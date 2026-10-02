/**
 * Headless software renderer: SceneNode -> RGBA pixels -> PNG.
 *
 * Pure JS (typed arrays only). Z-buffer triangle rasterizer with near-plane
 * clipping, perspective-correct attributes, trilinear-mipmapped wrapping
 * textures, hemispheric + sun lighting, alpha-blended transparency, supersample
 * anti-aliasing, outline post-process and horizontal cutaway (`clipZ`) with
 * dark section caps where walls are cut.
 *
 * World space is Z-up, meters (x = east, y = north).
 */
import pngjs from "pngjs";
import { m4, type Mat4, type Vec3 } from "../geometry/math.js";
import type { MeshData } from "../geometry/mesh.js";
import { walkMeshes, type SceneNode } from "../geometry/scene.js";
import type { MaterialDef, TextureSet } from "../materials/types.js";

// ---------------------------------------------------------------- public API

export interface Camera {
  eye: Vec3;
  target: Vec3;
  /** Default [0,0,1]. Ignored direction falls back to +Y when parallel to the view direction. */
  up?: Vec3;
  /** Vertical field of view in degrees (perspective). Default 45. */
  fov?: number;
  /** If set: orthographic projection, half-height of the view in meters. */
  ortho?: number;
}

export interface RenderOptions {
  width?: number;
  height?: number;
  /** Samples per pixel axis (1..4). Default 2. */
  supersample?: number;
  /** Solid background (sRGB 0..1). Default: sky gradient. */
  background?: [number, number, number];
  /** Dark silhouette / crease outlines. Default true. */
  edges?: boolean;
  /** Hide geometry above this world Z (cutaway). Cut solids get dark section caps. */
  clipZ?: number;
  /** Section-cap colour for `clipZ` cutaways (sRGB 0..1). Default dark charcoal. */
  capColor?: [number, number, number];
}

export interface MaterialLookup {
  (name: string): { def: MaterialDef; tex?: TextureSet };
}

export interface RenderedImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}

export type ViewPreset =
  | "iso"
  | "iso_ne"
  | "iso_nw"
  | "iso_se"
  | "iso_sw"
  | "front"
  | "back"
  | "left"
  | "right"
  | "top"
  | "south"
  | "north"
  | "east"
  | "west";

export const VIEW_PRESETS: readonly ViewPreset[] = [
  "iso", "iso_ne", "iso_nw", "iso_se", "iso_sw", "front", "back", "left", "right", "top", "south", "north", "east", "west",
];

export function encodePNG(img: RenderedImage): Buffer {
  const png = new pngjs.PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.rgba.buffer, img.rgba.byteOffset, img.rgba.byteLength);
  return pngjs.PNG.sync.write(png);
}

// ---------------------------------------------------------------- colour helpers

const SRGB2LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB2LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
const LUT_N = 16384;
const LIN2SRGB = new Uint8Array(LUT_N + 1);
for (let i = 0; i <= LUT_N; i++) {
  const l = i / LUT_N;
  const s = l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
  LIN2SRGB[i] = Math.max(0, Math.min(255, Math.round(s * 255)));
}
function lin2srgb8(x: number): number {
  if (!(x > 0)) return 0;
  if (x >= 1) return 255;
  return LIN2SRGB[(x * LUT_N + 0.5) | 0];
}
function srgb2lin(c: number): number {
  c = Math.max(0, Math.min(1, c));
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
/** Soft shoulder so sunlit white walls don't clip hard. */
function tone(x: number): number {
  return x <= 0.8 ? x : 0.8 + 0.2 * (1 - Math.exp(-(x - 0.8) / 0.2));
}

// ---------------------------------------------------------------- lighting (linear)

function nrm(x: number, y: number, z: number): Vec3 {
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
}
const SUN = nrm(0.45, -0.75, 1.1); // from upper south-east
const SUN_C: Vec3 = [1.0, 0.96, 0.88];
const FILL = nrm(-0.7, 0.35, 0.3); // weak bounce from west-north-west
const FILL_C: Vec3 = [0.1, 0.11, 0.13];
const SKY_C: Vec3 = [0.4, 0.45, 0.55];
const GROUND_C: Vec3 = [0.22, 0.2, 0.18];

// ---------------------------------------------------------------- textures (mip chains)

interface MipTex {
  n: number;
  sizes: number[];
  data: Uint8Array[]; // RGBA sRGB, stride 4
}

const mipCache = new WeakMap<TextureSet, MipTex | null>();

function buildMips(t: TextureSet): MipTex | null {
  const s0 = t.size | 0;
  if (s0 < 1 || !t.baseColor || t.baseColor.length < s0 * s0 * 4) return null;
  const n = s0 * s0;
  const hasAO = t.orm && t.orm.length >= n * 4;
  const hasN = t.normal && t.normal.length >= n * 4;
  let base = t.baseColor;
  if (hasAO || hasN) {
    // Bake ambient occlusion + a cheap fixed-direction relief from the normal map into the albedo.
    base = new Uint8Array(n * 4);
    const L = nrm(-0.35, 0.45, 1); // light from the image's top-left (glTF: +Y = image up)
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      let f = 1;
      if (hasAO) f *= 0.35 + 0.65 * (t.orm[o] / 255);
      if (hasN) {
        const nx = t.normal[o] / 127.5 - 1, ny = t.normal[o + 1] / 127.5 - 1, nz = t.normal[o + 2] / 127.5 - 1;
        const rel = (nx * L[0] + ny * L[1] + nz * L[2]) / L[2];
        f *= Math.max(0.5, Math.min(1.5, 1 + (rel - 1) * 0.6));
      }
      base[o] = lin2srgb8(SRGB2LIN[t.baseColor[o]] * f);
      base[o + 1] = lin2srgb8(SRGB2LIN[t.baseColor[o + 1]] * f);
      base[o + 2] = lin2srgb8(SRGB2LIN[t.baseColor[o + 2]] * f);
      base[o + 3] = 255;
    }
  }
  const sizes = [s0];
  const data = [base];
  let s = s0, src = base;
  while (s > 1) {
    const d = Math.max(1, s >> 1);
    const dst = new Uint8Array(d * d * 4);
    for (let y = 0; y < d; y++)
      for (let x = 0; x < d; x++) {
        const xa = (2 * x) % s, xb = (2 * x + 1) % s, ya = (2 * y) % s, yb = (2 * y + 1) % s;
        const i0 = (ya * s + xa) * 4, i1 = (ya * s + xb) * 4, i2 = (yb * s + xa) * 4, i3 = (yb * s + xb) * 4;
        const o = (y * d + x) * 4;
        for (let c = 0; c < 3; c++)
          dst[o + c] = lin2srgb8(
            0.25 * (SRGB2LIN[src[i0 + c]] + SRGB2LIN[src[i1 + c]] + SRGB2LIN[src[i2 + c]] + SRGB2LIN[src[i3 + c]]),
          );
        dst[o + 3] = 255;
      }
    sizes.push(d);
    data.push(dst);
    s = d;
    src = dst;
  }
  return { n: sizes.length, sizes, data };
}

function getMips(t: TextureSet): MipTex | null {
  let m = mipCache.get(t);
  if (m === undefined) {
    m = buildMips(t);
    mipCache.set(t, m);
  }
  return m;
}

let sR = 0, sG = 0, sB = 0;

function bilinear(data: Uint8Array, s: number, u: number, v: number) {
  const x = u * s - 0.5, y = v * s - 0.5;
  const fx = Math.floor(x), fy = Math.floor(y);
  const tx = x - fx, ty = y - fy;
  let x0 = fx % s;
  if (x0 < 0) x0 += s;
  let y0 = fy % s;
  if (y0 < 0) y0 += s;
  const x1 = x0 + 1 === s ? 0 : x0 + 1;
  const y1 = y0 + 1 === s ? 0 : y0 + 1;
  const i00 = (y0 * s + x0) << 2, i10 = (y0 * s + x1) << 2, i01 = (y1 * s + x0) << 2, i11 = (y1 * s + x1) << 2;
  const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
  const L = SRGB2LIN;
  sR = L[data[i00]] * w00 + L[data[i10]] * w10 + L[data[i01]] * w01 + L[data[i11]] * w11;
  sG = L[data[i00 + 1]] * w00 + L[data[i10 + 1]] * w10 + L[data[i01 + 1]] * w01 + L[data[i11 + 1]] * w11;
  sB = L[data[i00 + 2]] * w00 + L[data[i10 + 2]] * w10 + L[data[i01 + 2]] * w01 + L[data[i11 + 2]] * w11;
}

function sampleTex(t: MipTex, u: number, v: number, lod: number) {
  if (!(lod > 0) || t.n === 1) return bilinear(t.data[0], t.sizes[0], u, v);
  const maxL = t.n - 1;
  if (lod >= maxL) return bilinear(t.data[maxL], t.sizes[maxL], u, v);
  const l0 = Math.floor(lod), f = lod - l0;
  bilinear(t.data[l0], t.sizes[l0], u, v);
  if (f < 0.03) return;
  const r = sR, g = sG, b = sB;
  bilinear(t.data[l0 + 1], t.sizes[l0 + 1], u, v);
  sR = r + (sR - r) * f;
  sG = g + (sG - g) * f;
  sB = b + (sB - b) * f;
}

// ---------------------------------------------------------------- render state

interface Mat {
  r: number; g: number; b: number;
  er: number; eg: number; eb: number;
  opacity: number;
  doubleSided: boolean;
  transparent: boolean;
  tex: MipTex | null;
}

/** A mesh in world space (transformed copy when its node has a pivot). */
interface RMesh {
  pos: ArrayLike<number>;
  nor: ArrayLike<number> | null;
  uv: ArrayLike<number> | null;
  idx: ArrayLike<number>;
  flipWinding: boolean;
  mat: Mat;
}

const NEAR = 0.03;

let W = 0, H = 0;
let depthBuf = new Float64Array(0);
let colorBuf = new Float32Array(0);
let normalBuf = new Int8Array(0);
let persp = true;
let focal = 1; // pixels per unit of (view x / depth) or, for ortho, pixels per meter
let cxs = 0, cys = 0;
let eyeX = 0, eyeY = 0, eyeZ = 0;
let Rx = 1, Ry = 0, Rz = 0, Ux = 0, Uy = 0, Uz = 1, Fx = 0, Fy = 1, Fz = 0;
let clipOn = false, clipZv = 0;
let capR = 0, capG = 0, capB = 0;

// clip vertex: vx, vy, d, wz, u, v, nx, ny, nz
const CS = 9;
const clipA = new Float64Array(8 * CS);
const clipB = new Float64Array(8 * CS);
// projected vertex: sx, sy, key, q, u*q, v*q, nx*q, ny*q, nz*q
const PS = 9;
const P = new Float64Array(8 * PS);

function clipPlane(src: Float64Array, n: number, dst: Float64Array, comp: number, sign: number, offset: number): number {
  let m = 0;
  for (let i = 0; i < n; i++) {
    const a = i * CS, b = ((i + 1) % n) * CS;
    const fa = sign * src[a + comp] + offset, fb = sign * src[b + comp] + offset;
    const ina = fa >= 0, inb = fb >= 0;
    if (ina) {
      for (let k = 0; k < CS; k++) dst[m * CS + k] = src[a + k];
      m++;
    }
    if (ina !== inb) {
      // canonical direction (inside -> outside) so shared edges clip identically
      const pi = ina ? a : b, po = ina ? b : a;
      const fi = ina ? fa : fb, fo = ina ? fb : fa;
      const t = fi / (fi - fo);
      for (let k = 0; k < CS; k++) dst[m * CS + k] = src[pi + k] + (src[po + k] - src[pi + k]) * t;
      m++;
    }
  }
  return m;
}

// ---------------------------------------------------------------- triangle rasterizer

/** mode 0 = shaded opaque, 1 = flat section-cap opaque, 2 = shaded alpha-blended */
function rasterTri(ia: number, ib: number, ic: number, mode: number, mat: Mat, gnx: number, gny: number, gnz: number) {
  let a = ia * PS, b = ib * PS, c = ic * PS;
  const x0 = P[a], y0 = P[a + 1];
  let x1 = P[b], y1 = P[b + 1], x2 = P[c], y2 = P[c + 1];
  let area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
  if (!(Math.abs(area) > 1e-10)) return;
  if (area < 0) {
    let t = b; b = c; c = t;
    t = x1; x1 = x2; x2 = t;
    t = y1; y1 = y2; y2 = t;
    area = -area;
  }
  const w = W, h = H;
  const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2) - 0.5));
  const maxX = Math.min(w - 1, Math.ceil(Math.max(x0, x1, x2) - 0.5));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2) - 0.5));
  const maxY = Math.min(h - 1, Math.ceil(Math.max(y0, y1, y2) - 0.5));
  if (minX > maxX || minY > maxY) return;

  // Edge k is opposite vertex k: E = A*px + B*py + C > 0 inside (with top-left tie rule).
  const A0 = y1 - y2, B0 = x2 - x1, C0 = -(A0 * x1 + B0 * y1);
  const A1 = y2 - y0, B1 = x0 - x2, C1 = -(A1 * x2 + B1 * y2);
  const A2 = y0 - y1, B2 = x1 - x0, C2 = -(A2 * x0 + B2 * y0);
  const t0 = A0 > 0 || (A0 === 0 && B0 > 0) ? 1e-9 : 0;
  const t1 = A1 > 0 || (A1 === 0 && B1 > 0) ? 1e-9 : 0;
  const t2 = A2 > 0 || (A2 === 0 && B2 > 0) ? 1e-9 : 0;
  const inv = 1 / area;

  const K0 = P[a + 2], K1 = P[b + 2], K2 = P[c + 2];
  const Q0 = P[a + 3], Q1 = P[b + 3], Q2 = P[c + 3];
  const U0 = P[a + 4], U1 = P[b + 4], U2 = P[c + 4];
  const V0 = P[a + 5], V1 = P[b + 5], V2 = P[c + 5];
  const NX0 = P[a + 6], NX1 = P[b + 6], NX2 = P[c + 6];
  const NY0 = P[a + 7], NY1 = P[b + 7], NY2 = P[c + 7];
  const NZ0 = P[a + 8], NZ1 = P[b + 8], NZ2 = P[c + 8];

  const tex = mode === 1 ? null : mat.tex;
  let dQdx = 0, dQdy = 0, dUdx = 0, dUdy = 0, dVdx = 0, dVdy = 0, tsz2 = 0;
  if (tex) {
    dQdx = (Q0 * A0 + Q1 * A1 + Q2 * A2) * inv;
    dQdy = (Q0 * B0 + Q1 * B1 + Q2 * B2) * inv;
    dUdx = (U0 * A0 + U1 * A1 + U2 * A2) * inv;
    dUdy = (U0 * B0 + U1 * B1 + U2 * B2) * inv;
    dVdx = (V0 * A0 + V1 * A1 + V2 * A2) * inv;
    dVdy = (V0 * B0 + V1 * B1 + V2 * B2) * inv;
    tsz2 = tex.sizes[0] * tex.sizes[0];
  }
  const isPersp = persp;
  const depth = depthBuf, color = colorBuf, normal = normalBuf;
  const mr = mat.r, mg = mat.g, mb = mat.b, er = mat.er, eg = mat.eg, eb = mat.eb;
  const alpha = mat.opacity, ialpha = 1 - alpha;
  // flat normal for caps (int8)
  const cnx = Math.round(gnx * 127), cny = Math.round(gny * 127), cnz = Math.round(gnz * 127);

  for (let py = minY; py <= maxY; py++) {
    const yc = py + 0.5;
    const r0 = B0 * yc + C0 + t0, r1 = B1 * yc + C1 + t1, r2 = B2 * yc + C2 + t2;
    // analytic span of the row (then exact per-pixel tests)
    let lo = -Infinity, hi = Infinity;
    if (A0 > 0) lo = Math.max(lo, -r0 / A0); else if (A0 < 0) hi = Math.min(hi, -r0 / A0); else if (r0 <= 0) continue;
    if (A1 > 0) lo = Math.max(lo, -r1 / A1); else if (A1 < 0) hi = Math.min(hi, -r1 / A1); else if (r1 <= 0) continue;
    if (A2 > 0) lo = Math.max(lo, -r2 / A2); else if (A2 < 0) hi = Math.min(hi, -r2 / A2); else if (r2 <= 0) continue;
    const ix0 = Math.max(minX, Math.floor(lo - 0.5));
    const ix1 = Math.min(maxX, Math.ceil(hi - 0.5));
    const row = py * w;
    for (let px = ix0; px <= ix1; px++) {
      const xc = px + 0.5;
      const e0 = A0 * xc + r0;
      if (e0 <= 0) continue;
      const e1 = A1 * xc + r1;
      if (e1 <= 0) continue;
      const e2 = A2 * xc + r2;
      if (e2 <= 0) continue;
      const b0 = e0 * inv, b1 = e1 * inv, b2 = e2 * inv;
      const k = b0 * K0 + b1 * K1 + b2 * K2;
      const idx = row + px;
      if (k <= depth[idx]) continue;
      const o = idx * 3;
      if (mode === 1) {
        depth[idx] = k;
        color[o] = capR; color[o + 1] = capG; color[o + 2] = capB;
        normal[o] = cnx; normal[o + 1] = cny; normal[o + 2] = cnz;
        continue;
      }
      let nx = b0 * NX0 + b1 * NX1 + b2 * NX2;
      let ny = b0 * NY0 + b1 * NY1 + b2 * NY2;
      let nz = b0 * NZ0 + b1 * NZ1 + b2 * NZ2;
      const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (nl > 1e-12) {
        nx /= nl; ny /= nl; nz /= nl;
      } else {
        nx = gnx; ny = gny; nz = gnz;
      }
      let ar = mr, ag = mg, ab = mb;
      if (tex) {
        let iq = 1;
        if (isPersp) iq = 1 / (b0 * Q0 + b1 * Q1 + b2 * Q2);
        const u = (b0 * U0 + b1 * U1 + b2 * U2) * iq;
        const v = (b0 * V0 + b1 * V1 + b2 * V2) * iq;
        const dudx = (dUdx - u * dQdx) * iq, dvdx = (dVdx - v * dQdx) * iq;
        const dudy = (dUdy - u * dQdy) * iq, dvdy = (dVdy - v * dQdy) * iq;
        const rho2 = Math.max(dudx * dudx + dvdx * dvdx, dudy * dudy + dvdy * dvdy) * tsz2;
        sampleTex(tex, u, v, rho2 > 1 ? 0.5 * Math.log2(rho2) : 0);
        ar *= sR; ag *= sG; ab *= sB;
      }
      const ndl = nx * SUN[0] + ny * SUN[1] + nz * SUN[2];
      const ndf = nx * FILL[0] + ny * FILL[1] + nz * FILL[2];
      const sun = ndl > 0 ? ndl : 0, fill = ndf > 0 ? ndf : 0;
      const hemi = 0.5 + 0.5 * nz;
      const lr = SUN_C[0] * sun + FILL_C[0] * fill + GROUND_C[0] + (SKY_C[0] - GROUND_C[0]) * hemi;
      const lg = SUN_C[1] * sun + FILL_C[1] * fill + GROUND_C[1] + (SKY_C[1] - GROUND_C[1]) * hemi;
      const lb = SUN_C[2] * sun + FILL_C[2] * fill + GROUND_C[2] + (SKY_C[2] - GROUND_C[2]) * hemi;
      const cr = ar * lr + er, cg = ag * lg + eg, cb = ab * lb + eb;
      if (mode === 0) {
        depth[idx] = k;
        color[o] = cr; color[o + 1] = cg; color[o + 2] = cb;
        normal[o] = Math.round(nx * 127); normal[o + 1] = Math.round(ny * 127); normal[o + 2] = Math.round(nz * 127);
      } else {
        color[o] = color[o] * ialpha + cr * alpha;
        color[o + 1] = color[o + 1] * ialpha + cg * alpha;
        color[o + 2] = color[o + 2] * ialpha + cb * alpha;
      }
    }
  }
}

// ---------------------------------------------------------------- per-triangle pipeline

const SNAP = 256;
const triVerts = new Int32Array(3);

function drawTriangle(m: RMesh, t: number, blendPass: boolean) {
  const pos = m.pos, nor = m.nor, uv = m.uv, ix = m.idx, mat = m.mat;
  const ia = ix[t];
  let ib = ix[t + 1], ic = ix[t + 2];
  if (m.flipWinding) { const s = ib; ib = ic; ic = s; }
  const a3 = ia * 3, b3 = ib * 3, c3 = ic * 3;
  const ax = pos[a3], ay = pos[a3 + 1], az = pos[a3 + 2];
  const bx = pos[b3], by = pos[b3 + 1], bz = pos[b3 + 2];
  const cx = pos[c3], cy = pos[c3 + 1], cz = pos[c3 + 2];
  if (clipOn && az > clipZv && bz > clipZv && cz > clipZv) return;
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  let gnx = e1y * e2z - e1z * e2y, gny = e1z * e2x - e1x * e2z, gnz = e1x * e2y - e1y * e2x;
  const gl = Math.sqrt(gnx * gnx + gny * gny + gnz * gnz);
  if (!(gl > 1e-14)) return;
  gnx /= gl; gny /= gl; gnz /= gl;
  const facing = persp
    ? gnx * (eyeX - ax) + gny * (eyeY - ay) + gnz * (eyeZ - az)
    : -(gnx * Fx + gny * Fy + gnz * Fz);
  let mode = blendPass ? 2 : 0;
  let flip = false;
  if (facing <= 0) {
    if (mat.doubleSided || mat.transparent) flip = true;
    else if (clipOn) mode = 1;
    else return;
  }
  if (flip) { gnx = -gnx; gny = -gny; gnz = -gnz; }

  // view-space vertices into clip buffer
  const verts = triVerts;
  verts[0] = ia; verts[1] = ib; verts[2] = ic;
  const hasN = nor !== null, hasUV = uv !== null;
  const ns = flip ? -1 : 1;
  let anyNear = false, anyAbove = false;
  for (let k = 0; k < 3; k++) {
    const vi = verts[k], p3 = vi * 3, o = k * CS;
    const dx = pos[p3] - eyeX, dy = pos[p3 + 1] - eyeY, dz = pos[p3 + 2] - eyeZ;
    clipA[o] = dx * Rx + dy * Ry + dz * Rz;
    clipA[o + 1] = dx * Ux + dy * Uy + dz * Uz;
    const d = dx * Fx + dy * Fy + dz * Fz;
    clipA[o + 2] = d;
    clipA[o + 3] = pos[p3 + 2];
    if (hasUV) {
      clipA[o + 4] = uv![vi * 2];
      clipA[o + 5] = uv![vi * 2 + 1];
    } else {
      clipA[o + 4] = 0;
      clipA[o + 5] = 0;
    }
    if (hasN) {
      clipA[o + 6] = nor![p3] * ns;
      clipA[o + 7] = nor![p3 + 1] * ns;
      clipA[o + 8] = nor![p3 + 2] * ns;
    } else {
      clipA[o + 6] = gnx;
      clipA[o + 7] = gny;
      clipA[o + 8] = gnz;
    }
    if (persp && d < NEAR) anyNear = true;
    if (clipOn && pos[p3 + 2] > clipZv) anyAbove = true;
  }
  if (persp && clipA[2] < NEAR && clipA[CS + 2] < NEAR && clipA[2 * CS + 2] < NEAR) return;

  let poly = clipA, n = 3;
  if (anyNear) {
    n = clipPlane(poly, n, clipB, 2, 1, -NEAR);
    poly = clipB;
    if (n < 3) return;
  }
  if (anyAbove) {
    const dst = poly === clipA ? clipB : clipA;
    n = clipPlane(poly, n, dst, 3, -1, clipZv);
    poly = dst;
    if (n < 3) return;
  }

  // project
  let allL = true, allR = true, allT = true, allB = true;
  for (let k = 0; k < n; k++) {
    const o = k * CS, p = k * PS;
    let sx: number, sy: number, key: number, q: number;
    if (persp) {
      q = 1 / poly[o + 2];
      sx = cxs + poly[o] * q * focal;
      sy = cys - poly[o + 1] * q * focal;
      key = q;
    } else {
      q = 1;
      sx = cxs + poly[o] * focal;
      sy = cys - poly[o + 1] * focal;
      key = -poly[o + 2];
    }
    sx = Math.round(sx * SNAP) / SNAP;
    sy = Math.round(sy * SNAP) / SNAP;
    if (sx >= 0) allL = false;
    if (sx <= W) allR = false;
    if (sy >= 0) allT = false;
    if (sy <= H) allB = false;
    P[p] = sx; P[p + 1] = sy; P[p + 2] = key; P[p + 3] = q;
    P[p + 4] = poly[o + 4] * q; P[p + 5] = poly[o + 5] * q;
    P[p + 6] = poly[o + 6] * q; P[p + 7] = poly[o + 7] * q; P[p + 8] = poly[o + 8] * q;
  }
  if (allL || allR || allT || allB) return;
  for (let k = 1; k + 1 < n; k++) rasterTri(0, k, k + 1, mode, mat, gnx, gny, gnz);
}

// ---------------------------------------------------------------- section caps (cutaway fill)

/**
 * Close the section graph. Open solids (boxes built with skipped faces, e.g. the
 * door/window frame jambs whose wall-side face is omitted) cut into open
 * polylines. Fed to the scanline fill, each dangling end leaves an unmatched
 * crossing on the rows its open gap spans, and two such crossings on one row
 * (the jambs of one or several openings) flood the whole span between them with
 * cap colour: thin dark streaks across rooms at the cut height.
 *
 * Endpoints are welded on a 0.1 mm grid (snapped to one canonical position so
 * shared vertices project identically); every node with more incoming than
 * outgoing segments ("end") is then bridged to the nearest node with more
 * outgoing than incoming ones ("start"), closest pairs first, which restores the
 * missing face of an open box (a jamb's U closes across its skipped side).
 * Already-closed loops (the usual case for walls) are untouched.
 */
function closeSectionGraph(segs: number[]): number[] {
  const n = segs.length >> 2;
  const Q = 1e4;
  const MAX_BRIDGE = 1.0; // m; anything farther is left as it was
  const ids = new Map<string, number>();
  const px: number[] = [], py: number[] = [];
  const node = (x: number, y: number): number => {
    const key = Math.round(x * Q) + "," + Math.round(y * Q);
    let id = ids.get(key);
    if (id === undefined) {
      id = px.length;
      ids.set(key, id);
      px.push(x);
      py.push(y);
    }
    return id;
  };
  const out: number[] = [];
  const bal: number[] = []; // out - in per node
  for (let i = 0; i < n; i++) {
    const a = node(segs[4 * i], segs[4 * i + 1]);
    const b = node(segs[4 * i + 2], segs[4 * i + 3]);
    if (a === b) continue; // degenerate after welding
    while (bal.length < px.length) bal.push(0);
    bal[a]++;
    bal[b]--;
    out.push(px[a], py[a], px[b], py[b]);
  }
  const ends: number[] = [], starts: number[] = [];
  for (let v = 0; v < bal.length; v++) {
    for (let k = 0; k < -bal[v]; k++) ends.push(v);
    for (let k = 0; k < bal[v]; k++) starts.push(v);
  }
  if (!ends.length || !starts.length) return out;
  const pairs: [number, number, number][] = [];
  for (let i = 0; i < ends.length; i++)
    for (let j = 0; j < starts.length; j++) {
      const e = ends[i], s = starts[j];
      const d = Math.hypot(px[s] - px[e], py[s] - py[e]);
      if (d <= MAX_BRIDGE) pairs.push([d, i, j]);
    }
  pairs.sort((p, q) => p[0] - q[0]);
  const usedE = new Uint8Array(ends.length), usedS = new Uint8Array(starts.length);
  for (const [, i, j] of pairs) {
    if (usedE[i] || usedS[j]) continue;
    usedE[i] = usedS[j] = 1;
    out.push(px[ends[i]], py[ends[i]], px[starts[j]], py[starts[j]]);
  }
  return out;
}

/**
 * Fill the cut plane z = clipZ inside closed solids. Section segments (oriented
 * by face normal, closed by `closeSectionGraph`) are projected to screen and
 * scan-converted with a non-zero winding rule; a pixel counts as inside only if
 * the winding is non-zero from both the left and the right.
 */
function fillCaps(rawSegs: number[]) {
  if (!rawSegs.length) return;
  const segs = closeSectionGraph(rawSegs);
  if (!segs.length) return;
  const rows: (number[] | undefined)[] = new Array(H);
  const pushSeg = (xa: number, ya: number, xb: number, yb: number) => {
    if (ya === yb || !isFinite(xa + ya + xb + yb)) return;
    let wgt = 1;
    if (ya > yb) {
      let t = xa; xa = xb; xb = t;
      t = ya; ya = yb; yb = t;
      wgt = -1;
    }
    const j0 = Math.max(0, Math.ceil(ya - 0.5)), j1 = Math.min(H - 1, Math.ceil(yb - 0.5) - 1);
    const sl = (xb - xa) / (yb - ya);
    for (let j = j0; j <= j1; j++) {
      const x = xa + (j + 0.5 - ya) * sl;
      let r = rows[j];
      if (!r) rows[j] = r = [];
      r.push(x, wgt);
    }
  };
  const view = (x: number, y: number, z: number, out: number[]) => {
    const dx = x - eyeX, dy = y - eyeY, dz = z - eyeZ;
    out[0] = dx * Rx + dy * Ry + dz * Rz;
    out[1] = dx * Ux + dy * Uy + dz * Uz;
    out[2] = dx * Fx + dy * Fy + dz * Fz;
  };
  const va = [0, 0, 0], vb = [0, 0, 0];
  for (let i = 0; i < segs.length; i += 4) {
    view(segs[i], segs[i + 1], clipZv, va);
    view(segs[i + 2], segs[i + 3], clipZv, vb);
    if (persp) {
      if (va[2] < NEAR && vb[2] < NEAR) continue;
      if (va[2] < NEAR || vb[2] < NEAR) {
        const [pi, po] = va[2] >= NEAR ? [va, vb] : [vb, va];
        const t = (pi[2] - NEAR) / (pi[2] - po[2]);
        for (let k = 0; k < 3; k++) po[k] = pi[k] + (po[k] - pi[k]) * t;
      }
      pushSeg(cxs + (va[0] / va[2]) * focal, cys - (va[1] / va[2]) * focal, cxs + (vb[0] / vb[2]) * focal, cys - (vb[1] / vb[2]) * focal);
    } else {
      pushSeg(cxs + va[0] * focal, cys - va[1] * focal, cxs + vb[0] * focal, cys - vb[1] * focal);
    }
  }
  // cap faces the camera: up if the eye looks down onto the plane
  const lookDown = persp ? eyeZ > clipZv : Fz < 0;
  const cnz = lookDown ? 127 : -127;
  for (let j = 0; j < H; j++) {
    const r = rows[j];
    if (!r) continue;
    const m = r.length >> 1;
    const xs = new Float64Array(m), ws = new Int32Array(m);
    const order: number[] = [];
    for (let k = 0; k < m; k++) order.push(k);
    order.sort((p, q) => r[2 * p] - r[2 * q]);
    let total = 0;
    for (let k = 0; k < m; k++) {
      xs[k] = r[2 * order[k]];
      ws[k] = r[2 * order[k] + 1];
      total += ws[k];
    }
    let ptr = 0, winL = 0;
    const startX = Math.max(0, Math.floor(xs[0] - 0.5));
    const endX = Math.min(W - 1, Math.ceil(xs[m - 1]));
    const yc = j + 0.5;
    for (let i = startX; i <= endX; i++) {
      const xc = i + 0.5;
      while (ptr < m && xs[ptr] <= xc) winL += ws[ptr++];
      if (winL === 0 || total - winL === 0) continue;
      let key: number;
      if (persp) {
        const xn = (xc - cxs) / focal, yn = (cys - yc) / focal;
        const dz = Fz + Rz * xn + Uz * yn;
        if (Math.abs(dz) < 1e-12) continue;
        const t = (clipZv - eyeZ) / dz;
        if (t < NEAR) continue;
        key = 1 / t;
      } else {
        if (Math.abs(Fz) < 1e-12) continue;
        const oz = eyeZ + (Rz * (xc - cxs) + Uz * (cys - yc)) / focal;
        key = -(clipZv - oz) / Fz;
      }
      const idx = j * W + i;
      if (key <= depthBuf[idx]) continue;
      depthBuf[idx] = key;
      const o = idx * 3;
      colorBuf[o] = capR; colorBuf[o + 1] = capG; colorBuf[o + 2] = capB;
      normalBuf[o] = 0; normalBuf[o + 1] = 0; normalBuf[o + 2] = cnz;
    }
  }
}

function sectionSegment(m: RMesh, t: number, segs: number[]) {
  const pos = m.pos, ix = m.idx;
  const ia = ix[t];
  let ib = ix[t + 1], ic = ix[t + 2];
  if (m.flipWinding) { const s = ib; ib = ic; ic = s; }
  const v = [ia * 3, ib * 3, ic * 3];
  const z = clipZv;
  let above = 0;
  for (let k = 0; k < 3; k++) if (pos[v[k] + 2] > z) above++;
  if (above === 0 || above === 3) return;
  const pts: number[] = [];
  for (let k = 0; k < 3; k++) {
    const p = v[k], q = v[(k + 1) % 3];
    const pa = pos[p + 2] > z, qa = pos[q + 2] > z;
    if (pa === qa) continue;
    const lo = pa ? q : p, hi = pa ? p : q; // canonical: below -> above
    const t2 = (z - pos[lo + 2]) / (pos[hi + 2] - pos[lo + 2]);
    pts.push(pos[lo] + (pos[hi] - pos[lo]) * t2, pos[lo + 1] + (pos[hi + 1] - pos[lo + 1]) * t2);
  }
  if (pts.length !== 4) return;
  const ax = pos[v[0]], ay = pos[v[0] + 1], az = pos[v[0] + 2];
  const e1x = pos[v[1]] - ax, e1y = pos[v[1] + 1] - ay, e1z = pos[v[1] + 2] - az;
  const e2x = pos[v[2]] - ax, e2y = pos[v[2] + 1] - ay, e2z = pos[v[2] + 2] - az;
  const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z;
  // CCW boundary seen from above: direction = up × n
  const dx = -ny, dy = nx;
  if ((pts[2] - pts[0]) * dx + (pts[3] - pts[1]) * dy >= 0) segs.push(pts[0], pts[1], pts[2], pts[3]);
  else segs.push(pts[2], pts[3], pts[0], pts[1]);
}

// ---------------------------------------------------------------- outlines

function applyEdges(ss: number) {
  const w = W, h = H, depth = depthBuf, nb = normalBuf, col = colorBuf;
  const tauRel = 0.012;
  const tauAbs = Math.max(0.08, 3 / focal);
  const nThresh = 0.82 * 127 * 127;
  const dark = ss >= 2 ? 0.28 : 0.45;
  const mark = new Uint8Array(w * h);
  const NEG = -Infinity;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      const k = depth[i];
      if (k === NEG) continue;
      let edge = false;
      // silhouette against background
      if ((x > 0 && depth[i - 1] === NEG) || (x < w - 1 && depth[i + 1] === NEG) ||
          (y > 0 && depth[i - w] === NEG) || (y < h - 1 && depth[i + w] === NEG)) edge = true;
      else {
        const tau = persp ? tauRel * k : tauAbs;
        if (x > 0 && x < w - 1 && Math.abs(depth[i - 1] + depth[i + 1] - 2 * k) > tau) edge = true;
        else if (y > 0 && y < h - 1 && Math.abs(depth[i - w] + depth[i + w] - 2 * k) > tau) edge = true;
        else {
          const o = i * 3;
          const nx = nb[o], ny = nb[o + 1], nz = nb[o + 2];
          if (x < w - 1 && depth[i + 1] !== NEG) {
            const p = o + 3;
            if (nx * nb[p] + ny * nb[p + 1] + nz * nb[p + 2] < nThresh) edge = true;
          }
          if (!edge && y < h - 1 && depth[i + w] !== NEG) {
            const p = o + 3 * w;
            if (nx * nb[p] + ny * nb[p + 1] + nz * nb[p + 2] < nThresh) edge = true;
          }
        }
      }
      if (edge) mark[i] = 1;
    }
  }
  for (let i = 0; i < w * h; i++)
    if (mark[i]) {
      const o = i * 3;
      col[o] *= dark; col[o + 1] *= dark; col[o + 2] *= dark;
    }
}

// ---------------------------------------------------------------- main entry

function isIdentity(m: Mat4): boolean {
  for (let i = 0; i < 16; i++) if (m[i] !== (i % 5 === 0 ? 1 : 0)) return false;
  return true;
}

function toRMesh(mesh: MeshData, world: Mat4, mat: Mat): RMesh | null {
  const np = Math.floor(mesh.positions.length / 3);
  if (np === 0 || mesh.indices.length < 3) return null;
  const hasN = mesh.normals && mesh.normals.length >= np * 3;
  const hasUV = mesh.uvs && mesh.uvs.length >= np * 2;
  let pos: ArrayLike<number> = mesh.positions;
  let nor: ArrayLike<number> | null = hasN ? mesh.normals : null;
  let flip = false;
  if (!isIdentity(world)) {
    const p = new Float64Array(np * 3);
    const n = hasN ? new Float64Array(np * 3) : null;
    for (let i = 0; i < np; i++) {
      const q = m4.point(world, [mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]]);
      p[i * 3] = q[0]; p[i * 3 + 1] = q[1]; p[i * 3 + 2] = q[2];
      if (n) {
        const r = m4.normal(world, [mesh.normals[i * 3], mesh.normals[i * 3 + 1], mesh.normals[i * 3 + 2]]);
        n[i * 3] = r[0]; n[i * 3 + 1] = r[1]; n[i * 3 + 2] = r[2];
      }
    }
    pos = p;
    nor = n;
    flip = m4.isMirroring(world);
  }
  return { pos, nor, uv: hasUV ? mesh.uvs : null, idx: mesh.indices, flipWinding: flip, mat };
}

export function renderScene(
  root: SceneNode,
  materials: MaterialLookup,
  camera: Camera,
  opts: RenderOptions = {},
): RenderedImage {
  const outW = Math.max(1, Math.round(opts.width ?? 1280));
  const outH = Math.max(1, Math.round(opts.height ?? 800));
  const ss = Math.max(1, Math.min(4, Math.round(opts.supersample ?? 2)));
  W = outW * ss;
  H = outH * ss;
  const npx = W * H;

  // camera basis
  const [ex, ey, ez] = camera.eye;
  eyeX = ex; eyeY = ey; eyeZ = ez;
  let f = nrm(camera.target[0] - ex, camera.target[1] - ey, camera.target[2] - ez);
  if (!isFinite(f[0])) f = [0, 1, 0];
  let up = camera.up ?? [0, 0, 1];
  let r: Vec3 = [f[1] * up[2] - f[2] * up[1], f[2] * up[0] - f[0] * up[2], f[0] * up[1] - f[1] * up[0]];
  if (Math.hypot(r[0], r[1], r[2]) < 1e-6) {
    up = Math.abs(f[1]) < 0.9 ? [0, 1, 0] : [0, 0, 1];
    r = [f[1] * up[2] - f[2] * up[1], f[2] * up[0] - f[0] * up[2], f[0] * up[1] - f[1] * up[0]];
  }
  r = nrm(r[0], r[1], r[2]);
  const u: Vec3 = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  [Rx, Ry, Rz] = r;
  [Ux, Uy, Uz] = u;
  [Fx, Fy, Fz] = f;
  persp = !(camera.ortho && camera.ortho > 0);
  focal = persp ? H / 2 / Math.tan(((camera.fov ?? 45) * Math.PI) / 360) : H / 2 / camera.ortho!;
  cxs = W / 2;
  cys = H / 2;
  clipOn = typeof opts.clipZ === "number" && isFinite(opts.clipZ);
  clipZv = clipOn ? opts.clipZ! : 0;
  const cap = opts.capColor ?? [0.16, 0.16, 0.18];
  capR = srgb2lin(cap[0]); capG = srgb2lin(cap[1]); capB = srgb2lin(cap[2]);

  // buffers
  depthBuf = new Float64Array(npx).fill(-Infinity);
  colorBuf = new Float32Array(npx * 3);
  normalBuf = new Int8Array(npx * 3);
  if (opts.background) {
    const br = srgb2lin(opts.background[0]), bg = srgb2lin(opts.background[1]), bb = srgb2lin(opts.background[2]);
    for (let i = 0; i < npx; i++) {
      colorBuf[i * 3] = br; colorBuf[i * 3 + 1] = bg; colorBuf[i * 3 + 2] = bb;
    }
  } else {
    const top = [srgb2lin(0.47), srgb2lin(0.63), srgb2lin(0.84)];
    const bot = [srgb2lin(0.86), srgb2lin(0.9), srgb2lin(0.94)];
    for (let y = 0; y < H; y++) {
      const t = Math.pow(y / Math.max(1, H - 1), 0.8);
      const cr = top[0] + (bot[0] - top[0]) * t, cg = top[1] + (bot[1] - top[1]) * t, cb = top[2] + (bot[2] - top[2]) * t;
      for (let x = 0, o = y * W * 3; x < W; x++, o += 3) {
        colorBuf[o] = cr; colorBuf[o + 1] = cg; colorBuf[o + 2] = cb;
      }
    }
  }

  // materials + meshes
  const matCache = new Map<string, Mat>();
  const getMat = (name: string): Mat => {
    let m = matCache.get(name);
    if (m) return m;
    let def: MaterialDef | undefined, tex: TextureSet | undefined;
    try {
      const res = materials(name);
      def = res?.def;
      tex = res?.tex;
    } catch {
      def = undefined;
    }
    const c = def?.color ?? [0.7, 0.7, 0.7];
    const e = def?.emissive ?? [0, 0, 0];
    const opacity = Math.max(0, Math.min(1, def?.opacity ?? 1));
    m = {
      r: srgb2lin(c[0]), g: srgb2lin(c[1]), b: srgb2lin(c[2]),
      er: srgb2lin(e[0]), eg: srgb2lin(e[1]), eb: srgb2lin(e[2]),
      opacity,
      doubleSided: !!def?.doubleSided,
      transparent: opacity < 0.999,
      tex: tex ? getMips(tex) : null,
    };
    matCache.set(name, m);
    return m;
  };
  const meshes: RMesh[] = [];
  walkMeshes(root, (mesh, _node, world) => {
    const rm = toRMesh(mesh, world, getMat(mesh.material));
    if (rm) meshes.push(rm);
  });

  // opaque pass (+ collect transparent triangles and section segments)
  const transMesh: number[] = [], transTri: number[] = [], transDepth: number[] = [];
  const segs: number[] = [];
  for (let mi = 0; mi < meshes.length; mi++) {
    const m = meshes[mi];
    const idx = m.idx, pos = m.pos;
    const nt = idx.length - (idx.length % 3);
    const capSource = clipOn && !m.mat.transparent && !m.mat.doubleSided;
    for (let t = 0; t < nt; t += 3) {
      if (m.mat.transparent) {
        const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
        const mx = (pos[a] + pos[b] + pos[c]) / 3 - eyeX;
        const my = (pos[a + 1] + pos[b + 1] + pos[c + 1]) / 3 - eyeY;
        const mz = (pos[a + 2] + pos[b + 2] + pos[c + 2]) / 3 - eyeZ;
        transMesh.push(mi);
        transTri.push(t);
        transDepth.push(persp ? Math.hypot(mx, my, mz) : mx * Fx + my * Fy + mz * Fz);
        continue;
      }
      if (capSource) sectionSegment(m, t, segs);
      drawTriangle(m, t, false);
    }
  }
  if (clipOn) fillCaps(segs);
  if (opts.edges !== false) applyEdges(ss);

  // transparent pass, back to front
  if (transTri.length) {
    const order = new Uint32Array(transTri.length);
    for (let i = 0; i < order.length; i++) order[i] = i;
    order.sort((p, q) => transDepth[q] - transDepth[p]);
    for (let i = 0; i < order.length; i++) {
      const k = order[i];
      drawTriangle(meshes[transMesh[k]], transTri[k], true);
    }
  }

  // downsample (box filter) + tone + sRGB encode
  const rgba = new Uint8Array(outW * outH * 4);
  const inv = 1 / (ss * ss);
  for (let y = 0; y < outH; y++)
    for (let x = 0; x < outW; x++) {
      let r0 = 0, g0 = 0, b0 = 0;
      for (let sy = 0; sy < ss; sy++) {
        let o = ((y * ss + sy) * W + x * ss) * 3;
        for (let sx = 0; sx < ss; sx++, o += 3) {
          r0 += colorBuf[o]; g0 += colorBuf[o + 1]; b0 += colorBuf[o + 2];
        }
      }
      const o = (y * outW + x) * 4;
      rgba[o] = lin2srgb8(tone(r0 * inv));
      rgba[o + 1] = lin2srgb8(tone(g0 * inv));
      rgba[o + 2] = lin2srgb8(tone(b0 * inv));
      rgba[o + 3] = 255;
    }
  // release big buffers
  depthBuf = new Float64Array(0);
  colorBuf = new Float32Array(0);
  normalBuf = new Int8Array(0);
  return { width: outW, height: outH, rgba };
}

// ---------------------------------------------------------------- camera presets

const ISO_ELEV = 0.75; // ~28° above the horizon
const ELEV_LOW = 0.18; // elevations: ~10° above the horizon

const PRESET_DIRS: Record<Exclude<ViewPreset, "top">, Vec3> = {
  iso: [1, -1, ISO_ELEV * Math.SQRT2],
  iso_se: [1, -1, ISO_ELEV * Math.SQRT2],
  iso_ne: [1, 1, ISO_ELEV * Math.SQRT2],
  iso_nw: [-1, 1, ISO_ELEV * Math.SQRT2],
  iso_sw: [-1, -1, ISO_ELEV * Math.SQRT2],
  front: [0, -1, ELEV_LOW],
  south: [0, -1, ELEV_LOW],
  back: [0, 1, ELEV_LOW],
  north: [0, 1, ELEV_LOW],
  left: [-1, 0, ELEV_LOW],
  west: [-1, 0, ELEV_LOW],
  right: [1, 0, ELEV_LOW],
  east: [1, 0, ELEV_LOW],
};

/**
 * Camera that frames `bounds`. "top" is orthographic looking straight down
 * with north (+Y) up and east (+X) right; "front"/"south" stands south looking
 * north; iso = iso_se (3/4 view from south-east, above).
 */
export function presetCamera(bounds: { min: Vec3; max: Vec3 }, preset: ViewPreset, aspect: number): Camera {
  const min = bounds.min.map((v) => (isFinite(v) ? v : 0)) as Vec3;
  const max = bounds.max.map((v, i) => (isFinite(v) ? Math.max(v, min[i]) : min[i] + 1)) as Vec3;
  aspect = aspect > 0 && isFinite(aspect) ? aspect : 1;
  const c: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const size: Vec3 = [Math.max(max[0] - min[0], 0.1), Math.max(max[1] - min[1], 0.1), Math.max(max[2] - min[2], 0.1)];
  const diag = Math.hypot(size[0], size[1], size[2]);
  const margin = 1.06;
  if (preset === "top") {
    const half = Math.max(size[1] / 2, size[0] / 2 / aspect) * margin;
    return { eye: [c[0], c[1], max[2] + diag + 1], target: [c[0], c[1], min[2]], up: [0, 1, 0], ortho: half };
  }
  const fov = preset.startsWith("iso") ? 40 : 35;
  const dir = nrm(...(PRESET_DIRS[preset] ?? PRESET_DIRS.iso));
  const back: Vec3 = dir; // from target toward eye
  const f: Vec3 = [-back[0], -back[1], -back[2]];
  const r = nrm(f[1], -f[0], 0); // f × (0,0,1)
  const u: Vec3 = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  const tanV = Math.tan((fov * Math.PI) / 360) / margin;
  const tanH = tanV * aspect;
  const corners: Vec3[] = [];
  for (let i = 0; i < 8; i++) corners.push([i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]]);
  let target: Vec3 = [...c];
  let dist = diag;
  for (let iter = 0; iter < 4; iter++) {
    dist = 0;
    const rel = corners.map((p) => {
      const d: Vec3 = [p[0] - target[0], p[1] - target[1], p[2] - target[2]];
      return [d[0] * r[0] + d[1] * r[1] + d[2] * r[2], d[0] * u[0] + d[1] * u[1] + d[2] * u[2], d[0] * back[0] + d[1] * back[1] + d[2] * back[2]];
    });
    for (const [x, y, z] of rel) dist = Math.max(dist, z + Math.abs(x) / tanH, z + Math.abs(y) / tanV);
    dist = Math.max(dist, diag * 0.05);
    // re-centre the projected extents
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y, z] of rel) {
      const dd = Math.max(dist - z, 1e-6);
      x0 = Math.min(x0, x / dd); x1 = Math.max(x1, x / dd);
      y0 = Math.min(y0, y / dd); y1 = Math.max(y1, y / dd);
    }
    const mx = ((x0 + x1) / 2) * dist, my = ((y0 + y1) / 2) * dist;
    if (Math.abs(mx) + Math.abs(my) < 1e-4 * diag) break;
    target = [target[0] + r[0] * mx + u[0] * my, target[1] + r[1] * mx + u[1] * my, target[2] + r[2] * mx + u[2] * my];
  }
  const eye: Vec3 = [target[0] + back[0] * dist, target[1] + back[1] * dist, target[2] + back[2] * dist];
  return { eye, target, up: [0, 0, 1], fov };
}

/** Convenience: frame the scene (clipped to `clipZ` if given) with a preset and render it. */
export function renderPreset(
  root: SceneNode,
  materials: MaterialLookup,
  preset: ViewPreset,
  bounds: { min: Vec3; max: Vec3 },
  opts: RenderOptions = {},
): RenderedImage {
  const w = opts.width ?? 1280, h = opts.height ?? 800;
  const b = { min: [...bounds.min] as Vec3, max: [...bounds.max] as Vec3 };
  if (typeof opts.clipZ === "number") b.max[2] = Math.max(b.min[2], Math.min(b.max[2], opts.clipZ));
  return renderScene(root, materials, presetCamera(b, preset, w / h), opts);
}
