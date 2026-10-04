/**
 * Air side of the air-conditioning design: what the fan has to push and what the rooms hear and feel.
 *
 *  - Ducts: velocity, friction (Darcy–Weisbach on the Huebscher equivalent diameter, galvanised steel) and
 *    fittings (bends, take-offs) for every run; the riser from a roof unit down to each floor it serves.
 *  - Index runs: the supply and return paths with the largest pressure drop, through the diffuser / grille.
 *    The external static pressure the unit's fan needs, against what a standard unit of that size delivers.
 *  - Fan power and specific fan power.
 *  - Rooms: diffuser neck size and velocity, an NC estimate against the room's target (bedrooms NC 30,
 *    living rooms 35, service rooms 40), air changes per hour, and the diffuser throw against the room.
 */
import { polygonArea, v2, type Vec2 } from "../geometry/math.js";
import type { HvacDesign } from "./hvac.js";
import type { CeilingLayout } from "./finishes.js";

const RHO = 1.2;
const NU = 1.5e-5;
const ROUGH = 0.09e-3; // galvanised sheet
const NECKS = [150, 200, 250, 300, 350, 400];

export interface AirsideDuct {
  level: number;
  /** Index into hvac.levels[level].ducts. */
  index: number;
  velocity: number;
  paPerM: number;
  /** Friction + fittings, Pa. */
  dp: number;
}

export interface AirsideUnit {
  unit: string;
  /** Index runs (Pa): supply to the worst diffuser, return from the worst grille, both including the riser. */
  supplyPa: number;
  returnPa: number;
  riserPa: number;
  /** External static pressure needed (with 15 % margin) and what a standard unit of this size offers. */
  espPa: number;
  standardPa: number;
  /** Fan input, W, and specific fan power, W/(L/s). */
  fanW: number;
  sfp: number;
  indexSupply?: string;
  indexReturn?: string;
}

export interface AirsideRoom {
  level: number;
  room: number;
  name: string;
  supply: number;
  diffusers: number;
  neck: number;
  neckVelocity: number;
  nc: number;
  ncTarget: number;
  ach: number;
  /** Throw to 0.25 m/s and the distance from a diffuser to the far wall, m. */
  throw: number;
  reach: number;
}

export interface AirsideDesign {
  units: AirsideUnit[];
  ducts: AirsideDuct[];
  rooms: AirsideRoom[];
  issues: string[];
  assumptions: string[];
}

interface InfoIn {
  name: string;
  elevation: number;
  height: number;
  ceilings: CeilingLayout[];
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** Pressure drop of a rectangular duct run, Pa (straight length + ζ on the run's velocity). */
export function ductLoss(airflowLs: number, w: number, h: number, length: number, zeta: number): { v: number; paPerM: number; dp: number } {
  const q = airflowLs / 1000;
  const v = q / (w * h);
  const de = (1.3 * (w * h) ** 0.625) / (w + h) ** 0.25;
  const re = (v * de) / NU;
  const f = re < 2300 ? 64 / Math.max(re, 1) : 0.25 / Math.log10(ROUGH / (3.7 * de) + 5.74 / re ** 0.9) ** 2;
  const pv = (RHO * v * v) / 2;
  const paPerM = (f / de) * pv;
  return { v, paPerM, dp: paPerM * length + zeta * pv };
}

/** NC of a 600 × 600 four-way ceiling diffuser from its neck velocity (catalogue fit), plus several in one room. */
export function diffuserNC(neckV: number, n = 1): number {
  return Math.round(25 + 50 * Math.log10(Math.max(neckV, 0.5) / 2.5) + 10 * Math.log10(Math.max(1, n)));
}

const ncTargetOf = (name: string) =>
  /bed|master|guest|nursery|kids/i.test(name) ? 30 : /living|lounge|family|dining|sitting|majlis|diwan|study|office|library|reception/i.test(name) ? 35 : 40;
const neckLimit = (target: number) => (target <= 30 ? 2.5 : target <= 35 ? 3.0 : 3.5);

/** Standard external static pressure of a unit's fan, Pa. */
function standardESP(kind: string, tr: number): number {
  if (kind === "packaged") return tr <= 10 ? 125 : tr <= 20 ? 175 : 250;
  if (kind === "ducted_split") return tr <= 2.5 ? 50 : 100;
  return 0;
}

const plen = (pts: Vec2[]) => pts.slice(1).reduce((a, p, i) => a + v2.dist(pts[i], p), 0);
const bends = (pts: Vec2[]) => Math.max(0, pts.length - 2);

export function designAirside(h: HvacDesign, infos: InfoIn[], rooms: { name: string; polygon: number[][] }[][]): AirsideDesign {
  const issues: string[] = [];
  const ducts: AirsideDuct[] = [];
  const units: AirsideUnit[] = [];
  const out: AirsideRoom[] = [];
  const roofZ = Math.max(...infos.map((l) => l.elevation + l.height));

  // ---- every duct run ----
  const dpOf = new Map<string, number>();
  h.levels.forEach((L, li) =>
    L.ducts.forEach((d, i) => {
      const zeta = bends(d.pts) * 0.6 + (d.parent ? 0.6 : 0.3);
      const r = ductLoss(d.airflow, d.w, d.h, plen(d.pts), zeta);
      ducts.push({ level: li, index: i, velocity: r1(r.v), paPerM: Math.round(r.paPerM * 100) / 100, dp: r1(r.dp) });
      dpOf.set(`${li}:${i}`, r.dp);
    }),
  );
  const fast = ducts.filter((d) => d.velocity > 6.5 || d.paPerM > 2);
  if (fast.length) {
    const worst = fast.reduce((a, b) => (b.velocity > a.velocity ? b : a));
    const d = h.levels[worst.level].ducts[worst.index];
    issues.push(`${fast.length} duct run(s) are fast or high-friction (worst: ${d.unit} ${d.kind} ${Math.round(d.w * 1000)}×${Math.round(d.h * 1000)} mm at ${worst.velocity} m/s, ${worst.paPerM} Pa/m): they will be noisy above the ceiling; deepen the ceiling void so the ducts can grow.`);
  }

  // ---- terminals: supply diffusers and their rooms ----
  const termDp = new Map<string, number>();
  h.levels.forEach((L, li) => {
    const byRoom = new Map<number, typeof L.terminals>();
    for (const t of L.terminals.filter((t) => t.kind === "supply")) (byRoom.get(t.room) ?? byRoom.set(t.room, []).get(t.room)!).push(t);
    for (const [ri, ts] of byRoom) {
      const name = rooms[li]?.[ri]?.name ?? `room ${ri}`;
      const target = ncTargetOf(name);
      const each = Math.max(...ts.map((t) => t.airflow));
      const lim = neckLimit(target);
      const neck = NECKS.find((n) => each / 1000 / ((Math.PI * (n / 1000) ** 2) / 4) <= lim) ?? NECKS[NECKS.length - 1];
      const area = (Math.PI * (neck / 1000) ** 2) / 4;
      const nv = each / 1000 / area;
      // diffuser + plenum box + 1.5 m flexible duct + balancing damper
      const dpTerm = 12 * (nv / 2.5) ** 2 + 10;
      for (const t of ts) termDp.set(t.id, dpTerm);
      const poly = rooms[li]?.[ri]?.polygon as Vec2[] | undefined;
      const cl = infos[li].ceilings[ri];
      const ceilingH = cl && cl.type !== "none" ? cl.height : infos[li].height - 0.2;
      const vol = poly ? Math.abs(polygonArea(poly)) * ceilingH : 0;
      const supply = ts.reduce((a, t) => a + t.airflow, 0);
      // four-way throw to 0.25 m/s (T = K·Q / (V·√A), K ≈ 1.1); reach: from a diffuser to the wall of its share
      const thr = (1.1 * (each / 1000)) / (0.25 * Math.sqrt(area));
      const xs = poly?.map((p) => p[0]) ?? [0], ys = poly?.map((p) => p[1]) ?? [0];
      const span = Math.max(...xs) - Math.min(...xs), depth = Math.max(...ys) - Math.min(...ys);
      // each diffuser serves its share of the long side; reach = to the farther wall in its square
      const share = Math.max(span, depth) / ts.length;
      const far = Math.max(share, Math.min(span, depth)) / 2;
      const room: AirsideRoom = {
        level: li,
        room: ri,
        name,
        supply,
        diffusers: ts.length,
        neck,
        neckVelocity: r1(nv),
        nc: diffuserNC(nv, ts.length),
        ncTarget: target,
        ach: vol ? r1((supply * 3.6) / vol) : 0,
        throw: r1(thr),
        reach: r1(far),
      };
      out.push(room);
      if (room.nc > room.ncTarget + 2) issues.push(`${name} (${infos[li].name}): diffusers at about NC ${room.nc} against NC ${room.ncTarget} for this room — add a diffuser or use a larger neck.`);
      if (room.ach > 15) issues.push(`${name} (${infos[li].name}): ${room.ach} air changes an hour — expect draughts; spread the air over more diffusers or check the load.`);
      if (room.throw < 0.5 * room.reach) issues.push(`${name} (${infos[li].name}): the diffuser throw (${room.throw} m) reaches only part of the way to the walls (${room.reach} m) — warm corners; add a diffuser.`);
    }
    for (const t of L.terminals.filter((t) => t.kind === "return")) termDp.set(t.id, 15);
  });

  // ---- per unit: riser and index runs ----
  for (const u of h.units) {
    if (u.kind === "split") continue;
    const served = h.levels.map((L, li) => ({ L, li })).filter(({ L }) => L.ducts.some((d) => d.unit === u.id));
    if (!served.length) continue;
    let supplyPa = 0, returnPa = 0, riserPa = 0;
    let indexSupply: string | undefined, indexReturn: string | undefined;
    for (const { L, li } of served) {
      // riser: roof unit down to this floor's ceiling, or between floors for a ducted split
      const ceilZ = infos[li].elevation + infos[li].height - 0.2;
      const fromZ = u.onRoof ? roofZ + 0.3 : infos[u.level].elevation + infos[u.level].height - 0.2;
      const shaft = L.shafts.find((s) => s.unit === u.id);
      const horiz = u.onRoof && shaft ? Math.abs(u.at[0] - shaft.at[0]) + Math.abs(u.at[1] - shaft.at[1]) : 0;
      const vert = Math.abs(fromZ - ceilZ);
      // air through this floor's riser: this floor and every floor further from the unit
      const below = served.filter(({ li: o }) => Math.abs(infos[o].elevation - fromZ) >= Math.abs(infos[li].elevation - fromZ) - 1e-6);
      const q = below.reduce((a, { L: LL }) => a + LL.terminals.filter((t) => t.unit === u.id && t.kind === "supply").reduce((x, t) => x + t.airflow, 0), 0);
      let rp = 0;
      if (vert + horiz > 0.1 && q > 0) {
        const side = Math.max(0.2, Math.ceil(Math.sqrt(q / 1000 / 6) / 0.05) * 0.05);
        rp = ductLoss(q, side, side, vert + horiz, 1.2).dp + (u.onRoof ? 10 : 0);
      }
      riserPa = Math.max(riserPa, rp);
      for (const kind of ["supply", "return"] as const) {
        const tree = L.ducts.map((d, i) => ({ d, i })).filter(({ d }) => d.unit === u.id && d.kind === kind);
        const byNode = new Map(tree.map((e) => [e.d.node!, e]));
        for (const e of tree.filter((e) => e.d.term)) {
          let pa = termDp.get(e.d.term!) ?? 15;
          for (let n: number | undefined = e.d.node; n; n = byNode.get(n)?.d.parent) {
            const x = byNode.get(n);
            if (!x) break;
            pa += dpOf.get(`${li}:${x.i}`) ?? 0;
          }
          pa += rp;
          if (kind === "supply" && pa > supplyPa) [supplyPa, indexSupply] = [pa, e.d.term];
          if (kind === "return" && pa > returnPa) [returnPa, indexReturn] = [pa, e.d.term];
        }
      }
    }
    const esp = Math.round((supplyPa + returnPa) * 1.15);
    const std = standardESP(u.kind, u.size);
    const internal = u.kind === "packaged" ? 250 : 150;
    const fanW = Math.round(((u.airflow / 1000) * (esp + internal)) / 0.55);
    units.push({ unit: u.id, supplyPa: Math.round(supplyPa), returnPa: Math.round(returnPa), riserPa: Math.round(riserPa), espPa: esp, standardPa: std, fanW, sfp: Math.round((fanW / u.airflow) * 100) / 100, indexSupply, indexReturn });
    if (std && esp > std)
      issues.push(`${u.id}: the ducts need about ${esp} Pa external static, more than the ${std} Pa of a standard ${u.size} TR ${u.kind.replace("_", " ")} — specify the high-static fan option (or enlarge the index run to ${indexSupply}).`);
  }

  const assumptions = [
    "Duct losses: Darcy–Weisbach on the equivalent diameter of each rectangular run (galvanised, 0.09 mm), bends ζ 0.6, take-offs ζ 0.3–0.6; risers sized at 6 m/s; 10 Pa roof curb transition.",
    "Diffusers: 600 × 600 four-way with a plenum box, 1.5 m flexible duct and balancing damper (10 Pa + 12 Pa at a 2.5 m/s neck); return grilles 15 Pa. Neck velocity ≤ 2.5 m/s in bedrooms (NC 30), 3.0 in living rooms (NC 35), 3.5 elsewhere.",
    "External static pressure = supply + return index runs × 1.15. Standard fans: packaged ≤ 10 TR 125 Pa, ≤ 20 TR 175 Pa, larger 250 Pa; ducted splits 50–100 Pa. Fan efficiency 0.55, unit internal losses 250 Pa (packaged) / 150 Pa.",
  ];
  return { units, ducts, rooms: out, issues, assumptions };
}

/** Text section for the HVAC report. */
export function airsideReport(a: AirsideDesign, levelNames: string[]): string[] {
  const out: string[] = ["", "Air side (ducts, fans, noise):"];
  for (const u of a.units)
    out.push(`  ${u.unit}: external static ${u.espPa} Pa needed (supply ${u.supplyPa} + return ${u.returnPa}, riser ${u.riserPa}) vs ${u.standardPa || "—"} Pa standard; fan ≈ ${u.fanW} W (SFP ${u.sfp} W per L/s); index diffuser ${u.indexSupply ?? "—"}`);
  if (a.rooms.length) {
    out.push("  rooms — diffusers × neck (velocity), NC / target, air changes, throw / reach:");
    for (const r of a.rooms) out.push(`    ${levelNames[r.level]} / ${r.name}: ${r.diffusers} × Ø${r.neck} (${r.neckVelocity} m/s), NC ${r.nc}/${r.ncTarget}, ${r.ach} ACH, throw ${r.throw} m / ${r.reach} m`);
  }
  return out;
}
