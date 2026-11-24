// Detecção do corpo com MediaPipe, toda rodando no aparelho:
// - segmentação multiclasse (cabelo, pele do corpo, pele do rosto, roupa...)
// - pontos do corpo (ombro, cotovelo, punho, quadril, joelho...)
import { FilesetResolver, ImageSegmenter, PoseLandmarker, type ImageSegmenterResult } from '@mediapipe/tasks-vision';
import { isNative } from './platform';
import { clamp, resampleBilinear } from './util';

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

const BASE = import.meta.env.BASE_URL;
const SEG_MODEL = `${BASE}models/selfie_multiclass_256x256.tflite`;
const POSE_MODEL = `${BASE}models/pose_landmarker_full.task`;

type Fileset = Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;
let fileset: Fileset | null = null;
let segmenter: ImageSegmenter | null = null;
let poser: PoseLandmarker | null = null;
let skinChannels: number[] = [2, 3];
let loading: Promise<void> | null = null;

/**
 * Onde os modelos rodam. Medido num celular de entrada (Galaxy A04e): no processador a
 * análise de uma foto leva 9–13 s; na GPU, 2,6 s, depois de um "aquecimento" de ~9 s na
 * primeira vez. No computador o processador já é rápido e não precisa do aquecimento.
 * Então: GPU no celular (app ou site aberto no celular), CPU no computador.
 * ?gpu ou ?cpu na URL forçam um dos dois.
 */
const params = new URLSearchParams(location.search);
const isPhone =
  isNative ||
  /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1); // iPad "de computador"
const useGPU = params.has('gpu') || (isPhone && !params.has('cpu'));

/**
 * Alguns chips gráficos (ex.: PowerVR de celulares de entrada) rodam o modelo de pele mas
 * devolvem os mapas de probabilidade zerados. Nesses, usa-se o mapa de categorias (cada
 * pixel diz a classe) e, se ele também falhar, a pele passa para o processador. A decisão
 * fica guardada no aparelho para as próximas vezes.
 */
const SEG_KEY = 'provink.pele';
type SegMode = 'gpu' | 'gpu-categoria' | 'cpu';
const remembered = (() => {
  try {
    return localStorage.getItem(SEG_KEY) as SegMode | null;
  } catch {
    return null;
  }
})();
let segMode: SegMode = !useGPU ? 'cpu' : remembered === 'cpu' || remembered === 'gpu-categoria' ? remembered : 'gpu';
// Um chip que não consegue devolver o mapa de pele também erra os pontos do corpo (num
// PowerVR medido, ~15–40 px de desvio contra ~3 px num chip bom): nele, tudo no processador.
let poseOnGPU = useGPU && remembered !== 'cpu';

function rememberSegMode(m: SegMode) {
  segMode = m;
  try {
    localStorage.setItem(SEG_KEY, m);
  } catch {
    /* sem armazenamento: decide de novo na próxima vez */
  }
}

function createSegmenter(onGPU: boolean) {
  return ImageSegmenter.createFromOptions(fileset!, {
    baseOptions: { modelAssetPath: SEG_MODEL, delegate: onGPU ? 'GPU' : 'CPU' },
    runningMode: 'IMAGE',
    outputConfidenceMasks: true,
    // Na GPU pede também as categorias: são o plano B quando a probabilidade vem zerada.
    outputCategoryMask: onGPU,
  });
}

function makePose(onGPU: boolean) {
  return PoseLandmarker.createFromOptions(fileset!, {
    baseOptions: { modelAssetPath: POSE_MODEL, delegate: onGPU ? 'GPU' : 'CPU' },
    runningMode: 'IMAGE',
    numPoses: 1,
  });
}

export function loadModels(): Promise<void> {
  loading ??= (async () => {
    fileset = await FilesetResolver.forVisionTasks(`${BASE}mediapipe/wasm`);
    if (segMode !== 'cpu') {
      try {
        segmenter = await createSegmenter(true);
      } catch (err) {
        console.warn('GPU indisponível para a pele, usando CPU.', err);
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
        console.warn('GPU indisponível para a pose, usando CPU.', err);
        poseOnGPU = false;
      }
    }
    poser ??= await makePose(false);
  })();
  return loading;
}

let warm: Promise<void> | null = null;

/**
 * Prepara a GPU (a primeira análise é a que demora). Trava a tela enquanto roda, então quem
 * chama escolhe a hora: o melhor momento é quando a galeria do celular está aberta por cima
 * do app (a pessoa escolhendo a foto não vê a tela travada). Na CPU não faz nada.
 */
export function warmUp(): Promise<void> {
  if (!useGPU) return Promise.resolve();
  warm ??= loadModels().then(() => {
    if (segMode === 'cpu' && !poseOnGPU) return; // tudo no processador: nada a aquecer
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d')!;
    g.fillStyle = '#c89474';
    g.fillRect(0, 0, 256, 256);
    const t0 = performance.now();
    try {
      if (segMode !== 'cpu') segmenter?.segment(c).close();
      if (poseOnGPU) poser?.detect(c);
    } catch (err) {
      console.warn('Aquecimento da GPU falhou.', err);
    }
    console.info(`GPU aquecida em ${Math.round(performance.now() - t0)} ms`);
  });
  return warm;
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

export async function analyze(src: HTMLCanvasElement): Promise<Analysis> {
  const w = src.width;
  const h = src.height;
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
          console.warn('GPU devolveu o mapa de pele zerado; usando o mapa de categorias.');
          rememberSegMode('gpu-categoria');
        }
      }
      if (!got && segMode !== 'cpu') {
        // A GPU não serve para a pele neste aparelho: passa para o processador.
        console.warn('GPU não conseguiu o mapa de pele; a análise passa a ser feita no processador.');
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
      console.warn('Falha na segmentação de pele.', err);
    }
  }

  const t1 = performance.now();
  if (poser) {
    try {
      const res = poser.detect(src);
      const lm = res.landmarks[0];
      if (lm) pose = lm.map((p) => ({ x: p.x * w, y: p.y * h, v: p.visibility ?? 1 }));
    } catch (err) {
      console.warn('Falha na detecção de pose.', err);
    }
  }
  console.info(
    `Tempo: pele ${Math.round(t1 - t0)} ms (${segMode}), pose ${Math.round(performance.now() - t1)} ms (${poseOnGPU ? 'gpu' : 'cpu'})`,
  );

  return { skin, pose };
}
