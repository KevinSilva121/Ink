// Preparação do desenho importado (ex.: do Pinterest).
// Ideia central: na tatuagem, o branco do papel é a pele. Então o desenho é
// tratado como "filtro de tinta": branco = sem tinta, cores = tinta.
import { boxBlur, clamp, median } from './util';

export interface Design {
  w: number;
  h: number;
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
  note: string;
  /** Extraída de foto de tatuagem real: o aspecto de cicatrizada já vem da própria foto. */
  healed?: boolean;
}

export interface TexLevel {
  w: number;
  h: number;
  /** RGB = cor da tinta (255 = sem tinta); A = vermelhidão em volta (tatuagem recém-feita). */
  data: Uint8ClampedArray;
}

export interface Tex {
  w: number;
  h: number;
  levels: TexLevel[];
}

export type Look = 'cicatrizada' | 'recente';

const inkOf = (r: number, g: number, b: number) => Math.max(255 - r, 255 - g, 255 - b) / 255;

export function prepareDesign(img: ImageData): Design {
  const { width: w, height: h, data } = img;
  const n = w * h;
  let r = new Float32Array(n);
  let g = new Float32Array(n);
  let b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    const a = data[p + 3] / 255;
    r[i] = data[p] * a + 255 * (1 - a);
    g[i] = data[p + 1] * a + 255 * (1 - a);
    b[i] = data[p + 2] * a + 255 * (1 - a);
  }

  // Cor do fundo = mediana da borda da imagem.
  const t = Math.max(1, Math.round(0.01 * Math.min(w, h)));
  const step = Math.max(1, Math.floor((2 * (w + h) * t) / 4000));
  const br: number[] = [];
  const bgs: number[] = [];
  const bb: number[] = [];
  let k = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x >= t && x < w - t && y >= t && y < h - t) continue;
      if (k++ % step) continue;
      const i = y * w + x;
      br.push(r[i]);
      bgs.push(g[i]);
      bb.push(b[i]);
    }
  }
  const bgR = median(br);
  const bgG = median(bgs);
  const bgB = median(bb);
  const bmin = Math.min(bgR, bgG, bgB);
  const bmax = Math.max(bgR, bgG, bgB);

  let note: string;
  if (bmin > 160 && bmax - bmin < 45) {
    // Fundo branco ou quase branco (papel, JPEG): balanço de branco + ponto branco,
    // para o "quase branco" não virar um retângulo bege na pele.
    const wp = 0.95;
    const fr = 255 / (bgR * wp);
    const fg = 255 / (bgG * wp);
    const fb = 255 / (bgB * wp);
    for (let i = 0; i < n; i++) {
      r[i] = Math.min(255, r[i] * fr);
      g[i] = Math.min(255, g[i] * fg);
      b[i] = Math.min(255, b[i] * fb);
    }
    note = 'Fundo branco: onde é branco, a pele aparece (sem tinta).';
  } else {
    // Fundo colorido/escuro: remove a região conectada à borda com a mesma cor.
    const tol = 55;
    const near = (i: number) => Math.hypot(r[i] - bgR, g[i] - bgG, b[i] - bgB) < tol;
    const region = new Uint8Array(n);
    const stack = new Int32Array(n);
    let sp = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (x > 0 && x < w - 1 && y > 0 && y < h - 1) continue;
        const i = y * w + x;
        if (!region[i] && near(i)) {
          region[i] = 1;
          stack[sp++] = i;
        }
      }
    }
    while (sp > 0) {
      const i = stack[--sp];
      const x = i % w;
      const y = (i - x) / w;
      if (x > 0 && !region[i - 1] && near(i - 1)) (region[i - 1] = 1), (stack[sp++] = i - 1);
      if (x < w - 1 && !region[i + 1] && near(i + 1)) (region[i + 1] = 1), (stack[sp++] = i + 1);
      if (y > 0 && !region[i - w] && near(i - w)) (region[i - w] = 1), (stack[sp++] = i - w);
      if (y < h - 1 && !region[i + w] && near(i + w)) (region[i + w] = 1), (stack[sp++] = i + w);
    }
    const m = new Float32Array(n);
    for (let i = 0; i < n; i++) m[i] = region[i];
    const ms = boxBlur(m, w, h, 1);
    for (let i = 0; i < n; i++) {
      r[i] += (255 - r[i]) * ms[i];
      g[i] += (255 - g[i]) * ms[i];
      b[i] += (255 - b[i]) * ms[i];
    }
    note = 'Fundo não branco: removi pela cor da borda. Confira se nada do desenho sumiu.';
  }

  // Recorta as margens vazias para o tamanho valer pelo desenho, não pela imagem.
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (inkOf(r[i], g[i], b[i]) > 0.06) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) {
    return { w, h, r, g, b, note: 'Não encontrei desenho nessa imagem (parece toda branca).' };
  }
  const margin = Math.round(0.06 * Math.max(x1 - x0 + 1, y1 - y0 + 1));
  const cx0 = x0 - margin;
  const cy0 = y0 - margin;
  const cw = x1 - x0 + 1 + 2 * margin;
  const ch = y1 - y0 + 1 + 2 * margin;
  const nr = new Float32Array(cw * ch).fill(255);
  const ng = new Float32Array(cw * ch).fill(255);
  const nb = new Float32Array(cw * ch).fill(255);
  for (let y = 0; y < ch; y++) {
    const sy = cy0 + y;
    if (sy < 0 || sy >= h) continue;
    for (let x = 0; x < cw; x++) {
      const sx = cx0 + x;
      if (sx < 0 || sx >= w) continue;
      nr[y * cw + x] = r[sy * w + sx];
      ng[y * cw + x] = g[sy * w + sx];
      nb[y * cw + x] = b[sy * w + sx];
    }
  }
  r = nr;
  g = ng;
  b = nb;
  return { w: cw, h: ch, r, g, b, note };
}

const LOOKS = {
  // Cicatrizada: traço levemente espalhado, cores mais apagadas, preto puxando para cinza-azulado.
  cicatrizada: { blur: 0.0022, sat: 0.85, density: 0.9, tint: [0, 5, 10], halo: false },
  // Recém-feita: traço nítido, cores vivas, vermelhidão em volta.
  recente: { blur: 0.0006, sat: 1.08, density: 1.0, tint: [0, 0, 4], halo: true },
  // Desenho tirado de uma tatuagem já cicatrizada: não espalha nem apaga de novo.
  foto: { blur: 0, sat: 1, density: 1, tint: [0, 0, 0], halo: false },
} as const;

export function buildTexture(d: Design, look: Look): Tex {
  const P = d.healed && look === 'cicatrizada' ? LOOKS.foto : LOOKS[look];
  const { w, h } = d;
  const n = w * h;
  let { r, g, b } = d;
  const br = Math.round(P.blur * Math.max(w, h));
  if (br >= 1) {
    r = boxBlur(boxBlur(r, w, h, br), w, h, br);
    g = boxBlur(boxBlur(g, w, h, br), w, h, br);
    b = boxBlur(boxBlur(b, w, h, br), w, h, br);
  }
  const data = new Uint8ClampedArray(n * 4);
  const ink = P.halo ? new Float32Array(n) : null;
  for (let i = 0; i < n; i++) {
    let R = r[i];
    let G = g[i];
    let B = b[i];
    const lum = 0.299 * R + 0.587 * G + 0.114 * B;
    R = lum + (R - lum) * P.sat;
    G = lum + (G - lum) * P.sat;
    B = lum + (B - lum) * P.sat;
    R = 255 - (255 - R) * P.density;
    G = 255 - (255 - G) * P.density;
    B = 255 - (255 - B) * P.density;
    const dk = (1 - lum / 255) ** 2;
    R += P.tint[0] * dk;
    G += P.tint[1] * dk;
    B += P.tint[2] * dk;
    const p = i * 4;
    data[p] = R;
    data[p + 1] = G;
    data[p + 2] = B;
    if (ink) ink[i] = inkOf(data[p], data[p + 1], data[p + 2]);
  }
  if (ink) {
    const hr = Math.max(1, Math.round(0.012 * Math.max(w, h)));
    const halo = boxBlur(boxBlur(ink, w, h, hr), w, h, hr);
    for (let i = 0; i < n; i++) data[i * 4 + 3] = clamp(halo[i] * 2.5, 0, 1) * 255;
  }

  // Pirâmide de resoluções (mipmap) para o traço não serrilhar quando a tatuagem fica pequena.
  const levels: TexLevel[] = [{ w, h, data }];
  let cur = levels[0];
  while (cur.w >= 32 && cur.h >= 32) {
    const nw = Math.floor(cur.w / 2);
    const nh = Math.floor(cur.h / 2);
    const nd = new Uint8ClampedArray(nw * nh * 4);
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        const a = ((2 * y) * cur.w + 2 * x) * 4;
        const bq = a + 4;
        const c = a + cur.w * 4;
        const dq = c + 4;
        const o = (y * nw + x) * 4;
        for (let ch = 0; ch < 4; ch++) {
          nd[o + ch] = (cur.data[a + ch] + cur.data[bq + ch] + cur.data[c + ch] + cur.data[dq + ch]) / 4;
        }
      }
    }
    cur = { w: nw, h: nh, data: nd };
    levels.push(cur);
  }
  return { w, h, levels };
}
