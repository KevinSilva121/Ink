// Projetos guardados no próprio aparelho (IndexedDB): nada vai para servidor.
//
// Cada projeto tem um registro leve (nome, datas, miniatura e o estado das edições, em JSON)
// e arquivos guardados à parte (a foto, a análise do corpo e cada desenho). Os arquivos
// pesados são gravados uma vez; a cada edição só o registro leve é regravado.

export interface ProjectRecord {
  id: string;
  name: string;
  created: number;
  updated: number;
  thumb: Blob | null;
  /** Estado das edições (JSON) e as chaves dos arquivos que ele usa. */
  state: unknown;
  blobKeys: string[];
}

const DB_NAME = 'provador-tatuagem';
const VERSION = 1;
let dbp: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('projects')) d.createObjectStore('projects', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function run<T>(store: 'projects' | 'blobs', mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const tx = d.transaction(store, mode);
        const req = fn(tx.objectStore(store));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = () => reject(tx.error ?? req.error);
        tx.onabort = () => reject(tx.error ?? new Error('abortado'));
      }),
  );
}

export const putProject = (p: ProjectRecord) => run('projects', 'readwrite', (s) => s.put(p)).then(() => undefined);
export const getProject = (id: string) => run<ProjectRecord | undefined>('projects', 'readonly', (s) => s.get(id));
export const putBlob = (key: string, b: Blob) => run('blobs', 'readwrite', (s) => s.put(b, key)).then(() => undefined);
export const getBlob = (key: string) => run<Blob | undefined>('blobs', 'readonly', (s) => s.get(key));

export async function listProjects(): Promise<ProjectRecord[]> {
  const all = await run<ProjectRecord[]>('projects', 'readonly', (s) => s.getAll());
  return all.sort((a, b) => b.updated - a.updated);
}

export async function deleteProject(id: string) {
  const p = await getProject(id);
  await run('projects', 'readwrite', (s) => s.delete(id));
  if (!p) return;
  // Apaga os arquivos que nenhum outro projeto usa.
  const others = await listProjects();
  const used = new Set(others.flatMap((o) => o.blobKeys));
  for (const k of p.blobKeys) if (!used.has(k)) await run('blobs', 'readwrite', (s) => s.delete(k));
}

/** Pede ao navegador para não apagar os projetos quando faltar espaço. */
export async function askPersistence(): Promise<boolean> {
  try {
    if (await navigator.storage?.persisted?.()) return true;
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

export const newId = () =>
  (crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`).replace(/-/g, '');
