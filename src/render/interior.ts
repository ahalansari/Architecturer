import { FLOOR_FINISH } from "../build.js";
import { FURNITURE } from "../elements/furniture.js";
import { segDir, segLength } from "../elements/walls.js";
import { pointInPolygon, polygonCentroid, v2, type Vec2, type Vec3 } from "../geometry/math.js";
import type { Compiled } from "../pipeline.js";
import type { Camera } from "./raster.js";

/**
 * Cameras for interior design review:
 *  - room view: eye-level wide shot from a corner of a room, looking across it
 *  - wall elevation: orthographic, square-on view of one wall face from inside a room
 *    (for checking kitchens, wardrobes, tiling and art placement)
 */

export interface InteriorView {
  /** Room id or name. */
  room?: string;
  /** Which corner to shoot from (0 = the corner farthest from the centre; 1, 2... the next ones). */
  corner?: number;
  /** Wall id to show square-on. */
  elevation?: string;
  /** For elevations: which room's side of the wall (default: the wall's interior side). */
  elevationRoom?: string;
}

export function findRoom(c: Compiled, key: string) {
  const want = key.toLowerCase();
  for (const [li, lv] of c.project!.levels.entries())
    for (const r of lv.rooms)
      if (r.id === key || r.name.toLowerCase() === want) return { li, room: r, polygon: r.polygon as Vec2[] };
  const all = c.project!.levels.flatMap((l) => l.rooms.map((r) => r.id ?? r.name));
  throw new Error(`room '${key}' not found (rooms: ${all.join(", ") || "none"})`);
}

export interface InteriorShot {
  camera: Camera;
  /** Level index the shot belongs to; elevations hide the floors above it. */
  level: number;
  /** Elevations clip at the top of the wall. */
  clipZ?: number;
}

export function interiorCamera(c: Compiled, v: InteriorView, aspect: number): InteriorShot {
  if (v.elevation) return elevationCamera(c, v, aspect);
  const { li, polygon } = findRoom(c, v.room!);
  const floor = c.levels[li].elevation + FLOOR_FINISH;
  const ctr = polygonCentroid(polygon);
  // furniture in the room as rough circles, so the camera doesn't end up behind the fridge
  const lv = c.project!.levels[li];
  const blockers = lv.furniture
    .filter((f) => pointInPolygon(f.position as Vec2, polygon) && f.elevation < 1.6)
    .map((f) => {
      const t = FURNITURE[f.type];
      const w = f.width ?? t?.defaults.width ?? 0.5, d = f.depth ?? t?.defaults.depth ?? 0.5, h = f.height ?? t?.defaults.height ?? 1;
      return { p: f.position as Vec2, r: Math.hypot(w, d) / 2, tall: h > 1.2 };
    });
  // fitted cabinetry blocks corners too: sample each run's footprint as small circles
  const cw = ((lv as unknown as { casework?: Record<string, any>[] }).casework ?? []);
  for (const c of cw) {
    const depth = c.depth ?? (c.type === "wardrobe" ? 0.6 : c.type === "shelving" ? 0.35 : 0.6);
    if (Array.isArray(c.position)) {
      blockers.push({ p: c.position as Vec2, r: Math.max(c.length ?? 2, depth) / 2 + 0.2, tall: false });
      continue;
    }
    const path: Vec2[] = Array.isArray(c.path) ? c.path : [];
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i], b = path[i + 1];
      const n = Math.max(1, Math.ceil(v2.dist(a, b) / 0.5));
      for (let k = 0; k <= n; k++) {
        const q = v2.lerp(a, b, k / n);
        // the cabinets sit in front of the back edge, toward the room centre
        const into = v2.norm(v2.sub(ctr, q));
        blockers.push({ p: v2.add(q, v2.scale(into, depth / 2)), r: depth / 2 + 0.1, tall: c.type === "wardrobe" || c.type === "shelving" });
      }
    }
  }
  // corners ranked by: room for the camera, then distance from the centre (far corners see the most)
  const corners = polygon
    .map((p, i) => {
      const prev = polygon[(i - 1 + polygon.length) % polygon.length], next = polygon[(i + 1) % polygon.length];
      // step inward along the corner's bisector so the camera isn't inside the wall
      const bis = v2.norm(v2.add(v2.norm(v2.sub(prev, p)), v2.norm(v2.sub(next, p))));
      let eye = v2.add(p, v2.scale(bis, 0.7));
      if (!pointInPolygon(eye, polygon)) eye = v2.lerp(p, ctr, 0.15);
      const clear = Math.min(1.5, ...blockers.map((b) => v2.dist(eye, b.p) - b.r - (b.tall ? 0.4 : 0)));
      return { eye, d: v2.dist(p, ctr), score: Math.min(clear, 1.2) * 3 + v2.dist(p, ctr) * 0.3 };
    })
    .sort((a, b) => b.score - a.score);
  let pick = corners[(v.corner ?? 0) % corners.length];
  const clearOf = (q: Vec2) => Math.min(1.5, ...blockers.map((b) => v2.dist(q, b.p) - b.r - (b.tall ? 0.4 : 0)));
  if (clearOf(pick.eye) < 0.3 && v.corner === undefined) {
    // every corner is boxed in (e.g. a walk-in closet): stand at the most open spot and look into the farthest corner
    let best: { q: Vec2; c: number } | null = null;
    const xs = polygon.map((p) => p[0]), ys = polygon.map((p) => p[1]);
    for (let x = Math.min(...xs) + 0.15; x < Math.max(...xs); x += 0.15)
      for (let y = Math.min(...ys) + 0.15; y < Math.max(...ys); y += 0.15) {
        const q: Vec2 = [x, y];
        if (!pointInPolygon(q, polygon)) continue;
        const c = clearOf(q);
        if (!best || c > best.c) best = { q, c };
      }
    if (best) {
      const far = [...polygon].sort((a, b) => v2.dist(b, best!.q) - v2.dist(a, best!.q))[0];
      // back up a little from the far corner so more of the room fits
      const eye = v2.add(best.q, v2.scale(v2.norm(v2.sub(best.q, far)), Math.min(0.4, best.c)));
      return {
        camera: { eye: [eye[0], eye[1], floor + 1.5], target: [far[0], far[1], floor + 1.1], fov: aspect >= 1 ? 72 : 88 },
        level: li,
      };
    }
  }
  const look = v2.lerp(pick.eye, ctr, 2); // look past the centre toward the far side
  return {
    camera: { eye: [pick.eye[0], pick.eye[1], floor + 1.5], target: [look[0], look[1], floor + 1.15], fov: aspect >= 1 ? 62 : 80 },
    level: li,
  };
}

function elevationCamera(c: Compiled, v: InteriorView, aspect: number): InteriorShot {
  const wallId = v.elevation!;
  const li = c.levels.findIndex((l) => l.segments.some((s) => s.wallId === wallId));
  if (li < 0) {
    const ids = [...new Set(c.levels.flatMap((l) => l.segments.map((s) => s.wallId)))];
    throw new Error(`wall '${wallId}' not found (walls: ${ids.join(", ")})`);
  }
  const segs = c.levels[li].segments.filter((s) => s.wallId === wallId);
  const roomPoly = v.elevationRoom ? findRoom(c, v.elevationRoom).polygon : null;
  // the longest segment of that wall that faces the requested room (or its interior side)
  const scored = segs
    .map((s) => {
      const d = segDir(s), N = v2.perp(d);
      const L = segLength(s);
      let side = s.interiorSide === "left" ? 1 : -1;
      let u0 = 0, u1 = L;
      if (roomPoly) {
        // the stretch of this segment that bounds the room, on whichever side the room is
        const off = s.thickness / 2 + 0.3;
        for (const sd of [1, -1]) {
          const inside: number[] = [];
          for (let k = 0; k <= 40; k++) {
            const u = (L * k) / 40;
            if (pointInPolygon(v2.add(v2.add(s.a, v2.scale(d, u)), v2.scale(N, sd * off)), roomPoly)) inside.push(u);
          }
          if (inside.length >= 2) {
            side = sd;
            u0 = Math.max(0, inside[0] - L / 40);
            u1 = Math.min(L, inside[inside.length - 1] + L / 40);
            break;
          }
          if (sd === -1) return null;
        }
      }
      return { s, len: u1 - u0, mid: v2.add(s.a, v2.scale(d, (u0 + u1) / 2)), n: v2.scale(N, side) };
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
    .sort((a, b) => b.len - a.len);
  if (!scored.length) throw new Error(`wall '${wallId}' does not bound room '${v.elevationRoom}'`);
  // walls are split at junctions: merge the collinear pieces that face the same room into one stretch
  let { s, len, mid, n } = scored[0];
  {
    const d = segDir(s);
    let lo = v2.dot(v2.sub(mid, s.a), d) - len / 2, hi = lo + len;
    for (const o of scored.slice(1)) {
      const od = segDir(o.s);
      if (Math.abs(v2.cross(d, od)) > 1e-3 || Math.abs(v2.cross(d, v2.sub(o.s.a, s.a))) > 1e-3 || v2.dot(o.n, n) < 0.99) continue;
      const c = v2.dot(v2.sub(o.mid, s.a), d);
      lo = Math.min(lo, c - o.len / 2);
      hi = Math.max(hi, c + o.len / 2);
    }
    len = hi - lo;
    mid = v2.add(s.a, v2.scale(d, (lo + hi) / 2));
  }
  const face = v2.add(mid, v2.scale(n, s.thickness / 2));
  const zc = (s.z0 + s.z1) / 2;
  const half = Math.max((s.z1 - s.z0) / 2, len / 2 / aspect) * 1.06;
  // stand 2.4 m in front of the face: everything between (cabinets, furniture) is in view, the room behind is clipped
  const eye = v2.add(face, v2.scale(n, 2.4));
  const up: Vec3 = [0, 0, 1];
  return { camera: { eye: [eye[0], eye[1], zc], target: [face[0], face[1], zc], up, ortho: half }, level: li, clipZ: s.z1 + 0.01 };
}
