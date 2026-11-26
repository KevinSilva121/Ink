// Lupa: no celular o dedo cobre o que está embaixo dele. Mostra ampliado, num círculo no alto
// (do lado oposto ao dedo), com a mira no ponto exato e, na borracha, o círculo do tamanho dela.
import { clamp } from './util';

export const LOUPE_CSS = 132;

export interface LoupeOptions {
  /** Quanto amplia (px de tela da lupa por px de tela da imagem). */
  zoom?: number;
  /** Raio da borracha em px de tela (0 = sem círculo). */
  ringCss?: number;
  /** Cor de fundo fora da imagem. */
  bg?: string;
}

/** Ampliação que deixa o círculo da borracha (raio em px de tela) dentro da lupa. */
export const zoomForBrush = (ringCss: number) => clamp(56 / Math.max(1, ringCss), 1.2, 3);

/**
 * Desenha a lupa `lp` sobre `src` em volta do ponto `p` (pixels do canvas `src`); null esconde.
 * A lupa fica no canto de cima do contêiner dela, do lado oposto ao dedo.
 */
export function drawLoupe(src: HTMLCanvasElement, lp: HTMLCanvasElement, p: { x: number; y: number } | null, opt: LoupeOptions = {}) {
  if (!p) {
    lp.hidden = true;
    return;
  }
  const r = src.getBoundingClientRect();
  if (!r.width) return;
  const zoom = opt.zoom ?? 2.4;
  const ringCss = opt.ringCss ?? 0;
  const dpr = window.devicePixelRatio || 1;
  const size = Math.round(LOUPE_CSS * dpr);
  if (lp.width !== size) lp.width = lp.height = size;
  // Do lado oposto ao dedo (metade da parte visível do canvas; com zoom ele passa da caixa).
  const box = lp.parentElement!.getBoundingClientRect();
  const fingerX = r.left + (p.x / src.width) * r.width - box.left;
  const right = fingerX < box.width / 2;
  if (lp.classList.contains('right') !== right) lp.classList.toggle('right', right);
  if (lp.hidden) lp.hidden = false;
  const span = ((LOUPE_CSS / zoom) * src.width) / r.width; // pixels do canvas mostrados
  const g = lp.getContext('2d')!;
  const light = opt.bg === '#fff';
  g.fillStyle = opt.bg ?? '#000';
  g.fillRect(0, 0, size, size);
  g.imageSmoothingEnabled = true;
  g.drawImage(src, p.x - span / 2, p.y - span / 2, span, span, 0, 0, size, size);
  const c = size / 2;
  if (ringCss) {
    // O que fica dentro do círculo é apagado (tracejado claro e escuro: aparece em qualquer fundo).
    const rr = ringCss * zoom * dpr;
    g.lineWidth = Math.max(1.5, 1.5 * dpr);
    g.setLineDash([4 * dpr, 3 * dpr]);
    g.strokeStyle = 'rgba(255,255,255,0.95)';
    g.beginPath();
    g.arc(c, c, rr, 0, Math.PI * 2);
    g.stroke();
    g.lineDashOffset = 4 * dpr;
    g.strokeStyle = 'rgba(0,0,0,0.85)';
    g.stroke();
    g.setLineDash([]);
    g.lineDashOffset = 0;
  }
  // Mira no ponto exato do dedo.
  g.strokeStyle = light ? 'rgba(0,0,0,0.75)' : 'rgba(255,255,255,0.9)';
  g.lineWidth = Math.max(1, dpr);
  const a = size * 0.08;
  g.beginPath();
  g.moveTo(c - a, c);
  g.lineTo(c + a, c);
  g.moveTo(c, c - a);
  g.lineTo(c, c + a);
  g.stroke();
}
