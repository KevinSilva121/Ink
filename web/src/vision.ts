// Detecção do corpo com MediaPipe, toda rodando no aparelho (ver vision.worker.ts):
// - segmentação multiclasse (cabelo, pele do corpo, pele do rosto, roupa...)
// - pontos do corpo (ombro, cotovelo, punho, quadril, joelho...)
// Aqui fica só a ponte com o worker: a página nunca trava esperando a análise.
import { isNative } from './platform';

export interface Landmark {
  x: number;
  y: number;
  v: number;
}

export interface Analysis {
  /** Probabilidade de pele (0..1) por pixel da foto, ou null se o modelo falhou. */
  skin: Float32Array | null;
  /** 33 pontos do corpo em pixels da foto, ou null se ninguém foi detectado. */
  pose: Landmark[] | null;
}

export type SegMode = 'gpu' | 'gpu-categoria' | 'cpu';

export type VisionRequest =
  | { type: 'init'; id: number; base: string; useGPU: boolean; remembered: SegMode | null }
  | { type: 'analyze'; id: number; image: ImageBitmap; w: number; h: number };

export type VisionResponse =
  | { type: 'done'; id: number; result: Analysis | null }
  | { type: 'fail'; id: number; error: string }
  | { type: 'remember'; mode: SegMode }
  | { type: 'log'; level: 'info' | 'warn'; msg: string };

/**
 * Onde os modelos rodam. Medido num celular de entrada (Galaxy A04e): no processador a
 * análise de uma foto leva 9–13 s; na GPU, 2,6 s. No computador o processador já é rápido.
 * Então: GPU no celular (app ou site aberto no celular), CPU no computador.
 * ?gpu ou ?cpu na URL forçam um dos dois.
 */
const params = new URLSearchParams(location.search);
export const isPhone =
  isNative ||
  /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1); // iPad "de computador"
const useGPU = params.has('gpu') || (isPhone && !params.has('cpu'));

/**
 * Alguns chips gráficos (ex.: PowerVR de celulares de entrada) rodam o modelo de pele mas
 * devolvem os mapas de probabilidade zerados. O worker descobre e avisa; a decisão fica
 * guardada no aparelho para as próximas vezes.
 */
const SEG_KEY = 'provink.pele';
const remembered = (() => {
  try {
    return localStorage.getItem(SEG_KEY) as SegMode | null;
  } catch {
    return null;
  }
})();

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (r: Analysis | null) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL('./vision.worker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (e: MessageEvent<VisionResponse>) => {
    const m = e.data;
    if (m.type === 'log') {
      (m.level === 'warn' ? console.warn : console.info)(m.msg);
    } else if (m.type === 'remember') {
      try {
        localStorage.setItem(SEG_KEY, m.mode);
      } catch {
        /* sem armazenamento: decide de novo na próxima vez */
      }
    } else {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.type === 'done') p?.resolve(m.result);
      else p?.reject(new Error(m.error));
    }
  };
  w.onerror = (e) => {
    console.error('Worker da detecção falhou.', e.message);
    for (const p of pending.values()) p.reject(new Error(e.message || 'worker'));
    pending.clear();
  };
  worker = w;
  return w;
}

type Req = VisionRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;

function call(req: Req, transfer: Transferable[] = []): Promise<Analysis | null> {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ ...req, id }, transfer);
  });
}

let loading: Promise<void> | null = null;

/** Carrega os modelos (e, na GPU, já faz o aquecimento). Pode chamar quantas vezes quiser. */
export function loadModels(): Promise<void> {
  loading ??= call({ type: 'init', base: import.meta.env.BASE_URL, useGPU, remembered }).then(() => undefined);
  return loading;
}

/** Mantido por compatibilidade: o aquecimento agora acontece no worker, junto do carregamento. */
export function warmUp(): Promise<void> {
  return loadModels();
}

export async function analyze(src: HTMLCanvasElement): Promise<Analysis> {
  await loadModels();
  const image = await createImageBitmap(src);
  const res = await call({ type: 'analyze', image, w: src.width, h: src.height }, [image]);
  return res ?? { skin: null, pose: null };
}
