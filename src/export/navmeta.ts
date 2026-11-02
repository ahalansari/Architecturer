/**
 * Navigation metadata of a compiled plan, shared by the game export (Unity NavMesh areas, lift links) and the
 * server's navigation check: what kind of floor each room is, where the stairs run, where the lifts stop.
 */
import { pointInPolygon, polygonCentroid, v2, type Vec2 } from "../geometry/math.js";
import { KIND_RE } from "../elements/services.js";
import type { Compiled } from "../pipeline.js";

export type NavAreaKind = "indoor" | "outdoor" | "wet" | "stairs" | "service";
/** NavMesh area indices the Unity package uses (the top of Unity's 32, clear of user areas). */
export const NAV_AREA_INDEX: Record<NavAreaKind, number> = { indoor: 27, outdoor: 28, wet: 29, stairs: 30, service: 31 };
/** Default traversal costs: agents keep to circulation, avoid service rooms and prefer not to cut through wet rooms. */
export const NAV_AREA_COST: Record<NavAreaKind, number> = { indoor: 1, outdoor: 1.2, wet: 2, stairs: 1.5, service: 3 };

export interface NavArea {
  level: number;
  kind: NavAreaKind;
  name: string;
  poly: Vec2[];
  /** Floor and the height the volume reaches (stairs: to the floor they arrive at). */
  z: number;
  height: number;
  /** Axis-aligned rectangles covering the outline (x0, y0, x1, y1). */
  rects: [number, number, number, number][];
}
export interface NavLanding {
  lift: string;
  stop: number;
  level: number;
  /** Where a person waits in front of the landing door. */
  at: Vec2;
  z: number;
}

const SERVICE = /plant|pump|store|storage|service|utility|maid|driver|garage|boiler|mech/i;

export function roomNavKind(name: string): NavAreaKind {
  const kinds = new Set(KIND_RE.filter(([, re]) => re.test(name)).map(([k]) => k));
  if (kinds.has("outdoor")) return "outdoor";
  if (kinds.has("bath") || kinds.has("laundry")) return "wet";
  if (SERVICE.test(name) || kinds.has("garage") || kinds.has("closet")) return "service";
  return "indoor";
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Cover a polygon with axis-aligned rectangles: exact for rectilinear outlines (a grid on its own coordinates),
 * else 0.25 m cells. Cells in a row merge into runs, identical runs in consecutive rows into one rectangle.
 */
export function coverRects(poly: Vec2[], cell = 0.25): [number, number, number, number][] {
  const rect = poly.every((p, i) => {
    const q = poly[(i + 1) % poly.length];
    return Math.abs(p[0] - q[0]) < 1e-6 || Math.abs(p[1] - q[1]) < 1e-6;
  });
  let xs: number[], ys: number[];
  if (rect) {
    xs = [...new Set(poly.map((p) => r3(p[0])))].sort((a, b) => a - b);
    ys = [...new Set(poly.map((p) => r3(p[1])))].sort((a, b) => a - b);
  } else {
    const x0 = Math.min(...poly.map((p) => p[0])), x1 = Math.max(...poly.map((p) => p[0]));
    const y0 = Math.min(...poly.map((p) => p[1])), y1 = Math.max(...poly.map((p) => p[1]));
    const nx = Math.max(1, Math.ceil((x1 - x0) / cell)), ny = Math.max(1, Math.ceil((y1 - y0) / cell));
    xs = [...Array(nx + 1).keys()].map((i) => r3(x0 + ((x1 - x0) * i) / nx));
    ys = [...Array(ny + 1).keys()].map((i) => r3(y0 + ((y1 - y0) * i) / ny));
  }
  // rows of runs
  const rows: [number, number][][] = [];
  for (let j = 0; j + 1 < ys.length; j++) {
    const runs: [number, number][] = [];
    const cy = (ys[j] + ys[j + 1]) / 2;
    let start = -1;
    for (let i = 0; i + 1 <= xs.length; i++) {
      const inside = i + 1 < xs.length && pointInPolygon([(xs[i] + xs[i + 1]) / 2, cy], poly);
      if (inside && start < 0) start = i;
      if (!inside && start >= 0) {
        runs.push([start, i]);
        start = -1;
      }
    }
    rows.push(runs);
  }
  const out: [number, number, number, number][] = [];
  const open = new Map<string, number>(); // run key → index in out
  for (let j = 0; j < rows.length; j++) {
    const next = new Map<string, number>();
    for (const [a, b] of rows[j]) {
      const key = `${a}:${b}`;
      const k = open.get(key);
      if (k !== undefined) {
        out[k][3] = ys[j + 1];
        next.set(key, k);
      } else {
        out.push([xs[a], ys[j], xs[b], ys[j + 1]]);
        next.set(key, out.length - 1);
      }
    }
    open.clear();
    for (const [k, v] of next) open.set(k, v);
  }
  return out;
}

/** Areas (rooms, terraces, gardens, stairs) and lift landings of every level. */
export function navMetadata(c: Compiled): { areas: NavArea[]; landings: NavLanding[] } {
  const areas: NavArea[] = [];
  const landings: NavLanding[] = [];
  const project = c.project;
  if (!project) return { areas, landings };
  c.levels.forEach((info, li) => {
    const lv = project.levels[li];
    const ceiling = info.height;
    for (const r of lv.rooms) {
      const poly = r.polygon as Vec2[];
      areas.push({ level: li, kind: roomNavKind(r.name), name: r.name, poly, z: info.elevation, height: ceiling, rects: coverRects(poly) });
    }
    for (const t of lv.terraces) {
      const poly = t.polygon as Vec2[];
      areas.push({ level: li, kind: "outdoor", name: t.name, poly, z: info.elevation + (t.offset ?? 0), height: ceiling, rects: coverRects(poly) });
    }
    for (const g of lv.gardens) {
      const poly = g.polygon as Vec2[];
      areas.push({ level: li, kind: "outdoor", name: g.id ?? `${g.surface} area`, poly, z: info.elevation, height: ceiling, rects: coverRects(poly) });
    }
    for (const s of info.stairs) {
      const top = c.levels[s.target]?.elevation ?? s.topZ;
      for (const solid of s.solids) areas.push({ level: li, kind: "stairs", name: s.id, poly: solid, z: info.elevation, height: Math.max(0.5, top - info.elevation + 2), rects: coverRects(solid, 0.2) });
    }
  });
  for (const l of c.lifts ?? [])
    l.stopLevels.forEach((li, k) => {
      const at = v2.add(l.doorAt, v2.scale(l.f, 0.75));
      landings.push({ lift: l.id, stop: k, level: li, at, z: c.levels[li].elevation });
    });
  return { areas, landings };
}

/** The area a plan point falls in on a level (rooms before terraces before stairs). */
export function areaAt(areas: NavArea[], level: number, p: Vec2): NavArea | undefined {
  return areas.find((a) => a.level === level && a.kind !== "stairs" && pointInPolygon(p, a.poly)) ?? areas.find((a) => a.level === level && pointInPolygon(p, a.poly));
}
export const areaCentre = (a: NavArea): Vec2 => polygonCentroid(a.poly);
