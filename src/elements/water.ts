/**
 * Water hydraulics, the way a Kuwaiti villa is plumbed: the ground tank fills from the MEW supply, a transfer pump
 * lifts it to the roof tanks, and a booster set on the roof feeds the house (or the roof tanks feed it by gravity).
 * Electric storage heaters serve each wet room.
 *
 *  - Peak flows: DIN 1988-300 (residential simultaneity) from each outlet's design flow, per segment.
 *  - Pipe sizes: the smallest PPR (or PEX / copper) size that keeps the velocity under 2 m/s in branches and
 *    1.5 m/s in risers and mains.
 *  - Pressure: static head from the source, minus Darcy–Weisbach friction (Swamee–Jain) and fitting losses,
 *    at every outlet, against EN 806 minimum flow pressures. Booster duty and setting.
 *  - Hot water: wait time and litres run off at each hot outlet; hot / cold pressure balance at mixers.
 *  - Summer: the "cold" water temperature from a roof tank in July–August.
 *  - Storage: daily demand (occupants + garden), roof and ground tank sizes; heaters and their reheat time.
 *  - Drainage: discharge units (EN 12056-2), stack flows against capacity, stacks that do not line up between floors.
 */
import { z } from "zod";
import { pointInPolygon, v2, type Vec2 } from "../geometry/math.js";
import { KIND_RE, type FixtureKind, type PipeRun, type ServicesLayout } from "./services.js";

export const WaterSchema = z
  .object({
    supply: z
      .enum(["tank_booster", "tank_gravity", "mains"])
      .default("tank_booster")
      .describe("tank_booster (default: roof tanks and a booster pump set on the roof) | tank_gravity (roof tanks, no pump) | mains (direct from the street supply)"),
    boosterBar: z.number().positive().max(8).default(2.5).describe("Booster set cut-out pressure at the pump, bar"),
    mainsBar: z.number().positive().max(8).default(1.5).describe("Street supply pressure at ground level, bar (mains supply only)"),
    tankStand: z.number().min(0).max(6).default(1).describe("Height of the roof tank base above the roof slab, m"),
    tank: z.enum(["exposed", "shaded", "insulated"]).default("exposed").describe("Roof tank exposure: sets the summer cold-water temperature"),
    pipe: z.enum(["ppr", "pex", "copper"]).default("ppr").describe("Supply pipe material"),
    occupants: z.number().int().positive().optional().describe("People living in the house (default: two per bedroom)"),
    litresPerPersonDay: z.number().positive().default(450).describe("Daily use per person (Kuwait ≈ 450 L)"),
    heaterKW: z.number().positive().default(2).describe("Element rating of each storage water heater, kW"),
  })
  .prefault({})
  .describe("Water supply and hydraulics settings");
export type WaterSpec = z.output<typeof WaterSchema>;

/** Design flow (L/s) cold / hot, minimum flow pressure (bar), outlet height (m), discharge units (L/s). */
const OUTLET: Record<FixtureKind, { cold: number; hot: number; pmin: number; h: number; du: number; label: string }> = {
  wc: { cold: 0.13, hot: 0, pmin: 0.5, h: 0.8, du: 2.0, label: "WC cistern" },
  basin: { cold: 0.07, hot: 0.07, pmin: 1.0, h: 0.9, du: 0.5, label: "basin mixer" },
  sink: { cold: 0.07, hot: 0.07, pmin: 1.0, h: 1.0, du: 0.8, label: "sink mixer" },
  shower: { cold: 0.15, hot: 0.15, pmin: 1.0, h: 2.0, du: 0.6, label: "shower" },
  bath: { cold: 0.15, hot: 0.15, pmin: 1.0, h: 0.6, du: 0.8, label: "bath filler" },
  dishwasher: { cold: 0.07, hot: 0, pmin: 1.0, h: 0.3, du: 0.8, label: "dishwasher valve" },
  washing_machine: { cold: 0.15, hot: 0, pmin: 1.0, h: 0.9, du: 0.8, label: "washing machine valve" },
  floor_drain: { cold: 0, hot: 0, pmin: 0, h: 0, du: 0.8, label: "floor drain" },
  tap: { cold: 0.3, hot: 0, pmin: 1.0, h: 0.6, du: 0, label: "garden / utility tap" },
};
const MIXERS = new Set<FixtureKind>(["basin", "sink", "shower", "bath"]);

/** Pipe series: outside diameter → bore (mm). */
const PIPES = {
  ppr: { name: "PPR PN20", sizes: [[20, 13.2], [25, 16.6], [32, 21.2], [40, 26.6], [50, 33.4], [63, 42]], branchMin: 20, mainMin: 25, rough: 0.007 },
  pex: { name: "PEX", sizes: [[16, 11.6], [20, 15], [25, 20.4], [32, 26.2], [40, 32.6], [50, 40.8]], branchMin: 16, mainMin: 20, rough: 0.007 },
  copper: { name: "copper", sizes: [[15, 13.6], [22, 20.2], [28, 26.2], [35, 32.6], [42, 39.6], [54, 51.6]], branchMin: 15, mainMin: 22, rough: 0.0015 },
} as const;

/** Stack capacity (L/s) by size, primary-ventilated (EN 12056-2, table 11). */
const STACK_CAP: [number, number][] = [[50, 0.5], [75, 1.5], [90, 2.7], [100, 4.0], [125, 5.8], [150, 9.5]];

const SUMMER_TANK: Record<WaterSpec["tank"], number> = { exposed: 42, shaded: 37, insulated: 34 };
const RHO_G = 0.0981; // bar per metre of water
const DIST_H = 0.3; // supply pipes run in the walls / screed this high above the floor
const HOT_C = 60;
const IMP_GALLON = 4.546;

export interface WaterSegment {
  level: number;
  kind: "riser" | "main" | "branch" | "heater_feed" | "hot";
  /** cold / hot water. */
  water: "cold" | "hot";
  label: string;
  /** Plan path (risers: the riser position). */
  pts: Vec2[];
  /** Heights at the ends (m above datum). */
  z: [number, number];
  length: number;
  /** Peak design flow, L/s. */
  flow: number;
  od: number;
  bore: number;
  velocity: number;
  /** Friction + fittings, bar. */
  loss: number;
  /** Index in the level's services.pipes. */
  pipe?: number;
}

export interface WaterOutlet {
  id: string;
  level: number;
  room: string;
  kind: FixtureKind;
  label: string;
  at: Vec2;
  z: number;
  /** Flow pressure at the outlet at peak demand, bar. */
  cold?: number;
  hot?: number;
  required: number;
  /** Seconds until hot water arrives, litres run off first. */
  waitS?: number;
  waitL?: number;
  heater?: string;
  /** Summer temperature of the cold water at this outlet. */
  coldSummerC?: number;
  /** Segments from the source (indices into segments), cold and hot paths. */
  coldPath: number[];
  hotPath: number[];
}

export interface WaterHeater {
  id: string;
  level: number;
  room: string;
  at: Vec2;
  litres: number;
  kW: number;
  /** Winter reheat from 18 °C to 60 °C, minutes. */
  reheatMin: number;
  feeds: string[];
}

export interface WaterStack {
  id: string;
  level: number;
  at: Vec2;
  size: number;
  /** Discharge units on this stack (this floor and above), its flow and capacity (L/s). */
  du: number;
  flow: number;
  capacity: number;
  /** The stack this one drops into on the floor below, if any. */
  below?: string;
}

export interface WaterDesign {
  supply: WaterSpec["supply"];
  pipe: string;
  source: { at: Vec2; z: number; bar: number; level: number };
  peak: { cold: number; hot: number; total: number };
  booster?: { flowM3h: number; setBar: number; requiredBar: number; headM: number; kW: number };
  transfer?: { flowM3h: number; headM: number; kW: number };
  storage: { occupants: number; litresPerDay: number; gardenLitresPerDay: number; roof: { litres: number; tanks: string }; ground: { litres: number; m3: number } };
  coldSummerC: number;
  segments: WaterSegment[];
  outlets: WaterOutlet[];
  heaters: WaterHeater[];
  stacks: WaterStack[];
  issues: string[];
  assumptions: string[];
}

interface LevelIn {
  id: string;
  name?: string;
  rooms: { name: string; polygon: number[][] }[];
}
interface InfoIn {
  name: string;
  elevation: number;
  height: number;
  services: ServicesLayout;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const r1 = (n: number) => Math.round(n * 10) / 10;
const plen = (pts: Vec2[]) => pts.slice(1).reduce((a, p, i) => a + v2.dist(pts[i], p), 0);
const corners = (pts: Vec2[]) => {
  let n = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = v2.sub(pts[i], pts[i - 1]), b = v2.sub(pts[i + 1], pts[i]);
    if (Math.abs(a[0] * b[1] - a[1] * b[0]) > 1e-6 * (v2.len(a) * v2.len(b) + 1e-9)) n++;
  }
  return n;
};

/** DIN 1988-300 peak flow (residential) from the sum of design flows; never below the largest single outlet. */
export function peakFlow(sum: number, largest: number): number {
  if (sum <= 0) return 0;
  const din = sum > 0.2 ? 1.48 * sum ** 0.19 - 0.94 : sum;
  return Math.max(largest, Math.min(sum, din));
}

/** Friction and fitting loss in bar (Darcy–Weisbach with the Swamee–Jain friction factor). */
export function pipeLoss(flowLs: number, boreMm: number, length: number, zeta: number, roughMm: number, nu: number): { v: number; dp: number } {
  if (flowLs <= 0) return { v: 0, dp: 0 };
  const d = boreMm / 1000;
  const v = flowLs / 1000 / ((Math.PI * d * d) / 4);
  const re = (v * d) / nu;
  const f = re < 2300 ? 64 / re : 0.25 / Math.log10(roughMm / 1000 / (3.7 * d) + 5.74 / re ** 0.9) ** 2;
  const dp = ((f * length) / d + zeta) * (1000 * v * v) / 2 / 1e5;
  return { v, dp };
}

function sizeFor(series: (typeof PIPES)[keyof typeof PIPES], flow: number, vmax: number, min: number): [number, number] {
  for (const [od, bore] of series.sizes) {
    if (od < min) continue;
    const d = bore / 1000;
    if (flow / 1000 / ((Math.PI * d * d) / 4) <= vmax) return [od, bore];
  }
  const last = series.sizes[series.sizes.length - 1];
  return [last[0], last[1]];
}

export function designWater(project: { levels: LevelIn[]; water: WaterSpec }, infos: InfoIn[], gardenLitresPerDay = 0): WaterDesign {
  const spec = project.water;
  const series = PIPES[spec.pipe];
  const issues: string[] = [];
  const segments: WaterSegment[] = [];
  const outlets: WaterOutlet[] = [];
  const heaters: WaterHeater[] = [];
  const lvName = (li: number) => project.levels[li]?.name ?? infos[li]?.name ?? project.levels[li]?.id;
  const roomName = (li: number, ri: number) => (ri >= 0 ? project.levels[li].rooms[ri]?.name ?? `room ${ri}` : "outside");
  const nuCold = 0.75e-6, nuHot = 0.47e-6;

  const used = infos.map((_, li) => li).filter((li) => infos[li].services.points.some((p) => p.type === "inlet"));
  const roofZ = Math.max(...infos.filter((_, li) => project.levels[li].rooms.length).map((l) => l.elevation + l.height), 0);
  const top = used.length ? used.reduce((a, b) => (infos[b].elevation > infos[a].elevation ? b : a)) : 0;
  const riserAt: Vec2 = (infos[top]?.services.points.find((p) => p.type === "inlet")?.at as Vec2) ?? [0, 0];
  const source =
    spec.supply === "mains"
      ? { at: riserAt, z: -0.6, bar: spec.mainsBar, level: 0 }
      : spec.supply === "tank_gravity"
        ? { at: riserAt, z: roofZ + spec.tankStand + 0.3, bar: 0, level: top }
        : { at: riserAt, z: roofZ + 0.3, bar: spec.boosterBar, level: top };

  const coldSummerC = spec.supply === "mains" ? 35 : SUMMER_TANK[spec.tank];

  // ---- demand per level, per room, per heater ----
  type Fx = ServicesLayout["fixtures"][number];
  const fxOf = (li: number) => infos[li].services.fixtures.filter((f) => OUTLET[f.kind].cold > 0 || OUTLET[f.kind].hot > 0);
  const heaterOf = (li: number, f: Fx) => infos[li].services.pipes.find((p) => p.kind === "hot" && p.fixture === f.id)?.heater;
  const sumVR = (fs: { f: Fx; hot: boolean }[]) => {
    const vr = fs.map(({ f, hot }) => (hot ? OUTLET[f.kind].hot : OUTLET[f.kind].cold));
    return { sum: vr.reduce((a, b) => a + b, 0), max: Math.max(0, ...vr) };
  };
  /** Cold-side demand of everything a floor serves (cold outlets plus the heaters' hot draw). */
  const floorDemand = (li: number) => fxOf(li).flatMap((f) => [{ f, hot: false }, ...(f.hot && heaterOf(li, f) ? [{ f, hot: true }] : [])]);

  const addSeg = (s: Omit<WaterSegment, "velocity" | "loss" | "od" | "bore">, zeta: number, vmax: number, min: number): number => {
    const [od, bore] = sizeFor(series, s.flow, vmax, min);
    const { v, dp } = pipeLoss(s.flow, bore, s.length, zeta, series.rough, s.water === "hot" ? nuHot : nuCold);
    segments.push({ ...s, od, bore, velocity: r2(v), loss: dp });
    return segments.length - 1;
  };

  // ---- riser: from the source down (or up, for mains) past each floor's tee ----
  const floors = [...used].sort((a, b) => infos[b].elevation - infos[a].elevation);
  if (spec.supply === "mains") floors.reverse();
  const riserPath = new Map<number, number[]>();
  let zPrev = source.z;
  const chain: number[] = [];
  floors.forEach((li, k) => {
    const zTee = infos[li].elevation + DIST_H;
    const rest = floors.slice(k).flatMap(floorDemand);
    const { sum, max } = sumVR(rest);
    const seg = addSeg(
      { level: li, kind: "riser", water: "cold", label: k === 0 ? `riser from the ${spec.supply === "mains" ? "street supply" : spec.supply === "tank_gravity" ? "roof tank" : "booster set"} to ${lvName(li)}` : `riser to ${lvName(li)}`, pts: [riserAt, riserAt], z: [zPrev, zTee], length: Math.abs(zPrev - zTee) + (k === 0 ? 2 : 0), flow: peakFlow(sum, max) },
      k === 0 ? 3 : 0.5,
      1.5,
      series.mainMin,
    );
    chain.push(seg);
    zPrev = zTee;
    // across the floor to its inlet / manifold
    const inlet = infos[li].services.points.find((p) => p.type === "inlet")!.at as Vec2;
    const fl = sumVR(floorDemand(li));
    const off = Math.abs(inlet[0] - riserAt[0]) + Math.abs(inlet[1] - riserAt[1]);
    const path = [...chain];
    if (off > 5 && infos[li].services.points.find((p) => p.type === "inlet")!.auto)
      issues.push(`on ${lvName(li)} the stop valve is ${r1(off)} m from the riser, so the floor's water runs there and back: add a plumbing inlet at [${r2(riserAt[0])}, ${r2(riserAt[1])}] (level.plumbing type "inlet") to feed the floor from the riser.`);
    if (off > 0.05) path.push(addSeg({ level: li, kind: "main", water: "cold", label: `${lvName(li)}: riser to the floor's stop valve`, pts: [riserAt, [inlet[0], riserAt[1]], inlet], z: [zTee, zTee], length: off, flow: peakFlow(fl.sum, fl.max) }, 2 + 1.5, 1.5, series.mainMin));
    riserPath.set(li, path);
  });

  // ---- per floor: room mains, branches, heater feeds, hot branches ----
  for (const li of used) {
    const L = infos[li].services;
    const fl = fxOf(li);
    const base = riserPath.get(li)!;
    const zFloor = infos[li].elevation;
    const mainSeg = new Map<number, number>();
    const heaterSeg = new Map<string, number[]>();
    L.pipes.forEach((p, pi) => {
      if (p.kind !== "cold" || p.room === undefined || p.fixture || p.heater) return;
      const inRoom = fl.filter((f) => f.room === p.room);
      const { sum, max } = sumVR(inRoom.flatMap((f) => [{ f, hot: false }, ...(f.hot && heaterOf(li, f) ? [{ f, hot: true }] : [])]));
      mainSeg.set(p.room, addSeg({ level: li, kind: "main", water: "cold", label: `${lvName(li)}: main to ${roomName(li, p.room)}`, pts: p.pts, z: [zFloor + DIST_H, zFloor + DIST_H], length: plen(p.pts), flow: peakFlow(sum, max), pipe: pi }, corners(p.pts) * 1.0 + 1.5 + 0.5, 1.5, series.mainMin));
    });
    const toRoom = (ri: number | undefined) => (ri !== undefined && mainSeg.has(ri) ? [...base, mainSeg.get(ri)!] : base);
    L.pipes.forEach((p, pi) => {
      if (p.kind !== "cold" || !p.heater) return;
      const fed = fl.filter((f) => f.hot && heaterOf(li, f) === p.heater);
      const { sum, max } = sumVR(fed.map((f) => ({ f, hot: true })));
      const wh = L.points.find((q) => q.id === p.heater)!;
      const seg = addSeg({ level: li, kind: "heater_feed", water: "cold", label: `${lvName(li)}: feed to heater ${p.heater}`, pts: p.pts, z: [zFloor + DIST_H, zFloor + 1.6], length: plen(p.pts) + 1.3, flow: peakFlow(sum, max), pipe: pi }, corners(p.pts) + 1.5 + 2 + 3, 2, series.branchMin);
      heaterSeg.set(p.heater, [...toRoom(p.room), seg]);
      const hasBath = fed.some((f) => f.kind === "bath");
      const showers = fed.filter((f) => f.kind === "shower").length;
      const litres = hasBath ? 100 : showers > 1 ? 80 : showers ? 50 : 30;
      heaters.push({ id: p.heater, level: li, room: roomName(li, wh.room), at: wh.at, litres, kW: spec.heaterKW, reheatMin: Math.round((litres * 4.186 * (HOT_C - 18)) / spec.heaterKW / 60), feeds: fed.map((f) => f.id) });
    });
    for (const f of fl) {
      const O = OUTLET[f.kind];
      const zOut = zFloor + O.h;
      const o: WaterOutlet = { id: f.id, level: li, room: roomName(li, f.room), kind: f.kind, label: O.label, at: f.at, z: r2(zOut), required: O.pmin, coldPath: [], hotPath: [] };
      const cp = L.pipes.findIndex((p) => p.kind === "cold" && p.fixture === f.id);
      if (cp >= 0 && O.cold > 0) {
        const p = L.pipes[cp];
        const seg = addSeg({ level: li, kind: "branch", water: "cold", label: `${lvName(li)}: ${O.label} (${o.room})`, pts: p.pts, z: [zFloor + DIST_H, zOut], length: plen(p.pts) + Math.abs(O.h - DIST_H), flow: O.cold, pipe: cp }, corners(p.pts) + 1 + 1.5 + 2, 2, series.branchMin);
        o.coldPath = [...toRoom(p.room), seg];
        o.coldSummerC = coldSummerC;
      }
      const hp = L.pipes.findIndex((p) => p.kind === "hot" && p.fixture === f.id);
      if (hp >= 0 && O.hot > 0) {
        const p = L.pipes[hp];
        const feed = heaterSeg.get(p.heater!);
        if (feed) {
          const len = plen(p.pts) + Math.abs(O.h - 1.6);
          const seg = addSeg({ level: li, kind: "hot", water: "hot", label: `${lvName(li)}: hot to ${O.label} (${o.room})`, pts: p.pts, z: [zFloor + 1.6, zOut], length: len, flow: O.hot, pipe: hp }, corners(p.pts) + 1 + 2 + 2, 2, series.branchMin);
          o.hotPath = [...feed, seg];
          o.heater = p.heater;
          const s = segments[seg];
          const vol = ((Math.PI * (s.bore / 1000) ** 2) / 4) * len * 1000;
          o.waitL = r1(vol * 1.15);
          o.waitS = Math.round((vol * 1.15) / O.hot);
        }
      }
      outlets.push(o);
    }
  }

  // ---- pressures ----
  const pathLoss = (path: number[]) => path.reduce((a, i) => a + segments[i].loss, 0);
  let needBar = 0;
  for (const o of outlets) {
    const head = RHO_G * (source.z - o.z);
    if (o.coldPath.length) {
      o.cold = r2(Math.max(0, source.bar + head - pathLoss(o.coldPath)));
      needBar = Math.max(needBar, o.required - head + pathLoss(o.coldPath));
    }
    if (o.hotPath.length) {
      o.hot = r2(Math.max(0, source.bar + head - pathLoss(o.hotPath) - 0.1));
      needBar = Math.max(needBar, o.required - head + pathLoss(o.hotPath) + 0.1);
    }
  }
  const weak = outlets.filter((o) => (o.cold !== undefined && o.cold < o.required) || (o.hot !== undefined && o.hot < o.required));
  if (weak.length) {
    const worst = weak.reduce((a, b) => (Math.min(a.cold ?? 9, a.hot ?? 9) < Math.min(b.cold ?? 9, b.hot ?? 9) ? a : b));
    const fix =
      spec.supply === "tank_gravity"
        ? `a roof tank alone gives ${r1(RHO_G * (source.z - worst.z))} bar there: add a booster set (about ${r1(needBar + 0.3)} bar)`
        : spec.supply === "mains"
          ? "street pressure is not enough: use a ground tank and booster set (the usual Kuwaiti arrangement)"
          : `raise the booster setting to about ${r1(needBar + 0.3)} bar or enlarge the pipes on the index run`;
    issues.push(`${weak.length} outlet(s) below their minimum flow pressure, worst: ${worst.label} in ${worst.room} (${lvName(worst.level)}) at ${Math.min(worst.cold ?? 9, worst.hot ?? 9)} bar against ${worst.required} bar — ${fix}.`);
  }
  const high = outlets.filter((o) => Math.max(o.cold ?? 0, o.hot ?? 0) > 5);
  if (high.length) issues.push(`${high.length} outlet(s) see more than 5 bar (up to ${Math.max(...high.map((o) => Math.max(o.cold ?? 0, o.hot ?? 0)))} bar): fit a pressure-reducing valve on the lower floors.`);
  for (const o of outlets.filter((o) => MIXERS.has(o.kind) && o.cold !== undefined && o.hot !== undefined && Math.abs(o.cold - o.hot) > 0.5))
    issues.push(`${o.label} in ${o.room} (${lvName(o.level)}): hot and cold differ by ${r1(Math.abs(o.cold! - o.hot!))} bar at peak — the temperature will swing when other taps open; use a thermostatic / pressure-balancing mixer.`);
  const slow = outlets.filter((o) => (o.waitS ?? 0) > 15).sort((a, b) => b.waitS! - a.waitS!);
  for (const o of slow.slice(0, 6))
    issues.push(`hot water takes ${o.waitS} s to reach the ${o.label} in ${o.room} (${lvName(o.level)}), running ${o.waitL} L to waste — move heater ${o.heater} closer${o.waitS! > 30 ? ", or add a small heater at this outlet" : ""}.`);
  if (coldSummerC > 39)
    issues.push(
      `in July–August the "cold" water reaches about ${coldSummerC} °C from ${spec.tank === "exposed" ? "an exposed" : "a"} roof tank — hotter than a comfortable shower (38–40 °C): shade and insulate the roof tanks, feed the cold side from the ground tank, or fit a water chiller.`,
    );

  // ---- hot water heaters: sanity ----
  for (const h of heaters) if (h.reheatMin > 150) issues.push(`heater ${h.id} (${h.litres} L, ${h.kW} kW) takes ${h.reheatMin} min to reheat in winter: use a 3 kW element.`);

  // ---- storage and pumps ----
  const bedrooms = project.levels.flatMap((lv) => lv.rooms).filter((r) => KIND_RE.find(([, re]) => re.test(r.name))?.[0] === "bedroom" && !/maid|servant|driver|nanny/i.test(r.name)).length;
  const staff = project.levels.flatMap((lv) => lv.rooms).filter((r) => /maid|servant|driver|nanny/i.test(r.name)).length;
  const occupants = spec.occupants ?? Math.max(2, bedrooms * 2 + staff);
  const daily = occupants * spec.litresPerPersonDay;
  const roofNeed = daily + 0; // one day on the roof
  const roofGal = roofNeed / IMP_GALLON;
  const STD = [500, 600, 800, 1000];
  const roofTanks = roofGal <= 1000 ? `1 × ${STD.find((g) => g >= roofGal) ?? 1000} gallon` : `${Math.ceil(roofGal / 1000)} × 1000 gallon`;
  const roofLitres = roofGal <= 1000 ? (STD.find((g) => g >= roofGal) ?? 1000) * IMP_GALLON : Math.ceil(roofGal / 1000) * 1000 * IMP_GALLON;
  const groundL = (daily + gardenLitresPerDay) * 2;
  const total = sumVR(used.flatMap(floorDemand));
  const peakAll = peakFlow(total.sum, total.max);
  const hot = sumVR(used.flatMap((li) => fxOf(li).filter((f) => f.hot).map((f) => ({ f, hot: true }))));
  const peak = { cold: r2(peakFlow(sumVR(used.flatMap((li) => fxOf(li).map((f) => ({ f, hot: false })))).sum, 0.15)), hot: r2(peakFlow(hot.sum, hot.max)), total: r2(peakAll) };
  let booster: WaterDesign["booster"];
  if (spec.supply === "tank_booster") {
    const headM = spec.boosterBar * 10.2;
    booster = { flowM3h: r1(peakAll * 3.6), setBar: spec.boosterBar, requiredBar: r1(Math.max(0, needBar)), headM: r1(headM), kW: r2((9.81 * (peakAll / 1000) * 1000 * headM) / 0.45 / 1000) };
    if (needBar > spec.boosterBar) issues.push(`the booster is set to ${spec.boosterBar} bar but the index outlet needs ${r1(needBar)} bar.`);
  }
  let transfer: WaterDesign["transfer"];
  if (spec.supply !== "mains") {
    const headM = roofZ + spec.tankStand + 2 + 5;
    const q = daily / 1000 / 1; // fill a day's use in an hour
    transfer = { flowM3h: r1(q), headM: r1(headM), kW: r2((9.81 * (q / 3600) * 1000 * headM) / 0.45 / 1000) };
  }
  if (spec.supply !== "mains") issues.push(`roof tanks hold about ${Math.round(roofLitres)} L — ${r1(roofLitres / 1000)} t when full: stand them over beams or columns, not mid-span.`);

  // ---- drainage stacks ----
  const stacks: WaterStack[] = [];
  const byLevel = [...infos.keys()].sort((a, b) => infos[b].elevation - infos[a].elevation);
  for (const li of byLevel) {
    const L = infos[li].services;
    for (const st of L.points.filter((p) => p.type === "stack")) {
      const du = L.pipes.filter((p) => p.stack === st.id).reduce((a, p) => a + OUTLET[L.fixtures.find((f) => f.id === p.fixture)?.kind ?? "basin"].du, 0);
      const above = stacks.filter((s) => s.below === undefined && s.level !== li && infos[s.level].elevation > infos[li].elevation && v2.dist(s.at, st.at as Vec2) < 0.4);
      const ws: WaterStack = { id: st.id, level: li, at: st.at as Vec2, size: st.size ?? 100, du: du + above.reduce((a, s) => a + s.du, 0), flow: 0, capacity: STACK_CAP.find(([d]) => d >= (st.size ?? 100))?.[1] ?? 4 };
      for (const s of above) s.below = st.id;
      const maxDU = Math.max(0, ...L.pipes.filter((p) => p.stack === st.id).map((p) => OUTLET[L.fixtures.find((f) => f.id === p.fixture)?.kind ?? "basin"].du));
      ws.flow = r2(Math.max(maxDU, 0.5 * Math.sqrt(ws.du)));
      ws.du = r1(ws.du);
      stacks.push(ws);
      if (ws.flow > ws.capacity) issues.push(`stack ${st.id} on ${lvName(li)} carries ${ws.flow} L/s, over the ${ws.capacity} L/s a ${ws.size} mm stack takes: use ${STACK_CAP.find(([, c]) => c >= ws.flow)?.[0] ?? 150} mm.`);
    }
  }
  const lowest = Math.min(...infos.map((l) => l.elevation));
  for (const s of stacks)
    if (!s.below && infos[s.level].elevation > lowest + 0.1) {
      const lower = byLevel.filter((li) => infos[li].elevation < infos[s.level].elevation);
      const room = lower.length ? project.levels[lower[0]].rooms.find((r) => pointInPolygon(s.at, r.polygon as Vec2[]))?.name : undefined;
      issues.push(`stack ${s.id} on ${lvName(s.level)} has no stack below it${room ? ` (it lands in the ${room} on ${lvName(lower[0])})` : ""}: line the wet rooms up, or offset the stack in the ceiling below.`);
    }

  const assumptions = [
    `Supply: ${spec.supply === "tank_booster" ? `roof tanks with a booster set at ${spec.boosterBar} bar` : spec.supply === "tank_gravity" ? `roof tanks by gravity (tank base ${spec.tankStand} m above the roof)` : `street supply at ${spec.mainsBar} bar`}; ${series.name} pipes; velocity ≤ 2 m/s in branches, 1.5 m/s in mains and risers.`,
    "Peak flows by DIN 1988-300 (residential); outlet design flows: basin / sink 0.07 L/s, shower / bath 0.15, WC 0.13, washing machine 0.15, garden tap 0.3 (each, hot and cold).",
    "Minimum flow pressures (EN 806): mixers, showers, appliances 1.0 bar; WC cisterns 0.5 bar. Losses: Darcy–Weisbach plus fittings (elbows, tees, stop and angle valves); 0.1 bar through each heater.",
    `Hot water: electric storage heaters at ${HOT_C} °C (${spec.heaterKW} kW); wait = pipe volume from the heater × 1.15 ÷ outlet flow.`,
    `Storage: ${occupants} people × ${spec.litresPerPersonDay} L/day${gardenLitresPerDay ? ` + garden ${Math.round(gardenLitresPerDay)} L/day` : ""}; roof tanks hold one day, the ground tank two.`,
    "Drainage: EN 12056-2 discharge units (WC 2.0, basin 0.5, shower 0.6, bath / sink / appliances 0.8), K = 0.5; stack capacity with primary ventilation.",
  ];

  return {
    supply: spec.supply,
    pipe: series.name,
    source: { ...source, z: r2(source.z) },
    peak,
    booster,
    transfer,
    storage: { occupants, litresPerDay: daily, gardenLitresPerDay: Math.round(gardenLitresPerDay), roof: { litres: Math.round(roofLitres), tanks: roofTanks }, ground: { litres: Math.round(groundL), m3: Math.ceil(groundL / 500) / 2 } },
    coldSummerC,
    segments: segments.map((s) => ({ ...s, flow: r2(s.flow), length: r2(s.length), loss: Math.round(s.loss * 1000) / 1000 })),
    outlets,
    heaters,
    stacks,
    issues,
    assumptions,
  };
}

/** Plain-text report. */
export function waterReport(d: WaterDesign, levelNames: string[], detail = true): string {
  const out: string[] = [];
  const src = d.supply === "tank_booster" ? `roof tanks + booster set (${d.booster?.setBar} bar)` : d.supply === "tank_gravity" ? "roof tanks by gravity" : "street supply";
  out.push(`Water supply: ${src}; ${d.pipe} pipes. Peak demand ${d.peak.total} L/s (${r1(d.peak.total * 3.6)} m³/h), hot ${d.peak.hot} L/s.`);
  if (d.booster) out.push(`Booster set: ${d.booster.flowM3h} m³/h at ${d.booster.headM} m (${d.booster.setBar} bar; the index outlet needs ${d.booster.requiredBar} bar), about ${d.booster.kW} kW.`);
  if (d.transfer) out.push(`Transfer pump (ground tank → roof): ${d.transfer.flowM3h} m³/h at ${d.transfer.headM} m, about ${d.transfer.kW} kW.`);
  const st = d.storage;
  out.push(`Storage: ${st.occupants} people, ${st.litresPerDay} L/day${st.gardenLitresPerDay ? ` + ${st.gardenLitresPerDay} L/day garden` : ""}; roof tanks ${st.roof.tanks} (${st.roof.litres} L); ground tank ${st.ground.m3} m³.`);
  out.push(`Summer cold-water temperature: about ${d.coldSummerC} °C.`);
  out.push("");
  out.push("Outlets (pressure at peak flow, bar; hot-water wait):");
  for (const o of d.outlets) {
    const p = [o.cold !== undefined ? `cold ${o.cold}` : "", o.hot !== undefined ? `hot ${o.hot}` : ""].filter(Boolean).join(", ");
    const low = (o.cold ?? 9) < o.required || (o.hot ?? 9) < o.required;
    out.push(`  ${levelNames[o.level]} · ${o.room}: ${o.label} — ${p} (needs ${o.required})${o.waitS !== undefined ? `, hot in ${o.waitS} s / ${o.waitL} L` : ""}${low ? "  ← LOW" : ""}`);
  }
  if (d.heaters.length) {
    out.push("");
    out.push("Water heaters:");
    for (const h of d.heaters) out.push(`  ${h.id} (${levelNames[h.level]} · ${h.room}): ${h.litres} L, ${h.kW} kW, reheats in ${h.reheatMin} min; feeds ${h.feeds.length} outlet(s)`);
  }
  if (detail) {
    out.push("");
    out.push("Pipe sizing (peak flow → size, velocity, loss):");
    for (const s of d.segments.filter((s) => s.kind !== "branch" && s.kind !== "hot")) out.push(`  ${s.label}: ${s.flow} L/s → Ø${s.od}, ${s.velocity} m/s, ${s.length} m, ${s.loss} bar`);
    const br = d.segments.filter((s) => s.kind === "branch" || s.kind === "hot");
    if (br.length) out.push(`  branches: ${br.length} runs, Ø${Math.min(...br.map((s) => s.od))}–${Math.max(...br.map((s) => s.od))}, ${r1(br.reduce((a, s) => a + s.length, 0))} m`);
  }
  if (d.stacks.length) {
    out.push("");
    out.push("Drainage stacks:");
    for (const s of d.stacks) out.push(`  ${s.id} (${levelNames[s.level]}): Ø${s.size}, ${s.du} DU → ${s.flow} L/s of ${s.capacity}${s.below ? `, continues into ${s.below}` : ""}`);
  }
  if (d.issues.length) {
    out.push("");
    out.push("Issues:");
    for (const i of d.issues) out.push(`  - ${i}`);
  }
  out.push("");
  out.push("Assumptions:");
  for (const a of d.assumptions) out.push(`  - ${a}`);
  return out.join("\n");
}

export type { PipeRun };
