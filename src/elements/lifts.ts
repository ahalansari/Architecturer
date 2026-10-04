/**
 * Lifts (elevators): a real shaft instead of a circulation link. An elevator with `shaft` gets, on every level it
 * serves, a 200 mm reinforced-concrete shaft (walls + a landing door opening on each stop), a hole in the floor
 * slabs above the lowest stop, the car, landing doors and (when the top floor is too low for the lift's overhead)
 * an overrun on the roof. Sizes follow the capacity (persons) and the drive, as Kuwaiti villa lifts are specified:
 * machine-room-less traction (default), hydraulic, or a compact home lift with a shallow pit.
 */
import { pointInPolygon, polygonArea, v2, type Vec2 } from "../geometry/math.js";
import { MeshBuilder } from "../geometry/mesh.js";
import type { SceneNode } from "../geometry/scene.js";
import type { Circuit } from "./services.js";
import type { WallSegment } from "./walls.js";

export const LIFT_DRIVES = ["mrl_traction", "hydraulic", "home_lift"] as const;
export type LiftDrive = (typeof LIFT_DRIVES)[number];

interface LiftSize {
  persons: number;
  kg: number;
  /** Car internal width (door side) × depth, m. */
  car: [number, number];
  /** Shaft internal width × depth, m. */
  shaft: [number, number];
  door: number;
}

/** Typical car / shaft sizes (EN 81-20 / 81-70 practice for MRL traction villa lifts). */
const SIZES: LiftSize[] = [
  { persons: 4, kg: 320, car: [0.9, 1.2], shaft: [1.4, 1.6], door: 0.7 },
  { persons: 5, kg: 400, car: [1.0, 1.25], shaft: [1.5, 1.65], door: 0.8 },
  { persons: 6, kg: 450, car: [1.0, 1.3], shaft: [1.55, 1.75], door: 0.8 },
  { persons: 8, kg: 630, car: [1.1, 1.4], shaft: [1.65, 1.9], door: 0.8 },
  { persons: 13, kg: 1000, car: [1.1, 2.1], shaft: [1.7, 2.55], door: 0.9 },
];
const HOME_LIFT: LiftSize = { persons: 3, kg: 250, car: [0.8, 1.1], shaft: [1.2, 1.45], door: 0.8 };

const DRIVES: Record<LiftDrive, { label: string; pit: number; overhead: number; speed: number; kw: number; phase: 1 | 3; breaker: number }> = {
  mrl_traction: { label: "machine-room-less traction", pit: 1.1, overhead: 3.5, speed: 1.0, kw: 5.5, phase: 3, breaker: 32 },
  hydraulic: { label: "hydraulic (pump unit beside the shaft)", pit: 1.0, overhead: 3.3, speed: 0.5, kw: 9, phase: 3, breaker: 40 },
  home_lift: { label: "compact home lift (screw / hydraulic, shallow pit)", pit: 0.15, overhead: 2.6, speed: 0.15, kw: 2.2, phase: 1, breaker: 16 },
};

/** Shaft wall thickness (RC). */
export const SHAFT_WALL = 0.2;

export function liftSize(capacity: number, drive: LiftDrive): LiftSize {
  if (drive === "home_lift") return HOME_LIFT;
  return SIZES.find((s) => s.persons >= capacity) ?? SIZES[SIZES.length - 1];
}

const dirDeg = (d: unknown): number => (typeof d === "number" ? d : ({ east: 0, north: 90, west: 180, south: 270 } as Record<string, number>)[String(d)] ?? 270);

/** The shaft frame: centre, door-side unit vector f, the other axis s, internal half sizes. */
export function shaftFrame(e: { shaft?: { at: number[]; facing?: unknown }; capacity?: number; drive?: LiftDrive }) {
  const size = liftSize(e.capacity ?? 5, e.drive ?? "mrl_traction");
  const a = (dirDeg(e.shaft!.facing ?? "south") * Math.PI) / 180;
  const f: Vec2 = [Math.cos(a), Math.sin(a)];
  const s: Vec2 = [-f[1], f[0]];
  const c = e.shaft!.at as Vec2;
  const hw = size.shaft[0] / 2, hd = size.shaft[1] / 2;
  const P = (u: number, v: number): Vec2 => v2.add(c, v2.add(v2.scale(s, u), v2.scale(f, v)));
  return { size, c, f, s, hw, hd, P, inner: [P(-hw, -hd), P(hw, -hd), P(hw, hd), P(-hw, hd)] as Vec2[] };
}

type Json = Record<string, any>;

/**
 * Expand elevators with a `shaft` into walls and landing openings on the raw plan (before parsing), and fill in
 * each stop's landing point when it is not given. Returns errors for impossible input.
 */
export function applyLifts(input: unknown): { input: unknown; errors: string[] } {
  const errors: string[] = [];
  if (!input || typeof input !== "object") return { input, errors };
  const raw = input as Json;
  const lifts = (raw.elevators ?? []) as Json[];
  if (!lifts.some((e) => e?.shaft)) return { input, errors };
  const out = structuredClone(raw);
  const levels = (out.levels ?? []) as Json[];
  for (const e of out.elevators as Json[]) {
    if (!e?.shaft) continue;
    const id = e.id ?? "lift";
    const fr = shaftFrame(e as never);
    const t = SHAFT_WALL;
    const idx = ((e.stops ?? []) as Json[]).map((st) => levels.findIndex((l) => l.id === st.level));
    if (idx.some((i) => i < 0)) continue; // the layout check reports unknown levels
    const lo = Math.min(...idx), hi = Math.max(...idx);
    const ring = [fr.P(-fr.hw - t / 2, -fr.hd - t / 2), fr.P(fr.hw + t / 2, -fr.hd - t / 2), fr.P(fr.hw + t / 2, fr.hd + t / 2), fr.P(-fr.hw - t / 2, fr.hd + t / 2)];
    const doorAt = fr.P(0, fr.hd + t / 2);
    for (let li = lo; li <= hi; li++) {
      const lv = levels[li];
      const wallId = `${id}_shaft_${lv.id}`;
      // an open ring that ends where it starts: corners join, but it is not an exterior (closed) loop
      lv.walls = [...(lv.walls ?? []), { id: wallId, points: [...ring, ring[0]].map((p) => [r3(p[0]), r3(p[1])]), thickness: t, construction: "rc_200", material: "plaster_white" }];
      if (idx.includes(li))
        lv.openings = [...(lv.openings ?? []), { id: `${id}_door_${lv.id}`, type: "opening", wall: wallId, at: [r3(doorAt[0]), r3(doorAt[1])], width: r3(fr.size.door + 0.1), height: 2.1 }];
    }
    for (const st of e.stops as Json[]) if (!st.at) st.at = fr.P(0, fr.hd + t + 0.75).map(r3);
  }
  for (const e of out.elevators as Json[]) for (const st of (e?.stops ?? []) as Json[]) if (!st.at) errors.push(`elevator '${e.id}': stop on '${st.level}' needs \`at\` (or give the elevator a \`shaft\`)`);
  return { input: out, errors };
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

export interface LiftDesign {
  id: string;
  persons: number;
  kg: number;
  drive: LiftDrive;
  driveLabel: string;
  car: [number, number];
  shaft: [number, number];
  shaftOuter: [number, number];
  door: number;
  pit: number;
  overhead: number;
  speed: number;
  stops: number;
  /** Level indices from the lowest to the highest stop. */
  levels: number[];
  stopLevels: number[];
  travel: number;
  /** Height of the overrun box above the roof (0 = fits under the roof slab). */
  overrun: number;
  inner: Vec2[];
  outer: Vec2[];
  doorAt: Vec2;
  f: Vec2;
  kw: number;
  phase: 1 | 3;
  breaker: number;
  issues: string[];
}

interface LevelLite {
  elevation: number;
  height: number;
  stairOutlines: Vec2[][];
  segments: WallSegment[];
  openings: { id: string; seg: WallSegment; u: number; width: number }[];
}

/** Spec, checks and power supply for every elevator with a shaft. */
export function designLifts(project: { levels: { id: string; name?: string; rooms: { name: string; polygon: number[][] }[]; furniture: { id?: string; type: string; position: number[] }[] }[]; elevators: Json[]; defaults: { slabThickness: number } }, infos: LevelLite[]): { lifts: LiftDesign[]; circuits: Circuit[] } {
  const lifts: LiftDesign[] = [];
  const circuits: Circuit[] = [];
  for (const e of project.elevators) {
    if (!e.shaft) continue;
    const drive: LiftDrive = e.drive ?? "mrl_traction";
    const fr = shaftFrame(e as never);
    const d = DRIVES[drive];
    const stopLevels = (e.stops as Json[]).map((st) => project.levels.findIndex((l) => l.id === st.level)).filter((i) => i >= 0).sort((a, b) => a - b);
    if (stopLevels.length < 2) continue;
    const lo = stopLevels[0], hi = stopLevels[stopLevels.length - 1];
    const levels = Array.from({ length: hi - lo + 1 }, (_, k) => lo + k);
    const issues: string[] = [];
    const t = SHAFT_WALL;
    const outer = [fr.P(-fr.hw - t, -fr.hd - t), fr.P(fr.hw + t, -fr.hd - t), fr.P(fr.hw + t, fr.hd + t), fr.P(-fr.hw - t, fr.hd + t)];
    const doorAt = fr.P(0, fr.hd + t);
    // headroom above the top landing: the top floor's height less the roof slab
    const avail = infos[hi].height - project.defaults.slabThickness;
    const overrun = avail >= d.overhead ? 0 : Math.round((d.overhead - avail + project.defaults.slabThickness) * 100) / 100;
    const name = (li: number) => project.levels[li].name ?? project.levels[li].id;
    for (const li of stopLevels) {
      const landing = fr.P(0, fr.hd + t + 0.75);
      const lv = project.levels[li];
      const room = lv.rooms.find((r) => pointInPolygon(landing, r.polygon as Vec2[]));
      if (!room) issues.push(`no room in front of the lift doors on ${name(li)}: the landing must be a floor (a hall or lobby)`);
      else if (/terrace|balcony|garden|yard|outdoor|roof/i.test(room.name)) issues.push(`the lift opens onto ${room.name} on ${name(li)}: lift landings should be inside`);
      // clear landing in front of the doors (1.5 × 1.5 m for a wheelchair, 1.2 × 1.2 m otherwise)
      const clear = fr.size.kg >= 630 ? 1.5 : 1.2;
      const box = [fr.P(-clear / 2, fr.hd + t), fr.P(clear / 2, fr.hd + t), fr.P(clear / 2, fr.hd + t + clear), fr.P(-clear / 2, fr.hd + t + clear)];
      for (const f of lv.furniture)
        if (pointInPolygon(f.position as Vec2, box)) issues.push(`${f.type.replace(/_/g, " ")}${f.id ? ` '${f.id}'` : ""} blocks the lift landing on ${name(li)} (keep ${clear} × ${clear} m clear in front of the doors)`);
    }
    for (const li of levels) {
      const info = infos[li];
      if (!info) continue;
      if (info.stairOutlines.some((s) => s.some((p) => pointInPolygon(p, outer)) || outer.some((p) => pointInPolygon(p, s)))) issues.push(`the lift shaft overlaps a stair on ${name(li)}`);
      // furniture standing where the shaft is
      for (const f of project.levels[li].furniture)
        if (pointInPolygon(f.position as Vec2, outer)) issues.push(`${f.type.replace(/_/g, " ")}${f.id ? ` '${f.id}'` : ""} on ${name(li)} stands inside the lift shaft`);
      // doors and windows of other walls the shaft would block
      const grown = [fr.P(-fr.hw - t - 0.35, -fr.hd - t - 0.35), fr.P(fr.hw + t + 0.35, -fr.hd - t - 0.35), fr.P(fr.hw + t + 0.35, fr.hd + t + 0.35), fr.P(-fr.hw - t - 0.35, fr.hd + t + 0.35)];
      for (const o of info.openings) {
        if (o.seg.wallId.startsWith(`${e.id}_shaft_`)) continue;
        const d0 = v2.norm(v2.sub(o.seg.b, o.seg.a));
        const pts = [-0.5, 0, 0.5].map((k) => v2.add(o.seg.a, v2.scale(d0, o.u + k * o.width)));
        if (pts.some((p) => pointInPolygon(p, grown))) issues.push(`the lift shaft blocks opening '${o.id}' on ${name(li)}`);
      }
      // other walls running through the shaft
      for (const s of info.segments) {
        if (s.wallId.startsWith(`${e.id}_shaft_`)) continue;
        if ([0.25, 0.5, 0.75].some((k) => pointInPolygon(v2.lerp(s.a, s.b, k), fr.inner))) {
          issues.push(`wall '${s.wallId}' runs through the lift shaft on ${name(li)}`);
          break;
        }
      }
    }
    if (overrun > 0) issues.push(`the top floor (${name(hi)}) leaves ${avail.toFixed(2)} m above the landing, the ${d.label} needs ${d.overhead} m: a ${overrun} m overrun is built on the roof (or choose drive 'home_lift')`);
    const travel = Math.round((infos[hi].elevation - infos[lo].elevation) * 100) / 100;
    lifts.push({
      id: e.id, persons: fr.size.persons, kg: fr.size.kg, drive, driveLabel: d.label, car: fr.size.car, shaft: fr.size.shaft,
      shaftOuter: [Math.round((fr.size.shaft[0] + 2 * t) * 100) / 100, Math.round((fr.size.shaft[1] + 2 * t) * 100) / 100],
      door: fr.size.door, pit: d.pit, overhead: d.overhead, speed: d.speed, stops: stopLevels.length, levels, stopLevels, travel, overrun,
      inner: fr.inner, outer, doorAt, f: fr.f, kw: d.kw, phase: d.phase, breaker: d.breaker, issues,
    });
    circuits.push({ id: `LIFT-${lifts.length}`, kind: "lift", rating: d.breaker, label: `lift '${e.id}' ${fr.size.persons}-person ${d.label.split(" (")[0]}, ${d.phase}-phase + isolator`, rooms: [], points: 1 });
  }
  return { lifts, circuits };
}

/** One-line spec for notes and reports. */
export function liftSpec(l: LiftDesign): string {
  return `lift '${l.id}': ${l.persons} persons / ${l.kg} kg, ${l.driveLabel}, ${l.stops} stops, ${l.travel} m travel, car ${l.car.join(" × ")} m, shaft ${l.shaft.join(" × ")} m inside (${l.shaftOuter.join(" × ")} m with RC walls), door ${l.door} m, pit ${l.pit} m, overhead ${l.overhead} m${l.overrun ? ` (overrun ${l.overrun} m above the roof)` : ""}, ${l.speed} m/s, ${l.kw} kW ${l.phase}-phase`;
}

/** The car (at the lowest stop), landing doors in every door opening, and the roof overrun. */
export function liftsNode(lifts: LiftDesign[], levels: { elevation: number; height: number }[]): SceneNode | undefined {
  if (!lifts.length) return undefined;
  const mb = new MeshBuilder();
  for (const l of lifts) {
    const z0 = levels[l.levels[0]].elevation;
    const s: Vec2 = [-l.f[1], l.f[0]];
    const c: Vec2 = [(l.inner[0][0] + l.inner[2][0]) / 2, (l.inner[0][1] + l.inner[2][1]) / 2];
    const at = (u: number, v: number): Vec2 => v2.add(c, v2.add(v2.scale(s, u), v2.scale(l.f, v)));
    // car: walls and roof as a box shifted to the door side
    const cw = l.car[0] / 2, cd = l.car[1] / 2;
    const off = l.shaft[1] / 2 - cd - 0.05;
    const carPts = [at(-cw, off - cd), at(cw, off - cd), at(cw, off + cd), at(-cw, off + cd)];
    const xs = carPts.map((p) => p[0]), ys = carPts.map((p) => p[1]);
    mb.box("metal_steel", [Math.min(...xs), Math.min(...ys), z0 + 0.02], [Math.max(...xs), Math.max(...ys), z0 + 2.35]);
    // landing doors (closed), on the shaft side of each opening
    for (const li of l.stopLevels) {
      const z = levels[li].elevation;
      const p0 = at(-l.door / 2, l.shaft[1] / 2 + 0.03), p1 = at(l.door / 2, l.shaft[1] / 2 + 0.07);
      mb.box("metal_steel", [Math.min(p0[0], p1[0]), Math.min(p0[1], p1[1]), z], [Math.max(p0[0], p1[0]), Math.max(p0[1], p1[1]), z + 2.1]);
    }
    if (l.overrun > 0) {
      const top = levels[l.levels[l.levels.length - 1]];
      const zr = top.elevation + top.height;
      const ox = l.outer.map((p) => p[0]), oy = l.outer.map((p) => p[1]);
      mb.box("plaster_white", [Math.min(...ox), Math.min(...oy), zr], [Math.max(...ox), Math.max(...oy), zr + l.overrun]);
    }
  }
  return { name: "lifts", kind: "group", meshes: mb.meshes(), children: [], extras: { lifts: lifts.map((l) => l.id) } };
}

export const shaftArea = (l: LiftDesign) => Math.abs(polygonArea(l.outer));
