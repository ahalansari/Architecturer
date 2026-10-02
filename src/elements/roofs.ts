import { deg2rad, ensureCCW, m4, offsetPolygon, v2, type Vec2, type Vec3 } from "../geometry/math.js";
import type { MeshBuilder } from "../geometry/mesh.js";
import type { Roof } from "../schema/schema.js";

/** Minimum-area oriented rectangle around a polygon (tested along each edge direction). */
export function orientedRect(poly: Vec2[]) {
  let best = { area: Infinity, center: [0, 0] as Vec2, ax: [1, 0] as Vec2, hx: 0, hy: 0 };
  for (let i = 0; i < poly.length; i++) {
    const e = v2.norm(v2.sub(poly[(i + 1) % poly.length], poly[i]));
    const p = v2.perp(e);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const q of poly) {
      const x = v2.dot(q, e), y = v2.dot(q, p);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    const area = (maxX - minX) * (maxY - minY);
    if (area < best.area - 1e-9) {
      const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
      best = { area, center: v2.add(v2.scale(e, cx), v2.scale(p, cy)), ax: e, hx: (maxX - minX) / 2, hy: (maxY - minY) / 2 };
    }
  }
  return best;
}

/** Prism along local x with per-edge materials. Profile is in (y, z), counter-clockwise. */
function profilePrism(mb: MeshBuilder, prof: Vec2[], edgeMats: string[], capMat: string, x0: number, x1: number) {
  for (let i = 0; i < prof.length; i++) {
    const [ya, za] = prof[i], [yb, zb] = prof[(i + 1) % prof.length];
    // CCW in (y,z) seen from +x: outward normal is to the right of the edge
    mb.quad(edgeMats[i], [x0, ya, za], [x0, yb, zb], [x1, yb, zb], [x1, ya, za]);
  }
  const lift = (x: number) => prof.map(([y, z]) => [x, y, z] as Vec3);
  mb.polygon(capMat, lift(x1), [1, 0, 0]);
  mb.polygon(capMat, lift(x0), [-1, 0, 0]);
}

export interface RoofContext {
  baseZ: number;
  wallThickness: number;
  wallMaterial: string;
}

export function buildRoof(mb: MeshBuilder, roof: Roof, ctx: RoofContext) {
  const top = roof.material ?? (roof.type === "flat" ? "concrete" : "roof_tiles_red");
  const under = roof.undersideMaterial;
  // fascias / edges: explicit, else the underside trim; a flat roof flush with the walls continues the facade
  const edge = roof.edgeMaterial ?? (roof.type === "flat" && roof.overhang === 0 ? ctx.wallMaterial : under);
  const zb = ctx.baseZ;
  const th = roof.thickness;

  if (roof.type === "flat") {
    const outline = ensureCCW(roof.polygon as Vec2[]);
    const outer = offsetPolygon(outline, roof.overhang + ctx.wallThickness / 2);
    mb.prism(edge, outer, zb, zb + th, { caps: false });
    mb.flat(top, outer, zb + th);
    mb.flat(under, outer, zb, true);
    if (roof.parapet > 0) {
      const inner = offsetPolygon(outer, -0.15);
      const z0 = zb + th, z1 = z0 + roof.parapet;
      mb.prism(ctx.wallMaterial, outer, z0, z1, { caps: false });
      // inner faces point inward: build as reversed-winding quads
      for (let i = 0; i < inner.length; i++) {
        const p = inner[i], q = inner[(i + 1) % inner.length];
        mb.quad(ctx.wallMaterial, [q[0], q[1], z0], [p[0], p[1], z0], [p[0], p[1], z1], [q[0], q[1], z1]);
      }
      mb.flat(ctx.wallMaterial, outer, z1, false, [inner]);
    }
    return;
  }

  const rect = orientedRect(roof.polygon as Vec2[]);
  // the polygon is the wall centerline: grow by half a wall so the roof sits on the outer faces
  // local x runs along the ridge
  let ax = rect.ax, hx0 = rect.hx + ctx.wallThickness / 2, hy0 = rect.hy + ctx.wallThickness / 2;
  const longIsX = hx0 >= hy0;
  if ((roof.ridge === "long") !== longIsX) {
    ax = v2.perp(ax);
    [hx0, hy0] = [hy0, hx0];
  }
  const ay = v2.perp(ax);
  const frame = m4.fromBasis([ax[0], ax[1], 0], [ay[0], ay[1], 0], [0, 0, 1], [rect.center[0], rect.center[1], zb]);
  const tan = Math.tan(deg2rad(roof.pitch));
  const cos = Math.cos(deg2rad(roof.pitch));
  const ov = roof.overhang;
  const hx = hx0 + ov, hy = hy0 + ov;
  const d = th / cos; // vertical thickness of the sloped slab
  const zEave = -ov * tan; // underside height at the eave edge (relative to wall top)
  const wt = ctx.wallThickness;

  mb.with(frame, () => {
    if (roof.type === "gable") {
      const zr = hy0 * tan;
      const prof: Vec2[] = [
        [-hy, zEave],
        [0, zr],
        [hy, zEave],
        [hy, zEave + d],
        [0, zr + d],
        [-hy, zEave + d],
      ];
      // profile is counter-clockwise in (y,z): underside x2, right fascia, top x2, left fascia (fascias use the trim material)
      profilePrism(mb, prof, [under, under, edge, top, top, edge], edge, -hx, hx);
      // gable end walls fill the triangle between wall top and roof underside
      const gableMat = roof.gableMaterial ?? ctx.wallMaterial;
      const tri: Vec2[] = [
        [-hy0, 0],
        [hy0, 0],
        [0, zr],
      ];
      for (const sx of [-1, 1]) {
        const xa = sx > 0 ? hx0 - wt : -hx0, xb = sx > 0 ? hx0 : -hx0 + wt;
        mb.with(m4.fromBasis([0, 1, 0], [0, 0, 1], [1, 0, 0], [0, 0, 0]), () => mb.prism(gableMat, tri, xa, xb, { caps: true }));
      }
      return;
    }

    if (roof.type === "shed") {
      // rises from -y (low eave) to +y (high eave)
      const zHighWall = 2 * hy0 * tan;
      const prof: Vec2[] = [
        [-hy, zEave],
        [hy, zHighWall + ov * tan],
        [hy, zHighWall + ov * tan + d],
        [-hy, zEave + d],
      ];
      // counter-clockwise in (y,z): underside, high fascia, top, low fascia
      profilePrism(mb, prof, [under, edge, top, edge], edge, -hx, hx);
      const gableMat = roof.gableMaterial ?? ctx.wallMaterial;
      const tri: Vec2[] = [
        [-hy0, 0],
        [hy0, 0],
        [hy0, zHighWall],
      ];
      mb.with(m4.fromBasis([0, 1, 0], [0, 0, 1], [1, 0, 0], [0, 0, 0]), () => {
        mb.prism(gableMat, tri, -hx0, -hx0 + wt);
        mb.prism(gableMat, tri, hx0 - wt, hx0);
      });
      // high side wall
      mb.box(gableMat, [-hx0, hy0 - wt, 0], [hx0, hy0, zHighWall]);
      return;
    }

    // hip: four slopes, ridge length 2*(hx-hy)
    const rx = Math.max(0, hx - hy);
    const zrb = zEave + hy * tan; // underside ridge
    const surf = (dz: number) => {
      const E = (x: number, y: number): Vec3 => [x, y, zEave + dz];
      const R = (x: number): Vec3 => [x, 0, zrb + dz];
      return { E, R };
    };
    const T = surf(d), B = surf(0);
    // top faces (facing up/out)
    mb.quad(top, T.E(-hx, -hy), T.E(hx, -hy), T.R(rx), T.R(-rx));
    mb.quad(top, T.E(hx, hy), T.E(-hx, hy), T.R(-rx), T.R(rx));
    mb.triangle(top, T.E(hx, -hy), T.E(hx, hy), T.R(rx));
    mb.triangle(top, T.E(-hx, hy), T.E(-hx, -hy), T.R(-rx));
    // underside (facing down/in): reversed winding
    mb.quad(under, B.R(-rx), B.R(rx), B.E(hx, -hy), B.E(-hx, -hy));
    mb.quad(under, B.R(rx), B.R(-rx), B.E(-hx, hy), B.E(hx, hy));
    mb.triangle(under, B.R(rx), B.E(hx, hy), B.E(hx, -hy));
    mb.triangle(under, B.R(-rx), B.E(-hx, -hy), B.E(-hx, hy));
    // fascia around the eaves
    const corners: [number, number][] = [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]];
    for (let i = 0; i < 4; i++) {
      const [x0, y0] = corners[i], [x1, y1] = corners[(i + 1) % 4];
      mb.quad(edge, B.E(x0, y0), B.E(x1, y1), T.E(x1, y1), T.E(x0, y0));
    }
  });
}
