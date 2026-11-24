// Estima o "formato" da parte do corpo no ponto tocado: direção do membro
// (eixo), centro e largura. O membro vira um cilindro onde a tatuagem é enrolada.
import type { Landmark } from './vision';
import { clamp, median, smoothstep, solveLinear } from './util';

/**
 * Perfil do membro ao longo do eixo: para cada posição t (em pixels a partir do
 * centro), o deslocamento do centro e o raio naquele ponto. É o que permite a
 * tatuagem acompanhar um membro que afina e engrossa (punho → antebraço).
 */
export interface Profile {
  start: number;
  step: number;
  /** Centro e raio usados no desenho (com as pontas e os ajustes manuais). */
  off: Float32Array;
  rad: Float32Array;
  /** Como o app detectou, sem as pontas: base para os ajustes manuais. */
  baseOff: Float32Array;
  baseRad: Float32Array;
  /** Onde o membro começa a arredondar em cada ponta, como detectado (null = pontas desconhecidas). */
  baseCaps: [number, number] | null;
  /** Já com os ajustes: onde o arredondamento começa e onde o membro termina (raio zero). */
  caps: [number, number] | null;
  ends: [number, number] | null;
  /** Articulação de cada ponta (ex.: cotovelo, punho). */
  joints: [string, string] | null;
}

/** Correções feitas à mão no "Ajustar contorno", em coordenadas do frame detectado. */
export interface ContourEdits {
  /** Pontos de ajuste das bordas: posição no eixo e deslocamento de cada borda no sentido +v. */
  knots: { t: number; a: number; b: number }[];
  /** Pontas do membro movidas à mão (posição no eixo onde o membro termina). */
  tipLo: number | null;
  tipHi: number | null;
}

/** Comprimento do arredondamento da ponta, em raios. */
const CAP = 0.6;

export interface Frame {
  /** Ponto do eixo do membro mais próximo do toque. */
  cx: number;
  cy: number;
  /** Direção do membro ("para cima" da tatuagem). */
  ux: number;
  uy: number;
  /** Direção perpendicular ("para a direita" da tatuagem). */
  vx: number;
  vy: number;
  /** Raio do cilindro em pixels (Infinity = superfície plana). */
  R: number;
  width: number;
  ok: boolean;
  /** O membro passa da borda da foto: a largura (e a curvatura) é estimada. */
  hitBorder: boolean;
  part: string;
  method: string;
  profile: Profile | null;
  /** Pontos da pose nas pontas do trecho medido (ex.: cotovelo e punho), quando veio da pose. */
  seg?: [number, number] | null;
}

const LIMBS: { a: number; b: number; label: string; ja: string; jb: string }[] = [
  { a: 11, b: 13, label: 'braço', ja: 'ombro', jb: 'cotovelo' },
  { a: 12, b: 14, label: 'braço', ja: 'ombro', jb: 'cotovelo' },
  { a: 13, b: 15, label: 'antebraço', ja: 'cotovelo', jb: 'punho' },
  { a: 14, b: 16, label: 'antebraço', ja: 'cotovelo', jb: 'punho' },
  { a: 15, b: 19, label: 'mão', ja: 'punho', jb: 'dedos' },
  { a: 16, b: 20, label: 'mão', ja: 'punho', jb: 'dedos' },
  { a: 23, b: 25, label: 'coxa', ja: 'quadril', jb: 'joelho' },
  { a: 24, b: 26, label: 'coxa', ja: 'quadril', jb: 'joelho' },
  { a: 25, b: 27, label: 'perna', ja: 'joelho', jb: 'tornozelo' },
  { a: 26, b: 28, label: 'perna', ja: 'joelho', jb: 'tornozelo' },
];

/** Faz o eixo apontar para cima na foto (ou para a direita, se estiver deitado). */
function orientUp(ux: number, uy: number): [number, number] {
  const len = Math.hypot(ux, uy) || 1;
  ux /= len;
  uy /= len;
  if (Math.abs(uy) > 0.2 ? uy > 0 : ux < 0) return [-ux, -uy];
  return [ux, uy];
}

function pca(mask: Float32Array, w: number, h: number, qx: number, qy: number, r: number) {
  const st = Math.max(1, Math.floor(r / 50));
  const x0 = Math.max(0, Math.floor(qx - r));
  const x1 = Math.min(w - 1, Math.ceil(qx + r));
  const y0 = Math.max(0, Math.floor(qy - r));
  const y1 = Math.min(h - 1, Math.ceil(qy + r));
  const r2 = r * r;
  let n = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let y = y0; y <= y1; y += st) {
    for (let x = x0; x <= x1; x += st) {
      const dx = x - qx;
      const dy = y - qy;
      if (dx * dx + dy * dy > r2 || mask[y * w + x] < 0.5) continue;
      n++;
      sx += x;
      sy += y;
      sxx += x * x;
      syy += y * y;
      sxy += x * y;
    }
  }
  if (n < 20) return null;
  const mx = sx / n;
  const my = sy / n;
  const cxx = sxx / n - mx * mx;
  const cyy = syy / n - my * my;
  const cxy = sxy / n - mx * my;
  const th = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
  const tr = (cxx + cyy) / 2;
  const det = Math.sqrt(((cxx - cyy) / 2) ** 2 + cxy * cxy);
  return { ux: Math.cos(th), uy: Math.sin(th), ratio: (tr + det) / Math.max(1e-6, tr - det) };
}

/**
 * Anda do ponto (x0,y0) na direção (dx,dy) até sair da pele. Falhas pequenas
 * na detecção (até `gapTol` pixels) não contam como borda.
 */
function march(
  mask: Float32Array,
  w: number,
  h: number,
  x0: number,
  y0: number,
  dx: number,
  dy: number,
  gapTol: number,
  maxD = Math.hypot(w, h),
): { d: number; border: boolean } {
  let last = 0;
  let miss = 0;
  for (let d = 1; d <= maxD; d++) {
    const x = Math.round(x0 + dx * d);
    const y = Math.round(y0 + dy * d);
    if (x < 0 || y < 0 || x >= w || y >= h) return { d: last + 0.5, border: true };
    if (mask[y * w + x] >= 0.5) {
      last = d;
      miss = 0;
    } else if (++miss > gapTol) break;
  }
  return { d: last + 0.5, border: false };
}

/** Mede a largura do membro em 5 cortes transversais em volta do ponto (mediana). */
function crossSection(
  mask: Float32Array,
  w: number,
  h: number,
  px: number,
  py: number,
  ux: number,
  uy: number,
  span: number,
  /** O ponto de partida está no meio do membro (linha da pose): um lado bem maior que o outro = vazou. */
  symmetric = false,
) {
  const vx = -uy;
  const vy = ux;
  const widths: number[] = [];
  const offsets: number[] = [];
  let border = false;
  const gapTol = Math.max(4, Math.round(0.012 * Math.min(w, h)));
  for (const f of [-0.4, -0.2, 0, 0.2, 0.4]) {
    const qx = px + ux * f * span;
    const qy = py + uy * f * span;
    const ix = Math.round(qx);
    const iy = Math.round(qy);
    if (ix < 0 || iy < 0 || ix >= w || iy >= h || mask[iy * w + ix] < 0.5) continue;
    const a = march(mask, w, h, qx, qy, vx, vy, gapTol);
    const b = march(mask, w, h, qx, qy, -vx, -vy, gapTol);
    let da = a.d;
    let db = b.d;
    if (symmetric && Math.max(da, db) > 1.35 * Math.min(da, db)) da = db = Math.min(da, db);
    widths.push(da + db);
    offsets.push((da - db) / 2);
    border ||= a.border || b.border;
  }
  if (!widths.length) return null;
  return { width: median(widths), offset: median(offsets), border };
}

function segmentDistance(px: number, py: number, a: Landmark, b: Landmark) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy || 1;
  const t = ((px - a.x) * dx + (py - a.y) * dy) / len2;
  const tc = clamp(t, 0, 1);
  return { t, dist: Math.hypot(px - (a.x + dx * tc), py - (a.y + dy * tc)) };
}

function insidePolygon(px: number, py: number, pts: Landmark[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if (a.y > py !== b.y > py && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Trecho do corpo entre duas articulações (ou entre as pontas de uma área pintada). */
export interface PoseSegment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  label: string;
  /** Nome das articulações nas pontas a e b. */
  ja: string;
  jb: string;
  /** Pontos da pose nas pontas a e b. */
  ia?: number;
  ib?: number;
}

/**
 * Partes do corpo candidatas para o ponto tocado, na ordem em que devem ser tentadas.
 *
 * Se o toque cai dentro do tronco (entre ombros e quadris), o tronco vem primeiro — a não
 * ser que o toque esteja bem em cima de um braço que passa na frente dele (braços cruzados).
 * Sem essa regra, um toque no peito escolhia o braço, porque o ombro fica perto.
 */
function poseCandidates(pose: Landmark[], px: number, py: number, maxDist: number): PoseSegment[] {
  const limbs: { seg: PoseSegment; d: number; len: number }[] = [];
  for (const s of LIMBS) {
    const a = pose[s.a];
    const b = pose[s.b];
    if (!a || !b || a.v < 0.4 || b.v < 0.4) continue;
    const d = segmentDistance(px, py, a, b);
    if (d.t < -0.1 || d.t > 1.1) continue;
    // Segmento da mão é curto e pouco confiável (e com braços cruzados fica embaixo do outro antebraço).
    const dist = s.label === 'mão' ? d.dist * 1.6 : d.dist;
    limbs.push({
      seg: { ax: a.x, ay: a.y, bx: b.x, by: b.y, label: s.label, ja: s.ja, jb: s.jb, ia: s.a, ib: s.b },
      d: dist,
      len: Math.hypot(b.x - a.x, b.y - a.y),
    });
  }
  limbs.sort((p, q) => p.d - q.d);

  const tp = [pose[11], pose[12], pose[24], pose[23]];
  const torsoOk = tp.every((p) => p && p.v >= 0.4);
  const torso: PoseSegment | null = torsoOk
    ? {
        ax: (tp[2].x + tp[3].x) / 2,
        ay: (tp[2].y + tp[3].y) / 2,
        bx: (tp[0].x + tp[1].x) / 2,
        by: (tp[0].y + tp[1].y) / 2,
        label: 'tronco',
        ja: 'quadril',
        jb: 'ombros',
      }
    : null;

  // Os pontos de ombro e quadril ficam nas articulações, mais para dentro que a lateral do
  // tronco (costelas, dorsais): o polígono é alargado em volta do centro.
  const grow = (f: number): Landmark[] => {
    const cx = (tp[0].x + tp[1].x + tp[2].x + tp[3].x) / 4;
    const cy = (tp[0].y + tp[1].y + tp[2].y + tp[3].y) / 4;
    return tp.map((p) => ({ x: cx + (p.x - cx) * f, y: cy + (p.y - cy) * f, v: p.v }));
  };
  if (torso && insidePolygon(px, py, grow(1.2))) {
    return [...limbs.filter((l) => l.d < 0.2 * l.len).map((l) => l.seg), torso];
  }
  const near = limbs.filter((l) => l.d < maxDist).map((l) => l.seg);
  // Perto do tronco mas fora do polígono: tenta os membros e, se nenhum contém o toque, o tronco.
  if (torso && insidePolygon(px, py, grow(1.6))) near.push(torso);
  return near;
}

export function flatFrame(px: number, py: number, w: number, h: number, method: string): Frame {
  return {
    cx: px,
    cy: py,
    ux: 0,
    uy: -1,
    vx: 1,
    vy: 0,
    R: Infinity,
    width: 0.3 * Math.min(w, h),
    ok: false,
    hitBorder: false,
    part: '',
    method,
    profile: null,
  };
}

/** Monta o frame a partir de um corte transversal e mede o perfil ao longo do eixo. */
function buildFrame(
  mask: Float32Array,
  w: number,
  h: number,
  ox: number,
  oy: number,
  ux: number,
  uy: number,
  cs: NonNullable<ReturnType<typeof crossSection>>,
  seg: PoseSegment | null,
  method: string,
  /** O eixo passa no meio do membro (linha da pose): ver estimateProfile. */
  symmetric = false,
): Frame {
  const vx = -uy;
  const vy = ux;
  const frame: Frame = {
    cx: ox + vx * cs.offset,
    cy: oy + vy * cs.offset,
    ux,
    uy,
    vx,
    vy,
    R: cs.width / 2,
    width: cs.width,
    ok: true,
    hitBorder: cs.border,
    part: seg?.label ?? '',
    method,
    profile: null,
    seg: seg?.ia != null && seg.ib != null ? [seg.ia, seg.ib] : null,
  };
  // Trecho do eixo entre as articulações (ex.: cotovelo e punho), se a pose achou.
  let range: JointRange | null = null;
  if (seg) {
    const ta = (seg.ax - frame.cx) * ux + (seg.ay - frame.cy) * uy;
    const tb = (seg.bx - frame.cx) * ux + (seg.by - frame.cy) * uy;
    range = ta <= tb ? { lo: ta, hi: tb, joints: [seg.ja, seg.jb] } : { lo: tb, hi: ta, joints: [seg.jb, seg.ja] };
  }
  frame.profile = estimateProfile(mask, w, h, frame, range, symmetric);
  if (frame.profile) {
    frame.R = Math.max(1, profileAt(frame, 0)[1]);
    frame.width = 2 * frame.R;
  }
  return frame;
}

/**
 * Mede o membro num eixo já escolhido (ex.: do ombro ao punho, num fechamento de braço com o
 * braço esticado). `seg` diz onde o membro termina; o raio e o centro vêm da pele.
 */
export function frameOnAxis(
  mask: Float32Array,
  w: number,
  h: number,
  px: number,
  py: number,
  dx: number,
  dy: number,
  seg: PoseSegment | null,
  method: string,
  /** O ponto está na linha da pose (meio do membro): um lado bem maior que o outro = vazou para o tronco. */
  symmetric = false,
): Frame | null {
  const [ux, uy] = orientUp(dx, dy);
  const minD = Math.min(w, h);
  let cs = crossSection(mask, w, h, px, py, ux, uy, 0.1 * minD, symmetric);
  if (!cs) return null;
  cs = crossSection(mask, w, h, px, py, ux, uy, clamp(cs.width * 0.9, 0.04 * minD, 0.5 * Math.max(w, h)), symmetric) ?? cs;
  return buildFrame(mask, w, h, px, py, ux, uy, cs, seg, method, symmetric);
}

/** O ponto tocado está dentro da parte do corpo modelada? */
export function containsPoint(f: Frame, px: number, py: number): boolean {
  const t = (px - f.cx) * f.ux + (py - f.cy) * f.uy;
  const s = (px - f.cx) * f.vx + (py - f.cy) * f.vy;
  const [o, r] = profileAt(f, t);
  return r > 0 && Math.abs(s - o) <= r;
}

export function estimateFrame(
  mask: Float32Array,
  w: number,
  h: number,
  px: number,
  py: number,
  pose: Landmark[] | null,
): Frame {
  const minD = Math.min(w, h);
  const ix = clamp(Math.round(px), 0, w - 1);
  const iy = clamp(Math.round(py), 0, h - 1);
  if (mask[iy * w + ix] < 0.5) return flatFrame(px, py, w, h, 'fora da pele');

  // Estimativa só pela pele: direção pela forma em volta do toque e largura pelo corte transversal.
  let ux = 0;
  let uy = -1;
  let r = 0.1 * minD;
  let qx = px;
  let qy = py;
  let cs: ReturnType<typeof crossSection> = null;
  for (let it = 0; it < 3; it++) {
    const pc = pca(mask, w, h, qx, qy, r);
    if (pc && pc.ratio > 1.8) [ux, uy] = orientUp(pc.ux, pc.uy);
    const next = crossSection(mask, w, h, px, py, ux, uy, r);
    if (!next) break;
    cs = next;
    r = clamp(cs.width * 0.9, 0.04 * minD, 0.5 * Math.max(w, h));
    qx = px - uy * cs.offset;
    qy = py + ux * cs.offset;
  }

  // Com a pose: tenta as partes do corpo candidatas e fica com a primeira que contém o toque.
  if (pose) {
    const span = cs ? cs.width : 0.1 * minD;
    for (const seg of poseCandidates(pose, px, py, cs ? Math.max(cs.width * 0.9, 0.05 * minD) : 0.1 * minD)) {
      const [sux, suy] = orientUp(seg.bx - seg.ax, seg.by - seg.ay);
      // Ponto da linha entre as articulações mais perto do toque: fica perto do meio do membro.
      const k = (px - seg.ax) * sux + (py - seg.ay) * suy;
      const lx = seg.ax + sux * k;
      const ly = seg.ay + suy * k;
      const iq = clamp(Math.round(ly), 0, h - 1) * w + clamp(Math.round(lx), 0, w - 1);
      const sym = mask[iq] >= 0.5 ? crossSection(mask, w, h, lx, ly, sux, suy, span, true) : null;
      const segCs = sym ?? crossSection(mask, w, h, px, py, sux, suy, span);
      if (!segCs) continue;
      const f = sym
        ? buildFrame(mask, w, h, lx, ly, sux, suy, sym, seg, 'pose + contorno da pele', true)
        : buildFrame(mask, w, h, px, py, sux, suy, segCs, seg, 'pose + contorno da pele');
      if (containsPoint(f, px, py)) return f;
    }
  }

  if (!cs) return flatFrame(px, py, w, h, 'sem contorno');
  return buildFrame(mask, w, h, px, py, ux, uy, cs, null, 'contorno da pele');
}


/**
 * Modela o membro ao longo do eixo: linha do meio (o) e raio (r) que variam
 * suavemente — o = o0 + o1·τ e r = r0 + r1·τ + r2·τ² — ajustados às bordas da pele.
 *
 * As bordas medidas mentem de dois jeitos: "fogem" para fora onde outra pele
 * encosta (a outra mão, o tronco, o braço de cima) e "entram" onde algo cobre
 * a pele (relógio) ou a detecção falha. O ajuste quase ignora esses pontos e,
 * onde uma borda está escondida, deduz pela borda oposta (o membro afina dos
 * dois lados por igual).
 */
interface JointRange {
  lo: number;
  hi: number;
  joints: [string, string];
}

export function estimateProfile(
  mask: Float32Array,
  w: number,
  h: number,
  f: Frame,
  range: JointRange | null,
  /**
   * O eixo é a linha da pose, no meio do membro. Um lado medindo bem mais que o outro é pele
   * encostada (braço colado no tronco): esse lado vira o espelho do outro. Sem isso, com o braço
   * encostado o membro inteiro, o raio saía do tamanho do tronco.
   */
  symmetric = false,
): Profile | null {
  if (!f.ok) return null;
  const minD = Math.min(w, h);
  const step = Math.max(2, Math.round(minD / 300));
  const maxT = Math.hypot(w, h);
  const n = Math.floor((2 * maxT) / step) + 1;
  const start = -maxT;
  const i0 = Math.round(-start / step);
  const R0 = f.R;
  const gapTol = Math.max(4, Math.round(0.012 * minD));
  const maxD = 3 * R0 + 20;

  // 1) Mede as duas bordas a partir da linha do eixo, para os dois lados do toque.
  const A = new Float32Array(n).fill(NaN);
  const B = new Float32Array(n).fill(NaN);
  let lo = i0;
  let hi = i0;
  for (const dir of [1, -1]) {
    let miss = 0;
    for (let i = i0; i >= 0 && i < n; i += dir) {
      const t = start + i * step;
      const px = f.cx + f.ux * t;
      const py = f.cy + f.uy * t;
      const ix = Math.round(px);
      const iy = Math.round(py);
      if (ix < 0 || iy < 0 || ix >= w || iy >= h) break;
      if (mask[iy * w + ix] < 0.5) {
        if (++miss * step > 0.8 * R0) break;
        continue;
      }
      miss = 0;
      const a = march(mask, w, h, px, py, f.vx, f.vy, gapTol, maxD);
      const b = march(mask, w, h, px, py, -f.vx, -f.vy, gapTol, maxD);
      if (!a.border) A[i] = a.d;
      if (!b.border) B[i] = -b.d;
      if (symmetric && !a.border && !b.border) {
        if (a.d > 1.8 * b.d) A[i] = b.d;
        else if (b.d > 1.8 * a.d) B[i] = -a.d;
      }
      lo = Math.min(lo, i);
      hi = Math.max(hi, i);
    }
  }

  // 2) Janela do ajuste: entre as articulações (com folga) ou ±4 raios em volta do toque.
  const idxOf = (t: number) => Math.round((t - start) / step);
  let wLo: number;
  let wHi: number;
  const margin = range ? 0.1 * (range.hi - range.lo) : 0;
  if (range) {
    wLo = Math.max(lo, idxOf(range.lo - margin));
    wHi = Math.min(hi, idxOf(range.hi + margin));
  } else {
    const k = Math.round((4 * R0) / step);
    wLo = Math.max(lo, i0 - k);
    wHi = Math.min(hi, i0 + k);
  }
  wLo = Math.min(wLo, i0);
  wHi = Math.max(wHi, i0);
  const tc = start + ((wLo + wHi) / 2) * step;
  const Lh = Math.max(step, ((wHi - wLo) / 2) * step);

  const tau: number[] = [];
  const top: number[] = [];
  const bot: number[] = [];
  const halves: number[] = [];
  const mids: number[] = [];
  for (let i = wLo; i <= wHi; i++) {
    if (Number.isNaN(A[i]) && Number.isNaN(B[i])) continue;
    tau.push((start + i * step - tc) / Lh);
    top.push(A[i]);
    bot.push(B[i]);
    if (!Number.isNaN(A[i]) && !Number.isNaN(B[i])) {
      halves.push((A[i] - B[i]) / 2);
      mids.push((A[i] + B[i]) / 2);
    }
  }
  const N = top.filter((x) => !Number.isNaN(x)).length + bot.filter((x) => !Number.isNaN(x)).length;
  if (N < 8) return null;

  // 3) Ajuste robusto (mínimos quadrados reponderados). Pontos da borda muito mais longe que o
  // modelo (pele encostada) ou muito mais perto (relógio, falha da detecção) quase não contam.
  // Quando a borda inteira está encostada em outra pele, não há como saber só pela pele —
  // para esses casos existe o "Ajustar contorno" manual.
  const sortedHalves = [...halves].sort((x, y) => x - y);
  const r0init = sortedHalves.length ? sortedHalves[Math.floor(sortedHalves.length * 0.3)] : R0;
  const cleanMids = mids.filter((_, k) => halves[k] <= r0init * 1.15);
  let p = [cleanMids.length ? median(cleanMids) : 0, 0, r0init, 0, 0]; // o0, o1, r0, r1, r2
  const weight = (e: number, r: number) => {
    if (e > 0.1 * r + 3) return 0.03;
    if (e < -0.25 * r) return 0.03;
    return 1;
  };
  for (let it = 0; it < 15; it++) {
    const M = Array.from({ length: 5 }, () => [0, 0, 0, 0, 0]);
    const v = [0, 0, 0, 0, 0];
    const add = (row: number[], y: number, wt: number) => {
      for (let a = 0; a < 5; a++) {
        v[a] += wt * row[a] * y;
        for (let b = 0; b < 5; b++) M[a][b] += wt * row[a] * row[b];
      }
    };
    for (let k = 0; k < tau.length; k++) {
      const t = tau[k];
      const r = Math.max(1, p[2] + p[3] * t + p[4] * t * t);
      const o = p[0] + p[1] * t;
      if (!Number.isNaN(top[k])) add([1, t, 1, t, t * t], top[k], weight(top[k] - (o + r), r));
      if (!Number.isNaN(bot[k])) add([1, t, -1, -t, -t * t], bot[k], weight(o - r - bot[k], r));
    }
    // Preferências fracas: centro perto da linha do eixo, centro sem inclinação, pouca barriga.
    M[0][0] += 0.02 * N;
    M[1][1] += 0.1 * N;
    M[4][4] += 0.01 * N;
    const next = solveLinear(M, v);
    if (!next) break;
    p = next;
  }

  // 4) Tabela final. Fora da janela mantém os valores da ponta.
  const baseOff = new Float32Array(n);
  const baseRad = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = clamp((start + i * step - tc) / Lh, -1, 1);
    const r = clamp(p[2] + p[3] * t + p[4] * t * t, 0.3 * R0, 3 * R0);
    baseOff[i] = p[0] + p[1] * t;
    // Leve folga para fora: a tinta vai até a borda real (o recorte pela pele impede passar dela).
    baseRad[i] = r * 1.04 + 2;
  }
  // Se a pose disse onde ficam as articulações, o membro termina arredondado logo depois delas
  // (a tinta não continua para outra parte do corpo encostada, como o outro braço). A ponta
  // fica na articulação mesmo que a medição tenha parado antes (relógio, pulseira, sombra).
  const base: Profile = {
    start,
    step,
    off: baseOff,
    rad: baseRad,
    baseOff,
    baseRad,
    baseCaps: range ? [range.lo - margin, range.hi + margin] : null,
    caps: null,
    ends: null,
    joints: range ? range.joints : null,
  };
  return finishProfile(base, null);
}

/** Deslocamento das duas bordas na posição t, interpolado suavemente entre os pontos de ajuste. */
export function shiftAt(knots: ContourEdits['knots'], t: number): [number, number] {
  if (!knots.length) return [0, 0];
  const first = knots[0];
  const last = knots[knots.length - 1];
  if (t <= first.t) return [first.a, first.b];
  if (t >= last.t) return [last.a, last.b];
  let j = 1;
  while (knots[j].t < t) j++;
  const p = knots[j - 1];
  const q = knots[j];
  const s = q.t > p.t ? smoothstep(p.t, q.t, t) : 1;
  return [p.a + (q.a - p.a) * s, p.b + (q.b - p.b) * s];
}

function sample(arr: Float32Array, start: number, step: number, t: number): number {
  const x = (t - start) / step;
  const i = clamp(Math.floor(x), 0, arr.length - 2);
  const a = clamp(x - i, 0, 1);
  return arr[i] + (arr[i + 1] - arr[i]) * a;
}

/** Aplica as correções manuais (bordas e pontas) sobre o perfil detectado e arredonda as pontas. */
function finishProfile(p: Profile, e: ContourEdits | null): Profile {
  const { start, step, baseOff, baseRad } = p;
  const n = baseOff.length;
  const knots = e?.knots ?? [];
  const off = new Float32Array(n);
  const rad = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const [a, b] = shiftAt(knots, start + i * step);
    off[i] = baseOff[i] + (a + b) / 2;
    rad[i] = Math.max(1, baseRad[i] + (a - b) / 2);
  }
  if (!p.baseCaps) return { ...p, off, rad, caps: null, ends: null };

  const radAt = (t: number) => sample(rad, start, step, t);
  let [cLo, cHi] = p.baseCaps;
  let eLo = cLo - CAP * radAt(cLo);
  let eHi = cHi + CAP * radAt(cHi);
  if (e?.tipLo != null) {
    eLo = e.tipLo;
    cLo = eLo + CAP * radAt(eLo);
  }
  if (e?.tipHi != null) {
    eHi = e.tipHi;
    cHi = eHi - CAP * radAt(eHi);
  }
  if (cHi < cLo) cLo = cHi = (cLo + cHi) / 2;
  eLo = Math.min(eLo, cLo - 1);
  eHi = Math.max(eHi, cHi + 1);
  for (let i = 0; i < n; i++) {
    const t = start + i * step;
    let u = 0;
    if (t > cHi) u = (t - cHi) / (eHi - cHi);
    else if (t < cLo) u = (cLo - t) / (cLo - eLo);
    else continue;
    rad[i] = u >= 1 ? 0 : rad[i] * Math.sqrt(1 - u * u);
  }
  return { ...p, off, rad, caps: [cLo, cHi], ends: [eLo, eHi] };
}


export const noEdits = (): ContourEdits => ({ knots: [], tipLo: null, tipHi: null });

export const cloneEdits = (e: ContourEdits): ContourEdits => ({
  knots: e.knots.map((k) => ({ ...k })),
  tipLo: e.tipLo,
  tipHi: e.tipHi,
});

/**
 * Cópia do frame com as correções manuais: bordas deslocadas (`a` move a borda do lado +v
 * e `b` a do lado -v, ambas no sentido +v, em pixels) e pontas do membro movidas.
 */
export function withEdits(f: Frame, e: ContourEdits): Frame {
  if (!f.ok) return f;
  const [a, b] = shiftAt(e.knots, 0);
  const R = Math.max(1, f.R + (a - b) / 2);
  if (!f.profile) {
    const d = (a + b) / 2;
    return { ...f, cx: f.cx + f.vx * d, cy: f.cy + f.vy * d, R, width: 2 * R };
  }
  return { ...f, R, width: 2 * R, profile: finishProfile(f.profile, e) };
}

/**
 * Leva as correções de um frame para outro do mesmo membro (depois de mover a tatuagem o
 * app mede o membro de novo, a partir de outro ponto).
 */
export function transferEdits(e: ContourEdits, from: Frame, to: Frame): ContourEdits {
  const flip = from.ux * to.ux + from.uy * to.uy < 0;
  const tt = (t: number) => (from.cx + from.ux * t - to.cx) * to.ux + (from.cy + from.uy * t - to.cy) * to.uy;
  const knots = e.knots
    .map((k) => ({ t: tt(k.t), a: flip ? -k.b : k.a, b: flip ? -k.a : k.b }))
    .sort((p, q) => p.t - q.t);
  const lo = e.tipLo == null ? null : tt(e.tipLo);
  const hi = e.tipHi == null ? null : tt(e.tipHi);
  return flip ? { knots, tipLo: hi, tipHi: lo } : { knots, tipLo: lo, tipHi: hi };
}

/** Centro (deslocamento) e raio do membro na posição t do eixo. */
export function profileAt(f: Frame, t: number): [number, number] {
  const p = f.profile;
  if (!p) return [0, f.R];
  const x = (t - p.start) / p.step;
  const n = p.off.length;
  const i = clamp(Math.floor(x), 0, n - 2);
  const a = clamp(x - i, 0, 1);
  return [p.off[i] + (p.off[i + 1] - p.off[i]) * a, p.rad[i] + (p.rad[i + 1] - p.rad[i]) * a];
}
