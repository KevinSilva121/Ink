// Prepara os arquivos estáticos do MediaPipe: copia o WASM do node_modules
// e baixa os modelos uma única vez para public/models (ficam servidos pelo
// próprio app, sem depender do servidor do Google em tempo de uso).
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'public');

const wasmSrc = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const wasmDst = join(pub, 'mediapipe', 'wasm');
mkdirSync(wasmDst, { recursive: true });
cpSync(wasmSrc, wasmDst, { recursive: true });

const models = {
  'selfie_multiclass_256x256.tflite':
    'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite',
  'pose_landmarker_full.task':
    'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task',
};

const modelDir = join(pub, 'models');
mkdirSync(modelDir, { recursive: true });

for (const [name, url] of Object.entries(models)) {
  const dst = join(modelDir, name);
  if (existsSync(dst)) continue;
  process.stdout.write(`Baixando ${name}... `);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Falha ao baixar ${url}: ${res.status}`);
  writeFileSync(dst, Buffer.from(await res.arrayBuffer()));
  console.log('ok');
}
