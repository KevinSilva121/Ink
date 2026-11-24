// Encaixe pela área pintada: a pessoa pinta com o dedo onde a tatuagem vai ficar e o app
// devolve a tatuagem já no lugar, no tamanho, girada e curvada para cobrir aquela área.
//
// 1) o que foi pintado fora do corpo (fundo, roupa, cabelo) é descartado. Vale a pele que a
//    detecção achou e também o que foi pintado com a mesma cor dela, ligado a ela (em foto de
//    perto a detecção às vezes perde um pedaço do braço);
// 2) se sobrar mais de uma mancha, fica a maior (as próximas, como as duas metades de um
//    antebraço separadas por um relógio, contam como uma só);
// 3) a parte do corpo vem da pose; se a área passa de uma articulação com o membro quase reto
//    (fechamento de braço com o braço esticado), o membro modelado vai de ponta a ponta;
// 4) a área é medida sobre a pele (em volta do membro e ao longo dele) e o desenho é escalado
//    para cobrir essa medida.
import type { Landmark } from './vision';
import { estimateFrame, flatFrame, frameOnAxis, profileAt, type Frame, type PoseSegment } from './geometry';
import { clamp } from './util';

export interface AreaFit {
  frame: Frame;
  px: number;
  py: number;
  height: number;
  stretch: number;
  rot: number;
  curvature: number;
  /** Parte do que foi pintado que caiu fora do corpo (0..1), descartada. */
  outside: number;
  /** A área passa de uma articulação dobrada (ex.: cotovelo): a tatuagem ficou no trecho maior. */
  bent: string | null;
  /** Havia mais de uma área pintada separada: usou só a maior. */
  dropped: boolean;
}

export type AreaError = 'vazia' | 'fora';

/** A foto numa grade pequena (~480 px no lado maior): cor média de cada célula e se é pele. */
export interface SkinGrid {
  gw: number;
  gh: number;
  Y: Float32Array;
  Cb: Float32Array;
  Cr: Float32Array;
  skin: Uint8Array;
}

/** O que foi pintado (por célula da grade) e o que vale como corpo. */
export interface Accepted {
  painted: Uint8Array;
  ok: Uint8Array;
  nPainted: number;
  nOk: number;
  /** Células aceitas só pela cor (a detecção não tinha marcado como pele). */
  nColor: number;
}

export function gridSize(w: number, h: number): [number, number] {
  const g = Math.max(1, Math.max(w, h) / 480);
  return [Math.max(1, Math.round(w / g)), Math.max(1, Math.round(h / g))];
}

export function skinGrid(rgba: Uint8ClampedArray, w: number, h: number, body: Float32Array): SkinGrid {
  const [gw, gh] = gridSize(w, h);
  const n = gw * gh;
  const Y = new Float32Array(n);
  const Cb = new Float32Array(n);
  const Cr = new Float32Array(n);
  const skin = new Uint8Array(n);
  const cnt = new Float32Array(n);
  const sk = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    const j = Math.min(gh - 1, Math.floor((y * gh) / h));
    for (let x = 0; x < w; x++) {
      const k = j * gw + Math.min(gw - 1, Math.floor((x * gw) / w));
      const p = (y * w + x) * 4;
      const r = rgba[p];
      const g = rgba[p + 1];
      const b = rgba[p + 2];
      Y[k] += 0.299 * r + 0.587 * g + 0.114 * b;
      Cb[k] += 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
      Cr[k] += 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
      sk[k] += body[y * w + x];
      cnt[k]++;
    }
  }
  for (let k = 0; k < n; k++) {
    const c = cnt[k] || 1;
    Y[k] /= c;
    Cb[k] /= c;
    Cr[k] /= c;
    skin[k] = sk[k] / c >= 0.5 ? 1 : 0;
  }
  return { gw, gh, Y, Cb, Cr, skin };
}

/**
 * Separa o que foi pintado no corpo do que foi pintado fora. `alpha` é a pintura reduzida para
 * a grade (RGBA). Além da pele detectada, aceita o que tem a cor da pele pintada e está ligado a
 * ela; fundo, roupa e cabelo (outra cor) ficam de fora.
 */
export function acceptPaint(g: SkinGrid, alpha: Uint8ClampedArray): Accepted {
  const { gw, gh, Y, Cb, Cr, skin } = g;
  const n = gw * gh;
  const painted = new Uint8Array(n);
  const ok = new Uint8Array(n);
  let nPainted = 0;
  let nSkin = 0;
  let mY = 0;
  let mCb = 0;
  let mCr = 0;
  for (let k = 0; k < n; k++) {
    if (alpha[k * 4 + 3] < 128) continue;
    painted[k] = 1;
    nPainted++;
    if (!skin[k]) continue;
    ok[k] = 1;
    nSkin++;
    mY += Y[k];
    mCb += Cb[k];
    mCr += Cr[k];
  }
  if (nSkin < 8) return { painted, ok, nPainted, nOk: nSkin, nColor: 0 };
  mY /= nSkin;
  mCb /= nSkin;
  mCr /= nSkin;
  let v = 0;
  for (let k = 0; k < n; k++) if (ok[k]) v += (Cb[k] - mCb) ** 2 + (Cr[k] - mCr) ** 2;
  // Cresce a partir da pele detectada, de vizinho em vizinho: aceita quem tem cor parecida com o
  // vizinho já aceito (sombra, mancha de caneta e vermelhidão mudam a cor aos poucos) e não muito
  // longe da cor média da pele. Na borda da pele com fundo ou roupa a cor muda de repente e para.
  const tol = clamp(3 * Math.sqrt(v / nSkin), 16, 24);
  const like = (q: number, k: number) =>
    Math.hypot(Cb[q] - Cb[k], Cr[q] - Cr[k]) < 6 &&
    Math.hypot(Cb[q] - mCb, Cr[q] - mCr) < tol &&
    Y[q] > 0.35 * mY &&
    Y[q] < Math.min(255, 1.8 * mY + 25);
  const stack = new Int32Array(n);
  let sp = 0;
  for (let k = 0; k < n; k++) if (ok[k]) stack[sp++] = k;
  let nColor = 0;
  while (sp) {
    const k = stack[--sp];
    const x = k % gw;
    for (const q of [x > 0 ? k - 1 : -1, x < gw - 1 ? k + 1 : -1, k - gw, k + gw]) {
      if (q < 0 || q >= n || ok[q] || !painted[q] || !like(q, k)) continue;
      ok[q] = 1;
      nColor++;
      stack[sp++] = q;
    }
  }
  return { painted, ok, nPainted, nOk: nSkin + nColor, nColor };
}

const JOINT: Record<number, string> = {
  11: 'ombro',
  12: 'ombro',
  13: 'cotovelo',
  14: 'cotovelo',
  15: 'punho',
  16: 'punho',
  19: 'dedos',
  20: 'dedos',
  23: 'quadril',
  24: 'quadril',
  25: 'joelho',
  26: 'joelho',
  27: 'tornozelo',
  28: 'tornozelo',
};
const CHAINS = [
  [11, 13, 15, 19],
  [12, 14, 16, 20],
  [23, 25, 27],
  [24, 26, 28],
];
const PART: Record<string, string> = {
  '11-13': 'braço',
  '12-14': 'braço',
  '13-15': 'antebraço',
  '14-16': 'antebraço',
  '15-19': 'mão',
  '16-20': 'mão',
  '23-25': 'coxa',
  '24-26': 'coxa',
  '25-27': 'perna',
  '26-28': 'perna',
  // Membro inteiro (a articulação do meio não apareceu na pose).
  '11-15': 'braço + antebraço',
  '12-16': 'braço + antebraço',
  '23-27': 'coxa + perna',
  '24-28': 'coxa + perna',
};
const partOf = (a: number, b: number) => PART[`${Math.min(a, b)}-${Math.max(a, b)}`] ?? '';

/** Membro mais dobrado que isso numa articulação: não dá para modelar como um cilindro reto. */
const MAX_BEND = (35 * Math.PI) / 180;

/**
 * Trecho de membro que a área acompanha: o que tem mais pontos da área perto da linha entre as
 * duas articulações. Não decide pelo meio da área: num braço encostado no tronco, o meio de uma
 * pincelada larga cai no tronco. Devolve null se a área é mais do tronco (peito, barriga, costas).
 */
function pickLimb(pose: Landmark[], xs: number[], ys: number[]): [number, number] | null {
  const m = xs.length;
  const claimed = new Uint8Array(m);
  let best: [number, number] | null = null;
  let bestN = 0;
  // Trechos entre articulações vizinhas e, quando a do meio (cotovelo, joelho) não apareceu na
  // pose, o membro inteiro de ponta a ponta (ombro → punho, quadril → tornozelo).
  const pairs: [number, number][] = [];
  for (const c of CHAINS) {
    for (let i = 0; i + 1 < c.length; i++) pairs.push([c[i], c[i + 1]]);
    if (pose[c[1]] && pose[c[1]].v < 0.4) pairs.push([c[0], c[2]]);
  }
  {
    for (const [ia, ib] of pairs) {
      const a = pose[ia];
      const b = pose[ib];
      if (!a || !b || a.v < 0.4 || b.v < 0.4) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const L2 = dx * dx + dy * dy;
      if (L2 < 1) continue;
      const len = Math.sqrt(L2);
      let n = 0;
      for (let k = 0; k < m; k++) {
        const px = xs[k] - a.x;
        const py = ys[k] - a.y;
        const t = (px * dx + py * dy) / L2;
        if (t < -0.15 || t > 1.15) continue;
        const d = Math.abs(px * dy - py * dx) / len;
        if (d > 0.28 * len) continue;
        n++;
        if (d <= 0.2 * len) claimed[k] = 1;
      }
      if (n > bestN) {
        bestN = n;
        best = [ia, ib];
      }
    }
  }
  if (!best || bestN < 0.35 * m) return null;
  const tp = [pose[11], pose[12], pose[24], pose[23]];
  if (tp.every((p) => p && p.v >= 0.4)) {
    let nt = 0;
    for (let k = 0; k < m; k++) {
      if (claimed[k]) continue;
      let inside = false;
      for (let i = 0, j = 3; i < 4; j = i++) {
        const p = tp[i];
        const q = tp[j];
        if (p.y > ys[k] !== q.y > ys[k] && xs[k] < ((q.x - p.x) * (ys[k] - p.y)) / (q.y - p.y) + p.x) inside = !inside;
      }
      if (inside) nt++;
    }
    if (nt > bestN) return null;
  }
  return best;
}

function percentile(sorted: Float64Array, p: number): number {
  if (!sorted.length) return 0;
  return sorted[clamp(Math.round(p * (sorted.length - 1)), 0, sorted.length - 1)];
}

/** Junta manchas próximas: dilata a área e fica com a mancha que tem mais área pintada. */
function largestRegion(region: Uint8Array, gw: number, gh: number, rd: number): { keep: Uint8Array; dropped: boolean } {
  const n = gw * gh;
  // Dilatação separável (horizontal e depois vertical) com raio rd.
  const tmp = new Uint8Array(n);
  for (let y = 0; y < gh; y++) {
    let last = -1e9;
    for (let x = 0; x < gw; x++) {
      if (region[y * gw + x]) last = x;
      if (x - last <= rd) tmp[y * gw + x] = 1;
    }
    last = 1e9;
    for (let x = gw - 1; x >= 0; x--) {
      if (region[y * gw + x]) last = x;
      if (last - x <= rd) tmp[y * gw + x] = 1;
    }
  }
  const dil = new Uint8Array(n);
  for (let x = 0; x < gw; x++) {
    let last = -1e9;
    for (let y = 0; y < gh; y++) {
      if (tmp[y * gw + x]) last = y;
      if (y - last <= rd) dil[y * gw + x] = 1;
    }
    last = 1e9;
    for (let y = gh - 1; y >= 0; y--) {
      if (tmp[y * gw + x]) last = y;
      if (last - y <= rd) dil[y * gw + x] = 1;
    }
  }
  const label = new Int32Array(n);
  const stack = new Int32Array(n);
  const counts: number[] = [0];
  for (let i = 0; i < n; i++) {
    if (!dil[i] || label[i]) continue;
    const id = counts.length;
    let cnt = 0;
    let sp = 0;
    label[i] = id;
    stack[sp++] = i;
    while (sp) {
      const k = stack[--sp];
      if (region[k]) cnt++;
      const x = k % gw;
      if (x > 0 && dil[k - 1] && !label[k - 1]) (label[k - 1] = id), (stack[sp++] = k - 1);
      if (x < gw - 1 && dil[k + 1] && !label[k + 1]) (label[k + 1] = id), (stack[sp++] = k + 1);
      if (k >= gw && dil[k - gw] && !label[k - gw]) (label[k - gw] = id), (stack[sp++] = k - gw);
      if (k + gw < n && dil[k + gw] && !label[k + gw]) (label[k + gw] = id), (stack[sp++] = k + gw);
    }
    counts.push(cnt);
  }
  let best = 1;
  let total = 0;
  for (let id = 1; id < counts.length; id++) {
    total += counts[id];
    if (counts[id] > counts[best]) best = id;
  }
  const keep = new Uint8Array(n);
  for (let i = 0; i < n; i++) keep[i] = region[i] && label[i] === best ? 1 : 0;
  return { keep, dropped: total - counts[best] > 0.15 * total };
}

/**
 * Encaixa o desenho na área pintada. `aspect` é largura/altura do desenho e `ink` a fração da
 * largura e da altura dele que tem tinta (o desenho vem com uma margem em volta).
 */
export function fitArea(
  grid: SkinGrid,
  acc: Accepted,
  body: Float32Array,
  w: number,
  h: number,
  pose: Landmark[] | null,
  aspect: number,
  ink: [number, number],
): AreaFit | AreaError {
  const { gw, gh } = grid;
  const cw = w / gw;
  const ch = h / gh;
  const n = gw * gh;
  const region = acc.ok;
  const painted = acc.nPainted;
  const inside = acc.nOk;
  if (!painted) return 'vazia';
  // Quase tudo fora do corpo (ou só uma beirada encostando nele): pintou no lugar errado.
  if (inside < Math.max(40, 0.25 * painted)) return 'fora';

  const { keep, dropped } = largestRegion(region, gw, gh, Math.max(1, Math.round(0.02 * Math.min(gw, gh))));
  const xs: number[] = [];
  const ys: number[] = [];
  for (let k = 0; k < n; k++) {
    if (!keep[k]) continue;
    xs.push(((k % gw) + 0.5) * cw);
    ys.push((Math.floor(k / gw) + 0.5) * ch);
  }
  const m = xs.length;

  // Forma da área: centro e direção mais comprida.
  let mx = 0;
  let my = 0;
  for (let k = 0; k < m; k++) {
    mx += xs[k];
    my += ys[k];
  }
  mx /= m;
  my /= m;
  let cxx = 0;
  let cyy = 0;
  let cxy = 0;
  for (let k = 0; k < m; k++) {
    const dx = xs[k] - mx;
    const dy = ys[k] - my;
    cxx += dx * dx;
    cyy += dy * dy;
    cxy += dx * dy;
  }
  const th = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
  const tr = (cxx + cyy) / 2;
  const det = Math.sqrt(((cxx - cyy) / 2) ** 2 + cxy * cxy);
  const ratio = (tr + det) / Math.max(1e-6, tr - det);
  const pcaDir: [number, number] = [Math.cos(th), Math.sin(th)];

  // Ponto da área mais perto do centro (numa área em "L" o centro pode cair fora dela).
  let seed = 0;
  let bd = Infinity;
  for (let k = 0; k < m; k++) {
    const d = (xs[k] - mx) ** 2 + (ys[k] - my) ** 2;
    if (d < bd) {
      bd = d;
      seed = k;
    }
  }
  const sx = xs[seed];
  const sy = ys[seed];

  const base = estimateFrame(body, w, h, sx, sy, pose);
  let frame: Frame = base;
  let bent: string | null = null;
  /** Só os pontos da área entre estes limites (no eixo do frame final) contam para o tamanho. */
  let limit: { ax: number; ay: number; ux: number; uy: number; lo: number; hi: number } | null = null;

  // Extensão da área ao longo de uma direção, a partir de um ponto (percentis, contra borrões).
  const extent = (ox: number, oy: number, ux: number, uy: number): [number, number] => {
    const ts = new Float64Array(m);
    for (let k = 0; k < m; k++) ts[k] = (xs[k] - ox) * ux + (ys[k] - oy) * uy;
    ts.sort();
    return [percentile(ts, 0.02), percentile(ts, 0.98)];
  };

  const picked = pose ? pickLimb(pose, xs, ys) : null;
  const limb = picked ?? (base.ok && base.seg ? base.seg : null);
  if (limb && pose) {
    // Corrente de articulações do membro (ex.: ombro → cotovelo → punho), crescendo enquanto a
    // área passa da ponta e o membro continua quase reto.
    const chainOf = CHAINS.find((c) => c.includes(limb[0]) && c.includes(limb[1]));
    const P = (i: number) => pose[i];
    const chain = [...limb];
    const sameAsBase = base.ok && base.seg?.[0] === limb[0] && base.seg?.[1] === limb[1];
    // Raio do membro: o medido, ou uma estimativa pelo comprimento do trecho.
    const R = sameAsBase ? base.R : 0.13 * Math.hypot(P(limb[1]).x - P(limb[0]).x, P(limb[1]).y - P(limb[0]).y);
    let bentLo = false;
    let bentHi = false;
    if (chainOf) {
      for (const end of [1, 0] as const) {
        for (;;) {
          const last = end ? chain[chain.length - 1] : chain[0];
          const prev = end ? chain[chain.length - 2] : chain[1];
          const a = P(prev);
          const b = P(last);
          const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
          const ux = (b.x - a.x) / len;
          const uy = (b.y - a.y) / len;
          // A área passa desta articulação?
          const [, beyond] = extent(b.x, b.y, ux, uy);
          if (beyond < 0.35 * R) break;
          const at = chainOf.indexOf(last);
          const dirInChain = chainOf.indexOf(prev) < at ? 1 : -1;
          const next = chainOf[at + dirInChain];
          const c = next != null ? P(next) : null;
          if (!c || c.v < 0.4) break;
          const len2 = Math.hypot(c.x - b.x, c.y - b.y) || 1;
          const bend = Math.acos(clamp((ux * (c.x - b.x) + uy * (c.y - b.y)) / len2, -1, 1));
          if (bend > MAX_BEND) {
            bent = JOINT[last] ?? null;
            if (end) bentHi = true;
            else bentLo = true;
            break;
          }
          if (end) chain.push(next);
          else chain.unshift(next);
        }
      }
    }
    const first = P(chain[0]);
    const last = P(chain[chain.length - 1]);
    const len = Math.hypot(last.x - first.x, last.y - first.y) || 1;
    const ux = (last.x - first.x) / len;
    const uy = (last.y - first.y) / len;
    // As pontas do membro: as articulações das pontas ou, se a área vai além delas, a área.
    const [rLo, rHi] = extent(first.x, first.y, ux, uy);
    // Na articulação dobrada o membro termina ali (a parte da área depois dela fica de fora).
    const lo = bentLo ? 0 : Math.min(0, rLo);
    const hi = bentHi ? len : Math.max(len, rHi);
    const names = chain.map((i, k) => (k ? partOf(chain[k - 1], i) : '')).filter(Boolean);
    const seg: PoseSegment = {
      ax: first.x + ux * lo,
      ay: first.y + uy * lo,
      bx: first.x + ux * hi,
      by: first.y + uy * hi,
      label: [...new Set(names)].join(' + '),
      ja: JOINT[chain[0]] ?? 'fim da área',
      jb: JOINT[chain[chain.length - 1]] ?? 'fim da área',
      ia: chain[0],
      ib: chain[chain.length - 1],
    };
    // Corte transversal no ponto da linha do membro mais perto do centro da área.
    const k = clamp((mx - first.x) * ux + (my - first.y) * uy, 0, len);
    const qx = first.x + ux * k;
    const qy = first.y + uy * k;
    const onSkin = body[clamp(Math.round(qy), 0, h - 1) * w + clamp(Math.round(qx), 0, w - 1)] >= 0.5;
    const f = frameOnAxis(body, w, h, onSkin ? qx : sx, onSkin ? qy : sy, ux, uy, seg, 'área pintada + pose', onSkin);
    if (f?.ok) frame = f;
    if (bentLo || bentHi) {
      limit = { ax: first.x, ay: first.y, ux, uy, lo: bentLo ? -0.15 * R : -Infinity, hi: bentHi ? len + 0.15 * R : Infinity };
    }
  } else if (base.ok && base.part !== 'tronco' && ratio > 2.2) {
    // Sem pose: segue a direção comprida da área, de uma ponta à outra.
    const [rLo, rHi] = extent(mx, my, pcaDir[0], pcaDir[1]);
    const seg: PoseSegment = {
      ax: mx + pcaDir[0] * rLo,
      ay: my + pcaDir[1] * rLo,
      bx: mx + pcaDir[0] * rHi,
      by: my + pcaDir[1] * rHi,
      label: base.part,
      ja: 'fim da área',
      jb: 'fim da área',
    };
    const f = frameOnAxis(body, w, h, sx, sy, pcaDir[0], pcaDir[1], seg, 'área pintada');
    if (f?.ok) frame = f;
  } else if (!base.ok) {
    // Sem contorno de membro: plana, de pé na foto.
    frame = flatFrame(mx, my, w, h, 'área pintada (plana)');
  }

  // Mede a área sobre a pele: "a" em volta do membro, "t" ao longo dele.
  const f = frame;
  const curvature = !f.ok ? 0 : f.part === 'tronco' || f.hitBorder ? 0.6 : 1;
  const curved = curvature > 0.02 && Number.isFinite(f.R);
  const measure = (strict: boolean) => {
    const ts: number[] = [];
    const as: number[] = [];
    for (let k = 0; k < m; k++) {
      const x = xs[k];
      const y = ys[k];
      if (limit) {
        const lt = (x - limit.ax) * limit.ux + (y - limit.ay) * limit.uy;
        if (lt < limit.lo || lt > limit.hi) continue;
      }
      const dx = x - f.cx;
      const dy = y - f.cy;
      const t = dx * f.ux + dy * f.uy;
      const s = dx * f.vx + dy * f.vy;
      let a = s;
      if (curved) {
        const [o, r] = profileAt(f, t);
        if (strict && r <= 0.5) continue;
        const Reff = Math.max(1, r) / curvature;
        const q = (s - o) / Reff;
        // Bem fora do membro modelado: é outra parte do corpo encostada (o tronco, o outro braço).
        if (strict && Math.abs(q) > 1.1) continue;
        a = Reff * Math.asin(clamp(q, -1, 1));
      }
      ts.push(t);
      as.push(a);
    }
    return { ts, as };
  };
  let got = measure(true);
  if (got.ts.length < 0.25 * m) got = measure(false);
  const T = Float64Array.from(got.ts).sort();
  const A = Float64Array.from(got.as).sort();
  const minD = Math.min(w, h);
  const minLen = 0.03 * minD;
  let tLo = percentile(T, 0.01);
  let tHi = percentile(T, 0.99);
  let aLo = percentile(A, 0.01);
  let aHi = percentile(A, 0.99);
  if (tHi - tLo < minLen) [tLo, tHi] = [(tLo + tHi) / 2 - minLen / 2, (tLo + tHi) / 2 + minLen / 2];
  if (aHi - aLo < minLen) [aLo, aHi] = [(aLo + aHi) / 2 - minLen / 2, (aLo + aHi) / 2 + minLen / 2];
  const along = tHi - tLo;
  const across = aHi - aLo;
  const tC = (tLo + tHi) / 2;
  const aC = (aLo + aHi) / 2;

  // De pé (altura do desenho ao longo do membro) ou deitado: o que combina mais com a área.
  // Só deita com folga: muito desenho tem um "lado de cima" (letras, rostos).
  const [fx, fy] = ink;
  const inkAspect = (aspect * fx) / fy;
  const q = across / along;
  const errUp = Math.abs(Math.log(q / inkAspect));
  const errSide = Math.abs(Math.log(q * inkAspect));
  const sideways = errSide < errUp - Math.log(1.6);
  // Um pouco de esticada para acertar a área (sem deformar o desenho a ponto de aparecer).
  const stretch = clamp(sideways ? 1 / (q * inkAspect) : q / inkAspect, 0.9, 1.12);
  // Altura que cobre cada direção da área; cobre as duas, mas sem passar de 30% numa delas.
  const hAlong = sideways ? along / (aspect * stretch * fx) : along / fy;
  const hAcross = sideways ? across / fy : across / (aspect * stretch * fx);
  const height = Math.min(Math.max(hAlong, hAcross), 1.3 * Math.min(hAlong, hAcross));

  // Centro da tatuagem no centro da área (de volta para a foto).
  let s0 = aC;
  if (curved) {
    const [o, r] = profileAt(f, tC);
    const Reff = Math.max(1, r) / curvature;
    s0 = o + Reff * Math.sin(clamp(aC / Reff, -Math.PI / 2, Math.PI / 2));
  }
  const px = f.cx + f.vx * s0 + f.ux * tC;
  const py = f.cy + f.vy * s0 + f.uy * tC;

  return {
    frame: f,
    px,
    py,
    height,
    stretch,
    rot: sideways ? Math.PI / 2 : 0,
    curvature,
    outside: (painted - inside) / painted,
    bent,
    dropped,
  };
}

/** Fração da largura e da altura do desenho que tem tinta (a preparação deixa 6% de margem). */
export function inkFraction(w: number, h: number): [number, number] {
  const m = 0.06 * (Math.max(w, h) / 1.12);
  return [clamp((w - 2 * m) / w, 0.3, 1), clamp((h - 2 * m) / h, 0.3, 1)];
}
