import { lineIntersect, pointSegment, signedArea, v2, type Vec2, type Vec3 } from "../geometry/math.js";
import type { MeshBuilder } from "../geometry/mesh.js";
import type { Project, Wall } from "../schema/schema.js";
import { assemblyThickness, wallAssembly, type WallAssemblyId } from "./construction.js";

/** One straight piece of wall after polylines are expanded and junctions split. */
export interface WallSegment {
  wallId: string;
  /** Index of the source wall in level.walls. */
  wallIndex: number;
  a: Vec2;
  b: Vec2;
  thickness: number;
  /** Absolute z of the wall bottom and top. */
  z0: number;
  z1: number;
  matLeft: string;
  matRight: string;
  matTop: string;
  /** Which side faces the inside of a closed loop (doors swing "in" toward it). */
  interiorSide: "left" | "right";
  /** Distance along the source polyline from its first point to `a`. */
  dist0: number;
  /** Corner points after junction resolution (own left/right faces at each end). */
  aL: Vec2;
  aR: Vec2;
  bL: Vec2;
  bR: Vec2;
  /** True when nothing else connects at that end (gets an end cap). */
  freeA: boolean;
  freeB: boolean;
  holes: WallHole[];
  /** Part of a closed loop (exterior wall): reveals take the interior face's finish across the whole thickness. */
  exterior?: boolean;
  /** What the wall is built of (elements/construction.ts). */
  construction?: WallAssemblyId;
  /** Per-room face finishes (set by elements/finishes.ts); faces without a zone keep matLeft/matRight/matTop. */
  paint?: WallPaint;
}

/** Height bands of a face: band i covers z from bands[i-1].z1 (or -inf) up to bands[i].z1 (absolute z). */
export interface FaceBand {
  z1: number;
  /** null = keep the face's own material. */
  material: string | null;
}

/** A stretch [u0, u1] (segment u, meters from `a`) of a face with its height bands. */
export interface FaceZone {
  u0: number;
  u1: number;
  bands: FaceBand[];
}

export interface WallPaint {
  left: FaceZone[];
  right: FaceZone[];
  /** End caps of free ends (only painted when the cap faces into a finished room). */
  capA?: FaceBand[];
  capB?: FaceBand[];
}

function bandMaterial(bands: FaceBand[] | undefined, z: number, def: string): string {
  if (bands) for (const b of bands) if (z < b.z1) return b.material ?? def;
  return def;
}

function zoneAt(zones: FaceZone[] | undefined, u: number): FaceZone | undefined {
  return zones?.find((z) => u >= z.u0 - 1e-6 && u <= z.u1 + 1e-6);
}

/** Material of a painted face at (u, z). */
export function faceMaterial(zones: FaceZone[] | undefined, u: number, z: number, def: string): string {
  return bandMaterial(zoneAt(zones, u)?.bands, z, def);
}

/** Split [a, b] at the given cut values (kept sorted, deduplicated). */
function cutRange(a: number, b: number, cuts: Iterable<number>): number[] {
  const xs = [a, b];
  for (const c of cuts) if (c > a + 1e-5 && c < b - 1e-5) xs.push(c);
  return [...new Set(xs)].sort((x, y) => x - y);
}

/** Emit a face rectangle split along u by zone boundaries and along z by band boundaries, each piece with its material. */
function paintedRect(
  zones: FaceZone[] | undefined,
  def: string,
  ua: number,
  ub: number,
  za: number,
  zb: number,
  emit: (mat: string, ua: number, ub: number, za: number, zb: number) => void,
) {
  if (!zones?.length) return emit(def, ua, ub, za, zb);
  const us = cutRange(ua, ub, zones.flatMap((z) => [z.u0, z.u1]));
  for (let i = 0; i < us.length - 1; i++) {
    const zone = zoneAt(zones, (us[i] + us[i + 1]) / 2);
    const zs = cutRange(za, zb, zone ? zone.bands.map((b) => b.z1) : []);
    for (let j = 0; j < zs.length - 1; j++) emit(bandMaterial(zone?.bands, (zs[j] + zs[j + 1]) / 2, def), us[i], us[i + 1], zs[j], zs[j + 1]);
  }
}

export interface WallHole {
  u0: number;
  u1: number;
  z0: number;
  z1: number;
}

export const segLength = (s: WallSegment) => v2.dist(s.a, s.b);
export const segDir = (s: WallSegment) => v2.norm(v2.sub(s.b, s.a));

/** Wall ids default to "wall<index>" so openings can still reference them. */
export const wallIdOf = (w: Wall, i: number) => w.id ?? `wall${i}`;

export function expandWalls(
  walls: Wall[],
  project: Project,
  levelElevation: number,
  levelHeight: number,
): WallSegment[] {
  const d = project.defaults;
  const segs: WallSegment[] = [];
  walls.forEach((w, wi) => {
    const pts = w.points;
    const closed = w.closed && pts.length >= 3;
    const thickness = w.thickness ?? (w.construction ? assemblyThickness(w.construction) : closed ? d.exteriorWallThickness ?? d.wallThickness : d.wallThickness);
    const construction = wallAssembly(project.construction, w, closed, thickness);
    // For closed loops the interior is on the left of a counter-clockwise loop.
    const ccw = closed ? signedArea(pts) > 0 : true;
    const interiorSide: "left" | "right" = ccw ? "left" : "right";
    const base = w.material ?? d.wallMaterial;
    const interior = w.interiorMaterial ?? base;
    const exterior = w.exteriorMaterial ?? w.material ?? (closed ? d.exteriorMaterial ?? base : base);
    let matLeft = closed ? (interiorSide === "left" ? interior : exterior) : base;
    let matRight = closed ? (interiorSide === "left" ? exterior : interior) : base;
    if (w.leftMaterial) matLeft = w.leftMaterial;
    if (w.rightMaterial) matRight = w.rightMaterial;
    const z0 = levelElevation + w.baseOffset;
    const z1 = z0 + (w.height ?? levelHeight);
    const n = closed ? pts.length : pts.length - 1;
    let dist = 0;
    for (let i = 0; i < n; i++) {
      const a = pts[i] as Vec2, b = pts[(i + 1) % pts.length] as Vec2;
      const len = v2.dist(a, b);
      if (len < 1e-4) continue;
      segs.push({
        wallId: wallIdOf(w, wi),
        wallIndex: wi,
        a: [a[0], a[1]],
        b: [b[0], b[1]],
        thickness,
        z0,
        z1,
        matLeft,
        matRight,
        matTop: w.topMaterial ?? base,
        interiorSide,
        exterior: closed,
        construction,
        dist0: dist,
        aL: a, aR: a, bL: b, bR: b,
        freeA: true,
        freeB: true,
        holes: [],
      });
      dist += len;
    }
  });
  return segs;
}

/**
 * Make junctions explicit: snap endpoints that land on (or within half a
 * thickness of) another wall's interior onto its centerline, and split walls
 * at T-junctions and crossings so every junction is a shared endpoint.
 */
export function splitJunctions(segs: WallSegment[], warnings: string[]): WallSegment[] {
  const splits = new Map<WallSegment, number[]>();
  const addSplit = (s: WallSegment, t: number) => {
    if (t < 1e-3 || t > 1 - 1e-3) return;
    const arr = splits.get(s) ?? [];
    if (!arr.some((x) => Math.abs(x - t) * segLength(s) < 1e-3)) arr.push(t);
    splits.set(s, arr);
  };

  for (const s of segs) {
    for (const o of segs) {
      if (o === s) continue;
      const od = segDir(o), sd = segDir(s);
      const angle = Math.abs(v2.cross(od, sd));
      for (const end of ["a", "b"] as const) {
        const p = s[end];
        const { dist, t } = pointSegment(p, o.a, o.b);
        const interior = t > 1e-3 && t < 1 - 1e-3;
        if (!interior) continue;
        const tol = Math.max(o.thickness / 2 + 0.02, 0.01);
        if (dist < 1e-3) addSplit(o, t);
        else if (dist < tol && angle > 0.34) {
          // ended at the face of the other wall: extend/trim onto its centerline
          const hit = lineIntersect(s.a, v2.sub(s.b, s.a), o.a, v2.sub(o.b, o.a));
          if (hit) {
            const tt = pointSegment(hit, o.a, o.b).t;
            s[end] = hit;
            addSplit(o, tt);
          }
        }
      }
    }
  }

  // proper crossings (X junctions)
  for (let i = 0; i < segs.length; i++)
    for (let j = i + 1; j < segs.length; j++) {
      const s = segs[i], o = segs[j];
      const d1 = v2.sub(s.b, s.a), d2 = v2.sub(o.b, o.a);
      const den = v2.cross(d1, d2);
      if (Math.abs(den) < 1e-9) continue;
      const t = v2.cross(v2.sub(o.a, s.a), d2) / den;
      const u = v2.cross(v2.sub(o.a, s.a), d1) / den;
      if (t > 1e-3 && t < 1 - 1e-3 && u > 1e-3 && u < 1 - 1e-3) {
        addSplit(s, t);
        addSplit(o, u);
      }
    }

  const out: WallSegment[] = [];
  for (const s of segs) {
    const ts = (splits.get(s) ?? []).sort((x, y) => x - y);
    if (!ts.length) {
      out.push(s);
      continue;
    }
    const cuts = [0, ...ts, 1];
    const len = segLength(s);
    for (let k = 0; k < cuts.length - 1; k++) {
      const a = v2.lerp(s.a, s.b, cuts[k]), b = v2.lerp(s.a, s.b, cuts[k + 1]);
      out.push({ ...s, a, b, aL: a, aR: a, bL: b, bR: b, dist0: s.dist0 + cuts[k] * len, holes: [] });
    }
  }
  void warnings;
  return out;
}

/** Compute mitered corner points at every junction. */
export function resolveJoins(segs: WallSegment[]) {
  type End = { seg: WallSegment; end: "a" | "b" };
  const nodes: { p: Vec2; ends: End[] }[] = [];
  const tol = 0.02;
  for (const seg of segs)
    for (const end of ["a", "b"] as const) {
      const p = seg[end];
      let node = nodes.find((n) => v2.dist(n.p, p) < tol);
      if (!node) nodes.push((node = { p, ends: [] }));
      seg[end] = node.p; // snap to the shared node
      node.ends.push({ seg, end });
    }

  for (const node of nodes) {
    // outgoing direction of each wall away from the node
    const items = node.ends.map((e) => {
      const other = e.end === "a" ? e.seg.b : e.seg.a;
      const d = v2.norm(v2.sub(other, node.p));
      return { ...e, d, ang: Math.atan2(d[1], d[0]), half: e.seg.thickness / 2 };
    });
    items.sort((x, y) => x.ang - y.ang);
    const free = items.length === 1;
    // corner between consecutive walls (counter-clockwise order): left side of i meets right side of i+1
    const leftCorner: Vec2[] = [], rightCorner: Vec2[] = [];
    for (let i = 0; i < items.length; i++) {
      const A = items[i], B = items[(i + 1) % items.length];
      const nA = v2.perp(A.d), nB = v2.perp(B.d);
      const pA = v2.add(node.p, v2.scale(nA, A.half)); // left offset line of A
      const pB = v2.sub(node.p, v2.scale(nB, B.half)); // right offset line of B
      let c: Vec2 | null = free ? null : lineIntersect(pA, A.d, pB, B.d);
      const limit = 3 * Math.max(A.half, B.half) + 0.05;
      if (c && v2.dist(c, node.p) > limit) c = null; // near-parallel spike: fall back to square ends
      leftCorner[i] = c ?? pA;
      rightCorner[(i + 1) % items.length] = c ?? pB;
    }
    items.forEach((it, i) => {
      // outward-left == own left at end "a"; at end "b" outward direction is reversed
      if (it.end === "a") {
        it.seg.aL = leftCorner[i];
        it.seg.aR = rightCorner[i];
        it.seg.freeA = free;
      } else {
        it.seg.bR = leftCorner[i];
        it.seg.bL = rightCorner[i];
        it.seg.freeB = free;
      }
    });
  }
}

/** u-range along the segment where both faces exist (safe zone for openings). */
export function clearRange(s: WallSegment): [number, number] {
  const d = segDir(s);
  const u = (p: Vec2) => v2.dot(v2.sub(p, s.a), d);
  return [Math.max(u(s.aL), u(s.aR), 0), Math.min(u(s.bL), u(s.bR), segLength(s))];
}

/** Emit the solid parts of a rectangle [u0,u1]x[z0,z1] minus rectangular holes. */
function holedRect(
  u0: number,
  u1: number,
  z0: number,
  z1: number,
  holes: WallHole[],
  emit: (ua: number, ub: number, za: number, zb: number) => void,
) {
  const xs = new Set<number>([u0, u1]);
  for (const h of holes) {
    if (h.u0 > u0 && h.u0 < u1) xs.add(h.u0);
    if (h.u1 > u0 && h.u1 < u1) xs.add(h.u1);
  }
  const cols = [...xs].sort((a, b) => a - b);
  for (let i = 0; i < cols.length - 1; i++) {
    const ca = cols[i], cb = cols[i + 1];
    if (cb - ca < 1e-5) continue;
    let intervals: [number, number][] = [[z0, z1]];
    for (const h of holes) {
      if (h.u0 > ca + 1e-6 || h.u1 < cb - 1e-6) continue;
      const next: [number, number][] = [];
      for (const [a, b] of intervals) {
        if (h.z1 <= a || h.z0 >= b) next.push([a, b]);
        else {
          if (h.z0 > a) next.push([a, h.z0]);
          if (h.z1 < b) next.push([h.z1, b]);
        }
      }
      intervals = next;
    }
    for (const [a, b] of intervals) if (b - a > 1e-5) emit(ca, cb, a, b);
  }
}

export function buildWallSegment(mb: MeshBuilder, s: WallSegment, revealMaterial?: string) {
  const d = segDir(s);
  const N = v2.perp(d);
  const half = s.thickness / 2;
  const P = (u: number, w: number, z: number): Vec3 => [s.a[0] + d[0] * u + N[0] * w, s.a[1] + d[1] * u + N[1] * w, z];
  const uOf = (p: Vec2) => v2.dot(v2.sub(p, s.a), d);
  const holes = s.holes.map((h) => ({ ...h, z0: Math.max(h.z0, s.z0), z1: Math.min(h.z1, s.z1) })).filter((h) => h.z1 > h.z0);

  const paint = s.paint;
  // left face (+N), seen from the left: run u from high to low
  holedRect(uOf(s.aL), uOf(s.bL), s.z0, s.z1, holes, (ua, ub, za, zb) =>
    paintedRect(paint?.left, s.matLeft, ua, ub, za, zb, (m, ua, ub, za, zb) =>
      mb.quad(m, P(ub, half, za), P(ua, half, za), P(ua, half, zb), P(ub, half, zb)),
    ),
  );
  // right face (-N)
  holedRect(uOf(s.aR), uOf(s.bR), s.z0, s.z1, holes, (ua, ub, za, zb) =>
    paintedRect(paint?.right, s.matRight, ua, ub, za, zb, (m, ua, ub, za, zb) =>
      mb.quad(m, P(ua, -half, za), P(ub, -half, za), P(ub, -half, zb), P(ua, -half, zb)),
    ),
  );

  // top: footprint polygon (includes the junction centers so multi-wall nodes have no gaps)
  const foot: Vec2[] = [s.aR, s.bR, s.b, s.bL, s.aL, s.a].filter(
    (p, i, arr) => !v2.eq(p, arr[(i + arr.length - 1) % arr.length], 1e-5),
  );
  mb.flat(s.matTop, foot, s.z1);

  // end caps on free ends (split into height bands when a finished room sees them)
  const cap = (pL: Vec2, pR: Vec2, atStart: boolean, bands?: FaceBand[]) => {
    const [p0, p1] = atStart ? [pL, pR] : [pR, pL];
    const zs = cutRange(s.z0, s.z1, bands ? bands.map((b) => b.z1) : []);
    for (let j = 0; j < zs.length - 1; j++)
      mb.quad(
        bandMaterial(bands, (zs[j] + zs[j + 1]) / 2, s.matTop),
        [p0[0], p0[1], zs[j]], [p1[0], p1[1], zs[j]], [p1[0], p1[1], zs[j + 1]], [p0[0], p0[1], zs[j + 1]],
      );
  };
  if (s.freeA) cap(s.aL, s.aR, true, paint?.capA);
  if (s.freeB) cap(s.bL, s.bR, false, paint?.capB);

  // reveals: the inner faces of each hole, spanning the thickness
  const rm = revealMaterial ?? (s.interiorSide === "left" ? s.matLeft : s.matRight);
  if (!paint) {
    for (const h of holes) {
      // jamb at u0 faces +d, jamb at u1 faces -d
      mb.quad(rm, P(h.u0, -half, h.z0), P(h.u0, half, h.z0), P(h.u0, half, h.z1), P(h.u0, -half, h.z1));
      mb.quad(rm, P(h.u1, half, h.z0), P(h.u1, -half, h.z0), P(h.u1, -half, h.z1), P(h.u1, half, h.z1));
      // head faces down
      if (h.z1 < s.z1 - 1e-5) mb.quad(rm, P(h.u0, -half, h.z1), P(h.u0, half, h.z1), P(h.u1, half, h.z1), P(h.u1, -half, h.z1));
      // sill faces up
      if (h.z0 > s.z0 + 1e-5) mb.quad(rm, P(h.u0, half, h.z0), P(h.u0, -half, h.z0), P(h.u1, -half, h.z0), P(h.u1, half, h.z0));
    }
    return;
  }
  // Painted: each reveal takes the finish of the face it turns from, band by band (a tiled bathroom gets tiled
  // window reveals). Exterior walls use the interior finish across the whole depth; interior walls split at the
  // centerline so each room keeps its own finish.
  const inner = s.interiorSide === "left" ? paint.left : paint.right;
  const halves: { w0: number; w1: number; zones: FaceZone[]; def: string }[] = s.exterior
    ? [{ w0: -half, w1: half, zones: inner, def: rm }]
    : [
        { w0: -half, w1: 0, zones: paint.right, def: revealMaterial ?? s.matRight },
        { w0: 0, w1: half, zones: paint.left, def: revealMaterial ?? s.matLeft },
      ];
  const e = 1e-3;
  for (const h of holes)
    for (const { w0, w1, zones, def } of halves) {
      for (const [u, uLook, dir] of [[h.u0, h.u0 - e, 1], [h.u1, h.u1 + e, -1]] as const) {
        const bands = zoneAt(zones, uLook)?.bands;
        const zs = cutRange(h.z0, h.z1, bands ? bands.map((b) => b.z1) : []);
        for (let j = 0; j < zs.length - 1; j++) {
          const m = bandMaterial(bands, (zs[j] + zs[j + 1]) / 2, def);
          if (dir > 0) mb.quad(m, P(u, w0, zs[j]), P(u, w1, zs[j]), P(u, w1, zs[j + 1]), P(u, w0, zs[j + 1]));
          else mb.quad(m, P(u, w1, zs[j]), P(u, w0, zs[j]), P(u, w0, zs[j + 1]), P(u, w1, zs[j + 1]));
        }
      }
      const um = (h.u0 + h.u1) / 2;
      if (h.z1 < s.z1 - 1e-5)
        mb.quad(faceMaterial(zones, um, h.z1 + e, def), P(h.u0, w0, h.z1), P(h.u0, w1, h.z1), P(h.u1, w1, h.z1), P(h.u1, w0, h.z1));
      if (h.z0 > s.z0 + 1e-5)
        mb.quad(faceMaterial(zones, um, h.z0 - e, def), P(h.u0, w1, h.z0), P(h.u0, w0, h.z0), P(h.u1, w0, h.z0), P(h.u1, w1, h.z0));
    }
}
