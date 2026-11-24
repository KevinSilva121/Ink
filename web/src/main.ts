import './style.css';
import { analyze, loadModels, type Landmark } from './vision';
import { colorSkinMask, computeHighlight } from './photo';
import { buildTexture, prepareDesign, type Design, type Look, type Tex } from './design';
import {
  cloneEdits,
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
import { imageToLocal, localToImage, outline, render, type Placement } from './render';
import { openExtractor } from './extractor';
import { openDecal } from './decal';
import { clamp, loadToCanvas, smoothstep } from './util';
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

const stage = $<HTMLCanvasElement>('stage');
const overlay = $<HTMLCanvasElement>('overlay');
const ctx = stage.getContext('2d')!;
const octx = overlay.getContext('2d')!;
const statusEl = $('status');
const controls = $('controls');
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
const setStatus = (msg: string) => (statusEl.textContent = msg);
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
  setStatus('Analisando o corpo na foto…');
  await nextPaint();
  const res = analyze(photo.canvas);
  photo.skinModel = res.skin;
  photo.pose = res.pose;
  photo.analyzed = true;
  for (const L of layers) if (placed(L)) fitLayer(L, L.pl.px, L.pl.py, true, false);
  invalidateBase();
  draw();
  hint();
  // Reajuste automático (a detecção terminou): não é uma edição da pessoa.
  commit(true);
}

function hint() {
  if (!photo) {
    setStatus(modelsReady || modelsFailed ? 'Escolha uma foto do corpo para começar.' : 'Preparando a detecção do corpo…');
  } else if (!layers.length) {
    setStatus('Agora adicione a tatuagem (passo 2).');
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
  $('stageBox').hidden = false;
  $('empty').hidden = true;
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
  hint();
  commit();
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
  $('historyBar').hidden = !photo;
  undoBtn.disabled = historyAt <= 0;
  redoBtn.disabled = historyAt >= history.length - 1;
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
  if (historyAt <= 0) return;
  historyAt--;
  restore(history[historyAt]);
  updateHistoryButtons();
  scheduleSave();
  setStatus('Voltei uma edição. Use "Avançar" para refazer.');
}

function redo() {
  if (historyAt >= history.length - 1) return;
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

const defaultName = () =>
  `Projeto de ${new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} às ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;

const canvasBlob = (c: HTMLCanvasElement, type: string, q?: number) =>
  new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('toBlob'))), type, q));

/** Máscara de pele (0..1) ↔ imagem PNG em tons de cinza (sem perda, 8 bits). */
function maskToCanvas(m: Float32Array, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const img = new ImageData(w, h);
  for (let i = 0; i < m.length; i++) {
    const v = Math.round(clamp(m[i], 0, 1) * 255);
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  c.getContext('2d')!.putImageData(img, 0, 0);
  return c;
}

async function blobToMask(b: Blob, w: number, h: number): Promise<Float32Array> {
  const c = await loadToCanvas(b, Math.max(w, h));
  const d = c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h).data;
  const m = new Float32Array(w * h);
  for (let i = 0; i < m.length; i++) m[i] = d[i * 4] / 255;
  return m;
}

function scheduleSave() {
  if (!photo || loadingProject) return;
  clearTimeout(saveTimer);
  saveStateEl.textContent = 'Salvando…';
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
    if (!P.saved.has(P.photoKey)) {
      await putBlob(P.photoKey, await canvasBlob(ph.canvas, 'image/png'));
      P.saved.add(P.photoKey);
    }
    if (ph.skinModel && !P.skinKey) {
      const key = `${P.id}-pele`;
      await putBlob(key, await canvasBlob(maskToCanvas(ph.skinModel, ph.w, ph.h), 'image/png'));
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
    saveStateEl.textContent = 'Salvo no aparelho';
  } catch (err) {
    console.error(err);
    saveStateEl.textContent = 'Não consegui salvar';
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
  $('stageBox').hidden = true;
  $('empty').hidden = false;
  saveStateEl.textContent = '';
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
        if (s.maskSource === 'modelo' && ph.skinModel) L.mask = ph.skinModel;
        else if (L.fitPoint) L.mask = colorSkinMask(ph.rgba, ph.w, ph.h, L.fitPoint[0], L.fitPoint[1]);
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
    saveStateEl.textContent = 'Salvo no aparelho';
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
      when.textContent = `${n} tatuage${n === 1 ? 'm' : 'ns'} · editado em ${new Date(p.updated).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}${project?.id === p.id ? ' · aberto agora' : ''}`;
      info.append(name, when);
      const acts = document.createElement('div');
      acts.className = 'proj-acts';
      const mk = (label: string, cls: string, fn: () => void) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = cls;
        b.textContent = label;
        b.addEventListener('click', fn);
        return b;
      };
      acts.append(
        mk('Abrir', 'btn', () => {
          projDlg.close();
          void openProject(p.id).catch((err) => {
            console.error(err);
            setStatus('Não consegui abrir esse projeto.');
          });
        }),
        mk(isNative ? 'Salvar arquivo' : 'Baixar arquivo', 'btn ghost', () => void exportProject(p.id)),
        mk('Excluir', 'btn ghost', async () => {
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
  $('dPdf').textContent = 'Salvar PDF (tamanho real)';
}

// Botão "voltar" do Android: fecha a tela aberta ou o modo de edição, nessa ordem.
onBackButton(() => {
  const open = document.querySelector<HTMLDialogElement>('dialog[open]');
  if (open) {
    open.close();
    return true;
  }
  if (adjustMode || eraseMode || sideMode) {
    setAdjustMode(false);
    setEraseMode(false);
    setSideMode(false);
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
      li.className = 'chip';
      const main = document.createElement('button');
      main.type = 'button';
      main.className = 'chip-main';
      main.setAttribute('aria-pressed', String(L === sel));
      main.append(makeThumb(L.tex, 96));
      const label = document.createElement('span');
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
      del.textContent = '×';
      del.setAttribute('aria-label', `Remover tatuagem ${i + 1}`);
      del.addEventListener('click', () => removeLayer(L));
      li.append(main, del);
      return li;
    }),
  );
  $('designNote').textContent = sel ? sel.design.note : '';
  controls.hidden = !placed(sel);
  if (placed(sel)) {
    $('editing').textContent = layers.length > 1 ? `Editando a tatuagem ${numberOf(sel)}` : 'Ajustes';
    syncControls();
  }
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
  }
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
    setStatus('Não achei pele nesse ponto, então apliquei sem curvatura. Toque em cima da pele para ajustar ao corpo.');
    return;
  }
  const parts = [`Ajustado ao corpo${f.part ? ` (${f.part})` : ''}.`];
  if (L.maskSource === 'cor') parts.push('Pele detectada pela cor.');
  if (f.hitBorder) parts.push('O membro sai da foto, então a curvatura foi estimada.');
  const cut = cutAt(L);
  if (cut) {
    parts.push(
      `A tatuagem passa ${ofJoint(cut)} e é cortada ali. Para ela caber antes, use "Ajustar lados" e puxe só esse lado para dentro; para levar além, "Ajustar contorno" e a bolinha amarela.`,
    );
  }
  parts.push(
    layers.length > 1
      ? 'Arraste para mover; dois dedos giram e mudam o tamanho; toque numa tatuagem para editá-la.'
      : 'Arraste para mover; dois dedos giram e mudam o tamanho; tocar em outro ponto reposiciona.',
  );
  setStatus(parts.join(' '));
}

const ofJoint = (j: string) => (j.endsWith('s') ? `dos ${j}` : `do ${j}`);

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

function hitTest(x: number, y: number): Layer | null {
  for (let k = layers.length - 1; k >= 0; k--) {
    const L = layers[k];
    if (L.outline && insidePolygon(x, y, L.outline)) return L;
  }
  return null;
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
  if (placed(sel)) fn(sel.pl, sel);
  updateOutputs();
  schedule();
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
/** Bolinha de ajuste: na borda (verde, move a borda naquele trecho) ou na ponta do membro (amarela). */
type AdjustHandle =
  | { kind: 'edge'; side: 'a' | 'b'; t: number; x: number; y: number }
  | { kind: 'tip'; end: 0 | 1; t: number; x: number; y: number };

let adjustMode = false;
let drag: AdjustHandle | null = null;
const adjustBtn = $('adjust');

function setAdjustMode(on: boolean) {
  adjustMode = on && placed(sel) && !!sel.fitted?.ok;
  if (adjustMode && eraseMode) setEraseMode(false);
  if (adjustMode && sideMode) setSideMode(false);
  adjustBtn.setAttribute('aria-pressed', String(adjustMode));
  adjustBtn.textContent = adjustMode ? 'Pronto' : 'Ajustar contorno';
  if (adjustMode && placed(sel)) {
    const joints = sel.frame.profile?.ends ? sel.frame.profile.joints : null;
    const msg = ['Verdes: arraste até a borda real da pele; cada bolinha acerta o seu trecho.'];
    if (joints) {
      msg.push(
        `Amarelas: onde o membro termina (${joints[0]} e ${joints[1]}). Arraste para a tatuagem ir além ou parar antes.`,
      );
    }
    msg.push('Toque em "Pronto" quando terminar.');
    setStatus(msg.join(' '));
  } else if (placed(sel)) describe(sel);
  drawOverlay();
}

adjustBtn.addEventListener('click', () => {
  if (!placed(sel)) return;
  if (!sel.fitted?.ok) {
    setStatus('Essa tatuagem está fora da pele detectada. Toque em cima da pele para ajustar ao corpo primeiro.');
    return;
  }
  setAdjustMode(!adjustMode);
});

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
    if (h.side === 'a') k.a += d;
    else k.b += d;
  } else {
    h.t += dx * f.ux + dy * f.uy;
    // As duas pontas não podem se cruzar: sobra pelo menos um raio de membro entre elas.
    const ends = L.frame.profile?.ends;
    if (!ends) return;
    const minLen = 2 * L.frame.R;
    if (h.end === 1) e.tipHi = Math.max(h.t, ends[0] + minLen);
    else e.tipLo = Math.min(h.t, ends[1] - minLen);
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
const sidesBtn = $('sides');

function setSideMode(on: boolean) {
  sideMode = on && placed(sel);
  if (sideMode && adjustMode) setAdjustMode(false);
  if (sideMode && eraseMode) setEraseMode(false);
  sidesBtn.setAttribute('aria-pressed', String(sideMode));
  sidesBtn.textContent = sideMode ? 'Pronto' : 'Ajustar lados';
  if (sideMode) {
    setStatus(
      'Puxe a bolinha de um lado para encolher ou esticar só aquele lado; o lado oposto fica parado. Ex.: puxe para dentro o lado que passa do punho. Toque em "Pronto" quando terminar.',
    );
  } else if (placed(sel)) describe(sel);
  drawOverlay();
}

sidesBtn.addEventListener('click', () => setSideMode(!sideMode));

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
  const minH = 0.05 * L.baseHeight;
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
      const right = Math.max(lx, -hw + minH);
      width = right + hw;
      cx = (right - hw) / 2;
      break;
    }
    case 'left': {
      const left = Math.min(lx, hw - minH);
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
const eraseBtn = $('erase');

function setEraseMode(on: boolean) {
  eraseMode = on && placed(sel);
  if (eraseMode && adjustMode) setAdjustMode(false);
  if (eraseMode && sideMode) setSideMode(false);
  eraseBtn.setAttribute('aria-pressed', String(eraseMode));
  eraseBtn.textContent = eraseMode ? 'Pronto' : 'Borracha';
  if (eraseMode) {
    setStatus(
      'Passe o dedo onde a tatuagem não deve aparecer (dedos ou punho por cima, roupa, relógio, cabelo). Toque em "Pronto" quando terminar.',
    );
  } else {
    cursor = null;
    if (placed(sel)) describe(sel);
  }
  drawOverlay();
}

eraseBtn.addEventListener('click', () => setEraseMode(!eraseMode));

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

stage.addEventListener('pointermove', (e) => {
  if (!eraseMode) return;
  cursor = toImage(e);
  if (!stroke) drawOverlay();
});
stage.addEventListener('pointerleave', () => {
  cursor = null;
  if (eraseMode) drawOverlay();
});

$('decalBtn').addEventListener('click', () => {
  if (!placed(sel) || !sel.outline) return;
  setAdjustMode(false);
  setEraseMode(false);
  setSideMode(false);
  // A foto como está na tela (com todas as tatuagens), para marcar os pontos de medida.
  comparing = false;
  draw();
  openDecal({ view: stage, frame: sel.frame, tex: sel.tex, design: sel.design, pl: { ...sel.pl }, outline: sel.outline });
});

$('refit').addEventListener('click', () => {
  if (!placed(sel)) return;
  fitLayer(sel, sel.pl.px, sel.pl.py, false);
  setAdjustMode(false);
  setSideMode(false);
  commit();
});

$('save').addEventListener('click', async () => {
  if (!photo) return;
  try {
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
  b.addEventListener('click', () => void addDesigns([import.meta.env.BASE_URL + b.dataset.example]).catch(showError)),
);
// Colar imagem copiada (ex.: botão direito > copiar imagem no Pinterest, depois Ctrl+V).
document.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files ?? [])].filter((x) => x.type.startsWith('image/'));
  if (files.length) void addDesigns(files).catch(showError);
});

function showError(err: unknown) {
  console.error(err);
  setStatus('Não consegui abrir essa imagem. Tente outra (JPG ou PNG).');
}

// ---------- Gestos na foto ----------
const pointers = new Map<number, { x: number; y: number }>();
let tap: { sx: number; sy: number; moved: boolean } | null = null;
let pinch: { dist: number; ang: number } | null = null;

function toImage(e: PointerEvent) {
  const r = stage.getBoundingClientRect();
  return { x: ((e.clientX - r.left) * stage.width) / r.width, y: ((e.clientY - r.top) * stage.height) / r.height };
}

function twoFinger() {
  const [a, b] = [...pointers.values()];
  return { dist: Math.hypot(b.x - a.x, b.y - a.y), ang: Math.atan2(b.y - a.y, b.x - a.x) };
}

const touch = () => {
  showFrameUntil = performance.now() + 1200;
  schedule();
};

stage.addEventListener('pointerdown', (e) => {
  stage.setPointerCapture(e.pointerId);
  const p = toImage(e);
  pointers.set(e.pointerId, p);
  if (eraseMode) {
    tap = null;
    if (placed(sel) && photo && pointers.size === 1) {
      stroke = { r: brushRadius(), pts: [[p.x, p.y]] };
      sel.erase ??= new Uint8Array(photo.w * photo.h);
      stamp(sel.erase, p.x, p.y, stroke.r);
      schedule();
    }
    return;
  }
  if (sideMode) {
    // No modo de lados, só as alças respondem (a mais perto do dedo).
    tap = null;
    if (placed(sel) && pointers.size === 1) {
      let best: SideHandle | null = null;
      let bd = handleRadius() * HANDLE_HIT;
      for (const hd of sideHandles(sel)) {
        const d = Math.hypot(p.x - hd.x, p.y - hd.y);
        if (d < bd) {
          bd = d;
          best = hd;
        }
      }
      if (best) sideDrag = { side: best.side, start: { ...sel.pl } };
    }
    return;
  }
  if (adjustMode) {
    // No modo de contorno, só as bolinhas respondem (a mais perto do dedo).
    tap = null;
    if (sel && pointers.size === 1) {
      let best: AdjustHandle | null = null;
      let bd = handleRadius() * HANDLE_HIT;
      for (const hd of adjustHandles(sel)) {
        const d = Math.hypot(p.x - hd.x, p.y - hd.y);
        if (d < bd) {
          bd = d;
          best = hd;
        }
      }
      if (best) drag = best;
    }
    return;
  }
  if (pointers.size === 1) {
    tap = { sx: e.clientX, sy: e.clientY, moved: false };
    // Encostou numa tatuagem: ela passa a ser a editada (e é a que vai ser arrastada).
    if (!sel || sel.pl) {
      const hit = hitTest(p.x, p.y);
      if (hit && hit !== sel) {
        selectLayer(hit);
        describe(hit);
      }
    }
  } else if (pointers.size === 2) {
    tap = null;
    pinch = twoFinger();
  }
});

stage.addEventListener('pointermove', (e) => {
  const prev = pointers.get(e.pointerId);
  if (!prev) return;
  const p = toImage(e);
  pointers.set(e.pointerId, p);
  if (drag) {
    if (placed(sel)) {
      dragHandle(sel, drag, p.x - prev.x, p.y - prev.y);
      schedule();
    }
    return;
  }
  if (sideDrag) {
    if (placed(sel)) {
      dragSide(sel, p.x, p.y);
      syncControls();
      schedule();
    }
    return;
  }
  if (stroke) {
    if (sel?.erase) {
      const last = stroke.pts[stroke.pts.length - 1];
      stroke.pts.push([p.x, p.y]);
      stampSegment(sel.erase, last, [p.x, p.y], stroke.r);
      schedule();
    }
    return;
  }
  if (adjustMode || eraseMode || sideMode) return;
  if (pointers.size === 2 && pinch && placed(sel)) {
    const g = twoFinger();
    const pl = sel.pl;
    pl.height = clamp((pl.height * g.dist) / Math.max(1, pinch.dist), sel.baseHeight * SIZE_MIN, sel.baseHeight * SIZE_MAX);
    let d = g.ang - pinch.ang;
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    pl.rot -= d;
    pinch = g;
    syncControls();
    touch();
    return;
  }
  if (pointers.size === 1 && tap) {
    if (!tap.moved && Math.hypot(e.clientX - tap.sx, e.clientY - tap.sy) > 8) tap.moved = true;
    if (tap.moved && placed(sel)) {
      sel.pl.px += p.x - prev.x;
      sel.pl.py += p.y - prev.y;
      touch();
    }
  }
});

function endPointer(e: PointerEvent) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (pointers.size < 2 && pinch) {
    pinch = null;
    // Depois de mudar o tamanho com dois dedos, avisa se a tatuagem passou da ponta do membro.
    if (placed(sel)) describe(sel);
    commit();
  }
  if (pointers.size === 0 && (drag || sideDrag)) {
    // Terminou de puxar uma bolinha (contorno ou lados): vira um passo (se mudou algo).
    drag = null;
    sideDrag = null;
    drawOverlay();
    commit();
  }
  if (pointers.size === 0 && stroke) {
    if (stroke.pts.length) sel?.strokes.push(stroke);
    stroke = null;
    commit();
  }
  if (pointers.size > 0 || !tap) return;
  const t = tap;
  tap = null;
  if (e.type !== 'pointerup' || !photo) return;
  if (t.moved) {
    // Depois de arrastar, reajusta ao corpo no novo ponto mantendo tamanho e giro.
    if (placed(sel)) fitLayer(sel, sel.pl.px, sel.pl.py, true);
    commit();
    return;
  }
  if (!sel) {
    setStatus('Adicione uma tatuagem primeiro (passo 2).');
    return;
  }
  const p = toImage(e);
  if (!sel.pl) {
    fitLayer(sel, p.x, p.y, false);
    commit();
  } else if (hitTest(p.x, p.y) !== sel) {
    // Tocou fora da tatuagem editada: leva ela para lá, mantendo tamanho e giro.
    fitLayer(sel, p.x, p.y, true);
    commit();
  } else {
    touch();
  }
}
stage.addEventListener('pointerup', endPointer);
stage.addEventListener('pointercancel', endPointer);

/** A roda do mouse dispara muitos eventos: o passo é guardado quando ela para. */
let wheelTimer = 0;
stage.addEventListener(
  'wheel',
  (e) => {
    if (!placed(sel)) return;
    e.preventDefault();
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

// ---------- Desenho ----------
let scheduled = false;
function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    draw();
  });
}

let frameTimer = 0;

function draw() {
  if (!photo || !out) return;
  for (const L of layers) L.outline = placed(L) ? outline(L.frame, L.tex, L.pl) : null;
  if (comparing) {
    out.data.set(photo.rgba);
  } else {
    if (!baseCache) {
      out.data.set(photo.rgba);
      for (const L of layers) {
        if (L !== sel && placed(L)) render(out, photo.highlight, L.mask, L.frame, L.tex, L.pl, L.erase);
      }
      baseCache = out.data.slice();
    } else out.data.set(baseCache);
    if (placed(sel)) render(out, photo.highlight, sel.mask, sel.frame, sel.tex, sel.pl, sel.erase);
  }
  ctx.putImageData(out, 0, 0);
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
  const lw = Math.max(2, Math.min(photo.w, photo.h) / 350);

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

  if (eraseMode && cursor) {
    octx.beginPath();
    octx.arc(cursor.x, cursor.y, brushRadius(), 0, Math.PI * 2);
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
    octx.strokeStyle = '#7cf29c';
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
      octx.fillStyle = tip ? 'rgba(255, 209, 102, 0.9)' : 'rgba(124, 242, 156, 0.75)';
      octx.fill();
      octx.lineWidth = r * 0.18;
      octx.strokeStyle = tip ? '#5a3d00' : '#0b3d1c';
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

  if (sel?.outline && (sideMode || debugIn.checked || showFrameUntil > performance.now())) {
    octx.lineWidth = lw * (sideMode ? 1 : 0.7);
    octx.strokeStyle = sideMode ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.8)';
    octx.setLineDash([lw * 3, lw * 3]);
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
      octx.fillStyle = active ? 'rgba(224, 179, 106, 0.95)' : 'rgba(255, 255, 255, 0.92)';
      octx.fill();
      octx.lineWidth = r * 0.2;
      octx.strokeStyle = '#1a1408';
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
    },
  });
}
