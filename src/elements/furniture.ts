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
import { m4, v3, type Vec2, type Vec3 } from "../geometry/math.js";

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
