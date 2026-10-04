/**
 * Building services: the electrical and plumbing layout of a level.
 *
 * With `services.auto` (default) the layout is derived from the design, the way an MEP designer would set it out:
 *  - switches inside each lit room beside the door on the latch side (2-way at further doors to circulation and at
 *    double-bed bedsides), one rocker per light group, switching wired to the fixtures;
 *  - double sockets for furniture (bedsides, desk, TV wall, sofa end, floor lamps), worktop sockets clear of the sink
 *    and hob, appliance spurs (oven, dishwasher, fridge, washing machine, hood, water heater), a cooker unit, shaver
 *    sockets at basins, extract fans in wet rooms, smoke / heat detectors, data and TV points, the distribution
 *    board and a doorbell at the front door; then general sockets spread round the walls to a per-room target;
 *  - sanitary fixtures from furniture and casework with cold / hot supplies and waste / soil drains to a stack in the
 *    room corner (shared between neighbouring wet rooms), floor drains, a water heater per wet room and the main
 *    stop valve; pipes run along the walls;
 *  - circuits (lighting, power, kitchen, cooker, dedicated appliances, detectors) with ratings.
 * Explicit `electrical` / `plumbing` points are added on top (explicit stacks, heaters and the inlet replace the
 * automatic ones); `services.omit` drops auto points by id. Wall points get face plates in 3D.
 */
import { z } from "zod";
import { Direction, Id, Point } from "../schema/common.js";
import { m4, pointInPolygon, pointSegment, polygonArea, polygonCentroid, signedArea, v2, type Vec2 } from "../geometry/math.js";
import { MeshBuilder } from "../geometry/mesh.js";
import type { SceneNode } from "../geometry/scene.js";
import type { Level, Room } from "../schema/schema.js";
import type { ResolvedRun } from "./casework/layout.js";
import { legPoint } from "./casework/layout.js";
import type { CeilingLayout } from "./finishes.js";
import { FURNITURE } from "./furniture.js";
import type { PlacedOpening } from "./openings.js";
import { segDir, type WallSegment } from "./walls.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const ELECTRICAL_TYPES = [
  "light_point", "switch", "switch_2way", "dimmer", "socket", "double_socket", "usb_socket", "data", "tv", "shaver",
  "cooker", "spur", "fan", "ac", "db", "smoke", "heat", "doorbell",
] as const;
export type ElectricalType = (typeof ELECTRICAL_TYPES)[number];
export const PLUMBING_TYPES = ["stack", "floor_drain", "water_heater", "inlet", "tap"] as const;
export type PlumbingType = (typeof PLUMBING_TYPES)[number];

/** Points mounted on the ceiling (not snapped to a wall). */
export const CEILING_POINTS = new Set<ElectricalType>(["light_point", "fan", "smoke", "heat"]);
const DEFAULT_HEIGHT: Record<ElectricalType, number> = {
  light_point: 0, switch: 1.2, switch_2way: 1.2, dimmer: 1.2, socket: 0.3, double_socket: 0.3, usb_socket: 0.3, data: 0.3, tv: 0.3,
  shaver: 1.5, cooker: 1.2, spur: 0.3, fan: 0, ac: 2.3, db: 1.6, smoke: 0, heat: 0, doorbell: 1.4,
};

export const ElectricalSchema = z
  .object({
    id: Id.optional(),
    type: z.enum(ELECTRICAL_TYPES).describe(
      "light_point (ceiling lighting outlet without a designed fixture) | switch | switch_2way | dimmer | socket | double_socket | usb_socket | data | tv | shaver | cooker (cooker control unit) | spur (fused spur / dedicated appliance point) | fan (extract) | ac (split unit) | db (distribution board) | smoke | heat (detectors, on the ceiling) | doorbell",
    ),
    position: Point.describe("Plan point at / near the wall face: wall points snap onto the nearest face (like sconces); light_point / fan / smoke / heat stay where given on the ceiling"),
    height: z.number().min(0).optional().describe("Centre above the finished floor. Defaults: switches 1.2, sockets / data / tv / spur 0.3, shaver 1.5, cooker 1.2, ac 2.3, db 1.6, doorbell 1.4"),
    facing: Direction.optional().describe("Which side of the wall when the point is on the wall centreline (direction it faces)"),
    gangs: z.number().int().min(1).max(4).optional().describe("Switches: rockers (default: one per light it controls)"),
    controls: z.array(Id).default([]).describe("Switches: ids of the lights (level.lights) it switches"),
    label: z.string().optional().describe("Shown on the electrical sheet, e.g. 'fridge', 'EV'"),
  })
  .describe("Electrical point: switch, socket, data, appliance point, detector, distribution board...");
export type ElectricalSpec = z.output<typeof ElectricalSchema>;

export const PlumbingSchema = z
  .object({
    id: Id.optional(),
    type: z.enum(PLUMBING_TYPES).describe("stack (soil / waste stack: fixtures drain to the nearest) | floor_drain | water_heater (feeds the wet room it is in) | inlet (main stop valve) | tap (garden / utility cold tap)"),
    position: Point,
    size: z.number().positive().optional().describe("Stack / drain diameter in mm (default stack 100, floor drain 50)"),
    label: z.string().optional(),
  })
  .describe("Plumbing point that the automatic layout routes to (or an extra drain / tap)");
export type PlumbingSpec = z.output<typeof PlumbingSchema>;

export const ServicesSchema = z
  .object({
    auto: z.boolean().default(true).describe("Lay out switches, sockets, appliance points, detectors, supplies and drains from the design; explicit electrical / plumbing points are added on top"),
    plates: z.boolean().default(true).describe("Model switch / socket face plates (and detectors, fans, the DB) in 3D"),
    omit: z.array(Id).default([]).describe("Ids of automatic points to leave out (shown on the electrical / plumbing sheets)"),
  })
  .prefault({})
  .describe("Electrical and plumbing layout settings");

// ---------------------------------------------------------------------------
// Layout types
// ---------------------------------------------------------------------------

export interface ElecPoint {
  id: string;
  type: ElectricalType;
  /** Plan position (on the wall face for wall points). */
  at: Vec2;
  /** Wall face normal pointing into the room (wall points). */
  n?: Vec2;
  /** Centre above the finished floor (ceiling points: the ceiling height). */
  height: number;
  room: number;
  gangs?: number;
  /** Light groups switched (switches). */
  controls: string[];
  label?: string;
  auto: boolean;
  circuit?: string;
}

export type FixtureKind = "wc" | "basin" | "sink" | "shower" | "bath" | "dishwasher" | "washing_machine" | "floor_drain" | "tap";

export interface PlumbFixture {
  id: string;
  kind: FixtureKind;
  /** Connection point (on the wall behind the fixture, or the drain itself). */
  at: Vec2;
  room: number;
  cold: boolean;
  hot: boolean;
  /** Waste / soil diameter (mm); 0 = none. */
  drain: number;
  /** Footprint (for the sheet). */
  poly?: Vec2[];
  auto: boolean;
}

export interface PlumbPoint {
  id: string;
  type: PlumbingType;
  at: Vec2;
  room: number;
  size?: number;
  label?: string;
  auto: boolean;
}

export interface PipeRun {
  kind: "cold" | "hot" | "waste" | "soil";
  pts: Vec2[];
  /** mm */
  size: number;
}

export interface Circuit {
  id: string;
  kind: "lighting" | "power" | "kitchen" | "cooker" | "appliance" | "detectors" | "hvac" | "lift";
  rating: number;
  label: string;
  rooms: string[];
  points: number;
}

export interface LightGroup {
  /** Light spec id, or "<prefix>*" for related specs switched together (island_p1..3, bed_sconce_l/_r). */
  id: string;
  /** Light spec ids in the group. */
  ids: string[];
  type: string;
  room: number;
  /** Fixture positions. */
  pts: Vec2[];
  lumens: number;
}

export interface ServicesLayout {
  electrical: ElecPoint[];
  fixtures: PlumbFixture[];
  points: PlumbPoint[];
  pipes: PipeRun[];
  circuits: Circuit[];
  groups: LightGroup[];
}

export interface ServicesContext {
  levelZ: number;
  floorZ: number;
  segments: WallSegment[];
  openings: PlacedOpening[];
  runs: ResolvedRun[];
  ceilings: CeilingLayout[];
  /** Light fixtures as built (spec id / name, plan position). */
  fixtures: { id: string; type: string; at: Vec2; lumens: number }[];
  /** Polygons that are outside but part of the dwelling (terraces). */
  terraces: Vec2[][];
  warn: (m: string) => void;
}

// ---------------------------------------------------------------------------
// Room kinds
// ---------------------------------------------------------------------------

export type RoomKind = "bath" | "kitchen" | "bedroom" | "living" | "study" | "hall" | "closet" | "laundry" | "garage" | "outdoor" | "other";
export const KIND_RE: [RoomKind, RegExp][] = [
  ["outdoor", /terrace|balcony|\bdeck\b|patio|veranda|porch|garden|courtyard|\byard\b|roof/i],
  ["bath", /bath|\bwc\b|toilet|shower|en-?suite|powder|lavatory|washroom|restroom/i],
  ["laundry", /laundry|utility/i],
  ["kitchen", /kitchen|pantry|kitchenette/i],
  ["closet", /closet|wardrobe|dressing|store|storage/i],
  ["bedroom", /bed|master|guest room|nursery|kids/i],
  ["study", /study|office|library|\bden\b|work/i],
  ["living", /living|lounge|family|dining|sitting|majlis|diwaniya|salon|reception/i],
  ["hall", /hall|entry|entrance|corridor|foyer|lobby|landing|passage|vestibule/i],
  ["garage", /garage|carport/i],
];

const BEDS = new Set(["bed", "platform_bed", "canopy_bed", "bunk_bed", "kids_bed"]);
const PLUMB_FURN: Record<string, { kind: FixtureKind; cold: boolean; hot: boolean; drain: number }> = {
  toilet: { kind: "wc", cold: true, hot: false, drain: 100 },
  bathroom_sink: { kind: "basin", cold: true, hot: true, drain: 40 },
  bathtub: { kind: "bath", cold: true, hot: true, drain: 50 },
  freestanding_bathtub: { kind: "bath", cold: true, hot: true, drain: 50 },
  shower: { kind: "shower", cold: true, hot: true, drain: 50 },
  sink_counter: { kind: "sink", cold: true, hot: true, drain: 50 },
  dishwasher: { kind: "dishwasher", cold: true, hot: false, drain: 40 },
  washing_machine: { kind: "washing_machine", cold: true, hot: false, drain: 50 },
};
const PLUMB_CASE: Record<string, { kind: FixtureKind; cold: boolean; hot: boolean; drain: number }> = {
  sink: { kind: "sink", cold: true, hot: true, drain: 50 },
  basin: { kind: "basin", cold: true, hot: true, drain: 40 },
  dishwasher: { kind: "dishwasher", cold: true, hot: false, drain: 40 },
};
export const FIXTURE_LABEL: Record<FixtureKind, string> = {
  wc: "WC", basin: "basin", sink: "sink", shower: "shower", bath: "bath", dishwasher: "dishwasher", washing_machine: "washer", floor_drain: "floor drain", tap: "tap",
};

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

const ccw = (p: Vec2[]) => (signedArea(p) < 0 ? [...p].reverse() : p);
const slug = (r: Room, i: number) => (r.id ?? r.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")) || `room${i}`;

interface Stretch {
  room: number;
  seg: WallSegment;
  /** Start point on the wall face, unit direction, inward normal, usable length. */
  p: Vec2;
  d: Vec2;
  n: Vec2;
  len: number;
}

interface Furn {
  type: string;
  id?: string;
  c: Vec2;
  rot: number;
  w: number;
  d: number;
  h: number;
  elevation: number;
  poly: Vec2[];
  back: Vec2;
  room: number;
}

/** Nearest wall face to p: the face point, inward normal (toward p) and distance from the centreline. */
function nearestFace(p: Vec2, segs: WallSegment[], maxDist = 0.6): { seg: WallSegment; face: Vec2; n: Vec2; u: number; dist: number } | null {
  let best: { seg: WallSegment; t: number; dist: number } | null = null;
  for (const s of segs) {
    const r = pointSegment(p, s.a, s.b);
    if (r.dist < (best?.dist ?? Infinity)) best = { seg: s, t: r.t, dist: r.dist };
  }
  if (!best || best.dist > best.seg.thickness / 2 + maxDist) return null;
  const s = best.seg, d = segDir(s), left = v2.perp(d);
  const len = v2.dist(s.a, s.b);
  const foot = v2.add(s.a, v2.scale(d, best.t * len));
  const side = Math.sign(v2.dot(v2.sub(p, foot), left)) || (s.interiorSide === "left" ? 1 : -1);
  const n = v2.scale(left, side);
  return { seg: s, face: v2.add(foot, v2.scale(n, s.thickness / 2)), n, u: best.t * len, dist: best.dist };
}

/** Polygon with each edge moved inward by its own distance (CCW in, CCW out). */
function insetEdges(poly: Vec2[], dist: number[]): Vec2[] {
  const n = poly.length;
  const lines = poly.map((a, i) => {
    const b = poly[(i + 1) % n];
    const e = v2.norm(v2.sub(b, a));
    return { p: v2.add(a, v2.scale(v2.perp(e), dist[i])), e };
  });
  return poly.map((q, i) => {
    const L0 = lines[(i + n - 1) % n], L1 = lines[i];
    const den = v2.cross(L0.e, L1.e);
    if (Math.abs(den) < 1e-6) return v2.add(q, v2.scale(v2.perp(L1.e), dist[i]));
    const t = v2.cross(v2.sub(L1.p, L0.p), L1.e) / den;
    return v2.add(L0.p, v2.scale(L0.e, t));
  });
}

/** Path along a closed outline from a to b (the shorter way round), with a and b joined perpendicularly. */
function alongOutline(path: Vec2[], a: Vec2, b: Vec2): Vec2[] {
  const n = path.length;
  const cum: number[] = [0];
  for (let i = 0; i < n; i++) cum.push(cum[i] + v2.dist(path[i], path[(i + 1) % n]));
  const total = cum[n];
  const proj = (p: Vec2) => {
    let best = { s: 0, q: path[0], d: Infinity };
    for (let i = 0; i < n; i++) {
      const r = pointSegment(p, path[i], path[(i + 1) % n]);
      if (r.dist < best.d) best = { s: cum[i] + r.t * (cum[i + 1] - cum[i]), q: v2.lerp(path[i], path[(i + 1) % n], r.t), d: r.dist };
    }
    return best;
  };
  const A = proj(a), B = proj(b);
  const fwd = (B.s - A.s + total) % total;
  const dirFwd = fwd <= total - fwd;
  const out: Vec2[] = [a, A.q];
  const between = (s: number) => (dirFwd ? (s - A.s + total) % total < fwd : (A.s - s + total) % total < total - fwd);
  const idx = [...Array(n).keys()].filter((i) => between(cum[i]) && cum[i] !== A.s);
  idx.sort((i, j) => (dirFwd ? ((cum[i] - A.s + total) % total) - ((cum[j] - A.s + total) % total) : ((A.s - cum[i] + total) % total) - ((A.s - cum[j] + total) % total)));
  for (const i of idx) out.push(path[i]);
  out.push(B.q, b);
  return out.filter((p, i) => i === 0 || v2.dist(p, out[i - 1]) > 1e-4);
}

/** The point `dist` along a closed outline from the projection of p (forward, i.e. CCW). */
function pointAlong(path: Vec2[], p: Vec2, dist: number): Vec2 {
  const n = path.length;
  let best = { i: 0, t: 0, d: Infinity };
  for (let i = 0; i < n; i++) {
    const r = pointSegment(p, path[i], path[(i + 1) % n]);
    if (r.dist < best.d) best = { i, t: r.t, d: r.dist };
  }
  let i = best.i, q = v2.lerp(path[i], path[(i + 1) % n], best.t), left = dist;
  for (let k = 0; k < n; k++) {
    const b = path[(i + 1) % n];
    const seg = v2.dist(q, b);
    if (seg >= left) return v2.add(q, v2.scale(v2.norm(v2.sub(b, q)), left));
    left -= seg;
    q = b;
    i = (i + 1) % n;
  }
  return q;
}

/** Two-leg orthogonal route a → b (bend chosen to stay inside `inside` when given). */
function lRoute(a: Vec2, b: Vec2, inside?: (p: Vec2) => boolean): Vec2[] {
  const c1: Vec2 = [b[0], a[1]], c2: Vec2 = [a[0], b[1]];
  const c = inside && !inside(c1) && inside(c2) ? c2 : c1;
  return [a, c, b];
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export function buildServices(lv: Level, ctx: ServicesContext): { layout: ServicesLayout; node?: SceneNode } {
  const set = lv.services;
  const rooms = lv.rooms;
  const polys = rooms.map((r) => ccw(r.polygon as Vec2[]));
  const roomAt = (p: Vec2) => polys.findIndex((pg) => pointInPolygon(p, pg));
  const keys = rooms.map(slug);
  const kinds = rooms.map(() => new Set<RoomKind>());
  const segs = ctx.segments;
  const warn = ctx.warn;

  // ---- furniture with footprints ----
  const furn: Furn[] = lv.furniture.flatMap((f) => {
    const t = FURNITURE[f.type];
    if (!t) return [];
    const w = f.width ?? t.defaults.width, d = f.depth ?? t.defaults.depth, h = f.height ?? t.defaults.height;
    const rot = ((f.rotation ?? (f.facing ? { south: 0, east: 90, north: 180, west: 270 }[f.facing] : 0)) * Math.PI) / 180;
    const c = f.position as Vec2;
    const P = (x: number, y: number) => v2.add(c, v2.rotate([x, y], rot));
    return [{ type: f.type, id: f.id, c, rot, w, d, h, elevation: f.elevation, poly: [P(-w / 2, -d / 2), P(w / 2, -d / 2), P(w / 2, d / 2), P(-w / 2, d / 2)], back: P(0, d / 2), room: roomAt(c) }];
  });

  // casework modules (base / tall / upper) with their wall-side back points
  const caseMods = ctx.runs.flatMap((r) =>
    [...r.base, ...r.uppers].filter((p) => p.kind !== "gap").map((p) => {
      const leg = r.legs[p.leg];
      const poly = [legPoint(leg, p.x0, -p.depth), legPoint(leg, p.x1, -p.depth), legPoint(leg, p.x1, 0), legPoint(leg, p.x0, 0)];
      const back = legPoint(leg, (p.x0 + p.x1) / 2, 0);
      return { run: r, p, leg, poly, back, room: roomAt(polygonCentroid(poly)), top: r.dims.height };
    }),
  );

  // ---- room kinds (name, then contents) ----
  rooms.forEach((r, i) => {
    for (const [k, re] of KIND_RE) if (re.test(r.name)) kinds[i].add(k);
  });
  for (const f of furn) {
    if (f.room < 0) continue;
    if (["toilet", "bathtub", "shower", "freestanding_bathtub"].includes(f.type)) kinds[f.room].add("bath");
    if (BEDS.has(f.type)) kinds[f.room].add("bedroom");
    if (f.type === "washing_machine" && !kinds[f.room].has("bath") && !kinds[f.room].has("kitchen")) kinds[f.room].add("laundry");
  }
  for (const m of caseMods) if (m.room >= 0 && (m.p.kind === "hob" || m.p.kind === "sink")) kinds[m.room].add("kitchen");
  rooms.forEach((_, i) => {
    if (!kinds[i].size) kinds[i].add("other");
  });
  const is = (i: number, k: RoomKind) => i >= 0 && kinds[i].has(k);

  // ---- wall stretches per room (wall faces, minus openings and corners) ----
  const stretches: Stretch[] = [];
  polys.forEach((pg, ri) => {
    for (let i = 0; i < pg.length; i++) {
      const a = pg[i], b = pg[(i + 1) % pg.length];
      const len = v2.dist(a, b);
      if (len < 0.3) continue;
      const d = v2.scale(v2.sub(b, a), 1 / len), n = v2.perp(d);
      for (const s of segs) {
        const sd = v2.sub(s.b, s.a), sl = v2.len(sd);
        if (sl < 1e-3 || Math.abs(v2.cross(v2.scale(sd, 1 / sl), d)) > 0.02) continue;
        if (Math.abs(v2.cross(d, v2.sub(s.a, a))) > s.thickness / 2 + 0.03) continue;
        const t0 = Math.max(0, Math.min(v2.dot(v2.sub(s.a, a), d), v2.dot(v2.sub(s.b, a), d)));
        const t1 = Math.min(len, Math.max(v2.dot(v2.sub(s.a, a), d), v2.dot(v2.sub(s.b, a), d)));
        if (t1 - t0 < 0.2) continue;
        let iv: [number, number][] = [[t0 + s.thickness / 2, t1 - s.thickness / 2]];
        for (const o of ctx.openings) {
          if (o.seg !== s) continue;
          const mid = v2.add(o.seg.a, v2.scale(segDir(o.seg), o.u));
          const tm = v2.dot(v2.sub(mid, a), d);
          iv = iv.flatMap(([x0, x1]) => [[x0, Math.min(x1, tm - o.width / 2)], [Math.max(x0, tm + o.width / 2), x1]] as [number, number][]);
        }
        for (const [x0, x1] of iv)
          if (x1 - x0 > 0.25) stretches.push({ room: ri, seg: s, p: v2.add(v2.add(a, v2.scale(d, x0)), v2.scale(n, s.thickness / 2)), d, n, len: x1 - x0 });
      }
    }
  });

  // ---- light groups ----
  const groups = new Map<string, LightGroup>();
  for (const f of ctx.fixtures) {
    let ri = roomAt(f.at);
    if (ri < 0) {
      // sconces on an outside face: inside test fails; take the room on the other side of the wall
      const nf = nearestFace(f.at, segs, 0.2);
      if (nf) ri = roomAt(v2.add(f.at, v2.scale(nf.n, -(nf.seg.thickness + 0.1))));
    }
    // related specs of one type in a room share a rocker: island_p1/_p2, bed_sconce_l/_r, hall_flush/hall_flush2
    const base = f.id.replace(/[_-]?(\d+|l|r|left|right)$/i, "");
    const key = `${f.type}:${base}@${ri}`;
    const g = groups.get(key) ?? { id: f.id, ids: [], type: f.type, room: ri, pts: [], lumens: 0 };
    if (!g.ids.includes(f.id)) g.ids.push(f.id);
    if (g.ids.length > 1) g.id = `${base}*`;
    g.pts.push(f.at);
    g.lumens += f.lumens;
    groups.set(key, g);
  }
  const groupList = [...groups.values()];
  const groupOf = (lightId: string) => groupList.find((g) => g.ids.includes(lightId) || g.id === lightId);

  // ---- doors: rooms on both sides ----
  const doorSides = ctx.openings
    .filter((o) => o.op.type !== "window")
    .map((o) => {
      const d = segDir(o.seg), N = v2.perp(d);
      const mid = v2.add(o.seg.a, v2.scale(d, o.u));
      const probe = (s: number) => roomAt(v2.add(mid, v2.scale(N, s * (o.seg.thickness / 2 + 0.25))));
      const terr = (s: number) => ctx.terraces.some((t) => pointInPolygon(v2.add(mid, v2.scale(N, s * (o.seg.thickness / 2 + 0.25))), t));
      return { o, d, N, mid, left: probe(1), right: probe(-1), leftTerrace: terr(1), rightTerrace: terr(-1) };
    });

  const elec: ElecPoint[] = [];
  const counters = new Map<string, number>();
  const nextId = (prefix: string, ri: number) => {
    const k = `${prefix}.${ri >= 0 ? keys[ri] : "ext"}`;
    const n = (counters.get(k) ?? 0) + 1;
    counters.set(k, n);
    return `${k}.${n}`;
  };
  const omit = new Set(set.omit);
  const addE = (p: Omit<ElecPoint, "id" | "auto" | "controls"> & { controls?: string[] }, prefix: string) => {
    const id = nextId(prefix, p.room);
    if (omit.has(id)) return null;
    const e: ElecPoint = { ...p, id, auto: true, controls: p.controls ?? [] };
    elec.push(e);
    return e;
  };

  /** Is a wall point free (not in another opening, not behind tall casework or tall furniture)? */
  const tallBlock = [
    ...caseMods.filter((m) => m.p.row === "tall" || m.p.kind === "wardrobe").map((m) => m.poly),
    ...furn.filter((f) => f.h > 1.2 && f.elevation < 0.5 && !["plant_large", "floor_lamp", "coat_rack", "mirror_full_length", "curtain", "tree"].includes(f.type)).map((f) => f.poly),
  ];
  const baseBlock = caseMods.filter((m) => m.p.row === "base").map((m) => m.poly);
  const behind = (p: Vec2, n: Vec2, polysB: Vec2[][]) => {
    const q = v2.add(p, v2.scale(n, 0.08));
    return polysB.some((pg) => pointInPolygon(q, pg));
  };
  const onSeg = (s: WallSegment, u: number, margin: number) => {
    const len = v2.dist(s.a, s.b);
    if (u < s.thickness / 2 + margin * 0.5 || u > len - s.thickness / 2 - margin * 0.5) return false;
    return !ctx.openings.some((o) => o.seg === s && Math.abs(o.u - u) < o.width / 2 + margin);
  };
  const facePoint = (s: WallSegment, u: number, side: number): { at: Vec2; n: Vec2 } => {
    const d = segDir(s), N = v2.scale(v2.perp(d), side);
    return { at: v2.add(v2.add(s.a, v2.scale(d, u)), v2.scale(N, s.thickness / 2)), n: N };
  };

  const near = (type: ElectricalType[], p: Vec2, r: number) => elec.some((e) => type.includes(e.type) && v2.dist(e.at, p) < r);

  if (set.auto) {
    // ---- rooms without designed lights get a ceiling lighting point (switched like a fixture) ----
    rooms.forEach((_, ri) => {
      if (groupList.some((g) => g.room === ri) || polygonArea(polys[ri]) < 1.5 || is(ri, "outdoor")) return;
      const c = polygonCentroid(polys[ri]);
      const at = pointInPolygon(c, polys[ri]) ? c : polys[ri].reduce((a, b) => v2.lerp(a, b, 0.5));
      const e = addE({ type: "light_point", at, height: ctx.ceilings[ri]?.height ?? 2.6, room: ri }, "lp");
      if (e) groupList.push({ id: e.id, ids: [], type: "light_point", room: ri, pts: [at], lumens: 0 });
    });

    // ---- switches beside doors ----
    const roomDoors = rooms.map(() => [] as { ds: (typeof doorSides)[number]; side: number; other: number; outside: boolean; terrace: boolean }[]);
    for (const ds of doorSides)
      for (const side of [1, -1]) {
        const ri = side > 0 ? ds.left : ds.right;
        const other = side > 0 ? ds.right : ds.left;
        if (ri >= 0 && other !== ri) roomDoors[ri].push({ ds, side, other, outside: other < 0, terrace: side > 0 ? ds.rightTerrace : ds.leftTerrace });
      }
    const switchAt = (door: (typeof roomDoors)[number][number], hinge: boolean) => {
      const o = door.ds.o;
      const u0 = o.u - o.width / 2, u1 = o.u + o.width / 2;
      const hingeStart = o.op.hinge !== "right";
      const latchFirst = o.op.type === "door" && o.style !== "double" && o.style !== "sliding" ? (hingeStart ? [1, -1] : [-1, 1]) : [1, -1];
      const order = hinge ? latchFirst.map((x) => -x) : latchFirst;
      for (const dir of order) {
        const u = dir > 0 ? u1 + 0.18 : u0 - 0.18;
        if (!onSeg(o.seg, u, 0.08)) continue;
        const fp = facePoint(o.seg, u, door.side);
        if (behind(fp.at, fp.n, tallBlock)) continue;
        return fp;
      }
      // door tight in a corner: nearest free wall face of the room near the latch edge (e.g. the return wall)
      const ri = door.side > 0 ? door.ds.left : door.ds.right;
      const edge = v2.add(door.ds.mid, v2.scale(door.ds.d, order[0] * (o.width / 2 + 0.15)));
      let best: { at: Vec2; n: Vec2; d: number } | null = null;
      for (const st of stretches.filter((x) => x.room === ri)) {
        const t = Math.max(0.08, Math.min(st.len - 0.08, v2.dot(v2.sub(edge, st.p), st.d)));
        const at = v2.add(st.p, v2.scale(st.d, t));
        const d = v2.dist(at, edge);
        if (d < (best?.d ?? 1.2) && !behind(at, st.n, tallBlock)) best = { at, n: st.n, d };
      }
      return best ? { at: best.at, n: best.n } : null;
    };
    rooms.forEach((_, ri) => {
      const gs = groupList.filter((g) => g.room === ri).sort((a, b) => b.lumens - a.lumens);
      const doors = roomDoors[ri];
      // lights of an outdoor room (terrace modelled as a room) are switched inside, at the door to it
      const outdoorDoors = doors.filter((d) => is(d.other, "outdoor") && groupList.some((g) => g.room === d.other));
      if ((!gs.length && !outdoorDoors.length) || !doors.length || is(ri, "outdoor")) return;
      // main door: from circulation / outside, else the widest
      const score = (d: (typeof doors)[number]) => (d.outside && !d.terrace ? 4 : 0) + (is(d.other, "hall") ? 3 : 0) + (is(d.other, "living") ? 2 : 0) + (d.terrace ? -2 : 0) + d.ds.o.width;
      const sorted = [...doors].sort((a, b) => score(b) - score(a));
      const main = sorted[0];
      // exterior groups (terrace lights) go on the switch at the terrace door
      const extGroups = new Map<(typeof doors)[number], string[]>();
      const insideIds: string[] = [];
      for (const g of gs) {
        const allOut = g.pts.every((p) => roomAt(p) !== ri && !pointInPolygon(p, polys[ri]));
        if (allOut) {
          const td = doors.filter((d) => d.terrace || d.outside).sort((a, b) => Math.min(...g.pts.map((p) => v2.dist(p, a.ds.mid))) - Math.min(...g.pts.map((p) => v2.dist(p, b.ds.mid))))[0];
          if (td && td !== main) {
            extGroups.set(td, [...(extGroups.get(td) ?? []), g.id]);
            continue;
          }
        }
        insideIds.push(g.id);
      }
      for (const d of outdoorDoors) {
        const ids = groupList.filter((g) => g.room === d.other).map((g) => g.id);
        if (d === main) insideIds.push(...ids);
        else extGroups.set(d, [...(extGroups.get(d) ?? []), ...ids]);
      }
      const mainPt = insideIds.length ? switchAt(main, false) : null;
      if (!insideIds.length) {
        // only outdoor lights to switch here
      } else if (mainPt) {
        for (let k = 0; k < insideIds.length; k += 4) {
          const ctl = insideIds.slice(k, k + 4);
          const shift = v2.scale(v2.perp(mainPt.n), (k / 4) * 0.1 * (v2.dot(v2.perp(mainPt.n), v2.sub(mainPt.at, main.ds.mid)) > 0 ? 1 : -1));
          addE({ type: "switch", at: v2.add(mainPt.at, shift), n: mainPt.n, height: 1.2, room: ri, gangs: ctl.length, controls: ctl }, "sw");
        }
      } else warn(`services: no wall beside door '${main.ds.o.id}' for the switch of room '${rooms[ri].name}'`);
      for (const [door, ids] of extGroups) {
        const p = switchAt(door, false);
        if (p) addE({ type: "switch", at: p.at, n: p.n, height: 1.2, room: ri, gangs: ids.length, controls: ids }, "sw");
      }
      // 2-way at further doors to circulation / outside
      const mainGroup = insideIds[0];
      if (mainGroup)
        for (const d of sorted.slice(1)) {
          if (extGroups.has(d)) continue;
          if (!(d.outside || d.terrace || is(d.other, "hall") || is(d.other, "living"))) continue;
          const p = switchAt(d, false);
          if (p) addE({ type: "switch_2way", at: p.at, n: p.n, height: 1.2, room: ri, gangs: 1, controls: [mainGroup] }, "sw");
        }
    });

    // ---- distribution board + doorbell at the front door ----
    const fronts = doorSides
      .filter((ds) => ds.o.op.type === "door" && ((ds.left >= 0) !== (ds.right >= 0)) && !ds.leftTerrace && !ds.rightTerrace)
      .sort((a, b) => Number(/front|entr|main/i.test(b.o.id)) - Number(/front|entr|main/i.test(a.o.id)) || Number(is(b.left >= 0 ? b.left : b.right, "hall")) - Number(is(a.left >= 0 ? a.left : a.right, "hall")));
    const front = fronts[0];
    if (front) {
      const side = front.left >= 0 ? 1 : -1;
      const ri = side > 0 ? front.left : front.right;
      const door = { ds: front, side, other: -1, outside: true, terrace: false };
      const o = front.o;
      for (const dir of o.op.hinge !== "right" ? [-1, 1] : [1, -1]) {
        const u = dir > 0 ? o.u + o.width / 2 + 0.45 : o.u - o.width / 2 - 0.45;
        if (!onSeg(o.seg, u, 0.25)) continue;
        const fp = facePoint(o.seg, u, side);
        if (behind(fp.at, fp.n, tallBlock) || near(["switch", "switch_2way"], fp.at, 0.2)) continue;
        addE({ type: "db", at: fp.at, n: fp.n, height: 1.6, room: ri, label: "DB" }, "db");
        break;
      }
      void door;
      const hingeStart = o.op.hinge !== "right";
      for (const dir of hingeStart ? [1, -1] : [-1, 1]) {
        const u = dir > 0 ? o.u + o.width / 2 + 0.2 : o.u - o.width / 2 - 0.2;
        if (!onSeg(o.seg, u, 0.08)) continue;
        const fp = facePoint(o.seg, u, -side);
        addE({ type: "doorbell", at: fp.at, n: fp.n, height: 1.4, room: -1 }, "bell");
        break;
      }
    }

    // ---- furniture-driven points ----
    const wallBehind = (f: Furn) => {
      const nf = nearestFace(f.back, segs, 0.3);
      if (!nf) return null;
      const faceDist = v2.dot(v2.sub(f.back, nf.face), nf.n);
      return Math.abs(faceDist) < 0.3 ? nf : null;
    };
    const onWallBehind = (f: Furn, localX: number) => {
      const nf = wallBehind(f);
      if (!nf) return null;
      const p = v2.add(f.c, v2.rotate([localX, f.d / 2], f.rot));
      const along = v2.perp(nf.n);
      const at = v2.add(nf.face, v2.scale(along, v2.dot(v2.sub(p, nf.face), along)));
      return { at, n: nf.n };
    };
    for (const f of furn) {
      if (f.room < 0) continue;
      const ri = f.room;
      if (BEDS.has(f.type)) {
        const nf = wallBehind(f);
        if (!nf) continue;
        const stands = furn.filter((g) => g.type === "nightstand" && v2.dist(g.c, f.c) < f.w / 2 + 1.0);
        const sides = stands.length ? stands.map((g) => v2.dot(v2.sub(g.c, f.c), v2.rotate([1, 0], f.rot)) > 0 ? 1 : -1) : f.w >= 1.3 ? [1, -1] : [1];
        for (const sgn of new Set(sides)) {
          // over the nightstand on that side (socket toward the bed, switch outboard, clear of the lamp), else beside the bed
          const ns = stands.find((g) => (v2.dot(v2.sub(g.c, f.c), v2.rotate([1, 0], f.rot)) > 0 ? 1 : -1) === sgn);
          const nsX = ns ? v2.dot(v2.sub(ns.c, f.c), v2.rotate([1, 0], f.rot)) : sgn * (f.w / 2 + 0.25);
          const x = ns ? nsX - sgn * 0.16 : nsX;
          const p = onWallBehind(f, x);
          if (!p) continue;
          addE({ type: "double_socket", at: p.at, n: p.n, height: stands.length ? 0.7 : 0.3, room: ri, label: "bedside" }, "sk");
          const main = groupList.filter((g) => g.room === ri).sort((a, b) => b.lumens - a.lumens)[0];
          if (main && f.w >= 1.3) {
            const along = v2.perp(p.n);
            const away = v2.dot(along, v2.sub(p.at, f.c)) > 0 ? 1 : -1;
            addE({ type: "switch_2way", at: v2.add(p.at, v2.scale(along, away * (ns ? 0.32 : 0.17))), n: p.n, height: ns ? 0.7 : 0.95, room: ri, gangs: 1, controls: [main.id] }, "sw");
          }
        }
      } else if (f.type === "desk" || f.type === "dressing_table") {
        const p = onWallBehind(f, f.w / 2 - 0.25);
        if (!p) continue;
        addE({ type: "double_socket", at: p.at, n: p.n, height: 0.95, room: ri }, "sk");
        if (f.type === "desk") addE({ type: "data", at: v2.add(p.at, v2.scale(v2.perp(p.n), 0.2)), n: p.n, height: 0.95, room: ri }, "dt");
      } else if (f.type === "tv_stand" || (f.type === "tv" && f.elevation > 0.5)) {
        const p = onWallBehind(f, 0);
        if (!p || near(["tv"], p.at, 1.0)) continue;
        const h = f.type === "tv" ? Math.max(0.3, f.elevation - 0.1) : 0.3;
        const al = v2.perp(p.n);
        addE({ type: "tv", at: p.at, n: p.n, height: h, room: ri }, "tv");
        addE({ type: "double_socket", at: v2.add(p.at, v2.scale(al, 0.22)), n: p.n, height: h, room: ri }, "sk");
        addE({ type: "data", at: v2.sub(p.at, v2.scale(al, 0.18)), n: p.n, height: h, room: ri }, "dt");
      } else if ((f.type === "sofa" || f.type === "sectional_sofa") && !is(ri, "bath")) {
        const p = onWallBehind(f, f.w / 2 + 0.15);
        if (p && !behind(p.at, p.n, tallBlock)) addE({ type: "double_socket", at: p.at, n: p.n, height: 0.3, room: ri }, "sk");
      } else if (f.type === "floor_lamp") {
        const nf = nearestFace(f.c, segs, 1.2);
        if (nf && roomAt(v2.add(nf.face, v2.scale(nf.n, 0.05))) === ri && !near(["double_socket", "socket"], nf.face, 0.8)) addE({ type: "double_socket", at: nf.face, n: nf.n, height: 0.3, room: ri }, "sk");
      } else if (["fridge", "washing_machine", "dishwasher"].includes(f.type)) {
        const p = onWallBehind(f, 0);
        if (p) addE({ type: "spur", at: p.at, n: p.n, height: 0.3, room: ri, label: f.type === "washing_machine" ? "washer" : f.type }, "fs");
      } else if (f.type === "stove") {
        const p = onWallBehind(f, f.w / 2 + 0.25);
        if (p) addE({ type: "cooker", at: p.at, n: p.n, height: 1.2, room: ri, label: "cooker" }, "ck");
      }
    }

    // ---- casework: worktop sockets, appliance points, desks ----
    for (const r of ctx.runs) {
      const top = r.dims.height;
      const mods = r.base.filter((p) => p.kind !== "gap");
      for (let li = 0; li < r.legs.length; li++) {
        const leg = r.legs[li];
        const onLeg = mods.filter((p) => p.leg === li);
        const back = (x: number) => {
          const p = legPoint(leg, x, 0);
          const nf = nearestFace(v2.add(p, v2.scale(leg.n, 0.02)), segs, 0.15);
          if (!nf || v2.dot(nf.n, leg.n) < 0.9) return null;
          return { at: v2.add(nf.face, v2.scale(v2.perp(nf.n), v2.dot(v2.sub(p, nf.face), v2.perp(nf.n)))), n: nf.n, u: nf.u, seg: nf.seg };
        };
        const ri = roomAt(legPoint(leg, leg.len / 2, -0.3));
        if (r.freestanding) continue;
        const kitchen = onLeg.some((p) => p.kind === "sink" || p.kind === "hob" || p.kind === "dishwasher" || p.kind === "oven_base") || is(ri, "kitchen");
        // worktop sockets: clear of sink / hob and windows, ~1.2 m apart
        if (kitchen && r.spans.length) {
          const avoid = onLeg.filter((p) => p.kind === "sink" || p.kind === "hob").map((p) => [p.x0 - 0.3, p.x1 + 0.3] as [number, number]);
          const xs = onLeg.filter((p) => p.row === "base" && !["sink", "hob", "corner"].includes(p.kind)).map((p) => (p.x0 + p.x1) / 2);
          const chosen: number[] = [];
          for (const x of xs.sort((a, b) => a - b)) {
            if (avoid.some(([a, b]) => x > a && x < b) || chosen.some((c) => Math.abs(c - x) < 0.9)) continue;
            const bp = back(x);
            if (!bp) continue;
            const win = ctx.openings.some((o) => o.seg === bp.seg && Math.abs(o.u - bp.u) < o.width / 2 + 0.1 && o.z0 - ctx.floorZ < top + 0.35);
            if (win) continue;
            chosen.push(x);
            addE({ type: "double_socket", at: bp.at, n: bp.n, height: top + 0.2, room: ri, label: "worktop" }, "sk");
          }
        }
        for (const p of onLeg) {
          const cx = (p.x0 + p.x1) / 2;
          if (p.kind === "hob") {
            for (const x of [p.x1 + 0.3, p.x0 - 0.3]) {
              const bp = back(x);
              if (!bp || (x > leg.len && x < 0)) continue;
              addE({ type: "cooker", at: bp.at, n: bp.n, height: top + 0.25, room: ri, label: "cooker" }, "ck");
              break;
            }
          } else if (p.kind === "oven_base" || p.kind === "tall_oven" || p.kind === "dishwasher" || p.kind === "fridge") {
            const bp = back(cx);
            if (bp) addE({ type: "spur", at: bp.at, n: bp.n, height: 0.3, room: ri, label: p.kind === "tall_oven" || p.kind === "oven_base" ? "oven" : p.kind }, "fs");
          } else if (p.kind === "desk") {
            const bp = back(cx);
            if (bp) {
              addE({ type: "double_socket", at: bp.at, n: bp.n, height: top + 0.15, room: ri }, "sk");
              addE({ type: "data", at: v2.add(bp.at, v2.scale(v2.perp(bp.n), 0.2)), n: bp.n, height: top + 0.15, room: ri }, "dt");
            }
          }
        }
        for (const p of r.uppers.filter((u) => u.leg === li && u.kind === "hood")) {
          const bp = back((p.x0 + p.x1) / 2);
          if (bp) addE({ type: "spur", at: bp.at, n: bp.n, height: Math.min(p.z1 + 0.12, (ctx.ceilings[ri]?.height ?? 2.6) - 0.12), room: ri, label: "hood" }, "fs");
        }
      }
    }
  }

  // ---- plumbing fixtures ----
  const fixtures: PlumbFixture[] = [];
  const pcount = new Map<string, number>();
  const pid = (k: string, ri: number) => {
    const key = `${k}.${ri >= 0 ? keys[ri] : "ext"}`;
    const n = (pcount.get(key) ?? 0) + 1;
    pcount.set(key, n);
    return `${key}.${n}`;
  };
  if (set.auto) {
    for (const f of furn) {
      const spec = PLUMB_FURN[f.type];
      if (!spec || f.room < 0) continue;
      const nf = nearestFace(f.back, segs, 0.4);
      const at = nf && Math.abs(v2.dot(v2.sub(f.back, nf.face), nf.n)) < 0.4 ? v2.add(nf.face, v2.scale(v2.perp(nf.n), v2.dot(v2.sub(f.back, nf.face), v2.perp(nf.n)))) : f.back;
      fixtures.push({ id: pid(spec.kind, f.room), ...spec, at, room: f.room, poly: f.poly, auto: true });
    }
    for (const m of caseMods) {
      const spec = PLUMB_CASE[m.p.kind];
      if (!spec || m.room < 0) continue;
      fixtures.push({ id: pid(spec.kind, m.room), ...spec, at: m.back, room: m.room, poly: m.poly, auto: true });
    }
  }
  // floor drains: showers, then other bathrooms / laundries without one
  const points: PlumbPoint[] = [];
  const omitP = (id: string) => omit.has(id);
  if (set.auto) {
    const wetRooms = [...new Set(fixtures.map((f) => f.room))];
    for (const ri of wetRooms) {
      if (!is(ri, "bath") && !is(ri, "laundry")) continue;
      const shower = furn.find((f) => f.room === ri && f.type === "shower");
      let at: Vec2 | null = shower ? shower.c : null;
      if (!at) {
        // free floor nearest the room centre
        const pg = polys[ri], c = polygonCentroid(pg);
        let best: { p: Vec2; d: number } | null = null;
        const xs = pg.map((p) => p[0]), ys = pg.map((p) => p[1]);
        for (let x = Math.min(...xs) + 0.3; x < Math.max(...xs) - 0.2; x += 0.15)
          for (let y = Math.min(...ys) + 0.3; y < Math.max(...ys) - 0.2; y += 0.15) {
            const p: Vec2 = [x, y];
            if (!pointInPolygon(p, pg) || furn.some((f) => pointInPolygon(p, f.poly)) || caseMods.some((m) => pointInPolygon(p, m.poly))) continue;
            if (pg.some((q, i) => pointSegment(p, q, pg[(i + 1) % pg.length]).dist < 0.35)) continue;
            const d = v2.dist(p, c);
            if (!best || d < best.d) best = { p, d };
          }
        at = best?.p ?? null;
      }
      if (at) {
        const id = pid("fd", ri);
        if (!omitP(id)) fixtures.push({ id, kind: "floor_drain", at, room: ri, cold: false, hot: false, drain: 50, auto: true });
      }
    }
  }
  fixtures.splice(0, fixtures.length, ...fixtures.filter((f) => !omitP(f.id)));
  // explicit plumbing points
  (lv.plumbing ?? []).forEach((p, i) => {
    const at = p.position as Vec2;
    const ri = roomAt(at);
    const id = p.id ?? `plumbing${i}`;
    if (p.type === "floor_drain") fixtures.push({ id, kind: "floor_drain", at, room: ri, cold: false, hot: false, drain: p.size ?? 50, auto: false });
    else if (p.type === "tap") fixtures.push({ id, kind: "tap", at, room: ri, cold: true, hot: false, drain: 0, auto: false });
    else points.push({ id, type: p.type, at, room: ri, size: p.size, label: p.label, auto: false });
  });

  // ---- stacks, heaters, inlet ----
  const pipes: PipeRun[] = [];
  const wet = [...new Set(fixtures.filter((f) => f.room >= 0).map((f) => f.room))];
  // pipe paths along the walls: per-edge inset (wall half-thickness + offset)
  const pathCache = new Map<string, Vec2[]>();
  const roomPath = (ri: number, off: number) => {
    const key = `${ri}:${off}`;
    let p = pathCache.get(key);
    if (p) return p;
    const pg = polys[ri];
    const dist = pg.map((a, i) => {
      const b = pg[(i + 1) % pg.length];
      const m = v2.lerp(a, b, 0.5);
      const t = Math.max(0, ...segs.filter((s) => pointSegment(m, s.a, s.b).dist < s.thickness / 2 + 0.03).map((s) => s.thickness / 2));
      return t + off;
    });
    p = insetEdges(pg, dist);
    pathCache.set(key, p);
    return p;
  };
  const stackFor = new Map<number, PlumbPoint>();
  const stacks = points.filter((p) => p.type === "stack");
  for (const ri of wet) {
    const fx = fixtures.filter((f) => f.room === ri && f.drain > 0);
    if (!fx.length) continue;
    const soil = fx.some((f) => f.kind === "wc");
    const own = stacks.find((s) => s.room === ri) ?? stacks.find((s) => polys[ri].some((q, i) => pointSegment(s.at, q, polys[ri][(i + 1) % polys[ri].length]).dist < 0.6));
    if (own) {
      stackFor.set(ri, own);
      continue;
    }
    if (!set.auto) continue;
    const corners = roomPath(ri, 0.1);
    const target = (fx.find((f) => f.kind === "wc") ?? fx.find((f) => f.kind === "sink") ?? fx[0]).at;
    const corner = [...corners].sort((a, b) => v2.dist(a, target) - v2.dist(b, target))[0];
    const shared = points.find((p) => p.type === "stack" && p.auto && v2.dist(p.at, corner) < 2.0 && (p.size ?? 100) >= (soil ? 100 : 75));
    if (shared) {
      stackFor.set(ri, shared);
      continue;
    }
    const id = `svp.${keys[ri]}`;
    const st: PlumbPoint = { id, type: "stack", at: corner, room: ri, size: soil ? 100 : 75, label: soil ? "SVP" : "WS", auto: true };
    if (omitP(id)) continue;
    points.push(st);
    stackFor.set(ri, st);
  }
  // water heaters: explicit in the room, else one per wet room needing hot water (beside its stack)
  const heaterFor = new Map<number, PlumbPoint>();
  for (const ri of wet) {
    if (!fixtures.some((f) => f.room === ri && f.hot)) continue;
    const own = points.find((p) => p.type === "water_heater" && p.room === ri);
    if (own) {
      heaterFor.set(ri, own);
      continue;
    }
    if (!set.auto) continue;
    const st = stackFor.get(ri);
    const path = roomPath(ri, 0.25);
    const base = st?.room === ri ? st.at : polygonCentroid(polys[ri]);
    // ~0.6 m along the wall from the stack corner
    const at = pointAlong(path, base, 0.6);
    const id = `wh.${keys[ri]}`;
    if (omitP(id)) continue;
    const wh: PlumbPoint = { id, type: "water_heater", at, room: ri, label: "WH", auto: true };
    points.push(wh);
    heaterFor.set(ri, wh);
  }
  let inlet = points.find((p) => p.type === "inlet");
  if (!inlet && set.auto && wet.length) {
    const sink = fixtures.find((f) => f.kind === "sink") ?? fixtures.find((f) => f.cold);
    if (sink && !omitP("msv")) {
      inlet = { id: "msv", type: "inlet", at: sink.at, room: sink.room, label: "MSV", auto: true };
      points.push(inlet);
    }
  }

  // ---- pipe runs ----
  const inside = (ri: number) => (p: Vec2) => ri >= 0 && pointInPolygon(p, polys[ri]);
  for (const f of fixtures) {
    if (f.room < 0) continue;
    const st = stackFor.get(f.room);
    if (f.drain > 0 && st) {
      const pts = st.room === f.room ? alongOutline(roomPath(f.room, 0.08), f.at, st.at) : lRoute(f.at, st.at, inside(f.room));
      pipes.push({ kind: f.kind === "wc" ? "soil" : "waste", pts, size: f.drain });
    }
    if (f.hot) {
      const wh = heaterFor.get(f.room);
      if (wh) pipes.push({ kind: "hot", pts: alongOutline(roomPath(f.room, 0.24), wh.at, f.at), size: 15 });
    }
  }
  // cold: inlet → each wet room's entry (its stack corner / heater), then branches along the walls
  if (inlet) {
    for (const ri of wet) {
      const fx = fixtures.filter((f) => f.room === ri && f.cold);
      if (!fx.length) continue;
      const entry = (stackFor.get(ri)?.room === ri ? stackFor.get(ri)!.at : null) ?? heaterFor.get(ri)?.at ?? fx[0].at;
      const entryIn = roomPath(ri, 0.16).reduce((a, b) => (v2.dist(b, entry) < v2.dist(a, entry) ? b : a));
      if (ri !== inlet.room) pipes.push({ kind: "cold", pts: lRoute(inlet.at, entryIn), size: 22 });
      for (const f of fx) pipes.push({ kind: "cold", pts: alongOutline(roomPath(ri, 0.16), ri === inlet.room ? inlet.at : entryIn, f.at), size: 15 });
      const wh = heaterFor.get(ri);
      if (wh) pipes.push({ kind: "cold", pts: alongOutline(roomPath(ri, 0.16), ri === inlet.room ? inlet.at : entryIn, wh.at), size: 15 });
    }
    for (const f of fixtures.filter((x) => x.room < 0 && x.cold)) pipes.push({ kind: "cold", pts: lRoute(inlet.at, f.at), size: 15 });
  }

  if (set.auto) {
    // ---- bathrooms: extract fan, shaver socket, water heater spur ----
    for (let ri = 0; ri < rooms.length; ri++) {
      if (!is(ri, "bath")) continue;
      const anchor = furn.find((f) => f.room === ri && f.type === "shower") ?? furn.find((f) => f.room === ri && f.type === "toilet");
      const c = polygonCentroid(polys[ri]);
      let at = anchor ? v2.lerp(anchor.c, c, 0.35) : c;
      const lights = groupList.filter((g) => g.room === ri).flatMap((g) => g.pts);
      if (lights.some((q) => v2.dist(q, at) < 0.4)) at = v2.lerp(at, c, -0.4);
      addE({ type: "fan", at, height: ctx.ceilings[ri]?.height ?? 2.6, room: ri, label: "extract" }, "fan");
      const basin = fixtures.find((f) => f.room === ri && f.kind === "basin");
      if (basin) {
        const nf = nearestFace(basin.at, segs, 0.2);
        if (nf) addE({ type: "shaver", at: v2.add(nf.face, v2.scale(v2.perp(nf.n), 0.45)), n: nf.n, height: 1.5, room: ri }, "sh");
      }
    }
    for (const [ri, wh] of heaterFor) {
      if (!wh.auto) continue;
      const nf = nearestFace(wh.at, segs, 0.4);
      if (nf) addE({ type: "spur", at: nf.face, n: nf.n, height: 2.0, room: ri, label: "heater" }, "fs");
    }

    // ---- detectors: smoke in circulation / living / bedrooms, heat in kitchens ----
    for (let ri = 0; ri < rooms.length; ri++) {
      const k = kinds[ri];
      const type: ElectricalType | null = k.has("outdoor") ? null : k.has("hall") || k.has("living") || k.has("bedroom") ? "smoke" : k.has("kitchen") ? "heat" : null;
      if (!type || polygonArea(polys[ri]) < 3) continue;
      const pg = polys[ri], c = polygonCentroid(pg);
      const lights = groupList.filter((g) => g.room === ri).flatMap((g) => g.pts);
      let best: { p: Vec2; d: number } | null = null;
      const xs = pg.map((p) => p[0]), ys = pg.map((p) => p[1]);
      for (let x = Math.min(...xs) + 0.5; x < Math.max(...xs) - 0.4; x += 0.2)
        for (let y = Math.min(...ys) + 0.5; y < Math.max(...ys) - 0.4; y += 0.2) {
          const p: Vec2 = [x, y];
          if (!pointInPolygon(p, pg) || lights.some((q) => v2.dist(q, p) < 0.5)) continue;
          if (pg.some((q, i) => pointSegment(p, q, pg[(i + 1) % pg.length]).dist < 0.5)) continue;
          const d = v2.dist(p, c);
          if (!best || d < best.d) best = { p, d };
        }
      if (best) addE({ type, at: best.p, height: ctx.ceilings[ri]?.height ?? 2.6, room: ri }, type === "smoke" ? "sd" : "hd");
    }

    // ---- general sockets round the walls to a per-room target ----
    const general = new Set<ElectricalType>(["double_socket", "socket", "usb_socket"]);
    rooms.forEach((r, ri) => {
      const k = kinds[ri];
      if (k.has("bath")) return;
      const area = polygonArea(polys[ri]);
      const perim = polys[ri].reduce((a, p, i) => a + v2.dist(p, polys[ri][(i + 1) % polys[ri].length]), 0);
      const target = k.has("outdoor") ? 1 : k.has("living") ? Math.max(3, Math.round(perim / 4.5)) : k.has("bedroom") ? 4 : k.has("study") ? 3 : k.has("hall") ? (area > 3 ? (perim > 10 ? 2 : 1) : 0)
        : k.has("kitchen") ? 1 : k.has("laundry") ? 1 : k.has("garage") ? 2 : k.has("closet") ? (area > 6 ? 1 : 0) : 2;
      const have = () => elec.filter((e) => e.room === ri && general.has(e.type) && e.label !== "worktop").length;
      const cands: { at: Vec2; n: Vec2; pen: number }[] = [];
      for (const st of stretches.filter((s) => s.room === ri)) {
        for (let t = 0.3; t <= st.len - 0.3 + 1e-6; t += 0.25) {
          const at = v2.add(st.p, v2.scale(st.d, t));
          if (behind(at, st.n, tallBlock) || behind(at, st.n, baseBlock)) continue;
          const pen = furn.some((f) => f.h > 0.4 && pointInPolygon(v2.add(at, v2.scale(st.n, 0.12)), f.poly)) ? 1.5 : 0;
          cands.push({ at, n: st.n, pen });
        }
      }
      void r;
      while (have() < target && cands.length) {
        const existing = elec.filter((e) => e.room === ri && e.n && e.type !== "db").map((e) => e.at);
        let best = cands[0], bestScore = -Infinity;
        for (const c of cands) {
          const dmin = existing.length ? Math.min(...existing.map((q) => v2.dist(q, c.at))) : 5;
          const score = Math.min(dmin, 6) - c.pen;
          if (score > bestScore) (bestScore = score), (best = c);
        }
        if (bestScore < 0.8) break;
        addE({ type: "double_socket", at: best.at, n: best.n, height: 0.3, room: ri }, "sk");
        cands.splice(cands.indexOf(best), 1);
      }
    });
  }

  // ---- explicit electrical points ----
  (lv.electrical ?? []).forEach((s, i) => {
    const p = s.position as Vec2;
    const id = s.id ?? `electrical${i}`;
    let at = p, n: Vec2 | undefined;
    if (!CEILING_POINTS.has(s.type)) {
      const nf = nearestFace(p, segs, 0.6);
      if (nf) {
        at = nf.face;
        n = nf.n;
        if (nf.dist < 0.02 && s.facing !== undefined) {
          const deg = typeof s.facing === "number" ? s.facing : { east: 0, north: 90, west: 180, south: 270 }[s.facing];
          const want: Vec2 = [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];
          if (v2.dot(want, nf.n) < 0) {
            n = v2.scale(nf.n, -1);
            at = v2.add(nf.face, v2.scale(n, nf.seg.thickness));
          }
        }
      } else warn(`electrical '${id}' at [${p.join(", ")}] is not near a wall; it is drawn where given`);
    }
    const ri = roomAt(n ? v2.add(at, v2.scale(n, 0.05)) : at);
    for (const c of s.controls) if (!groupOf(c)) warn(`electrical '${id}': controls unknown light '${c}' (lights: ${groupList.flatMap((g) => g.ids).join(", ") || "none"})`);
    const controls = [...new Set(s.controls.map((c) => groupOf(c)?.id ?? c))];
    const height = s.height ?? (CEILING_POINTS.has(s.type) ? (ctx.ceilings[ri]?.height ?? 2.6) : DEFAULT_HEIGHT[s.type]);
    elec.push({ id, type: s.type, at, n, height, room: ri, gangs: s.gangs ?? (s.type.startsWith("switch") || s.type === "dimmer" ? Math.max(1, controls.length) : undefined), controls, label: s.label, auto: false });
  });

  // ---- circuits ----
  const circuits: Circuit[] = [];
  const roomName = (ri: number) => (ri >= 0 ? rooms[ri].name : "outside");
  const assign = (prefix: string, kind: Circuit["kind"], rating: number, label: string, items: { room: number; pts: number; tag: (id: string) => void }[], maxPts: number) => {
    let cur: Circuit | null = null;
    for (const it of items) {
      if (!cur || cur.points + it.pts > maxPts) {
        cur = { id: `${prefix}${circuits.filter((c) => c.id.startsWith(prefix) && c.id.slice(prefix.length).match(/^\d+$/)).length + 1}`, kind, rating, label, rooms: [], points: 0 };
        circuits.push(cur);
      }
      cur.points += it.pts;
      const nm = roomName(it.room);
      if (!cur.rooms.includes(nm)) cur.rooms.push(nm);
      it.tag(cur.id);
    }
  };
  // lighting: fixtures by room (switches, fans and shavers ride on the room's lighting circuit)
  const lightItems = rooms.map((_, ri) => ({ room: ri, pts: groupList.filter((g) => g.room === ri).reduce((a, g) => a + g.pts.length, 0) })).filter((x) => x.pts > 0);
  const roomLighting = new Map<number, string>();
  assign("L", "lighting", 10, "lighting", lightItems.map((x) => ({ ...x, tag: (id: string) => roomLighting.set(x.room, id) })), 14);
  for (const e of elec) if (["switch", "switch_2way", "dimmer", "fan", "shaver", "doorbell"].includes(e.type)) e.circuit = roomLighting.get(e.room) ?? roomLighting.values().next().value;
  // power: general sockets by room
  const general = elec.filter((e) => ["double_socket", "socket", "usb_socket"].includes(e.type) && e.label !== "worktop");
  const byRoom = new Map<number, ElecPoint[]>();
  for (const e of general) byRoom.set(e.room, [...(byRoom.get(e.room) ?? []), e]);
  assign("P", "power", 20, "sockets", [...byRoom].map(([room, es]) => ({ room, pts: es.length, tag: (id: string) => es.forEach((e) => (e.circuit = id)) })), 8);
  // kitchen worktop + fridge + hood
  const kit = elec.filter((e) => e.label === "worktop" || (e.type === "spur" && (e.label === "fridge" || e.label === "hood")));
  if (kit.length) assign("K", "kitchen", 32, "kitchen worktop", [{ room: kit[0].room, pts: kit.length, tag: (id) => kit.forEach((e) => (e.circuit = id)) }], 99);
  let ci = 0;
  for (const e of elec.filter((x) => x.type === "cooker")) {
    const id = `C${++ci}`;
    circuits.push({ id, kind: "cooker", rating: 32, label: "cooker / hob", rooms: [roomName(e.room)], points: 1 });
    e.circuit = id;
  }
  let ai = 0;
  for (const e of elec.filter((x) => (x.type === "spur" && !x.circuit) || x.type === "ac")) {
    const id = `A${++ai}`;
    const rating = e.type === "ac" ? 20 : e.label === "heater" || e.label === "oven" ? 20 : 16;
    circuits.push({ id, kind: "appliance", rating, label: e.label ?? e.type, rooms: [roomName(e.room)], points: 1 });
    e.circuit = id;
  }
  const det = elec.filter((x) => x.type === "smoke" || x.type === "heat");
  if (det.length) {
    circuits.push({ id: "F1", kind: "detectors", rating: 6, label: "smoke / heat (interlinked)", rooms: [...new Set(det.map((e) => roomName(e.room)))], points: det.length });
    det.forEach((e) => (e.circuit = "F1"));
  }

  const layout: ServicesLayout = { electrical: elec, fixtures, points, pipes, circuits, groups: groupList };
  return { layout, node: set.plates ? platesNode(layout, ctx, lv) : undefined };
}

// ---------------------------------------------------------------------------
// 3D: face plates, detectors, fans, distribution board
// ---------------------------------------------------------------------------

function platesNode(L: ServicesLayout, ctx: ServicesContext, lv: Level): SceneNode | undefined {
  const mb = new MeshBuilder();
  const W = "plastic_white", D = "plastic_black";
  for (const e of L.electrical) {
    const z = ctx.floorZ + e.height;
    if (e.type === "light_point") {
      mb.cylinder(W, [e.at[0], e.at[1], ctx.levelZ + e.height - 0.028], 0.045, 0.05, 0.018, 16);
      continue;
    }
    if (CEILING_POINTS.has(e.type)) {
      const c = ctx.ceilings[e.room];
      let h = c?.height ?? e.height;
      if (c?.soffit && !pointInPolygon(e.at, c.soffit.inner)) h = c.soffit.height;
      const zc = ctx.levelZ + h - 0.012;
      if (e.type === "fan") mb.box(W, [e.at[0] - 0.11, e.at[1] - 0.11, zc - 0.02], [e.at[0] + 0.11, e.at[1] + 0.11, zc], {}), mb.box(D, [e.at[0] - 0.08, e.at[1] - 0.08, zc - 0.021], [e.at[0] + 0.08, e.at[1] + 0.08, zc - 0.02], {});
      else mb.cylinder(W, [e.at[0], e.at[1], zc - 0.035], 0.055, 0.06, 0.035, 20);
      continue;
    }
    if (!e.n) continue;
    const n = e.n, d: Vec2 = [-n[1], n[0]];
    const wains = e.room >= 0 ? lv.rooms[e.room].finishes?.wainscot : undefined;
    const off = wains && e.height < wains.height ? 0.022 : 0.002;
    const o = v2.add(e.at, v2.scale(n, off));
    const frame = m4.fromBasis([d[0], d[1], 0], [n[0], n[1], 0], [0, 0, 1], [o[0], o[1], z]);
    let w = 0.086, h = 0.086, t = 0.009;
    if (e.type === "double_socket" || e.type === "cooker" || (e.gangs ?? 1) >= 3) w = 0.146;
    if (e.type === "db") (w = 0.42), (h = 0.5), (t = 0.11);
    if (e.type === "ac") (w = 0.9), (h = 0.3), (t = 0.22);
    if (e.type === "doorbell") (w = 0.035), (h = 0.09), (t = 0.02);
    mb.with(frame, () => {
      mb.box(W, [-w / 2, 0, -h / 2], [w / 2, t, h / 2], { skip: ["-y"] });
      if (e.type.startsWith("switch") || e.type === "dimmer") {
        const g = e.gangs ?? 1;
        for (let k = 0; k < g; k++) {
          const cx = (k - (g - 1) / 2) * ((w - 0.03) / g);
          mb.box(W, [cx - 0.012, t, -0.025], [cx + 0.012, t + 0.006, 0.025], { skip: ["-y"] });
        }
      } else if (e.type.includes("socket") || e.type === "spur" || e.type === "cooker" || e.type === "shaver") {
        const outlets = e.type === "double_socket" ? [-0.035, 0.035] : [0];
        for (const cx of outlets) mb.box(D, [cx - 0.016, t, -0.012], [cx + 0.016, t + 0.0015, 0.012], { skip: ["-y"] });
      } else if (e.type === "db") {
        mb.box("metal_steel", [-w / 2 + 0.02, t, -h / 2 + 0.02], [w / 2 - 0.02, t + 0.004, h / 2 - 0.02], { skip: ["-y"] });
      } else if (e.type === "ac") {
        mb.box(D, [-w / 2 + 0.04, t * 0.4, -h / 2 - 0.001], [w / 2 - 0.04, t * 0.9, -h / 2 + 0.03], {});
      } else if (e.type === "doorbell") {
        mb.cylinder(D, [0, t, 0], 0.01, 0.01, 0.004, 12);
      } else {
        mb.box(D, [-0.012, t, -0.01], [0.012, t + 0.0015, 0.01], { skip: ["-y"] });
      }
    });
  }
  const meshes = mb.meshes();
  return meshes.length ? { name: "services", kind: "group", meshes, children: [], extras: { electricalPoints: L.electrical.length } } : undefined;
}
