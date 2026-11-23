// Extrai o desenho de uma tatuagem fotografada na pele.
//
// É a conta inversa do provador: lá, pele × desenho = pele tatuada; aqui,
// foto ÷ pele = desenho. Onde só há pele sobra branco; onde há tinta, sobra a
// cor da tinta. O difícil é saber a cor da pele EMBAIXO da tinta (com a luz e a
// sombra do corpo): ela é deduzida da pele em volta.
import { profileAt, type Frame } from './geometry';
import { boxBlur, clamp, median, smoothstep, solveLinear } from './util';

/** Imagem em "espaço de tinta": por canal, foto ÷ pele (1 = sem tinta). */
export interface InkImage {
  w: number;
  h: number;
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
  /** Quanto cada pixel parece pele sem tinta (0..1); só na separação da foto. */
  skin?: Float32Array;
  /** Tem tom de pele (mesmo com sombra ou tinta clara por cima); null se a foto não tem cor. */
  skinLike?: Float32Array | null;
}

// ---------- 1) Separar a tinta da pele ----------

/** Máximo numa janela deslizante (fila monotônica), ao longo de uma linha ou coluna. */
function slidingMax(
  src: Float32Array,
  dst: Float32Array,
  off: number,
  stride: number,
  n: number,
  r: number,
  dq: Int32Array,
) {
  let head = 0;
  let tail = 0;
  let next = 0;
  for (let i = 0; i < n; i++) {
    const hi = Math.min(n - 1, i + r);
    while (next <= hi) {
      const v = src[off + next * stride];
      while (tail > head && src[off + dq[tail - 1] * stride] <= v) tail--;
      dq[tail++] = next++;
    }
    while (dq[head] < i - r) head++;
    dst[off + i * stride] = src[off + dq[head] * stride];
  }
}

/** Dilatação (máximo em volta) separável: apaga traços escuros mais finos que a janela. */
function maxFilter(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const dq = new Int32Array(Math.max(w, h) + 1);
  for (let y = 0; y < h; y++) slidingMax(src, tmp, y * w, 1, w, r, dq);
  for (let x = 0; x < w; x++) slidingMax(tmp, out, x, w, h, r, dq);
  return out;
}

/**
 * Preenche os buracos de uma imagem a partir dos pixels com peso (push-pull): onde o peso
 * é 1 fica o valor do pixel; onde é 0 (tinta), o valor vem da pele em volta, de perto ou
 * de longe, conforme o tamanho do buraco.
 */
function pushPull(vals: Float32Array[], weight: Float32Array, w: number, h: number): Float32Array[] {
  interface Level {
    w: number;
    h: number;
    m: Float32Array;
    p: Float32Array[];
  }
  const levels: Level[] = [{ w, h, m: weight, p: vals.map((v) => v.map((x, i) => x * weight[i])) }];
  for (;;) {
    const L = levels[levels.length - 1];
    if (L.w <= 1 && L.h <= 1) break;
    const nw = Math.ceil(L.w / 2);
    const nh = Math.ceil(L.h / 2);
    const m = new Float32Array(nw * nh);
    const p = vals.map(() => new Float32Array(nw * nh));
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        let cnt = 0;
        let sm = 0;
        let s0 = 0;
        let s1 = 0;
        let s2 = 0;
        for (let dy = 0; dy < 2; dy++) {
          const yy = 2 * y + dy;
          if (yy >= L.h) continue;
          for (let dx = 0; dx < 2; dx++) {
            const xx = 2 * x + dx;
            if (xx >= L.w) continue;
            const j = yy * L.w + xx;
            cnt++;
            sm += L.m[j];
            s0 += L.p[0][j];
            s1 += L.p[1][j];
            s2 += L.p[2][j];
          }
        }
        const i = y * nw + x;
        m[i] = sm / cnt;
        p[0][i] = s0 / cnt;
        p[1][i] = s1 / cnt;
        p[2][i] = s2 / cnt;
      }
    }
    levels.push({ w: nw, h: nh, m, p });
  }

  const top = levels[levels.length - 1];
  let V = vals.map((v, c) => {
    if (top.m[0] > 1e-6) return Float32Array.of(top.p[c][0] / top.m[0]);
    let s = 0;
    for (let i = 0; i < v.length; i++) s += v[i];
    return Float32Array.of(s / v.length);
  });
  for (let l = levels.length - 2; l >= 0; l--) {
    const L = levels[l];
    const U = levels[l + 1];
    const nV = vals.map(() => new Float32Array(L.w * L.h));
    for (let y = 0; y < L.h; y++) {
      const fy = (y + 0.5) / 2 - 0.5;
      const y0 = clamp(Math.floor(fy), 0, U.h - 1);
      const y1 = Math.min(y0 + 1, U.h - 1);
      const ay = clamp(fy - y0, 0, 1);
      for (let x = 0; x < L.w; x++) {
        const fx = (x + 0.5) / 2 - 0.5;
        const x0 = clamp(Math.floor(fx), 0, U.w - 1);
        const x1 = Math.min(x0 + 1, U.w - 1);
        const ax = clamp(fx - x0, 0, 1);
        const i = y * L.w + x;
        const mm = L.m[i];
        const a = Math.min(1, mm * 4);
        for (let c = 0; c < 3; c++) {
          const v = V[c];
          const up =
            (v[y0 * U.w + x0] * (1 - ax) + v[y0 * U.w + x1] * ax) * (1 - ay) +
            (v[y1 * U.w + x0] * (1 - ax) + v[y1 * U.w + x1] * ax) * ay;
          nV[c][i] = mm > 1e-4 ? a * (L.p[c][i] / mm) + (1 - a) * up : up;
        }
      }
    }
    V = nV;
  }
  return V;
}

/**
 * Superfície suave (polinômio de 2º grau em x e y) ajustada à pele em volta da tatuagem:
 * dá a luz e a sombra do corpo por baixo de áreas grandes de tinta (fechamentos, preenchimentos).
 */
function skinSurface(I: Float32Array[], w: number, h: number, idx: number[]): Float32Array[] {
  const n = w * h;
  const feat = (i: number) => {
    const x = ((i % w) / w) * 2 - 1;
    const y = (Math.floor(i / w) / h) * 2 - 1;
    return [1, x, y, x * x, x * y, y * y];
  };
  const F = idx.map(feat);
  return I.map((ch) => {
    const vals = idx.map((i) => ch[i]);
    const med = median(vals);
    let wts = vals.map(() => 1);
    let coef = [med, 0, 0, 0, 0, 0];
    for (let it = 0; it < 4; it++) {
      const M = Array.from({ length: 6 }, () => [0, 0, 0, 0, 0, 0]);
      const v = [0, 0, 0, 0, 0, 0];
      for (let k = 0; k < F.length; k++) {
        const f = F[k];
        const wt = wts[k];
        for (let a = 0; a < 6; a++) {
          v[a] += wt * f[a] * vals[k];
          for (let b = 0; b < 6; b++) M[a][b] += wt * f[a] * f[b];
        }
      }
      for (let a = 0; a < 6; a++) M[a][a] += 1e-3 * F.length;
      const next = solveLinear(M, v);
      if (!next) break;
      coef = next;
      const res = F.map((f, k) => vals[k] - f.reduce((s, x, a) => s + x * coef[a], 0));
      const scale = 1.48 * median(res.map(Math.abs)) + 2;
      wts = res.map((r) => 1 / (1 + (r / (2 * scale)) ** 2));
    }
    const out = new Float32Array(n);
    const [c0, c1, c2, c3, c4, c5] = coef;
    for (let yy = 0; yy < h; yy++) {
      const y = (yy / h) * 2 - 1;
      for (let xx = 0; xx < w; xx++) {
        const x = (xx / w) * 2 - 1;
        const v = c0 + c1 * x + c2 * y + c3 * x * x + c4 * x * y + c5 * y * y;
        out[yy * w + xx] = clamp(v, 0.6 * med, 1.4 * med);
      }
    }
    return out;
  });
}

/**
 * Divide a foto pela pele estimada. `ring` marca a pele em volta da tatuagem (fora do
 * retângulo marcado); `hint` (opcional) é a probabilidade de pele do modelo.
 */
export function separateInk(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  ring: Uint8Array,
  hint: Float32Array | null,
): InkImage {
  const n = w * h;
  const I = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i++) {
    I[0][i] = rgba[i * 4];
    I[1][i] = rgba[i * 4 + 1];
    I[2][i] = rgba[i * 4 + 2];
  }
  const Ib = I.map((c) => boxBlur(c, w, h, 1));

  // Pele de referência: anel em volta, só o que tem tom de pele (o anel pode pegar fundo,
  // roupa, a maca) e, entre esses, o que é parecido com a maioria.
  const ycc = (i: number) => {
    const r = Ib[0][i];
    const g = Ib[1][i];
    const b = Ib[2][i];
    return [0.299 * r + 0.587 * g + 0.114 * b, -0.1687 * r - 0.3313 * g + 0.5 * b, 0.5 * r - 0.4187 * g - 0.0813 * b];
  };
  const skinTone = (i: number) => {
    const [y, cb, cr] = ycc(i);
    return y > 40 && cr > 3 && cr < 54 && cb > -58 && cb < 8;
  };
  const collect = (useHint: boolean) => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) if (ring[i] && (!useHint || !hint || hint[i] >= 0.5) && skinTone(i)) out.push(i);
    return out;
  };
  // Em foto de perto o modelo de pele costuma falhar: aí vale só o tom.
  let idx = collect(true);
  if (idx.length < 40 && hint) idx = collect(false);
  if (idx.length < 40) idx = [];
  if (idx.length) {
    const step = Math.max(1, Math.floor(idx.length / 6000));
    const sub = idx.filter((_, k) => k % step === 0);
    const Y = sub.map((i) => ycc(i));
    const mY = median(Y.map((v) => v[0]));
    const mCb = median(Y.map((v) => v[1]));
    const mCr = median(Y.map((v) => v[2]));
    idx = sub.filter((_, k) => {
      const [y, cb, cr] = Y[k];
      return Math.abs(cb - mCb) < 12 && Math.abs(cr - mCr) < 12 && y > 0.6 * mY && y < 1.5 * mY + 10;
    });
  }
  let P: Float32Array[];
  if (idx.length >= 40) {
    P = skinSurface(Ib, w, h, idx);
  } else {
    // Sem anel de pele utilizável: usa um tom claro da própria região.
    P = Ib.map((c) => {
      const s = Array.from(c.filter((_, i) => i % 7 === 0)).sort((a, b) => a - b);
      return new Float32Array(n).fill(s[Math.floor(s.length * 0.9)] || 255);
    });
  }

  // Envelope local (dilatação + desfoque): acompanha sombras e músculos.
  const kd = Math.max(4, Math.round(0.04 * Math.max(w, h)));
  const D = Ib.map((c) => boxBlur(maxFilter(c, w, h, kd), w, h, kd));
  const qmin = (A: Float32Array[], i: number) =>
    Math.min(Ib[0][i] / Math.max(1, A[0][i]), Ib[1][i] / Math.max(1, A[1][i]), Ib[2][i] / Math.max(1, A[2][i]));

  // Cor da pele (sem o brilho): reflexo e tinta branca são claros mas menos saturados que a
  // pele, e não podem servir de referência de "pele embaixo da tinta".
  let tone: ((i: number) => number) | null = null;
  let skinLike: Float32Array | null = null;
  // Foto sem cor de verdade (preto e branco, sépia, filtro forte): nada de julgar pela cor.
  const chroma: number[] = [];
  for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 20000))) {
    const [y, cb, cr] = ycc(i);
    if (y > 60) chroma.push(Math.hypot(cb, cr));
  }
  chroma.sort((a, b) => a - b);
  const hasColor = chroma.length > 100 && chroma[Math.floor(chroma.length * 0.9)] >= 16;
  if (idx.length && hasColor) {
    const nr: number[] = [];
    const ng: number[] = [];
    const ys: number[] = [];
    for (const i of idx) {
      const s = Ib[0][i] + Ib[1][i] + Ib[2][i] + 1;
      nr.push(Ib[0][i] / s);
      ng.push(Ib[1][i] / s);
      ys.push(s / 3);
    }
    const rr = median(nr);
    const rg = median(ng);
    const ry = median(ys);
    const dist = (i: number) => {
      const s = Ib[0][i] + Ib[1][i] + Ib[2][i] + 1;
      return Math.hypot(Ib[0][i] / s - rr, Ib[1][i] / s - rg);
    };
    tone = (i: number) => smoothstep(0.085, 0.05, dist(i));
    // Para achar o fundo: tom de pele com folga (brilho, sombra na borda, tinta clara por
    // cima). Faixa clássica de pele em YCbCr, que aguenta bem a mudança de luz, e não muito
    // longe da pele em volta.
    skinLike = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const r = Ib[0][i];
      const g = Ib[1][i];
      const b = Ib[2][i];
      const y = 0.299 * r + 0.587 * g + 0.114 * b;
      const cb = 128 - 0.1687 * r - 0.3313 * g + 0.5 * b;
      const cr = 128 + 0.5 * r - 0.4187 * g - 0.0813 * b;
      const ok = y > Math.max(40, 0.25 * ry) && cr > 133 && cr < 178 && cb > 75 && cb < 128 && dist(i) < 0.14;
      skinLike[i] = ok ? 1 : 0;
    }
  }

  // Peso de "é pele": claro em relação ao envelope local, com cor de pele e não muito mais
  // escuro que a pele do anel. A superfície do anel é só uma trava larga (para preenchimentos
  // grandes de tinta): a luz no meio do braço pode ser bem diferente da luz na borda.
  const m = new Float32Array(n);
  const skinW = (i: number, q: number) => q * smoothstep(0.45, 0.6, qmin(P, i)) * (tone ? tone(i) : 1);
  for (let i = 0; i < n; i++) m[i] = skinW(i, smoothstep(0.8, 0.92, qmin(D, i)));
  const rs = Math.max(2, Math.round(0.006 * Math.max(w, h)));
  let B = pushPull(Ib, m, w, h).map((c) => boxBlur(c, w, h, rs));
  for (let it = 0; it < 2; it++) {
    for (let i = 0; i < n; i++) m[i] = skinW(i, smoothstep(0.82, 0.93, qmin(B, i)));
    B = pushPull(Ib, m, w, h).map((c) => boxBlur(c, w, h, rs));
  }

  const out = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < n; i++) out[c][i] = Math.min(1.5, I[c][i] / Math.max(1, B[c][i]));
  }
  return { w, h, r: out[0], g: out[1], b: out[2], skin: m, skinLike };
}

/** Distância (chanfro 3-4, em pixels) de cada pixel até o pixel marcado mais perto. */
function distanceTo(mask: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? 0 : INF;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + 3);
      if (y > 0) {
        v = Math.min(v, d[i - w] + 3);
        if (x > 0) v = Math.min(v, d[i - w - 1] + 4);
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + 4);
      }
      d[i] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i];
      if (x < w - 1) v = Math.min(v, d[i + 1] + 3);
      if (y < h - 1) {
        v = Math.min(v, d[i + w] + 3);
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + 4);
        if (x > 0) v = Math.min(v, d[i + w - 1] + 4);
      }
      d[i] = v;
    }
  }
  for (let i = 0; i < d.length; i++) d[i] /= 3;
  return d;
}

/**
 * "Casco" do membro: em cada linha transversal ao membro, tudo entre a pele mais de um lado
 * e a mais do outro (só a pele dentro do contorno). As bordas de um braço ou perna mudam
 * devagar, então cada linha usa a pele mais externa das linhas vizinhas, e linha sem pele
 * visível (tatuagem de borda a borda) herda das vizinhas. O que está aqui dentro é membro:
 * nunca é tratado como fundo.
 */
function skinHull(S: Uint8Array, keep: Uint8Array, w: number, h: number): Uint8Array {
  const n = w * h;
  // Direção do membro pela forma da pele dentro do contorno.
  let cnt = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    if (!S[i] || keep[i] < 128) continue;
    const x = i % w;
    const y = (i - x) / w;
    cnt++;
    sx += x;
    sy += y;
    sxx += x * x;
    syy += y * y;
    sxy += x * y;
  }
  const H = new Uint8Array(n);
  if (cnt < 20) return H;
  const mx = sx / cnt;
  const my = sy / cnt;
  const th = 0.5 * Math.atan2(2 * (sxy / cnt - mx * my), sxx / cnt - mx * mx - (syy / cnt - my * my));
  const vertical = Math.abs(Math.sin(th)) > Math.abs(Math.cos(th));
  // Membro em pé: as linhas transversais são as linhas da imagem; deitado: as colunas.
  const lines = vertical ? h : w;
  const len = vertical ? w : h;
  const at = (line: number, pos: number) => (vertical ? line * w + pos : pos * w + line);
  const lo = new Float64Array(lines).fill(NaN);
  const hi = new Float64Array(lines).fill(NaN);
  for (let L = 0; L < lines; L++) {
    for (let p = 0; p < len; p++) {
      const i = at(L, p);
      if (!S[i] || keep[i] < 128) continue;
      if (!(lo[L] <= p)) lo[L] = p;
      hi[L] = p;
    }
  }
  // Linhas sem pele: interpola entre as vizinhas (e repete nas pontas).
  const known: number[] = [];
  for (let L = 0; L < lines; L++) if (!Number.isNaN(lo[L])) known.push(L);
  if (!known.length) return H;
  for (let L = 0; L < lines; L++) {
    if (!Number.isNaN(lo[L])) continue;
    let k = 0;
    while (k < known.length && known[k] < L) k++;
    const a = known[Math.max(0, k - 1)];
    const b = known[Math.min(known.length - 1, k)];
    const f = b === a ? 0 : (L - a) / (b - a);
    lo[L] = lo[a] + (lo[b] - lo[a]) * f;
    hi[L] = hi[a] + (hi[b] - hi[a]) * f;
  }
  // Envelope: a pele mais externa entre as linhas vizinhas (janela larga: onde a tatuagem
  // vai até a borda, a pele da borda só aparece um pouco acima ou abaixo), com folga.
  const win = Math.max(2, Math.round(0.2 * lines));
  const margin = Math.max(2, Math.round(0.01 * Math.max(w, h)));
  for (let L = 0; L < lines; L++) {
    let a = Infinity;
    let b = -Infinity;
    for (let j = Math.max(0, L - win); j <= Math.min(lines - 1, L + win); j++) {
      a = Math.min(a, lo[j]);
      b = Math.max(b, hi[j]);
    }
    for (let p = Math.max(0, Math.floor(a - margin)); p <= Math.min(len - 1, Math.ceil(b + margin)); p++) H[at(L, p)] = 1;
  }
  return H;
}

/**
 * Fundo que entrou no contorno (recorte imperfeito): maca, roupa, chão, parede.
 *
 * Tinta de tatuagem sempre está perto de pele ou cercada por ela. Fundo vem de fora: entra
 * pela linha do contorno e fica longe de qualquer pele. Então: (1) acha a pele (só pedaços
 * grandes, para não contar reflexo solto no fundo); (2) marca o que está longe dela;
 * (3) fica só com o que encosta na linha do contorno; (4) leva junto a faixa entre esse fundo
 * e a pele, sem atravessar pele. Devolve o multiplicador do contorno (255 = fica, 0 = sai),
 * ou null quando não há fundo para tirar ou a foto não deixa julgar com segurança.
 */
export function backgroundMask(
  skinLike: Float32Array,
  keep: Uint8Array,
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
): Uint8Array | null {
  const n = w * h;
  const size = Math.max(w, h);
  let keepArea = 0;
  for (let i = 0; i < n; i++) if (keep[i] >= 128) keepArea++;
  if (!keepArea) return null;

  // 1) Pele: pedaços grandes de tom de pele.
  const S = new Uint8Array(n);
  const lab = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  const minSkin = 0.01 * keepArea;
  let skinArea = 0;
  for (let s = 0; s < n; s++) {
    if (!(skinLike[s] > 0.5) || lab[s] >= 0) continue;
    const members: number[] = [];
    let sp = 0;
    stack[sp++] = s;
    lab[s] = 1;
    while (sp > 0) {
      const i = stack[--sp];
      members.push(i);
      const x = i % w;
      if (x > 0 && skinLike[i - 1] > 0.5 && lab[i - 1] < 0) (lab[i - 1] = 1), (stack[sp++] = i - 1);
      if (x < w - 1 && skinLike[i + 1] > 0.5 && lab[i + 1] < 0) (lab[i + 1] = 1), (stack[sp++] = i + 1);
      if (i >= w && skinLike[i - w] > 0.5 && lab[i - w] < 0) (lab[i - w] = 1), (stack[sp++] = i - w);
      if (i < n - w && skinLike[i + w] > 0.5 && lab[i + w] < 0) (lab[i + w] = 1), (stack[sp++] = i + w);
    }
    if (members.length >= minSkin) {
      for (const i of members) S[i] = 1;
      skinArea += members.length;
    }
  }
  // Pouca pele reconhecida dentro do contorno: não dá para saber onde o membro termina.
  let skinIn = 0;
  for (let i = 0; i < n; i++) if (S[i] && keep[i] >= 128) skinIn++;
  if (skinIn < 0.15 * keepArea) return null;

  // 2) e 3) Fora do membro, longe da pele, com cor de fundo e encostado na linha do contorno.
  const hull = skinHull(S, keep, w, h);
  let hullIn = 0;
  for (let i = 0; i < n; i++) if (hull[i] && keep[i] >= 128) hullIn++;
  if (hullIn < 0.4 * keepArea) return null;
  const dist = distanceTo(S, w, h);
  const D = Math.max(6, 0.03 * size);
  const inLasso = (i: number) => keep[i] >= 128;

  // Cores do fundo: o que aparece fora do contorno, longe da pele (couro da maca, chão,
  // roupa). Cor de tinta que não aparece lá fora (verde, azul de um desenho) fica protegida.
  const bin = (i: number) => ((rgba[i * 4] >> 4) << 8) | ((rgba[i * 4 + 1] >> 4) << 4) | (rgba[i * 4 + 2] >> 4);
  const hist = new Float32Array(4096);
  let samples = 0;
  const sst = Math.max(1, Math.floor(n / 60000));
  for (let i = 0; i < n; i += sst) {
    if (keep[i] >= 128 || S[i] || dist[i] <= D) continue;
    hist[bin(i)]++;
    samples++;
  }
  let bgLike: (i: number) => boolean = () => true;
  if (samples >= 200) {
    const near = new Float32Array(4096);
    for (let r = 0; r < 16; r++) {
      for (let g = 0; g < 16; g++) {
        for (let b = 0; b < 16; b++) {
          let s = 0;
          for (let dr = -1; dr <= 1; dr++) {
            for (let dg = -1; dg <= 1; dg++) {
              for (let db = -1; db <= 1; db++) {
                const rr = r + dr;
                const gg = g + dg;
                const bb = b + db;
                if (rr < 0 || gg < 0 || bb < 0 || rr > 15 || gg > 15 || bb > 15) continue;
                s += hist[(rr << 8) | (gg << 4) | bb];
              }
            }
          }
          near[(r << 8) | (g << 4) | b] = s / samples;
        }
      }
    }
    bgLike = (i: number) => near[bin(i)] >= 0.004;
  }
  // Pode ser fundo: dentro do contorno, fora do membro e com cor de fundo.
  const inside = (i: number) => keep[i] >= 128 && !hull[i] && bgLike(i);
  const onEdge = (i: number) => {
    const x = i % w;
    const y = (i - x) / w;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1) return true;
    return !inLasso(i - 1) || !inLasso(i + 1) || !inLasso(i - w) || !inLasso(i + w);
  };
  const bg = new Uint8Array(n);
  const seen = new Uint8Array(n);
  for (let s = 0; s < n; s++) {
    if (seen[s] || !inside(s) || dist[s] <= D) continue;
    const members: number[] = [];
    let touches = false;
    let sp = 0;
    stack[sp++] = s;
    seen[s] = 1;
    while (sp > 0) {
      const i = stack[--sp];
      members.push(i);
      if (!touches && onEdge(i)) touches = true;
      const x = i % w;
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < n - w ? i + w : -1];
      for (const j of nb) {
        if (j >= 0 && !seen[j] && inside(j) && dist[j] > D) {
          seen[j] = 1;
          stack[sp++] = j;
        }
      }
    }
    if (touches) for (const i of members) bg[i] = 1;
  }

  // 4) A faixa entre o fundo e a pele (até D), sem atravessar pele, só por cor de fundo.
  const canGrow = (j: number) => inLasso(j) && !S[j] && bgLike(j);
  const steps = new Int32Array(n).fill(-1);
  let head = 0;
  let tail = 0;
  const queue = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    if (bg[i]) {
      steps[i] = 0;
      queue[tail++] = i;
    }
  }
  while (head < tail) {
    const i = queue[head++];
    if (steps[i] >= D) continue;
    const x = i % w;
    const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < n - w ? i + w : -1];
    for (const j of nb) {
      if (j >= 0 && steps[j] < 0 && canGrow(j)) {
        steps[j] = steps[i] + 1;
        bg[j] = 1;
        queue[tail++] = j;
      }
    }
  }

  let bgArea = 0;
  for (let i = 0; i < n; i++) if (bg[i] && inLasso(i)) bgArea++;
  // Quase nada (não vale mexer) ou demais (algo deu errado: melhor não tirar).
  if (bgArea < 0.005 * keepArea || bgArea > 0.55 * keepArea) return null;

  const soft = new Float32Array(n);
  for (let i = 0; i < n; i++) soft[i] = bg[i];
  const sb = boxBlur(soft, w, h, 2);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(255 * clamp(1 - sb[i], 0, 1));
  return out;
}

// ---------- 2) Desenrolar a curva do membro ----------

export interface ExtractGeometry {
  /** Formato do membro (na foto de análise), ou null se não foi reconhecido. */
  frame: Frame | null;
  /** Foto de análise → imagem de trabalho: xW = xA·k − ox. */
  k: number;
  ox: number;
  oy: number;
  /** Retângulo marcado, na foto de análise. */
  rect: [number, number, number, number];
}

/** Para cada pixel do desenho, o ponto da imagem de trabalho de onde ele vem (NaN = branco). */
export interface DesignMap {
  w: number;
  h: number;
  map: Float32Array;
}

/** Até onde desenrolar para os lados: perto da silhueta a pele aparece muito de lado. */
const THETA_MAX = 1.25;

export function buildMap(g: ExtractGeometry, curvature: number): DesignMap {
  const [rx0, ry0, rx1, ry1] = g.rect;
  const inRect = (x: number, y: number) => x >= rx0 && x <= rx1 && y >= ry0 && y <= ry1;
  const f = g.frame;
  if (!f) {
    // Sem membro reconhecido: recorte simples do retângulo.
    const x0 = rx0 * g.k - g.ox;
    const y0 = ry0 * g.k - g.oy;
    const w = Math.max(1, Math.round((rx1 - rx0) * g.k));
    const h = Math.max(1, Math.round((ry1 - ry0) * g.k));
    const map = new Float32Array(w * h * 2);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        map[(j * w + i) * 2] = x0 + i;
        map[(j * w + i) * 2 + 1] = y0 + j;
      }
    }
    return { w, h, map };
  }

  const kc = curvature;
  const aOf = (s: number, t: number) => {
    const [o, r] = profileAt(f, t);
    if (kc <= 0.02) return s - o;
    const R = Math.max(1, r) / kc;
    const lim = Math.sin(Math.min(THETA_MAX, Math.PI / 2));
    return R * Math.asin(clamp((s - o) / R, -lim, lim));
  };
  // Extensão do desenho: contorno do retângulo levado para o espaço desenrolado.
  let aMin = Infinity;
  let aMax = -Infinity;
  let tMin = Infinity;
  let tMax = -Infinity;
  const per: [number, number][] = [];
  for (let k = 0; k < 40; k++) {
    const u = k / 10;
    const side = Math.floor(u);
    const fr = u - side;
    if (side === 0) per.push([rx0 + (rx1 - rx0) * fr, ry0]);
    else if (side === 1) per.push([rx1, ry0 + (ry1 - ry0) * fr]);
    else if (side === 2) per.push([rx1 - (rx1 - rx0) * fr, ry1]);
    else per.push([rx0, ry1 - (ry1 - ry0) * fr]);
  }
  for (const [x, y] of per) {
    const s = (x - f.cx) * f.vx + (y - f.cy) * f.vy;
    const t = (x - f.cx) * f.ux + (y - f.cy) * f.uy;
    const a = aOf(s, t);
    aMin = Math.min(aMin, a);
    aMax = Math.max(aMax, a);
    tMin = Math.min(tMin, t);
    tMax = Math.max(tMax, t);
  }
  let px = 1 / g.k; // unidades da foto de análise por pixel do desenho
  const area = ((aMax - aMin) / px) * ((tMax - tMin) / px);
  if (area > 4e6) px *= Math.sqrt(area / 4e6);
  const w = Math.max(1, Math.ceil((aMax - aMin) / px));
  const h = Math.max(1, Math.ceil((tMax - tMin) / px));
  const map = new Float32Array(w * h * 2).fill(NaN);
  for (let j = 0; j < h; j++) {
    const t = tMax - (j + 0.5) * px;
    const [o, r] = profileAt(f, t);
    if (r <= 0.5) continue;
    const R = Math.max(1, r) / Math.max(kc, 1e-6);
    for (let i = 0; i < w; i++) {
      const a = aMin + (i + 0.5) * px;
      let s: number;
      if (kc > 0.02) {
        const th = a / R;
        if (Math.abs(th) > Math.min(THETA_MAX, Math.PI / 2)) continue;
        s = o + R * Math.sin(th);
      } else s = o + a;
      if (Math.abs(s - o) > r) continue;
      const x = f.cx + f.vx * s + f.ux * t;
      const y = f.cy + f.vy * s + f.uy * t;
      if (!inRect(x, y)) continue;
      map[(j * w + i) * 2] = x * g.k - g.ox;
      map[(j * w + i) * 2 + 1] = y * g.k - g.oy;
    }
  }
  return { w, h, map };
}

/** Desenho montado, com a marcação do que está dentro do contorno (e do membro). */
export interface SampledDesign extends InkImage {
  inside: Uint8Array;
}

/**
 * Monta o desenho (ainda sem ajustes) a partir do mapa. Vira branco o que a borracha apagou
 * e o que ficou fora do contorno marcado (`keep`), ambos na imagem de trabalho (0..255).
 */
export function sampleDesign(
  dm: DesignMap,
  ink: InkImage,
  erase: Uint8Array | null,
  keep: Uint8Array | null = null,
): SampledDesign {
  const { w, h, map } = dm;
  const n = w * h;
  const out = {
    w,
    h,
    r: new Float32Array(n).fill(1),
    g: new Float32Array(n).fill(1),
    b: new Float32Array(n).fill(1),
    inside: new Uint8Array(n),
  };
  const src = [ink.r, ink.g, ink.b];
  const dst = [out.r, out.g, out.b];
  const W = ink.w;
  const H = ink.h;
  for (let i = 0; i < n; i++) {
    const x = map[i * 2];
    const y = map[i * 2 + 1];
    if (!(x >= 0 && y >= 0 && x <= W - 1 && y <= H - 1)) continue;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = Math.min(x0 + 1, W - 1);
    const y1 = Math.min(y0 + 1, H - 1);
    const ax = x - x0;
    const ay = y - y0;
    const j = Math.round(y) * W + Math.round(x);
    if (!keep || keep[j] >= 128) out.inside[i] = 1;
    const e = 1 - (1 - (erase ? erase[j] / 255 : 0)) * (keep ? keep[j] / 255 : 1);
    for (let c = 0; c < 3; c++) {
      const s = src[c];
      const v =
        (s[y0 * W + x0] * (1 - ax) + s[y0 * W + x1] * ax) * (1 - ay) + (s[y1 * W + x0] * (1 - ax) + s[y1 * W + x1] * ax) * ay;
      dst[c][i] = v + (1 - v) * e;
    }
  }
  return out;
}

// ---------- 3) Rebarbas do recorte ----------

export interface TrimResult {
  /** Pedaços encostados na borda do contorno que foram removidos. */
  edge: number;
  /** Pontinhos soltos, longe de qualquer tinta, que foram removidos. */
  specks: number;
}

/**
 * Remove o que sobrou de um recorte imperfeito e não faz parte da tatuagem:
 * - pedaços de "tinta" encostados na borda do contorno e quase todos numa faixa junto dela,
 *   separados da tatuagem por pele: fundo, roupa, sombra da borda do braço, pedaço de outra
 *   tatuagem que o contorno pegou;
 * - pedacinhos minúsculos e isolados (sujeira, poro escuro), longe de qualquer outra tinta.
 *   Pontilhismo fica, porque os pontos andam em grupo;
 * - tinta fraca solta na faixa da borda, que não encosta em nenhuma tinta que ficou.
 * Altera o desenho no lugar (o que sai vira branco).
 */
export function trimScraps(
  d: SampledDesign,
  kHi: number,
  /** Tirar pedaços encostados no contorno? Não quando o contorno já gruda na tatuagem (ímã). */
  edgeRule = true,
): TrimResult {
  const { w, h, inside } = d;
  const n = w * h;
  const k = new Float32Array(n);
  for (let i = 0; i < n; i++) k[i] = inside[i] ? clamp(1 - Math.min(d.r[i], d.g[i], d.b[i]), 0, 1) : 0;
  const tInk = Math.max(0.12, 0.3 * kHi);

  // Fora do contorno (e a beirada da imagem).
  const outside = new Float32Array(n);
  let insideArea = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!inside[i] || x === 0 || y === 0 || x === w - 1 || y === h - 1) outside[i] = 1;
      else insideArea++;
    }
  }
  if (!insideArea) return { edge: 0, specks: 0 };
  const bw = Math.max(6, Math.round(0.035 * Math.max(w, h)));
  const band = maxFilter(outside, w, h, bw);
  const touch = maxFilter(outside, w, h, 2);
  const inkMask = new Float32Array(n);
  for (let i = 0; i < n; i++) inkMask[i] = k[i] > tInk ? 1 : 0;
  const density = boxBlur(inkMask, w, h, Math.max(4, Math.round(0.02 * Math.max(w, h))));

  // Pedaços de tinta (vizinhança de 8).
  const lab = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  const area: number[] = [];
  const inBand: number[] = [];
  const touches: boolean[] = [];
  const dens: number[] = [];
  for (let s = 0; s < n; s++) {
    if (!inkMask[s] || lab[s] >= 0) continue;
    const id = area.length;
    let a = 0;
    let ab = 0;
    let t = false;
    let ds = 0;
    let sp = 0;
    stack[sp++] = s;
    lab[s] = id;
    while (sp > 0) {
      const i = stack[--sp];
      a++;
      if (band[i] > 0) ab++;
      if (touch[i] > 0) t = true;
      ds += density[i];
      const x = i % w;
      const y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (inkMask[j] && lab[j] < 0) {
            lab[j] = id;
            stack[sp++] = j;
          }
        }
      }
    }
    area.push(a);
    inBand.push(ab);
    touches.push(t);
    dens.push(ds / a);
  }

  const tiny = Math.max(6, Math.round(0.00003 * insideArea));
  const small = 0.004 * insideArea;
  const remove = new Uint8Array(area.length);
  const res: TrimResult = { edge: 0, specks: 0 };
  for (let c = 0; c < area.length; c++) {
    if (edgeRule && touches[c] && (inBand[c] / area[c] > 0.5 || area[c] < small)) {
      remove[c] = 1;
      res.edge++;
    } else if (area[c] <= tiny && dens[c] < 0.03) {
      remove[c] = 1;
      res.specks++;
    }
  }

  const rem = new Float32Array(n);
  const kept = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (lab[i] < 0) continue;
    if (remove[lab[i]]) rem[i] = 1;
    else kept[i] = 1;
  }
  // Leva junto a borda suave do pedaço removido (sem encostar no que fica).
  const remNear = maxFilter(rem, w, h, 2);
  const keptNear = maxFilter(kept, w, h, 3);
  const drops: number[] = [];
  let total = 0;
  let dropped = 0;
  for (let i = 0; i < n; i++) {
    total += k[i];
    if (!inside[i] || kept[i]) continue;
    const drop =
      rem[i] > 0 || (remNear[i] > 0 && keptNear[i] === 0) || (edgeRule && band[i] > 0 && k[i] > 0 && keptNear[i] === 0);
    if (drop) {
      drops.push(i);
      dropped += k[i];
    }
  }
  // Trava: sobras de recorte são pouca coisa perto da tatuagem. Se ia sumir tinta demais,
  // é sinal de que a foto confundiu a regra, e é melhor não mexer.
  if (dropped > 0.35 * total) return { edge: 0, specks: 0 };
  for (const i of drops) d.r[i] = d.g[i] = d.b[i] = 1;
  return res;
}

// ---------- 4) Limpeza e acabamento ----------

export interface Finish {
  /** 'cor' mantém cores e sombreado; 'pb' sombreado em cinza; 'traco' só linhas pretas lisas. */
  mode: 'cor' | 'pb' | 'traco';
  /** Quanto de tinta fraca (poros, textura, pelos claros) vira branco: 0..0.4. */
  clean: number;
  /** Intensidade da tinta (curva): 1 = como na foto. */
  gain: number;
  /** Nitidez (para tatuagem cicatrizada, que espalha): 0..2. */
  sharp: number;
}

export interface FinishPrep {
  /** Quantidade de tinta por pixel (0 = branco) e a versão desfocada (para a nitidez). */
  k: Float32Array;
  kb: Float32Array;
  /** Tinta "cheia" da foto (o preto mais escuro vira preto de verdade). */
  kHi: number;
  /** Correção por canal para o preto sair neutro (preto cicatrizado puxa para o azul na pele). */
  neutral: [number, number, number];
}

export function prepFinish(d: InkImage, kHi?: number, neutral?: [number, number, number]): FinishPrep {
  const n = d.w * d.h;
  const k = new Float32Array(n);
  for (let i = 0; i < n; i++) k[i] = clamp(1 - Math.min(d.r[i], d.g[i], d.b[i]), 0, 1);
  const kb = boxBlur(k, d.w, d.h, Math.max(1, Math.round(0.002 * Math.max(d.w, d.h))));
  const step = Math.max(1, Math.floor(n / 200000));
  if (kHi === undefined) {
    const inked: number[] = [];
    for (let i = 0; i < n; i += step) if (k[i] > 0.15) inked.push(k[i]);
    inked.sort((a, b) => a - b);
    kHi = inked.length > 50 ? clamp(inked[Math.floor(inked.length * 0.95)], 0.25, 1) : 0.6;
  }
  if (!neutral) {
    // Nos pixels mais escuros (o preto domina até em tatuagem colorida), quanto cada canal
    // absorve em relação ao máximo. Preto neutro = os três iguais.
    const fr: number[] = [];
    const fg: number[] = [];
    const fb: number[] = [];
    for (let i = 0; i < n; i += step) {
      if (k[i] < 0.55) continue;
      fr.push((1 - d.r[i]) / k[i]);
      fg.push((1 - d.g[i]) / k[i]);
      fb.push((1 - d.b[i]) / k[i]);
    }
    if (fr.length > 50) {
      const c = [median(fr), median(fg), median(fb)];
      const mx = Math.max(...c);
      // Só corrige um desvio moderado (um desvio forte é cor de verdade, não tom do preto).
      neutral = Math.min(...c) / mx > 0.6 ? (c.map((v) => clamp(mx / Math.max(v, 1e-3), 1, 1.6)) as [number, number, number]) : [1, 1, 1];
    } else neutral = [1, 1, 1];
  }
  return { k, kb, kHi, neutral };
}

/** Desenho final em fundo branco. `scale` > 1 renderiza maior (linhas do modo traço mais lisas). */
export function renderFinish(d: InkImage, prep: FinishPrep, fin: Finish, scale = 1): ImageData {
  const W = Math.max(1, Math.round(d.w * scale));
  const H = Math.max(1, Math.round(d.h * scale));
  const img = new ImageData(W, H);
  const o = img.data;
  const { k, kb, kHi } = prep;
  const lo = fin.clean;
  const span = Math.max(0.05, kHi - lo);
  const gamma = 1 / fin.gain;
  const w = d.w;
  const h = d.h;
  for (let y = 0; y < H; y++) {
    const fy = (y + 0.5) / scale - 0.5;
    const y0 = clamp(Math.floor(fy), 0, h - 1);
    const y1 = Math.min(y0 + 1, h - 1);
    const ay = clamp(fy - y0, 0, 1);
    for (let x = 0; x < W; x++) {
      const fx = (x + 0.5) / scale - 0.5;
      const x0 = clamp(Math.floor(fx), 0, w - 1);
      const x1 = Math.min(x0 + 1, w - 1);
      const ax = clamp(fx - x0, 0, 1);
      const i00 = y0 * w + x0;
      const i01 = y0 * w + x1;
      const i10 = y1 * w + x0;
      const i11 = y1 * w + x1;
      const bil = (a: Float32Array) =>
        (a[i00] * (1 - ax) + a[i01] * ax) * (1 - ay) + (a[i10] * (1 - ax) + a[i11] * ax) * ay;
      const k0 = bil(k);
      const ks = k0 + fin.sharp * (k0 - bil(kb));
      const kn = clamp((ks - lo) / span, 0, 1);
      const kk = kn ** gamma;
      const p = (y * W + x) * 4;
      o[p + 3] = 255;
      if (fin.mode === 'traco') {
        const v = 255 * (1 - smoothstep(0.3, 0.55, kk));
        o[p] = o[p + 1] = o[p + 2] = v;
      } else if (fin.mode === 'pb') {
        o[p] = o[p + 1] = o[p + 2] = 255 * (1 - kk);
      } else {
        // Mantém a proporção entre os canais (a cor da tinta) e muda só a quantidade.
        const sc = kk / Math.max(k0, 0.02);
        const [nr, ng, nb] = prep.neutral;
        const ar = Math.min(k0, (1 - bil(d.r)) * nr);
        const ag = Math.min(k0, (1 - bil(d.g)) * ng);
        const ab = Math.min(k0, (1 - bil(d.b)) * nb);
        o[p] = 255 * clamp(1 - ar * sc, 0, 1);
        o[p + 1] = 255 * clamp(1 - ag * sc, 0, 1);
        o[p + 2] = 255 * clamp(1 - ab * sc, 0, 1);
      }
    }
  }
  return img;
}
