/**
 * Navigation check: a real Recast / Detour navmesh baked from the building's collision geometry (walls, floors,
 * stairs as ramps, furniture as boxes; doors open; lifts as off-mesh links between their landings) for two agents —
 * a walking person and a wheelchair user — then a path from the entrance to every room. Reports rooms that cannot
 * be reached (and why: a narrow door, stairs only, furniture in the way, a step), walking distances, doors too
 * narrow for a wheelchair, and a plan image of the walkable area.
 */
import { init, NavMeshQuery, getNavMeshPositionsAndIndices, type NavMesh } from "@recast-navigation/core";
import { generateSoloNavMesh } from "@recast-navigation/generators";
import { m4, pointInPolygon, polygonCentroid, v2, type Vec2, type Vec3 } from "../geometry/math.js";
import type { MeshData } from "../geometry/mesh.js";
import { boxOf } from "../geometry/spatial.js";
import { boxCollider, collect, IDENTITY, type Collected } from "../export/game.js";
import { navMetadata, type NavArea } from "../export/navmeta.js";
import type { Compiled } from "../pipeline.js";

export interface NavAgent {
  id: "person" | "wheelchair";
  label: string;
  radius: number;
  height: number;
  climb: number;
  slope: number;
}
export const NAV_AGENTS: NavAgent[] = [
  { id: "person", label: "walking person", radius: 0.25, height: 1.8, climb: 0.2, slope: 45 },
  { id: "wheelchair", label: "wheelchair user", radius: 0.35, height: 1.4, climb: 0.025, slope: 6 },
];
/** Voxel size: fine enough that a 0.9 m door keeps its width (Recast loses about a cell each side of an opening). */
const CS = 0.025, CH = 0.01;

export interface NavRoomResult {
  level: number;
  name: string;
  kind: NavArea["kind"];
  /** Per agent: walking distance from the entrance (m), or why it cannot be reached. */
  person: { reached: boolean; distance?: number; why?: string };
  wheelchair: { reached: boolean; distance?: number; why?: string };
  centre: Vec2;
  path?: Vec3[];
}
export interface NavDoor {
  level: number;
  id: string;
  width: number;
  at: Vec2;
  rooms: string[];
}
export interface NavStudy {
  entrance: { level: number; at: Vec2; door?: string; outside: boolean };
  rooms: NavRoomResult[];
  narrowDoors: NavDoor[];
  /** Walkable triangles in plan coordinates (x, y, z) per agent, for the drawing. */
  mesh: Record<NavAgent["id"], { positions: number[]; indices: number[] }>;
  stats: { triangles: number; bakeMs: number; walkable: Record<NavAgent["id"], number> };
  issues: string[];
}

export interface NavObstacle {
  id: string;
  type: string;
  lo: Vec3;
  hi: Vec3;
}

/** Furniture whose box the path (swept by the agent's radius) runs through. */
function blockers(path: Vec3[], items: NavObstacle[], a: NavAgent): NavObstacle[] {
  // in the order the path meets them: the first is what stops you
  const hits = new Map<NavObstacle, number>();
  let along = 0;
  for (let k = 1; k < path.length; k++) {
    const p = path[k - 1], q = path[k];
    const L = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const steps = Math.max(1, Math.ceil(L / 0.05));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps, x = p[0] + (q[0] - p[0]) * t, y = p[1] + (q[1] - p[1]) * t, z = p[2] + (q[2] - p[2]) * t;
      for (const f of items)
        if (!hits.has(f) && x > f.lo[0] - a.radius && x < f.hi[0] + a.radius && y > f.lo[1] - a.radius && y < f.hi[1] + a.radius && f.hi[2] > z + a.climb && f.lo[2] < z + a.height) hits.set(f, along + t * L);
    }
    along += L;
  }
  return [...hits].sort((x, y) => x[1] - y[1]).map(([f]) => f);
}

let ready: Promise<void> | undefined;
const ensure = () => (ready ??= init());

/** The collision geometry the navmesh is baked from, in Recast's y-up space: (x, z, -y). */
export function navGeometry(c: Compiled, opts: { furniture?: boolean } = {}): { positions: Float32Array; indices: Uint32Array; triangles: number; furniture: NavObstacle[] } {
  const pos: number[] = [], idx: number[] = [];
  const furniture: NavObstacle[] = [];
  const add = (md: MeshData, m?: number[]) => {
    const base = pos.length / 3;
    for (let i = 0; i < md.positions.length; i += 3) {
      const p: Vec3 = [md.positions[i], md.positions[i + 1], md.positions[i + 2]];
      const w = m ? m4.point(m as never, p) : p;
      pos.push(w[0], w[2], -w[1]);
    }
    for (const k of md.indices) idx.push(base + k);
  };
  for (const top of c.root?.children ?? []) {
    const col: Collected = { render: [], collide: [], movable: [], rooms: [] };
    collect(top, IDENTITY, col);
    for (const { mesh, m } of col.collide) add(mesh, m as never);
    if (opts.furniture !== false)
      for (const { node, world } of col.movable) {
        if (node.kind !== "furniture") continue;
        const box = boxCollider(node);
        if (!box) continue;
        for (const mesh of box.meshes) {
          add(mesh, world as never);
          const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
          for (let i = 0; i < mesh.positions.length; i += 3) {
            const w = m4.point(world as never, [mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]]);
            for (let k = 0; k < 3; k++) (lo[k] = Math.min(lo[k], w[k])), (hi[k] = Math.max(hi[k], w[k]));
          }
          furniture.push({ id: node.name, type: String(node.extras?.type ?? "furniture"), lo, hi });
        }
      }
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx), triangles: idx.length / 3, furniture };
}

const toY = (p: Vec2, z: number) => ({ x: p[0], y: z, z: -p[1] });
const fromY = (q: { x: number; y: number; z: number }): Vec3 => [q.x, -q.z, q.y];

/**
 * Bake for one agent. Detour attaches an off-mesh link only where its ends lie within a step of the surface, so the
 * lift landings are first snapped onto a link-less bake, then baked in.
 */
function bake(geo: ReturnType<typeof navGeometry>, a: NavAgent, links: { a: Vec3; b: Vec3 }[]): NavMesh {
  if (!links.length) return bakeOnce(geo, a, []);
  const first = bakeOnce(geo, a, []);
  const q = new NavMeshQuery(first);
  const snap = (p: Vec3): Vec3 | undefined => {
    const f = q.findClosestPoint({ x: p[0], y: p[2] + 0.05, z: -p[1] }, { halfExtents: { x: 0.6, y: 0.4, z: 0.6 } });
    return f.success && f.polyRef ? fromY(f.point) : undefined;
  };
  const snapped = links.flatMap((l) => {
    const sa = snap(l.a), sb = snap(l.b);
    return sa && sb ? [{ a: sa, b: sb }] : [];
  });
  q.destroy();
  first.destroy();
  return bakeOnce(geo, a, snapped);
}

function bakeOnce(geo: ReturnType<typeof navGeometry>, a: NavAgent, links: { a: Vec3; b: Vec3 }[]): NavMesh {
  const r = generateSoloNavMesh(geo.positions, geo.indices, {
    cs: CS,
    ch: CH,
    walkableSlopeAngle: a.slope,
    walkableHeight: Math.ceil(a.height / CH),
    walkableClimb: Math.floor(a.climb / CH),
    walkableRadius: Math.ceil(a.radius / CS),
    maxEdgeLen: Math.round(12 / 0.3),
    maxSimplificationError: 1.3,
    minRegionArea: 64,
    mergeRegionArea: 400,
    maxVertsPerPoly: 6,
    detailSampleDist: 6,
    detailSampleMaxError: 1,
    offMeshConnections: links.map((l) => ({ startPosition: { x: l.a[0], y: l.a[2], z: -l.a[1] }, endPosition: { x: l.b[0], y: l.b[2], z: -l.b[1] }, radius: a.radius, bidirectional: true })),
  });
  if (!r.success) throw new Error(`navmesh bake failed (${a.id}): ${r.error}`);
  return r.navMesh;
}

/** Points inside a room to try as its standing spot: the centre, then a 0.4 m grid nearest the centre first. */
function standCandidates(poly: Vec2[], centre: Vec2): Vec2[] {
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  const out: Vec2[] = pointInPolygon(centre, poly) ? [centre] : [];
  for (let x = Math.min(...xs) + 0.2; x < Math.max(...xs); x += 0.4)
    for (let y = Math.min(...ys) + 0.2; y < Math.max(...ys); y += 0.4) if (pointInPolygon([x, y], poly)) out.push([x, y]);
  return out.sort((a, b) => v2.dist(a, centre) - v2.dist(b, centre)).slice(0, 80);
}

const plen = (pts: Vec3[]) => pts.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1], p[2] - pts[i][2]), 0);
const r1 = (n: number) => Math.round(n * 10) / 10;

/** Doors: the opening's centre, width and the rooms either side. */
function doorsOf(c: Compiled, areas: NavArea[]): NavDoor[] {
  const out: NavDoor[] = [];
  c.levels.forEach((info, li) =>
    info.openings
      .filter((o) => o.op.type === "door" || o.op.type === "opening")
      .forEach((o) => {
        const d = v2.norm(v2.sub(o.seg.b, o.seg.a));
        const at = v2.add(o.seg.a, v2.scale(d, o.u));
        const n: Vec2 = [-d[1], d[0]];
        const side = (s: number) => areas.find((a) => a.level === li && a.kind !== "stairs" && pointInPolygon(v2.add(at, v2.scale(n, s * (o.seg.thickness / 2 + 0.3))), a.poly))?.name;
        out.push({ level: li, id: o.id, width: o.width, at, rooms: [side(1), side(-1)].map((x) => x ?? "outside") });
      }),
  );
  return out;
}

/** Bake for both agents, path from the entrance to every room, and explain the failures. */
export async function navStudy(c: Compiled): Promise<NavStudy> {
  if (!c.root || !c.project) throw new Error("the plan does not compile: " + c.errors.join("; "));
  await ensure();
  const t0 = Date.now();
  const { areas, landings } = navMetadata(c);
  const doors = doorsOf(c, areas);
  const issues: string[] = [];
  // lifts: an off-mesh link between consecutive landings
  const links: { a: Vec3; b: Vec3 }[] = [];
  const byLift = new Map<string, typeof landings>();
  for (const l of landings) byLift.set(l.lift, [...(byLift.get(l.lift) ?? []), l]);
  for (const ls of byLift.values()) {
    ls.sort((a, b) => a.stop - b.stop);
    for (let k = 0; k + 1 < ls.length; k++) links.push({ a: [ls[k].at[0], ls[k].at[1], ls[k].z], b: [ls[k + 1].at[0], ls[k + 1].at[1], ls[k + 1].z] });
  }
  const geo = navGeometry(c);
  const meshes = Object.fromEntries(NAV_AGENTS.map((a) => [a.id, bake(geo, a, links)])) as Record<NavAgent["id"], NavMesh>;
  const queries = Object.fromEntries(NAV_AGENTS.map((a) => [a.id, new NavMeshQuery(meshes[a.id])])) as Record<NavAgent["id"], NavMeshQuery>;
  const bakeMs = Date.now() - t0;
  // every lift landing must stand on walkable floor, or the lift links nothing
  for (const l of landings) {
    for (const ag of NAV_AGENTS) {
      const f = queries[ag.id].findClosestPoint(toY(l.at, l.z + 0.05), { halfExtents: { x: 0.5, y: 0.3, z: 0.5 } });
      const p = f.success && f.polyRef ? fromY(f.point) : undefined;
      if (!p || Math.hypot(p[0] - l.at[0], p[1] - l.at[1]) > 0.45) {
        const room = areas.find((a) => a.level === l.level && a.kind !== "stairs" && pointInPolygon(l.at, a.poly))?.name;
        issues.push(`lift '${l.lift}': a ${ag.label} cannot stand at its landing on ${c.levels[l.level].name}${room ? ` (in the ${room})` : ""} — clear 1.5 × 1.5 m in front of the lift door.`);
        break;
      }
    }
  }

  // the entrance: an exterior door on the floor nearest ground level (main / entry / front first, then the widest)
  const gl = c.levels.map((l, i) => ({ i, e: l.elevation })).filter((x) => x.e > -0.6).sort((a, b) => Math.abs(a.e) - Math.abs(b.e))[0]?.i ?? 0;
  const ext = doors
    .filter((d) => d.level === gl && d.rooms.includes("outside") && d.rooms.some((r) => r !== "outside"))
    .sort((a, b) => Number(/main|entr|front/i.test(b.id)) - Number(/main|entr|front/i.test(a.id)) || b.width - a.width);
  const z0 = c.levels[gl].elevation;
  let start: { at: Vec2; z: number; door?: string; outside: boolean } = { at: polygonCentroid(areas.filter((a) => a.level === gl)[0]?.poly ?? [[0, 0], [1, 0], [1, 1]]), z: z0, outside: false };
  if (ext[0]) {
    const o = c.levels[gl].openings.find((x) => x.id === ext[0].id)!;
    const d = v2.norm(v2.sub(o.seg.b, o.seg.a));
    const n: Vec2 = [-d[1], d[0]];
    const outs = [1, -1].map((s) => v2.add(ext[0].at, v2.scale(n, s * (o.seg.thickness / 2 + 0.7))));
    // start just inside: the approach (steps, ramp, threshold) is site work the model does not carry
    const out = outs.find((p) => !areas.some((a) => a.level === gl && a.kind !== "stairs" && pointInPolygon(p, a.poly)));
    const inn = outs.find((p) => p !== out) ?? outs[0];
    start = { at: inn, z: z0, door: ext[0].id, outside: false };
  } else issues.push("no exterior door found on the ground floor: paths start inside");

  const rooms: NavRoomResult[] = [];
  const skip = /void|open to below|shaft|duct|riser/i;
  // planting and gravel beds are not destinations
  const beds = new Set(c.project.levels.flatMap((lv) => lv.gardens.filter((g) => ["planting", "mulch", "gravel", "sand"].includes(g.surface)).map((g) => g.id ?? `${g.surface} area`)));
  for (const a of areas) {
    if (a.kind === "stairs" || skip.test(a.name) || (a.kind === "outdoor" && beds.has(a.name))) continue;
    const centre = polygonCentroid(a.poly);
    const cands = standCandidates(a.poly, centre);
    const res = {} as Pick<NavRoomResult, "person" | "wheelchair">;
    let path: Vec3[] | undefined;
    for (const ag of NAV_AGENTS) {
      const q = queries[ag.id];
      // a standing spot in the room on its floor (not a table top, not the stairwell): nearest the centre first
      let spot: ReturnType<NavMeshQuery["findClosestPoint"]> | undefined, sp: Vec3 | undefined;
      for (const cnd of cands) {
        const f = q.findClosestPoint(toY(cnd, a.z + 0.05), { halfExtents: { x: 0.3, y: 0.25, z: 0.3 } });
        const p = f.success && f.polyRef ? fromY(f.point) : undefined;
        if (p && pointInPolygon([p[0], p[1]], a.poly) && Math.abs(p[2] - a.z) < 0.2) {
          spot = f;
          sp = p;
          break;
        }
      }
      if (!spot || !sp) {
        res[ag.id] = { reached: false, why: "no floor a " + ag.label + " can stand on (too small, or furniture fills it)" };
        continue;
      }
      const r = q.computePath(toY(start.at, start.z), spot.point, { halfExtents: { x: 0.6, y: 0.5, z: 0.6 }, maxPathPolys: 8192, maxStraightPathPoints: 1024 });
      const pts = (r.path ?? []).map(fromY);
      const end = pts[pts.length - 1];
      const ok = r.success && !!end && Math.hypot(end[0] - sp[0], end[1] - sp[1]) < 0.4 && Math.abs(end[2] - sp[2]) < 0.5;
      res[ag.id] = ok ? { reached: true, distance: r1(plen(pts)) } : { reached: false };
      if (ok && ag.id === "person") path = pts;
    }
    rooms.push({ level: a.level, name: a.name, kind: a.kind, ...res, centre, path });
  }

  // why: narrow doors into the room, stairs only, furniture, steps
  const narrow = (ag: NavAgent, d: NavDoor) => d.width - 0.1 < 2 * ag.radius + 0.02;
  let bare: Record<string, NavMeshQuery> | undefined;
  const needBare = rooms.some((r) => (!r.person.reached && !r.person.why) || (!r.wheelchair.reached && !r.wheelchair.why));
  const g2 = needBare ? navGeometry(c, { furniture: false }) : undefined;
  if (g2) {
    bare = Object.fromEntries(NAV_AGENTS.map((a) => [a.id, new NavMeshQuery(bake(g2, a, links))]));
  }
  for (const room of rooms) {
    const a = areas.find((x) => x.level === room.level && x.name === room.name)!;
    const into = doors.filter((d) => d.level === room.level && d.rooms.includes(room.name));
    for (const ag of NAV_AGENTS) {
      const res = room[ag.id];
      if (res.reached || res.why) continue;
      const tight = into.filter((d) => narrow(ag, d));
      const byStairs = ag.id === "wheelchair" && room.person.reached && room.path?.some((p) => areas.some((s) => s.kind === "stairs" && pointInPolygon([p[0], p[1]], s.poly)));
      if (byStairs) res.why = `only by the stairs: add a lift or a ramp${tight.length === into.length && into.length ? ` (and its door '${tight[0].id}' is ${tight[0].width} m)` : ""}`;
      else if (!into.length && a.kind !== "outdoor") res.why = "no door into it";
      else if (into.length && tight.length === into.length) res.why = `${tight.map((d) => `door '${d.id}' is ${d.width} m`).join(", ")} — a ${ag.label} needs ${(Math.round((2 * ag.radius + 0.12) * 100) / 100).toFixed(2)} m`;
      else if (bare) {
        const q = bare[ag.id];
        const spot = q.findClosestPoint(toY(room.centre, a.z + 0.05), { halfExtents: { x: 1, y: 0.3, z: 1 } });
        const r = spot.success ? q.computePath(toY(start.at, start.z), spot.point, { halfExtents: { x: 0.6, y: 0.5, z: 0.6 }, maxPathPolys: 8192, maxStraightPathPoints: 1024 }) : undefined;
        const end = r?.path?.length ? fromY(r.path[r.path.length - 1]) : undefined;
        if (end && Math.hypot(end[0] - spot.point.x, -end[1] - spot.point.z) < 0.4) {
          const hit = blockers(r!.path.map(fromY), geo.furniture, ag);
          res.why = hit.length
            ? `furniture in the way, first ${hit.slice(0, 2).map((f) => `${f.id} (${f.type}) at [${r1((f.lo[0] + f.hi[0]) / 2)}, ${r1((f.lo[1] + f.hi[1]) / 2)}]`).join(", then ")} — move it, or leave 0.9 m clear past it`
            : "furniture blocks the way in";
        }
        else res.why = ag.id === "wheelchair" ? "a step, ramp steeper than 1:10, or a gap narrower than 0.8 m on the way" : "a step higher than 20 cm or a gap narrower than 0.5 m on the way";
      }
    }
  }
  const narrowDoors = doors.filter((d) => narrow(NAV_AGENTS[1], d) && d.rooms.some((r) => r !== "outside"));
  const lost = rooms.filter((r) => !r.person.reached);
  if (lost.length) issues.push(`${lost.length} room${lost.length > 1 ? "s" : ""} a person cannot reach from the entrance: ${lost.map((r) => r.name).join(", ")}.`);
  const wl = rooms.filter((r) => r.person.reached && !r.wheelchair.reached);
  if (wl.length) issues.push(`${wl.length} room${wl.length > 1 ? "s" : ""} a wheelchair user cannot reach: ${wl.map((r) => `${r.name} (${r.wheelchair.why ?? "?"})`).join("; ")}.`);

  const mesh = Object.fromEntries(
    NAV_AGENTS.map((a) => {
      const [p, i] = getNavMeshPositionsAndIndices(meshes[a.id]);
      const plan: number[] = [];
      for (let k = 0; k < p.length; k += 3) plan.push(p[k], -p[k + 2], p[k + 1]);
      return [a.id, { positions: plan, indices: i }];
    }),
  ) as NavStudy["mesh"];
  const walkable = Object.fromEntries(
    NAV_AGENTS.map((a) => {
      const { positions: P, indices: I } = mesh[a.id];
      let s = 0;
      for (let k = 0; k < I.length; k += 3) {
        const [i0, i1, i2] = [I[k] * 3, I[k + 1] * 3, I[k + 2] * 3];
        s += Math.abs((P[i1] - P[i0]) * (P[i2 + 1] - P[i0 + 1]) - (P[i2] - P[i0]) * (P[i1 + 1] - P[i0 + 1])) / 2;
      }
      return [a.id, Math.round(s)];
    }),
  ) as Record<NavAgent["id"], number>;
  for (const a of NAV_AGENTS) meshes[a.id].destroy();
  return {
    entrance: { level: gl, at: start.at, door: start.door, outside: start.outside },
    rooms,
    narrowDoors,
    mesh,
    stats: { triangles: geo.triangles, bakeMs, walkable },
    issues,
  };
}

export function navReport(s: NavStudy, levelNames: string[]): string {
  const out: string[] = [];
  out.push(
    `Navigation check — Recast navmesh baked from the collision geometry (${s.stats.triangles} triangles, ${s.stats.bakeMs} ms); doors open, furniture as obstacles, lifts linked.`,
  );
  out.push(`Agents: ${NAV_AGENTS.map((a) => `${a.label} (Ø${a.radius * 2} m, ${a.height} m tall, steps ≤ ${a.climb * 100} cm, slopes ≤ ${a.slope}°)`).join("; ")}.`);
  out.push(`Walkable floor: ${s.stats.walkable.person} m² for a person, ${s.stats.walkable.wheelchair} m² for a wheelchair.`);
  out.push(`From: ${s.entrance.door ? `door '${s.entrance.door}'` : "inside"} on ${levelNames[s.entrance.level]} (${s.entrance.outside ? "outside it" : "just inside"}).`);
  for (const i of s.issues) out.push(`! ${i}`);
  const levels = [...new Set(s.rooms.map((r) => r.level))].sort((a, b) => a - b);
  for (const li of levels) {
    out.push("", `${levelNames[li]}:`);
    for (const r of s.rooms.filter((x) => x.level === li)) {
      const p = r.person.reached ? `${r.person.distance} m` : `NOT REACHED — ${r.person.why ?? "?"}`;
      const w = r.wheelchair.reached ? `wheelchair ${r.wheelchair.distance} m` : `no wheelchair — ${r.wheelchair.why ?? "?"}`;
      out.push(`  ${r.name.padEnd(30)} ${p}${r.person.reached ? `; ${w}` : ""}`);
    }
  }
  if (s.narrowDoors.length) {
    out.push("", "Doors narrower than a wheelchair needs (0.8 m clear):");
    for (const d of s.narrowDoors) out.push(`  ${levelNames[d.level]}: '${d.id}' ${d.width} m between ${d.rooms.join(" and ")}`);
  }
  out.push("", "The navmesh is the one Unity bakes from the same model (export_model engine 'unity' with the Architecturer package); distances follow the shortest walking path.");
  return out.join("\n");
}

/** Plan image: each floor's walkable area for both agents, rooms coloured by reach, the entrance and paths. */
export function navSVG(c: Compiled, s: NavStudy): string {
  const levels = c.levels.map((l, i) => ({ l, i })).filter(({ i }) => s.rooms.some((r) => r.level === i));
  const font = `font-family="Liberation Sans, Helvetica, Arial, sans-serif"`;
  const pts = c.levels.flatMap((l) => l.segments.flatMap((sg) => [sg.a, sg.b]));
  const bb = boxOf(pts, 2); // no Math.min(...pts): a campus has more wall ends than the call stack takes
  const x0 = bb.x0, x1 = bb.x1, y0 = bb.y0, y1 = bb.y1;
  const cols = Math.min(2, levels.length), rows = Math.ceil(levels.length / cols);
  const PW = 640, sc = PW / (x1 - x0), PH = (y1 - y0) * sc;
  const W = cols * PW + (cols + 1) * 30, H = 110 + rows * (PH + 50);
  const o: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" ${font}><rect width="${W}" height="${H}" fill="#fff"/>`];
  o.push(`<text x="30" y="38" font-size="22" font-weight="bold" fill="#1d2b36">Navigation — ${esc(c.project?.name ?? "")}</text>`);
  o.push(
    `<text x="30" y="62" font-size="13" fill="#55606a"><tspan fill="#9fd49a">■</tspan> walkable on foot  <tspan fill="#5d93c4">■</tspan> also by wheelchair  <tspan fill="#e74c3c">■</tspan> room not reached  <tspan fill="#f39c12">■</tspan> no wheelchair access  ● entrance · grey lines: walking paths</text>`,
  );
  levels.forEach(({ l, i }, k) => {
    const ox = 30 + (k % cols) * (PW + 30), oy = 90 + Math.floor(k / cols) * (PH + 50);
    const X = (x: number) => (ox + (x - x0) * sc).toFixed(1), Y = (y: number) => (oy + (y1 - y) * sc).toFixed(1);
    o.push(`<text x="${ox}" y="${oy - 8}" font-size="15" font-weight="bold" fill="#1d2b36">${esc(l.name)}</text>`);
    o.push(`<rect x="${ox}" y="${oy}" width="${PW}" height="${PH}" fill="#f7f8f9" stroke="#e1e5e8"/>`);
    o.push(`<clipPath id="lv${k}"><rect x="${ox}" y="${oy}" width="${PW}" height="${PH}"/></clipPath><g clip-path="url(#lv${k})">`);
    // rooms by reach
    const areas = navMetadata(c).areas.filter((a) => a.level === i && a.kind !== "stairs");
    for (const a of areas) {
      const r = s.rooms.find((x) => x.level === i && x.name === a.name);
      const fill = !r ? "#eeeeee" : !r.person.reached ? "#fadbd8" : !r.wheelchair.reached ? "#fdebd0" : "#ffffff";
      o.push(`<polygon points="${a.poly.map((p) => `${X(p[0])},${Y(p[1])}`).join(" ")}" fill="${fill}" stroke="#c9ced3" stroke-width="0.8"/>`);
    }
    // walkable triangles on this floor
    for (const [ag, col] of [["person", "#9fd49a"], ["wheelchair", "#1f6fb2"]] as const) {
      const { positions: P, indices: I } = s.mesh[ag];
      const tri: string[] = [];
      for (let t = 0; t < I.length; t += 3) {
        const zs = [I[t], I[t + 1], I[t + 2]].map((v) => P[v * 3 + 2]);
        const zm = (zs[0] + zs[1] + zs[2]) / 3;
        if (zm < l.elevation - 0.25 || zm > l.elevation + l.height - 0.6) continue;
        tri.push(`M${X(P[I[t] * 3])},${Y(P[I[t] * 3 + 1])}L${X(P[I[t + 1] * 3])},${Y(P[I[t + 1] * 3 + 1])}L${X(P[I[t + 2] * 3])},${Y(P[I[t + 2] * 3 + 1])}Z`);
      }
      if (tri.length) o.push(`<path d="${tri.join("")}" fill="${col}" fill-opacity="${ag === "person" ? 0.85 : 0.4}" stroke="none"/>`);
    }
    // walls
    for (const sg of l.segments) o.push(`<line x1="${X(sg.a[0])}" y1="${Y(sg.a[1])}" x2="${X(sg.b[0])}" y2="${Y(sg.b[1])}" stroke="#2c3e50" stroke-width="${Math.max(1.5, sg.thickness * sc)}" stroke-linecap="square"/>`);
    // narrow doors
    for (const d of s.narrowDoors.filter((d) => d.level === i)) o.push(`<circle cx="${X(d.at[0])}" cy="${Y(d.at[1])}" r="6" fill="none" stroke="#f39c12" stroke-width="2"/>`);
    // paths on this floor
    for (const r of s.rooms) {
      if (!r.path) continue;
      const seg = r.path.filter((p) => p[2] > l.elevation - 0.3 && p[2] < l.elevation + l.height - 0.5);
      if (seg.length > 1) o.push(`<polyline points="${seg.map((p) => `${X(p[0])},${Y(p[1])}`).join(" ")}" fill="none" stroke="#7f8c8d" stroke-width="1" stroke-opacity="0.55"/>`);
    }
    // labels
    for (const r of s.rooms.filter((x) => x.level === i)) {
      const t = r.person.reached ? `${r.person.distance} m${r.wheelchair.reached ? "" : " · no wheelchair"}` : "not reached";
      o.push(`<text x="${X(r.centre[0])}" y="${Y(r.centre[1])}" font-size="10.5" text-anchor="middle" fill="#2c3e50">${esc(r.name.slice(0, 26))}</text><text x="${X(r.centre[0])}" y="${+Y(r.centre[1]) + 12}" font-size="10" text-anchor="middle" fill="${r.person.reached ? (r.wheelchair.reached ? "#1e8449" : "#b9770e") : "#c0392b"}">${esc(t)}</text>`);
    }
    o.push("</g>");
    if (s.entrance.level === i) o.push(`<circle cx="${X(s.entrance.at[0])}" cy="${Y(s.entrance.at[1])}" r="7" fill="#2c3e50"/><text x="${+X(s.entrance.at[0]) + 10}" y="${+Y(s.entrance.at[1]) + 4}" font-size="11" font-weight="bold" fill="#2c3e50">entrance</text>`);
  });
  o.push("</svg>");
  return o.join("");
}
const esc = (t: string) => t.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
