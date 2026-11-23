// Detecção do corpo com MediaPipe, toda rodando no aparelho:
// - segmentação multiclasse (cabelo, pele do corpo, pele do rosto, roupa...)
// - pontos do corpo (ombro, cotovelo, punho, quadril, joelho...)
import { FilesetResolver, ImageSegmenter, PoseLandmarker } from '@mediapipe/tasks-vision';
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

let segmenter: ImageSegmenter | null = null;
let poser: PoseLandmarker | null = null;
let skinChannels: number[] = [2, 3];
let loading: Promise<void> | null = null;

// A análise roda uma vez por foto, então a CPU (WASM) é o padrão: é previsível
// em celular barato e evita a compilação de shaders da GPU. ?gpu na URL testa a GPU.
const useGPU = new URLSearchParams(location.search).has('gpu');

async function withDelegate<T>(make: (delegate: 'GPU' | 'CPU') => Promise<T>): Promise<T> {
  if (!useGPU) return make('CPU');
  try {
    return await make('GPU');
  } catch (err) {
    console.warn('GPU indisponível para o MediaPipe, usando CPU.', err);
    return make('CPU');
  }
}

export function loadModels(): Promise<void> {
  loading ??= (async () => {
    const fileset = await FilesetResolver.forVisionTasks(`${BASE}mediapipe/wasm`);
    segmenter = await withDelegate((delegate) =>
      ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: `${BASE}models/selfie_multiclass_256x256.tflite`, delegate },
        runningMode: 'IMAGE',
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      }),
    );
    const labels = segmenter.getLabels().map((l) => l.toLowerCase());
    const found = labels.flatMap((l, i) => (l.includes('skin') ? [i] : []));
    if (found.length) skinChannels = found;

    poser = await withDelegate((delegate) =>
      PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: `${BASE}models/pose_landmarker_full.task`, delegate },
        runningMode: 'IMAGE',
        numPoses: 1,
      }),
    );
  })();
  return loading;
}

export function analyze(src: HTMLCanvasElement): Analysis {
  const w = src.width;
  const h = src.height;
  let skin: Float32Array | null = null;
  let pose: Landmark[] | null = null;

  const t0 = performance.now();
  if (segmenter) {
    try {
      const res = segmenter.segment(src);
      const masks = res.confidenceMasks;
      if (masks?.length) {
        const mw = masks[0].width;
        const mh = masks[0].height;
        const sum = new Float32Array(mw * mh);
        for (const ch of skinChannels) {
          const m = masks[ch];
          if (!m) continue;
          const a = m.getAsFloat32Array();
          for (let i = 0; i < sum.length; i++) sum[i] += a[i];
        }
        skin = mw === w && mh === h ? sum : resampleBilinear(sum, mw, mh, w, h);
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
    `Tempo: pele ${Math.round(t1 - t0)} ms, pose ${Math.round(performance.now() - t1)} ms (${useGPU ? 'GPU se disponível' : 'CPU'})`,
  );

  return { skin, pose };
}
