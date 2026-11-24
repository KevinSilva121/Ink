// Projetos guardados no próprio aparelho: nada vai para servidor.
//
// Cada projeto tem um registro leve (nome, datas, miniatura e o estado das edições) e
// arquivos guardados à parte (a foto, a análise do corpo e cada desenho). Os arquivos
// pesados são gravados uma vez; a cada edição só o registro leve é regravado.
//
// Onde fica:
// - no site: IndexedDB do navegador;
// - no app instalado (Android/iOS): arquivos na pasta do próprio app, que o sistema não
//   apaga para liberar espaço (o armazenamento de navegador dentro do app pode ser limpo).
import { isNative } from './platform';

export interface ProjectRecord {
  id: string;
  name: string;
  created: number;
  updated: number;
  thumb: Blob | null;
  /** Estado das edições e as chaves dos arquivos que ele usa. */
  state: unknown;
  blobKeys: string[];
}

interface Backend {
  putProject(p: ProjectRecord): Promise<void>;
  getProject(id: string): Promise<ProjectRecord | undefined>;
  listProjects(): Promise<ProjectRecord[]>;
  removeProject(id: string): Promise<void>;
  putBlob(key: string, b: Blob): Promise<void>;
  getBlob(key: string): Promise<Blob | undefined>;
  removeBlob(key: string): Promise<void>;
}

/** JSON não tem Float32Array nem Infinity: vira um objeto marcado, e volta na leitura. */
export const jsonReplacer = (_k: string, v: unknown) =>
  v instanceof Float32Array
    ? { $f32: Array.from(v, (x) => Math.round(x * 1000) / 1000) }
    : typeof v === 'number' && !Number.isFinite(v)
      ? { $num: String(v) }
      : v;
export const jsonReviver = (_k: string, v: unknown) => {
  if (v && typeof v === 'object' && '$f32' in v) return Float32Array.from((v as { $f32: number[] }).$f32);
  if (v && typeof v === 'object' && '$num' in v) return Number((v as { $num: string }).$num);
  return v;
};

// ---------- Navegador: IndexedDB ----------
const DB_NAME = 'provador-tatuagem';
const VERSION = 1;

function idbBackend(): Backend {
  let dbp: Promise<IDBDatabase> | null = null;
  const db = () =>
    (dbp ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('projects')) d.createObjectStore('projects', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  const run = <T>(store: 'projects' | 'blobs', mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) =>
    db().then(
      (d) =>
        new Promise<T>((resolve, reject) => {
          const tx = d.transaction(store, mode);
          const req = fn(tx.objectStore(store));
          tx.oncomplete = () => resolve(req.result);
          tx.onerror = () => reject(tx.error ?? req.error);
          tx.onabort = () => reject(tx.error ?? new Error('abortado'));
        }),
    );
  return {
    putProject: (p) => run('projects', 'readwrite', (s) => s.put(p)).then(() => undefined),
    getProject: (id) => run<ProjectRecord | undefined>('projects', 'readonly', (s) => s.get(id)),
    listProjects: () => run<ProjectRecord[]>('projects', 'readonly', (s) => s.getAll()),
    removeProject: (id) => run('projects', 'readwrite', (s) => s.delete(id)).then(() => undefined),
    putBlob: (key, b) => run('blobs', 'readwrite', (s) => s.put(b, key)).then(() => undefined),
    getBlob: (key) => run<Blob | undefined>('blobs', 'readonly', (s) => s.get(key)),
    removeBlob: (key) => run('blobs', 'readwrite', (s) => s.delete(key)).then(() => undefined),
  };
}

// ---------- App instalado: arquivos do app (Capacitor Filesystem) ----------
// provink/projetos/<id>.json  — registro (miniatura em data URL, estado em JSON)
// provink/arquivos/<chave>    — foto, análise e desenhos (data URL: guarda o tipo junto)
function fileBackend(): Backend {
  const fs = import('@capacitor/filesystem');
  const ROOT = 'provink';
  const safe = (k: string) => k.replace(/[^\w.-]/g, '_');
  const dataUrl = (b: Blob) =>
    new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(b);
    });
  const write = async (path: string, text: string) => {
    const { Filesystem, Directory, Encoding } = await fs;
    await Filesystem.writeFile({ path: `${ROOT}/${path}`, data: text, directory: Directory.Data, encoding: Encoding.UTF8, recursive: true });
  };
  const read = async (path: string): Promise<string | undefined> => {
    const { Filesystem, Directory, Encoding } = await fs;
    try {
      const r = await Filesystem.readFile({ path: `${ROOT}/${path}`, directory: Directory.Data, encoding: Encoding.UTF8 });
      return typeof r.data === 'string' ? r.data : await (r.data as Blob).text();
    } catch {
      return undefined;
    }
  };
  const remove = async (path: string) => {
    const { Filesystem, Directory } = await fs;
    try {
      await Filesystem.deleteFile({ path: `${ROOT}/${path}`, directory: Directory.Data });
    } catch {
      /* já não existia */
    }
  };
  const toRecord = async (text: string): Promise<ProjectRecord> => {
    const o = JSON.parse(text, jsonReviver);
    return { ...o, thumb: o.thumb ? await (await fetch(o.thumb)).blob() : null };
  };
  return {
    async putProject(p) {
      const thumb = p.thumb ? await dataUrl(p.thumb) : null;
      await write(`projetos/${safe(p.id)}.json`, JSON.stringify({ ...p, thumb }, jsonReplacer));
    },
    async getProject(id) {
      const t = await read(`projetos/${safe(id)}.json`);
      return t ? toRecord(t) : undefined;
    },
    async listProjects() {
      const { Filesystem, Directory } = await fs;
      let names: string[] = [];
      try {
        const r = await Filesystem.readdir({ path: `${ROOT}/projetos`, directory: Directory.Data });
        names = r.files.map((f) => (typeof f === 'string' ? f : f.name)).filter((n) => n.endsWith('.json'));
      } catch {
        return [];
      }
      const out: ProjectRecord[] = [];
      for (const n of names) {
        const t = await read(`projetos/${n}`);
        if (t) out.push(await toRecord(t));
      }
      return out;
    },
    removeProject: (id) => remove(`projetos/${safe(id)}.json`),
    putBlob: async (key, b) => write(`arquivos/${safe(key)}`, await dataUrl(b)),
    async getBlob(key) {
      const t = await read(`arquivos/${safe(key)}`);
      return t ? (await fetch(t)).blob() : undefined;
    },
    removeBlob: (key) => remove(`arquivos/${safe(key)}`),
  };
}

// No site dá para testar o armazenamento do app com ?arquivos na URL.
const useFiles = isNative || new URLSearchParams(location.search).has('arquivos');
const B: Backend = useFiles ? fileBackend() : idbBackend();

export const putProject = (p: ProjectRecord) => B.putProject(p);
export const getProject = (id: string) => B.getProject(id);
export const putBlob = (key: string, b: Blob) => B.putBlob(key, b);
export const getBlob = (key: string) => B.getBlob(key);

export async function listProjects(): Promise<ProjectRecord[]> {
  return (await B.listProjects()).sort((a, b) => b.updated - a.updated);
}

export async function deleteProject(id: string) {
  const p = await B.getProject(id);
  await B.removeProject(id);
  if (!p) return;
  // Apaga os arquivos que nenhum outro projeto usa.
  const used = new Set((await listProjects()).flatMap((o) => o.blobKeys));
  for (const k of p.blobKeys) if (!used.has(k)) await B.removeBlob(k);
}

/** Pede ao navegador para não apagar os projetos quando faltar espaço (no app não precisa). */
export async function askPersistence(): Promise<boolean> {
  if (useFiles) return true;
  try {
    if (await navigator.storage?.persisted?.()) return true;
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

export const newId = () =>
  (crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`).replace(/-/g, '');
