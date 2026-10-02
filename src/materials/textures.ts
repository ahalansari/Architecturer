/**
 * Procedural, seamlessly tileable PBR textures.
 *
 * Every pattern paints into a small float "canvas" (sRGB color, height in tile units,
 * roughness offset, occlusion multiplier). A shared post-pass then multiplies the
 * material tint in, derives a tangent-space normal map from the height with a
 * wrap-around Sobel filter, adds cavity occlusion and packs everything as RGBA8.
 *
 * Tileability: all noise is periodic (lattices wrap modulo their period), all cell
 * layouts (bricks, planks, voronoi...) have integer counts per tile and wrap their ids,
 * and every pixel-space filter wraps around the edges.
 *
 * Coordinates: u = x / size (left→right), v = y / size (top→bottom). On walls the geometry
 * maps v downward ("up" is the top of the image), so courses/boards run along u.
 */
import type { MaterialDef, RGB, TexturePattern, TextureSet } from "./types.js";

// ---------------------------------------------------------------------------
// Hashing / RNG
// ---------------------------------------------------------------------------

/** FNV-1a 32-bit string hash. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Integer hash of (x, y, seed) → uint32. */
function ihash(x: number, y: number, s: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(s | 0, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Deterministic random in [0,1) for integer coordinates. */
function rnd(x: number, y: number, s: number): number {
  return ihash(x, y, s) / 4294967296;
}

// ---------------------------------------------------------------------------
// Small math helpers
// ---------------------------------------------------------------------------

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}
const mod = (a: number, n: number) => ((a % n) + n) % n;
const fract = (x: number) => x - Math.floor(x);

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

/**
 * Parse "#rgb", "#rrggbb", "#rrggbbaa" (with or without '#'), "rgb(r,g,b)" or a
 * [r,g,b] array (0..1, or 0..255 if any component > 1). Returns sRGB 0..1 or undefined.
 */
export function parseColor(input: unknown): RGB | undefined {
  if (Array.isArray(input) && input.length >= 3 && input.slice(0, 3).every((x) => typeof x === "number" && isFinite(x))) {
    const a = input.slice(0, 3) as number[];
    const div = a.some((x) => x > 1) ? 255 : 1;
    return [clamp01(a[0] / div), clamp01(a[1] / div), clamp01(a[2] / div)];
  }
  if (typeof input !== "string") return undefined;
  const s = input.trim().toLowerCase();
  const rgbm = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(s);
  if (rgbm) return [clamp01(+rgbm[1] / 255), clamp01(+rgbm[2] / 255), clamp01(+rgbm[3] / 255)];
  let hex = s.startsWith("#") ? s.slice(1) : s;
  if (!/^[0-9a-f]+$/.test(hex)) return undefined;
  if (hex.length === 3 || hex.length === 4) hex = hex.slice(0, 3).split("").map((ch) => ch + ch).join("");
  else if (hex.length === 8) hex = hex.slice(0, 6);
  if (hex.length !== 6) return undefined;
  const v = parseInt(hex, 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

const hex = (s: string): RGB => parseColor(s)!;

// ---------------------------------------------------------------------------
// Params access
// ---------------------------------------------------------------------------

class Params {
  constructor(private raw: Record<string, number | string> = {}) {}
  num(key: string, def: number, min = -Infinity, max = Infinity): number {
    const v = this.raw[key];
    const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
    return isFinite(n) ? clamp(n, min, max) : def;
  }
  int(key: string, def: number, min = 1, max = 4096): number {
    return Math.round(this.num(key, def, min, max));
  }
  /** First key that holds a parseable color wins. */
  color(keys: string | string[], def: RGB): RGB {
    for (const k of Array.isArray(keys) ? keys : [keys]) {
      const c = parseColor(this.raw[k]);
      if (c) return c;
    }
    return def;
  }
  str(key: string, def: string): string {
    const v = this.raw[key];
    return typeof v === "string" ? v.toLowerCase() : def;
  }
}

// ---------------------------------------------------------------------------
// Canvas
// ---------------------------------------------------------------------------

interface Canvas {
  size: number;
  n: number;
  seed: number;
  /** sRGB color 0..1, 3 floats per pixel. */
  col: Float32Array;
  /** Height in tile units (1 = one texture tile). Physically plausible: mortar ≈ 0.006 at 1 m/tile. */
  h: Float32Array;
  /** Added to the material roughness. */
  rough: Float32Array;
  /** Multiplied into ambient occlusion. */
  ao: Float32Array;
  /** Cavity occlusion strength (per unit of height below the local average). */
  cavity: number;
  /** Cavity blur radius in tile units. */
  cavityRadius: number;
}

function makeCanvas(size: number, seed: number): Canvas {
  const n = size * size;
  const c: Canvas = {
    size,
    n,
    seed,
    col: new Float32Array(n * 3).fill(1),
    h: new Float32Array(n),
    rough: new Float32Array(n),
    ao: new Float32Array(n).fill(1),
    cavity: 60,
    cavityRadius: 0.012,
  };
  return c;
}

function setCol(c: Canvas, i: number, r: number, g: number, b: number) {
  const k = i * 3;
  c.col[k] = r;
  c.col[k + 1] = g;
  c.col[k + 2] = b;
}

/** Pixel-center coordinates in [0,1). */
function coords(size: number): Float32Array {
  const a = new Float32Array(size);
  for (let i = 0; i < size; i++) a[i] = (i + 0.5) / size;
  return a;
}

// ---------------------------------------------------------------------------
// Periodic noise
// ---------------------------------------------------------------------------

/** Adds one octave of periodic gradient (Perlin) noise with periods (px, py) cells per tile. */
function perlinLayer(out: Float32Array, size: number, px: number, py: number, seed: number, amp: number) {
  const gx = new Float32Array(px * py);
  const gy = new Float32Array(px * py);
  for (let k = 0; k < px * py; k++) {
    const a = rnd(k, 7, seed) * Math.PI * 2;
    gx[k] = Math.cos(a);
    gy[k] = Math.sin(a);
  }
  const ix0 = new Int32Array(size), ix1 = new Int32Array(size);
  const tx = new Float32Array(size), sx = new Float32Array(size);
  for (let x = 0; x < size; x++) {
    const f = ((x + 0.5) * px) / size;
    const i = Math.floor(f);
    const t = f - i;
    ix0[x] = i % px;
    ix1[x] = (i + 1) % px;
    tx[x] = t;
    sx[x] = t * t * t * (t * (t * 6 - 15) + 10);
  }
  const k = amp * 1.41;
  for (let y = 0; y < size; y++) {
    const f = ((y + 0.5) * py) / size;
    const j = Math.floor(f);
    const ty = f - j;
    const sy = ty * ty * ty * (ty * (ty * 6 - 15) + 10);
    const r0 = (j % py) * px, r1 = ((j + 1) % py) * px;
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const a0 = r0 + ix0[x], b0 = r0 + ix1[x], a1 = r1 + ix0[x], b1 = r1 + ix1[x];
      const fx = tx[x], fx1 = fx - 1, fy1 = ty - 1;
      const n00 = gx[a0] * fx + gy[a0] * ty;
      const n10 = gx[b0] * fx1 + gy[b0] * ty;
      const n01 = gx[a1] * fx + gy[a1] * fy1;
      const n11 = gx[b1] * fx1 + gy[b1] * fy1;
      const s = sx[x];
      const a = n00 + s * (n10 - n00);
      const b = n01 + s * (n11 - n01);
      out[row + x] += k * (a + sy * (b - a));
    }
  }
}

/**
 * Periodic fractal noise field, normalized to zero mean and std ≈ 0.33 (so values sit mostly in [-1, 1]).
 * px/py = base periods (cells per tile) along u/v — use different values for anisotropic noise (grain, brushing).
 */
function fbm(c: Canvas, px: number, py: number, octaves: number, salt: number, gain = 0.5): Float32Array {
  const out = new Float32Array(c.n);
  let amp = 1;
  for (let o = 0; o < octaves; o++) {
    const qx = px << o, qy = py << o;
    if (o > 0 && Math.max(qx, qy) > c.size / 1.5) break; // finer than a pixel: skip
    perlinLayer(out, c.size, qx, qy, ihash(salt, o, c.seed), amp);
    amp *= gain;
  }
  return normalize(out, 0.33);
}

function normalize(f: Float32Array, std: number): Float32Array {
  let m = 0;
  for (let i = 0; i < f.length; i++) m += f[i];
  m /= f.length;
  let v = 0;
  for (let i = 0; i < f.length; i++) v += (f[i] - m) * (f[i] - m);
  const s = std / Math.sqrt(v / f.length || 1);
  for (let i = 0; i < f.length; i++) f[i] = (f[i] - m) * s;
  return f;
}

/** Bilinear lookup of a field at (u, v) in tile units, wrapping. */
function sample(f: Float32Array, size: number, u: number, v: number): number {
  const x = mod(u * size - 0.5, size), y = mod(v * size - 0.5, size);
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const tx = x - x0, ty = y - y0;
  const x1 = (x0 + 1) % size, y1 = (y0 + 1) % size;
  const a = f[y0 * size + x0] + (f[y0 * size + x1] - f[y0 * size + x0]) * tx;
  const b = f[y1 * size + x0] + (f[y1 * size + x1] - f[y1 * size + x0]) * tx;
  return a + (b - a) * ty;
}

// ---------------------------------------------------------------------------
// Periodic Voronoi (one jittered point per cell, wrapped ids)
// ---------------------------------------------------------------------------

interface Voronoi {
  /** Cell id (wrapped, stable across tile edges). */
  id: Int32Array;
  /** Exact distance to the nearest cell border, in tile units. */
  edge: Float32Array;
  /** Distance to the cell's point, in tile units. */
  f1: Float32Array;
}

/**
 * cx × cy cells per tile. Optional warp fields displace the lookup position (in tile units × warpAmp)
 * to make borders wobbly while staying periodic.
 */
function voronoi(c: Canvas, cx: number, cy: number, jitter: number, salt: number, warpU?: Float32Array, warpV?: Float32Array, warpAmp = 0): Voronoi {
  const { size, n } = c;
  const jx = new Float32Array(cx * cy), jy = new Float32Array(cx * cy);
  for (let k = 0; k < cx * cy; k++) {
    jx[k] = 0.5 + (rnd(k, 1, c.seed ^ salt) - 0.5) * jitter;
    jy[k] = 0.5 + (rnd(k, 2, c.seed ^ salt) - 0.5) * jitter;
  }
  const id = new Int32Array(n), edge = new Float32Array(n), f1 = new Float32Array(n);
  const nu = new Float32Array(9), nv = new Float32Array(9), nk = new Int32Array(9);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      let u = (x + 0.5) / size, v = (y + 0.5) / size;
      if (warpU && warpV) {
        u += warpU[i] * warpAmp;
        v += warpV[i] * warpAmp;
      }
      const gx = Math.floor(u * cx), gy = Math.floor(v * cy);
      let best = 1e9, bi = 0, m = 0;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const ci = gx + di, cj = gy + dj;
          const k = mod(ci, cx) + mod(cj, cy) * cx;
          const pu = (ci + jx[k]) / cx, pv = (cj + jy[k]) / cy;
          nu[m] = pu;
          nv[m] = pv;
          nk[m] = k;
          const du = pu - u, dv = pv - v;
          const d = du * du + dv * dv;
          if (d < best) {
            best = d;
            bi = m;
          }
          m++;
        }
      }
      // distance to the nearest bisector between the winning point and its neighbours
      const au = nu[bi], av = nv[bi];
      let e = 1e9;
      for (let q = 0; q < 9; q++) {
        if (q === bi) continue;
        let du = nu[q] - au, dv = nv[q] - av;
        const len = Math.sqrt(du * du + dv * dv) || 1e-9;
        du /= len;
        dv /= len;
        const d = (u - (au + nu[q]) * 0.5) * -du + (v - (av + nv[q]) * 0.5) * -dv;
        if (d < e) e = d;
      }
      id[i] = nk[bi];
      edge[i] = e;
      f1[i] = Math.sqrt(best);
    }
  }
  return { id, edge, f1 };
}

// ---------------------------------------------------------------------------
// Rectangular cell layouts (bricks, tiles, pavers)
// ---------------------------------------------------------------------------

interface Cell {
  /** Wrapped id. */
  id: number;
  row: number;
  col: number;
  /** Local coords within the cell, 0..1. */
  lx: number;
  ly: number;
  /** Distance to the nearest cell edge, in tile units. */
  d: number;
}

/** Grid of cols × rows cells; row r is shifted by r·offset cells (running bond for 0.5). */
function rectCell(u: number, v: number, cols: number, rows: number, offset: number, out: Cell): Cell {
  const fy = v * rows;
  const r = Math.floor(fy);
  const ly = fy - r;
  const row = mod(r, rows);
  const fx = u * cols + fract(row * offset);
  const cc = Math.floor(fx);
  const lx = fx - cc;
  const col = mod(cc, cols);
  out.row = row;
  out.col = col;
  out.id = row * cols + col;
  out.lx = lx;
  out.ly = ly;
  out.d = Math.min(Math.min(lx, 1 - lx) / cols, Math.min(ly, 1 - ly) / rows);
  return out;
}

const newCell = (): Cell => ({ id: 0, row: 0, col: 0, lx: 0, ly: 0, d: 0 });

/** Visit pixels within radius r (tile units) of (cu, cv), wrapping. fn gets pixel index, offset (du, dv) in tile units. */
function forDisc(size: number, cu: number, cv: number, r: number, fn: (i: number, du: number, dv: number) => void) {
  const x0 = Math.floor((cu - r) * size), x1 = Math.ceil((cu + r) * size);
  const y0 = Math.floor((cv - r) * size), y1 = Math.ceil((cv + r) * size);
  for (let y = y0; y <= y1; y++) {
    const dv = (y + 0.5) / size - cv;
    const row = mod(y, size) * size;
    for (let x = x0; x <= x1; x++) {
      const du = (x + 0.5) / size - cu;
      if (du * du + dv * dv <= r * r) fn(row + mod(x, size), du, dv);
    }
  }
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

type Painter = (c: Canvas, p: Params) => void;

const paintNone: Painter = (c) => {
  c.cavity = 0;
};

/** Running-bond brick wall. Default 4 × 14 bricks per tile ≈ 250 × 71 mm at 1 m/tile. */
const paintBrick: Painter = (c, p) => {
  const cols = p.int("cols", 4), rows = p.int("rows", 14);
  const offset = p.num("offset", 0.5, 0, 1);
  const mortarW = p.num("mortarWidth", 0.011, 0, 0.1);
  const brickCol = p.color(["brickColor", "base", "brick"], hex("#9a4a35"));
  const mortarCol = p.color(["mortar", "mortarColor"], hex("#b9b2a6"));
  const variation = p.num("variation", 1, 0, 3);
  const { size } = c;
  const low = fbm(c, 6, 6, 5, 1);
  const speck = fbm(c, 48, 48, 3, 2);
  const chip = fbm(c, 24, 24, 3, 3);
  const mortN = fbm(c, 96, 96, 2, 4);
  const U = coords(size);
  const cell = newCell();
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      rectCell(U[x], U[y], cols, rows, offset, cell);
      // chipped, slightly irregular brick edges
      const d = cell.d - mortarW * 0.5 + chip[i] * 0.0025;
      const m = smoothstep(-0.0008, 0.0012, d); // 1 = brick face
      // per-brick tone and hue
      const r1 = rnd(cell.id, 11, c.seed), r2 = rnd(cell.id, 12, c.seed), r3 = rnd(cell.id, 13, c.seed);
      let tone = 1 + (r1 - 0.5) * 0.32 * variation;
      if (r3 < 0.07 * variation) tone *= 0.7; // occasional overfired brick
      const hue = (r2 - 0.5) * 0.12 * variation;
      const face = tone * (1 + low[i] * 0.12 + speck[i] * 0.08) * (0.88 + 0.12 * smoothstep(0, 0.01, d));
      const br = brickCol[0] * face * (1 + hue), bg = brickCol[1] * face * (1 - hue * 0.5), bb = brickCol[2] * face * (1 - hue);
      const mt = 1 + mortN[i] * 0.12 + low[i] * 0.05;
      const mr = mortarCol[0] * mt, mg = mortarCol[1] * mt, mb = mortarCol[2] * mt;
      setCol(c, i, mix(mr, br, m), mix(mg, bg, m), mix(mb, bb, m));
      c.h[i] = m * (0.006 + 0.003 * smoothstep(0, 0.004, d) + speck[i] * 0.0004) + mortN[i] * 0.0006;
      c.rough[i] = (1 - m) * 0.1 + speck[i] * 0.03;
    }
  }
  c.cavity = 70;
};

/** Dome profile for a voronoi cell: 1 at the cell point, 0 at its border, no medial-axis creases. */
function cellDome(f1: number, edge: number): number {
  const t = f1 / (f1 + Math.max(edge, 0) + 1e-9);
  return Math.sqrt(Math.max(0, 1 - t * t));
}

/**
 * Cut stone wall. style "ashlar" (default): courses of rectangular blocks of varying height/width with
 * chipped, rounded edges. style "rubble": irregular polygonal stones (warped voronoi).
 */
const paintStone: Painter = (c, p) => {
  const style = p.str("style", "ashlar");
  const rows = p.int("rows", style === "rubble" ? 5 : 6);
  const cols = p.int("cols", style === "rubble" ? 4 : 3);
  const jointW = p.num("mortarWidth", 0.01, 0, 0.1);
  const stoneCol = p.color(["stoneColor", "base", "stone"], hex("#a8a59e"));
  const mortarCol = p.color(["mortar", "mortarColor"], hex("#85817a"));
  const variation = p.num("variation", 1, 0, 3);
  const { size, n } = c;
  const wu = fbm(c, 6, 6, 3, 21), wv = fbm(c, 6, 6, 3, 22);
  const low = fbm(c, 8, 8, 5, 24);
  const fine = fbm(c, 64, 64, 3, 25);
  const chip = fbm(c, 32, 32, 2, 26);
  const ids = new Int32Array(n), edge = new Float32Array(n), dome = new Float32Array(n);

  if (style === "rubble") {
    const vor = voronoi(c, cols, rows, 0.85, 23, wu, wv, 0.03);
    for (let i = 0; i < n; i++) {
      ids[i] = vor.id[i];
      edge[i] = vor.edge[i];
      dome[i] = cellDome(vor.f1[i], vor.edge[i]);
    }
  } else {
    // course boundaries (random heights, normalized to the tile) and block boundaries per course
    const yb = new Float64Array(rows + 1);
    for (let r = 0; r < rows; r++) yb[r + 1] = yb[r] + 0.6 + rnd(r, 27, c.seed) * 0.8;
    for (let r = 0; r <= rows; r++) yb[r] /= yb[rows];
    const maxB = cols + 2;
    const xb = new Float64Array(rows * (maxB + 1));
    const nb = new Int32Array(rows), off = new Float64Array(rows);
    for (let r = 0; r < rows; r++) {
      nb[r] = Math.max(1, cols + Math.floor(rnd(r, 28, c.seed) * 3) - 1);
      off[r] = rnd(r, 29, c.seed);
      const o = r * (maxB + 1);
      for (let k = 0; k < nb[r]; k++) xb[o + k + 1] = xb[o + k] + 0.55 + rnd(r * 31 + k, 30, c.seed) * 0.9;
      for (let k = 0; k <= nb[r]; k++) xb[o + k] /= xb[o + nb[r]];
    }
    const rc = 0.012; // corner rounding radius (tile units)
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        const u = (x + 0.5) / size + wu[i] * 0.006, v = mod((y + 0.5) / size + wv[i] * 0.006, 1);
        let r = 0;
        while (r < rows - 1 && v >= yb[r + 1]) r++;
        const o = r * (maxB + 1);
        const uu = mod(u - off[r], 1);
        let k = 0;
        while (k < nb[r] - 1 && uu >= xb[o + k + 1]) k++;
        const dx = Math.min(uu - xb[o + k], xb[o + k + 1] - uu);
        const dy = Math.min(v - yb[r], yb[r + 1] - v);
        const d = dx < rc && dy < rc ? rc - Math.hypot(rc - dx, rc - dy) : Math.min(dx, dy);
        ids[i] = r * 64 + k;
        edge[i] = d;
        dome[i] = Math.sqrt(smoothstep(0, 0.05, d));
      }
    }
  }

  for (let i = 0; i < n; i++) {
    const id = ids[i];
    const e = edge[i] - jointW * 0.5 + chip[i] * 0.003;
    const m = smoothstep(-0.001, 0.0015, e);
    const r1 = rnd(id, 31, c.seed), r2 = rnd(id, 32, c.seed);
    const tone = 1 + (r1 - 0.5) * 0.3 * variation;
    const warm = (r2 - 0.5) * 0.1 * variation;
    const s = tone * (1 + low[i] * 0.12 + fine[i] * 0.07) * (0.86 + 0.14 * smoothstep(0, 0.02, e));
    const sr = stoneCol[0] * s * (1 + warm), sg = stoneCol[1] * s, sb = stoneCol[2] * s * (1 - warm);
    const mt = 1 + fine[i] * 0.15;
    setCol(c, i, mix(mortarCol[0] * mt, sr, m), mix(mortarCol[1] * mt, sg, m), mix(mortarCol[2] * mt, sb, m));
    // rock-faced stones: domed with rough surface
    c.h[i] = m * (0.006 + 0.008 * dome[i] + low[i] * 0.003 + fine[i] * 0.0012) + fine[i] * 0.0005;
    c.rough[i] = (1 - m) * 0.08 + fine[i] * 0.04;
  }
  c.cavity = 60;
};

/** Smooth trowelled plaster: near white, faint skim-coat ridges. */
const paintPlaster: Painter = (c, p) => {
  const base = p.color("base", hex("#efede8"));
  const strength = p.num("roughness", 1, 0, 4); // relief amount
  const low = fbm(c, 3, 3, 6, 41);
  const trowel = fbm(c, 5, 5, 4, 42);
  const fine = fbm(c, 96, 96, 2, 43);
  for (let i = 0; i < c.n; i++) {
    // contour steps of a low-frequency field look like overlapping trowel strokes
    const t = fract(trowel[i] * 4 + low[i] * 0.5);
    const ridge = smoothstep(0, 0.12, t) - t * 0.4;
    const shade = 1 + low[i] * 0.035 + fine[i] * 0.015 + ridge * 0.012;
    setCol(c, i, base[0] * shade, base[1] * shade, base[2] * shade);
    c.h[i] = strength * (ridge * 0.0005 + fine[i] * 0.00025 + low[i] * 0.0006);
    c.rough[i] = fine[i] * 0.04 - ridge * 0.03;
  }
  c.cavity = 20;
};

/** Poured concrete: blotchy gray, pores, faint formwork joints. */
const paintConcrete: Painter = (c, p) => {
  const base = p.color("base", hex("#c4c2bd"));
  const formLines = p.int("formLines", 2, 0, 16);
  const pores = p.int("pores", 700, 0, 20000);
  const { size } = c;
  const low = fbm(c, 3, 3, 6, 51, 0.55);
  const mid = fbm(c, 16, 16, 3, 52);
  const fine = fbm(c, 128, 128, 2, 53);
  const U = coords(size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      let s = 1 + low[i] * 0.09 + mid[i] * 0.04 + fine[i] * 0.03;
      let h = low[i] * 0.0008 + fine[i] * 0.0002;
      if (formLines > 0) {
        // horizontal panel joints + one vertical joint per tile
        const dv = Math.abs(fract(U[y] * formLines + 0.5) - 0.5) / formLines;
        const du = Math.abs(fract(U[x] + 0.5) - 0.5);
        const line = Math.max(1 - smoothstep(0.0008, 0.0025, dv), 1 - smoothstep(0.0008, 0.0025, du));
        s *= 1 - line * 0.07;
        h -= line * 0.0006;
      }
      setCol(c, i, base[0] * s, base[1] * s, base[2] * s);
      c.h[i] = h;
      c.rough[i] = fine[i] * 0.05;
    }
  }
  // pores / bug holes
  for (let k = 0; k < pores; k++) {
    const cu = rnd(k, 1, c.seed ^ 55), cv = rnd(k, 2, c.seed ^ 55);
    const r = 0.0012 + Math.pow(rnd(k, 3, c.seed ^ 55), 3) * 0.004;
    forDisc(size, cu, cv, r, (i, du, dv) => {
      const t = 1 - Math.sqrt(du * du + dv * dv) / r;
      const k2 = smoothstep(0, 0.5, t);
      c.h[i] -= k2 * r * 0.6;
      const kk = 1 - k2 * 0.3;
      c.col[i * 3] *= kk;
      c.col[i * 3 + 1] *= kk;
      c.col[i * 3 + 2] *= kk;
      c.rough[i] += k2 * 0.1;
    });
  }
  c.cavity = 50;
};

/** Shared wood colouring: annual rings (distorted by slow noise) plus fine pores and fibres. */
interface WoodFields {
  warp: Float32Array;
  warp2: Float32Array;
  pores: Float32Array;
  fiber: Float32Array;
  low: Float32Array;
}
function woodFields(c: Canvas, salt: number): WoodFields {
  return {
    warp: fbm(c, 1, 4, 3, salt + 1, 0.45), // very long along u, varies slowly across v
    warp2: fbm(c, 2, 2, 3, salt + 2),
    pores: fbm(c, 4, 192, 2, salt + 3), // fine streaks along u
    fiber: fbm(c, 2, 48, 3, salt + 4),
    low: fbm(c, 3, 3, 4, salt + 5),
  };
}
/** Latewood factor (0..1) of the last woodShade call. */
const wood = { late: 0 };
/** Shade (≈1) for ring coordinate t (one ring per unit). */
function woodShade(f: WoodFields, i: number, t: number, contrast: number): number {
  const r = fract(t);
  const late = smoothstep(0.55, 0.86, r) * (1 - smoothstep(0.9, 1, r));
  wood.late = late;
  return 1 + contrast * (-late * 0.24 - r * 0.06 + f.pores[i] * 0.07 + f.fiber[i] * 0.05 + f.low[i] * 0.04);
}

/** Floor planks along u with staggered butt joints. Default 6 planks per tile (≈20 cm at 1.2 m/tile). */
const paintWoodPlanks: Painter = (c, p) => {
  const rows = p.int("planks", 6);
  const joints = p.int("joints", 1, 1, 8); // butt joints per plank row per tile
  const gapW = p.num("gap", 0.0018, 0, 0.05);
  const woodCol = p.color(["wood", "base"], hex("#a8774a"));
  const contrast = p.num("contrast", 1, 0, 3);
  const variation = p.num("variation", 1, 0, 3);
  const density = p.num("rings", 70, 1, 1000); // rings per tile unit
  const { size } = c;
  const f = woodFields(c, 60);
  const U = coords(size);
  const W = 1 / rows, L = 1 / joints;
  for (let y = 0; y < size; y++) {
    const v = U[y];
    const fy = v * rows;
    const row = Math.floor(fy);
    const ly = fy - row;
    const off = rnd(row, 61, c.seed);
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const fx = U[x] * joints + off;
      const seg = mod(Math.floor(fx), joints);
      const lx = fract(fx);
      const id = mod(row, rows) * joints + seg;
      const dEdge = Math.min(Math.min(ly, 1 - ly) * W, Math.min(lx, 1 - lx) * L);
      const m = smoothstep(gapW * 0.5, gapW * 0.5 + 0.0012, dEdge);
      const r1 = rnd(id, 62, c.seed), r2 = rnd(id, 63, c.seed), r3 = rnd(id, 64, c.seed);
      // plank-local ring coordinate: flat-sawn planks show elongated "cathedral" arches, others straight rift grain
      const X = lx * L, Y = ly * W;
      const D = density * (0.75 + r2 * 0.5);
      let t: number;
      if (r3 < 0.65) {
        const xc = rnd(id, 65, c.seed) * L, yc = W * (0.5 + (rnd(id, 66, c.seed) - 0.5) * 2.4);
        const q = 0.06 + rnd(id, 67, c.seed) * 0.08;
        const dy = Y - yc, dx = q * (X - xc);
        t = Math.sqrt(dy * dy + dx * dx) * D;
      } else t = Y * D;
      t += f.warp[i] * 1.6 + f.warp2[i] * 0.4 + r1 * 7;
      const shade = woodShade(f, i, t, contrast);
      const tone = 1 + (r1 - 0.5) * 0.3 * variation;
      const hue = (r2 - 0.5) * 0.08 * variation;
      const s = shade * tone * (0.9 + 0.1 * m);
      const wr = woodCol[0] * s * (1 + hue), wg = woodCol[1] * s, wb = woodCol[2] * s * (1 - hue);
      const gk = 0.25; // gap colour (shadowed)
      setCol(c, i, mix(woodCol[0] * gk, wr, m), mix(woodCol[1] * gk, wg, m), mix(woodCol[2] * gk, wb, m));
      c.h[i] = m * 0.003 + smoothstep(0, 0.004, dEdge) * 0.0005 - wood.late * 0.00012 + f.pores[i] * 0.00006;
      c.rough[i] = (1 - m) * 0.2 + wood.late * 0.05 + f.pores[i] * 0.03;
    }
  }
  c.cavity = 70;
};

/** Continuous grain (furniture, doors). Grain runs along u; params.vertical = 1 rotates it. */
const paintWoodGrain: Painter = (c, p) => {
  const woodCol = p.color(["wood", "base"], hex("#a8774a"));
  const rings = p.int("rings", 40, 1, 1000); // integer → periodic across the tile
  const contrast = p.num("contrast", 1, 0, 3);
  const { size } = c;
  const f = woodFields(c, 70);
  const U = coords(size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const t = U[y] * rings + f.warp[i] * 2.5 + f.warp2[i] * 0.8;
      const s = woodShade(f, i, t, contrast);
      setCol(c, i, woodCol[0] * s, woodCol[1] * s, woodCol[2] * s);
      c.h[i] = -wood.late * 0.00015 * contrast + f.pores[i] * 0.00008 * contrast;
      c.rough[i] = wood.late * 0.05 + f.pores[i] * 0.03;
    }
  }
  if (p.num("vertical", 0) > 0) transpose(c);
  c.cavity = 30;
};

/** Square ceramic tiles with grout. count = tiles per tile-edge; cols/rows/offset override. */
const paintTiles: Painter = (c, p) => {
  const count = p.int("count", 4);
  const cols = p.int("cols", count), rows = p.int("rows", count);
  const offset = p.num("offset", 0, 0, 1);
  const groutW = p.num("groutWidth", 0.006, 0, 0.1);
  const tileCol = p.color(["tile", "base", "tileColor"], hex("#f0f0ee"));
  const groutCol = p.color(["grout", "groutColor"], hex("#b4b2ac"));
  const variation = p.num("variation", 1, 0, 4);
  const { size } = c;
  const wav = fbm(c, 4, 4, 3, 81);
  const fine = fbm(c, 96, 96, 2, 82);
  const U = coords(size);
  const cell = newCell();
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      rectCell(U[x], U[y], cols, rows, offset, cell);
      const d = cell.d - groutW * 0.5;
      const m = smoothstep(-0.0005, 0.0008, d);
      const r1 = rnd(cell.id, 83, c.seed);
      const tone = (1 + (r1 - 0.5) * 0.06 * variation) * (1 + wav[i] * 0.015 * variation);
      const gt = 1 + fine[i] * 0.1;
      setCol(c, i, mix(groutCol[0] * gt, tileCol[0] * tone, m), mix(groutCol[1] * gt, tileCol[1] * tone, m), mix(groutCol[2] * gt, tileCol[2] * tone, m));
      // rounded tile edge + faint glaze waviness (per-tile tilt so reflections break up)
      const tilt = (rnd(cell.id, 84, c.seed) - 0.5) * 0.002 * (cell.lx - 0.5) + (rnd(cell.id, 85, c.seed) - 0.5) * 0.002 * (cell.ly - 0.5);
      c.h[i] = m * (0.002 + 0.0015 * Math.sqrt(smoothstep(0, 0.003, d)) + wav[i] * 0.00015 + tilt) + fine[i] * 0.0001 * (1 - m);
      c.rough[i] = (1 - m) * 0.55 + m * wav[i] * 0.03;
    }
  }
  c.cavity = 60;
};

/** Polished marble: near-white cloudy base with warped veins. params.base / params.vein recolour (e.g. black marble). */
const paintMarble: Painter = (c, p) => {
  const base = p.color("base", hex("#efefed"));
  const veinCol = p.color(["vein", "veinColor"], hex("#7e8288"));
  const veins = p.num("veins", 1, 0, 3);
  const { size } = c;
  // warp gain < 0.5 keeps the warp gradient small so veins stay long instead of curling into islands
  const w1 = fbm(c, 1, 1, 6, 91, 0.4);
  const w2 = fbm(c, 1, 2, 7, 92, 0.45);
  const mask = fbm(c, 2, 2, 3, 95);
  const cloud = fbm(c, 3, 3, 5, 93);
  const crack = fbm(c, 2, 2, 6, 94, 0.45);
  const U = coords(size);
  const TAU = Math.PI * 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = U[x], v = U[y];
      // integer direction coefficients keep sin() periodic over the tile
      const a = Math.abs(Math.sin(TAU * (u + v + w1[i] * 0.42)));
      const b = Math.abs(Math.sin(TAU * (2 * u - v + w2[i] * 0.35 + 0.3)));
      const main = Math.pow(1 - a, 10) * 0.45 + Math.pow(1 - a, 60) * 0.45;
      const minor = Math.pow(1 - b, 40) * 0.5 * smoothstep(-0.2, 0.3, mask[i]);
      const hc = Math.abs(Math.sin(TAU * (u - 2 * v + crack[i] * 0.5)));
      const hair = Math.pow(1 - hc, 70) * 0.3 * smoothstep(0, 0.4, -mask[i]);
      const vein = clamp01((main + minor + hair) * veins);
      const soft = Math.pow(1 - a, 3) * 0.1 * veins; // diffuse halo around veins
      const cl = 1 + cloud[i] * 0.05 - soft * 0.6;
      const r = mix(base[0] * cl, veinCol[0], vein), g = mix(base[1] * cl, veinCol[1], vein), bb = mix(base[2] * cl, veinCol[2], vein);
      setCol(c, i, r, g, bb);
      c.h[i] = -vein * 0.00008 + cloud[i] * 0.00005;
      c.rough[i] = vein * 0.06;
    }
  }
  c.cavity = 0;
};

/** Overlapping clay barrel tiles (terracotta). rows = courses per tile, cols = tiles across. */
const paintRoofTiles: Painter = (c, p) => {
  const cols = p.int("cols", 5), rows = p.int("rows", 4);
  const offset = p.num("offset", 0, 0, 1);
  const tileCol = p.color(["tile", "base", "tileColor"], hex("#b65a36"));
  const bulge = p.num("bulge", 0.18, 0, 0.6); // how far the curved lower edge hangs (fraction of a course)
  const variation = p.num("variation", 1, 0, 3);
  const { size } = c;
  const low = fbm(c, 5, 5, 5, 101);
  const fine = fbm(c, 64, 64, 3, 102);
  const dirt = fbm(c, 16, 2, 4, 103); // vertical rain streaks running down the slope
  const U = coords(size);
  const tileW = 1 / cols;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const fy = U[y] * rows;
      let r = Math.floor(fy);
      let ly = fy - r;
      // course r-1's tiles hang down over course r with an arched lower edge
      const lxPrev = fract(U[x] * cols + fract(mod(r - 1, rows) * offset));
      const hang = bulge * Math.sin(Math.PI * lxPrev);
      let covered = false;
      if (ly < hang) {
        r -= 1;
        ly += 1;
        covered = true;
      }
      const row = mod(r, rows);
      const fx = U[x] * cols + fract(row * offset);
      const col = mod(Math.floor(fx), cols);
      const lx = fract(fx);
      const id = row * cols + col;
      const myHang = bulge * Math.sin(Math.PI * lx);
      const bottom = 1 + myHang; // lower edge of this tile in ly units
      // barrel cross-section + slope up toward the lower (exposed) edge
      const prof = Math.sqrt(Math.max(0, Math.sin(Math.PI * lx)));
      const edgeRound = smoothstep(0, 0.06, bottom - ly);
      const hgt = (prof * 0.12 + ly * 0.06) * edgeRound * tileW;
      // shadow cast by the course above onto this one
      const below = covered ? 1 : ly - hang;
      const shadow = 0.55 + 0.45 * smoothstep(0, 0.35, below);
      const sideShade = 0.75 + 0.25 * prof;
      const r1 = rnd(id, 104, c.seed), r2 = rnd(id, 105, c.seed);
      const tone = (1 + (r1 - 0.5) * 0.3 * variation) * (1 + low[i] * 0.08 + fine[i] * 0.06) * (1 - Math.max(0, dirt[i]) * 0.18);
      const hue = (r2 - 0.5) * 0.12 * variation;
      const s = tone * sideShade;
      setCol(c, i, tileCol[0] * s * (1 + hue), tileCol[1] * s, tileCol[2] * s * (1 - hue));
      c.h[i] = hgt + fine[i] * 0.0004;
      c.ao[i] = shadow * (0.8 + 0.2 * prof);
      c.rough[i] = fine[i] * 0.04;
    }
  }
  c.cavity = 40;
};

/** Asphalt / architectural shingles: courses with randomly cut tabs, granular surface. */
const paintShingles: Painter = (c, p) => {
  const rows = p.int("rows", 8);
  const tabs = p.int("tabs", 4);
  const jitterW = p.num("jitter", 0.35, 0, 0.9);
  const slotW = p.num("slot", 0.004, 0, 0.05);
  const base = p.color(["base", "shingleColor"], hex("#6a6866"));
  const variation = p.num("variation", 1, 0, 3);
  const { size } = c;
  const gran = fbm(c, 160, 160, 2, 111);
  const granC = fbm(c, 200, 200, 1, 112);
  const low = fbm(c, 4, 4, 4, 113);
  const U = coords(size);
  const cuts = new Float32Array(rows * tabs);
  for (let r = 0; r < rows; r++) {
    const off = rnd(r, 114, c.seed);
    for (let t = 0; t < tabs; t++) cuts[r * tabs + t] = off + (t + (rnd(r * tabs + t, 115, c.seed) - 0.5) * jitterW) / tabs;
  }
  for (let y = 0; y < size; y++) {
    const fy = U[y] * rows;
    const row = Math.floor(fy);
    const ly = fy - row;
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = U[x];
      // find the tab containing u (cuts are sorted modulo 1)
      let tab = tabs - 1, dCut = 1;
      for (let t = 0; t < tabs; t++) {
        const du = mod(u - cuts[row * tabs + t], 1);
        const dd = Math.min(du, 1 - du);
        if (dd < dCut) dCut = dd;
      }
      for (let t = 0; t < tabs; t++) {
        if (mod(u - cuts[row * tabs + t], 1) < mod(u - cuts[row * tabs + ((t + tabs - 1) % tabs)], 1)) tab = t;
      }
      const id = row * tabs + tab;
      // slots between tabs expose the darker shingle beneath (only on the lower part of the course)
      const slot = (1 - smoothstep(slotW * 0.5, slotW * 0.5 + 0.0012, dCut)) * smoothstep(0.25, 0.35, ly);
      const r1 = rnd(id, 116, c.seed), r2 = rnd(id, 117, c.seed);
      const tone = (1 + (r1 - 0.5) * 0.35 * variation) * (1 + gran[i] * 0.22 + low[i] * 0.06);
      const tint = granC[i] * 0.08;
      const s = tone * (1 - slot * 0.65) * (0.7 + 0.3 * smoothstep(0, 0.25, ly)); // shadow under course above
      setCol(c, i, base[0] * s * (1 + tint + (r2 - 0.5) * 0.06), base[1] * s, base[2] * s * (1 - tint));
      c.h[i] = (ly * 0.004 + gran[i] * 0.0002) * (1 - slot * 0.8) * smoothstep(1, 0.97, ly) / rows * 8;
      c.ao[i] = 0.6 + 0.4 * smoothstep(0, 0.2, ly);
      c.rough[i] = gran[i] * 0.05;
    }
  }
  c.cavity = 40;
};

/**
 * Brushed metal: fine streaks along u. Optional profiles for roofing / cladding:
 * params.seams = standing seams per tile (raised ribs along v), params.corrugated = waves per tile.
 */
const paintMetal: Painter = (c, p) => {
  const base = p.color("base", hex("#d9dadc"));
  const brush = p.num("brush", 1, 0, 4);
  const seams = p.int("seams", 0, 0, 64);
  const corr = p.int("corrugated", 0, 0, 256);
  const { size } = c;
  const streak = fbm(c, 2, 256, 2, 121);
  const streak2 = fbm(c, 1, 64, 3, 122);
  const low = fbm(c, 3, 3, 4, 123);
  const U = coords(size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = U[x];
      let h = brush * streak[i] * 0.00003;
      let shade = 1;
      if (seams > 0) {
        const d = Math.abs(fract(u * seams + 0.5) - 0.5) / seams; // distance to nearest seam (tile units)
        const rib = 1 - smoothstep(0.004, 0.009, d);
        h += rib * 0.02 * Math.sqrt(1 - Math.min(1, d / 0.009)) - smoothstep(0.009, 0.03, d) * 0.0005;
        shade *= 1 - (1 - smoothstep(0.009, 0.02, d)) * (1 - rib) * 0.15;
      }
      if (corr > 0) h += Math.sin(u * corr * Math.PI * 2) * (0.12 / corr); // depth/pitch ≈ 0.24, like real sheet
      const s = (1 + brush * (streak[i] * 0.05 + streak2[i] * 0.03) + low[i] * 0.025) * shade;
      setCol(c, i, base[0] * s, base[1] * s, base[2] * s);
      c.h[i] = h;
      c.rough[i] = brush * (streak[i] * 0.05 + streak2[i] * 0.03) + low[i] * 0.03;
    }
  }
  c.cavity = seams > 0 || corr > 0 ? 30 : 0;
};

/** Plain-weave fabric. threads = threads per tile edge (even). */
const paintFabric: Painter = (c, p) => {
  let N = p.int("threads", 64, 2, 1024);
  N += N & 1;
  const base = p.color("base", hex("#e6e4df"));
  const { size } = c;
  const slub = fbm(c, 4, 48, 2, 131);
  const slub2 = fbm(c, 48, 4, 2, 132);
  const low = fbm(c, 4, 4, 4, 133);
  const fuzz = fbm(c, 192, 192, 1, 134);
  const U = coords(size);
  for (let y = 0; y < size; y++) {
    const fv = U[y] * N;
    const j = Math.floor(fv);
    const lv = fv - j;
    const rw = rnd(j, 135, c.seed);
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const fu = U[x] * N;
      const k = Math.floor(fu);
      const lu = fu - k;
      const warpOver = ((k + j) & 1) === 0;
      // thread cross-sections: warp runs along v (varies with lu), weft along u (varies with lv)
      const cw = Math.sqrt(Math.max(0, 1 - Math.pow((lu - 0.5) / 0.46, 2)));
      const cf = Math.sqrt(Math.max(0, 1 - Math.pow((lv - 0.5) / 0.46, 2)));
      const archW = warpOver ? 0.55 + 0.45 * Math.sin(Math.PI * lv) : 0.35;
      const archF = warpOver ? 0.35 : 0.55 + 0.45 * Math.sin(Math.PI * lu);
      const hw = cw * archW, hf = cf * archF;
      const top = hw > hf;
      const hgt = Math.max(hw, hf);
      const rt = top ? rnd(k, 136, c.seed) : rw;
      const sl = top ? slub[i] : slub2[i];
      const s = (0.72 + 0.28 * hgt) * (1 + (rt - 0.5) * 0.08 + sl * 0.08 + low[i] * 0.04 + fuzz[i] * 0.04);
      setCol(c, i, base[0] * s, base[1] * s, base[2] * s);
      c.h[i] = (hgt * 0.5 + fuzz[i] * 0.03) / N;
      c.rough[i] = fuzz[i] * 0.04;
    }
  }
  c.cavity = 0;
};

/** Cut-pile carpet: fine noise. */
const paintCarpet: Painter = (c, p) => {
  const base = p.color("base", hex("#e2ddd4"));
  const fine = fbm(c, 220, 220, 1, 141);
  const mid = fbm(c, 64, 64, 2, 142);
  const low = fbm(c, 4, 4, 4, 143);
  for (let i = 0; i < c.n; i++) {
    const s = 1 + fine[i] * 0.12 + mid[i] * 0.05 + low[i] * 0.04;
    setCol(c, i, base[0] * s, base[1] * s, base[2] * s);
    c.h[i] = fine[i] * 0.0006 + mid[i] * 0.0003;
    c.rough[i] = 0;
  }
  c.cavity = 80;
  c.cavityRadius = 0.004;
};

/** Pebble-grain leather: small voronoi bumps with creases plus soft wrinkles. */
const paintLeather: Painter = (c, p) => {
  const base = p.color("base", hex("#7a4b2c"));
  const cells = p.int("cells", 48, 4, 512);
  const wu = fbm(c, 8, 8, 2, 151), wv = fbm(c, 8, 8, 2, 152);
  const vor = voronoi(c, cells, cells, 0.9, 153, wu, wv, 0.004);
  const low = fbm(c, 4, 4, 5, 154);
  const wrinkle = fbm(c, 6, 6, 4, 155);
  const cr = 0.5 / cells;
  for (let i = 0; i < c.n; i++) {
    const e = vor.edge[i] / cr; // 0 at crease, ~1 at cell centre
    const bump = Math.sqrt(smoothstep(0, 0.6, e));
    const wr = Math.abs(fract(wrinkle[i] * 3) - 0.5) * 2;
    const wk = 1 - smoothstep(0, 0.12, wr);
    const s = (1 + low[i] * 0.12) * (0.82 + 0.18 * bump) * (1 - wk * 0.08) * (1 + (rnd(vor.id[i], 156, c.seed) - 0.5) * 0.06);
    setCol(c, i, base[0] * s, base[1] * s, base[2] * s);
    c.h[i] = bump * cr * 0.25 - wk * 0.0006 + low[i] * 0.0004;
    c.rough[i] = (1 - bump) * 0.1 - low[i] * 0.04;
  }
  c.cavity = 30;
};

/** Top-down lawn: dense random blades over a darker ground layer. */
const paintGrass: Painter = (c, p) => {
  const base = p.color(["base", "grass"], hex("#5c8a32"));
  const blades = p.int("blades", 14000, 100, 200000);
  const { size } = c;
  const low = fbm(c, 4, 4, 5, 161);
  const fine = fbm(c, 64, 64, 2, 162);
  for (let i = 0; i < c.n; i++) {
    const s = 0.5 + low[i] * 0.05 + fine[i] * 0.05;
    setCol(c, i, base[0] * s * 1.05, base[1] * s * 0.9, base[2] * s * 0.8);
    c.h[i] = fine[i] * 0.0004;
    c.ao[i] = 0.8;
  }
  // blades: tapered strokes, darker at the root and lighter / yellower at the tip
  for (let k = 0; k < blades; k++) {
    const s = c.seed ^ 163;
    const cu = rnd(k, 1, s), cv = rnd(k, 2, s);
    const ang = rnd(k, 3, s) * Math.PI * 2;
    const len = 0.012 + rnd(k, 4, s) * 0.022;
    const wid = 0.0012 + rnd(k, 5, s) * 0.0012;
    const tone = 0.75 + rnd(k, 6, s) * 0.5 + sample(low, size, cu, cv) * 0.2;
    const yel = rnd(k, 7, s) < 0.12 ? 0.25 : rnd(k, 8, s) * 0.08; // some dry blades
    const dx = Math.cos(ang), dy = Math.sin(ang);
    const layer = rnd(k, 9, s);
    forDisc(size, cu + dx * len * 0.5, cv + dy * len * 0.5, len * 0.5 + wid, (i, du, dv) => {
      // project onto blade axis (t: 0 root .. 1 tip)
      const along = du * dx + dv * dy + len * 0.5;
      const t = along / len;
      if (t < 0 || t > 1) return;
      const across = Math.abs(-du * dy + dv * dx);
      const w = wid * (1 - t * 0.85);
      if (across > w) return;
      const hh = 0.001 + t * 0.003 + layer * 0.002;
      if (hh < c.h[i]) return; // keep the topmost blade
      const prof = 1 - across / w;
      const sh = tone * (0.85 + 0.45 * t) * (0.85 + 0.15 * prof);
      setCol(c, i, base[0] * sh * (1 + yel * 1.5), base[1] * sh * (1 + yel * 0.3), base[2] * sh * (1 - yel * 2));
      c.h[i] = hh + prof * wid * 0.3;
      c.ao[i] = 0.75 + 0.25 * t;
    });
  }
  c.cavity = 40;
  c.cavityRadius = 0.006;
};

/** Loose gravel: rounded pebbles of mixed stone colours. */
const paintGravel: Painter = (c, p) => {
  const stones = p.int("stones", 26, 2, 512);
  const base = p.color("base", hex("#b0aba2"));
  const wu = fbm(c, 8, 8, 3, 171), wv = fbm(c, 8, 8, 3, 172);
  const vor = voronoi(c, stones, stones, 0.9, 173, wu, wv, 0.25 / stones);
  const fine = fbm(c, 96, 96, 2, 174);
  const low = fbm(c, 4, 4, 4, 175);
  const cr = 0.5 / stones;
  const palette: RGB[] = [hex("#ffffff"), hex("#e4dccf"), hex("#c9c4bb"), hex("#efe3d0"), hex("#aaa298"), hex("#d9c6ad")];
  for (let i = 0; i < c.n; i++) {
    const id = vor.id[i];
    // rounded pebble: radial coordinate t (0 centre → 1 cell border), blended toward a circle
    const f1 = vor.f1[i], e = Math.max(0, vor.edge[i]);
    const R = mix(f1 + e, cr, 0.25);
    const t = f1 / R;
    const size01 = 0.88 + rnd(id, 176, c.seed) * 0.1; // pebble radius relative to its cell (gap between pebbles)
    const tt = t / size01;
    const m = 1 - smoothstep(0.9, 1.0, tt);
    const dome = Math.sqrt(Math.max(0, 1 - tt * tt));
    const pc = palette[Math.floor(rnd(id, 177, c.seed) * palette.length)];
    const tone = (0.72 + rnd(id, 178, c.seed) * 0.36) * (1 + fine[i] * 0.12) * (0.8 + 0.2 * dome);
    const gr = 0.5 + low[i] * 0.05; // sandy ground between pebbles
    setCol(c, i, mix(base[0] * gr, base[0] * pc[0] * tone, m), mix(base[1] * gr, base[1] * pc[1] * tone, m), mix(base[2] * gr * 0.92, base[2] * pc[2] * tone, m));
    c.h[i] = m * dome * cr * 0.7 * (0.7 + rnd(id, 179, c.seed) * 0.6) + fine[i] * 0.0003;
    c.rough[i] = (1 - m) * 0.1 + fine[i] * 0.04;
  }
  c.cavity = 50;
  c.cavityRadius = 0.008;
};

/** Paving: style "squares" (slabs, default), "bricks" (running-bond pavers) or "flagstone" (irregular). */
const paintPaving: Painter = (c, p) => {
  const style = p.str("style", "squares");
  const jointW = p.num("jointWidth", style === "flagstone" ? 0.014 : 0.006, 0, 0.1);
  const stoneCol = p.color(["base", "stone", "paverColor"], style === "bricks" ? hex("#a55b42") : hex("#b3aea5"));
  const jointCol = p.color(["joint", "jointColor"], hex("#6f6a62"));
  const variation = p.num("variation", 1, 0, 3);
  const { size } = c;
  const low = fbm(c, 6, 6, 5, 181);
  const fine = fbm(c, 80, 80, 3, 182);
  const chip = fbm(c, 24, 24, 3, 183);
  let ids: Int32Array, dist: Float32Array;
  if (style === "flagstone") {
    const wu = fbm(c, 4, 4, 3, 184), wv = fbm(c, 4, 4, 3, 185);
    const vor = voronoi(c, p.int("cols", 4), p.int("rows", 4), 0.9, 186, wu, wv, 0.05);
    ids = vor.id;
    dist = vor.edge;
  } else {
    const bricks = style === "bricks";
    const cols = p.int("cols", bricks ? 5 : p.int("count", 2)), rows = p.int("rows", bricks ? 10 : p.int("count", 2));
    const offset = p.num("offset", bricks ? 0.5 : 0, 0, 1);
    ids = new Int32Array(c.n);
    dist = new Float32Array(c.n);
    const U = coords(size);
    const cell = newCell();
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        rectCell(U[x], U[y], cols, rows, offset, cell);
        ids[y * size + x] = cell.id;
        dist[y * size + x] = cell.d;
      }
  }
  for (let i = 0; i < c.n; i++) {
    const id = ids[i];
    const d = dist[i] - jointW * 0.5 + chip[i] * 0.002;
    const m = smoothstep(-0.0008, 0.0012, d);
    const r1 = rnd(id, 187, c.seed), r2 = rnd(id, 188, c.seed);
    const tone = (1 + (r1 - 0.5) * 0.25 * variation) * (1 + low[i] * 0.1 + fine[i] * 0.07) * (0.9 + 0.1 * smoothstep(0, 0.008, d));
    const warm = (r2 - 0.5) * 0.06 * variation;
    const jt = 1 + fine[i] * 0.2;
    setCol(c, i, mix(jointCol[0] * jt, stoneCol[0] * tone * (1 + warm), m), mix(jointCol[1] * jt, stoneCol[1] * tone, m), mix(jointCol[2] * jt, stoneCol[2] * tone * (1 - warm), m));
    c.h[i] = m * (0.005 + 0.002 * smoothstep(0, 0.006, d) + low[i] * 0.0012 + fine[i] * 0.0004) + fine[i] * 0.0006 * (1 - m);
    c.rough[i] = (1 - m) * 0.1 + fine[i] * 0.04;
  }
  c.cavity = 60;
};

/** Horizontal clapboard / lap siding: each board overlaps the one below, casting a shadow line. */
const paintSiding: Painter = (c, p) => {
  const boards = p.int("boards", 8);
  const base = p.color("base", hex("#efeeea"));
  const grain = p.num("grain", 1, 0, 4);
  const { size } = c;
  const streak = fbm(c, 3, 96, 3, 191);
  const low = fbm(c, 4, 4, 4, 192);
  const U = coords(size);
  for (let y = 0; y < size; y++) {
    const fy = U[y] * boards;
    const row = Math.floor(fy);
    const ly = fy - row; // 0 = top of board (tucked under the board above), 1 = exposed lower edge
    const tone = 1 + (rnd(row, 193, c.seed) - 0.5) * 0.03;
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const lip = smoothstep(1, 0.93, ly); // rounded lower edge
      const thick = (0.3 + 0.7 * ly) * lip + (1 - lip) * 0.3;
      const shadow = 0.6 + 0.4 * smoothstep(0, 0.18, ly);
      const s = tone * (1 + streak[i] * 0.03 * grain + low[i] * 0.025) * (0.96 + 0.04 * ly);
      setCol(c, i, base[0] * s, base[1] * s, base[2] * s);
      c.h[i] = (thick * 0.02 + streak[i] * 0.0002 * grain) / boards * 0.8;
      c.ao[i] = shadow;
      c.rough[i] = streak[i] * 0.03;
    }
  }
  c.cavity = 20;
};

/** Transpose all canvas channels (rotates a pattern by 90°, mirrored). */
function transpose(c: Canvas) {
  const s = c.size;
  const swap1 = (a: Float32Array) => {
    for (let y = 0; y < s; y++)
      for (let x = y + 1; x < s; x++) {
        const i = y * s + x, j = x * s + y;
        const t = a[i];
        a[i] = a[j];
        a[j] = t;
      }
  };
  swap1(c.h);
  swap1(c.rough);
  swap1(c.ao);
  for (let y = 0; y < s; y++)
    for (let x = y + 1; x < s; x++) {
      const i = (y * s + x) * 3, j = (x * s + y) * 3;
      for (let k = 0; k < 3; k++) {
        const t = c.col[i + k];
        c.col[i + k] = c.col[j + k];
        c.col[j + k] = t;
      }
    }
}


/**
 * Enamelled steel discs on a dark backing (the Kuwait Towers spheres): staggered rows of slightly
 * domed, glossy discs, each picking a shade from `palette` ("#hex,#hex,..."). Knobs: cols, rows,
 * size (disc diameter relative to the spacing), jitter (random size variation 0..0.6), background.
 */
const paintDisks: Painter = (c, p) => {
  const cols = p.int("cols", 6, 1, 64);
  const rows = Math.max(2, Math.round(p.int("rows", cols, 1, 64) / 2) * 2); // even, so the stagger wraps
  const fill = p.num("size", 0.9, 0.3, 1.0);
  const jitter = p.num("jitter", 0, 0, 0.6);
  const bg = p.color(["background", "base"], hex("#20292e"));
  const listed = p
    .str("palette", "")
    .split(/[,;\s]+/)
    .map((x) => parseColor(x))
    .filter((x): x is RGB => !!x);
  const palette = listed.length
    ? listed
    : ["#1d4d68", "#276a86", "#3a87a1", "#5ea7b8", "#2b6656", "#4c8c78", "#73868f", "#a7b6bd"].map(hex);
  const fine = fbm(c, 64, 64, 2, 191);
  for (let i = 0; i < c.n; i++) {
    setCol(c, i, bg[0], bg[1], bg[2]);
    c.h[i] = 0;
    c.rough[i] = 0.15;
    c.ao[i] = 0.75;
  }
  const r = (0.5 * fill) / Math.max(cols, rows);
  for (let j = 0; j < rows; j++) {
    const v = (j + 0.5) / rows;
    const offset = (j % 2) * (0.5 / cols);
    for (let k = 0; k < cols; k++) {
      const u = (k + 0.5) / cols + offset;
      const id = j * 1000 + k;
      const pc = palette[Math.floor(rnd(id, 192, c.seed) * palette.length)];
      const tone = 0.9 + rnd(id, 193, c.seed) * 0.2;
      const rd = r * (1 - jitter * rnd(id, 194, c.seed));
      forDisc(c.size, u, v, rd, (i, du, dv) => {
        const d = Math.sqrt(du * du + dv * dv) / rd;
        const dome = Math.sqrt(Math.max(0, 1 - d * d));
        // glossy enamel: brighter toward the top-left, thin darker rim
        const light = 0.82 + 0.22 * dome + 0.12 * Math.max(0, (-du - dv) / rd) - 0.25 * smoothstep(0.88, 1, d);
        const t = tone * light * (1 + fine[i] * 0.04);
        setCol(c, i, pc[0] * t, pc[1] * t, pc[2] * t);
        c.h[i] = rd * (0.25 + 0.15 * dome);
        c.rough[i] = -0.35;
        c.ao[i] = 1;
      });
    }
  }
  c.cavity = 30;
  c.cavityRadius = 0.01;
};

const PAINTERS: Record<TexturePattern, Painter> = {
  none: paintNone,
  brick: paintBrick,
  stone: paintStone,
  plaster: paintPlaster,
  concrete: paintConcrete,
  wood_planks: paintWoodPlanks,
  wood_grain: paintWoodGrain,
  tiles: paintTiles,
  marble: paintMarble,
  roof_tiles: paintRoofTiles,
  shingles: paintShingles,
  metal: paintMetal,
  fabric: paintFabric,
  carpet: paintCarpet,
  leather: paintLeather,
  grass: paintGrass,
  gravel: paintGravel,
  paving: paintPaving,
  siding: paintSiding,
  disks: paintDisks,
};

// ---------------------------------------------------------------------------
// Post-processing: normals, cavity AO, packing
// ---------------------------------------------------------------------------

/** Separable wrap-around box blur (radius in pixels), run twice for a smoother kernel. */
function boxBlur(src: Float32Array, size: number, radius: number): Float32Array {
  if (radius < 1) return src.slice();
  let a = src.slice();
  const b = new Float32Array(src.length);
  const w = 2 * radius + 1;
  for (let pass = 0; pass < 2; pass++) {
    // horizontal
    for (let y = 0; y < size; y++) {
      const row = y * size;
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += a[row + mod(k, size)];
      for (let x = 0; x < size; x++) {
        b[row + x] = sum / w;
        sum += a[row + mod(x + radius + 1, size)] - a[row + mod(x - radius, size)];
      }
    }
    // vertical
    for (let x = 0; x < size; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += b[mod(k, size) * size + x];
      for (let y = 0; y < size; y++) {
        a[y * size + x] = sum / w;
        sum += b[mod(y + radius + 1, size) * size + x] - b[mod(y - radius, size) * size + x];
      }
    }
  }
  return a;
}

/** Fraction of the occlusion that is also multiplied into the base color. */
const ALBEDO_AO = 0.35;

function seedFor(mat: MaterialDef): number {
  const params = mat.params ?? {};
  const keys = Object.keys(params).sort();
  return hashString(mat.pattern + "|" + keys.map((k) => `${k}=${params[k]}`).join(","));
}

/**
 * Generate seamlessly tileable baseColor / normal / ORM textures (RGBA8, size × size) for a material.
 * Deterministic for a given pattern + params; the tint (`color`), roughness, metalness, opacity and
 * normalStrength are applied on top.
 */
export function generateTextures(mat: MaterialDef, size = 512): TextureSet {
  size = Math.max(4, Math.round(size));
  const c = makeCanvas(size, seedFor(mat));
  const painter = PAINTERS[mat.pattern] ?? paintNone;
  painter(c, new Params(mat.params));

  const n = c.n;
  const baseColor = new Uint8Array(n * 4);
  const normal = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const tint = mat.color ?? [1, 1, 1];
  const alpha = Math.round(clamp01(mat.opacity ?? 1) * 255);
  const rough0 = clamp01(mat.roughness ?? 0.8);
  const metal = Math.round(clamp01(mat.metalness ?? 0) * 255);
  const strength = mat.normalStrength ?? 1;

  // cavity occlusion: how far each pixel sits below its blurred neighbourhood
  // (scaled with the bump strength so flattened materials don't get dark crevices)
  const cavityK = c.cavity * Math.min(1, strength);
  const blurred = cavityK > 0 ? boxBlur(c.h, size, Math.max(1, Math.round(c.cavityRadius * size * 0.5))) : undefined;

  for (let i = 0; i < n; i++) {
    const k = i * 4;
    let ao = c.ao[i];
    if (blurred) ao *= 1 - clamp01((blurred[i] - c.h[i]) * cavityK);
    ao = clamp(ao, 0.15, 1);
    // bake part of the occlusion into albedo too: many engines/viewers only apply AO to ambient light
    const bake = 1 - ALBEDO_AO * (1 - ao);
    baseColor[k] = Math.round(clamp01(c.col[i * 3] * tint[0] * bake) * 255);
    baseColor[k + 1] = Math.round(clamp01(c.col[i * 3 + 1] * tint[1] * bake) * 255);
    baseColor[k + 2] = Math.round(clamp01(c.col[i * 3 + 2] * tint[2] * bake) * 255);
    baseColor[k + 3] = alpha;
    orm[k] = Math.round(ao * 255);
    orm[k + 1] = Math.round(clamp(rough0 + c.rough[i], 0.02, 1) * 255);
    orm[k + 2] = metal;
    orm[k + 3] = 255;
  }

  // normals: wrap-around Sobel on height (tile units) → slope per tile unit; OpenGL (+Y up) convention
  const h = c.h;
  const scale = (size / 8) * strength;
  for (let y = 0; y < size; y++) {
    const ym = mod(y - 1, size) * size, y0 = y * size, yp = mod(y + 1, size) * size;
    for (let x = 0; x < size; x++) {
      const xm = mod(x - 1, size), xp = mod(x + 1, size);
      const dx = h[ym + xp] + 2 * h[y0 + xp] + h[yp + xp] - (h[ym + xm] + 2 * h[y0 + xm] + h[yp + xm]);
      const dy = h[yp + xm] + 2 * h[yp + x] + h[yp + xp] - (h[ym + xm] + 2 * h[ym + x] + h[ym + xp]);
      // image y grows downward while tangent +Y points up the image: ny = +dh/dy(image)
      const nx = -dx * scale, ny = dy * scale;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      const k = (y0 + x) * 4;
      normal[k] = Math.round((nx * inv * 0.5 + 0.5) * 255);
      normal[k + 1] = Math.round((ny * inv * 0.5 + 0.5) * 255);
      normal[k + 2] = Math.round((inv * 0.5 + 0.5) * 255);
      normal[k + 3] = 255;
    }
  }
  return { size, baseColor, normal, orm };
}
