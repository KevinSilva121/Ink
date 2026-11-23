// Decalque em tamanho real, para qualquer parte do corpo.
//
// O decalque NÃO é a imagem da foto (lá a tatuagem aparece espremida pela curva e pela
// perspectiva; ao colar, é a pele que faz essa curva). É o desenho com os ajustes da pessoa
// (tamanho, giro, lados, espelhar) "desenrolado" sobre a pele: exatamente o espaço em que o
// provador monta a tatuagem antes de enrolar no corpo.
//
// A foto não sabe quantos centímetros tem o corpo: a pessoa marca dois pontos e diz quanto
// medem no corpo, com a fita seguindo a pele. A distância entre eles é calculada sobre a pele
// (o mesmo modelo do provador), então vale para braço, perna, peito, costas, costela.
import { profileAt, type Frame } from './geometry';
import { imageToSkin, localToImage, type Placement } from './render';
import type { Design, Tex } from './design';
import { clamp, smoothstep } from './util';

export interface DecalInput {
  /** Foto com as tatuagens, como está na tela. */
  view: HTMLCanvasElement;
  frame: Frame;
  tex: Tex;
  design: Design;
  pl: Placement;
  outline: [number, number][];
}

type Paper = 'stencil' | 'temporaria' | 'comum';
type Pt = [number, number];

// Folha A4 em mm.
/** Folha A4: em pé ou deitada (a que precisar de menos folhas). */
interface Sheet {
  w: number;
  h: number;
}
const PORTRAIT: Sheet = { w: 210, h: 297 };
const LANDSCAPE: Sheet = { w: 297, h: 210 };
const MARGIN = 10;
const HEADER = 24;
const FOOTER = 18;
const OVERLAP = 10;
const DPI = 300;
const P = DPI / 25.4; // pixels por mm na folha

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const dlg = $<HTMLDialogElement>('decal');
const photoCv = $<HTMLCanvasElement>('dPhoto');
const previewCv = $<HTMLCanvasElement>('dPreview');
const cmIn = $<HTMLInputElement>('dCm');
const mirrorIn = $<HTMLInputElement>('dMirror');
const pdfBtn = $<HTMLButtonElement>('dPdf');
const statusEl = $('dStatus');

const fmt = (v: number, d = 1) => v.toLocaleString('pt-BR', { maximumFractionDigits: d, minimumFractionDigits: d });
const nextPaint = () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));

interface Saved {
  A: Pt;
  B: Pt;
  cm: string;
}
/** Medida feita para cada tatuagem (enquanto a página está aberta). */
const saved = new WeakMap<Design, Saved>();

let cur: DecalInput | null = null;
let view: HTMLCanvasElement | null = null;
let crop = { x: 0, y: 0, w: 1, h: 1, k: 1 };
let A: Pt = [0, 0];
let B: Pt = [0, 0];
let dragging: 'A' | 'B' | null = null;

const HINTS: Record<string, string> = {
  antebraço: 'Por exemplo: a dobra do cotovelo e o ossinho do punho.',
  braço: 'Por exemplo: a ponta do ombro e a dobra do cotovelo.',
  mão: 'Por exemplo: o punho e a junta dos dedos.',
  coxa: 'Por exemplo: a dobra da virilha e o topo do joelho.',
  perna: 'Por exemplo: logo abaixo do joelho e o ossinho do tornozelo.',
  tronco: 'Por exemplo: os dois mamilos, ou o umbigo e o osso do meio do peito.',
};

const PAPER_NOTES: Record<Paper, string> = {
  stencil:
    'Sai só o traço, em preto e sem espelhar: é assim que o tatuador passa para o papel hectográfico ou térmico (a transferência já desinverte).',
  temporaria:
    'Sai colorido e espelhado, porque o lado impresso vai virado para a pele. Recorte pela linha tracejada antes de colar.',
  comum: 'Sai colorido, sem espelhar e com as linhas de referência: para recortar e segurar no corpo, conferindo tamanho e posição.',
};

export function openDecal(input: DecalInput) {
  cur = input;
  view = document.createElement('canvas');
  view.width = input.view.width;
  view.height = input.view.height;
  view.getContext('2d')!.drawImage(input.view, 0, 0);

  // Recorte da foto em volta da tatuagem (com folga para marcar pontos do corpo).
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of input.outline) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  const half = Math.max(x1 - x0, y1 - y0) * 1.1 + 0.08 * Math.min(view.width, view.height);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const cxa = clamp(cx - half, 0, view.width);
  const cya = clamp(cy - half, 0, view.height);
  const cxb = clamp(cx + half, 0, view.width);
  const cyb = clamp(cy + half, 0, view.height);
  const k = Math.min(1, 900 / Math.max(cxb - cxa, cyb - cya));
  crop = { x: cxa, y: cya, w: cxb - cxa, h: cyb - cya, k };
  photoCv.width = Math.max(1, Math.round(crop.w * k));
  photoCv.height = Math.max(1, Math.round(crop.h * k));

  const s = saved.get(input.design);
  if (s) {
    A = s.A;
    B = s.B;
    cmIn.value = s.cm;
  } else {
    // Começa nas pontas da tatuagem: medir isso no corpo = dizer a altura que ela vai ter.
    const hh = input.pl.height / 2;
    A = localToImage(input.frame, input.tex, input.pl, 0, hh);
    B = localToImage(input.frame, input.tex, input.pl, 0, -hh);
    cmIn.value = '';
  }
  $('dHelp').textContent = [
    'As marcas A e B começam no topo e no pé da tatuagem. Meça no seu corpo, com a fita seguindo a pele, onde você quer que ela comece e termine; ou arraste as marcas para dois pontos fáceis de achar no corpo e meça entre eles.',
    HINTS[input.frame.part] ?? 'Por exemplo: pintas, ossos ou dobras que dá para achar no corpo.',
    'As duas marcas precisam ficar na mesma parte do corpo da tatuagem.',
  ].join(' ');
  statusEl.textContent = '';
  if (!dlg.open) dlg.showModal();
  drawPhoto();
  update();
}

function paper(): Paper {
  return (document.querySelector<HTMLInputElement>('input[name="dPaper"]:checked')?.value ?? 'stencil') as Paper;
}

function parseCm(): number | null {
  const v = parseFloat(cmIn.value.replace(',', '.'));
  return Number.isFinite(v) && v > 0 ? v : null;
}

// ---------- Medida ----------
function skinDist(I: DecalInput, a: Pt, b: Pt): number {
  const p = imageToSkin(I.frame, I.tex, I.pl, a[0], a[1]);
  const q = imageToSkin(I.frame, I.tex, I.pl, b[0], b[1]);
  return Math.hypot(p[0] - q[0], p[1] - q[1]);
}

/** A marca está em cima do membro modelado (longe da borda, onde a medida perde precisão)? */
function onLimb(I: DecalInput, [x, y]: Pt): boolean {
  const f = I.frame;
  if (!f.ok) return true;
  const t = (x - f.cx) * f.ux + (y - f.cy) * f.uy;
  const s = (x - f.cx) * f.vx + (y - f.cy) * f.vy;
  const [o, r] = profileAt(f, t);
  return r > 0 && Math.abs(s - o) <= 0.93 * r;
}

function drawPhoto() {
  if (!view) return;
  const g = photoCv.getContext('2d')!;
  g.drawImage(view, crop.x, crop.y, crop.w, crop.h, 0, 0, photoCv.width, photoCv.height);
  const to = ([x, y]: Pt): Pt => [(x - crop.x) * crop.k, (y - crop.y) * crop.k];
  const a = to(A);
  const b = to(B);
  const r = markRadius();
  g.lineWidth = Math.max(2, r * 0.18);
  g.strokeStyle = '#ffd166';
  g.setLineDash([r * 0.5, r * 0.4]);
  g.beginPath();
  g.moveTo(...a);
  g.lineTo(...b);
  g.stroke();
  g.setLineDash([]);
  for (const [p, label] of [
    [a, 'A'],
    [b, 'B'],
  ] as const) {
    g.beginPath();
    g.arc(p[0], p[1], r, 0, Math.PI * 2);
    g.fillStyle = 'rgba(255, 209, 102, 0.92)';
    g.fill();
    g.strokeStyle = '#1a1408';
    g.stroke();
    g.fillStyle = '#1a1408';
    g.font = `700 ${Math.round(r * 1.1)}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(label, p[0], p[1] + 1);
  }
}

function markRadius() {
  return (14 * photoCv.width) / Math.max(1, photoCv.getBoundingClientRect().width || photoCv.width);
}

function pointerImage(e: PointerEvent): Pt {
  const r = photoCv.getBoundingClientRect();
  const cx = ((e.clientX - r.left) * photoCv.width) / r.width;
  const cy = ((e.clientY - r.top) * photoCv.height) / r.height;
  return [crop.x + cx / crop.k, crop.y + cy / crop.k];
}

/** A marca perto do ponto tocado (ou null, se o toque não foi numa marca). */
function markAt(clientX: number, clientY: number): 'A' | 'B' | null {
  const r = photoCv.getBoundingClientRect();
  const p: Pt = [
    crop.x + ((clientX - r.left) * photoCv.width) / r.width / crop.k,
    crop.y + ((clientY - r.top) * photoCv.height) / r.height / crop.k,
  ];
  const hit = (markRadius() * 2.2) / crop.k;
  const da = Math.hypot(p[0] - A[0], p[1] - A[1]);
  const db = Math.hypot(p[0] - B[0], p[1] - B[1]);
  if (Math.min(da, db) > hit) return null;
  return da <= db ? 'A' : 'B';
}

// No celular, arrastar a foto rola a página (a foto é grande); só um toque numa marca a segura.
photoCv.addEventListener(
  'touchstart',
  (e) => {
    const t = e.touches[0];
    if (t && e.touches.length === 1 && markAt(t.clientX, t.clientY)) e.preventDefault();
  },
  { passive: false },
);

photoCv.addEventListener('pointerdown', (e) => {
  if (!cur) return;
  const m = markAt(e.clientX, e.clientY);
  if (!m) return;
  dragging = m;
  photoCv.setPointerCapture(e.pointerId);
});
photoCv.addEventListener('pointermove', (e) => {
  if (!dragging || !view) return;
  const p = pointerImage(e);
  const q: Pt = [clamp(p[0], 0, view.width - 1), clamp(p[1], 0, view.height - 1)];
  if (dragging === 'A') A = q;
  else B = q;
  drawPhoto();
  update();
});
const endDrag = () => (dragging = null);
photoCv.addEventListener('pointerup', endDrag);
photoCv.addEventListener('pointercancel', endDrag);

// ---------- Geometria do decalque (em mm, Y para cima = ao longo do membro) ----------
interface Geo {
  mmPerPx: number;
  Wt: number;
  Ht: number;
  cos: number;
  sin: number;
  /** Espelhar na folha (papel de tatuagem temporária, foto no espelho). */
  mirror: boolean;
  flip: boolean;
  stencil: boolean;
  paper: Paper;
  /** Meia largura e meia altura do desenho já girado, em mm. */
  ex: number;
  ey: number;
  region: { x0: number; x1: number; y0: number; y1: number };
  /** Linha do centro do membro como aparece na foto (mm), se dá para saber. */
  midX: number | null;
  midLabel: string;
  /** Onde o membro termina (articulações), em mm ao longo do membro. */
  joints: { y: number; label: string }[];
  up: string;
  down: string;
  heightCm: number;
  widthCm: number;
}

function geometry(I: DecalInput, cm: number): Geo {
  const f = I.frame;
  const pl = I.pl;
  const Ht = pl.height;
  const Wt = pl.height * (I.tex.w / I.tex.h) * (pl.stretch || 1);
  const mmPerPx = (cm * 10) / Math.max(1e-6, skinDist(I, A, B));
  const cos = Math.cos(pl.rot);
  const sin = Math.sin(pl.rot);
  const p = paper();
  const mirror = (p === 'temporaria') !== mirrorIn.checked;
  const hx = (Wt / 2) * mmPerPx;
  const hy = (Ht / 2) * mmPerPx;
  const ex = Math.abs(cos) * hx + Math.abs(sin) * hy;
  const ey = Math.abs(sin) * hx + Math.abs(cos) * hy;
  const pad = 10;
  const region = { x0: -ex - pad, x1: ex + pad, y0: -ey - pad, y1: ey + pad };

  let midX: number | null = null;
  const t0 = (pl.px - f.cx) * f.ux + (pl.py - f.cy) * f.uy;
  if (f.ok) {
    const [o] = profileAt(f, t0);
    const [da] = imageToSkin(f, I.tex, pl, f.cx + f.ux * t0 + f.vx * o, f.cy + f.uy * t0 + f.vy * o);
    const x = da * mmPerPx * (mirror ? -1 : 1);
    if (Math.abs(x) <= ex + 40) {
      midX = x;
      region.x0 = Math.min(region.x0, x - 6);
      region.x1 = Math.max(region.x1, x + 6);
    }
  }
  const part = f.part;
  const joints: Geo['joints'] = [];
  const pj = f.profile?.joints;
  const caps = f.profile?.caps;
  if (pj && caps) {
    for (const i of [0, 1]) {
      const y = (caps[i] - t0) * mmPerPx;
      if (y > region.y0 && y < region.y1) joints.push({ y, label: pj[i] });
    }
  }
  const nice = (j: string) => (j === 'ombros' ? 'cabeça' : j === 'quadril' && part === 'tronco' ? 'quadril' : j);
  return {
    mmPerPx,
    Wt,
    Ht,
    cos,
    sin,
    mirror,
    flip: pl.flip,
    stencil: p === 'stencil',
    paper: p,
    ex,
    ey,
    region,
    midX,
    midLabel: part === 'tronco' ? 'centro do corpo na foto' : part ? `centro do ${part} na foto` : 'centro na foto',
    joints,
    up: pj ? `↑ ${nice(pj[1])}` : '↑ para cima, como na foto',
    down: pj ? `↓ ${nice(pj[0])}` : '',
    heightCm: (Ht * mmPerPx) / 10,
    widthCm: (Wt * mmPerPx) / 10,
  };
}

/** Onde o decalque é desenhado: escala, posição da origem do decalque e retângulo (em px). */
interface ViewRect {
  ppm: number;
  ox: number;
  oy: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

function drawDecal(g: CanvasRenderingContext2D, I: DecalInput, G: Geo, v: ViewRect) {
  const D = I.design;
  const x = Math.max(0, Math.floor(v.x));
  const y = Math.max(0, Math.floor(v.y));
  const w = Math.min(g.canvas.width - x, Math.ceil(v.w));
  const h = Math.min(g.canvas.height - y, Math.ceil(v.h));
  if (w <= 0 || h <= 0) return;
  const img = g.getImageData(x, y, w, h);
  const d = img.data;
  const DW = D.w;
  const DH = D.h;
  const sgn = G.mirror ? -1 : 1;
  for (let j = 0; j < h; j++) {
    const Y = (v.oy - (y + j + 0.5)) / v.ppm;
    const dt = Y / G.mmPerPx;
    for (let i = 0; i < w; i++) {
      const X = (x + i + 0.5 - v.ox) / v.ppm;
      const da = (sgn * X) / G.mmPerPx;
      const lx = G.cos * da + G.sin * dt;
      const ly = -G.sin * da + G.cos * dt;
      let fx = (lx / G.Wt + 0.5) * DW - 0.5;
      const fy = (0.5 - ly / G.Ht) * DH - 0.5;
      if (G.flip) fx = DW - 1 - fx;
      if (fx < -1 || fy < -1 || fx > DW || fy > DH) continue;
      const ix = Math.floor(fx);
      const iy = Math.floor(fy);
      const ax = fx - ix;
      const ay = fy - iy;
      let r = 0;
      let gg = 0;
      let b = 0;
      for (let jy = 0; jy < 2; jy++) {
        const sy = iy + jy;
        const wy = jy ? ay : 1 - ay;
        for (let jx = 0; jx < 2; jx++) {
          const sx = ix + jx;
          const wt = (jx ? ax : 1 - ax) * wy;
          if (sx < 0 || sy < 0 || sx >= DW || sy >= DH) {
            r += 255 * wt;
            gg += 255 * wt;
            b += 255 * wt;
          } else {
            const q = sy * DW + sx;
            r += D.r[q] * wt;
            gg += D.g[q] * wt;
            b += D.b[q] * wt;
          }
        }
      }
      const p = (j * w + i) * 4;
      if (G.stencil) {
        const ink = 1 - Math.min(r, gg, b) / 255;
        const vv = 255 * (1 - smoothstep(0.28, 0.5, ink));
        d[p] = d[p + 1] = d[p + 2] = vv;
      } else {
        d[p] = r;
        d[p + 1] = gg;
        d[p + 2] = b;
      }
      d[p + 3] = 255;
    }
  }
  g.putImageData(img, x, y);

  // Guias (fora do desenho, para não irem para a pele junto).
  const X = (mm: number) => v.ox + mm * v.ppm;
  const Yp = (mm: number) => v.oy - mm * v.ppm;
  const mm = v.ppm;
  g.save();
  g.beginPath();
  g.rect(v.x, v.y, v.w, v.h);
  g.clip();
  g.lineCap = 'round';
  // Linha de corte: o retângulo do desenho com 3 mm de folga.
  const hx = (G.Wt / 2) * G.mmPerPx + 3;
  const hy = (G.Ht / 2) * G.mmPerPx + 3;
  g.setLineDash([2 * mm, 1.5 * mm]);
  g.lineWidth = Math.max(1, 0.25 * mm);
  g.strokeStyle = '#9a9a9a';
  g.beginPath();
  ([
    [-hx, hy],
    [hx, hy],
    [hx, -hy],
    [-hx, -hy],
  ] as const).forEach(([lx, ly], i) => {
    const px = sgn * (G.cos * lx - G.sin * ly);
    const py = G.sin * lx + G.cos * ly;
    if (i) g.lineTo(X(px), Yp(py));
    else g.moveTo(X(px), Yp(py));
  });
  g.closePath();
  g.stroke();
  g.setLineDash([]);

  const font = (size: number, weight = 500) => `${weight} ${Math.round(size * mm)}px system-ui, -apple-system, sans-serif`;
  g.fillStyle = '#333';
  g.strokeStyle = '#333';
  g.lineWidth = Math.max(1, 0.35 * mm);
  g.font = font(3.2, 600);
  g.textBaseline = 'middle';
  // Seta ao longo do membro.
  const top = G.ey + 4;
  const arrowX = G.midX !== null && Math.abs(G.midX) < G.ex ? G.midX : 0;
  g.beginPath();
  g.moveTo(X(arrowX), Yp(top));
  g.lineTo(X(arrowX), Yp(top + 5));
  g.stroke();
  g.beginPath();
  g.moveTo(X(arrowX) - 1.6 * mm, Yp(top + 4.6));
  g.lineTo(X(arrowX), Yp(top + 7.4));
  g.lineTo(X(arrowX) + 1.6 * mm, Yp(top + 4.6));
  g.closePath();
  g.fill();
  g.textAlign = 'left';
  g.fillText(G.up.replace('↑ ', ''), X(arrowX) + 2.5 * mm, Yp(top + 5));
  if (G.down) {
    g.textAlign = 'left';
    g.fillText(G.down, X(arrowX) + 2.5 * mm, Yp(-G.ey - 7));
  }
  // Centro do membro na foto: tiques em cima e embaixo (linha inteira só no papel comum).
  if (G.midX !== null) {
    const mx = X(G.midX);
    g.lineWidth = Math.max(1, 0.3 * mm);
    if (G.paper === 'comum') {
      g.setLineDash([1 * mm, 1.5 * mm]);
      g.strokeStyle = '#b5b5b5';
      g.beginPath();
      g.moveTo(mx, Yp(G.region.y1));
      g.lineTo(mx, Yp(G.region.y0));
      g.stroke();
      g.setLineDash([]);
    }
    g.strokeStyle = '#333';
    g.beginPath();
    g.moveTo(mx, Yp(G.region.y1));
    g.lineTo(mx, Yp(G.region.y1 - 4));
    g.moveTo(mx, Yp(G.region.y0));
    g.lineTo(mx, Yp(G.region.y0 + 4));
    g.stroke();
    g.font = font(2.4);
    g.textAlign = G.midX > 0 ? 'right' : 'left';
    g.fillText(G.midLabel, mx + (G.midX > 0 ? -1.5 : 1.5) * mm, Yp(G.region.y0 + 2));
  }
  // Onde o membro termina (articulação).
  for (const jn of G.joints) {
    const py = Yp(jn.y);
    g.lineWidth = Math.max(1, 0.3 * mm);
    if (G.paper === 'comum') {
      g.setLineDash([1 * mm, 1.5 * mm]);
      g.strokeStyle = '#b5b5b5';
      g.beginPath();
      g.moveTo(X(G.region.x0), py);
      g.lineTo(X(G.region.x1), py);
      g.stroke();
      g.setLineDash([]);
    }
    g.strokeStyle = '#333';
    g.beginPath();
    g.moveTo(X(G.region.x0), py);
    g.lineTo(X(G.region.x0 + 4), py);
    g.moveTo(X(G.region.x1), py);
    g.lineTo(X(G.region.x1 - 4), py);
    g.stroke();
    g.font = font(2.4);
    g.textAlign = 'left';
    g.fillText(jn.label, X(G.region.x0 + 5), py - 1.6 * mm);
  }
  g.restore();
}

// ---------- Folhas ----------
interface Tile {
  r: number;
  c: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

function tilesFor(G: Geo, S: Sheet): Tiling {
  const cw = S.w - 2 * MARGIN;
  const ch = S.h - 2 * MARGIN - HEADER - FOOTER;
  const { x0, x1, y0, y1 } = G.region;
  const W = x1 - x0;
  const H = y1 - y0;
  const cols = W <= cw ? 1 : Math.ceil((W - OVERLAP) / (cw - OVERLAP));
  const rows = H <= ch ? 1 : Math.ceil((H - OVERLAP) / (ch - OVERLAP));
  const list: Tile[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const tx0 = x0 + c * (cw - OVERLAP);
      const ty1 = y1 - r * (ch - OVERLAP);
      list.push({ r, c, x0: tx0, x1: Math.min(tx0 + cw, x1), y0: Math.max(ty1 - ch, y0), y1: ty1 });
    }
  }
  return { list, rows, cols, sheet: S };
}

interface Tiling {
  list: Tile[];
  rows: number;
  cols: number;
  sheet: Sheet;
}

/** Folha em pé ou deitada: a que usar menos folhas (empate: em pé). */
function tiles(G: Geo): Tiling {
  const a = tilesFor(G, PORTRAIT);
  const b = tilesFor(G, LANDSCAPE);
  return b.list.length < a.list.length ? b : a;
}

function renderPage(I: DecalInput, G: Geo, T: Tiling, k: number): HTMLCanvasElement {
  const { sheet: S, rows, cols } = T;
  const t = T.list[k - 1];
  const n = T.list.length;
  const c = document.createElement('canvas');
  c.width = Math.round(S.w * P);
  c.height = Math.round(S.h * P);
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  const cw = S.w - 2 * MARGIN;
  const ch = S.h - 2 * MARGIN - HEADER - FOOTER;
  const offX = cols === 1 ? (cw - (t.x1 - t.x0)) / 2 : 0;
  const offY = rows === 1 ? (ch - (t.y1 - t.y0)) / 2 : 0;
  const left = MARGIN + offX;
  const topMm = MARGIN + HEADER + offY;
  drawDecal(g, I, G, {
    ppm: P,
    ox: (left - t.x0) * P,
    oy: (topMm + t.y1) * P,
    x: left * P,
    y: topMm * P,
    w: (t.x1 - t.x0) * P,
    h: (t.y1 - t.y0) * P,
  });
  if (n > 1) {
    // Borda da folha: as vizinhas se sobrepõem 1 cm a partir daqui.
    g.setLineDash([2 * P, 2 * P]);
    g.strokeStyle = '#6aa0ff';
    g.lineWidth = 0.3 * P;
    g.strokeRect(left * P, topMm * P, (t.x1 - t.x0) * P, (t.y1 - t.y0) * P);
    g.setLineDash([]);
  }

  // Cabeçalho.
  g.fillStyle = '#111';
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  g.font = `700 ${Math.round(4.2 * P)}px system-ui, sans-serif`;
  const part = I.frame.part ? ` · ${I.frame.part}` : '';
  g.fillText(`Decalque${part} · ${fmt(G.heightCm)} × ${fmt(G.widthCm)} cm`, MARGIN * P, (MARGIN + 5) * P);
  g.font = `500 ${Math.round(3 * P)}px system-ui, sans-serif`;
  const paperLine: Record<Paper, string> = {
    stencil: 'Stencil: traço em preto, sem espelhar (o papel hectográfico/térmico já desinverte).',
    temporaria: 'Tatuagem temporária: já está espelhado. Recorte pela linha tracejada.',
    comum: 'Papel comum: recorte e segure no corpo para conferir tamanho e posição.',
  };
  g.fillText(paperLine[G.paper], MARGIN * P, (MARGIN + 11) * P);
  g.fillText('Imprima em "tamanho real" (100%), sem "ajustar à página". Confira a régua abaixo com a fita.', MARGIN * P, (MARGIN + 16) * P);
  if (n > 1) {
    g.fillText(
      `Folha ${k} de ${n} (linha ${t.r + 1}, coluna ${t.c + 1}). As folhas se sobrepõem 1 cm: emende pelas linhas azuis.`,
      MARGIN * P,
      (MARGIN + 21) * P,
    );
  }

  // Régua de conferência (5 cm).
  const rx = MARGIN * P;
  const ry = (S.h - MARGIN - 6) * P;
  g.strokeStyle = '#111';
  g.lineWidth = 0.25 * P;
  g.beginPath();
  g.moveTo(rx, ry);
  g.lineTo(rx + 50 * P, ry);
  for (let i = 0; i <= 50; i++) {
    const len = i % 10 === 0 ? 4 : i % 5 === 0 ? 2.8 : 1.6;
    g.moveTo(rx + i * P, ry);
    g.lineTo(rx + i * P, ry - len * P);
  }
  g.stroke();
  g.font = `500 ${Math.round(2.6 * P)}px system-ui, sans-serif`;
  g.fillStyle = '#111';
  for (let cmk = 0; cmk <= 5; cmk++) {
    g.textAlign = 'center';
    g.fillText(String(cmk), rx + cmk * 10 * P, ry + 3.6 * P);
  }
  g.textAlign = 'left';
  g.fillText('cm  ← esta régua tem que medir 5 cm de verdade', rx + 54 * P, ry - 0.5 * P);
  return c;
}

// ---------- PDF (feito à mão: uma imagem JPEG por folha A4) ----------
function jpegBytes(c: HTMLCanvasElement): Uint8Array {
  const bin = atob(c.toDataURL('image/jpeg', 0.92).split(',')[1]);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function buildPdf(pages: { jpg: Uint8Array; w: number; h: number }[], S: Sheet): Blob {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let len = 0;
  const push = (d: Uint8Array | string) => {
    const b = typeof d === 'string' ? enc.encode(d) : d;
    chunks.push(b);
    len += b.length;
  };
  const obj = (num: number, ...body: (Uint8Array | string)[]) => {
    offsets[num] = len;
    push(`${num} 0 obj\n`);
    for (const b of body) push(b);
    push('\nendobj\n');
  };
  push('%PDF-1.4\n');
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  const W = ((S.w / 25.4) * 72).toFixed(2);
  const H = ((S.h / 25.4) * 72).toFixed(2);
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${pages.map((_, k) => `${3 + 3 * k} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  pages.forEach((p, k) => {
    const pn = 3 + 3 * k;
    obj(pn, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 ${pn + 2} 0 R >> >> /Contents ${pn + 1} 0 R >>`);
    const content = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`;
    obj(pn + 1, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    obj(
      pn + 2,
      `<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpg.length} >>\nstream\n`,
      p.jpg,
      '\nendstream',
    );
  });
  const total = 3 + 3 * pages.length;
  const xref = len;
  push(`xref\n0 ${total}\n0000000000 65535 f \n`);
  for (let i = 1; i < total; i++) push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(chunks as BlobPart[], { type: 'application/pdf' });
}

// ---------- Tela ----------
function update() {
  if (!cur) return;
  const I = cur;
  saved.set(I.design, { A, B, cm: cmIn.value });
  $('dPaperNote').textContent = PAPER_NOTES[paper()];
  const warn: string[] = [];
  if (!onLimb(I, A) || !onLimb(I, B)) {
    warn.push('Uma das marcas está fora (ou bem na borda) da parte do corpo da tatuagem: a medida fica imprecisa. Traga as marcas mais para dentro.');
  }
  const cm = parseCm();
  const g = previewCv.getContext('2d')!;
  if (!cm) {
    pdfBtn.disabled = true;
    $('dSize').textContent = 'Digite a medida para ver o decalque no tamanho real.';
    previewCv.width = previewCv.height = 1;
    $('dWarn').textContent = warn.join(' ');
    return;
  }
  const G = geometry(I, cm);
  if (G.heightCm > 150 || Math.max(G.heightCm, G.widthCm) < 0.8) warn.push('O tamanho ficou estranho: confira a medida e onde estão as marcas.');
  $('dWarn').textContent = warn.join(' ');
  const T = tiles(G);
  const n = T.list.length;
  const lay = T.sheet === LANDSCAPE ? ' deitada' : '';
  $('dSize').textContent = `Tatuagem: ${fmt(G.heightCm)} cm de altura × ${fmt(G.widthCm)} cm de largura · ${n === 1 ? `1 folha A4${lay}` : `${n} folhas A4${lay ? ' deitadas' : ''} para emendar`}`;
  pdfBtn.disabled = false;

  // Prévia do decalque inteiro.
  const W = G.region.x1 - G.region.x0;
  const H = G.region.y1 - G.region.y0;
  const dpr = window.devicePixelRatio || 1;
  const box = previewCv.parentElement!.getBoundingClientRect();
  const maxW = Math.max(200, Math.min(520, box.width - 16 || 360));
  const ppm = Math.min(maxW / W, 460 / H) * dpr;
  previewCv.width = Math.max(1, Math.round(W * ppm));
  previewCv.height = Math.max(1, Math.round(H * ppm));
  previewCv.style.width = `${previewCv.width / dpr}px`;
  previewCv.style.height = `${previewCv.height / dpr}px`;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, previewCv.width, previewCv.height);
  drawDecal(g, I, G, {
    ppm,
    ox: -G.region.x0 * ppm,
    oy: G.region.y1 * ppm,
    x: 0,
    y: 0,
    w: previewCv.width,
    h: previewCv.height,
  });
  if (n > 1) {
    g.setLineDash([4 * dpr, 4 * dpr]);
    g.strokeStyle = '#6aa0ff';
    g.lineWidth = 1.5 * dpr;
    for (const t of T.list) {
      g.strokeRect((t.x0 - G.region.x0) * ppm, (G.region.y1 - t.y1) * ppm, (t.x1 - t.x0) * ppm, (t.y1 - t.y0) * ppm);
    }
    g.setLineDash([]);
  }
}

cmIn.addEventListener('input', update);
// O teclado do celular pode cobrir o campo: depois que ele abre, traz o campo para o meio.
cmIn.addEventListener('focus', () => setTimeout(() => cmIn.scrollIntoView({ block: 'center', behavior: 'smooth' }), 350));
cmIn.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') cmIn.blur();
});
/** − e +: ajustar a medida sem teclado (meio centímetro por toque). */
function stepCm(delta: number) {
  const v = parseCm() ?? 10 - delta;
  const next = clamp(Math.round((v + delta) * 2) / 2, 0.5, 300);
  cmIn.value = fmt(next, next % 1 ? 1 : 0);
  update();
}
$('dMinus').addEventListener('click', () => stepCm(-0.5));
$('dPlus').addEventListener('click', () => stepCm(0.5));
mirrorIn.addEventListener('change', update);
document.querySelectorAll<HTMLInputElement>('input[name="dPaper"]').forEach((el) => el.addEventListener('change', update));

pdfBtn.addEventListener('click', async () => {
  if (!cur) return;
  const cm = parseCm();
  if (!cm) return;
  const I = cur;
  const G = geometry(I, cm);
  const T = tiles(G);
  pdfBtn.disabled = true;
  const pages: { jpg: Uint8Array; w: number; h: number }[] = [];
  try {
    for (let k = 0; k < T.list.length; k++) {
      statusEl.textContent = `Gerando folha ${k + 1} de ${T.list.length}…`;
      await nextPaint();
      const c = renderPage(I, G, T, k + 1);
      pages.push({ jpg: jpegBytes(c), w: c.width, h: c.height });
    }
    const blob = buildPdf(pages, T.sheet);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `decalque-${fmt(G.heightCm).replace(',', '_')}cm.pdf`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    statusEl.textContent = `PDF pronto (${T.list.length === 1 ? '1 folha' : `${T.list.length} folhas`}). Imprima em tamanho real e confira a régua de 5 cm.`;
    if (new URLSearchParams(location.search).has('debug')) Object.assign(window, { __decalPdf: blob });
  } catch (err) {
    console.error(err);
    statusEl.textContent = 'Não consegui gerar o PDF. Tente de novo.';
  } finally {
    pdfBtn.disabled = false;
  }
});

$('dClose').addEventListener('click', () => dlg.close());
dlg.addEventListener('close', () => {
  cur = null;
  view = null;
  dragging = null;
});
// Ao girar o celular, ajusta a prévia. Abrir o teclado também muda a altura da tela: isso não
// precisa redesenhar nada (e não pode atrapalhar quem está digitando).
let lastWidth = window.innerWidth;
window.addEventListener('resize', () => {
  if (!dlg.open || window.innerWidth === lastWidth) return;
  lastWidth = window.innerWidth;
  drawPhoto();
  update();
});
