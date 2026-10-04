/**
 * Air conditioning: cooling loads per room and a ducted layout, the way a Kuwaiti MEP designer sets out a villa.
 *
 *  - Loads: a simplified peak-hour method (equivalent temperature differences for walls and roofs, solar cooling
 *    load per orientation for glass, people, lighting from the lighting design, appliances, fresh air and
 *    infiltration) at Kuwait design conditions (48 °C outside, 24 °C inside by default). Wall U-values come from
 *    the construction system (insulated block, hollow block, RC...). Good for sizing and costing; the stamped
 *    MEW submission still needs an MEP engineer's calculation.
 *  - System: rooftop packaged units by default (one per floor, split when a floor needs more than maxUnitTR), with
 *    supply and return ducts in the false ceilings dropping through a shaft; or ducted splits (indoor unit in a
 *    ceiling, outdoor unit on the roof), or wall splits per room.
 *  - Layout: supply diffusers and a return grille per room, a supply and a return duct tree from the shaft sized
 *    by airflow, a thermostat per zone, and the roof units; then coordination checks (duct depth against the
 *    ceiling void, exposed ducts, roof space) and a power supply per unit for the electrical schedule.
 */
import { z } from "zod";
import { ensureCCW, m4, pointInPolygon, pointSegment, polygonArea, polygonCentroid, v2, type Vec2 } from "../geometry/math.js";
import { MeshBuilder } from "../geometry/mesh.js";
import type { SceneNode } from "../geometry/scene.js";
import { Id, Point } from "../schema/common.js";
import { WALL_ASSEMBLIES } from "./construction.js";
import type { CeilingLayout } from "./finishes.js";
import type { PlacedOpening } from "./openings.js";
import { KIND_RE, type Circuit, type RoomKind, type ServicesLayout } from "./services.js";
import type { WallSegment } from "./walls.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const HVAC_SYSTEMS = ["packaged", "ducted_split", "split", "none"] as const;
export type HvacSystem = (typeof HVAC_SYSTEMS)[number];

export const HvacSchema = z
  .object({
    system: z
      .enum(HVAC_SYSTEMS)
      .default("packaged")
      .describe("packaged: rooftop packaged units, ducted (Kuwait villa default) | ducted_split: concealed indoor units + roof condensers | split: wall splits per room | none"),
    outdoorTemp: z.number().default(48).describe("Design outdoor dry bulb, °C (Kuwait ~46–50)"),
    indoorTemp: z.number().default(24).describe("Design indoor temperature, °C"),
    glazing: z
      .object({
        u: z.number().positive().default(2.8).describe("Window U-value, W/m²K (double glazing ~2.8)"),
        shgc: z.number().min(0).max(1).default(0.4).describe("Solar heat gain coefficient (tinted / low-e ~0.25–0.4)"),
      })
      .prefault({}),
    roofU: z.number().positive().optional().describe("Roof U-value, W/m²K (default from the construction system: insulated RC roof 0.4)"),
    safetyFactor: z.number().min(0).max(50).default(10).describe("% added to every room load"),
    diversity: z.number().min(50).max(100).default(90).describe("% of the sum of room peaks used to size a unit (rooms peak at different hours)"),
    maxUnitTR: z.number().positive().optional().describe("Largest unit per zone (default: packaged 25 TR, ducted split 5 TR)"),
    zones: z
      .array(
        z.object({
          id: Id.optional(),
          rooms: z.array(z.string()).min(1).describe("Room ids or names (on one level)"),
          shaft: Point.optional().describe("Where the ducts drop from the roof unit (default: a hall or store near the rooms)"),
        }),
      )
      .default([])
      .describe("Manual zoning; rooms left out are zoned per floor"),
    omitRooms: z.array(z.string()).default([]).describe("Rooms (ids or names) not air-conditioned"),
  })
  .prefault({})
  .describe("Air conditioning: cooling loads, units and the ducted layout (render_plan sheet 'hvac', hvac_design)");
export type HvacSpec = z.output<typeof HvacSchema>;

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type Orientation = "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";

export interface RoomLoad {
  level: number;
  room: number;
  name: string;
  kind: RoomKind;
  area: number;
  conditioned: boolean;
  /** Why a room is not conditioned. */
  reason?: string;
  exposures: { orientation: Orientation; wall: number; glass: number }[];
  roof: number;
  /** Sensible gains by source, W. */
  parts: Record<"walls" | "glassConduction" | "glassSolar" | "roof" | "people" | "lighting" | "equipment" | "freshAir" | "infiltration", number>;
  sensible: number;
  latent: number;
  /** Total with the safety factor, W. */
  total: number;
  tr: number;
  /** Supply air, L/s. */
  supply: number;
  /** Outdoor air, L/s. */
  freshAir: number;
  zone?: string;
}

export interface HvacUnit {
  id: string;
  kind: "packaged" | "ducted_split" | "split";
  zone: string;
  level: number;
  rooms: { level: number; room: number }[];
  /** Block load with diversity, TR. */
  load: number;
  /** Selected nominal capacity, TR. */
  size: number;
  /** Supply air, L/s. */
  airflow: number;
  freshAir: number;
  /** Electrical input, kW, and the protective device. */
  kw: number;
  phase: 1 | 3;
  breaker: number;
  /** Plan position (packaged / condensers: on the roof; ducted split indoor unit: in the ceiling; split: on the wall). */
  at: Vec2;
  footprint?: Vec2[];
  /** Level where the unit physically sits (roof units: the top level). */
  onLevel: number;
  onRoof: boolean;
}

export interface Terminal {
  id: string;
  kind: "supply" | "return";
  room: number;
  at: Vec2;
  /** L/s */
  airflow: number;
  unit: string;
}

export interface Duct {
  kind: "supply" | "return";
  unit: string;
  pts: Vec2[];
  /** L/s carried */
  airflow: number;
  /** Width × height, m. */
  w: number;
  h: number;
  /** Tree links within the unit's supply / return tree on this level: node 0 is the riser; the terminal it ends at. */
  node?: number;
  parent?: number;
  term?: string;
}

export interface LevelHvac {
  terminals: Terminal[];
  ducts: Duct[];
  /** Shafts on this level (the unit's riser), plan position and unit. */
  shafts: { at: Vec2; unit: string; size: number }[];
  thermostats: { at: Vec2; unit: string; room: number }[];
  /** Wall split indoor units on this level. */
  splits: { at: Vec2; dir: Vec2; unit: string; room: number; tr: number }[];
}

export interface HvacDesign {
  system: HvacSystem;
  rooms: RoomLoad[];
  units: HvacUnit[];
  levels: LevelHvac[];
  /** Power supplies for the electrical schedule (one per unit / condenser). */
  circuits: Circuit[];
  issues: string[];
  totals: { tr: number; kw: number; area: number; m2PerTR: number; wPerM2: number };
  assumptions: string[];
  /** Air side: duct pressure drops, fan static, noise, air changes (designAirside). */
  air?: import("./airside.js").AirsideDesign;
}

/** What the HVAC design needs from each built level. */
export interface HvacLevelInput {
  name: string;
  height: number;
  /** Stair footprints starting on this level (no diffusers or risers there; the stairwell above is open too). */
  stairOutlines: Vec2[][];
  segments: WallSegment[];
  openings: PlacedOpening[];
  ceilings: CeilingLayout[];
  services: ServicesLayout;
}

interface RoomIn {
  id?: string;
  name: string;
  polygon: number[][];
  ceilingHeight?: number;
}
interface LevelIn {
  id: string;
  rooms: RoomIn[];
  openings: { id?: string; treatment?: unknown }[];
}

// ---------------------------------------------------------------------------
// Constants (Kuwait practice; see the module comment)
// ---------------------------------------------------------------------------

const ORIENTS: Orientation[] = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
/** Extra equivalent temperature difference on walls from the sun, K (light-coloured heavy walls, afternoon peak). */
const WALL_SOLAR: Record<Orientation, number> = { N: 2, NE: 5, E: 9, SE: 8, S: 7, SW: 11, W: 14, NW: 8 };
/** Roof sol-air excess over the air temperature, K. */
const ROOF_SOLAR = 22;
/** Solar cooling load through glass at SHGC 1, W/m² (latitude 29° N, summer, with storage). */
const GLASS_SOLAR: Record<Orientation, number> = { N: 110, NE: 300, E: 430, SE: 330, S: 210, SW: 430, W: 560, NW: 370 };
/** Wall U-values, W/m²K (core + 15 mm plaster both faces + surface films). */
const WALL_U: Record<string, number> = {
  block_100: 2.9, block_150: 2.6, block_200: 2.4, block_insulated_200: 0.65, rc_200: 3.0, rc_250: 2.8, drywall: 1.9, glass: 5.7, timber_stud: 0.4,
};
const DOOR_U = 2.5;
const PEOPLE_SENSIBLE = 75, PEOPLE_LATENT = 55;
/** Coincident humid design: outdoor minus indoor humidity ratio, kg/kg (coastal Kuwait in August). */
const DW = 0.006;
const SUPPLY_DT = 11; // 24 °C room, 13 °C supply
const PACKAGED_SIZES = [5, 7.5, 10, 12.5, 15, 17.5, 20, 25, 30, 40];
const DUCTED_SPLIT_SIZES = [1.5, 2, 2.5, 3, 4, 5];
const SPLIT_SIZES = [1, 1.5, 2, 2.5, 3];
const TR_W = 3517;
const KW_PER_TR = 1.4; // hot-climate packaged / split input incl. fans
const BREAKERS = [10, 16, 20, 25, 32, 40, 50, 63, 80, 100, 125];
const DIFFUSER_MAX = 130; // L/s per 600 × 600 diffuser

const r2 = (x: number) => Math.round(x * 100) / 100;

function kindOf(name: string): RoomKind {
  for (const [k, re] of KIND_RE) if (re.test(name)) return k;
  return "other";
}

function orientationOf(n: Vec2): Orientation {
  // bearing clockwise from north
  const bearing = (90 - (Math.atan2(n[1], n[0]) * 180) / Math.PI + 360) % 360;
  return ORIENTS[Math.round(bearing / 45) % 8];
}

const segDir = (s: WallSegment): Vec2 => v2.norm(v2.sub(s.b, s.a));
const segLen = (s: WallSegment) => v2.dist(s.a, s.b);
const sizeUp = (sizes: number[], x: number) => sizes.find((s) => s >= x - 1e-6) ?? Math.ceil(x / sizes[sizes.length - 1]) * sizes[sizes.length - 1];

// ---------------------------------------------------------------------------
// Loads
// ---------------------------------------------------------------------------

interface Exposure {
  orientation: Orientation;
  length: number;
  wallU: number;
  /** Glazed openings (area, shading factor) and opaque doors (area). */
  glass: { area: number; shade: number }[];
  doors: number;
}

/** Exterior walls a room touches, with their orientation and openings. */
function exposuresOf(poly: Vec2[], info: HvacLevelInput, treatments: Map<string, boolean>, defaultExtU: number): Exposure[] {
  const out: Exposure[] = [];
  const P = ensureCCW(poly);
  const ext = info.segments.filter((s) => s.exterior);
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length];
    const len = v2.dist(a, b);
    if (len < 0.3) continue;
    const d = v2.norm(v2.sub(b, a));
    const outward: Vec2 = [d[1], -d[0]];
    const mid = v2.lerp(a, b, 0.5);
    for (const s of ext) {
      const sd = segDir(s);
      if (Math.abs(v2.cross(d, sd)) > 0.08) continue;
      const off = Math.abs(v2.cross(sd, v2.sub(mid, s.a)));
      if (off > s.thickness / 2 + 0.3) continue;
      const L = segLen(s);
      const ta = v2.dot(v2.sub(a, s.a), sd), tb = v2.dot(v2.sub(b, s.a), sd);
      const t0 = Math.max(0, Math.min(ta, tb)), t1 = Math.min(L, Math.max(ta, tb));
      if (t1 - t0 < 0.2) continue;
      const e: Exposure = { orientation: orientationOf(outward), length: t1 - t0, wallU: (s.construction && WALL_U[s.construction]) ?? defaultExtU, glass: [], doors: 0 };
      for (const o of info.openings) {
        if (o.seg !== s || o.u < t0 - 0.05 || o.u > t1 + 0.05) continue;
        const area = o.width * o.height;
        const glazed = o.op.type === "window" || /sliding|glass|french|patio/.test(o.style);
        if (glazed) e.glass.push({ area, shade: treatments.get(o.id) ? 0.75 : 1 });
        else if (o.op.type === "door") e.doors += area;
        else e.glass.push({ area, shade: 1 }); // open archway to outside: treat as glazing-equivalent gain
      }
      out.push(e);
    }
  }
  return out;
}

function internalLoads(kind: RoomKind, name: string, area: number) {
  const majlis = /majlis|diwaniya|reception|guest hall/i.test(name);
  const people =
    kind === "bedroom" ? 2 : kind === "living" ? Math.max(3, Math.round(area / (majlis ? 2.5 : 6))) : kind === "kitchen" ? 2 : kind === "study" ? 1 : kind === "laundry" ? 1 : kind === "hall" || kind === "closet" ? 0 : Math.max(1, Math.round(area / 10));
  const equip =
    kind === "kitchen" ? { s: 1200, l: 500 } : kind === "living" ? { s: 250, l: 0 } : kind === "bedroom" ? { s: 150, l: 0 } : kind === "study" ? { s: 300, l: 0 } : kind === "laundry" ? { s: 500, l: 200 } : { s: 4 * area, l: 0 };
  return { people, equip };
}

// ---------------------------------------------------------------------------
// Design
// ---------------------------------------------------------------------------

export function designHvac(
  project: { name: string; levels: LevelIn[]; hvac: HvacSpec; construction: { system: string; exteriorWall?: string } },
  infos: HvacLevelInput[],
  exteriorWall: string,
): HvacDesign {
  const spec = project.hvac;
  const system = spec.system;
  const dT = spec.outdoorTemp - spec.indoorTemp;
  const issues: string[] = [];
  const assumptions = [
    `Design ${spec.outdoorTemp} °C outside / ${spec.indoorTemp} °C inside; humid design Δw ${DW} kg/kg; supply air ${spec.indoorTemp - SUPPLY_DT} °C.`,
    `Exterior walls U ${WALL_U[exteriorWall] ?? 0.65} W/m²K (${exteriorWall.replace(/_/g, " ")}), glass U ${spec.glazing.u} / SHGC ${spec.glazing.shgc}, roof U ${spec.roofU ?? 0.4}.`,
    `People ${PEOPLE_SENSIBLE} W sensible + ${PEOPLE_LATENT} W latent each; lighting from the lighting design at 100 lm/W (else 5 W/m²); fresh air 0.15 L/s·m² + 2.5 L/s per person; infiltration 0.2 ACH.`,
    `Room loads +${spec.safetyFactor}% safety; units sized on ${spec.diversity}% of the sum of room peaks.`,
  ];
  const omit = new Set(spec.omitRooms.map((s) => s.toLowerCase()));
  const defaultExtU = WALL_U[exteriorWall] ?? 0.65;
  const roofU = spec.roofU ?? 0.4;
  const sf = 1 + spec.safetyFactor / 100;

  // ---- room loads ----
  const rooms: RoomLoad[] = [];
  project.levels.forEach((lv, li) => {
    const info = infos[li];
    if (!info) return;
    const treatments = new Map<string, boolean>();
    lv.openings.forEach((o, i) => treatments.set(o.id ?? `window${i}`, !!o.treatment));
    for (const o of info.openings) if (o.op.treatment) treatments.set(o.id, true);
    const above = project.levels[li + 1];
    lv.rooms.forEach((r, ri) => {
      const poly = r.polygon as Vec2[];
      const area = Math.abs(polygonArea(poly));
      const kind = kindOf(r.name);
      const base: RoomLoad = {
        level: li, room: ri, name: r.name, kind, area: r2(area), conditioned: true, exposures: [], roof: 0,
        parts: { walls: 0, glassConduction: 0, glassSolar: 0, roof: 0, people: 0, lighting: 0, equipment: 0, freshAir: 0, infiltration: 0 },
        sensible: 0, latent: 0, total: 0, tr: 0, supply: 0, freshAir: 0,
      };
      const skip = (reason: string) => rooms.push({ ...base, conditioned: false, reason });
      if (omit.has(r.name.toLowerCase()) || (r.id && omit.has(r.id.toLowerCase()))) return skip("omitted");
      if (system === "none") return skip("no air conditioning (hvac.system none)");
      if (kind === "outdoor") return skip("outdoor");
      if (kind === "garage") return skip("garage");
      if (kind === "bath") return skip("bathroom: extract fan, transfer air");
      if (kind === "closet" && area < 4) return skip("small store / closet");
      const ceil = info.ceilings[ri];
      const ch = ceil && ceil.type !== "none" ? ceil.height : r.ceilingHeight ?? info.height - 0.3;
      const wallH = info.height;
      const exps = exposuresOf(poly, info, treatments, defaultExtU);
      const parts = base.parts;
      for (const e of exps) {
        const glass = e.glass.reduce((a, g) => a + g.area, 0);
        const wall = Math.max(0, e.length * wallH - glass - e.doors);
        parts.walls += e.wallU * wall * (dT + WALL_SOLAR[e.orientation]) + DOOR_U * e.doors * dT;
        parts.glassConduction += spec.glazing.u * glass * dT;
        parts.glassSolar += e.glass.reduce((a, g) => a + spec.glazing.shgc * GLASS_SOLAR[e.orientation] * g.area * g.shade, 0);
        const prev = base.exposures.find((x) => x.orientation === e.orientation);
        if (prev) {
          prev.wall = r2(prev.wall + wall);
          prev.glass = r2(prev.glass + glass);
        } else base.exposures.push({ orientation: e.orientation, wall: r2(wall), glass: r2(glass) });
      }
      // roof (or an outdoor terrace) above the room
      const c = polygonCentroid(poly);
      const covered = above?.rooms.some((x) => kindOf(x.name) !== "outdoor" && pointInPolygon(c, x.polygon as Vec2[]));
      if (!covered) {
        base.roof = r2(area);
        parts.roof = roofU * area * (dT + ROOF_SOLAR);
      }
      const { people, equip } = internalLoads(kind, r.name, area);
      parts.people = people * PEOPLE_SENSIBLE;
      const lumens = info.services.groups.filter((g) => g.room === ri).reduce((a, g) => a + g.lumens, 0);
      parts.lighting = lumens > 0 ? lumens / 100 : 5 * area;
      parts.equipment = equip.s;
      const fresh = 0.15 * area + 2.5 * people;
      const infil = (0.2 * area * ch) / 3.6; // L/s
      parts.freshAir = 1.23 * fresh * dT;
      parts.infiltration = 1.23 * infil * dT;
      const sensible = Object.values(parts).reduce((a, v) => a + v, 0);
      const latent = people * PEOPLE_LATENT + equip.l + 3010 * (fresh + infil) * DW;
      const total = (sensible + latent) * sf;
      for (const k of Object.keys(parts) as (keyof typeof parts)[]) parts[k] = Math.round(parts[k]);
      rooms.push({
        ...base,
        sensible: Math.round(sensible * sf),
        latent: Math.round(latent * sf),
        total: Math.round(total),
        tr: r2(total / TR_W),
        supply: Math.round((sensible * sf) / (1.23 * SUPPLY_DT)),
        freshAir: Math.round(fresh),
      });
    });
  });

  // ---- zones (a zone = one unit; its rooms may be on several floors, fed through one riser) ----
  const cond = rooms.filter((r) => r.conditioned);
  const maxTR = spec.maxUnitTR ?? (system === "ducted_split" ? 5 : 25);
  const minTR = system === "ducted_split" ? DUCTED_SPLIT_SIZES[0] : PACKAGED_SIZES[0];
  const zones: { id: string; rooms: RoomLoad[]; shaft?: Vec2; manual: boolean }[] = [];
  const claimed = new Set<RoomLoad>();
  const zoneLoad = (rs: RoomLoad[]) => (spec.diversity / 100) * rs.reduce((a, r) => a + r.tr, 0);
  const find = (ref: string) => cond.find((r) => r.name.toLowerCase() === ref.toLowerCase() || project.levels[r.level].rooms[r.room].id?.toLowerCase() === ref.toLowerCase());
  if (system === "packaged" || system === "ducted_split") {
    spec.zones.forEach((z, i) => {
      const rs = z.rooms
        .map((ref) => {
          const r = find(ref);
          if (!r) issues.push(`hvac zone ${z.id ?? i + 1}: room '${ref}' not found or not air-conditioned`);
          return r;
        })
        .filter((r): r is RoomLoad => !!r && !claimed.has(r));
      if (!rs.length) return;
      rs.forEach((r) => claimed.add(r));
      zones.push({ id: z.id ?? `Z${zones.length + 1}`, rooms: rs, shaft: z.shaft as Vec2 | undefined, manual: true });
    });
    const auto: { level: number; rooms: RoomLoad[] }[] = [];
    project.levels.forEach((_, li) => {
      const rs = cond.filter((r) => r.level === li && !claimed.has(r));
      if (!rs.length) return;
      const n = Math.max(1, Math.ceil(zoneLoad(rs) / maxTR));
      // a big floor: n zones along its longer direction, by load
      const cs = rs.map((r) => polygonCentroid(project.levels[li].rooms[r.room].polygon as Vec2[]));
      const xs = cs.map((p) => p[0]), ys = cs.map((p) => p[1]);
      const alongX = Math.max(...xs) - Math.min(...xs) >= Math.max(...ys) - Math.min(...ys);
      const order = rs.map((r, i) => ({ r, k: alongX ? cs[i][0] : cs[i][1] })).sort((a, b) => a.k - b.k).map((x) => x.r);
      const per = order.reduce((a, r) => a + r.tr, 0) / n;
      let cur: RoomLoad[] = [];
      let acc = 0, made = 0;
      for (const r of order) {
        if (cur.length && acc + r.tr / 2 > per && made < n - 1) {
          auto.push({ level: li, rooms: cur });
          made++;
          cur = [];
          acc = 0;
        }
        cur.push(r);
        acc += r.tr;
      }
      if (cur.length) auto.push({ level: li, rooms: cur });
    });
    // floors too small for the smallest unit share one with the floor next to them (one riser)
    for (let i = 0; i + 1 < auto.length; ) {
      const a = auto[i], b = auto[i + 1];
      if ((zoneLoad(a.rooms) < minTR || zoneLoad(b.rooms) < minTR) && Math.abs(a.level - b.level) === 1 && zoneLoad([...a.rooms, ...b.rooms]) <= maxTR) {
        auto.splice(i, 2, { level: Math.min(a.level, b.level), rooms: [...a.rooms, ...b.rooms] });
      } else i++;
    }
    for (const z of auto) zones.push({ id: `Z${zones.length + 1}`, rooms: z.rooms, manual: false });
  }

  // ---- units and layout ----
  const top = project.levels.length - 1;
  const levels: LevelHvac[] = project.levels.map(() => ({ terminals: [], ducts: [], shafts: [], thermostats: [], splits: [] }));
  const units: HvacUnit[] = [];
  const circuits: Circuit[] = [];
  const roomPoly = (l: number, i: number) => project.levels[l].rooms[i].polygon as Vec2[];
  const roomAt = (l: number, p: Vec2) => project.levels[l]?.rooms.findIndex((r) => pointInPolygon(p, r.polygon as Vec2[])) ?? -1;
  /** Stairs on a level and the stairwells of stairs arriving from the level below: nothing hangs there. */
  const noGo = (l: number): Vec2[][] => [...(infos[l]?.stairOutlines ?? []), ...(l > 0 ? infos[l - 1]?.stairOutlines ?? [] : [])];
  const blocked = (l: number, p: Vec2, margin = 0.3) => noGo(l).some((g) => pointInPolygon(p, g) || nearEdge(p, g) < margin);
  /** The nearest clear point in a room to `want` (0.25 m grid), or `want` itself. */
  const clearPoint = (l: number, poly: Vec2[], want: Vec2, margin = 0.3): Vec2 => {
    if (pointInPolygon(want, poly) && !blocked(l, want, margin) && nearEdge(want, poly) > 0.3) return want;
    const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
    let best: Vec2 = want, bd = Infinity;
    for (let x = Math.min(...xs) + 0.125; x < Math.max(...xs); x += 0.25)
      for (let y = Math.min(...ys) + 0.125; y < Math.max(...ys); y += 0.25) {
        const q: Vec2 = [x, y];
        if (!pointInPolygon(q, poly) || blocked(l, q, margin) || nearEdge(q, poly) < 0.3) continue;
        const d = v2.dist(q, want);
        if (d < bd) {
          bd = d;
          best = q;
        }
      }
    return best;
  };
  const electrics = (tr: number) => {
    const kw = r2(tr * KW_PER_TR);
    const phase: 1 | 3 = tr > 3 ? 3 : 1;
    const amps = phase === 3 ? (kw * 1000) / (Math.sqrt(3) * 415 * 0.85) : (kw * 1000) / (240 * 0.95);
    return { kw, phase, breaker: BREAKERS.find((b) => b >= amps * 1.25) ?? 160 };
  };
  /** Rooms whose ceiling void is too shallow for ducts (or that have no false ceiling), per unit. */
  const tight = new Map<string, Map<string, number>>();
  const bare = new Map<string, Set<string>>();

  if (system === "split") {
    cond.forEach((r) => {
      const poly = roomPoly(r.level, r.room);
      const n = Math.max(1, Math.ceil(r.tr / 3));
      const each = sizeUp(SPLIT_SIZES, r.tr / n);
      // on the longest wall, centred
      const P = ensureCCW(poly);
      let best = 0;
      for (let i = 1; i < P.length; i++) if (v2.dist(P[i], P[(i + 1) % P.length]) > v2.dist(P[best], P[(best + 1) % P.length])) best = i;
      const a = P[best], b = P[(best + 1) % P.length];
      const d = v2.norm(v2.sub(b, a));
      const inward: Vec2 = [-d[1], d[0]];
      for (let k = 0; k < n; k++) {
        const at = v2.add(v2.lerp(a, b, (k + 0.5) / n), v2.scale(inward, 0.15));
        const id = `AC-${units.length + 1}`;
        const el = electrics(each);
        units.push({ id, kind: "split", zone: r.name, level: r.level, rooms: [{ level: r.level, room: r.room }], load: r2(r.tr / n), size: each, airflow: Math.round(r.supply / n), freshAir: 0, ...el, at, onLevel: r.level, onRoof: false });
        levels[r.level].splits.push({ at, dir: inward, unit: id, room: r.room, tr: each });
        circuits.push({ id, kind: "hvac", rating: el.breaker, label: `split AC ${each} TR, ${r.name}`, rooms: [r.name], points: 1 });
      }
      r.zone = r.name;
    });
    if (cond.length) assumptions.push("Wall splits: outdoor condensers on the roof; refrigerant pipes and condensate drains run in wall chases to each unit.");
  } else if (system !== "none") {
    zones.forEach((z, zi) => {
      const id = system === "packaged" ? `PU-${zi + 1}` : `FCU-${zi + 1}`;
      z.rooms.forEach((r) => (r.zone = id));
      const load = r2(zoneLoad(z.rooms));
      const size = sizeUp(system === "packaged" ? PACKAGED_SIZES : DUCTED_SPLIT_SIZES, load);
      const airflow = z.rooms.reduce((a, r) => a + r.supply, 0);
      const fresh = z.rooms.reduce((a, r) => a + r.freshAir, 0);
      const zLevels = [...new Set(z.rooms.map((r) => r.level))].sort((a, b) => a - b);
      const low = zLevels[0];

      // ---- riser / indoor unit position: a hall or store that lines up on every floor it passes ----
      const zoneCentre = polygonCentroid(z.rooms.map((r) => polygonCentroid(roomPoly(r.level, r.room))).concat(z.rooms.length < 3 ? [polygonCentroid(roomPoly(z.rooms[0].level, z.rooms[0].room)), polygonCentroid(roomPoly(z.rooms[0].level, z.rooms[0].room))] : []));
      let shaft = z.shaft;
      if (!shaft) {
        const service = (k: RoomKind) => k === "hall" || k === "closet" || k === "laundry";
        const cands = zLevels.flatMap((l) =>
          project.levels[l].rooms
            .filter((r) => service(kindOf(r.name)) || (kindOf(r.name) === "other" && Math.abs(polygonArea(r.polygon as Vec2[])) < 15))
            .flatMap((r) => {
              const poly = r.polygon as Vec2[];
              const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
              const out: Vec2[] = [];
              for (let x = Math.min(...xs) + 0.25; x < Math.max(...xs); x += 0.5)
                for (let y = Math.min(...ys) + 0.25; y < Math.max(...ys); y += 0.5) {
                  const q: Vec2 = [x, y];
                  if (pointInPolygon(q, poly) && nearEdge(q, poly) > 0.3 && nearEdge(q, poly) < 0.9 && !zLevels.some((zl) => blocked(zl, q, 0.4))) out.push(q);
                }
              return out;
            }),
        );
        const score = (p: Vec2) => {
          let s = v2.dist(p, zoneCentre);
          for (let l = low; l <= top; l++) if (blocked(l, p, 0.4)) s += 20;
          for (let l = low; l <= (system === "packaged" ? top : zLevels[zLevels.length - 1]); l++) {
            const ri = roomAt(l, p);
            if (ri < 0) {
              if (l <= zLevels[zLevels.length - 1]) s += 3;
              continue;
            }
            if (!service(kindOf(project.levels[l].rooms[ri].name))) s += 6; // the riser would cut through a habitable room
          }
          return s;
        };
        shaft = cands.length ? cands.sort((a, b) => score(a) - score(b))[0] : zoneCentre;
        if (!cands.length) issues.push(`${id}: no hall or store for the duct riser; it is placed among the rooms (set hvac.zones[].shaft)`);
      }
      const shaftSize = Math.max(0.5, r2(Math.sqrt((airflow * 2) / 1000 / 5) + 0.2));
      if (system === "packaged") for (let l = low; l <= top; l++) levels[l].shafts.push({ at: shaft, unit: id, size: shaftSize });
      else for (const l of zLevels) levels[l].shafts.push({ at: shaft, unit: id, size: 0.3 });

      const mainRoom = [...z.rooms].sort((a, b) => (b.kind === "living" ? 1000 : b.kind === "bedroom" ? 500 : 0) + b.area - ((a.kind === "living" ? 1000 : a.kind === "bedroom" ? 500 : 0) + a.area))[0];
      for (const li of zLevels) {
        const info = infos[li];
        const L = levels[li];
        const here = z.rooms.filter((r) => r.level === li);
        // ---- terminals ----
        const supplies: Terminal[] = [];
        const returns: Terminal[] = [];
        for (const r of here) {
          const poly = roomPoly(li, r.room);
          const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
          const c = polygonCentroid(poly);
          const alongX = Math.max(...xs) - Math.min(...xs) >= Math.max(...ys) - Math.min(...ys);
          const lo = alongX ? Math.min(...xs) : Math.min(...ys), hi = alongX ? Math.max(...xs) : Math.max(...ys);
          const n = Math.max(1, Math.ceil(r.supply / DIFFUSER_MAX));
          const lights = info.services.groups.filter((g) => g.room === r.room).flatMap((g) => g.pts);
          for (let k = 0; k < n; k++) {
            const t = lo + ((k + 0.5) * (hi - lo)) / n;
            let p: Vec2 = alongX ? [t, c[1]] : [c[0], t];
            if (!pointInPolygon(p, poly)) p = v2.lerp(p, c, 0.6);
            if (lights.some((q) => v2.dist(q, p) < 0.35)) p = v2.add(p, alongX ? [0, 0.45] : [0.45, 0]);
            p = clearPoint(li, poly, p);
            supplies.push({ id: `${id}.S${L.terminals.filter((t) => t.unit === id).length + supplies.length + 1}`, kind: "supply", room: r.room, at: p, airflow: Math.round(r.supply / n), unit: id });
          }
          // return grille near the room's door, else off-centre; the thermostat beside the main room's door
          // interior doors only: a return grille or thermostat by the front door would sit in the hot draught
          const door = info.openings.find((o) => o.op.type === "door" && !o.seg.exterior && nearEdge(v2.add(o.seg.a, v2.scale(segDir(o.seg), o.u)), poly) < o.seg.thickness / 2 + 0.25);
          let rp: Vec2;
          if (door) {
            const dc = v2.add(door.seg.a, v2.scale(segDir(door.seg), door.u));
            const toC = v2.norm(v2.sub(c, dc));
            rp = v2.add(dc, v2.add(v2.scale(toC, 0.8), v2.scale(segDir(door.seg), door.width / 2 + 0.4)));
            if (!pointInPolygon(rp, poly)) rp = v2.add(dc, v2.scale(toC, 0.8));
            if (r === mainRoom) {
              const tp = v2.add(dc, v2.add(v2.scale(toC, 0.12), v2.scale(segDir(door.seg), -(door.width / 2 + 0.3))));
              if (pointInPolygon(tp, poly)) L.thermostats.push({ at: tp, unit: id, room: r.room });
            }
          } else rp = v2.lerp(c, poly[0], 0.35);
          rp = clearPoint(li, poly, rp);
          // keep the return 2 m+ from this room's diffusers (else the cold air short-circuits back to the unit):
          // by the door when that is far enough, else the spot farthest from them
          const mine = supplies.filter((t) => t.room === r.room).map((t) => t.at);
          const gap = (p: Vec2) => Math.min(Infinity, ...mine.map((q) => v2.dist(p, q)));
          if (mine.length && gap(rp) < 2) {
            const cands: Vec2[] = [rp];
            for (let q = 0; q < poly.length; q++) {
              const a0 = poly[q], b0 = poly[(q + 1) % poly.length];
              for (const t of [0.15, 0.5, 0.85]) cands.push(v2.lerp(v2.lerp(a0, b0, t), c, 0.6 / Math.max(0.6, v2.dist(v2.lerp(a0, b0, t), c))));
            }
            const best = cands.filter((p) => pointInPolygon(p, poly)).map((p) => clearPoint(li, poly, p)).reduce((x, y) => (gap(y) > gap(x) + 0.05 ? y : x), rp);
            rp = best;
          }
          returns.push({ id: `${id}.R${L.terminals.filter((t) => t.unit === id && t.kind === "return").length + returns.length + 1}`, kind: "return", room: r.room, at: rp, airflow: Math.round(r.supply * 0.85), unit: id });
        }
        L.terminals.push(...supplies, ...returns);
        if (li === zLevels[zLevels.length - 1] && !levels.some((LL) => LL.thermostats.some((t) => t.unit === id)) && returns.length) L.thermostats.push({ at: returns[0].at, unit: id, room: returns[0].room });

        // ---- ducts: a tree from the riser through the terminals, sized by the air each branch carries ----
        const voidAt = (p: Vec2): { void: number; room: string } | undefined => {
          const ri = roomAt(li, p);
          if (ri < 0) return undefined;
          const cl = info.ceilings[ri];
          return { void: !cl || cl.type === "none" ? 0 : cl.structure - cl.height, room: project.levels[li].rooms[ri].name };
        };
        for (const kind of ["supply", "return"] as const) {
          const terms = kind === "supply" ? supplies : returns;
          for (const e of ductTree(shaft, terms.map((t) => ({ at: t.at, airflow: t.airflow })), (p) => roomAt(li, p) >= 0)) {
            const v = kind === "supply" ? (e.airflow > 300 ? 5 : e.leaf ? 3 : 4) : 4;
            const area = e.airflow / 1000 / v;
            let minVoid = Infinity;
            for (let i = 0; i + 1 < e.pts.length; i++) {
              const len = v2.dist(e.pts[i], e.pts[i + 1]);
              for (let s = 0; s <= len; s += 0.5) {
                const q = voidAt(v2.lerp(e.pts[i], e.pts[i + 1], len ? s / len : 0));
                if (!q) continue;
                minVoid = Math.min(minVoid, q.void);
                if (q.void < 0.05) (bare.get(id) ?? bare.set(id, new Set()).get(id)!).add(q.room);
                else if (q.void < 0.25) {
                  const m = tight.get(id) ?? tight.set(id, new Map()).get(id)!;
                  m.set(q.room, Math.min(m.get(q.room) ?? Infinity, q.void));
                }
              }
            }
            // ducts are sized for a 300 mm void (the false ceiling the warnings ask for) when there is less
            const avail = minVoid === Infinity || minVoid < 0.25 ? 0.3 : minVoid - 0.1;
            const maxH = Math.max(0.15, Math.min(0.35, Math.floor((avail + 1e-6) / 0.05) * 0.05));
            const h = Math.min(maxH, Math.max(0.15, Math.round(Math.sqrt(area / 2) / 0.05) * 0.05));
            const w = Math.max(h, Math.ceil(area / h / 0.05) * 0.05);
            L.ducts.push({ kind, unit: id, pts: e.pts, airflow: Math.round(e.airflow), w: r2(w), h: r2(h), node: e.node, parent: e.parent, term: terms[e.node - 1]?.id });
          }
        }
      }

      // ---- the unit ----
      const el = electrics(size);
      const roomsOf = z.rooms.map((r) => ({ level: r.level, room: r.room }));
      if (system === "packaged") {
        const [fw, fd] = size <= 7.5 ? [1.8, 1.1] : size <= 15 ? [2.4, 1.3] : size <= 25 ? [3.2, 1.8] : [4.2, 2.2];
        // beside the riser on the roof, on whichever side the roof has room
        const roofRooms = project.levels[top].rooms.filter((x) => kindOf(x.name) !== "outdoor");
        const onRoof = (p: Vec2) => !roofRooms.length || roofRooms.some((x) => pointInPolygon(p, x.polygon as Vec2[]));
        const box = (c: Vec2): Vec2[] => [[-fw / 2, -fd / 2], [fw / 2, -fd / 2], [fw / 2, fd / 2], [-fw / 2, fd / 2]].map((q) => v2.add(c, q as Vec2));
        const taken = units.filter((u) => u.footprint).map((u) => u.footprint!);
        // 0.4 m clear of the parapets for service access and airflow
        const grown = (b: Vec2[]) => {
          const c = polygonCentroid(b);
          return b.map((p) => v2.add(p, v2.scale(v2.norm(v2.sub(p, c)), 0.55)));
        };
        const clear = (b: Vec2[]) => grown(b).every(onRoof) && !taken.some((t) => b.some((p) => pointInPolygon(p, t)) || t.some((p) => pointInPolygon(p, b)));
        let at: Vec2 = v2.add(shaft, [fw / 2 + 0.6, 0]);
        let fits = false;
        const offs: Vec2[] = [];
        for (const r of [0, 1, 2]) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) offs.push([dx * (fw / 2 + 0.6 + r * 0.8), dy * (fd / 2 + 0.6 + r * 0.8)]);
        for (const off of offs) {
          const p = v2.add(shaft, off);
          if (clear(box(p))) {
            at = p;
            fits = true;
            break;
          }
        }
        if (!fits) issues.push(`${id} (${size} TR, about ${fw}×${fd} m) does not fit on the roof beside its riser: move the riser (hvac.zones[].shaft) or check the roof plan`);
        units.push({ id, kind: "packaged", zone: z.id, level: low, rooms: roomsOf, load, size, airflow, freshAir: fresh, ...el, at, footprint: box(at), onLevel: top, onRoof: true });
        circuits.push({ id: `AC-${zi + 1}`, kind: "hvac", rating: el.breaker, label: `${id} packaged unit ${size} TR on the roof, ${el.phase === 3 ? "3-phase" : "1-phase"} + isolator`, rooms: z.rooms.map((r) => r.name), points: 1 });
      } else {
        units.push({ id, kind: "ducted_split", zone: z.id, level: low, rooms: roomsOf, load, size, airflow, freshAir: fresh, ...el, at: shaft, onLevel: low, onRoof: false });
        circuits.push({ id: `AC-${zi + 1}`, kind: "hvac", rating: el.breaker, label: `${id} ducted split ${size} TR + roof condenser, ${el.phase === 3 ? "3-phase" : "1-phase"}`, rooms: z.rooms.map((r) => r.name), points: 1 });
        const ri = roomAt(low, shaft);
        const cl = ri >= 0 ? infos[low].ceilings[ri] : undefined;
        if (cl && cl.type !== "none" && cl.structure - cl.height < 0.35) issues.push(`${id} indoor unit in ${project.levels[low].rooms[ri].name}: the ceiling void is ${Math.round((cl.structure - cl.height) * 1000)} mm, a concealed unit needs about 350 mm`);
      }
      if (zLevels.length > 1) assumptions.push(`${id} serves ${zLevels.map((l) => infos[l].name).join(" and ")} (each floor alone is below the smallest unit, ${minTR} TR) through one riser.`);
    });
    for (const [id, rs] of bare) issues.push(`${id}: ducts run where there is no false ceiling (${[...rs].join(", ")}): ducted AC needs a false ceiling about 300 mm below the slab in those rooms (room ceilingHeight), or bulkheads along the duct runs`);
    for (const [id, rs] of tight) issues.push(`${id}: the ceiling void is too shallow for ducts in ${[...rs].map(([n, v]) => `${n} (${Math.round(v * 1000)} mm)`).join(", ")}: ducts need about 250–300 mm (duct, insulation and hangers)`);
    if (system === "packaged" && units.length)
      assumptions.push("Packaged units on the roof on steel bases with anti-vibration mounts; supply and return ducts drop through a riser per unit; condensate to the roof drains; fresh air through each unit's outdoor-air damper.");
  }

  // ---- totals ----
  const tr = r2(units.reduce((a, u) => a + u.size, 0));
  const area = r2(cond.reduce((a, r) => a + r.area, 0));
  const totalW = cond.reduce((a, r) => a + r.total, 0);
  return {
    system,
    rooms,
    units,
    levels,
    circuits,
    issues,
    totals: { tr, kw: r2(units.reduce((a, u) => a + u.kw, 0)), area, m2PerTR: tr ? r2(area / tr) : 0, wPerM2: area ? Math.round(totalW / area) : 0 },
    assumptions,
  };
}

function nearEdge(p: Vec2, poly: Vec2[]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) best = Math.min(best, pointSegment(p, poly[i], poly[(i + 1) % poly.length]).dist);
  return best;
}

/**
 * A duct tree: minimum spanning tree (Manhattan) from the root through the terminals, each edge drawn as an L
 * (bend chosen to stay inside rooms) and carrying the air of everything downstream.
 */
function ductTree(root: Vec2, terms: { at: Vec2; airflow: number }[], inside: (p: Vec2) => boolean): { pts: Vec2[]; airflow: number; leaf: boolean; node: number; parent: number }[] {
  const nodes = [root, ...terms.map((t) => t.at)];
  const n = nodes.length;
  const parent = new Array<number>(n).fill(-1);
  const inTree = new Array<boolean>(n).fill(false);
  const dist = new Array<number>(n).fill(Infinity);
  dist[0] = 0;
  const man = (a: Vec2, b: Vec2) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
  for (let k = 0; k < n; k++) {
    let u = -1;
    for (let i = 0; i < n; i++) if (!inTree[i] && (u < 0 || dist[i] < dist[u])) u = i;
    inTree[u] = true;
    for (let i = 0; i < n; i++)
      if (!inTree[i] && man(nodes[u], nodes[i]) < dist[i]) {
        dist[i] = man(nodes[u], nodes[i]);
        parent[i] = u;
      }
  }
  // air downstream of each node
  const flow = [0, ...terms.map((t) => t.airflow)];
  const children = Array.from({ length: n }, () => [] as number[]);
  for (let i = 1; i < n; i++) children[parent[i]].push(i);
  const down = (i: number): number => flow[i] + children[i].reduce((a, c) => a + down(c), 0);
  const out: { pts: Vec2[]; airflow: number; leaf: boolean; node: number; parent: number }[] = [];
  for (let i = 1; i < n; i++) {
    const a = nodes[parent[i]], b = nodes[i];
    const bends: Vec2[] = [[b[0], a[1]], [a[0], b[1]]];
    const score = (m: Vec2) => [0.25, 0.5, 0.75].filter((t) => inside(v2.lerp(a, m, t)) && inside(v2.lerp(m, b, t))).length + (inside(m) ? 1 : 0);
    const bend = score(bends[0]) >= score(bends[1]) ? bends[0] : bends[1];
    const pts = v2.dist(a, bend) < 0.01 || v2.dist(bend, b) < 0.01 ? [a, b] : [a, bend, b];
    out.push({ pts, airflow: down(i), leaf: children[i].length === 0, node: i, parent: parent[i] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3D: roof units, wall splits, and ceiling diffusers / grilles
// ---------------------------------------------------------------------------

/** Scene node with the air-conditioning equipment (levels: elevation + ceiling layouts of each level). */
export function hvacNode(h: HvacDesign, levels: { elevation: number; height: number; ceilings: CeilingLayout[] }[], roomCount: (l: number) => number): SceneNode | undefined {
  if (!h.units.length) return undefined;
  const mb = new MeshBuilder();
  const top = levels[levels.length - 1];
  for (const u of h.units) {
    if (!u.footprint) continue;
    const xs = u.footprint.map((p) => p[0]), ys = u.footprint.map((p) => p[1]);
    const z0 = top.elevation + top.height;
    const ht = u.size <= 7.5 ? 1.15 : u.size <= 15 ? 1.35 : 1.7;
    mb.box("metal_steel", [Math.min(...xs), Math.min(...ys), z0], [Math.max(...xs), Math.max(...ys), z0 + 0.15]); // steel base
    mb.box("metal_white", [Math.min(...xs) + 0.05, Math.min(...ys) + 0.05, z0 + 0.15], [Math.max(...xs) - 0.05, Math.max(...ys) - 0.05, z0 + 0.15 + ht]);
    // condenser fans on top
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const fans = u.size <= 10 ? 1 : 2;
    for (let k = 0; k < fans; k++) {
      const fx = fans === 1 ? cx : cx + (k - 0.5) * (Math.max(...xs) - Math.min(...xs)) * 0.5;
      mb.cylinder("metal_black", [fx, cy, z0 + 0.15 + ht], 0.32, 0.32, 0.03, 20);
    }
  }
  h.levels.forEach((L, li) => {
    const lv = levels[li];
    if (!lv) return;
    for (const s of L.splits) {
      const z = lv.elevation + 2.3;
      const along: Vec2 = [-s.dir[1], s.dir[0]];
      const o = v2.add(s.at, v2.scale(s.dir, -0.15));
      const frame = m4.fromBasis([along[0], along[1], 0], [s.dir[0], s.dir[1], 0], [0, 0, 1], [o[0], o[1], z]);
      mb.with(frame, () => mb.box("plastic_white", [-0.45, 0, -0.15], [0.45, 0.22, 0.15]));
    }
    for (const t of L.terminals) {
      if (t.room < 0 || t.room >= roomCount(li)) continue;
      const cl = lv.ceilings[t.room];
      const hgt = cl && cl.type !== "none" ? cl.height : lv.height - 0.2;
      const z = lv.elevation + hgt - 0.012;
      const r = t.kind === "supply" ? 0.3 : 0.25;
      mb.box(t.kind === "supply" ? "plastic_white" : "plastic_gray", [t.at[0] - r, t.at[1] - r, z], [t.at[0] + r, t.at[1] + r, z + 0.01]);
    }
  });
  return { name: "air_conditioning", kind: "group", meshes: mb.meshes(), children: [], extras: { system: h.system, tr: h.totals.tr } };
}
