// Tela "Extrair de uma foto": a pessoa marca a tatuagem numa foto (na pele de alguém)
// e recebe o desenho em fundo branco, pronto para provar no próprio corpo.
import { analyze, loadModels, type Landmark } from './vision';
import { estimateFrame, profileAt, type Frame } from './geometry';
import {
  buildMap,
  backgroundMask,
  prepFinish,
  renderFinish,
  sampleDesign,
  separateInk,
  trimScraps,
  type DesignMap,
  type ExtractGeometry,
  type Finish,
  type FinishPrep,
  type InkImage,
  type SampledDesign,
  type TrimResult,
} from './extract';
import { MagnetLasso, edgeCost } from './magnet';
import { clamp, loadToCanvas, smoothstep } from './util';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const nextPaint = () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));

const dlg = $<HTMLDialogElement>('extractor');
const statusEl = $('xStatus');
const pickView = $('xPick');
const resultView = $('xResult');
const photoCv = $<HTMLCanvasElement>('xPhoto');
const outCv = $<HTMLCanvasElement>('xOut');
const paper = outCv.parentElement!;
const cleanIn = $<HTMLInputElement>('xClean');
const gainIn = $<HTMLInputElement>('xGain');
const sharpIn = $<HTMLInputElement>('xSharp');
const unwrapIn = $<HTMLInputElement>('xUnwrap');
const trimIn = $<HTMLInputElement>('xTrim');
const eraseBtn = $('xErase');
const undoBtn = $<HTMLButtonElement>('xUndo');

/** Resolução máxima da foto guardada (detalhe da tatuagem) e da foto usada na análise do corpo. */
const HI_SIDE = 3200;
const AN_SIDE = 1600;
/** Maior lado da região processada. */
const WORK_SIDE = 1400;

interface Stroke {
  r: number;
  pts: [number, number][];
}

interface Work {
  ink: InkImage;
  /** Dentro do contorno (0..255), na imagem de trabalho. */
  keep: Uint8Array;
  /** Contorno já sem o fundo em volta do membro (rebarbas), quando deu para achar a silhueta. */
  keepLimb: Uint8Array | null;
  /** Contorno feito com o ímã (já colado na tatuagem). */
  snapped: boolean;
  geo: ExtractGeometry;
  frame: Frame | null;
  map: DesignMap;
  design: SampledDesign;
  prep: FinishPrep;
  trim: TrimResult;
  erase: Uint8Array | null;
  strokes: Stroke[];
  rot: number;
  scale: number;
}

interface Session {
  hi: HTMLCanvasElement;
  an: HTMLCanvasElement;
  anRgba: Uint8ClampedArray;
  /** Foto de análise → foto guardada. */
  kAH: number;
  analysis: Promise<{ skin: Float32Array | null; pose: Landmark[] | null }>;
  /** Contorno marcado (foto de análise) e o retângulo em volta dele. */
  poly: Pt[] | null;
  rect: Rect | null;
  /** O contorno veio do ímã (grudado na borda do desenho). */
  snapped: boolean;
  /** Mapa de bordas para o ímã (calculado uma vez por foto). */
  cost: Uint8Array | null;
  work: Work | null;
}

let S: Session | null = null;
let onUse: ((blob: Blob) => void) | null = null;
let busy = false;

const setStatus = (msg: string) => (statusEl.textContent = msg);

export async function openExtractor(file: Blob, use: (blob: Blob) => void) {
  onUse = use;
  S = null;
  showPick();
  if (!dlg.open) dlg.showModal();
  setStatus('Carregando foto…');
  try {
    const hi = await loadToCanvas(file, HI_SIDE);
    const s = Math.min(1, AN_SIDE / Math.max(hi.width, hi.height));
    const an = document.createElement('canvas');
    an.width = Math.max(1, Math.round(hi.width * s));
    an.height = Math.max(1, Math.round(hi.height * s));
    const actx = an.getContext('2d', { willReadFrequently: true })!;
    actx.imageSmoothingQuality = 'high';
    actx.drawImage(hi, 0, 0, an.width, an.height);
    const anRgba = actx.getImageData(0, 0, an.width, an.height).data;
    const sess: Session = {
      hi,
      an,
      anRgba,
      kAH: hi.width / an.width,
      analysis: runAnalysis(an),
      poly: null,
      rect: null,
      snapped: false,
      cost: null,
      work: null,
    };
    S = sess;
    photoCv.width = an.width;
    photoCv.height = an.height;
    drawPick();
    setStatus(pickHint());
    // Prepara o mapa de bordas do ímã antes do primeiro toque.
    setTimeout(() => {
      if (S === sess && !sess.cost) sess.cost = edgeCost(anRgba, an.width, an.height);
    }, 30);
  } catch (err) {
    console.error(err);
    setStatus('Não consegui abrir essa foto. Tente outra (JPG ou PNG).');
  }
}

/** Pele e pose da foto (para desenrolar a curva do membro). Sem os modelos, segue sem desenrolar. */
async function runAnalysis(an: HTMLCanvasElement) {
  try {
    await loadModels();
  } catch {
    return { skin: null, pose: null };
  }
  await nextPaint();
  const res = analyze(an);
  return { skin: res.skin ? fillHoles(res.skin, an.width, an.height) : null, pose: res.pose };
}

/**
 * Tinta escura às vezes não é reconhecida como pele pelo modelo: os "buracos" cercados de
 * pele viram pele, para o contorno do membro não parar no meio da tatuagem.
 */
function fillHoles(skin: Float32Array, w: number, h: number): Float32Array {
  const n = w * h;
  const outside = new Uint8Array(n);
  const stack = new Int32Array(n);
  let sp = 0;
  const push = (i: number) => {
    if (!outside[i] && skin[i] < 0.5) {
      outside[i] = 1;
      stack[sp++] = i;
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (sp > 0) {
    const i = stack[--sp];
    const x = i % w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (i >= w) push(i - w);
    if (i < n - w) push(i + w);
  }
  const out = skin.slice();
  for (let i = 0; i < n; i++) if (!outside[i] && out[i] < 0.5) out[i] = 1;
  return out;
}

type Pt = [number, number];
type Rect = [number, number, number, number];

const bboxOf = (poly: Pt[]): Rect => {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of poly) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return [x0, y0, x1, y1];
};

function pointInPoly(px: number, py: number, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[i];
    const [bx, by] = poly[j];
    if (ay > py !== by > py && px < ((bx - ax) * (py - ay)) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}

/**
 * Preenche o contorno num mapa 0..255 (com borda suave), já levado para outra escala.
 * `grow` alarga o contorno para fora (em pixels do mapa).
 */
function rasterPoly(poly: Pt[], w: number, h: number, k = 1, ox = 0, oy = 0, grow = 0): Uint8Array {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.fillStyle = '#fff';
  g.strokeStyle = '#fff';
  g.beginPath();
  poly.forEach(([x, y], i) => (i ? g.lineTo(x * k - ox, y * k - oy) : g.moveTo(x * k - ox, y * k - oy)));
  g.closePath();
  g.fill();
  if (grow > 0) {
    g.lineWidth = 2 * grow;
    g.lineJoin = 'round';
    g.stroke();
  }
  const d = g.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4 + 3];
  return out;
}

/**
 * Membro em volta do contorno marcado: tenta no centro e, se lá não for pele, em pontos em
 * volta. Descarta resultado implausível: um "membro" mais estreito que a tatuagem marcada é,
 * na verdade, um pedaço dela (e desentortar com ele estragaria o desenho). Já um membro
 * largo demais só desentorta menos, o que não estraga.
 */
function findFrame(mask: Float32Array, w: number, h: number, poly: Pt[], pose: Landmark[] | null): Frame | null {
  const [rx0, ry0, rx1, ry1] = bboxOf(poly);
  const cx = (rx0 + rx1) / 2;
  const cy = (ry0 + ry1) / 2;
  const dx = (rx1 - rx0) * 0.25;
  const dy = (ry1 - ry0) * 0.25;
  const tries = [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, 1], [-1, 1], [1, -1]];
  for (const [i, j] of tries) {
    const px = clamp(cx + i * dx, 0, w - 1);
    const py = clamp(cy + j * dy, 0, h - 1);
    if (mask[Math.round(py) * w + Math.round(px)] < 0.5) continue;
    const f = estimateFrame(mask, w, h, px, py, pose);
    if (!f.ok || !f.profile) continue;
    let lo = Infinity;
    let hi = -Infinity;
    for (const [x, y] of poly) {
      const s = (x - f.cx) * f.vx + (y - f.cy) * f.vy;
      lo = Math.min(lo, s);
      hi = Math.max(hi, s);
    }
    if (2 * f.R < 0.75 * (hi - lo)) continue;
    // O miolo da região marcada tem que estar dentro do membro (senão o membro achado é
    // outra coisa, e desentortar com ele estragaria o desenho).
    let tot = 0;
    let ok = 0;
    for (let a = 0; a < 5; a++) {
      for (let b = 0; b < 5; b++) {
        const qx = rx0 + (rx1 - rx0) * (0.25 + (0.5 * a) / 4);
        const qy = ry0 + (ry1 - ry0) * (0.25 + (0.5 * b) / 4);
        if (!pointInPoly(qx, qy, poly)) continue;
        tot++;
        const t = (qx - f.cx) * f.ux + (qy - f.cy) * f.uy;
        const s = (qx - f.cx) * f.vx + (qy - f.cy) * f.vy;
        const [o, r] = profileAt(f, t);
        if (Math.abs(s - o) <= r) ok++;
      }
    }
    if (tot && ok < 0.8 * tot) continue;
    return f;
  }
  return null;
}

/**
 * Pele pela cor, tomando como referência o tom de pele em volta do contorno (e não um
 * ponto, que pode cair na tinta). Fica só o que está ligado a essa pele, e a tinta cercada
 * de pele (buracos) conta como parte do membro.
 */
function ringColorMask(rgba: Uint8ClampedArray, w: number, h: number, poly: Pt[], inside: Uint8Array) {
  const [rx0, ry0, rx1, ry1] = bboxOf(poly);
  const pad = 0.15 * Math.max(rx1 - rx0, ry1 - ry0);
  const ycc = (p: number): [number, number, number] => {
    const r = rgba[p];
    const g = rgba[p + 1];
    const b = rgba[p + 2];
    return [0.299 * r + 0.587 * g + 0.114 * b, -0.1687 * r - 0.3313 * g + 0.5 * b, 0.5 * r - 0.4187 * g - 0.0813 * b];
  };
  const seeds: number[] = [];
  const Ys: number[] = [];
  const Cbs: number[] = [];
  const Crs: number[] = [];
  const x0 = Math.max(0, Math.floor(rx0 - pad));
  const x1 = Math.min(w - 1, Math.ceil(rx1 + pad));
  const y0 = Math.max(0, Math.floor(ry0 - pad));
  const y1 = Math.min(h - 1, Math.ceil(ry1 + pad));
  const step = Math.max(1, Math.round(Math.max(x1 - x0, y1 - y0) / 400));
  for (let y = y0; y <= y1; y += step) {
    for (let x = x0; x <= x1; x += step) {
      if (inside[y * w + x] > 127) continue;
      const [Y, cb, cr] = ycc((y * w + x) * 4);
      if (Y > 40 && cr > 3 && cr < 54 && cb > -58 && cb < 8) {
        seeds.push(y * w + x);
        Ys.push(Y);
        Cbs.push(cb);
        Crs.push(cr);
      }
    }
  }
  if (seeds.length < 30) return null;
  const sorted = (a: number[]) => [...a].sort((p, q) => p - q);
  const mid = (a: number[]) => sorted(a)[Math.floor(a.length / 2)];
  const mY = mid(Ys);
  const mCb = mid(Cbs);
  const mCr = mid(Crs);
  const n = w * h;
  const like = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const [Y, cb, cr] = ycc(i * 4);
    like[i] = Y > 0.3 * mY && Y < 1.9 * mY + 20 && Math.hypot(cb - mCb, cr - mCr) < 16 ? 1 : 0;
  }
  // Conectado à pele do anel.
  const keep = new Float32Array(n);
  const stack = new Int32Array(n);
  let sp = 0;
  for (const s of seeds) {
    if (like[s] && !keep[s]) {
      keep[s] = 1;
      stack[sp++] = s;
    }
  }
  while (sp > 0) {
    const i = stack[--sp];
    const x = i % w;
    const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < n - w ? i + w : -1];
    for (const j of nb) {
      if (j >= 0 && like[j] && !keep[j]) {
        keep[j] = 1;
        stack[sp++] = j;
      }
    }
  }
  return fillHoles(keep, w, h);
}

/**
 * A tatuagem tem cor de verdade? Conta os pixels dentro do contorno com cor forte e diferente
 * do tom da pele (verde, azul, vermelho, amarelo). Preto e cinza na pele só tem tons de pele
 * e cinzas; a escolha inicial do tipo vem daqui (a pessoa pode trocar).
 */
function looksColorful(rgba: Uint8ClampedArray, keep: Uint8Array, ring: Uint8Array): boolean {
  const n = keep.length;
  const step = Math.max(1, Math.floor(n / 150000));
  const ycc = (i: number) => {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    return [0.299 * r + 0.587 * g + 0.114 * b, -0.1687 * r - 0.3313 * g + 0.5 * b, 0.5 * r - 0.4187 * g - 0.0813 * b];
  };
  const cbs: number[] = [];
  const crs: number[] = [];
  for (let i = 0; i < n; i += step) {
    if (!ring[i]) continue;
    const [y, cb, cr] = ycc(i);
    if (y > 40 && cr > 3 && cr < 54 && cb > -58 && cb < 8) {
      cbs.push(cb);
      crs.push(cr);
    }
  }
  const mid = (a: number[]) => [...a].sort((p, q) => p - q)[Math.floor(a.length / 2)];
  const sCb = cbs.length > 20 ? mid(cbs) : -12;
  const sCr = crs.length > 20 ? mid(crs) : 20;
  let inside = 0;
  let colorful = 0;
  for (let i = 0; i < n; i += step) {
    if (keep[i] < 128) continue;
    inside++;
    const [y, cb, cr] = ycc(i);
    if (y < 25) continue;
    if (Math.hypot(cb, cr) > 16 && Math.hypot(cb - sCb, cr - sCr) > 20) colorful++;
  }
  return inside > 0 && colorful / inside > 0.06;
}

// ---------- Marcar a tatuagem ----------
function showPick() {
  pickView.hidden = false;
  resultView.hidden = true;
  setErase(false);
}

const HINTS = {
  ima: 'Passe o dedo (ou o mouse) em volta da tatuagem, perto da borda: a linha gruda na borda sozinha. Solte perto de onde começou para fechar.',
  livre:
    'Contorne a tatuagem com o dedo (ou o mouse), deixando um pouco de pele em volta. O que ficar fora do contorno não entra.',
};
const cutMode = () =>
  (document.querySelector<HTMLInputElement>('input[name="xCut"]:checked')?.value ?? 'ima') as keyof typeof HINTS;
const pickHint = () => HINTS[cutMode()];
document.querySelectorAll<HTMLInputElement>('input[name="xCut"]').forEach((el) =>
  el.addEventListener('change', () => {
    if (S && !S.work) setStatus(pickHint());
  }),
);

/** Desenha a foto com o contorno: em andamento (traço livre ou ímã) ou já fechado. */
function drawPick(live?: Pt[], magnet?: MagnetLasso) {
  if (!S) return;
  const ctx = photoCv.getContext('2d')!;
  ctx.drawImage(S.an, 0, 0);
  const lw = Math.max(2, Math.min(photoCv.width, photoCv.height) / 300);
  ctx.lineWidth = lw;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#e0b36a';
  const path = (pts: Pt[], close: boolean) => {
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    if (close) ctx.closePath();
  };
  if (magnet) {
    // Trecho fixo (dourado), trecho que acompanha o dedo (claro) e pontos fixos.
    path(magnet.path, false);
    ctx.stroke();
    if (magnet.live.length > 1) {
      ctx.strokeStyle = '#fff3d6';
      path(magnet.live, false);
      ctx.stroke();
    }
    ctx.fillStyle = '#e0b36a';
    for (const [x, y] of magnet.anchors) {
      ctx.beginPath();
      ctx.arc(x, y, lw * 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
    return;
  }
  if (live) {
    path(live, false);
    ctx.stroke();
    return;
  }
  if (!S.poly) return;
  // Escurece o que ficou de fora.
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.beginPath();
  ctx.rect(0, 0, photoCv.width, photoCv.height);
  S.poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.fill('evenodd');
  path(S.poly, true);
  ctx.stroke();
}

function canvasPoint(cv: HTMLCanvasElement, e: PointerEvent) {
  const r = cv.getBoundingClientRect();
  return { x: ((e.clientX - r.left) * cv.width) / r.width, y: ((e.clientY - r.top) * cv.height) / r.height };
}

/** Traço do dedo (sempre) e o contorno ímã em andamento (no modo ímã). */
let lasso: Pt[] | null = null;
let magnet: MagnetLasso | null = null;
let pendingPts: Pt[] = [];
let magnetFrame = 0;

const polyArea = (poly: Pt[]) => {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1]);
  return Math.abs(a / 2);
};

photoCv.addEventListener('pointerdown', (e) => {
  if (!S || busy) return;
  photoCv.setPointerCapture(e.pointerId);
  const p = canvasPoint(photoCv, e);
  lasso = [[p.x, p.y]];
  magnet = null;
  if (cutMode() === 'ima') {
    S.cost ??= edgeCost(S.anRgba, S.an.width, S.an.height);
    // A faixa onde a linha pode grudar: ~14 px na tela.
    const R = (14 * photoCv.width) / Math.max(1, photoCv.getBoundingClientRect().width);
    magnet = new MagnetLasso(S.cost, S.an.width, S.an.height, R);
    magnet.start(p.x, p.y);
    drawPick(undefined, magnet);
  }
});
photoCv.addEventListener('pointermove', (e) => {
  if (!S || !lasso) return;
  const p = canvasPoint(photoCv, e);
  const [lx, ly] = lasso[lasso.length - 1];
  if (Math.hypot(p.x - lx, p.y - ly) < 2) return;
  const q: Pt = [clamp(p.x, 0, photoCv.width - 1), clamp(p.y, 0, photoCv.height - 1)];
  lasso.push(q);
  if (!magnet) {
    drawPick(lasso);
    return;
  }
  // O ímã recalcula no máximo uma vez por quadro (o dedo manda muitos pontos).
  pendingPts.push(q);
  magnetFrame ||= requestAnimationFrame(() => {
    magnetFrame = 0;
    if (!magnet || !pendingPts.length) return;
    magnet.move(pendingPts);
    pendingPts = [];
    drawPick(undefined, magnet);
  });
});
const endPick = () => {
  if (!S || !lasso) return;
  const trace = lasso;
  lasso = null;
  if (magnetFrame) cancelAnimationFrame(magnetFrame);
  magnetFrame = 0;
  if (magnet && pendingPts.length) magnet.move(pendingPts);
  pendingPts = [];
  let poly = magnet ? magnet.end() : trace;
  const snapped = !!magnet;
  magnet = null;
  const [x0, y0, x1, y1] = bboxOf(trace);
  const minSide = 0.03 * Math.min(photoCv.width, photoCv.height);
  if (trace.length < 3 || x1 - x0 < minSide || y1 - y0 < minSide) {
    drawPick();
    setStatus(pickHint());
    return;
  }
  // Arrastou em linha reta (de um canto ao outro): vira o retângulo entre os dois pontos.
  if (polyArea(trace) < 0.15 * (x1 - x0) * (y1 - y0)) {
    poly = [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ];
    S.snapped = false;
  } else S.snapped = snapped;
  S.poly = poly;
  S.rect = bboxOf(poly);
  drawPick();
  void process().catch((err) => {
    console.error(err);
    busy = false;
    setStatus('Algo deu errado ao separar a tatuagem. Tente marcar de novo.');
  });
};
photoCv.addEventListener('pointerup', endPick);
photoCv.addEventListener('pointercancel', endPick);

// ---------- Processar ----------
async function process() {
  const sess = S;
  if (!sess?.rect) return;
  busy = true;
  setStatus('Separando a tinta da pele…');
  await nextPaint();
  const { skin, pose } = await sess.analysis;
  await nextPaint();
  if (S !== sess || !sess.rect || !sess.poly) return; // fechou ou trocou de foto no meio
  const { an, hi, kAH, poly } = sess;
  const rect = sess.rect;
  const [rx0, ry0, rx1, ry1] = rect;

  // Formato do membro (para desentortar). Primeiro com a pele do modelo; em foto de perto
  // (só o braço) o modelo costuma falhar, então tenta pela cor da pele em volta.
  let frame = skin ? findFrame(skin, an.width, an.height, poly, pose) : null;
  let cm: Float32Array | null = null;
  if (!frame) {
    cm = ringColorMask(sess.anRgba, an.width, an.height, poly, rasterPoly(poly, an.width, an.height));
    if (cm) frame = findFrame(cm, an.width, an.height, poly, pose);
  }
  if (frame) {
    // Para extrair, o membro não termina nas articulações (a tatuagem pode passar delas).
    const p = frame.profile!;
    frame = { ...frame, profile: { ...p, off: p.baseOff, rad: p.baseRad } };
  }
  if (new URLSearchParams(location.search).has('debug')) Object.assign(window, { __inkx: { frame, rect, cm } });

  // Região de trabalho: o retângulo com uma margem de pele em volta, na foto guardada.
  const rw = rx1 - rx0;
  const rh = ry1 - ry0;
  const pad = 0.15 * Math.max(rw, rh);
  const ax0 = Math.max(0, rx0 - pad);
  const ay0 = Math.max(0, ry0 - pad);
  const ax1 = Math.min(an.width, rx1 + pad);
  const ay1 = Math.min(an.height, ry1 + pad);
  const sx = ax0 * kAH;
  const sy = ay0 * kAH;
  const sw = (ax1 - ax0) * kAH;
  const sh = (ay1 - ay0) * kAH;
  const m = Math.min(1, WORK_SIDE / Math.max(sw, sh));
  const ww = Math.max(8, Math.round(sw * m));
  const wh = Math.max(8, Math.round(sh * m));
  const wc = document.createElement('canvas');
  wc.width = ww;
  wc.height = wh;
  const wctx = wc.getContext('2d', { willReadFrequently: true })!;
  wctx.imageSmoothingQuality = 'high';
  wctx.drawImage(hi, sx, sy, sw, sh, 0, 0, ww, wh);
  const rgba = wctx.getImageData(0, 0, ww, wh).data;
  const geo: ExtractGeometry = { frame, k: kAH * m, ox: sx * m, oy: sy * m, rect };

  // O contorno na imagem de trabalho: dentro = tatuagem; fora = pele de referência (anel).
  // Contorno do ímã fica no meio da borda do traço: uma folga para fora não corta o traço.
  const grow = sess.snapped ? Math.max(4, Math.round(0.008 * Math.max(ww, wh))) : 0;
  const keep = rasterPoly(poly, ww, wh, geo.k, geo.ox, geo.oy, grow);
  const ring = new Uint8Array(ww * wh);
  let hint: Float32Array | null = null;
  if (skin) hint = new Float32Array(ww * wh);
  for (let y = 0; y < wh; y++) {
    for (let x = 0; x < ww; x++) {
      const i = y * ww + x;
      ring[i] = keep[i] < 128 ? 1 : 0;
      if (hint && skin) {
        const axp = clamp(Math.round((x + geo.ox) / geo.k), 0, an.width - 1);
        const ayp = clamp(Math.round((y + geo.oy) / geo.k), 0, an.height - 1);
        hint[i] = skin[ayp * an.width + axp];
      }
    }
  }
  const ink = separateInk(rgba, ww, wh, ring, hint);
  const mode = looksColorful(rgba, keep, ring) ? 'cor' : 'pb';
  document.querySelector<HTMLInputElement>(`input[name="xMode"][value="${mode}"]`)!.checked = true;

  const unwrapDefault = !frame ? 0 : frame.part === 'tronco' || frame.hitBorder ? 60 : 100;
  unwrapIn.value = String(unwrapDefault);
  unwrapIn.disabled = !frame;
  const map = buildMap(geo, unwrapDefault / 100);
  // Fundo que entrou no contorno (maca, roupa, chão) sai como rebarba.
  let keepLimb: Uint8Array | null = null;
  if (ink.skinLike) {
    const bgKeep = backgroundMask(ink.skinLike, keep, rgba, ww, wh);
    if (new URLSearchParams(location.search).has('debug')) {
      Object.assign(window, { __inkw: { skin: ink.skinLike, keep, limb: bgKeep, w: ww, h: wh, rgba } });
    }
    if (bgKeep) {
      keepLimb = new Uint8Array(keep.length);
      for (let i = 0; i < keep.length; i++) keepLimb[i] = (keep[i] * bgKeep[i]) / 255;
    }
  }
  const W: Work = {
    ink,
    keep,
    keepLimb,
    snapped: sess.snapped,
    geo,
    frame,
    map,
    design: sampleDesign(map, ink, null, keep),
    prep: null!,
    trim: { edge: 0, specks: 0 },
    erase: null,
    strokes: [],
    rot: 0,
    scale: 1,
  };
  rebuild(W, true);
  sess.work = W;
  busy = false;
  pickView.hidden = true;
  resultView.hidden = false;
  updateOutputs();
  renderOut();
  updateUndo();
  setStatus(
    [
      frame ? `Pronto. Desentortei pela curva do ${frame.part || 'membro'}.` : 'Pronto. Não reconheci o membro, então não desentortei.',
      trimNote(W),
      'Use a borracha no que ainda não for tatuagem (pelos, pintas, sombras).',
    ]
      .filter(Boolean)
      .join(' '),
  );
  outCv.scrollIntoView({ block: 'nearest' });
}

/**
 * Remonta o desenho a partir do mapa (contorno, borracha, desentortar) e tira as rebarbas.
 * `fresh` recalcula os níveis automáticos (preto mais escuro, tom do preto).
 */
function rebuild(W: Work, fresh: boolean) {
  W.design = sampleDesign(W.map, W.ink, W.erase, trimIn.checked && W.keepLimb ? W.keepLimb : W.keep);
  const base = fresh || !W.prep ? prepFinish(W.design) : W.prep;
  W.trim = trimIn.checked ? trimScraps(W.design, base.kHi, !W.snapped) : { edge: 0, specks: 0 };
  W.prep = prepFinish(W.design, base.kHi, base.neutral);
}

function trimNote(W: Work): string {
  const { edge, specks } = W.trim;
  const bg = trimIn.checked && !!W.keepLimb;
  if (!edge && !specks && !bg) return '';
  const parts: string[] = [];
  if (bg) parts.push('o fundo em volta do braço ou da perna');
  if (edge) parts.push(edge === 1 ? '1 rebarba na borda do contorno' : `${edge} rebarbas na borda do contorno`);
  if (specks) parts.push(specks === 1 ? '1 pontinho solto' : `${specks} pontinhos soltos`);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} e ${parts[parts.length - 1]}` : parts[0];
  return `Removi ${list} (se sumiu algo da tatuagem, desligue "Remover rebarbas").`;
}

// ---------- Ajustes e desenho ----------
function finish(): Finish {
  const mode = (document.querySelector<HTMLInputElement>('input[name="xMode"]:checked')?.value ?? 'cor') as Finish['mode'];
  return {
    mode,
    clean: Number(cleanIn.value) / 100,
    gain: Number(gainIn.value) / 100,
    sharp: Number(sharpIn.value) / 100,
  };
}

function updateOutputs() {
  $('xCleanOut').textContent = `${cleanIn.value}%`;
  $('xGainOut').textContent = `${gainIn.value}%`;
  $('xSharpOut').textContent = `${sharpIn.value}%`;
  $('xUnwrapOut').textContent = unwrapIn.disabled ? 'sem membro' : Number(unwrapIn.value) === 0 ? 'não' : `${unwrapIn.value}%`;
}

const unrotated = document.createElement('canvas');

function renderOut() {
  const W = S?.work;
  if (!W) return;
  const fin = finish();
  // No modo traço, renderiza em resolução maior: as linhas saem lisas.
  W.scale = fin.mode === 'traco' ? clamp(2400 / Math.max(W.design.w, W.design.h), 1, 2) : 1;
  const img = renderFinish(W.design, W.prep, fin, W.scale);
  unrotated.width = img.width;
  unrotated.height = img.height;
  unrotated.getContext('2d')!.putImageData(img, 0, 0);
  const swap = W.rot % 2 === 1;
  outCv.width = swap ? img.height : img.width;
  outCv.height = swap ? img.width : img.height;
  const ctx = outCv.getContext('2d')!;
  ctx.save();
  ctx.translate(outCv.width / 2, outCv.height / 2);
  ctx.rotate((W.rot * Math.PI) / 2);
  ctx.drawImage(unrotated, -img.width / 2, -img.height / 2);
  ctx.restore();
}

let pending = 0;
function scheduleRender(resample = false) {
  if (resample && S?.work) rebuild(S.work, false);
  if (pending) return;
  pending = requestAnimationFrame(() => {
    pending = 0;
    renderOut();
  });
}

for (const el of [cleanIn, gainIn, sharpIn]) {
  el.addEventListener('input', () => {
    updateOutputs();
    scheduleRender();
  });
}
document.querySelectorAll<HTMLInputElement>('input[name="xMode"]').forEach((el) =>
  el.addEventListener('change', () => scheduleRender()),
);
unwrapIn.addEventListener('input', () => {
  updateOutputs();
  const W = S?.work;
  if (!W) return;
  W.map = buildMap(W.geo, Number(unwrapIn.value) / 100);
  rebuild(W, true);
  scheduleRender();
});
trimIn.addEventListener('change', () => {
  const W = S?.work;
  if (!W) return;
  rebuild(W, false);
  scheduleRender();
  setStatus(trimIn.checked ? trimNote(W) || 'Não encontrei rebarbas para remover.' : 'Rebarbas mantidas: nada foi removido automaticamente.');
});

$('xRotate').addEventListener('click', () => {
  if (!S?.work) return;
  S.work.rot = (S.work.rot + 1) % 4;
  renderOut();
});

$('xAgain').addEventListener('click', () => {
  if (!S) return;
  S.work = null;
  S.poly = null;
  S.rect = null;
  showPick();
  drawPick();
  setStatus(pickHint());
});

// ---------- Borracha (no desenho extraído) ----------
let erasing = false;
let stroke: Stroke | null = null;

function setErase(on: boolean) {
  erasing = on && !!S?.work;
  eraseBtn.setAttribute('aria-pressed', String(erasing));
  eraseBtn.textContent = erasing ? 'Pronto' : 'Borracha';
  paper.classList.toggle('erasing', erasing);
  undoBtn.hidden = !erasing;
  updateUndo();
  if (erasing) {
    setStatus('Passe o dedo no que não é tatuagem: pelos, pintas, sombras, fundo. Toque em "Pronto" quando terminar.');
    // No celular o botão fica embaixo do desenho: volta para o desenho.
    paper.scrollIntoView({ block: 'nearest' });
  }
}

function updateUndo() {
  undoBtn.disabled = !S?.work?.strokes.length;
}

eraseBtn.addEventListener('click', () => setErase(!erasing));
undoBtn.addEventListener('click', () => {
  const W = S?.work;
  if (!W?.strokes.length) return;
  W.strokes.pop();
  W.erase = null;
  if (W.strokes.length) {
    W.erase = new Uint8Array(W.ink.w * W.ink.h);
    for (const s of W.strokes) {
      stamp(W, s.pts[0], s.r);
      for (let k = 1; k < s.pts.length; k++) stampSegment(W, s.pts[k - 1], s.pts[k], s.r);
    }
  }
  updateUndo();
  scheduleRender(true);
});

/** Ponto do desenho exibido (já girado e ampliado) → ponto da imagem de trabalho. */
function toWork(W: Work, e: PointerEvent): [number, number] | null {
  const p = canvasPoint(outCv, e);
  const uw = unrotated.width;
  const uh = unrotated.height;
  let x = p.x;
  let y = p.y;
  if (W.rot === 1) [x, y] = [y, uh - 1 - x];
  else if (W.rot === 2) [x, y] = [uw - 1 - x, uh - 1 - y];
  else if (W.rot === 3) [x, y] = [uw - 1 - y, x];
  const dx = clamp(Math.round(x / W.scale), 0, W.map.w - 1);
  const dy = clamp(Math.round(y / W.scale), 0, W.map.h - 1);
  const i = (dy * W.map.w + dx) * 2;
  const wx = W.map.map[i];
  const wy = W.map.map[i + 1];
  return Number.isNaN(wx) ? null : [wx, wy];
}

function brushRadius(W: Work) {
  const shown = outCv.getBoundingClientRect().width || 1;
  return (18 * outCv.width) / shown / W.scale;
}

function stamp(W: Work, [x, y]: [number, number], r: number) {
  const e = (W.erase ??= new Uint8Array(W.ink.w * W.ink.h));
  const w = W.ink.w;
  const h = W.ink.h;
  for (let yy = Math.max(0, Math.floor(y - r)); yy <= Math.min(h - 1, Math.ceil(y + r)); yy++) {
    for (let xx = Math.max(0, Math.floor(x - r)); xx <= Math.min(w - 1, Math.ceil(x + r)); xx++) {
      const d = Math.hypot(xx - x, yy - y);
      if (d > r) continue;
      const a = Math.round(255 * (1 - smoothstep(0.6 * r, r, d)));
      const i = yy * w + xx;
      if (a > e[i]) e[i] = a;
    }
  }
}

function stampSegment(W: Work, a: [number, number], b: [number, number], r: number) {
  const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (r / 3)));
  for (let k = 1; k <= n; k++) stamp(W, [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n], r);
}

outCv.addEventListener('pointerdown', (e) => {
  const W = S?.work;
  if (!erasing || !W) return;
  outCv.setPointerCapture(e.pointerId);
  const p = toWork(W, e);
  stroke = { r: brushRadius(W), pts: [] };
  if (p) {
    stroke.pts.push(p);
    stamp(W, p, stroke.r);
    scheduleRender(true);
  }
});
outCv.addEventListener('pointermove', (e) => {
  const W = S?.work;
  if (!stroke || !W) return;
  const p = toWork(W, e);
  if (!p) return;
  const last = stroke.pts[stroke.pts.length - 1];
  stroke.pts.push(p);
  if (last) stampSegment(W, last, p, stroke.r);
  else stamp(W, p, stroke.r);
  scheduleRender(true);
});
const endStroke = () => {
  const W = S?.work;
  if (stroke && W && stroke.pts.length) W.strokes.push(stroke);
  stroke = null;
  updateUndo();
};
outCv.addEventListener('pointerup', endStroke);
outCv.addEventListener('pointercancel', endStroke);

// ---------- Usar / salvar / fechar ----------
/** PNG do desenho final (síncrono: o toBlob às vezes demora até o navegador ficar ocioso). */
function exportBlob(): Blob {
  const bin = atob(outCv.toDataURL('image/png').split(',')[1]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: 'image/png' });
}

$('xUse').addEventListener('click', () => {
  if (!S?.work) return;
  const blob = exportBlob();
  const cb = onUse;
  close();
  cb?.(blob);
});

$('xSave').addEventListener('click', () => {
  if (!S?.work) return;
  const blob = exportBlob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'tatuagem-extraida.png';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});

function close() {
  if (dlg.open) dlg.close();
}

$('xClose').addEventListener('click', close);
dlg.addEventListener('close', () => {
  // Libera a memória da foto.
  S = null;
  onUse = null;
  busy = false;
  setErase(false);
});
