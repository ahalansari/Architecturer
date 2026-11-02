/**
 * Pump pits for floors below the street sewer. A Kuwaiti basement (typically 3–4 m down) cannot drain by gravity:
 *
 *  - a sewage pit (EN 12056-4 wastewater lifting plant) takes the basement's WCs, showers, basins and laundry and
 *    lifts them with vortex (or grinder) pumps through a rising main that loops above ground level before it falls
 *    to the sewer connection;
 *  - a drainage sump takes the rain that falls into sunken courts, light wells and ramps open to the sky.
 *
 * Design: inflows (EN 12056-2 discharge units, a design storm on the open areas, groundwater), the pump chosen where
 * its curve meets the system curve (static lift + Darcy–Weisbach friction), the rising main (0.7–2.3 m/s), switch
 * levels from the allowed starts per hour, and the storage above the alarm. Then a one-second time-step simulation
 * of the pit level through a normal day, a design storm, a power cut and a failed duty pump.
 */
import { z } from "zod";
import { MeshBuilder } from "../geometry/mesh.js";
import { boxOf } from "../geometry/spatial.js";
import { pointInPolygon, pointSegment, polygonArea, polygonCentroid, v2, type Vec2, type Vec3 } from "../geometry/math.js";
import type { SceneNode } from "../geometry/scene.js";
import { Id, Point } from "../schema/common.js";
import type { WallSegment } from "./walls.js";
import type { FixtureKind, ServicesLayout } from "./services.js";
import { pipeLoss } from "./water.js";

export const PumpPitSchema = z
  .object({
    id: Id.optional(),
    kind: z
      .enum(["sewage", "drainage"])
      .default("sewage")
      .describe("sewage: ejector pit for the floor's WCs, showers, basins, laundry (vortex pumps, sealed cover, vented) | drainage: sump for rain on sunken courts, light wells, ramps (and groundwater)"),
    position: Point.describe("Centre of the pit in plan"),
    size: z.tuple([z.number().min(0.6).max(4), z.number().min(0.6).max(4)]).optional().describe("Inside plan size [x, y], m (default: 1.0 × 1.0 for two pumps, 0.8 × 0.8 for one, larger when the volume per cycle needs it)"),
    depth: z.number().min(0.6).max(6).optional().describe("Inside depth below the finished floor, m (default: from the switch levels and the incoming drain)"),
    pumps: z.number().int().min(1).max(3).default(2).describe("Pumps: 2 = duty / standby, alternating (both run when the level keeps rising)"),
    pump: z.string().optional().describe("Pump model from the catalogue (S-11…S-30 vortex, G-15 / G-22 grinder, D-04…D-22 drainage); default: the smallest that works"),
    discharge: Point.optional().describe("Where the rising main meets the gravity sewer / storm drain at ground level (manhole). Default: just outside the building on the nearest side"),
    catchment: z.array(Id).optional().describe("Ids of terraces / gardens that drain here (default: every area of this floor open to the sky)"),
    extraArea: z.number().min(0).default(0).describe("Other paved area draining here, m² (a ramp, part of a roof)"),
    groundwaterLh: z.number().min(0).default(0).describe("Groundwater seeping in, L/h"),
    extraInflowLh: z.number().min(0).default(0).describe("Other steady inflow, L/h (AC condensate, pool backwash averaged)"),
    rainfallMmH: z.number().positive().max(300).default(60).describe("Design rainfall, five-minute peak, mm/h (Kuwait ≈ 60 for a 1-in-10-year storm, indicative)"),
    usage: z.number().positive().max(5).default(1).describe("Scales how often the fixtures are used in the day simulation (1 = a household)"),
    powerCutHours: z.number().positive().max(24).default(4).describe("Length of the power-cut scenario, h"),
    pumpOutHours: z.number().min(0).max(48).optional().describe("Controller timer: pump the pit down after this many hours without a cycle so sewage does not turn septic (default 6 for sewage, 0 = off)"),
  })
  .describe("Pump pit below the floor: sewage ejector pit or rain / groundwater sump, with its pumps, rising main and controls");
export type PumpPitSpec = z.output<typeof PumpPitSchema>;

export type PitKind = PumpPitSpec["kind"];

interface PumpModel {
  model: string;
  type: "vortex" | "grinder" | "drainage";
  kW: number;
  /** Shut-off head (m) and the flow at zero head (L/s): H = h0 · (1 − (Q / qmax)²). */
  h0: number;
  qmax: number;
  eta: number;
}
/** Generic submersible pumps (indicative curves for typical domestic units, not one maker's). */
export const PUMPS: PumpModel[] = [
  { model: "D-04", type: "drainage", kW: 0.4, h0: 8, qmax: 3, eta: 0.38 },
  { model: "D-07", type: "drainage", kW: 0.75, h0: 11, qmax: 4.5, eta: 0.42 },
  { model: "D-11", type: "drainage", kW: 1.1, h0: 14, qmax: 6.5, eta: 0.46 },
  { model: "D-22", type: "drainage", kW: 2.2, h0: 18, qmax: 10, eta: 0.5 },
  { model: "S-11", type: "vortex", kW: 1.1, h0: 10, qmax: 9, eta: 0.36 },
  { model: "S-15", type: "vortex", kW: 1.5, h0: 13, qmax: 11, eta: 0.38 },
  { model: "S-22", type: "vortex", kW: 2.2, h0: 17, qmax: 13, eta: 0.4 },
  { model: "S-30", type: "vortex", kW: 3, h0: 21, qmax: 15, eta: 0.42 },
  { model: "G-15", type: "grinder", kW: 1.5, h0: 24, qmax: 3.2, eta: 0.3 },
  { model: "G-22", type: "grinder", kW: 2.2, h0: 32, qmax: 3.8, eta: 0.32 },
];
const PUMP_TYPE = { vortex: "vortex impeller, 50 mm free passage", grinder: "grinder (cutter)", drainage: "drainage, 10 mm solids" } as const;
/** PE100 SDR17 rising mains: outside diameter, bore (mm), nominal size. Sewage with solids: DN 80 at least (DN 40 after a grinder). */
const MAINS: Record<PumpModel["type"], [number, number, string][]> = {
  vortex: [[90, 79.2, "DN 80"], [110, 96.8, "DN 100"]],
  grinder: [[50, 44, "DN 40"], [63, 55.4, "DN 50"]],
  drainage: [[63, 55.4, "DN 50"], [75, 66, "DN 65"], [90, 79.2, "DN 80"]],
};
const V_MIN = 0.7, V_MAX = 2.3;
/** Allowed starts per hour of one pump (small submersibles). */
const STARTS = 12;
/** Valves and bends on the rising main: ball non-return 1.8, gate 0.3, five bends, exit 1. */
const ZETA = 1.8 + 0.3 + 5 * 0.4 + 1;
/** Discharge units, L/s (EN 12056-2, system I). */
const DU: Record<FixtureKind, number> = { wc: 2, basin: 0.5, sink: 0.8, shower: 0.6, bath: 0.8, dishwasher: 0.8, washing_machine: 0.8, floor_drain: 0.8, tap: 0 };
/** A household's use of each fixture: uses per day, litres per use, seconds it drains over. */
const USE: Record<FixtureKind, { perDay: number; litres: number; seconds: number }> = {
  wc: { perDay: 5, litres: 6, seconds: 8 },
  basin: { perDay: 8, litres: 2, seconds: 20 },
  sink: { perDay: 6, litres: 5, seconds: 30 },
  shower: { perDay: 2, litres: 60, seconds: 420 },
  bath: { perDay: 0.3, litres: 150, seconds: 180 },
  dishwasher: { perDay: 1, litres: 15, seconds: 120 },
  washing_machine: { perDay: 1.5, litres: 50, seconds: 240 },
  floor_drain: { perDay: 0.5, litres: 10, seconds: 60 },
  tap: { perDay: 0, litres: 0, seconds: 1 },
};
/** When a Kuwaiti household uses water, by hour (relative). */
const HOURLY = [0.3, 0.2, 0.15, 0.15, 0.3, 0.8, 1.6, 2, 1.6, 1.1, 0.9, 0.9, 1.1, 1.3, 1.1, 0.9, 1, 1.3, 1.6, 1.8, 2, 1.9, 1.4, 0.8];
/** Floors lower than this (m) are below the street sewer. */
export const BELOW_SEWER = -1;
const SURFACE_C: Record<string, number> = { lawn: 0.3, planting: 0.3, mulch: 0.3, sand: 0.3, turf: 0.6, gravel: 0.6, paving: 0.95 };

export interface Duty {
  /** Total flow (L/s), head (m), velocity in the rising main (m/s), electrical input of each running pump (kW). */
  flowLs: number;
  headM: number;
  velocity: number;
  kWin: number;
}

export interface PitDesign {
  id: string;
  level: number;
  kind: PitKind;
  /** False: suggested by the design (the plan has no pit there yet). */
  explicit: boolean;
  at: Vec2;
  size: [number, number];
  area: number;
  depth: number;
  /** Finished floor level of the storey the pit is sunk into. */
  floorZ: number;
  room?: string;
  fixtures: { id: string; kind: FixtureKind; room?: string; at: Vec2 }[];
  du: number;
  areas: { name: string; m2: number; c: number }[];
  inflow: { peakLs: number; stormLs: number; baseLs: number; dailyLitres: number; rainMmH: number };
  /** Switch and pipe levels above the pit floor, m. */
  levels: { stop: number; start: number; assist?: number; alarm: number; inlet: number; top: number };
  volumes: { effective: number; toAlarm: number; emergency: number };
  pumps: { count: number; model: PumpModel; atStop: Duty; atAlarm: Duty; both?: Duty };
  main: { od: number; bore: number; label: string; length: number; staticHead: number; crestZ: number; discharge: Vec2; route: Vec2[] };
  usage: number;
  powerCutHours: number;
  /** Timed pump-down after this many idle hours (0 = off). */
  pumpOutHours: number;
  issues: string[];
  notes: string[];
}

interface LevelIn {
  id: string;
  name?: string;
  rooms: { name: string; polygon: number[][] }[];
  terraces: { id?: string; name: string; polygon: number[][] }[];
  gardens: { id?: string; name?: string; surface: string; polygon: number[][] }[];
  pumpPits: PumpPitSpec[];
}
interface InfoIn {
  id: string;
  name: string;
  elevation: number;
  height: number;
  segments: WallSegment[];
  services: ServicesLayout;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const r1 = (n: number) => Math.round(n * 10) / 10;
const up = (n: number, s: number) => Math.ceil(n / s - 1e-9) * s;

const pumpHead = (p: PumpModel, q: number, n = 1) => p.h0 * (1 - (q / (n * p.qmax)) ** 2);
const frictionM = (q: number, bore: number, length: number) => pipeLoss(q, bore, length, ZETA, 0.05, 1.0e-6).dp * 10.197;

/** Where n pumps in parallel meet the system curve (static lift `hs`, the main's friction). */
function dutyPoint(p: PumpModel, n: number, hs: number, bore: number, length: number): Duty {
  const f = (q: number) => pumpHead(p, q, n) - hs - frictionM(q, bore, length);
  if (f(1e-4) <= 0) return { flowLs: 0, headM: r2(hs), velocity: 0, kWin: 0 };
  let lo = 1e-4, hi = n * p.qmax;
  for (let k = 0; k < 50; k++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 0) lo = mid;
    else hi = mid;
  }
  const q = lo, h = pumpHead(p, q, n);
  const d = bore / 1000;
  return { flowLs: r2(q), headM: r2(h), velocity: r2(q / 1000 / ((Math.PI * d * d) / 4)), kWin: r2((9.81 * (q / n / 1000) * 1000 * h) / p.eta / 1000) };
}

/** Is a point under the floor above (a room there)? Then the area is roofed, not open to the rain. */
const covered = (pt: Vec2, above?: LevelIn) => !!above?.rooms.some((r) => pointInPolygon(pt, r.polygon as Vec2[]));

/** Rooms where a pit goes: plant / pump / service rooms first, then stores and laundries. */
const SERVICE_RE = [/plant|pump|mech|service|utility|boiler/i, /store|storage|laundry|garage/i];

/**
 * A spot for a pit: inside `poly`, in its corner nearest `toward`, clear of the walls by 0.15 m.
 */
function cornerSpot(poly: Vec2[], toward: Vec2, size: [number, number]): Vec2 {
  const c = polygonCentroid(poly);
  const corner = [...poly].sort((a, b) => v2.dist(a, toward) - v2.dist(b, toward))[0];
  const d = v2.sub(c, corner);
  const sx = Math.sign(d[0]) || 1, sy = Math.sign(d[1]) || 1;
  const p: Vec2 = [corner[0] + sx * (size[0] / 2 + 0.25), corner[1] + sy * (size[1] / 2 + 0.25)];
  return pointInPolygon(p, poly) ? p : c;
}

/**
 * Pump pits of the plan, designed; with `suggest`, floors below the sewer that need a pit and have none get a
 * suggested one (explicit: false).
 */
export function designPumpPits(project: { levels: LevelIn[] }, infos: InfoIn[], opts: { suggest?: boolean } = {}): { pits: PitDesign[]; issues: string[] } {
  const pits: PitDesign[] = [];
  const issues: string[] = [];
  const ground = Math.max(0, Math.min(...infos.filter((l) => l.elevation >= -0.5).map((l) => l.elevation), 0));
  // the building's extent, for a default discharge point just outside it
  const allPts = infos.flatMap((l) => l.segments.flatMap((s) => [s.a, s.b]));
  // (a loop, not Math.min(...pts): a campus has more wall ends than the call stack takes arguments)
  const box = allPts.length ? boxOf(allPts) : { x0: -5, x1: 5, y0: -5, y1: 5 };
  const lvName = (li: number) => project.levels[li]?.name ?? infos[li]?.name ?? project.levels[li]?.id;

  for (let li = 0; li < infos.length; li++) {
    const info = infos[li], lv = project.levels[li];
    if (!lv) continue;
    const above = infos.map((l, k) => ({ l, k })).filter((x) => x.l.elevation > info.elevation + 0.5).sort((a, b) => a.l.elevation - b.l.elevation)[0];
    const lvAbove = above ? project.levels[above.k] : undefined;
    const below = info.elevation < BELOW_SEWER;
    // what has to be pumped: the fixtures that drain, and the open areas
    const fixtures = info.services.fixtures.filter((f) => DU[f.kind] > 0);
    const roomOf = (p: Vec2) => lv.rooms.find((r) => pointInPolygon(p, r.polygon as Vec2[]))?.name;
    const open = [
      ...lv.terraces.map((t) => ({ id: t.id, name: t.name, poly: t.polygon as Vec2[], c: 0.95 })),
      ...lv.gardens.map((g) => ({ id: g.id, name: g.name ?? `${g.surface} area`, poly: g.polygon as Vec2[], c: SURFACE_C[g.surface] ?? 0.5 })),
    ].filter((a) => !covered(polygonCentroid(a.poly), lvAbove));
    let specs = lv.pumpPits.map((s, i) => ({ s, explicit: true, id: s.id ?? `${s.kind === "sewage" ? "SP" : "DP"}${i + 1}` }));
    if (below && opts.suggest && !specs.length && (fixtures.length || open.length)) {
      // suggest: a sewage pit in a service room (or the wettest room), a sump in the largest open area
      const wet = fixtures.length ? polygonCentroid(fixtures.map((f) => f.at)) : undefined;
      if (wet && fixtures.length >= 1) {
        const rooms = lv.rooms.map((r) => ({ r, poly: r.polygon as Vec2[] }));
        const svc = SERVICE_RE.map((re) => rooms.filter((x) => re.test(x.r.name))).find((a) => a.length);
        const pick = (svc ?? rooms.filter((x) => fixtures.some((f) => pointInPolygon(f.at, x.poly))))
          .sort((a, b) => v2.dist(polygonCentroid(a.poly), wet) - v2.dist(polygonCentroid(b.poly), wet))[0];
        if (pick) specs.push({ s: PumpPitSchema.parse({ kind: "sewage", position: cornerSpot(pick.poly, wet, [1.2, 1.2]) }), explicit: false, id: "SP1" });
      }
      const big = [...open].sort((a, b) => polygonArea(b.poly) - polygonArea(a.poly))[0];
      if (big) {
        const centre = lv.rooms.length ? polygonCentroid(lv.rooms.flatMap((r) => r.polygon as Vec2[])) : polygonCentroid(big.poly);
        specs.push({ s: PumpPitSchema.parse({ kind: "drainage", position: cornerSpot(big.poly, centre, [1, 1]) }), explicit: false, id: "DP1" });
      }
    } else if (below && !specs.length && (fixtures.length || open.length)) {
      const what = [
        fixtures.length ? `${fixtures.length} fixture${fixtures.length > 1 ? "s" : ""} (${[...new Set(fixtures.map((f) => roomOf(f.at)).filter(Boolean))].slice(0, 4).join(", ")})` : "",
        open.length ? `open ${open.map((a) => a.name).join(", ")} that collect${open.length > 1 ? "" : "s"} rain` : "",
      ].filter(Boolean);
      issues.push(`${lvName(li)} is ${r1(-info.elevation)} m below ground with ${what.join(" and ")}: it cannot drain to the street sewer by gravity — add a pump pit (level.pumpPits; pump_pit suggests one).`);
    }
    if (!specs.length) continue;

    // who drains where: fixtures to the nearest sewage pit, open areas to the nearest drainage pit (or the other kind)
    const nearest = (p: Vec2, kind: PitKind) => {
      const pref = specs.filter((x) => x.s.kind === kind);
      const pool = pref.length ? pref : specs;
      return pool.sort((a, b) => v2.dist(a.s.position as Vec2, p) - v2.dist(b.s.position as Vec2, p))[0];
    };
    const served = new Map(specs.map((x) => [x.id, { fixtures: [] as typeof fixtures, areas: [] as typeof open }]));
    for (const f of fixtures) served.get(nearest(f.at, "sewage").id)!.fixtures.push(f);
    for (const a of open) {
      const named = specs.find((x) => x.s.catchment?.includes(a.id ?? "\u0000"));
      const inside = specs.find((x) => pointInPolygon(x.s.position as Vec2, a.poly) && x.s.kind === "drainage");
      const to = named ?? (specs.some((x) => x.s.catchment) ? undefined : (inside ?? nearest(polygonCentroid(a.poly), "drainage")));
      if (to) served.get(to.id)!.areas.push(a);
    }

    for (const { s, explicit, id } of specs) {
      const at = s.position as Vec2;
      const sv = served.get(id)!;
      let size = (s.size ?? (s.pumps > 1 ? [1, 1] : [0.8, 0.8])) as [number, number];
      let area = size[0] * size[1];
      const pitIssues: string[] = [], notes: string[] = [];
      const du = sv.fixtures.reduce((a, f) => a + DU[f.kind], 0);
      const maxDU = Math.max(0, ...sv.fixtures.map((f) => DU[f.kind]));
      const peakLs = du ? Math.max(maxDU, 0.5 * Math.sqrt(du)) : 0;
      const areas = sv.areas.map((a) => ({ name: a.name, m2: r1(polygonArea(a.poly)), c: a.c }));
      if (s.extraArea) areas.push({ name: "other paved area", m2: s.extraArea, c: 1 });
      const stormLs = areas.reduce((a, x) => a + (x.m2 * x.c * s.rainfallMmH) / 3600, 0);
      const baseLs = (s.groundwaterLh + s.extraInflowLh) / 3600;
      const dailyLitres = sv.fixtures.reduce((a, f) => a + USE[f.kind].perDay * USE[f.kind].litres, 0) * s.usage + baseLs * 86400;
      if (s.kind === "drainage" && sv.fixtures.length)
        pitIssues.push(`${sv.fixtures.length} fixture${sv.fixtures.length > 1 ? "s" : ""} (WCs, showers…) drain to this drainage sump: sewage needs a sewage pit with vortex or grinder pumps — add one (kind: sewage).`);
      if (s.kind === "sewage" && stormLs > 0) notes.push(`rain from ${areas.map((a) => a.name).join(", ")} also comes here: check the authority accepts rainwater in the foul sewer, or give the open area its own drainage sump.`);

      // the incoming drain's depth below the floor: the longest run to the pit at a fall of 1:60 (1:100 for surface water)
      const runs = [...sv.fixtures.map((f) => Math.abs(f.at[0] - at[0]) + Math.abs(f.at[1] - at[1])), ...sv.areas.map((a) => Math.max(...a.poly.map((p) => Math.abs(p[0] - at[0]) + Math.abs(p[1] - at[1]))) * 0.5)];
      const longest = Math.max(0, ...runs);
      const inletDepth = sv.fixtures.length ? 0.35 + longest / 60 : 0.3 + longest / 100;

      // the rising main: up through a loop 0.3 m above ground (backflow), across, down to the sewer connection
      const discharge = (s.discharge as Vec2 | undefined) ?? (() => {
        const opts: [number, Vec2][] = [
          [at[0] - box.x0, [box.x0 - 1.5, at[1]]],
          [box.x1 - at[0], [box.x1 + 1.5, at[1]]],
          [at[1] - box.y0, [at[0], box.y0 - 1.5]],
          [box.y1 - at[1], [at[0], box.y1 + 1.5]],
        ];
        return opts.sort((a, b) => a[0] - b[0])[0][1];
      })();
      if (!s.discharge) notes.push(`the rising main runs to [${r1(discharge[0])}, ${r1(discharge[1])}], just outside the nearest side — set discharge to the real sewer connection (manhole).`);
      const route: Vec2[] = Math.abs(discharge[0] - at[0]) >= Math.abs(discharge[1] - at[1]) ? [at, [discharge[0], at[1]], discharge] : [at, [at[0], discharge[1]], discharge];
      const horiz = Math.abs(discharge[0] - at[0]) + Math.abs(discharge[1] - at[1]);
      const crestZ = ground + 0.3;
      const floorZ = info.elevation;

      // pump and main: the smallest that delivers the peak at 0.7 m/s or more; switch levels from the starts per hour
      const types: PumpModel["type"][] = s.kind === "drainage" ? ["drainage"] : ["vortex", "grinder"];
      const need = s.kind === "drainage" ? stormLs + baseLs : peakLs + (stormLs + baseLs);
      const stopFor = (t: PumpModel["type"]) => (t === "drainage" ? 0.15 : t === "grinder" ? 0.3 : 0.35);
      const evaluate = (p: PumpModel, m: [number, number, string], depth: number) => {
        const stop = stopFor(p.type);
        const length = depth - stop + (crestZ - floorZ) + horiz + (crestZ + 0.8);
        const hsStop = crestZ - (floorZ - depth + stop);
        return { length, d1: dutyPoint(p, 1, hsStop, m[1], length) };
      };
      // first pass at a typical depth to pick the pump; the depth then follows from the levels
      const guessDepth = s.depth ?? (s.kind === "sewage" ? 1.6 : 1.2);
      const named = s.pump ? PUMPS.find((p) => p.model.toLowerCase() === s.pump!.toLowerCase()) : undefined;
      if (s.pump && !named) pitIssues.push(`pump '${s.pump}' is not in the catalogue (${PUMPS.map((p) => p.model).join(", ")}): using the smallest that works.`);
      const cands = named ? [named] : PUMPS.filter((p) => types.includes(p.type));
      let choice: { p: PumpModel; m: [number, number, string] } | undefined;
      for (const p of cands) {
        for (const m of MAINS[p.type]) {
          const { d1 } = evaluate(p, m, guessDepth);
          if (d1.flowLs >= need && d1.velocity >= V_MIN && d1.velocity <= V_MAX) {
            choice = { p, m };
            break;
          }
        }
        if (choice) break;
      }
      if (!choice) {
        const p = named ?? cands[cands.length - 1];
        choice = { p, m: MAINS[p.type][0] };
      }
      const { p: model, m: main } = choice;
      const nPumps = s.pumps;
      const stop = stopFor(model.type);
      // volume per cycle: a cycle (fill + pump-down) no shorter than 3600 / (starts × alternating pumps) at the
      // worst steady inflow — half the pump flow, or the peak if less — and a run of at least 15 s
      const q1 = evaluate(model, main, guessDepth).d1.flowLs;
      const qi = Math.min(need, q1 / 2);
      const tMin = 3600 / (STARTS * Math.min(2, nPumps));
      const vEff = Math.max(qi > 0 && q1 > qi ? tMin / (1 / (q1 - qi) + 1 / qi) : 0, q1 * 15) / 1000;
      // a bigger chamber when the cycle would take more than 0.5 m of it
      if (!s.size) for (const side of [1.2, 1.5, 2]) if (vEff / area > 0.5 && side > size[0]) (size = [side, side]), (area = side * side);
      const hEff = Math.max(0.1, up(vEff / area, 0.05));
      const start = r2(stop + hEff);
      const assist = nPumps > 1 ? r2(start + 0.1) : undefined;
      const alarm = r2((assist ?? start) + 0.1);
      const need2 = alarm + 0.05 + inletDepth;
      const depth = s.depth ?? Math.max(1, up(need2, 0.1));
      const inlet = r2(depth - inletDepth);
      if (s.depth !== undefined && inlet < alarm)
        pitIssues.push(`the incoming drain enters ${r2(inletDepth)} m below the floor, ${r2(alarm - inlet)} m below the alarm level: the drains back up before the alarm sounds — make the pit at least ${r1(up(need2, 0.1))} m deep.`);
      const { length, d1: atStop } = evaluate(model, main, depth);
      const atAlarm = dutyPoint(model, 1, crestZ - (floorZ - depth + alarm), main[1], length);
      const both = nPumps > 1 ? dutyPoint(model, 2, crestZ - (floorZ - depth + stop), main[1], length) : undefined;
      const staticHead = crestZ - (floorZ - depth + stop);

      if (atStop.flowLs <= 0) pitIssues.push(`the ${model.model} cannot lift ${r1(staticHead)} m at all: choose a pump with more head.`);
      else {
        if (atStop.flowLs < need) pitIssues.push(`one ${model.model} delivers ${atStop.flowLs} L/s, less than the ${r2(need)} L/s that can arrive${s.kind === "drainage" ? " in the design storm" : " at peak"}: a bigger pump${named ? "" : " (none in the catalogue is enough: split the inflow between two pits)"}.`);
        if (atStop.velocity < V_MIN) pitIssues.push(`the rising main runs at ${atStop.velocity} m/s, below the ${V_MIN} m/s that keeps it from silting (EN 12056-4): a smaller main or a bigger pump.`);
        if (atStop.velocity > V_MAX) pitIssues.push(`the rising main runs at ${atStop.velocity} m/s, over ${V_MAX} m/s (noise, water hammer at the non-return valves): a larger main.`);
      }
      if (nPumps === 1) pitIssues.push(s.kind === "sewage" ? "one pump only: EN 12056-4 asks for a second (duty / standby) where the flow cannot be interrupted — a basement with WCs cannot." : "one pump only: a failure floods the area in the next storm — fit a standby pump.");
      if (both && stormLs > 0 && atStop.flowLs < stormLs + baseLs && both.flowLs >= stormLs + baseLs) pitIssues.push("the design storm needs both pumps running: no standby is left — fit larger pumps.");
      // the pit must not sit on a wall
      for (const sg of info.segments) {
        const d = pointSegment(at, sg.a, sg.b).dist;
        if (d < sg.thickness / 2 + Math.min(size[0], size[1]) / 2 - 0.05) {
          pitIssues.push(`the pit overlaps wall '${sg.wallId}': move it ${r2(sg.thickness / 2 + Math.max(size[0], size[1]) / 2 + 0.1 - d)} m clear (its chamber walls are 0.2 m thick).`);
          break;
        }
      }
      const room = roomOf(at) ?? sv.areas.find((a) => pointInPolygon(at, a.poly))?.name;
      pits.push({
        id,
        level: li,
        kind: s.kind,
        explicit,
        at,
        size,
        area: r2(area),
        depth: r2(depth),
        floorZ,
        room,
        fixtures: sv.fixtures.map((f) => ({ id: f.id, kind: f.kind, room: roomOf(f.at), at: f.at })),
        du: r1(du),
        areas,
        inflow: { peakLs: r2(peakLs), stormLs: r2(stormLs), baseLs: Math.round(baseLs * 1e4) / 1e4, dailyLitres: Math.round(dailyLitres), rainMmH: s.rainfallMmH },
        levels: { stop, start, assist, alarm, inlet, top: r2(depth) },
        volumes: { effective: r2(area * (start - stop)), toAlarm: r2(area * alarm), emergency: r2(area * (depth - alarm)) },
        pumps: { count: nPumps, model, atStop, atAlarm, both },
        main: { od: main[0], bore: main[1], label: `PE100 Ø${main[0]} (${main[2]})`, length: r1(length), staticHead: r2(staticHead), crestZ: r2(crestZ), discharge, route },
        usage: s.usage,
        powerCutHours: s.powerCutHours,
        pumpOutHours: s.pumpOutHours ?? (s.kind === "sewage" ? 6 : 0),
        issues: pitIssues,
        notes,
      });
    }
  }
  return { pits, issues };
}

// ---------------------------------------------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------------------------------------------

export type PitScenario = "day" | "storm" | "power_cut" | "pump_failure";

export interface PitSim {
  scenario: PitScenario;
  title: string;
  hours: number;
  /** Clock hour the run starts at (0 = midnight). */
  startHour: number;
  /** Sampled every `step` seconds; `level` has two points per sample (the window's low and high, in order). */
  step: number;
  level: number[];
  inflow: number[];
  out: number[];
  running: number[];
  powerOff?: [number, number];
  storm?: [number, number];
  stats: {
    maxLevel: number;
    alarmAt?: number;
    floodAt?: number;
    floodLitres: number;
    starts: number[];
    maxStartsPerHour: number;
    runHours: number[];
    energyKWh: number;
    inLitres: number;
    pumpedLitres: number;
    longestStandH: number;
    assistRuns: number;
    timerRuns: number;
  };
}

function rng(seed: string) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 3432918353), (h = (h << 13) | (h >>> 19));
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One day of the fixtures' discharges, L/s for each second. */
function dayInflow(p: PitDesign, seed: string): Float32Array {
  const q = new Float32Array(86400);
  const rand = rng(seed);
  const cum: number[] = [];
  HOURLY.reduce((a, w, i) => (cum[i] = a + w), 0);
  const tot = cum[23];
  const when = () => {
    const u = rand() * tot;
    const h = cum.findIndex((c) => c >= u);
    return (h + rand()) * 3600;
  };
  for (const f of p.fixtures) {
    const u = USE[f.kind];
    const mean = u.perDay * p.usage;
    // Poisson count of uses
    let n = 0;
    for (let L = Math.exp(-mean), k = 1; (k *= rand()) > L; ) n++;
    for (let i = 0; i < n; i++) {
      const t0 = Math.floor(when()), rate = u.litres / u.seconds;
      for (let t = t0; t < Math.min(86400, t0 + u.seconds); t++) q[t] += rate;
    }
  }
  return q;
}

/** Rain on the catchment: a burst peaking at `peakS`, e-folding over 10 minutes, delayed 3 minutes by the drains. */
function stormInflow(p: PitDesign, n: number, peakS: number): Float32Array {
  const q = new Float32Array(n);
  const tau = 600, k = 180;
  let y = 0;
  for (let t = 0; t < n; t++) {
    const rain = p.inflow.stormLs * Math.exp(-Math.abs(t - peakS) / tau);
    y += (rain - y) / k;
    q[t] = y;
  }
  return q;
}

/** Run one scenario, one-second steps. */
export function simulatePit(p: PitDesign, scenario: PitScenario): PitSim {
  const sewage = p.inflow.dailyLitres - p.inflow.baseLs * 86400 > 1;
  const storm = p.inflow.stormLs > 0;
  // storm runs: 3 h (longer with a power cut), the storm peaks 45 min in, on top of the day's flows at that time
  // the storm is the harder test for a power cut or a failed pump whenever rain reaches the pit
  const stormBased = storm && scenario !== "day";
  const cutH = p.powerCutHours;
  const hours = stormBased ? Math.max(3, scenario === "power_cut" ? cutH + 1.5 : 3) : 24;
  const startHour = stormBased ? 17 : 0;
  const n = Math.round(hours * 3600);
  const day = sewage ? dayInflow(p, `${p.id}:${p.level}`) : undefined;
  const rain = stormBased ? stormInflow(p, n, 2700) : undefined;
  const qin = new Float32Array(n);
  for (let t = 0; t < n; t++) qin[t] = p.inflow.baseLs + (day ? day[(t + startHour * 3600) % 86400] : 0) + (rain ? rain[t] : 0);
  // power off: 18:00 for the day runs, 15 min before the storm peaks for storm runs
  const powerOff: [number, number] | undefined = scenario === "power_cut" ? (stormBased ? [1800, 1800 + cutH * 3600] : [18 * 3600, 18 * 3600 + cutH * 3600]) : undefined;
  const broken = new Set(scenario === "pump_failure" ? [0] : []);
  const L = p.levels, A = p.area;
  const cap = A * p.depth;
  const flowAt = (running: number, h: number) => {
    if (!running) return 0;
    if (running >= 2 && p.pumps.both) return p.pumps.both.flowLs;
    const f = Math.max(0, Math.min(1, (h - L.stop) / Math.max(0.01, L.alarm - L.stop)));
    return p.pumps.atStop.flowLs + (p.pumps.atAlarm.flowLs - p.pumps.atStop.flowLs) * f;
  };
  const step = Math.max(10, Math.round(n / 1200));
  const out: PitSim = {
    scenario,
    title: "",
    hours,
    startHour,
    step,
    level: [],
    inflow: [],
    out: [],
    running: [],
    powerOff,
    storm: stormBased ? [1800, 1800 + 3600] : undefined,
    stats: { maxLevel: 0, floodLitres: 0, starts: Array(p.pumps.count).fill(0), maxStartsPerHour: 0, runHours: Array(p.pumps.count).fill(0), energyKWh: 0, inLitres: 0, pumpedLitres: 0, longestStandH: 0, assistRuns: 0, timerRuns: 0 },
  };
  let vol = A * L.stop * 0.98; // starts just pumped down
  let running: number[] = [];
  let next = 0;
  // the oldest fresh inflow above the stop level: how long sewage has stood, and when the timer pumps it out
  let waitingFrom: number | undefined;
  const startsByHour = new Map<string, number>();
  // each sample window keeps its low and high level (short pump-downs show) and whether a pump ran in it
  let wLo = Infinity, wHi = -Infinity, tLo = 0, tHi = 0, wRun = 0, wIn = 0, wOut = 0;
  for (let t = 0; t < n; t++) {
    const power = !powerOff || t < powerOff[0] || t >= powerOff[1];
    const h = Math.min(p.depth, vol / A);
    const avail = [...Array(p.pumps.count).keys()].filter((k) => !broken.has(k) && power);
    if (!power) running = [];
    running = running.filter((k) => avail.includes(k));
    const startPump = () => {
      const free = avail.filter((k) => !running.includes(k));
      if (!free.length) return false;
      const k = free.includes(next % p.pumps.count) ? next % p.pumps.count : free[0];
      if (!running.length && waitingFrom !== undefined) out.stats.longestStandH = Math.max(out.stats.longestStandH, (t - waitingFrom) / 3600);
      running.push(k);
      next = k + 1;
      out.stats.starts[k]++;
      const key = `${k}:${Math.floor(t / 3600)}`;
      startsByHour.set(key, (startsByHour.get(key) ?? 0) + 1);
      return true;
    };
    if (!running.length && h >= L.start) startPump();
    // the controller's timer: pump down sewage that has stood too long
    else if (!running.length && p.pumpOutHours > 0 && waitingFrom !== undefined && t - waitingFrom >= p.pumpOutHours * 3600 && startPump()) out.stats.timerRuns++;
    if (running.length === 1 && L.assist !== undefined && h >= L.assist && startPump()) out.stats.assistRuns++;
    if (running.length && h <= L.stop) {
      running = [];
      waitingFrom = undefined;
    }
    const qo = Math.min(flowAt(running.length, h), vol * 1000 + qin[t]);
    vol += (qin[t] - qo) / 1000;
    out.stats.inLitres += qin[t];
    out.stats.pumpedLitres += qo;
    for (const k of running) out.stats.runHours[k] += 1 / 3600;
    if (running.length) out.stats.energyKWh += (running.length >= 2 && p.pumps.both ? p.pumps.both.kWin * 2 : p.pumps.atStop.kWin) / 3600;
    const lv = Math.min(p.depth, vol / A);
    if (waitingFrom === undefined && !running.length && lv > L.stop + 0.005) waitingFrom = t;
    out.stats.maxLevel = Math.max(out.stats.maxLevel, lv);
    if (out.stats.alarmAt === undefined && lv >= L.alarm) out.stats.alarmAt = t;
    if (vol > cap) {
      if (out.stats.floodAt === undefined) out.stats.floodAt = t;
      out.stats.floodLitres = Math.max(out.stats.floodLitres, (vol - cap) * 1000);
    }
    if (lv < wLo) (wLo = lv), (tLo = t);
    if (lv > wHi) (wHi = lv), (tHi = t);
    wRun = Math.max(wRun, running.length);
    wIn = Math.max(wIn, qin[t]);
    wOut = Math.max(wOut, qo);
    if ((t + 1) % step === 0 || t === n - 1) {
      out.level.push(...(tLo <= tHi ? [wLo, wHi] : [wHi, wLo]).map(r2));
      out.inflow.push(r2(wIn));
      out.out.push(r2(wOut));
      out.running.push(wRun);
      wLo = Infinity, wHi = -Infinity, wRun = 0, wIn = 0, wOut = 0;
    }
  }
  if (!running.length && waitingFrom !== undefined) out.stats.longestStandH = Math.max(out.stats.longestStandH, (n - waitingFrom) / 3600);
  out.stats.maxStartsPerHour = Math.max(0, ...startsByHour.values());
  out.stats.maxLevel = r2(out.stats.maxLevel);
  out.stats.floodLitres = Math.round(out.stats.floodLitres);
  out.stats.energyKWh = r2(out.stats.energyKWh);
  out.stats.inLitres = Math.round(out.stats.inLitres);
  out.stats.pumpedLitres = Math.round(out.stats.pumpedLitres);
  out.stats.runHours = out.stats.runHours.map((x) => r2(x));
  out.stats.longestStandH = r1(out.stats.longestStandH);
  const hhmm = (s: number) => `${String(Math.floor((startHour * 3600 + s) / 3600) % 24).padStart(2, "0")}:${String(Math.floor(((startHour * 3600 + s) % 3600) / 60)).padStart(2, "0")}`;
  out.title =
    scenario === "day"
      ? "Normal day"
      : scenario === "storm"
        ? `Design storm (${p.inflow.rainMmH} mm/h peak)`
        : scenario === "power_cut"
          ? `Power cut ${hhmm(powerOff![0])}–${hhmm(powerOff![1])}${stormBased ? " in the storm" : ""}`
          : `Duty pump fails${stormBased ? " in the storm" : ""}`;
  return out;
}

/** The scenarios that apply to a pit. */
export function pitScenarios(p: PitDesign): PitScenario[] {
  const sewage = p.fixtures.length > 0;
  const s: PitScenario[] = [];
  if (sewage || p.inflow.baseLs > 0) s.push("day");
  if (p.inflow.stormLs > 0) s.push("storm");
  s.push("power_cut", "pump_failure");
  return s;
}

export interface PitStudy {
  pit: PitDesign;
  sims: PitSim[];
  issues: string[];
}

/** Every scenario for a pit, and what they show. */
export function studyPit(p: PitDesign): PitStudy {
  const sims = pitScenarios(p).map((s) => simulatePit(p, s));
  const issues: string[] = [];
  const clock = (sim: PitSim, s: number) => `${String(Math.floor((sim.startHour * 3600 + s) / 3600) % 24).padStart(2, "0")}:${String(Math.floor(((sim.startHour * 3600 + s) % 3600) / 60)).padStart(2, "0")}`;
  for (const sim of sims) {
    const st = sim.stats;
    if (st.floodAt !== undefined) {
      const extra = st.floodLitres / 1000;
      const deeper = r1(extra / p.area + 0.05);
      issues.push(
        `${sim.title}: the pit fills to the floor at ${clock(sim, st.floodAt)} and about ${Math.round(st.floodLitres)} L backs up${p.kind === "sewage" ? " through the basement's floor drains and WCs" : " over the area"} — ${
          sim.scenario === "power_cut"
            ? `put the pump panel on a standby generator / UPS, or hold it: ${deeper} m deeper (or a larger pit)`
            : sim.scenario === "pump_failure"
              ? p.pumps.count < 2 ? "fit a standby pump" : "larger pumps: one alone cannot keep up"
              : "larger pumps or more storage"
        }.`,
      );
    }
    if (st.maxStartsPerHour > STARTS) issues.push(`${sim.title}: a pump starts ${st.maxStartsPerHour} times in one hour (limit ${STARTS}): raise the start level for a larger volume per cycle.`);
  }
  const day = sims.find((s) => s.scenario === "day");
  if (p.kind === "sewage" && day && day.stats.longestStandH > 8)
    issues.push(`sewage stands in the pit up to ${day.stats.longestStandH} h between pump-outs: in Kuwait's heat it turns septic (hydrogen-sulphide odour, corrosion) — set the controller's pump-out timer (pumpOutHours ≤ 6) or a smaller pit.`);
  return { pit: p, sims, issues };
}

// ---------------------------------------------------------------------------------------------------------------
// Report and chart
// ---------------------------------------------------------------------------------------------------------------

const KIND_LABEL: Record<FixtureKind, string> = { wc: "WC", basin: "basin", sink: "sink", shower: "shower", bath: "bath", dishwasher: "dishwasher", washing_machine: "washing machine", floor_drain: "floor drain", tap: "tap" };
const plural = (n: number, s: string) => `${n} ${s}${n === 1 ? "" : s.endsWith("h") ? "es" : "s"}`;

export function pumpPitReport(studies: PitStudy[], levelNames: string[], levelIssues: string[] = []): string {
  const out: string[] = [];
  for (const i of levelIssues) out.push(`! ${i}`);
  for (const { pit: p, sims, issues } of studies) {
    const hhmm = (sim: PitSim, s: number) => `${String(Math.floor((sim.startHour * 3600 + s) / 3600) % 24).padStart(2, "0")}:${String(Math.floor(((sim.startHour * 3600 + s) % 3600) / 60)).padStart(2, "0")}`;
    const name = `${p.kind === "sewage" ? "Sewage pump pit" : "Drainage sump"} ${p.id}`;
    out.push(`${name} — ${levelNames[p.level]} (floor ${p.floorZ.toFixed(2)} m)${p.room ? `, in the ${p.room}` : ""}${p.explicit ? "" : "  [SUGGESTED — not in the plan yet]"}`);
    out.push(`  Chamber: ${p.size[0]} × ${p.size[1]} m inside, ${p.depth} m deep below the floor; waterproofed RC, 200 mm walls${p.kind === "sewage" ? ", sealed bolted cover, vent Ø50 to the roof" : ", galvanised grating cover"}.`);
    const counts = new Map<string, number>();
    for (const f of p.fixtures) counts.set(KIND_LABEL[f.kind], (counts.get(KIND_LABEL[f.kind]) ?? 0) + 1);
    const serves: string[] = [];
    if (p.fixtures.length) serves.push(`${[...counts].map(([k, n]) => plural(n, k)).join(", ")} — ${p.du} DU, peak ${p.inflow.peakLs} L/s (EN 12056-2)`);
    if (p.areas.length) serves.push(`rain on ${p.areas.map((a) => `${a.name} ${a.m2} m²`).join(", ")} — ${p.inflow.stormLs} L/s at ${p.inflow.rainMmH} mm/h`);
    if (p.inflow.baseLs > 0) serves.push(`steady ${r1(p.inflow.baseLs * 3600)} L/h (groundwater / other)`);
    out.push(`  Serves: ${serves.join("; ") || "nothing yet"}.${p.inflow.dailyLitres ? ` About ${p.inflow.dailyLitres} L a day.` : ""}`);
    const m = p.pumps.model;
    out.push(
      `  Pumps: ${p.pumps.count} × ${m.model} submersible, ${PUMP_TYPE[m.type]}, ${m.kW} kW${p.pumps.count > 1 ? ", duty / standby alternating" : ""}: one delivers ${p.pumps.atStop.flowLs} L/s at ${p.pumps.atStop.headM} m${p.pumps.both ? `; both ${p.pumps.both.flowLs} L/s at ${p.pumps.both.headM} m` : ""}.`,
    );
    out.push(
      `  Rising main: ${p.main.label}, ${p.main.length} m, ${p.pumps.atStop.velocity} m/s (keep ${V_MIN}–${V_MAX}); lifts ${p.main.staticHead} m to a loop 0.3 m above ground (backflow), then to [${r1(p.main.discharge[0])}, ${r1(p.main.discharge[1])}]; non-return + gate valve on each pump, guide rails and auto-couplings.`,
    );
    const L = p.levels;
    out.push(`  Levels above the pit floor (m): stop ${L.stop} · start ${L.start}${L.assist !== undefined ? ` · second pump ${L.assist}` : ""} · alarm ${L.alarm} · incoming drain ${L.inlet} · floor ${L.top}.${p.pumpOutHours ? ` Pump-out timer: ${p.pumpOutHours} h.` : ""}`);
    const avg = p.inflow.dailyLitres / 24;
    out.push(
      `  Volumes: ${Math.round(p.volumes.effective * 1000)} L per pump cycle; ${Math.round(p.volumes.emergency * 1000)} L above the alarm${avg > 1 ? ` (${r1((p.volumes.emergency * 1000) / avg)} h of average flow)` : ""}${p.inflow.stormLs > 0 ? `, ${r1((p.volumes.emergency * 1000) / p.inflow.stormLs / 60)} min of the storm peak` : ""}.`,
    );
    out.push("  Simulation (1 s steps):");
    for (const sim of sims) {
      const st = sim.stats;
      const bits = [`peak level ${st.maxLevel} m`];
      if (st.floodAt !== undefined) bits.push(`FLOODS at ${hhmm(sim, st.floodAt)} (${st.floodLitres} L over the floor)`);
      else if (st.alarmAt !== undefined) bits.push(`alarm at ${hhmm(sim, st.alarmAt)}, ${r2(p.depth - st.maxLevel)} m to spare`);
      else bits.push(`${r2(L.alarm - st.maxLevel)} m below the alarm`);
      const starts = st.starts.reduce((a, b) => a + b, 0);
      if (starts) bits.push(`${plural(starts, "start")}${p.pumps.count > 1 ? ` (${st.starts.join(" / ")})` : ""}, at most ${st.maxStartsPerHour} an hour${st.timerRuns ? `, ${st.timerRuns} by the timer` : ""}`);
      if (st.assistRuns) bits.push(`second pump ran ${st.assistRuns}×`);
      if (sim.scenario === "day") bits.push(`${Math.round(st.inLitres)} L in, ${st.energyKWh} kWh${p.kind === "sewage" ? `, sewage stands up to ${st.longestStandH} h` : ""}`);
      out.push(`    ${sim.title}: ${bits.join("; ")}.`);
    }
    const all = [...p.issues, ...issues];
    if (all.length) {
      out.push("  Issues:");
      for (const i of all) out.push(`    - ${i}`);
    }
    if (p.notes.length) for (const n of p.notes) out.push(`  Note: ${n}`);
    if (!p.explicit)
      out.push(
        `  Add it: add_elements level '${levelNames[p.level]}' { pumpPits: [${JSON.stringify({ id: p.id, kind: p.kind, position: p.at.map((x) => r2(x)), size: p.size })}] }`,
      );
    out.push("");
  }
  out.push("Assumptions:");
  out.push("  - Inflow: EN 12056-2 discharge units (WC 2.0, shower 0.6, basin 0.5, others 0.8), K = 0.5; a household's day of use (WC 5×6 L, shower 2×60 L, washing machine 1.5×50 L…) spread over Kuwaiti hours, seeded so runs repeat.");
  out.push("  - Rain: a burst peaking at the design intensity, e-folding over 10 minutes; runoff paving 0.95, gravel / turf 0.6, planting / lawn 0.3; walls draining into a court are not counted (add them as extraArea).");
  out.push(`  - Pumps: generic submersible curves (not one maker's), at most ${STARTS} starts an hour each (alternating pumps share them) at the worst steady inflow, runs of 15 s or more; system curve = static lift + Darcy–Weisbach in PE100 (k 0.05 mm) + valves and bends (ζ ${r1(ZETA)}).`);
  out.push("  - Levels: the incoming drain falls 1:60 (1:100 for surface water) from the farthest fixture; the rising main loops 0.3 m above ground before it falls to the sewer (EN 12056-4 backflow loop).");
  return out.join("\n");
}

/** Chart: the pit level through each scenario, the switch levels, and when the pumps run. */
export function pumpPitSVG(st: PitStudy, levelName: string): string {
  const p = st.pit;
  const W = 1400, n = st.sims.length, cols = n > 2 ? 2 : n, rows = Math.ceil(n / cols);
  const PW = (W - 60 - (cols - 1) * 40) / cols, PH = 300, top = 92;
  const H = top + rows * (PH + 70) + 10;
  const font = `font-family="Liberation Sans, Helvetica, Arial, sans-serif"`;
  const o: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" ${font}><rect width="${W}" height="${H}" fill="#fff"/>`];
  o.push(`<text x="30" y="40" font-size="24" font-weight="bold" fill="#1d2b36">${p.kind === "sewage" ? "Sewage pump pit" : "Drainage sump"} ${p.id} — ${esc(levelName)}${p.explicit ? "" : " (suggested)"}</text>`);
  o.push(`<text x="30" y="66" font-size="14" fill="#55606a">${p.size[0]} × ${p.size[1]} × ${p.depth} m deep · ${p.pumps.count} × ${p.pumps.model.model} ${p.pumps.model.kW} kW · ${p.pumps.atStop.flowLs} L/s at ${p.pumps.atStop.headM} m · rising main ${p.main.label} ${p.pumps.atStop.velocity} m/s</text>`);
  const lines: [string, number | undefined, string][] = [
    ["floor", p.levels.top, "#b03a2e"],
    ["alarm", p.levels.alarm, "#d68910"],
    ["2nd pump", p.levels.assist, "#7d8c99"],
    ["start", p.levels.start, "#2e86c1"],
    ["stop", p.levels.stop, "#7d8c99"],
  ];
  st.sims.forEach((sim, i) => {
    const x0 = 30 + (i % cols) * (PW + 40), y0 = top + Math.floor(i / cols) * (PH + 70);
    const gx = x0 + 44, gw = PW - 110, gy = y0 + 30, gh = PH - 70;
    const ymax = p.depth * 1.08;
    const Y = (h: number) => gy + gh - (Math.min(h, ymax) / ymax) * gh;
    const X = (k: number) => gx + (k / Math.max(1, sim.running.length)) * gw;
    const st2 = sim.stats;
    const bad = st2.floodAt !== undefined;
    o.push(`<rect x="${x0}" y="${y0}" width="${PW}" height="${PH + 40}" rx="8" fill="${bad ? "#fdf2f0" : "#f7f9fa"}" stroke="${bad ? "#e6b0aa" : "#e1e6ea"}"/>`);
    o.push(`<text x="${x0 + 14}" y="${y0 + 21}" font-size="15" font-weight="bold" fill="#1d2b36">${esc(sim.title)}</text>`);
    const verdict = bad ? `floods ${Math.round(st2.floodLitres)} L` : st2.alarmAt !== undefined ? `alarm, ${r2(p.depth - st2.maxLevel)} m spare` : `peak ${st2.maxLevel} m, ${r2(p.levels.alarm - st2.maxLevel)} m under alarm`;
    o.push(`<text x="${x0 + PW - 14}" y="${y0 + 21}" font-size="13" text-anchor="end" fill="${bad ? "#b03a2e" : st2.alarmAt !== undefined ? "#b9770e" : "#1e8449"}" font-weight="bold">${verdict}</text>`);
    // shaded spans: power off, storm
    const span = (a: number, b: number, fill: string, label: string) => {
      const xa = gx + (a / (sim.hours * 3600)) * gw, xb = gx + (Math.min(b, sim.hours * 3600) / (sim.hours * 3600)) * gw;
      o.push(`<rect x="${xa}" y="${gy}" width="${Math.max(1, xb - xa)}" height="${gh}" fill="${fill}"/><text x="${xa + 4}" y="${gy + 13}" font-size="11" fill="#6c7a86">${label}</text>`);
    };
    if (sim.storm) span(sim.storm[0], sim.storm[1], "#eaf2f8", "storm");
    if (sim.powerOff) span(sim.powerOff[0], sim.powerOff[1], "#f4ecf7", "power off");
    // switch levels
    for (const [label, h, col] of lines) {
      if (h === undefined) continue;
      o.push(`<line x1="${gx}" x2="${gx + gw}" y1="${Y(h)}" y2="${Y(h)}" stroke="${col}" stroke-width="1" stroke-dasharray="${label === "floor" ? "0" : "5 4"}"/><text x="${gx + gw + 5}" y="${Y(h) + 4}" font-size="11" fill="${col}">${label}</text>`);
    }
    // axes
    for (let k = 0; k <= 4; k++) {
      const h = (p.depth * k) / 4;
      o.push(`<text x="${gx - 6}" y="${Y(h) + 4}" font-size="11" text-anchor="end" fill="#7f8c8d">${+h.toFixed(2)}</text>`);
    }
    const ticks = sim.hours <= 6 ? sim.hours * 2 : 8;
    for (let k = 0; k <= ticks; k++) {
      const s = (k / ticks) * sim.hours * 3600;
      const hh = (sim.startHour + s / 3600) % 24;
      o.push(`<text x="${gx + (k / ticks) * gw}" y="${gy + gh + 16}" font-size="11" text-anchor="middle" fill="#7f8c8d">${String(Math.floor(hh)).padStart(2, "0")}:${String(Math.round((hh % 1) * 60)).padStart(2, "0")}</text>`);
    }
    o.push(`<text x="${gx - 34}" y="${gy + gh / 2}" font-size="11" fill="#7f8c8d" transform="rotate(-90 ${gx - 34} ${gy + gh / 2})" text-anchor="middle">level above pit floor, m</text>`);
    // pumps running: a strip under the axis
    const sy = gy + gh + 24;
    let k0 = -1;
    for (let k = 0; k <= sim.running.length; k++) {
      const on = k < sim.running.length && sim.running[k] > 0;
      if (on && k0 < 0) k0 = k;
      if (!on && k0 >= 0) {
        const two = sim.running.slice(k0, k).some((r) => r > 1);
        o.push(`<rect x="${X(k0)}" y="${sy}" width="${Math.max(1, X(k) - X(k0))}" height="8" fill="${two ? "#1e8449" : "#52be80"}"/>`);
        k0 = -1;
      }
    }
    o.push(`<text x="${gx}" y="${sy + 22}" font-size="11" fill="#6c7a86">pumps running${p.pumps.count > 1 ? " (dark: both)" : ""}</text>`);
    // the level
    const XL = (k: number) => gx + (k / Math.max(1, sim.level.length - 1)) * gw;
    const pts = sim.level.map((h, k) => `${XL(k).toFixed(1)},${Y(h).toFixed(1)}`).join(" ");
    o.push(`<polyline points="${pts}" fill="none" stroke="#1f618d" stroke-width="1.6"/>`);
    if (bad) o.push(`<circle cx="${gx + (st2.floodAt! / (sim.hours * 3600)) * gw}" cy="${Y(p.depth)}" r="5" fill="#b03a2e"/>`);
  });
  o.push("</svg>");
  return o.join("");
}
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// ---------------------------------------------------------------------------------------------------------------
// 3D
// ---------------------------------------------------------------------------------------------------------------

/** The pits in 3D: RC chamber under the floor, water, pumps on guide rails, cover, valves, the rising main, panel. */
export function pumpPitsNode(pits: PitDesign[], infos: { elevation: number; height: number; segments: WallSegment[] }[]): SceneNode | undefined {
  const mine = pits.filter((p) => p.explicit);
  if (!mine.length) return undefined;
  const mb = new MeshBuilder();
  for (const p of mine) {
    const info = infos[p.level];
    const fz = p.floorZ, [cx, cy] = p.at, [w, l] = p.size, t = 0.2;
    const zb = fz - p.depth;
    const x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - l / 2, y1 = cy + l / 2;
    // chamber: base slab and four walls, kept just under the floor slab's top
    mb.box("concrete_dark", [x0 - t, y0 - t, zb - t], [x1 + t, y1 + t, zb]);
    mb.box("concrete_dark", [x0 - t, y0 - t, zb], [x0, y1 + t, fz - 0.02]);
    mb.box("concrete_dark", [x1, y0 - t, zb], [x1 + t, y1 + t, fz - 0.02]);
    mb.box("concrete_dark", [x0, y0 - t, zb], [x1, y0, fz - 0.02]);
    mb.box("concrete_dark", [x0, y1, zb], [x1, y1 + t, fz - 0.02]);
    // water at the start level
    mb.flat("water", [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], zb + p.levels.start * 0.9);
    // pumps side by side along the longer side, each on its auto-coupling and guide rails
    const along: Vec2 = w >= l ? [1, 0] : [0, 1];
    const n = p.pumps.count, gap = Math.min(0.45, (Math.max(w, l) - 0.3) / Math.max(1, n));
    const tops: Vec3[] = [];
    for (let k = 0; k < n; k++) {
      const o = (k - (n - 1) / 2) * gap;
      const [px, py] = v2.add(p.at, v2.scale(along, o));
      mb.cylinder("metal_iron", [px, py, zb + 0.02], 0.15, 0.15, 0.12, 20);
      mb.cylinder(p.kind === "sewage" ? "paint_blue" : "paint_gray", [px, py, zb + 0.14], 0.11, 0.1, 0.34, 20);
      mb.rod("metal_steel", [px - 0.06, py + 0.14, zb + 0.02], [px - 0.06, py + 0.14, fz - 0.05], 0.012, 6);
      mb.rod("metal_steel", [px + 0.06, py + 0.14, zb + 0.02], [px + 0.06, py + 0.14, fz - 0.05], 0.012, 6);
      // discharge up the rail side, through the cover
      mb.rod("metal_steel", [px, py + 0.14, zb + 0.1], [px, py + 0.14, fz + 0.9], 0.04, 12);
      // non-return and gate valves above the cover
      mb.block("metal_iron", px, py + 0.14, fz + 0.3, 0.13, 0.13, 0.16);
      mb.block("metal_iron", px, py + 0.14, fz + 0.58, 0.11, 0.11, 0.12);
      mb.cylinder("paint_red", [px, py + 0.14, fz + 0.7], 0.07, 0.07, 0.02, 14);
      tops.push([px, py + 0.14, fz + 0.9]);
    }
    // cover flush with the floor finish
    mb.box(p.kind === "sewage" ? "metal_iron" : "metal_steel", [x0 - 0.05, y0 - 0.05, fz + 0.005], [x1 + 0.05, y1 + 0.05, fz + 0.018]);
    // manifold and the rising main to the ceiling, turning toward the discharge
    const ceil = fz + info.height - 0.35;
    if (tops.length > 1) mb.rod("plastic_black", tops[0], tops[tops.length - 1], 0.046, 12);
    const mid: Vec3 = tops.length ? [(tops[0][0] + tops[tops.length - 1][0]) / 2, (tops[0][1] + tops[tops.length - 1][1]) / 2, fz + 0.9] : [cx, cy, fz + 0.9];
    mb.rod("plastic_black", mid, [mid[0], mid[1], ceil], 0.046, 12);
    const dir = v2.norm(v2.sub(p.main.route[1] ?? p.main.discharge, p.at));
    const turn: Vec3 = [mid[0] + (dir[0] || 0) * 0.8, mid[1] + (dir[1] || 0) * 0.8, ceil];
    mb.rod("plastic_black", [mid[0], mid[1], ceil], turn, 0.046, 12);
    mb.rod("plastic_black", turn, [turn[0], turn[1], fz + info.height], 0.046, 12);
    // sewage pits are vented to the roof
    if (p.kind === "sewage") mb.rod("plastic_gray", [x1 - 0.12, y1 - 0.12, fz + 0.02], [x1 - 0.12, y1 - 0.12, fz + info.height], 0.028, 10);
    // control panel with the alarm beacon on the nearest wall
    let best: { d: number; q: Vec2; s: WallSegment } | undefined;
    for (const s of info.segments) {
      const r = pointSegment(p.at, s.a, s.b);
      if (!best || r.dist < best.d) best = { d: r.dist, q: v2.lerp(s.a, s.b, r.t), s };
    }
    if (best && best.d < 6) {
      const along2 = v2.norm(v2.sub(best.s.b, best.s.a));
      let nrm: Vec2 = [-along2[1], along2[0]];
      if (v2.dot(nrm, v2.sub(p.at, best.q)) < 0) nrm = [-nrm[0], -nrm[1]];
      const c = v2.add(best.q, v2.scale(nrm, best.s.thickness / 2 + 0.08));
      const hw = v2.scale(along2, 0.2), hd = v2.scale(nrm, 0.08);
      mb.prism("paint_white", [v2.sub(v2.sub(c, hw), hd), v2.sub(v2.add(c, hw), hd), v2.add(v2.add(c, hw), hd), v2.add(v2.sub(c, hw), hd)], fz + 1.3, fz + 1.8);
      mb.cylinder("paint_red", [c[0], c[1], fz + 1.8], 0.04, 0.035, 0.07, 12);
    }
  }
  return { name: "pump_pits", kind: "group", meshes: mb.meshes(), children: [] };
}
