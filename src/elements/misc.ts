import { ensureCCW, pointInPolygon, signedArea, v2, type Vec2 } from "../geometry/math.js";
import type { MeshBuilder } from "../geometry/mesh.js";
import type { Column, Railing } from "../schema/schema.js";

/** Slab with top at zTop. Holes are cut out of top, bottom, and get inward-facing edges. */
export function buildSlab(
  mb: MeshBuilder,
  outline: Vec2[],
  holes: Vec2[][],
  zTop: number,
  thickness: number,
  topMat: string,
  bottomMat: string,
  edgeMat = topMat,
) {
  const outer = ensureCCW(outline);
  const inner = holes.map((h) => (signedArea(h) > 0 ? [...h].reverse() : h)); // clockwise holes
  const z0 = zTop - thickness;
  mb.prism(edgeMat, outer, z0, zTop, { caps: false });
  // hole walls face inward (clockwise loop => the right-hand normal points into the hole)
  for (const h of inner)
    for (let i = 0; i < h.length; i++) {
      const p = h[i], q = h[(i + 1) % h.length];
      mb.quad(edgeMat, [p[0], p[1], z0], [q[0], q[1], z0], [q[0], q[1], zTop], [p[0], p[1], zTop]);
    }
  mb.flat(topMat, outer, zTop, false, inner);
  mb.flat(bottomMat, outer, z0, true, inner);
}

/** Keep only holes that lie inside the outline (earcut can't handle holes crossing the edge). */
export function holesInside(outline: Vec2[], holes: Vec2[][], warn: (m: string) => void): Vec2[][] {
  return holes.filter((h) => {
    const inside = h.every((p) => pointInPolygon(p, outline));
    const touching = h.some((p) => pointInPolygon(p, outline));
    if (!inside && touching) warn("a stairwell/slab hole crosses the slab edge and was skipped; keep holes fully inside slabs");
    return inside;
  });
}

export function buildColumn(mb: MeshBuilder, c: Column, z0: number, height: number) {
  const [x, y] = c.position;
  if (c.shape === "round") mb.cylinder(c.material, [x, y, z0], c.size / 2, c.size / 2, height, 20);
  else mb.block(c.material, x, y, z0, c.size, c.size, height);
}

export function buildRailing(mb: MeshBuilder, r: Railing, z0: number) {
  const pts = r.points as Vec2[];
  const n = r.closed ? pts.length : pts.length - 1;
  const H = r.height;
  const top = z0 + H;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const len = v2.dist(a, b);
    if (len < 1e-4) continue;
    const d = v2.norm(v2.sub(b, a));
    const at = (u: number): Vec2 => v2.add(a, v2.scale(d, u));
    // posts at the ends and roughly every 1.2 m
    const posts = Math.max(1, Math.round(len / 1.2));
    for (let k = 0; k <= posts; k++) {
      if (k === posts && i < n - 1) continue; // shared with next segment
      const p = at((len * k) / posts);
      mb.block(r.material, p[0], p[1], z0, 0.05, 0.05, H);
    }
    // handrail
    const pa = at(0), pb = at(len);
    mb.rod(r.material, [pa[0], pa[1], top], [pb[0], pb[1], top], 0.025, 8);
    if (r.style === "bars") {
      mb.rod(r.material, [pa[0], pa[1], z0 + 0.08], [pb[0], pb[1], z0 + 0.08], 0.012, 6);
      const bars = Math.floor(len / 0.12);
      for (let k = 1; k < bars; k++) {
        const p = at((len * k) / bars);
        mb.rod(r.material, [p[0], p[1], z0 + 0.08], [p[0], p[1], top], 0.008, 5);
      }
    } else {
      const N = v2.perp(d);
      const half = r.style === "glass" ? 0.006 : 0.04;
      const mat = r.style === "glass" ? "glass" : r.material;
      const q = (u: number, w: number): Vec2 => v2.add(at(u), v2.scale(N, w));
      const zb = z0 + 0.06, zt = top - 0.03;
      // panel as a thin box along the segment
      const c0 = q(0, -half), c1 = q(len, -half), c2 = q(len, half), c3 = q(0, half);
      if (r.style === "glass") {
        mb.quad(mat, [c0[0], c0[1], zb], [c1[0], c1[1], zb], [c1[0], c1[1], zt], [c0[0], c0[1], zt]);
      } else {
        mb.prism(mat, [c0, c1, c2, c3], zb, zt);
      }
    }
  }
}

/** Railings as thin solid walls for collision. */
export function railingCollider(col: MeshBuilder, r: Railing, z0: number, material: string) {
  const pts = r.points as Vec2[];
  const n = r.closed ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    if (v2.dist(a, b) < 1e-4) continue;
    const N = v2.scale(v2.perp(v2.norm(v2.sub(b, a))), 0.03);
    col.prism(material, [v2.sub(a, N), v2.sub(b, N), v2.add(b, N), v2.add(a, N)], z0, z0 + r.height);
  }
}
