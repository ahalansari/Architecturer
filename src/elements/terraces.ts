import { offsetPolygon, pointSegment, signedArea, v2, type Vec2 } from "../geometry/math.js";
import type { MeshBuilder } from "../geometry/mesh.js";
import type { Railing, Terrace } from "../schema/schema.js";
import { buildRailing, buildSlab, railingCollider } from "./misc.js";
import { COLLIDER } from "./stairs.js";
import { segDir, type WallSegment } from "./walls.js";

export interface TerraceContext {
  /** Level elevation. */
  z: number;
  /** Ground height (first level elevation), for "auto" edges and supports. */
  groundZ: number;
  segments: WallSegment[];
  wallMaterial: string;
}

export interface TerraceResult {
  /** Per edge (point i -> i+1): runs along a wall of the building. */
  attached: boolean[];
  /** Per edge: gets a railing or parapet. */
  guarded: boolean[];
  guard: "railing" | "parapet" | "none";
}

/** Offset a polygon inward by d, whatever its winding (vertex indices are preserved). */
function inset(poly: Vec2[], d: number): Vec2[] {
  return signedArea(poly) > 0 ? offsetPolygon(poly, -d) : offsetPolygon(poly, d);
}

/** An edge is attached when it runs parallel to, and within half a wall of, this level's walls along its whole length. */
export function attachedEdges(poly: Vec2[], segs: WallSegment[]): boolean[] {
  return poly.map((a, i) => {
    const b = poly[(i + 1) % poly.length];
    const d = v2.norm(v2.sub(b, a));
    return [0.15, 0.5, 0.85].every((t) => {
      const p = v2.lerp(a, b, t);
      return segs.some(
        (s) => Math.abs(v2.cross(d, segDir(s))) < 0.1 && pointSegment(p, s.a, s.b).dist < s.thickness / 2 + 0.2,
      );
    });
  });
}

/** Runs of consecutive guarded edges as vertex index lists, or null when every edge is guarded (a closed loop). */
function chains(guarded: boolean[]): number[][] | null {
  const n = guarded.length;
  if (guarded.every(Boolean)) return null;
  const start = guarded.findIndex((g) => !g);
  const out: number[][] = [];
  let cur: number[] | null = null;
  for (let k = 1; k <= n; k++) {
    const e = (start + k) % n;
    if (guarded[e]) {
      cur ??= [e];
      cur.push((e + 1) % n);
    } else if (cur) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export interface TerraceGuards extends TerraceResult {
  /** Guarded edge runs as vertex index lists; null = every edge guarded (closed loop). */
  runs: number[][] | null;
  /** Railing/parapet center lines (railings are inset 4 cm from the edge). */
  lines: { points: Vec2[]; closed: boolean }[];
}

/** Which edges of a terrace get a railing or parapet (shared by the 3D builder and the 2D plan). */
export function terraceGuards(t: Terrace, segments: WallSegment[], levelZ: number, groundZ: number): TerraceGuards {
  const poly = t.polygon as Vec2[];
  const attached = attachedEdges(poly, segments);
  const guard = t.edge === "auto" ? (levelZ + t.offset - groundZ > 0.5 ? "railing" : "none") : t.edge;
  const guarded = attached.map((att, i) => guard !== "none" && !att && !t.openEdges.includes(i));
  const runs = guard === "none" ? [] : chains(guarded);
  const pts = inset(poly, guard === "parapet" ? t.parapetThickness / 2 : 0.04);
  const lines = (runs ?? [[...poly.keys()]]).map((idx) => ({ points: idx.map((i) => pts[i]), closed: runs === null }));
  return { attached, guarded, guard, runs, lines };
}

export function buildTerrace(mb: MeshBuilder, col: MeshBuilder, t: Terrace, ctx: TerraceContext): TerraceResult {
  const poly = t.polygon as Vec2[];
  const top = ctx.z + t.offset;
  const edgeMat = t.edgeMaterial ?? ctx.wallMaterial;
  buildSlab(mb, poly, [], top, t.thickness, t.material, t.bottomMaterial, edgeMat);
  buildSlab(col, poly, [], top, t.thickness, COLLIDER, COLLIDER);

  const g = terraceGuards(t, ctx.segments, ctx.z, ctx.groundZ);
  const { attached, guard, runs } = g;

  if (guard === "railing") {
    const rails: Railing[] = g.lines.map((l) => ({
      points: l.points,
      closed: l.closed,
      height: t.height,
      offset: 0,
      style: t.railingStyle,
      material: t.railingMaterial,
    }));
    for (const r of rails) {
      buildRailing(mb, r, top);
      railingCollider(col, r, top, COLLIDER);
    }
  } else if (guard === "parapet") {
    const mat = t.parapetMaterial ?? ctx.wallMaterial;
    const inner = inset(poly, t.parapetThickness);
    const z1 = top + t.height;
    for (const target of [mb, col]) {
      const m = target === col ? COLLIDER : mat;
      if (runs === null) {
        // closed ring: outer faces, inward faces, top with a hole
        const outer = signedArea(poly) > 0 ? poly : [...poly].reverse();
        const inn = signedArea(inner) > 0 ? [...inner].reverse() : inner; // clockwise
        target.prism(m, outer, top, z1, { caps: false });
        for (let i = 0; i < inn.length; i++) {
          const p = inn[i], q = inn[(i + 1) % inn.length];
          target.quad(m, [p[0], p[1], top], [q[0], q[1], top], [q[0], q[1], z1], [p[0], p[1], z1]);
        }
        target.flat(m, outer, z1, false, [inn]);
      } else
        for (const idx of runs) target.prism(m, [...idx.map((i) => poly[i]), ...[...idx].reverse().map((i) => inner[i])], top, z1);
    }
  }

  // columns under free outer corners (both neighbouring edges free)
  if (t.supports) {
    const bottom = top - t.thickness;
    if (bottom - ctx.groundZ > 0.3) {
      const at = inset(poly, t.supportSize / 2 + 0.05);
      poly.forEach((_, i) => {
        const prev = (i - 1 + poly.length) % poly.length;
        if (attached[prev] || attached[i]) return;
        for (const [target, m] of [[mb, t.supportMaterial], [col, COLLIDER]] as const)
          target.block(m, at[i][0], at[i][1], ctx.groundZ, t.supportSize, t.supportSize, bottom - ctx.groundZ);
      });
    }
  }
  return { attached, guarded: g.guarded, guard };
}
