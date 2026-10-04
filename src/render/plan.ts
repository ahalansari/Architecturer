import type { LevelInfo } from "../build.js";
import { segDir } from "../elements/walls.js";
import { FURNITURE } from "../elements/furniture.js";
import { terraceGuards } from "../elements/terraces.js";
import { shapeFootprint } from "../elements/shapes.js";
import { caseworkPlan, resolveLevelCasework } from "../elements/casework.js";
import { deg2rad, pointInPolygon, pointSegment, polygonArea, polygonCentroid, v2, type Vec2 } from "../geometry/math.js";
import type { Compiled } from "../pipeline.js";
import { directionToDegrees, type Stair } from "../schema/schema.js";
import { AC, ductSVG, roofUnitSVG, shaftSVG, splitSVG, terminalSVG, thermostatSVG } from "./plan-hvac.js";
import { EL, elecSymbol, fixtureSymbol, PL, pipeSVG, plumbPointSymbol, switchWiring } from "./plan-services.js";
import { FIXTURE_LABEL } from "../elements/services.js";
import { ceilingLevels, dimension, fcpRoom, fmtH, levelKey, levelTag, rcpRoom, traySection } from "./plan-ceilings.js";
import { floorPattern, levelFixtures, LUX_BANDS, luxFill, lightSymbol, materialLabel, materialTone, roomFinishBands, roomLux, type PlanFixture, type Tone } from "./plan-sheets.js";
import { WALL_ASSEMBLIES, type WallKind } from "../elements/construction.js";

const WALL_FILL: Record<WallKind, string> = { block: "url(#wall_block)", rc: "#3a3a3a", drywall: "#ececec", glass: "#dcebf7", timber: "url(#wall_timber)" };

export interface PlanOptions {
  /** Pixels per meter. */
  scale?: number;
  /** Label walls/openings/furniture with their ids (useful for AI editing). */
  labels?: boolean;
  /**
   * plan (default): construction plan with small light symbols.
   * lighting: reflected-ceiling style lighting layout: fixture symbols, rooms tinted by estimated lux, legend.
   * finishes: floors drawn in their material and pattern, wall finish / accent bands, finish schedule per room, legend.
   * rcp: reflected ceiling plan: ceiling materials and heights, soffits, coffers, beams, coves, cornices, ceiling
   *   openings and light fixtures, no furniture.
   * false_ceiling: suspended-ceiling setting-out: ceiling levels colour-coded and tagged above the finished floor,
   *   drop edges, LED coves, soffit dimensions, void depth, typical section.
   * electrical: switches (with switch legs to the lights), sockets, data / TV, appliance points, detectors, the DB,
   *   circuit schedule.
   * plumbing: sanitary fixtures with cold / hot supplies and waste / soil drains, stacks, floor drains, water
   *   heaters, main stop valve, fixture schedule.
   */
  sheet?: PlanSheet;
}

export const PLAN_SHEETS = ["plan", "lighting", "finishes", "rcp", "false_ceiling", "electrical", "plumbing", "hvac", "landscape"] as const;
export type PlanSheet = (typeof PLAN_SHEETS)[number];

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
  /** Rounded backing plate behind the text (labels over busy fills such as floor patterns). */
  plate?: string;
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
    if (r.plate) {
      const b = best.box;
      out.push(`<rect x="${(b.x0 - 3).toFixed(1)}" y="${(b.y0 - 2).toFixed(1)}" width="${(b.x1 - b.x0 + 6).toFixed(1)}" height="${(b.y1 - b.y0 + 4).toFixed(1)}" rx="4" fill="${r.plate}" stroke="#00000022" stroke-width="0.6"/>`);
    }
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
  const sheet = opts.sheet ?? "plan";
  /** Ceiling sheets look up: no furniture, stairs or door swings. */
  const ceilingSheet = sheet === "rcp" || sheet === "false_ceiling";
  const svc = info.services;
  const hv = c.hvac;
  const hvL = hv?.levels[li];
  const hvRooms = new Map((hv?.rooms ?? []).filter((r) => r.level === li).map((r) => [r.room, r]));
  const wetRooms = new Set(svc.fixtures.map((f) => f.room));
  const fixtures: PlanFixture[] = c.root ? levelFixtures(c, lv) : [];
  const tones = new Map<string, Tone>();
  const D = project.defaults;

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
  for (const g of lv.gardens) pts.push(...(g.polygon as Vec2[]));
  for (const f of lv.furniture) pts.push(f.position as Vec2);
  for (const cw of lv.casework) pts.push(...((cw.path ?? (cw.position ? [cw.position] : [])) as Vec2[]));
  for (const h of info.stairOutlines) pts.push(...h);
  for (const a of arriving) pts.push(...a.plan.hole);
  if (!pts.length) pts.push([0, 0], [10, 10]);
  let minX = Math.min(...pts.map((p) => p[0])), maxX = Math.max(...pts.map((p) => p[0]));
  let minY = Math.min(...pts.map((p) => p[1])), maxY = Math.max(...pts.map((p) => p[1]));
  minX = Math.floor(minX - 1); minY = Math.floor(minY - 1); maxX = Math.ceil(maxX + 1); maxY = Math.ceil(maxY + 1);
  const span = Math.max(maxX - minX, maxY - minY);
  const S = opts.scale ?? Math.max(20, Math.min(80, Math.round(1100 / span)));
  const pad = 50;
  const W0 = (maxX - minX) * S + pad * 2;
  const LEGEND_W = sheet === "plan" ? 0 : 260;
  const W = W0 + LEGEND_W;
  let H = (maxY - minY) * S + pad * 2 + 30;
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

  // floor materials drawn as patterns on the finishes sheet
  const floorFill = new Map<string, string>();
  const floorDefs: string[] = [];
  if (sheet === "finishes")
    for (const r of lv.rooms) {
      const m = r.floorMaterial ?? D.floorMaterial;
      if (floorFill.has(m)) continue;
      const id = `floor_${floorFill.size}`;
      floorDefs.push(floorPattern(id, materialTone(c, m, tones), S));
      floorFill.set(m, `url(#${id})`);
    }
  const svgOpen = out.length;
  out.push("");
  out.push(
    `<defs>` +
      floorDefs.join("") +
      `<marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#333"/></marker>` +
      `<marker id="arrow_dn" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#555"/></marker>` +
      `<pattern id="hatch_soffit" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="#7d7d7d" stroke-width="0.6"/></pattern>` +
      `<pattern id="hatch_open" patternUnits="userSpaceOnUse" width="10" height="10" patternTransform="rotate(-45)"><rect width="10" height="10" fill="#f6f6f6"/><line x1="0" y1="0" x2="0" y2="10" stroke="#c8c8c8" stroke-width="0.8"/></pattern>` +
      `<pattern id="hatch_slab" patternUnits="userSpaceOnUse" width="5" height="5" patternTransform="rotate(45)"><rect width="5" height="5" fill="#e4e4e4"/><line x1="0" y1="0" x2="0" y2="5" stroke="#999" stroke-width="0.6"/></pattern>` +
      `<pattern id="wall_block" patternUnits="userSpaceOnUse" width="4" height="4" patternTransform="rotate(45)"><rect width="4" height="4" fill="#d6d6d6"/><line x1="0" y1="0" x2="0" y2="4" stroke="#3a3a3a" stroke-width="0.9"/></pattern>` +
      `<pattern id="wall_timber" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)"><rect width="6" height="6" fill="#ead9bf"/><line x1="0" y1="0" x2="0" y2="6" stroke="#9a6b3a" stroke-width="0.7"/><line x1="0" y1="0" x2="6" y2="0" stroke="#9a6b3a" stroke-width="0.7"/></pattern>` +
      `<pattern id="hatch_overhead" patternUnits="userSpaceOnUse" width="${hatchStep}" height="${hatchStep}" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="${hatchStep}" stroke="#b07a45" stroke-width="1"/></pattern>` +
      `</defs>`,
  );
  out.push(`<rect width="100%" height="100%" fill="#ffffff"/>`);
  const sheetTitle = { plan: "", lighting: " — lighting plan", finishes: " — finishes plan", rcp: " — reflected ceiling plan", false_ceiling: " — false ceiling plan", electrical: " — electrical layout", plumbing: " — plumbing layout", hvac: " — air conditioning layout", landscape: " — landscape and irrigation" }[sheet];
  out.push(`<text x="${pad}" y="28" font-size="18" font-weight="bold" fill="#222">${esc(project.name)} — ${esc(info.name)}${sheetTitle} (z=${info.elevation.toFixed(2)} m)</text>`);

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

  // gardens (under everything else): surfaces as soft fills
  for (const g of ceilingSheet ? [] : lv.gardens) out.push(`<polygon points="${poly(g.polygon as Vec2[])}" ${gardenFill(g.surface, sheet === "landscape")}/>`);

  // floor-level slabs (terraces, paths, driveways)
  const overhead = lv.slabs.filter((s) => s.offset > OVERHEAD);
  for (const s of lv.slabs) if (s.offset <= OVERHEAD) out.push(`<polygon points="${poly(s.polygon as Vec2[])}" fill="#eeeeee" stroke="#bbb" stroke-width="1"/>`);

  // terraces / balconies: warm deck fill under everything else
  const terraceGuardLines = lv.terraces.map((t) => terraceGuards(t, info.segments, info.elevation, c.levels[0].elevation));
  for (const t of lv.terraces) out.push(`<polygon points="${poly(t.polygon as Vec2[])}" fill="#efe6d6" stroke="#b5a184" stroke-width="1"/>`);

  // rooms
  const lux = lv.rooms.map((r) => roomLux(r.polygon as Vec2[], fixtures));
  const ceilDraw = { px, S, fs };
  const levelFills = ceilingLevels(info.ceilings);
  const ceilTags: { at: Vec2; text: string }[] = [];
  lv.rooms.forEach((r, i) => {
    const cl = info.ceilings[i];
    if (ceilingSheet && cl) {
      // the room polygon (wall centrelines) under the walls, then the ceiling inside the wall faces
      out.push(`<polygon points="${poly(r.polygon as Vec2[])}" fill="#ffffff" stroke="none"/>`);
      if (sheet === "rcp") out.push(rcpRoom(ceilDraw, cl, (m) => materialTone(c, m, tones)));
      else {
        const f = fcpRoom(ceilDraw, cl, levelFills);
        out.push(f.svg);
        ceilTags.push(...f.tags);
      }
      return;
    }
    const fill =
      sheet === "finishes" ? floorFill.get(r.floorMaterial ?? D.floorMaterial)
      : sheet === "lighting" ? luxFill(lux[i].lux)
      : sheet === "electrical" ? "#f8f7f3"
      : sheet === "plumbing" ? (wetRooms.has(i) ? "#e8f2fa" : "#f8f7f3")
      : sheet === "hvac" ? (hvRooms.get(i)?.conditioned ? "#eef5fb" : "#f6f5f2")
      : ROOM_COLORS[i % ROOM_COLORS.length];
    out.push(`<polygon points="${poly(r.polygon as Vec2[])}" fill="${fill}" stroke="none"/>`);
  });
  for (const r of lv.roofs)
    out.push(`<polygon points="${poly(r.polygon as Vec2[])}" fill="none" stroke="#c77" stroke-width="1.5" stroke-dasharray="8 4"/>`);

  // stairs arriving from below: the stairwell, with the flight seen through it (light) and a DN arrow
  const stairSoft: Box[] = [];
  for (const a of ceilingSheet ? [] : arriving) {
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
  for (const { s, plan } of ceilingSheet ? [] : ownStairs) {
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
  // (faded on the lighting / finishes sheets: context only)
  if (sheet !== "plan") out.push(`<g opacity="${sheet === "finishes" ? 0.4 : sheet === "plumbing" ? 0.75 : 0.35}">`);
  const furn = lv.furniture.map((f, i) => {
    const t = FURNITURE[f.type];
    const h = f.height ?? t?.defaults.height ?? 1;
    const flat = FLAT_TYPES.has(f.type) || (h <= 0.03 && f.elevation <= 0.01);
    return { f, i, t, flat, top: f.elevation + h };
  });
  furn.sort((a, b) => (a.flat === b.flat ? a.top - b.top || a.i - b.i : a.flat ? -1 : 1));
  const furnSoft: Box[] = [];
  const sanitary = new Set(["toilet", "bathroom_sink", "bathtub", "freestanding_bathtub", "shower", "sink_counter", "dishwasher", "washing_machine"]);
  for (const { f, t, flat } of ceilingSheet ? [] : sheet === "plumbing" ? furn.filter((x) => sanitary.has(x.f.type)) : furn) {
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
    if (labels && sheet === "plan") {
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

  // casework runs: worktops, base/tall units solid (tall ones crossed), wall cabinets dashed, sink/hob symbols
  for (const cp of resolveLevelCasework(project, li, info).filter((r) => r.legs.length).map(caseworkPlan)) {
    if (ceilingSheet) {
      // only what reaches up towards the ceiling: tall units and wall cabinets, as dashed outlines
      for (const it of cp.items.filter((i) => i.row === "tall" || i.row === "upper"))
        out.push(`<polygon points="${poly(it.poly)}" fill="none" stroke="#7a6f60" stroke-width="0.8" stroke-dasharray="4 3"/>`);
      continue;
    }
    for (const it of cp.items.filter((i) => i.row === "worktop")) out.push(`<polygon points="${poly(it.poly)}" fill="#f3efe7" stroke="#7d7466" stroke-width="1"/>`);
    for (const it of cp.items.filter((i) => i.row === "base" || i.row === "tall")) {
      out.push(`<polygon points="${poly(it.poly)}" fill="${it.row === "tall" ? "#e6e2da" : "none"}" stroke="#5b5348" stroke-width="1.2"/>`);
      if (it.row === "tall") out.push(line(it.poly[0], it.poly[2], `stroke="#9b9284" stroke-width="0.8"`), line(it.poly[1], it.poly[3], `stroke="#9b9284" stroke-width="0.8"`));
      if (it.front && !["filler", "end_panel"].includes(it.kind)) out.push(line(it.front[0], it.front[1], `stroke="#3d352b" stroke-width="2"`));
      furnSoft.push(pxBox(it.poly));
    }
    for (const sy of cp.symbols) {
      out.push(`<polygon points="${poly(sy.poly)}" fill="#ffffff" stroke="#5b5348" stroke-width="1"/>`);
      for (const rg of sy.rings ?? []) out.push(`<circle cx="${X(rg.c[0])}" cy="${Y(rg.c[1])}" r="${(rg.r * S).toFixed(1)}" fill="none" stroke="#5b5348" stroke-width="0.8"/>`);
    }
    for (const it of cp.items.filter((i) => i.row === "upper")) out.push(`<polygon points="${poly(it.poly)}" fill="none" stroke="#7a6f60" stroke-width="1" stroke-dasharray="5 3"/>`);
    for (const it of cp.items.filter((i) => i.label && i.row !== "upper")) {
      const cc = px(polygonCentroid(it.poly));
      out.push(`<text x="${cc[0]}" y="${cc[1] + 3}" font-size="${Math.max(7, fs - 4)}" fill="#5b5348" text-anchor="middle">${esc(it.label!)}</text>`);
    }
    if (labels && sheet === "plan") {
      const lc = px(cp.labelAt);
      L.push({ lines: [{ text: cp.id, size: fs - 2, color: "#5b4a33", bold: true }], prio: 2.8, cands: [{ x: lc[0], y: lc[1], cost: 0 }, { x: lc[0], y: lc[1] - fs, cost: 10 }, { x: lc[0], y: lc[1] + fs, cost: 10 }], optional: true });
    }
  }

  if (sheet !== "plan") out.push(`</g>`);

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

  // walls: the plan sheet hatches them by what they are built of (block, RC, drywall, glass, timber); the
  // overlay sheets keep a solid poché so their symbols read clearly
  const wallPx: Vec2[][] = [];
  const kinds = new Set<WallKind>();
  for (const s of info.segments) {
    const kind = WALL_ASSEMBLIES[s.construction ?? "block_200"].kind;
    kinds.add(kind);
    const fill = sheet !== "plan" ? "#3a3a3a" : WALL_FILL[kind];
    out.push(`<polygon points="${poly([s.aR, s.bR, s.b, s.bL, s.aL, s.a])}" fill="${fill}" stroke="#3a3a3a" stroke-width="${sheet === "plan" ? 0.9 : 0.5}"/>`);
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
    } else if (o.op.type === "door" && ceilingSheet) {
      // looking up: the door head across the opening
      for (const w of [-half + 0.01, half - 0.01]) out.push(line(at(u0, w), at(u1, w), `stroke="#777" stroke-width="0.8"`));
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
    if (labels && sheet === "plan") {
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
  for (const r of ceilingSheet ? [] : [...lv.railings, ...terraceRails]) {
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

  // finishes sheet: wall finish bands along the inside faces (accent walls bolder, wainscot as a strip on the wall)
  const bandW = Math.max(4, Math.min(8, S * 0.11)) / S;
  const wallMats = new Map<string, { accent: boolean }>();
  if (sheet === "finishes")
    for (const r of lv.rooms)
      for (const b of roomFinishBands(r, info, D.wallMaterial, bandW)) {
        const t = materialTone(c, b.material, tones);
        const w = (b.accent ? 1.6 : 1) * bandW * S;
        const shift = v2.scale(b.inward, ((b.accent ? 1.6 : 1) - 1) * bandW / 2);
        const a = v2.add(b.a, shift), e = v2.add(b.b, shift);
        out.push(line(a, e, `stroke="${t.fill}" stroke-width="${w.toFixed(1)}"`));
        out.push(line(a, e, `stroke="${t.line}" stroke-width="${b.accent ? 1.4 : 0.7}" fill="none"${b.partial ? ` stroke-dasharray="4 3"` : ""}`));
        if (b.wainscot) {
          const k = materialTone(c, b.wainscot, tones);
          const ws = v2.scale(b.inward, -(bandW / 2) + 0.012);
          out.push(line(v2.add(b.a, ws), v2.add(b.b, ws), `stroke="${k.line}" stroke-width="1.6"`));
        }
        if (!wallMats.has(b.material) || b.accent) wallMats.set(b.material, { accent: b.accent || !!wallMats.get(b.material)?.accent });
      }

  // false ceiling: level tags on soffits / beams
  for (const t of ceilTags) out.push(levelTag(ceilDraw, t.at, t.text, levelFills.get(levelKey(+t.text)) ?? "#ffffff"));

  // light fixtures and lamps (lighting sheet / RCP: full size with ids; plan: small, no labels;
  // false ceiling: the cut-outs, faded; ceiling sheets skip free-standing lamps)
  const bigFixtures = sheet === "lighting" || sheet === "electrical" || ceilingSheet;
  const fr = bigFixtures ? Math.max(5, Math.min(10, S * 0.13)) : Math.max(3, Math.min(6, S * 0.08));
  const fixtureSyms = sheet === "plumbing" || sheet === "hvac" ? [] : fixtures.filter((f) => sheet === "lighting" || !f.lamp);
  const fixtureSoft: Box[] = fixtureSyms.map((f) => {
    const [x, y] = px(f.at);
    return { x0: x - fr, y0: y - fr, x1: x + fr, y1: y + fr };
  });
  if (fixtureSyms.length) {
    out.push(`<g${sheet === "finishes" ? ` opacity="0.55"` : sheet === "false_ceiling" ? ` opacity="0.6"` : ""}>`);
    // paths first so point symbols stay on top
    for (const f of [...fixtureSyms].sort((a, b) => Number(!!b.points) - Number(!!a.points))) out.push(lightSymbol(f, px, fr, S));
    out.push(`</g>`);
  }
  // electrical: switch legs, then the points; plumbing: drains under supplies, then fixtures and points
  const er = Math.max(4.5, Math.min(8, S * 0.11));
  const svcSoft: Box[] = [];
  if (sheet === "electrical") {
    out.push(switchWiring(svc.electrical.filter((e) => e.controls.length), svc.groups, px));
    for (const e of svc.electrical) {
      out.push(elecSymbol(e, px, er));
      const [x, y] = px(e.at);
      svcSoft.push({ x0: x - er * 1.6, y0: y - er * 1.6, x1: x + er * 1.6, y1: y + er * 1.6 });
      // non-standard mounting heights
      const std = { switch: 1.2, switch_2way: 1.2, dimmer: 1.2, double_socket: 0.3, socket: 0.3, usb_socket: 0.3, data: 0.3, tv: 0.3, spur: 0.3 } as Record<string, number>;
      if (e.n && std[e.type] !== undefined && Math.abs(e.height - std[e.type]) > 0.05) {
        const q = px(v2.add(e.at, v2.scale(e.n, (er * 2.4) / S)));
        out.push(`<text x="${q[0].toFixed(1)}" y="${(q[1] + 3).toFixed(1)}" font-size="${Math.max(7, fs - 5)}" fill="#777" text-anchor="middle">${e.height.toFixed(2)}</text>`);
      }
    }
    if (labels)
      for (const e of svc.electrical) {
        if (!e.auto && !e.id) continue;
        const short = e.auto ? e.id.replace(/^([a-z]+)\.[^.]+\.(\d+)$/, "$1$2") : e.id;
        const q = px(e.n ? v2.add(e.at, v2.scale(e.n, (er * 2.2) / S)) : e.at);
        const size = Math.max(7, fs - 5);
        L.push({ lines: [{ text: short, size, color: "#8a8a8a" }], prio: 5, optional: true, cands: [{ x: q[0], y: q[1] + (e.n ? 0 : er + size), cost: 0 }, { x: q[0] + er * 2, y: q[1], cost: 4 }, { x: q[0] - er * 2, y: q[1], cost: 4 }] });
      }
  }
  if (sheet === "plumbing") {
    const order = { soil: 0, waste: 1, cold: 2, hot: 3 };
    for (const p of [...svc.pipes].sort((a, b) => order[a.kind] - order[b.kind])) out.push(pipeSVG(p, px));
    for (const f of svc.fixtures) out.push(fixtureSymbol(f, px, er));
    for (const p of svc.points) out.push(plumbPointSymbol(p, px, er));
    const size = Math.max(7, fs - 4);
    for (const f of svc.fixtures) {
      if (f.kind === "tap") continue;
      const [x, y] = px(f.at);
      svcSoft.push({ x0: x - er, y0: y - er, x1: x + er, y1: y + er });
      if (!labels) continue;
      const text = `${FIXTURE_LABEL[f.kind]}${f.drain ? ` Ø${f.drain}` : ""}`;
      const c = f.poly ? px(polygonCentroid(f.poly)) : [x, y + er * 2];
      L.push({ lines: [{ text, size, color: f.kind === "wc" ? PL.soil : "#5a4632" }], prio: 2.5, optional: true, cands: [{ x: c[0], y: c[1], cost: 0 }, { x: c[0], y: c[1] + size * 1.3, cost: 5 }, { x: c[0], y: c[1] - size * 1.3, cost: 5 }, { x: x, y: y + er * 2, cost: 10 }] });
    }
    for (const p of svc.points) {
      const [x, y] = px(p.at);
      svcSoft.push({ x0: x - er, y0: y - er, x1: x + er, y1: y + er });
      const text = p.type === "stack" ? `${p.label ?? "stack"} Ø${p.size ?? 100}` : p.type === "inlet" ? (p.label ?? "MSV") : p.type === "water_heater" ? "" : (p.label ?? p.type);
      if (text) L.push({ lines: [{ text, size, color: p.type === "inlet" ? PL.cold : PL.soil, bold: true }], prio: 2, optional: true, cands: [{ x, y: y - er * 2, cost: 0 }, { x, y: y + er * 2, cost: 2 }, { x: x + er * 3.5, y, cost: 4 }, { x: x - er * 3.5, y, cost: 4 }] });
    }
  }

  if (sheet === "hvac" && hv && hvL) {
    // returns under supplies, then the riser, terminals, thermostats, splits and roof units
    for (const d of [...hvL.ducts].sort((a, b) => (a.kind === "return" ? 0 : 1) - (b.kind === "return" ? 0 : 1))) out.push(ductSVG(d, px, S));
    const tr = Math.max(5, Math.min(10, 0.3 * S));
    for (const sh of hvL.shafts) {
      out.push(shaftSVG(sh.at, sh.size, px, S));
      const [x, y] = px(sh.at);
      svcSoft.push({ x0: x - tr * 1.5, y0: y - tr * 1.5, x1: x + tr * 1.5, y1: y + tr * 1.5 });
      if (labels) L.push({ lines: [{ text: `${sh.unit} riser`, size: Math.max(8, fs - 3), color: AC.shaft, bold: true }], prio: 2, optional: true, cands: [{ x, y: y - tr * 2.4, cost: 0 }, { x, y: y + tr * 2.4, cost: 2 }, { x: x + tr * 4, y, cost: 4 }, { x: x - tr * 4, y, cost: 4 }] });
    }
    for (const t of hvL.terminals) {
      out.push(terminalSVG(t, px, tr * 0.8));
      const [x, y] = px(t.at);
      svcSoft.push({ x0: x - tr, y0: y - tr, x1: x + tr, y1: y + tr });
      if (labels && t.kind === "supply")
        L.push({ lines: [{ text: `${t.airflow}`, size: Math.max(7, fs - 5), color: AC.supply }], prio: 5, optional: true, cands: [{ x, y: y + tr * 1.9, cost: 0 }, { x, y: y - tr * 1.9, cost: 1 }, { x: x + tr * 2.4, y, cost: 3 }] });
    }
    for (const t of hvL.thermostats) out.push(thermostatSVG(t.at, px, tr * 0.75));
    for (const sp of hvL.splits) {
      out.push(splitSVG(sp.at, sp.dir, px, S));
      if (labels) {
        const [x, y] = px(sp.at);
        L.push({ lines: [{ text: `${sp.unit} ${sp.tr} TR`, size: Math.max(8, fs - 4), color: AC.unit, bold: true }], prio: 2, optional: true, cands: [{ x, y: y - tr * 2, cost: 0 }, { x, y: y + tr * 2, cost: 1 }] });
      }
    }
    for (const u of hv.units.filter((u) => u.onRoof && u.onLevel === li)) {
      out.push(roofUnitSVG(u, px));
      if (labels && u.footprint) {
        const [x, y] = px(polygonCentroid(u.footprint));
        L.push({ lines: [{ text: `${u.id} ${u.size} TR`, size: Math.max(8, fs - 3), color: AC.unit, bold: true }, { text: "on the roof above", size: Math.max(7, fs - 5), color: AC.unit }], prio: 1.5, plate: "#ffffffd0", cands: [{ x, y, cost: 0 }, { x, y: y - fs * 2, cost: 2 }] });
      }
    }
  }

  if ((sheet === "lighting" || sheet === "rcp") && labels) {
    const seen = new Set<string>();
    for (const f of fixtures) {
      if (!f.id || f.lamp || seen.has(f.id)) continue;
      seen.add(f.id);
      const at = px(f.points?.[0] ?? f.at);
      const size = fs - 3;
      L.push({
        lines: [{ text: f.id, size, color: "#8a5a00" }],
        prio: 3,
        optional: true,
        cands: [
          { x: at[0], y: at[1] - fr - size * 0.7, cost: 0 },
          { x: at[0], y: at[1] + fr + size * 0.7, cost: 4 },
          { x: at[0] + fr + textWidth(f.id, size) / 2 + 2, y: at[1], cost: 6 },
          { x: at[0] - fr - textWidth(f.id, size) / 2 - 2, y: at[1], cost: 6 },
        ],
      });
    }
  }

  // room names + areas: in open floor space near the centroid (terraces too)
  const roomExtra = (r: (typeof lv.rooms)[number] | (typeof lv.terraces)[number]): LabelLine[] => {
    const small = fs - 3, col = "#444";
    if (sheet === "lighting") {
      const ri = lv.rooms.indexOf(r as (typeof lv.rooms)[number]);
      const lm = ri >= 0 ? lux[ri] : roomLux(r.polygon as Vec2[], fixtures);
      return lm.lumens > 0 ? [{ text: `≈ ${Math.round(lm.lux)} lx · ${Math.round(lm.lumens).toLocaleString("en-US")} lm`, size: small, color: "#8a5a00", bold: true }] : [{ text: "no lighting", size: small, color: "#b33" }];
    }
    const ci = lv.rooms.indexOf(r as (typeof lv.rooms)[number]);
    const cl = ci >= 0 ? info.ceilings[ci] : undefined;
    if (sheet === "electrical") {
      const pts = svc.electrical.filter((e) => e.room === ci && ci >= 0);
      const n = (types: string[]) => pts.filter((e) => types.includes(e.type)).length;
      const plural = (k: number, w: string) => (k ? `${k} ${w}${k > 1 ? (w.endsWith("h") ? "es" : "s") : ""}` : "");
      const parts = [plural(n(["double_socket", "socket", "usb_socket"]), "socket"), plural(n(["switch", "switch_2way", "dimmer"]), "switch")].filter(Boolean);
      const circ = [...new Set(pts.map((e) => e.circuit).filter(Boolean))].join(" ");
      return ci < 0 ? [] : [...(parts.length ? [{ text: parts.join(" · "), size: small, color: EL.power }] : []), ...(circ ? [{ text: circ, size: small, color: "#777" }] : [])];
    }
    if (sheet === "hvac") {
      const rl = ci >= 0 ? hvRooms.get(ci) : undefined;
      if (!rl) return [];
      if (!rl.conditioned) return [{ text: rl.reason?.split(":")[0] ?? "not conditioned", size: small, color: "#999" }];
      return [{ text: `${rl.tr} TR · ${(rl.total / 1000).toFixed(1)} kW`, size: small, color: AC.supply, bold: true }, { text: `${rl.supply} L/s · ${rl.zone ?? ""}`, size: small, color: "#666" }];
    }
    if (sheet === "plumbing") {
      const fx = svc.fixtures.filter((f) => f.room === ci && ci >= 0);
      if (!fx.length) return [];
      const counts = new Map<string, number>();
      for (const f of fx) counts.set(FIXTURE_LABEL[f.kind], (counts.get(FIXTURE_LABEL[f.kind]) ?? 0) + 1);
      return [{ text: [...counts].map(([k, v]) => (v > 1 ? `${v}× ${k}` : k)).join(" · "), size: small, color: PL.cold }];
    }
    if (ceilingSheet && !cl) return [{ text: "open to the sky", size: small, color: "#777" }];
    if (sheet === "rcp" && cl) {
      if (cl.type === "none") return [{ text: "no ceiling (exposed soffit)", size: small, color: "#777" }];
      const lines: LabelLine[] = [{ text: `CH ${cl.height.toFixed(2)} · ${materialLabel(cl.material!)}`, size: small, color: "#1d4f86", bold: true }];
      if (cl.type === "tray") lines.push({ text: `tray, soffit ${cl.soffit!.height.toFixed(2)}${cl.cove ? " · LED cove" : ""}`, size: small, color: col });
      if (cl.type === "coffered") lines.push({ text: `coffered, ribs ${cl.beams[0]?.height.toFixed(2) ?? cl.soffit!.height.toFixed(2)}`, size: small, color: col });
      if (cl.type === "beams") lines.push({ text: `${cl.beams.length} beams ${materialLabel(cl.beams[0]?.material ?? "")}, under ${cl.beams[0]?.height.toFixed(2)}`, size: small, color: col });
      if (cl.fallback) lines.push({ text: `${cl.fallback} did not fit: flat`, size: small, color: "#b33" });
      if (cl.cornice) lines.push({ text: `cornice ${materialLabel(cl.cornice.material)}`, size: small, color: "#666" });
      return lines;
    }
    if (sheet === "false_ceiling" && cl) {
      if (cl.type === "none") return [{ text: "no false ceiling", size: small, color: "#777" }];
      const voidD = cl.structure - cl.height;
      const lines: LabelLine[] = [{ text: `FCL ${fmtH(cl.height)}`, size: fs - 1, color: "#1d4f86", bold: true }];
      if (cl.soffit && cl.type === "tray") {
        const q = cl.soffit.inner;
        const w = Math.max(...q.map((p) => p[0])) - Math.min(...q.map((p) => p[0])), h = Math.max(...q.map((p) => p[1])) - Math.min(...q.map((p) => p[1]));
        lines.push({ text: `recess ${w.toFixed(2)} × ${h.toFixed(2)} m, drop ${(cl.height - cl.soffit.height).toFixed(2)}`, size: small, color: col });
      }
      if (cl.type === "coffered" || cl.type === "beams") lines.push({ text: `${cl.type} drop ${(cl.height - (cl.beams[0]?.height ?? cl.soffit?.height ?? cl.height)).toFixed(2)}`, size: small, color: col });
      lines.push({ text: voidD > 0.005 ? `void ${voidD.toFixed(2)} m · ${materialLabel(cl.material!)}` : `on slab soffit · ${materialLabel(cl.material!)}`, size: small, color: "#666" });
      return lines;
    }
    if (sheet === "finishes" && "floorMaterial" in r) {
      const f = r.finishes;
      const lines: LabelLine[] = [{ text: `floor: ${materialLabel(r.floorMaterial ?? D.floorMaterial)}`, size: small, color: col }];
      if (f?.walls) lines.push({ text: `walls: ${materialLabel(f.walls)}`, size: small, color: col });
      for (const a of f?.accents ?? [])
        lines.push({ text: `accent ${a.side ?? a.wall}${a.from !== undefined || a.to !== undefined ? ` ${a.from ?? 0}–${a.to ?? "top"} m` : ""}: ${materialLabel(a.material)}`, size: small, color: "#6b4a1f" });
      if (f?.wainscot) lines.push({ text: `${f.wainscot.style === "panels" ? "panelled " : ""}wainscot ${f.wainscot.height} m: ${materialLabel(f.wainscot.material)}`, size: small, color: col });
      const ceil = f?.ceiling && f.ceiling.type !== "flat" ? `${f.ceiling.type} ceiling` : r.ceilingMaterial === false ? "no ceiling" : "";
      const trims = [ceil, f?.cornice ? "cornice" : "", f?.skirting ? "skirting" : "", f?.floorBorder ? "border" : ""].filter(Boolean).join(" · ");
      if (trims) lines.push({ text: trims, size: small, color: "#666" });
      return lines;
    }
    return [];
  };
  if (sheet === "landscape" || sheet === "plan")
    for (const g of lv.gardens) {
      const cc = polygonCentroid(g.polygon as Vec2[]);
      L.push({ lines: [{ text: g.surface === "turf" ? "artificial turf" : g.surface === "planting" ? "planting bed" : g.surface, size: fs - 2, color: "#3d5a2a", bold: true }, { text: `${Math.abs(polygonArea(g.polygon as Vec2[])).toFixed(1)} m²`, size: fs - 4, color: "#557" }], prio: 2, optional: true, cands: [{ x: X(cc[0]), y: Y(cc[1]), cost: 0 }] });
    }
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
        ...roomExtra(r),
      ],
      plate: sheet === "finishes" || ceilingSheet || sheet === "electrical" || sheet === "plumbing" || sheet === "hvac" ? "#fffffff0" : undefined,
      prio: 0,
      cands,
      within: pgPx,
      soft: [...furnSoft, ...stairSoft, ...(bigFixtures ? fixtureSoft : []), ...svcSoft],
      softWeight: 0.08,
    });
  });

  // wall ids (lowest priority: skipped when there is no free spot)
  if (labels && sheet === "plan") {
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

  // landscape sheet: irrigation (sprinkler coverage, drip lines, bubblers, laterals, mainline, valves, controller)
  const ls = c.landscape;
  const lsL = ls?.levels[li];
  if (sheet === "landscape" && lsL) {
    // throw circles, clipped to the lawns they water
    const lawns = lv.gardens.filter((g) => g.surface === "lawn");
    if (lsL.heads.length && lawns.length) {
      out.push(`<clipPath id="lawnclip${li}">${lawns.map((g) => `<polygon points="${poly(g.polygon as Vec2[])}"/>`).join("")}</clipPath><g clip-path="url(#lawnclip${li})">`);
      for (const h of lsL.heads) out.push(`<circle cx="${X(h.at[0])}" cy="${Y(h.at[1])}" r="${(h.radius * S).toFixed(1)}" fill="#3b82c4" fill-opacity="0.06" stroke="#3b82c4" stroke-opacity="0.35" stroke-width="0.6"/>`);
      out.push(`</g>`);
    }
    for (const p of lsL.pipes.filter((p) => p.kind === "lateral")) out.push(`<polyline points="${poly(p.pts)}" fill="none" stroke="#5b8fc7" stroke-width="1"/>`);
    for (const p of lsL.pipes.filter((p) => p.kind === "main")) out.push(`<polyline points="${poly(p.pts)}" fill="none" stroke="#1d5fa8" stroke-width="2.2"/>`);
    for (const d of lsL.drip) out.push(`<polyline points="${poly(d.pts)}" fill="none" stroke="#8a5a2b" stroke-width="1.1" stroke-dasharray="1.5 2.5"/>`);
    for (const h of lsL.heads) {
      const [x, y] = px(h.at);
      out.push(`<circle cx="${x}" cy="${y}" r="3.2" fill="#ffffff" stroke="#1d5fa8" stroke-width="1.4"/>`);
    }
    for (const b of [...lsL.bubblers, ...lsL.emitters]) {
      const [x, y] = px(b.at);
      out.push(`<circle cx="${x}" cy="${y}" r="${lsL.bubblers.includes(b as never) ? 4 : 2.6}" fill="${lsL.bubblers.includes(b as never) ? "#1d5fa8" : "#8a5a2b"}"/>`);
    }
    for (const v of lsL.valves) {
      const [x, y] = px(v.at);
      out.push(`<rect x="${x - 4}" y="${y - 4}" width="8" height="8" fill="#ffffff" stroke="#1d5fa8" stroke-width="1.3"/>`);
      if (labels) L.push({ lines: [{ text: v.zone, size: Math.max(7, fs - 5), color: "#1d5fa8", bold: true }], prio: 3, optional: true, cands: [{ x, y: y - 10, cost: 0 }, { x: x + 12, y, cost: 2 }] });
    }
    if (lsL.controller) {
      const [x, y] = px(lsL.controller);
      out.push(`<rect x="${x - 6}" y="${y - 6}" width="12" height="12" rx="2" fill="#1d5fa8"/><text x="${x}" y="${y + 3.5}" font-size="9" font-weight="bold" fill="#fff" text-anchor="middle">C</text>`);
    }
  }

  // lifts: car outline and the cross through the shaft, on every level the shaft passes
  for (const l of ceilingSheet ? [] : (c.lifts ?? []).filter((l) => l.levels.includes(li))) {
    const [a0, a1, a2, a3] = l.inner;
    out.push(`<polygon points="${poly(l.inner)}" fill="#f4f4f4" stroke="none"/>`);
    out.push(line(a0, a2, `stroke="#777" stroke-width="1"`), line(a1, a3, `stroke="#777" stroke-width="1"`));
    if (l.stopLevels.includes(li)) {
      // the car, against the door side
      const s0: Vec2 = [-l.f[1], l.f[0]];
      const cc: Vec2 = [(a0[0] + a2[0]) / 2, (a0[1] + a2[1]) / 2];
      const at = (u: number, v: number): Vec2 => v2.add(cc, v2.add(v2.scale(s0, u), v2.scale(l.f, v)));
      const off = l.shaft[1] / 2 - l.car[1] / 2 - 0.05;
      out.push(`<polygon points="${poly([at(-l.car[0] / 2, off - l.car[1] / 2), at(l.car[0] / 2, off - l.car[1] / 2), at(l.car[0] / 2, off + l.car[1] / 2), at(-l.car[0] / 2, off + l.car[1] / 2)])}" fill="none" stroke="#444" stroke-width="1.3"/>`);
    }
    const cp = px(polygonCentroid(l.inner));
    L.push({ lines: [{ text: `LIFT ${l.id}`, size: fs - 2, color: "#333", bold: true }, { text: `${l.persons} p · ${l.kg} kg`, size: fs - 4, color: "#666" }], plate: "#ffffffd8", prio: 1, cands: [{ x: cp[0], y: cp[1], cost: 0 }] });
  }

  // ---- label layer (drawn last) ----
  out.push(...placeLabels(L, wallPx, W0, H));

  // legend panel (lighting / finishes sheets)
  if (sheet !== "plan") {
    const lg: string[] = [];
    const x0 = W0 + 10;
    let y = pad + 30;
    const head = (t: string) => {
      lg.push(`<text x="${x0}" y="${y}" font-size="13" font-weight="bold" fill="#222">${esc(t)}</text>`);
      y += 18;
    };
    const row = (sym: string, t: string, sub?: string) => {
      lg.push(sym, `<text x="${x0 + 34}" y="${y + 4}" font-size="11" fill="#222">${esc(t)}</text>`);
      if (sub) lg.push(`<text x="${x0 + 34}" y="${y + 16}" font-size="9.5" fill="#666">${esc(sub)}</text>`);
      y += sub ? 30 : 22;
    };
    const fixtureLegend = (list: PlanFixture[]) => {
      head("Fixtures");
      const types = new Map<string, { n: number; lm: number; k: Set<number>; sample: PlanFixture }>();
      for (const f of list) {
        const key = f.lamp ? `lamp: ${f.type.replace(/_/g, " ")}` : f.type.replace(/_/g, " ");
        const e = types.get(key) ?? { n: 0, lm: 0, k: new Set<number>(), sample: f };
        e.n++;
        e.lm += f.lumens;
        if (f.kelvin) e.k.add(f.kelvin);
        types.set(key, e);
      }
      if (!types.size) row("", "no light fixtures on this level");
      for (const [k, e] of types) {
        const at: Vec2 = [x0 + 14, y];
        const s = e.sample;
        const sym = s.points
          ? lightSymbol({ ...s, points: [[x0 + 2, y], [x0 + 26, y]], heads: s.type === "track" ? [{ at: [x0 + 8, y], lumens: 0 }, { at: [x0 + 20, y], lumens: 0 }] : [] }, (p) => p, 7, 1)
          : lightSymbol({ ...s, at, rotZ: s.type === "wall_sconce" ? Math.PI : 0 }, (p) => p, 7, 1);
        const kel = [...e.k].sort().map((v) => `${v} K`).join("/");
        row(sym, `${k} × ${e.n}`, `${Math.round(e.lm).toLocaleString("en-US")} lm${kel ? " · " + kel : ""}`);
      }
      const total = list.reduce((a, f) => a + f.lumens, 0);
      y += 4;
      lg.push(`<text x="${x0}" y="${y}" font-size="11" font-weight="bold" fill="#222">Total ${Math.round(total).toLocaleString("en-US")} lm</text>`);
      y += 26;
    };
    const cls = info.ceilings.filter(Boolean);
    if (sheet === "rcp") {
      head("Ceilings");
      const mats = [...new Set(cls.filter((cl) => cl.type !== "none").map((cl) => cl.material!))];
      for (const m of mats) {
        const t = materialTone(c, m, tones);
        row(`<rect x="${x0 + 2}" y="${y - 7}" width="24" height="14" fill="${t.fill}" fill-opacity="0.55" stroke="#999" stroke-width="0.6"/>`, materialLabel(m));
      }
      if (cls.some((cl) => cl.soffit && cl.type === "tray")) row(`<rect x="${x0 + 2}" y="${y - 7}" width="24" height="14" fill="url(#hatch_soffit)" stroke="#555" stroke-width="0.8"/>`, "lowered soffit (tray)");
      const bm = cls.find((cl) => cl.beams.length)?.beams[0];
      if (bm) row(`<rect x="${x0 + 2}" y="${y - 3}" width="24" height="6" fill="${materialTone(c, bm.material, tones).fill}" stroke="#6b5a45" stroke-width="0.8"/>`, "beam / coffer rib");
      if (cls.some((cl) => cl.cove)) row(`<line x1="${x0 + 2}" y1="${y}" x2="${x0 + 26}" y2="${y}" stroke="#f2b632" stroke-width="2" stroke-dasharray="6 3"/>`, "LED cove");
      if (cls.some((cl) => cl.cornice)) row(`<line x1="${x0 + 2}" y1="${y}" x2="${x0 + 26}" y2="${y}" stroke="#8a8a8a" stroke-width="0.8"/>`, "cornice line");
      if (cls.some((cl) => cl.holes.length)) row(`<rect x="${x0 + 4}" y="${y - 7}" width="20" height="14" fill="#fff" stroke="#555"/><path d="M ${x0 + 4} ${y - 7} L ${x0 + 24} ${y + 7} M ${x0 + 24} ${y - 7} L ${x0 + 4} ${y + 7}" stroke="#999" stroke-width="0.8"/>`, "opening in the ceiling");
      if (cls.some((cl) => cl.type === "none")) row(`<rect x="${x0 + 2}" y="${y - 7}" width="24" height="14" fill="url(#hatch_open)" stroke="#999" stroke-width="0.6"/>`, "no ceiling");
      row(`<rect x="${x0 + 2}" y="${y - 7}" width="24" height="14" fill="none" stroke="#7a6f60" stroke-width="0.8" stroke-dasharray="4 3"/>`, "tall / wall cabinets");
      lg.push(`<text x="${x0}" y="${y}" font-size="9" fill="#777">CH = ceiling height above the finished floor</text>`);
      y += 22;
      fixtureLegend(fixtures.filter((f) => !f.lamp));
    } else if (sheet === "false_ceiling") {
      head("Ceiling levels (above FFL)");
      for (const [h, fill] of levelFills) {
        const mains = cls.filter((cl) => cl.type !== "none" && levelKey(cl.height) === h).length;
        row(`<rect x="${x0 + 2}" y="${y - 7}" width="24" height="14" fill="${fill}" stroke="#1d4f86" stroke-width="0.6"/>`, `FCL +${h}`, mains ? `${mains} room${mains > 1 ? "s" : ""}` : "soffits / drops");
      }
      if (cls.some((cl) => cl.type === "none")) row(`<rect x="${x0 + 2}" y="${y - 7}" width="24" height="14" fill="url(#hatch_open)" stroke="#999" stroke-width="0.6"/>`, "no false ceiling");
      y += 4;
      head("Symbols");
      row(`<line x1="${x0 + 2}" y1="${y}" x2="${x0 + 26}" y2="${y}" stroke="#1d4f86" stroke-width="1.6"/>`, "drop edge (level change)");
      if (cls.some((cl) => cl.cove)) row(`<line x1="${x0 + 2}" y1="${y}" x2="${x0 + 26}" y2="${y}" stroke="#f2b632" stroke-width="2" stroke-dasharray="6 3"/>`, "LED cove");
      row(levelTag({ px: (p) => p, S: 1, fs: 13 }, [x0 + 14, y], "+2.45"), "level tag");
      row(dimension({ px: (p) => p, S: 1, fs: 12 }, [x0 + 2, y + 4], [x0 + 26, y + 4], ""), "soffit width (m)");
      if (cls.some((cl) => cl.holes.length)) row(`<rect x="${x0 + 4}" y="${y - 7}" width="20" height="14" fill="#fff" stroke="#555"/><path d="M ${x0 + 4} ${y - 7} L ${x0 + 24} ${y + 7} M ${x0 + 24} ${y - 7} L ${x0 + 4} ${y + 7}" stroke="#999" stroke-width="0.8"/>`, "opening in the ceiling");
      if (fixtures.some((f) => !f.lamp)) row(lightSymbol({ type: "downlight", lamp: false, at: [x0 + 14, y], rotZ: 0, lumens: 0, heads: [] }, (p) => p, 7, 1), "fixture cut-outs (see RCP)");
      const tray = cls.find((cl) => cl.type === "tray" && cl.soffit);
      if (tray) {
        y += 6;
        head("Typical tray section");
        const ts = traySection(x0, y - 6, LEGEND_W - 24, tray);
        lg.push(ts.svg);
        y += ts.height + 8;
      }
    } else if (sheet === "electrical") {
      head("Electrical points");
      const T0 = (p: Vec2) => p;
      const types = new Map<string, { n: number; sample: (typeof svc.electrical)[number] }>();
      for (const e of svc.electrical) {
        const e2 = types.get(e.type) ?? { n: 0, sample: e };
        e2.n++;
        types.set(e.type, e2);
      }
      const NAMES: Record<string, string> = {
        light_point: "lighting point (no fixture designed)", switch: "switch (ticks = gangs)", switch_2way: "2-way switch", dimmer: "dimmer", double_socket: "double socket", socket: "socket", usb_socket: "USB socket", data: "data point", tv: "TV point",
        shaver: "shaver socket", cooker: "cooker control unit", spur: "fused spur / appliance", fan: "extract fan", ac: "AC unit", db: "distribution board", smoke: "smoke detector", heat: "heat detector", doorbell: "doorbell",
      };
      const HEIGHT: Record<string, string> = { switch: "1.20", switch_2way: "1.20", dimmer: "1.20", double_socket: "0.30", socket: "0.30", data: "0.30", tv: "0.30", shaver: "1.50", db: "1.60", doorbell: "1.40", fan: "ceiling", smoke: "ceiling", heat: "ceiling", light_point: "ceiling" };
      for (const [t, e] of types) {
        const wall = !!e.sample.n;
        const sym = elecSymbol({ ...e.sample, at: [x0 + 14, wall ? y + 6 : y], n: wall ? [0, -1] : undefined, gangs: t.startsWith("switch") ? 1 : e.sample.gangs, label: t === "spur" ? "" : e.sample.label }, T0, 6.5);
        row(sym, `${NAMES[t] ?? t} × ${e.n}`, HEIGHT[t] ? `${HEIGHT[t] === "ceiling" ? "on the ceiling" : `centre ${HEIGHT[t]} m`}` : undefined);
      }
      row(`<path d="M ${x0 + 2} ${y + 4} Q ${x0 + 14} ${y - 8} ${x0 + 26} ${y + 4}" fill="none" stroke="#6b6b6b" stroke-width="0.9" stroke-dasharray="4 3"/>`, "switch leg to the lights");
      lg.push(`<text x="${x0}" y="${y}" font-size="9" fill="#777">other heights noted beside the symbol (m)</text>`);
      y += 22;
      head("Circuits");
      // air-conditioning supplies come from the board on the floor that has it
      const hasDb = (l: LevelInfo) => l.services.electrical.some((e) => e.type === "db");
      const acCircuits = hasDb(info) || (li === 0 && !c.levels.some(hasDb)) ? [...(hv?.circuits ?? []), ...(c.liftCircuits ?? [])] : [];
      for (const cc of [...svc.circuits, ...acCircuits]) {
        lg.push(`<text x="${x0}" y="${y}" font-size="10.5" font-weight="bold" fill="#222">${esc(cc.id)}</text><text x="${x0 + 28}" y="${y}" font-size="10.5" fill="#222">${cc.rating} A · ${esc(cc.label)} · ${cc.points} pt${cc.points > 1 ? "s" : ""}</text>`);
        lg.push(`<text x="${x0 + 28}" y="${y + 11}" font-size="9" fill="#777">${esc(cc.rooms.join(", ").slice(0, 44))}</text>`);
        y += 26;
      }
    } else if (sheet === "plumbing") {
      head("Pipes");
      const line = (kind: "soil" | "waste" | "cold" | "hot", t: string, sub: string) =>
        row(pipeSVG({ kind, pts: [[x0 + 2, y], [x0 + 26, y]], size: kind === "cold" ? 15 : 50 }, (p) => p), t, sub);
      line("cold", "cold water supply", "15 mm branches, 22 mm main");
      line("hot", "hot water supply", "15 mm from the water heater");
      line("waste", "waste drain", "40–50 mm, fall 1:40 to the stack");
      line("soil", "soil drain (WC)", "100 mm, fall 1:40");
      y += 4;
      head("Points");
      const T0 = (p: Vec2) => p;
      if (svc.points.some((p) => p.type === "stack")) row(plumbPointSymbol({ id: "", type: "stack", at: [x0 + 14, y], room: -1, auto: true }, T0, 6.5), "soil / waste stack (SVP)");
      if (svc.fixtures.some((f) => f.kind === "floor_drain")) row(fixtureSymbol({ id: "", kind: "floor_drain", at: [x0 + 14, y], room: -1, cold: false, hot: false, drain: 50, auto: true }, T0, 6.5), "floor drain Ø50");
      if (svc.points.some((p) => p.type === "water_heater")) row(plumbPointSymbol({ id: "", type: "water_heater", at: [x0 + 14, y], room: -1, auto: true }, T0, 6.5), "water heater");
      if (svc.points.some((p) => p.type === "inlet")) row(plumbPointSymbol({ id: "", type: "inlet", at: [x0 + 14, y], room: -1, auto: true }, T0, 6.5), "main stop valve");
      row(fixtureSymbol({ id: "", kind: "basin", at: [x0 + 14, y], room: -1, cold: true, hot: true, drain: 40, auto: true }, T0, 6.5), "fixture connection", "drain · cold (blue) · hot (red)");
      y += 4;
      head("Fixture schedule");
      const sched = new Map<string, { n: number; cold: boolean; hot: boolean; drain: number }>();
      for (const f of svc.fixtures) {
        const e = sched.get(f.kind) ?? { n: 0, cold: f.cold, hot: f.hot, drain: f.drain };
        e.n++;
        sched.set(f.kind, e);
      }
      lg.push(`<text x="${x0}" y="${y}" font-size="9.5" fill="#777">fixture</text><text x="${x0 + 110}" y="${y}" font-size="9.5" fill="#777">no.</text><text x="${x0 + 135}" y="${y}" font-size="9.5" fill="#777">supply</text><text x="${x0 + 185}" y="${y}" font-size="9.5" fill="#777">drain</text>`);
      y += 14;
      for (const [k, e] of sched) {
        lg.push(`<text x="${x0}" y="${y}" font-size="10.5" fill="#222">${esc(FIXTURE_LABEL[k as keyof typeof FIXTURE_LABEL])}</text><text x="${x0 + 110}" y="${y}" font-size="10.5" fill="#222">${e.n}</text><text x="${x0 + 135}" y="${y}" font-size="10.5" fill="#222">${[e.cold ? "CW" : "", e.hot ? "HW" : ""].filter(Boolean).join("+") || "—"}</text><text x="${x0 + 185}" y="${y}" font-size="10.5" fill="#222">${e.drain ? `Ø${e.drain}` : "—"}</text>`);
        y += 15;
      }
      y += 8;
    } else if (sheet === "landscape") {
      head("Garden");
      const ar = ls ? Object.entries(ls.areas).filter(([, v]) => v > 0) : [];
      for (const [k, v] of ar) row(`<rect x="${x0 + 2}" y="${y - 7}" width="24" height="14" ${gardenFill(k as never, true)}/>`, `${k === "turf" ? "artificial turf" : k === "planting" ? "planting bed" : k} ${v} m²`);
      if (ls) {
        const p = ls.plants;
        lg.push(`<text x="${x0}" y="${y}" font-size="10.5" fill="#222">${p.trees} trees · ${p.palms} palms · ${p.shrubs} shrubs · ${p.hedgeM} m hedge</text>`);
        y += 20;
      }
      head("Irrigation");
      row(`<circle cx="${x0 + 14}" cy="${y}" r="3.2" fill="#fff" stroke="#1d5fa8" stroke-width="1.4"/><circle cx="${x0 + 14}" cy="${y}" r="10" fill="#3b82c4" fill-opacity="0.08" stroke="#3b82c4" stroke-opacity="0.35" stroke-width="0.6"/>`, "pop-up spray head (coverage)");
      row(`<line x1="${x0 + 2}" y1="${y}" x2="${x0 + 26}" y2="${y}" stroke="#8a5a2b" stroke-width="1.1" stroke-dasharray="1.5 2.5"/>`, "drip line / emitters");
      row(`<circle cx="${x0 + 14}" cy="${y}" r="4" fill="#1d5fa8"/>`, "tree / palm bubbler");
      row(`<line x1="${x0 + 2}" y1="${y}" x2="${x0 + 26}" y2="${y}" stroke="#1d5fa8" stroke-width="2.2"/>`, "mainline from the valve box");
      row(`<rect x="${x0 + 10}" y="${y - 4}" width="8" height="8" fill="#fff" stroke="#1d5fa8" stroke-width="1.3"/>`, "zone valve");
      row(`<rect x="${x0 + 8}" y="${y - 6}" width="12" height="12" rx="2" fill="#1d5fa8"/>`, "controller");
      if (ls?.zones.length) {
        y += 4;
        head("Zones");
        for (const z of ls.zones.filter((z) => z.level === li)) {
          lg.push(`<text x="${x0}" y="${y}" font-size="10.5" font-weight="bold" fill="#1d5fa8">${esc(z.id)}</text><text x="${x0 + 28}" y="${y}" font-size="10" fill="#222">${esc(z.what.slice(0, 30))}</text>`);
          lg.push(`<text x="${x0 + 28}" y="${y + 11}" font-size="9" fill="#777">${z.flow} L/min · ${z.runMin} min/day · ${z.litresPerDay} L/day</text>`);
          y += 26;
          if (y > H - 60) break;
        }
        lg.push(`<text x="${x0}" y="${y + 4}" font-size="10.5" font-weight="bold" fill="#222">Summer water ≈ ${ls.demand.litresPerDay} L/day (${ls.demand.m3PerMonth} m³/month)</text>`);
        y += 22;
      }
    } else if (sheet === "hvac") {
      const sys = { packaged: "Rooftop packaged units, ducted", ducted_split: "Ducted splits + roof condensers", split: "Wall splits + roof condensers", none: "No air conditioning" }[hv?.system ?? "none"];
      head("Air conditioning");
      lg.push(`<text x="${x0}" y="${y}" font-size="10.5" fill="#222">${esc(sys)}</text>`);
      y += 16;
      if (hv && hv.units.length) {
        lg.push(`<text x="${x0}" y="${y}" font-size="10.5" fill="#222">${hv.totals.tr} TR for ${hv.totals.area} m² (${hv.totals.m2PerTR} m²/TR, ${hv.totals.wPerM2} W/m²)</text>`);
        y += 22;
      }
      head("Symbols");
      const T0 = (p: Vec2) => p;
      row(ductSVG({ kind: "supply", unit: "", pts: [[x0 + 2, y], [x0 + 26, y]], airflow: 0, w: 0.25, h: 0.2 }, T0, 32), "supply duct (to scale)");
      row(ductSVG({ kind: "return", unit: "", pts: [[x0 + 2, y], [x0 + 26, y]], airflow: 0, w: 0.25, h: 0.2 }, T0, 32), "return duct");
      row(terminalSVG({ kind: "supply", at: [x0 + 14, y] }, T0, 6), "supply diffuser 600×600", "figure: air, L/s");
      row(terminalSVG({ kind: "return", at: [x0 + 14, y] }, T0, 6), "return grille");
      if (hvL?.shafts.length) row(shaftSVG([x0 + 14, y], 0.5, T0, 20), "duct riser to the roof unit");
      if (hv?.levels.some((l) => l.thermostats.length)) row(thermostatSVG([x0 + 14, y], T0, 6), "thermostat (1.5 m)");
      if (hv?.units.some((u) => u.onRoof)) row(`<rect x="${x0 + 2}" y="${y - 7}" width="24" height="14" fill="#f3ecfa" stroke="${AC.unit}" stroke-width="1.4" stroke-dasharray="5 3"/>`, "packaged unit on the roof");
      if (hvL?.splits.length) row(splitSVG([x0 + 14, y + 4], [0, -1], T0, 24), "wall split indoor unit");
      y += 4;
      head("Units");
      for (const u of hv?.units ?? []) {
        lg.push(`<text x="${x0}" y="${y}" font-size="10.5" font-weight="bold" fill="${AC.unit}">${esc(u.id)}</text><text x="${x0 + 46}" y="${y}" font-size="10.5" fill="#222">${u.size} TR · load ${u.load} TR · ${u.airflow} L/s</text>`);
        lg.push(`<text x="${x0 + 46}" y="${y + 11}" font-size="9" fill="#777">${u.freshAir ? `fresh air ${u.freshAir} L/s · ` : ""}${u.kw} kW · ${u.phase}-ph ${u.breaker} A</text>`);
        y += 26;
        if (y > H - 40) break;
      }
      const loads = [...hvRooms.values()].filter((r) => r.conditioned);
      if (loads.length) {
        y += 4;
        head("Room loads (this floor)");
        lg.push(`<text x="${x0}" y="${y}" font-size="9.5" fill="#777">room</text><text x="${x0 + 130}" y="${y}" font-size="9.5" fill="#777">kW</text><text x="${x0 + 165}" y="${y}" font-size="9.5" fill="#777">TR</text><text x="${x0 + 200}" y="${y}" font-size="9.5" fill="#777">L/s</text>`);
        y += 14;
        for (const r of loads) {
          lg.push(`<text x="${x0}" y="${y}" font-size="10" fill="#222">${esc(r.name.slice(0, 22))}</text><text x="${x0 + 130}" y="${y}" font-size="10" fill="#222">${(r.total / 1000).toFixed(1)}</text><text x="${x0 + 165}" y="${y}" font-size="10" fill="#222">${r.tr}</text><text x="${x0 + 200}" y="${y}" font-size="10" fill="#222">${r.supply}</text>`);
          y += 14;
        }
      }
      if (hv?.issues.length) {
        y += 8;
        lg.push(`<text x="${x0}" y="${y}" font-size="10" font-weight="bold" fill="#b33">${hv.issues.length} coordination issue${hv.issues.length > 1 ? "s" : ""}: see hvac_design</text>`);
        y += 16;
      }
    } else if (sheet === "lighting") {
      fixtureLegend(fixtures);
      head("Estimated average illuminance");
      for (const b of LUX_BANDS) row(`<rect x="${x0 + 2}" y="${y - 7}" width="24" height="14" fill="${b.fill}" stroke="#999" stroke-width="0.6"/>`, b.label);
      lg.push(`<text x="${x0}" y="${y + 2}" font-size="9" fill="#777">lumens in the room × ${0.5} / floor area</text>`);
      y += 16;
    } else {
      head("Floors");
      const floors = [...new Set(lv.rooms.map((r) => r.floorMaterial ?? D.floorMaterial))];
      for (const m of floors) {
        const t = materialTone(c, m, tones);
        row(`<rect x="${x0 + 2}" y="${y - 9}" width="24" height="18" fill="${floorFill.get(m)}" stroke="${t.line}" stroke-width="0.8"/>`, materialLabel(m), t.def.pattern !== "none" ? t.def.pattern.replace(/_/g, " ") : undefined);
      }
      y += 6;
      head("Walls");
      if (!wallMats.size) row("", "plain walls");
      for (const [m, w] of wallMats) {
        const t = materialTone(c, m, tones);
        row(`<rect x="${x0 + 2}" y="${y - (w.accent ? 5 : 3)}" width="24" height="${w.accent ? 10 : 6}" fill="${t.fill}" stroke="${t.line}" stroke-width="${w.accent ? 1.4 : 0.7}"/>`, materialLabel(m), w.accent ? "accent wall" : undefined);
      }
      const wains = [...new Set(lv.rooms.map((r) => r.finishes?.wainscot?.material).filter((m): m is string => !!m))];
      for (const m of wains) {
        const t = materialTone(c, m, tones);
        row(`<rect x="${x0 + 2}" y="${y - 3}" width="24" height="6" fill="#ffffff" stroke="none"/><line x1="${x0 + 2}" y1="${y + 3}" x2="${x0 + 26}" y2="${y + 3}" stroke="${t.line}" stroke-width="1.6"/>`, materialLabel(m), "wainscot / tiled band (wall side)");
      }
    }
    out.push(`<line x1="${W0}" y1="${pad + 10}" x2="${W0}" y2="${Math.max(H, y + 20) - 20}" stroke="#ddd" stroke-width="1"/>`, ...lg);
    H = Math.max(H, y + 30);
  }

  // wall construction key (plan sheet)
  if (sheet === "plan" && info.segments.length) {
    const used = [...new Set(info.segments.map((s) => s.construction ?? "block_200"))];
    let x = pad, y = H + 4;
    for (const id of used) {
      const a = WALL_ASSEMBLIES[id];
      const label = a.label + (a.plastered ? ", plastered" : "");
      const w = 27 + label.length * 5.6 + 18;
      if (x > pad && x + w > W0 - pad) (x = pad), (y += 16);
      out.push(`<rect x="${x}" y="${y - 8}" width="22" height="10" fill="${WALL_FILL[a.kind]}" stroke="#3a3a3a" stroke-width="0.9"/>`);
      out.push(`<text x="${x + 27}" y="${y + 1}" font-size="10.5" fill="#444">${esc(label)}</text>`);
      x += w;
    }
    H = y + 18;
  }

  // north arrow + scale bar
  const nx = W0 - pad, ny = 20;
  out.push(`<g><polygon points="${nx},${ny + 2} ${nx - 6},${ny + 20} ${nx + 6},${ny + 20}" fill="#333"/><text x="${nx}" y="${ny + 32}" font-size="11" text-anchor="middle" fill="#333">N</text></g>`);
  out.push(`<line x1="${W0 - pad - 5 * S}" y1="${H - 15}" x2="${W0 - pad}" y2="${H - 15}" stroke="#333" stroke-width="3"/><text x="${W0 - pad - 2.5 * S}" y="${H - 20}" font-size="10" text-anchor="middle" fill="#333">5 m</text>`);
  out.push(`</svg>`);
  out[svgOpen] = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Helvetica, Arial, sans-serif">`;
  return out.join("\n");
}

export async function svgToPng(svg: string): Promise<Buffer> {
  const { Resvg } = await import("@resvg/resvg-js");
  return Buffer.from(new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: "Helvetica" } }).render().asPng());
}

/** Plan fill of a garden surface (stronger on the landscape sheet). */
function gardenFill(surface: string, strong: boolean): string {
  const f: Record<string, [string, string]> = {
    lawn: ["#cfe8b5", "#b7dc95"], turf: ["#bfe3a0", "#9fd47a"], planting: ["#e3d2b8", "#d4b996"], gravel: ["#e2e0db", "#d0cdc6"],
    mulch: ["#d9c1a3", "#c8a47e"], paving: ["#e9e6e0", "#dcd7cf"], sand: ["#f1e6c8", "#e8d8ad"],
  };
  const [soft, hard] = f[surface] ?? ["#e8efe0", "#d8e6c8"];
  return `fill="${strong ? hard : soft}" stroke="${strong ? "#8aa36f" : "#b9cba5"}" stroke-width="0.8"${surface === "turf" ? ' stroke-dasharray="3 2"' : ""}`;
}
