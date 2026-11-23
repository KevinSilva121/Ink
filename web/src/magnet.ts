// Recorte "ímã": a linha do contorno gruda na borda mais forte perto do dedo, como o laço
// magnético dos editores de imagem ("tesoura inteligente").
//
// A foto vira um mapa de custo: borda forte (traço da tatuagem, contorno do desenho) é
// barata, pele lisa é cara. Enquanto o dedo anda, o app acha o caminho mais barato do último
// ponto fixo até o dedo, só numa faixa estreita em volta do traço (para não pular para uma
// borda longe de onde a pessoa está passando). De tempos em tempos o trecho vira fixo.
import { boxBlur } from './util';

export type Pt = [number, number];

/** Custo de passar por cada pixel (1 = borda forte ... 64 = liso). */
export function edgeCost(rgba: Uint8ClampedArray, w: number, h: number): Uint8Array {
  const n = w * h;
  const ch = [0, 1, 2].map((c) => {
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = rgba[i * 4 + c];
    return boxBlur(boxBlur(a, w, h, 1), w, h, 1);
  });
  const mag = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      let best = 0;
      for (const a of ch) {
        const gx = a[i - w + 1] + 2 * a[i + 1] + a[i + w + 1] - (a[i - w - 1] + 2 * a[i - 1] + a[i + w - 1]);
        const gy = a[i + w - 1] + 2 * a[i + w] + a[i + w + 1] - (a[i - w - 1] + 2 * a[i - w] + a[i - w + 1]);
        const m = gx * gx + gy * gy;
        if (m > best) best = m;
      }
      mag[i] = Math.sqrt(best);
    }
  }
  const sample: number[] = [];
  for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 50000))) sample.push(mag[i]);
  sample.sort((a, b) => a - b);
  const top = sample[Math.floor(sample.length * 0.98)] || 1;
  const cost = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const g = Math.min(1, mag[i] / top);
    cost[i] = 1 + Math.round(63 * (1 - g) ** 1.5);
  }
  return cost;
}

/**
 * Simplifica um contorno fechado: divide no ponto mais longe do começo (num laço o começo e
 * o fim coincidem, e a simplificação de uma linha só daria esses dois pontos).
 */
function simplifyLoop(pts: Pt[], tol: number): Pt[] {
  if (pts.length < 4) return pts.slice();
  let far = 0;
  let fd = -1;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]);
    if (d > fd) {
      fd = d;
      far = i;
    }
  }
  const a = simplify(pts.slice(0, far + 1), tol);
  const b = simplify(pts.slice(far), tol);
  return [...a, ...b.slice(1)];
}

/** Simplifica uma linha de pixels (Douglas-Peucker) mantendo o formato. */
function simplify(pts: Pt[], tol: number): Pt[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    let far = -1;
    let fd = tol;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / len;
      if (d > fd) {
        fd = d;
        far = i;
      }
    }
    if (far >= 0) {
      keep[far] = 1;
      stack.push([a, far], [far, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

export class MagnetLasso {
  /** Trecho já fixo (pixels), o trecho que ainda acompanha o dedo e os pontos fixos. */
  path: Pt[] = [];
  live: Pt[] = [];
  anchors: Pt[] = [];
  private trace: Pt[] = [];
  private traced = 0;

  constructor(
    private cost: Uint8Array,
    private w: number,
    private h: number,
    /** Largura da faixa em volta do traço onde a linha pode grudar (pixels da foto). */
    private R: number,
  ) {}

  start(x: number, y: number) {
    const p = this.snap(x, y, this.R * 0.6);
    this.anchors = [p];
    this.path = [p];
    this.trace = [p];
    this.live = [];
    this.traced = 0;
  }

  /** O dedo andou (pode vir mais de um ponto de uma vez; o último é onde ele está). */
  move(points: Pt[]) {
    if (!points.length || !this.anchors.length) return;
    for (const [x, y] of points) {
      const last = this.trace[this.trace.length - 1];
      this.traced += Math.hypot(x - last[0], y - last[1]);
      this.trace.push([x, y]);
    }
    const [x, y] = points[points.length - 1];
    const target = this.snap(x, y, this.R * 0.6);
    this.live = this.wire(this.anchors[this.anchors.length - 1], target, this.trace, this.R);
    // Andou o bastante: o trecho até aqui vira fixo.
    if (this.traced > 2.5 * this.R && this.live.length > 1) this.commit();
  }

  /** Solta o dedo: fixa o último trecho e fecha grudando na borda até o começo. */
  end(): Pt[] {
    if (this.live.length > 1) this.commit();
    const a = this.anchors[this.anchors.length - 1];
    const s = this.anchors[0];
    if (Math.hypot(a[0] - s[0], a[1] - s[1]) > 1) {
      const closing = this.wire(a, s, [a, s], this.R * 1.5);
      this.path.push(...closing.slice(1));
    }
    return simplifyLoop(this.smooth(this.dropSpurs(this.path)), 0.8);
  }

  /**
   * Tira "espinhos": trechos em que a linha vai até um detalhe e volta pelo mesmo lugar
   * (o caminho passa de novo perto de onde já esteve, logo depois).
   */
  private dropSpurs(path: Pt[]): Pt[] {
    const out: Pt[] = [];
    const K = Math.ceil(3 * this.R);
    let i = 0;
    while (i < path.length) {
      out.push(path[i]);
      let next = i + 1;
      for (let j = Math.min(path.length - 2, i + K); j > i + 2; j--) {
        if (Math.hypot(path[j][0] - path[i][0], path[j][1] - path[i][1]) <= 1.5) {
          next = j + 1;
          break;
        }
      }
      i = next;
    }
    return out;
  }

  /** Suaviza a escadinha dos pixels (média de 5 pontos, contorno fechado). */
  private smooth(path: Pt[]): Pt[] {
    const n = path.length;
    if (n < 8) return path;
    const out: Pt[] = [];
    for (let k = 0; k < n; k++) {
      let sx = 0;
      let sy = 0;
      for (let d = -2; d <= 2; d++) {
        const p = path[(k + d + n) % n];
        sx += p[0];
        sy += p[1];
      }
      out.push([sx / 5, sy / 5]);
    }
    return out;
  }

  private commit() {
    const end = this.live[this.live.length - 1];
    this.path.push(...this.live.slice(1));
    this.anchors.push(end);
    this.trace = [end];
    this.traced = 0;
    this.live = [];
  }

  /** Pixel de borda mais forte perto do ponto (ou o próprio ponto, se tudo for liso). */
  private snap(x: number, y: number, r: number): Pt {
    const { w, h, cost } = this;
    const cx = Math.round(Math.min(w - 1, Math.max(0, x)));
    const cy = Math.round(Math.min(h - 1, Math.max(0, y)));
    let best: Pt = [cx, cy];
    let bc = cost[cy * w + cx] + 0.001;
    const ri = Math.ceil(r);
    for (let yy = Math.max(0, cy - ri); yy <= Math.min(h - 1, cy + ri); yy++) {
      for (let xx = Math.max(0, cx - ri); xx <= Math.min(w - 1, cx + ri); xx++) {
        const d = Math.hypot(xx - cx, yy - cy);
        if (d > r) continue;
        // Prefere borda forte; entre bordas parecidas, a mais perto do dedo.
        const c = cost[yy * w + xx] + d * 0.15;
        if (c < bc) {
          bc = c;
          best = [xx, yy];
        }
      }
    }
    return best;
  }

  /** Caminho mais barato de `a` até `b` dentro da faixa de largura R em volta de `corridor`. */
  private wire(a: Pt, b: Pt, corridor: Pt[], R: number): Pt[] {
    const { w, h, cost } = this;
    const pts = [a, ...corridor, b];
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [x, y] of pts) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    const pad = Math.ceil(R) + 2;
    x0 = Math.max(0, Math.floor(x0) - pad);
    y0 = Math.max(0, Math.floor(y0) - pad);
    x1 = Math.min(w - 1, Math.ceil(x1) + pad);
    y1 = Math.min(h - 1, Math.ceil(y1) + pad);
    const ww = x1 - x0 + 1;
    const wh = y1 - y0 + 1;
    const n = ww * wh;

    // Faixa permitida: discos de raio R ao longo do traço.
    const allowed = new Uint8Array(n);
    const disc = (cx: number, cy: number) => {
      const r = Math.ceil(R);
      for (let yy = Math.max(y0, Math.round(cy) - r); yy <= Math.min(y1, Math.round(cy) + r); yy++) {
        for (let xx = Math.max(x0, Math.round(cx) - r); xx <= Math.min(x1, Math.round(cx) + r); xx++) {
          if ((xx - cx) ** 2 + (yy - cy) ** 2 <= R * R) allowed[(yy - y0) * ww + (xx - x0)] = 1;
        }
      }
    };
    for (let k = 0; k < pts.length; k++) {
      const [px, py] = pts[k];
      disc(px, py);
      if (k === 0) continue;
      const [qx, qy] = pts[k - 1];
      const steps = Math.ceil(Math.hypot(px - qx, py - qy) / Math.max(1, R / 2));
      for (let s = 1; s < steps; s++) disc(qx + ((px - qx) * s) / steps, qy + ((py - qy) * s) / steps);
    }

    const src = (Math.round(a[1]) - y0) * ww + (Math.round(a[0]) - x0);
    const dst = (Math.round(b[1]) - y0) * ww + (Math.round(b[0]) - x0);
    allowed[src] = allowed[dst] = 1;

    // Dijkstra com baldes (custos inteiros pequenos).
    const INF = 0x3fffffff;
    const dist = new Int32Array(n).fill(INF);
    const prev = new Int32Array(n).fill(-1);
    const B = 256;
    const buckets: number[][] = Array.from({ length: B }, () => []);
    dist[src] = 0;
    buckets[0].push(src);
    let pending = 1;
    let cur = 0;
    let found = false;
    while (pending > 0) {
      const bk = buckets[cur % B];
      if (!bk.length) {
        cur++;
        continue;
      }
      const i = bk.pop()!;
      pending--;
      if (dist[i] !== cur) continue;
      if (i === dst) {
        found = true;
        break;
      }
      const x = i % ww;
      const y = (i - x) / ww;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= wh) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const xx = x + dx;
          if (xx < 0 || xx >= ww) continue;
          const j = yy * ww + xx;
          if (!allowed[j]) continue;
          const c = cost[(yy + y0) * w + (xx + x0)];
          const nd = cur + (dx && dy ? Math.round(c * 1.414) : c);
          if (nd < dist[j]) {
            dist[j] = nd;
            prev[j] = i;
            buckets[nd % B].push(j);
            pending++;
          }
        }
      }
    }
    if (!found) return [a, b];
    const out: Pt[] = [];
    for (let i = dst; i >= 0; i = prev[i]) {
      const x = i % ww;
      out.push([x + x0, (i - x) / ww + y0]);
      if (i === src) break;
    }
    return out.reverse();
  }
}
