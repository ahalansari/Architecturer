/**
 * Gardens: landscape areas and their irrigation, as a Kuwaiti landscaping contractor sets them out.
 *
 *  - Areas (level.gardens): natural lawn, artificial turf, planting beds, gravel, mulch, paving, sand; trees, palms,
 *    shrubs and hedges are furniture (tree with kind palm / deciduous / conifer, bush, hedge, planter).
 *  - Irrigation, automatic: pop-up spray heads on lawns (head-to-head, quarter / half / full arcs at corners, edges
 *    and inside), drip lines on planting beds, drip along hedges and at shrubs and planters, bubblers at trees (two
 *    per palm). Zones by type, capped by flow; a valve box and controller by the house (next to the main water
 *    inlet when there is one); the mainline from the valves to each zone; summer daily water demand and run times.
 */
import { z } from "zod";
import { ensureCCW, pointInPolygon, pointSegment, polygonArea, polygonCentroid, v2, type Vec2 } from "../geometry/math.js";
import { MeshBuilder } from "../geometry/mesh.js";
import type { SceneNode } from "../geometry/scene.js";
import { Id, Mat, Point, Polygon } from "../schema/common.js";
import type { WallSegment } from "./walls.js";

export const GARDEN_SURFACES = ["lawn", "turf", "planting", "gravel", "mulch", "paving", "sand"] as const;
export type GardenSurface = (typeof GARDEN_SURFACES)[number];

export const GardenSchema = z
  .object({
    id: Id.optional(),
    polygon: Polygon,
    surface: z
      .enum(GARDEN_SURFACES)
      .default("lawn")
      .describe("lawn (natural grass, pop-up sprinklers) | turf (artificial grass, no irrigation) | planting (shrubs / ground cover on drip) | gravel | mulch | paving | sand"),
    material: Mat.optional().describe("Override the surface's material"),
    irrigation: z.boolean().default(true).describe("Irrigate this area (lawn: sprinklers; planting: drip)"),
  })
  .describe("A landscape area: drawn on the ground (or a roof garden) and irrigated automatically");
export type Garden = z.output<typeof GardenSchema>;

export const LandscapeSchema = z
  .object({
    irrigation: z.boolean().default(true).describe("Design the irrigation (sprinklers, drip, bubblers, zones, controller)"),
    controller: z.object({ level: Id.optional(), at: Point }).optional().describe("Where the controller and valve box go (default: by the house, next to the main water inlet)"),
    sprinklerSpacing: z.number().min(2).max(8).default(3.5).describe("Lawn spray heads, head-to-head spacing (m)"),
    dripSpacing: z.number().min(0.2).max(1).default(0.4).describe("Drip line spacing on planting beds (m)"),
    lawnLitresPerDay: z.number().positive().default(8).describe("Summer water for lawn, L per m² per day"),
    bedLitresPerDay: z.number().positive().default(4).describe("Summer water for planting beds, L per m² per day"),
  })
  .prefault({})
  .describe("Garden irrigation settings");
export type LandscapeSpec = z.output<typeof LandscapeSchema>;

export const SURFACE_MATERIAL: Record<GardenSurface, string> = {
  lawn: "grass", turf: "grass_artificial", planting: "dirt", gravel: "gravel", mulch: "mulch", paving: "paving_stone", sand: "sand",
};
const SURFACE_LIFT: Record<GardenSurface, number> = { lawn: 0.02, turf: 0.025, planting: 0.03, gravel: 0.03, mulch: 0.035, paving: 0.05, sand: 0.02 };

// ---------------------------------------------------------------------------
// 3D
// ---------------------------------------------------------------------------

/** Garden surfaces of one level (slightly above the level / ground). */
export function buildGardens(gardens: Garden[], z: number): SceneNode | undefined {
  if (!gardens.length) return undefined;
  const mb = new MeshBuilder();
  for (const g of gardens) {
    const poly = ensureCCW(g.polygon as Vec2[]);
    const top = z + SURFACE_LIFT[g.surface];
    mb.flat(g.material ?? SURFACE_MATERIAL[g.surface], poly, top);
    // edges: a thin kerb so beds and gravel read as raised areas
    if (g.surface === "planting" || g.surface === "gravel" || g.surface === "mulch") mb.prism("concrete", poly.map((p) => p), z, top + 0.01, { caps: false });
  }
  return { name: "gardens", kind: "group", meshes: mb.meshes(), children: [], extras: { gardens: gardens.length } };
}

// ---------------------------------------------------------------------------
// Irrigation
// ---------------------------------------------------------------------------

export type ZoneKind = "spray" | "drip" | "bubbler";

export interface SprayHead {
  at: Vec2;
  radius: number;
  /** 90 / 180 / 360 */
  arc: number;
  /** L/min */
  flow: number;
  zone: string;
}

export interface IrrigationZone {
  id: string;
  kind: ZoneKind;
  level: number;
  /** Heads, emitters or bubblers. */
  count: number;
  /** L/min */
  flow: number;
  /** Summer run time per day, minutes. */
  runMin: number;
  /** L/day in summer. */
  litresPerDay: number;
  what: string;
}

export interface LevelIrrigation {
  heads: SprayHead[];
  drip: { pts: Vec2[]; zone: string }[];
  bubblers: { at: Vec2; n: number; zone: string }[];
  emitters: { at: Vec2; n: number; zone: string }[];
  /** Zone laterals and the mainline from the valve box. */
  pipes: { pts: Vec2[]; kind: "main" | "lateral"; zone?: string }[];
  valves: { at: Vec2; zone: string }[];
  controller?: Vec2;
}

export interface LandscapeDesign {
  areas: Record<GardenSurface, number>;
  plants: { trees: number; palms: number; shrubs: number; hedgeM: number; planters: number };
  zones: IrrigationZone[];
  levels: LevelIrrigation[];
  demand: { litresPerDay: number; m3PerMonth: number; peakFlow: number };
  issues: string[];
  assumptions: string[];
}

interface LevelIn {
  id: string;
  name?: string;
  gardens: Garden[];
  rooms: { name: string; polygon: number[][] }[];
  furniture: { id?: string; type: string; position: number[]; width?: number; depth?: number; rotation?: number; facing?: unknown; options?: Record<string, unknown> }[];
}

const SPRAY_ZONE_MAX = 40; // L/min
const DRIP_ZONE_MAX = 20; // L/min (1.2 m³/h)
const BUBBLER_ZONE_MAX = 30;
const EMITTER_LPH = 2;
const EMITTER_SPACING = 0.3;
const SPRAY_RATE_MMH = 40; // precipitation rate of spray heads

const ARC_FLOW: Record<number, number> = { 90: 2.5, 180: 5, 360: 10 };

function nearEdge(p: Vec2, poly: Vec2[]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) best = Math.min(best, pointSegment(p, poly[i], poly[(i + 1) % poly.length]).dist);
  return best;
}

/** Lawn spray heads: along the edges every ≤ spacing (corners quarter, edges half), full circles inside. */
function sprayHeads(poly: Vec2[], S: number): Omit<SprayHead, "zone">[] {
  const P = ensureCCW(poly);
  const out: Omit<SprayHead, "zone">[] = [];
  const add = (at: Vec2, arc: number) => {
    if (out.some((h) => v2.dist(h.at, at) < S * 0.45)) return;
    out.push({ at, radius: S, arc, flow: ARC_FLOW[arc] });
  };
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length], prev = P[(i - 1 + P.length) % P.length];
    const convex = v2.cross(v2.sub(a, prev), v2.sub(b, a)) > 0;
    add(a, convex ? 90 : 360);
    const len = v2.dist(a, b);
    const n = Math.ceil(len / S);
    for (let k = 1; k < n; k++) add(v2.lerp(a, b, k / n), 180);
  }
  const xs = P.map((p) => p[0]), ys = P.map((p) => p[1]);
  for (let x = Math.min(...xs) + S; x < Math.max(...xs) - S * 0.4; x += S)
    for (let y = Math.min(...ys) + S; y < Math.max(...ys) - S * 0.4; y += S) {
      const q: Vec2 = [x, y];
      if (pointInPolygon(q, P) && nearEdge(q, P) > S * 0.45) add(q, 360);
    }
  return out;
}

/** Drip lines across a bed: parallel to its longer side, `gap` apart, clipped to the polygon. */
function dripLines(poly: Vec2[], gap: number): Vec2[][] {
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  const alongX = Math.max(...xs) - Math.min(...xs) >= Math.max(...ys) - Math.min(...ys);
  const lines: Vec2[][] = [];
  const lo = alongX ? Math.min(...ys) : Math.min(...xs), hi = alongX ? Math.max(...ys) : Math.max(...xs);
  for (let t = lo + gap / 2; t < hi; t += gap) {
    // intersections of the scan line with the polygon edges
    const hits: number[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const [ac, bc] = alongX ? [a[1], b[1]] : [a[0], b[0]];
      if ((ac <= t && bc > t) || (bc <= t && ac > t)) {
        const k = (t - ac) / (bc - ac);
        hits.push(alongX ? a[0] + k * (b[0] - a[0]) : a[1] + k * (b[1] - a[1]));
      }
    }
    hits.sort((p, q) => p - q);
    for (let i = 0; i + 1 < hits.length; i += 2) {
      const s0 = hits[i] + 0.1, s1 = hits[i + 1] - 0.1;
      if (s1 - s0 < 0.3) continue;
      lines.push(alongX ? [[s0, t], [s1, t]] : [[t, s0], [t, s1]]);
    }
  }
  return lines;
}

const plen = (pts: Vec2[]) => pts.slice(1).reduce((a, p, i) => a + v2.dist(pts[i], p), 0);

/** Manhattan minimum spanning tree from a root through points: the zone's lateral pipes. */
function laterals(root: Vec2, pts: Vec2[], route: (a: Vec2, b: Vec2) => Vec2[]): Vec2[][] {
  const nodes = [root, ...pts];
  const inTree = nodes.map((_, i) => i === 0);
  const best = nodes.map((p) => Math.abs(p[0] - root[0]) + Math.abs(p[1] - root[1]));
  const parent = nodes.map(() => 0);
  const out: Vec2[][] = [];
  for (let k = 1; k < nodes.length; k++) {
    let u = -1;
    for (let i = 0; i < nodes.length; i++) if (!inTree[i] && (u < 0 || best[i] < best[u])) u = i;
    inTree[u] = true;
    const a = nodes[parent[u]], b = nodes[u];
    out.push(v2.dist(a, b) < 0.01 ? [a, b] : route(a, b));
    for (let i = 0; i < nodes.length; i++) {
      if (inTree[i]) continue;
      const d = Math.abs(nodes[i][0] - b[0]) + Math.abs(nodes[i][1] - b[1]);
      if (d < best[i]) {
        best[i] = d;
        parent[i] = u;
      }
    }
  }
  return out;
}

/**
 * Buried pipes go round the building, not under it: a 4-way grid search (0.25 m) with a turn penalty, where
 * indoor rooms grown by the wall thickness are blocked. Paths that do not touch the building stay L-shaped.
 */
class PipeRouter {
  private readonly res = 0.25;
  private readonly x0: number;
  private readonly y0: number;
  private readonly nx: number;
  private readonly ny: number;
  private readonly blocked: Uint8Array;
  constructor(private readonly rooms: Vec2[][], pts: Vec2[]) {
    const all = [...pts, ...rooms.flat()];
    const xs = all.map((p) => p[0]), ys = all.map((p) => p[1]);
    this.x0 = Math.min(...xs) - 2;
    this.y0 = Math.min(...ys) - 2;
    this.nx = Math.ceil((Math.max(...xs) + 2 - this.x0) / this.res) + 1;
    this.ny = Math.ceil((Math.max(...ys) + 2 - this.y0) / this.res) + 1;
    this.blocked = new Uint8Array(this.nx * this.ny);
    for (let j = 0; j < this.ny; j++) for (let i = 0; i < this.nx; i++) this.blocked[j * this.nx + i] = this.inside(this.at(i, j)) ? 1 : 0;
  }
  private at(i: number, j: number): Vec2 {
    return [this.x0 + i * this.res, this.y0 + j * this.res];
  }
  private inside(p: Vec2, grow = 0.35): boolean {
    return this.rooms.some((r) => pointInPolygon(p, r) || r.some((a, k) => pointSegment(p, a, r[(k + 1) % r.length]).dist < grow));
  }
  private cell(p: Vec2): [number, number] {
    return [Math.min(this.nx - 1, Math.max(0, Math.round((p[0] - this.x0) / this.res))), Math.min(this.ny - 1, Math.max(0, Math.round((p[1] - this.y0) / this.res)))];
  }
  private clear(a: Vec2, b: Vec2): boolean {
    const n = Math.ceil(v2.dist(a, b) / 0.1);
    for (let k = 0; k <= n; k++) if (this.inside(v2.lerp(a, b, k / Math.max(1, n)), 0.3)) return false;
    return true;
  }
  route(a: Vec2, b: Vec2): Vec2[] {
    if (!this.rooms.length) return dedupe([a, [b[0], a[1]], b]);
    for (const c of [[b[0], a[1]], [a[0], b[1]]] as Vec2[]) if (this.clear(a, c) && this.clear(c, b)) return dedupe([a, c, b]);
    const [si, sj] = this.cell(a), [gi, gj] = this.cell(b);
    const N = this.nx * this.ny, D = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const cost = new Float64Array(N * 4).fill(Infinity), prev = new Int32Array(N * 4).fill(-1);
    const heap: [number, number][] = [];
    const push = (f: number, s: number) => {
      heap.push([f, s]);
      let k = heap.length - 1;
      while (k > 0) {
        const p = (k - 1) >> 1;
        if (heap[p][0] <= heap[k][0]) break;
        [heap[p], heap[k]] = [heap[k], heap[p]];
        k = p;
      }
    };
    const pop = () => {
      const top = heap[0], last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        let k = 0;
        for (;;) {
          const l = 2 * k + 1, r = l + 1;
          let m = k;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === k) break;
          [heap[m], heap[k]] = [heap[k], heap[m]];
          k = m;
        }
      }
      return top;
    };
    const h = (i: number, j: number) => Math.abs(i - gi) + Math.abs(j - gj);
    for (let d = 0; d < 4; d++) {
      cost[(sj * this.nx + si) * 4 + d] = 0;
      push(h(si, sj), (sj * this.nx + si) * 4 + d);
    }
    let goal = -1;
    while (heap.length) {
      const [f, s] = pop();
      const c = s >> 2, d = s & 3, i = c % this.nx, j = (c / this.nx) | 0;
      if (f - h(i, j) > cost[s] + 1e-9) continue;
      if (i === gi && j === gj) {
        goal = s;
        break;
      }
      for (let e = 0; e < 4; e++) {
        const ni = i + D[e][0], nj = j + D[e][1];
        if (ni < 0 || nj < 0 || ni >= this.nx || nj >= this.ny) continue;
        const nc = nj * this.nx + ni;
        if (this.blocked[nc] && !(ni === gi && nj === gj)) continue;
        const ns = nc * 4 + e, g = cost[s] + 1 + (e === d ? 0 : 3);
        if (g < cost[ns]) {
          cost[ns] = g;
          prev[ns] = s;
          push(g + h(ni, nj), ns);
        }
      }
    }
    if (goal < 0) return dedupe([a, [b[0], a[1]], b]);
    const cells: Vec2[] = [];
    for (let s = goal; s >= 0; s = prev[s]) cells.push(this.at((s >> 2) % this.nx, ((s >> 2) / this.nx) | 0));
    cells.reverse();
    // exact ends, then keep the corners only
    const raw = [a, ...cells.slice(1, -1), b];
    const out: Vec2[] = [raw[0]];
    for (let k = 1; k < raw.length - 1; k++) {
      const p = out[out.length - 1], q = raw[k], r = raw[k + 1];
      const straight = (Math.abs(p[0] - q[0]) < 1e-6 && Math.abs(q[0] - r[0]) < 1e-6) || (Math.abs(p[1] - q[1]) < 1e-6 && Math.abs(q[1] - r[1]) < 1e-6);
      if (!straight) out.push(q);
    }
    out.push(b);
    // the first and last legs may be diagonal (exact points off the grid): square them up
    const sq: Vec2[] = [out[0]];
    for (let k = 1; k < out.length; k++) {
      const p = sq[sq.length - 1], q = out[k];
      if (Math.abs(p[0] - q[0]) > 1e-6 && Math.abs(p[1] - q[1]) > 1e-6) sq.push(k === 1 ? [q[0], p[1]] : [p[0], q[1]]);
      sq.push(q);
    }
    return dedupe(sq);
  }
}

function dedupe(pts: Vec2[]): Vec2[] {
  return pts.filter((p, k) => k === 0 || v2.dist(p, pts[k - 1]) > 1e-6);
}

export function designLandscape(
  project: { levels: LevelIn[]; landscape: LandscapeSpec },
  infos: { segments: WallSegment[]; services: { points: { type: string; at: Vec2 }[] } }[],
): LandscapeDesign {
  const spec = project.landscape;
  const areas = Object.fromEntries(GARDEN_SURFACES.map((s) => [s, 0])) as Record<GardenSurface, number>;
  const plants = { trees: 0, palms: 0, shrubs: 0, hedgeM: 0, planters: 0 };
  const zones: IrrigationZone[] = [];
  const issues: string[] = [];
  const levels: LevelIrrigation[] = project.levels.map(() => ({ heads: [], drip: [], bubblers: [], emitters: [], pipes: [], valves: [] }));
  const assumptions = [
    `Summer water: lawn ${spec.lawnLitresPerDay} L/m²·day, planting beds ${spec.bedLitresPerDay} L/m²·day, trees 60 L/day, palms 150 L/day, shrubs 10 L/day, hedges 8 L/m·day, planters 5 L/day.`,
    `Lawn spray heads ${spec.sprinklerSpacing} m head-to-head (${SPRAY_RATE_MMH} mm/h); drip lines ${spec.dripSpacing} m apart with ${EMITTER_LPH} L/h emitters every ${EMITTER_SPACING} m; bubblers 3 L/min (two per palm).`,
    `Zones capped at ${SPRAY_ZONE_MAX} L/min (spray), ${DRIP_ZONE_MAX} L/min (drip), ${BUBBLER_ZONE_MAX} L/min (bubblers); run in the early morning, lawns in two cycles.`,
  ];
  let zoneNo = 0;
  const nextZone = () => `Z${++zoneNo}`;

  project.levels.forEach((lv, li) => {
    const L = levels[li];
    const indoor = (p: Vec2) => lv.rooms.some((r) => pointInPolygon(p, r.polygon as Vec2[]) && !/terrace|balcony|garden|yard|patio|roof|deck|court/i.test(r.name));
    for (const g of lv.gardens) {
      const a = Math.abs(polygonArea(g.polygon as Vec2[]));
      areas[g.surface] += a;
      if (indoor(polygonCentroid(g.polygon as Vec2[]))) issues.push(`garden${g.id ? ` '${g.id}'` : ""} (${g.surface}) on ${lv.name ?? lv.id} lies inside a room`);
    }
    // plants outside (or in a garden): trees, palms, shrubs, hedges, planters
    const outside = lv.furniture.filter((f) => ["tree", "bush", "hedge", "planter", "agave", "grass_clump"].includes(f.type) && !indoor(f.position as Vec2));
    for (const f of outside) {
      if (f.type === "tree") String(f.options?.kind ?? "deciduous") === "palm" ? plants.palms++ : plants.trees++;
      else if (f.type === "bush" || f.type === "agave" || f.type === "grass_clump") plants.shrubs++;
      else if (f.type === "hedge") plants.hedgeM += f.width ?? 2;
      else plants.planters++;
    }
    if (!spec.irrigation) return;

    // ---- lawns: spray zones ----
    const heads: Omit<SprayHead, "zone">[] = [];
    for (const g of lv.gardens.filter((g) => g.surface === "lawn" && g.irrigation)) heads.push(...sprayHeads(g.polygon as Vec2[], spec.sprinklerSpacing));
    const lawnArea = lv.gardens.filter((g) => g.surface === "lawn" && g.irrigation).reduce((a, g) => a + Math.abs(polygonArea(g.polygon as Vec2[])), 0);
    heads.sort((p, q) => p.at[0] - q.at[0] || p.at[1] - q.at[1]);
    let cur: Omit<SprayHead, "zone">[] = [];
    const flushSpray = () => {
      if (!cur.length) return;
      const id = nextZone();
      const flow = cur.reduce((a, h) => a + h.flow, 0);
      const share = (flow / Math.max(1, heads.reduce((a, h) => a + h.flow, 0))) * lawnArea;
      const litres = share * spec.lawnLitresPerDay;
      L.heads.push(...cur.map((h) => ({ ...h, zone: id })));
      zones.push({ id, kind: "spray", level: li, count: cur.length, flow, runMin: Math.round((spec.lawnLitresPerDay / SPRAY_RATE_MMH) * 60), litresPerDay: Math.round(litres), what: `lawn sprinklers, ${Math.round(share)} m²` });
      cur = [];
    };
    for (const h of heads) {
      if (cur.reduce((a, x) => a + x.flow, 0) + h.flow > SPRAY_ZONE_MAX) flushSpray();
      cur.push(h);
    }
    flushSpray();

    // ---- planting beds, hedges, shrubs, planters: drip zones ----
    type DripItem = { lines: Vec2[][]; points: { at: Vec2; n: number }[]; lph: number; litres: number; what: string };
    const drips: DripItem[] = [];
    for (const g of lv.gardens.filter((g) => g.surface === "planting" && g.irrigation)) {
      const lines = dripLines(g.polygon as Vec2[], spec.dripSpacing);
      const len = lines.reduce((a, l) => a + plen(l), 0);
      const area = Math.abs(polygonArea(g.polygon as Vec2[]));
      drips.push({ lines, points: [], lph: (len / EMITTER_SPACING) * EMITTER_LPH, litres: area * spec.bedLitresPerDay, what: `planting bed ${Math.round(area)} m²` });
    }
    for (const f of outside) {
      const at = f.position as Vec2;
      if (f.type === "hedge") {
        const w = f.width ?? 2;
        const rot = (((f.rotation as number | undefined) ?? 0) * Math.PI) / 180;
        const d: Vec2 = [Math.cos(rot), Math.sin(rot)];
        const line = [v2.add(at, v2.scale(d, -w / 2)), v2.add(at, v2.scale(d, w / 2))];
        drips.push({ lines: [line], points: [], lph: (w / EMITTER_SPACING) * EMITTER_LPH, litres: w * 8, what: `hedge ${w} m` });
      } else if (f.type === "bush" || f.type === "grass_clump" || f.type === "agave") drips.push({ lines: [], points: [{ at, n: 2 }], lph: 2 * EMITTER_LPH * 2, litres: 10, what: "shrub" });
      else if (f.type === "planter") drips.push({ lines: [], points: [{ at, n: 2 }], lph: 2 * EMITTER_LPH, litres: 5, what: "planter" });
    }
    let dcur: DripItem[] = [];
    const flushDrip = () => {
      if (!dcur.length) return;
      const id = nextZone();
      const lph = dcur.reduce((a, d) => a + d.lph, 0);
      const litres = dcur.reduce((a, d) => a + d.litres, 0);
      for (const d of dcur) {
        L.drip.push(...d.lines.map((pts) => ({ pts, zone: id })));
        L.emitters.push(...d.points.map((p) => ({ ...p, zone: id })));
      }
      const count = Math.round(dcur.reduce((a, d) => a + d.lines.reduce((x, l) => x + plen(l) / EMITTER_SPACING, 0) + d.points.reduce((x, p) => x + p.n, 0), 0));
      const kinds = [...new Set(dcur.map((d) => d.what.split(" ")[0]))];
      zones.push({ id, kind: "drip", level: li, count, flow: Math.round((lph / 60) * 10) / 10, runMin: Math.max(5, Math.round((litres / Math.max(1, lph)) * 60)), litresPerDay: Math.round(litres), what: `drip: ${kinds.join(", ")}` });
      dcur = [];
    };
    for (const d of drips) {
      if ((dcur.reduce((a, x) => a + x.lph, 0) + d.lph) / 60 > DRIP_ZONE_MAX) flushDrip();
      dcur.push(d);
    }
    flushDrip();

    // ---- trees and palms: bubbler zones ----
    const trees = outside.filter((f) => f.type === "tree");
    let bcur: typeof trees = [];
    const flushTrees = () => {
      if (!bcur.length) return;
      const id = nextZone();
      const n = bcur.reduce((a, f) => a + (String(f.options?.kind) === "palm" ? 2 : 1), 0);
      const litres = bcur.reduce((a, f) => a + (String(f.options?.kind) === "palm" ? 150 : 60), 0);
      L.bubblers.push(...bcur.map((f) => ({ at: f.position as Vec2, n: String(f.options?.kind) === "palm" ? 2 : 1, zone: id })));
      zones.push({ id, kind: "bubbler", level: li, count: n, flow: n * 3, runMin: Math.round(litres / (n * 3)), litresPerDay: litres, what: `bubblers: ${bcur.length} tree(s) / palm(s)` });
      bcur = [];
    };
    for (const f of trees) {
      if ((bcur.reduce((a, x) => a + (String(x.options?.kind) === "palm" ? 2 : 1), 0) + 2) * 3 > BUBBLER_ZONE_MAX) flushTrees();
      bcur.push(f);
    }
    flushTrees();
  });

  // ---- controller, valve box and pipes ----
  const levelZones = (li: number) => zones.filter((z) => z.level === li);
  const used = project.levels.map((_, li) => li).filter((li) => levelZones(li).length);
  if (used.length) {
    const cl = spec.controller?.level ? project.levels.findIndex((l) => l.id === spec.controller!.level) : used[0];
    let ctrl = spec.controller?.at as Vec2 | undefined;
    const indoorRooms = (li: number) =>
      project.levels[li].rooms.filter((r) => !/terrace|balcony|garden|yard|patio|roof|deck|court/i.test(r.name)).map((r) => r.polygon as Vec2[]);
    const isIndoor = (li: number, p: Vec2) => indoorRooms(li).some((r) => pointInPolygon(p, r));
    let outward: Vec2 = [0, -1];
    if (!ctrl) {
      // beside the main water inlet if there is one, else on the outside face of the exterior wall closest to
      // the gardens; the valve box goes in the ground a metre out from the wall
      const inlet = infos[cl]?.services.points.find((p) => p.type === "inlet")?.at;
      const all = levelZones(cl).length ? [...levels[cl].heads.map((h) => h.at), ...levels[cl].drip.flatMap((d) => d.pts), ...levels[cl].bubblers.map((b) => b.at), ...levels[cl].emitters.map((e) => e.at)] : [];
      const centre: Vec2 = all.length ? [all.reduce((a, p) => a + p[0], 0) / all.length, all.reduce((a, p) => a + p[1], 0) / all.length] : [0, 0];
      const from = inlet ?? centre;
      let best: Vec2 | undefined, bd = Infinity;
      for (const s of infos[cl]?.segments.filter((s) => s.exterior) ?? []) {
        const r = pointSegment(from, s.a, s.b);
        const p = v2.lerp(s.a, s.b, Math.min(0.9, Math.max(0.1, r.t)));
        const dir = v2.norm(v2.sub(s.b, s.a));
        // the side away from the rooms
        const n: Vec2 = [-dir[1], dir[0]];
        const side = isIndoor(cl, v2.add(p, v2.scale(n, s.thickness / 2 + 0.3))) ? v2.scale(n, -1) : n;
        if (isIndoor(cl, v2.add(p, v2.scale(side, s.thickness / 2 + 0.3)))) continue;
        if (r.dist < bd) {
          bd = r.dist;
          best = v2.add(p, v2.scale(side, s.thickness / 2 + 0.15));
          outward = side;
        }
      }
      ctrl = best ?? centre;
    }
    const L0 = levels[cl];
    L0.controller = ctrl;
    for (const li of used) {
      const L = levels[li];
      const box: Vec2 = li === cl ? v2.add(ctrl, v2.scale(outward, 0.9)) : (L.heads[0]?.at ?? L.drip[0]?.pts[0] ?? L.bubblers[0]?.at ?? L.emitters[0]?.at)!;
      const zonePts = levelZones(li).flatMap((z) => [...L.heads.filter((h) => h.zone === z.id).map((h) => h.at), ...L.bubblers.filter((b) => b.zone === z.id).map((b) => b.at)]);
      const router = new PipeRouter(indoorRooms(li), [box, ...zonePts, ...L.drip.flatMap((d) => d.pts), ...L.emitters.map((e) => e.at)]);
      const route = (a: Vec2, b: Vec2) => router.route(a, b);
      if (li !== cl) issues.push(`irrigation on ${project.levels[li].name ?? project.levels[li].id} is fed by a riser from the valve box on ${project.levels[cl].name ?? project.levels[cl].id}`);
      for (const z of levelZones(li)) {
        const along: Vec2 = [-outward[1], outward[0]];
        const k = L.valves.length;
        L.valves.push({ at: v2.add(v2.add(box, v2.scale(along, ((k % 4) - 1.5) * 0.25)), v2.scale(outward, Math.floor(k / 4) * 0.25)), zone: z.id });
        const pts = [...L.heads.filter((h) => h.zone === z.id).map((h) => h.at), ...L.bubblers.filter((b) => b.zone === z.id).map((b) => b.at), ...L.emitters.filter((e) => e.zone === z.id).map((e) => e.at), ...L.drip.filter((d) => d.zone === z.id).map((d) => d.pts[0])];
        if (!pts.length) continue;
        const first = pts.reduce((a, p) => (v2.dist(p, box) < v2.dist(a, box) ? p : a), pts[0]);
        L.pipes.push({ pts: route(box, first), kind: "main", zone: z.id });
        for (const seg of laterals(first, pts.filter((p) => p !== first), route)) L.pipes.push({ pts: seg, kind: "lateral", zone: z.id });
      }
    }
  }
  const litresPerDay = zones.reduce((a, z) => a + z.litresPerDay, 0);
  return {
    areas: Object.fromEntries(Object.entries(areas).map(([k, v]) => [k, Math.round(v * 10) / 10])) as Record<GardenSurface, number>,
    plants: { ...plants, hedgeM: Math.round(plants.hedgeM * 10) / 10 },
    zones,
    levels,
    demand: { litresPerDay: Math.round(litresPerDay), m3PerMonth: Math.round((litresPerDay * 30) / 100) / 10, peakFlow: Math.max(0, ...zones.map((z) => z.flow)) },
    issues,
    assumptions,
  };
}

export function landscapeReport(d: LandscapeDesign, levelNames: string[]): string {
  const area = Object.entries(d.areas).filter(([, v]) => v > 0);
  const out: string[] = [];
  out.push(area.length ? `Garden areas: ${area.map(([k, v]) => `${k} ${v} m²`).join(", ")}.` : "No garden areas (level.gardens).");
  const p = d.plants;
  out.push(`Plants: ${p.trees} tree(s), ${p.palms} palm(s), ${p.shrubs} shrub(s), ${p.hedgeM} m of hedge, ${p.planters} planter(s).`);
  if (d.zones.length) {
    out.push("", "Irrigation zones:");
    for (const z of d.zones) out.push(`  ${z.id} (${levelNames[z.level]}): ${z.what} — ${z.count} ${z.kind === "spray" ? "heads" : z.kind === "drip" ? "emitters" : "bubblers"}, ${z.flow} L/min, ${z.runMin} min/day in summer, ${z.litresPerDay} L/day`);
    out.push(`Water: about ${d.demand.litresPerDay} L/day in summer (${d.demand.m3PerMonth} m³/month); largest zone ${d.demand.peakFlow} L/min — size the pump / supply for it, zones run one at a time.`);
  } else out.push("No irrigation (nothing to water, or landscape.irrigation is false).");
  if (d.issues.length) out.push("", "Notes:", ...d.issues.map((i) => `  - ${i}`));
  out.push("", "Assumptions:", ...d.assumptions.map((a) => `  - ${a}`));
  return out.join("\n");
}
