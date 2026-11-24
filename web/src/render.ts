// Composição de uma tatuagem sobre a imagem (a imagem pode já ter outras tatuagens):
// 1) forma: enrola o desenho no membro, com raio e centro que variam ao longo
//    do eixo (o membro pode afinar e engrossar);
// 2) recorte: só aparece onde há pele;
// 3) luz: tinta multiplica a pele (mantém sombra, poros, pelos) e o brilho volta por cima;
// 4) tinta: cobertura ajustável para cores claras em pele escura.
import { profileAt, type Frame } from './geometry';
import type { Tex } from './design';
import { clamp, smoothstep } from './util';

export interface Placement {
  /** Ponto da foto onde fica o centro da tatuagem. */
  px: number;
  py: number;
  /** Altura da tatuagem medida sobre a pele, em pixels. */
  height: number;
  /** Largura em relação à proporção original do desenho (1 = sem deformar). */
  stretch: number;
  /** Rotação em relação ao eixo do membro (radianos, anti-horário). */
  rot: number;
  /** 0 = plana, 1 = membro estimado, >1 = mais curva. */
  curvature: number;
  /** 0 = tinta só multiplica a pele; >0 = tinta cobre um pouco (cores claras aparecem mais). */
  coverage: number;
  clip: boolean;
  flip: boolean;
}

interface Mapping {
  curved: boolean;
  k: number;
  a0: number;
  t0: number;
  Wt: number;
  Ht: number;
  cosA: number;
  sinA: number;
}

function mapping(frame: Frame, tex: Tex, pl: Placement): Mapping {
  const curved = pl.curvature > 0.02 && Number.isFinite(frame.R);
  const pdx = pl.px - frame.cx;
  const pdy = pl.py - frame.cy;
  const s0 = pdx * frame.vx + pdy * frame.vy;
  const t0 = pdx * frame.ux + pdy * frame.uy;
  let a0 = s0;
  if (curved) {
    const [o0, r0] = profileAt(frame, t0);
    const Reff = Math.max(1, r0) / pl.curvature;
    a0 = Reff * Math.asin(clamp((s0 - o0) / Reff, -0.999, 0.999));
  }
  return {
    curved,
    k: pl.curvature,
    a0,
    t0,
    Ht: pl.height,
    Wt: pl.height * (tex.w / tex.h) * (pl.stretch || 1),
    cosA: Math.cos(pl.rot),
    sinA: Math.sin(pl.rot),
  };
}

/** Converte um ponto do desenho (centro = 0,0; y para cima) para a foto. */
function toImage(frame: Frame, m: Mapping, lx: number, ly: number): [number, number] {
  const a = m.a0 + m.cosA * lx - m.sinA * ly;
  const t = m.t0 + m.sinA * lx + m.cosA * ly;
  let s = a;
  if (m.curved) {
    const [o, r] = profileAt(frame, t);
    const Reff = Math.max(1, r) / m.k;
    s = o + Reff * Math.sin(clamp(a / Reff, -Math.PI / 2, Math.PI / 2));
  }
  return [frame.cx + frame.vx * s + frame.ux * t, frame.cy + frame.vy * s + frame.uy * t];
}

/** Ponto do desenho (centro = 0,0; y para cima; em pixels sobre a pele) → ponto da foto. */
export function localToImage(frame: Frame, tex: Tex, pl: Placement, lx: number, ly: number): [number, number] {
  return toImage(frame, mapping(frame, tex, pl), lx, ly);
}

/**
 * Ponto da foto → deslocamento sobre a pele a partir do centro da tatuagem, sem o giro do
 * desenho: [em volta do membro, ao longo do membro], em pixels medidos sobre a pele.
 */
export function imageToSkin(frame: Frame, tex: Tex, pl: Placement, x: number, y: number): [number, number] {
  const m = mapping(frame, tex, pl);
  const dx = x - frame.cx;
  const dy = y - frame.cy;
  const s = dx * frame.vx + dy * frame.vy;
  const t = dx * frame.ux + dy * frame.uy;
  let a = s;
  if (m.curved) {
    const [o, r] = profileAt(frame, t);
    const Reff = Math.max(1, r) / m.k;
    a = Reff * Math.asin(clamp((s - o) / Reff, -0.999, 0.999));
  }
  return [a - m.a0, t - m.t0];
}

/** Ponto da foto → ponto do desenho (a mesma conta do desenho da tatuagem, ao contrário). */
export function imageToLocal(frame: Frame, tex: Tex, pl: Placement, x: number, y: number): [number, number] {
  const [da, dt] = imageToSkin(frame, tex, pl, x, y);
  const c = Math.cos(pl.rot);
  const s = Math.sin(pl.rot);
  return [c * da + s * dt, -s * da + c * dt];
}

/** Contorno da tatuagem já curvada (para moldura de edição e para tocar/selecionar). */
export function outline(frame: Frame, tex: Tex, pl: Placement, perEdge = 10): [number, number][] {
  const m = mapping(frame, tex, pl);
  const hw = m.Wt / 2;
  const hh = m.Ht / 2;
  const pts: [number, number][] = [];
  const edges: [number, number, number, number][] = [
    [-hw, hh, hw, hh],
    [hw, hh, hw, -hh],
    [hw, -hh, -hw, -hh],
    [-hw, -hh, -hw, hh],
  ];
  for (const [x0, y0, x1, y1] of edges) {
    for (let i = 0; i < perEdge; i++) {
      const s = i / perEdge;
      pts.push(toImage(frame, m, x0 + (x1 - x0) * s, y0 + (y1 - y0) * s));
    }
  }
  return pts;
}

/** Retângulo de pixels [x0, y0, x1, y1] (inclusivo). */
export type Box = [number, number, number, number];

/**
 * Desenha a tatuagem em `out` e devolve o retângulo que pode ter mudado (ou null).
 * `step` > 1 é a prévia rápida usada enquanto o dedo arrasta: a geometria e o desenho são
 * calculados uma vez por bloco de step×step pixels, mas a mistura com a pele continua pixel a
 * pixel (pele, brilho, borracha). Na tela do celular a foto aparece reduzida e a diferença
 * não se vê; ao soltar, tudo é redesenhado com step 1.
 */
export function render(
  out: ImageData,
  highlight: Float32Array,
  mask: Float32Array | null,
  frame: Frame,
  tex: Tex,
  pl: Placement,
  /** Borracha (0..255): onde há algo na frente da pele, a tatuagem não aparece. */
  erase: Uint8Array | null = null,
  step = 1,
): Box | null {
  const W = out.width;
  const H = out.height;
  const o = out.data;
  const { cx, cy, ux, uy, vx, vy } = frame;
  const m = mapping(frame, tex, pl);
  const { curved, a0, t0, Wt, Ht, cosA, sinA } = m;
  const k = m.k;
  const prof = curved ? frame.profile : null;
  const pn = prof ? prof.off.length : 0;

  // Caixa de pixels que pode receber tinta (conservadora).
  const D = 0.5 * Math.hypot(Wt, Ht);
  let smin = a0 - D;
  let smax = a0 + D;
  if (curved) {
    let omin = Infinity;
    let omax = -Infinity;
    for (let t = t0 - D; t <= t0 + D; t += Math.max(1, D / 20)) {
      const [ot] = profileAt(frame, t);
      omin = Math.min(omin, ot);
      omax = Math.max(omax, ot);
    }
    const ext = Math.abs(a0) + D;
    smin = omin - ext;
    smax = omax + ext;
  }
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const s of [smin, smax]) {
    for (const t of [t0 - D, t0 + D]) {
      const x = cx + vx * s + ux * t;
      const y = cy + vy * s + uy * t;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  const bx0 = Math.max(0, Math.floor(x0));
  const by0 = Math.max(0, Math.floor(y0));
  const bx1 = Math.min(W - 1, Math.ceil(x1));
  const by1 = Math.min(H - 1, Math.ceil(y1));
  if (bx0 > bx1 || by0 > by1) return null;

  // Nível do mipmap: o mais leve que ainda tenha pelo menos 1 texel por pixel calculado.
  const texelsPerPx = (tex.w / Wt) * step;
  let li = 0;
  while (li < tex.levels.length - 1 && texelsPerPx / 2 ** (li + 1) >= 1) li++;
  const L = tex.levels[li];
  const lw = L.w;
  const lh = L.h;
  const ld = L.data;

  const cov = pl.coverage;
  const useMask = pl.clip && mask !== null;
  const R0 = frame.R;
  step = Math.max(1, Math.floor(step));

  for (let y = by0; y <= by1; y += step) {
    const yEnd = Math.min(by1, y + step - 1);
    for (let x = bx0; x <= bx1; x += step) {
      const xEnd = Math.min(bx1, x + step - 1);
      // Centro do bloco (com step 1, o centro do pixel).
      const dx = (x + xEnd + 1) * 0.5 - cx;
      const dy = (y + yEnd + 1) * 0.5 - cy;
      const s = dx * vx + dy * vy;
      const t = dx * ux + dy * uy;
      let a = s;
      let fore = 1;
      if (curved) {
        let off = 0;
        let rad = R0;
        if (prof) {
          const pf = (t - prof.start) / prof.step;
          const pi = pf < 0 ? 0 : pf > pn - 2 ? pn - 2 : Math.floor(pf);
          const pa = pf - pi < 0 ? 0 : pf - pi > 1 ? 1 : pf - pi;
          off = prof.off[pi] + (prof.off[pi + 1] - prof.off[pi]) * pa;
          rad = prof.rad[pi] + (prof.rad[pi + 1] - prof.rad[pi]) * pa;
        }
        if (rad <= 0.5) continue; // além da ponta do membro
        const Reff = rad / k;
        const q = (s - off) / Reff;
        if (!(q > -1 && q < 1)) continue;
        a = Reff * Math.asin(q);
        fore = Math.sqrt(1 - q * q);
      }
      const da = a - a0;
      const dt = t - t0;
      const lx = cosA * da + sinA * dt;
      const ly = -sinA * da + cosA * dt;
      let fx = (lx / Wt + 0.5) * lw - 0.5;
      const fy = (0.5 - ly / Ht) * lh - 0.5;
      if (pl.flip) fx = lw - 1 - fx;
      if (fx < -1 || fy < -1 || fx > lw || fy > lh) continue;

      const fm = smoothstep(0, 0.12, fore);
      if (fm <= 0.002) continue;
      // Algum pixel do bloco aparece (pele e borracha)? Senão nem lê o desenho.
      let visible = false;
      for (let yy = y; yy <= yEnd && !visible; yy++) {
        for (let xx = x; xx <= xEnd; xx++) {
          const i = yy * W + xx;
          if ((useMask ? mask![i] : 1) * fm * (erase ? 1 - erase[i] / 255 : 1) > 0.002) {
            visible = true;
            break;
          }
        }
      }
      if (!visible) continue;

      // Amostragem bilinear; fora do desenho = branco (sem tinta).
      const ix = Math.floor(fx);
      const iy = Math.floor(fy);
      const ax = fx - ix;
      const ay = fy - iy;
      let tr = 0;
      let tg = 0;
      let tb = 0;
      let th = 0;
      for (let jy = 0; jy < 2; jy++) {
        const sy = iy + jy;
        const wy = jy ? ay : 1 - ay;
        for (let jx = 0; jx < 2; jx++) {
          const sx = ix + jx;
          const wgt = (jx ? ax : 1 - ax) * wy;
          if (sx < 0 || sy < 0 || sx >= lw || sy >= lh) {
            tr += 255 * wgt;
            tg += 255 * wgt;
            tb += 255 * wgt;
          } else {
            const q = (sy * lw + sx) * 4;
            tr += ld[q] * wgt;
            tg += ld[q + 1] * wgt;
            tb += ld[q + 2] * wgt;
            th += ld[q + 3] * wgt;
          }
        }
      }
      const ir = tr / 255;
      const ig = tg / 255;
      const ib = tb / 255;
      const ink = Math.max(1 - ir, 1 - ig, 1 - ib);
      const halo = th / 255;
      if (ink < 0.003 && halo < 0.003) continue;
      // Halo (vermelhidão da recém-feita) e cor de cobertura: iguais no bloco todo.
      const hh = halo * 0.35;
      const kr = halo > 0 ? 1 - hh * 0.02 : 1;
      const kg = halo > 0 ? 1 - hh * 0.22 : 1;
      const kb = halo > 0 ? 1 - hh * 0.25 : 1;
      const covOn = cov > 0 && ink > 0.003;
      const pr = covOn ? (1 - (1 - ir) / ink) * 255 : 0;
      const pg = covOn ? (1 - (1 - ig) / ink) * 255 : 0;
      const pb = covOn ? (1 - (1 - ib) / ink) * 255 : 0;

      for (let yy = y; yy <= yEnd; yy++) {
        for (let xx = x; xx <= xEnd; xx++) {
          const i = yy * W + xx;
          const mk = (useMask ? mask![i] : 1) * fm * (erase ? 1 - erase[i] / 255 : 1);
          if (mk <= 0.002) continue;
          // Base = imagem atual (pode já ter outra tatuagem por baixo).
          const p = i * 4;
          const Br = o[p];
          const Bg = o[p + 1];
          const Bb = o[p + 2];
          const Sr = Br * kr;
          const Sg = Bg * kg;
          const Sb = Bb * kb;
          // Tinta multiplica a pele.
          let Rr = Sr * ir;
          let Rg = Sg * ig;
          let Rb = Sb * ib;
          // Cobertura: parte da tinta "pinta" por cima (cor extraída do branco).
          if (covOn) {
            Rr += (Sr * (1 - ink) + pr * ink - Rr) * cov;
            Rg += (Sg * (1 - ink) + pg * ink - Rg) * cov;
            Rb += (Sb * (1 - ink) + pb * ink - Rb) * cov;
          }
          // O brilho da pele fica por cima da tinta.
          const hl = highlight[i] * ink * 0.5;
          Rr += hl;
          Rg += hl;
          Rb += hl;

          o[p] = Br + (Rr - Br) * mk;
          o[p + 1] = Bg + (Rg - Bg) * mk;
          o[p + 2] = Bb + (Rb - Bb) * mk;
        }
      }
    }
  }
  return [bx0, by0, bx1, by1];
}
