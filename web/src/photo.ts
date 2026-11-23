// Mapas derivados da foto do corpo: brilho da pele e máscara de pele por cor.
import { boxBlur, clamp, smoothstep } from './util';

/**
 * Brilho especular da pele (o "reflexo" por cima da tinta). Na pele real a
 * tinta fica embaixo da epiderme, então o brilho continua aparecendo sobre ela.
 */
export function computeHighlight(rgba: Uint8ClampedArray, w: number, h: number): Float32Array {
  const n = w * h;
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    lum[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
  }
  const r = Math.max(3, Math.round(0.012 * Math.min(w, h)));
  const blurred = boxBlur(boxBlur(lum, w, h, r), w, h, r);
  const hl = new Float32Array(n);
  for (let i = 0; i < n; i++) hl[i] = clamp(lum[i] - blurred[i] - 6, 0, 90);
  return hl;
}

const toYCbCr = (r: number, g: number, b: number): [number, number, number] => [
  0.299 * r + 0.587 * g + 0.114 * b,
  128 - 0.168736 * r - 0.331264 * g + 0.5 * b,
  128 + 0.5 * r - 0.418688 * g - 0.081312 * b,
];

/**
 * Plano B quando o modelo não acha pele no ponto tocado (comum em close):
 * pega a cor da pele no ponto e expande para a região conectada de cor parecida.
 */
export function colorSkinMask(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  px: number,
  py: number,
): Float32Array {
  const n = w * h;
  const win = Math.max(3, Math.round(0.006 * Math.min(w, h)));
  let sy = 0;
  let scb = 0;
  let scr = 0;
  let cnt = 0;
  for (let y = Math.round(py) - win; y <= Math.round(py) + win; y++) {
    for (let x = Math.round(px) - win; x <= Math.round(px) + win; x++) {
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const p = (y * w + x) * 4;
      const [Y, Cb, Cr] = toYCbCr(rgba[p], rgba[p + 1], rgba[p + 2]);
      sy += Y;
      scb += Cb;
      scr += Cr;
      cnt++;
    }
  }
  const mY = sy / cnt;
  const mCb = scb / cnt;
  const mCr = scr / cnt;

  const m = new Float32Array(n);
  // Só aceita a cor tocada como pele se ela estiver na faixa típica de tons de pele
  // (evita confundir fundo cinza, água ou pedra com pele quando o toque cai fora do corpo).
  if (mCr < 131 || mCr > 182 || mCb < 70 || mCb > 136) return m;
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    const [Y, Cb, Cr] = toYCbCr(rgba[p], rgba[p + 1], rgba[p + 2]);
    if (Y < mY * 0.3 || Y > Math.min(255, mY * 1.9 + 20)) continue;
    m[i] = 1 - smoothstep(10, 22, Math.hypot(Cb - mCb, Cr - mCr));
  }

  // Mantém só a região conectada ao ponto tocado.
  const keep = new Uint8Array(n);
  const stack = new Int32Array(n);
  let sp = 0;
  const start = Math.round(py) * w + Math.round(px);
  if (m[start] >= 0.5) {
    stack[sp++] = start;
    keep[start] = 1;
  }
  while (sp > 0) {
    const i = stack[--sp];
    const x = i % w;
    const y = (i - x) / w;
    const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
    for (const j of nb) {
      if (j >= 0 && !keep[j] && m[j] >= 0.5) {
        keep[j] = 1;
        stack[sp++] = j;
      }
    }
  }
  for (let i = 0; i < n; i++) if (!keep[i]) m[i] = 0;
  return boxBlur(m, w, h, 1);
}
