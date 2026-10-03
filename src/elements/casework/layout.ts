/**
 * Casework run resolution: placement (wall / path / freestanding) -> straight legs with local frames,
 * module widths and positions, corners, exposed ends, windows behind each leg. Shared by the geometry
 * builder, the layout validator and the 2D plan renderer.
 *
 * LEG FRAME (like furniture): x runs LEFT -> RIGHT as seen standing in front of the cabinets, y points from
 * the front toward the wall (+y = back), z up from the floor finish. The back line is y = 0, the door
 * fronts are at y = -depth. Paths are normalized so the fronts are on the right of the path direction,
 * which makes path order == left-to-right for every leg (no mirrored frames).
 */
import { deg2rad, lineIntersect, pointInPolygon, pointSegment, signedArea, v2, type Vec2 } from "../../geometry/math.js";
import type { PlacedOpening } from "../openings.js";
import { segDir, segLength, type WallSegment } from "../walls.js";
import { BASE_KINDS, TALL_KINDS, UPPER_KINDS, type CaseModule, type Casework, type CaseworkType, type ModuleKind } from "./schema.js";

export type Row = "base" | "tall" | "upper";

export interface CaseCtx {
  segments: WallSegment[];
  openings: PlacedOpening[];
  /** Absolute elevation of the level floor (slab top). */
  elevation: number;
  /** Ceiling height above the level floor. */
  ceiling: number;
  rooms: Vec2[][];
  /** Wall polylines of the level by id (for wall placement). */
  walls: { id: string; points: Vec2[]; closed: boolean; thickness: number }[];
}

export interface LegOpening {
  id: string;
  type: "door" | "window" | "opening";
  /** Range along the leg (local x). */
  x0: number;
  x1: number;
  /** Bottom / top above the level floor. */
  sill: number;
  top: number;
}

export interface Leg {
  index: number;
  /** Back line start/end (a = local x 0). */
  a: Vec2;
  b: Vec2;
  len: number;
  /** Unit vector of local +x (left -> right facing the fronts). */
  X: Vec2;
  /** Front normal (toward the room). Local +y = -n. */
  n: Vec2;
  /** Radians of local +x. */
  angle: number;
  /** Local x range actually used by modules (exterior corners extend past len). */
  start: number;
  end: number;
  cornerStart?: CornerInfo;
  cornerEnd?: CornerInfo;
  openings: LegOpening[];
  /** Local x intervals where a wall is right behind the back line (backsplash there, back panels elsewhere). */
  backed: [number, number][];
}

export interface CornerInfo {
  interior: boolean;
}

export interface Placed {
  module: CaseModule;
  kind: ModuleKind;
  row: Row;
  /** Index in modules/uppers (-1 for automatic parts). */
  index: number;
  id: string;
  label: string;
  leg: number;
  x0: number;
  x1: number;
  depth: number;
  /** Bottom / top above the floor finish. */
  z0: number;
  z1: number;
  /** "corner": blind corner (blind zone on `blind` side); "block": exterior corner post; "filler": automatic. */
  auto?: "corner_filler" | "scribe";
  blind?: "left" | "right";
  /** Width of the blind zone of a corner unit. */
  blindWidth?: number;
  exposedL: boolean;
  exposedR: boolean;
  open: boolean;
  /** Worktop runs over it. */
  worktop: boolean;
  /** Exterior corner block. */
  block?: boolean;
}

export interface Dims {
  type: CaseworkType;
  height: number;
  depth: number;
  tallTop: number;
  upperBottom: number;
  upperTop: number;
  upperDepth: number;
  plinth: number;
  /** Base-row lift (floating units). */
  elevation: number;
  wt: number;
  overhang: number;
  backsplash: number | "full" | 0;
  doorStyle: string;
  handle: string;
  lighting: boolean;
  cornice: boolean;
  toCeiling: boolean;
  ceiling: number;
}

export interface WorktopSpan {
  leg: number;
  x0: number;
  x1: number;
  /** y extent: front edge (negative) and back edge. */
  yf: number;
  yb: number;
  /** Extend over exposed end panels / waterfall. */
  waterfallL: boolean;
  waterfallR: boolean;
}

export interface ResolvedRun {
  run: Casework;
  id: string;
  dims: Dims;
  freestanding: boolean;
  legs: Leg[];
  base: Placed[];
  uppers: Placed[];
  spans: WorktopSpan[];
  /** Run ends not against a wall. */
  freeStart: boolean;
  freeEnd: boolean;
  errors: string[];
  warnings: string[];
}

// ---------------------------------------------------------------------------------------------
// defaults

interface TypeDefaults {
  height: number;
  depth: number;
  tall: number;
  plinth: number;
  elevation: number;
  wt: number;
  backsplash: "none" | "upstand" | "full";
}

const TYPE_DEFAULTS: Record<CaseworkType, TypeDefaults> = {
  kitchen: { height: 0.9, depth: 0.6, tall: 2.2, plinth: 0.1, elevation: 0, wt: 0.03, backsplash: "full" },
  wardrobe: { height: 0.9, depth: 0.6, tall: 2.3, plinth: 0.08, elevation: 0, wt: 0.02, backsplash: "none" },
  vanity: { height: 0.85, depth: 0.5, tall: 2.0, plinth: 0.1, elevation: 0.3, wt: 0.02, backsplash: "upstand" },
  shelving: { height: 0.8, depth: 0.35, tall: 2.2, plinth: 0.06, elevation: 0, wt: 0.025, backsplash: "none" },
  media: { height: 0.5, depth: 0.45, tall: 2.2, plinth: 0.06, elevation: 0.2, wt: 0.025, backsplash: "none" },
  desk: { height: 0.75, depth: 0.6, tall: 2.1, plinth: 0.08, elevation: 0, wt: 0.03, backsplash: "none" },
  bench: { height: 0.45, depth: 0.45, tall: 2.1, plinth: 0.08, elevation: 0, wt: 0.03, backsplash: "none" },
  custom: { height: 0.9, depth: 0.6, tall: 2.2, plinth: 0.1, elevation: 0, wt: 0.03, backsplash: "none" },
};

export const DEFAULT_WIDTH: Record<ModuleKind, number> = {
  base_doors: 0.6, base_drawers: 0.6, sink: 0.8, hob: 0.8, oven_base: 0.6, dishwasher: 0.6, open_shelf: 0.3, wine_rack: 0.3,
  basin: 0.6, desk: 1.0, bench: 1.0, fridge: 0.6, tall_oven: 0.6, pantry: 0.6, wardrobe: 1.0, tall_open: 0.8,
  upper_doors: 0.6, upper_glass: 0.6, upper_open: 0.6, upper_lift: 0.9, hood: 0.9, corner: 1.05, filler: 0.05, end_panel: 0.02, gap: 0.6,
};

const BASE = new Set<string>(BASE_KINDS);
const TALL = new Set<string>(TALL_KINDS);
const UPPER = new Set<string>(UPPER_KINDS);

export function rowOf(kind: ModuleKind, inUppers: boolean): Row {
  if (UPPER.has(kind)) return "upper";
  if (TALL.has(kind)) return "tall";
  if (BASE.has(kind)) return "base";
  return inUppers ? "upper" : "base";
}

export function resolveDims(run: Casework, ctx: CaseCtx): Dims {
  const t = TYPE_DEFAULTS[run.type];
  const elevation = run.elevation ?? t.elevation;
  const height = run.height ?? t.height;
  const toCeiling = run.toCeiling ?? false;
  const ceiling = ctx.ceiling - 0.012; // the cabinets stop just under the ceiling finish
  const tallTop = toCeiling ? ceiling : run.tallHeight ?? t.tall;
  const upperHeight = run.upperHeight ?? 0.72;
  const upperTop = toCeiling ? ceiling : tallTop;
  const upperBottom = run.upperBottom ?? upperTop - upperHeight;
  const bs = run.backsplash ?? t.backsplash;
  const hasUppers = run.uppers.some((m) => !["gap", "filler", "corner", "end_panel"].includes(m.kind));
  return {
    type: run.type,
    height,
    depth: run.depth ?? t.depth,
    tallTop,
    upperBottom,
    upperTop: run.upperBottom !== undefined && run.upperHeight !== undefined ? run.upperBottom + run.upperHeight : Math.max(upperTop, upperBottom + 0.2),
    upperDepth: run.upperDepth ?? 0.35,
    plinth: run.plinth ?? t.plinth,
    elevation,
    wt: run.worktopThickness ?? t.wt,
    overhang: run.overhang ?? 0.02,
    backsplash: bs === "none" ? 0 : bs === "upstand" ? 0.1 : bs,
    doorStyle: run.doorStyle ?? "slab",
    handle: run.handle ?? "bar",
    lighting: run.lighting ?? ((run.type === "kitchen" && hasUppers) || elevation > 0.05),
    cornice: run.cornice ?? false,
    toCeiling,
    ceiling,
  };
}

// ---------------------------------------------------------------------------------------------
// placement -> legs

const r2 = (n: number) => Math.round(n * 100) / 100;
const fmt = (n: number) => r2(n).toString();

function rightNormal(d: Vec2): Vec2 {
  return [d[1], -d[0]];
}

/** Offset a wall polyline to one face (mitered), returning the face polyline aligned with the centerline points. */
function facePolyline(pts: Vec2[], closed: boolean, off: number): Vec2[] {
  const n = pts.length;
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const hasPrev = closed || i > 0, hasNext = closed || i < n - 1;
    const prev = pts[(i - 1 + n) % n], cur = pts[i], next = pts[(i + 1) % n];
    const dPrev = hasPrev ? v2.norm(v2.sub(cur, prev)) : null;
    const dNext = hasNext ? v2.norm(v2.sub(next, cur)) : null;
    const nPrev = dPrev ? v2.perp(dPrev) : null, nNext = dNext ? v2.perp(dNext) : null;
    if (dPrev && dNext && nPrev && nNext) {
      const p = lineIntersect(v2.add(prev, v2.scale(nPrev, off)), dPrev, v2.add(cur, v2.scale(nNext, off)), dNext);
      out.push(p ?? v2.add(cur, v2.scale(nNext, off)));
    } else out.push(v2.add(cur, v2.scale((nPrev ?? nNext)!, off)));
  }
  return out;
}

function snapToWall(run: Casework, ctx: CaseCtx, errors: string[], where: string): Vec2[] | null {
  const w = ctx.walls.find((x) => x.id === run.wall);
  if (!w) {
    errors.push(`${where}: wall '${run.wall}' not found on this level (walls: ${ctx.walls.map((x) => x.id).join(", ") || "none"})`);
    return null;
  }
  const pts = w.closed ? [...w.points, w.points[0]] : w.points;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + v2.dist(pts[i - 1], pts[i]));
  const total = cum[cum.length - 1];
  const from = Math.max(0, Math.min(total, run.to !== undefined && run.from !== undefined ? Math.min(run.from, run.to) : run.from ?? 0));
  // without `to` a run with fixed widths is exactly as long as its modules (else it runs to the end of the wall)
  const fixedLen = run.modules.length && !run.modules.some((m) => m.width === "auto") ? totalWidth(run.modules, run.depth ?? 0.6) : 0;
  const to = Math.max(0, Math.min(total, run.to !== undefined ? Math.max(run.to, run.from ?? 0) : fixedLen > 0 ? from + fixedLen : total));
  if (to - from < 0.1) {
    errors.push(`${where}: from ${fmt(from)} / to ${fmt(to)} leave no length on wall '${w.id}' (length ${fmt(total)}); \`to\` must be larger than \`from\``);
    return null;
  }
  // which face: explicit, the interior of a closed loop, or the side with a room
  let side = run.side;
  if (!side) {
    if (w.closed) side = signedArea(w.points) > 0 ? "left" : "right";
    else {
      const s = (from + to) / 2;
      const i = Math.max(1, cum.findIndex((c) => c >= s));
      const a = pts[i - 1], b = pts[i];
      const d = v2.norm(v2.sub(b, a));
      const mid = v2.add(a, v2.scale(d, s - cum[i - 1]));
      const probe = (sg: number) => v2.add(mid, v2.scale(v2.perp(d), sg * (w.thickness / 2 + 0.3)));
      const inRoom = (p: Vec2) => ctx.rooms.some((r) => pointInPolygon(p, r));
      const L = inRoom(probe(1)), R = inRoom(probe(-1));
      if (L && R) {
        errors.push(`${where}: wall '${w.id}' has rooms on both sides — set side: 'left' or 'right' (relative to the wall's point order) to pick the face`);
        return null;
      }
      side = R ? "right" : "left";
    }
  }
  const off = (side === "left" ? 1 : -1) * (w.thickness / 2);
  const face = facePolyline(pts, false, off);
  if (w.closed) {
    // the closing point repeats the first: recompute its miter with the loop wrap-around
    const loopFace = facePolyline(w.points, true, off);
    face[0] = loopFace[0];
    face[face.length - 1] = loopFace[0];
  }
  const at = (s: number): Vec2 => {
    let i = cum.findIndex((c) => c >= s - 1e-9);
    if (i <= 0) i = 1;
    const t = (s - cum[i - 1]) / Math.max(1e-9, cum[i] - cum[i - 1]);
    const c = v2.lerp(pts[i - 1], pts[i], t);
    const d = v2.norm(v2.sub(pts[i], pts[i - 1]));
    const p = v2.add(c, v2.scale(v2.perp(d), off));
    // clamp onto the (mitered) face segment
    const fa = face[i - 1], fb = face[i];
    const fd = v2.norm(v2.sub(fb, fa));
    const k = Math.max(0, Math.min(v2.dist(fa, fb), v2.dot(v2.sub(p, fa), fd)));
    return v2.add(fa, v2.scale(fd, k));
  };
  const path: Vec2[] = [at(from)];
  for (let i = 1; i < pts.length - 1; i++) if (cum[i] > from + 1e-6 && cum[i] < to - 1e-6) path.push(face[i]);
  path.push(at(to));
  return path;
}

function inWall(p: Vec2, segs: WallSegment[]): WallSegment | undefined {
  return segs.find((s) => pointInPolygon(p, [s.aR, s.bR, s.bL, s.aL]));
}

/** Normalized back-line polyline with fronts on the RIGHT of the walking direction. */
function runPath(run: Casework, ctx: CaseCtx, errors: string[], where: string, depth: number): { path: Vec2[]; freestanding: boolean } | null {
  const modes = [run.wall !== undefined, run.path !== undefined, run.position !== undefined].filter(Boolean).length;
  if (modes !== 1) {
    errors.push(`${where}: give exactly one placement: wall (+from/to), path (back edge) or position (+facing, freestanding)`);
    return null;
  }
  if (run.position) {
    const rot = deg2rad(run.rotation ?? (run.facing ? { south: 0, east: 90, north: 180, west: 270 }[run.facing] : 0));
    const n = v2.rotate([0, -1], rot);
    const X: Vec2 = [-n[1], n[0]];
    const L = run.length ?? totalWidth(run.modules, depth);
    if (!(L > 0.05)) {
      errors.push(`${where}: give \`length\` (the modules have only 'auto' widths)`);
      return null;
    }
    const back = v2.sub(run.position as Vec2, v2.scale(n, depth / 2));
    const a = v2.sub(back, v2.scale(X, L / 2));
    return { path: [a, v2.add(a, v2.scale(X, L))], freestanding: true };
  }
  let path: Vec2[];
  let explicitFront = run.front;
  if (run.wall !== undefined) {
    const p = snapToWall(run, ctx, errors, where);
    if (!p) return null;
    path = p;
    // the wall face: fronts point away from the wall, i.e. toward the side we snapped to
    explicitFront = undefined;
    const d = v2.norm(v2.sub(path[1], path[0]));
    const mid = v2.lerp(path[0], path[1], 0.5);
    const leftInWall = !!inWall(v2.add(mid, v2.scale(v2.perp(d), 0.03)), ctx.segments);
    const rightInWall = !!inWall(v2.add(mid, v2.scale(rightNormal(d), 0.03)), ctx.segments);
    explicitFront = leftInWall && !rightInWall ? "right" : rightInWall && !leftInWall ? "left" : run.front ?? "right";
  } else path = (run.path as Vec2[]).map((p) => [p[0], p[1]] as Vec2);
  // drop duplicate points
  path = path.filter((p, i) => i === 0 || v2.dist(p, path[i - 1]) > 1e-4);
  if (path.length < 2) {
    errors.push(`${where}: path needs two distinct points`);
    return null;
  }
  let front = explicitFront;
  if (!front) {
    // away from the nearest wall: probe both sides of every leg's midpoint
    let score = 0;
    for (let i = 0; i < path.length - 1; i++) {
      const d = v2.norm(v2.sub(path[i + 1], path[i]));
      const mid = v2.lerp(path[i], path[i + 1], 0.5);
      for (const k of [0.03, 0.12, 0.25]) {
        if (inWall(v2.add(mid, v2.scale(v2.perp(d), k)), ctx.segments)) score += 1; // wall on the left -> front right
        if (inWall(v2.add(mid, v2.scale(rightNormal(d), k)), ctx.segments)) score -= 1;
      }
    }
    front = score >= 0 ? "right" : "left";
  }
  if (front === "left") path = [...path].reverse();
  return { path, freestanding: false };
}

function totalWidth(mods: CaseModule[], depth: number): number {
  return mods.reduce((s, m) => s + (typeof m.width === "number" ? m.width : m.width === "auto" ? 0 : m.kind === "corner" ? depth + 0.45 : DEFAULT_WIDTH[m.kind]), 0);
}

// ---------------------------------------------------------------------------------------------
// main

export function resolveRun(run: Casework, index: number, ctx: CaseCtx): ResolvedRun {
  const id = run.id ?? `${run.type}${index}`;
  const where = `casework '${id}'`;
  const errors: string[] = [], warnings: string[] = [];
  const dims = resolveDims(run, ctx);
  const res: ResolvedRun = { run, id, dims, freestanding: false, legs: [], base: [], uppers: [], spans: [], freeStart: true, freeEnd: true, errors, warnings };

  // rows must hold the right kinds
  run.modules.forEach((m, i) => {
    if (UPPER.has(m.kind)) errors.push(`${where}: modules[${i}] is '${m.kind}', a wall cabinet — move it to \`uppers\``);
  });
  run.uppers.forEach((m, i) => {
    if (BASE.has(m.kind) || TALL.has(m.kind)) errors.push(`${where}: uppers[${i}] is '${m.kind}' — base and tall units go in \`modules\`, uppers only takes upper_*/hood/gap/filler/corner`);
  });
  if (errors.length) return res;

  const rp = runPath(run, ctx, errors, where, dims.depth);
  if (!rp) return res;
  res.freestanding = rp.freestanding;
  const path = rp.path;

  // legs
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], b = path[i + 1];
    const X = v2.norm(v2.sub(b, a));
    const n = rightNormal(X);
    res.legs.push({ index: i, a, b, len: v2.dist(a, b), X, n, angle: Math.atan2(X[1], X[0]), start: 0, end: v2.dist(a, b), openings: [], backed: [] });
  }
  for (let i = 0; i < res.legs.length - 1; i++) {
    const A = res.legs[i], B = res.legs[i + 1];
    const turn = v2.cross(A.X, B.X);
    if (Math.abs(turn) < 0.05) {
      warnings.push(`${where}: path points ${i + 1} is (almost) straight — merge the two legs into one`);
    }
    // fronts on the right: turning right (toward the fronts) is an interior corner
    const interior = turn < 0;
    A.cornerEnd = { interior };
    B.cornerStart = { interior };
    if (Math.abs(v2.dot(A.X, B.X)) > 0.2) warnings.push(`${where}: corner ${i + 1} is not a right angle — corner units assume 90° corners`);
  }

  // where is there a wall right behind the back line?
  if (!rp.freestanding)
    for (const leg of res.legs) {
      const step = 0.05;
      let open: number | null = null;
      for (let x = 0; x <= leg.len + 1e-6; x += step) {
        const hit = !!inWall(legPoint(leg, Math.min(x, leg.len - 0.01), 0.04), ctx.segments);
        if (hit && open === null) open = Math.max(0, x - step / 2);
        if (!hit && open !== null) {
          leg.backed.push([open, x - step / 2]);
          open = null;
        }
      }
      if (open !== null) leg.backed.push([open, leg.len]);
      // snap interval ends that are within a step of the leg ends
      for (const iv of leg.backed) {
        if (iv[0] < step) iv[0] = 0;
        if (iv[1] > leg.len - step) iv[1] = leg.len;
      }
    }

  // openings in the wall behind each leg
  for (const leg of res.legs) {
    for (const o of ctx.openings) {
      const s = o.seg;
      const d = segDir(s);
      if (Math.abs(v2.cross(d, leg.X)) > 0.05) continue;
      const c = v2.add(s.a, v2.scale(d, o.u));
      const off = v2.dot(v2.sub(c, leg.a), leg.n); // centerline is behind the back line: negative
      if (Math.abs(-off - s.thickness / 2) > 0.08) continue;
      const xc = v2.dot(v2.sub(c, leg.a), leg.X);
      if (xc + o.width / 2 < -0.05 || xc - o.width / 2 > leg.len + 0.05) continue;
      const sill = o.z0 - ctx.elevation;
      leg.openings.push({ id: o.id, type: o.op.type, x0: xc - o.width / 2, x1: xc + o.width / 2, sill, top: sill + o.height });
    }
  }

  const D = dims.depth, UD = dims.upperDepth;
  const free = (p: Vec2, dir: Vec2, n: Vec2, depth: number) => {
    // a run end is "free" when there is no wall right beyond it
    for (const k of [0.25, 0.6]) if (inWall(v2.add(v2.add(p, v2.scale(dir, 0.04)), v2.scale(n, depth * k)), ctx.segments)) return false;
    return true;
  };
  const first = res.legs[0], last = res.legs[res.legs.length - 1];
  const freeStart = rp.freestanding || free(first.a, v2.scale(first.X, -1), first.n, D);
  const freeEnd = rp.freestanding || free(last.b, last.X, last.n, D);
  res.freeStart = freeStart;
  res.freeEnd = freeEnd;

  // ---- split module lists per leg (corner markers) ----
  const splitRow = (list: CaseModule[], isUpper: boolean, legCap: (leg: number) => number): { m: CaseModule; index: number }[][] => {
    const nLegs = res.legs.length;
    const chunks: { m: CaseModule; index: number }[][] = [[]];
    const markers = list.filter((m) => m.kind === "corner").length;
    if (markers > 0) {
      list.forEach((m, index) => {
        if (m.kind === "corner") {
          chunks[chunks.length - 1].push({ m, index });
          if (chunks.length < nLegs) chunks.push([]);
          else warnings.push(`${where}: ${isUpper ? "uppers" : "modules"}[${index}] is a corner but the run has only ${nLegs - 1} corner(s) — remove it`);
        } else chunks[chunks.length - 1].push({ m, index });
      });
      if (markers < nLegs - 1 && list.length)
        warnings.push(`${where}: ${isUpper ? "uppers" : "modules"} has ${markers} corner marker(s) but the path has ${nLegs - 1} corner(s) — add {kind:'corner'} between the modules of each leg`);
      while (chunks.length < nLegs) chunks.push([]);
      return chunks;
    }
    // greedy split by length
    let leg = 0, used = 0;
    list.forEach((m, index) => {
      const w = typeof m.width === "number" ? m.width : m.width === "auto" ? 0.3 : DEFAULT_WIDTH[m.kind];
      if (leg < nLegs - 1 && used + w > legCap(leg) + 0.01 && chunks[leg].length) {
        chunks[leg].push({ m: { kind: "corner" } as CaseModule, index: -1 });
        leg++;
        used = 0;
        chunks.push([]);
      }
      chunks[leg].push({ m, index });
      used += w;
    });
    while (chunks.length < nLegs) chunks.push([]);
    // a leg that got nothing still needs the corner closing the previous leg
    for (let i = 0; i < nLegs - 1; i++) if (!chunks[i].some((c) => c.m.kind === "corner") && chunks[i].length && chunks[i + 1].length) chunks[i].push({ m: { kind: "corner" } as CaseModule, index: -1 });
    return chunks;
  };

  // exterior corners extend the leg by the depth (corner post)
  for (const leg of res.legs) {
    if (leg.cornerEnd && !leg.cornerEnd.interior) leg.end = leg.len + D;
  }

  const legCapBase = (i: number) => res.legs[i].end - (res.legs[i].cornerStart?.interior ? D + 0.05 : 0);
  const baseChunks = splitRow(run.modules, false, legCapBase);
  const label = (m: CaseModule, index: number, isUpper: boolean) =>
    `${id}/${m.id ?? (index >= 0 ? `${isUpper ? "uppers" : "modules"}[${index}] ${m.kind}` : `auto ${m.kind}`)}`;

  // ---- base / tall row ----
  const baseZ0 = (row: Row) => (row === "base" ? (dims.elevation > 0 ? dims.elevation : dims.plinth) : dims.plinth);
  const mkPlaced = (m: CaseModule, index: number, row: Row, leg: number, x0: number, x1: number, isUpper: boolean): Placed => {
    const depth = m.depth ?? (row === "upper" ? (m.kind === "hood" && m.hood !== "integrated" ? Math.max(UD, 0.5) : UD) : row === "tall" && (dims.type === "media" || dims.type === "shelving") ? Math.min(D, 0.4) : D);
    let z0 = 0, z1 = 0;
    if (row === "upper") {
      z0 = dims.upperBottom;
      z1 = m.height ? z0 + m.height : dims.upperTop;
      if (m.kind === "hood" && m.hood !== "integrated") z0 = Math.max(dims.height + 0.6, Math.min(z0, dims.height + 0.65));
    } else if (row === "tall") {
      z0 = baseZ0("tall");
      z1 = m.height ?? dims.tallTop;
    } else {
      z0 = baseZ0("base");
      z1 = dims.height;
    }
    const hasTop = row === "base" && m.kind !== "end_panel" && (m.kind !== "gap" || m.worktop === true);
    return {
      module: m, kind: m.kind, row, index, id: m.id ?? `${m.kind}${index >= 0 ? index : ""}`, label: label(m, index, isUpper), leg, x0, x1, depth, z0, z1,
      exposedL: false, exposedR: false, open: !!m.open, worktop: hasTop,
    };
  };

  const layoutChunk = (chunk: { m: CaseModule; index: number }[], s: number, e: number, legIdx: number, isUpper: boolean, legsTotal: number, out: Placed[], rowName: string) => {
    const items = chunk.filter((c) => c.m.kind !== "corner");
    const corner = chunk.find((c) => c.m.kind === "corner");
    const leg = res.legs[legIdx];
    // the corner unit sits at the end of the leg
    let cornerW = 0;
    const legDepth = isUpper ? UD : D;
    if (corner && leg.cornerEnd) {
      if (leg.cornerEnd.interior) {
        const want = typeof corner.m.width === "number" ? corner.m.width : legDepth + (isUpper ? 0.35 : 0.45);
        cornerW = Math.max(want, legDepth + 0.25);
      } else cornerW = legDepth;
      e -= cornerW;
    }
    const fixed = items.reduce((sum, c) => sum + (c.m.width === "auto" ? 0 : typeof c.m.width === "number" ? c.m.width : DEFAULT_WIDTH[c.m.kind]), 0);
    const autos = items.filter((c) => c.m.width === "auto").length;
    const avail = e - s;
    let autoW = 0, scale = 1;
    if (autos) {
      autoW = (avail - fixed) / autos;
      if (autoW < 0.1) {
        warnings.push(`${where}: ${rowName} on leg ${legIdx + 1}: the fixed widths (${fmt(fixed)} m) leave only ${fmt(Math.max(0, avail - fixed))} m for ${autos} 'auto' module(s) — make the fixed modules narrower or the run longer`);
        autoW = 0.1;
      }
    }
    const need = fixed + autoW * autos;
    if (need > avail + 0.005) {
      scale = avail / need;
      warnings.push(
        `${where}: ${rowName} on leg ${legIdx + 1} need ${fmt(need)} m but only ${fmt(avail)} m is available — modules were squeezed by ${fmt(need - avail)} m; reduce widths by ${fmt(need - avail)} m${legsTotal === 1 && !res.freestanding ? " or lengthen the run (path / to)" : ""}`,
      );
    }
    let x = s;
    for (const c of items) {
      const w = (c.m.width === "auto" ? autoW : typeof c.m.width === "number" ? c.m.width : DEFAULT_WIDTH[c.m.kind]) * scale;
      out.push(mkPlaced(c.m, c.index, rowOf(c.m.kind, isUpper), legIdx, x, x + w, isUpper));
      x += w;
    }
    const left = e - x;
    if (left > 0.005) {
      // leftover length: absorb small gaps with a scribe filler, report bigger ones
      const lastLeg = legIdx === res.legs.length - 1;
      if (!isUpper) {
        const againstWall = !(lastLeg ? freeEnd : false) || !!corner;
        if (left <= 0.1 && againstWall) {
          const p = mkPlaced({ kind: "filler" } as CaseModule, -1, out.length && out[out.length - 1].row === "tall" ? "tall" : "base", legIdx, x, x + left, false);
          p.auto = "scribe";
          out.push(p);
        } else {
          warnings.push(
            `${where}: modules on leg ${legIdx + 1} fill ${fmt(x - s)} of ${fmt(avail)} m — ${fmt(left)} m is left empty at the ${corner ? "corner" : "end"}; give one module width 'auto'${lastLeg && !corner ? " or shorten the run by " + fmt(left) + " m" : ""}`,
          );
          if (corner) {
            const p = mkPlaced({ kind: "filler" } as CaseModule, -1, "base", legIdx, x, x + left, false);
            p.auto = "scribe";
            out.push(p);
          }
        }
      }
    }
    if (corner && leg.cornerEnd) {
      const p = mkPlaced(corner.m, corner.index, isUpper ? "upper" : "base", legIdx, e, e + cornerW, isUpper);
      p.kind = "corner";
      if (leg.cornerEnd.interior) {
        p.blind = "right";
        p.blindWidth = (isUpper ? UD : D);
      } else p.block = true;
      out.push(p);
    }
  };

  res.legs.forEach((leg, i) => {
    let s = leg.start;
    if (leg.cornerStart?.interior) {
      // the previous leg's corner unit runs through the corner: start after its depth + a filler so fronts clear
      s = D + 0.05;
      const firstTall = baseChunks[i].find((c) => c.m.kind !== "corner");
      const row = firstTall && TALL.has(firstTall.m.kind) ? "tall" : "base";
      const f = mkPlaced({ kind: "filler" } as CaseModule, -1, row, i, D, D + 0.05, false);
      f.auto = "corner_filler";
      res.base.push(f);
    }
    layoutChunk(baseChunks[i], s, leg.end, i, false, res.legs.length, res.base, "modules");
  });

  // ---- uppers: skip spans above tall modules ----
  if (run.uppers.length) {
    const blocksOf = (legIdx: number): [number, number][] =>
      res.base.filter((p) => p.leg === legIdx && p.row === "tall").map((p) => [p.x0, p.x1] as [number, number]).sort((a, b) => a[0] - b[0]);
    const capU = (i: number) => {
      const leg = res.legs[i];
      return leg.end - (leg.cornerStart?.interior ? UD + 0.05 : 0) - blocksOf(i).reduce((s, b) => s + b[1] - b[0], 0);
    };
    const chunks = splitRow(run.uppers, true, capU);
    const legHasUppers = chunks.map((c) => c.some((x) => x.m.kind !== "corner" && x.m.kind !== "gap"));
    chunks.forEach((chunk, i) => {
      const leg = res.legs[i];
      let s = leg.start;
      if (leg.cornerStart?.interior && chunks[i - 1]?.some((c) => c.m.kind === "corner") && legHasUppers[i - 1]) {
        s = UD + 0.05;
        const f = mkPlaced({ kind: "filler" } as CaseModule, -1, "upper", i, UD, UD + 0.05, true);
        f.auto = "corner_filler";
        res.uppers.push(f);
      }
      let e = leg.end;
      const corner = chunk.find((c) => c.m.kind === "corner");
      let cornerW = 0;
      if (corner && leg.cornerEnd && legHasUppers[i + 1]) {
        cornerW = leg.cornerEnd.interior ? Math.max(typeof corner.m.width === "number" ? corner.m.width : UD + 0.35, UD + 0.25) : UD;
        e -= cornerW;
      }
      layoutUppers(chunk.filter((c) => c.m.kind !== "corner"), s, e, i, blocksOf(i));
      if (cornerW > 0) {
        const p = mkPlaced(corner!.m, corner!.index, "upper", i, e, e + cornerW, true);
        p.kind = "corner";
        if (leg.cornerEnd!.interior) {
          p.blind = "right";
          p.blindWidth = UD;
        } else p.block = true;
        res.uppers.push(p);
      }
    });
  }

  function layoutUppers(items: { m: CaseModule; index: number }[], s: number, e: number, legIdx: number, blocks: [number, number][]) {
    // free intervals between tall blocks
    const freeIv = (lo: number, hi: number): [number, number][] => {
      const out: [number, number][] = [];
      let cur = lo;
      for (const [b0, b1] of blocks) {
        if (b1 <= cur + 1e-6 || b0 >= hi - 1e-6) continue;
        if (b0 > cur + 0.01) out.push([cur, Math.min(b0, hi)]);
        cur = Math.max(cur, b1);
      }
      if (hi > cur + 0.01) out.push([cur, hi]);
      return out;
    };
    let cursor = s;
    let group: { m: CaseModule; index: number }[] = [];
    const flush = (hi: number) => {
      for (const [lo, up] of freeIv(cursor, hi)) {
        if (!group.length) break;
        // take items while their fixed widths fit
        const take: typeof group = [];
        let fixed = 0;
        while (group.length) {
          const c = group[0];
          const w = c.m.width === "auto" ? 0.2 : typeof c.m.width === "number" ? c.m.width : DEFAULT_WIDTH[c.m.kind];
          if (fixed + w > up - lo + 0.005 && take.length) break;
          take.push(group.shift()!);
          fixed += c.m.width === "auto" ? 0 : w;
        }
        const autos = take.filter((c) => c.m.width === "auto").length;
        const autoW = autos ? Math.max(0.1, (up - lo - fixed) / autos) : 0;
        let x = lo;
        for (const c of take) {
          const w = c.m.width === "auto" ? autoW : typeof c.m.width === "number" ? c.m.width : DEFAULT_WIDTH[c.m.kind];
          res.uppers.push(mkPlaced(c.m, c.index, "upper", legIdx, x, x + w, true));
          x += w;
        }
        if (x > up + 0.01) warnings.push(`${where}: uppers on leg ${legIdx + 1} overrun the space by ${fmt(x - up)} m (above tall units or past the end) — make them narrower`);
      }
      for (const c of group) warnings.push(`${where}: no room left for ${label(c.m, c.index, true)} — remove it or make the uppers narrower`);
      group = [];
    };
    for (const c of items) {
      if (c.m.over) {
        const target = res.base.find((p) => p.module.id === c.m.over);
        if (!target) {
          warnings.push(`${where}: uppers[${c.index}].over = '${c.m.over}' is not the id of a base/tall module in this run (ids: ${res.base.filter((p) => p.module.id).map((p) => p.module.id).join(", ") || "none"})`);
          group.push({ ...c, m: { ...c.m, over: undefined } });
          continue;
        }
        if (target.leg !== legIdx) {
          warnings.push(`${where}: uppers[${c.index}] (over '${c.m.over}') is on leg ${legIdx + 1} but '${c.m.over}' is on leg ${target.leg + 1} — fix the corner markers in uppers`);
          continue;
        }
        const w = typeof c.m.width === "number" ? c.m.width : target.x1 - target.x0;
        const cx = (target.x0 + target.x1) / 2;
        const x0 = Math.max(cursor, cx - w / 2), x1 = Math.min(e, cx + w / 2);
        flush(x0);
        res.uppers.push(mkPlaced(c.m, c.index, "upper", legIdx, x0, x1, true));
        cursor = x1;
      } else group.push(c);
    }
    flush(e);
  }

  // ---- exposed sides (get front-material end panels) ----
  const endMode = run.endPanels ?? "auto";
  const mark = (row: Placed[], isUpper: boolean) => {
    const byLeg = new Map<number, Placed[]>();
    for (const p of row) byLeg.set(p.leg, [...(byLeg.get(p.leg) ?? []), p]);
    for (const [li, list] of byLeg) {
      list.sort((a, b) => a.x0 - b.x0);
      const leg = res.legs[li];
      list.forEach((p, k) => {
        if (p.kind === "gap" || p.kind === "filler" || p.kind === "end_panel") return;
        const prev = list[k - 1], next = list[k + 1];
        const solid = (q: Placed | undefined, gapTol: number) => !!q && q.kind !== "gap" && q.kind !== "hood" && Math.abs((q === prev ? q.x1 : q.x0) - (q === prev ? p.x0 : p.x1)) < gapTol;
        const higher = (q: Placed | undefined) => !!q && (q.z1 < p.z1 - 0.05 || q.depth < p.depth - 0.05);
        let L: boolean, R: boolean;
        if (isUpper) {
          L = !solid(prev, 0.02) || higher(prev);
          R = !solid(next, 0.02) || higher(next);
          if (!prev && p.x0 < 0.02 && leg.index === 0 && !freeStart) L = false;
          if (!next && p.x1 > leg.end - 0.02 && leg.index === res.legs.length - 1 && !freeEnd) R = false;
          if (!prev && leg.cornerStart?.interior) L = p.x0 > UD + 0.12;
          if (!next && leg.cornerEnd && p.kind !== "corner") R = true;
        } else {
          L = prev ? !solid(prev, 0.02) || higher(prev) : leg.index === 0 ? freeStart : !leg.cornerStart?.interior;
          R = next ? !solid(next, 0.02) || higher(next) : leg.index === res.legs.length - 1 ? freeEnd : false;
          if (p.row === "base" && prev?.row === "tall") L = false;
          if (p.row === "base" && next?.row === "tall") R = false;
          if (endMode === "none") L = R = false;
          if (endMode === "left" || endMode === "both") L = L || (!prev && leg.index === 0);
          if (endMode === "right" || endMode === "both") R = R || (!next && leg.index === res.legs.length - 1);
        }
        p.exposedL = L;
        p.exposedR = R;
      });
    }
  };
  mark(res.base, false);
  mark(res.uppers, true);

  // ---- worktop spans ----
  const isl = run.island;
  for (const leg of res.legs) {
    const list = res.base.filter((p) => p.leg === leg.index).sort((a, b) => a.x0 - b.x0);
    let cur: WorktopSpan | null = null;
    const yf = -(D + dims.overhang);
    const yb = res.freestanding ? (isl?.backPanel !== false ? 0.019 : 0) + (isl?.seating ?? 0) : 0;
    const integ = (p: Placed) => p.kind === "basin" && p.module.basin === "integrated";
    let curInteg = false;
    for (const p of list) {
      if (p.worktop && p.row === "base") {
        // integrated (ceramic) vanity tops are their own pieces
        if (cur && Math.abs(cur.x1 - p.x0) < 0.01 && integ(p) === curInteg) cur.x1 = p.x1;
        else {
          if (cur) res.spans.push(cur);
          cur = { leg: leg.index, x0: p.x0, x1: p.x1, yf, yb, waterfallL: false, waterfallR: false };
          curInteg = integ(p);
        }
      } else if (cur) {
        res.spans.push(cur);
        cur = null;
      }
    }
    if (cur) res.spans.push(cur);
  }
  for (const sp of res.spans) {
    const leg = res.legs[sp.leg];
    // the previous leg's worktop covers the corner square: start at its front edge
    if (leg.cornerStart?.interior && sp.x0 <= D + 0.06) sp.x0 = D + dims.overhang;
    if (res.freestanding && isl) {
      if ((isl.waterfall === "left" || isl.waterfall === "both") && sp.x0 <= leg.start + 0.01) sp.waterfallL = true;
      if ((isl.waterfall === "right" || isl.waterfall === "both") && sp.x1 >= leg.end - 0.01) sp.waterfallR = true;
    }
  }
  return res;
}

// ---------------------------------------------------------------------------------------------
// geometry queries (world plan coordinates)

/** World point of a leg-local (x, y) — y is toward the wall, fronts are at y = -depth. */
export function legPoint(leg: Leg, x: number, y: number): Vec2 {
  return v2.add(leg.a, v2.add(v2.scale(leg.X, x), v2.scale(leg.n, -y)));
}

/** Footprint rectangle of a placed module (CCW: front-left, front-right, back-right, back-left). */
export function footprint(r: ResolvedRun, p: Placed, extraFront = 0): Vec2[] {
  const leg = r.legs[p.leg];
  const d = p.depth + extraFront;
  return [legPoint(leg, p.x0, -d), legPoint(leg, p.x1, -d), legPoint(leg, p.x1, 0), legPoint(leg, p.x0, 0)];
}

/** Worktop outline of a span (CCW). */
export function spanOutline(r: ResolvedRun, s: WorktopSpan): Vec2[] {
  const leg = r.legs[s.leg];
  const wt = r.dims.wt;
  const x0 = s.x0 - (s.waterfallL ? wt : 0), x1 = s.x1 + (s.waterfallR ? wt : 0);
  return [legPoint(leg, x0, s.yf), legPoint(leg, x1, s.yf), legPoint(leg, x1, s.yb), legPoint(leg, x0, s.yb)];
}

export { pointSegment, segLength };
