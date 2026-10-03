/**
 * Per-kind cabinet module builders. Everything is in the LEG frame (see layout.ts): x left->right facing
 * the fronts, y toward the wall (fronts at y = -depth), z up from the floor finish.
 * Static geometry goes into `c.mb`; doors / drawers / appliance doors are emitted as LeafSpecs (built in
 * their own pivot frame) and become separate "door_leaf" nodes.
 */
import { m4, type Vec2, type Vec3 } from "../../geometry/math.js";
import { MeshBuilder } from "../../geometry/mesh.js";
import type { Dims, Placed, ResolvedRun } from "./layout.js";
import {
  CT, EP, FT, G, barLength, books, bottle, carcass, cavity, clamp, clothes, cushion, cylX, cylY, dishes, ellipse, folded, frontPanel, handle,
  loft, provisions, roundRect, shoes, slab, type FrontStyle, type HandleStyle,
} from "./parts.js";

export interface Mats {
  front: string;
  carcass: string;
  worktop: string;
  backsplash: string;
  handle: string;
  plinth: string;
  glass: string;
  sink: string;
  tap: string;
  appliance: string;
  accent: string;
  cushion: string;
}

export interface LeafSpec {
  name: string;
  motion: "hinged" | "slide";
  /** Hinged leaves: which edge carries the hinge. */
  hinge?: "left" | "right" | "bottom" | "top";
  /** Pivot in the leg frame. */
  pivot: Vec3;
  mb: MeshBuilder;
  /** Slide direction in the leg frame (x, y) and distance. */
  slideDir?: Vec2;
  slideDist?: number;
  maxAngle?: number;
  open: boolean;
  role: string;
}

export type WorktopCut = { kind: "hole"; outline: Vec2[] } | { kind: "notch"; x0: number; x1: number; yBack: number };

export interface ModCtx {
  r: ResolvedRun;
  d: Dims;
  p: Placed;
  M: Mats;
  mb: MeshBuilder;
  leaves: LeafSpec[];
  cuts: WorktopCut[];
  R: () => number;
  style: FrontStyle;
  handle: HandleStyle;
  /** Doors are sliding panels in front of the run (wardrobes): no hinged doors, carcass set back. */
  sliding: boolean;
  /** Front plane (y of the front faces). */
  yFront: number;
  decor: boolean;
}

const SLIDE_SETBACK = 0.09;

// ---------------------------------------------------------------------------------------------
// shared pieces

/** Front x range (inside exposed end panels). */
function frontX(c: ModCtx): [number, number] {
  return [c.p.x0 + (c.p.exposedL ? EP : 0), c.p.x1 - (c.p.exposedR ? EP : 0)];
}

/** Carcass top under the worktop (base) or the module top. */
function topZ(c: ModCtx): number {
  return c.p.row === "base" ? c.d.height - c.d.wt : c.p.z1;
}

/** Top of the fronts (gola channels steal 3 cm under the worktop). */
function frontTop(c: ModCtx): number {
  const zt = topZ(c);
  if (c.p.row === "base") return zt - (c.handle === "gola" ? 0.032 : 0.002);
  return zt;
}

const effHandle = (c: ModCtx, row: string): HandleStyle => (c.handle === "gola" && row !== "base" ? "push" : c.handle);

/** Carcass + end panels. Returns the interior x range. */
function shell(c: ModCtx, o: { shelves?: number[]; mat?: string; top?: boolean; back?: boolean } = {}): [number, number] {
  const p = c.p;
  const zb = p.z0, zt = topZ(c);
  const yF = c.yFront + FT + 0.001 + (c.sliding ? SLIDE_SETBACK - FT - 0.001 : 0);
  const mat = o.mat ?? c.M.carcass;
  carcass(c.mb, mat, p.x0 + (p.exposedL ? EP : 0), p.x1 - (p.exposedR ? EP : 0), zb, zt, { yF, shelves: o.shelves, top: o.top, back: o.back });
  endPanels(c);
  return [p.x0 + (p.exposedL ? EP : 0) + CT, p.x1 - (p.exposedR ? EP : 0) - CT];
}

function endPanels(c: ModCtx) {
  const p = c.p;
  const floor = p.row === "upper" ? p.z0 : p.row === "base" && c.d.elevation > 0 ? p.z0 : 0;
  const top = topZ(c);
  const yF = c.yFront;
  // open shelving is clad in its own (accent) material, closed cabinets in the front material
  const mat = ["open_shelf", "tall_open", "upper_open", "wine_rack"].includes(p.kind) ? c.M.accent : c.M.front;
  if (p.exposedL) c.mb.box(mat, [p.x0, yF, floor], [p.x0 + EP, -0.002, top]);
  if (p.exposedR) c.mb.box(mat, [p.x1 - EP, yF, floor], [p.x1, -0.002, top]);
}

function leafMB(): MeshBuilder {
  return new MeshBuilder();
}

function frontMats(c: ModCtx) {
  return { front: c.M.front, glass: c.M.glass, handle: c.M.handle };
}

/**
 * Hinged door covering [x0,x1] x [z0,z1] on the front plane. `role` decides the handle position.
 * Pivot = front outer corner on the hinge side, so the leaf stays within its own width when it opens.
 */
function door(c: ModCtx, x0: number, x1: number, z0: number, z1: number, hinge: "left" | "right", role: "base" | "tall" | "upper", style: FrontStyle = c.style, name = "door") {
  const a = x0 + G, b = x1 - G, za = z0 + G, zz = z1 - G;
  const w = b - a, h = zz - za;
  if (w < 0.03 || h < 0.03) return;
  const lb = leafMB();
  const ox = hinge === "left" ? 0 : -w;
  frontPanel(lb, style, frontMats(c), ox, ox + w, 0, h);
  const hs = effHandle(c, role);
  const free = hinge === "left" ? w - 0.035 : -w + 0.035;
  const absZ = (z: number) => za + z;
  if (hs === "bar") {
    const L = role === "tall" ? clamp(h * 0.3, 0.2, 0.6) : 0.16;
    let hz: number;
    if (role === "upper") hz = 0.06 + L / 2;
    else if (role === "base") hz = h - 0.06 - L / 2;
    else hz = clamp(1.05 - za, L / 2 + 0.06, h - L / 2 - 0.06); // ~1.05 m above the floor
    if (role === "tall" && absZ(h) > 2.0 && za > 1.4) hz = 0.06 + L / 2; // top doors of a tall stack
    handle(lb, "bar", c.M.handle, free, hz, L, true);
  } else if (hs === "knob") {
    const hz = role === "upper" ? 0.06 : role === "base" ? h - 0.06 : clamp(1.05 - za, 0.06, h - 0.06);
    handle(lb, "knob", c.M.handle, free, hz, 0, false);
  } else if (hs === "edge") {
    const top = role !== "upper";
    handle(lb, "edge", c.M.handle, hinge === "left" ? w - 0.09 : -w + 0.09, 0, 0.12, false, top ? h : 0, top);
  }
  c.leaves.push({ name, motion: "hinged", hinge, pivot: [hinge === "left" ? a : b, c.yFront, za], mb: lb, maxAngle: 105, open: c.p.open, role });
}

/** Pair of doors meeting in the middle (or one door) over [x0,x1]. */
function doors(c: ModCtx, x0: number, x1: number, z0: number, z1: number, role: "base" | "tall" | "upper", count?: number, style?: FrontStyle) {
  const n = count ?? (x1 - x0 > 0.62 ? 2 : 1);
  if (n <= 0) return;
  if (n === 1) {
    door(c, x0, x1, z0, z1, c.p.module.hinge ?? defaultHinge(c), role, style);
    return;
  }
  const w = (x1 - x0) / n;
  for (let i = 0; i < n; i++) {
    const hinge = n === 2 ? (i === 0 ? "left" : "right") : i % 2 === 0 ? "left" : "right";
    door(c, x0 + i * w, x0 + (i + 1) * w, z0, z1, hinge, role, style, `door${i + 1}`);
  }
}

/** Single doors open away from the neighbouring counter (tall units) or follow `hinge`. */
function defaultHinge(c: ModCtx): "left" | "right" {
  const p = c.p, r = c.r;
  if (p.kind === "corner") return p.blind === "right" ? "left" : "right";
  const leg = r.legs[p.leg];
  const row = (p.row === "upper" ? r.uppers : r.base).filter((q) => q.leg === p.leg && q.kind !== "filler").sort((a, b) => a.x0 - b.x0);
  const k = row.indexOf(p);
  // next to a corner: hinge away from it so the open door doesn't block the corner unit
  if (k === 0 && leg.cornerStart?.interior) return "right";
  if (k === row.length - 1 && row[k + 1] === undefined && leg.cornerEnd?.interior) return "left";
  // against a wall at the run end: fridges open away from it (full 90°+ opening), cupboards toward it
  const wallL = k === 0 && p.leg === 0 && !r.freeStart && p.x0 <= leg.start + 0.06;
  const wallR = k === row.length - 1 && p.leg === r.legs.length - 1 && !r.freeEnd && p.x1 >= leg.end - 0.06;
  if (wallL) return p.kind === "fridge" ? "right" : "left";
  if (wallR) return p.kind === "fridge" ? "left" : "right";
  if (p.row === "tall") {
    const list = c.r.base.filter((q) => q.leg === p.leg).sort((a, b) => a.x0 - b.x0);
    const k = list.indexOf(p);
    const next = list[k + 1], prev = list[k - 1];
    if (next && next.row === "base" && !(prev && prev.row === "base")) return "left";
    if (prev && prev.row === "base") return "right";
  }
  return "left";
}

/** Drawer: front + box. Pivot at the front bottom centre; it slides out along -y (toward the room). */
function drawer(c: ModCtx, x0: number, x1: number, z0: number, z1: number, o: { inset?: number; boxDepth?: number; handle?: boolean; style?: FrontStyle; name?: string; inner?: [number, number] } = {}) {
  const a = x0 + G, b = x1 - G, za = z0 + G, zz = z1 - G;
  const w = b - a, h = zz - za;
  if (w < 0.03 || h < 0.03) return;
  const lb = leafMB();
  frontPanel(lb, o.style ?? c.style, frontMats(c), -w / 2, w / 2, 0, h);
  const hs = effHandle(c, "base");
  if (o.handle !== false) {
    if (hs === "bar") handle(lb, "bar", c.M.handle, 0, h > 0.2 ? h - 0.06 : h / 2, barLength(w, false), false);
    else if (hs === "knob") handle(lb, "knob", c.M.handle, 0, h > 0.2 ? h - 0.06 : h / 2, 0, false);
    else if (hs === "edge") handle(lb, "edge", c.M.handle, 0, 0, Math.min(0.2, w * 0.35), false, h, true);
  }
  // drawer box: sides, back, bottom (open top)
  const inner = o.inner ?? [x0 + CT + 0.006, x1 - CT - 0.006];
  const bx0 = inner[0] - (a + b) / 2, bx1 = inner[1] - (a + b) / 2;
  const bd = o.boxDepth ?? Math.max(0.2, c.p.depth - FT - 0.07);
  const bh = clamp(h - 0.05, 0.06, 0.24);
  const y0 = FT + 0.004, y1 = y0 + bd, t = 0.012, zb = 0.025;
  const m = c.M.carcass;
  lb.box(m, [bx0, y0, zb], [bx1, y1, zb + t]);
  lb.box(m, [bx0, y0, zb + t], [bx0 + t, y1, zb + bh]);
  lb.box(m, [bx1 - t, y0, zb + t], [bx1, y1, zb + bh]);
  lb.box(m, [bx0 + t, y1 - t, zb + t], [bx1 - t, y1, zb + bh]);
  lb.box(m, [bx0 + t, y0, zb + t], [bx1 - t, y0 + t, zb + bh * 0.85]);
  const inset = o.inset ?? 0;
  c.leaves.push({
    name: o.name ?? "drawer",
    motion: "slide",
    pivot: [(a + b) / 2, c.yFront + inset, za],
    mb: lb,
    slideDir: [0, -1],
    slideDist: Math.round(bd * 0.9 * 1000) / 1000,
    open: c.p.open,
    role: "drawer",
  });
}

function drawerStack(c: ModCtx, x0: number, x1: number, z0: number, z1: number, n: number, weights?: number[]) {
  const W = weights ?? (n === 1 ? [1] : n === 2 ? [1, 1] : n === 3 ? [0.6, 1, 1] : [0.5, ...Array(n - 1).fill(1)]);
  const total = W.reduce((s, v) => s + v, 0);
  const gola = c.handle === "gola";
  let z = z1;
  W.forEach((wt, i) => {
    const h = ((z1 - z0) * wt) / total;
    // gola: a recessed channel above every drawer below the first
    const top = gola && i > 0 ? z - 0.03 : z;
    if (gola && i > 0) golaChannel(c, x0, x1, z - 0.03, z);
    drawer(c, x0, x1, z - h, top, { name: `drawer${i + 1}` });
    z -= h;
  });
}

function golaChannel(c: ModCtx, x0: number, x1: number, z0: number, z1: number) {
  const y = c.yFront + 0.026;
  c.mb.box(c.M.handle, [x0, y, z0], [x1, y + 0.02, z1], { skip: ["+y"] });
  c.mb.box(c.M.handle, [x0, c.yFront + FT, z0], [x1, y, z0 + 0.003]);
}

/** Static panel on the front plane (false fronts, blind corner panels). */
function fixedFront(c: ModCtx, x0: number, x1: number, z0: number, z1: number, style: FrontStyle = c.style) {
  c.mb.with(m4.translation(0, c.yFront, 0), () => frontPanel(c.mb, style, frontMats(c), x0 + G, x1 - G, z0 + G, z1 - G));
}

/** Drop-down appliance door (oven, dishwasher). Pivot on the bottom front edge. */
function dropDoor(c: ModCtx, x0: number, x1: number, z0: number, z1: number, build: (lb: MeshBuilder, w: number, h: number) => void, name: string) {
  const a = x0 + G, b = x1 - G, za = z0 + G, zz = z1 - G;
  const lb = leafMB();
  build(lb, b - a, zz - za);
  c.leaves.push({ name, motion: "hinged", hinge: "bottom", pivot: [a, c.yFront, za], mb: lb, maxAngle: 90, open: c.p.open, role: "appliance" });
}

// ---------------------------------------------------------------------------------------------
// module builders

type Builder = (c: ModCtx) => void;

const baseDoors: Builder = (c) => {
  const [fx0, fx1] = frontX(c);
  const zb = c.p.z0, zt = frontTop(c);
  const mid = (zb + topZ(c)) / 2;
  const [ix0, ix1] = shell(c, { shelves: c.p.module.shelves === 0 ? [] : [mid] });
  if (c.handle === "gola") golaChannel(c, fx0, fx1, zt, topZ(c));
  let z1 = zt;
  if (c.p.module.topDrawer) {
    const dh = 0.15;
    drawer(c, fx0, fx1, zt - dh, zt, { name: "drawer1", inner: [ix0 + 0.006, ix1 - 0.006] });
    z1 = zt - dh;
    if (c.handle === "gola") {
      golaChannel(c, fx0, fx1, z1 - 0.03, z1);
      z1 -= 0.03;
    }
  }
  doors(c, fx0, fx1, zb, z1, "base", c.p.module.doors);
  if (c.decor && c.p.open) dishes(c.mb, c.R, ix0, ix1, zb + CT, c.yFront + FT + 0.02, mid - zb - CT - 0.02);
};

const baseDrawers: Builder = (c) => {
  const [fx0, fx1] = frontX(c);
  shell(c);
  const zt = frontTop(c);
  if (c.handle === "gola") golaChannel(c, fx0, fx1, zt, topZ(c));
  drawerStack(c, fx0, fx1, c.p.z0, zt, c.p.module.drawers ?? (c.d.type === "media" || c.d.type === "bench" ? 1 : 3));
};

const openShelf: Builder = (c) => {
  const p = c.p;
  const zb = p.z0, zt = topZ(c);
  const [x0, x1] = [p.x0 + (p.exposedL ? EP : 0), p.x1 - (p.exposedR ? EP : 0)];
  const n = c.p.module.shelves ?? Math.max(1, Math.round((zt - zb) / 0.33) - 1);
  const shelves = Array.from({ length: n }, (_, i) => zb + ((zt - zb) * (i + 1)) / (n + 1) - CT / 2);
  carcass(c.mb, c.M.accent, x0, x1, zb, zt, { yF: c.yFront, shelves, top: p.row !== "base" });
  endPanels(c);
  if (c.decor) {
    const levels = [zb + CT, ...shelves.map((z) => z + CT)];
    levels.forEach((z, i) => {
      const next = i < shelves.length ? shelves[i] : zt - (p.row === "base" ? 0 : CT);
      if (p.row === "upper") dishes(c.mb, c.R, x0 + CT, x1 - CT, z, c.yFront + 0.02, next - z - 0.01);
      else books(c.mb, c.R, x0 + CT, x1 - CT, z, c.yFront + 0.03, next - z - 0.01, 0.65);
    });
  }
};

const wineRack: Builder = (c) => {
  const p = c.p;
  const zb = p.z0, zt = topZ(c);
  const x0 = p.x0 + (p.exposedL ? EP : 0), x1 = p.x1 - (p.exposedR ? EP : 0);
  carcass(c.mb, c.M.accent, x0, x1, zb, zt, { yF: c.yFront, top: p.row !== "base" });
  endPanels(c);
  const ix0 = x0 + CT, ix1 = x1 - CT, iz0 = zb + CT, iz1 = zt - (p.row === "base" ? 0.002 : CT);
  const cols = Math.max(1, Math.floor((ix1 - ix0) / 0.1)), rows = Math.max(1, Math.floor((iz1 - iz0) / 0.1));
  const cw = (ix1 - ix0) / cols, rh = (iz1 - iz0) / rows;
  const t = 0.008, yF = c.yFront + 0.01;
  for (let i = 1; i < cols; i++) c.mb.box(c.M.accent, [ix0 + i * cw - t / 2, yF, iz0], [ix0 + i * cw + t / 2, -0.013, iz1]);
  for (let j = 1; j < rows; j++) c.mb.box(c.M.accent, [ix0, yF, iz0 + j * rh - t / 2], [ix1, -0.013, iz0 + j * rh + t / 2]);
  if (!c.decor) return;
  const mats = ["glass_tinted", "plastic_green", "glass_tinted", "#3a1420"];
  for (let i = 0; i < cols; i++)
    for (let j = 0; j < rows; j++) if (c.R() < 0.8) bottle(c.mb, ix0 + (i + 0.5) * cw, yF + 0.005, iz0 + j * rh + 0.04, mats[Math.floor(c.R() * mats.length)]);
};

/** Kitchen tap (gooseneck) standing on z, spout reaching toward the front (-y). */
function tap(mb: MeshBuilder, mat: string, x: number, y: number, z: number, height = 0.32, reach = 0.2) {
  const r = 0.0115;
  mb.cylinder(mat, [x, y, z], 0.027, 0.024, 0.05, 14);
  mb.cylinder(mat, [x, y, z + 0.05], r, r, height - 0.05, 12, { bottom: false, top: false });
  const R = reach / 2, cy = y - R, cz = z + height;
  const seg = 8;
  let prev: Vec3 = [x, y, cz];
  for (let i = 1; i <= seg; i++) {
    const a = (i / seg) * Math.PI;
    const pt: Vec3 = [x, cy + Math.cos(a) * R, cz + Math.sin(a) * R];
    mb.rod(mat, prev, pt, r, 10);
    mb.sphere(mat, pt, r, 8, 5);
    prev = pt;
  }
  mb.cylinder(mat, [x, y - reach, cz - 0.06], r * 1.2, r, 0.06, 10, { top: false });
  // lever
  mb.rod(mat, [x + 0.026, y, z + 0.035], [x + 0.08, y + 0.01, z + 0.06], 0.0065, 8);
}

/** Bowl hanging under a worktop hole: hole at z = top, `depth` deep, inward faces. */
function bowl(mb: MeshBuilder, mat: string, hole: Vec2[], bottomLoop: Vec2[], top: number, depth: number, drain: Vec2, drainMat = "chrome") {
  loft(mb, mat, bottomLoop, top - depth, hole, top, true);
  mb.flat(mat, bottomLoop, top - depth);
  mb.cylinder(drainMat, [drain[0], drain[1], top - depth], 0.03, 0.03, 0.002, 14, { bottom: false });
}

const sink: Builder = (c) => {
  const p = c.p, m = p.module;
  const [fx0, fx1] = frontX(c);
  shell(c, { top: false });
  const zb = p.z0, zt = frontTop(c), top = c.d.height, wb = c.d.height - c.d.wt;
  const w = fx1 - fx0, cx = (fx0 + fx1) / 2;
  const bowls = m.bowls ?? (w >= 0.88 ? 2 : 1);
  if (m.sinkStyle === "farmhouse") {
    // ceramic apron-front sink sitting in a notch of the worktop
    const sx0 = fx0 + 0.015, sx1 = fx1 - 0.015;
    const sy0 = c.yFront - 0.012, sy1 = -0.075;
    const sz0 = top - 0.25;
    c.cuts.push({ kind: "notch", x0: sx0, x1: sx1, yBack: sy1 });
    const outline: Vec2[] = [[sx0, sy0], [sx1, sy0], [sx1, sy1], [sx0, sy1]];
    const holes: Vec2[][] = [];
    const inner = bowls === 2 ? [[sx0 + 0.03, (sx0 + sx1) / 2 - 0.02], [(sx0 + sx1) / 2 + 0.02, sx1 - 0.03]] : [[sx0 + 0.03, sx1 - 0.03]];
    for (const [a, b] of inner) holes.push(roundRect((a + b) / 2, (sy0 + sy1) / 2, b - a, sy1 - sy0 - 0.06, 0.04));
    slab(c.mb, c.M.sink, outline, holes, sz0, top, false);
    for (const h of holes) {
      const ctr = h.reduce((s, q) => [s[0] + q[0] / h.length, s[1] + q[1] / h.length] as Vec2, [0, 0] as Vec2);
      const bottomLoop = h.map((q) => [ctr[0] + (q[0] - ctr[0]) * 0.94, ctr[1] + (q[1] - ctr[1]) * 0.92] as Vec2);
      bowl(c.mb, c.M.sink, h, bottomLoop, top, 0.21, ctr);
    }
    doors(c, fx0, fx1, zb, sz0 - 0.004, "base", m.doors);
    tap(c.mb, c.M.tap, cx, -0.045, top, 0.34, 0.22);
    return;
  }
  // undermount stainless bowl(s)
  const by0 = c.yFront + 0.085, by1 = -0.095, bd = by1 - by0;
  const spans: [number, number][] =
    bowls === 2
      ? [[cx - (w - 0.14) / 2, cx - 0.025], [cx + 0.025, cx + (w - 0.14) / 2]]
      : [[cx - Math.min(w - 0.12, 0.72) / 2, cx + Math.min(w - 0.12, 0.72) / 2]];
  for (const [a, b] of spans) {
    const hole = roundRect((a + b) / 2, (by0 + by1) / 2, b - a, bd, 0.03);
    c.cuts.push({ kind: "hole", outline: hole });
    const bottomLoop = roundRect((a + b) / 2, (by0 + by1) / 2, b - a - 0.02, bd - 0.02, 0.025);
    bowl(c.mb, c.M.sink, hole, bottomLoop, wb, 0.2, [(a + b) / 2, (by0 + by1) / 2 + 0.06]);
  }
  // waste pipes under the bowls (visible when the doors open)
  for (const [a, b] of spans) {
    const x = (a + b) / 2, y = (by0 + by1) / 2 + 0.06;
    c.mb.cylinder("plastic_white", [x, y, wb - 0.32], 0.02, 0.02, 0.12, 10);
    cylY(c.mb, "plastic_white", x, y, -0.02, wb - 0.3, 0.02, 0.02, 10);
  }
  tap(c.mb, c.M.tap, cx, -0.05, top);
  let z1 = zt;
  if (m.topDrawer !== false) {
    // tilt-out false front
    fixedFront(c, fx0, fx1, zt - 0.15, zt);
    z1 = zt - 0.15;
  }
  if (c.handle === "gola") golaChannel(c, fx0, fx1, zt, topZ(c));
  doors(c, fx0, fx1, zb, z1, "base", m.doors);
};

const hob: Builder = (c) => {
  const p = c.p, m = p.module;
  const [fx0, fx1] = frontX(c);
  shell(c);
  const zt = frontTop(c), top = c.d.height;
  if (c.handle === "gola") golaChannel(c, fx0, fx1, zt, topZ(c));
  drawerStack(c, fx0, fx1, p.z0, zt, m.drawers ?? 2, m.drawers ? undefined : [0.75, 1]);
  const cx = (fx0 + fx1) / 2, cy = (c.yFront - 0.0) / 2 - 0.01;
  const hw = clamp(fx1 - fx0 - 0.08, 0.3, 0.9), hd = clamp(-c.yFront - 0.08, 0.3, 0.52);
  if ((m.hob ?? "induction") === "induction") {
    c.mb.box("screen_black", [cx - hw / 2, cy - hd / 2, top], [cx + hw / 2, cy + hd / 2, top + 0.005]);
    // cooking zones (printed rings) + touch controls
    const zones: [number, number, number][] = hw > 0.7
      ? [[-0.25, 0.1, 0.11], [-0.25, -0.12, 0.085], [0.05, 0.05, 0.12], [0.26, 0.12, 0.075], [0.26, -0.1, 0.09]]
      : [[-0.15, 0.1, 0.1], [-0.15, -0.12, 0.08], [0.15, 0.1, 0.08], [0.15, -0.1, 0.1]];
    for (const [zx, zy, r] of zones) {
      const s = hw / (hw > 0.7 ? 0.78 : 0.58);
      const ring = ellipse(cx + zx * s, cy + zy, r, r, 28), inner = ellipse(cx + zx * s, cy + zy, r - 0.004, r - 0.004, 28);
      c.mb.flat("plastic_gray", ring, top + 0.0055, false, [inner]);
    }
    for (let i = 0; i < 5; i++) c.mb.box("plastic_gray", [cx - 0.06 + i * 0.03, cy - hd / 2 + 0.02, top + 0.005], [cx - 0.048 + i * 0.03, cy - hd / 2 + 0.032, top + 0.0056]);
  } else {
    c.mb.box(c.M.appliance, [cx - hw / 2, cy - hd / 2, top], [cx + hw / 2, cy + hd / 2, top + 0.008]);
    const burners: [number, number, number][] = hw > 0.7
      ? [[-0.24, 0.1, 0.04], [-0.24, -0.11, 0.03], [0, 0, 0.055], [0.24, 0.1, 0.035], [0.24, -0.11, 0.03]]
      : [[-0.14, 0.1, 0.035], [-0.14, -0.11, 0.03], [0.14, 0.1, 0.03], [0.14, -0.11, 0.045]];
    const s = hw / (hw > 0.7 ? 0.78 : 0.58);
    for (const [bx, by, r] of burners) {
      c.mb.cylinder("metal_black", [cx + bx * s, cy + by, top + 0.008], r * 1.25, r * 1.15, 0.012, 16);
      c.mb.cylinder("metal_black", [cx + bx * s, cy + by, top + 0.02], r * 0.8, r * 0.75, 0.008, 14);
    }
    // cast-iron grates
    const gz = top + 0.035;
    for (const gx of [-1, 1]) {
      const x0 = cx + (gx < 0 ? -hw / 2 + 0.01 : 0.005), x1 = cx + (gx < 0 ? -0.005 : hw / 2 - 0.01);
      for (const y of [cy - hd / 2 + 0.03, cy + hd / 2 - 0.03]) cylX(c.mb, "metal_black", x0, x1, y, gz, 0.004, 6);
      for (const x of [x0, x1, (x0 + x1) / 2]) cylY(c.mb, "metal_black", x, cy - hd / 2 + 0.03, cy + hd / 2 - 0.03, gz, 0.004, 0.004, 6);
      for (const x of [x0, x1]) for (const y of [cy - hd / 2 + 0.03, cy + hd / 2 - 0.03]) c.mb.cylinder("metal_black", [x, y, top + 0.008], 0.005, 0.005, gz - top - 0.008, 6);
    }
    for (let i = 0; i < 4; i++) c.mb.cylinder("metal_black", [cx - hw / 2 + 0.06 + i * 0.04, cy - hd / 2 + 0.018, top + 0.008], 0.013, 0.012, 0.018, 12);
  }
};

/** Built-in oven body + drop-down door filling [x0,x1] x [z0,z1]. */
function oven(c: ModCtx, x0: number, x1: number, z0: number, z1: number, name = "oven") {
  const strip = 0.075;
  const yF = c.yFront, A = c.M.appliance;
  // control panel
  c.mb.box(A, [x0 + G, yF, z1 - strip], [x1 - G, yF + 0.04, z1 - G]);
  c.mb.box("screen_black", [(x0 + x1) / 2 - 0.06, yF - 0.001, z1 - strip + 0.02], [(x0 + x1) / 2 + 0.06, yF, z1 - 0.02]);
  for (const s of [-1, 1]) cylY(c.mb, A, (x0 + x1) / 2 + s * ((x1 - x0) / 2 - 0.09), yF - 0.016, yF, z1 - strip / 2, 0.017, 0.017, 14);
  // cavity
  const cx0 = x0 + 0.045, cx1 = x1 - 0.045, cz0 = z0 + 0.06, cz1 = z1 - strip - 0.03;
  c.mb.box(A, [x0 + G, yF + 0.04, z0 + G], [x0 + 0.045, -0.03, z1 - strip]);
  c.mb.box(A, [x1 - 0.045, yF + 0.04, z0 + G], [x1 - G, -0.03, z1 - strip]);
  c.mb.box(A, [x0 + 0.045, yF + 0.04, z0 + G], [x1 - 0.045, -0.03, cz0]);
  c.mb.box(A, [x0 + 0.045, yF + 0.04, cz1], [x1 - 0.045, -0.03, z1 - strip]);
  cavity(c.mb, "metal_black", [cx0, yF + 0.04, cz0], [cx1, -0.06, cz1]);
  for (const f of [0.35, 0.65]) {
    const z = cz0 + (cz1 - cz0) * f;
    for (let i = 0; i <= 8; i++) cylY(c.mb, "chrome", cx0 + 0.01 + ((cx1 - cx0 - 0.02) * i) / 8, yF + 0.06, -0.07, z, 0.0025, 0.0025, 4, false);
    cylX(c.mb, "chrome", cx0, cx1, yF + 0.06, z, 0.003, 4);
  }
  c.mb.flat("emissive_light", ellipse((cx0 + cx1) / 2, -0.1, 0.02, 0.02, 10), cz1 - 0.001, true); // oven lamp
  dropDoor(c, x0, x1, z0, z1 - strip, (lb, w, h) => {
    lb.box(A, [0, 0, 0], [w, 0.04, h]);
    lb.box("screen_black", [0.004, -0.002, 0.004], [w - 0.004, 0, h - 0.004]);
    lb.box("glass_tinted", [0.08, -0.0025, h * 0.22], [w - 0.08, -0.002, h * 0.78]);
    // bar handle across the top
    for (const px of [0.06, w - 0.06]) cylY(lb, A, px, -0.035, 0, h - 0.045, 0.006, 0.006, 8, false);
    cylX(lb, A, 0.04, w - 0.04, -0.035, h - 0.045, 0.009, 12);
  }, name);
}

const ovenBase: Builder = (c) => {
  const p = c.p;
  const [fx0, fx1] = frontX(c);
  shell(c, { top: true });
  const zt = topZ(c) - 0.004;
  const oz0 = Math.max(p.z0 + 0.12, zt - 0.595);
  oven(c, fx0, fx1, oz0, zt);
  if (oz0 - p.z0 > 0.08) drawer(c, fx0, fx1, p.z0, oz0, { name: "drawer1" });
};

const dishwasher: Builder = (c) => {
  const p = c.p, m = p.module;
  const [fx0, fx1] = frontX(c);
  const zb = p.z0, zt = frontTop(c);
  const integrated = (m.appliance ?? "integrated") === "integrated";
  // stainless tub with two racks
  const tx0 = fx0 + 0.02, tx1 = fx1 - 0.02, tz0 = zb + 0.03, tz1 = topZ(c) - 0.03, ty0 = c.yFront + 0.06, ty1 = -0.04;
  c.mb.box("metal_steel", [fx0, ty0 - 0.02, zb], [tx0, ty1, topZ(c) - 0.002]);
  c.mb.box("metal_steel", [tx1, ty0 - 0.02, zb], [fx1, ty1, topZ(c) - 0.002]);
  cavity(c.mb, "metal_steel", [tx0, ty0, tz0], [tx1, ty1, tz1]);
  for (const f of [0.18, 0.58]) {
    const z = tz0 + (tz1 - tz0) * f;
    for (let i = 0; i <= 10; i++) cylY(c.mb, "plastic_gray", tx0 + 0.02 + ((tx1 - tx0 - 0.04) * i) / 10, ty0 + 0.02, ty1 - 0.02, z, 0.003, 0.003, 4, false);
    for (const y of [ty0 + 0.02, ty1 - 0.02]) cylX(c.mb, "plastic_gray", tx0 + 0.02, tx1 - 0.02, y, z, 0.004, 4);
    for (let i = 0; i <= 7; i++) c.mb.cylinder("plastic_gray", [tx0 + 0.04 + ((tx1 - tx0 - 0.08) * i) / 7, (ty0 + ty1) / 2, z], 0.002, 0.002, 0.11, 4, { top: false, bottom: false });
  }
  endPanels(c);
  if (c.handle === "gola") golaChannel(c, fx0, fx1, zt, topZ(c));
  dropDoor(c, fx0, fx1, zb, zt, (lb, w, h) => {
    if (integrated) {
      frontPanel(lb, c.style, frontMats(c), 0, w, 0, h);
      const hs = effHandle(c, "base");
      if (hs === "bar") handle(lb, "bar", c.M.handle, w / 2, h - 0.06, barLength(w, false), false);
      else if (hs === "knob") handle(lb, "knob", c.M.handle, w / 2, h - 0.06, 0, false);
      else if (hs === "edge") handle(lb, "edge", c.M.handle, w / 2, 0, 0.18, false, h, true);
      lb.box("metal_steel", [0.02, FT, 0.02], [w - 0.02, FT + 0.03, h - 0.02]);
    } else {
      lb.box(c.M.appliance, [0, 0, 0], [w, 0.035, h]);
      lb.box("screen_black", [0.02, -0.001, h - 0.075], [w - 0.02, 0, h - 0.015]);
      for (const px of [0.07, w - 0.07]) cylY(lb, c.M.appliance, px, -0.03, 0, h - 0.11, 0.005, 0.005, 8, false);
      cylX(lb, c.M.appliance, 0.05, w - 0.05, -0.03, h - 0.11, 0.008, 10);
    }
  }, "door");
};

const basin: Builder = (c) => {
  const p = c.p, m = p.module;
  const [fx0, fx1] = frontX(c);
  shell(c, { top: false });
  const zt = frontTop(c), top = c.d.height;
  if (c.handle === "gola") golaChannel(c, fx0, fx1, zt, topZ(c));
  drawerStack(c, fx0, fx1, p.z0, zt, m.drawers ?? (zt - p.z0 > 0.45 ? 2 : 1), m.drawers ? undefined : zt - p.z0 > 0.45 ? [0.7, 1] : undefined);
  const cx = (fx0 + fx1) / 2;
  const style = m.basin ?? "vessel";
  const depth = -c.yFront;
  if (style === "vessel") {
    const r = clamp(Math.min(fx1 - fx0 - 0.1, depth - 0.12) / 2, 0.14, 0.22);
    const cy = c.yFront + 0.04 + r;
    const prof: Vec2[] = [[0, 0], [r * 0.55, 0], [r * 0.9, 0.035], [r, 0.09], [r * 1.0, 0.13], [r - 0.008, 0.132], [r - 0.012, 0.12], [r * 0.85, 0.055], [r * 0.4, 0.025], [0, 0.022]];
    c.mb.lathe(prof, () => c.M.sink, [cx, cy, top], 32);
    c.mb.cylinder("chrome", [cx, cy, top + 0.0225], 0.02, 0.02, 0.002, 12, { bottom: false });
    // tall basin mixer behind the bowl
    const ty = Math.min(cy + r + 0.05, -0.04);
    c.mb.cylinder(c.M.tap, [cx, ty, top], 0.022, 0.02, 0.03, 14);
    c.mb.cylinder(c.M.tap, [cx, ty, top + 0.03], 0.014, 0.014, 0.27, 12);
    cylY(c.mb, c.M.tap, cx, ty - 0.15, ty, top + 0.29, 0.011, 0.011, 10);
    c.mb.cylinder(c.M.tap, [cx, ty - 0.15, top + 0.27], 0.012, 0.011, 0.02, 10, { top: false });
    cylY(c.mb, c.M.tap, cx, ty - 0.012, ty + 0.06, top + 0.2, 0.005, 0.005, 8);
  } else {
    const bw = clamp(fx1 - fx0 - 0.16, 0.3, 0.5), bdp = clamp(depth - 0.2, 0.25, 0.36);
    const cy = c.yFront + 0.07 + bdp / 2;
    const hole = ellipse(cx, cy, bw / 2, bdp / 2, 28);
    c.cuts.push({ kind: "hole", outline: hole });
    bowl(c.mb, c.M.sink, hole, ellipse(cx, cy + 0.01, bw / 2 - 0.06, bdp / 2 - 0.05, 28), top - c.d.wt, 0.13, [cx, cy + 0.03]);
    const ty = Math.min(cy + bdp / 2 + 0.05, -0.04);
    c.mb.cylinder(c.M.tap, [cx, ty, top], 0.022, 0.02, 0.03, 14);
    c.mb.cylinder(c.M.tap, [cx, ty, top + 0.03], 0.013, 0.013, 0.13, 12);
    cylY(c.mb, c.M.tap, cx, ty - 0.13, ty, top + 0.15, 0.01, 0.01, 10);
    c.mb.cylinder(c.M.tap, [cx, ty - 0.13, top + 0.13], 0.011, 0.01, 0.02, 10, { top: false });
  }
};

const desk: Builder = (c) => {
  const p = c.p;
  endPanels(c);
  // modesty panel
  const zt = topZ(c);
  c.mb.box(c.M.front, [p.x0 + (p.exposedL ? EP : 0), -0.03, Math.max(0.3, zt - 0.4)], [p.x1 - (p.exposedR ? EP : 0), -0.012, zt]);
};

const bench: Builder = (c) => {
  const p = c.p;
  const [fx0, fx1] = frontX(c);
  shell(c);
  drawerStack(c, fx0, fx1, p.z0, frontTop(c), p.module.drawers ?? 1);
  const top = c.d.height;
  cushion(c.mb, c.M.cushion, p.x0 + 0.005, p.x1 - 0.005, c.yFront + 0.005, -0.01, top, top + 0.07, 0.025);
  if (!c.r.freestanding) cushion(c.mb, c.M.cushion, p.x0 + 0.02, p.x1 - 0.02, -0.13, -0.012, top + 0.075, top + 0.45, 0.03);
};

const corner: Builder = (c) => {
  const p = c.p;
  if (p.block) {
    // exterior corner post: solid, clad in the front material
    const z0 = p.row === "upper" ? p.z0 : 0;
    c.mb.box(c.M.front, [p.x0, c.yFront, z0], [p.x1, -0.002, topZ(c)]);
    return;
  }
  const zb = p.z0, zt = frontTop(c);
  const blind = p.blindWidth ?? -c.yFront;
  const role = p.row === "upper" ? "upper" : "base";
  shell(c, { shelves: [(zb + topZ(c)) / 2] });
  const [fx0, fx1] = frontX(c);
  if (p.blind === "right") {
    doors(c, fx0, fx1 - blind, zb, zt, role, 1);
    fixedFront(c, fx1 - blind, fx1, zb, zt, "slab");
  } else {
    fixedFront(c, fx0, fx0 + blind, zb, zt, "slab");
    doors(c, fx0 + blind, fx1, zb, zt, role, 1);
  }
  if (c.handle === "gola" && role === "base") golaChannel(c, fx0, fx1, zt, topZ(c));
};

const filler: Builder = (c) => {
  const p = c.p;
  const z0 = p.z0;
  const z1 = p.row === "base" ? frontTop(c) : p.z1;
  c.mb.box(c.M.front, [p.x0 + 0.0005, c.yFront, z0 + G], [p.x1 - 0.0005, c.yFront + 0.06, z1 - (p.row === "base" ? 0 : G)]);
};

const endPanel: Builder = (c) => {
  const p = c.p;
  const z0 = p.row === "upper" ? p.z0 : p.row === "base" && c.d.elevation > 0 ? p.z0 : 0;
  c.mb.box(c.M.front, [p.x0, c.yFront, z0], [p.x1, -0.002, p.row === "base" ? topZ(c) + (p.worktop ? 0 : c.d.wt) : p.z1]);
};

// ---- tall units ----

/** Split line between the main and the top doors of tall units (aligned across the run). */
function tallSplit(c: ModCtx): number | null {
  const zb = c.p.z0, zt = c.p.z1;
  if (zt - zb < 2.05) return null;
  return Math.min(zb + 1.78, zt - 0.3);
}

const fridge: Builder = (c) => {
  const p = c.p, m = p.module;
  const [fx0, fx1] = frontX(c);
  const zb = p.z0, zt = p.z1;
  const split = tallSplit(c);
  const hinge = m.hinge ?? defaultHinge(c);
  if ((m.appliance ?? "integrated") === "freestanding") {
    // stainless fridge in a tall housing with a bridge cabinet above
    const fz1 = Math.min(zt - 0.35, 1.85);
    shell(c, { shelves: [], back: true });
    // housing: hide the carcass bottom below the fridge with a plinth-height panel
    c.mb.box(c.M.carcass, [fx0, c.yFront + FT, fz1], [fx1, -0.004, fz1 + CT]);
    doors(c, fx0, fx1, fz1 + CT, zt, "upper", m.doors);
    const bx0 = fx0 + 0.008, bx1 = fx1 - 0.008, yF = c.yFront - 0.02;
    const A = c.M.appliance;
    c.mb.box(A, [bx0, yF + 0.05, 0.02], [bx1, -0.03, fz1 - 0.01]);
    c.mb.box("plastic_black", [bx0 + 0.02, yF + 0.06, 0], [bx1 - 0.02, -0.05, 0.02]);
    cavity(c.mb, "plastic_white", [bx0 + 0.03, yF + 0.05, 0.12], [bx1 - 0.03, -0.06, fz1 - 0.05]);
    const french = bx1 - bx0 >= 0.78;
    const dz = 0.02 + (fz1 - 0.02) * 0.32;
    const fridgeDoor = (x0: number, x1: number, z0: number, z1: number, h: "left" | "right", name: string, handleTop: boolean) => {
      const lb = leafMB();
      const w = x1 - x0 - 0.004;
      const ox = h === "left" ? 0 : -w;
      lb.box(A, [ox, 0, 0], [ox + w, 0.05, z1 - z0 - 0.004]);
      const hx = h === "left" ? w - 0.05 : -w + 0.05;
      const hh = z1 - z0;
      const L = Math.min(0.5, hh * 0.6);
      const hz = handleTop ? hh - 0.05 - L / 2 : 0.05 + L / 2;
      for (const z of [hz - L / 2 + 0.03, hz + L / 2 - 0.03]) cylY(lb, A, hx, -0.035, 0, z, 0.008, 0.008, 8, false);
      lb.cylinder(A, [hx, -0.035, hz - L / 2], 0.011, 0.011, L, 12);
      c.leaves.push({ name, motion: "hinged", hinge: h, pivot: [h === "left" ? x0 + 0.002 : x1 - 0.002, yF, z0 + 0.002], mb: lb, maxAngle: 120, open: p.open, role: "appliance" });
    };
    if (french) {
      const mx = (bx0 + bx1) / 2;
      fridgeDoor(bx0, mx, dz, fz1, "left", "door1", false);
      fridgeDoor(mx, bx1, dz, fz1, "right", "door2", false);
      // freezer drawer
      const lb = leafMB();
      const w = bx1 - bx0 - 0.004, h = dz - 0.024;
      lb.box(A, [-w / 2, 0, 0], [w / 2, 0.05, h]);
      for (const px of [-w / 2 + 0.08, w / 2 - 0.08]) cylY(lb, A, px, -0.035, 0, h - 0.06, 0.008, 0.008, 8, false);
      cylX(lb, A, -w / 2 + 0.06, w / 2 - 0.06, -0.035, h - 0.06, 0.011, 12);
      lb.box("plastic_white", [-w / 2 + 0.04, 0.05, 0.03], [w / 2 - 0.04, 0.5, h - 0.05]);
      c.leaves.push({ name: "freezer", motion: "slide", pivot: [(bx0 + bx1) / 2, yF, 0.022], mb: lb, slideDir: [0, -1], slideDist: 0.45, open: p.open, role: "drawer" });
    } else {
      fridgeDoor(bx0, bx1, dz, fz1, hinge, "door1", false);
      fridgeDoor(bx0, bx1, 0.02, dz, hinge, "freezer", true);
    }
    return;
  }
  // integrated fridge-freezer behind matching doors
  shell(c, { back: true });
  const fzTop = split ?? zt;
  const freezerTop = zb + 0.72;
  // appliance liner
  const lx0 = fx0 + CT + 0.01, lx1 = fx1 - CT - 0.01, ly0 = c.yFront + FT + 0.06, ly1 = -0.03;
  cavity(c.mb, "plastic_white", [lx0, ly0, zb + CT], [lx1, ly1, freezerTop - 0.02]);
  cavity(c.mb, "plastic_white", [lx0, ly0, freezerTop + 0.02], [lx1, ly1, fzTop - CT - 0.01]);
  c.mb.box("plastic_white", [lx0, ly0 - 0.02, freezerTop - 0.02], [lx1, ly1, freezerTop + 0.02]);
  for (let i = 1; i <= 3; i++) {
    const z = freezerTop + 0.02 + ((fzTop - freezerTop - 0.05) * i) / 4.2;
    c.mb.box("glass_frosted", [lx0, ly0 + 0.01, z], [lx1, ly1, z + 0.005]);
  }
  c.mb.box("plastic_white", [lx0 + 0.01, ly0 + 0.02, freezerTop + 0.03], [lx1 - 0.01, ly1 - 0.02, freezerTop + 0.2]);
  for (let i = 1; i <= 2; i++) c.mb.box("plastic_white", [lx0, ly0, zb + CT + i * 0.22], [lx1, ly1, zb + CT + i * 0.22 + 0.01]);
  c.mb.flat("emissive_light", roundRect((lx0 + lx1) / 2, (ly0 + ly1) / 2, 0.12, 0.03, 0.01), fzTop - CT - 0.011, true);
  if (split) {
    door(c, fx0, fx1, split, zt, hinge, "upper", c.style, "door_top");
    c.mb.box(c.M.carcass, [fx0 + CT, c.yFront + FT + 0.001, split - CT], [fx1 - CT, -0.004, split]);
  }
  door(c, fx0, fx1, freezerTop, fzTop, hinge, "tall", c.style, "door_fridge");
  door(c, fx0, fx1, zb, freezerTop, hinge, "base", c.style, "door_freezer");
};

const tallOven: Builder = (c) => {
  const p = c.p;
  const [fx0, fx1] = frontX(c);
  const zb = p.z0, zt = p.z1;
  shell(c, { shelves: [] });
  const oz0 = clamp(0.86, zb + 0.3, zt - 0.7);
  const oz1 = oz0 + 0.595;
  const mz1 = oz1 + 0.455;
  const hasMicro = zt - mz1 > 0.2;
  if (oz0 - zb > 0.1) drawerStack(c, fx0, fx1, zb, oz0, oz0 - zb > 0.5 ? 2 : 1);
  oven(c, fx0, fx1, oz0, oz1);
  let top = oz1;
  if (hasMicro) {
    // compact microwave: side-hinged black glass door, controls on the right
    const yF = c.yFront, A = c.M.appliance;
    const x0 = fx0 + G, x1 = fx1 - G, z0 = oz1 + G, z1 = mz1 - G;
    c.mb.box(A, [x0, yF + 0.04, z0], [x1, -0.03, z1]);
    cavity(c.mb, "plastic_gray", [x0 + 0.04, yF + 0.035, z0 + 0.06], [x1 - 0.15, -0.06, z1 - 0.06]);
    c.mb.box(A, [x1 - 0.11, yF, z0], [x1, yF + 0.04, z1]);
    c.mb.box("screen_black", [x1 - 0.095, yF - 0.001, z1 - 0.12], [x1 - 0.015, yF, z1 - 0.06]);
    cylY(c.mb, A, x1 - 0.055, yF - 0.016, yF, z0 + 0.12, 0.018, 0.018, 14);
    const lb = leafMB();
    const w = x1 - 0.11 - x0, h = z1 - z0;
    lb.box(A, [0, 0, 0], [w, 0.035, h]);
    lb.box("screen_black", [0.004, -0.002, 0.004], [w - 0.004, 0, h - 0.004]);
    lb.box("glass_tinted", [0.06, -0.0025, 0.07], [w - 0.06, -0.002, h - 0.07]);
    c.leaves.push({ name: "microwave", motion: "hinged", hinge: "left", pivot: [x0, yF, z0], mb: lb, maxAngle: 100, open: p.open, role: "appliance" });
    top = mz1;
  }
  if (zt - top > 0.08) {
    c.mb.box(c.M.carcass, [fx0 + CT, c.yFront + FT + 0.001, top], [fx1 - CT, -0.004, top + CT]);
    doors(c, fx0, fx1, top, zt, "upper", c.p.module.doors ?? 1);
  }
};

const pantry: Builder = (c) => {
  const p = c.p, m = p.module;
  const [fx0, fx1] = frontX(c);
  const zb = p.z0, zt = p.z1;
  const split = tallSplit(c);
  const n = m.shelves ?? Math.max(2, Math.round((zt - zb) / 0.36) - 1);
  const shelves = Array.from({ length: n }, (_, i) => zb + ((zt - zb) * (i + 1)) / (n + 1));
  const [ix0, ix1] = shell(c, { shelves: split ? [...shelves.filter((z) => Math.abs(z - split) > 0.08), split - CT] : shelves });
  if (split) {
    doors(c, fx0, fx1, zb, split, "tall", m.doors);
    doors(c, fx0, fx1, split, zt, "upper", m.doors);
  } else doors(c, fx0, fx1, zb, zt, "tall", m.doors);
  if (c.decor && (p.open || c.style === "glass")) {
    const lv = [zb + CT, ...shelves.map((z) => z + CT)];
    lv.forEach((z, i) => provisions(c.mb, c.R, ix0, ix1, z, c.yFront + FT + 0.02, (lv[i + 1] ?? zt - CT) - z - 0.02));
  }
};

const tallOpen: Builder = (c) => {
  openShelf(c);
};

const wardrobe: Builder = (c) => {
  const p = c.p, m = p.module;
  const [fx0, fx1] = frontX(c);
  const zb = p.z0, zt = p.z1;
  const interior = m.interior ?? "hanging";
  const showClothes = (m.clothes ?? true) && c.decor;
  const yF = c.yFront + (c.sliding ? SLIDE_SETBACK : FT + 0.001);
  const ix0 = fx0 + CT, ix1 = fx1 - CT;
  const yRail = (yF - 0.004) / 2;
  const hatShelf = Math.min(zt - 0.3, zb + 1.9);
  const rail = (z: number, len: number) => {
    cylX(c.mb, c.M.handle, ix0, ix1, yRail, z, 0.012, 10);
    for (const x of [ix0, ix1]) c.mb.box(c.M.handle, [x - (x === ix0 ? 0 : 0.012), yRail - 0.02, z - 0.02], [x + (x === ix0 ? 0.012 : 0), yRail + 0.02, z + 0.02]);
    if (showClothes) clothes(c.mb, c.R, ix0, ix1, yRail, z, len, c.M.handle);
  };
  let shelves: number[] = [];
  const zLow = zb + CT;
  switch (interior) {
    case "hanging":
      shelves = [hatShelf];
      rail(hatShelf - 0.06, hatShelf - 0.06 - zLow - 0.25);
      break;
    case "double_hanging": {
      const mid = zb + (hatShelf - zb) * 0.5;
      shelves = [hatShelf, mid];
      rail(hatShelf - 0.06, hatShelf - mid - 0.15);
      rail(mid - 0.06, mid - zLow - 0.15);
      break;
    }
    case "shelves": {
      const n = m.shelves ?? Math.max(3, Math.round((zt - zb) / 0.33) - 1);
      shelves = Array.from({ length: n }, (_, i) => zb + ((zt - zb) * (i + 1)) / (n + 1));
      if (showClothes) [zLow, ...shelves.map((z) => z + CT)].forEach((z, i, a) => folded(c.mb, c.R, ix0, ix1, z, yF, (a[i + 1] ?? zt - CT) - z));
      break;
    }
    case "shoes": {
      const n = m.shelves ?? Math.max(4, Math.round((hatShelf - zb) / 0.25));
      shelves = [hatShelf];
      for (let i = 0; i < n; i++) {
        const z = zb + 0.08 + ((hatShelf - zb - 0.2) * i) / n;
        // sloped shelf with a front lip
        c.mb.with(m4.mul(m4.translation(0, yF + 0.02, z), m4.rotationX(0.28)), () => {
          c.mb.box(c.M.carcass, [ix0, 0, 0], [ix1, -yF - 0.06, 0.012]);
          if (showClothes) shoes(c.mb, c.R, ix0, ix1, 0.012, -0.02, ["leather_black", "leather_brown", "leather_tan", "fabric_white", "fabric_blue"]);
        });
        c.mb.box(c.M.handle, [ix0, yF + 0.012, z - 0.01], [ix1, yF + 0.02, z + 0.035]);
      }
      break;
    }
    case "drawers":
    case "mixed": {
      const nd = m.drawers ?? (interior === "mixed" ? 3 : 4);
      const dTop = zb + Math.min(nd * 0.2, interior === "mixed" ? 0.75 : 1.0);
      shelves = [dTop, hatShelf];
      const dh = (dTop - zb - CT) / nd;
      for (let i = 0; i < nd; i++) {
        const z0 = zb + CT + i * dh;
        drawer(c, ix0 + 0.004, ix1 - 0.004, z0, z0 + dh - 0.004, { inset: yF - c.yFront + 0.002, boxDepth: Math.max(0.25, -yF - 0.08), name: `inner_drawer${i + 1}`, inner: [ix0 + 0.02, ix1 - 0.02], style: "slab" });
      }
      if (interior === "mixed") rail(hatShelf - 0.06, hatShelf - dTop - 0.2);
      else {
        const s2 = (dTop + hatShelf) / 2;
        shelves.push(s2);
        if (showClothes) {
          folded(c.mb, c.R, ix0, ix1, dTop + CT, yF, s2 - dTop - CT);
          folded(c.mb, c.R, ix0, ix1, s2 + CT, yF, hatShelf - s2 - CT);
        }
      }
      break;
    }
  }
  if (showClothes && interior !== "shelves") folded(c.mb, c.R, ix0, ix1, hatShelf + CT, yF, zt - hatShelf - 2 * CT);
  const [x0c, x1c] = [p.x0 + (p.exposedL ? EP : 0), p.x1 - (p.exposedR ? EP : 0)];
  carcass(c.mb, c.M.carcass, x0c, x1c, zb, zt, { yF, shelves });
  endPanels(c);
  if (c.sliding) return;
  const split = zt - zb > 2.38 ? zb + 2.05 : null;
  if (split) {
    doors(c, fx0, fx1, zb, split, "tall", m.doors ?? (fx1 - fx0 > 0.7 ? 2 : 1));
    doors(c, fx0, fx1, split, zt, "upper", m.doors ?? (fx1 - fx0 > 0.7 ? 2 : 1));
  } else doors(c, fx0, fx1, zb, zt, "tall", m.doors ?? (fx1 - fx0 > 0.7 ? 2 : 1));
};

// ---- uppers ----

const upperDoors = (glass: boolean): Builder => (c) => {
  const p = c.p, m = p.module;
  const [fx0, fx1] = frontX(c);
  const zb = p.z0, zt = p.z1;
  const n = m.shelves ?? (zt - zb > 0.6 ? 2 : 1);
  const shelves = Array.from({ length: n }, (_, i) => zb + ((zt - zb) * (i + 1)) / (n + 1));
  const [ix0, ix1] = shell(c, { shelves });
  doors(c, fx0, fx1, zb, zt, "upper", m.doors, glass ? "glass" : undefined);
  if (c.decor && (glass || p.open)) {
    const lv = [zb + CT, ...shelves.map((z) => z + CT)];
    lv.forEach((z, i) => dishes(c.mb, c.R, ix0, ix1, z, c.yFront + FT + 0.01, (lv[i + 1] ?? zt - CT) - z - 0.03));
    if (glass) c.mb.box("emissive_light", [ix0 + 0.02, c.yFront + FT + 0.03, zt - CT - 0.004], [ix1 - 0.02, c.yFront + FT + 0.04, zt - CT]);
  }
};

const upperLift: Builder = (c) => {
  const p = c.p;
  const [fx0, fx1] = frontX(c);
  const zb = p.z0, zt = p.z1;
  shell(c, { shelves: [(zb + zt) / 2] });
  const n = p.module.doors ?? (zt - zb > 0.8 ? 2 : 1);
  const h = (zt - zb) / n;
  for (let i = 0; i < n; i++) {
    const z0 = zt - (i + 1) * h, z1 = zt - i * h;
    const a = fx0 + G, b = fx1 - G, za = z0 + G, zz = z1 - G;
    const w = b - a, hh = zz - za;
    const lb = leafMB();
    frontPanel(lb, c.style, frontMats(c), 0, w, -hh, 0);
    const hs = effHandle(c, "upper");
    if (hs === "bar") handle(lb, "bar", c.M.handle, w / 2, -hh + 0.05, barLength(w, false), false);
    else if (hs === "knob") handle(lb, "knob", c.M.handle, w / 2, -hh + 0.05, 0, false);
    else if (hs === "edge") handle(lb, "edge", c.M.handle, w / 2, 0, 0.18, false, -hh, false);
    c.leaves.push({ name: `flap${i + 1}`, motion: "hinged", hinge: "top", pivot: [a, c.yFront, zz], mb: lb, maxAngle: 100, open: p.open, role: "flap" });
  }
};

const hood: Builder = (c) => {
  const p = c.p;
  const x0 = p.x0, x1 = p.x1, w = x1 - x0, cx = (x0 + x1) / 2;
  const z0 = p.z0;
  const ceiling = Math.max(c.d.ceiling, z0 + 0.5);
  const hd = p.depth;
  const A = c.M.appliance;
  if (p.module.hood === "integrated") {
    // looks like a wall cabinet; the extractor hides inside with a slim steel visor under it
    const saved = c.yFront;
    c.yFront = -c.d.upperDepth;
    const q = p;
    const cc: ModCtx = { ...c, p: q };
    shell(cc, { shelves: [] });
    const [fx0, fx1] = frontX(cc);
    doors(cc, fx0, fx1, q.z0, q.z1, "upper", p.module.doors);
    c.mb.box(A, [fx0 + 0.01, -c.d.upperDepth - 0.04, q.z0 - 0.025], [fx1 - 0.01, -0.03, q.z0 - 0.002]);
    c.mb.box("metal_iron", [fx0 + 0.04, -c.d.upperDepth + 0.01, q.z0 - 0.026], [fx1 - 0.04, -0.05, q.z0 - 0.025]);
    for (const s of [-1, 1]) c.mb.flat("emissive_light", ellipse(cx + s * w * 0.28, -c.d.upperDepth + 0.02, 0.018, 0.018, 12), q.z0 - 0.0265, true);
    c.yFront = saved;
    return;
  }
  if ((p.module.hood ?? "chimney") === "box") {
    const zTop = c.d.toCeiling ? ceiling : Math.max(p.z1, z0 + 0.4);
    c.mb.box(c.M.front, [x0 + 0.002, -hd, z0], [x1 - 0.002, -0.002, zTop]);
    c.mb.box("metal_iron", [x0 + 0.04, -hd + 0.04, z0 - 0.003], [x1 - 0.04, -0.06, z0]);
    for (const s of [-1, 1]) c.mb.flat("emissive_light", ellipse(cx + s * w * 0.25, -hd + 0.07, 0.025, 0.025, 12), z0 - 0.0035, true);
    return;
  }
  // canopy, sloped shoulders and a chimney flue up to the ceiling
  const vz = z0 + 0.06;
  c.mb.box(A, [x0, -hd, z0], [x1, -0.003, vz]);
  c.mb.box("metal_iron", [x0 + 0.03, -hd + 0.03, z0 - 0.002], [x1 - 0.03, -0.04, z0]);
  for (const s of [-1, 1]) c.mb.flat("emissive_light", ellipse(cx + s * w * 0.3, -hd + 0.06, 0.022, 0.022, 12), z0 - 0.0025, true);
  const fw = Math.min(0.3, w * 0.4), fd = 0.26;
  const sz = vz + clamp(hd * 0.55, 0.18, 0.3);
  const lo: Vec2[] = [[x0, -hd], [x1, -hd], [x1, -0.003], [x0, -0.003]];
  const hi: Vec2[] = [[cx - fw / 2, -fd], [cx + fw / 2, -fd], [cx + fw / 2, -0.003], [cx - fw / 2, -0.003]];
  loft(c.mb, A, lo, vz, hi, sz);
  c.mb.box(A, [cx - fw / 2, -fd, sz], [cx + fw / 2, -0.003, ceiling], { skip: ["-z"] });
  // control buttons on the canopy front
  for (let i = 0; i < 4; i++) c.mb.box("screen_black", [cx - 0.06 + i * 0.035, -hd - 0.0015, z0 + 0.02], [cx - 0.04 + i * 0.035, -hd, z0 + 0.035]);
};

export const BUILDERS: Record<string, Builder> = {
  base_doors: baseDoors,
  base_drawers: baseDrawers,
  sink,
  hob,
  oven_base: ovenBase,
  dishwasher,
  open_shelf: openShelf,
  wine_rack: wineRack,
  basin,
  desk,
  bench,
  corner,
  filler,
  end_panel: endPanel,
  gap: () => {},
  fridge,
  tall_oven: tallOven,
  pantry,
  wardrobe,
  tall_open: tallOpen,
  upper_doors: upperDoors(false),
  upper_glass: upperDoors(true),
  upper_open: openShelf,
  upper_lift: upperLift,
  hood,
};

export { SLIDE_SETBACK };
