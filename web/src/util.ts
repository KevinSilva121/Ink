export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** Resolve o sistema linear M·x = v (eliminação de Gauss com pivotamento). */
export function solveLinear(M: number[][], v: number[]): number[] | null {
  const n = v.length;
  const a = M.map((row, i) => [...row, v[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    if (Math.abs(a[p][c]) < 1e-9) return null;
    [a[c], a[p]] = [a[p], a[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = a[r][c] / a[c][c];
      for (let k = c; k <= n; k++) a[r][k] -= f * a[c][k];
    }
  }
  return a.map((row, i) => row[n] / row[i]);
}

/** Desfoque de caixa separável (soma corrida), com borda replicada. */
export function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  if (r < 1) return src.slice();
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const norm = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let i = -r; i <= r; i++) acc += src[row + clamp(i, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc * norm;
      acc += src[row + Math.min(x + r + 1, w - 1)] - src[row + Math.max(x - r, 0)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let i = -r; i <= r; i++) acc += tmp[clamp(i, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc * norm;
      acc += tmp[Math.min(y + r + 1, h - 1) * w + x] - tmp[Math.max(y - r, 0) * w + x];
    }
  }
  return out;
}

/** Redimensiona um mapa de um canal com interpolação bilinear. */
export function resampleBilinear(
  src: Float32Array,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
): Float32Array {
  const out = new Float32Array(dw * dh);
  const sx = sw / dw;
  const sy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const fy = (y + 0.5) * sy - 0.5;
    const y0 = clamp(Math.floor(fy), 0, sh - 1);
    const y1 = Math.min(y0 + 1, sh - 1);
    const ay = clamp(fy - y0, 0, 1);
    for (let x = 0; x < dw; x++) {
      const fx = (x + 0.5) * sx - 0.5;
      const x0 = clamp(Math.floor(fx), 0, sw - 1);
      const x1 = Math.min(x0 + 1, sw - 1);
      const ax = clamp(fx - x0, 0, 1);
      const top = src[y0 * sw + x0] * (1 - ax) + src[y0 * sw + x1] * ax;
      const bot = src[y1 * sw + x0] * (1 - ax) + src[y1 * sw + x1] * ax;
      out[y * dw + x] = top * (1 - ay) + bot * ay;
    }
  }
  return out;
}

/** Carrega uma imagem (arquivo ou URL) num canvas, limitando o maior lado. */
export async function loadToCanvas(src: Blob | string, maxSide: number): Promise<HTMLCanvasElement> {
  const url = typeof src === 'string' ? src : URL.createObjectURL(src);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    let w = img.naturalWidth;
    let h = img.naturalHeight;
    if (!w || !h) {
      w = 1024;
      h = 1024;
    }
    const s = Math.min(1, maxSide / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * s));
    canvas.height = Math.max(1, Math.round(h * s));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Canvas 2D indisponível');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    if (typeof src !== 'string') URL.revokeObjectURL(url);
  }
}
