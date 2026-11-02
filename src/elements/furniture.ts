/**
 * Parametric procedural furniture & fixtures, built from MeshBuilder primitives.
 *
 * LOCAL FRAME CONVENTION (every type follows it):
 *   - Origin = CENTER of the footprint, ON THE FLOOR (z = 0). Units are meters, Z is up.
 *   - width runs along X, depth along Y, height along Z.
 *   - The FRONT of the object (where you sit, where doors/drawers open, where a screen faces,
 *     the foot end of a bed) faces -Y. The back (wall side, headboard, backrest) is at +Y.
 *   - Everything (handles, knobs, faucets, pillows...) stays inside
 *     [-w/2, w/2] x [-d/2, d/2] x [0, h].
 *   - Wall / ceiling items (upper_cabinet, mirror, tv with mount "wall", radiator, ceiling_light)
 *     are still built in z = 0..h; the caller lifts them to the right elevation.
 *     ceiling_light: z = h is the ceiling attachment point, the fixture hangs down from there.
 *
 * Parts scale with width/depth/height (proportional cushions, drawers, shelves...), while
 * structural members (legs, panels, handles) keep plausible real-world thicknesses.
 * Materials are referenced by slot; unspecified slots fall back to the type's defaults.
 */
import { MeshBuilder } from "../geometry/mesh.js";
import { m4, offsetPolygon, v3, type Vec2, type Vec3 } from "../geometry/math.js";
import { MEDICAL_FURNITURE } from "./medical.js";

export interface FurnitureSpec {
  width: number;
  depth: number;
  height: number;
  /** slot -> material name */
  materials: Record<string, string>;
  options: Record<string, unknown>;
}

export interface FurnitureOption {
  description: string;
  default: unknown;
}

export interface FurnitureType {
  /** One line, shown to AI agents. */
  description: string;
  defaults: { width: number; depth: number; height: number };
  /** material slot -> default material name */
  slots: Record<string, string>;
  /** Type-specific knobs. */
  options?: Record<string, FurnitureOption>;
  build(mb: MeshBuilder, s: FurnitureSpec): void;
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function optNum(s: FurnitureSpec, key: string, def: number, lo = -Infinity, hi = Infinity): number {
  const v = s.options?.[key];
  let n = def;
  if (typeof v === "number" && isFinite(v)) n = v;
  else if (typeof v === "string" && v.trim() !== "" && isFinite(Number(v))) n = Number(v);
  return clamp(n, lo, hi);
}

function optBool(s: FurnitureSpec, key: string, def: boolean): boolean {
  const v = s.options?.[key];
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    if (["true", "yes", "1", "on"].includes(t)) return true;
    if (["false", "no", "0", "off"].includes(t)) return false;
  }
  return def;
}

function optStr<T extends string>(s: FurnitureSpec, key: string, allowed: readonly T[], def: T): T {
  const v = s.options?.[key];
  if (typeof v === "string") {
    const t = v.trim().toLowerCase() as T;
    if (allowed.includes(t)) return t;
  }
  return def;
}

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** CCW ellipse loop; vertex i sits at angle a0 + i/seg*TAU (same as MeshBuilder.cylinder). */
function ellipse(cx: number, cy: number, rx: number, ry: number, seg: number, a0 = 0): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i < seg; i++) {
    const a = a0 + (i / seg) * TAU;
    pts.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return pts;
}

/** CCW rounded rectangle loop. Always 4*(seg+1) vertices so loops can be lofted together. */
function roundRect(cx: number, cy: number, w: number, d: number, r: number, seg = 3): Vec2[] {
  w = Math.max(w, 0.003);
  d = Math.max(d, 0.003);
  r = clamp(r, 0.0005, Math.min(w, d) / 2 - 0.0005);
  const hx = w / 2 - r, hy = d / 2 - r;
  const corners: [number, number, number][] = [
    [hx, -hy, -90],
    [hx, hy, 0],
    [-hx, hy, 90],
    [-hx, -hy, 180],
  ];
  const pts: Vec2[] = [];
  for (const [ox, oy, a0] of corners)
    for (let i = 0; i <= seg; i++) {
      const a = ((a0 + (90 * i) / seg) * Math.PI) / 180;
      pts.push([cx + ox + Math.cos(a) * r, cy + oy + Math.sin(a) * r]);
    }
  return pts;
}

/** Side wall between two CCW loops with matching vertices (lo at zlo, hi at zhi). */
function loft(mb: MeshBuilder, mat: string, lo: Vec2[], zlo: number, hi: Vec2[], zhi: number, inward = false) {
  const n = lo.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a: Vec3 = [lo[i][0], lo[i][1], zlo];
    const b: Vec3 = [lo[j][0], lo[j][1], zlo];
    const c: Vec3 = [hi[j][0], hi[j][1], zhi];
    const d: Vec3 = [hi[i][0], hi[i][1], zhi];
    if (inward) mb.quad(mat, d, c, b, a);
    else mb.quad(mat, a, b, c, d);
  }
}

/**
 * Upholstery-style block: rounded corners in plan plus a 45° bevel on the top (and bottom) edges.
 * Centered at (cx, cy), from z0 up by h.
 */
function softBox(
  mb: MeshBuilder,
  mat: string,
  cx: number,
  cy: number,
  z0: number,
  w: number,
  d: number,
  h: number,
  r = 0.03,
  bevel = 0.02,
  bevelBottom = true,
) {
  if (w < 1e-3 || d < 1e-3 || h < 1e-3) return;
  const b = clamp(bevel, 0, Math.min(h / 2, w / 2, d / 2) - 0.001);
  const rr = clamp(Math.max(r, b + 0.002), 0.001, Math.min(w, d) / 2 - 0.0005);
  const outer = roundRect(cx, cy, w, d, rr);
  if (b < 1e-4) {
    mb.prism(mat, outer, z0, z0 + h);
    return;
  }
  const inner = roundRect(cx, cy, w - 2 * b, d - 2 * b, rr - b);
  const z1 = z0 + h;
  const zb = bevelBottom ? z0 + b : z0;
  if (bevelBottom) {
    loft(mb, mat, inner, z0, outer, zb);
    mb.flat(mat, inner, z0, true);
  } else mb.flat(mat, outer, z0, true);
  loft(mb, mat, outer, zb, outer, z1 - b);
  loft(mb, mat, outer, z1 - b, inner, z1);
  mb.flat(mat, inner, z1);
}

/** Elliptic cylinder / frustum (constant rx:ry ratio) standing at z0. */
function ecyl(
  mb: MeshBuilder,
  mat: string,
  cx: number,
  cy: number,
  z0: number,
  rx: number,
  ry: number,
  h: number,
  seg = 16,
  topScale = 1,
  caps: { top?: boolean; bottom?: boolean } = { top: true, bottom: true },
) {
  mb.with(m4.mul(m4.translation(cx, cy, 0), m4.scaling(1, ry / rx, 1)), () =>
    mb.cylinder(mat, [0, 0, z0], rx, rx * topScale, h, seg, caps),
  );
}

/**
 * Thin-walled open tube / frustum (lampshades, pot rims, rings): smooth outer wall,
 * inward-facing inner wall, optional annular caps.
 */
function tube(
  mb: MeshBuilder,
  mat: string,
  cx: number,
  cy: number,
  z0: number,
  z1: number,
  r0: number,
  r1: number,
  thick: number,
  seg = 16,
  caps: { top?: boolean; bottom?: boolean } = { top: true, bottom: true },
) {
  mb.cylinder(mat, [cx, cy, z0], r0, r1, z1 - z0, seg, { top: false, bottom: false });
  const i0 = ellipse(cx, cy, r0 - thick, r0 - thick, seg);
  const i1 = ellipse(cx, cy, r1 - thick, r1 - thick, seg);
  loft(mb, mat, i0, z0, i1, z1, true);
  if (caps.top !== false) mb.flat(mat, ellipse(cx, cy, r1, r1, seg), z1, false, [i1]);
  if (caps.bottom !== false) mb.flat(mat, ellipse(cx, cy, r0, r0, seg), z0, true, [i0]);
}

/** Box with rectangular section (sx, sy) running from a to b (tilted legs, beams). */
function beam(mb: MeshBuilder, mat: string, a: Vec3, b: Vec3, sx: number, sy: number) {
  const dv = v3.sub(b, a);
  const len = v3.len(dv);
  if (len < 1e-6) return;
  const z = v3.norm(dv);
  const x: Vec3 = Math.abs(z[2]) < 0.99 ? v3.norm(v3.cross([0, 0, 1], z)) : [1, 0, 0];
  const y = v3.cross(z, x);
  mb.with(m4.fromBasis(x, y, z, a), () => mb.block(mat, 0, 0, 0, sx, sy, len));
}

/** Frame whose local +Z points along world -Y (for things on a front face: dials, portholes). */
function facingFront(x: number, y: number, z: number) {
  return m4.fromBasis([1, 0, 0], [0, 0, 1], [0, -1, 0], [x, y, z]);
}

/**
 * Open-topped basin cut into a slab: slab outline (CCW) from z0 to z1 with a hole, and an
 * inward-facing cavity going down `depth` from z1 (bottom loop = hole shrunk by `taper`).
 */
function basinSlab(
  mb: MeshBuilder,
  slabMat: string,
  basinMat: string,
  outline: Vec2[],
  hole: Vec2[],
  holeBottom: Vec2[],
  z0: number,
  z1: number,
  depth: number,
  drainMat?: string,
  drainAt?: Vec2,
) {
  loft(mb, slabMat, outline, z0, outline, z1);
  mb.flat(slabMat, outline, z1, false, [hole]);
  mb.flat(slabMat, outline, z0, true, [hole]);
  const zb = z1 - depth;
  loft(mb, basinMat, holeBottom, zb, hole, z1, true);
  mb.flat(basinMat, holeBottom, zb);
  if (drainMat && drainAt) mb.cylinder(drainMat, [drainAt[0], drainAt[1], zb], 0.025, 0.025, 0.002, 12, { bottom: false });
}

// ---- doors, drawers & handles ----

/** Front panel thickness, handle projection, total depth reserved in front of a carcass. */
const FT = 0.018;
const HP = 0.022;
const FRONT = FT + HP;
const GAP = 0.002;

type Handle = "bar_h" | "bar_v" | "knob" | "none";

/**
 * A door / drawer front on a carcass whose front face lies at y = yFace (front faces -Y).
 * The panel occupies yFace-FT..yFace, the handle projects to yFace-FRONT.
 */
function front(
  mb: MeshBuilder,
  mat: string,
  hmat: string,
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  yFace: number,
  handle: Handle,
  hx = (x0 + x1) / 2,
  hz = (z0 + z1) / 2,
  hlen?: number,
) {
  mb.box(mat, [x0 + GAP, yFace - FT, z0 + GAP], [x1 - GAP, yFace, z1 - GAP], { skip: ["+y"] });
  const yh = yFace - FT;
  if (handle === "none") return;
  if (handle === "knob") {
    mb.rod(hmat, [hx, yh, hz], [hx, yh - HP * 0.6, hz], 0.006, 8);
    mb.rod(hmat, [hx, yh - HP * 0.6, hz], [hx, yh - HP, hz], 0.015, 12);
    return;
  }
  const r = 0.0065;
  const yb = yh - HP + r;
  if (handle === "bar_h") {
    const L = hlen ?? clamp((x1 - x0) * 0.4, 0.08, 0.22);
    for (const px of [hx - L * 0.4, hx + L * 0.4]) mb.rod(hmat, [px, yh, hz], [px, yb, hz], 0.005, 6);
    mb.rod(hmat, [hx - L / 2, yb, hz], [hx + L / 2, yb, hz], r, 8);
  } else {
    const L = hlen ?? clamp((z1 - z0) * 0.3, 0.1, 0.4);
    for (const pz of [hz - L * 0.4, hz + L * 0.4]) mb.rod(hmat, [hx, yh, pz], [hx, yb, pz], 0.005, 6);
    mb.rod(hmat, [hx, yb, hz - L / 2], [hx, yb, hz + L / 2], r, 8);
  }
}

function faucet(mb: MeshBuilder, mat: string, x: number, y: number, z0: number, height: number, reach: number) {
  if (height < 0.1) return;
  const r = 0.011;
  mb.cylinder(mat, [x, y, z0], 0.026, 0.02, 0.045, 12, { bottom: false });
  const top = z0 + height - r;
  mb.cylinder(mat, [x, y, z0 + 0.045], r, r, top - z0 - 0.045, 10, { top: false, bottom: false });
  mb.sphere(mat, [x, y, top], r, 10, 6);
  mb.rod(mat, [x, y, top], [x, y - reach, top], r, 10);
  mb.sphere(mat, [x, y - reach, top], r, 10, 6);
  mb.rod(mat, [x, y - reach, top], [x, y - reach, top - Math.min(0.05, height * 0.25)], r, 10);
  // lever
  mb.rod(mat, [x + 0.015, y, z0 + 0.03], [x + 0.06, y + 0.005, z0 + 0.05], 0.006, 6);
}

function legs4(
  mb: MeshBuilder,
  mat: string,
  w: number,
  d: number,
  inset: number,
  size: number,
  z0: number,
  z1: number,
  round = false,
  taper = 1,
) {
  const lx = w / 2 - inset - size / 2, ly = d / 2 - inset - size / 2;
  for (const sx of [-1, 1])
    for (const sy of [-1, 1]) {
      if (round) mb.cylinder(mat, [sx * lx, sy * ly, z0], (size / 2) * taper, size / 2, z1 - z0, 10, { top: false });
      else mb.block(mat, sx * lx, sy * ly, z0, size, size, z1 - z0, { skip: ["+z"] });
    }
}

// ---------------------------------------------------------------------------
// builders
// ---------------------------------------------------------------------------

function buildTable(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const t = clamp(h * 0.05, 0.02, 0.05);
  if (optBool(s, "round", false)) {
    ecyl(mb, M.top, 0, 0, h - t, w / 2, d / 2, t, 24);
    const m = Math.min(w, d);
    const r = clamp(m * 0.05, 0.03, 0.07);
    const br = clamp(m * 0.28, r * 2.5, m / 2);
    mb.cylinder(M.legs, [0, 0, 0], br, br * 0.9, 0.03, 16, { bottom: true, top: true });
    mb.cylinder(M.legs, [0, 0, 0.03], r * 1.8, r, 0.12, 12, { top: false, bottom: false });
    mb.cylinder(M.legs, [0, 0, 0.15], r, r, h - t - 0.15 - 0.03, 12, { top: false, bottom: false });
    mb.cylinder(M.legs, [0, 0, h - t - 0.03], r, r * 2.5, 0.03, 12, { bottom: false, top: false });
    return;
  }
  mb.box(M.top, [-w / 2, -d / 2, h - t], [w / 2, d / 2, h]);
  const L = clamp(Math.min(w, d) * 0.06, 0.04, 0.08);
  const ins = clamp(Math.min(w, d) * 0.03, 0.01, 0.05);
  legs4(mb, M.legs, w, d, ins, L, 0, h - t);
  const lx = w / 2 - ins - L / 2, ly = d / 2 - ins - L / 2;
  const a = clamp(h * 0.1, 0.04, 0.1), at = 0.02;
  const yo = ly + L / 2 - 0.012, xo = lx + L / 2 - 0.012;
  for (const sg of [-1, 1]) {
    mb.box(M.legs, [-lx + L / 2, sg > 0 ? yo - at : -yo, h - t - a], [lx - L / 2, sg > 0 ? yo : -yo + at, h - t], { skip: ["+z"] });
    mb.box(M.legs, [sg > 0 ? xo - at : -xo, -ly + L / 2, h - t - a], [sg > 0 ? xo : -xo + at, ly - L / 2, h - t], { skip: ["+z"] });
  }
}

function buildCoffeeTable(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const t = clamp(h * 0.09, 0.02, 0.045);
  mb.prism(M.top, roundRect(0, 0, w, d, Math.min(w, d) * 0.06), h - t, h);
  const L = 0.03, ins = 0.025;
  legs4(mb, M.legs, w, d, ins, L, 0, h - t);
  if (optBool(s, "shelf", true) && h > 0.25) {
    const lx = w / 2 - ins - L, ly = d / 2 - ins;
    const zs = clamp(h * 0.25, 0.08, 0.2);
    mb.box(M.top, [-lx, -ly, zs], [lx, ly, zs + 0.02]);
  }
}

function buildSideTable(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const t = clamp(h * 0.05, 0.018, 0.035);
  if (optBool(s, "round", true)) {
    const rx = w / 2, ry = d / 2;
    ecyl(mb, M.top, 0, 0, h - t, rx, ry, t, 20);
    const lr = 0.014;
    for (let i = 0; i < 3; i++) {
      const a = Math.PI / 2 + (i / 3) * TAU + Math.PI / 3; // one leg at the back, two at the front
      const top: Vec3 = [Math.cos(a) * rx * 0.55, Math.sin(a) * ry * 0.55, h - t];
      const bot: Vec3 = [Math.cos(a) * (rx - lr - 0.01), Math.sin(a) * (ry - lr - 0.01), 0.004];
      mb.rod(M.legs, bot, top, lr, 8);
    }
    return;
  }
  mb.box(M.top, [-w / 2, -d / 2, h - t], [w / 2, d / 2, h]);
  const L = clamp(Math.min(w, d) * 0.07, 0.025, 0.045);
  legs4(mb, M.legs, w, d, 0.01, L, 0, h - t);
  const lx = w / 2 - 0.01 - L, ly = d / 2 - 0.01;
  const zs = h * 0.3;
  mb.box(M.top, [-lx, -ly + L, zs], [lx, ly - L, zs + 0.018]);
}

function buildDesk(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const t = 0.03;
  mb.box(M.top, [-w / 2, -d / 2, h - t], [w / 2, d / 2, h]);
  const side = optStr(s, "drawers", ["right", "left", "none"] as const, "right");
  const pw = clamp(w * 0.3, 0.3, 0.45);
  const yBack = d / 2 - 0.02;
  const yFace = -d / 2 + 0.01 + FRONT;
  const panel = 0.025;
  const draw = (sx: number) => {
    // drawer pedestal on side sx (+1 right/+X, -1 left)
    const x0 = sx > 0 ? w / 2 - pw : -w / 2, x1 = sx > 0 ? w / 2 : -w / 2 + pw;
    mb.box(M.body, [x0, yFace, 0], [x1, yBack, h - t], { skip: ["+z"] });
    const n = h > 0.6 ? 3 : 2;
    const zt = h - t - 0.004;
    const hs = [0.18, 0.18, zt - 0.36 - 0.005];
    let z = zt;
    for (let i = 0; i < n; i++) {
      const hh = i === n - 1 ? z - 0.005 : Math.min(hs[i], (zt - 0.005) / n);
      front(mb, M.body, M.handles, x0, x1, z - hh, z, yFace, "bar_h", (x0 + x1) / 2, z - Math.min(0.05, hh / 2));
      z -= hh;
    }
  };
  const legPanel = (sx: number) => {
    const x0 = sx > 0 ? w / 2 - panel : -w / 2, x1 = sx > 0 ? w / 2 : -w / 2 + panel;
    mb.box(M.body, [x0, -d / 2 + 0.02, 0], [x1, yBack, h - t], { skip: ["+z"] });
  };
  if (side === "right") { draw(1); legPanel(-1); }
  else if (side === "left") { draw(-1); legPanel(1); }
  else { legPanel(1); legPanel(-1); }
  // modesty panel
  const mx0 = side === "left" ? -w / 2 + pw : -w / 2 + panel;
  const mx1 = side === "right" ? w / 2 - pw : w / 2 - panel;
  mb.box(M.body, [mx0, yBack - 0.018, h * 0.35], [mx1, yBack, h - t], { skip: ["+z"] });
}

function buildChair(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const seatH = clamp(h * 0.5, 0.3, 0.5);
  const L = clamp(w * 0.08, 0.03, 0.045);
  const lean = (6 * Math.PI) / 180;
  const backH = h - seatH;
  // back legs lean back: base offset forward so the top ends at the back edge
  const yTop = d / 2 - L / 2;
  const zb = (L / 2) * Math.sin(lean);
  const lenB = (h - zb - (L / 2) * Math.sin(lean)) / Math.cos(lean);
  const yBase = yTop - lenB * Math.sin(lean);
  const yAt = (z: number) => yBase + (z - zb) * Math.tan(lean);
  const lx = w / 2 - L / 2 - 0.005;
  const seatBack = yAt(seatH) + L / 2;
  // front legs
  for (const sx of [-1, 1]) mb.block(M.frame, sx * lx, -d / 2 + L / 2 + 0.005, 0, L, L, seatH - 0.05, { skip: ["+z"] });
  // seat frame + cushion
  mb.box(M.frame, [-w / 2 + 0.005, -d / 2 + 0.005, seatH - 0.05], [w / 2 - 0.005, seatBack - L, seatH - 0.02]);
  softBox(mb, M.seat, 0, (-d / 2 + 0.003 + seatBack - L) / 2, seatH - 0.02, w - 0.012, seatBack - L + d / 2 - 0.003, 0.04, 0.03, 0.012, false);
  // back frame (tilted)
  mb.with(m4.mul(m4.translation(0, yBase, zb), m4.rotationX(-lean)), () => {
    for (const sx of [-1, 1]) mb.block(M.frame, sx * lx, 0, 0, L, L, lenB);
    const rail = (z0: number, hh: number) => mb.block(M.frame, 0, 0, z0, 2 * lx - L, L * 0.6, hh);
    rail(lenB - Math.min(0.13, backH * 0.32), Math.min(0.11, backH * 0.28));
    rail(seatH + backH * 0.35, 0.03);
    // stretcher low between back legs
    rail(0.12, 0.02);
  });
  // side stretchers
  for (const sx of [-1, 1]) mb.box(M.frame, [sx * lx - 0.008, -d / 2 + L + 0.005, 0.12], [sx * lx + 0.008, yAt(0.12) - L / 2, 0.14]);
}

function buildOfficeChair(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const R = Math.min(w, d) / 2 - 0.03;
  const seatH = clamp(h * 0.42, 0.38, 0.55);
  // five-star base with casters
  mb.cylinder(M.base, [0, 0, 0.07], 0.045, 0.04, 0.06, 12);
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (i / 5) * TAU;
    const c = Math.cos(a), sn = Math.sin(a);
    const end: Vec3 = [c * R, sn * R, 0.065];
    beam(mb, M.base, [c * 0.03, sn * 0.03, 0.1], end, 0.035, 0.03);
    mb.cylinder(M.base, [c * R, sn * R, 0.04], 0.012, 0.012, 0.025, 8);
    // caster wheel: short horizontal cylinder perpendicular to the leg
    const t: Vec3 = [-sn * 0.012, c * 0.012, 0];
    mb.rod(M.casters, [c * R - t[0], sn * R - t[1], 0.025], [c * R + t[0], sn * R + t[1], 0.025], 0.025, 10);
  }
  // gas lift
  mb.cylinder(M.frame, [0, 0, 0.13], 0.035, 0.03, 0.17, 12, { bottom: false });
  mb.cylinder(M.base, [0, 0, 0.3], 0.018, 0.018, seatH - 0.08 - 0.3, 10, { bottom: false, top: false });
  mb.block(M.frame, 0, 0, seatH - 0.1, 0.2, 0.22, 0.03);
  // seat
  const sw = Math.min(w * 0.78, 0.52), sd = Math.min(d * 0.75, 0.5);
  const sy = -d / 2 + 0.02 + sd / 2;
  softBox(mb, M.frame, 0, sy, seatH - 0.07, sw, sd, 0.025, 0.06, 0.008);
  softBox(mb, M.seat, 0, sy, seatH - 0.05, sw - 0.01, sd - 0.01, 0.05, 0.07, 0.025, false);
  // back support + backrest
  const yb = d / 2 - 0.05;
  const bz0 = seatH + 0.1;
  beam(mb, M.frame, [0, sy + sd / 2 - 0.08, seatH - 0.075], [0, yb - 0.01, seatH - 0.075], 0.05, 0.02);
  beam(mb, M.frame, [0, yb - 0.01, seatH - 0.085], [0, yb - 0.01, bz0 + 0.1], 0.05, 0.02);
  const lean = (8 * Math.PI) / 180;
  const bh = (h - bz0) / Math.cos(lean) - 0.02;
  const bw = Math.min(w * 0.72, 0.47);
  mb.with(m4.mul(m4.translation(0, yb - 0.035 - (h - bz0) * Math.tan(lean) * 0.6, bz0), m4.rotationX(-lean)), () => {
    softBox(mb, M.frame, 0, 0.025, 0, bw, 0.025, bh, 0.06, 0.008);
    softBox(mb, M.seat, 0, -0.01, 0.02, bw - 0.02, 0.05, bh - 0.04, 0.06, 0.02);
  });
  // armrests
  if (optBool(s, "arms", true)) {
    const ax = Math.min(sw / 2 + 0.03, w / 2 - 0.03);
    const az = seatH + 0.21;
    for (const sx of [-1, 1]) {
      const px = sx * (ax - 0.01);
      mb.box(M.frame, [Math.min(sx * 0.09, px), sy + 0.045, seatH - 0.09], [Math.max(sx * 0.09, px), sy + 0.075, seatH - 0.075]);
      mb.block(M.frame, px, sy + 0.06, seatH - 0.09, 0.02, 0.03, az - seatH + 0.09, { skip: ["+z"] });
      softBox(mb, M.frame, px, sy + 0.02, az, 0.06, 0.25, 0.03, 0.02, 0.008);
    }
  }
}

interface SofaDims {
  armW: number;
  backD: number;
  legH: number;
  baseTop: number;
  ct: number;
  armTop: number;
  bt: number;
}

function sofaDims(w: number, d: number, h: number, arms: boolean): SofaDims {
  const legH = clamp(h * 0.12, 0.04, 0.14);
  const baseTop = legH + clamp(h * 0.25, 0.12, 0.28);
  const ct = clamp(h * 0.14, 0.08, 0.16);
  return {
    armW: arms ? clamp(w * 0.08 + 0.05, 0.1, 0.2) : 0,
    backD: clamp(d * 0.2, 0.12, 0.25),
    legH,
    baseTop,
    ct,
    armTop: Math.min(h, baseTop + ct + clamp(h * 0.22, 0.12, 0.25)),
    bt: clamp(d * 0.17, 0.1, 0.2),
  };
}

/** Back cushions leaning on a back whose front face is at y = yBack (local frame, back at +Y). */
function backCushions(mb: MeshBuilder, mat: string, x0: number, x1: number, n: number, yBack: number, zSeat: number, top: number, bt: number) {
  const lean = (9 * Math.PI) / 180;
  const bh = (top - zSeat) / Math.cos(lean);
  if (bh < 0.08 || n < 1) return;
  const cw = (x1 - x0) / n;
  mb.with(m4.mul(m4.translation(0, yBack, zSeat - 0.02), m4.rotationX(-lean)), () => {
    for (let i = 0; i < n; i++) softBox(mb, mat, x0 + cw * (i + 0.5), -bt / 2, 0, cw - 0.008, bt, bh, 0.05, 0.035);
  });
}

function seatCushions(mb: MeshBuilder, mat: string, x0: number, x1: number, y0: number, y1: number, n: number, z: number, ct: number) {
  const cw = (x1 - x0) / n;
  for (let i = 0; i < n; i++) softBox(mb, mat, x0 + cw * (i + 0.5), (y0 + y1) / 2, z, cw - 0.008, y1 - y0, ct, 0.04, 0.03);
}

function sofaLeg(mb: MeshBuilder, mat: string, x: number, y: number, legH: number) {
  mb.cylinder(mat, [x, y, 0], 0.017, 0.024, legH + 0.01, 10, { top: false });
}

function buildSofa(mb: MeshBuilder, s: FurnitureSpec, defaultSeats?: number) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const arms = optBool(s, "arms", true);
  const D = sofaDims(w, d, h, arms);
  const iw = w - 2 * D.armW;
  const auto = defaultSeats ?? clamp(Math.round(iw / 0.62), 1, 6);
  const n = Math.round(optNum(s, "seats", auto, 1, 8));
  const ov = Math.min(D.armW, 0.02);
  // arms
  if (arms)
    for (const sx of [-1, 1])
      softBox(mb, M.body, sx * (w / 2 - D.armW / 2), 0, D.legH, D.armW, d, D.armTop - D.legH, Math.min(0.06, D.armW / 2), 0.03);
  // back + seat platform
  softBox(mb, M.body, 0, d / 2 - D.backD / 2, D.legH, iw + 2 * ov, D.backD, h - D.legH, 0.03, 0.03);
  softBox(mb, M.body, 0, (-d / 2 + d / 2 - D.backD) / 2 + 0.01, D.legH, iw + 2 * ov, d - D.backD + 0.02, D.baseTop - D.legH, 0.02, 0.015);
  // cushions
  seatCushions(mb, M.cushions, -iw / 2, iw / 2, -d / 2 + 0.004, d / 2 - D.backD, n, D.baseTop, D.ct);
  backCushions(mb, M.cushions, -iw / 2, iw / 2, n, d / 2 - D.backD, D.baseTop + D.ct, h - 0.04, D.bt);
  // legs
  const lx = w / 2 - 0.06, ly = d / 2 - 0.06;
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) sofaLeg(mb, M.legs, sx * lx, sy * ly, D.legH);
  if (w > 1.8) for (const sy of [-1, 1]) sofaLeg(mb, M.legs, 0, sy * ly, D.legH);
}

function buildSectional(mb: MeshBuilder, s: FurnitureSpec) {
  const left = optStr(s, "chaise", ["right", "left"] as const, "right") === "left";
  const go = () => {
    const { width: w, depth: d, height: h } = s;
    const M = s.materials;
    const D = sofaDims(Math.min(w, d), d, h, true);
    const sd = clamp(Math.min(w, d) * 0.45, 0.75, 1.0);
    const { armW, backD, legH, baseTop, ct, bt } = D;
    // arms: left end of the main run, front end of the chaise run
    softBox(mb, M.body, -w / 2 + armW / 2, d / 2 - sd / 2, legH, armW, sd, D.armTop - legH, 0.06, 0.03);
    softBox(mb, M.body, w / 2 - sd / 2, -d / 2 + armW / 2, legH, sd, armW, D.armTop - legH, 0.06, 0.03);
    // backs
    softBox(mb, M.body, (-w / 2 + armW - 0.02 + w / 2) / 2, d / 2 - backD / 2, legH, w - armW + 0.02, backD, h - legH, 0.03, 0.03);
    softBox(mb, M.body, w / 2 - backD / 2, (-d / 2 + armW - 0.02 + d / 2 - backD + 0.02) / 2, legH, backD, d - armW - backD + 0.04, h - legH, 0.03, 0.03);
    // seat platforms
    const bx0 = -w / 2 + armW - 0.02, bx1 = w / 2 - backD + 0.02;
    softBox(mb, M.body, (bx0 + bx1) / 2, (d / 2 - sd + d / 2 - backD + 0.02) / 2, legH, bx1 - bx0, sd - backD + 0.02, baseTop - legH, 0.02, 0.015);
    const by0 = -d / 2 + armW - 0.02, by1 = d / 2 - sd + 0.02;
    softBox(mb, M.body, (w / 2 - sd + bx1) / 2, (by0 + by1) / 2, legH, bx1 - (w / 2 - sd), by1 - by0, baseTop - legH, 0.02, 0.015);
    // seat cushions
    const runL = w / 2 - sd - (-w / 2 + armW);
    const k = Math.max(1, Math.round(runL / 0.65));
    seatCushions(mb, M.cushions, -w / 2 + armW, w / 2 - sd, d / 2 - sd + 0.004, d / 2 - backD, k, baseTop, ct);
    seatCushions(mb, M.cushions, w / 2 - sd + 0.004, w / 2 - backD, d / 2 - sd + 0.004, d / 2 - backD, 1, baseTop, ct);
    const runC = d / 2 - sd - (-d / 2 + armW);
    const m = Math.max(1, Math.round(runC / 0.65));
    const cw = runC / m;
    for (let i = 0; i < m; i++)
      softBox(mb, M.cushions, (w / 2 - sd + w / 2 - backD) / 2 + 0.002, -d / 2 + armW + cw * (i + 0.5), baseTop, sd - backD - 0.004, cw - 0.008, ct, 0.04, 0.03);
    // back cushions along +Y
    backCushions(mb, M.cushions, -w / 2 + armW, w / 2 - sd, k, d / 2 - backD, baseTop + ct, h - 0.04, bt);
    backCushions(mb, M.cushions, w / 2 - sd, w / 2 - backD - bt, 1, d / 2 - backD, baseTop + ct, h - 0.04, bt);
    // back cushions along +X (local frame rotated so its +Y is world +X; local x = -world y)
    mb.with(m4.rotationZ(-Math.PI / 2), () => {
      backCushions(mb, M.cushions, -(d / 2 - sd), -(-d / 2 + armW), m, w / 2 - backD, baseTop + ct, h - 0.04, bt);
      backCushions(mb, M.cushions, -(d / 2 - backD), -(d / 2 - sd), 1, w / 2 - backD, baseTop + ct, h - 0.04, bt);
    });
    // legs
    const e = 0.06;
    const pts: Vec2[] = [
      [-w / 2 + e, d / 2 - e], [-w / 2 + e, d / 2 - sd + e], [w / 2 - e, d / 2 - e], [w / 2 - e, -d / 2 + e],
      [w / 2 - sd + e, -d / 2 + e], [w / 2 - sd + e, d / 2 - sd + e], [0, d / 2 - e], [0, d / 2 - sd + e],
    ];
    for (const p of pts) sofaLeg(mb, M.legs, p[0], p[1], legH);
  };
  if (left) mb.with(m4.scaling(-1, 1, 1), go);
  else go();
}

function mattressSet(
  mb: MeshBuilder,
  M: Record<string, string>,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  z: number,
  mt: number,
  pillows = true,
) {
  const w = x1 - x0, d = y1 - y0, cx = (x0 + x1) / 2;
  softBox(mb, M.mattress, cx, (y0 + y1) / 2, z, w - 0.02, d - 0.02, mt, 0.06, 0.03);
  const top = z + mt;
  // duvet covers the foot ~70%, draping over the sides
  const dy1 = y1 - Math.min(0.62, d * 0.32);
  const drop = Math.min(mt * 0.7, 0.18);
  softBox(mb, M.duvet, cx, (y0 + dy1) / 2, top - drop, w, dy1 - y0, drop + 0.035, 0.05, 0.025);
  // folded top edge
  softBox(mb, M.duvet, cx, dy1 - 0.12, top - 0.02, w - 0.012, 0.24, 0.07, 0.04, 0.03);
  if (!pillows) return;
  const np = w >= 1.15 ? 2 : 1;
  const pw = Math.min((w - 0.12) / np - 0.04, 0.72);
  const pd = Math.min(0.42, (y1 - dy1) - 0.08);
  for (let i = 0; i < np; i++) {
    const px = np === 1 ? cx : cx + (i === 0 ? -1 : 1) * (pw / 2 + 0.03);
    softBox(mb, M.pillows, px, y1 - 0.05 - pd / 2, top - 0.01, pw, pd, 0.13, 0.08, 0.05);
  }
}

function buildBed(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const hbT = clamp(d * 0.03, 0.04, 0.08);
  const legH = 0.08;
  const frameTop = clamp(h * 0.3, 0.2, 0.36);
  const mt = clamp(h * 0.22, 0.12, 0.25);
  // headboard
  softBox(mb, M.headboard, 0, d / 2 - hbT / 2, 0, w, hbT, h, 0.02, 0.012, false);
  // frame
  mb.box(M.frame, [-w / 2, -d / 2, legH], [w / 2, d / 2 - hbT, frameTop]);
  const L = 0.06;
  for (const sx of [-1, 1]) mb.block(M.frame, sx * (w / 2 - L / 2 - 0.02), -d / 2 + L / 2 + 0.02, 0, L, L, legH, { skip: ["+z"] });
  for (const sx of [-1, 1]) mb.block(M.frame, sx * (w / 2 - L / 2 - 0.02), d / 2 - hbT - L / 2 - 0.02, 0, L, L, legH, { skip: ["+z"] });
  mattressSet(mb, M, -w / 2 + 0.01, w / 2 - 0.01, -d / 2 + 0.01, d / 2 - hbT - 0.01, frameTop, mt);
}

function buildBunkBed(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const P = 0.06;
  const lowDeck = clamp(h * 0.15, 0.18, 0.3);
  const upDeck = Math.max(lowDeck + 0.8, h - 0.55);
  const mt = 0.14;
  const px = w / 2 - P / 2, py = d / 2 - P / 2;
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) mb.block(M.frame, sx * px, sy * py, 0, P, P, h);
  const rails = (z: number, hh: number, ends = true, frontEnd = true) => {
    for (const sx of [-1, 1]) mb.box(M.frame, [sx * px - 0.015, -py + P / 2, z], [sx * px + 0.015, py - P / 2, z + hh]);
    if (ends) {
      mb.box(M.frame, [-px + P / 2, py - 0.015, z], [px - P / 2, py + 0.015, z + hh]);
      if (frontEnd) mb.box(M.frame, [-px + P / 2, -py - 0.015, z], [px - P / 2, -py + 0.015, z + hh]);
    }
  };
  const deck = (z: number) => {
    rails(z - 0.12, 0.12);
    mb.box(M.frame, [-px + 0.015, -py + 0.015, z - 0.03], [px - 0.015, py - 0.015, z - 0.01]);
  };
  deck(lowDeck);
  deck(upDeck);
  // head / foot panels
  mb.box(M.frame, [-px + P / 2, py - 0.012, upDeck + mt], [px - P / 2, py + 0.012, h - 0.04]);
  mb.box(M.frame, [-px + P / 2, py - 0.012, lowDeck + mt], [px - P / 2, py + 0.012, upDeck - 0.2]);
  mb.box(M.frame, [-px + P / 2, -py - 0.012, lowDeck + mt], [px - P / 2, -py + 0.012, lowDeck + mt + 0.2]);
  // upper guard rails (long sides), foot end left open for the ladder
  for (const z of [h - 0.08, upDeck + mt + 0.1]) rails(z, 0.05, false);
  const inner = w / 2 - P - 0.005;
  mattressSet(mb, M, -inner, inner, -d / 2 + P + 0.005, d / 2 - P - 0.005, lowDeck - 0.01, mt);
  mattressSet(mb, M, -inner, inner, -d / 2 + P + 0.005, d / 2 - P - 0.005, upDeck - 0.01, mt);
  // ladder at the foot end
  const lw = Math.min(0.4, w - 2 * P - 0.1);
  const ly = -d / 2 + 0.02;
  for (const sx of [-1, 1]) mb.block(M.frame, sx * (lw / 2), ly, 0, 0.035, 0.04, upDeck + mt + 0.25);
  const nr = Math.max(2, Math.round((upDeck + mt) / 0.3));
  for (let i = 1; i <= nr; i++) {
    const z = ((upDeck + mt) * i) / (nr + 0.3);
    mb.rod(M.frame, [-lw / 2, ly, z], [lw / 2, ly, z], 0.014, 8);
  }
}

function buildNightstand(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const legH = clamp(h * 0.15, 0.04, 0.12);
  const t = 0.025;
  const yFace = -d / 2 + FRONT;
  mb.box(M.body, [-w / 2, -d / 2, h - t], [w / 2, d / 2, h]);
  mb.box(M.body, [-w / 2 + 0.005, yFace, legH], [w / 2 - 0.005, d / 2, h - t], { skip: ["+z"] });
  legs4(mb, M.body, w, d, 0.02, 0.035, 0, legH, true, 0.65);
  const n = Math.round(optNum(s, "drawers", 2, 1, 4));
  const zh = (h - t - legH) / n;
  for (let i = 0; i < n; i++) {
    const z0 = legH + i * zh;
    front(mb, M.body, M.handles, -w / 2 + 0.005, w / 2 - 0.005, z0, z0 + zh, yFace, "knob");
  }
}

function buildWardrobe(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const plinth = 0.08;
  const yFace = -d / 2 + FRONT;
  mb.box(M.body, [-w / 2 + 0.01, yFace + 0.04, 0], [w / 2 - 0.01, d / 2, plinth], { skip: ["+z"] });
  mb.box(M.body, [-w / 2, yFace, plinth], [w / 2, d / 2, h]);
  const n = Math.round(optNum(s, "doors", clamp(Math.round(w / 0.5), 1, 6), 1, 8));
  const dw = w / n;
  for (let i = 0; i < n; i++) {
    const x0 = -w / 2 + i * dw, x1 = x0 + dw;
    // pairs open from the middle; an odd last door gets its handle on the left
    const handleRight = i % 2 === 0 && i < n - 1;
    const hx = handleRight ? x1 - 0.05 : x0 + 0.05;
    front(mb, M.body, M.handles, x0, x1, plinth, h, yFace, "bar_v", hx, plinth + (h - plinth) * 0.5, 0.35);
  }
}

function buildDresser(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const legH = clamp(h * 0.1, 0.04, 0.1);
  const t = 0.025;
  const yFace = -d / 2 + FRONT;
  mb.box(M.body, [-w / 2, -d / 2, h - t], [w / 2, d / 2, h]);
  mb.box(M.body, [-w / 2 + 0.008, yFace, legH], [w / 2 - 0.008, d / 2 - 0.005, h - t], { skip: ["+z"] });
  legs4(mb, M.body, w, d, 0.02, 0.04, 0, legH, true, 0.6);
  const rows = Math.round(optNum(s, "rows", clamp(Math.round((h - legH) / 0.22), 1, 8), 1, 10));
  const cols = Math.round(optNum(s, "columns", w > 0.95 ? 2 : 1, 1, 4));
  const zh = (h - t - legH) / rows, xw = (w - 0.016) / cols;
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const x0 = -w / 2 + 0.008 + c * xw, z0 = legH + r * zh;
      front(mb, M.body, M.handles, x0, x0 + xw, z0, z0 + zh, yFace, "bar_h", undefined, undefined, Math.min(0.16, xw * 0.35));
    }
}

function buildBookshelf(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const t = clamp(Math.min(w, d) * 0.06, 0.015, 0.025);
  const base = clamp(h * 0.04, 0.03, 0.08);
  const bk = 0.008;
  mb.box(M.frame, [-w / 2, -d / 2, 0], [-w / 2 + t, d / 2, h]);
  mb.box(M.frame, [w / 2 - t, -d / 2, 0], [w / 2, d / 2, h]);
  mb.box(M.frame, [-w / 2 + t, -d / 2, h - t], [w / 2 - t, d / 2, h]);
  mb.box(M.frame, [-w / 2 + t, -d / 2 + 0.012, 0], [w / 2 - t, d / 2 - bk, base]);
  mb.box(M.frame, [-w / 2 + t, d / 2 - bk, 0], [w / 2 - t, d / 2, h - t]);
  const zb = base, zt = h - t;
  const n = Math.round(optNum(s, "shelves", Math.max(0, Math.round((zt - zb) / 0.36) - 1), 0, 20));
  const span = (zt - zb) / (n + 1);
  const bounds: [number, number][] = [];
  let lo = zb;
  for (let i = 1; i <= n; i++) {
    const zc = zb + i * span;
    mb.box(M.frame, [-w / 2 + t, -d / 2 + 0.006, zc - t / 2], [w / 2 - t, d / 2 - bk, zc + t / 2]);
    bounds.push([lo, zc - t / 2]);
    lo = zc + t / 2;
  }
  bounds.push([lo, zt]);
  if (!optBool(s, "books", true)) return;
  const slots = [M.book_a, M.book_b, M.book_c, M.book_d];
  const rnd = rng(Math.round(w * 1000) * 31 + Math.round(h * 1000) * 7 + n);
  const xl = -w / 2 + t + 0.004, xr = w / 2 - t - 0.004;
  bounds.forEach(([b0, b1], ci) => {
    const clear = b1 - b0;
    if (clear < 0.1) return;
    let x = xl + rnd() * 0.04;
    const stop = xr - rnd() * (xr - xl) * 0.3;
    while (true) {
      if (rnd() < 0.07) x += 0.04 + rnd() * 0.1;
      const bw = 0.018 + rnd() * 0.03;
      if (x + bw > stop) break;
      const bh = Math.min(clear - 0.012, 0.33, clear * (0.62 + rnd() * 0.3));
      const bd = Math.min(d - bk - 0.035, 0.14 + rnd() * 0.08);
      const y0 = -d / 2 + 0.012 + rnd() * 0.012;
      mb.box(slots[Math.floor(rnd() * slots.length) % slots.length], [x, y0, b0], [x + bw, y0 + bd, b0 + bh]);
      x += bw + 0.0015;
    }
    void ci;
  });
}

function buildTvStand(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const legH = clamp(h * 0.2, 0.04, 0.12);
  const t = 0.022;
  const f = 0.012; // door recess
  mb.box(M.body, [-w / 2, -d / 2, h - t], [w / 2, d / 2, h]);
  mb.box(M.body, [-w / 2, -d / 2, legH], [w / 2, d / 2, legH + t]);
  mb.box(M.body, [-w / 2, -d / 2, legH + t], [-w / 2 + t, d / 2, h - t]);
  mb.box(M.body, [w / 2 - t, -d / 2, legH + t], [w / 2, d / 2, h - t]);
  mb.box(M.body, [-w / 2 + t, d / 2 - 0.01, legH + t], [w / 2 - t, d / 2, h - t]);
  const xd = w / 6;
  for (const sx of [-1, 1]) mb.box(M.body, [sx * xd - t / 2, -d / 2 + f, legH + t], [sx * xd + t / 2, d / 2 - 0.01, h - t]);
  const zm = (legH + t + h - t) / 2;
  mb.box(M.body, [-xd + t / 2, -d / 2 + f + 0.01, zm - t / 2], [xd - t / 2, d / 2 - 0.01, zm + t / 2]);
  // doors (inset) with slim pull bars
  for (const sx of [-1, 1]) {
    const x0 = sx < 0 ? -w / 2 + t : xd + t / 2, x1 = sx < 0 ? -xd - t / 2 : w / 2 - t;
    mb.box(M.body, [x0 + GAP, -d / 2 + f, legH + t + GAP], [x1 - GAP, -d / 2 + f + FT, h - t - GAP], { skip: ["+y"] });
    mb.box(M.accent, [x0 + (x1 - x0) * 0.25, -d / 2, h - t - 0.03], [x1 - (x1 - x0) * 0.25, -d / 2 + f, h - t - 0.018]);
  }
  // a set-top box in the open compartment
  mb.box(M.accent, [-Math.min(0.15, xd - t), d / 2 - 0.25 > -d / 2 + 0.05 ? -d / 2 + 0.05 : -d / 2 + 0.03, legH + t], [Math.min(0.15, xd - t), Math.min(d / 2 - 0.02, -d / 2 + 0.3), Math.min(zm - t / 2 - 0.005, legH + t + 0.05)]);
  legs4(mb, M.legs, w, d, 0.03, 0.03, 0, legH);
}

function buildTv(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const wall = optStr(s, "mount", ["stand", "wall"] as const, "stand") === "wall";
  const pt = Math.min(d, 0.05);
  const bezel = clamp(w * 0.012, 0.006, 0.02);
  const panel = (y0: number, z0: number, z1: number) => {
    mb.box(M.frame, [-w / 2, y0, z0], [w / 2, y0 + pt, z1]);
    // screen glass 1.5 mm proud of the bezel
    mb.box(M.screen, [-w / 2 + bezel, y0 - 0.0015, z0 + bezel * 1.4], [w / 2 - bezel, y0, z1 - bezel], { skip: ["+y"] });
  };
  if (wall) {
    panel(d / 2 - pt, 0, h);
    return;
  }
  const footH = 0.02;
  const ph = Math.min(w * 0.5625 + 0.03, h - 0.07);
  const z0 = h - ph;
  const bw = Math.min(w * 0.35, 0.5);
  mb.box(M.frame, [-bw / 2, -d / 2 + 0.01, 0], [bw / 2, d / 2 - 0.01, footH]);
  mb.box(M.frame, [-0.04, pt / 2, footH], [0.04, Math.min(pt / 2 + 0.03, d / 2), z0 + ph * 0.3]);
  panel(-pt / 2, z0, h);
}

interface CounterOpts {
  cabBack: number;
  counterH: number;
  basin?: { cx: number; y0: number; w: number; d: number; depth: number; faucetH: number };
}

function buildCounterRun(mb: MeshBuilder, s: FurnitureSpec, o: CounterOpts) {
  const { width: w, depth: d } = s;
  const M = s.materials;
  const ch = o.counterH;
  const ct = 0.04;
  const toe = clamp(ch * 0.11, 0.06, 0.12);
  const yFace = -d / 2 + 0.02 + FRONT;
  const top = ch - ct;
  mb.box(M.plinth, [-w / 2 + 0.002, yFace + 0.05, 0], [w / 2 - 0.002, o.cabBack - 0.002, toe], { skip: ["+z"] });
  mb.box(M.cabinet, [-w / 2, yFace, toe], [w / 2, o.cabBack, top], { skip: ["+z"] });
  const outline = roundRect(0, 0, w, d, 0.004, 1);
  if (o.basin) {
    const b = o.basin;
    const hole = roundRect(b.cx, b.y0 + b.d / 2, b.w, b.d, 0.05);
    const bottom = roundRect(b.cx, b.y0 + b.d / 2, b.w - 0.04, b.d - 0.04, 0.035);
    basinSlab(mb, M.counter, M.basin, outline, hole, bottom, top, ch, b.depth, M.basin, [b.cx, b.y0 + b.d / 2]);
    faucet(mb, M.basin, b.cx, b.y0 + b.d + 0.045, ch, b.faucetH, Math.min(0.17, b.d * 0.45));
  } else {
    mb.prism(M.counter, outline, top, ch);
  }
  const drawers = optBool(s, "drawers", true);
  const n = Math.max(1, Math.round(w / 0.6));
  const uw = w / n;
  const dh = Math.min(0.16, (top - toe) * 0.25);
  for (let i = 0; i < n; i++) {
    const x0 = -w / 2 + i * uw, x1 = x0 + uw;
    let zTop = top - 0.003;
    if (drawers) {
      const isSink = o.basin && Math.abs((x0 + x1) / 2 - o.basin.cx) < uw / 2;
      front(mb, M.cabinet, M.handles, x0, x1, zTop - dh, zTop, yFace, isSink ? "none" : "bar_h");
      zTop -= dh;
    }
    if (uw > 0.75) {
      const xm = (x0 + x1) / 2;
      front(mb, M.cabinet, M.handles, x0, xm, toe, zTop, yFace, "bar_v", xm - 0.04, zTop - 0.1, 0.12);
      front(mb, M.cabinet, M.handles, xm, x1, toe, zTop, yFace, "bar_v", xm + 0.04, zTop - 0.1, 0.12);
    } else {
      front(mb, M.cabinet, M.handles, x0, x1, toe, zTop, yFace, "bar_h", undefined, zTop - 0.05);
    }
  }
}

function buildUpperCabinet(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const yFace = -d / 2 + FRONT;
  mb.box(M.cabinet, [-w / 2, yFace, 0], [w / 2, d / 2, h]);
  const n = Math.round(optNum(s, "doors", clamp(Math.round(w / 0.45), 1, 6), 1, 8));
  const dw = w / n;
  for (let i = 0; i < n; i++) {
    const x0 = -w / 2 + i * dw, x1 = x0 + dw;
    const handleRight = i % 2 === 0 && i < n - 1;
    front(mb, M.cabinet, M.handles, x0, x1, 0, h, yFace, "bar_v", handleRight ? x1 - 0.04 : x0 + 0.04, 0.1, 0.12);
  }
}

function buildFridge(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const kick = 0.07;
  const dt = 0.045;
  const yFace = -d / 2 + 0.03 + dt;
  mb.box(M.trim, [-w / 2 + 0.02, yFace + 0.01, 0], [w / 2 - 0.02, d / 2 - 0.02, kick], { skip: ["+z"] });
  mb.box(M.body, [-w / 2, yFace, kick], [w / 2, d / 2, h]);
  const split = kick + (h - kick) * 0.36;
  const door = (z0: number, z1: number, hz: number, hl: number) => {
    mb.box(M.body, [-w / 2 + 0.003, yFace - dt, z0 + 0.003], [w / 2 - 0.003, yFace, z1 - 0.003], { skip: ["+y"] });
    const hx = -w / 2 + 0.05;
    for (const z of [hz - hl / 2 + 0.02, hz + hl / 2 - 0.02]) mb.block(M.handles, hx, yFace - dt - 0.015, z - 0.01, 0.018, 0.03, 0.02);
    mb.block(M.handles, hx, -d / 2 + 0.008, hz - hl / 2, 0.022, 0.016, hl);
  };
  door(kick, split, split - 0.18, Math.min(0.3, (split - kick) * 0.6));
  door(split, h, split + 0.3, Math.min(0.6, (h - split) * 0.5));
}

function buildStove(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const kick = 0.06;
  const yFace = -d / 2 + 0.035;
  const topZ = h - 0.012;
  mb.box(M.top, [-w / 2 + 0.01, yFace + 0.03, 0], [w / 2 - 0.01, d / 2 - 0.01, kick], { skip: ["+z"] });
  mb.box(M.body, [-w / 2, yFace, kick], [w / 2, d / 2, topZ - 0.012], { skip: ["+z"] });
  mb.box(M.top, [-w / 2, yFace, topZ - 0.012], [w / 2, d / 2, topZ]);
  // burners
  const bxs = [-w / 4, w / 4], bys = [yFace + (d / 2 - yFace) * 0.27, yFace + (d / 2 - yFace) * 0.73];
  const r0 = Math.min(w, d) * 0.11;
  bys.forEach((by, j) =>
    bxs.forEach((bx, i) => {
      const r = r0 * ((i + j) % 2 === 0 ? 0.8 : 1);
      mb.cylinder(M.burners, [bx, by, topZ], r, r * 0.95, 0.006, 16, { bottom: false });
      mb.cylinder(M.top, [bx, by, topZ + 0.006], r * 0.4, r * 0.38, h - topZ - 0.006, 12, { bottom: false });
    }),
  );
  // control strip + knobs
  const stripH = 0.1;
  mb.box(M.top, [-w / 2 + 0.01, yFace - 0.004, topZ - 0.012 - stripH], [w / 2 - 0.01, yFace, topZ - 0.016], { skip: ["+y"] });
  const nk = 4;
  for (let i = 0; i < nk; i++) {
    const kx = -w / 2 + (w * (i + 0.5)) / nk;
    mb.with(facingFront(kx, yFace - 0.004, topZ - 0.012 - stripH / 2 - 0.002), () => mb.cylinder(M.handles, [0, 0, 0], 0.018, 0.016, 0.022, 12, { bottom: false }));
  }
  // oven door with window and handle
  const dz0 = kick + 0.01, dz1 = topZ - 0.02 - stripH - 0.01;
  mb.box(M.body, [-w / 2 + 0.01, yFace - 0.01, dz0], [w / 2 - 0.01, yFace, dz1], { skip: ["+y"] });
  mb.box(M.window, [-w / 2 + 0.08, yFace - 0.012, dz0 + (dz1 - dz0) * 0.22], [w / 2 - 0.08, yFace - 0.01, dz1 - (dz1 - dz0) * 0.25], { skip: ["+y"] });
  const hz = dz1 - 0.04;
  for (const px of [-w / 2 + 0.07, w / 2 - 0.07]) mb.rod(M.handles, [px, yFace - 0.01, hz], [px, -d / 2 + 0.008, hz], 0.006, 6);
  mb.rod(M.handles, [-w / 2 + 0.05, -d / 2 + 0.008, hz], [w / 2 - 0.05, -d / 2 + 0.008, hz], 0.008, 10);
}

function buildDishwasher(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const kick = 0.09;
  const yFace = -d / 2 + 0.04;
  mb.box(M.trim, [-w / 2 + 0.01, yFace + 0.04, 0], [w / 2 - 0.01, d / 2 - 0.01, kick], { skip: ["+z"] });
  mb.box(M.body, [-w / 2, yFace, kick], [w / 2, d / 2, h]);
  const stripH = 0.09;
  mb.box(M.body, [-w / 2 + 0.003, yFace - 0.022, kick + 0.003], [w / 2 - 0.003, yFace, h - stripH - 0.003], { skip: ["+y"] });
  mb.box(M.trim, [-w / 2 + 0.003, yFace - 0.022, h - stripH], [w / 2 - 0.003, yFace, h - 0.003], { skip: ["+y"] });
  mb.box(M.handles, [-w / 2 + 0.25 * w, yFace - 0.0235, h - stripH * 0.6], [-w / 2 + 0.45 * w, yFace - 0.022, h - stripH * 0.35], { skip: ["+y"] });
  const hz = h - stripH - 0.05;
  for (const px of [-w / 2 + 0.08, w / 2 - 0.08]) mb.rod(M.handles, [px, yFace - 0.022, hz], [px, -d / 2 + 0.008, hz], 0.006, 6);
  mb.rod(M.handles, [-w / 2 + 0.06, -d / 2 + 0.008, hz], [w / 2 - 0.06, -d / 2 + 0.008, hz], 0.008, 10);
}

function buildToilet(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const tankD = clamp(d * 0.27, 0.14, 0.24);
  const bt = clamp(h * 0.5, 0.34, 0.43);
  const rx = w / 2 - 0.006;
  const ry = Math.min((d - tankD) / 2 + 0.04, d / 2 - 0.006);
  const cy = -d / 2 + ry + 0.004;
  const hasTank = h > bt + 0.15;
  // pedestal + bowl
  const pz = bt - 0.15;
  ecyl(mb, M.body, 0, cy + ry * 0.12, 0, rx * 0.55, ry * 0.55, pz, 16, 1.2, { top: false });
  ecyl(mb, M.body, 0, cy, pz, rx * 0.8, ry * 0.8, bt - 0.025 - pz, 16, 1.0 / 0.8, { bottom: true, top: true });
  // connector to the tank
  mb.box(M.body, [-rx * 0.5, cy, 0], [rx * 0.5, d / 2 - (hasTank ? tankD - 0.01 : 0.02), bt - 0.03]);
  // seat + lid
  ecyl(mb, M.seat, 0, cy - 0.003, bt - 0.025, rx * 0.97, ry * 0.94, 0.02, 20);
  ecyl(mb, M.seat, 0, cy - 0.005, bt - 0.005, rx * 0.93, ry * 0.9, 0.022, 20, 0.97);
  if (!hasTank) return;
  // tank
  const tw = Math.min(w, 0.44);
  softBox(mb, M.body, 0, d / 2 - tankD / 2, bt - 0.05, tw - 0.02, tankD - 0.01, h - 0.025 - (bt - 0.05), 0.02, 0.008);
  softBox(mb, M.body, 0, d / 2 - tankD / 2, h - 0.025, tw, tankD, 0.019, 0.02, 0.006);
  mb.cylinder(M.flush, [0, d / 2 - tankD / 2, h - 0.006], 0.022, 0.022, 0.006, 12, { bottom: false });
}

function buildBathroomSink(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const ch = Math.min(optNum(s, "counter_height", 0.85, 0.4, 1.2), h);
  const style = optStr(s, "style", ["vanity", "pedestal"] as const, "vanity");
  const fh = optBool(s, "faucet", true) ? Math.min(0.25, h - ch) : 0;
  const bw = clamp(w * 0.6, 0.25, 0.55), bd = clamp(d * 0.55, 0.22, 0.38);
  const by = -d / 2 + 0.06 + bd / 2;
  const hole = ellipse(0, by, bw / 2, bd / 2, 20);
  const bottom = ellipse(0, by, bw / 2 - 0.05, bd / 2 - 0.04, 20);
  if (style === "pedestal") {
    const slabT = 0.16;
    basinSlab(mb, M.basin, M.basin, roundRect(0, 0, w, d, Math.min(w, d) * 0.25, 4), hole, bottom, ch - slabT, ch, 0.13, M.faucet, [0, by]);
    ecyl(mb, M.basin, 0, 0.0, 0, Math.min(w, d) * 0.22, Math.min(w, d) * 0.2, ch - slabT, 16, 0.6, { top: false });
  } else {
    const ct = 0.04;
    const yFace = -d / 2 + 0.01 + FRONT;
    const toe = 0.08;
    mb.box(M.cabinet, [-w / 2 + 0.01, yFace + 0.04, 0], [w / 2 - 0.01, d / 2 - 0.002, toe], { skip: ["+z"] });
    mb.box(M.cabinet, [-w / 2 + 0.005, yFace, toe], [w / 2 - 0.005, d / 2, ch - ct], { skip: ["+z"] });
    basinSlab(mb, M.basin, M.basin, roundRect(0, 0, w, d, 0.01, 2), hole, bottom, ch - ct, ch, 0.14, M.faucet, [0, by]);
    const n = w >= 0.75 ? 2 : 1;
    const dw = (w - 0.01) / n;
    for (let i = 0; i < n; i++) {
      const x0 = -w / 2 + 0.005 + i * dw;
      const hx = n === 2 ? (i === 0 ? x0 + dw - 0.04 : x0 + 0.04) : x0 + dw - 0.04;
      front(mb, M.cabinet, M.handles, x0, x0 + dw, toe, ch - ct - 0.003, yFace, "bar_v", hx, ch - ct - 0.11, 0.12);
    }
  }
  if (fh > 0) faucet(mb, M.faucet, 0, Math.min(by + bd / 2 + 0.04, d / 2 - 0.03), ch, fh, Math.min(0.12, bd * 0.4));
}

function buildBathtub(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const rim = clamp(Math.min(w, d) * 0.09, 0.04, 0.09);
  const outline = roundRect(0, 0, w, d, 0.04);
  const hole = roundRect(0, 0, w - 2 * rim, d - 2 * rim, Math.min(0.2, (d - 2 * rim) * 0.35));
  const bottom = roundRect(0.06, 0, w - 2 * rim - 0.3, d - 2 * rim - 0.16, Math.min(0.15, (d - 2 * rim - 0.16) * 0.35));
  const depth = Math.max(0.1, h - 0.07);
  basinSlab(mb, M.body, M.body, outline, hole, bottom, 0, h, depth, M.faucet, [-w / 2 + rim + 0.3, 0]);
  // spout from the -X end
  mb.rod(M.faucet, [-w / 2 + rim * 0.4, 0, h - 0.07], [-w / 2 + rim + 0.12, 0, h - 0.07], 0.016, 10);
}

function buildShower(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const tray = 0.05;
  softBox(mb, M.tray, 0, 0, 0, w, d, tray, 0.01, 0.005, false);
  mb.cylinder(M.frame, [0, 0, tray], 0.04, 0.04, 0.002, 16, { bottom: false });
  const gt = 0.008, inset = 0.035, gTop = h - 0.12;
  const fy = -d / 2 + inset;
  const fx = -w / 2 + inset;
  // front glass: fixed panel + door
  const split = -w / 2 + inset + (w - inset) * 0.45;
  mb.box(M.glass, [fx, fy, tray], [split - 0.004, fy + gt, gTop]);
  mb.box(M.glass, [split + 0.004, fy, tray + 0.005], [w / 2, fy + gt, gTop]);
  mb.box(M.glass, [fx, fy + gt, tray], [fx + gt, d / 2, gTop]);
  // chrome profiles
  const pr = 0.02;
  mb.box(M.frame, [fx - 0.004, fy - 0.004, tray], [fx + pr, fy + pr, gTop + 0.004]);
  mb.box(M.frame, [w / 2 - pr, fy - 0.004, tray], [w / 2, fy + pr, gTop + 0.004]);
  mb.box(M.frame, [fx - 0.004, d / 2 - pr, tray], [fx + pr, d / 2, gTop + 0.004]);
  mb.box(M.frame, [fx + pr, fy - 0.002, gTop], [w / 2 - pr, fy + gt + 0.002, gTop + 0.02]);
  mb.box(M.frame, [fx - 0.002, fy + pr, gTop], [fx + gt + 0.002, d / 2 - pr, gTop + 0.02]);
  // door handle
  const hx = split + 0.07;
  mb.rod(M.frame, [hx, fy - 0.025, 0.9], [hx, fy - 0.025, 1.2], 0.008, 8);
  for (const z of [0.95, 1.15]) mb.rod(M.frame, [hx, fy, z], [hx, fy - 0.025, z], 0.005, 6);
  // head on an arm from the back wall, mixer below
  const az = h - 0.05;
  const ax = w * 0.15;
  mb.rod(M.frame, [ax, d / 2, az], [ax, d / 2 - 0.3, az], 0.012, 8);
  mb.cylinder(M.frame, [ax, d / 2 - 0.3, az - 0.03], 0.1, 0.1, 0.02, 16);
  mb.cylinder(M.frame, [ax, d / 2 - 0.3, az - 0.01], 0.015, 0.015, 0.01, 8, { bottom: false, top: false });
  mb.with(facingFront(ax, d / 2, 1.1), () => {
    mb.cylinder(M.frame, [0, 0, 0], 0.05, 0.05, 0.015, 16);
    mb.cylinder(M.frame, [0, 0, 0.015], 0.014, 0.014, 0.05, 10, { bottom: false });
  });
}

function buildMirror(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const dd = Math.max(0.01, d - 0.003);
  const yb = d / 2;
  const bw = clamp(Math.min(w, h) * 0.04, 0.012, 0.05);
  if (optBool(s, "round", false)) {
    mb.with(m4.mul(facingFront(0, yb, h / 2), m4.scaling(1, h / w, 1)), () => {
      mb.cylinder(M.frame, [0, 0, 0], w / 2, w / 2, dd - 0.004, 32);
      mb.cylinder(M.mirror, [0, 0, 0.003], w / 2 - bw, w / 2 - bw, dd - 0.003, 32, { bottom: false });
    });
    return;
  }
  const y0 = yb - dd;
  mb.box(M.frame, [-w / 2, y0, 0], [w / 2, yb, bw]);
  mb.box(M.frame, [-w / 2, y0, h - bw], [w / 2, yb, h]);
  mb.box(M.frame, [-w / 2, y0, bw], [-w / 2 + bw, yb, h - bw]);
  mb.box(M.frame, [w / 2 - bw, y0, bw], [w / 2, yb, h - bw]);
  mb.box(M.mirror, [-w / 2 + bw, y0 + Math.min(0.006, dd * 0.4), bw], [w / 2 - bw, yb - 0.002, h - bw], { skip: ["+y"] });
  mb.box(M.frame, [-w / 2 + bw, yb - 0.002, bw], [w / 2 - bw, yb, h - bw], { skip: ["-y", "+z", "-z", "+x", "-x"] });
}

function lampHead(mb: MeshBuilder, M: Record<string, string>, z0: number, z1: number, r0: number, r1: number) {
  tube(mb, M.shade, 0, 0, z0, z1, r0, r1, 0.003, 16);
  mb.sphere(M.bulb, [0, 0, z0 + (z1 - z0) * 0.35], Math.min(0.04, r1 * 0.4), 10, 6);
}

function buildFloorLamp(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const R = Math.min(w, d) / 2 - 0.004;
  const sh = clamp(h * 0.2, 0.15, 0.4);
  mb.cylinder(M.base, [0, 0, 0], R * 0.7, R * 0.62, 0.03, 16);
  mb.cylinder(M.base, [0, 0, 0.03], 0.012, 0.012, h - sh * 0.4 - 0.03, 8, { bottom: false });
  lampHead(mb, M, h - sh, h, R, R * 0.72);
  // spider arms
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU;
    mb.rod(M.base, [0, 0, h - sh * 0.4], [Math.cos(a) * (R * 0.72 - 0.004), Math.sin(a) * (R * 0.72 - 0.004), h - 0.005], 0.003, 4);
  }
}

function buildTableLamp(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const R = Math.min(w, d) / 2 - 0.003;
  const sh = h * 0.42;
  const bh = h * 0.42;
  const br = Math.min(R * 0.55, bh * 0.45);
  mb.cylinder(M.base, [0, 0, 0], br * 0.6, br * 0.65, 0.02, 14);
  mb.sphere(M.base, [0, 0, 0.02 + bh * 0.45], br, 14, 10, [1, 1, (bh * 0.45) / br]);
  mb.cylinder(M.base, [0, 0, 0.02 + bh * 0.85], br * 0.3, br * 0.25, bh * 0.15, 12, { bottom: false });
  mb.cylinder(M.stem, [0, 0, 0.02 + bh], 0.008, 0.008, h - sh * 0.4 - 0.02 - bh, 8, { bottom: false });
  lampHead(mb, M, h - sh, h, R, R * 0.7);
}

function buildCeilingLight(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const R = Math.min(w, d) / 2 - 0.004;
  const style = optStr(s, "style", ["pendant", "flush"] as const, "pendant");
  if (style === "flush") {
    mb.cylinder(M.cord, [0, 0, h - 0.015], R * 0.85, R * 0.85, 0.015, 20);
    mb.cylinder(M.shade, [0, 0, 0], R * 0.75, R, h - 0.015, 20, { top: false });
    return;
  }
  const sh = Math.min(h * 0.45, R * 1.1);
  mb.cylinder(M.cord, [0, 0, h - 0.025], 0.06, 0.06, 0.025, 12);
  mb.cylinder(M.cord, [0, 0, sh], 0.004, 0.004, h - 0.025 - sh, 6, { top: false, bottom: false });
  // dome: cone with a cylindrical skirt, open underneath
  mb.cylinder(M.cord, [0, 0, sh], 0.025, 0.02, 0.03, 10, { bottom: false });
  tube(mb, M.shade, 0, 0, sh * 0.35, sh, R * 0.95, 0.03, 0.003, 16, { top: true, bottom: true });
  tube(mb, M.shade, 0, 0, 0, sh * 0.35, R, R * 0.95, 0.003, 16, { top: false, bottom: true });
  mb.sphere(M.bulb, [0, 0, sh * 0.35], Math.min(0.05, R * 0.3), 10, 6);
}

function buildPlant(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const Rf = Math.min(w, d) / 2;
  const R = Rf * 0.62;
  const ph = clamp(h * 0.3, 0.08, 0.45);
  mb.cylinder(M.pot, [0, 0, 0], R * 0.75, R, ph - 0.03, 16, { top: false });
  tube(mb, M.pot, 0, 0, ph - 0.03, ph, R + 0.012, R + 0.012, 0.014, 16);
  mb.cylinder(M.soil, [0, 0, ph - 0.03], R - 0.002, R - 0.002, 0.012, 16, { bottom: false });
  // trunk + foliage
  const ch = h - ph;
  const crownZ = ph + ch * (ch > 0.8 ? 0.45 : 0.25);
  const crownH = h - crownZ;
  mb.cylinder(M.stem, [0, 0, ph - 0.03], 0.018, 0.012, crownZ + crownH * 0.3 - ph + 0.03, 8, { bottom: false });
  const rc = Math.min(Rf * 0.6, crownH * 0.4);
  const k = clamp(crownH / (2 * Rf), 0.8, 1.8);
  const rnd = rng(Math.round(w * 997 + h * 131));
  const blobs: [number, number, number, number][] = [[0, 0, crownZ + crownH * 0.55, rc]];
  const nb = 6;
  for (let i = 0; i < nb; i++) {
    const a = (i / nb) * TAU + rnd() * 0.5;
    const r = rc * (0.55 + rnd() * 0.15);
    const off = Math.min(rc * 0.75, Rf - r - 0.005);
    const z = crownZ + crownH * (0.3 + rnd() * 0.45);
    blobs.push([Math.cos(a) * off, Math.sin(a) * off, z, r]);
  }
  for (const [x, y, z, r] of blobs) {
    const rz = r * k;
    const zc = clamp(z, crownZ + rz, h - rz);
    mb.sphere(M.foliage, [x, y, zc], r, 10, 7, [1, 1, k]);
  }
}

function buildRug(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  if (!optBool(s, "border", true)) {
    mb.box(M.main, [-w / 2, -d / 2, 0], [w / 2, d / 2, h], { skip: ["-z"] });
    return;
  }
  const b = Math.min(w, d) * 0.07;
  mb.box(M.main, [-w / 2 + b, -d / 2 + b, 0], [w / 2 - b, d / 2 - b, h], { skip: ["-z", "+x", "-x", "+y", "-y"] });
  mb.box(M.border, [-w / 2, -d / 2, 0], [w / 2, -d / 2 + b, h], { skip: ["-z", "+y"] });
  mb.box(M.border, [-w / 2, d / 2 - b, 0], [w / 2, d / 2, h], { skip: ["-z", "-y"] });
  mb.box(M.border, [-w / 2, -d / 2 + b, 0], [-w / 2 + b, d / 2 - b, h], { skip: ["-z", "+y", "-y", "+x"] });
  mb.box(M.border, [w / 2 - b, -d / 2 + b, 0], [w / 2, d / 2 - b, h], { skip: ["-z", "+y", "-y", "-x"] });
}

function buildCurtain(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const open = optNum(s, "open", 0.3, 0, 1);
  const rodZ = h - 0.04;
  const ry = d / 2 - 0.05;
  const rodY = Math.max(-d / 2 + 0.03, Math.min(0, ry));
  mb.rod(M.rod, [-w / 2 + 0.035, rodY, rodZ], [w / 2 - 0.035, rodY, rodZ], 0.012, 10);
  for (const sx of [-1, 1]) {
    mb.sphere(M.rod, [sx * (w / 2 - 0.02), rodY, rodZ], 0.02, 10, 6);
    mb.rod(M.rod, [sx * (w / 2 - 0.08), rodY, rodZ], [sx * (w / 2 - 0.08), d / 2, rodZ], 0.008, 6);
  }
  const panelW = (w / 2 - 0.04) * (1 - 0.65 * open);
  const amp = Math.min(d / 2 - 0.012, 0.025 + 0.03 * open, Math.abs(-d / 2 - rodY) + d / 2);
  const amp2 = Math.min(amp, d / 2 - Math.abs(rodY) - 0.01);
  const pleat = 0.1 * (1 - 0.5 * open);
  const th = 0.006;
  for (const sx of [-1, 1]) {
    const xOuter = sx * (w / 2 - 0.04), xInner = xOuter - sx * panelW;
    const x0 = Math.min(xOuter, xInner), x1 = Math.max(xOuter, xInner);
    const n = Math.max(2, Math.round((x1 - x0) / pleat) * 2);
    const frontEdge: Vec2[] = [];
    for (let i = 0; i <= n; i++) {
      const x = x0 + ((x1 - x0) * i) / n;
      frontEdge.push([x, rodY + (i % 2 === 0 ? -amp2 : amp2)]);
    }
    const profile: Vec2[] = [...frontEdge, ...frontEdge.map((p) => [p[0], p[1] + th] as Vec2).reverse()];
    mb.prism(M.fabric, profile, 0.01, rodZ - 0.02);
    for (let i = 0; i <= n; i += 2) mb.rod(M.rod, [frontEdge[i][0], rodY, rodZ - 0.03], [frontEdge[i][0], rodY, rodZ + 0.014], 0.004, 4);
  }
}

function buildPiano(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const cabD = clamp(d * 0.5, 0.2, 0.35);
  const keyZ = clamp(h * 0.57, 0.6, 0.75);
  const cheek = 0.05;
  const kd = Math.min(0.15, d - cabD - 0.08);
  const yk0 = -d / 2 + 0.035;
  // upper cabinet
  mb.box(M.body, [-w / 2, d / 2 - cabD, 0.06], [w / 2, d / 2, h - 0.02]);
  mb.box(M.body, [-w / 2, d / 2 - cabD - 0.01, h - 0.02], [w / 2, d / 2, h]);
  mb.box(M.body, [-w / 2 + 0.02, d / 2 - cabD + 0.02, 0], [w / 2 - 0.02, d / 2 - 0.02, 0.06], { skip: ["+z"] });
  // cheeks, front legs, keybed
  for (const sx of [-1, 1]) {
    const x0 = sx < 0 ? -w / 2 : w / 2 - cheek, x1 = x0 + cheek;
    mb.box(M.body, [x0, -d / 2 + 0.02, keyZ - 0.1], [x1, d / 2 - cabD, keyZ + 0.08]);
    mb.cylinder(M.body, [(x0 + x1) / 2, -d / 2 + 0.05, 0], 0.02, 0.025, keyZ - 0.1, 10, { top: false });
  }
  mb.box(M.body, [-w / 2 + cheek, yk0 - 0.015, keyZ - 0.06], [w / 2 - cheek, d / 2 - cabD, keyZ]);
  // fallboard / key cover behind the keys
  mb.box(M.body, [-w / 2 + cheek, yk0 + kd, keyZ], [w / 2 - cheek, d / 2 - cabD, keyZ + 0.08]);
  // keys
  const kw = w - 2 * cheek - 0.01;
  const nw = clamp(Math.round(kw / 0.0235), 7, 52);
  const ww = kw / nw;
  const kx0 = -kw / 2;
  for (let i = 0; i < nw; i++) mb.box(M.keys_white, [kx0 + i * ww + 0.0006, yk0, keyZ], [kx0 + (i + 1) * ww - 0.0006, yk0 + kd, keyZ + 0.02], { skip: ["-z", "+y"] });
  for (let i = 0; i < nw - 1; i++) {
    const k = i % 7; // keyboard starting at C: black keys after C, D, F, G, A
    if (k === 2 || k === 6) continue;
    const xb = kx0 + (i + 1) * ww;
    mb.box(M.keys_black, [xb - ww * 0.3, yk0 + kd * 0.38, keyZ + 0.02], [xb + ww * 0.3, yk0 + kd, keyZ + 0.032], { skip: ["-z", "+y"] });
  }
  // music desk
  mb.box(M.body, [-w * 0.3, d / 2 - cabD - 0.03, keyZ + 0.14], [w * 0.3, d / 2 - cabD, keyZ + 0.17]);
}

function buildWashingMachine(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const yFace = -d / 2 + 0.035;
  softBox(mb, M.body, 0, (yFace + d / 2) / 2, 0.012, w, d / 2 - yFace, h - 0.012, 0.02, 0.008);
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) mb.cylinder(M.trim, [sx * (w / 2 - 0.05), yFace + 0.05 + (sy > 0 ? d - 0.2 : 0), 0], 0.02, 0.02, 0.014, 8, { top: false });
  const stripH = clamp(h * 0.14, 0.08, 0.14);
  // control panel
  mb.box(M.trim, [w * 0.05, yFace - 0.003, h - stripH + 0.02], [w / 2 - 0.04, yFace, h - 0.025], { skip: ["+y"] });
  mb.box(M.body, [-w / 2 + 0.04, yFace - 0.003, h - stripH + 0.02], [-w / 2 + 0.04 + w * 0.3, yFace, h - 0.025], { skip: ["+y"] });
  mb.with(facingFront(-w * 0.05 + 0.0, yFace, h - stripH / 2 - 0.002), () => mb.cylinder(M.door, [0, 0, 0], 0.028, 0.026, 0.02, 14, { bottom: false }));
  // porthole door
  const R = Math.min(w * 0.36, (h - stripH) * 0.4);
  const cz = (h - stripH) / 2 + 0.02;
  mb.with(facingFront(0, yFace, cz), () => {
    tube(mb, M.door, 0, 0, 0, 0.03, R, R, R * 0.26, 24, { top: true, bottom: false });
    mb.cylinder(M.trim, [0, 0, 0], R * 0.75, R * 0.75, 0.004, 24, { bottom: false });
    mb.cylinder(M.glass, [0, 0, 0.012], R * 0.75, R * 0.68, 0.012, 24, { bottom: false });
  });
}

function buildRadiator(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const pitch = 0.05;
  const n = Math.max(2, Math.floor((w - 0.02) / pitch));
  const fw = 0.034;
  const span = (n - 1) * pitch;
  const fd = Math.max(0.03, d - 0.035);
  const y0 = -d / 2, y1 = y0 + fd;
  for (let i = 0; i < n; i++) {
    const x = -span / 2 + i * pitch;
    softBox(mb, M.body, x, (y0 + y1) / 2, 0.0, fw, fd, h, 0.012, 0.006);
  }
  for (const z of [0.07, h - 0.07]) mb.rod(M.body, [-span / 2 - fw / 2 - 0.003, (y0 + y1) / 2, z], [span / 2 + fw / 2 + 0.003, (y0 + y1) / 2, z], Math.min(0.022, fd * 0.4), 10);
  // wall brackets
  for (const sx of [-1, 1]) mb.box(M.body, [sx * span * 0.3 - 0.015, y1, h * 0.75], [sx * span * 0.3 + 0.015, d / 2, h * 0.75 + 0.03]);
}

function buildFireplace(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const hearthH = 0.04;
  const ow = w * 0.5, oh = Math.min(h * 0.6, h - 0.25);
  const yf = -d / 2 + 0.08;
  const yBack = d / 2 - 0.04;
  const mt = 0.05;
  mb.box(M.hearth, [-w / 2, -d / 2, 0], [w / 2, d / 2, hearthH]);
  // surround: piers + lintel
  mb.box(M.surround, [-w / 2 + 0.05, yf, hearthH], [-ow / 2, d / 2, oh], { skip: ["+x", "-z"] });
  mb.box(M.surround, [ow / 2, yf, hearthH], [w / 2 - 0.05, d / 2, oh], { skip: ["-x", "-z"] });
  mb.box(M.surround, [-w / 2 + 0.05, yf, oh], [w / 2 - 0.05, d / 2, h - mt], { skip: ["-z", "+z"] });
  mb.box(M.surround, [-ow / 2, yBack, hearthH], [ow / 2, d / 2, oh], { skip: ["-y", "-z", "+z", "+x", "-x"] });
  // mantel shelf
  mb.box(M.mantel, [-w / 2, -d / 2 + 0.02, h - mt], [w / 2, d / 2, h]);
  // firebox (inward faces)
  const fx0 = -ow / 2, fx1 = ow / 2, fz0 = hearthH + 0.002, fz1 = oh;
  mb.quad(M.firebox, [fx0, yf, fz0], [fx1, yf, fz0], [fx1, yBack, fz0], [fx0, yBack, fz0]); // floor (up)
  mb.quad(M.firebox, [fx0, yBack, fz1], [fx1, yBack, fz1], [fx1, yf, fz1], [fx0, yf, fz1]); // ceiling (down)
  mb.quad(M.firebox, [fx0, yBack, fz0], [fx1, yBack, fz0], [fx1, yBack, fz1], [fx0, yBack, fz1]); // back (faces -y)
  mb.quad(M.firebox, [fx0, yf, fz0], [fx0, yBack, fz0], [fx0, yBack, fz1], [fx0, yf, fz1]); // left (faces +x)
  mb.quad(M.firebox, [fx1, yBack, fz0], [fx1, yf, fz0], [fx1, yf, fz1], [fx1, yBack, fz1]); // right (faces -x)
  // logs + embers
  if (optBool(s, "fire", true)) {
    const lz = fz0 + 0.04;
    const lyc = (yf + yBack) / 2;
    mb.rod(M.logs, [-ow * 0.32, lyc - 0.06, lz], [ow * 0.32, lyc + 0.02, lz], 0.04, 8);
    mb.rod(M.logs, [-ow * 0.3, lyc + 0.08, lz], [ow * 0.28, lyc + 0.0, lz + 0.01], 0.035, 8);
    mb.rod(M.logs, [-ow * 0.15, lyc - 0.03, lz + 0.06], [ow * 0.2, lyc + 0.05, lz + 0.07], 0.03, 8);
    const fr = Math.min(ow * 0.16, 0.1, (oh - hearthH) * 0.3);
    mb.sphere(M.fire, [0, lyc, fz0 + fr * 1.1], fr, 10, 7, [1, 0.5, 1.2]);
  }
}

function buildStool(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const R = Math.min(w, d) / 2;
  const st = clamp(h * 0.08, 0.04, 0.07);
  const sz = h - st;
  ecyl(mb, M.seat, 0, 0, sz, R - 0.005, (R - 0.005) * (d / w > 1 ? 1 : 1), st, 16);
  mb.cylinder(M.frame, [0, 0, sz - 0.02], R * 0.6, R * 0.6, 0.02, 12);
  const lr = 0.012;
  const legs: [Vec3, Vec3][] = [];
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i / 4) * TAU;
    const top: Vec3 = [Math.cos(a) * R * 0.5, Math.sin(a) * R * 0.5, sz - 0.02];
    const bot: Vec3 = [Math.cos(a) * (R - lr - 0.006), Math.sin(a) * (R - lr - 0.006), 0.003];
    mb.rod(M.frame, bot, top, lr, 8);
    legs.push([bot, top]);
  }
  const fz = h * 0.33;
  const at = (l: [Vec3, Vec3]) => v3.lerp(l[0], l[1], (fz - l[0][2]) / (l[1][2] - l[0][2]));
  for (let i = 0; i < 4; i++) mb.rod(M.frame, at(legs[i]), at(legs[(i + 1) % 4]), 0.009, 6);
}

function buildBench(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const st = 0.03;
  const n = Math.max(2, Math.round(d / 0.1));
  const gap = 0.01;
  const sw = (d - gap * (n - 1)) / n;
  for (let i = 0; i < n; i++) {
    const y0 = -d / 2 + i * (sw + gap);
    mb.box(M.seat, [-w / 2, y0, h - st], [w / 2, y0 + sw, h]);
  }
  const fx = w / 2 - clamp(w * 0.1, 0.05, 0.2);
  const L = 0.04;
  for (const sx of [-1, 1]) {
    const x = sx * fx;
    for (const sy of [-1, 1]) mb.block(M.legs, x, sy * (d / 2 - L / 2 - 0.02), 0, L, L, h - st - 0.04, { skip: ["+z"] });
    mb.box(M.legs, [x - L / 2, -d / 2 + 0.01, h - st - 0.04], [x + L / 2, d / 2 - 0.01, h - st], { skip: ["+z"] });
    mb.box(M.legs, [x - L / 2, -d / 2 + 0.02 + L, 0.08], [x + L / 2, d / 2 - 0.02 - L, 0.11]);
  }
  mb.box(M.legs, [-fx + L / 2, -0.015, 0.08], [fx - L / 2, 0.015, 0.11]);
}

function buildCrate(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const p = Math.min(0.045, Math.min(w, d, h) * 0.12); // corner post
  const t = Math.min(0.015, Math.min(w, d) * 0.04); // plank projection
  // core
  mb.box(M.main, [-w / 2 + t, -d / 2 + t, 0], [w / 2 - t, d / 2 - t, h - t]);
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) mb.block(M.main, sx * (w / 2 - p / 2), sy * (d / 2 - p / 2), 0, p, p, h);
  const n = Math.max(2, Math.round(h / 0.15));
  const ph = (h - 0.01 * (n - 1)) / n;
  for (let i = 0; i < n; i++) {
    const z0 = i * (ph + 0.01);
    for (const sy of [-1, 1]) mb.box(M.main, [-w / 2 + p, sy < 0 ? -d / 2 : d / 2 - t, z0], [w / 2 - p, sy < 0 ? -d / 2 + t : d / 2, z0 + ph], { skip: [] });
    for (const sx of [-1, 1]) mb.box(M.main, [sx < 0 ? -w / 2 : w / 2 - t, -d / 2 + p, z0], [sx < 0 ? -w / 2 + t : w / 2, d / 2 - p, z0 + ph], { skip: [] });
  }
  const m = Math.max(2, Math.round(w / 0.15));
  const pw = (w - 2 * p - 0.01 * (m - 1)) / m;
  for (let i = 0; i < m; i++) {
    const x0 = -w / 2 + p + i * (pw + 0.01);
    mb.box(M.main, [x0, -d / 2 + t, h - t], [x0 + pw, d / 2 - t, h], { skip: ["-z"] });
  }
}

function buildBox(mb: MeshBuilder, s: FurnitureSpec) {
  mb.box(s.materials.main, [-s.width / 2, -s.depth / 2, 0], [s.width / 2, s.depth / 2, s.height]);
}

function buildCylinder(mb: MeshBuilder, s: FurnitureSpec) {
  const seg = Math.round(optNum(s, "segments", 16, 3, 48));
  ecyl(mb, s.materials.main, 0, 0, 0, s.width / 2, s.depth / 2, s.height, seg);
}

function buildDoorMat(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const b = Math.min(0.04, Math.min(w, d) * 0.1);
  mb.box(M.border, [-w / 2, -d / 2, 0], [w / 2, d / 2, h * 0.7], { skip: ["-z"] });
  mb.box(M.main, [-w / 2 + b, -d / 2 + b, h * 0.7], [w / 2 - b, d / 2 - b, h], { skip: ["-z"] });
}

// ---------------------------------------------------------------------------
// outdoor, vehicles & landscape
// ---------------------------------------------------------------------------

/**
 * Sweep a closed profile along X: `rings` are CCW loops in (y, z) (seen from +X) placed at
 * increasing x. `edgeMat[k]` is the material of the strip leaving vertex k. Caps use capMat.
 */
function sweepX(
  mb: MeshBuilder,
  rings: Vec3[][],
  edgeMat: (k: number, ring: number) => string,
  caps: { mat: string; first: Vec3; last: Vec3 } | null,
) {
  const n = rings[0].length;
  for (let r = 0; r + 1 < rings.length; r++) {
    const A = rings[r], B = rings[r + 1];
    for (let k = 0; k < n; k++) {
      const j = (k + 1) % n;
      mb.quad(edgeMat(k, r), A[k], A[j], B[j], B[k]);
    }
  }
  if (caps) {
    mb.polygon(caps.mat, rings[0], caps.first);
    mb.polygon(caps.mat, rings[rings.length - 1], caps.last);
  }
}

/** Cloud of ellipsoid blobs filling the box [cx±sx/2, cy±sy/2, z0..z0+sz] (bushes, crowns, shrubs). */
function foliage(mb: MeshBuilder, mat: string, cx: number, cy: number, z0: number, sx: number, sy: number, sz: number, count: number, seed: number, seg = 10, ground = false) {
  const rnd = rng(seed);
  const blob = (x: number, y: number, z: number, rx: number, ry: number, rz: number) => {
    rx = Math.min(rx, sx / 2), ry = Math.min(ry, sy / 2), rz = Math.min(rz, sz / 2);
    x = clamp(x, cx - sx / 2 + rx, cx + sx / 2 - rx);
    y = clamp(y, cy - sy / 2 + ry, cy + sy / 2 - ry);
    z = clamp(z, z0 + rz, z0 + sz - rz);
    mb.sphere(mat, [x, y, z], rx, seg, Math.max(5, seg - 3), [1, ry / rx, rz / rx]);
  };
  blob(cx, cy, z0 + sz * 0.55, sx * 0.36, sy * 0.36, sz * 0.4);
  for (let i = 0; i < count; i++) {
    const a = (i / count) * TAU + rnd() * 0.6;
    const k = 0.75 + rnd() * 0.3;
    const rx = sx * 0.25 * k, ry = sy * 0.25 * k, rz = sz * 0.3 * k;
    const out = 0.55 + rnd() * 0.45;
    const z = ground && i % 2 === 0 ? z0 + rz : z0 + sz * (0.3 + rnd() * 0.45);
    blob(cx + Math.cos(a) * (sx / 2 - rx) * out, cy + Math.sin(a) * (sy / 2 - ry) * out, z, rx, ry, rz);
  }
  if (count >= 5) blob(cx + (rnd() - 0.5) * sx * 0.15, cy + (rnd() - 0.5) * sy * 0.15, z0 + sz, sx * 0.24, sy * 0.24, sz * 0.25);
}

/** Matrix whose local +Z runs along world +X (wheels, rings with a horizontal axle). */
function axleX(x: number, y: number, z: number) {
  return m4.fromBasis([0, 1, 0], [0, 0, 1], [1, 0, 0], [x, y, z]);
}

type CarStyle = "sedan" | "suv" | "hatchback" | "pickup";
const CAR_SHAPES: Record<CarStyle, { zb: number; hood: number; w: number; r1: number; r2: number; t: number; tumble: number; fa: number; ra: number; cl: number; pillars: number[] }> = {
  // fractions of length from the front (w = windshield base, r1/r2 = roof front/rear, t = rear glass base), zb/hood/cl of height
  sedan: { zb: 0.6, hood: 0.1, w: 0.31, r1: 0.45, r2: 0.7, t: 0.83, tumble: 0.13, fa: 0.19, ra: 0.2, cl: 0.11, pillars: [0.45] },
  hatchback: { zb: 0.58, hood: 0.09, w: 0.29, r1: 0.44, r2: 0.86, t: 0.96, tumble: 0.12, fa: 0.17, ra: 0.15, cl: 0.11, pillars: [0.42] },
  suv: { zb: 0.56, hood: 0.05, w: 0.26, r1: 0.38, r2: 0.93, t: 0.975, tumble: 0.08, fa: 0.17, ra: 0.18, cl: 0.14, pillars: [0.36, 0.7] },
  pickup: { zb: 0.55, hood: 0.05, w: 0.25, r1: 0.37, r2: 0.56, t: 0.575, tumble: 0.08, fa: 0.16, ra: 0.22, cl: 0.15, pillars: [] },
};

function buildCar(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: L, height: h } = s;
  const M = s.materials;
  const style = optStr(s, "style", ["sedan", "suv", "hatchback", "pickup"] as const, "sedan");
  const S = CAR_SHAPES[style];
  const hw = w / 2 - Math.min(0.08, w * 0.045); // body half width (mirrors stick out to w/2)
  const yF = -L / 2 + 0.03, yR = L / 2 - 0.03; // body ends (bumpers reach the box)
  const at = (f: number) => -L / 2 + f * L;
  const R = clamp(Math.min(0.23 * h, 0.075 * L, 0.2 * w), 0.12, 0.5);
  const Ra = R + 0.03;
  const c = Math.max(S.cl * h, 0.08);
  const zb = S.zb * h, zHood = zb - S.hood * h;
  const zDeck = style === "sedan" ? zb - 0.025 * h : zb;
  const yFa = Math.max(at(S.fa), yF + Ra + 0.05), yRa = Math.min(L / 2 - S.ra * L, yR - Ra - 0.05);
  const yW = at(S.w), yR1 = at(S.r1), yR2 = at(S.r2), yT = at(S.t);
  // ---- lower body side profile (CCW in y,z) with wheel arches ----
  const P: Vec2[] = [];
  const PM: string[] = [];
  const add = (y: number, z: number, m = M.body) => { P.push([y, z]); PM.push(m); };
  const arch = (ya: number) => {
    const half = Math.sqrt(Math.max(0, Ra * Ra - (R - c) * (R - c)));
    const b = Math.asin(clamp((c - R) / Ra, -1, 1)); // negative
    add(ya - half, c, M.trim);
    const n = 9;
    for (let i = 1; i < n; i++) {
      const th = Math.PI - b - ((Math.PI - 2 * b) * i) / n;
      add(ya + Ra * Math.cos(th), R + Ra * Math.sin(th), M.trim);
    }
    add(ya + half, c);
  };
  add(yF + 0.1, c + 0.05);
  arch(yFa);
  arch(yRa);
  add(yR - 0.1, c + 0.05);
  const zRT = style === "sedan" ? zDeck : zb;
  add(yR, c + 0.17);
  add(yR, zRT - 0.07);
  add(yR - 0.05, zRT);
  if (style === "sedan") add(yT + 0.08, zDeck);
  if (yT < yR - 0.1) add(yT, zb);
  add(yW, zb);
  add(yF + 0.28, zHood + 0.03);
  add(yF + 0.06, zHood);
  add(yF, zHood - 0.07);
  add(yF, c + 0.18);
  // ---- body: profile swept across the width with rounded (chamfered) sides ----
  const bodyRing = (x: number, off: number): Vec3[] => (off > 0 ? offsetPolygon(P, -off) : P).map(([y, z]) => [x, y, z] as Vec3);
  const offs: [number, number][] = [[hw, 0.055], [hw - 0.022, 0.018], [hw - 0.075, 0]];
  const rings = [...offs.map(([x, o]) => bodyRing(-x, o)), ...[...offs].reverse().map(([x, o]) => bodyRing(x, o))];
  sweepX(mb, rings, (k) => PM[k], { mat: M.body, first: [-1, 0, 0], last: [1, 0, 0] });
  // ---- cabin (greenhouse) with tumblehome ----
  const zr = h;
  const zbot = zb - 0.06;
  const cwb = hw - 0.04, cwt = cwb - S.tumble * (w / 1.8);
  const xs = (z: number) => cwb - (cwb - cwt) * clamp((z - zb) / (zr - zb), 0, 1);
  const wsY = (z: number) => yW + ((yR1 - yW) * (z - zb)) / (zr - zb); // windshield line
  const rwY = (z: number) => yT + ((yR2 - yT) * (z - zb)) / (zr - zb); // rear glass line
  const Q: Vec2[] = [
    [wsY(zbot), zbot],
    [Math.min(rwY(zbot), yR - 0.06), zbot],
    [rwY(zr - 0.04), zr - 0.04],
    [yR2 - 0.06, zr],
    [yR1 + 0.06, zr],
    [wsY(zr - 0.04), zr - 0.04],
  ];
  const QM = [M.body, M.glass, M.body, M.body, M.body, M.glass];
  const cabRing = (sx: number, off: number): Vec3[] =>
    (off > 0 ? offsetPolygon(Q, -off) : Q).map(([y, z]) => [sx * (xs(z) - (off > 0 ? 0 : 0.035)), y, z] as Vec3);
  const crings = [cabRing(-1, 0.035), cabRing(-1, 0), cabRing(1, 0), cabRing(1, 0.035)];
  const k = (cwb - cwt) / (zr - zb);
  sweepX(mb, crings, (e, r) => (r === 1 ? QM[e] : e === 1 || e === 5 ? M.body : QM[e]), { mat: M.glass, first: [-1, 0, k], last: [1, 0, k] });
  for (const f of S.pillars) {
    const yb = yR1 + (yR2 - yR1) * f;
    for (const sx of [-1, 1]) beam(mb, M.body, [sx * (xs(zb) + 0.003), yb, zb - 0.01], [sx * (xs(zr - 0.04) + 0.003), yb, zr - 0.035], 0.07, 0.012);
  }
  // ---- interior seen through the glass ----
  const ix = cwb - 0.06;
  mb.box(M.interior, [-ix, Math.max(yW, wsY(zbot)) + 0.05, zb], [ix, Math.min(yT, yR - 0.1) - 0.05, zb + 0.01]);
  mb.box(M.interior, [-ix, yW - 0.02, zb], [ix, yW + 0.26, zb + Math.min(0.12, (zr - zb) * 0.25)]);
  const seat = (y: number) => {
    for (const sx of style === "pickup" && y > yR1 + 0.5 ? [] : [-1, 1]) {
      const sxw = Math.min(0.5, ix * 0.8);
      mb.box(M.interior, [sx > 0 ? ix * 0.1 : -ix * 0.1 - sxw, y - 0.45, zb + 0.01], [sx > 0 ? ix * 0.1 + sxw : -ix * 0.1, y, zb + 0.08]);
      mb.box(M.interior, [sx > 0 ? ix * 0.1 : -ix * 0.1 - sxw, y, zb + 0.01], [sx > 0 ? ix * 0.1 + sxw : -ix * 0.1, y + 0.1, zb + Math.min(0.42, (zr - zb) * 0.68)]);
    }
  };
  seat(Math.min(yR1 + 0.25, yR2 - 0.15));
  if (yR2 - yR1 > 1.0) seat(yR2 - 0.1);
  // ---- pickup bed ----
  if (style === "pickup") {
    const y0 = Math.max(yT, rwY(zbot)) + 0.03, top = zb + 0.26;
    for (const sx of [-1, 1]) mb.box(M.body, [sx > 0 ? hw - 0.075 : -hw + 0.015, y0, zb - 0.04], [sx > 0 ? hw - 0.015 : -hw + 0.075, yR - 0.02, top]);
    mb.box(M.body, [-hw + 0.075, y0, zb - 0.04], [hw - 0.075, y0 + 0.05, top]);
    mb.box(M.body, [-hw + 0.075, yR - 0.08, zb - 0.04], [hw - 0.075, yR - 0.02, top - 0.02]);
    mb.box(M.trim, [-hw + 0.075, y0 + 0.05, zb], [hw - 0.075, yR - 0.08, zb + 0.012]);
  }
  // ---- bumpers, grille, lights ----
  const bw = 2 * hw - 0.06;
  softBox(mb, M.body, 0, -L / 2 + 0.07, c + 0.03, bw, 0.14, 0.2, 0.08, 0.025);
  softBox(mb, M.body, 0, L / 2 - 0.07, c + 0.03, bw, 0.14, 0.2, 0.08, 0.025);
  mb.box(M.trim, [-bw / 2 + 0.06, -L / 2 + 0.03, c + 0.02], [bw / 2 - 0.06, -L / 2 + 0.12, c + 0.06]);
  const gz0 = c + 0.25, gz1 = zHood - 0.09;
  if (gz1 - gz0 > 0.04) mb.box(M.trim, [-Math.min(0.36, hw * 0.42), yF - 0.006, gz0], [Math.min(0.36, hw * 0.42), yF + 0.02, gz1]);
  const lz1 = zHood - 0.075, lz0 = Math.max(c + 0.25, lz1 - 0.07);
  for (const sx of [-1, 1]) {
    const xa = sx * Math.min(0.38, hw * 0.45) + sx * 0.02, xb = sx * (hw - 0.09);
    mb.box(M.lights_front, [Math.min(xa, xb), yF - 0.005, lz0], [Math.max(xa, xb), yF + 0.02, lz1]);
    const tz1 = zRT - 0.09, tz0 = Math.max(c + 0.25, tz1 - 0.08);
    const ta = sx * hw * 0.5, tb = sx * (hw - 0.09);
    mb.box(M.lights_rear, [Math.min(ta, tb), yR - 0.02, tz0], [Math.max(ta, tb), yR + 0.005, tz1]);
  }
  // ---- doors (seams + handles) and mirrors ----
  const seams = style === "pickup" ? [yW + 0.08, yR2 + 0.02] : style === "sedan" || style === "suv" ? [yW + 0.08, yR1 + (yR2 - yR1) * S.pillars[0], Math.min(yT - 0.05, yRa - Ra - 0.05)] : [yW + 0.08, yR1 + (yR2 - yR1) * S.pillars[0], yRa - Ra - 0.05];
  for (const sx of [-1, 1]) {
    for (const y of seams) mb.box(M.trim, [sx > 0 ? hw - 0.003 : -hw - 0.002, y - 0.003, c + 0.12], [sx > 0 ? hw + 0.002 : -hw + 0.003, y + 0.003, zb - 0.09]);
    for (let i = 0; i + 1 < seams.length; i++) {
      const y = seams[i + 1] - 0.16;
      mb.box(M.trim, [sx > 0 ? hw - 0.002 : -hw - 0.01, y, zb - 0.13], [sx > 0 ? hw + 0.01 : -hw + 0.002, y + 0.11, zb - 0.105]);
    }
    const my = yW + 0.12;
    mb.box(M.body, [sx > 0 ? cwb - 0.01 : -w / 2 + 0.06, my - 0.02, zb + 0.03], [sx > 0 ? w / 2 - 0.06 : -cwb + 0.01, my + 0.02, zb + 0.06]);
    softBox(mb, M.body, sx * (w / 2 - 0.065), my, zb + 0.02, 0.13, 0.08, 0.11, 0.025, 0.01);
    mb.box(M.glass, [sx > 0 ? w / 2 - 0.12 : -w / 2 + 0.01, my + 0.04, zb + 0.035], [sx > 0 ? w / 2 - 0.01 : -w / 2 + 0.12, my + 0.042, zb + 0.12]);
  }
  // ---- wheels ----
  for (const ya of [yFa, yRa])
    for (const sx of [-1, 1]) {
      const xo = sx * (hw - 0.012), xi = sx * (hw - 0.012 - Math.min(0.24, w * 0.13));
      mb.rod(M.tires, [xi, ya, R], [xo, ya, R], R, 16);
      mb.rod(M.rims, [xo - sx * 0.01, ya, R], [xo + sx * 0.006, ya, R], R * 0.64, 14);
      mb.rod(M.trim, [xo + sx * 0.006, ya, R], [xo + sx * 0.008, ya, R], R * 0.5, 14);
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * TAU;
        beam(mb, M.rims, [xo + sx * 0.007, ya, R], [xo + sx * 0.007, ya + Math.cos(a) * R * 0.52, R + Math.sin(a) * R * 0.52], 0.006, 0.07);
      }
      mb.rod(M.rims, [xo + sx * 0.006, ya, R], [xo + sx * 0.012, ya, R], R * 0.14, 10);
    }
}

function buildGardenChair(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const L = 0.045;
  const seatH = clamp(h * 0.47, 0.3, 0.46);
  const armH = Math.min(h - 0.15, seatH + 0.22);
  const lean = (14 * Math.PI) / 180;
  const z0b = seatH - 0.04;
  const lenB = (h - z0b - L * Math.sin(lean)) / Math.cos(lean);
  const yb0 = d / 2 - L / 2 - 0.005 - lenB * Math.sin(lean);
  const lx = w / 2 - L / 2;
  for (const sx of [-1, 1]) {
    mb.block(M.frame, sx * lx, -d / 2 + L / 2 + 0.02, 0, L, L, armH - 0.025, { skip: ["+z"] });
    mb.block(M.frame, sx * lx, yb0, 0, L, L, z0b + 0.02);
    mb.box(M.frame, [sx * lx - 0.012, -d / 2 + L + 0.02, seatH - 0.1], [sx * lx + 0.012, yb0 - L / 2, seatH - 0.02]);
    mb.box(M.frame, [sx * lx - 0.012, -d / 2 + L + 0.02, 0.1], [sx * lx + 0.012, yb0 - L / 2, 0.14]);
    // armrest
    mb.box(M.frame, [sx > 0 ? w / 2 - 0.075 : -w / 2, -d / 2, armH - 0.025], [sx > 0 ? w / 2 : -w / 2 + 0.075, yb0 + 0.12, armH]);
  }
  mb.box(M.frame, [-lx + L / 2, -d / 2 + 0.02, seatH - 0.1], [lx - L / 2, -d / 2 + 0.045, seatH - 0.02]);
  // seat slats
  const sy0 = -d / 2 + 0.02, sy1 = yb0 + L / 2;
  const n = Math.max(3, Math.round((sy1 - sy0) / 0.075));
  const sw = (sy1 - sy0 - 0.012 * (n - 1)) / n;
  for (let i = 0; i < n; i++) mb.box(M.seat, [-lx + L / 2, sy0 + i * (sw + 0.012), seatH - 0.02], [lx - L / 2, sy0 + i * (sw + 0.012) + sw, seatH]);
  // reclined back with horizontal slats
  mb.with(m4.mul(m4.translation(0, yb0, z0b), m4.rotationX(-lean)), () => {
    for (const sx of [-1, 1]) mb.block(M.frame, sx * (lx - 0.03), 0, 0, L * 0.8, L, lenB);
    const top = lenB - 0.02, bot = Math.max(0.12, (armH - z0b) * 0.6);
    const k = Math.max(2, Math.round((top - bot) / 0.085));
    const sh = (top - bot - 0.02 * (k - 1)) / k;
    for (let i = 0; i < k; i++) mb.box(M.seat, [-lx + 0.02, -L / 2 - 0.02, bot + i * (sh + 0.02)], [lx - 0.02, -L / 2, bot + i * (sh + 0.02) + sh]);
  });
}

function buildSunLounger(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const cushion = optBool(s, "cushion", true);
  const fz = clamp(h * 0.38, 0.2, 0.4);
  const t = cushion ? 0.085 : 0.03;
  const Lb = Math.min(0.75, d * 0.38);
  const th = Math.asin(clamp((h - fz + 0.025 - t) / Lb, 0, Math.sin((65 * Math.PI) / 180)));
  const yh = d / 2 - Lb * Math.cos(th) - t * Math.sin(th) - 0.01;
  const rw = 0.04;
  // frame rails + legs
  for (const sx of [-1, 1]) {
    mb.box(M.frame, [sx > 0 ? w / 2 - rw : -w / 2, -d / 2, fz - 0.11], [sx > 0 ? w / 2 : -w / 2 + rw, d / 2, fz - 0.025]);
    for (const y of [-d / 2 + 0.04, d / 2 - 0.04]) mb.block(M.frame, sx * (w / 2 - rw / 2), y, 0, rw, 0.05, fz - 0.11, { skip: ["+z"] });
  }
  for (const y of [-d / 2, d / 2 - 0.04]) mb.box(M.frame, [-w / 2 + rw, y, fz - 0.11], [w / 2 - rw, y + 0.04, fz - 0.04]);
  // flat slats
  const n = Math.max(4, Math.round((yh - (-d / 2 + 0.04)) / 0.09));
  const sl = (yh - 0.01 - (-d / 2 + 0.04) - 0.015 * (n - 1)) / n;
  for (let i = 0; i < n; i++) {
    const y0 = -d / 2 + 0.04 + i * (sl + 0.015);
    mb.box(M.frame, [-w / 2 + rw, y0, fz - 0.045], [w / 2 - rw, y0 + sl, fz - 0.025]);
  }
  if (cushion) softBox(mb, M.cushion, 0, (-d / 2 + 0.02 + yh) / 2, fz - 0.025, w - 0.04, yh + d / 2 - 0.02, t - 0.025, 0.04, 0.02);
  // backrest raised around the hinge
  mb.with(m4.mul(m4.translation(0, yh, fz - 0.025), m4.rotationX(th)), () => {
    for (const sx of [-1, 1]) mb.box(M.frame, [sx > 0 ? w / 2 - rw - 0.03 : -w / 2 + rw, 0, -0.04], [sx > 0 ? w / 2 - rw : -w / 2 + rw + 0.03, Lb, 0]);
    const k = Math.max(3, Math.round(Lb / 0.09));
    const bl = (Lb - 0.015 * (k - 1)) / k;
    for (let i = 0; i < k; i++) mb.box(M.frame, [-w / 2 + rw + 0.03, i * (bl + 0.015), -0.02], [w / 2 - rw - 0.03, i * (bl + 0.015) + bl, 0]);
    if (cushion) softBox(mb, M.cushion, 0, Lb / 2, 0, w - 0.04, Lb, t - 0.025, 0.04, 0.02);
  });
  // strut under the backrest
  const yS = yh + Lb * 0.55 * Math.cos(th), zS = fz - 0.025 + Lb * 0.55 * Math.sin(th) - 0.04;
  for (const sx of [-1, 1]) mb.rod(M.frame, [sx * (w / 2 - rw - 0.05), Math.min(yS + 0.25, d / 2 - 0.06), fz - 0.06], [sx * (w / 2 - rw - 0.05), yS, zS], 0.012, 6);
}

function buildOutdoorTable(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const t = 0.03;
  if (optBool(s, "round", false)) {
    ecyl(mb, M.top, 0, 0, h - t, w / 2, d / 2, t, 24);
    const k = Math.SQRT1_2 * 0.82;
    const L = 0.05;
    for (const sx of [-1, 1])
      for (const sy of [-1, 1]) mb.block(M.legs, sx * (w / 2) * k, sy * (d / 2) * k, 0, L, L, h - t, { skip: ["+z"] });
    for (const sy of [-1, 1]) mb.box(M.legs, [-(w / 2) * k, sy * (d / 2) * k - 0.012, h - t - 0.08], [(w / 2) * k, sy * (d / 2) * k + 0.012, h - t]);
    mb.box(M.legs, [-0.012, -(d / 2) * k, 0.15], [0.012, (d / 2) * k, 0.19]);
    return;
  }
  const n = Math.max(3, Math.round(d / 0.095));
  const g = 0.01;
  const sw = (d - g * (n - 1)) / n;
  for (let i = 0; i < n; i++) mb.box(M.top, [-w / 2, -d / 2 + i * (sw + g), h - t], [w / 2, -d / 2 + i * (sw + g) + sw, h]);
  const L = clamp(Math.min(w, d) * 0.07, 0.045, 0.08);
  legs4(mb, M.legs, w, d, 0.04, L, 0, h - t);
  const lx = w / 2 - 0.04 - L, ly = d / 2 - 0.04 - L;
  for (const sg of [-1, 1]) {
    mb.box(M.legs, [-lx, sg * (ly + L / 2) - 0.011, h - t - 0.08], [lx, sg * (ly + L / 2) + 0.011, h - t]);
    mb.box(M.legs, [sg * (lx + L / 2) - 0.011, -ly, h - t - 0.08], [sg * (lx + L / 2) + 0.011, ly, h - t]);
  }
}

function buildParasol(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const open = optBool(s, "open", true);
  const R = w / 2 - 0.005;
  mb.with(m4.scaling(1, d / w, 1), () => {
    const br = Math.min(0.28, R * 0.4);
    mb.cylinder(M.base, [0, 0, 0], br, br * 0.92, 0.08, 16);
    mb.cylinder(M.base, [0, 0, 0.08], 0.06, 0.045, 0.1, 10, { bottom: false });
    const apex = h - 0.08;
    mb.cylinder(M.pole, [0, 0, 0.18], 0.022, 0.022, apex - 0.18, 10, { bottom: false, top: false });
    mb.cylinder(M.pole, [0, 0, apex - 0.01], 0.03, 0.012, h - apex + 0.01, 8, { bottom: false });
    if (!open) {
      const z0 = h * 0.42;
      mb.cylinder(M.canopy, [0, 0, z0], 0.03, 0.11, (apex - z0) * 0.62, 10, { top: false });
      mb.cylinder(M.canopy, [0, 0, z0 + (apex - z0) * 0.62], 0.11, 0.03, (apex - z0) * 0.38, 10, { bottom: false });
      return;
    }
    const rimZ = h - clamp(h * 0.17, 0.3, 0.55);
    const n = 8;
    const rim: Vec3[] = [], rimLo: Vec3[] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + Math.PI / n;
      rim.push([Math.cos(a) * R, Math.sin(a) * R, rimZ]);
      rimLo.push([Math.cos(a) * (R - 0.012), Math.sin(a) * (R - 0.012), rimZ - 0.01]);
    }
    const A: Vec3 = [0, 0, apex], Alo: Vec3 = [0, 0, apex - 0.012];
    const val = 0.07;
    for (let i = 0; i < n; i++) {
      const p = rim[i], q = rim[(i + 1) % n];
      mb.triangle(M.canopy, p, q, A);
      mb.triangle(M.canopy, Alo, rimLo[(i + 1) % n], rimLo[i]);
      // valance flap (both sides)
      mb.quad(M.canopy, [p[0], p[1], p[2] - val], [q[0], q[1], q[2] - val], q, p);
      const pi = rimLo[i], qi = rimLo[(i + 1) % n];
      mb.quad(M.canopy, [qi[0], qi[1], rimZ - val], [pi[0], pi[1], rimZ - val], [pi[0], pi[1], rimZ - 0.01], [qi[0], qi[1], rimZ - 0.01]);
      mb.quad(M.canopy, [p[0], p[1], rimZ - val], [pi[0], pi[1], rimZ - val], [qi[0], qi[1], rimZ - val], [q[0], q[1], rimZ - val]);
      // rib + stretcher
      const rp: Vec3 = [rimLo[i][0] * 0.97, rimLo[i][1] * 0.97, rimZ - 0.015];
      mb.rod(M.pole, [0, 0, apex - 0.03], rp, 0.006, 4);
      mb.rod(M.pole, [0, 0, rimZ - 0.35], [rp[0] * 0.5, rp[1] * 0.5, (apex + rimZ) / 2 - 0.03], 0.005, 4);
    }
    mb.cylinder(M.pole, [0, 0, rimZ - 0.38], 0.035, 0.035, 0.06, 10);
  });
}

function buildBbq(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  if (optStr(s, "style", ["gas", "kettle"] as const, "gas") === "kettle") {
    const R = Math.min(Math.min(w, d) / 2 - 0.03, (h - 0.1) * 0.33);
    const zc = h - 0.07 - R;
    mb.sphere(M.body, [0, 0, zc], R, 16, 12);
    mb.cylinder(M.lid, [0, 0, zc - 0.012], R + 0.004, R + 0.004, 0.024, 16, { top: false, bottom: false });
    // top handle
    for (const sx of [-1, 1]) mb.rod(M.handles, [sx * 0.06, 0, zc + R - 0.01], [sx * 0.06, 0, h - 0.015], 0.006, 6);
    mb.rod(M.handles, [-0.08, 0, h - 0.015], [0.08, 0, h - 0.015], 0.015, 8);
    mb.cylinder(M.handles, [0, 0, zc + R - 0.005], 0.04, 0.04, 0.012, 10, { bottom: false });
    // side handles
    for (const sx of [-1, 1]) mb.rod(M.handles, [sx * (R - 0.01), -0.07, zc - 0.03], [sx * (R + 0.02), 0.07, zc - 0.03], 0.01, 6);
    // legs, rack, ash pan, wheels
    const feet: Vec3[] = [];
    for (let i = 0; i < 3; i++) {
      const a = Math.PI / 2 + (i / 3) * TAU;
      const top: Vec3 = [Math.cos(a) * R * 0.55, Math.sin(a) * R * 0.55, zc - R * 0.8];
      const bot: Vec3 = [Math.cos(a) * (Math.min(w, d) / 2 - 0.03), Math.sin(a) * (Math.min(w, d) / 2 - 0.03), 0.06];
      mb.rod(M.body, bot, top, 0.012, 6);
      feet.push(bot);
    }
    const rz = (zc - R) * 0.35;
    const pt = (f: Vec3): Vec3 => { const t = (rz - 0.06) / (zc - R * 0.8 - 0.06); return [f[0] + (f[0] * 0.55 * R / Math.hypot(f[0], f[1]) - f[0]) * t, f[1] + (f[1] * 0.55 * R / Math.hypot(f[0], f[1]) - f[1]) * t, rz]; };
    for (let i = 0; i < 3; i++) mb.rod(M.body, pt(feet[i]), pt(feet[(i + 1) % 3]), 0.008, 6);
    mb.cylinder(M.lid, [0, 0, zc - R - 0.12], R * 0.3, R * 0.35, 0.05, 12);
    mb.rod(M.handles, [0, 0, zc - R - 0.07], [0, 0, zc - R + 0.01], 0.006, 6);
    for (const f of feet.slice(1)) mb.rod(M.wheels, [f[0] - 0.02, f[1], 0.06], [f[0] + 0.02, f[1], 0.06], 0.06, 12);
    mb.cylinder(M.body, [feet[0][0], feet[0][1], 0], 0.02, 0.02, 0.06, 8, { top: false });
    return;
  }
  const cw = Math.min(w * 0.58, 0.8);
  const hd = Math.min(0.3, h * 0.26);
  const zf = h - hd;
  const yFace = -d / 2 + 0.06;
  // cart + doors
  mb.box(M.body, [-cw / 2, yFace, 0.14], [cw / 2, d / 2 - 0.02, zf - 0.2]);
  front(mb, M.body, M.handles, -cw / 2, 0, 0.14, zf - 0.2, yFace, "bar_v", -0.05, (zf - 0.06) / 2, 0.2);
  front(mb, M.body, M.handles, 0, cw / 2, 0.14, zf - 0.2, yFace, "bar_v", 0.05, (zf - 0.06) / 2, 0.2);
  mb.box(M.body, [-cw / 2 + 0.01, yFace + 0.02, 0.06], [cw / 2 - 0.01, d / 2 - 0.04, 0.14], { skip: ["+z"] });
  for (const sx of [-1, 1]) {
    mb.rod(M.wheels, [sx * (cw / 2 - 0.06), -d / 2 + 0.12, 0.06], [sx * (cw / 2 - 0.02), -d / 2 + 0.12, 0.06], 0.06, 12);
    mb.rod(M.wheels, [sx * (cw / 2 - 0.06), d / 2 - 0.1, 0.06], [sx * (cw / 2 - 0.02), d / 2 - 0.1, 0.06], 0.06, 12);
  }
  // firebox + control panel + knobs
  mb.box(M.body, [-cw / 2, yFace, zf - 0.2], [cw / 2, d / 2 - 0.02, zf]);
  mb.box(M.lid, [-cw / 2 + 0.01, -d / 2 + 0.03, zf - 0.18], [cw / 2 - 0.01, yFace, zf - 0.04], { skip: ["+y"] });
  const nk = 4;
  for (let i = 0; i < nk; i++) mb.with(facingFront(-cw / 2 + (cw * (i + 0.5)) / nk, -d / 2 + 0.03, zf - 0.11), () => mb.cylinder(M.handles, [0, 0, 0], 0.02, 0.017, 0.025, 10, { bottom: false }));
  // side shelves
  for (const sx of [-1, 1]) {
    const x0 = sx > 0 ? cw / 2 : -w / 2, x1 = sx > 0 ? w / 2 : -cw / 2;
    if (x1 - x0 > 0.05) {
      mb.box(M.lid, [x0, -d / 2 + 0.06, zf - 0.03], [x1, d / 2 - 0.06, zf]);
      mb.box(M.body, [sx > 0 ? cw / 2 : x0 + 0.03, -0.02, zf - 0.12], [sx > 0 ? x1 - 0.03 : -cw / 2, 0.02, zf - 0.03]);
    }
  }
  // domed lid
  const ry = (d - 0.12) / 2, rz = hd;
  const prof: Vec2[] = [];
  const n = 12;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI;
    prof.push([Math.cos(a) * ry + 0.02, Math.sin(a) * rz * (i === 0 || i === n ? 1 : 1)]);
  }
  mb.with(m4.fromBasis([0, 1, 0], [0, 0, 1], [1, 0, 0], [-cw / 2 + 0.01, 0, zf]), () => mb.prism(M.lid, prof, 0, cw - 0.02));
  const hy = 0.02 - ry - 0.035, hz = zf + rz * 0.35;
  for (const sx of [-1, 1]) mb.rod(M.handles, [sx * cw * 0.3, hy + 0.035, hz], [sx * cw * 0.3, hy, hz], 0.006, 6);
  mb.rod(M.handles, [-cw * 0.36, hy, hz], [cw * 0.36, hy, hz], 0.012, 8);
}

function buildOutdoorSofa(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const arms = optBool(s, "arms", true);
  const legH = 0.06;
  const baseTop = clamp(h * 0.36, 0.2, 0.32);
  const armW = arms ? 0.08 : 0;
  const armTop = Math.min(h - 0.05, baseTop + 0.25);
  const backT = 0.06;
  const ct = clamp(h * 0.18, 0.1, 0.16);
  const iw = w - 2 * armW;
  const n = Math.round(optNum(s, "seats", clamp(Math.round(iw / 0.68), 1, 6), 1, 8));
  // base frame
  mb.box(M.frame, [-w / 2 + armW, -d / 2 + 0.01, legH], [w / 2 - armW, d / 2 - backT, baseTop]);
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) mb.block(M.frame, sx * (w / 2 - 0.04), sy * (d / 2 - 0.04), 0, 0.07, 0.07, legH, { skip: ["+z"] });
  // slatted arms
  const slats = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, alongY: boolean) => {
    const len = alongY ? y1 - y0 : x1 - x0;
    const k = Math.max(2, Math.round(len / 0.08));
    const sw = 0.035, gap = (len - k * sw) / (k - 1);
    for (let i = 0; i < k; i++) {
      const a = (alongY ? y0 : x0) + i * (sw + gap);
      if (alongY) mb.box(M.frame, [x0 + 0.01, a, z0], [x1 - 0.01, a + sw, z1]);
      else mb.box(M.frame, [a, y0 + 0.01, z0], [a + sw, y1 - 0.01, z1]);
    }
  };
  if (arms)
    for (const sx of [-1, 1]) {
      const x0 = sx > 0 ? w / 2 - armW : -w / 2, x1 = x0 + armW;
      mb.box(M.frame, [x0, -d / 2, armTop - 0.035], [x1, d / 2, armTop]);
      mb.box(M.frame, [x0, -d / 2, 0], [x1, -d / 2 + 0.07, armTop - 0.035], { skip: ["+z"] });
      mb.box(M.frame, [x0, d / 2 - 0.07, 0], [x1, d / 2, armTop - 0.035], { skip: ["+z"] });
      mb.box(M.frame, [x0, -d / 2 + 0.07, legH], [x1, d / 2 - 0.07, legH + 0.05]);
      slats(x0, x1, -d / 2 + 0.07, d / 2 - 0.07, legH + 0.05, armTop - 0.035, true);
    }
  // slatted back panel
  const bTop = Math.min(h - 0.1, baseTop + ct + 0.3);
  mb.box(M.frame, [-w / 2 + armW, d / 2 - backT, legH], [w / 2 - armW, d / 2, baseTop]);
  mb.box(M.frame, [-w / 2 + armW, d / 2 - backT, bTop - 0.04], [w / 2 - armW, d / 2, bTop]);
  slats(-w / 2 + armW, w / 2 - armW, d / 2 - backT, d / 2, baseTop, bTop - 0.04, false);
  // cushions
  seatCushions(mb, M.cushions, -iw / 2, iw / 2, -d / 2 + 0.01, d / 2 - backT, n, baseTop, ct);
  // keep the leaning cushions' tops inside the footprint on shallow sofas
  const lean = Math.tan((9 * Math.PI) / 180) * (h - 0.02 - baseTop - ct);
  backCushions(mb, M.cushions, -iw / 2, iw / 2, n, d / 2 - Math.max(backT, lean + 0.005), baseTop + ct, h - 0.02, clamp(d * 0.17, 0.1, 0.18));
}

function buildPlanter(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const bh = Math.min(0.5, h * 0.5);
  const wall = clamp(Math.min(w, d) * 0.06, 0.02, 0.05);
  const outline = roundRect(0, 0, w, d, 0.01, 1);
  const hole = roundRect(0, 0, w - 2 * wall, d - 2 * wall, 0.008, 1);
  basinSlab(mb, M.box, M.box, outline, hole, hole, 0, bh, 0.05);
  mb.flat(M.soil, hole, bh - 0.045);
  const sx = w - 2 * wall - 0.01, sy = d - 2 * wall - 0.01;
  const nClumps = Math.max(1, Math.round(sx / Math.max(sy, 0.35)));
  const cw = sx / nClumps;
  for (let i = 0; i < nClumps; i++) foliage(mb, M.foliage, -sx / 2 + cw * (i + 0.5), 0, bh - 0.06, cw * 1.05 > sx ? sx : cw * 1.05, sy, h - bh + 0.06, 5, 17 + i * 13, 9);
}

function buildBush(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const rnd = rng(Math.round(w * 101 + h * 37 + Number(s.options.seed ?? 0) * 7919));
  const size = clamp(Math.min(w, h) * 0.45, 0.25, 0.7);
  leafClump(mb, s.materials.leaves, [0, 0, h * 0.5], [w * 0.42, d * 0.42, h * 0.45], Math.round(clamp(w * d * h * 30, 14, 60)), size, rnd);
}

/** A palm frond: drooping leaf with a raised midrib, closed thin volume. */
function frond(mb: MeshBuilder, mat: string, base: Vec3, a: number, len: number, wid: number) {
  const dir: Vec3 = [Math.cos(a), Math.sin(a), 0], side: Vec3 = [-Math.sin(a), Math.cos(a), 0];
  const n = 7, th = 0.012;
  const C: Vec3[] = [], Lp: Vec3[] = [], Rp: Vec3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const z = base[2] + len * (0.35 * t - 0.75 * t * t);
    const c: Vec3 = [base[0] + dir[0] * len * t, base[1] + dir[1] * len * t, z];
    const wv = wid * Math.sin(Math.PI * Math.min(1, t * 1.15)) * (t < 0.05 ? 0 : 1);
    C.push(c);
    Lp.push([c[0] + side[0] * wv, c[1] + side[1] * wv, z - 0.035 * (wv / wid)]);
    Rp.push([c[0] - side[0] * wv, c[1] - side[1] * wv, z - 0.035 * (wv / wid)]);
  }
  const dn = (p: Vec3): Vec3 => [p[0], p[1], p[2] - th];
  const q = (a: Vec3, b: Vec3, c: Vec3, d: Vec3) => mb.quad(mat, d, c, b, a);
  for (let i = 0; i < n; i++) {
    // top (faces up)
    q(C[i], Lp[i], Lp[i + 1], C[i + 1]);
    q(C[i], C[i + 1], Rp[i + 1], Rp[i]);
    // bottom (faces down)
    q(dn(C[i]), dn(C[i + 1]), dn(Lp[i + 1]), dn(Lp[i]));
    q(dn(C[i]), dn(Rp[i]), dn(Rp[i + 1]), dn(C[i + 1]));
    // edges
    q(Lp[i], dn(Lp[i]), dn(Lp[i + 1]), Lp[i + 1]);
    q(Rp[i], Rp[i + 1], dn(Rp[i + 1]), dn(Rp[i]));
  }
}


// ---------------------------------------------------------------------------
// Foliage from alpha-tested cards (palm fronds, leaf clusters): real silhouettes and dappled shadows
// ---------------------------------------------------------------------------

/** One square leaf-cluster card centred on c, facing n, rotated by spin. */
function leafCard(mb: MeshBuilder, mat: string, c: Vec3, n: Vec3, size: number, spin: number) {
  const nn = v3.norm(n);
  const ref: Vec3 = Math.abs(nn[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  let a = v3.norm(v3.cross(ref, nn));
  let b = v3.cross(nn, a);
  const cs = Math.cos(spin), sn = Math.sin(spin);
  [a, b] = [v3.add(v3.scale(a, cs), v3.scale(b, sn)), v3.sub(v3.scale(b, cs), v3.scale(a, sn))];
  const h = size / 2;
  const p = (u: number, v: number): Vec3 => v3.add(c, v3.add(v3.scale(a, (u - 0.5) * 2 * h), v3.scale(b, (v - 0.5) * 2 * h)));
  mb.quad(mat, p(0, 0), p(1, 0), p(1, 1), p(0, 1), [[0, 0], [1, 0], [1, 1], [0, 1]]);
}

/** A clump of leaf cards filling an ellipsoid. */
function leafClump(mb: MeshBuilder, mat: string, c: Vec3, r: Vec3, cards: number, size: number, rnd: () => number) {
  for (let i = 0; i < cards; i++) {
    // points biased to the outside of the clump, cards facing outward-ish
    const th = rnd() * TAU, ph = Math.acos(2 * rnd() - 1), k = 0.55 + 0.45 * Math.sqrt(rnd());
    const d: Vec3 = [Math.sin(ph) * Math.cos(th), Math.sin(ph) * Math.sin(th), Math.cos(ph)];
    const p: Vec3 = [c[0] + d[0] * r[0] * k, c[1] + d[1] * r[1] * k, c[2] + d[2] * r[2] * k];
    const n = v3.norm(v3.add(d, [rnd() - 0.5, rnd() - 0.5, rnd() - 0.2]));
    leafCard(mb, mat, p, n, size * (0.8 + 0.4 * rnd()), rnd() * TAU);
  }
}

/**
 * A date-palm frond card from the crown: arched rib (start elevation, sagging with length), folded into a V along
 * the rib; u runs base → tip, v across.
 */
function frondCard(mb: MeshBuilder, mat: string, base: Vec3, az: number, elev: number, len: number, wid: number, fold = 0.42) {
  const n = 9;
  const dirH: Vec3 = [Math.cos(az), Math.sin(az), 0];
  const side: Vec3 = [-Math.sin(az), Math.cos(az), 0];
  const rib: Vec3[] = [];
  const ups: Vec3[] = [];
  let p: Vec3 = [...base];
  let e = elev;
  for (let i = 0; i <= n; i++) {
    rib.push(p);
    const t = (i + 0.5) / n;
    // the rib bends down more towards the tip
    e -= (0.18 + 0.55 * t) * (1 / n) * 2.2;
    const d: Vec3 = [dirH[0] * Math.cos(e), dirH[1] * Math.cos(e), Math.sin(e)];
    ups.push(v3.norm(v3.cross(side, d)));
    p = v3.add(p, v3.scale(d, len / n));
  }
  for (let i = 0; i < n; i++) {
    const u0 = i / n, u1 = (i + 1) / n;
    for (const sgn of [-1, 1]) {
      // each half tilted up by the fold angle
      const off = (k: number): Vec3 => v3.add(v3.scale(side, sgn * Math.cos(fold) * wid * 0.5), v3.scale(ups[k], Math.sin(fold) * wid * 0.5));
      const a = rib[i], b = rib[i + 1];
      const a2 = v3.add(a, off(i)), b2 = v3.add(b, off(i + 1));
      const va = sgn < 0 ? 0 : 1;
      mb.quad(mat, a, b, b2, a2, [[u0, 0.5], [u1, 0.5], [u1, va], [u0, va]]);
    }
  }
}

function buildDatePalm(mb: MeshBuilder, s: FurnitureSpec, seed: number) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const rnd = rng(seed);
  const m = Math.min(w, d);
  const crownR = m / 2;
  const lean = Math.min(m * 0.05, 0.3) * (rnd() < 0.5 ? 1 : -0.6);
  const zt = h - crownR * 0.35;
  const segs = 10;
  const pts: Vec3[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    pts.push([lean * t * t, 0, zt * t]);
  }
  for (let i = 0; i < segs; i++) {
    const r0 = 0.2 - 0.05 * (i / segs), r1 = 0.2 - 0.05 * ((i + 1) / segs);
    const a = pts[i], b = pts[i + 1];
    mb.with(m4.fromBasis([1, 0, 0], [0, 1, 0], v3.norm(v3.sub(b, a)), a), () => mb.cylinder(M.palmTrunk, [0, 0, 0], i === 0 ? r0 * 1.25 : r0, r1, v3.len(v3.sub(b, a)), 12, { top: false, bottom: i === 0 }));
  }
  const top = pts[segs];
  // the crown's leaf bases
  mb.sphere(M.palmTrunk, [top[0], top[1], top[2] + 0.05], 0.26, 10, 8, [1, 1, 0.8]);
  const L = crownR * 1.05;
  const tiers: [number, number, number, number][] = [
    // count, elevation (rad), length factor, width factor
    [7, 1.15, 0.78, 0.36],
    [10, 0.55, 1, 0.42],
    [9, 0.05, 0.95, 0.42],
  ];
  let k = 0;
  for (const [count, el, lf, wf] of tiers)
    for (let i = 0; i < count; i++, k++) {
      const az = k * 2.39996 + rnd() * 0.3;
      frondCard(mb, M.fronds, [top[0], top[1], top[2] + 0.1 - el * 0.05], az, el + (rnd() - 0.5) * 0.25, L * lf * (0.88 + rnd() * 0.24), L * wf, 0.35 + rnd() * 0.15);
    }
}

function buildLeafTree(mb: MeshBuilder, s: FurnitureSpec, seed: number, olive: boolean) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const rnd = rng(seed);
  const m = Math.min(w, d);
  const crownZ = h * (olive ? 0.45 : 0.4);
  const stems = olive ? 3 : 1;
  const tips: Vec3[] = [];
  for (let k = 0; k < stems; k++) {
    // a twisted stem: a few jittered rod segments up to the crown, then branches
    const a0 = (k / stems) * TAU + rnd();
    let p: Vec3 = [Math.cos(a0) * 0.05 * (stems - 1), Math.sin(a0) * 0.05 * (stems - 1), 0];
    const r = clamp(m * (olive ? 0.035 : 0.045), 0.05, 0.25);
    const n = 4;
    for (let i = 0; i < n; i++) {
      const t = (i + 1) / n;
      const q: Vec3 = [p[0] + (rnd() - 0.5) * 0.18 + Math.cos(a0) * 0.05 * t, p[1] + (rnd() - 0.5) * 0.18 + Math.sin(a0) * 0.05 * t, crownZ * t];
      mb.rod(M.trunk, p, q, r * (1.15 - 0.3 * t), 8);
      p = q;
    }
    const nb = olive ? 3 : 5;
    for (let b = 0; b < nb; b++) {
      const az = a0 + (b / nb) * TAU + rnd() * 0.6;
      const out = (w / 2) * (0.45 + rnd() * 0.3);
      const q: Vec3 = [p[0] + Math.cos(az) * out, p[1] + Math.sin(az) * out * (d / w), p[2] + (h - crownZ) * (0.3 + rnd() * 0.3)];
      mb.rod(M.trunk, p, q, r * 0.45, 6);
      tips.push(q);
    }
  }
  // leaf clumps at the branch ends and in the middle of the crown
  const cards = olive ? 16 : 18;
  const size = clamp(m * 0.28, 0.45, 1.1);
  const leaves = olive ? M.olive : M.leaves;
  for (const t of tips) leafClump(mb, leaves, [t[0], t[1], t[2] + size * 0.2], [size * 1.1, size * 1.1, size * 0.8], cards, size, rnd);
  leafClump(mb, leaves, [0, 0, crownZ + (h - crownZ) * 0.55], [w * 0.38, d * 0.38, (h - crownZ) * 0.4], cards * 2, size, rnd);
}


/** Water wall: a dark wet-stone panel with a film of water running down into a basin, LED line at the lip. */
function buildWaterWall(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const basinH = clamp(h * 0.14, 0.25, 0.45), basinD = Math.max(d, 0.35);
  const panelT = 0.1;
  const y0 = basinD / 2 - panelT; // panel at the back of the footprint
  mb.box(M.panel, [-w / 2, y0, 0], [w / 2, y0 + panelT, h]);
  // cap on top
  mb.box(M.basin, [-w / 2 - 0.02, y0 - 0.03, h], [w / 2 + 0.02, y0 + panelT + 0.02, h + 0.04]);
  // the sheet of water just in front of the panel, top to basin
  mb.quad(M.water, [-w / 2 + 0.03, y0 - 0.006, basinH - 0.04], [w / 2 - 0.03, y0 - 0.006, basinH - 0.04], [w / 2 - 0.03, y0 - 0.006, h - 0.02], [-w / 2 + 0.03, y0 - 0.006, h - 0.02]);
  // basin: four walls and a water surface
  const t = 0.05, bx = w / 2 + 0.05, by0 = -basinD / 2, by1 = y0;
  mb.box(M.basin, [-bx, by0, 0], [bx, by0 + t, basinH]);
  mb.box(M.basin, [-bx, by0, 0], [-bx + t, by1, basinH]);
  mb.box(M.basin, [bx - t, by0, 0], [bx, by1, basinH]);
  mb.box(M.basin, [-bx + t, by0 + t, 0], [bx - t, by1, 0.05]);
  mb.quad(M.water, [-bx + t, by0 + t, basinH - 0.05], [bx - t, by0 + t, basinH - 0.05], [bx - t, by1, basinH - 0.05], [-bx + t, by1, basinH - 0.05]);
  // warm LED line under the basin's front lip
  mb.box(M.led, [-bx + 0.02, by0 - 0.012, basinH - 0.03], [bx - 0.02, by0, basinH - 0.015]);
}


/** Agave: a rosette of thick pointed leaves, inner ones upright. */
function buildAgave(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, height: h } = s;
  const rnd = rng(Math.round(w * 97 + h * 31 + Number(s.options.seed ?? 0) * 7919));
  const R = w / 2;
  const rings: [number, number, number][] = [
    // count, elevation (rad), length factor
    [9, 0.35, 1],
    [7, 0.8, 0.85],
    [5, 1.2, 0.7],
  ];
  let k = 0;
  for (const [count, el, lf] of rings)
    for (let i = 0; i < count; i++, k++) {
      const az = k * 2.39996 + rnd() * 0.3;
      const len = Math.min(R / Math.max(0.2, Math.cos(el)), h / Math.max(0.2, Math.sin(el))) * lf * (0.85 + rnd() * 0.2);
      const dir: Vec3 = [Math.cos(az), Math.sin(az), 0], side: Vec3 = [-Math.sin(az), Math.cos(az), 0];
      const n = 6, wid = clamp(len * 0.16, 0.04, 0.16);
      const pts: Vec3[] = [];
      for (let j = 0; j <= n; j++) {
        const t = j / n, e = el - 0.35 * t * t;
        pts.push([dir[0] * len * t * Math.cos(e), dir[1] * len * t * Math.cos(e), 0.03 + len * t * Math.sin(e)]);
      }
      for (let j = 0; j < n; j++) {
        const w0 = wid * (1 - j / n) * (j === 0 ? 0.7 : 1), w1 = wid * (1 - (j + 1) / n);
        const a = pts[j], b = pts[j + 1];
        // a shallow V (channelled leaf)
        const ua: Vec3 = [0, 0, w0 * 0.25], ub: Vec3 = [0, 0, w1 * 0.25];
        mb.quad(s.materials.leaf, a, b, v3.add(v3.add(b, v3.scale(side, w1)), ub), v3.add(v3.add(a, v3.scale(side, w0)), ua));
        mb.quad(s.materials.leaf, v3.add(v3.sub(a, v3.scale(side, w0)), ua), v3.add(v3.sub(b, v3.scale(side, w1)), ub), b, a);
      }
    }
}

/** Ornamental grass: a fountain of thin blades. */
function buildGrassClump(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, height: h } = s;
  const rnd = rng(Math.round(w * 89 + h * 53 + Number(s.options.seed ?? 0) * 7919));
  const blades = Math.round(clamp(w * 90, 30, 140));
  for (let i = 0; i < blades; i++) {
    const az = rnd() * TAU, r0 = Math.sqrt(rnd()) * w * 0.12;
    const out = w * (0.25 + rnd() * 0.3), up = h * (0.65 + rnd() * 0.4);
    const dir: Vec3 = [Math.cos(az), Math.sin(az), 0], side: Vec3 = [-Math.sin(az) * 0.006, Math.cos(az) * 0.006, 0];
    const base: Vec3 = [dir[0] * r0, dir[1] * r0, 0];
    const n = 5;
    let prev = base;
    for (let j = 1; j <= n; j++) {
      const t = j / n;
      // rises, then arches outwards and droops at the tip
      const p: Vec3 = [base[0] + dir[0] * out * t * t, base[1] + dir[1] * out * t * t, up * (1.6 * t - 0.75 * t * t)];
      const wa = 1.5 * (1 - (j - 1) / n), wb = 1.5 * (1 - t);
      mb.quad(s.materials.blades, v3.sub(prev, v3.scale(side, wa)), v3.sub(p, v3.scale(side, wb)), v3.add(p, v3.scale(side, wb)), v3.add(prev, v3.scale(side, wa)));
      prev = p;
    }
  }
}

/**
 * Built-in courtyard lounge: masonry plinth with a shadow gap and an LED line under the seat, seat and back
 * cushions, a few throw pillows. shape "l": the long run at the back (+y) and a return down the left (−x).
 */
function buildOutdoorLounge(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d } = s;
  const M = s.materials;
  const L = optStr(s, "shape", ["l", "straight"] as const, "l") === "l";
  const led = s.options.led !== false;
  const sd = Math.min(0.75, d * 0.9), plinthH = 0.32, seatH = 0.44, gap = 0.06;
  const runs: { x0: number; x1: number; y0: number; y1: number; alongX: boolean }[] = [{ x0: -w / 2, x1: w / 2, y0: d / 2 - sd, y1: d / 2, alongX: true }];
  if (L) runs.push({ x0: -w / 2, x1: -w / 2 + sd, y0: -d / 2, y1: d / 2 - sd, alongX: false });
  for (const r of runs) {
    // plinth on a recessed base (the shadow gap), LED line under the front edge
    mb.box(M.plinth, [r.x0, r.y0, gap], [r.x1, r.y1, plinthH]);
    if (r.alongX) mb.box(M.base, [r.x0 + (L ? sd : gap), r.y0 + gap, 0], [r.x1 - gap, r.y1, gap]);
    else mb.box(M.base, [r.x0, r.y0 + gap, 0], [r.x1 - gap, r.y1, gap]);
    if (led) {
      if (r.alongX) mb.box(M.led, [r.x0 + (L ? sd : 0.05), r.y0 + gap + 0.005, gap - 0.016], [r.x1 - 0.05, r.y0 + gap + 0.015, gap - 0.004]);
      else mb.box(M.led, [r.x1 - gap - 0.015, r.y0 + 0.05, gap - 0.016], [r.x1 - gap - 0.005, r.y1, gap - 0.004]);
    }
    // seat cushions ~0.75 m, then back cushions against the back edge
    const len = r.alongX ? r.x1 - r.x0 : r.y1 - r.y0;
    const n = Math.max(1, Math.round(len / 0.75)), cl = len / n;
    for (let i = 0; i < n; i++) {
      if (r.alongX) {
        const a = r.x0 + i * cl;
        mb.box(M.cushions, [a + 0.006, r.y0 + 0.02, plinthH], [a + cl - 0.006, r.y1 - 0.02, seatH]);
        mb.box(M.cushions, [a + 0.01, r.y1 - 0.17, seatH], [a + cl - 0.01, r.y1 - 0.03, seatH + 0.42]);
      } else {
        const a = r.y0 + i * cl;
        mb.box(M.cushions, [r.x0 + 0.02, a + 0.006, plinthH], [r.x1 - 0.02, a + cl - 0.006, seatH]);
        mb.box(M.cushions, [r.x0 + 0.03, a + 0.01, seatH], [r.x0 + 0.17, a + cl - 0.01, seatH + 0.42]);
      }
    }
  }
  // throw pillows
  const pillows: [number, number, boolean][] = L ? [[-w / 2 + sd + 0.35, d / 2 - 0.26, true], [-w / 2 + 0.26, -d / 2 + 0.45, false], [w / 2 - 0.45, d / 2 - 0.26, true]] : [[-w / 2 + 0.4, d / 2 - 0.26, true], [w / 2 - 0.4, d / 2 - 0.26, true]];
  for (const [x, y, alongX] of pillows) mb.box(M.pillows, alongX ? [x - 0.21, y - 0.06, seatH] : [x - 0.06, y - 0.21, seatH], alongX ? [x + 0.21, y + 0.06, seatH + 0.4] : [x + 0.06, y + 0.21, seatH + 0.4]);
}

/** Monolithic stone coffee table on a recessed base, with a dark tray. */
function buildStoneTable(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  mb.box(M.base, [-w / 2 + 0.06, -d / 2 + 0.06, 0], [w / 2 - 0.06, d / 2 - 0.06, 0.05]);
  mb.box(M.top, [-w / 2, -d / 2, 0.05], [w / 2, d / 2, h]);
  if (s.options.tray !== false) {
    mb.cylinder(M.tray, [w * 0.1, 0, h], Math.min(w, d) * 0.24, Math.min(w, d) * 0.24, 0.02, 24);
    mb.sphere(M.tray, [w * 0.1, 0, h + 0.07], 0.07, 12, 8, [1, 1, 0.75]);
  }
}

function buildTree(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const kind = optStr(s, "kind", ["deciduous", "conifer", "palm", "olive"] as const, "deciduous");
  const m = Math.min(w, d);
  const seed = Math.round(w * 131 + d * 71 + h * 13 + Number(s.options.seed ?? 0) * 7919);
  if (kind === "palm") return buildDatePalm(mb, s, seed);
  if (kind === "olive" || kind === "deciduous") return buildLeafTree(mb, s, seed, kind === "olive");
  if (kind === "conifer") {
    const rt = clamp(m * 0.04, 0.05, 0.2);
    mb.cylinder(M.trunk, [0, 0, 0], rt * 1.3, rt * 0.6, h * 0.35, 8);
    const z0 = h * 0.12, n = 4;
    const step = (h - z0) / (n + 0.6);
    for (let i = 0; i < n; i++) {
      const zb = z0 + i * step;
      const top = i === n - 1 ? h : zb + step * 1.7;
      const f = 1 - i / (n + 0.4);
      ecyl(mb, M.needles, 0, 0, zb, (w / 2) * f, (d / 2) * f, top - zb, 12, i === n - 1 ? 0.02 : 0.12);
    }
    return;
  }
  if (kind === "palm") {
    const reach = m / 2 - 0.04;
    const lean = Math.min(m * 0.08, 0.25);
    const zt = h - 0.17;
    const segs = 7;
    const pts: Vec3[] = [];
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      pts.push([lean * t * t, 0, zt * t]);
    }
    for (let i = 0; i < segs; i++) {
      const r0 = 0.15 - 0.05 * (i / segs), r1 = 0.15 - 0.05 * ((i + 1) / segs);
      const a = pts[i], b = pts[i + 1];
      mb.with(m4.fromBasis([1, 0, 0], [0, 1, 0], v3.norm(v3.sub(b, a)), a), () => mb.cylinder(M.trunk, [0, 0, 0], r0 * 1.12, r1, v3.len(v3.sub(b, a)), 8, { top: true, bottom: i === 0 }));
    }
    const top = pts[segs];
    mb.sphere(M.foliage, top, 0.16, 8, 6);
    const fr = Math.min(reach - lean, m / 2 - lean - 0.04);
    for (let i = 0; i < 11; i++) frond(mb, M.foliage, [top[0], top[1], top[2] + 0.04], (i / 11) * TAU + 0.3, fr * (i % 2 ? 0.88 : 1), clamp(fr * 0.17, 0.1, 0.28));
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU;
      mb.sphere(M.trunk, [top[0] + Math.cos(a) * 0.12, Math.sin(a) * 0.12, top[2] - 0.12], 0.07, 8, 6);
    }
    return;
  }
  // deciduous
  const rt = clamp(m * 0.045, 0.06, 0.3);
  const crownZ = h * 0.38;
  mb.cylinder(M.trunk, [0, 0, 0], rt * 1.6, rt, 0.25, 8, { top: false });
  mb.cylinder(M.trunk, [0, 0, 0.25], rt, rt * 0.6, crownZ + (h - crownZ) * 0.35 - 0.25, 8, { bottom: false });
  const rnd = rng(seed);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU + rnd();
    mb.rod(M.trunk, [0, 0, crownZ * 0.9], [Math.cos(a) * w * 0.22, Math.sin(a) * d * 0.22, crownZ + (h - crownZ) * 0.35], rt * 0.35, 6);
  }
  foliage(mb, M.foliage, 0, 0, crownZ, w, d, h - crownZ, 8, seed, 10);
}

function buildHedge(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  softBox(mb, M.foliage, 0, 0, 0, w, d, h, Math.min(0.12, d * 0.3), Math.min(0.08, d * 0.2, h * 0.2), false);
}

function buildFence(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const style = optStr(s, "style", ["picket", "panel", "slats"] as const, "picket");
  const P = clamp(Math.min(d, 0.1), 0.04, 0.1);
  const capS = Math.min(P + 0.015, d, w / 4);
  const PP = Math.max(P, capS);
  const nb = Math.max(1, Math.ceil((w - PP) / 2.0));
  const span = (w - PP) / nb;
  const posts: number[] = [];
  for (let i = 0; i <= nb; i++) posts.push(-w / 2 + PP / 2 + i * span);
  for (const x of posts) {
    mb.block(M.posts, x, 0, 0, P, P, h - 0.03, { skip: ["+z"] });
    mb.block(M.posts, x, 0, h - 0.03, capS, capS, 0.02);
    mb.cylinder(M.posts, [x, 0, h - 0.01], capS * 0.4, capS * 0.15, 0.01, 4, { bottom: false });
  }
  const bt = Math.min(0.02, d * 0.25);
  const yb0 = -P / 2 + 0.005; // board front
  for (let i = 0; i < nb; i++) {
    const x0 = posts[i] + P / 2, x1 = posts[i + 1] - P / 2;
    if (style === "slats") {
      const k = Math.max(2, Math.round((h - 0.1) / 0.11));
      const sh = (h - 0.1 - 0.02 * (k - 1)) / k;
      for (let j = 0; j < k; j++) mb.box(M.boards, [x0, -bt / 2, 0.05 + j * (sh + 0.02)], [x1, bt / 2, 0.05 + j * (sh + 0.02) + sh]);
      continue;
    }
    // rails behind the boards
    for (const z of style === "picket" ? [h * 0.2, h * 0.68] : [h * 0.15, h * 0.5, h - 0.15]) mb.box(M.posts, [x0, yb0 + bt, z], [x1, Math.min(yb0 + bt + 0.035, P / 2), z + 0.07]);
    if (style === "panel") {
      const bw = 0.1;
      const k = Math.max(1, Math.round((x1 - x0) / bw));
      const ww = (x1 - x0) / k;
      for (let j = 0; j < k; j++) mb.box(M.boards, [x0 + j * ww + 0.0015, yb0, 0.04], [x0 + (j + 1) * ww - 0.0015, yb0 + bt, h - 0.07]);
      mb.box(M.boards, [x0, yb0 - 0.004, h - 0.07], [x1, yb0 + bt + 0.035, h - 0.045]);
    } else {
      const pw = 0.075, gap = 0.05;
      const k = Math.max(1, Math.floor((x1 - x0 + gap) / (pw + gap)));
      const used = k * pw + (k - 1) * gap;
      const top = h - 0.05;
      for (let j = 0; j < k; j++) {
        const a = x0 + (x1 - x0 - used) / 2 + j * (pw + gap);
        const prof: Vec2[] = [[a, 0.05], [a + pw, 0.05], [a + pw, top - 0.045], [a + pw / 2, top], [a, top - 0.045]];
        mb.with(m4.fromBasis([1, 0, 0], [0, 0, 1], [0, -1, 0], [0, yb0 + bt, 0]), () => mb.prism(M.boards, prof, 0, bt));
      }
    }
  }
}

function buildHotTub(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const st = 0.1;
  const r = Math.min(0.15, Math.min(w, d) * 0.08);
  const outline = roundRect(0, 0, w, d, r, 3);
  loft(mb, M.cabinet, outline, 0, outline, h - st);
  mb.flat(M.cabinet, outline, 0, true);
  const rim = clamp(Math.min(w, d) * 0.08, 0.1, 0.2);
  const hole = roundRect(0, 0, w - 2 * rim, d - 2 * rim, Math.min(0.3, (Math.min(w, d) - 2 * rim) * 0.25), 3);
  const bottom = roundRect(0, 0, w - 2 * rim - 0.3, d - 2 * rim - 0.3, Math.min(0.2, (Math.min(w, d) - 2 * rim - 0.3) * 0.25), 3);
  const depth = Math.max(0.2, h - 0.12);
  basinSlab(mb, M.shell, M.shell, outline, hole, bottom, h - st, h, depth);
  const tw = 0.13 / depth;
  mb.flat(M.water, hole.map((p, i) => [p[0] + (bottom[i][0] - p[0]) * tw, p[1] + (bottom[i][1] - p[1]) * tw] as Vec2), h - 0.13);
  // seats under water
  const sz = h - depth;
  const sh = Math.min(0.35, depth * 0.5);
  for (const sy of [-1, 1]) mb.box(M.shell, [-(w - 2 * rim) / 2 + 0.3, sy > 0 ? (d - 2 * rim) / 2 - 0.25 - 0.15 : -(d - 2 * rim) / 2 + 0.15, sz], [(w - 2 * rim) / 2 - 0.3, sy > 0 ? (d - 2 * rim) / 2 - 0.15 : -(d - 2 * rim) / 2 + 0.4, sz + sh]);
}

function buildTrashBin(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const wr = clamp(h * 0.1, 0.06, 0.12);
  const ya = d / 2 - wr - 0.01;
  const zTop = h - 0.065;
  const lo = roundRect(0, -0.03, w * 0.78, d * 0.72, 0.05, 2);
  const hi = roundRect(0, -0.01, w - 0.05, d - 0.08, 0.06, 2);
  loft(mb, M.body, lo, 0.03, hi, zTop);
  mb.flat(M.body, lo, 0.03, true);
  mb.flat(M.body, hi, zTop);
  softBox(mb, M.body, 0, -0.01, zTop - 0.04, w - 0.02, d - 0.06, 0.04, 0.06, 0.008);
  // lid with front lip
  softBox(mb, M.lid, 0, -0.01, zTop, w, d - 0.04, h - zTop - 0.005, 0.06, 0.01);
  mb.box(M.lid, [-w * 0.3, -d / 2, zTop - 0.025], [w * 0.3, -d / 2 + 0.03, zTop + 0.01]);
  // handle bar + hinge at the back
  mb.rod(M.lid, [-w / 2 + 0.07, d / 2 - 0.025, zTop - 0.04], [w / 2 - 0.07, d / 2 - 0.025, zTop - 0.04], 0.018, 8);
  for (const sx of [-1, 1]) mb.box(M.body, [sx * (w / 2 - 0.12) - 0.02, d / 2 - 0.06, zTop - 0.06], [sx * (w / 2 - 0.12) + 0.02, d / 2 - 0.02, zTop - 0.02]);
  // wheels + axle, front foot
  for (const sx of [-1, 1]) {
    mb.rod(M.wheels, [sx * (w / 2 - 0.06), ya, wr], [sx * (w / 2 - 0.005), ya, wr], wr, 14);
    mb.rod(M.body, [sx * (w / 2 - 0.004), ya, wr], [sx * (w / 2 - 0.0005), ya, wr], wr * 0.4, 10);
  }
  mb.rod(M.body, [-w / 2 + 0.06, ya, wr], [w / 2 - 0.06, ya, wr], 0.012, 8);
  mb.box(M.body, [-w * 0.25, -d * 0.36 - 0.03, 0], [w * 0.25, -d * 0.36 + 0.06, 0.04]);
}

function buildBicycle(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const R = clamp(Math.min(0.34, h * 0.33, d * 0.195), 0.15, 0.4);
  const yFa = -d / 2 + R + 0.012, yRa = d / 2 - R - 0.012;
  const wb = yRa - yFa;
  const kh = h / 1.05;
  const tr = 0.017;
  const wheel = (y: number) => {
    mb.with(axleX(0, y, R), () => {
      tube(mb, M.tires, 0, 0, -0.02, 0.02, R, R, 0.04, 24);
      tube(mb, M.metal, 0, 0, -0.012, 0.012, R - 0.04, R - 0.04, 0.02, 24);
      mb.cylinder(M.metal, [0, 0, -0.045], 0.022, 0.022, 0.09, 10);
    });
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU;
      const sx = i % 2 ? 1 : -1;
      mb.rod(M.metal, [sx * 0.035, y, R], [0, y + Math.cos(a) * (R - 0.055), R + Math.sin(a) * (R - 0.055)], 0.0018, 3);
    }
  };
  wheel(yFa);
  wheel(yRa);
  const BB: Vec3 = [0, yRa - 0.42 * (wb / 1.04), R * 0.82];
  const ST: Vec3 = [0, BB[1] + 0.15 * kh, BB[2] + 0.52 * kh];
  const HT: Vec3 = [0, yFa + 0.28 * (wb / 1.04), 0.85 * h];
  const HB: Vec3 = [0, yFa + 0.22 * (wb / 1.04), 0.68 * h];
  const tube2 = (a: Vec3, b: Vec3, r = tr) => mb.rod(M.frame, a, b, r, 8);
  tube2(BB, ST);
  tube2(ST, [0, ST[1] - 0.005, ST[2] + 0.04], tr * 1.1);
  tube2(ST, HT, tr * 0.9);
  tube2(HB, BB, tr * 1.15);
  tube2(HB, HT, tr * 1.3);
  for (const sx of [-1, 1]) {
    mb.rod(M.frame, [sx * 0.012, BB[1], BB[2]], [sx * 0.05, yRa, R], 0.011, 6);
    mb.rod(M.frame, [sx * 0.01, ST[1] - 0.01, ST[2] - 0.03], [sx * 0.05, yRa, R], 0.009, 6);
    mb.rod(M.frame, [sx * 0.015, HB[1], HB[2]], [sx * 0.045, yFa, R], 0.012, 6);
  }
  // seat post + saddle
  const saddleZ = Math.min(h - 0.06, 0.9 * h);
  const SP: Vec3 = [0, ST[1] + (saddleZ - ST[2]) * 0.3, saddleZ];
  mb.rod(M.metal, ST, SP, 0.013, 8);
  softBox(mb, M.saddle, 0, SP[1] - 0.04, saddleZ, 0.15, 0.27, 0.05, 0.06, 0.018);
  mb.box(M.saddle, [-0.03, SP[1] - 0.17, saddleZ + 0.005], [0.03, SP[1] - 0.09, saddleZ + 0.045]);
  // stem + handlebar
  const bz = h - 0.03;
  const SB: Vec3 = [0, HT[1] + 0.05, bz];
  mb.rod(M.metal, HT, [0, HT[1] - 0.01, bz - 0.04], 0.014, 8);
  mb.rod(M.metal, [0, HT[1] - 0.01, bz - 0.04], SB, 0.013, 8);
  const hx = Math.min(0.28, w / 2 - 0.02);
  mb.rod(M.metal, [-hx + 0.1, SB[1], bz], [hx - 0.1, SB[1], bz], 0.012, 8);
  for (const sx of [-1, 1]) {
    mb.rod(M.metal, [sx * (hx - 0.1), SB[1], bz], [sx * (hx - 0.11), SB[1] + 0.03, bz], 0.012, 8);
    mb.rod(M.saddle, [sx * (hx - 0.11), SB[1] + 0.03, bz], [sx * hx, SB[1] + 0.03, bz], 0.016, 8);
  }
  // drivetrain
  mb.rod(M.metal, [0.04, BB[1], BB[2]], [0.05, BB[1], BB[2]], 0.09, 16);
  mb.rod(M.metal, [-0.045, BB[1], BB[2]], [0.045, BB[1], BB[2]], 0.025, 8);
  const ca = 0.6;
  for (const sx of [-1, 1]) {
    const py = BB[1] - sx * Math.cos(ca) * 0.17, pz = BB[2] + sx * Math.sin(ca) * 0.17;
    beam(mb, M.metal, [sx * 0.065, BB[1], BB[2]], [sx * 0.065, py, pz], 0.015, 0.03);
    mb.box(M.saddle, [sx > 0 ? 0.075 : -0.16, py - 0.04, pz - 0.012], [sx > 0 ? 0.16 : -0.075, py + 0.04, pz + 0.012]);
  }
  mb.rod(M.metal, [0.05, BB[1], BB[2] + 0.09], [0.05, yRa, R + 0.035], 0.004, 4);
  mb.rod(M.metal, [0.05, BB[1], BB[2] - 0.09], [0.05, yRa, R - 0.035], 0.004, 4);
  mb.rod(M.metal, [0.05, yRa, R], [0.06, yRa, R], 0.04, 10);
}

function buildLampPost(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const k = Math.min(w, d) / 0.4;
  const head = Math.min(0.62, h * 0.2);
  mb.cylinder(M.pole, [0, 0, 0], 0.17 * k, 0.12 * k, 0.08, 12);
  mb.cylinder(M.pole, [0, 0, 0.08], 0.12 * k, 0.07 * k, 0.32, 12, { bottom: false });
  mb.cylinder(M.pole, [0, 0, 0.4], 0.055 * k, 0.04 * k, h - head - 0.4, 10, { bottom: false, top: false });
  mb.cylinder(M.pole, [0, 0, h - head], 0.065 * k, 0.065 * k, 0.05, 10);
  const z0 = h - head + 0.05;
  const gl = head * 0.5;
  mb.cylinder(M.pole, [0, 0, z0], 0.05 * k, 0.13 * k, head * 0.1, 6, { bottom: true, top: false });
  const zg = z0 + head * 0.1;
  mb.cylinder(M.light, [0, 0, zg], 0.12 * k, 0.15 * k, gl, 6, { bottom: true, top: false });
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU;
    mb.rod(M.pole, [Math.cos(a) * 0.125 * k, Math.sin(a) * 0.125 * k, zg], [Math.cos(a) * 0.155 * k, Math.sin(a) * 0.155 * k, zg + gl], 0.008, 4);
  }
  const zr = zg + gl;
  mb.cylinder(M.pole, [0, 0, zr], 0.195 * k, 0.04 * k, h - zr - 0.06, 6);
  mb.cylinder(M.pole, [0, 0, h - 0.06], 0.025 * k, 0.004, 0.06, 8, { bottom: false });
}

function buildMailbox(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const r = (w - 0.06) / 2;
  const hb = Math.min(0.12, h * 0.1);
  const zb = h - hb - r;
  const P = Math.min(0.09, w * 0.4);
  mb.block(M.post, 0, 0.05 * (d / 0.5), 0, P, P, zb, { skip: ["+z"] });
  mb.box(M.post, [-r, -0.1, zb - 0.025], [r, d / 2 - 0.05, zb]);
  const D = (inset: number): Vec2[] => {
    const pts: Vec2[] = [[-r + inset, -hb + inset], [r - inset, -hb + inset]];
    for (let i = 0; i <= 10; i++) {
      const a = (i / 10) * Math.PI;
      pts.push([Math.cos(a) * (r - inset), Math.sin(a) * (r - inset)]);
    }
    return pts;
  };
  const len = d - 0.025;
  mb.with(m4.fromBasis([1, 0, 0], [0, 0, 1], [0, -1, 0], [0, d / 2 - 0.005, zb + hb]), () => {
    mb.prism(M.box, D(0), 0, len);
    mb.prism(M.box, D(0.006), len, len + 0.012);
  });
  mb.box(M.box, [-0.02, -d / 2, zb + hb + r * 0.55], [0.02, -d / 2 + 0.01, zb + hb + r * 0.75]);
  // flag on the +X side
  const fx = r + 0.004;
  mb.box(M.flag, [fx, 0.02, zb + 0.03], [fx + 0.008, 0.045, zb + hb + r + 0.03 > h ? h - 0.01 : zb + hb + r]);
  mb.box(M.flag, [fx, 0.045, zb + hb + r - 0.08], [fx + 0.008, 0.13, zb + hb + r - 0.005]);
}

// ---------------------------------------------------------------------------
// interior decor
// WALL-MOUNTED items (wall_art, gallery_wall, floating_shelf, wall_clock, mirror_round, mirror_arched,
// towel_rail, towel_hook_set, toilet_roll_holder, mirror_full_length with lean=false) are built at
// z = 0..h with their BACK FLAT AGAINST THE WALL at y = +d/2 and the front facing -Y: place them with
// `elevation` and a position half their depth in front of the wall face.
// ---------------------------------------------------------------------------

/** Quad oriented so its normal points away from `ref`. */
function quadOut(mb: MeshBuilder, mat: string, a: Vec3, b: Vec3, c: Vec3, d: Vec3, ref: Vec3) {
  const n = v3.add(v3.cross(v3.sub(b, a), v3.sub(c, a)), v3.cross(v3.sub(c, a), v3.sub(d, a)));
  const m: Vec3 = [(a[0] + b[0] + c[0] + d[0]) / 4, (a[1] + b[1] + c[1] + d[1]) / 4, (a[2] + b[2] + c[2] + d[2]) / 4];
  if (v3.dot(n, v3.sub(m, ref)) < 0) mb.quad(mat, d, c, b, a);
  else mb.quad(mat, a, b, c, d);
}

/**
 * Surface of revolution around the vertical axis at (cx, cy). `prof` = [radius, z] points:
 * rising segments become smooth outward walls, falling segments inward walls (vessel interiors),
 * level segments discs/annuli (moving inward = facing up, outward = facing down).
 */
function lathe(mb: MeshBuilder, mat: string, cx: number, cy: number, prof: Vec2[], seg = 16) {
  for (let i = 0; i + 1 < prof.length; i++) {
    const [r0, z0] = prof[i], [r1, z1] = prof[i + 1];
    if (Math.abs(z1 - z0) < 1e-6) {
      if (Math.abs(r1 - r0) < 1e-6) continue;
      const ro = Math.max(r0, r1), ri = Math.min(r0, r1);
      mb.flat(mat, ellipse(cx, cy, ro, ro, seg), z0, r1 > r0, ri > 1e-4 ? [ellipse(cx, cy, ri, ri, seg)] : []);
    } else if (z1 > z0) {
      mb.cylinder(mat, [cx, cy, z0], Math.max(r0, 1e-4), Math.max(r1, 1e-4), z1 - z0, seg, { top: false, bottom: false });
    } else {
      loft(mb, mat, ellipse(cx, cy, Math.max(r1, 1e-4), Math.max(r1, 1e-4), seg), z1, ellipse(cx, cy, Math.max(r0, 1e-4), Math.max(r0, 1e-4), seg), z0, true);
    }
  }
}

/** Like `lathe`, but every ring is a rounded rectangle (w x d, corner r) shrunk by the profile's inset. */
function rectLathe(mb: MeshBuilder, mat: string, cx: number, cy: number, w: number, d: number, r: number, prof: Vec2[], seg = 5) {
  const ring = (s: number) => roundRect(cx, cy, Math.max(w - 2 * s, 0.004), Math.max(d - 2 * s, 0.004), Math.max(r - s, 0.0015), seg);
  for (let i = 0; i + 1 < prof.length; i++) {
    const [s0, z0] = prof[i], [s1, z1] = prof[i + 1];
    if (Math.abs(z1 - z0) < 1e-6) {
      if (Math.abs(s1 - s0) < 1e-6) continue;
      const so = Math.min(s0, s1), si = Math.max(s0, s1);
      const inner = Math.min(w, d) - 2 * si > 0.006 ? [ring(si)] : [];
      mb.flat(mat, ring(so), z0, s1 < s0, inner);
    } else if (z1 > z0) loft(mb, mat, ring(s0), z0, ring(s1), z1);
    else loft(mb, mat, ring(s1), z1, ring(s0), z0, true);
  }
}

/**
 * Leaf / blade: closed thin solid from `base` along unit `dir`, width profile `shape(t)` (0..1),
 * drooping by `droop` * len * t^2, edges cupped down. `side` overrides the width direction.
 */
function blade(
  mb: MeshBuilder,
  mat: string,
  base: Vec3,
  dir: Vec3,
  len: number,
  wid: number,
  o: { droop?: number; n?: number; shape?: (t: number) => number; cup?: number; th?: number; side?: Vec3 } = {},
) {
  const n = o.n ?? 5, th = o.th ?? 0.004, cup = o.cup ?? 0.25, droop = o.droop ?? 0;
  const shape = o.shape ?? ((t: number) => Math.sin(Math.PI * Math.min(1, t)));
  dir = v3.norm(dir);
  let side = o.side ?? v3.cross([0, 0, 1], dir);
  if (v3.len(side) < 1e-3) side = [1, 0, 0];
  side = v3.norm(side);
  const nrm = v3.norm(v3.cross(dir, side));
  const C: Vec3[] = [], L: Vec3[] = [], R: Vec3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const c = v3.add(v3.add(base, v3.scale(dir, len * t)), [0, 0, -droop * len * t * t]);
    const wv = wid * Math.max(0, shape(t));
    C.push(c);
    L.push(v3.add(v3.add(c, v3.scale(side, wv)), v3.scale(nrm, -cup * wv)));
    R.push(v3.add(v3.add(c, v3.scale(side, -wv)), v3.scale(nrm, -cup * wv)));
  }
  const dn = (p: Vec3) => v3.add(p, v3.scale(nrm, -th));
  for (let i = 0; i < n; i++) {
    const mid = v3.add(v3.lerp(C[i], C[i + 1], 0.5), v3.scale(nrm, -th / 2 - cup * wid * 0.3 * shape((i + 0.5) / n)));
    quadOut(mb, mat, C[i], L[i], L[i + 1], C[i + 1], dn(mid));
    quadOut(mb, mat, C[i], C[i + 1], R[i + 1], R[i], dn(mid));
    quadOut(mb, mat, dn(C[i]), dn(L[i]), dn(L[i + 1]), dn(C[i + 1]), v3.add(mid, v3.scale(nrm, th * 2)));
    quadOut(mb, mat, dn(C[i]), dn(C[i + 1]), dn(R[i + 1]), dn(R[i]), v3.add(mid, v3.scale(nrm, th * 2)));
    quadOut(mb, mat, L[i], dn(L[i]), dn(L[i + 1]), L[i + 1], v3.lerp(C[i], C[i + 1], 0.5));
    quadOut(mb, mat, R[i], R[i + 1], dn(R[i + 1]), dn(R[i]), v3.lerp(C[i], C[i + 1], 0.5));
  }
}

/** Puffy pillow in the XZ plane (faces -Y / +Y), centered at (cx, y0, cz); T = half thickness. */
function pillow(mb: MeshBuilder, mat: string, cx: number, y0: number, cz: number, w: number, h: number, T: number, round = false, tufted = false, N = 8) {
  const P = (i: number, j: number, s: number): Vec3 => {
    const u = -1 + (2 * i) / N, v = -1 + (2 * j) / N;
    let x: number, z: number, f: number;
    if (round) {
      const du = u * Math.sqrt(1 - (v * v) / 2), dv = v * Math.sqrt(1 - (u * u) / 2);
      x = (du * w) / 2;
      z = (dv * h) / 2;
      f = Math.pow(Math.max(0, 1 - (du * du + dv * dv)), 0.45);
    } else {
      x = ((u * w) / 2) * (1 - 0.07 * (1 - v * v));
      z = ((v * h) / 2) * (1 - 0.07 * (1 - u * u));
      f = Math.pow(Math.max(0, 1 - u * u), 0.5) * Math.pow(Math.max(0, 1 - v * v), 0.5);
    }
    if (tufted) f *= 1 - 0.4 * Math.exp(-(u * u + v * v) * 10);
    return [cx + x, y0 + s * T * f, cz + z];
  };
  const ref: Vec3 = [cx, y0, cz];
  for (let i = 0; i < N; i++)
    for (let j = 0; j < N; j++)
      for (const s of [-1, 1]) quadOut(mb, mat, P(i, j, s), P(i + 1, j, s), P(i + 1, j + 1, s), P(i, j + 1, s), ref);
  return (i: number, j: number) => P(i, j, 0);
}

/** Torus around `axis` ("y": ring standing in the XZ plane, "z": lying flat). Arc a0..a1 of the ring. */
function torus(mb: MeshBuilder, mat: string, c: Vec3, R: number, r: number, axis: "y" | "z" = "z", segR = 20, segr = 8, a0 = 0, a1 = TAU) {
  const e1: Vec3 = [1, 0, 0], e2: Vec3 = axis === "z" ? [0, 1, 0] : [0, 0, 1], e3: Vec3 = axis === "z" ? [0, 0, 1] : [0, -1, 0];
  const P = (i: number, j: number): Vec3 => {
    const u = a0 + ((a1 - a0) * i) / segR, v = (j / segr) * TAU;
    const k = R + r * Math.cos(v);
    return v3.add(c, v3.add(v3.add(v3.scale(e1, k * Math.cos(u)), v3.scale(e2, k * Math.sin(u))), v3.scale(e3, r * Math.sin(v))));
  };
  const T = (i: number): Vec3 => {
    const u = a0 + ((a1 - a0) * i) / segR;
    return v3.add(c, v3.add(v3.scale(e1, R * Math.cos(u)), v3.scale(e2, R * Math.sin(u))));
  };
  for (let i = 0; i < segR; i++) {
    const ref = v3.lerp(T(i), T(i + 1), 0.5);
    for (let j = 0; j < segr; j++) quadOut(mb, mat, P(i, j), P(i + 1, j), P(i + 1, j + 1), P(i, j + 1), ref);
  }
}

/** Smooth-ish tube swept along a polyline with per-point radius (0 radius = pointed end). */
function sweepTube(mb: MeshBuilder, mat: string, pts: Vec3[], radii: number[], seg = 8) {
  const rings: Vec3[][] = [];
  for (let i = 0; i < pts.length; i++) {
    const t = v3.norm(v3.sub(pts[Math.min(pts.length - 1, i + 1)], pts[Math.max(0, i - 1)]));
    let n = v3.cross(t, [0, 0, 1]);
    if (v3.len(n) < 1e-3) n = [1, 0, 0];
    n = v3.norm(n);
    const b = v3.cross(t, n);
    const ring: Vec3[] = [];
    for (let k = 0; k < seg; k++) {
      const a = (k / seg) * TAU;
      ring.push(v3.add(pts[i], v3.add(v3.scale(n, Math.cos(a) * radii[i]), v3.scale(b, Math.sin(a) * radii[i]))));
    }
    rings.push(ring);
  }
  for (let i = 0; i + 1 < pts.length; i++) {
    const ref = v3.lerp(pts[i], pts[i + 1], 0.5);
    for (let k = 0; k < seg; k++) {
      const j = (k + 1) % seg;
      quadOut(mb, mat, rings[i][k], rings[i][j], rings[i + 1][j], rings[i + 1][k], ref);
    }
  }
  for (const [i, o] of [[0, 1], [pts.length - 1, pts.length - 2]]) {
    if (radii[i] < 1e-4) continue;
    const out = v3.norm(v3.sub(pts[i], pts[o]));
    mb.polygon(mat, rings[i], out);
  }
}

// ---- small decor primitives (shared by shelves, trays, consoles...) ----

const VASE_PROFILES: Record<string, Vec2[]> = {
  bottle: [[0, 0], [0.72, 0], [0.95, 0.07], [1, 0.33], [0.86, 0.55], [0.36, 0.72], [0.25, 0.8], [0.26, 0.97], [0.3, 1], [0.21, 1], [0.19, 0.9], [0, 0.9]],
  bulb: [[0, 0], [0.5, 0], [0.84, 0.1], [1, 0.38], [0.92, 0.64], [0.58, 0.82], [0.36, 0.9], [0.34, 1], [0.27, 1], [0.26, 0.86], [0, 0.86]],
  cylinder: [[0, 0], [0.95, 0], [1, 0.03], [1, 1], [0.9, 1], [0.9, 0.06], [0, 0.06]],
  pot: [[0, 0], [0.72, 0], [0.8, 0.05], [1, 0.85], [1.06, 0.88], [1.06, 1], [0.94, 1], [0.94, 0.9], [0, 0.9]],
  bowl: [[0, 0], [0.42, 0], [0.45, 0.12], [0.8, 0.45], [1, 1], [0.93, 1], [0.74, 0.5], [0.4, 0.22], [0, 0.22]],
  jar: [[0, 0], [0.9, 0], [1, 0.06], [1, 0.92], [0.92, 1], [0.84, 1], [0.84, 0.08], [0, 0.08]],
};

function vessel(mb: MeshBuilder, mat: string, x: number, y: number, z: number, r: number, hgt: number, shape: keyof typeof VASE_PROFILES, seg = 16) {
  lathe(mb, mat, x, y, VASE_PROFILES[shape].map(([pr, pz]) => [pr * r, z + pz * hgt] as Vec2), seg);
}

/** Book standing upright (spine to -Y) or lying flat (spine to -Y), with paper pages showing. */
function book(mb: MeshBuilder, cover: string, pages: string, x0: number, y0: number, z0: number, bw: number, bd: number, bh: number, flat = false) {
  const c = Math.min(0.0025, Math.min(bw, bh) * 0.15);
  if (!flat) {
    mb.box(cover, [x0, y0, z0], [x0 + c, y0 + bd, z0 + bh]);
    mb.box(cover, [x0 + bw - c, y0, z0], [x0 + bw, y0 + bd, z0 + bh]);
    mb.box(cover, [x0 + c, y0, z0], [x0 + bw - c, y0 + c, z0 + bh]);
    mb.box(pages, [x0 + c, y0 + c, z0 + 0.003], [x0 + bw - c, y0 + bd - 0.003, z0 + bh - 0.003]);
  } else {
    mb.box(cover, [x0, y0, z0], [x0 + bw, y0 + bd, z0 + c]);
    mb.box(cover, [x0, y0, z0 + bh - c], [x0 + bw, y0 + bd, z0 + bh]);
    mb.box(cover, [x0, y0, z0 + c], [x0 + bw, y0 + c, z0 + bh - c]);
    mb.box(pages, [x0 + 0.003, y0 + c, z0 + c], [x0 + bw - 0.003, y0 + bd - 0.003, z0 + bh - c]);
  }
}

/** Upright books from x to at most xEnd; returns the x where the row ended. */
function bookRow(mb: MeshBuilder, covers: string[], pages: string, x: number, xEnd: number, yFront: number, maxD: number, z: number, maxH: number, rnd: () => number) {
  while (true) {
    const bw = 0.018 + rnd() * 0.022;
    if (x + bw > xEnd) break;
    const bh = Math.min(maxH, 0.17 + rnd() * 0.09);
    const y0 = yFront + rnd() * 0.008;
    const bd = Math.min(yFront + maxD - y0, 0.13 + rnd() * 0.05);
    book(mb, covers[Math.floor(rnd() * covers.length) % covers.length], pages, x, y0, z, bw, bd, bh);
    x += bw + 0.001;
  }
  return x;
}

/** Stack of books lying flat; returns the top z. */
function bookPile(mb: MeshBuilder, covers: string[], pages: string, cx: number, cy: number, z: number, maxW: number, maxD: number, n: number, rnd: () => number) {
  for (let i = 0; i < n; i++) {
    const bw = Math.min(maxW, 0.19 + rnd() * 0.06) - i * 0.012, bd = Math.min(maxD, 0.14 + rnd() * 0.04) - i * 0.008;
    const bh = 0.022 + rnd() * 0.016;
    const ox = (rnd() - 0.5) * Math.max(0, maxW - bw) * 0.8;
    book(mb, covers[(i + Math.floor(rnd() * 3)) % covers.length], pages, cx - bw / 2 + ox, cy - bd / 2, z, bw, bd, bh, true);
    z += bh;
  }
  return z;
}

function candle(mb: MeshBuilder, wax: string, flame: string | null, x: number, y: number, z: number, r: number, hgt: number) {
  mb.cylinder(wax, [x, y, z], r, r, hgt, 14);
  if (!flame) return;
  mb.cylinder("rubber_black", [x, y, z + hgt], 0.0012, 0.001, 0.008, 4, { bottom: false });
  mb.sphere(flame, [x, y, z + hgt + 0.016], 0.006, 8, 6, [1, 1, 2]);
}

function miniPlant(mb: MeshBuilder, pot: string, soil: string, foliageMat: string, x: number, y: number, z: number, r: number, hgt: number, seed: number) {
  const ph = Math.min(hgt * 0.45, r * 2.2);
  vessel(mb, pot, x, y, z, r, ph, "pot", 12);
  mb.cylinder(soil, [x, y, z + ph * 0.86], r * 0.92, r * 0.92, 0.003, 12, { bottom: false });
  const fr = Math.min(r * 1.25, hgt * 0.35);
  foliage(mb, foliageMat, x, y, z + ph * 0.8, fr * 2, fr * 2, hgt - ph * 0.8, 4, seed, 8);
}

/** Dress a shelf strip [x0,x1] x [yF,yB] at height z with books, a vase, a plant... */
function shelfDecor(mb: MeshBuilder, M: Record<string, string>, x0: number, x1: number, yF: number, yB: number, z: number, clearH: number, seed: number) {
  const rnd = rng(seed);
  const covers = [M.book_a, M.book_b, M.book_c];
  const depth = yB - yF;
  if (clearH < 0.08 || depth < 0.08) return;
  const yc = (yF + yB) / 2;
  let x = x0 + 0.02 + rnd() * 0.04;
  const order = Math.floor(rnd() * 3);
  for (let k = 0; k < 3 && x < x1 - 0.06; k++) {
    const kind = (k + order) % 3;
    if (kind === 0 && clearH > 0.16) {
      const end = Math.min(x1 - 0.02, x + 0.1 + rnd() * 0.12);
      x = bookRow(mb, covers, M.pages, x, end, yB - Math.min(depth - 0.01, 0.17) - 0.004, depth - 0.012, z, clearH - 0.01, rnd) + 0.06;
    } else if (kind === 1) {
      const r = Math.min(0.05, depth * 0.3, (x1 - x) / 2 - 0.01);
      if (r < 0.02) break;
      const vh = Math.min(clearH - 0.01, r * 4);
      vessel(mb, M.vase, x + r, yc, z, r, vh, rnd() < 0.5 ? "bulb" : "bottle", 12);
      x += 2 * r + 0.07;
    } else {
      const r = Math.min(0.045, depth * 0.3, (x1 - x) / 2 - 0.01);
      if (r < 0.02) break;
      if (rnd() < 0.5 && clearH > 0.12) miniPlant(mb, M.pot, M.soil, M.foliage, x + r * 1.25, yc, z, r, Math.min(clearH - 0.01, 0.22), seed + k);
      else {
        const top = bookPile(mb, covers, M.pages, x + 0.1, yc, z, Math.min(0.2, x1 - x - 0.01), depth - 0.02, 2, rnd);
        if (top + 0.05 < z + clearH) mb.sphere(M.vase, [x + 0.1, yc, top + 0.035], 0.035, 12, 8);
        x += 0.1;
      }
      x += 2 * r + 0.08;
    }
  }
}

const DECOR_SLOTS = { book_a: "fabric_red", book_b: "art_navy", book_c: "art_cream", pages: "paper_white", vase: "ceramic_white", pot: "terracotta", soil: "dirt", foliage: "plant_green" };

// ---- wall art ----

type FrameStyle = "thin_black" | "oak" | "gold" | "none";
type ArtStyle = "abstract" | "landscape" | "geometric" | "botanical";
const FRAME_STYLES = ["thin_black", "oak", "gold", "none"] as const;
const ART_STYLES = ["abstract", "landscape", "geometric", "botanical"] as const;
const FRAME_DEF: Record<FrameStyle, { fw: number; mat: string }> = {
  thin_black: { fw: 0.016, mat: "metal_black" },
  oak: { fw: 0.032, mat: "wood_oak" },
  gold: { fw: 0.042, mat: "metal_gold" },
  none: { fw: 0, mat: "" },
};

/** Flat procedural artwork painted as stacked 1.5 mm layers in front of yFront (facing -Y). */
function paintArt(mb: MeshBuilder, M: Record<string, string>, x0: number, x1: number, z0: number, z1: number, yFront: number, art: ArtStyle, seed: number) {
  const W = x1 - x0, H = z1 - z0, m = Math.min(W, H);
  const rnd = rng(seed * 7919 + 13);
  const pal = [M.art_a, M.art_b, M.art_c, M.art_d];
  const Y = (layer: number) => yFront - 0.0015 * (layer + 1);
  const uv = (u: number, v: number, layer: number): Vec3 => [x0 + clamp(u, 0, 1) * W, Y(layer), z0 + clamp(v, 0, 1) * H];
  const poly = (mat: string, layer: number, pts: Vec2[]) => mb.polygon(mat, pts.map(([u, v]) => uv(u, v, layer)), [0, -1, 0]);
  /** circle / arc in meters around (u,v); a0..a1 partial arcs include the center */
  const disc = (mat: string, layer: number, cu: number, cv: number, r: number, a0 = 0, a1 = TAU, seg = 28) => {
    const pts: Vec3[] = [];
    const full = a1 - a0 >= TAU - 1e-6;
    const cx = x0 + cu * W, cz = z0 + cv * H;
    if (!full) pts.push([cx, Y(layer), cz]);
    const n = full ? seg : Math.max(4, Math.round((seg * (a1 - a0)) / TAU));
    for (let i = 0; i < (full ? n : n + 1); i++) {
      const a = a0 + ((a1 - a0) * i) / n;
      pts.push([clamp(cx + Math.cos(a) * r, x0, x1), Y(layer), clamp(cz + Math.sin(a) * r, z0, z1)]);
    }
    mb.polygon(mat, pts, [0, -1, 0]);
  };
  const j = () => (rnd() - 0.5) * 0.08;
  if (art === "landscape") {
    disc(M.art_c, 0, 0.7 + j(), 0.72 + j() * 0.5, 0.11 * m);
    const far: Vec2[] = [[0, 0], [1, 0], [1, 0.46]];
    for (const [u, v] of [[0.86, 0.57], [0.7, 0.43], [0.52, 0.66], [0.33, 0.46], [0.18, 0.62], [0, 0.44]] as Vec2[]) far.push([u, v + j() * 0.5]);
    poly(M.art_d, 1, far);
    const wave = (base: number, amp: number, k: number, ph: number, layer: number, mat: string) => {
      const pts: Vec2[] = [[0, 0], [1, 0]];
      for (let i = 12; i >= 0; i--) pts.push([i / 12, base + amp * Math.sin(Math.PI * k * (i / 12) + ph)]);
      poly(mat, layer, pts);
    };
    wave(0.3, 0.07, 2.4, 0.5 + rnd(), 2, M.art_b);
    wave(0.13, 0.05, 1.6, 1 + rnd(), 3, M.art_a);
  } else if (art === "geometric") {
    const cols = W > H * 1.25 ? 3 : 2, rows = H > W * 1.25 ? 3 : 2;
    const cw = 1 / cols, ch = 1 / rows;
    let last = -1;
    for (let cx = 0; cx < cols; cx++)
      for (let cy = 0; cy < rows; cy++) {
        const u0 = cx * cw, v0 = cy * ch, u1 = u0 + cw, v1 = v0 + ch;
        let ci = Math.floor(rnd() * 4);
        if (ci === last) ci = (ci + 1) % 4;
        last = ci;
        if (rnd() < 0.45) poly(pal[(ci + 2) % 4], 0, [[u0, v0], [u1, v0], [u1, v1], [u0, v1]]);
        const r = Math.min(cw * W, ch * H);
        const k = Math.floor(rnd() * 4);
        const ucx = (u0 + u1) / 2, vcy = (v0 + v1) / 2;
        if (k === 0) disc(pal[ci], 1, ucx, v0, r * 0.48, 0, Math.PI);
        else if (k === 1) disc(pal[ci], 1, u0, v0, r * 0.95, 0, Math.PI / 2);
        else if (k === 2) poly(pal[ci], 1, [[u0 + cw * 0.1, v0 + ch * 0.1], [u1 - cw * 0.1, v0 + ch * 0.1], [ucx, v1 - ch * 0.1]]);
        else disc(pal[ci], 1, ucx, vcy, r * 0.32);
      }
  } else if (art === "botanical") {
    const stem: Vec2[] = [];
    const n = 10;
    const bend = 0.08 + j();
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      stem.push([0.5 + bend * Math.sin(t * 2.2) - bend * 0.5, 0.08 + 0.8 * t]);
    }
    const sw = 0.006 / W;
    poly(M.art_b, 0, [...stem.map(([u, v]) => [u - sw, v] as Vec2), ...stem.map(([u, v]) => [u + sw, v] as Vec2).reverse()]);
    for (let i = 1; i < 9; i++) {
      const [u, v] = stem[i];
      const side = i % 2 ? 1 : -1;
      const ang = Math.PI / 2 - side * (0.75 + rnd() * 0.25);
      const L = 0.17 * m * (1 - i * 0.05), Wd = L * 0.32;
      const cxm = x0 + u * W + Math.cos(ang) * L * 0.55, czm = z0 + v * H + Math.sin(ang) * L * 0.55;
      const pts: Vec3[] = [];
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * TAU;
        const lx = Math.cos(a) * L * 0.55, ly = Math.sin(a) * Wd * 0.5 * (1 - 0.3 * Math.cos(a));
        pts.push([clamp(cxm + lx * Math.cos(ang) - ly * Math.sin(ang), x0, x1), Y(1 + (i % 2)), clamp(czm + lx * Math.sin(ang) + ly * Math.cos(ang), z0, z1)]);
      }
      mb.polygon(i % 3 === 0 ? M.art_a : M.art_d, pts, [0, -1, 0]);
    }
    disc(M.art_c, 0, 0.5 + bend * 0.4, 0.9, 0.035 * m);
  } else {
    disc(M.art_b, 0, 1, 0, 0.62 * m, Math.PI / 2, Math.PI, 20);
    const aw = 0.34 * m, ax = 0.12 + j();
    const az0 = 0.1, az1 = 0.48 + j() * 0.5;
    poly(M.art_a, 1, [[ax, az0], [ax + aw / W, az0], [ax + aw / W, az1], [ax, az1]]);
    disc(M.art_a, 1, ax + aw / W / 2, az1, aw / 2, 0, Math.PI, 16);
    disc(M.art_c, 2, 0.68 + j(), 0.7 + j(), 0.15 * m);
    poly(M.art_d, 3, [[0.55, 0.12], [0.82, 0.12], [0.82, 0.3], [0.55, 0.3]]);
    const lv = 0.86 + j() * 0.3;
    poly(M.art_e, 3, [[0.1, lv], [0.42, lv], [0.42, lv + 0.012], [0.1, lv + 0.012]]);
  }
}

/** A framed (or canvas-wrapped) artwork occupying x0..x1, z0..z1, back at yb, depth d. */
function artwork(mb: MeshBuilder, M: Record<string, string>, x0: number, x1: number, z0: number, z1: number, yb: number, d: number, frame: FrameStyle, art: ArtStyle, matBoard: boolean, seed: number) {
  const W = x1 - x0, H = z1 - z0;
  if (frame === "none") {
    mb.box(M.canvas, [x0, yb - d + 0.007, z0], [x1, yb, z1]);
    paintArt(mb, M, x0, x1, z0, z1, yb - d + 0.007, art, seed);
    return;
  }
  const fw = Math.min(FRAME_DEF[frame].fw, W * 0.12, H * 0.12);
  const fm = M.frame !== "metal_black" ? M.frame : FRAME_DEF[frame].mat;
  const yf = yb - d;
  mb.box(fm, [x0, yf, z0], [x1, yb, z0 + fw]);
  mb.box(fm, [x0, yf, z1 - fw], [x1, yb, z1]);
  mb.box(fm, [x0, yf, z0 + fw], [x0 + fw, yb, z1 - fw]);
  mb.box(fm, [x1 - fw, yf, z0 + fw], [x1, yb, z1 - fw]);
  let ix0 = x0 + fw, ix1 = x1 - fw, iz0 = z0 + fw, iz1 = z1 - fw;
  if (frame === "gold") {
    const lw = fw * 0.3, ly = yf + 0.008;
    mb.box(fm, [ix0, ly, iz0], [ix1, yb, iz0 + lw]);
    mb.box(fm, [ix0, ly, iz1 - lw], [ix1, yb, iz1]);
    mb.box(fm, [ix0, ly, iz0 + lw], [ix0 + lw, yb, iz1 - lw]);
    mb.box(fm, [ix1 - lw, ly, iz0 + lw], [ix1, yb, iz1 - lw]);
    ix0 += lw; ix1 -= lw; iz0 += lw; iz1 -= lw;
  }
  const yArt = yf + (frame === "gold" ? 0.014 : 0.008);
  if (matBoard) {
    const mw = Math.min(ix1 - ix0, iz1 - iz0) * 0.13;
    mb.box(M.mat, [ix0, yArt, iz0], [ix1, yb, iz0 + mw]);
    mb.box(M.mat, [ix0, yArt, iz1 - mw], [ix1, yb, iz1]);
    mb.box(M.mat, [ix0, yArt, iz0 + mw], [ix0 + mw, yb, iz1 - mw]);
    mb.box(M.mat, [ix1 - mw, yArt, iz0 + mw], [ix1, yb, iz1 - mw]);
    ix0 += mw; ix1 -= mw; iz0 += mw; iz1 -= mw;
    mb.box(M.canvas, [ix0, yArt + 0.008, iz0], [ix1, yb, iz1], { skip: ["+x", "-x", "+z", "-z"] });
    paintArt(mb, M, ix0, ix1, iz0, iz1, yArt + 0.008, art, seed);
  } else {
    mb.box(M.canvas, [ix0, yArt, iz0], [ix1, yb, iz1], { skip: ["+x", "-x", "+z", "-z"] });
    paintArt(mb, M, ix0, ix1, iz0, iz1, yArt, art, seed);
  }
}

const ART_SLOTS = { frame: "metal_black", canvas: "art_cream", mat: "paint_white", art_a: "art_terracotta", art_b: "art_navy", art_c: "art_mustard", art_d: "art_sage", art_e: "art_charcoal" };

function buildWallArt(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const frame = optStr(s, "frame", FRAME_STYLES, "thin_black");
  const art = optStr(s, "art", ART_STYLES, "abstract");
  const matB = optBool(s, "mat", frame === "thin_black" || frame === "oak");
  artwork(mb, s.materials, -w / 2, w / 2, 0, h, d / 2, Math.min(d, 0.05), frame, art, matB, Math.round(optNum(s, "seed", 1)));
}

function buildGalleryWall(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const fixed = optStr(s, "frame", ["mixed", ...FRAME_STYLES] as const, "mixed");
  const seed = Math.round(optNum(s, "seed", 1));
  const T: [number, number, number, number][] = [
    [0, 0.36, 0.3, 0.64], [0.34, 0.56, 0.27, 0.44], [0.34, 0, 0.27, 0.5], [0.65, 0.4, 0.35, 0.6], [0, 0, 0.3, 0.3], [0.65, 0, 0.2, 0.34], [0.89, 0.06, 0.11, 0.24],
  ];
  const frames: FrameStyle[] = ["thin_black", "oak", "gold", "thin_black", "none", "oak", "thin_black"];
  const arts: ArtStyle[] = ["landscape", "geometric", "botanical", "abstract", "abstract", "botanical", "geometric"];
  T.forEach(([u, v, uw, vh], i) => {
    const f = fixed === "mixed" ? frames[(i + seed) % frames.length] : fixed;
    artwork(mb, s.materials, -w / 2 + u * w, -w / 2 + (u + uw) * w, v * h, (v + vh) * h, d / 2, Math.min(d, f === "none" ? 0.03 : 0.025), f, arts[(i + seed) % arts.length], f === "thin_black" || f === "oak", seed * 10 + i);
  });
}

function buildFloatingShelf(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const t = Math.min(0.04, h * 0.2);
  mb.box(M.shelf, [-w / 2, -d / 2, 0], [w / 2, d / 2, t]);
  if (optBool(s, "decor", true)) shelfDecor(mb, M, -w / 2, w / 2, -d / 2 + 0.01, d / 2 - 0.005, t, h - t, Math.round(w * 100 + d * 1000));
}

function buildWallShelves(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const decor = optBool(s, "decor", true);
  if (optStr(s, "style", ["ladder", "grid"] as const, "ladder") === "grid") {
    const t = 0.02;
    const cols = Math.max(1, Math.round(w / 0.38)), rows = Math.max(1, Math.round(h / 0.38));
    const cw = (w - t) / cols, rh = (h - t) / rows;
    mb.box(M.shelf, [-w / 2, d / 2 - 0.006, 0], [w / 2, d / 2, h]);
    for (let i = 0; i <= cols; i++) mb.box(M.shelf, [-w / 2 + i * cw, -d / 2, 0], [-w / 2 + i * cw + t, d / 2 - 0.006, h]);
    for (let j = 0; j <= rows; j++)
      for (let i = 0; i < cols; i++) mb.box(M.shelf, [-w / 2 + i * cw + t, -d / 2, j * rh], [-w / 2 + (i + 1) * cw, d / 2 - 0.006, j * rh + t]);
    if (!decor) return;
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        const x0 = -w / 2 + i * cw + t, x1 = x0 + cw - t, z = j * rh + t;
        const k = (i * 3 + j * 5) % 4;
        if (k === 3) {
          const bw = cw - t - 0.03;
          rectLathe(mb, M.basket, (x0 + x1) / 2, 0, bw, d - 0.04, 0.02, [[0, z], [0, z + rh * 0.8], [0.008, z + rh * 0.8], [0.008, z + 0.01], [bw, z + 0.01]], 2);
        } else shelfDecor(mb, M, x0, x1, -d / 2 + 0.02, d / 2 - 0.01, z, rh - t, i * 17 + j * 31 + 3);
      }
    return;
  }
  // ladder leaning against the wall
  const rs = 0.035;
  const yA = -d / 2 + rs / 2 + 0.005, yB = d / 2 - rs / 2 - 0.004;
  const yAt = (z: number) => yA + ((yB - yA) * z) / h;
  for (const sx of [-1, 1]) beam(mb, M.shelf, [sx * (w / 2 - rs / 2), yA, 0.006], [sx * (w / 2 - rs / 2), yB, h - rs * 0.6], rs, rs);
  const n = Math.max(2, Math.round(h / 0.38));
  for (let i = 0; i < n; i++) {
    const z = 0.12 + ((h - 0.25) * i) / (n - 1);
    const yf = yAt(z) - rs / 2;
    if (d / 2 - yf < 0.06) continue;
    mb.box(M.shelf, [-w / 2 + rs, yf, z], [w / 2 - rs, d / 2 - 0.004, z + 0.02]);
    const clear = i < n - 1 ? (h - 0.25) / (n - 1) - 0.03 : h - z - 0.03;
    if (decor) shelfDecor(mb, M, -w / 2 + rs, w / 2 - rs, yf + 0.005, d / 2 - 0.006, z + 0.02, clear, i * 13 + 7);
  }
}

function buildVase(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const shape = optStr(s, "shape", ["bottle", "bulb", "cylinder"] as const, "bulb");
  const stems = optStr(s, "stems", ["none", "branches", "flowers", "pampas"] as const, "branches");
  const R = (Math.min(w, d) / 2) * (stems === "none" ? 1 : 0.62);
  const bh = stems === "none" ? h : Math.min(h * 0.45, R * 4.2);
  const r = R * (shape === "cylinder" ? 0.85 : 1);
  vessel(mb, M.vase, 0, 0, 0, r, bh, shape, 18);
  if (stems === "none") return;
  const neckZ = bh * 0.9;
  const rnd = rng(Math.round(h * 1000));
  const reach = Math.min(w, d) / 2 - (stems === "pampas" ? 0.08 : stems === "flowers" ? 0.035 : 0.04);
  const n = stems === "flowers" ? 5 : stems === "pampas" ? 4 : 4;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + rnd() * 0.5;
    const out = reach * (0.35 + rnd() * 0.55);
    const top: Vec3 = [Math.cos(a) * out, Math.sin(a) * out, h - (stems === "pampas" ? 0.11 : 0.03) - rnd() * (h - bh) * 0.25];
    const base: Vec3 = [Math.cos(a) * 0.004, Math.sin(a) * 0.004, neckZ - 0.03];
    const mid: Vec3 = [top[0] * 0.35, top[1] * 0.35, (base[2] + top[2]) * 0.55];
    mb.rod(M.stems, base, mid, 0.0028, 4);
    mb.rod(M.stems, mid, top, 0.0022, 4);
    if (stems === "flowers") {
      mb.sphere(M.flowers, v3.add(top, [0, 0, 0.012]), 0.03, 10, 7, [1, 1, 0.65]);
      mb.sphere(M.stems === M.flowers ? M.vase : M.foliage, v3.add(top, [0, 0, 0.026]), 0.01, 6, 4);
      blade(mb, M.foliage, v3.lerp(base, mid, 0.7), [Math.cos(a + 0.6), Math.sin(a + 0.6), 0.5], 0.07, 0.016, { n: 3 });
    } else if (stems === "pampas") {
      const dir = v3.norm(v3.sub(top, mid));
      const x = v3.norm(v3.cross([0, 0, 1], dir));
      mb.with(m4.fromBasis(v3.len(x) > 0.1 ? x : [1, 0, 0], v3.cross(dir, v3.len(x) > 0.1 ? x : [1, 0, 0]), dir, top), () => mb.sphere(M.flowers, [0, 0, 0.05], 0.03, 8, 6, [1, 1, 2.2]));
    } else {
      // eucalyptus-like branch with paired round leaves
      for (let k = 1; k <= 5; k++) {
        const p = v3.lerp(mid, top, k / 5.3);
        for (const sd of [-1, 1]) {
          const la = a + sd * 1.3 + k;
          blade(mb, M.foliage, p, [Math.cos(la), Math.sin(la), 0.15], 0.032, 0.014, { n: 3, cup: 0.1, th: 0.002 });
        }
      }
    }
  }
}

function buildBooksStack(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const top = optStr(s, "topper", ["none", "object", "candle"] as const, "object");
  const rnd = rng(Math.round(w * 1000 + h * 100));
  const stackH = top === "none" ? h : h * 0.55;
  const n = Math.max(1, Math.round(stackH / 0.032));
  const bh = stackH / n;
  let z = 0;
  for (let i = 0; i < n; i++) {
    const bw = w * (0.86 + rnd() * 0.14) - i * 0.01, bd = d * (0.84 + rnd() * 0.16) - i * 0.006;
    const ox = (rnd() - 0.5) * (w - bw), oy = (rnd() - 0.5) * (d - bd);
    book(mb, [M.book_a, M.book_b, M.book_c][i % 3], M.pages, -bw / 2 + ox, -bd / 2 + oy, z, bw, bd, bh, true);
    z += bh;
  }
  if (top === "object") {
    const r = Math.min(h - z, Math.min(w, d) * 0.25) / 2;
    mb.sphere(M.topper, [0, 0, z + r], r, 14, 10);
  } else if (top === "candle") candle(mb, M.topper, "emissive_light", 0, 0, z, Math.min(0.035, (h - z) * 0.3), Math.max(0.02, h - z - 0.03));
}

function buildDecorBowl(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const R = Math.min(w, d) / 2;
  mb.with(m4.scaling(1, d / w > 1 ? 1 : d / w, 1), () => {
    vessel(mb, M.bowl, 0, 0, 0, w / 2, h * (optStr(s, "contents", ["none", "orbs"] as const, "none") === "orbs" ? 0.7 : 1), "bowl", 24);
  });
  if (optStr(s, "contents", ["none", "orbs"] as const, "none") === "orbs") {
    const r = Math.min(h * 0.28, R * 0.24);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU + 0.4;
      mb.sphere(i === 1 ? M.orbs_b : M.orbs, [Math.cos(a) * r * 1.05, Math.sin(a) * r * 1.05 * Math.min(1, d / w), h * 0.7 * 0.24 + r], r, 12, 8);
    }
  }
}

function buildCandleSet(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const lit = optBool(s, "lit", true);
  const tray = optBool(s, "tray", true);
  const tz = tray ? 0.015 : 0;
  if (tray) softBox(mb, M.tray, 0, 0, 0, w, d, tz, Math.min(w, d) * 0.4, 0.004);
  const r = Math.min(d * 0.32, w / 8);
  const ch = h - tz - (lit ? 0.03 : 0);
  const xs = [-w / 2 + r + 0.02, 0, w / 2 - r - 0.02];
  [1, 0.72, 0.5].forEach((k, i) => candle(mb, M.wax, lit ? M.flame : null, xs[i], (i - 1) * d * 0.08, tz, r * (1 - i * 0.08), ch * k));
}

function buildCushion(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const style = optStr(s, "style", ["plain", "piped", "tufted"] as const, "plain");
  const round = optStr(s, "shape", ["square", "round"] as const, "square") === "round";
  const T = clamp(Math.min(w, h) * 0.17, 0.04, Math.max(0.03, d * 0.45));
  const th = Math.asin(clamp((d - 2 * T) / h, 0, 0.35));
  const c = Math.cos(th), sn = Math.sin(th);
  const ph = (h - 2 * sn * T) / c;
  mb.with(m4.mul(m4.translation(0, -d / 2 + c * T, sn * T), m4.rotationX(-th)), () => {
    const pin = style === "piped" ? 0.012 : 0;
    const seam = pillow(mb, M.fabric, 0, 0, ph / 2, w - pin, ph - pin, T, round, style === "tufted", 8);
    if (style === "piped") {
      const N = 8;
      const loop: Vec3[] = [];
      for (let i = 0; i < N; i++) loop.push(seam(i, 0));
      for (let j = 0; j < N; j++) loop.push(seam(N, j));
      for (let i = N; i > 0; i--) loop.push(seam(i, N));
      for (let j = N; j > 0; j--) loop.push(seam(0, j));
      for (let i = 0; i < loop.length; i++) mb.rod(M.piping, loop[i], loop[(i + 1) % loop.length], 0.005, 5);
    }
    if (style === "tufted") for (const sy of [-1, 1]) mb.sphere(M.piping, [0, sy * T * 0.6, ph / 2], 0.012, 8, 6);
  });
}

function buildThrowBlanket(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const th = 0.012;
  if (optStr(s, "style", ["draped", "folded"] as const, "draped") === "folded") {
    // folded runner lying on top with a flap hanging over the -Y edge (bed end)
    const ft = 0.035;
    softBox(mb, M.fabric, 0, 0.012, h - ft, w, d - 0.024, ft, 0.03, 0.012);
    const drop = Math.min(h * 0.6, 0.35);
    mb.rod(M.fabric, [-w / 2 + 0.004, -d / 2 + 0.024, h - ft / 2 - 0.001], [w / 2 - 0.004, -d / 2 + 0.024, h - ft / 2 - 0.001], ft / 2 + 0.002, 10);
    softBox(mb, M.fabric, 0, -d / 2 + 0.012, h - drop, w - 0.01, 0.024, drop - ft / 2, 0.01, 0.006);
    return;
  }
  // draped over a support (sofa arm / chair back) running along Y: hangs down both sides
  const a = w / 2 - 0.025, r = Math.min(0.06, a * 0.6);
  const dropL = Math.min(h * 0.75, 0.55), dropR = Math.min(h * 0.45, 0.3);
  const path = (off: number, y: number): Vec3[] => {
    const pts: Vec3[] = [];
    const rip = (z0: number, z: number, side: number) => side * 0.016 * Math.sin((y / 0.11) * TAU + side) * clamp((z0 - z) / 0.3, 0, 1);
    for (let i = 0; i <= 4; i++) {
      const z = h - r - dropL + (dropL * i) / 4;
      pts.push([-a - off + rip(h - r, z, -1), y, z]);
    }
    for (let i = 1; i < 8; i++) {
      const t = Math.PI - (i / 8) * Math.PI;
      pts.push([Math.cos(t) * (a + off - (a - r)) * 0 + (a + off) * Math.cos(t), y, h - r + (r + off) * Math.sin(t) - off * 0]);
    }
    for (let i = 4; i >= 0; i--) {
      const z = h - r - dropR + (dropR * i) / 4;
      pts.push([a + off + rip(h - r, z, 1), y, z]);
    }
    return pts.map((p) => [clamp(p[0], -w / 2, w / 2), p[1], Math.min(p[2], h)] as Vec3);
  };
  const ny = Math.max(4, Math.round(d / 0.06));
  const ys = Array.from({ length: ny + 1 }, (_, k) => -d / 2 + 0.01 + ((d - 0.02) * k) / ny);
  const outer = ys.map((y) => path(0, y)), inner = ys.map((y) => path(-th, y));
  const n = outer[0].length;
  for (let k = 0; k < ny; k++)
    for (let i = 0; i + 1 < n; i++) {
      quadOut(mb, M.fabric, outer[k][i], outer[k][i + 1], outer[k + 1][i + 1], outer[k + 1][i], inner[k][i]);
      quadOut(mb, M.fabric, inner[k][i], inner[k][i + 1], inner[k + 1][i + 1], inner[k + 1][i], outer[k][i]);
    }
  for (let k = 0; k < ny; k++)
    for (const i of [0, n - 1]) {
      const ref = v3.add(outer[k][i], [0, 0, 0.05]);
      quadOut(mb, M.fabric, outer[k][i], inner[k][i], inner[k + 1][i], outer[k + 1][i], ref);
    }
  for (const k of [0, ny])
    for (let i = 0; i + 1 < n; i++) {
      const ref = v3.add(outer[k][i], [0, k === 0 ? 0.05 : -0.05, 0]);
      quadOut(mb, M.fabric, outer[k][i], outer[k][i + 1], inner[k][i + 1], inner[k][i], ref);
    }
}

function buildWallClock(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const R = Math.min(w, h) / 2;
  const dd = Math.min(d, 0.05);
  const rim = Math.max(0.012, R * 0.07);
  mb.with(facingFront(0, d / 2, h / 2), () => {
    tube(mb, M.frame, 0, 0, 0, dd, R, R, rim, 40, { top: true, bottom: true });
    mb.cylinder(M.face, [0, 0, 0], R - rim + 0.001, R - rim + 0.001, dd - 0.008, 40);
    const zf = dd - 0.008;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU;
      const long = i % 3 === 0;
      const r0 = (R - rim) * (long ? 0.74 : 0.82), r1 = (R - rim) * 0.92;
      beam(mb, M.hands, [Math.cos(a) * r0, Math.sin(a) * r0, zf], [Math.cos(a) * r1, Math.sin(a) * r1, zf], 0.002, long ? 0.012 : 0.006);
    }
    const hand = (a: number, len: number, wd: number, z: number) => beam(mb, M.hands, [-Math.cos(a) * len * 0.15, -Math.sin(a) * len * 0.15, zf + z], [Math.cos(a) * len, Math.sin(a) * len, zf + z], 0.002, wd);
    hand(Math.PI / 2 - (10.2 / 12) * TAU, (R - rim) * 0.5, 0.014, 0.002);
    hand(Math.PI / 2 - (10 / 60) * TAU, (R - rim) * 0.78, 0.009, 0.004);
    mb.cylinder(M.hands, [0, 0, zf], 0.012, 0.012, 0.007, 12, { bottom: false });
  });
}

function buildSculpture(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const form = optStr(s, "form", ["ring", "pebbles", "twist"] as const, "ring");
  const bz = Math.min(0.04, h * 0.1);
  softBox(mb, M.base, 0, 0, 0, w * 0.75, d * 0.75, bz, 0.005, 0.003);
  const H = h - bz;
  if (form === "ring") {
    const tr = Math.min(w, H) * 0.12;
    const R = Math.min(w / 2, H / 2) - tr;
    torus(mb, M.main, [0, 0, bz + tr + R], R, tr, "y", 28, 10);
  } else if (form === "pebbles") {
    let z = bz;
    const n = 4;
    for (let i = 0; i < n; i++) {
      const rx = Math.min(w, d) * 0.42 * (1 - i * 0.16), rz = (H / n) * 0.5;
      mb.sphere(i % 2 ? M.base : M.main, [(i % 2 ? 1 : -1) * 0.01, 0, z + rz], rx, 16, 9, [1, 0.85, rz / rx]);
      z += rz * 2;
    }
  } else {
    const n = 14;
    const lh = H / n;
    for (let i = 0; i < n; i++) {
      const sc = 1 - 0.35 * Math.abs(i / (n - 1) - 0.4);
      mb.with(m4.mul(m4.translation(0, 0, bz + i * lh), m4.rotationZ(i * 0.16)), () => softBox(mb, M.main, 0, 0, 0, Math.min(w, d) * 0.6 * sc, Math.min(w, d) * 0.3 * sc, lh, 0.01, lh * 0.2));
    }
  }
}

function buildTrayWithDecor(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const tz = 0.025;
  rectLathe(mb, M.tray, 0, 0, w, d, Math.min(0.04, d * 0.2), [[0, 0], [0, tz], [0.008, tz], [0.008, 0.008], [Math.min(w, d), 0.008]]);
  const rnd = rng(7);
  const z = 0.008;
  candle(mb, M.wax, "emissive_light", -w / 2 + 0.06, 0, z, Math.min(0.035, d * 0.15), Math.min(0.09, h - z - 0.03));
  const vr = Math.min(0.04, d * 0.17);
  vessel(mb, M.vase, w * 0.08, d * 0.12, z, vr, Math.min(h - z - 0.01, vr * 3.5), "bottle", 14);
  const top = bookPile(mb, [M.book_a, M.book_b], M.pages, w / 2 - 0.08, -d * 0.08, z, Math.min(0.14, w * 0.35), d - 0.05, 2, rnd);
  if (top + 0.05 < h) mb.sphere(M.vase, [w / 2 - 0.08, -d * 0.08, top + 0.022], 0.022, 10, 7);
}

function buildLantern(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const a = Math.min(w, d);
  const bz = 0.03, roofH = Math.min(0.08, h * 0.18), ring = Math.min(0.05, h * 0.1);
  const bodyTop = h - roofH - ring;
  mb.block(M.frame, 0, 0, 0, a, a, bz);
  const p = 0.016;
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) mb.block(M.frame, sx * (a / 2 - p / 2 - 0.006), sy * (a / 2 - p / 2 - 0.006), bz, p, p, bodyTop - bz);
  mb.block(M.frame, 0, 0, bodyTop - 0.015, a - 0.004, a - 0.004, 0.015);
  const g = a / 2 - 0.012;
  for (const sy of [-1, 1]) mb.box(M.glass, [-g, sy * g - 0.002, bz], [g, sy * g + 0.002, bodyTop - 0.015]);
  for (const sx of [-1, 1]) mb.box(M.glass, [sx * g - 0.002, -g + 0.002, bz], [sx * g + 0.002, g - 0.002, bodyTop - 0.015]);
  mb.with(m4.rotationZ(Math.PI / 4), () => mb.cylinder(M.frame, [0, 0, bodyTop], (a / 2) * Math.SQRT2, 0.02, roofH, 4));
  torus(mb, M.frame, [0, 0, h - ring / 2 - 0.004], ring / 2 - 0.004, 0.004, "y", 14, 5);
  candle(mb, M.wax, M.flame, 0, 0, bz, Math.min(0.04, a * 0.18), Math.min(0.15, (bodyTop - bz) * 0.5));
}

// ---- plants ----

type PotStyle = "round" | "cylinder" | "tapered" | "square" | "basket";
const POT_STYLES = ["round", "cylinder", "tapered", "square", "basket"] as const;

/** A planter pot with soil; returns the soil height. */
function plantPot(mb: MeshBuilder, M: Record<string, string>, style: PotStyle, r: number, ph: number) {
  const soilZ = ph - Math.min(0.03, ph * 0.1);
  if (style === "square") {
    const s = r * 1.8;
    rectLathe(mb, M.pot, 0, 0, s, s, 0.02, [[0.03, 0], [0, ph * 0.08], [0, ph], [0.018, ph], [0.018, soilZ], [s, soilZ]], 3);
  } else if (style === "basket") {
    lathe(mb, M.basket, 0, 0, [[0, 0], [r * 0.82, 0], [r * 0.95, ph * 0.1], [r, ph * 0.92], [r * 0.93, ph * 0.92], [r * 0.93, soilZ], [0, soilZ]], 20);
    torus(mb, M.basket, [0, 0, ph * 0.92], r * 0.965, Math.min(0.018, ph * 0.06), "z", 24, 6);
  } else {
    const P: Record<string, Vec2[]> = {
      round: [[0, 0], [0.55, 0], [0.8, 0.12], [1, 0.48], [0.96, 0.82], [0.86, 1], [0.8, 1]],
      cylinder: [[0, 0], [0.96, 0], [1, 0.03], [1, 1], [0.92, 1]],
      tapered: [[0, 0], [0.62, 0], [0.66, 0.04], [1, 0.95], [1.02, 1], [0.93, 1]],
    };
    const prof = P[style].map(([pr, pz]) => [pr * r, pz * ph] as Vec2);
    const lip = prof[prof.length - 1][0];
    lathe(mb, M.pot, 0, 0, [...prof, [lip, soilZ], [0, soilZ]], 24);
  }
  return soilZ;
}

type Species = "fiddle_leaf" | "monstera" | "snake_plant" | "olive_tree" | "palm";

function buildPlantLarge(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const sp = optStr(s, "species", ["fiddle_leaf", "monstera", "snake_plant", "olive_tree", "palm"] as const, "fiddle_leaf") as Species;
  const pot = optStr(s, "pot", POT_STYLES, "round") as PotStyle;
  const reach = Math.min(w, d) / 2 - 0.01;
  const ph = clamp(h * 0.24, 0.18, 0.42);
  const pr = Math.min(reach * (sp === "snake_plant" ? 0.75 : 0.55), ph * 0.85);
  const soil = plantPot(mb, M, pot, pr, ph);
  const rnd = rng(Math.round(h * 997 + w * 131));
  const top = h - 0.01;
  if (sp === "snake_plant") {
    const n = 11;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU * 2.3 + rnd();
      const rr = pr * (0.15 + 0.55 * rnd());
      const base: Vec3 = [Math.cos(a) * rr, Math.sin(a) * rr, soil - 0.01];
      const L = (top - soil) * (0.55 + 0.45 * rnd());
      const tilt = 0.08 + rnd() * 0.18;
      const dir = v3.norm([Math.cos(a) * tilt, Math.sin(a) * tilt, 1]);
      const sideA = a + Math.PI / 2 + (rnd() - 0.5) * 1.2;
      blade(mb, i % 3 === 0 ? M.foliage_alt : M.foliage, base, dir, Math.min(L, (top - soil) / dir[2]), 0.032 + rnd() * 0.012, {
        n: 6, side: [Math.cos(sideA), Math.sin(sideA), 0], cup: 0.35, th: 0.004, shape: (t) => (t < 0.08 ? 0.6 + t * 5 : t > 0.82 ? Math.max(0, (1 - t) / 0.18) : 1),
      });
    }
    return;
  }
  if (sp === "olive_tree") {
    const crownZ = soil + (top - soil) * 0.42;
    mb.rod(M.stem, [0, 0, soil - 0.02], [0.02, 0.01, crownZ], 0.022, 7);
    mb.rod(M.stem, [0.02, 0.01, crownZ], [-0.01, 0.02, crownZ + (top - crownZ) * 0.4], 0.016, 6);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU + 0.5;
      mb.rod(M.stem, [0.02, 0.01, crownZ], [Math.cos(a) * reach * 0.45, Math.sin(a) * reach * 0.45, crownZ + (top - crownZ) * 0.35], 0.009, 5);
    }
    foliage(mb, M.foliage_alt, 0, 0, crownZ, reach * 2, reach * 2, top - crownZ, 9, Math.round(h * 100), 9);
    return;
  }
  if (sp === "palm") {
    const n = 8;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + rnd() * 0.4;
      const L = Math.min(reach * (0.85 + rnd() * 0.25), (top - soil) * 0.95);
      const rise = 1.2 + rnd() * 0.5;
      const ts = rise / (2 * (rise - 0.5));
      const peak = ts <= 1 ? (rise * rise) / (4 * (rise - 0.5)) : 0.5;
      const hz = ((top - soil - 0.04) * (0.75 + 0.22 * rnd())) / peak;
      const pts: Vec3[] = [];
      for (let k = 0; k <= 6; k++) {
        const t = k / 6;
        pts.push([Math.cos(a) * L * t * 0.95, Math.sin(a) * L * t * 0.95, soil + hz * (rise * t - (rise - 0.5) * t * t)]);
      }
      for (let k = 0; k < 6; k++) mb.rod(M.stem, pts[k], pts[k + 1], 0.005 * (1 - k / 8), 4);
      for (let k = 2; k <= 6; k++) {
        const p = pts[k], q = pts[Math.min(6, k + 1)];
        const along = v3.norm(v3.sub(q, p));
        for (const sd of [-1, 1]) {
          const sdir = v3.norm(v3.cross([0, 0, 1], along));
          const ld = v3.norm(v3.add(v3.scale(sdir, sd), v3.scale(along, 0.5)));
          const ll = 0.16 * L * (1 - Math.abs(k - 3.8) / 5);
          blade(mb, M.foliage, p, [ld[0], ld[1], ld[2] - 0.25], ll, 0.018, { n: 3, droop: 0.4, cup: 0.3, th: 0.003 });
        }
      }
    }
    return;
  }
  if (sp === "monstera") {
    const n = 9;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + rnd() * 0.5;
      const elev = 0.35 + rnd() * 0.75;
      const L = (top - soil) * (0.45 + 0.4 * rnd());
      const out = reach * (0.35 + 0.35 * rnd());
      const tip: Vec3 = [Math.cos(a) * out, Math.sin(a) * out, Math.min(top - 0.12, soil + L * Math.sin(elev) + 0.1)];
      const mid: Vec3 = [tip[0] * 0.4, tip[1] * 0.4, (soil + tip[2]) * 0.5 + 0.05];
      mb.rod(M.stem, [0, 0, soil - 0.01], mid, 0.007, 5);
      mb.rod(M.stem, mid, tip, 0.006, 5);
      const ll = Math.min(0.32, (reach - out) / 1.15);
      const dir: Vec3 = [Math.cos(a) * 0.9, Math.sin(a) * 0.9, 0.25 - rnd() * 0.3];
      blade(mb, M.foliage, tip, dir, Math.max(0.12, ll), Math.max(0.1, ll) * 0.45, {
        n: 6, droop: 0.35, cup: 0.12, th: 0.004, shape: (t) => Math.sin(Math.PI * Math.pow(t, 0.6)) * (1 - 0.18 * Math.max(0, Math.sin(t * 18))),
      });
    }
    return;
  }
  // fiddle leaf fig: upright trunk with big broad leaves spiralling up
  const trunkTop = top - 0.12;
  mb.rod(M.stem, [0, 0, soil - 0.02], [0.015, 0, trunkTop], 0.016, 7);
  const z0 = soil + (top - soil) * 0.28;
  const n = 22;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const z = z0 + (trunkTop - z0) * t;
    const a = i * 2.4;
    const L = Math.min(0.26, reach - 0.02) * (1 - 0.35 * t);
    const pitch = 0.35 + 0.5 * t;
    const dir: Vec3 = [Math.cos(a) * Math.cos(pitch), Math.sin(a) * Math.cos(pitch), Math.sin(pitch)];
    const base: Vec3 = [0.015 * t + Math.cos(a) * 0.02, Math.sin(a) * 0.02, z];
    if (z + L * Math.sin(pitch) > top) continue;
    blade(mb, M.foliage, base, dir, L, L * 0.38, { n: 5, droop: 0.25, cup: 0.15, th: 0.004, shape: (tt) => Math.sin(Math.PI * Math.pow(tt, 0.72)) });
  }
}

function buildHangingPlant(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const R = Math.min(w, d) / 2;
  const pr = Math.min(R * 0.45, 0.12);
  const potZ = h * 0.38, ph = pr * 1.1;
  lathe(mb, M.pot, 0, 0, [[0, potZ], [pr * 0.4, potZ], [pr * 0.85, potZ + ph * 0.3], [pr, potZ + ph], [pr * 0.9, potZ + ph], [pr * 0.9, potZ + ph * 0.85], [0, potZ + ph * 0.85]], 18);
  // cords to a top ring
  const ringZ = h - 0.04;
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU + Math.PI / 2;
    mb.rod(M.cord, [Math.cos(a) * pr * 0.95, Math.sin(a) * pr * 0.95, potZ + ph * 0.6], [Math.cos(a) * 0.012, Math.sin(a) * 0.012, ringZ - 0.01], 0.0035, 4);
  }
  torus(mb, M.cord, [0, 0, ringZ + 0.012], 0.018, 0.004, "y", 12, 5);
  mb.rod(M.cord, [0, 0, ringZ + 0.03], [0, 0, h], 0.003, 4);
  foliage(mb, M.foliage, 0, 0, potZ + ph * 0.7, pr * 2.2, pr * 2.2, Math.min(0.14, ringZ - potZ - ph), 5, 33, 8);
  // trailing vines
  const rnd = rng(5);
  const nv = 6;
  for (let i = 0; i < nv; i++) {
    const a = (i / nv) * TAU + rnd() * 0.5;
    const len = (potZ + ph) * (0.55 + 0.4 * rnd());
    const pts: Vec3[] = [];
    for (let k = 0; k <= 6; k++) {
      const t = k / 6;
      const rr = Math.min(R - 0.03, pr * (1 + 0.6 * Math.sin(t * Math.PI * 0.7)));
      pts.push([Math.cos(a + t * 0.6) * rr, Math.sin(a + t * 0.6) * rr, potZ + ph - len * t]);
    }
    for (let k = 0; k < 6; k++) {
      mb.rod(M.foliage, pts[k], pts[k + 1], 0.0025, 3);
      const la = a + k;
      blade(mb, M.foliage, pts[k + 1], [Math.cos(la), Math.sin(la), -0.3], 0.045, 0.02, { n: 2, cup: 0.15, th: 0.003 });
    }
  }
}

// ---- mirrors ----

/** Framed panel with arbitrary convex outline in the XZ plane (CCW seen from the front), back at yb. */
function framedPanel(mb: MeshBuilder, fmat: string, pmat: string, outline: Vec2[], fw: number, yb: number, depth: number) {
  const inner = offsetPolygon(outline, -fw);
  const yf = yb - depth, yp = yf + Math.min(0.008, depth * 0.4);
  const P = (p: Vec2, y: number): Vec3 => [p[0], y, p[1]];
  let cx = 0, cz = 0;
  for (const p of outline) { cx += p[0] / outline.length; cz += p[1] / outline.length; }
  const n = outline.length;
  mb.polygon(fmat, outline.map((p) => P(p, yf)), [0, -1, 0], [inner.map((p) => P(p, yf))]);
  mb.polygon(fmat, outline.map((p) => P(p, yb)), [0, 1, 0]);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    quadOut(mb, fmat, P(outline[i], yf), P(outline[j], yf), P(outline[j], yb), P(outline[i], yb), [cx, (yf + yb) / 2, cz]);
    const a = P(inner[i], yf), b = P(inner[j], yf);
    const m: Vec3 = [(a[0] + b[0]) / 2, yf, (a[2] + b[2]) / 2];
    quadOut(mb, fmat, a, b, P(inner[j], yp), P(inner[i], yp), [2 * m[0] - cx, yf, 2 * m[2] - cz]);
  }
  mb.polygon(pmat, inner.map((p) => P(p, yp)), [0, -1, 0]);
}

function mirrorOutline(shape: "round" | "arched" | "rect", w: number, h: number, z0 = 0): Vec2[] {
  if (shape === "round") return ellipse(0, z0 + h / 2, w / 2, h / 2, 48);
  if (shape === "rect") return roundRect(0, z0 + h / 2, w, h, Math.min(w, h) * 0.04, 3);
  const r = w / 2, zs = z0 + Math.max(0.01, h - r);
  const pts: Vec2[] = [[-w / 2, z0], [w / 2, z0]];
  const arcR = Math.min(r, h - 0.01);
  for (let i = 0; i <= 20; i++) {
    const a = (i / 20) * Math.PI;
    pts.push([Math.cos(a) * r, zs + Math.sin(a) * arcR]);
  }
  return pts;
}

function buildShapedMirror(mb: MeshBuilder, s: FurnitureSpec, shape: "round" | "arched" | "rect") {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const fw = clamp(optNum(s, "frame_width", Math.min(w, h) * 0.04), 0.005, Math.min(w, h) * 0.2);
  const lean = shape === "rect" && optBool(s, "lean", true);
  const t = Math.min(0.035, d);
  if (!lean) {
    framedPanel(mb, M.frame, M.mirror, mirrorOutline(shape, w, h), fw, d / 2, t);
    return;
  }
  // leaning full-length mirror: bottom edge on the floor at the front, top touching the wall at +Y
  let th = 0.05;
  for (let it = 0; it < 30; it++) {
    const c = Math.cos(th), sn = Math.sin(th);
    const L = (h - sn * t) / c;
    const f = c * t + sn * L - (d - 0.002);
    th -= f / (L * c + 0.01);
    th = clamp(th, 0, 0.35);
  }
  const c = Math.cos(th), sn = Math.sin(th);
  const L = (h - sn * t) / c;
  mb.with(m4.mul(m4.translation(0, -d / 2, sn * t), m4.rotationX(-th)), () => framedPanel(mb, M.frame, M.mirror, mirrorOutline("rect", w, L), fw, t, t));
}

// ---- living / dining / bedroom furniture ----

function buildConsoleTable(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const t = 0.028, f = 0.02;
  mb.box(M.top, [-w / 2, -d / 2, h - t], [w / 2, d / 2, h]);
  const lx = w / 2 - 0.03, ly = d / 2 - 0.025;
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) mb.block(M.frame, sx * (lx - f / 2), sy * (ly - f / 2), 0, f, f, h - t, { skip: ["+z"] });
  const rim = (z: number) => {
    for (const sy of [-1, 1]) mb.box(M.frame, [-lx + f, sy * (ly - f / 2) - f / 2, z], [lx - f, sy * (ly - f / 2) + f / 2, z + f]);
    for (const sx of [-1, 1]) mb.box(M.frame, [sx * (lx - f / 2) - f / 2, -ly + f, z], [sx * (lx - f / 2) + f / 2, ly - f, z + f]);
  };
  rim(h - t - f);
  if (optBool(s, "shelf", true)) {
    const zs = Math.min(0.15, h * 0.2);
    rim(zs);
    mb.box(M.shelf, [-lx + f, -ly + f, zs + f], [lx - f, ly - f, zs + f + 0.015]);
  }
}

function buildSideboard(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const legH = clamp(h * 0.22, 0.08, 0.22);
  const t = 0.025;
  const fluted = optStr(s, "fronts", ["fluted", "plain"] as const, "fluted") === "fluted";
  const yFace = -d / 2 + FRONT;
  mb.box(M.body, [-w / 2, -d / 2, h - t], [w / 2, d / 2, h]);
  mb.box(M.body, [-w / 2 + 0.01, yFace, legH], [w / 2 - 0.01, d / 2 - 0.005, h - t], { skip: ["+z"] });
  for (const sx of [-1, 1])
    for (const sy of [-1, 1]) mb.rod(M.legs, [sx * (w / 2 - 0.1), sy * (d / 2 - 0.09), legH + 0.005], [sx * (w / 2 - 0.065), sy * (d / 2 - 0.06), 0.012], 0.018, 8);
  const n = Math.round(optNum(s, "doors", clamp(Math.round(w / 0.45), 2, 6), 1, 8));
  const dw = (w - 0.02) / n;
  for (let i = 0; i < n; i++) {
    const x0 = -w / 2 + 0.01 + i * dw, x1 = x0 + dw;
    front(mb, M.body, M.handles, x0, x1, legH, h - t, yFace, fluted ? "none" : "knob", i % 2 ? x0 + 0.04 : x1 - 0.04, (legH + h - t) / 2 + 0.05);
    if (fluted) {
      const r = 0.0075, pitch = 0.022;
      const k = Math.floor((x1 - x0 - 0.02) / pitch);
      const off = (x1 - x0 - (k - 1) * pitch) / 2;
      for (let j = 0; j < k; j++) mb.rod(M.body, [x0 + off + j * pitch, yFace - FT, legH + 0.012], [x0 + off + j * pitch, yFace - FT, h - t - 0.012], r, 6);
      const hx = i % 2 ? x0 + off : x1 - off;
      mb.rod(M.handles, [hx, yFace - FT, (legH + h - t) / 2], [hx, yFace - FT - HP + 0.009, (legH + h - t) / 2], 0.004, 6);
      mb.sphere(M.handles, [hx, yFace - FT - HP + 0.009, (legH + h - t) / 2], 0.009, 8, 6);
    }
  }
}

function buildBarCart(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const r = 0.011;
  const wr = Math.min(0.11, h * 0.14);
  const px0 = -w / 2 + 2 * wr * 0.0 + 0.05, px1 = w / 2 - 0.03;
  const py = d / 2 - 0.045;
  const shelves = [Math.max(wr * 1.6, 0.18), h * 0.68];
  for (const x of [px0, px1])
    for (const sy of [-1, 1]) {
      const top = x === px0 ? h - r : shelves[1] + 0.06;
      mb.cylinder(M.frame, [x, sy * py, x === px1 ? 0.02 : wr], r, r, top - (x === px1 ? 0.02 : wr), 8);
    }
  mb.rod(M.frame, [px0, -py, h - r], [px0, py, h - r], r, 8);
  for (const z of shelves) {
    mb.box(M.shelves, [px0 + r, -py + r, z], [px1 - r, py - r, z + 0.012]);
    for (const sy of [-1, 1]) mb.rod(M.frame, [px0, sy * py, z + 0.04], [px1, sy * py, z + 0.04], 0.006, 6);
    for (const x of [px0, px1]) mb.rod(M.frame, [x, -py, z + 0.04], [x, py, z + 0.04], 0.006, 6);
    for (const sy of [-1, 1]) mb.rod(M.frame, [px0, sy * py, z], [px1, sy * py, z], r * 0.8, 6);
  }
  // wheels on the handle end
  const wx = -w / 2 + wr + 0.004;
  for (const sy of [-1, 1]) mb.rod(M.wheels, [wx, sy * (d / 2 - 0.027), wr], [wx, sy * (d / 2 - 0.004), wr], wr, 18);
  mb.rod(M.frame, [wx, -(d / 2 - 0.027), wr], [wx, d / 2 - 0.027, wr], 0.006, 6);
  for (const sy of [-1, 1]) mb.cylinder(M.frame, [px1, sy * py, 0], 0.018, 0.014, 0.02, 8);
  // bottles and glasses
  const zt = shelves[1] + 0.012;
  const bh = Math.min(0.3, h - zt - 0.01);
  vessel(mb, M.bottles, px0 + 0.12, -0.04, zt, 0.04, bh, "bottle", 12);
  vessel(mb, M.bottles_b, px0 + 0.22, 0.06, zt, 0.035, bh * 0.85, "bottle", 12);
  vessel(mb, M.bottles, px0 + 0.3, -0.07, zt, 0.032, bh * 0.75, "bulb", 12);
  for (let i = 0; i < 3; i++) vessel(mb, M.shelves, px1 - 0.08 - i * 0.07, 0.07 - i * 0.02, zt, 0.03, 0.09, "jar", 12);
  vessel(mb, M.frame, px1 - 0.13, -0.08, zt, 0.06, 0.12, "cylinder", 14);
  const zb = shelves[0] + 0.012;
  vessel(mb, M.bottles_b, px0 + 0.14, 0, zb, 0.045, Math.min(0.3, shelves[1] - zb - 0.03), "bottle", 12);
  bookPile(mb, [M.book_a, M.book_b], M.pages, px1 - 0.16, 0, zb, 0.24, d - 0.1, 2, rng(3));
}

function buildLoungeChair(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  // swivel 5-star base
  const R = Math.min(w, d) / 2 - 0.05;
  const hub = 0.16;
  mb.cylinder(M.base, [0, 0, 0.05], 0.05, 0.04, hub - 0.05, 12);
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (i / 5) * TAU;
    beam(mb, M.base, [Math.cos(a) * 0.03, Math.sin(a) * 0.03, 0.1], [Math.cos(a) * R, Math.sin(a) * R, 0.035], 0.04, 0.025);
    mb.cylinder(M.base, [Math.cos(a) * R, Math.sin(a) * R, 0], 0.018, 0.018, 0.035, 8);
  }
  mb.cylinder(M.base, [0, 0, hub], 0.03, 0.03, 0.12, 10);
  const seatZ = hub + 0.12;
  const sw = w * 0.74, sd = d * 0.62;
  const sy = -d / 2 + sd / 2 + 0.02;
  // seat shell + cushion (slightly tilted back)
  mb.with(m4.mul(m4.translation(0, sy, seatZ), m4.rotationX(-0.12)), () => {
    softBox(mb, M.shell, 0, 0, 0, sw, sd, 0.025, 0.08, 0.008);
    softBox(mb, M.cushions, 0, 0, 0.025, sw - 0.04, sd - 0.03, 0.1, 0.07, 0.035);
  });
  // back shells (lower back + headrest) reclined
  const lean = 0.42;
  const yb0 = sy + sd / 2 - 0.06;
  const L = Math.min((h - seatZ - 0.07 - 0.1 * Math.sin(lean)) / (0.98 * Math.cos(lean)), (d / 2 - yb0 - 0.12) / Math.sin(lean) + 0.12);
  mb.with(m4.mul(m4.translation(0, yb0, seatZ + 0.06), m4.rotationX(-lean)), () => {
    softBox(mb, M.shell, 0, 0.06, 0, sw * 0.95, 0.025, L * 0.62, 0.08, 0.008);
    softBox(mb, M.cushions, 0, 0.0, 0.04, sw * 0.9, 0.1, L * 0.55, 0.07, 0.035);
    softBox(mb, M.shell, 0, 0.06, L * 0.66, sw * 0.8, 0.025, L * 0.34, 0.08, 0.008);
    softBox(mb, M.cushions, 0, 0.0, L * 0.68, sw * 0.75, 0.1, L * 0.3, 0.07, 0.035);
    mb.box(M.base, [-0.02, 0.07, L * 0.5], [0.02, 0.09, L * 0.75]);
  });
  // armrests
  for (const sx of [-1, 1]) {
    const ax = sx * (w / 2 - 0.06);
    mb.box(M.base, [ax - 0.01, sy - 0.05, seatZ], [ax + 0.01, sy + sd / 2 - 0.05, seatZ + 0.2]);
    softBox(mb, M.cushions, ax, sy + 0.02, seatZ + 0.2, 0.09, sd * 0.75, 0.05, 0.03, 0.015);
  }
}

function buildWingbackChair(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const legH = 0.12;
  const armW = clamp(w * 0.14, 0.09, 0.15);
  const backD = 0.16;
  const seatTop = 0.46;
  const armTop = 0.66;
  for (const sx of [-1, 1])
    for (const sy of [-1, 1]) mb.cylinder(M.legs, [sx * (w / 2 - 0.06), sy * (d / 2 - 0.06), 0], 0.018, 0.026, legH + 0.01, 10, { top: false });
  softBox(mb, M.body, 0, -backD / 2 + 0.01, legH, w - 2 * armW + 0.04, d - backD + 0.02, 0.27, 0.02, 0.015);
  softBox(mb, M.body, 0, -backD / 2, legH + 0.27, w - 2 * armW, d - backD - 0.01, seatTop - legH - 0.27, 0.05, 0.03);
  // back
  softBox(mb, M.body, 0, d / 2 - backD / 2, legH, w - 2 * armW + 0.04, backD, h - legH, 0.06, 0.04);
  // rolled arms
  for (const sx of [-1, 1]) {
    const ax = sx * (w / 2 - armW / 2);
    softBox(mb, M.body, ax, -0.01, legH, armW, d - 0.02, armTop - legH - 0.04, 0.03, 0.02);
    mb.rod(M.body, [ax, -d / 2 + armW / 2, armTop - armW / 2], [ax, d / 2 - backD, armTop - armW / 2], armW / 2 - 0.002, 12);
    // wing: profile in (y, z) extruded across the arm width
    const yB = d / 2 - backD + 0.04, yF = d / 2 - backD - Math.min(0.3, d * 0.3);
    const wing: Vec2[] = [[yB, armTop - 0.06], [yB, h - 0.07], [yB - 0.06, h - 0.05], [yF + 0.07, h - 0.16], [yF, h - 0.27], [yF + 0.02, armTop + 0.04], [yF + 0.12, armTop - 0.04]];
    const x0 = sx > 0 ? w / 2 - armW + 0.01 : -w / 2 + 0.01;
    mb.with(m4.fromBasis([0, 1, 0], [0, 0, 1], [1, 0, 0], [x0, 0, 0]), () => mb.prism(M.body, wing, 0, armW - 0.03));
  }
}

function buildAccentChair(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const R = w / 2 - 0.005;
  const seatZ = clamp(h * 0.5, 0.36, 0.45);
  mb.with(m4.scaling(1, d / w, 1), () => {
    // plinth + upholstered base
    mb.cylinder(M.legs, [0, 0, 0], R * 0.7, R * 0.7, 0.03, 24);
    mb.cylinder(M.body, [0, 0, 0.03], R * 0.86, R * 0.92, seatZ - 0.12 - 0.03, 28);
    // seat cushion
    softBox(mb, M.body, 0, -0.04, seatZ - 0.12, R * 1.55, R * 1.5, 0.12, R * 0.7, 0.04);
    // curved backrest wrapping around +Y
    const span = (125 * Math.PI) / 180;
    const N = 18;
    const tb = Math.min(0.13, R * 0.35);
    const armZ = seatZ + 0.17;
    const sec = (k: number): Vec3[] => {
      const t = k / N;
      const a = Math.PI / 2 - span + 2 * span * t;
      const ht = armZ + (h - armZ) * Math.pow(Math.sin(Math.PI * t), 0.8);
      const c = Math.cos(a), sn = Math.sin(a);
      const ro = R, ri = R - tb, rb = 0.035;
      const z0 = 0.03;
      return [
        [c * ro, sn * ro, z0],
        [c * ro, sn * ro, ht - rb],
        [c * (ro - rb * 0.4), sn * (ro - rb * 0.4), ht - rb * 0.2],
        [c * (ro - tb / 2), sn * (ro - tb / 2), ht],
        [c * (ri + rb * 0.4), sn * (ri + rb * 0.4), ht - rb * 0.2],
        [c * ri, sn * ri, ht - rb],
        [c * ri, sn * ri, seatZ - 0.04],
      ];
    };
    const secs = Array.from({ length: N + 1 }, (_, k) => sec(k));
    for (let k = 0; k < N; k++) {
      const A = secs[k], B = secs[k + 1];
      const ref: Vec3 = [0, 0, 0];
      for (const p of [...A, ...B]) { ref[0] += p[0] / 14; ref[1] += p[1] / 14; ref[2] += p[2] / 14; }
      for (let i = 0; i < 7; i++) quadOut(mb, M.body, A[i], A[(i + 1) % 7], B[(i + 1) % 7], B[i], ref);
    }
    for (const k of [0, N]) {
      const S = secs[k];
      const tdir = v3.norm(v3.sub(secs[k === 0 ? 1 : N - 1][0], S[0]));
      mb.polygon(M.body, S, v3.scale(tdir, -1));
    }
  });
}

function buildOttoman(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const style = optStr(s, "style", ["pouf", "round", "square"] as const, "pouf");
  if (style === "pouf") {
    mb.with(m4.scaling(1, d / w, 1), () => {
      const R = w / 2;
      lathe(mb, M.fabric, 0, 0, [[0, 0], [R * 0.78, 0], [R * 0.95, h * 0.15], [R, h * 0.5], [R * 0.95, h * 0.85], [R * 0.75, h], [R * 0.2, h], [0, h - 0.02]], 24);
    });
    return;
  }
  if (style === "round") {
    const legH = 0.08;
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + (i / 4) * TAU;
      mb.rod(M.legs, [Math.cos(a) * w * 0.28, Math.sin(a) * d * 0.28, legH + 0.01], [Math.cos(a) * w * 0.36, Math.sin(a) * d * 0.36, 0.007], 0.014, 8);
    }
    softBox(mb, M.fabric, 0, 0, legH, w, d, h - legH, Math.min(w, d) / 2, 0.035);
    mb.sphere(M.legs, [0, 0, h - 0.014], 0.01, 8, 5);
    return;
  }
  const legH = 0.1;
  legs4(mb, M.legs, w, d, 0.03, 0.035, 0, legH + 0.01, true, 0.7);
  softBox(mb, M.fabric, 0, 0, legH, w, d, h - legH, 0.03, 0.03);
}

function buildDaybed(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const legH = 0.12, baseTop = 0.32, armW = 0.1, backD = 0.12;
  const armTop = Math.min(h - 0.1, 0.62);
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) mb.cylinder(M.legs, [sx * (w / 2 - 0.05), sy * (d / 2 - 0.05), 0], 0.016, 0.024, legH + 0.01, 10, { top: false });
  softBox(mb, M.frame, 0, -backD / 2, legH, w - 2 * armW + 0.04, d - backD, baseTop - legH, 0.02, 0.015);
  softBox(mb, M.frame, 0, d / 2 - backD / 2, legH, w, backD, h - legH, 0.04, 0.03);
  for (const sx of [-1, 1]) {
    softBox(mb, M.frame, sx * (w / 2 - armW / 2), -0.0, legH, armW, d, armTop - legH - 0.03, 0.03, 0.02);
    mb.rod(M.frame, [sx * (w / 2 - armW / 2), -d / 2 + armW / 2, armTop - armW / 2], [sx * (w / 2 - armW / 2), d / 2 - backD, armTop - armW / 2], armW / 2 - 0.002, 12);
  }
  const iw = w - 2 * armW;
  softBox(mb, M.mattress, 0, -backD / 2 + 0.005, baseTop, iw - 0.01, d - backD - 0.02, 0.14, 0.05, 0.03);
  const zt = baseTop + 0.14;
  // bolsters along the arms + pillows against the back
  const br = Math.min(0.1, (h - zt) * 0.4);
  for (const sx of [-1, 1]) mb.rod(M.pillows, [sx * (iw / 2 - br), -d / 2 + 0.06, zt + br - 0.01], [sx * (iw / 2 - br), d / 2 - backD - 0.04, zt + br - 0.01], br, 14);
  const np = Math.max(1, Math.round((iw - 4 * br) / 0.55));
  const pw = (iw - 4 * br) / np;
  for (let i = 0; i < np; i++) {
    const cx = -iw / 2 + 2 * br + pw * (i + 0.5);
    const ph = Math.min(0.45, (h - zt - 0.03) / Math.cos(0.25) - 0.03);
    mb.with(m4.mul(m4.translation(cx, d / 2 - backD - 0.06, zt - 0.01), m4.rotationX(-0.25)), () => pillow(mb, i % 2 ? M.pillows : M.cushions, 0, 0, ph / 2, Math.min(0.5, pw - 0.03), ph, 0.06));
  }
}

function buildPlatformBed(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const ns = optBool(s, "nightstands", false);
  const nsW = ns ? Math.min(0.5, (w - 1.0) / 2) : 0;
  const bw = w - 2 * nsW;
  const hbT = 0.08;
  const platTop = 0.26;
  // recessed plinth makes the platform float
  mb.box(M.frame, [-bw / 2 + 0.12, -d / 2 + 0.15, 0], [bw / 2 - 0.12, d / 2 - hbT - 0.1, 0.08], { skip: ["+z"] });
  softBox(mb, M.frame, 0, -hbT / 2, 0.08, bw, d - hbT, platTop - 0.08, 0.015, 0.008);
  // low wide headboard (full width, panel)
  softBox(mb, M.headboard, 0, d / 2 - hbT / 2, 0.08, w, hbT, h - 0.08, 0.02, 0.015, false);
  if (ns)
    for (const sx of [-1, 1]) {
      const cx = sx * (w / 2 - nsW / 2);
      mb.box(M.frame, [cx - nsW / 2 + 0.01, d / 2 - hbT - 0.38, 0.36], [cx + nsW / 2 - 0.01, d / 2 - hbT, 0.52]);
      mb.box(M.handles, [cx - 0.08, d / 2 - hbT - 0.383, 0.43], [cx + 0.08, d / 2 - hbT - 0.38, 0.445]);
    }
  mattressSet(mb, M, -bw / 2 + 0.06, bw / 2 - 0.06, -d / 2 + 0.06, d / 2 - hbT - 0.02, platTop, Math.min(0.24, h * 0.3));
}

function buildCanopyBed(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const P = 0.05;
  const px = w / 2 - P / 2, py = d / 2 - P / 2;
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) mb.block(M.frame, sx * px, sy * py, 0, P, P, h);
  for (const sy of [-1, 1]) mb.box(M.frame, [-px + P / 2, sy * py - 0.015, h - 0.05], [px - P / 2, sy * py + 0.015, h]);
  for (const sx of [-1, 1]) mb.box(M.frame, [sx * px - 0.015, -py + P / 2, h - 0.05], [sx * px + 0.015, py - P / 2, h]);
  // bed frame + headboard between the back posts
  mb.box(M.frame, [-px + P / 2, -py + P / 2, 0.18], [px - P / 2, py - P / 2, 0.3]);
  softBox(mb, M.headboard, 0, py - 0.03, 0.3, w - 2 * P, 0.05, Math.min(1.25, h * 0.55), 0.02, 0.012, false);
  mattressSet(mb, M, -px + P / 2, px - P / 2, -py + P / 2, py - 0.06, 0.3, 0.24);
  if (optBool(s, "drapes", true)) {
    const R = Math.min(0.09, P * 1.8);
    for (const sx of [-1, 1])
      for (const sy of [-1, 1]) {
        const cx = sx * (px - R + P / 2 - 0.002) * 1, cy = sy * (py - R + P / 2 - 0.002);
        lathe(mb, M.drapes, cx - sx * 0.0, cy, [[0, 0.01], [R * 0.9, 0.01], [R, 0.3], [R * 0.75, h * 0.42], [R * 0.4, h * 0.5], [R * 0.75, h * 0.6], [R * 0.85, h - 0.06], [0, h - 0.06]], 10);
      }
  }
}

function buildDiningBench(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const cushion = optBool(s, "cushion", false);
  const t = 0.04;
  const top = cushion ? h - 0.05 : h;
  mb.box(M.top, [-w / 2, -d / 2, top - t], [w / 2, d / 2, top]);
  if (cushion) softBox(mb, M.cushion, 0, 0, top, w - 0.02, d - 0.02, h - top, 0.03, 0.02);
  for (const sx of [-1, 1])
    for (const sy of [-1, 1]) mb.rod(M.legs, [sx * (w / 2 - 0.12), sy * (d / 2 - 0.08), top - t + 0.005], [sx * (w / 2 - 0.05), sy * (d / 2 - 0.03), 0.004], 0.02, 8);
  for (const sx of [-1, 1]) mb.rod(M.legs, [sx * (w / 2 - 0.085), -(d / 2 - 0.055), top * 0.35], [sx * (w / 2 - 0.085), d / 2 - 0.055, top * 0.35], 0.012, 6);
  mb.rod(M.legs, [-(w / 2 - 0.085), 0, top * 0.35], [w / 2 - 0.085, 0, top * 0.35], 0.012, 6);
}

function buildRoundDiningTable(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const t = 0.03;
  ecyl(mb, M.top, 0, 0, h - t, w / 2, d / 2, t, 40);
  const m = Math.min(w, d);
  if (optStr(s, "base", ["tulip", "pedestal"] as const, "tulip") === "tulip") {
    const rb = m * 0.28;
    lathe(mb, M.base, 0, 0, [[0, 0], [rb, 0], [rb, 0.012], [rb * 0.82, 0.03], [rb * 0.45, 0.08], [rb * 0.2, 0.18], [0.045, 0.36], [0.042, h - t - 0.1], [0.07, h - t - 0.03], [0.16, h - t], [0, h - t]], 24);
    return;
  }
  const rc = 0.06;
  mb.cylinder(M.base, [0, 0, 0.04], rc, rc * 0.9, h - t - 0.1, 14, { bottom: false });
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i / 4) * TAU;
    beam(mb, M.base, [0, 0, 0.025], [Math.cos(a) * m * 0.32, Math.sin(a) * m * 0.32, 0.025], 0.07, 0.05);
  }
  mb.box(M.base, [-0.08, -0.08, 0], [0.08, 0.08, 0.05]);
  mb.cylinder(M.base, [0, 0, h - t - 0.06], rc * 0.9, rc * 2.2, 0.06, 14, { bottom: false });
}

function buildDressingTable(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const topZ = Math.min(0.76, h * 0.55);
  const t = 0.025;
  mb.box(M.body, [-w / 2, -d / 2, topZ - t], [w / 2, d / 2, topZ]);
  const ap = 0.12;
  const yFace = -d / 2 + 0.02 + FT + HP * 0.5;
  mb.box(M.body, [-w / 2 + 0.03, yFace, topZ - t - ap], [w / 2 - 0.03, d / 2 - 0.03, topZ - t], { skip: ["+z"] });
  front(mb, M.body, M.handles, -w * 0.3, w * 0.3, topZ - t - ap, topZ - t, yFace, "knob");
  for (const sx of [-1, 1])
    for (const sy of [-1, 1]) mb.cylinder(M.body, [sx * (w / 2 - 0.05), sy * (d / 2 - 0.05), 0], 0.014, 0.022, topZ - t - 0.005, 10, { top: false });
  // mirror on two uprights at the back
  const shape = optStr(s, "mirror", ["round", "arched", "rect"] as const, "round");
  const mh = h - topZ - 0.03, mw = Math.min(w * 0.7, shape === "round" ? mh : mh * 0.75);
  const yb = d / 2 - 0.035;
  for (const sx of [-1, 1]) mb.box(M.body, [sx * (mw / 2 + 0.02) - 0.015, yb, topZ], [sx * (mw / 2 + 0.02) + 0.015, yb + 0.03, topZ + mh * 0.6]);
  mb.with(m4.translation(0, 0, topZ + 0.03), () => framedPanel(mb, M.body, M.mirror, mirrorOutline(shape, mw, mh), Math.min(0.035, mw * 0.06), yb + 0.03, 0.025));
  // a couple of things on top
  vessel(mb, M.vase, -w / 2 + 0.1, 0, topZ, 0.035, 0.12, "bottle", 12);
  bookPile(mb, [M.handles, M.body], "paper_white", w / 2 - 0.15, -0.03, topZ, 0.18, Math.min(0.14, d - 0.12), 2, rng(9));
}

function buildFilingCabinet(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const base = 0.04;
  const yFace = -d / 2 + FRONT;
  mb.box(M.body, [-w / 2 + 0.02, yFace + 0.02, 0], [w / 2 - 0.02, d / 2 - 0.01, base], { skip: ["+z"] });
  mb.box(M.body, [-w / 2, yFace, base], [w / 2, d / 2, h]);
  const n = Math.round(optNum(s, "drawers", clamp(Math.round((h - base) / 0.32), 1, 5), 1, 6));
  const dh = (h - base) / n;
  for (let i = 0; i < n; i++) {
    const z0 = base + i * dh, z1 = z0 + dh;
    front(mb, M.body, M.handles, -w / 2, w / 2, z0, z1, yFace, "bar_h", 0, z1 - dh * 0.32, Math.min(0.16, w * 0.4));
    mb.box(M.handles, [-0.04, yFace - FT - 0.003, z1 - dh * 0.2], [0.04, yFace - FT, z1 - dh * 0.2 + 0.025], { skip: ["+y"] });
  }
}

function buildCrib(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const P = 0.045;
  const px = w / 2 - P / 2, py = d / 2 - P / 2;
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) mb.block(M.frame, sx * px, sy * py, 0, P, P, h);
  const mz = clamp(h * 0.32, 0.15, 0.4);
  const railLo = mz - 0.06;
  // long sides: rails + slats
  for (const sy of [-1, 1]) {
    for (const z of [railLo, h - 0.05]) mb.box(M.frame, [-px + P / 2, sy * py - 0.015, z], [px - P / 2, sy * py + 0.015, z + 0.045]);
    const n = Math.floor((w - 2 * P) / 0.065);
    for (let i = 0; i < n; i++) {
      const x = -px + P / 2 + ((w - 2 * P) * (i + 0.5)) / n;
      mb.box(M.frame, [x - 0.012, sy * py - 0.011, railLo + 0.045], [x + 0.012, sy * py + 0.011, h - 0.05]);
    }
  }
  // solid end panels with a curved top
  for (const sx of [-1, 1]) {
    const prof: Vec2[] = [[-py + P / 2, railLo], [py - P / 2, railLo], [py - P / 2, h - 0.08]];
    for (let i = 1; i < 10; i++) {
      const t = i / 10;
      prof.push([py - P / 2 - t * (2 * py - P), h - 0.08 + 0.05 * Math.sin(Math.PI * t)]);
    }
    prof.push([-py + P / 2, h - 0.08]);
    mb.with(m4.fromBasis([0, 1, 0], [0, 0, 1], [1, 0, 0], [sx * px - 0.01, 0, 0]), () => mb.prism(M.frame, prof, 0, 0.02));
  }
  mb.box(M.frame, [-px + P / 2, -py + P / 2, mz - 0.04], [px - P / 2, py - P / 2, mz - 0.02]);
  softBox(mb, M.mattress, 0, 0, mz - 0.02, w - 2 * P - 0.01, d - 2 * P - 0.01, 0.1, 0.03, 0.02);
  softBox(mb, M.blanket, -w * 0.12, 0, mz + 0.08, w * 0.45, d - 2 * P - 0.03, 0.03, 0.04, 0.012);
}

function buildToyBox(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const open = optBool(s, "open", true);
  const lt = 0.025;
  const lidAng = open ? (70 * Math.PI) / 180 : 0;
  const bh = open ? Math.max(0.2, h - d * Math.sin(lidAng) - 0.01) : h - lt;
  const wall = 0.018;
  const bw = w - 0.006;
  rectLathe(mb, M.box, 0, 0, bw, d - 0.006, 0.015, [[0, 0], [0, bh], [wall, bh], [wall, bh * 0.35], [Math.min(bw, d), bh * 0.35]], 2);
  for (const sx of [-1, 1]) mb.box(M.accent, [sx > 0 ? bw / 2 - 0.002 : -w / 2, -0.06, bh * 0.6], [sx > 0 ? w / 2 : -bw / 2 + 0.002, 0.06, bh * 0.68]);
  const hy = d / 2 - lt * Math.sin(lidAng) - 0.003;
  mb.with(m4.mul(m4.translation(0, hy, bh), m4.rotationX(-lidAng)), () => mb.box(M.box, [-w / 2, -(d - 0.006), 0], [w / 2, 0, lt]));
  if (!open) return;
  // toys peeking out
  const tz = bh * 0.35;
  const room = bh - tz;
  mb.sphere(M.toy_a, [-w * 0.22, -d * 0.05, tz + Math.min(0.1, room * 0.7)], Math.min(0.1, room * 0.7, d / 2 - wall - 0.01), 14, 10);
  for (let i = 0; i < 4; i++) {
    const c = Math.min(0.07, room * 0.45);
    const x = w * 0.05 + (i % 2) * c * 1.15, y = -d * 0.15 + Math.floor(i / 2) * c * 1.2;
    mb.with(m4.mul(m4.translation(x, y, tz + (i === 3 ? c : 0) + c / 2), m4.rotationZ(i * 0.4)), () => mb.block([M.toy_b, M.toy_c, M.toy_a, M.toy_b][i], 0, 0, -c / 2, c, c, c));
  }
  mb.sphere(M.toy_c, [w * 0.32, d * 0.12, tz + room * 0.55], Math.min(0.07, room * 0.5), 12, 8);
}

function buildKidsBed(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const P = 0.045;
  const px = w / 2 - P / 2, py = d / 2 - P / 2;
  const roofRise = Math.min(w * 0.42, h * 0.35);
  const wallH = h - roofRise;
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) mb.block(M.frame, sx * px, sy * py, 0, P, P, wallH);
  // gables (front & back) + ridge
  for (const sy of [-1, 1]) {
    for (const sx of [-1, 1]) beam(mb, M.frame, [sx * px, sy * py, wallH - 0.02], [0, sy * py, h - P * 0.7], P, P);
  }
  mb.box(M.frame, [-P / 2, -py - P / 2, h - P], [P / 2, py + P / 2, h]);
  for (const sx of [-1, 1]) mb.box(M.frame, [sx * px - P / 2, -py + P / 2, wallH - P], [sx * px + P / 2, py - P / 2, wallH]);
  // low frame + rails + mattress
  mb.box(M.frame, [-px + P / 2, -py + P / 2, 0.08], [px - P / 2, py - P / 2, 0.16]);
  for (const sy of [-1, 1]) mb.box(M.frame, [-px + P / 2, sy * py - 0.012, 0.16], [px - P / 2, sy * py + 0.012, 0.36]);
  mattressSet(mb, M, -px + P / 2, px - P / 2, -py + P / 2, py - P / 2, 0.16, 0.13);
}

// ---- bathroom ----

function buildTowelRail(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const r = 0.013;
  const yr = d / 2 - Math.min(0.06, d * 0.5);
  const xs = w / 2 - r - 0.005;
  for (const sx of [-1, 1]) {
    mb.cylinder(M.metal, [sx * xs, yr, 0.01], r, r, h - 0.02, 10);
    for (const z of [0.12, h - 0.12]) mb.rod(M.metal, [sx * xs, yr, z], [sx * xs, d / 2, z], 0.008, 8);
    for (const z of [0.12, h - 0.12]) mb.cylinder(M.metal, [sx * xs, d / 2 - 0.002, z - 0.025], 0.002, 0.002, 0.05, 4);
  }
  const n = Math.max(3, Math.round((h - 0.1) / 0.075));
  for (let i = 0; i < n; i++) {
    const z = 0.06 + ((h - 0.12) * i) / (n - 1);
    mb.rod(M.metal, [-xs, yr, z], [xs, yr, z], 0.009, 8);
  }
  if (!optBool(s, "towel", true)) return;
  // towel folded over the second bar from the top
  const zb = 0.06 + ((h - 0.12) * (n - 2)) / (n - 1);
  const tw = Math.min(w - 0.1, 0.42), tt = 0.012;
  const yf = yr - 0.009 - tt / 2 - 0.001, yk = yr + 0.009 + tt / 2 + 0.001;
  mb.rod(M.towel, [-tw / 2, yr, zb + 0.004], [tw / 2, yr, zb + 0.004], 0.009 + tt, 12);
  softBox(mb, M.towel, 0, yf, Math.max(0.02, zb - h * 0.45), tw, tt, zb - Math.max(0.02, zb - h * 0.45), 0.004, 0.003);
  softBox(mb, M.towel, 0, yk, Math.max(0.05, zb - h * 0.3), tw, tt, zb - Math.max(0.05, zb - h * 0.3), 0.004, 0.003);
}

function buildTowelHooks(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const ph = Math.min(0.09, h * 0.2);
  const pt = 0.018;
  mb.box(M.plate, [-w / 2, d / 2 - pt, h - ph], [w / 2, d / 2, h]);
  const n = Math.max(2, Math.round(w / 0.16));
  const hz = h - ph / 2;
  const hookY = Math.max(-d / 2 + 0.012, d / 2 - pt - 0.05);
  const xs = Array.from({ length: n }, (_, i) => -w / 2 + (w * (i + 0.5)) / n);
  for (const x of xs) {
    mb.rod(M.hooks, [x, d / 2 - pt, hz - 0.01], [x, hookY + 0.005, hz - 0.005], 0.006, 8);
    mb.sphere(M.hooks, [x, hookY + 0.002, hz + 0.004], 0.011, 8, 6);
  }
  if (!optBool(s, "towels", true)) return;
  const towels = [M.towel, M.towel_b];
  [0, n - 1].forEach((k, i) => {
    if (n < 2 && i) return;
    const x = xs[k];
    const tw = Math.min(0.26, w / n + 0.08), tt = 0.014;
    const top = hz - 0.006, bot = Math.max(0.0, top - Math.min(0.55, h * 0.85));
    const ty = hookY + 0.01;
    // two hanging layers (front/back of the fold) with a rounded top
    softBox(mb, towels[i % 2], clamp(x, -w / 2 + tw / 2, w / 2 - tw / 2), ty - tt / 2 - 0.002, bot, tw, tt, top - bot, 0.01, 0.004);
    softBox(mb, towels[i % 2], clamp(x, -w / 2 + tw / 2, w / 2 - tw / 2), ty + tt / 2, bot + 0.04, tw * 0.94, tt, top - bot - 0.04, 0.01, 0.004);
  });
}

function buildToiletRollHolder(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const rr = Math.min(0.055, (d - 0.02) / 2, h / 2 - 0.005);
  const zc = h / 2;
  const yc = d / 2 - 0.012 - rr;
  mb.with(facingFront(-w / 2 + 0.03, d / 2, zc), () => mb.cylinder(M.metal, [0, 0, 0], 0.025, 0.025, 0.012, 14));
  mb.rod(M.metal, [-w / 2 + 0.03, d / 2 - 0.012, zc], [-w / 2 + 0.03, yc, zc], 0.007, 8);
  mb.rod(M.metal, [-w / 2 + 0.03, yc, zc], [w / 2 - 0.005, yc, zc], 0.007, 8);
  const rl = Math.min(0.1, w - 0.06);
  mb.with(axleX(-w / 2 + 0.045, yc, zc), () => {
    tube(mb, M.paper, 0, 0, 0, rl, rr, rr, rr - 0.022, 24);
    tube(mb, M.core, 0, 0, 0.001, rl - 0.001, 0.022, 0.022, 0.003, 12);
  });
}

function buildBathMat(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  softBox(mb, M.main, 0, 0, 0, w, d, h * 0.6, 0.04, 0.004, false);
  const n = Math.max(3, Math.round(d / 0.06));
  for (let i = 0; i < n; i++) {
    const y = -d / 2 + 0.04 + ((d - 0.08) * (i + 0.5)) / n;
    softBox(mb, M.main, 0, y, h * 0.6 - 0.001, w - 0.08, (d - 0.08) / n - 0.012, h * 0.4 + 0.001, 0.008, 0.003, false);
  }
}

function buildSoapDispenser(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const set = optBool(s, "set", true);
  const x0 = set ? -w / 2 + 0.045 : 0;
  const r = Math.min(0.04, d / 2 - 0.005);
  const bh = h * 0.68;
  lathe(mb, M.bottle, x0, 0, [[0, 0], [r * 0.95, 0], [r, 0.01], [r, bh * 0.9], [r * 0.7, bh], [0, bh]], 16);
  mb.cylinder(M.pump, [x0, 0, bh], 0.012, 0.012, h * 0.12, 10, { bottom: false });
  mb.cylinder(M.pump, [x0, 0, bh + h * 0.12], 0.016, 0.016, h - bh - h * 0.12 - 0.002, 10);
  mb.rod(M.pump, [x0, 0, h - 0.012], [x0, -Math.min(0.045, d / 2 - 0.006), h - 0.016], 0.005, 6);
  if (!set) return;
  // tumbler with toothbrushes + soap dish
  const tx = 0.01;
  vessel(mb, M.tumbler, tx, 0, 0, Math.min(0.036, d / 2 - 0.01), h * 0.5, "jar", 16);
  for (const [a, mat] of [[0.25, M.brush_a], [-0.3, M.brush_b]] as [number, string][]) {
    const top: Vec3 = [tx + Math.sin(a) * 0.05, Math.cos(a) * 0.01, h - 0.02];
    mb.rod(mat, [tx, 0, 0.02], top, 0.006, 6);
    mb.box(mat, [top[0] - 0.005, top[1] - 0.012, top[2] - 0.02], [top[0] + 0.005, top[1] - 0.004, top[2] + 0.018]);
  }
  const sx = w / 2 - 0.05;
  rectLathe(mb, M.bottle, sx, 0, 0.09, Math.min(0.07, d - 0.01), 0.02, [[0.01, 0], [0, 0.012], [0.006, 0.012], [0.006, 0.006], [0.05, 0.006]], 3);
  softBox(mb, M.soap, sx, 0, 0.006, 0.065, Math.min(0.045, d - 0.03), 0.022, 0.015, 0.008);
}

function buildFreestandingBathtub(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const style = optStr(s, "style", ["modern", "clawfoot"] as const, "modern");
  const r = d / 2 - 0.005;
  if (style === "modern") {
    rectLathe(mb, M.body, 0, 0, w, d, r, [[0.14, 0], [0.06, 0.06], [0.015, h * 0.45], [0, h - 0.01], [0.006, h], [0.05, h], [0.07, h - 0.04], [0.12, h * 0.4], [0.2, 0.1], [Math.min(w, d) / 2, 0.1]], 8);
    mb.cylinder(M.faucet, [w * 0.25, 0, 0.1], 0.025, 0.025, 0.002, 12, { bottom: false });
    return;
  }
  // clawfoot: roll-top tub on four feet, deck tap at the -X end
  const z0 = 0.14, rim = h - 0.13;
  rectLathe(mb, M.body, 0, 0, w, d, r, [[0.16, z0], [0.06, z0 + 0.08], [0.012, rim * 0.6], [0.006, rim - 0.04], [0, rim - 0.015], [0.006, rim], [0.03, rim + 0.005], [0.045, rim - 0.01], [0.07, rim - 0.06], [0.13, z0 + 0.2], [0.22, z0 + 0.05], [Math.min(w, d) / 2, z0 + 0.05]], 8);
  for (const sx of [-1, 1])
    for (const sy of [-1, 1]) {
      const fx = sx * (w / 2 - 0.2), fy = sy * (d / 2 - 0.12);
      mb.rod(M.feet, [fx * 0.94, fy * 0.85, z0 + 0.04], [fx, fy, 0.04], 0.022, 8);
      mb.sphere(M.feet, [fx, fy, 0.035], 0.035, 10, 7, [1, 1, 1]);
    }
  const tx = -w / 2 + 0.06;
  for (const sy of [-1, 1]) {
    mb.cylinder(M.faucet, [tx, sy * 0.06, rim + 0.005], 0.012, 0.012, h - rim - 0.03, 8);
    mb.cylinder(M.faucet, [tx, sy * 0.06, h - 0.025], 0.022, 0.018, 0.02, 8);
  }
  mb.rod(M.faucet, [tx, -0.06, h - 0.06], [tx, 0.06, h - 0.06], 0.01, 8);
  mb.rod(M.faucet, [tx, 0, h - 0.06], [tx + 0.09, 0, h - 0.08], 0.011, 8);
}

function buildShowerCurtain(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const rodZ = h - 0.02;
  mb.rod(M.rod, [-w / 2, 0, rodZ], [w / 2, 0, rodZ], 0.012, 10);
  const amp = Math.min(d / 2 - 0.01, 0.035);
  const n = Math.max(4, Math.round(w / 0.08)) * 2;
  const front: Vec2[] = [];
  for (let i = 0; i <= n; i++) front.push([-w / 2 + 0.01 + ((w - 0.02) * i) / n, i % 2 ? amp : -amp]);
  const prof: Vec2[] = [...front, ...front.map((p) => [p[0], p[1] + 0.004] as Vec2).reverse()];
  mb.prism(M.fabric, prof, 0.03, rodZ - 0.06);
  for (let i = 0; i <= n; i += 2) torus(mb, M.rod, [clamp(front[i][0], -w / 2 + 0.03, w / 2 - 0.03), 0, rodZ - 0.025], 0.025, 0.003, "y", 10, 4);
}

// ---- kitchen counter decor ----

function buildKettle(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const R = Math.min(d / 2 - 0.005, (w - 0.14) / 2);
  const cx = 0;
  mb.cylinder(M.accent, [cx, 0, 0], R * 1.02, R, 0.016, 20);
  const bh = h - 0.03;
  lathe(mb, M.body, cx, 0, [[0, 0.016], [R * 0.92, 0.016], [R, 0.04], [R * 0.94, bh * 0.75], [R * 0.72, bh], [0, bh]], 22);
  mb.cylinder(M.accent, [cx, 0, bh - 0.002], R * 0.25, R * 0.22, h - bh + 0.002 - 0.004, 12);
  // handle (+X) and spout (-X)
  const hx = Math.min(w / 2 - 0.012, cx + R + 0.06);
  beam(mb, M.accent, [cx + R * 0.85, 0, bh * 0.85], [hx, 0, bh * 0.85], 0.03, 0.022);
  beam(mb, M.accent, [hx, 0, bh * 0.86], [hx, 0, bh * 0.3], 0.025, 0.03);
  beam(mb, M.accent, [hx, 0, bh * 0.3], [cx + R * 0.9, 0, bh * 0.25], 0.03, 0.02);
  mb.rod(M.body, [cx - R * 0.8, 0, bh * 0.55], [Math.max(-w / 2 + 0.012, cx - R - 0.06), 0, bh * 0.82], 0.012, 8);
}

function buildCoffeeMachine(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const yb = -d / 2 + d * 0.38;
  // back tower + top overhang + drip tray base
  softBox(mb, M.body, 0, (yb + d / 2) / 2, 0, w, d / 2 - yb, h, 0.02, 0.008);
  softBox(mb, M.body, 0, (-d / 2 + 0.03 + yb) / 2 + 0.01, h * 0.68, w, yb + d / 2 - 0.03 + 0.02, h * 0.32, 0.02, 0.008);
  mb.box(M.body, [-w / 2 + 0.01, -d / 2 + 0.02, 0], [w / 2 - 0.01, yb + 0.01, 0.035]);
  mb.box(M.accent, [-w / 2 + 0.03, -d / 2 + 0.03, 0.035], [w / 2 - 0.03, yb, 0.038]);
  // group head + portafilter
  const gy = (-d / 2 + 0.03 + yb) / 2;
  mb.cylinder(M.metal, [0, gy, h * 0.6], 0.04, 0.045, h * 0.08, 16, { top: false });
  mb.cylinder(M.metal, [0, gy, h * 0.53], 0.042, 0.04, h * 0.07, 16);
  beam(mb, M.accent, [0, gy - 0.03, h * 0.56], [0, -d / 2 + 0.005, h * 0.53], 0.022, 0.03);
  // cup
  lathe(mb, M.cup, 0, gy, [[0, 0.038], [0.024, 0.038], [0.032, 0.09], [0.028, 0.09], [0.026, 0.06], [0, 0.06]], 14);
  // steam wand, gauge, buttons
  mb.rod(M.metal, [w / 2 - 0.04, gy + 0.01, h * 0.68], [w / 2 - 0.035, gy - 0.02, h * 0.2], 0.005, 6);
  mb.with(facingFront(0, -d / 2 + 0.03, h * 0.84), () => {
    mb.cylinder(M.metal, [0, 0, 0], 0.03, 0.03, 0.008, 18, { bottom: false });
    mb.cylinder(M.cup, [0, 0, 0.008], 0.025, 0.025, 0.001, 18, { bottom: false });
  });
  for (const x of [-w * 0.32, -w * 0.2, w * 0.2]) mb.with(facingFront(x, -d / 2 + 0.03, h * 0.84), () => mb.cylinder(M.accent, [0, 0, 0], 0.01, 0.01, 0.006, 10, { bottom: false }));
}

function buildFruitBowl(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const R = Math.min(w, d) / 2;
  const bh = Math.min(h * 0.55, R * 0.5);
  vessel(mb, M.bowl, 0, 0, 0, R, bh, "bowl", 24);
  const fz = bh * 0.22;
  const fr = Math.min(0.04, (h - fz) / 2 - 0.002, R * 0.3);
  const fruit = (x: number, y: number, z: number, mat: string, k = 1, stem = true) => {
    mb.sphere(mat, [x, y, z + fr * k], fr * k, 12, 9, [1, 1, 0.92]);
    if (stem) mb.rod(M.stem, [x, y, z + fr * k * 1.8], [x + 0.004, y, z + fr * k * 2 + 0.01], 0.0025, 4);
  };
  const ring = R * 0.42;
  fruit(ring, 0, fz, M.fruit_a);
  fruit(-ring * 0.5, ring * 0.86, fz, M.fruit_b, 1.05, false);
  fruit(-ring * 0.5, -ring * 0.86, fz, M.fruit_a);
  fruit(0, 0, fz + fr * 0.9, M.fruit_b, 1.0, false);
  mb.sphere(M.fruit_c, [ring * 0.2, -ring * 0.3, fz + fr * 1.7 + 0.004], fr * 0.75, 12, 8, [1.3, 0.85, 0.85]);
  // two bananas lying across the fruit, curving up at both ends
  const br = Math.min(0.017, (h - fz - fr * 1.9) / 3);
  for (let b = 0; b < 2; b++) {
    const pts: Vec3[] = [], rad: number[] = [];
    const n = 9;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      pts.push([-R * 0.6 + R * 1.15 * t, R * 0.18 - b * br * 2.1 - 0.02 * Math.sin(Math.PI * t), fz + fr * 1.9 + br + 0.055 * Math.pow(2 * t - 1, 2) * (R / 0.16) * 0.5 + b * br * 0.6]);
      rad.push(i === n ? 0.004 : br * Math.pow(Math.sin(Math.PI * (0.06 + 0.88 * t)), 0.5));
    }
    sweepTube(mb, M.fruit_c, pts.map((p) => [p[0], p[1], Math.min(p[2], h - br)] as Vec3), rad, 7);
    mb.rod(M.stem, pts[n], v3.add(pts[n], [0.012, 0, 0.012]), 0.004, 5);
  }
}

function buildCuttingBoards(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const t = 0.018;
  // each board: outline in (x, z) with a hanging hole, extruded along -Y and leaned against the wall
  const board = (mat: string, cx: number, bw: number, bh: number, round: boolean, lean: number, yBack: number) => {
    const hr = 0.012;
    const body = round ? ellipse(cx, bh * 0.4, bw / 2, bh * 0.4, 28) : roundRect(cx, bh * 0.38, bw, bh * 0.76, 0.03, 3);
    const tabW = Math.min(0.08, bw * 0.35);
    const tab = roundRect(cx, bh * 0.85, tabW, bh * 0.3, tabW * 0.45, 3);
    const hole = ellipse(cx, bh * 0.9, hr, hr, 12);
    const c = Math.cos(lean), sn = Math.sin(lean);
    mb.with(m4.mul(m4.translation(0, yBack - t * c - bh * sn, t * sn), m4.mul(m4.rotationX(-lean), m4.fromBasis([1, 0, 0], [0, 0, 1], [0, -1, 0], [0, t, 0]))), () => {
      mb.prism(mat, body, 0, t);
      loft(mb, mat, tab, 0, tab, t);
      mb.flat(mat, tab, t, false, [hole]);
      mb.flat(mat, tab, 0, true, [hole]);
      loft(mb, mat, hole, 0, hole, t, true);
    });
  };
  const L = (bh: number, yb: number) => Math.asin(clamp((yb + d / 2 - t - 0.006) / bh, 0, 0.3));
  const y2 = d / 2 - Math.min(0.022, d * 0.15), y3 = d / 2 - Math.min(0.045, d * 0.3);
  board(M.board_a, -w * 0.12, w * 0.62, h, false, L(h, d / 2), d / 2);
  board(M.board_b, w * 0.18, w * 0.55, h * 0.82, true, L(h * 0.82, y2) * 0.75, y2);
  board(M.board_c, -w * 0.25, w * 0.4, h * 0.55, false, L(h * 0.55, y3) * 0.5, y3);
}

function buildUtensilJar(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const R = Math.min(w, d) / 2 - 0.004;
  const jh = Math.min(h * 0.5, 0.18);
  vessel(mb, M.jar, 0, 0, 0, R, jh, "jar", 18);
  const items: [number, number, string][] = [[0.3, 0.2, "spoon"], [-0.25, 0.7, "spatula"], [0.1, 2.4, "ladle"], [-0.15, 4, "spoon"], [0.2, 5.2, "whisk"]];
  for (const [tilt, az, kind] of items) {
    const top: Vec3 = [Math.cos(az) * Math.sin(tilt) * (h - jh) * 0.55, Math.sin(az) * Math.sin(tilt) * (h - jh) * 0.55, h - 0.005];
    const base: Vec3 = [Math.cos(az) * R * 0.3, Math.sin(az) * R * 0.3, 0.04];
    const dir = v3.norm(v3.sub(top, base));
    const tipLen = 0.07;
    const neck = v3.sub(top, v3.scale(dir, tipLen));
    const mat = kind === "spoon" || kind === "spatula" ? M.wood : M.metal;
    mb.rod(mat, base, neck, 0.005, 6);
    const x = v3.norm(v3.cross([0, 0, 1], dir));
    const frame = m4.fromBasis(x, v3.cross(dir, x), dir, neck);
    mb.with(frame, () => {
      if (kind === "spoon") mb.sphere(mat, [0, 0, tipLen * 0.5], 0.022, 10, 7, [1, 0.35, 1.5]);
      else if (kind === "spatula") mb.block(mat, 0, 0, 0, 0.05, 0.006, tipLen);
      else if (kind === "ladle") mb.sphere(mat, [0, 0, tipLen * 0.55], 0.03, 10, 7, [1, 1, 0.9]);
      else for (let k = 0; k < 3; k++) mb.with(m4.rotationZ((k / 3) * Math.PI), () => torus(mb, mat, [0, 0, tipLen * 0.45], 0.022, 0.0018, "y", 14, 4));
    });
  }
}

function buildPlantHerbs(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const tray = 0.015;
  softBox(mb, M.tray, 0, 0, 0, w, d, tray, 0.02, 0.004);
  const n = 3;
  const pr = Math.min(d / 2 - 0.01, w / (2 * n) - 0.01);
  const ph = Math.min(0.11, h * 0.45);
  for (let i = 0; i < n; i++) {
    const x = -w / 2 + (w * (i + 0.5)) / n;
    vessel(mb, M.pot, x, 0, tray, pr, ph, "pot", 14);
    mb.cylinder(M.soil, [x, 0, tray + ph * 0.86], pr * 0.92, pr * 0.92, 0.003, 14, { bottom: false });
    const z0 = tray + ph * 0.84, top = h - 0.005;
    if (i === 1) {
      const rnd = rng(11);
      for (let k = 0; k < 14; k++) {
        const a = rnd() * TAU, rr = rnd() * pr * 0.6;
        blade(mb, M.foliage, [x + Math.cos(a) * rr, Math.sin(a) * rr, z0], [Math.cos(a) * 0.15, Math.sin(a) * 0.15, 1], (top - z0) * (0.6 + 0.4 * rnd()), 0.004, { n: 3, th: 0.002, cup: 0, side: [-Math.sin(a), Math.cos(a), 0], shape: (t) => 1 - t * 0.8 });
      }
    } else foliage(mb, M.foliage, x, 0, z0, Math.min(pr * 2.4, w / n), Math.min(pr * 2.4, d), top - z0, 5, 21 + i, 8);
  }
}

// ---- entry & laundry ----

function buildCoatRack(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const R = Math.min(w, d) / 2;
  for (let i = 0; i < 3; i++) {
    const a = Math.PI / 2 + (i / 3) * TAU;
    mb.rod(M.wood, [0, 0, 0.32], [Math.cos(a) * (R - 0.02), Math.sin(a) * (R - 0.02), 0.012], 0.014, 8);
  }
  mb.cylinder(M.wood, [0, 0, 0.2], 0.02, 0.016, h - 0.25, 10);
  mb.sphere(M.wood, [0, 0, h - 0.035], 0.03, 10, 7);
  const hooks: Vec3[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU + 0.3;
    const z = i % 2 ? h - 0.22 : h - 0.32;
    const tip: Vec3 = [Math.cos(a) * 0.13, Math.sin(a) * 0.13, z + 0.08];
    mb.rod(M.wood, [0, 0, z], tip, 0.008, 6);
    mb.sphere(M.wood, tip, 0.014, 8, 6);
    hooks.push(tip);
  }
  if (!optBool(s, "coats", true)) return;
  // a coat and a tote hanging from two hooks
  const hangCoat = (hk: Vec3, mat: string, len: number, cw: number) => {
    const a = Math.atan2(hk[1], hk[0]);
    const rr = Math.min(0.17, R - cw / 2 - 0.02);
    const cx = Math.cos(a) * rr, cy = Math.sin(a) * rr;
    mb.with(m4.mul(m4.translation(cx, cy, 0), m4.rotationZ(a + Math.PI / 2)), () => {
      const top = hk[2] - 0.02;
      const shoulders = roundRect(0, 0, cw * 0.55, 0.06, 0.025, 2), chest = roundRect(0, 0, cw, 0.11, 0.05, 2), hem = roundRect(0, 0.01, cw * 1.08, 0.14, 0.06, 2);
      loft(mb, mat, chest, top - 0.12, shoulders, top);
      loft(mb, mat, hem, top - len, chest, top - 0.12);
      mb.flat(mat, shoulders, top);
      mb.flat(mat, hem, top - len, true);
      for (const sx of [-1, 1]) mb.rod(mat, [sx * cw * 0.42, 0, top - 0.1], [sx * cw * 0.5, 0.02, top - len * 0.75], 0.035, 8);
    });
  };
  const cw = Math.min(0.4, w * 0.6);
  hangCoat(hooks[1], M.coat, Math.min(0.95, h * 0.55), cw);
  hangCoat(hooks[4], M.coat_b, Math.min(0.8, h * 0.45), cw * 0.9);
  const hk = hooks[2];
  lathe(mb, M.hat, hk[0], hk[1], [[0, hk[2] - 0.005], [0.15, hk[2] - 0.005], [0.15, hk[2] + 0.002], [0.09, hk[2] + 0.004], [0.085, Math.min(h - 0.01, hk[2] + 0.1)], [0, Math.min(h - 0.01, hk[2] + 0.1)]].map(([r, z]) => [Math.min(r, R - Math.hypot(hk[0], hk[1]) - 0.01), z] as Vec2), 18);
}

function buildShoeCabinet(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const legH = 0.08, t = 0.022;
  const yFace = -d / 2 + FRONT;
  mb.box(M.top, [-w / 2, -d / 2, h - t], [w / 2, d / 2, h]);
  mb.box(M.body, [-w / 2 + 0.005, yFace, legH], [w / 2 - 0.005, d / 2, h - t], { skip: ["+z"] });
  legs4(mb, M.top, w, d, 0.03, 0.03, 0, legH, true, 0.7);
  const n = Math.round(optNum(s, "flaps", clamp(Math.round((h - legH) / 0.3), 1, 5), 1, 6));
  const fh = (h - t - legH) / n;
  for (let i = 0; i < n; i++) {
    const z0 = legH + i * fh;
    front(mb, M.body, M.handles, -w / 2 + 0.005, w / 2 - 0.005, z0, z0 + fh, yFace, "bar_h", 0, z0 + fh - 0.035, Math.min(0.2, w * 0.3));
  }
}

function buildUmbrellaStand(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const R = Math.min(w, d) / 2 - 0.004;
  const sh = Math.min(0.5, h * 0.5);
  lathe(mb, M.stand, 0, 0, [[0, 0], [R, 0], [R * 0.96, sh], [R * 0.88, sh], [R * 0.9, 0.02], [0, 0.02]], 20);
  const umbrella = (a: number, mat: string, len: number) => {
    const tilt = 0.08;
    const dir = v3.norm([Math.cos(a) * tilt, Math.sin(a) * tilt, 1]);
    const base: Vec3 = [-Math.cos(a) * R * 0.4, -Math.sin(a) * R * 0.4, 0.025];
    const x = v3.norm(v3.cross([0, 0, 1], dir));
    mb.with(m4.fromBasis(x, v3.cross(dir, x), dir, base), () => {
      mb.cylinder(M.shaft, [0, 0, 0], 0.004, 0.004, len - 0.1, 6);
      lathe(mb, mat, 0, 0, [[0, 0.05], [0.035, len * 0.18], [0.03, len * 0.55], [0.012, len * 0.68], [0, len * 0.68]], 8);
      mb.cylinder(M.shaft, [0, 0, len - 0.1], 0.006, 0.006, 0.02, 6);
      torus(mb, M.handle, [0.035, 0, len - 0.075], 0.035, 0.009, "y", 10, 6, 0, Math.PI);
    });
  };
  umbrella(0.5, M.umbrella, Math.min(0.9, (h - 0.03) / Math.cos(0.08) - 0.01));
  umbrella(3.6, M.umbrella_b, Math.min(0.8, (h - 0.03) / Math.cos(0.08) - 0.05));
}

function buildLaundryBasket(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const bh = h * 0.85;
  const r = Math.min(w, d) * 0.3;
  rectLathe(mb, M.basket, 0, 0, w, d, r, [[0.04, 0], [0, bh], [0.012, bh], [0.05, 0.02], [Math.min(w, d) / 2, 0.02]], 6);
  // liner fold over the rim
  rectLathe(mb, M.liner, 0, 0, w - 0.002, d - 0.002, r, [[0.003, bh - 0.06], [0.0, bh - 0.002], [0.008, bh + 0.008], [0.016, bh - 0.002], [0.016, bh - 0.05]], 6);
  // laundry heap
  const rnd = rng(19);
  const mats = [M.laundry_a, M.laundry_b, M.laundry_c];
  for (let i = 0; i < 6; i++) {
    const rx = (w - 0.12) * (0.2 + rnd() * 0.12), ry = (d - 0.12) * (0.25 + rnd() * 0.15), rz = 0.05;
    const x = (rnd() - 0.5) * (w - 0.12 - 2 * rx), y = (rnd() - 0.5) * (d - 0.12 - 2 * ry);
    mb.sphere(mats[i % 3], [x, y, Math.min(h - rz, bh - 0.02 + rnd() * 0.04)], rx, 10, 6, [1, ry / rx, rz / rx]);
  }
}

function buildIroningBoard(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const t = 0.03;
  const L = w, B = d;
  const outline: Vec2[] = [];
  for (let i = 0; i <= 12; i++) {
    const a = -Math.PI / 2 + (i / 12) * Math.PI;
    outline.push([L / 2 - B / 2 + Math.cos(a) * B / 2, Math.sin(a) * B / 2]);
  }
  for (let i = 0; i <= 12; i++) {
    const a = Math.PI / 2 + (i / 12) * Math.PI;
    outline.push([-L / 2 + B * 0.9 + Math.cos(a) * B * 0.9, Math.sin(a) * (B / 2) * 0.98]);
  }
  const withIron = optBool(s, "iron", true);
  const top = withIron ? h - 0.055 : h;
  mb.prism(M.cover, outline.map(([x, y]) => [x, y * 0.995] as Vec2), top - t, top);
  // X legs
  for (const sy of [-1, 1]) {
    mb.rod(M.frame, [-L * 0.3, sy * (B / 2 - 0.05), 0.01], [L * 0.2, sy * (B / 2 - 0.05), top - t], 0.011, 6);
    mb.rod(M.frame, [L * 0.2, sy * (B / 2 - 0.05), 0.01], [-L * 0.3, sy * (B / 2 - 0.05), top - t], 0.011, 6);
  }
  for (const x of [-L * 0.3, L * 0.2]) mb.rod(M.frame, [x, -(B / 2 - 0.05), 0.012], [x, B / 2 - 0.05, 0.012], 0.012, 6);
  if (!withIron) return;
  const ix = L / 2 - 0.2;
  const iron: Vec2[] = [[ix - 0.12, -0.05], [ix + 0.06, -0.055], [ix + 0.13, 0], [ix + 0.06, 0.055], [ix - 0.12, 0.05]];
  const z0 = top;
  mb.prism(M.iron_plate, iron, z0, z0 + 0.015);
  mb.prism(M.iron, iron.map(([x, y]) => [x - 0.005 * Math.sign(x - ix), y * 0.85] as Vec2), z0 + 0.015, z0 + 0.05);
  void z0;
}

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

/** Wraps a type so build() always sees sane dimensions, every slot and every option default. */
function def(t: FurnitureType): FurnitureType {
  const inner = t.build;
  return {
    ...t,
    build(mb, s) {
      const pos = (v: unknown, dflt: number) => (typeof v === "number" && isFinite(v) && v > 0 ? v : dflt);
      const materials: Record<string, string> = { ...t.slots };
      for (const [k, v] of Object.entries(s.materials ?? {})) if (typeof v === "string" && v) materials[k] = v;
      const options: Record<string, unknown> = {};
      for (const [k, o] of Object.entries(t.options ?? {})) options[k] = o.default;
      Object.assign(options, s.options ?? {});
      inner(mb, {
        width: pos(s.width, t.defaults.width),
        depth: pos(s.depth, t.defaults.depth),
        height: pos(s.height, t.defaults.height),
        materials,
        options,
      });
    },
  };
}

const SOFA_SLOTS = { body: "fabric_gray", cushions: "fabric_gray", legs: "wood_walnut" };
const BED_SLOTS = { frame: "wood_walnut", headboard: "fabric_gray", mattress: "linen_white", duvet: "fabric_blue", pillows: "linen_white" };
const COUNTER_SLOTS = { counter: "marble_white", cabinet: "wood_painted_white", handles: "metal_steel", plinth: "plastic_black" };

export const FURNITURE: Record<string, FurnitureType> = {
  table: def({
    description: "Rectangular dining table on 4 legs with apron; option round=true gives an oval/round pedestal table.",
    defaults: { width: 1.6, depth: 0.9, height: 0.75 },
    slots: { top: "wood_oak", legs: "wood_oak" },
    options: { round: { description: "Round/oval top on a central pedestal", default: false } },
    build: buildTable,
  }),
  coffee_table: def({
    description: "Low coffee table: rounded top, slim metal legs, lower shelf.",
    defaults: { width: 1.2, depth: 0.6, height: 0.42 },
    slots: { top: "wood_walnut", legs: "metal_black" },
    options: { shelf: { description: "Lower shelf", default: true } },
    build: buildCoffeeTable,
  }),
  side_table: def({
    description: "Small side/end table; round tripod by default, square with shelf when round=false.",
    defaults: { width: 0.5, depth: 0.5, height: 0.55 },
    slots: { top: "wood_oak", legs: "metal_black" },
    options: { round: { description: "Round top on three splayed legs", default: true } },
    build: buildSideTable,
  }),
  desk: def({
    description: "Work desk with a 3-drawer pedestal, side panel and modesty panel; front (-Y) is where you sit.",
    defaults: { width: 1.4, depth: 0.7, height: 0.75 },
    slots: { top: "wood_oak", body: "wood_painted_white", handles: "metal_steel" },
    options: { drawers: { description: "Drawer pedestal side: right | left | none", default: "right" } },
    build: buildDesk,
  }),
  chair: def({
    description: "Dining chair with upholstered seat and slightly reclined backrest (backrest at +Y).",
    defaults: { width: 0.45, depth: 0.5, height: 0.9 },
    slots: { frame: "wood_oak", seat: "fabric_gray" },
    build: buildChair,
  }),
  office_chair: def({
    description: "Swivel office chair: 5-star base with casters, gas lift, padded seat and back, armrests.",
    defaults: { width: 0.65, depth: 0.65, height: 1.1 },
    slots: { base: "chrome", casters: "rubber_black", frame: "plastic_black", seat: "fabric_gray" },
    options: { arms: { description: "Armrests", default: true } },
    build: buildOfficeChair,
  }),
  armchair: def({
    description: "Upholstered armchair with seat and back cushions on short legs.",
    defaults: { width: 0.85, depth: 0.85, height: 0.85 },
    slots: { body: "fabric_beige", cushions: "fabric_beige", legs: "wood_walnut" },
    options: { arms: { description: "Armrests", default: true } },
    build: (mb, s) => buildSofa(mb, s, 1),
  }),
  sofa: def({
    description: "Straight sofa with arms, seat and back cushions; seats = cushion count.",
    defaults: { width: 2.1, depth: 0.9, height: 0.85 },
    slots: SOFA_SLOTS,
    options: {
      seats: { description: "Number of seat cushions (auto from width when omitted)", default: "auto" },
      arms: { description: "Armrests on both ends", default: true },
    },
    build: (mb, s) => buildSofa(mb, s),
  }),
  sectional_sofa: def({
    description: "L-shaped corner sofa; main run along the back (+Y), chaise run along +X (or -X with chaise=left) reaching the front.",
    defaults: { width: 2.8, depth: 2.0, height: 0.85 },
    slots: SOFA_SLOTS,
    options: { chaise: { description: "Which side the L returns toward the front: right (+X) | left (-X)", default: "right" } },
    build: buildSectional,
  }),
  bed: def({
    description: "Bed with frame, mattress, duvet, pillows and headboard at +Y (foot faces -Y); width 1.6 = double/queen.",
    defaults: { width: 1.6, depth: 2.1, height: 1.0 },
    slots: BED_SLOTS,
    build: buildBed,
  }),
  bunk_bed: def({
    description: "Two-level bunk bed with posts, guard rails and a ladder at the foot end (-Y).",
    defaults: { width: 1.0, depth: 2.0, height: 1.7 },
    slots: { frame: "wood_oak", mattress: "linen_white", duvet: "fabric_red", pillows: "linen_white" },
    build: buildBunkBed,
  }),
  nightstand: def({
    description: "Bedside table with drawers and knobs on short tapered legs.",
    defaults: { width: 0.45, depth: 0.4, height: 0.55 },
    slots: { body: "wood_walnut", handles: "metal_brass" },
    options: { drawers: { description: "Number of drawers", default: 2 } },
    build: buildNightstand,
  }),
  wardrobe: def({
    description: "Tall wardrobe with hinged doors, vertical bar handles and recessed plinth.",
    defaults: { width: 1.2, depth: 0.6, height: 2.1 },
    slots: { body: "wood_painted_white", handles: "metal_steel" },
    options: { doors: { description: "Number of doors (auto ~0.5 m each)", default: "auto" } },
    build: buildWardrobe,
  }),
  dresser: def({
    description: "Chest of drawers / dresser: grid of drawers with bar pulls on short legs.",
    defaults: { width: 1.2, depth: 0.5, height: 0.85 },
    slots: { body: "wood_oak", handles: "metal_brass" },
    options: {
      rows: { description: "Drawer rows (auto from height)", default: "auto" },
      columns: { description: "Drawer columns (2 when wider than 0.95 m)", default: "auto" },
    },
    build: buildDresser,
  }),
  bookshelf: def({
    description: "Open bookcase with back panel and evenly spaced shelves, optionally filled with books.",
    defaults: { width: 0.9, depth: 0.32, height: 1.9 },
    slots: { frame: "wood_oak", book_a: "fabric_red", book_b: "fabric_blue", book_c: "leather_brown", book_d: "fabric_beige" },
    options: {
      shelves: { description: "Number of intermediate shelves (auto ~0.36 m spacing)", default: "auto" },
      books: { description: "Fill shelves with books", default: true },
    },
    build: buildBookshelf,
  }),
  tv_stand: def({
    description: "Low media console: two doors and an open middle compartment on metal legs.",
    defaults: { width: 1.6, depth: 0.4, height: 0.5 },
    slots: { body: "wood_walnut", legs: "metal_black", accent: "plastic_black" },
    build: buildTvStand,
  }),
  tv: def({
    description: "Flat-screen TV facing -Y; mount=stand (on a foot, sits on furniture) or wall (panel only, back at +Y).",
    defaults: { width: 1.25, depth: 0.25, height: 0.8 },
    slots: { frame: "plastic_black", screen: "glass" },
    options: { mount: { description: "stand | wall", default: "stand" } },
    build: buildTv,
  }),
  kitchen_counter: def({
    description: "Run of base cabinets (~0.6 m units, drawer over door) with countertop and toe-kick plinth.",
    defaults: { width: 1.8, depth: 0.6, height: 0.9 },
    slots: COUNTER_SLOTS,
    options: { drawers: { description: "Top drawer in each unit", default: true } },
    build: (mb, s) => buildCounterRun(mb, s, { cabBack: s.depth / 2, counterH: s.height }),
  }),
  kitchen_island: def({
    description: "Kitchen island: cabinets facing -Y, countertop overhanging at +Y for bar seating.",
    defaults: { width: 1.8, depth: 0.9, height: 0.92 },
    slots: COUNTER_SLOTS,
    options: {
      overhang: { description: "Countertop overhang on the +Y (seating) side in meters", default: 0.3 },
      drawers: { description: "Top drawer in each unit", default: true },
    },
    build: (mb, s) => {
      const ov = optNum(s, "overhang", 0.3, 0, s.depth - 0.3);
      buildCounterRun(mb, s, { cabBack: s.depth / 2 - ov, counterH: s.height });
    },
  }),
  upper_cabinet: def({
    description: "Wall-mounted kitchen cabinet (built at z=0..h; caller sets elevation), doors face -Y.",
    defaults: { width: 0.8, depth: 0.35, height: 0.7 },
    slots: { cabinet: "wood_painted_white", handles: "metal_steel" },
    options: { doors: { description: "Number of doors (auto ~0.45 m each)", default: "auto" } },
    build: buildUpperCabinet,
  }),
  fridge: def({
    description: "Bottom-freezer refrigerator with two doors and bar handles.",
    defaults: { width: 0.7, depth: 0.7, height: 1.85 },
    slots: { body: "metal_steel", handles: "chrome", trim: "plastic_black" },
    build: buildFridge,
  }),
  stove: def({
    description: "Freestanding range: 4-burner cooktop, control knobs, oven door with window.",
    defaults: { width: 0.6, depth: 0.6, height: 0.9 },
    slots: { body: "metal_steel", top: "metal_black", burners: "rubber_black", window: "glass", handles: "chrome" },
    build: buildStove,
  }),
  sink_counter: def({
    description: "Base cabinet run with an inset sink basin and faucet; height includes the faucet, countertop at counter_height.",
    defaults: { width: 1.2, depth: 0.6, height: 1.15 },
    slots: { ...COUNTER_SLOTS, basin: "chrome" },
    options: {
      counter_height: { description: "Countertop height (m)", default: 0.9 },
      faucet: { description: "Add a gooseneck faucet (needs height > counter_height + 0.1)", default: true },
      drawers: { description: "Top drawer row (false front under the sink)", default: true },
    },
    build: (mb, s) => {
      const { width: w, depth: d, height: h } = s;
      const ch = Math.min(optNum(s, "counter_height", 0.9, 0.5, 1.2), h);
      const bw = clamp(w * 0.45, 0.3, 0.8), bd = clamp(d - 0.2, 0.25, 0.45);
      const fh = optBool(s, "faucet", true) ? Math.min(0.32, h - ch) : 0;
      buildCounterRun(mb, s, {
        cabBack: d / 2,
        counterH: ch,
        basin: { cx: 0, y0: -d / 2 + 0.065, w: bw, d: bd, depth: 0.18, faucetH: fh },
      });
    },
  }),
  dishwasher: def({
    description: "Built-in/freestanding dishwasher with control strip and bar handle.",
    defaults: { width: 0.6, depth: 0.6, height: 0.85 },
    slots: { body: "metal_steel", handles: "chrome", trim: "plastic_black" },
    build: buildDishwasher,
  }),
  toilet: def({
    description: "Close-coupled toilet: bowl at the front (-Y), cistern against the wall (+Y), closed seat lid.",
    defaults: { width: 0.4, depth: 0.7, height: 0.8 },
    slots: { body: "ceramic_white", seat: "plastic_white", flush: "chrome" },
    build: buildToilet,
  }),
  bathroom_sink: def({
    description: "Washbasin with faucet: style=vanity (cabinet) or pedestal; height includes the faucet.",
    defaults: { width: 0.6, depth: 0.48, height: 1.05 },
    slots: { basin: "ceramic_white", cabinet: "wood_painted_white", handles: "metal_steel", faucet: "chrome" },
    options: {
      style: { description: "vanity | pedestal", default: "vanity" },
      counter_height: { description: "Basin rim height (m)", default: 0.85 },
      faucet: { description: "Add a faucet", default: true },
    },
    build: buildBathroomSink,
  }),
  bathtub: def({
    description: "Built-in bathtub with rim, sloped interior, drain and spout at the -X end.",
    defaults: { width: 1.7, depth: 0.75, height: 0.55 },
    slots: { body: "ceramic_white", faucet: "chrome" },
    build: buildBathtub,
  }),
  shower: def({
    description: "Corner shower: tray, glass on the front (-Y) and left (-X) sides with door, head and mixer on the +Y wall.",
    defaults: { width: 0.9, depth: 0.9, height: 2.1 },
    slots: { tray: "ceramic_white", glass: "glass", frame: "chrome" },
    build: buildShower,
  }),
  mirror: def({
    description: "Framed wall mirror (back at +Y, reflective face -Y; built at z=0..h, caller sets elevation).",
    defaults: { width: 0.6, depth: 0.03, height: 0.8 },
    slots: { frame: "metal_black", mirror: "mirror" },
    options: { round: { description: "Round/oval mirror", default: false } },
    build: buildMirror,
  }),
  floor_lamp: def({
    description: "Floor lamp: weighted base, thin pole, fabric drum shade with glowing bulb.",
    defaults: { width: 0.4, depth: 0.4, height: 1.7 },
    slots: { base: "metal_black", shade: "fabric_beige", bulb: "emissive_light" },
    build: buildFloorLamp,
  }),
  table_lamp: def({
    description: "Table lamp: ceramic body, stem and fabric shade.",
    defaults: { width: 0.3, depth: 0.3, height: 0.5 },
    slots: { base: "ceramic_white", stem: "metal_brass", shade: "fabric_beige", bulb: "emissive_light" },
    build: buildTableLamp,
  }),
  ceiling_light: def({
    description: "Pendant (dome shade on a cord) or flush ceiling light; z=h is the ceiling, it hangs down from there.",
    defaults: { width: 0.4, depth: 0.4, height: 0.6 },
    slots: { shade: "metal_black", cord: "metal_black", bulb: "emissive_light" },
    options: { style: { description: "pendant | flush", default: "pendant" } },
    build: buildCeilingLight,
  }),
  plant: def({
    description: "Potted plant: pot, soil, trunk and a leafy crown of foliage blobs (taller = tree-like).",
    defaults: { width: 0.5, depth: 0.5, height: 1.0 },
    slots: { pot: "ceramic_white", soil: "rubber_black", stem: "wood_walnut", foliage: "plant_green" },
    build: buildPlant,
  }),
  rug: def({
    description: "Thin area rug with an optional contrasting border.",
    defaults: { width: 2.0, depth: 1.4, height: 0.01 },
    slots: { main: "carpet_beige", border: "carpet_gray" },
    options: { border: { description: "Contrasting border", default: true } },
    build: buildRug,
  }),
  door_mat: def({
    description: "Door mat: rubber edge with a raised coir/carpet center.",
    defaults: { width: 0.8, depth: 0.5, height: 0.015 },
    slots: { main: "carpet_beige", border: "rubber_black" },
    build: buildDoorMat,
  }),
  curtain: def({
    description: "Pair of pleated curtains on a rod (rod brackets to the wall at +Y); open = 0 closed .. 1 drawn aside.",
    defaults: { width: 1.6, depth: 0.15, height: 2.4 },
    slots: { fabric: "linen_white", rod: "metal_black" },
    options: { open: { description: "0 = closed, 1 = fully drawn to the sides", default: 0.3 } },
    build: buildCurtain,
  }),
  piano: def({
    description: "Upright piano with keyboard facing -Y.",
    defaults: { width: 1.5, depth: 0.6, height: 1.25 },
    slots: { body: "plastic_black", keys_white: "plastic_white", keys_black: "rubber_black" },
    build: buildPiano,
  }),
  washing_machine: def({
    description: "Front-loading washing machine with porthole door and control panel.",
    defaults: { width: 0.6, depth: 0.6, height: 0.85 },
    slots: { body: "plastic_white", door: "chrome", glass: "glass", trim: "plastic_black" },
    build: buildWashingMachine,
  }),
  radiator: def({
    description: "Wall column radiator (back at +Y); built from z=0, caller sets elevation (~0.1 m).",
    defaults: { width: 0.8, depth: 0.1, height: 0.6 },
    slots: { body: "plastic_white" },
    build: buildRadiator,
  }),
  fireplace: def({
    description: "Fireplace surround with mantel shelf, hearth and firebox with logs and glow; back against the wall (+Y).",
    defaults: { width: 1.4, depth: 0.4, height: 1.1 },
    slots: { surround: "marble_white", mantel: "wood_walnut", hearth: "stone_gray", firebox: "metal_black", logs: "wood_oak", fire: "emissive_light" },
    options: { fire: { description: "Logs and glowing embers", default: true } },
    build: buildFireplace,
  }),
  bar_stool: def({
    description: "Bar stool: round padded seat on four splayed legs with footrest ring.",
    defaults: { width: 0.42, depth: 0.42, height: 0.75 },
    slots: { seat: "leather_black", frame: "metal_black" },
    build: buildStool,
  }),
  counter_stool: def({
    description: "Counter-height stool (like bar_stool, for 0.9 m counters).",
    defaults: { width: 0.4, depth: 0.4, height: 0.65 },
    slots: { seat: "leather_brown", frame: "metal_black" },
    build: buildStool,
  }),
  bench: def({
    description: "Slatted bench on two metal leg frames.",
    defaults: { width: 1.2, depth: 0.4, height: 0.45 },
    slots: { seat: "wood_oak", legs: "metal_black" },
    build: buildBench,
  }),
  crate: def({
    description: "Wooden crate with corner posts and planks.",
    defaults: { width: 0.6, depth: 0.6, height: 0.5 },
    slots: { main: "wood_oak" },
    build: buildCrate,
  }),
  box: def({
    description: "Generic solid box filling the footprint (block out custom objects).",
    defaults: { width: 1, depth: 1, height: 1 },
    slots: { main: "wood_oak" },
    build: buildBox,
  }),
  cylinder: def({
    description: "Generic vertical cylinder filling the footprint (elliptic when width != depth).",
    defaults: { width: 0.5, depth: 0.5, height: 1 },
    slots: { main: "concrete" },
    options: { segments: { description: "Number of sides", default: 16 } },
    build: buildCylinder,
  }),
  car: def({
    description: "Passenger car, nose toward -Y (length = depth): body with wheel arches, glass cabin, bumpers, lights, mirrors; style sedan | suv | hatchback | pickup.",
    defaults: { width: 1.8, depth: 4.5, height: 1.45 },
    slots: { body: "car_paint_red", glass: "glass_tinted", tires: "tire_rubber", rims: "metal_aluminum", lights_front: "emissive_light", lights_rear: "emissive_red", interior: "fabric_gray", trim: "plastic_black" },
    options: { style: { description: "sedan | suv | hatchback | pickup", default: "sedan" } },
    build: buildCar,
  }),
  garden_chair: def({
    description: "Slatted wooden garden armchair with reclined back.",
    defaults: { width: 0.6, depth: 0.62, height: 0.88 },
    slots: { frame: "wood_teak", seat: "wood_teak" },
    build: buildGardenChair,
  }),
  sun_lounger: def({
    description: "Sun lounger: slatted bed with raised backrest at +Y (feet toward -Y), optional cushion.",
    defaults: { width: 0.7, depth: 2.0, height: 0.85 },
    slots: { frame: "wood_teak", cushion: "fabric_white" },
    options: { cushion: { description: "Add a cushion", default: true } },
    build: buildSunLounger,
  }),
  outdoor_table: def({
    description: "Slatted teak garden table on square legs; round=true gives a round top.",
    defaults: { width: 1.4, depth: 0.9, height: 0.74 },
    slots: { top: "wood_teak", legs: "wood_teak" },
    options: { round: { description: "Round/oval top", default: false } },
    build: buildOutdoorTable,
  }),
  parasol: def({
    description: "Patio umbrella: weighted base, pole, 8-panel canopy (footprint = canopy); open=false gives a furled umbrella.",
    defaults: { width: 2.6, depth: 2.6, height: 2.5 },
    slots: { canopy: "fabric_beige", pole: "wood_teak", base: "concrete" },
    options: { open: { description: "Canopy open", default: true } },
    build: buildParasol,
  }),
  bbq: def({
    description: "Barbecue grill facing -Y: style gas (cart with domed lid, knobs, side shelves) or kettle (round charcoal grill).",
    defaults: { width: 1.2, depth: 0.6, height: 1.15 },
    slots: { body: "metal_black", lid: "metal_steel", handles: "chrome", wheels: "rubber_black" },
    options: { style: { description: "gas | kettle", default: "gas" } },
    build: buildBbq,
  }),
  water_wall: def({
    description: "Water wall: dark wet-stone panel with a sheet of water running into a basin, warm LED line at the basin lip (courtyards, entrances). width = length, height = panel height; the panel stands at the back (north) of the footprint.",
    defaults: { width: 1.4, depth: 0.45, height: 2.6 },
    slots: { panel: "stone_wet_dark", basin: "stone_dark", water: "water", led: "emissive_light" },
    build: buildWaterWall,
  }),
  agave: def({
    description: "Agave: rosette of thick blue-green pointed leaves (succulent, gravel gardens, planters).",
    defaults: { width: 1.0, depth: 1.0, height: 0.7 },
    slots: { leaf: "agave_leaf" },
    build: buildAgave,
  }),
  grass_clump: def({
    description: "Ornamental grass clump: a fountain of thin arching blades (pennisetum / feather grass) for beds and planters.",
    defaults: { width: 0.8, depth: 0.8, height: 0.8 },
    slots: { blades: "grass_ornamental" },
    build: buildGrassClump,
  }),
  outdoor_lounge: def({
    description: "Built-in courtyard lounge: masonry plinth with an LED line in the shadow gap, seat and back cushions, throw pillows. shape l (long run at the back, return on the left) | straight. width = long run, depth = return length.",
    defaults: { width: 3.2, depth: 2.4, height: 0.86 },
    slots: { plinth: "travertine", base: "stone_dark", cushions: "fabric_beige", pillows: "fabric_green", led: "emissive_light" },
    options: { shape: { description: "l | straight", default: "l" }, led: { description: "LED line under the seat", default: true } },
    build: buildOutdoorLounge,
  }),
  stone_table: def({
    description: "Monolithic stone coffee table on a recessed base, with a dark tray (courtyards, lounges).",
    defaults: { width: 1.2, depth: 0.8, height: 0.38 },
    slots: { top: "travertine", base: "stone_dark", tray: "metal_black" },
    options: { tray: { description: "Tray and bowl on top", default: true } },
    build: buildStoneTable,
  }),
  outdoor_sofa: def({
    description: "Low lounge sofa: slatted teak frame with thick seat and back cushions.",
    defaults: { width: 2.0, depth: 0.85, height: 0.75 },
    slots: { frame: "wood_teak", cushions: "fabric_white" },
    options: {
      seats: { description: "Number of seat cushions (auto from width)", default: "auto" },
      arms: { description: "Slatted armrests", default: true },
    },
    build: buildOutdoorSofa,
  }),
  planter: def({
    description: "Box planter with soil and a leafy shrub; height includes the plant (box is ~half).",
    defaults: { width: 1.0, depth: 0.45, height: 0.9 },
    slots: { box: "wood_teak", soil: "dirt", foliage: "plant_green" },
    build: buildPlanter,
  }),
  bush: def({
    description: "Rounded shrub: leaf cards filling the box.",
    defaults: { width: 1.0, depth: 1.0, height: 0.9 },
    slots: { foliage: "plant_green", leaves: "leaves_green" },
    build: buildBush,
  }),
  tree: def({
    description: "Tree; footprint = canopy. kind deciduous (shade tree with a leafy crown) | olive (twisted stems, silver-green crown) | palm (date palm: diamond-bark trunk, arched fronds) | conifer (stacked cones). Leaves are cut-out cards: real silhouettes and dappled shadows.",
    defaults: { width: 2.4, depth: 2.4, height: 3.0 },
    slots: { trunk: "bark", foliage: "plant_green", needles: "plant_dark_green", leaves: "leaves_green", olive: "olive_leaves", fronds: "palm_frond", palmTrunk: "palm_bark" },
    options: { kind: { description: "deciduous | olive | palm | conifer", default: "deciduous" } },
    build: buildTree,
  }),
  hedge: def({
    description: "Clipped box hedge; width = length along X.",
    defaults: { width: 2.0, depth: 0.6, height: 1.2 },
    slots: { foliage: "plant_dark_green" },
    build: buildHedge,
  }),
  fence: def({
    description: "Fence section; width = length along X (posts every <= 2 m). style picket | panel (close boards) | slats (horizontal).",
    defaults: { width: 2.0, depth: 0.1, height: 1.0 },
    slots: { boards: "wood_painted_white", posts: "wood_painted_white" },
    options: { style: { description: "picket | panel | slats", default: "picket" } },
    build: buildFence,
  }),
  hot_tub: def({
    description: "Square hot tub: wood cabinet, acrylic shell with seats and water.",
    defaults: { width: 2.1, depth: 2.1, height: 0.9 },
    slots: { cabinet: "wood_dark", shell: "plastic_white", water: "water" },
    build: buildHotTub,
  }),
  trash_bin: def({
    description: "Wheelie bin: tapered body, hinged lid, handle and wheels at the back (+Y).",
    defaults: { width: 0.58, depth: 0.74, height: 1.07 },
    slots: { body: "plastic_green", lid: "plastic_green", wheels: "rubber_black" },
    build: buildTrashBin,
  }),
  bicycle: def({
    description: "Bicycle, front wheel toward -Y (length = depth, width = handlebar).",
    defaults: { width: 0.6, depth: 1.75, height: 1.05 },
    slots: { frame: "car_paint_blue", tires: "tire_rubber", metal: "chrome", saddle: "leather_black" },
    build: buildBicycle,
  }),
  lamp_post: def({
    description: "Classic street / garden lamp post with a glowing hexagonal lantern.",
    defaults: { width: 0.4, depth: 0.4, height: 3.5 },
    slots: { pole: "metal_black", light: "emissive_light" },
    build: buildLampPost,
  }),
  mailbox: def({
    description: "Post-mounted rural mailbox, door facing -Y, flag on the +X side.",
    defaults: { width: 0.25, depth: 0.5, height: 1.2 },
    slots: { box: "metal_black", post: "wood_painted_white", flag: "car_paint_red" },
    build: buildMailbox,
  }),
  // ---- interior decor (wall-mounted ones: back flat at +Y = d/2, built z = 0..h, set elevation) ----
  wall_art: def({
    description: "Framed print / canvas (WALL-MOUNTED: back at +Y, set elevation). frame thin_black|oak|gold|none (none = canvas), art abstract|landscape|geometric|botanical; recolor via art_a..art_e/canvas slots.",
    defaults: { width: 0.6, depth: 0.03, height: 0.8 },
    slots: ART_SLOTS,
    options: {
      frame: { description: "thin_black | oak | gold | none (gallery-wrapped canvas)", default: "thin_black" },
      art: { description: "abstract | landscape | geometric | botanical", default: "abstract" },
      mat: { description: "White mat board inside the frame (default on for thin_black/oak)", default: "auto" },
      seed: { description: "Variation number (shifts shapes/colors)", default: 1 },
    },
    build: buildWallArt,
  }),
  gallery_wall: def({
    description: "Arrangement of 7 framed artworks filling the box (WALL-MOUNTED: back at +Y, set elevation ~1.0).",
    defaults: { width: 1.6, depth: 0.03, height: 1.1 },
    slots: ART_SLOTS,
    options: {
      frame: { description: "mixed | thin_black | oak | gold | none", default: "mixed" },
      seed: { description: "Variation number", default: 1 },
    },
    build: buildGalleryWall,
  }),
  floating_shelf: def({
    description: "Floating wall shelf; height includes decor on it (WALL-MOUNTED: back at +Y, elevation = shelf underside).",
    defaults: { width: 0.9, depth: 0.22, height: 0.32 },
    slots: { shelf: "wood_oak", ...DECOR_SLOTS },
    options: { decor: { description: "Books, vase and a small plant on the shelf", default: true } },
    build: buildFloatingShelf,
  }),
  wall_shelves: def({
    description: "Floor-standing shelving against a wall: style ladder (leaning, shelves get shallower) or grid (cube unit), with decor.",
    defaults: { width: 0.8, depth: 0.35, height: 1.8 },
    slots: { shelf: "wood_oak", basket: "wicker", ...DECOR_SLOTS },
    options: {
      style: { description: "ladder | grid", default: "ladder" },
      decor: { description: "Books, vases, plants, baskets", default: true },
    },
    build: buildWallShelves,
  }),
  vase: def({
    description: "Decorative vase; height includes stems (branches = eucalyptus, flowers, pampas). Put on tables via elevation.",
    defaults: { width: 0.24, depth: 0.24, height: 0.55 },
    slots: { vase: "ceramic_white", stems: "wood_walnut", foliage: "plant_olive", flowers: "petal_pink" },
    options: {
      shape: { description: "bottle | bulb | cylinder", default: "bulb" },
      stems: { description: "none | branches | flowers | pampas", default: "branches" },
    },
    build: buildVase,
  }),
  books_stack: def({
    description: "Stack of coffee-table books with an object or candle on top.",
    defaults: { width: 0.26, depth: 0.2, height: 0.16 },
    slots: { book_a: "art_navy", book_b: "art_cream", book_c: "art_terracotta", pages: "paper_white", topper: "metal_brass" },
    options: { topper: { description: "none | object | candle", default: "object" } },
    build: buildBooksStack,
  }),
  decor_bowl: def({
    description: "Wide decorative bowl (wood by default), optionally with three orbs.",
    defaults: { width: 0.34, depth: 0.34, height: 0.1 },
    slots: { bowl: "wood_walnut", orbs: "metal_brass", orbs_b: "ceramic_white" },
    options: { contents: { description: "none | orbs", default: "none" } },
    build: buildDecorBowl,
  }),
  candle_set: def({
    description: "Three pillar candles of different heights on a small tray, lit by default.",
    defaults: { width: 0.3, depth: 0.12, height: 0.24 },
    slots: { wax: "wax", flame: "emissive_light", tray: "marble_white" },
    options: { lit: { description: "Glowing flames", default: true }, tray: { description: "Marble tray", default: true } },
    build: buildCandleSet,
  }),
  cushion: def({
    description: "Throw pillow standing upright, leaning back (front -Y); size via width/height (0.45 std, 0.55 large, 0.55x0.3 lumbar). Place on sofas with elevation = seat height.",
    defaults: { width: 0.45, depth: 0.16, height: 0.45 },
    slots: { fabric: "velvet_rust", piping: "fabric_beige" },
    options: {
      style: { description: "plain | piped | tufted", default: "plain" },
      shape: { description: "square | round", default: "square" },
    },
    build: buildCushion,
  }),
  throw_blanket: def({
    description: "Knit throw. draped: hangs over a support running along Y (sofa arm / chair back) whose top is at h; folded: folded runner on top (bed end, h = mattress top) with a flap over -Y.",
    defaults: { width: 0.4, depth: 0.7, height: 0.65 },
    slots: { fabric: "knit_cream" },
    options: { style: { description: "draped | folded", default: "draped" } },
    build: buildThrowBlanket,
  }),
  wall_clock: def({
    description: "Round wall clock (WALL-MOUNTED: back at +Y, set elevation ~1.8).",
    defaults: { width: 0.4, depth: 0.05, height: 0.4 },
    slots: { frame: "metal_black", face: "plastic_white", hands: "metal_black" },
    build: buildWallClock,
  }),
  sculpture: def({
    description: "Abstract tabletop sculpture on a plinth: form ring | pebbles | twist.",
    defaults: { width: 0.24, depth: 0.16, height: 0.42 },
    slots: { main: "ceramic_white", base: "marble_black" },
    options: { form: { description: "ring | pebbles | twist", default: "ring" } },
    build: buildSculpture,
  }),
  tray_with_decor: def({
    description: "Decorative tray with candle, bud vase and a small book stack (coffee tables, ottomans).",
    defaults: { width: 0.45, depth: 0.28, height: 0.2 },
    slots: { tray: "wood_walnut", wax: "wax", vase: "ceramic_black", book_a: "art_sage", book_b: "art_cream", pages: "paper_white" },
    build: buildTrayWithDecor,
  }),
  lantern: def({
    description: "Decorative glass lantern with a lit candle (floor or table).",
    defaults: { width: 0.24, depth: 0.24, height: 0.48 },
    slots: { frame: "metal_black", glass: "glass", wax: "wax", flame: "emissive_light" },
    build: buildLantern,
  }),
  plant_large: def({
    description: "Large indoor plant in a nice pot (footprint = foliage spread): species fiddle_leaf | monstera | snake_plant | olive_tree | palm; pot round | cylinder | tapered | square | basket.",
    defaults: { width: 0.75, depth: 0.75, height: 1.6 },
    slots: { pot: "ceramic_white", basket: "wicker", soil: "dirt", stem: "bark", foliage: "plant_green", foliage_alt: "plant_olive" },
    options: {
      species: { description: "fiddle_leaf | monstera | snake_plant | olive_tree | palm", default: "fiddle_leaf" },
      pot: { description: "round | cylinder | tapered | square | basket", default: "round" },
    },
    build: buildPlantLarge,
  }),
  hanging_plant: def({
    description: "Hanging pot with trailing vines on cords; z = h is the ceiling hook (like ceiling_light).",
    defaults: { width: 0.45, depth: 0.45, height: 0.9 },
    slots: { pot: "ceramic_white", cord: "fabric_beige", foliage: "plant_green" },
    build: buildHangingPlant,
  }),
  mirror_round: def({
    description: "Round (oval if w != h) framed wall mirror (WALL-MOUNTED: back at +Y, set elevation).",
    defaults: { width: 0.7, depth: 0.03, height: 0.7 },
    slots: { frame: "metal_brass", mirror: "mirror" },
    options: { frame_width: { description: "Frame width in meters", default: 0.025 } },
    build: (mb, s) => buildShapedMirror(mb, s, "round"),
  }),
  mirror_arched: def({
    description: "Arched (rounded top) framed wall mirror (WALL-MOUNTED: back at +Y, set elevation).",
    defaults: { width: 0.7, depth: 0.03, height: 1.1 },
    slots: { frame: "metal_brass", mirror: "mirror" },
    options: { frame_width: { description: "Frame width in meters", default: 0.025 } },
    build: (mb, s) => buildShapedMirror(mb, s, "arched"),
  }),
  mirror_full_length: def({
    description: "Full-length floor mirror leaning against the wall (+Y); lean=false hangs it flat (back at +Y).",
    defaults: { width: 0.6, depth: 0.12, height: 1.75 },
    slots: { frame: "metal_black", mirror: "mirror" },
    options: { lean: { description: "Lean against the wall (bottom out at the front)", default: true }, frame_width: { description: "Frame width in meters", default: 0.03 } },
    build: (mb, s) => buildShapedMirror(mb, s, "rect"),
  }),
  console_table: def({
    description: "Slim console table: wood top on a thin metal frame with a lower shelf (entries, behind sofas).",
    defaults: { width: 1.2, depth: 0.35, height: 0.8 },
    slots: { top: "wood_walnut", frame: "metal_brass", shelf: "wood_walnut" },
    options: { shelf: { description: "Lower shelf", default: true } },
    build: buildConsoleTable,
  }),
  sideboard: def({
    description: "Mid-century credenza on splayed legs with fluted (or plain) doors.",
    defaults: { width: 1.8, depth: 0.45, height: 0.75 },
    slots: { body: "wood_walnut", legs: "wood_walnut", handles: "metal_brass" },
    options: {
      fronts: { description: "fluted | plain", default: "fluted" },
      doors: { description: "Number of doors (auto ~0.45 m)", default: "auto" },
    },
    build: buildSideboard,
  }),
  bar_cart: def({
    description: "Brass bar cart with two glass shelves, wheels at -X, bottles and glasses.",
    defaults: { width: 0.8, depth: 0.45, height: 0.85 },
    slots: { frame: "metal_brass", shelves: "glass", wheels: "rubber_black", bottles: "glass_amber", bottles_b: "glass_green", book_a: "art_navy", book_b: "art_cream", pages: "paper_white" },
    build: buildBarCart,
  }),
  lounge_chair: def({
    description: "Mid-century lounge chair: plywood shells with leather cushions on a swivel star base.",
    defaults: { width: 0.85, depth: 0.85, height: 0.85 },
    slots: { shell: "wood_walnut", cushions: "leather_black", base: "metal_black" },
    build: buildLoungeChair,
  }),
  wingback_chair: def({
    description: "Wingback armchair with rolled arms, tall back and wings, on turned legs.",
    defaults: { width: 0.85, depth: 0.9, height: 1.15 },
    slots: { body: "velvet_emerald", legs: "wood_walnut" },
    build: buildWingbackChair,
  }),
  accent_chair: def({
    description: "Curved barrel accent chair (boucle) with wraparound back on a plinth.",
    defaults: { width: 0.75, depth: 0.72, height: 0.75 },
    slots: { body: "fabric_boucle", legs: "wood_oak" },
    build: buildAccentChair,
  }),
  ottoman: def({
    description: "Ottoman / pouf: style pouf (knit, round) | round (upholstered drum on legs) | square.",
    defaults: { width: 0.5, depth: 0.5, height: 0.42 },
    slots: { fabric: "knit_cream", legs: "wood_oak" },
    options: { style: { description: "pouf | round | square", default: "pouf" } },
    build: buildOttoman,
  }),
  daybed: def({
    description: "Upholstered daybed: back along +Y, rolled arms, mattress, bolsters and pillows.",
    defaults: { width: 2.0, depth: 0.95, height: 0.8 },
    slots: { frame: "fabric_beige", legs: "wood_walnut", mattress: "linen_white", pillows: "fabric_white", cushions: "velvet_rust" },
    build: buildDaybed,
  }),
  bedding: def({
    description: "Made-up mattress (mattress, duvet with folded edge, pillows at +Y) to dress a bed frame sold without bedding, e.g. an IKEA frame: same position and facing as the frame, elevation = the frame's slat height.",
    defaults: { width: 1.8, depth: 2.0, height: 0.22 },
    slots: { mattress: "linen_white", duvet: "linen_natural", pillows: "linen_white" },
    options: { pillows: { description: "Pillows at the head end", default: true } },
    build(mb, s) {
      mattressSet(mb, s.materials, -s.width / 2, s.width / 2, -s.depth / 2, s.depth / 2, 0, s.height * 0.75, s.options.pillows !== false);
    },
  }),
  platform_bed: def({
    description: "Low floating platform bed with wide headboard (+Y); nightstands=true builds integrated side shelves (width then includes them, e.g. 2.6).",
    defaults: { width: 1.8, depth: 2.2, height: 0.9 },
    slots: { frame: "wood_oak", headboard: "fabric_beige", handles: "metal_brass", mattress: "linen_white", duvet: "fabric_beige", pillows: "fabric_white" },
    options: { nightstands: { description: "Integrated floating nightstands on both sides", default: false } },
    build: buildPlatformBed,
  }),
  canopy_bed: def({
    description: "Four-poster canopy bed with top rails, headboard and gathered drapes at the posts.",
    defaults: { width: 1.8, depth: 2.2, height: 2.1 },
    slots: { frame: "metal_black", headboard: "fabric_beige", mattress: "linen_white", duvet: "fabric_gray", pillows: "linen_white", drapes: "linen_white" },
    options: { drapes: { description: "Gathered drapes at each post", default: true } },
    build: buildCanopyBed,
  }),
  dining_bench: def({
    description: "Dining bench: thick wood slab on splayed legs (optional cushion).",
    defaults: { width: 1.4, depth: 0.38, height: 0.46 },
    slots: { top: "wood_oak", legs: "wood_oak", cushion: "fabric_beige" },
    options: { cushion: { description: "Upholstered pad", default: false } },
    build: buildDiningBench,
  }),
  round_dining_table: def({
    description: "Round (oval if w != d) dining table on a tulip or pedestal base.",
    defaults: { width: 1.2, depth: 1.2, height: 0.75 },
    slots: { top: "wood_oak", base: "plastic_white" },
    options: { base: { description: "tulip | pedestal", default: "tulip" } },
    build: buildRoundDiningTable,
  }),
  dressing_table: def({
    description: "Vanity / dressing table with a drawer and a mirror on uprights; height includes the mirror.",
    defaults: { width: 1.0, depth: 0.45, height: 1.45 },
    slots: { body: "wood_painted_white", handles: "metal_brass", mirror: "mirror", vase: "ceramic_blush" },
    options: { mirror: { description: "round | arched | rect", default: "round" } },
    build: buildDressingTable,
  }),
  filing_cabinet: def({
    description: "Metal filing cabinet with drawers, bar handles and label holders.",
    defaults: { width: 0.47, depth: 0.62, height: 1.02 },
    slots: { body: "plastic_gray", handles: "chrome" },
    options: { drawers: { description: "Number of drawers (auto ~0.32 m)", default: "auto" } },
    build: buildFilingCabinet,
  }),
  crib: def({
    description: "Baby crib: slatted long sides (front -Y), solid curved end panels, mattress and blanket.",
    defaults: { width: 1.3, depth: 0.7, height: 0.95 },
    slots: { frame: "wood_painted_white", mattress: "linen_white", blanket: "knit_cream" },
    build: buildCrib,
  }),
  toy_box: def({
    description: "Toy chest with hinged lid (open shows toys) and side handles.",
    defaults: { width: 0.75, depth: 0.42, height: 0.85 },
    slots: { box: "wood_painted_white", accent: "rubber_black", toy_a: "car_paint_red", toy_b: "car_paint_blue", toy_c: "art_mustard" },
    options: { open: { description: "Lid open with toys peeking out (height includes the raised lid)", default: true } },
    build: buildToyBox,
  }),
  kids_bed: def({
    description: "Montessori house bed: low frame and mattress inside a house-shaped frame with a gable roof.",
    defaults: { width: 1.0, depth: 2.0, height: 1.6 },
    slots: { frame: "wood_pine", mattress: "linen_white", duvet: "art_sky", pillows: "fabric_white" },
    build: buildKidsBed,
  }),
  towel_rail: def({
    description: "Heated ladder towel rail with a folded towel (WALL-MOUNTED: back at +Y, set elevation ~0.15).",
    defaults: { width: 0.5, depth: 0.12, height: 0.9 },
    slots: { metal: "chrome", towel: "towel_white" },
    options: { towel: { description: "Towel over a bar", default: true } },
    build: buildTowelRail,
  }),
  towel_hook_set: def({
    description: "Wooden hook rail with hanging towels; plate at the top of the box (WALL-MOUNTED: back at +Y, elevation ~1.1).",
    defaults: { width: 0.5, depth: 0.08, height: 0.6 },
    slots: { plate: "wood_oak", hooks: "metal_black", towel: "towel_white", towel_b: "towel_gray" },
    options: { towels: { description: "Hang towels on the outer hooks", default: true } },
    build: buildTowelHooks,
  }),
  toilet_roll_holder: def({
    description: "Toilet roll holder with roll (WALL-MOUNTED: back at +Y, elevation ~0.65).",
    defaults: { width: 0.18, depth: 0.13, height: 0.13 },
    slots: { metal: "chrome", paper: "paper_white", core: "art_cream" },
    build: buildToiletRollHolder,
  }),
  bath_mat: def({
    description: "Ribbed bath mat (flat on the floor).",
    defaults: { width: 0.8, depth: 0.5, height: 0.015 },
    slots: { main: "towel_white" },
    build: buildBathMat,
  }),
  soap_dispenser: def({
    description: "Pump soap dispenser; set=true adds a toothbrush tumbler and soap dish (place on a vanity via elevation).",
    defaults: { width: 0.3, depth: 0.1, height: 0.2 },
    slots: { bottle: "ceramic_black", pump: "metal_brass", tumbler: "ceramic_black", brush_a: "plastic_white", brush_b: "art_sage", soap: "art_cream" },
    options: { set: { description: "Add tumbler with toothbrushes and soap dish", default: true } },
    build: buildSoapDispenser,
  }),
  freestanding_bathtub: def({
    description: "Freestanding bathtub: style modern (seamless stadium tub) | clawfoot (roll-top on four feet with deck tap).",
    defaults: { width: 1.7, depth: 0.8, height: 0.6 },
    slots: { body: "ceramic_white", feet: "metal_brass", faucet: "chrome" },
    options: { style: { description: "modern | clawfoot", default: "modern" } },
    build: buildFreestandingBathtub,
  }),
  shower_curtain: def({
    description: "Shower curtain on a rod with rings; width = rod length.",
    defaults: { width: 1.6, depth: 0.1, height: 2.0 },
    slots: { fabric: "linen_white", rod: "chrome" },
    build: buildShowerCurtain,
  }),
  kettle: def({
    description: "Electric kettle on its base (spout -X, handle +X); place on counters via elevation.",
    defaults: { width: 0.26, depth: 0.17, height: 0.25 },
    slots: { body: "metal_steel", accent: "plastic_black" },
    build: buildKettle,
  }),
  coffee_machine: def({
    description: "Espresso machine with group head, portafilter, drip tray, gauge and cup (front -Y).",
    defaults: { width: 0.3, depth: 0.38, height: 0.38 },
    slots: { body: "metal_steel", accent: "plastic_black", metal: "chrome", cup: "ceramic_white" },
    build: buildCoffeeMachine,
  }),
  fruit_bowl: def({
    description: "Bowl of fruit: apples, oranges, a lemon and bananas.",
    defaults: { width: 0.32, depth: 0.32, height: 0.17 },
    slots: { bowl: "ceramic_white", fruit_a: "fruit_red", fruit_b: "fruit_orange", fruit_c: "fruit_yellow", stem: "wood_walnut" },
    build: buildFruitBowl,
  }),
  cutting_boards: def({
    description: "Three cutting boards leaning against the backsplash (+Y).",
    defaults: { width: 0.45, depth: 0.1, height: 0.45 },
    slots: { board_a: "wood_oak", board_b: "wood_walnut", board_c: "marble_white" },
    build: buildCuttingBoards,
  }),
  utensil_jar: def({
    description: "Ceramic crock with wooden spoons, spatula, ladle and whisk.",
    defaults: { width: 0.13, depth: 0.13, height: 0.34 },
    slots: { jar: "ceramic_white", wood: "wood_oak", metal: "metal_steel" },
    build: buildUtensilJar,
  }),
  plant_herbs: def({
    description: "Three potted kitchen herbs on a small tray (windowsill / counter).",
    defaults: { width: 0.42, depth: 0.14, height: 0.26 },
    slots: { pot: "terracotta", soil: "dirt", foliage: "plant_green", tray: "wood_oak" },
    build: buildPlantHerbs,
  }),
  coat_rack: def({
    description: "Standing coat tree on a tripod with hooks; coats=true hangs a coat, a jacket and a hat.",
    defaults: { width: 0.6, depth: 0.6, height: 1.8 },
    slots: { wood: "wood_walnut", coat: "fabric_beige", coat_b: "art_navy", hat: "leather_tan" },
    options: { coats: { description: "Hang coats and a hat", default: true } },
    build: buildCoatRack,
  }),
  shoe_cabinet: def({
    description: "Slim entry shoe cabinet with tilt-out flaps on short legs.",
    defaults: { width: 0.8, depth: 0.26, height: 1.0 },
    slots: { body: "wood_painted_white", top: "wood_oak", handles: "metal_brass" },
    options: { flaps: { description: "Number of flaps (auto)", default: "auto" } },
    build: buildShoeCabinet,
  }),
  umbrella_stand: def({
    description: "Umbrella stand with two closed umbrellas (height includes the umbrellas).",
    defaults: { width: 0.26, depth: 0.26, height: 0.95 },
    slots: { stand: "metal_black", umbrella: "art_navy", umbrella_b: "art_terracotta", shaft: "chrome", handle: "wood_walnut" },
    build: buildUmbrellaStand,
  }),
  laundry_basket: def({
    description: "Woven laundry basket with a liner and a heap of clothes.",
    defaults: { width: 0.48, depth: 0.36, height: 0.55 },
    slots: { basket: "wicker", liner: "linen_white", laundry_a: "fabric_blue", laundry_b: "fabric_white", laundry_c: "fabric_gray" },
    build: buildLaundryBasket,
  }),
  ironing_board: def({
    description: "Ironing board on X legs with an iron resting on it (length along X).",
    defaults: { width: 1.3, depth: 0.38, height: 0.9 },
    slots: { cover: "fabric_blue", frame: "metal_steel", iron: "plastic_white", iron_plate: "metal_steel" },
    options: { iron: { description: "Iron on the board (board top at h - 0.055)", default: true } },
    build: buildIroningBoard,
  }),
  // hospitals, clinics, laboratories (elements/medical.ts)
  ...Object.fromEntries(Object.entries(MEDICAL_FURNITURE).map(([k, t]) => [k, def(t)])),
};

export function listFurniture(): {
  type: string;
  description: string;
  defaults: { width: number; depth: number; height: number };
  slots: Record<string, string>;
  options: Record<string, FurnitureOption>;
}[] {
  return Object.entries(FURNITURE).map(([type, t]) => ({
    type,
    description: t.description,
    defaults: { ...t.defaults },
    slots: { ...t.slots },
    options: { ...(t.options ?? {}) },
  }));
}
