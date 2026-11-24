// Detecção do corpo com MediaPipe, rodando num "worker" (outra linha de execução): a análise
// leva de 3 a 12 s num celular e, na tela principal, deixava o app travado esse tempo todo.
// - segmentação multiclasse (cabelo, pele do corpo, pele do rosto, roupa...)
// - pontos do corpo (ombro, cotovelo, punho, quadril, joelho...)
import { FilesetResolver, ImageSegmenter, PoseLandmarker, type ImageSegmenterResult } from '@mediapipe/tasks-vision';
import { clamp, resampleBilinear } from './util';
import type { Landmark, SegMode, VisionRequest, VisionResponse } from './vision';

// Privacidade: o MediaPipe tenta mandar estatísticas de uso para o Google. Na página, a regra
// de segurança (CSP) bloqueia; dentro do worker ela não vale, então o bloqueio é feito aqui:
// só passa o que vem do próprio app.
const isLocal = (u: string) => {
  const url = new URL(u, self.location.href);
  return url.origin === self.location.origin || url.protocol === 'data:' || url.protocol === 'blob:';
};
const realFetch = self.fetch.bind(self);
self.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const u = input instanceof Request ? input.url : String(input);
  if (!isLocal(u)) return Promise.reject(new TypeError('Conexão externa bloqueada.'));
  return realFetch(input, init);
};
if (typeof XMLHttpRequest !== 'undefined') {
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    if (!isLocal(String(url))) throw new TypeError('Conexão externa bloqueada.');
    return (open as (...a: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof open;
}

// O MediaPipe carrega o próprio arquivo .js com import() quando está num worker de módulo, e
// usa self.import se existir. Duas correções aqui:
// - o import() fica "escondido" num Function: o servidor de desenvolvimento (Vite) não mexe
//   nele (mexendo, ele se recusa a servir a pasta public);
// - depois de criar cada modelo o MediaPipe apaga self.ModuleFactory, e um módulo já
//   importado não roda de novo: sem repor, o segundo modelo (a pose) não carregava.
(self as unknown as { import: (u: string) => Promise<unknown> }).import = new Function(
  'u',
  'return import(u).then((m) => { self.ModuleFactory = m.default; return m; })',
) as (u: string) => Promise<unknown>;

const post = (m: VisionResponse, transfer: Transferable[] = []) =>
  (self as unknown as { postMessage(m: unknown, t: Transferable[]): void }).postMessage(m, transfer);
const log = (level: 'info' | 'warn', msg: string) => post({ type: 'log', level, msg });

type Fileset = Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;
let fileset: Fileset | null = null;
let segmenter: ImageSegmenter | null = null;
let poser: PoseLandmarker | null = null;
let skinChannels: number[] = [2, 3];
let segModel = '';
let poseModel = '';
let segMode: SegMode = 'cpu';
let poseOnGPU = false;

function rememberSegMode(m: SegMode) {
  segMode = m;
  post({ type: 'remember', mode: m }); // a página guarda (o worker não tem localStorage)
}

function createSegmenter(onGPU: boolean) {
  return ImageSegmenter.createFromOptions(fileset!, {
    baseOptions: { modelAssetPath: segModel, delegate: onGPU ? 'GPU' : 'CPU' },
    runningMode: 'IMAGE',
    outputConfidenceMasks: true,
    // Na GPU pede também as categorias: são o plano B quando a probabilidade vem zerada.
    outputCategoryMask: onGPU,
  });
}

function makePose(onGPU: boolean) {
  return PoseLandmarker.createFromOptions(fileset!, {
    baseOptions: { modelAssetPath: poseModel, delegate: onGPU ? 'GPU' : 'CPU' },
    runningMode: 'IMAGE',
    numPoses: 1,
  });
}

async function init(base: string, useGPU: boolean, remembered: SegMode | null) {
  segModel = `${base}models/selfie_multiclass_256x256.tflite`;
  poseModel = `${base}models/pose_landmarker_full.task`;
  segMode = !useGPU ? 'cpu' : remembered === 'cpu' || remembered === 'gpu-categoria' ? remembered : 'gpu';
  // Um chip que não consegue devolver o mapa de pele também erra os pontos do corpo (num
  // PowerVR medido, ~15–40 px de desvio contra ~3 px num chip bom): nele, tudo no processador.
  poseOnGPU = useGPU && remembered !== 'cpu';
  fileset = await FilesetResolver.forVisionTasks(`${base}mediapipe/wasm`, true);
  if (segMode !== 'cpu') {
    try {
      segmenter = await createSegmenter(true);
    } catch (err) {
      log('warn', `GPU indisponível para a pele, usando CPU. ${err}`);
      segMode = 'cpu';
    }
  }
  segmenter ??= await createSegmenter(false);
  const labels = segmenter.getLabels().map((l) => l.toLowerCase());
  const found = labels.flatMap((l, i) => (l.includes('skin') ? [i] : []));
  if (found.length) skinChannels = found;

  if (poseOnGPU) {
    try {
      poser = await makePose(true);
    } catch (err) {
      log('warn', `GPU indisponível para a pose, usando CPU. ${err}`);
      poseOnGPU = false;
    }
  }
  poser ??= await makePose(false);
  // A primeira análise na GPU demora (prepara os programas da placa de vídeo). Como aqui não
  // trava a tela, já faz agora com uma imagem lisa: a primeira foto de verdade sai rápida.
  // No processador não compensa: o modelo de pele sempre roda em 256×256, então aquecer custa
  // uma análise inteira (~9 s num celular de entrada, medido) e a foto escolhida nesse meio
  // tempo esperaria na fila; o ganho na primeira foto seria só ~1–2 s.
  if (segMode !== 'cpu' || poseOnGPU) {
    const c = new OffscreenCanvas(256, 256);
    const g = c.getContext('2d')!;
    g.fillStyle = '#c89474';
    g.fillRect(0, 0, 256, 256);
    const t0 = performance.now();
    try {
      if (segMode !== 'cpu') segmenter.segment(c).close();
      if (poseOnGPU) poser.detect(c);
    } catch (err) {
      log('warn', `Aquecimento da GPU falhou. ${err}`);
    }
    log('info', `GPU aquecida em ${Math.round(performance.now() - t0)} ms`);
  }
}

/**
 * Pele (0..1) no tamanho do mapa do modelo, a partir do resultado da segmentação.
 * Devolve null se o mapa veio vazio (leitura da GPU que falhou): numa foto de corpo sempre
 * há fundo, pele ou roupa com alguma probabilidade.
 */
function readSkin(res: ImageSegmenterResult, useCategories: boolean): { skin: Float32Array; w: number; h: number } | null {
  const masks = res.confidenceMasks;
  if (!useCategories && masks?.length) {
    const mw = masks[0].width;
    const mh = masks[0].height;
    const sum = new Float32Array(mw * mh);
    for (const ch of skinChannels) {
      const a = masks[ch]?.getAsFloat32Array();
      if (a) for (let i = 0; i < sum.length; i++) sum[i] += a[i];
    }
    // Conferência: pele + fundo (classe 0) não podem ser zero na imagem inteira.
    const bg = masks[0]?.getAsFloat32Array();
    let peak = 0;
    for (let i = 0; i < sum.length; i += 97) peak = Math.max(peak, sum[i] + (bg ? bg[i] : 0));
    if (peak > 0.2) return { skin: sum, w: mw, h: mh };
  }
  const cat = res.categoryMask;
  if (cat) {
    const c = cat.getAsUint8Array();
    const skin = new Float32Array(c.length);
    let anyClass = false;
    for (let i = 0; i < c.length; i++) {
      if (c[i] !== 0) anyClass = true;
      skin[i] = skinChannels.includes(c[i]) ? 1 : 0;
    }
    if (anyClass) return { skin, w: cat.width, h: cat.height };
  }
  return null;
}

async function analyze(src: ImageBitmap, w: number, h: number) {
  let skin: Float32Array | null = null;
  let pose: Landmark[] | null = null;

  const t0 = performance.now();
  if (segmenter) {
    try {
      let res = segmenter.segment(src);
      let got = readSkin(res, segMode === 'gpu-categoria');
      if (!got && segMode === 'gpu') {
        // Probabilidade zerada: tenta as categorias da mesma análise.
        got = readSkin(res, true);
        if (got) {
          log('warn', 'GPU devolveu o mapa de pele zerado; usando o mapa de categorias.');
          rememberSegMode('gpu-categoria');
        }
      }
      if (!got && segMode !== 'cpu') {
        // A GPU não serve para a pele neste aparelho: passa para o processador.
        log('warn', 'GPU não conseguiu o mapa de pele; a análise passa a ser feita no processador.');
        res.close();
        segmenter.close();
        segmenter = await createSegmenter(false);
        rememberSegMode('cpu');
        res = segmenter.segment(src);
        got = readSkin(res, false);
        if (poseOnGPU && poser) {
          poser.close();
          poser = await makePose(false);
          poseOnGPU = false;
        }
      }
      if (got) {
        skin = got.w === w && got.h === h ? got.skin : resampleBilinear(got.skin, got.w, got.h, w, h);
        for (let i = 0; i < skin.length; i++) skin[i] = clamp(skin[i], 0, 1);
      }
      res.close();
    } catch (err) {
      log('warn', `Falha na segmentação de pele. ${err}`);
    }
  }

  const t1 = performance.now();
  if (poser) {
    try {
      const res = poser.detect(src);
      const lm = res.landmarks[0];
      if (lm) pose = lm.map((p) => ({ x: p.x * w, y: p.y * h, v: p.visibility ?? 1 }));
    } catch (err) {
      log('warn', `Falha na detecção de pose. ${err}`);
    }
  }
  src.close();
  log(
    'info',
    `Tempo: pele ${Math.round(t1 - t0)} ms (${segMode}), pose ${Math.round(performance.now() - t1)} ms (${poseOnGPU ? 'gpu' : 'cpu'})`,
  );
  return { skin, pose };
}

// Um pedido por vez, na ordem em que chegaram (a foto do corpo e a do extrator dividem o worker).
let queue: Promise<unknown> = Promise.resolve();
self.onmessage = (e: MessageEvent<VisionRequest>) => {
  const req = e.data;
  queue = queue.then(async () => {
    try {
      if (req.type === 'init') {
        await init(req.base, req.useGPU, req.remembered);
        post({ type: 'done', id: req.id, result: null });
      } else {
        const result = await analyze(req.image, req.w, req.h);
        post({ type: 'done', id: req.id, result }, result.skin ? [result.skin.buffer] : []);
      }
    } catch (err) {
      post({ type: 'fail', id: req.id, error: String(err) });
    }
  });
};
