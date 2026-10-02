import type { LevelInfo } from "../build.js";
import { segDir } from "../elements/walls.js";
import { FURNITURE } from "../elements/furniture.js";
import { terraceGuards } from "../elements/terraces.js";
import { shapeFootprint } from "../elements/shapes.js";
import { deg2rad, pointInPolygon, pointSegment, polygonArea, polygonCentroid, v2, type Vec2 } from "../geometry/math.js";
import type { Compiled } from "../pipeline.js";
import { directionToDegrees, type Stair } from "../schema/schema.js";

export interface PlanOptions {
  /** Pixels per meter. */
  scale?: number;
  /** Label walls/openings/furniture with their ids (useful for AI editing). */
  labels?: boolean;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const ROOM_COLORS = ["#f6e7c8", "#d9ecf7", "#e2f2dc", "#f7dfe4", "#e9e2f5", "#fbeedd", "#dff3f0", "#f1f1d8"];
/** Slabs raised more than this above the level floor are drawn as overhead (canopies, roof decks...). */
const OVERHEAD = 0.3;
/** Furniture that lies flat on the floor and must be drawn below everything else. */
const FLAT_TYPES = new Set(["rug", "door_mat", "mat", "carpet"]);

// ---------------------------------------------------------------------------------------------
// stair geometry in plan (mirrors the layout in elements/stairs.ts)

interface StairPlan {
  /** Outlines of flights / landings / the spiral disc. */
  parts: Vec2[][];
  /** Step nosing lines. */
  treads: [Vec2, Vec2][];
  /** Walking line from the first step to the top. */
  path: Vec2[];
  /** Stairwell outline cut out of the slab above (same as elements/stairs.ts footprints). */
  hole: Vec2[];
  spiral?: { center: Vec2; radius: number };
}

function stairPlan(s: Stair, levelHeight: number): StairPlan {
  const rise = s.rise ?? levelHeight;
  const n = Math.max(2, Math.round(rise / s.riser));
  const t = s.tread, w = s.width;
  const ang = deg2rad(directionToDegrees(s.direction));
  const dir: Vec2 = [Math.cos(ang), Math.sin(ang)];
  const right: Vec2 = [dir[1], -dir[0]];
  const start = s.start as Vec2;
  const W = (p: Vec2): Vec2 => v2.add(start, v2.add(v2.scale(right, p[0]), v2.scale(dir, p[1])));
  const treads: [Vec2, Vec2][] = [];
  const parts: Vec2[][] = [];

  if (s.type === "spiral") {
    const R = w;
    const walk = R * 0.6;
    const sense = s.turn === "left" ? 1 : -1;
    const dT = Math.min(t / walk, (2 * Math.PI) / 12) * sense;
    const at = (a: number, r: number): Vec2 => v2.add(start, [Math.cos(a) * r, Math.sin(a) * r]);
    for (let i = 0; i < n; i++) treads.push([at(ang + i * dT, 0.08), at(ang + i * dT, R)]);
    const path: Vec2[] = [];
    for (let i = 0; i <= 4 * (n - 1); i++) path.push(at(ang + (0.5 + i / 4) * dT * ((n - 1.5) / (n - 1)), walk));
    const circle: Vec2[] = [];
    for (let i = 0; i < 40; i++) circle.push(at((i / 40) * 2 * Math.PI, R));
    parts.push(circle);
    const hole: Vec2[] = [];
    for (let i = 0; i < 24; i++) hole.push(at((i / 24) * 2 * Math.PI, R + 0.05));
    return { parts, treads, path, hole, spiral: { center: start, radius: R } };
  }

  /** A flight with its own origin and climbing axis (stair-local coords). */
  const flight = (o: Vec2, fy: Vec2, nn: number) => {
    const fx: Vec2 = [fy[1], -fy[0]];
    for (let i = 0; i < nn; i++) {
      const c = v2.add(o, v2.scale(fy, i * t));
      treads.push([W(v2.sub(c, v2.scale(fx, w / 2))), W(v2.add(c, v2.scale(fx, w / 2)))]);
    }
    const run = (nn - 1) * t;
    const e = v2.add(o, v2.scale(fy, run));
    parts.push([v2.sub(o, v2.scale(fx, w / 2)), v2.add(o, v2.scale(fx, w / 2)), v2.add(e, v2.scale(fx, w / 2)), v2.sub(e, v2.scale(fx, w / 2))].map(W));
  };
  const rect = (x0: number, y0: number, x1: number, y1: number) => parts.push(([[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as Vec2[]).map(W));

  if (s.type === "straight") {
    flight([0, 0], [0, 1], n);
    return { parts, treads, path: [W([0, 0]), W([0, (n - 1) * t])], hole: parts[0] };
  }
  const n1 = Math.min(n - 2, Math.max(2, s.split ?? Math.floor(n / 2)));
  const n2 = n - n1;
  const turn = s.turn === "left" ? -1 : 1;
  const run1 = (n1 - 1) * t, run2 = (n2 - 1) * t;
  flight([0, 0], [0, 1], n1);
  if (s.type === "L") {
    rect(-w / 2, run1, w / 2, run1 + w);
    flight([turn * (w / 2), run1 + w / 2], [turn, 0], n2);
    const ex = turn * (w / 2 + run2);
    const hole = ([[-turn * (w / 2), 0], [turn * (w / 2), 0], [turn * (w / 2), run1], [ex, run1], [ex, run1 + w], [-turn * (w / 2), run1 + w]] as Vec2[]).map(W);
    return { parts, treads, path: [[0, 0], [0, run1 + w / 2], [turn * (w / 2 + run2), run1 + w / 2]].map((p) => W(p as Vec2)), hole };
  }
  const off = turn * (w + s.gap);
  const xa = Math.min(-w / 2, off - w / 2), xb = Math.max(w / 2, off + w / 2);
  rect(xa, run1, xb, run1 + w);
  flight([off, run1], [0, -1], n2);
  const y0 = Math.min(0, run1 - run2);
  const hole = ([[xa, y0], [xb, y0], [xb, run1 + w], [xa, run1 + w]] as Vec2[]).map(W);
  return { parts, treads, path: [[0, 0], [0, run1 + w / 2], [off, run1 + w / 2], [off, run1 - run2]].map((p) => W(p as Vec2)), hole };
}

// ---------------------------------------------------------------------------------------------
// label layer: greedy placement with collision avoidance

interface Box { x0: number; y0: number; x1: number; y1: number }
interface LabelLine { text: string; size: number; color: string; bold?: boolean }
interface Cand { x: number; y: number; cost: number }
interface LabelReq {
  lines: LabelLine[];
  /** Lower is placed first (wins). */
  prio: number;
  cands: Cand[];
  /** Skip the label when every candidate collides with an already placed label. */
  optional?: boolean;
  halo?: string;
  avoidWalls?: boolean;
  /** Penalize boxes leaving this polygon (px). */
  within?: Vec2[];
  /** Soft obstacles (penalty proportional to overlap area). */
  soft?: Box[];
  softWeight?: number;
}

function charW(ch: string): number {
  if ("ijl".includes(ch)) return 0.23;
  if ("ft/.,:;!|'I ²()".includes(ch)) return 0.29;
  if (ch === "r") return 0.34;
  if (ch === "m") return 0.84;
  if (ch === "w") return 0.73;
  if ("MW".includes(ch)) return 0.85;
  if (/[A-Z]/.test(ch)) return 0.7;
  if ("cksvxyz".includes(ch)) return 0.5;
  return 0.56;
}
const textWidth = (s: string, size: number, bold = false) => [...s].reduce((a, ch) => a + charW(ch), 0) * size * (bold ? 1.08 : 1);
const overlapArea = (a: Box, b: Box) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));

/** Separating-axis test: axis-aligned box vs convex polygon. */
function boxHitsPoly(b: Box, poly: Vec2[]): boolean {
  const corners: Vec2[] = [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]];
  const axes: Vec2[] = [[1, 0], [0, 1]];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], c = poly[(i + 1) % poly.length];
    if (v2.dist(a, c) > 1e-6) axes.push(v2.perp(v2.sub(c, a)));
  }
  for (const ax of axes) {
    const p1 = corners.map((p) => v2.dot(p, ax)), p2 = poly.map((p) => v2.dot(p, ax));
    if (Math.max(...p1) <= Math.min(...p2) + 0.5 || Math.max(...p2) <= Math.min(...p1) + 0.5) return false;
  }
  return true;
}

function placeLabels(reqs: LabelReq[], walls: Vec2[][], W: number, H: number): string[] {
  const out: string[] = [];
  const placed: Box[] = [];
  const order = reqs.map((r, i) => ({ r, i })).sort((a, b) => a.r.prio - b.r.prio || a.i - b.i);
  for (const { r } of order) {
    const lh = r.lines.map((l) => l.size * 1.15);
    const bw = Math.max(...r.lines.map((l) => textWidth(l.text, l.size, l.bold))) + 4;
    const bh = lh.reduce((a, b) => a + b, 0) + 2;
    let best: { box: Box; cost: number } | null = null;
    for (const c of r.cands) {
      const box: Box = { x0: c.x - bw / 2, y0: c.y - bh / 2, x1: c.x + bw / 2, y1: c.y + bh / 2 };
      let cost = c.cost;
      if (box.x0 < 2 || box.y0 < 2 || box.x1 > W - 2 || box.y1 > H - 2) cost += 5000;
      let hit = 0;
      for (const p of placed) hit += overlapArea(box, p);
      if (hit > 0) {
        if (r.optional) continue;
        cost += 1000 + hit * 5;
      }
      if (r.avoidWalls !== false && walls.some((w) => boxHitsPoly(box, w))) cost += 120;
      if (r.within) {
        const pts: Vec2[] = [[box.x0, box.y0], [box.x1, box.y0], [box.x1, box.y1], [box.x0, box.y1], [c.x, box.y0], [c.x, box.y1], [box.x0, c.y], [box.x1, c.y]];
        cost += pts.filter((p) => !pointInPolygon(p, r.within!)).length * 150;
      }
      if (r.soft) for (const s of r.soft) cost += overlapArea(box, s) * (r.softWeight ?? 0.05);
      if (!best || cost < best.cost) best = { box, cost };
    }
    if (!best) continue;
    placed.push(best.box);
    let y = best.box.y0 + 1;
    const cx = (best.box.x0 + best.box.x1) / 2;
    r.lines.forEach((l, i) => {
      const base = y + l.size * 0.92;
      const halo = r.halo ?? "#ffffff";
      out.push(
        `<text x="${cx.toFixed(1)}" y="${base.toFixed(1)}" font-size="${l.size}"${l.bold ? ' font-weight="bold"' : ""} fill="${l.color}" stroke="${halo}" stroke-width="3" stroke-linejoin="round" paint-order="stroke" text-anchor="middle">${esc(l.text)}</text>`,
      );
      y += lh[i];
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------

/** Top-down architectural plan of one level as SVG. */
export function renderPlanSVG(c: Compiled, levelId?: string, opts: PlanOptions = {}): string {
  if (!c.project) throw new Error("project failed to compile: " + c.errors.join("; "));
  const project = c.project;
  const li = levelId ? project.levels.findIndex((l) => l.id === levelId) : 0;
  if (li < 0) throw new Error(`level '${levelId}' not found (levels: ${project.levels.map((l) => l.id).join(", ")})`);
  const lv = project.levels[li];
  const info: LevelInfo = c.levels[li];
  const labels = opts.labels ?? true;

  // stairs of this level, and stairs from lower levels that arrive here
  const ownStairs = lv.stairs.map((s) => ({ s, plan: stairPlan(s, info.height) }));
  const arriving: { s: Stair; plan: StairPlan; hole: boolean }[] = [];
  for (let j = 0; j < li; j++) {
    const lj = c.levels[j];
    if (!lj) continue;
    for (const s of project.levels[j].stairs) {
      const top = lj.elevation + (s.rise ?? lj.height);
      if (Math.abs(top - info.elevation) < 0.05) arriving.push({ s, plan: stairPlan(s, lj.height), hole: s.cutSlabAbove });
    }
  }

  // bounds over everything on the level (fall back to the level below for empty levels)
  const pts: Vec2[] = [];
  for (const s of info.segments) pts.push(s.aL, s.aR, s.bL, s.bR);
  for (const r of lv.rooms) pts.push(...(r.polygon as Vec2[]));
  for (const s of lv.slabs) pts.push(...(s.polygon as Vec2[]));
  for (const r of lv.roofs) pts.push(...(r.polygon as Vec2[]));
  for (const r of lv.railings) pts.push(...(r.points as Vec2[]));
  for (const t of lv.terraces) pts.push(...(t.polygon as Vec2[]));
  for (const f of lv.furniture) pts.push(f.position as Vec2);
  for (const h of info.stairOutlines) pts.push(...h);
  for (const a of arriving) pts.push(...a.plan.hole);
  if (!pts.length) pts.push([0, 0], [10, 10]);
  let minX = Math.min(...pts.map((p) => p[0])), maxX = Math.max(...pts.map((p) => p[0]));
  let minY = Math.min(...pts.map((p) => p[1])), maxY = Math.max(...pts.map((p) => p[1]));
  minX = Math.floor(minX - 1); minY = Math.floor(minY - 1); maxX = Math.ceil(maxX + 1); maxY = Math.ceil(maxY + 1);
  const span = Math.max(maxX - minX, maxY - minY);
  const S = opts.scale ?? Math.max(20, Math.min(80, Math.round(1100 / span)));
  const pad = 50;
  const W = (maxX - minX) * S + pad * 2, H = (maxY - minY) * S + pad * 2 + 30;
  const X = (x: number) => +(pad + (x - minX) * S).toFixed(2);
  const Y = (y: number) => +(pad + 30 + (maxY - y) * S).toFixed(2);
  const P = (p: Vec2) => `${X(p[0])},${Y(p[1])}`;
  const px = (p: Vec2): Vec2 => [X(p[0]), Y(p[1])];
  const poly = (ps: Vec2[]) => ps.map(P).join(" ");
  const line = (a: Vec2, b: Vec2, attrs: string) => `<line x1="${X(a[0])}" y1="${Y(a[1])}" x2="${X(b[0])}" y2="${Y(b[1])}" ${attrs}/>`;
  const pxBox = (ps: Vec2[]): Box => {
    const q = ps.map(px);
    return { x0: Math.min(...q.map((p) => p[0])), y0: Math.min(...q.map((p) => p[1])), x1: Math.max(...q.map((p) => p[0])), y1: Math.max(...q.map((p) => p[1])) };
  };
  const out: string[] = [];
  const L: LabelReq[] = [];
  const fs = Math.max(9, Math.min(13, S / 4));
  const hatchStep = 7;

  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Helvetica, Arial, sans-serif">`);
  out.push(
    `<defs>` +
      `<marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#333"/></marker>` +
      `<marker id="arrow_dn" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#555"/></marker>` +
      `<pattern id="hatch_overhead" patternUnits="userSpaceOnUse" width="${hatchStep}" height="${hatchStep}" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="${hatchStep}" stroke="#b07a45" stroke-width="1"/></pattern>` +
      `</defs>`,
  );
  out.push(`<rect width="100%" height="100%" fill="#ffffff"/>`);
  out.push(`<text x="${pad}" y="28" font-size="18" font-weight="bold" fill="#222">${esc(project.name)} — ${esc(info.name)} (z=${info.elevation.toFixed(2)} m)</text>`);

  // grid with coordinates every meter (labels every `step` meters)
  const step = span > 40 ? 5 : span > 20 ? 2 : 1;
  for (let x = minX; x <= maxX; x++) {
    out.push(`<line x1="${X(x)}" y1="${Y(minY)}" x2="${X(x)}" y2="${Y(maxY)}" stroke="${x % step === 0 ? "#dcdcdc" : "#f0f0f0"}" stroke-width="1"/>`);
    if (x % step === 0) out.push(`<text x="${X(x)}" y="${Y(minY) + 14}" font-size="10" fill="#888" text-anchor="middle">${x}</text>`);
  }
  for (let y = minY; y <= maxY; y++) {
    out.push(`<line x1="${X(minX)}" y1="${Y(y)}" x2="${X(maxX)}" y2="${Y(y)}" stroke="${y % step === 0 ? "#dcdcdc" : "#f0f0f0"}" stroke-width="1"/>`);
    if (y % step === 0) out.push(`<text x="${X(minX) - 6}" y="${Y(y) + 3}" font-size="10" fill="#888" text-anchor="end">${y}</text>`);
  }

  // floor-level slabs (terraces, paths, driveways)
  const overhead = lv.slabs.filter((s) => s.offset > OVERHEAD);
  for (const s of lv.slabs) if (s.offset <= OVERHEAD) out.push(`<polygon points="${poly(s.polygon as Vec2[])}" fill="#eeeeee" stroke="#bbb" stroke-width="1"/>`);

  // terraces / balconies: warm deck fill under everything else
  const terraceGuardLines = lv.terraces.map((t) => terraceGuards(t, info.segments, info.elevation, c.levels[0].elevation));
  for (const t of lv.terraces) out.push(`<polygon points="${poly(t.polygon as Vec2[])}" fill="#efe6d6" stroke="#b5a184" stroke-width="1"/>`);

  // rooms
  lv.rooms.forEach((r, i) => {
    out.push(`<polygon points="${poly(r.polygon as Vec2[])}" fill="${ROOM_COLORS[i % ROOM_COLORS.length]}" stroke="none"/>`);
  });
  for (const r of lv.roofs)
    out.push(`<polygon points="${poly(r.polygon as Vec2[])}" fill="none" stroke="#c77" stroke-width="1.5" stroke-dasharray="8 4"/>`);

  // stairs arriving from below: the stairwell, with the flight seen through it (light) and a DN arrow
  const stairSoft: Box[] = [];
  for (const a of arriving) {
    out.push(`<polygon points="${poly(a.plan.hole)}" fill="#f2f2f2" stroke="none"/>`);
    for (const t of a.plan.treads) out.push(line(t[0], t[1], `stroke="#b8b8b8" stroke-width="1"`));
    for (const h of a.plan.parts) out.push(`<polygon points="${poly(h)}" fill="none" stroke="#c4c4c4" stroke-width="1"/>`);
    out.push(`<polygon points="${poly(a.plan.hole)}" fill="none" stroke="#888" stroke-width="1.2"${a.hole ? ` stroke-dasharray="5 3"` : ""}/>`);
    const down = [...a.plan.path].reverse();
    out.push(`<polyline points="${poly(down)}" fill="none" stroke="#555" stroke-width="1.3" marker-end="url(#arrow_dn)"/>`);
    out.push(`<circle cx="${X(down[0][0])}" cy="${Y(down[0][1])}" r="3" fill="#555"/>`);
    stairSoft.push(...a.plan.parts.map(pxBox));
    const top = px(down[0]);
    const towards = v2.norm(v2.sub(px(down[1]), px(down[0])));
    L.push({
      lines: [{ text: "DN", size: fs, color: "#444", bold: true }],
      prio: 1,
      cands: [
        { x: top[0] + towards[0] * fs * 1.4, y: top[1] + towards[1] * fs * 1.4, cost: 0 },
        { x: top[0] - towards[0] * fs * 1.2, y: top[1] - towards[1] * fs * 1.2, cost: 5 },
        { x: top[0] + fs * 1.6, y: top[1], cost: 10 },
        { x: top[0] - fs * 1.6, y: top[1], cost: 10 },
      ],
    });
  }

  // stairs starting on this level: outline, treads, walking line with UP arrow
  for (const { s, plan } of ownStairs) {
    for (const p of plan.parts) out.push(`<polygon points="${poly(p)}" fill="#ffffff" stroke="none"/>`);
    for (const t of plan.treads) out.push(line(t[0], t[1], `stroke="#888" stroke-width="1"`));
    for (const p of plan.parts) out.push(`<polygon points="${poly(p)}" fill="none" stroke="#555" stroke-width="1.5"/>`);
    if (plan.spiral) out.push(`<circle cx="${X(plan.spiral.center[0])}" cy="${Y(plan.spiral.center[1])}" r="${Math.max(2, 0.08 * S)}" fill="#555"/>`);
    out.push(`<polyline points="${poly(plan.path)}" fill="none" stroke="#333" stroke-width="1.5" marker-end="url(#arrow)"/>`);
    out.push(`<circle cx="${X(plan.path[0][0])}" cy="${Y(plan.path[0][1])}" r="3" fill="#333"/>`);
    stairSoft.push(...plan.parts.map(pxBox));
    const st = px(plan.path[0]);
    const fwd = v2.norm(v2.sub(px(plan.path[1]), st));
    L.push({
      lines: [{ text: "UP", size: fs, color: "#222", bold: true }],
      prio: 1,
      cands: [
        { x: st[0] - fwd[0] * fs * 1.3, y: st[1] - fwd[1] * fs * 1.3, cost: 0 },
        { x: st[0] + fwd[0] * fs * 1.4, y: st[1] + fwd[1] * fs * 1.4, cost: 5 },
        { x: st[0] + fs * 1.6, y: st[1], cost: 10 },
        { x: st[0] - fs * 1.6, y: st[1], cost: 10 },
      ],
    });
    if (labels && s.id) {
      const b = pxBox(plan.parts.flat());
      const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
      L.push({
        lines: [{ text: s.id, size: fs - 3, color: "#555" }],
        prio: 3,
        cands: [{ x: cx, y: cy, cost: 0 }, { x: cx, y: cy - fs, cost: 5 }, { x: cx, y: cy + fs, cost: 5 }, { x: cx, y: b.y0 - fs * 0.7, cost: 15 }, { x: cx, y: b.y1 + fs * 0.7, cost: 15 }],
      });
    }
  }

  // furniture footprints: flat things (rugs, mats) first, then by height so tall items stay on top
  const furn = lv.furniture.map((f, i) => {
    const t = FURNITURE[f.type];
    const h = f.height ?? t?.defaults.height ?? 1;
    const flat = FLAT_TYPES.has(f.type) || (h <= 0.03 && f.elevation <= 0.01);
    return { f, i, t, flat, top: f.elevation + h };
  });
  furn.sort((a, b) => (a.flat === b.flat ? a.top - b.top || a.i - b.i : a.flat ? -1 : 1));
  const furnSoft: Box[] = [];
  for (const { f, t, flat } of furn) {
    const w = f.width ?? t?.defaults.width ?? 1, dpt = f.depth ?? t?.defaults.depth ?? 1;
    const rot = deg2rad(f.rotation ?? (f.facing ? { south: 0, east: 90, north: 180, west: 270 }[f.facing] : 0));
    const c0 = f.position as Vec2;
    const corner = (x: number, y: number) => v2.add(c0, v2.rotate([x, y], rot));
    const rect = [corner(-w / 2, -dpt / 2), corner(w / 2, -dpt / 2), corner(w / 2, dpt / 2), corner(-w / 2, dpt / 2)];
    const high = f.elevation >= 1.2; // wall cabinets, ceiling lights: overhead, dashed
    if (flat) out.push(`<polygon points="${poly(rect)}" fill="#ffffff" fill-opacity="0.45" stroke="#9aaabd" stroke-width="1" stroke-dasharray="4 2"/>`);
    else if (high) out.push(`<polygon points="${poly(rect)}" fill="none" stroke="#6a7f99" stroke-width="1" stroke-dasharray="5 3"/>`);
    else {
      out.push(`<polygon points="${poly(rect)}" fill="#ffffff" fill-opacity="0.8" stroke="#6a7f99" stroke-width="1"/>`);
      // front edge
      out.push(line(rect[0], rect[1], `stroke="#2b4f80" stroke-width="2.5"`));
    }
    const b = pxBox(rect);
    if (!flat) furnSoft.push(b);
    if (labels) {
      const cx = X(c0[0]), cy = Y(c0[1]);
      const size = fs - 2;
      const tw = textWidth(f.id ?? f.type, size);
      const cands: Cand[] = [{ x: cx, y: cy, cost: 0 }];
      for (const k of [0.25, 0.5, 0.75]) cands.push({ x: cx + tw * k, y: cy, cost: 12 * k * 4 }, { x: cx - tw * k, y: cy, cost: 12 * k * 4 });
      for (const k of [1, 2]) cands.push({ x: cx, y: cy - size * 1.2 * k, cost: 15 * k }, { x: cx, y: cy + size * 1.2 * k, cost: 15 * k });
      for (const dx of [0.4, -0.4]) for (const dy of [1, -1]) cands.push({ x: cx + tw * dx, y: cy + size * 1.2 * dy, cost: 35 });
      cands.push({ x: cx, y: b.y0 - size * 0.7, cost: 60 }, { x: cx, y: b.y1 + size * 0.7, cost: 60 });
      cands.push({ x: b.x1 + tw / 2 + 3, y: cy, cost: 80 }, { x: b.x0 - tw / 2 - 3, y: cy, cost: 80 });
      L.push({ lines: [{ text: f.id ?? f.type, size, color: flat ? "#6a7f99" : "#2b4f80" }], prio: flat ? 3.5 : 3, cands });
    }
  }

  // overhead slabs (canopies, roof decks): hatched + dashed, labelled with their height
  for (const s of overhead) {
    const pg = s.polygon as Vec2[];
    const area = polygonArea(pg);
    out.push(
      `<polygon points="${poly(pg)}" fill="${area <= 30 ? "url(#hatch_overhead)" : "none"}" stroke="#b07a45" stroke-width="1.5" stroke-dasharray="7 4"/>`,
    );
    for (const h of s.holes as Vec2[][]) out.push(`<polygon points="${poly(h)}" fill="none" stroke="#b07a45" stroke-width="1" stroke-dasharray="3 3"/>`);
    const cc = px(polygonCentroid(pg));
    const b = pxBox(pg);
    const cands: Cand[] = [{ x: cc[0], y: cc[1], cost: 0 }];
    for (let i = 0; i < pg.length; i++) {
      const m = px(v2.lerp(pg[i], pg[(i + 1) % pg.length], 0.5));
      const inward = v2.norm(v2.sub(cc, m));
      cands.push({ x: m[0] + inward[0] * fs * 1.6, y: m[1] + inward[1] * fs * 1.6, cost: 40 });
    }
    cands.push({ x: (b.x0 + b.x1) / 2, y: b.y0 - fs * 1.2, cost: 80 }, { x: (b.x0 + b.x1) / 2, y: b.y1 + fs * 1.2, cost: 80 });
    const hTxt = `${s.offset >= 0 ? "+" : ""}${s.offset.toFixed(2)} m overhead`;
    L.push({
      lines: [...(labels && s.id ? [{ text: s.id, size: fs - 3, color: "#8a5a2b" }] : []), { text: hTxt, size: fs - 3, color: "#8a5a2b", bold: true }],
      prio: 2.5,
      cands,
    });
  }

  // a cut through a solid is filled like a wall; a hollow shell is drawn as a ring of its wall thickness
  const cutSection = (sh: (typeof lv.shapes)[number], ctr: Vec2, r: number) => {
    const hollow = "hollow" in sh && sh.hollow;
    return hollow
      ? `<circle cx="${X(ctr[0])}" cy="${Y(ctr[1])}" r="${((r - hollow.thickness / 2) * S).toFixed(1)}" fill="none" stroke="#3a3a3a" stroke-width="${Math.max(2, hollow.thickness * S).toFixed(1)}"/>`
      : `<circle cx="${X(ctr[0])}" cy="${Y(ctr[1])}" r="${(r * S).toFixed(1)}" fill="#3a3a3a"/>`;
  };
  // free-form shapes from lower levels that pass through this floor (e.g. a tower shaft through a sphere): cut section only
  c.project.levels.forEach((other, oi) => {
    if (oi === li) return;
    for (const sh of other.shapes) {
      const fp = shapeFootprint(sh, c.levels[oi].elevation, info.elevation + 1.2);
      if (fp?.cut) out.push(cutSection(sh, fp.center, fp.cut));
    }
  });
  // free-form shapes on this level: cut section at 1.2 m (solid, like walls) and widest extent overhead (dashed)
  for (const sh of lv.shapes) {
    if (sh.type === "box") {
      const [w, d] = sh.size;
      const rot = deg2rad(sh.rotation);
      const corner = (x: number, y: number) => v2.add([sh.center[0], sh.center[1]], v2.rotate([x, y], rot));
      out.push(`<polygon points="${poly([corner(-w / 2, -d / 2), corner(w / 2, -d / 2), corner(w / 2, d / 2), corner(-w / 2, d / 2)])}" fill="none" stroke="#7a7a7a" stroke-width="1" stroke-dasharray="5 3"/>`);
      continue;
    }
    const fp = shapeFootprint(sh, info.elevation, info.elevation + 1.2);
    if (!fp) continue;
    const [cx, cy] = fp.center;
    if (fp.max > (fp.cut ?? 0) + 0.05)
      out.push(`<circle cx="${X(cx)}" cy="${Y(cy)}" r="${(fp.max * S).toFixed(1)}" fill="none" stroke="#6d7f8f" stroke-width="1.2" stroke-dasharray="7 4"/>`);
    if (fp.cut) out.push(cutSection(sh, fp.center, fp.cut));
    if (labels && sh.name)
      L.push({ lines: [{ text: sh.name, size: fs - 3, color: "#4a5a68" }], prio: 3, optional: true, cands: [{ x: X(cx), y: Y(cy - fp.max) + fs + 2, cost: 0 }, { x: X(cx), y: Y(cy + fp.max) - 4, cost: 2 }] });
  }

  // columns
  for (const col of lv.columns) {
    const [x, y] = col.position;
    if (col.shape === "round") out.push(`<circle cx="${X(x)}" cy="${Y(y)}" r="${(col.size / 2) * S}" fill="#444"/>`);
    else out.push(`<rect x="${X(x - col.size / 2)}" y="${Y(y + col.size / 2)}" width="${col.size * S}" height="${col.size * S}" fill="#444"/>`);
  }

  // walls
  const wallPx: Vec2[][] = [];
  for (const s of info.segments) {
    out.push(`<polygon points="${poly([s.aR, s.bR, s.b, s.bL, s.aL, s.a])}" fill="#3a3a3a" stroke="#3a3a3a" stroke-width="0.5"/>`);
    wallPx.push([s.aR, s.bR, s.bL, s.aL].map(px));
  }
  // openings: clear the wall, then draw symbols
  const openingSoft: Box[] = [];
  for (const o of info.openings) {
    const s = o.seg;
    const d = segDir(s);
    const N = v2.perp(d);
    const half = s.thickness / 2 + 0.01;
    const at = (u: number, w: number): Vec2 => v2.add(s.a, v2.add(v2.scale(d, u), v2.scale(N, w)));
    const u0 = o.u - o.width / 2, u1 = o.u + o.width / 2;
    out.push(`<polygon points="${poly([at(u0, -half), at(u1, -half), at(u1, half), at(u0, half)])}" fill="#ffffff"/>`);
    openingSoft.push(pxBox([at(u0, -half), at(u1, -half), at(u1, half), at(u0, half)]));
    if (o.op.type === "window") {
      for (const w of [-half + 0.01, 0, half - 0.01]) out.push(line(at(u0, w), at(u1, w), `stroke="#3b82c4" stroke-width="1.5"`));
    } else if (o.op.type === "door") {
      const toward = (o.op.swing === "in") === (s.interiorSide === "left") ? 1 : -1;
      const leaves: { hinge: number; len: number }[] =
        o.style === "double"
          ? [{ hinge: u0, len: o.width / 2 }, { hinge: u1, len: -o.width / 2 }]
          : o.style === "sliding" || o.style === "garage"
            ? []
            : [o.op.hinge === "right" ? { hinge: u1, len: -o.width } : { hinge: u0, len: o.width }];
      for (const Lf of leaves) {
        const h = at(Lf.hinge, 0);
        const tip = at(Lf.hinge, toward * Math.abs(Lf.len));
        const closed = at(Lf.hinge + Lf.len, 0);
        const r = Math.abs(Lf.len) * S;
        const sweep = (Lf.len > 0) === (toward > 0) ? 0 : 1;
        out.push(line(h, tip, `stroke="#a0522d" stroke-width="2"`));
        out.push(`<path d="M ${P(tip)} A ${r} ${r} 0 0 ${sweep} ${P(closed)}" fill="none" stroke="#a0522d" stroke-width="1" stroke-dasharray="3 2"/>`);
      }
      if (!leaves.length) out.push(line(at(u0, 0), at(u1, 0), `stroke="#a0522d" stroke-width="2"`));
    }
    if (labels) {
      const off = half + 0.22 + (fs - 3) / S / 2;
      const cands: Cand[] = [];
      [-1, 1].forEach((side, si) => {
        for (const [du, c] of [[0, 0], [0.35, 20], [-0.35, 20], [0.7, 40], [-0.7, 40]] as const) {
          const p = px(at(o.u + du * Math.max(o.width, 0.8), side * off));
          cands.push({ x: p[0], y: p[1], cost: c + si * 8 });
        }
        const p2 = px(at(o.u, side * (off + (fs - 1) / S)));
        cands.push({ x: p2[0], y: p2[1], cost: 30 + si * 8 });
      });
      L.push({ lines: [{ text: o.id, size: fs - 3, color: "#a0522d" }], prio: 2, cands });
    }
  }

  // railings: bold and solid so they can't be mistaken for stairwell / slab outlines
  // (terrace guards are drawn the same way: railings in their style, parapets as solid)
  const terraceRails = lv.terraces.flatMap((t, i) =>
    terraceGuardLines[i].lines.map((l) => ({ ...l, id: undefined as string | undefined, style: terraceGuardLines[i].guard === "parapet" ? "solid" : t.railingStyle })),
  );
  for (const r of [...lv.railings, ...terraceRails]) {
    const ptsR = [...(r.points as Vec2[]), ...(r.closed ? [r.points[0] as Vec2] : [])];
    const pl = poly(ptsR);
    if (r.style === "glass") {
      out.push(`<polyline points="${pl}" fill="none" stroke="#1c7fc0" stroke-width="4" stroke-linejoin="miter"/>`);
      out.push(`<polyline points="${pl}" fill="none" stroke="#d6efff" stroke-width="1.3" stroke-linejoin="miter"/>`);
    } else if (r.style === "solid") {
      out.push(`<polyline points="${pl}" fill="none" stroke="#555" stroke-width="5" stroke-linejoin="miter"/>`);
    } else {
      out.push(`<polyline points="${pl}" fill="none" stroke="#222" stroke-width="2.2" stroke-linejoin="miter"/>`);
    }
    // posts at the corners and roughly every meter
    const postColor = r.style === "glass" ? "#0d4f7a" : "#222";
    const ps = Math.max(3, Math.min(6, S * 0.07));
    for (let i = 0; i < ptsR.length - 1; i++) {
      const a = ptsR[i], b = ptsR[i + 1];
      const len = v2.dist(a, b);
      const k = Math.max(1, Math.round(len / 1.0));
      for (let j = i === 0 ? 0 : 1; j <= k; j++) {
        const p = px(v2.lerp(a, b, j / k));
        out.push(`<rect x="${(p[0] - ps / 2).toFixed(1)}" y="${(p[1] - ps / 2).toFixed(1)}" width="${ps}" height="${ps}" fill="${postColor}"/>`);
      }
    }
    if (labels && r.id) {
      const cands: Cand[] = [];
      for (let i = 0; i < ptsR.length - 1; i++)
        for (const [tt, c] of [[0.5, 0], [0.3, 10], [0.7, 10]] as const) {
          const m = ptsR[i], n2 = ptsR[i + 1];
          const nrm = v2.perp(v2.norm(v2.sub(n2, m)));
          for (const side of [1, -1]) {
            const p = px(v2.add(v2.lerp(m, n2, tt), v2.scale(nrm, side * (fs - 1) / S)));
            cands.push({ x: p[0], y: p[1], cost: c + i * 3 + (side < 0 ? 4 : 0) });
          }
        }
      L.push({ lines: [{ text: r.id, size: fs - 3, color: r.style === "glass" ? "#1c6a9e" : "#333" }], prio: 4, optional: true, cands });
    }
  }

  // room names + areas: in open floor space near the centroid (terraces too)
  [...lv.rooms, ...lv.terraces].forEach((r) => {
    const pg = r.polygon as Vec2[];
    const pgPx = pg.map(px);
    const cc = polygonCentroid(pg);
    const cands: Cand[] = [];
    if (pointInPolygon(cc, pg)) cands.push({ x: X(cc[0]), y: Y(cc[1]), cost: 0 });
    const b = { x0: Math.min(...pg.map((p) => p[0])), x1: Math.max(...pg.map((p) => p[0])), y0: Math.min(...pg.map((p) => p[1])), y1: Math.max(...pg.map((p) => p[1])) };
    const g = Math.max(0.2, Math.min(0.5, (b.x1 - b.x0 + b.y1 - b.y0) / 40));
    for (let x = b.x0 + g / 2; x < b.x1; x += g)
      for (let y = b.y0 + g / 2; y < b.y1; y += g) {
        if (!pointInPolygon([x, y], pg)) continue;
        // prefer points well inside the room, then near the centroid
        const clear = Math.min(...pg.map((p, i) => pointSegment([x, y], p, pg[(i + 1) % pg.length]).dist));
        cands.push({ x: X(x), y: Y(y), cost: 5 + v2.dist([x, y], cc) * S * 0.25 - Math.min(clear, 1.5) * S * 0.2 });
      }
    if (!cands.length) cands.push({ x: X(cc[0]), y: Y(cc[1]), cost: 0 });
    L.push({
      lines: [
        { text: r.name, size: fs + 1, color: "#222", bold: true },
        { text: `${polygonArea(pg).toFixed(1)} m²`, size: fs - 2, color: "#555" },
      ],
      prio: 0,
      cands,
      within: pgPx,
      soft: [...furnSoft, ...stairSoft],
      softWeight: 0.08,
    });
  });

  // wall ids (lowest priority: skipped when there is no free spot)
  if (labels) {
    const byWall = new Map<string, typeof info.segments>();
    for (const s of info.segments) byWall.set(s.wallId, [...(byWall.get(s.wallId) ?? []), s]);
    for (const [id, segs] of byWall) {
      const cands: Cand[] = [];
      const sorted = [...segs].sort((a, b) => v2.dist(b.a, b.b) - v2.dist(a.a, a.b));
      sorted.forEach((s, si) => {
        if (v2.dist(s.a, s.b) < 0.3) return;
        for (const [tt, cst] of [[0.5, 0], [0.35, 6], [0.65, 6], [0.2, 12], [0.8, 12], [0.1, 20], [0.9, 20]] as const) {
          const p = px(v2.lerp(s.a, s.b, tt));
          cands.push({ x: p[0], y: p[1], cost: cst + si * 4 });
        }
      });
      L.push({
        lines: [{ text: id, size: fs - 3, color: "#ffffff" }],
        prio: 4,
        optional: true,
        halo: "#3a3a3a",
        avoidWalls: false,
        cands,
        soft: openingSoft,
        softWeight: 0.5,
      });
    }
  }

  // ---- label layer (drawn last) ----
  out.push(...placeLabels(L, wallPx, W, H));

  // north arrow + scale bar
  const nx = W - pad, ny = 20;
  out.push(`<g><polygon points="${nx},${ny + 2} ${nx - 6},${ny + 20} ${nx + 6},${ny + 20}" fill="#333"/><text x="${nx}" y="${ny + 32}" font-size="11" text-anchor="middle" fill="#333">N</text></g>`);
  out.push(`<line x1="${W - pad - 5 * S}" y1="${H - 15}" x2="${W - pad}" y2="${H - 15}" stroke="#333" stroke-width="3"/><text x="${W - pad - 2.5 * S}" y="${H - 20}" font-size="10" text-anchor="middle" fill="#333">5 m</text>`);
  out.push(`</svg>`);
  return out.join("\n");
}

export async function svgToPng(svg: string): Promise<Buffer> {
  const { Resvg } = await import("@resvg/resvg-js");
  return Buffer.from(new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: "Helvetica" } }).render().asPng());
}
