/**
 * Airflow study of one floor: how the conditioned air actually moves and mixes. The floor is voxelised (rooms up to
 * their ceilings, walls solid, interior doors open, windows and exterior doors shut), the HVAC design's diffusers
 * blow 13 °C air in (four-way ceiling jets, momentum-matched to the real slot velocity), its return grilles take air
 * out, and each room's heat gains warm the air: the façade's (walls, glass, sun, roof) next to the exterior walls,
 * people / lights / equipment through the occupied zone. The GPU solver (viewer/gpu/airflow.js) runs a few minutes
 * of flow; the result is the temperature and air speed everywhere, and per room the occupied-zone temperature,
 * head-to-ankle stratification, draught and dead-zone shares and the ADPI comfort index (ASHRAE 55 / 113).
 */
import type { Compiled } from "../pipeline.js";
import { pointInPolygon, pointSegment, v2, type Vec2 } from "../geometry/math.js";
import { gpuTracer } from "../render/gpu.js";
import { AirflowSolver } from "../../viewer/gpu/airflow.js";

export interface AirflowGrid {
  nx: number;
  ny: number;
  nz: number;
  dx: number;
  x0: number;
  y0: number;
  /** Floor level (absolute z of cell layer 0's bottom). */
  z0: number;
}

export interface AirflowRoom {
  room: number;
  name: string;
  supply: number;
  /** Occupied zone (0.1–1.8 m): mean °C, at ankle (0.1 m) and head (1.1 m), mean / 95th percentile speed (m/s). */
  meanT: number;
  ankleT: number;
  headT: number;
  meanV: number;
  p95V: number;
  /** Share of the occupied zone: draughty (> 0.25 m/s), stagnant (< 0.05 m/s), and ADPI (comfortable mixing), %. */
  draught: number;
  stagnant: number;
  adpi: number;
}

export interface AirflowResult {
  level: number;
  grid: AirflowGrid;
  /** 4 floats per cell: u, v, w (m/s), °C. */
  field: Float32Array;
  /** 0 air, 1 solid, 2 supply, 3 return. */
  kind: Uint32Array;
  rooms: AirflowRoom[];
  issues: string[];
  assumptions: string[];
  seconds: number;
  ms: number;
  gpu: string;
}

const RHO_C = 1200; // J/m³K
const SLOT_V = 3; // m/s leaving a ceiling diffuser's slots
const SUPPLY_DT = 11; // 24 → 13 °C

const cache = new WeakMap<Compiled, Map<string, Promise<AirflowResult>>>();

/** Cached per compiled plan, level and settings. */
export function airflowStudy(c: Compiled, levelId?: string, o: { seconds?: number } = {}): Promise<AirflowResult> {
  let m = cache.get(c);
  if (!m) cache.set(c, (m = new Map()));
  const key = `${levelId ?? ""}|${o.seconds ?? ""}`;
  let p = m.get(key);
  if (!p) {
    p = simulate(c, levelId, o);
    m.set(key, p);
    p.catch(() => m!.delete(key));
  }
  return p;
}

export interface AirflowSetup {
  li: number;
  grid: AirflowGrid;
  kind: Uint32Array;
  src: Float32Array;
  roomOf: Int32Array;
  loads: NonNullable<Compiled["hvac"]>["rooms"];
  supplyOf: Map<number, number>;
  tRoom: number;
}

async function simulate(c: Compiled, levelId: string | undefined, o: { seconds?: number }): Promise<AirflowResult> {
  const setup = voxelize(c, levelId);
  return runAirflow(c, setup, o);
}

/** The floor as cells, with supplies, returns and heat sources. */
export function voxelize(c: Compiled, levelId?: string): AirflowSetup {
  if (!c.project || !c.hvac) throw new Error("the plan has no air-conditioning design");
  const li = levelId ? c.project.levels.findIndex((l) => l.id === levelId) : c.hvac.levels.findIndex((l) => l.terminals.some((t) => t.kind === "supply"));
  if (li < 0) throw new Error(levelId ? `level '${levelId}' not found` : "no floor has supply diffusers");
  const hv = c.hvac.levels[li];
  if (!hv.terminals.some((t) => t.kind === "supply")) throw new Error(`no supply diffusers on ${c.levels[li].name} (hvac.system ${c.hvac.system})`);
  const info = c.levels[li];
  const rooms = c.project.levels[li].rooms;
  const polys = rooms.map((r) => r.polygon as Vec2[]);
  const ceilH = rooms.map((_, ri) => {
    const cl = info.ceilings[ri];
    return cl && cl.type !== "none" ? cl.height : info.height - 0.2;
  });

  // ---- grid ----
  const xs = polys.flat().map((p) => p[0]), ys = polys.flat().map((p) => p[1]);
  const area = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
  const H = Math.max(...ceilH);
  const dx = Math.max(0.1, Math.ceil(Math.cbrt((area * H) / 350_000) / 0.025) * 0.025);
  const x0 = Math.min(...xs) - dx, y0 = Math.min(...ys) - dx;
  const nx = Math.ceil((Math.max(...xs) + dx - x0) / dx), ny = Math.ceil((Math.max(...ys) + dx - y0) / dx), nz = Math.ceil(H / dx);
  const N = nx * ny * nz;
  const at = (i: number, j: number, k: number) => (k * ny + j) * nx + i;
  const ctr = (i: number, j: number): Vec2 => [x0 + (i + 0.5) * dx, y0 + (j + 0.5) * dx];
  const kind = new Uint32Array(N).fill(1);
  const roomOf = new Int32Array(nx * ny).fill(-1);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const p = ctr(i, j);
      const ri = polys.findIndex((pg) => pointInPolygon(p, pg));
      if (ri < 0 || /terrace|balcony|patio|deck|garden|yard|roof/i.test(rooms[ri].name)) continue;
      roomOf[j * nx + i] = ri;
      for (let k = 0; k < nz; k++) if ((k + 0.5) * dx < ceilH[ri]) kind[at(i, j, k)] = 0;
    }
  // walls solid; then interior doors and archways open again
  const z0 = info.elevation;
  for (const s of info.segments) {
    const r = Math.max(s.thickness / 2, dx * 0.55);
    const bx0 = Math.max(0, Math.floor((Math.min(s.a[0], s.b[0]) - r - x0) / dx)), bx1 = Math.min(nx - 1, Math.ceil((Math.max(s.a[0], s.b[0]) + r - x0) / dx));
    const by0 = Math.max(0, Math.floor((Math.min(s.a[1], s.b[1]) - r - y0) / dx)), by1 = Math.min(ny - 1, Math.ceil((Math.max(s.a[1], s.b[1]) + r - y0) / dx));
    for (let j = by0; j <= by1; j++)
      for (let i = bx0; i <= bx1; i++) {
        if (pointSegment(ctr(i, j), s.a, s.b).dist > r) continue;
        for (let k = 0; k < nz; k++) {
          const z = z0 + (k + 0.5) * dx;
          if (z >= s.z0 - 1e-6 && z <= s.z1 + 1e-6) kind[at(i, j, k)] = 1;
        }
      }
  }
  for (const op of info.openings) {
    if (op.op.type === "window" || op.seg.exterior) continue;
    const s = op.seg;
    const d = v2.norm(v2.sub(s.b, s.a));
    const c0 = v2.add(s.a, v2.scale(d, op.u));
    const half = op.width / 2, r = Math.max(s.thickness / 2, dx * 0.55) + dx;
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const q = v2.sub(ctr(i, j), c0);
        const along = q[0] * d[0] + q[1] * d[1], across = Math.abs(q[0] * -d[1] + q[1] * d[0]);
        if (Math.abs(along) > half - dx * 0.25 || across > r) continue;
        for (let k = 0; k < nz; k++) if ((k + 0.5) * dx < op.z0 - z0 + op.height) kind[at(i, j, k)] = 0;
      }
  }

  // ---- supplies (momentum-matched four-way jets) and returns ----
  const src = new Float32Array(N * 4);
  const tRoom = 24;
  const top = (i: number, j: number) => {
    for (let k = nz - 1; k >= 0; k--) if (kind[at(i, j, k)] === 0) return k;
    return -1;
  };
  const supplyOf = new Map<number, number>();
  for (const t of hv.terminals) {
    const ci = Math.floor((t.at[0] - x0) / dx), cj = Math.floor((t.at[1] - y0) / dx);
    const rad = Math.max(1, Math.round(0.3 / dx));
    const cells: [number, number, number][] = [];
    for (let j = cj - rad + 1; j <= cj + rad - 1; j++)
      for (let i = ci - rad + 1; i <= ci + rad - 1; i++) {
        if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
        const k = top(i, j);
        if (k >= 0) cells.push([i, j, k]);
      }
    if (!cells.length) continue;
    if (t.kind === "return") {
      for (const [i, j, k] of cells) kind[at(i, j, k)] = 3;
      continue;
    }
    const Q = t.airflow / 1000;
    supplyOf.set(t.room, (supplyOf.get(t.room) ?? 0) + t.airflow);
    const side = (2 * rad - 1) * dx;
    const aOut = 4 * side * dx;
    const vm = Math.min(2.5, Math.sqrt((Q * SLOT_V) / aOut));
    const qModel = vm * aOut;
    const tIn = tRoom - SUPPLY_DT * (Q / qModel);
    for (const [i, j, k] of cells) {
      const p = ctr(i, j);
      let dir = v2.sub(p, t.at as Vec2);
      const l = v2.len(dir);
      dir = l > dx * 0.3 ? v2.scale(dir, 1 / l) : [0, 0];
      const n = at(i, j, k);
      kind[n] = 2;
      src.set([dir[0] * vm, dir[1] * vm, -0.25 * vm, tIn], n * 4);
    }
  }

  // ---- heat: façade gains at the exterior walls, internal gains through the occupied zone ----
  const loads = c.hvac.rooms.filter((r) => r.level === li && r.conditioned);
  const vCell = dx * dx * dx;
  const isTop = li === c.levels.reduce((a, l, i) => (l.elevation > c.levels[a].elevation ? i : a), 0);
  for (const L of loads) {
    const p = L.parts;
    const facade = p.walls + p.glassConduction + p.glassSolar + p.infiltration;
    const internal = p.people + p.lighting + p.equipment;
    const near: number[] = [], occ: number[] = [], ceil: number[] = [];
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        if (roomOf[j * nx + i] !== L.room) continue;
        for (let k = 0; k < nz; k++) {
          const n = at(i, j, k);
          if (kind[n] !== 0) continue;
          const z = (k + 0.5) * dx;
          if (z > 0.1 && z < 1.8) occ.push(n);
          if (k === top(i, j)) ceil.push(n);
          // next to an exterior wall?
          let ext = false;
          for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const ii = i + di, jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
            if (kind[at(ii, jj, k)] === 1 && roomOf[jj * nx + ii] === -1) ext = true;
            else if (kind[at(ii, jj, k)] === 1) {
              const q = ctr(ii, jj);
              if (info.segments.some((s) => s.exterior && pointSegment(q, s.a, s.b).dist < s.thickness / 2 + dx)) ext = true;
            }
          }
          if (ext) near.push(n);
        }
      }
    const spread = (cells: number[], watts: number) => {
      if (!cells.length || watts <= 0) return;
      const rate = watts / (RHO_C * vCell * cells.length);
      for (const n of cells) src[n * 4 + 3] += rate;
    };
    spread(near.length ? near : occ, facade);
    spread(occ, internal);
    if (isTop) spread(ceil, p.roof);
    else spread(near.length ? near : occ, p.roof);
  }

  return { li, grid: { nx, ny, nz, dx, x0, y0, z0 }, kind, src, roomOf, loads, supplyOf, tRoom };
}

export async function runAirflow(c: Compiled, setup: AirflowSetup, o: { seconds?: number }): Promise<AirflowResult> {
  const { li, kind, src, roomOf, loads, supplyOf, tRoom } = setup;
  const { nx, ny, nz, dx } = setup.grid;
  const info = c.levels[li];
  const at = (i: number, j: number, k: number) => (k * ny + j) * nx + i;
  // ---- run ----
  const pt = await gpuTracer();
  const solver = new AirflowSolver((pt as unknown as { device: unknown }).device);
  const t0 = Date.now();
  const seconds = Math.max(30, Math.min(900, o.seconds ?? 240));
  solver.setup({ nx, ny, nz, dx }, kind, src, tRoom);
  await solver.run({ seconds, dt: 0.1, jacobi: 24, tref: tRoom });
  const field = await solver.read();
  solver.destroy();
  const ms = Date.now() - t0;

  // ---- per room ----
  const out: AirflowRoom[] = [];
  const issues: string[] = [];
  const layer = (z: number) => Math.min(nz - 1, Math.max(0, Math.floor(z / dx)));
  for (const L of loads) {
    const T: number[] = [], V: number[] = [], ank: number[] = [], head: number[] = [];
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        if (roomOf[j * nx + i] !== L.room) continue;
        for (let k = layer(0.1); k <= layer(1.8); k++) {
          const n = at(i, j, k);
          if (kind[n] !== 0) continue;
          const t = field[n * 4 + 3], v = Math.hypot(field[n * 4], field[n * 4 + 1], field[n * 4 + 2]);
          if (!Number.isFinite(t) || !Number.isFinite(v)) continue;
          T.push(t);
          V.push(v);
          if (k === layer(0.1)) ank.push(t);
          if (k === layer(1.1)) head.push(t);
        }
      }
    if (!T.length) continue;
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
    const mT = mean(T);
    const sorted = [...V].sort((a, b) => a - b);
    let comfy = 0, dr = 0, st = 0;
    for (let q = 0; q < T.length; q++) {
      const edt = T[q] - mT - 8 * (V[q] - 0.15);
      if (edt > -1.7 && edt < 1.1 && V[q] < 0.35) comfy++;
      if (V[q] > 0.25) dr++;
      if (V[q] < 0.05) st++;
    }
    const r1 = (x: number) => Math.round(x * 10) / 10;
    const room: AirflowRoom = {
      room: L.room,
      name: L.name,
      supply: supplyOf.get(L.room) ?? 0,
      meanT: r1(mT),
      ankleT: r1(mean(ank)),
      headT: r1(mean(head)),
      meanV: Math.round(mean(V) * 100) / 100,
      p95V: Math.round(sorted[Math.floor(sorted.length * 0.95)] * 100) / 100,
      draught: Math.round((dr / T.length) * 100),
      stagnant: Math.round((st / T.length) * 100),
      adpi: Math.round((comfy / T.length) * 100),
    };
    out.push(room);
    const where = `${room.name} (${info.name})`;
    if (room.meanT > 26) issues.push(`${where} runs warm at ${room.meanT} °C in the occupied zone: the air does not reach it — add or move a diffuser${room.supply ? "" : " (it has no supply)"}.`);
    if (room.headT - room.ankleT > 3) issues.push(`${where}: ${r1(room.headT - room.ankleT)} K between head and ankle (ISO 7730 limit 3 K) — supply air is not mixing down.`);
    if (room.draught > 20) issues.push(`${where}: ${room.draught}% of the occupied zone is draughty (> 0.25 m/s) — lower the diffuser airflow or spread it over more diffusers.`);
    if (room.supply && room.stagnant > 50) issues.push(`${where}: ${room.stagnant}% of the occupied zone is stagnant (< 0.05 m/s) — poor mixing; the throw does not reach.`);
    if (room.supply && room.adpi < 70) issues.push(`${where}: ADPI ${room.adpi}% (aim for 80%+) — uneven air distribution.`);
  }
  // supply right beside a return: the cold air goes straight back to the unit
  const hvL = c.hvac!.levels[li];
  for (const rt of hvL.terminals.filter((t) => t.kind === "return")) {
    const sp = hvL.terminals.filter((t) => t.kind === "supply").find((t) => v2.dist(t.at as Vec2, rt.at as Vec2) < 1.2);
    if (sp) issues.push(`${c.project!.levels[li].rooms[rt.room]?.name ?? "a room"} (${info.name}): return ${rt.id} is ${v2.dist(sp.at as Vec2, rt.at as Vec2).toFixed(1)} m from supply ${sp.id} — the cold air short-circuits back to the unit; keep them 2 m+ apart.`);
  }
  const assumptions = [
    `Floor ${info.name} as a ${nx}×${ny}×${nz} grid of ${Math.round(dx * 100)} cm cells; interior doors open, windows and exterior doors shut, furniture ignored.`,
    `Supply at 13 °C through four-way ceiling diffusers (jets matched to ${SLOT_V} m/s slot momentum), returns at the grilles; the summer design loads as heat: façade gains at the exterior walls, people / lights / equipment in the occupied zone.`,
    `${seconds} s of flow from a uniform 24 °C (stable-fluids solver with buoyancy on the GPU). An indicative study for comparing layouts, not a certified CFD analysis.`,
    "Occupied zone 0.1–1.8 m; ADPI = share where the effective draft temperature is between −1.7 and +1.1 K at under 0.35 m/s (ASHRAE 113); draught > 0.25 m/s; stagnant < 0.05 m/s.",
  ];
  const i = pt.adapterInfo;
  return { level: li, grid: setup.grid, field, kind, rooms: out, issues, assumptions, seconds, ms, gpu: [i.vendor, i.architecture].filter(Boolean).join(" ") || "GPU" };
}

/** Plain-text report. */
export function airflowReport(r: AirflowResult, levelName: string): string {
  const out = [`Airflow study, ${levelName}: ${r.seconds} s of flow on a ${r.grid.nx}×${r.grid.ny}×${r.grid.nz} grid (${Math.round(r.grid.dx * 100)} cm), ${(r.ms / 1000).toFixed(1)} s on the ${r.gpu}.`, "", "Rooms (occupied zone 0.1–1.8 m):"];
  for (const m of r.rooms)
    out.push(`  ${m.name}: ${m.meanT} °C (ankle ${m.ankleT}, head ${m.headT}), air ${m.meanV} m/s (95% ${m.p95V}), draught ${m.draught}%, stagnant ${m.stagnant}%, ADPI ${m.adpi}%${m.supply ? `, ${m.supply} L/s supplied` : ", no supply"}`);
  if (r.issues.length) out.push("", "Issues:", ...r.issues.map((i) => `  - ${i}`));
  out.push("", "Assumptions:", ...r.assumptions.map((a) => `  - ${a}`));
  return out.join("\n");
}

/**
 * The field for the viewer's particle animation, averaged over 2×2×2 cells (NaN where all solid):
 * [u32 header length][header JSON][pad to 4][Float32 u, v, w, °C per cell].
 */
export function packField(c: Compiled, r: AirflowResult): Uint8Array {
  const g = r.grid;
  const f = 2;
  const nx = Math.ceil(g.nx / f), ny = Math.ceil(g.ny / f), nz = Math.ceil(g.nz / f);
  const data = new Float32Array(nx * ny * nz * 4).fill(NaN);
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const acc = [0, 0, 0, 0];
        let n = 0;
        for (let dk = 0; dk < f; dk++)
          for (let dj = 0; dj < f; dj++)
            for (let di = 0; di < f; di++) {
              const ii = i * f + di, jj = j * f + dj, kk = k * f + dk;
              if (ii >= g.nx || jj >= g.ny || kk >= g.nz) continue;
              const q = (kk * g.ny + jj) * g.nx + ii;
              if (r.kind[q] === 1) continue;
              for (let m = 0; m < 4; m++) acc[m] += r.field[q * 4 + m];
              n++;
            }
        if (n) data.set(acc.map((v) => v / n), ((k * ny + j) * nx + i) * 4);
      }
  const supplies = c.hvac!.levels[r.level].terminals.map((t) => ({ kind: t.kind, at: t.at, airflow: t.airflow }));
  const header = new TextEncoder().encode(
    JSON.stringify({ nx, ny, nz, dx: g.dx * f, x0: g.x0, y0: g.y0, z0: g.z0, level: c.levels[r.level].id, levelName: c.levels[r.level].name, rooms: r.rooms, issues: r.issues, terminals: supplies }),
  );
  const off = 4 + Math.ceil(header.length / 4) * 4;
  const out = new Uint8Array(off + data.byteLength);
  new DataView(out.buffer).setUint32(0, header.length, true);
  out.set(header, 4);
  out.set(new Uint8Array(data.buffer), off);
  return out;
}
