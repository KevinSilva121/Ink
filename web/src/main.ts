import '@fontsource-variable/inter/wght.css';
import './style.css';
import { analyze, loadModels, type Landmark } from './vision';
import { colorSkinMask, computeHighlight } from './photo';
import { buildTexture, prepareDesign, type Design, type Look, type Tex } from './design';
import {
  cloneEdits,
  containsPoint,
  estimateFrame,
  flatFrame,
  noEdits,
  profileAt,
  shiftAt,
  transferEdits,
  withEdits,
  type ContourEdits,
  type Frame,
} from './geometry';
import { imageToLocal, localToImage, outline, render, type Box, type Placement } from './render';
import { openExtractor } from './extractor';
import { acceptPaint, fitArea, gridSize, inkFraction, skinGrid, type Accepted, type SkinGrid } from './area';
import { openDecal } from './decal';
import { clamp, loadToCanvas, resampleBilinear, smoothstep } from './util';
import {
  askPersistence,
  deleteProject,
  getBlob,
  getProject,
  jsonReplacer,
  jsonReviver,
  listProjects,
  newId,
  putBlob,
  putProject,
} from './store';
import { blobToDataUrl, isNative, onBackButton, saveFile } from './platform';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------- Abertura ----------
// Fica pelo menos 1,5 s à vista e some suave quando o app terminou de carregar; um toque pula.
// O tempo conta de quando a arte chegou (no celular, a página leva segundos para abrir e, contando
// do início, a abertura sumia quase sem aparecer). Enquanto isso, os modelos carregam por baixo.
{
  const splash = $('splash');
  const art = splash.querySelector('img')!;
  let gone = false;
  const hide = () => {
    if (gone) return;
    gone = true;
    splash.classList.add('out');
    setTimeout(() => splash.remove(), 450);
  };
  const artAt = () => {
    const e = performance.getEntriesByName(art.currentSrc)[0] as PerformanceResourceTiming | undefined;
    return e?.responseEnd || performance.now();
  };
  const shown = new Promise<number>((res) => {
    if (art.complete) res(artAt());
    else {
      art.addEventListener('load', () => res(performance.now()), { once: true });
      art.addEventListener('error', () => res(0), { once: true });
    }
  });
  const loaded = new Promise<void>((res) => {
    if (document.readyState === 'complete') res();
    else window.addEventListener('load', () => res(), { once: true });
  });
  void Promise.all([shown, loaded]).then(([t]) => setTimeout(hide, Math.max(0, t + 1500 - performance.now())));
  splash.addEventListener('pointerdown', hide);
  setTimeout(hide, 6000); // nunca fica presa
}

const stage = $<HTMLCanvasElement>('stage');
const overlay = $<HTMLCanvasElement>('overlay');
const ctx = stage.getContext('2d')!;
const octx = overlay.getContext('2d')!;
const statusEl = $('status');
const stageBox = $('stageBox');
const stageView = $('stageView');
const layerList = $<HTMLUListElement>('layers');
const sizeIn = $<HTMLInputElement>('size');
const rotIn = $<HTMLInputElement>('rot');
const curvIn = $<HTMLInputElement>('curv');
const covIn = $<HTMLInputElement>('cov');
const clipIn = $<HTMLInputElement>('clip');
const flipIn = $<HTMLInputElement>('flip');
const debugIn = $<HTMLInputElement>('debug');

// Tamanho em escala logarítmica: 10% a 1000% da sugestão inicial (100% no meio).
const SIZE_MIN = 0.1;
const SIZE_MAX = 10;
const sliderToScale = (v: number) => SIZE_MIN * (SIZE_MAX / SIZE_MIN) ** (v / 1000);
const scaleToSlider = (s: number) => (1000 * Math.log(s / SIZE_MIN)) / Math.log(SIZE_MAX / SIZE_MIN);

interface PhotoState {
  w: number;
  h: number;
  canvas: HTMLCanvasElement;
  rgba: Uint8ClampedArray;
  highlight: Float32Array;
  skinModel: Float32Array | null;
  pose: Landmark[] | null;
  analyzed: boolean;
}

interface Layer {
  /** Identifica o desenho no projeto salvo (o arquivo original fica guardado com esta chave). */
  id: string;
  source: Blob;
  healed: boolean;
  /** Ponto onde a tatuagem foi ajustada ao corpo pela última vez (refaz a máscara de pele pela cor). */
  fitPoint: [number, number] | null;
  design: Design;
  tex: Tex;
  pl: Placement | null;
  /** Formato do membro como o app detectou. */
  fitted: Frame | null;
  /** Correções manuais do "Ajustar contorno" (bordas e pontas). */
  edits: ContourEdits;
  /** Formato usado para desenhar (detectado + correção manual). */
  frame: Frame | null;
  /**
   * Traços da área pintada, quando a pele da tatuagem inclui o que foi pintado com cor de pele
   * fora da detecção (a máscara é refeita com eles ao abrir o projeto).
   */
  area: Stroke[] | null;
  /** Traços da borracha (em pixels da foto) e o mapa resultante. */
  strokes: Stroke[];
  erase: Uint8Array | null;
  mask: Float32Array | null;
  maskSource: string;
  baseHeight: number;
  outline: [number, number][] | null;
}

interface Stroke {
  r: number;
  pts: [number, number][];
}

let photo: PhotoState | null = null;
let layers: Layer[] = [];
let sel: Layer | null = null;
let look: Look = 'cicatrizada';
let out: ImageData | null = null;
/** Foto + todas as tatuagens menos a selecionada (a selecionada é desenhada por cima). */
let baseCache: Uint8ClampedArray | null = null;
let modelsReady = false;
let modelsFailed = false;
let comparing = false;
let showFrameUntil = 0;

const placed = (L: Layer | null): L is Layer & { pl: Placement; frame: Frame } => !!L?.pl && !!L.frame;
const numberOf = (L: Layer) => layers.indexOf(L) + 1;
const QUIET = /^(Escolha uma foto do corpo|Preparando a detecção do corpo)/;
// Aviso maior que a faixa (3 linhas) cresce por cima da foto: os botões da foto descem junto,
// senão ficavam escondidos embaixo dele.
new ResizeObserver(() => {
  const over = Math.max(0, statusEl.offsetHeight - (statusEl.parentElement?.offsetHeight ?? 0));
  stageBox.style.setProperty('--st-over', `${over}px`);
}).observe(statusEl);

function setStatus(msg: string) {
  statusEl.textContent = msg;
  statusEl.classList.toggle('quiet', !msg || QUIET.test(msg));
}
/** Ícone do conjunto da página (index.html, <symbol id="i-...">). */
const icon = (name: string) => `<svg class="ic" aria-hidden="true"><use href="#i-${name}" /></svg>`;
const nextPaint = () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));
const invalidateBase = () => (baseCache = null);

// ---------- Modelos ----------
loadModels()
  .then(async () => {
    modelsReady = true;
    if (photo && !photo.analyzed) await runAnalysis();
    else hint();
  })
  .catch((err) => {
    console.error(err);
    modelsFailed = true;
    setStatus('Não consegui carregar a detecção do corpo. Vou usar só a cor da pele.');
  });

async function runAnalysis() {
  if (!photo) return;
  setStatus(layers.length ? 'Analisando o corpo na foto…' : 'Analisando o corpo na foto… Enquanto isso, já pode pintar a área onde a tatuagem vai ficar.');
  await nextPaint();
  const ph = photo;
  const res = await analyze(ph.canvas);
  // Trocou de foto (ou abriu um projeto) enquanto analisava: esta análise não vale mais.
  if (photo !== ph) return;
  photo.skinModel = res.skin;
  photo.pose = res.pose;
  photo.analyzed = true;
  areaGrid = null;
  if (tool === 'area') classifyArea();
  areaTint = null;
  for (const L of layers) if (placed(L)) fitLayer(L, L.pl.px, L.pl.py, true, false);
  invalidateBase();
  draw();
  // A pessoa pode estar no meio de uma ferramenta (a análise não trava mais a tela).
  if (!sideMode && !adjustMode && !eraseMode && tool !== 'area' && !locked) hint();
  // Reajuste automático (a detecção terminou): não é uma edição da pessoa.
  commit(true);
  if (tool === 'area') drawOverlay();
  // Tocou em "Encaixar" antes de a análise terminar.
  if (areaFitWaiting) {
    areaFitWaiting = false;
    fitSelToArea();
  } else if (tool === 'area') areaHint();
}

function hint() {
  if (!photo) {
    setStatus(modelsReady || modelsFailed ? 'Escolha uma foto do corpo para começar.' : 'Preparando a detecção do corpo…');
  } else if (tool === 'area') {
    areaHint();
  } else if (!layers.length) {
    setStatus('Pinte a área da tatuagem (botão "Área") ou adicione a tatuagem: botão "+ Tatuagem".');
  } else if (sel && !sel.pl) {
    setStatus(`Toque na foto onde você quer a tatuagem ${numberOf(sel)}.`);
  } else if (sel) {
    describe(sel);
  }
}

// ---------- Foto ----------
/** Prepara a foto (já no tamanho de trabalho) para o provador. */
function installPhoto(canvas: HTMLCanvasElement) {
  const w = canvas.width;
  const h = canvas.height;
  const rgba = canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h).data;
  photo = { w, h, canvas, rgba, highlight: computeHighlight(rgba, w, h), skinModel: null, pose: null, analyzed: false };
  stage.width = overlay.width = w;
  stage.height = overlay.height = h;
  out = new ImageData(new Uint8ClampedArray(rgba), w, h);
  selBox = null;
  areaGrid = null;
  resetArea();
  setEditorMode(true);
  resetView();
}

/**
 * Com a foto aberta, a tela vira o editor: a foto ocupa o espaço livre e as ferramentas ficam
 * embaixo (ou ao lado, em tela larga), sem rolar a página. Sem foto, volta aos passos 1 e 2.
 */
function setEditorMode(on: boolean) {
  document.body.classList.toggle('ed', on);
  stageBox.hidden = !on;
  $('empty').hidden = on;
  $('steps').hidden = on;
  $('dock').hidden = !on;
  // A lista de tatuagens vai junto para a parte visível.
  if (on) $('layerStrip').prepend(layerList);
  else $('layersHome').append(layerList);
  if (!on) {
    setLocked(false);
    setTool(null);
  }
  fitStage();
}

async function setPhoto(src: Blob) {
  setStatus('Carregando foto…');
  const canvas = await loadToCanvas(src, 1600);
  installPhoto(canvas);
  // Foto nova = projeto novo (o anterior continua salvo como estava).
  project = null;
  for (const L of layers) {
    L.pl = null;
    L.fitted = null;
    L.frame = null;
    L.edits = noEdits();
    L.area = null;
    L.strokes = [];
    L.erase = null;
    L.mask = null;
    L.outline = null;
  }
  setAdjustMode(false);
  setEraseMode(false);
  setSideMode(false);
  sel = layers[0] ?? null;
  maskTint = null;
  invalidateBase();
  refreshPanel();
  draw();
  // Foto nova: o histórico recomeça daqui.
  resetHistory();
  // O primeiro passo é pintar a área da tatuagem (com ou sem tatuagem escolhida).
  setTool('area');
  if (modelsReady) await runAnalysis();
  else if (modelsFailed) hint();
  else setStatus('Foto carregada. Terminando de preparar a detecção do corpo…');
}

// ---------- Tatuagens ----------
/** Cria a tatuagem a partir do arquivo do desenho (sem colocar na lista). */
async function makeLayer(src: Blob | string, healed: boolean, id = newId()): Promise<Layer> {
  const source = typeof src === 'string' ? await (await fetch(src)).blob() : src;
  const canvas = await loadToCanvas(source, 1200);
  const img = canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, canvas.width, canvas.height);
  const design = prepareDesign(img);
  if (healed) {
    design.healed = true;
    design.note = 'Extraída de uma foto: o aspecto de cicatrizada já vem da própria foto.';
  }
  return {
    id,
    source,
    healed,
    fitPoint: null,
    design,
    tex: buildTexture(design, look),
    pl: null,
    fitted: null,
    edits: noEdits(),
    frame: null,
    area: null,
    strokes: [],
    erase: null,
    mask: null,
    maskSource: '',
    baseHeight: 1,
    outline: null,
  };
}

async function addDesign(src: Blob | string, select = true, healed = false): Promise<Layer> {
  const L = await makeLayer(src, healed);
  layers.push(L);
  if (select || !sel) selectLayer(L);
  else refreshPanel();
  return L;
}

async function addDesigns(files: (Blob | string)[], healed = false) {
  if (!files.length) return;
  setStatus(files.length > 1 ? `Preparando ${files.length} tatuagens…` : 'Preparando a tatuagem…');
  let first: Layer | null = null;
  for (const f of files) {
    const L = await addDesign(f, false, healed);
    first ??= L;
  }
  if (first) selectLayer(first);
  commit();
  if (!photo || !first || first.pl) {
    hint();
    return;
  }
  // Já tem área pintada: a tatuagem vem encaixada nela. Senão, é hora de pintar.
  if (areaStrokes.length) fitSelToArea();
  else {
    setTool('area');
    areaHint();
  }
}

function removeLayer(L: Layer) {
  const i = layers.indexOf(L);
  if (i < 0) return;
  layers.splice(i, 1);
  if (sel === L) sel = layers[Math.min(i, layers.length - 1)] ?? null;
  invalidateBase();
  refreshPanel();
  if (!placed(sel)) {
    setAdjustMode(false);
    setEraseMode(false);
    setSideMode(false);
  }
  draw();
  hint();
  commit();
}

function selectLayer(L: Layer | null) {
  if (sel !== L) invalidateBase();
  sel = L;
  showFrameUntil = performance.now() + 1500;
  maskTint = null;
  refreshPanel();
  draw();
}

// ---------- Voltar / Avançar ----------
// Cada edição terminada vira um passo: uma foto do estado de todas as tatuagens. Voltar e
// avançar só trocam qual foto está valendo. As partes pesadas (formato do membro, máscara de
// pele) são guardadas por referência: nunca são alteradas depois de criadas.
interface LayerSnap {
  L: Layer;
  pl: Placement | null;
  fitted: Frame | null;
  fitPoint: [number, number] | null;
  edits: ContourEdits;
  area: Stroke[] | null;
  strokes: Stroke[];
  mask: Float32Array | null;
  maskSource: string;
  baseHeight: number;
}

interface Snap {
  layers: LayerSnap[];
  sel: Layer | null;
  look: Look;
}

const HISTORY_MAX = 80;
let history: Snap[] = [];
let historyAt = -1;
const undoBtn = $<HTMLButtonElement>('undo');
const redoBtn = $<HTMLButtonElement>('redo');

function snapshot(): Snap {
  return {
    layers: layers.map((L) => ({
      L,
      pl: L.pl ? { ...L.pl } : null,
      fitted: L.fitted,
      fitPoint: L.fitPoint,
      edits: cloneEdits(L.edits),
      area: L.area,
      strokes: [...L.strokes],
      mask: L.mask,
      maskSource: L.maskSource,
      baseHeight: L.baseHeight,
    })),
    sel,
    look,
  };
}

function samePlacement(a: Placement | null, b: Placement | null): boolean {
  if (!a || !b) return a === b;
  return (Object.keys(a) as (keyof Placement)[]).every((k) => a[k] === b[k]);
}

function sameSnap(a: Snap, b: Snap): boolean {
  if (a.look !== b.look || a.layers.length !== b.layers.length) return false;
  return a.layers.every((x, i) => {
    const y = b.layers[i];
    return (
      x.L === y.L &&
      x.fitted === y.fitted &&
      x.mask === y.mask &&
      samePlacement(x.pl, y.pl) &&
      x.strokes.length === y.strokes.length &&
      x.strokes.every((s, j) => s === y.strokes[j]) &&
      JSON.stringify(x.edits) === JSON.stringify(y.edits)
    );
  });
}

/** Guarda o estado atual como um passo. `replace` troca o passo atual (ajuste automático). */
function commit(replace = false) {
  const s = snapshot();
  if (historyAt >= 0 && sameSnap(s, history[historyAt])) {
    history[historyAt].sel = s.sel;
    return;
  }
  if (replace && historyAt >= 0) {
    history[historyAt] = s;
  } else {
    history = history.slice(0, historyAt + 1);
    history.push(s);
    // Limite de passos e de memória: cada máscara de pele pela cor ocupa alguns MB.
    const heavy = () => {
      const set = new Set<Float32Array>();
      for (const h of history) for (const x of h.layers) if (x.mask && x.mask !== photo?.skinModel) set.add(x.mask);
      return set.size;
    };
    while (history.length > HISTORY_MAX || (history.length > 2 && heavy() > 12)) history.shift();
    historyAt = history.length - 1;
  }
  updateHistoryButtons();
  scheduleSave();
}

function resetHistory() {
  history = [];
  historyAt = -1;
  commit();
}

function updateHistoryButtons() {
  undoBtn.disabled = locked || historyAt <= 0;
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-undo]')) b.disabled = undoBtn.disabled;
  redoBtn.disabled = locked || historyAt >= history.length - 1;
}

function restore(s: Snap) {
  layers = s.layers.map((x) => x.L);
  for (const x of s.layers) {
    const L = x.L;
    L.pl = x.pl ? { ...x.pl } : null;
    L.fitted = x.fitted;
    L.fitPoint = x.fitPoint;
    L.edits = cloneEdits(x.edits);
    L.frame = L.pl && L.fitted ? withEdits(L.fitted, L.edits) : null;
    L.mask = x.mask;
    L.maskSource = x.maskSource;
    L.area = x.area;
    L.baseHeight = x.baseHeight;
    const sameStrokes = L.strokes.length === x.strokes.length && L.strokes.every((st, j) => st === x.strokes[j]);
    if (!sameStrokes) {
      L.strokes = [...x.strokes];
      rebuildErase(L);
    }
  }
  if (look !== s.look) {
    look = s.look;
    const radio = document.querySelector<HTMLInputElement>(`input[name="look"][value="${look}"]`);
    if (radio) radio.checked = true;
    for (const L of layers) L.tex = buildTexture(L.design, look);
  }
  sel = s.sel && layers.includes(s.sel) ? s.sel : (layers[0] ?? null);
  // Algo no meio do caminho (arrasto, traço) é descartado.
  if (areaStroke) {
    areaStroke = null;
    repaintArea();
  }
  drag = null;
  sideDrag = null;
  stroke = null;
  if (!placed(sel)) {
    setAdjustMode(false);
    setEraseMode(false);
    setSideMode(false);
  } else if (adjustMode && !sel.fitted?.ok) setAdjustMode(false);
  maskTint = null;
  invalidateBase();
  refreshPanel();
  draw();
}

function undo() {
  if (locked || historyAt <= 0) return;
  historyAt--;
  restore(history[historyAt]);
  updateHistoryButtons();
  scheduleSave();
  setStatus('Voltei uma edição. Use "Avançar" para refazer.');
}

function redo() {
  if (locked || historyAt >= history.length - 1) return;
  historyAt++;
  restore(history[historyAt]);
  updateHistoryButtons();
  scheduleSave();
  setStatus('Avancei uma edição.');
}

// ---------- Projetos (salvos no aparelho, sozinhos, a cada edição) ----------
interface ProjectInfo {
  id: string;
  name: string;
  created: number;
  photoKey: string;
  skinKey: string | null;
  /** Arquivos já gravados no aparelho (não precisam ser gravados de novo). */
  saved: Set<string>;
}

interface SavedLayer {
  id: string;
  healed: boolean;
  pl: Placement | null;
  fitted: Frame | null;
  fitPoint: [number, number] | null;
  edits: ContourEdits;
  strokes: Stroke[];
  maskSource: string;
  /** Traços da área pintada (máscara "área"). */
  area?: Stroke[] | null;
  baseHeight: number;
}

interface SavedState {
  version: 1;
  w: number;
  h: number;
  photoKey: string;
  skinKey: string | null;
  pose: Landmark[] | null;
  look: Look;
  sel: number;
  layers: SavedLayer[];
}

let project: ProjectInfo | null = null;
let saveTimer = 0;
let saving: Promise<void> | null = null;
/** Enquanto um projeto está sendo aberto, nada é salvo (o estado ainda está pela metade). */
let loadingProject = false;
const saveStateEl = $('saveState');
/** Selo sobre a foto: o ícone (no CSS) muda com o estado. */
function setSaveState(text: string, state: '' | 'busy' | 'ok' | 'err') {
  saveStateEl.textContent = text;
  saveStateEl.dataset.state = state;
}

const defaultName = () =>
  `Projeto de ${new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} às ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;

/**
 * Imagem do canvas como arquivo. Não usa toBlob: o navegador só faz esse trabalho quando
 * está "ocioso" e, num celular ocupado, cada chamada esperava ~4 s (a foto, ~13 s).
 * toDataURL codifica na hora.
 */
async function canvasBlob(c: HTMLCanvasElement, type: string, q?: number): Promise<Blob> {
  const url = c.toDataURL(type, q);
  const bin = atob(url.slice(url.indexOf(',') + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

/** Máscara de pele (0..1) ↔ imagem PNG em tons de cinza (sem perda, 8 bits). */
/**
 * A máscara é guardada pequena (até 512 px): o modelo de pele trabalha em 256 px, então
 * guardar no tamanho da foto só gastava tempo (codificar PNG grande leva segundos em celular
 * fraco). Ao abrir, volta ao tamanho da foto por interpolação.
 */
const MASK_SIDE = 512;

function maskToCanvas(m: Float32Array, w: number, h: number): HTMLCanvasElement {
  const s = Math.min(1, MASK_SIDE / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * s));
  const ch = Math.max(1, Math.round(h * s));
  const small = s < 1 ? resampleBilinear(m, w, h, cw, ch) : m;
  const c = document.createElement('canvas');
  c.width = cw;
  c.height = ch;
  const img = new ImageData(cw, ch);
  for (let i = 0; i < small.length; i++) {
    const v = Math.round(clamp(small[i], 0, 1) * 255);
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  c.getContext('2d')!.putImageData(img, 0, 0);
  return c;
}

async function blobToMask(b: Blob, w: number, h: number): Promise<Float32Array> {
  // Abre no tamanho em que foi guardada (projetos antigos: tamanho da foto) e amplia.
  const c = await loadToCanvas(b, Math.max(w, h));
  const d = c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height).data;
  const m = new Float32Array(c.width * c.height);
  for (let i = 0; i < m.length; i++) m[i] = d[i * 4] / 255;
  return c.width === w && c.height === h ? m : resampleBilinear(m, c.width, c.height, w, h);
}

function scheduleSave() {
  if (!photo || loadingProject) return;
  clearTimeout(saveTimer);
  setSaveState('Salvando…', 'busy');
  saveTimer = window.setTimeout(() => {
    saveTimer = 0;
    void saveNow();
  }, 900);
}

async function saveNow(): Promise<void> {
  if (saving) await saving;
  saving = doSave().finally(() => (saving = null));
  return saving;
}

async function doSave() {
  if (!photo || loadingProject) return;
  const ph = photo;
  try {
    if (!project) {
      const id = newId();
      project = { id, name: defaultName(), created: Date.now(), photoKey: `${id}-foto`, skinKey: null, saved: new Set() };
      void askPersistence();
    }
    const P = project;
    // Tempo de cada etapa (no console), para achar o que pesa em celular fraco.
    const tm: string[] = [];
    let t = performance.now();
    const lap = (what: string) => {
      const now = performance.now();
      tm.push(`${what} ${Math.round(now - t)} ms`);
      t = now;
    };
    if (!P.saved.has(P.photoKey)) {
      // JPEG de alta qualidade: em celular fraco, PNG desse tamanho levava ~13 s para codificar.
      const b = await canvasBlob(ph.canvas, 'image/jpeg', 0.95);
      lap('foto→jpeg');
      await putBlob(P.photoKey, b);
      lap(`foto gravada (${Math.round(b.size / 1024)} KB)`);
      P.saved.add(P.photoKey);
    }
    if (ph.skinModel && !P.skinKey) {
      const key = `${P.id}-pele`;
      const b = await canvasBlob(maskToCanvas(ph.skinModel, ph.w, ph.h), 'image/png');
      lap('pele→png');
      await putBlob(key, b);
      lap(`pele gravada (${Math.round(b.size / 1024)} KB)`);
      P.skinKey = key;
      P.saved.add(key);
    }
    for (const L of layers) {
      if (P.saved.has(L.id)) continue;
      await putBlob(L.id, L.source);
      P.saved.add(L.id);
    }
    const state: SavedState = {
      version: 1,
      w: ph.w,
      h: ph.h,
      photoKey: P.photoKey,
      skinKey: P.skinKey,
      pose: ph.pose,
      look,
      sel: sel ? layers.indexOf(sel) : -1,
      layers: layers.map((L) => ({
        id: L.id,
        healed: L.healed,
        pl: L.pl ? { ...L.pl } : null,
        fitted: L.fitted,
        fitPoint: L.fitPoint,
        edits: cloneEdits(L.edits),
        strokes: L.strokes,
        maskSource: L.maskSource,
        area: L.area,
        baseHeight: L.baseHeight,
      })),
    };
    // Miniatura para a lista de projetos.
    const tc = document.createElement('canvas');
    const ts = 240 / Math.max(stage.width, stage.height);
    tc.width = Math.max(1, Math.round(stage.width * ts));
    tc.height = Math.max(1, Math.round(stage.height * ts));
    const tg = tc.getContext('2d')!;
    tg.imageSmoothingQuality = 'high';
    tg.drawImage(stage, 0, 0, tc.width, tc.height);
    const thumb = await canvasBlob(tc, 'image/jpeg', 0.8);
    lap('desenhos + miniatura');
    if (project !== P) return; // trocou de projeto no meio
    await putProject({
      id: P.id,
      name: P.name,
      created: P.created,
      updated: Date.now(),
      thumb,
      state,
      blobKeys: [P.photoKey, ...(P.skinKey ? [P.skinKey] : []), ...layers.map((L) => L.id)],
    });
    lap('registro');
    console.info(`Projeto salvo: ${tm.join(', ')}`);
    setSaveState('Salvo no aparelho', 'ok');
  } catch (err) {
    console.error(err);
    setSaveState('Não consegui salvar', 'err');
  }
}

/** Fecha o que estiver aberto e volta para a tela inicial (sem foto). */
function newProject() {
  clearTimeout(saveTimer);
  setAdjustMode(false);
  setEraseMode(false);
  setSideMode(false);
  project = null;
  photo = null;
  out = null;
  layers = [];
  sel = null;
  history = [];
  historyAt = -1;
  invalidateBase();
  setEditorMode(false);
  setSaveState('', '');
  refreshPanel();
  updateHistoryButtons();
  hint();
}

async function openProject(id: string) {
  const rec = await getProject(id);
  if (!rec) return;
  const st = rec.state as SavedState;
  loadingProject = true;
  clearTimeout(saveTimer);
  setAdjustMode(false);
  setEraseMode(false);
  setSideMode(false);
  setStatus('Abrindo projeto…');
  try {
    const photoBlob = await getBlob(st.photoKey);
    if (!photoBlob) throw new Error('foto do projeto não encontrada');
    // A foto foi guardada já no tamanho de trabalho: abre sem redimensionar.
    installPhoto(await loadToCanvas(photoBlob, Math.max(st.w, st.h)));
    const ph = photo!;
    const skinBlob = st.skinKey ? await getBlob(st.skinKey) : undefined;
    if (skinBlob) {
      ph.skinModel = await blobToMask(skinBlob, ph.w, ph.h);
      ph.pose = st.pose;
      ph.analyzed = true;
    }
    look = st.look;
    const radio = document.querySelector<HTMLInputElement>(`input[name="look"][value="${look}"]`);
    if (radio) radio.checked = true;
    const loaded: Layer[] = [];
    for (const s of st.layers) {
      const blob = await getBlob(s.id);
      if (!blob) continue;
      const L = await makeLayer(blob, s.healed, s.id);
      L.pl = s.pl ? { ...s.pl, stretch: s.pl.stretch ?? 1 } : null;
      L.fitted = s.fitted;
      L.fitPoint = s.fitPoint;
      L.edits = s.edits ?? noEdits();
      L.maskSource = s.maskSource;
      L.baseHeight = s.baseHeight;
      if (L.pl && L.fitted) {
        L.frame = withEdits(L.fitted, L.edits);
        const color = () => (L.fitPoint ? colorSkinMask(ph.rgba, ph.w, ph.h, L.fitPoint[0], L.fitPoint[1]) : null);
        if (s.maskSource === 'modelo' && ph.skinModel) L.mask = ph.skinModel;
        else if (s.maskSource === 'área' && s.area?.length) {
          const base = ph.skinModel ?? color();
          L.area = s.area;
          L.mask = base ? areaMaskFor(s.area, base) : null;
        } else L.mask = color();
      }
      L.strokes = s.strokes ?? [];
      rebuildErase(L);
      loaded.push(L);
    }
    layers = loaded;
    sel = layers[st.sel] ?? layers[0] ?? null;
    project = {
      id: rec.id,
      name: rec.name,
      created: rec.created,
      photoKey: st.photoKey,
      skinKey: skinBlob ? st.skinKey : null,
      saved: new Set(rec.blobKeys),
    };
    maskTint = null;
    invalidateBase();
    refreshPanel();
    draw();
    history = [];
    historyAt = -1;
    commit();
    setSaveState('Salvo no aparelho', 'ok');
  } finally {
    loadingProject = false;
  }
  // Projeto salvo antes da detecção do corpo terminar: termina agora.
  if (photo && !photo.analyzed && modelsReady) await runAnalysis();
  else hint();
}

// ----- Arquivo do projeto (para guardar de vez ou passar para outro aparelho) -----
const safeFileName = (s: string) => s.replace(/[\\/:*?"<>|]/g, '-').trim() || 'provink';

async function exportProject(id: string) {
  if (project?.id === id) await saveNow();
  const rec = await getProject(id);
  if (!rec) return;
  const blobs: Record<string, string> = {};
  for (const k of rec.blobKeys) {
    const b = await getBlob(k);
    if (b) blobs[k] = await blobToDataUrl(b);
  }
  const file = { format: 'provador-tatuagem', version: 1, name: rec.name, created: rec.created, updated: rec.updated, state: rec.state, blobs };
  const blob = new Blob([JSON.stringify(file, jsonReplacer)], { type: 'application/json' });
  await saveFile(blob, `${safeFileName(rec.name)}.provink.json`, `Projeto: ${rec.name}`);
}

async function importProject(file: Blob): Promise<string> {
  const data = JSON.parse(await file.text(), jsonReviver);
  if (data?.format !== 'provador-tatuagem' || !data.state) throw new Error('não é um arquivo de projeto');
  for (const [k, url] of Object.entries(data.blobs as Record<string, string>)) {
    if (!(await getBlob(k))) await putBlob(k, await (await fetch(url)).blob());
  }
  const id = newId();
  const thumb = null;
  await putProject({
    id,
    name: data.name ?? 'Projeto importado',
    created: data.created ?? Date.now(),
    updated: Date.now(),
    thumb,
    state: data.state,
    blobKeys: Object.keys(data.blobs),
  });
  return id;
}

// ----- Tela "Meus projetos" -----
const projDlg = $<HTMLDialogElement>('projects');
const projList = $<HTMLUListElement>('pList');
const projStatus = $('pStatus');

async function showProjects() {
  if (project) await saveNow();
  await renderProjects();
  if (!projDlg.open) projDlg.showModal();
}

async function renderProjects() {
  const all = await listProjects();
  projStatus.textContent = all.length ? '' : 'Nenhum projeto salvo ainda. Escolha uma foto do corpo: o projeto é salvo sozinho.';
  projList.replaceChildren(
    ...all.map((p) => {
      const li = document.createElement('li');
      li.className = 'proj';
      const img = document.createElement('img');
      img.alt = '';
      if (p.thumb) {
        img.src = URL.createObjectURL(p.thumb);
        img.onload = () => URL.revokeObjectURL(img.src);
      }
      const info = document.createElement('div');
      info.className = 'proj-info';
      const nameBox = document.createElement('label');
      nameBox.className = 'proj-name';
      const name = document.createElement('input');
      name.type = 'text';
      name.value = p.name;
      name.setAttribute('aria-label', 'Nome do projeto');
      name.addEventListener('change', async () => {
        const rec = await getProject(p.id);
        if (!rec) return;
        rec.name = name.value.trim() || rec.name;
        await putProject(rec);
        if (project?.id === p.id) project.name = rec.name;
      });
      const when = document.createElement('span');
      when.className = 'note';
      const n = (p.state as SavedState).layers?.length ?? 0;
      when.textContent = `${n} tatuage${n === 1 ? 'm' : 'ns'} · editado em ${new Date(p.updated).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}`;
      nameBox.append(name);
      nameBox.insertAdjacentHTML('beforeend', icon('pencil'));
      info.append(nameBox, when);
      if (project?.id === p.id) {
        const open = document.createElement('span');
        open.className = 'proj-open';
        open.textContent = 'aberto agora';
        info.append(open);
      }
      const acts = document.createElement('div');
      acts.className = 'proj-acts';
      const mk = (label: string, cls: string, ic: string, fn: () => void) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = cls;
        b.innerHTML = icon(ic);
        b.append(label);
        b.addEventListener('click', fn);
        return b;
      };
      acts.append(
        mk('Abrir', 'btn ghost btn-gold', 'folder-open', () => {
          projDlg.close();
          void openProject(p.id).catch((err) => {
            console.error(err);
            setStatus('Não consegui abrir esse projeto.');
          });
        }),
        mk(isNative ? 'Salvar arquivo' : 'Baixar arquivo', 'btn ghost', 'download', () => void exportProject(p.id)),
        mk('Excluir', 'btn ghost btn-danger', 'trash', async () => {
          if (!confirm(`Excluir "${p.name}"? Isso não tem volta.`)) return;
          await deleteProject(p.id);
          if (project?.id === p.id) project = null;
          await renderProjects();
        }),
      );
      li.append(img, info, acts);
      return li;
    }),
  );
}

$('projectsBtn').addEventListener('click', () => void showProjects());
$('pClose').addEventListener('click', () => projDlg.close());
$('pNew').addEventListener('click', () => {
  projDlg.close();
  newProject();
});
$<HTMLInputElement>('pImport').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  input.value = '';
  if (!f) return;
  try {
    const id = await importProject(f);
    projDlg.close();
    await openProject(id);
    scheduleSave(); // grava a miniatura do projeto importado
  } catch (err) {
    console.error(err);
    projStatus.textContent = 'Esse arquivo não é um projeto do provador (ou está corrompido).';
  }
});
// Ao sair ou trocar de aba (no app: ir para o fundo), grava o que estiver pendente.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'hidden' || !saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = 0;
  void saveNow();
});

// No app, "baixar" vira "salvar" (abre o menu de compartilhar do celular).
if (isNative) {
  $('pNote').textContent =
    'Cada projeto (foto, tatuagens e todos os ajustes) é salvo sozinho a cada edição, dentro do app. Para guardar uma cópia ou passar para outro aparelho, use "Salvar arquivo" e depois "Abrir arquivo de projeto".';
  $('dPdf').querySelector('span')!.textContent = 'Salvar PDF (tamanho real)';
}

// Botão "voltar" do Android: fecha a tela aberta ou o modo de edição, nessa ordem.
onBackButton(() => {
  const open = document.querySelector<HTMLDialogElement>('dialog[open]');
  if (open) {
    open.close();
    return true;
  }
  if (!addMenu.hidden) {
    closeAddMenu();
    return true;
  }
  if (tool) {
    setTool(null);
    return true;
  }
  if (view.z > 1) {
    resetView();
    return true;
  }
  return false;
});

undoBtn.addEventListener('click', undo);
redoBtn.addEventListener('click', redo);
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || !photo) return;
  if (document.querySelector('dialog[open]')) return;
  const k = e.key.toLowerCase();
  if (k === 'z' && !e.shiftKey) {
    e.preventDefault();
    undo();
  } else if (k === 'y' || (k === 'z' && e.shiftKey)) {
    e.preventDefault();
    redo();
  }
});

/** Miniaturas já feitas (montar uma a partir do desenho grande custa caro num celular fraco). */
const thumbs = new WeakMap<Tex, HTMLCanvasElement>();

function thumbOf(tex: Tex): HTMLCanvasElement {
  let c = thumbs.get(tex);
  if (!c) {
    c = makeThumb(tex, 96);
    thumbs.set(tex, c);
  }
  return c;
}

function makeThumb(tex: Tex, size: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const t = c.getContext('2d')!;
  const L = tex.levels[0];
  const tmp = document.createElement('canvas');
  tmp.width = L.w;
  tmp.height = L.h;
  const opaque = new Uint8ClampedArray(L.data);
  for (let i = 3; i < opaque.length; i += 4) opaque[i] = 255;
  tmp.getContext('2d')!.putImageData(new ImageData(opaque, L.w, L.h), 0, 0);
  t.fillStyle = '#c89474';
  t.fillRect(0, 0, size, size);
  const s = Math.min(size / L.w, size / L.h) * 0.9;
  t.globalCompositeOperation = 'multiply';
  t.imageSmoothingQuality = 'high';
  t.drawImage(tmp, (size - L.w * s) / 2, (size - L.h * s) / 2, L.w * s, L.h * s);
  return c;
}

/** Atualiza a lista de tatuagens e o painel de controles. */
function refreshPanel() {
  layerList.replaceChildren(
    ...layers.map((L, i) => {
      const li = document.createElement('li');
      li.className = L === sel ? 'chip on' : 'chip';
      const main = document.createElement('button');
      main.type = 'button';
      main.className = 'chip-main';
      main.setAttribute('aria-pressed', String(L === sel));
      main.setAttribute('aria-label', `Tatuagem ${i + 1}${L.pl ? '' : ' (falta posicionar)'}`);
      main.append(thumbOf(L.tex));
      const label = document.createElement('span');
      label.className = 'chip-num';
      label.textContent = `${i + 1}`;
      if (!L.pl) {
        const pend = document.createElement('span');
        pend.className = 'pending';
        pend.textContent = photo ? 'posicionar' : 'aguardando foto';
        main.append(label, pend);
      } else main.append(label);
      main.addEventListener('click', () => {
        selectLayer(L);
        hint();
      });
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'chip-del';
      del.innerHTML = icon('x');
      del.setAttribute('aria-label', `Remover tatuagem ${i + 1}`);
      del.addEventListener('click', () => {
        if (!locked) removeLayer(L);
      });
      li.append(main, del);
      return li;
    }),
  );
  $('designNote').textContent = sel ? sel.design.note : '';
  if (placed(sel)) syncControls();
  syncToolUI();
}

// ---------- Ajuste ao corpo ----------
function fitLayer(L: Layer, x: number, y: number, keepEdits: boolean, report = true) {
  if (!photo) return;
  const { w, h } = photo;
  x = clamp(x, 0, w - 1);
  y = clamp(y, 0, h - 1);
  const i = Math.round(y) * w + Math.round(x);
  if (photo.skinModel && photo.skinModel[i] > 0.35) {
    L.mask = photo.skinModel;
    L.maskSource = 'modelo';
  } else {
    L.mask = colorSkinMask(photo.rgba, w, h, x, y);
    L.maskSource = L.mask[i] >= 0.5 ? 'cor' : 'nenhuma';
    // Fora da pele (fundo, roupa): a máscara pela cor sai vazia e a tatuagem sumiria inteira.
    // Com a detecção do corpo, vale a pele dela.
    if (L.maskSource === 'nenhuma' && photo.skinModel) {
      L.mask = photo.skinModel;
      L.maskSource = 'modelo';
    }
  }
  L.area = null;
  if (L === sel) maskTint = null;
  L.fitPoint = [x, y];
  const prev = L.fitted;
  const fitted = L.mask[i] >= 0.5 ? estimateFrame(L.mask, w, h, x, y, photo.pose) : flatFrame(x, y, w, h, 'fora da pele');
  // A correção manual do contorno só continua valendo se ainda for o mesmo membro.
  let keep = false;
  if (keepEdits && prev?.ok && fitted.ok && prev.part === fitted.part) {
    const dot = prev.ux * fitted.ux + prev.uy * fitted.uy;
    const across = Math.abs((fitted.cx - prev.cx) * prev.vx + (fitted.cy - prev.cy) * prev.vy);
    keep = Math.abs(dot) > 0.94 && across < prev.R;
  }
  L.edits = keep && prev ? transferEdits(L.edits, prev, fitted) : noEdits();
  L.fitted = fitted;
  L.frame = withEdits(fitted, L.edits);
  // Tatuagem levada para além de uma ponta que tinha sido movida à mão: volta às pontas detectadas.
  const f = L.frame;
  if (f.ok && profileAt(f, (x - f.cx) * f.ux + (y - f.cy) * f.uy)[1] <= 0) {
    L.edits.tipLo = L.edits.tipHi = null;
    L.frame = withEdits(fitted, L.edits);
  }
  const firstTime = !L.pl;
  if (keepEdits && L.pl) {
    L.pl.px = x;
    L.pl.py = y;
  } else {
    L.pl = { px: x, py: y, height: 1, stretch: 1, rot: 0, curvature: 1, coverage: 0.15, clip: true, flip: flipIn.checked };
    applyDefaults(L);
  }
  if (L !== sel) invalidateBase();
  if (!report) return;
  if (firstTime) {
    // Várias importadas de uma vez: passa para a próxima que falta posicionar.
    const next = layers.find((o) => !o.pl);
    if (next) {
      selectLayer(next);
      setStatus(`Tatuagem ${numberOf(L)} posicionada. Agora toque onde você quer a tatuagem ${numberOf(next)}.`);
      return;
    }
  }
  refreshPanel();
  draw();
  describe(L);
}

/**
 * Durante o arrasto: em cima do membro medido, a tatuagem continua enrolada nele; com o meio
 * fora dele, fica plana embaixo do dedo (o enrolamento colava a tatuagem na borda do membro).
 */
function followLimb(L: Layer & { pl: Placement; frame: Frame }) {
  if (!photo || !L.fitted?.ok) return;
  const { px, py } = L.pl;
  if (L.frame.ok && containsPoint(L.frame, px, py)) return;
  const limb = L.frame.ok ? L.frame : withEdits(L.fitted, L.edits);
  L.frame = containsPoint(limb, px, py) ? limb : flatFrame(px, py, photo.w, photo.h, 'fora do membro');
}

/**
 * Depois de arrastar: se a tatuagem continua no mesmo membro, o formato medido continua valendo
 * (só ela andou). Se foi para outra parte do corpo, mede de novo ali. Se o meio dela caiu fora da
 * pele mas dentro do membro (relógio, sombra), também mantém. Fora do membro, mede de novo onde
 * ela foi solta (no fundo, fica plana e com o contorno à vista).
 */
function settleMoved(L: Layer & { pl: Placement; frame: Frame }) {
  if (!photo) return;
  const { px, py } = L.pl;
  const f = L.frame;
  const i = clamp(Math.round(py), 0, photo.h - 1) * photo.w + clamp(Math.round(px), 0, photo.w - 1);
  const t = (px - f.cx) * f.ux + (py - f.cy) * f.uy;
  const inside = f.ok && containsPoint(f, px, py);
  const sameLimb = inside && (!!f.profile?.caps || Math.abs(t) < 3 * f.R);
  const offSkin = photo.skinModel ? photo.skinModel[i] < 0.35 && (!L.mask || L.mask[i] < 0.5) : false;
  // Fora da pele mas ainda dentro do membro (relógio, sombra): o encaixe de antes continua valendo.
  // Fora do membro, não: o meio da tatuagem ia parar na borda do membro, longe do dedo.
  if (sameLimb || (offSkin && inside)) {
    refreshPanel();
    draw();
    if (sameLimb) describe(L);
    else setStatus('O meio da tatuagem ficou fora da pele: mantive o encaixe de antes. Arraste de volta para a pele para reencaixar.');
    return;
  }
  fitLayer(L, px, py, true);
}

function applyDefaults(L: Layer) {
  if (!photo || !L.frame || !L.pl) return;
  const minD = Math.min(photo.w, photo.h);
  const wide = L.tex.w / L.tex.h > 1.3;
  const torso = L.frame.part === 'tronco';
  const base = L.frame.ok ? L.frame.width : 0.3 * minD;
  // No tronco a largura medida é do peito/barriga inteiro: a sugestão inicial é bem menor.
  const k = torso ? 0.4 : wide ? 0.6 : 0.9;
  L.baseHeight = clamp(k * base, 0.06 * minD, 0.6 * minD);
  L.pl.height = L.baseHeight;
  L.pl.rot = wide && !torso ? Math.PI / 2 : 0;
  // Peito, costas e barriga são mais achatados que um cilindro da largura do tronco.
  L.pl.curvature = !L.frame.ok ? 0 : torso || L.frame.hitBorder ? 0.6 : 1;
  L.pl.coverage = 0.15;
  L.pl.clip = L.frame.ok;
}

function describe(L: Layer) {
  const f = L.frame;
  if (!f) return;
  if (!f.ok) {
    setStatus('Não achei pele nesse ponto, então ficou sem curvatura. Arraste a tatuagem para cima da pele.');
    return;
  }
  const parts = [`Ajustado ao corpo${f.part ? ` (${f.part})` : ''}.`];
  if (L.maskSource === 'cor') parts.push('Pele detectada pela cor.');
  if (f.hitBorder) parts.push('O membro sai da foto: curvatura estimada.');
  const cut = cutAt(L);
  if (cut) {
    parts.push(`Cortada ${cutAtJoint(cut)}: "Lados" encolhe esse lado; "Contorno" leva além.`);
  } else {
    parts.push(
      layers.length > 1
        ? 'Arraste para mover; dois dedos sobre ela giram e mudam o tamanho; toque em outra para editá-la.'
        : 'Arraste para mover; dois dedos sobre ela giram e mudam o tamanho.',
    );
  }
  setStatus(parts.join(' '));
}

/** "no punho", "nos dedos". */
const cutAtJoint = (j: string) => (j.endsWith('s') ? `nos ${j}` : `no ${j}`);

/** Articulação onde a ponta do membro está cortando a tatuagem (ex.: punho), ou null. */
function cutAt(L: Layer): string | null {
  const f = L.frame;
  const p = f?.profile;
  if (!f || !p?.caps || !p.ends || !p.joints || !L.outline) return null;
  let tMin = Infinity;
  let tMax = -Infinity;
  for (const [x, y] of L.outline) {
    const t = (x - f.cx) * f.ux + (y - f.cy) * f.uy;
    tMin = Math.min(tMin, t);
    tMax = Math.max(tMax, t);
  }
  // A ponta começa a arredondar em `caps`; até ~30% do arredondamento a diferença não aparece.
  if (tMax > p.caps[1] + 0.3 * (p.ends[1] - p.caps[1])) return p.joints[1];
  if (tMin < p.caps[0] - 0.3 * (p.caps[0] - p.ends[0])) return p.joints[0];
  return null;
}

/**
 * Tatuagem embaixo do dedo (a de cima primeiro). Aceita um pouco além da borda: com uma
 * tatuagem pequena, acertar o dedo bem dentro dela é difícil.
 */
function hitTest(x: number, y: number, slackCss = 14): Layer | null {
  const slack = slackCss * screenToImage();
  for (const pass of [0, 1]) {
    for (let k = layers.length - 1; k >= 0; k--) {
      const L = layers[k];
      if (!L.outline) continue;
      if (pass === 0 ? insidePolygon(x, y, L.outline) : distToPolygon(x, y, L.outline) < slack) return L;
    }
  }
  return null;
}

function distToPolygon(px: number, py: number, pts: [number, number][]): number {
  let best = Infinity;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [ax, ay] = pts[j];
    const [bx, by] = pts[i];
    const dx = bx - ax;
    const dy = by - ay;
    const t = clamp(((px - ax) * dx + (py - ay) * dy) / Math.max(1e-9, dx * dx + dy * dy), 0, 1);
    best = Math.min(best, Math.hypot(px - ax - dx * t, py - ay - dy * t));
  }
  return best;
}

/** Pixels da foto por pixel de tela (muda com o zoom). */
function screenToImage() {
  return stage.width / Math.max(1, stage.getBoundingClientRect().width);
}

function insidePolygon(px: number, py: number, pts: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[j];
    if (ay > py !== by > py && px < ((bx - ax) * (py - ay)) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}

// ---------- Controles ----------
function syncControls() {
  if (!placed(sel)) return;
  const pl = sel.pl;
  sizeIn.value = String(Math.round(scaleToSlider(pl.height / sel.baseHeight)));
  let deg = Math.round((-pl.rot * 180) / Math.PI);
  deg = ((((deg + 180) % 360) + 360) % 360) - 180;
  rotIn.value = String(deg);
  curvIn.value = String(Math.round(pl.curvature * 100));
  covIn.value = String(Math.round(pl.coverage * 100));
  clipIn.checked = pl.clip;
  flipIn.checked = pl.flip;
  updateOutputs();
}

function updateOutputs() {
  const scale = placed(sel) ? sel.pl.height / sel.baseHeight : sliderToScale(Number(sizeIn.value));
  $('sizeOut').textContent = `${Math.round(scale * 100)}%`;
  $('rotOut').textContent = `${rotIn.value}°`;
  $('curvOut').textContent = Number(curvIn.value) === 0 ? 'plana' : `${curvIn.value}%`;
  $('covOut').textContent = `${covIn.value}%`;
}

const editSel = (fn: (pl: Placement, L: Layer) => void) => () => {
  if (locked) return;
  if (placed(sel)) fn(sel.pl, sel);
  updateOutputs();
  schedule(true);
};
sizeIn.addEventListener('input', editSel((pl, L) => (pl.height = L.baseHeight * sliderToScale(Number(sizeIn.value)))));
rotIn.addEventListener('input', editSel((pl) => (pl.rot = (-Number(rotIn.value) * Math.PI) / 180)));
curvIn.addEventListener('input', editSel((pl) => (pl.curvature = Number(curvIn.value) / 100)));
covIn.addEventListener('input', editSel((pl) => (pl.coverage = Number(covIn.value) / 100)));
clipIn.addEventListener('change', editSel((pl) => (pl.clip = clipIn.checked)));
flipIn.addEventListener('change', editSel((pl) => (pl.flip = flipIn.checked)));
sizeIn.addEventListener('change', () => {
  // Ao soltar o controle de tamanho: avisa se a tatuagem passou da ponta do membro.
  if (placed(sel) && !adjustMode && !eraseMode) requestAnimationFrame(() => placed(sel) && describe(sel));
});
// Cada controle vira um passo ao ser solto (e não a cada pixel arrastado).
for (const el of [sizeIn, rotIn, curvIn, covIn, clipIn, flipIn]) el.addEventListener('change', () => commit());
debugIn.addEventListener('change', () => drawOverlay());
document.querySelectorAll<HTMLInputElement>('input[name="look"]').forEach((el) =>
  el.addEventListener('change', () => {
    look = el.value as Look;
    for (const L of layers) L.tex = buildTexture(L.design, look);
    invalidateBase();
    refreshPanel();
    draw();
    commit();
  }),
);

const compareBtn = $('compare');
const startCompare = (e: Event) => {
  e.preventDefault();
  comparing = true;
  draw();
};
const stopCompare = () => {
  if (!comparing) return;
  comparing = false;
  draw();
};
compareBtn.addEventListener('pointerdown', startCompare);
compareBtn.addEventListener('pointerup', stopCompare);
compareBtn.addEventListener('pointerleave', stopCompare);
compareBtn.addEventListener('pointercancel', stopCompare);
compareBtn.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------- Ajustar contorno (correção manual das bordas e das pontas do membro) ----------
/** Bolinha de ajuste: na borda (branca, move a borda naquele trecho) ou na ponta do membro (dourada). */
type AdjustHandle =
  | { kind: 'edge'; side: 'a' | 'b'; t: number; x: number; y: number }
  | { kind: 'tip'; end: 0 | 1; t: number; x: number; y: number };

let adjustMode = false;
let drag: AdjustHandle | null = null;

function setAdjustMode(on: boolean) {
  const was = adjustMode;
  adjustMode = on && placed(sel) && !!sel.fitted?.ok;
  if (adjustMode && eraseMode) setEraseMode(false);
  if (adjustMode && sideMode) setSideMode(false);
  syncToolUI();
  if (adjustMode && placed(sel)) {
    const joints = sel.frame.profile?.ends ? sel.frame.profile.joints : null;
    const msg = ['Brancas: arraste até a borda real da pele.'];
    if (joints) {
      const where = joints[0] === joints[1] ? '' : ` (${joints[0]} e ${joints[1]})`;
      msg.push(`Douradas: onde o membro termina${where}; arraste para a tatuagem ir além ou parar antes.`);
    }
    setStatus(msg.join(' '));
  } else if (was && placed(sel)) describe(sel);
  drawOverlay();
}

/** Trecho do eixo coberto pela tatuagem (do contorno dela). */
function axisSpan(L: Layer & { pl: Placement; frame: Frame }): [number, number, number] {
  const f = L.frame;
  const tOf = (x: number, y: number) => (x - f.cx) * f.ux + (y - f.cy) * f.uy;
  const t0 = tOf(L.pl.px, L.pl.py);
  let lo = t0;
  let hi = t0;
  for (const [x, y] of L.outline ?? []) {
    const t = tOf(x, y);
    lo = Math.min(lo, t);
    hi = Math.max(hi, t);
  }
  return [lo, t0, hi];
}

/**
 * Bolinhas do modo de contorno: três por borda (começo, meio e fim da tatuagem ao longo do
 * membro) e uma em cada ponta do membro, quando a pose mostrou onde ficam as articulações.
 */
function adjustHandles(L: Layer): AdjustHandle[] {
  if (!placed(L) || !L.frame.ok || !photo) return [];
  const f = L.frame;
  const p = f.profile;
  const hr = handleRadius();
  const [sLo, t0, sHi] = axisSpan(L);
  let lo = -Infinity;
  let hi = Infinity;
  if (p?.caps) [lo, hi] = p.caps;
  const ts: number[] = [];
  for (const t of [t0, sLo + 0.1 * (t0 - sLo), sHi - 0.1 * (sHi - t0)]) {
    const tc = clamp(t, Math.min(lo, hi), Math.max(lo, hi));
    if (ts.every((u) => Math.abs(u - tc) > 3 * hr)) ts.push(tc);
  }
  const at = (t: number, s: number): [number, number] => [f.cx + f.ux * t + f.vx * s, f.cy + f.uy * t + f.vy * s];
  const hs: AdjustHandle[] = [];
  for (const t of ts) {
    const [o, r0] = profileAt(f, t);
    const r = r0 > 0 ? r0 : f.R;
    const [ax, ay] = at(t, o + r);
    const [bx, by] = at(t, o - r);
    hs.push({ kind: 'edge', side: 'a', t, x: ax, y: ay }, { kind: 'edge', side: 'b', t, x: bx, y: by });
  }
  if (p?.ends) {
    for (const end of [0, 1] as const) {
      const t = p.ends[end];
      const [x, y] = at(t, profileAt(f, t)[0]);
      if (x >= 0 && y >= 0 && x < photo.w && y < photo.h) hs.push({ kind: 'tip', end, t, x, y });
    }
  }
  return hs;
}

/** Move a bolinha que está sendo arrastada (deslocamento do dedo em pixels da foto). */
function dragHandle(L: Layer, h: AdjustHandle, dx: number, dy: number) {
  const f = L.fitted;
  if (!f?.ok || !L.frame) return;
  const e = L.edits;
  if (h.kind === 'edge') {
    // Usa o ponto de ajuste que já existe naquele trecho, ou cria um partindo do contorno atual.
    const near = 1.5 * handleRadius();
    let k = e.knots.find((q) => Math.abs(q.t - h.t) < near);
    if (!k) {
      const [a, b] = shiftAt(e.knots, h.t);
      k = { t: h.t, a, b };
      e.knots.push(k);
      e.knots.sort((p, q) => p.t - q.t);
    }
    const d = dx * f.vx + dy * f.vy;
    // Uma borda não passa da outra: o membro fica com pelo menos ~1/5 da largura detectada
    // (antes ficava com 1 px e a tatuagem sumia).
    const r0 = profileAt(f, h.t)[1] || f.R;
    const slack = 2 * (Math.max(4, 0.2 * r0) - r0);
    if (h.side === 'a') k.a = Math.max(k.a + d, k.b + slack);
    else k.b = Math.min(k.b + d, k.a - slack);
  } else {
    h.t += dx * f.ux + dy * f.uy;
    // As duas pontas não podem se cruzar: sobra pelo menos um raio de membro entre elas. E a
    // ponta não passa do meio da tatuagem (passando, o membro acabava antes dela e ela sumia).
    const ends = L.frame.profile?.ends;
    if (!ends) return;
    const fr = L.frame;
    const minLen = 2 * fr.R;
    const t0 = L.pl ? (L.pl.px - fr.cx) * fr.ux + (L.pl.py - fr.cy) * fr.uy : null;
    if (h.end === 1) e.tipHi = Math.max(h.t, ends[0] + minLen, t0 == null ? -Infinity : t0 + 0.5 * fr.R);
    else e.tipLo = Math.min(h.t, ends[1] - minLen, t0 == null ? Infinity : t0 - 0.5 * fr.R);
  }
  L.frame = withEdits(f, e);
}

/** Raio da bolinha desenhada (11 px na tela); a área de toque é maior (ver HANDLE_HIT). */
function handleRadius() {
  return (11 * stage.width) / Math.max(1, stage.getBoundingClientRect().width);
}
const HANDLE_HIT = 2.6;

// ---------- Ajustar lados (puxar só um lado da tatuagem; o lado oposto fica parado) ----------
/** Alça no meio de um lado do desenho: top/bottom mudam a altura, left/right a largura. */
interface SideHandle {
  side: 'top' | 'bottom' | 'left' | 'right';
  x: number;
  y: number;
}

let sideMode = false;
/** Arrasto de uma alça: o lado puxado e a tatuagem como estava ao começar. */
let sideDrag: { side: SideHandle['side']; start: Placement } | null = null;

function setSideMode(on: boolean) {
  const was = sideMode;
  sideMode = on && placed(sel);
  if (sideMode && adjustMode) setAdjustMode(false);
  if (sideMode && eraseMode) setEraseMode(false);
  syncToolUI();
  if (sideMode) {
    setStatus(
      'Puxe a bolinha de um lado para encolher ou esticar só aquele lado (o oposto fica parado).',
    );
  } else if (was && placed(sel)) describe(sel);
  drawOverlay();
}

function sideHandles(L: Layer): SideHandle[] {
  if (!placed(L)) return [];
  const hw = (L.pl.height * (L.tex.w / L.tex.h) * L.pl.stretch) / 2;
  const hh = L.pl.height / 2;
  const at = (side: SideHandle['side'], lx: number, ly: number): SideHandle => {
    const [x, y] = localToImage(L.frame, L.tex, L.pl, lx, ly);
    return { side, x, y };
  };
  return [at('top', 0, hh), at('bottom', 0, -hh), at('right', hw, 0), at('left', -hw, 0)];
}

/**
 * Move o lado puxado até o dedo. As contas usam a tatuagem como estava no começo do arrasto:
 * a posição do dedo vira coordenada do desenho, o lado oposto fica onde estava e o centro
 * passa a ser o meio entre os dois.
 */
function dragSide(L: Layer & { pl: Placement; frame: Frame }, x: number, y: number) {
  if (!sideDrag) return;
  const s = sideDrag.start;
  const [lx, ly] = imageToLocal(L.frame, L.tex, s, x, y);
  const aspect = L.tex.w / L.tex.h;
  const hh = s.height / 2;
  const hw = (s.height * aspect * s.stretch) / 2;
  // Puxando um lado além do oposto, a tatuagem para num tamanho mínimo em que ainda aparece e
  // as bolinhas não ficam uma em cima da outra (antes encolhia a 5% e sumia).
  const minSide = Math.max(0.1 * L.baseHeight, 3 * handleRadius());
  const minH = Math.min(s.height, minSide);
  const minW = Math.min(2 * hw, minSide);
  let cx = 0;
  let cy = 0;
  let height = s.height;
  let width = 2 * hw;
  switch (sideDrag.side) {
    case 'top': {
      const top = Math.max(ly, -hh + minH);
      height = top + hh;
      cy = (top - hh) / 2;
      break;
    }
    case 'bottom': {
      const bot = Math.min(ly, hh - minH);
      height = hh - bot;
      cy = (hh + bot) / 2;
      break;
    }
    case 'right': {
      const right = Math.max(lx, -hw + minW);
      width = right + hw;
      cx = (right - hw) / 2;
      break;
    }
    case 'left': {
      const left = Math.min(lx, hw - minW);
      width = hw - left;
      cx = (hw + left) / 2;
      break;
    }
  }
  height = clamp(height, L.baseHeight * SIZE_MIN * 0.5, L.baseHeight * SIZE_MAX);
  const [px, py] = localToImage(L.frame, L.tex, s, cx, cy);
  L.pl.px = px;
  L.pl.py = py;
  L.pl.height = height;
  L.pl.stretch = clamp(width / (height * aspect), 0.1, 10);
}

// ---------- Borracha (o que está na frente da pele: dedos, punho, roupa, relógio) ----------
let eraseMode = false;
let stroke: Stroke | null = null;
let cursor: { x: number; y: number } | null = null;

function setEraseMode(on: boolean) {
  const was = eraseMode;
  eraseMode = on && placed(sel);
  if (eraseMode && adjustMode) setAdjustMode(false);
  if (eraseMode && sideMode) setSideMode(false);
  syncToolUI();
  if (eraseMode) {
    setStatus('Passe o dedo onde a tatuagem não deve aparecer (dedos, roupa, relógio, cabelo). Dois dedos aproximam a foto.');
  } else {
    cursor = null;
    if (was && placed(sel)) describe(sel);
  }
  drawOverlay();
}

function brushRadius() {
  return (22 * stage.width) / Math.max(1, stage.getBoundingClientRect().width);
}

function stamp(erase: Uint8Array, x: number, y: number, r: number) {
  if (!photo) return;
  const { w, h } = photo;
  const x0 = Math.max(0, Math.floor(x - r));
  const x1 = Math.min(w - 1, Math.ceil(x + r));
  const y0 = Math.max(0, Math.floor(y - r));
  const y1 = Math.min(h - 1, Math.ceil(y + r));
  for (let yy = y0; yy <= y1; yy++) {
    for (let xx = x0; xx <= x1; xx++) {
      const d = Math.hypot(xx + 0.5 - x, yy + 0.5 - y);
      if (d > r) continue;
      const a = Math.round(255 * (1 - smoothstep(0.6 * r, r, d)));
      const i = yy * w + xx;
      if (a > erase[i]) erase[i] = a;
    }
  }
}

function stampSegment(erase: Uint8Array, a: [number, number], b: [number, number], r: number) {
  const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (r / 3)));
  for (let k = 1; k <= n; k++) stamp(erase, a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n, r);
}

function rebuildErase(L: Layer) {
  if (!photo || !L.strokes.length) {
    L.erase = null;
    return;
  }
  const e = new Uint8Array(photo.w * photo.h);
  for (const s of L.strokes) {
    stamp(e, s.pts[0][0], s.pts[0][1], s.r);
    for (let k = 1; k < s.pts.length; k++) stampSegment(e, s.pts[k - 1], s.pts[k], s.r);
  }
  L.erase = e;
}

stageBox.addEventListener('pointermove', (e) => {
  if ((!eraseMode && tool !== 'area') || !photo) return;
  cursor = toImage(e);
  if (!stroke) scheduleOverlay();
});
stageBox.addEventListener('pointerleave', () => {
  cursor = null;
  if (eraseMode || tool === 'area') scheduleOverlay();
});

$('decalBtn').addEventListener('click', () => {
  if (!placed(sel) || !sel.outline) return;
  setTool(null);
  // A foto como está na tela (com todas as tatuagens), para marcar os pontos de medida.
  comparing = false;
  draw();
  openDecal({ view: stage, frame: sel.frame, tex: sel.tex, design: sel.design, pl: { ...sel.pl }, outline: sel.outline });
});

$('refit').addEventListener('click', () => {
  if (!placed(sel) || locked) return;
  fitLayer(sel, sel.pl.px, sel.pl.py, false);
  setAdjustMode(false);
  setSideMode(false);
  commit();
});

$('save').addEventListener('click', async () => {
  if (!photo) return;
  try {
    // Garante a versão completa (não a prévia rápida de quando o dedo está arrastando).
    comparing = false;
    draw();
    const name = project?.name ?? 'provink';
    await saveFile(await canvasBlob(stage, 'image/jpeg', 0.92), `${safeFileName(name)}.jpg`, 'Foto com a tatuagem');
  } catch (err) {
    console.error(err);
    setStatus('Não consegui salvar a imagem.');
  }
});

$<HTMLInputElement>('photoInput').addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  if (f) void setPhoto(f).catch(showError);
  input.value = '';
});
$<HTMLInputElement>('designInput').addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  void addDesigns(files).catch(showError);
  input.value = '';
});
$<HTMLInputElement>('extractInput').addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  input.value = '';
  if (f) void openExtractor(f, (blob) => void addDesigns([blob], true).catch(showError));
});
document.querySelectorAll<HTMLButtonElement>('[data-example]').forEach((b) =>
  b.addEventListener('click', () => {
    closeAddMenu();
    void addDesigns([import.meta.env.BASE_URL + b.dataset.example]).catch(showError);
  }),
);
// Colar imagem copiada (ex.: botão direito > copiar imagem no Pinterest, depois Ctrl+V).
document.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files ?? [])].filter((x) => x.type.startsWith('image/'));
  if (files.length && !locked) void addDesigns(files).catch(showError);
});

function showError(err: unknown) {
  console.error(err);
  setStatus('Não consegui abrir essa imagem. Tente outra (JPG ou PNG).');
}

// ---------- Área (pinta onde a tatuagem vai ficar e ela já vem encaixada) ----------
/** Traços da área (pixels da foto): valem para a tatuagem selecionada ou para a próxima escolhida. */
let areaStrokes: Stroke[] = [];
let areaStroke: Stroke | null = null;
/** Tocou em "Encaixar" antes de a análise do corpo terminar. */
let areaFitWaiting = false;
/** Os traços, opacos, no tamanho da foto (a cor vem na hora de mostrar). */
const areaCanvas = document.createElement('canvas');
const actx = areaCanvas.getContext('2d')!;
/** Cor de cada célula pintada: azul no corpo, listras vermelhas fora dele (é ignorado). */
let areaTint: HTMLCanvasElement | null = null;
/** A foto na grade da área (cor média e pele), refeita quando muda a máscara de pele. */
let areaGrid: { body: Float32Array; grid: SkinGrid } | null = null;
/** O que já foi pintado, separado em corpo e fora do corpo (refeito ao fim de cada traço). */
let areaAcc: Accepted | null = null;
const areaSizeIn = $<HTMLInputElement>('areaSize');
const areaGoBtn = $<HTMLButtonElement>('areaGo');
const areaUndoBtn = $<HTMLButtonElement>('areaUndo');
const areaClearBtn = $<HTMLButtonElement>('areaClear');
const areaTapBtn = $<HTMLButtonElement>('areaTap');

function resetArea() {
  areaStrokes = [];
  areaStroke = null;
  areaAcc = null;
  areaTint = null;
  areaFitWaiting = false;
  // Mudar o tamanho limpa o canvas.
  areaCanvas.width = photo?.w ?? 1;
  areaCanvas.height = photo?.h ?? 1;
  syncAreaUI();
}

const areaBrush = () => Number(areaSizeIn.value) * screenToImage();

/** Pinta o traço (a partir do ponto `from`, para ir pintando enquanto o dedo anda). */
function paintStroke(st: Stroke, from = 0, c = actx) {
  const actx = c;
  actx.fillStyle = actx.strokeStyle = '#000';
  actx.lineCap = 'round';
  actx.lineJoin = 'round';
  actx.lineWidth = 2 * st.r;
  if (from === 0) {
    const [x, y] = st.pts[0];
    actx.beginPath();
    actx.arc(x, y, st.r, 0, Math.PI * 2);
    actx.fill();
  }
  if (st.pts.length < 2) return;
  const k0 = Math.max(0, from - 1);
  actx.beginPath();
  actx.moveTo(st.pts[k0][0], st.pts[k0][1]);
  for (let k = k0 + 1; k < st.pts.length; k++) actx.lineTo(st.pts[k][0], st.pts[k][1]);
  actx.stroke();
}

function repaintArea() {
  actx.clearRect(0, 0, areaCanvas.width, areaCanvas.height);
  for (const st of areaStrokes) paintStroke(st);
  if (areaStroke) paintStroke(areaStroke);
}

function gridFor(body: Float32Array): SkinGrid {
  if (areaGrid?.body !== body) areaGrid = { body, grid: skinGrid(photo!.rgba, photo!.w, photo!.h, body) };
  return areaGrid.grid;
}

/** Separa o que foi pintado no corpo e fora dele (só com a detecção do corpo pronta). */
function classifyArea() {
  areaAcc = photo?.skinModel && areaStrokes.length ? acceptPaint(gridFor(photo.skinModel), readPaint().rgba) : null;
  areaTint = null;
}

/** Cores da pintura, na grade: o que foi separado em corpo/fora e, onde ainda não, a detecção. */
function areaTintCanvas(): HTMLCanvasElement | null {
  if (!photo) return null;
  if (areaTint) return areaTint;
  const c = document.createElement('canvas');
  const model = photo.skinModel;
  if (!model) {
    // Ainda sem a detecção do corpo: tudo azul.
    c.width = c.height = 1;
    const g = c.getContext('2d')!;
    g.fillStyle = 'rgb(56, 189, 248)';
    g.fillRect(0, 0, 1, 1);
    return (areaTint = c);
  }
  const { gw, gh, skin } = gridFor(model);
  const img = new ImageData(gw, gh);
  const d = img.data;
  const acc = areaAcc;
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const k = j * gw + i;
      const p = k * 4;
      const body = acc?.painted[k] ? acc.ok[k] : skin[k];
      if (body) {
        d[p] = 56;
        d[p + 1] = 189;
        d[p + 2] = 248;
        d[p + 3] = 255;
      } else {
        d[p] = 239;
        d[p + 1] = 68;
        d[p + 2] = 68;
        d[p + 3] = (i + j) % 8 < 4 ? 255 : 70;
      }
    }
  }
  c.width = gw;
  c.height = gh;
  c.getContext('2d')!.putImageData(img, 0, 0);
  return (areaTint = c);
}

/**
 * Máscara de pele da tatuagem com a área: a pele detectada e mais o que foi pintado com cor de
 * pele ligado a ela (bordas suaves, vindas da grade).
 */
function withPaintedSkin(body: Float32Array, grid: SkinGrid, acc: Accepted): Float32Array {
  const ph = photo!;
  const extra = new Float32Array(grid.gw * grid.gh);
  // Todas as células aceitas (não só as da cor): nas células meio pele, meio fundo, a detecção
  // deixava buracos quadrados na borda.
  for (let k = 0; k < extra.length; k++) if (acc.ok[k]) extra[k] = 1;
  const up = resampleBilinear(extra, grid.gw, grid.gh, ph.w, ph.h);
  const m = new Float32Array(ph.w * ph.h);
  for (let i = 0; i < m.length; i++) m[i] = Math.max(body[i], smoothstep(0.3, 0.7, up[i]));
  return m;
}

/** Refaz a máscara de uma área guardada (ao abrir o projeto). */
function areaMaskFor(strokes: Stroke[], body: Float32Array): Float32Array {
  const ph = photo!;
  const c = document.createElement('canvas');
  c.width = ph.w;
  c.height = ph.h;
  const g = c.getContext('2d')!;
  for (const st of strokes) paintStroke(st, 0, g);
  const grid = gridFor(body);
  return withPaintedSkin(body, grid, acceptPaint(grid, readPaint(c).rgba));
}

/** Meio dos traços pintados (para achar a pele pela cor, quando a detecção do corpo falhou). */
function areaCenter(): [number, number] | null {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const st of areaStrokes) {
    for (const [x, y] of st.pts) {
      sx += x;
      sy += y;
      n++;
    }
  }
  return n ? [sx / n, sy / n] : null;
}

/** A pintura reduzida para a grade da área (~480 px; o encaixe não precisa de mais). */
function readPaint(src: HTMLCanvasElement = areaCanvas) {
  const ph = photo!;
  const [gw, gh] = gridSize(ph.w, ph.h);
  const c = document.createElement('canvas');
  c.width = gw;
  c.height = gh;
  const x = c.getContext('2d', { willReadFrequently: true })!;
  x.imageSmoothingEnabled = true;
  x.imageSmoothingQuality = 'high';
  x.drawImage(src, 0, 0, gw, gh);
  return { rgba: x.getImageData(0, 0, gw, gh).data, gw, gh };
}

function areaHint() {
  if (!photo) return;
  if (areaStrokes.length) {
    // Já pintou (também quando a análise do corpo termina depois): diz o que falta.
    const acc = areaAcc;
    const off = !!acc && acc.nOk < acc.nPainted;
    const go = sel ? '"Encaixar"' : '"Escolher tatuagem"';
    setStatus(
      off
        ? `A parte vermelha está fora do corpo e vai ser ignorada. Quando terminar, toque em ${go}.`
        : `Continue pintando ou toque em ${go}.`,
    );
  } else if (!sel) {
    setStatus('Pinte com o dedo a área que a tatuagem vai cobrir. Depois escolha a tatuagem: ela já vem no tamanho certo.');
  } else if (!sel.pl) {
    setStatus(`Pinte com o dedo a área que a tatuagem ${numberOf(sel)} vai cobrir e toque em "Encaixar". Dois dedos aproximam a foto.`);
  } else {
    setStatus(`Pinte a nova área da tatuagem ${numberOf(sel)} e toque em "Encaixar": tamanho, giro e curva são refeitos.`);
  }
}

function syncAreaUI() {
  const has = areaStrokes.length > 0;
  areaUndoBtn.disabled = !has;
  areaClearBtn.disabled = !has;
  $('areaGoLabel').textContent = sel ? 'Encaixar' : 'Escolher tatuagem';
  areaTapBtn.hidden = !(sel && !sel.pl);
  const v = Number(areaSizeIn.value);
  $('areaSizeOut').textContent = v < 18 ? 'Fino' : v < 36 ? 'Médio' : 'Grosso';
}

/** Encaixa a tatuagem selecionada na área pintada. */
function fitSelToArea() {
  if (!photo) return;
  if (!sel) {
    // Sem tatuagem ainda: escolhe agora (com ou sem área pintada; sem, ela espera a pintura).
    addMenu.hidden = false;
    addBtn.setAttribute('aria-expanded', 'true');
    setStatus(
      areaStrokes.length
        ? 'Área pronta. Agora escolha a tatuagem: ela já vem no tamanho da área.'
        : 'Escolha a tatuagem. Depois pinte a área que ela vai cobrir (ou toque em "Prefiro só tocar no lugar").',
    );
    return;
  }
  if (!areaStrokes.length) {
    setStatus('Primeiro pinte com o dedo a área que a tatuagem vai cobrir.');
    return;
  }
  if (!photo.analyzed && !modelsFailed) {
    areaFitWaiting = true;
    setStatus('Só um instante: terminando de analisar o corpo para encaixar…');
    return;
  }
  const ph = photo;
  const L = sel;
  let body = ph.skinModel;
  let source = 'modelo';
  let seed: [number, number] | null = null;
  if (!body) {
    // Sem a detecção do corpo: a pele é achada pela cor, a partir do meio da área.
    seed = areaCenter();
    if (!seed) return;
    body = colorSkinMask(ph.rgba, ph.w, ph.h, seed[0], seed[1]);
    source = 'cor';
  }
  const grid = gridFor(body);
  const acc = acceptPaint(grid, readPaint().rgba);
  // O que foi pintado com cor de pele, ligado à pele detectada, também recebe tinta.
  const fitBody = acc.nColor ? withPaintedSkin(body, grid, acc) : body;
  const r = fitArea(grid, acc, fitBody, ph.w, ph.h, ph.pose, L.tex.w / L.tex.h, inkFraction(L.tex.w, L.tex.h));
  if (r === 'vazia') {
    setStatus('Primeiro pinte com o dedo a área que a tatuagem vai cobrir.');
    return;
  }
  if (r === 'fora') {
    setStatus('O que você pintou está fora do corpo (fundo, roupa ou cabelo). Pinte em cima da pele.');
    return;
  }
  L.mask = fitBody;
  L.maskSource = acc.nColor ? 'área' : source;
  L.area = acc.nColor ? [...areaStrokes] : null;
  maskTint = null;
  L.fitPoint = seed ?? [r.px, r.py];
  L.fitted = r.frame;
  L.edits = noEdits();
  L.frame = withEdits(r.frame, L.edits);
  L.pl = {
    px: r.px,
    py: r.py,
    height: r.height,
    stretch: r.stretch,
    rot: r.rot,
    curvature: r.curvature,
    coverage: 0.15,
    clip: true,
    flip: flipIn.checked,
  };
  L.baseHeight = r.height;
  resetArea();
  closeAddMenu();
  setTool(null);
  showFrameUntil = performance.now() + 1500;
  refreshPanel();
  draw();
  commit();

  const f = r.frame;
  const msg = [`Encaixada na área pintada${f.part ? ` (${f.part})` : ''}.`];
  if (r.outside > 0.08) msg.push('O que saiu do corpo foi ignorado.');
  if (r.dropped) msg.push('Havia áreas separadas: usei a maior.');
  if (r.bent) {
    const leg = r.bent === 'joelho' || r.bent === 'tornozelo';
    msg.push(
      leg
        ? `Perna dobrada no ${r.bent}: ficou no trecho maior. Para fechar a perna toda, use uma foto com ela esticada.`
        : `Braço dobrado no ${r.bent}: ficou no trecho maior. Para fechar o braço todo, use uma foto com ele esticado.`,
    );
  } else msg.push('Arraste para mover; dois dedos sobre ela giram e mudam o tamanho.');
  setStatus(msg.join(' '));

  // Várias escolhidas de uma vez: a próxima também vai para uma área.
  const next = layers.find((o) => !o.pl);
  if (next) {
    selectLayer(next);
    setTool('area');
    setStatus(`Tatuagem ${numberOf(L)} encaixada. Agora pinte a área da tatuagem ${numberOf(next)}.`);
  }
}

areaGoBtn.addEventListener('click', () => {
  if (!locked) fitSelToArea();
});
areaUndoBtn.addEventListener('click', () => {
  areaStrokes.pop();
  repaintArea();
  classifyArea();
  syncAreaUI();
  drawOverlay();
});
areaClearBtn.addEventListener('click', () => {
  areaStrokes = [];
  repaintArea();
  classifyArea();
  syncAreaUI();
  drawOverlay();
});
areaTapBtn.addEventListener('click', () => {
  setTool(null);
  if (sel && !sel.pl) setStatus(`Toque na foto onde você quer a tatuagem ${numberOf(sel)}.`);
});
areaSizeIn.addEventListener('input', () => {
  syncAreaUI();
  scheduleOverlay();
});

// ---------- Ferramentas (barra de baixo) ----------
type Tool = 'area' | 'size' | 'rot' | 'ink' | 'sides' | 'adjust' | 'erase' | 'more';
/** Ferramentas que funcionam sem uma tatuagem posicionada. */
const freeTool = (t: Tool | null) => t === 'more' || t === 'area';
let tool: Tool | null = null;
const toolPanel = $('toolPanel');
const dock = $('dock');
const toolButtons = [...document.querySelectorAll<HTMLButtonElement>('#toolbar .tool')];
const panels = [...toolPanel.querySelectorAll<HTMLElement>('[data-panel]')];

/** Abre uma ferramenta (o painel dela aparece em cima da barra) ou fecha (null). */
function setTool(t: Tool | null) {
  if (locked || (t && !freeTool(t) && !placed(sel)) || (t === 'area' && !photo)) t = null;
  if (t === 'adjust' && !sel?.fitted?.ok) {
    setStatus('Essa tatuagem está fora da pele detectada. Arraste ela para cima da pele (ou use Mais > Reajustar ao corpo).');
    t = null;
  }
  const wasArea = tool === 'area';
  tool = t;
  if (wasArea && t !== 'area') {
    // Saiu da área sem encaixar: o que já foi pintado fica guardado (só some da tela).
    areaStroke = null;
    cursor = null;
    drawOverlay();
  }
  // Primeiro desliga o modo que estava ligado, depois liga o novo (cada um escreve a sua dica).
  if (t !== 'sides' && sideMode) setSideMode(false);
  if (t !== 'adjust' && adjustMode) setAdjustMode(false);
  if (t !== 'erase' && eraseMode) setEraseMode(false);
  if (t === 'sides' && !sideMode) setSideMode(true);
  if (t === 'adjust' && !adjustMode) setAdjustMode(true);
  if (t === 'erase' && !eraseMode) setEraseMode(true);
  syncToolUI();
  if (t === 'area' && !wasArea) {
    areaHint();
    drawOverlay();
  }
}

/** Deixa a barra e o painel de acordo com a ferramenta e com a tatuagem selecionada. */
function syncToolUI() {
  if ((tool === 'sides' && !sideMode) || (tool === 'adjust' && !adjustMode) || (tool === 'erase' && !eraseMode)) tool = null;
  if (locked || (tool && !freeTool(tool) && !placed(sel))) tool = null;
  for (const b of toolButtons) {
    b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
    b.disabled = locked || (!freeTool(b.dataset.tool as Tool) && !placed(sel));
  }
  syncAreaUI();
  toolPanel.hidden = !tool;
  for (const p of panels) p.hidden = p.dataset.panel !== tool;
  dock.dataset.tool = tool ?? '';
  dock.classList.toggle('no-layers', !layers.length);
  const noLayer = !placed(sel);
  for (const id of ['refit', 'decalBtn']) $<HTMLButtonElement>(id).disabled = noLayer || locked;
  for (const el of [curvIn, clipIn, flipIn]) el.disabled = noLayer || locked;
  addBtn.disabled = locked;
}

for (const b of toolButtons) {
  b.addEventListener('click', () => {
    const t = b.dataset.tool as Tool;
    setTool(tool === t ? null : t);
  });
}
for (const b of toolPanel.querySelectorAll<HTMLButtonElement>('[data-done]')) b.addEventListener('click', () => setTool(null));
for (const b of toolPanel.querySelectorAll<HTMLButtonElement>('[data-undo]')) b.addEventListener('click', () => undoBtn.click());
for (const b of toolPanel.querySelectorAll<HTMLButtonElement>('[data-save]')) b.addEventListener('click', () => $('save').click());

// ----- Adicionar tatuagem (menu do botão "+") -----
const addBtn = $<HTMLButtonElement>('addBtn');
const addMenu = $('addMenu');

function closeAddMenu() {
  addMenu.hidden = true;
  addBtn.setAttribute('aria-expanded', 'false');
}

addBtn.addEventListener('click', () => {
  const open = addMenu.hidden;
  addMenu.hidden = !open;
  addBtn.setAttribute('aria-expanded', String(open));
});
addMenu.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('label')) setTimeout(closeAddMenu, 0);
});
document.addEventListener('pointerdown', (e) => {
  if (!addMenu.hidden && !(e.target as HTMLElement).closest('.add-wrap, #addMenu, #areaGo')) closeAddMenu();
});

// ----- Trava: com a edição travada, tocar na foto não muda nada (só aproxima e afasta) -----
let locked = false;
const lockBtn = $('lock');

function setLocked(on: boolean) {
  if (on === locked) return;
  locked = on;
  if (on) {
    setTool(null);
    closeAddMenu();
    cancelGesture();
  }
  lockBtn.setAttribute('aria-pressed', String(on));
  const label = on ? 'Destravar a edição' : 'Travar a edição';
  lockBtn.setAttribute('aria-label', label);
  lockBtn.title = label;
  document.body.classList.toggle('locked', on);
  syncToolUI();
  updateHistoryButtons();
  if (on) setStatus('Edição travada: tocar na foto não muda nada (dois dedos aproximam). Toque no cadeado para editar de novo.');
  else if (photo) {
    if (placed(sel)) describe(sel);
    else hint();
  }
}
lockBtn.addEventListener('click', () => setLocked(!locked));

// ---------- Enquadramento: a foto encaixada na caixa e o zoom de dois dedos ----------
const view = { z: 1, x: 0, y: 0 };
let fitW = 0;
let fitH = 0;
const fitViewBtn = $('fitView');

/** Encaixa a foto na caixa (chamado quando a tela muda de tamanho). */
function fitStage() {
  if (!photo || stageBox.hidden) return;
  const bw = stageBox.clientWidth;
  const bh = stageBox.clientHeight;
  if (!bw || !bh) return;
  const s = Math.min(bw / photo.w, bh / photo.h);
  fitW = photo.w * s;
  fitH = photo.h * s;
  stageView.style.width = `${fitW}px`;
  stageView.style.height = `${fitH}px`;
  stageView.style.left = `${(bw - fitW) / 2}px`;
  stageView.style.top = `${(bh - fitH) / 2}px`;
  applyView();
}
new ResizeObserver(() => fitStage()).observe(stageBox);

function applyView() {
  const mx = Math.max(0, (fitW * view.z - stageBox.clientWidth) / 2);
  const my = Math.max(0, (fitH * view.z - stageBox.clientHeight) / 2);
  view.x = clamp(view.x, -mx, mx);
  view.y = clamp(view.y, -my, my);
  stageView.style.transform = view.z === 1 ? '' : `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
  fitViewBtn.hidden = view.z < 1.02;
  scheduleOverlay();
}

/** Zoom em torno de um ponto da tela (fica parado embaixo do dedo/cursor). */
function zoomAt(clientX: number, clientY: number, z: number, from = { ...view }) {
  const r = stageBox.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const nz = clamp(z, 1, 8);
  const k = nz / from.z;
  view.x = clientX - cx - k * (clientX - cx - from.x);
  view.y = clientY - cy - k * (clientY - cy - from.y);
  view.z = nz;
  if (nz === 1) view.x = view.y = 0;
  applyView();
}

function resetView() {
  view.z = 1;
  view.x = view.y = 0;
  applyView();
}
fitViewBtn.addEventListener('click', resetView);

// ---------- Gestos na foto ----------
// Regras para não estragar a edição sem querer:
// - só arrasta a tatuagem quem começa o toque EM CIMA dela; tocar fora não muda nada;
// - dois dedos em cima da tatuagem giram e mudam o tamanho; fora dela, aproximam a foto;
// - com a trava ligada, qualquer toque só move e aproxima a foto.
interface Pt {
  x: number;
  y: number;
  cx: number;
  cy: number;
}
const pointers = new Map<number, Pt>();
type Gesture =
  /** ox/oy: do dedo até o meio da tatuagem (na foto), para ela andar junto com o dedo. */
  | { k: 'tattoo' | 'place' | 'pan'; sx: number; sy: number; moved: boolean; ox?: number; oy?: number }
  | { k: 'pinchT'; dist: number; ang: number }
  | { k: 'pinchV'; d0: number; mx: number; my: number; from: { z: number; x: number; y: number } }
  | { k: 'mode' }
  | { k: 'done' };
let gesture: Gesture | null = null;

function toImage(e: { clientX: number; clientY: number }) {
  const r = stage.getBoundingClientRect();
  return { x: ((e.clientX - r.left) * stage.width) / r.width, y: ((e.clientY - r.top) * stage.height) / r.height };
}

function twoFinger() {
  const [a, b] = [...pointers.values()];
  return { dist: Math.hypot(b.x - a.x, b.y - a.y), ang: Math.atan2(b.y - a.y, b.x - a.x) };
}

const touch = () => {
  showFrameUntil = performance.now() + 1200;
  schedule(true);
};

/** Interrompe o que um dedo estava fazendo (ex.: entrou o segundo dedo, ou travou a edição). */
function cancelGesture() {
  if (areaStroke) {
    // Traço da área que virou gesto de dois dedos: sai da pintura.
    areaStroke = null;
    repaintArea();
    scheduleOverlay();
  }
  if (stroke) {
    // Traço da borracha que virou gesto de dois dedos: descarta o pedaço apagado.
    stroke = null;
    if (sel) rebuildErase(sel);
    schedule();
  }
  if (drag || sideDrag) {
    drag = null;
    sideDrag = null;
    commit();
    drawOverlay();
  }
  gesture = pointers.size ? { k: 'done' } : null;
}

stageBox.addEventListener('pointerdown', (e) => {
  if (!photo || (e.target as HTMLElement).closest('.fab, .fabs')) return;
  stageBox.setPointerCapture(e.pointerId);
  const p = toImage(e);
  pointers.set(e.pointerId, { ...p, cx: e.clientX, cy: e.clientY });
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const onTattoo =
      !locked &&
      !sideMode &&
      !adjustMode &&
      !eraseMode &&
      tool !== 'area' &&
      placed(sel) &&
      (gesture?.k === 'tattoo' || hitTest(mid.x, mid.y, 30) === sel);
    // Estava arrastando a tatuagem com um dedo: o lugar onde ela está vale antes do gesto novo.
    if (gesture?.k === 'tattoo' && gesture.moved && placed(sel)) settleMoved(sel);
    cancelGesture();
    if (onTattoo) {
      gesture = { k: 'pinchT', ...twoFinger() };
    } else {
      gesture = {
        k: 'pinchV',
        d0: Math.max(1, Math.hypot(b.cx - a.cx, b.cy - a.cy)),
        mx: (a.cx + b.cx) / 2,
        my: (a.cy + b.cy) / 2,
        from: { ...view },
      };
    }
    return;
  }
  if (pointers.size > 2) return;

  const startPan = (): Gesture => ({ k: 'pan', sx: e.clientX, sy: e.clientY, moved: false });
  if (locked) {
    gesture = startPan();
    return;
  }
  if (tool === 'area') {
    // Pincel da área: pinta (dois dedos aproximam a foto).
    areaStroke = { r: areaBrush(), pts: [[p.x, p.y]] };
    paintStroke(areaStroke);
    cursor = p;
    scheduleOverlay();
    gesture = { k: 'mode' };
    return;
  }
  if (eraseMode) {
    if (placed(sel) && photo) {
      stroke = { r: brushRadius(), pts: [[p.x, p.y]] };
      sel.erase ??= new Uint8Array(photo.w * photo.h);
      stamp(sel.erase, p.x, p.y, stroke.r);
      schedule(true);
      gesture = { k: 'mode' };
    }
    return;
  }
  if (sideMode || adjustMode) {
    // Só as bolinhas respondem (a mais perto do dedo); fora delas, o dedo move a foto.
    let best: SideHandle | AdjustHandle | null = null;
    let bd = handleRadius() * HANDLE_HIT;
    if (placed(sel)) {
      for (const hd of sideMode ? sideHandles(sel) : adjustHandles(sel)) {
        const d = Math.hypot(p.x - hd.x, p.y - hd.y);
        if (d < bd) {
          bd = d;
          best = hd;
        }
      }
    }
    if (best && sideMode && placed(sel)) sideDrag = { side: (best as SideHandle).side, start: { ...sel.pl } };
    else if (best && adjustMode) drag = best as AdjustHandle;
    gesture = best ? { k: 'mode' } : startPan();
    return;
  }
  if (sel && !sel.pl) {
    // Tatuagem ainda sem lugar: o toque escolhe onde ela fica.
    gesture = { k: 'place', sx: e.clientX, sy: e.clientY, moved: false };
    return;
  }
  const hit = hitTest(p.x, p.y);
  if (hit) {
    // Encostou numa tatuagem: ela passa a ser a editada (e é a que vai ser arrastada).
    if (hit !== sel) {
      selectLayer(hit);
      describe(hit);
    }
    const pl = hit.pl!;
    gesture = { k: 'tattoo', sx: e.clientX, sy: e.clientY, moved: false, ox: pl.px - p.x, oy: pl.py - p.y };
  } else gesture = startPan();
});

stageBox.addEventListener('pointermove', (e) => {
  const prev = pointers.get(e.pointerId);
  if (!prev) return;
  const p = toImage(e);
  pointers.set(e.pointerId, { ...p, cx: e.clientX, cy: e.clientY });
  const g = gesture;
  if (!g) return;
  if (g.k === 'pinchV') {
    if (pointers.size < 2) return;
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(b.cx - a.cx, b.cy - a.cy);
    // Zoom em volta do ponto entre os dedos que estava embaixo deles no começo + arrasto.
    const mx = (a.cx + b.cx) / 2;
    const my = (a.cy + b.cy) / 2;
    zoomAt(g.mx, g.my, (g.from.z * d) / g.d0, g.from);
    view.x += mx - g.mx;
    view.y += my - g.my;
    applyView();
    return;
  }
  if (g.k === 'pinchT') {
    if (pointers.size < 2 || !placed(sel)) return;
    const t = twoFinger();
    const pl = sel.pl;
    pl.height = clamp((pl.height * t.dist) / Math.max(1, g.dist), sel.baseHeight * SIZE_MIN, sel.baseHeight * SIZE_MAX);
    let d = t.ang - g.ang;
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    pl.rot -= d;
    g.dist = t.dist;
    g.ang = t.ang;
    syncControls();
    touch();
    return;
  }
  if (g.k === 'mode') {
    if (drag && placed(sel)) {
      dragHandle(sel, drag, p.x - prev.x, p.y - prev.y);
      schedule(true);
    } else if (sideDrag && placed(sel)) {
      dragSide(sel, p.x, p.y);
      syncControls();
      schedule(true);
    } else if (areaStroke) {
      areaStroke.pts.push([p.x, p.y]);
      paintStroke(areaStroke, areaStroke.pts.length - 1);
      cursor = p;
      scheduleOverlay();
    } else if (stroke && sel?.erase) {
      const last = stroke.pts[stroke.pts.length - 1];
      stroke.pts.push([p.x, p.y]);
      stampSegment(sel.erase, last, [p.x, p.y], stroke.r);
      cursor = p;
      schedule(true);
    }
    return;
  }
  if (g.k === 'done' || pointers.size !== 1) return;
  if (!g.moved && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) > 8) g.moved = true;
  if (!g.moved) return;
  if (g.k === 'tattoo' && placed(sel) && photo) {
    // O meio da tatuagem fica embaixo do mesmo ponto do dedo, sem sair da foto (fora dela não
    // daria mais para pegar a tatuagem de volta).
    sel.pl.px = clamp(p.x + (g.ox ?? 0), 0, photo.w - 1);
    sel.pl.py = clamp(p.y + (g.oy ?? 0), 0, photo.h - 1);
    followLimb(sel);
    touch();
  } else if (g.k === 'pan' || g.k === 'place') {
    // Arrastar fora da tatuagem (ou antes de posicioná-la) só move a foto aproximada.
    view.x += e.clientX - prev.cx;
    view.y += e.clientY - prev.cy;
    applyView();
  }
});

function endPointer(e: PointerEvent) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  const g = gesture;
  if (g?.k === 'pinchT' && pointers.size < 2) {
    // Depois de mudar o tamanho com dois dedos, avisa se a tatuagem passou da ponta do membro.
    if (placed(sel)) describe(sel);
    schedule();
    commit();
    gesture = pointers.size ? { k: 'done' } : null;
    return;
  }
  if (g?.k === 'pinchV' && pointers.size < 2) {
    gesture = pointers.size ? { k: 'done' } : null;
    return;
  }
  if (pointers.size > 0) return;
  gesture = null;
  if (drag || sideDrag) {
    // Terminou de puxar uma bolinha (contorno ou lados): vira um passo (se mudou algo).
    drag = null;
    sideDrag = null;
    schedule();
    commit();
    return;
  }
  if (stroke) {
    if (stroke.pts.length) sel?.strokes.push(stroke);
    stroke = null;
    schedule();
    commit();
    return;
  }
  if (areaStroke) {
    const st = areaStroke;
    areaStrokes.push(st);
    areaStroke = null;
    classifyArea();
    syncAreaUI();
    drawOverlay();
    areaHint();
    return;
  }
  if (!g || !photo || (g.k !== 'tattoo' && g.k !== 'place' && g.k !== 'pan')) return;
  if (g.k === 'tattoo') {
    if (g.moved && placed(sel)) {
      settleMoved(sel);
      commit();
    } else touch();
    return;
  }
  if (g.moved || e.type !== 'pointerup') return;
  if (g.k === 'place' && sel && !sel.pl) {
    const p = toImage(e);
    fitLayer(sel, p.x, p.y, false);
    commit();
    return;
  }
  // Toque fora da tatuagem: não muda nada, só explica.
  if (locked) setStatus('Edição travada. Toque no cadeado (no canto da foto) para editar de novo.');
  else if (!sel) setStatus('Adicione uma tatuagem primeiro: botão "+ Tatuagem".');
  else if (placed(sel) && !sideMode && !adjustMode)
    setStatus('Para mover a tatuagem, arraste ela com o dedo. Dois dedos fora dela aproximam a foto.');
}
stageBox.addEventListener('pointerup', endPointer);
stageBox.addEventListener('pointercancel', endPointer);

/** A roda do mouse dispara muitos eventos: o passo é guardado quando ela para. */
let wheelTimer = 0;
stageBox.addEventListener(
  'wheel',
  (e) => {
    if (!photo) return;
    e.preventDefault();
    const p = toImage(e);
    // Em cima da tatuagem: tamanho (Shift: giro). Fora dela (ou travado): zoom da foto.
    const onTattoo = !locked && !sideMode && !adjustMode && !eraseMode && tool !== 'area' && placed(sel) && hitTest(p.x, p.y, 0) === sel;
    if (!onTattoo || !placed(sel)) {
      zoomAt(e.clientX, e.clientY, view.z * Math.exp(-e.deltaY * 0.0015));
      return;
    }
    const pl = sel.pl;
    if (e.shiftKey) pl.rot -= e.deltaY * 0.003;
    else pl.height = clamp(pl.height * Math.exp(-e.deltaY * 0.0015), sel.baseHeight * SIZE_MIN, sel.baseHeight * SIZE_MAX);
    syncControls();
    touch();
    clearTimeout(wheelTimer);
    wheelTimer = window.setTimeout(() => commit(), 400);
  },
  { passive: false },
);

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || document.querySelector('dialog[open]')) return;
  if (!addMenu.hidden) closeAddMenu();
  else if (tool) setTool(null);
});

// ---------- Desenho ----------
// A foto com as outras tatuagens fica guardada (baseCache); a selecionada é redesenhada por
// cima, e só no retângulo onde ela estava e onde está agora (selBox). Enquanto o dedo arrasta,
// a prévia usa blocos de 2×2 pixels; parou, sai a versão completa.
const DRAFT_STEP = 2;
let scheduled = false;
let wantFull = false;
let fullTimer = 0;
/** Retângulo onde a tatuagem selecionada foi desenhada por cima da base em `out`. */
let selBox: Box | null = null;

function schedule(draft = false) {
  if (draft) {
    clearTimeout(fullTimer);
    fullTimer = window.setTimeout(() => schedule(false), 160);
  } else wantFull = true;
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    const full = wantFull;
    wantFull = false;
    draw(full ? 1 : DRAFT_STEP);
  });
}

let overlayScheduled = false;
function scheduleOverlay() {
  if (overlayScheduled) return;
  overlayScheduled = true;
  requestAnimationFrame(() => {
    overlayScheduled = false;
    drawOverlay();
  });
}

const union = (a: Box | null, b: Box | null): Box | null =>
  !a ? b : !b ? a : [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];

/** Volta a base (foto + outras tatuagens) para dentro do retângulo. */
function restoreBase(b: Box) {
  if (!photo || !out || !baseCache) return;
  const W = photo.w;
  for (let y = b[1]; y <= b[3]; y++) {
    const s = (y * W + b[0]) * 4;
    out.data.set(baseCache.subarray(s, (y * W + b[2] + 1) * 4), s);
  }
}

let frameTimer = 0;

function draw(step = 1) {
  if (!photo || !out) return;
  if (step === 1) clearTimeout(fullTimer);
  for (const L of layers) L.outline = placed(L) ? outline(L.frame, L.tex, L.pl) : null;
  const all: Box = [0, 0, photo.w - 1, photo.h - 1];
  let dirty: Box | null;
  if (comparing) {
    out.data.set(photo.rgba);
    dirty = all;
    selBox = all; // na volta, a base inteira é restaurada
  } else {
    if (!baseCache) {
      out.data.set(photo.rgba);
      for (const L of layers) {
        if (L !== sel && placed(L)) render(out, photo.highlight, L.mask, L.frame, L.tex, L.pl, L.erase);
      }
      baseCache = out.data.slice();
      dirty = all;
    } else {
      dirty = selBox;
      if (selBox) restoreBase(selBox);
    }
    const nb = placed(sel) ? render(out, photo.highlight, sel.mask, sel.frame, sel.tex, sel.pl, sel.erase, step) : null;
    dirty = union(dirty, nb);
    selBox = nb;
  }
  if (dirty) ctx.putImageData(out, 0, 0, dirty[0], dirty[1], dirty[2] - dirty[0] + 1, dirty[3] - dirty[1] + 1);
  drawOverlay();
  const remaining = showFrameUntil - performance.now();
  if (remaining > 0) {
    clearTimeout(frameTimer);
    frameTimer = window.setTimeout(drawOverlay, remaining + 20);
  }
}

let maskTint: ImageData | null = null;

function drawOverlay() {
  octx.clearRect(0, 0, overlay.width, overlay.height);
  if (!photo || comparing) return;
  // Linhas com a mesma grossura na tela, com ou sem zoom.
  const lw = Math.max(2, Math.min(photo.w, photo.h) / 350) / view.z;

  if (tool === 'area' && (areaStrokes.length || areaStroke)) {
    // A pintura ganha a cor de cada ponto: azul no corpo, vermelho listrado fora dele.
    const tint = areaTintCanvas();
    octx.save();
    octx.drawImage(areaCanvas, 0, 0);
    octx.globalCompositeOperation = 'source-in';
    octx.globalAlpha = 0.5;
    octx.imageSmoothingEnabled = false;
    if (tint) octx.drawImage(tint, 0, 0, photo.w, photo.h);
    octx.restore();
  }

  if (debugIn.checked && placed(sel)) {
    const { mask, frame } = sel;
    if (mask) {
      if (!maskTint) {
        maskTint = new ImageData(photo.w, photo.h);
        const d = maskTint.data;
        for (let i = 0; i < mask.length; i++) {
          d[i * 4] = 40;
          d[i * 4 + 1] = 200;
          d[i * 4 + 2] = 255;
          d[i * 4 + 3] = mask[i] * 80;
        }
      }
      octx.putImageData(maskTint, 0, 0);
    }
    if (photo.pose) {
      // Esqueleto: ombros, braços, quadril e pernas.
      const P = photo.pose;
      const bones = [
        [11, 12], [11, 13], [13, 15], [15, 19], [12, 14], [14, 16], [16, 20],
        [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28],
      ];
      octx.strokeStyle = 'rgba(255, 209, 102, 0.7)';
      octx.lineWidth = lw * 0.8;
      for (const [a, b] of bones) {
        if (!P[a] || !P[b] || P[a].v < 0.4 || P[b].v < 0.4) continue;
        octx.beginPath();
        octx.moveTo(P[a].x, P[a].y);
        octx.lineTo(P[b].x, P[b].y);
        octx.stroke();
      }
      octx.fillStyle = '#ffd166';
      for (const p of photo.pose) {
        if (p.v < 0.4) continue;
        octx.beginPath();
        octx.arc(p.x, p.y, lw * 1.6, 0, Math.PI * 2);
        octx.fill();
      }
    }
    if (frame.ok) {
      // Eixo do membro (vermelho) e contorno medido ao longo dele (verde).
      const L = Math.max(frame.width * 1.5, sel.pl.height);
      octx.lineWidth = lw;
      octx.strokeStyle = '#ff5d73';
      octx.beginPath();
      octx.moveTo(frame.cx - frame.ux * L, frame.cy - frame.uy * L);
      octx.lineTo(frame.cx + frame.ux * L, frame.cy + frame.uy * L);
      octx.stroke();
      octx.strokeStyle = '#7cf29c';
      for (const sgn of [-1, 1]) {
        octx.beginPath();
        for (let t = -L; t <= L; t += L / 40) {
          const [o, r] = profileAt(frame, t);
          const s = o + sgn * r;
          const x = frame.cx + frame.vx * s + frame.ux * t;
          const y = frame.cy + frame.vy * s + frame.uy * t;
          if (t === -L) octx.moveTo(x, y);
          else octx.lineTo(x, y);
        }
        octx.stroke();
      }
    }
  }

  if ((eraseMode || tool === 'area') && cursor) {
    octx.beginPath();
    octx.arc(cursor.x, cursor.y, tool === 'area' ? areaBrush() : brushRadius(), 0, Math.PI * 2);
    octx.lineWidth = lw * 0.8;
    octx.strokeStyle = 'rgba(255,255,255,0.9)';
    octx.stroke();
    octx.strokeStyle = 'rgba(0,0,0,0.6)';
    octx.setLineDash([lw * 2, lw * 2]);
    octx.stroke();
    octx.setLineDash([]);
  }

  if (adjustMode && placed(sel) && sel.frame.ok) {
    const f = sel.frame;
    const ends = f.profile?.ends;
    // Contorno do membro: entre as pontas (com o arredondamento) ou em volta da tatuagem.
    const [sLo, t0, sHi] = axisSpan(sel);
    const ext = Math.max(sel.pl.height, 2.5 * f.R);
    const tA = ends ? ends[0] : Math.min(sLo, t0 - ext);
    const tB = ends ? ends[1] : Math.max(sHi, t0 + ext);
    const pt = (t: number, s: number): [number, number] => [f.cx + f.vx * s + f.ux * t, f.cy + f.vy * s + f.uy * t];
    octx.lineWidth = lw * 1.3;
    octx.strokeStyle = '#e8b45f';
    octx.beginPath();
    const N = 160;
    for (let k = 0; k <= N; k++) {
      const t = tA + ((tB - tA) * k) / N;
      const [o, r] = profileAt(f, t);
      const [x, y] = pt(t, o + r);
      if (k) octx.lineTo(x, y);
      else octx.moveTo(x, y);
    }
    for (let k = N; k >= 0; k--) {
      const t = tA + ((tB - tA) * k) / N;
      const [o, r] = profileAt(f, t);
      const [x, y] = pt(t, o - r);
      octx.lineTo(x, y);
    }
    if (ends) octx.closePath();
    octx.stroke();

    const hr = handleRadius();
    for (const hd of adjustHandles(sel)) {
      const tip = hd.kind === 'tip';
      const active =
        drag?.kind === 'tip'
          ? hd.kind === 'tip' && hd.end === drag.end
          : drag?.kind === 'edge' && hd.kind === 'edge' && hd.side === drag.side && Math.abs(hd.t - drag.t) < 1;
      const r = hr * (active ? 1.3 : tip ? 1.15 : 1);
      octx.beginPath();
      octx.arc(hd.x, hd.y, r, 0, Math.PI * 2);
      if (active) {
        // Bolinha sendo arrastada: halo dourado em volta.
        octx.beginPath();
        octx.arc(hd.x, hd.y, r * 1.9, 0, Math.PI * 2);
        octx.fillStyle = 'rgba(232, 180, 95, 0.35)';
        octx.fill();
        octx.beginPath();
        octx.arc(hd.x, hd.y, r, 0, Math.PI * 2);
      }
      octx.fillStyle = tip ? '#e8b45f' : '#ffffff';
      octx.fill();
      octx.lineWidth = r * 0.3;
      octx.strokeStyle = tip ? '#3a2606' : '#e8b45f';
      octx.stroke();
      if (tip) {
        // Setinha ao longo do membro: a ponta anda para frente e para trás.
        const a = r * 0.6;
        octx.beginPath();
        for (const sg of [1, -1]) {
          const [x1, y1] = [hd.x + f.ux * a * sg, hd.y + f.uy * a * sg];
          octx.moveTo(hd.x - f.ux * a * sg, hd.y - f.uy * a * sg);
          octx.lineTo(x1, y1);
          octx.moveTo(x1, y1);
          octx.lineTo(x1 - f.ux * a * 0.5 * sg + f.vx * a * 0.5, y1 - f.uy * a * 0.5 * sg + f.vy * a * 0.5);
          octx.moveTo(x1, y1);
          octx.lineTo(x1 - f.ux * a * 0.5 * sg - f.vx * a * 0.5, y1 - f.uy * a * 0.5 * sg - f.vy * a * 0.5);
        }
        octx.stroke();
      }
    }
  }

  // Fora da pele a tatuagem quase não aparece: o contorno fica à vista para achar e arrastar.
  const offSkin = placed(sel) && !sel.frame.ok;
  if (sel?.outline && (sideMode || offSkin || debugIn.checked || showFrameUntil > performance.now())) {
    octx.lineWidth = lw * (sideMode ? 1 : 0.7);
    octx.strokeStyle = sideMode ? 'rgba(255,255,255,0.95)' : 'rgba(232, 180, 95, 0.95)';
    octx.setLineDash([lw * 3, lw * 2.2]);
    octx.beginPath();
    sel.outline.forEach(([x, y], i) => (i ? octx.lineTo(x, y) : octx.moveTo(x, y)));
    octx.closePath();
    octx.stroke();
    octx.setLineDash([]);
  }

  if (sideMode && placed(sel)) {
    // Alças nos lados: um tracinho branco ao longo do lado, com borda escura.
    const hr = handleRadius();
    for (const hd of sideHandles(sel)) {
      const active = sideDrag?.side === hd.side;
      const r = hr * (active ? 1.3 : 1);
      octx.beginPath();
      octx.arc(hd.x, hd.y, r, 0, Math.PI * 2);
      octx.fillStyle = active ? '#e8b45f' : '#ffffff';
      octx.fill();
      octx.lineWidth = r * 0.3;
      octx.strokeStyle = active ? '#3a2606' : '#e8b45f';
      octx.stroke();
    }
  }
}

updateOutputs();

// ?debug na URL expõe o estado no console (para diagnosticar fotos problemáticas).
if (new URLSearchParams(location.search).has('debug')) {
  Object.assign(window, {
    __ink: {
      get photo() {
        return photo;
      },
      get layers() {
        return layers;
      },
      handles() {
        return sel ? adjustHandles(sel) : [];
      },
      sides() {
        return sel ? sideHandles(sel) : [];
      },
      /** Mede o desenho: passo 1 = completo, 2 = prévia; full = como era antes (foto inteira). */
      bench(step: number, full: boolean) {
        // Como era antes: a foto inteira copiada e enviada para a tela a cada quadro.
        if (full && photo) selBox = [0, 0, photo.w - 1, photo.h - 1];
        const t = performance.now();
        draw(step);
        return performance.now() - t;
      },
    },
  });
}
