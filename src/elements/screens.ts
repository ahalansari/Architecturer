/**
 * Slatted timber: privacy / sun screens along a line (vertical fins or horizontal louvres, the mashrabiya of a
 * modern Kuwaiti facade) and pergolas (perimeter beams, slats overhead, posts). Both cast the striped shadows
 * that make a courtyard read.
 */
import { z } from "zod";
import { v2, type Vec2 } from "../geometry/math.js";
import { MeshBuilder } from "../geometry/mesh.js";
import type { SceneNode } from "../geometry/scene.js";
import { Id, Mat, Point, Polygon } from "../schema/common.js";

const Slat = z
  .object({
    width: z.number().positive().max(0.5).default(0.05).describe("Face width of a slat, m"),
    depth: z.number().positive().max(0.6).default(0.08).describe("Depth of a slat (perpendicular to the screen), m"),
    gap: z.number().positive().max(1).default(0.05).describe("Clear gap between slats, m"),
  })
  .prefault({});

export const ScreenSchema = z
  .object({
    id: Id.optional(),
    points: z.array(Point).min(2).describe("Line of the screen in plan (e.g. along a facade, in front of a window)"),
    base: z.number().default(0).describe("Bottom of the screen above the level floor, m"),
    height: z.number().positive().default(2.4),
    direction: z.enum(["vertical", "horizontal"]).default("vertical").describe("vertical fins | horizontal louvres"),
    slat: Slat,
    offset: z.number().default(0).describe("Shift the screen sideways off its line, m (positive = left of the direction of travel)"),
    frame: z.boolean().default(true).describe("Top and bottom rails (vertical) or end posts (horizontal)"),
    material: Mat.default("wood_teak"),
  })
  .describe("Slatted screen: timber fins or louvres along a line (facade screens, privacy screens, sun shading)");
export type Screen = z.output<typeof ScreenSchema>;

export const PergolaSchema = z
  .object({
    id: Id.optional(),
    polygon: Polygon.describe("Rectangle the pergola covers"),
    height: z.number().positive().default(2.8).describe("Underside of the slats above the level floor, m"),
    direction: z.number().optional().describe("Direction the slats run, degrees (default: across the shorter side)"),
    slat: Slat,
    beams: z.boolean().default(true).describe("Perimeter beams under the slats"),
    posts: z.union([z.boolean(), z.array(Point)]).default(true).describe("true: a post at each corner; or the post positions; false for a pergola carried by walls"),
    material: Mat.default("wood_teak"),
    postMaterial: Mat.optional().describe("Posts and beams (default: the slat material)"),
  })
  .describe("Pergola: slats overhead on perimeter beams and posts (striped shade over a terrace or seating)");
export type Pergola = z.output<typeof PergolaSchema>;

/** Box between two plan points (along a→b), from z0 to z1, `depth` thick across. */
function bar(mb: MeshBuilder, mat: string, a: Vec2, b: Vec2, depth: number, z0: number, z1: number) {
  const d = v2.norm(v2.sub(b, a)), n: Vec2 = [-d[1] * depth * 0.5, d[0] * depth * 0.5];
  const P = [v2.add(a, n), v2.add(b, n), v2.sub(b, n), v2.sub(a, n)];
  mb.prism(mat, P, z0, z1);
}

export function buildScreens(screens: Screen[], z: number): SceneNode | undefined {
  if (!screens.length) return undefined;
  const mb = new MeshBuilder();
  for (const s of screens) {
    const pts = s.points as Vec2[];
    const z0 = z + s.base, z1 = z0 + s.height;
    const { width: w, depth: dp, gap } = s.slat;
    for (let i = 0; i + 1 < pts.length; i++) {
      let a = pts[i], b = pts[i + 1];
      const d = v2.norm(v2.sub(b, a));
      if (s.offset) {
        const n: Vec2 = [-d[1] * s.offset, d[0] * s.offset];
        a = v2.add(a, n);
        b = v2.add(b, n);
      }
      const len = v2.dist(a, b);
      if (s.direction === "vertical") {
        const n = Math.max(1, Math.floor((len + gap) / (w + gap)));
        const used = n * w + (n - 1) * gap, start = (len - used) / 2;
        const rail = s.frame ? 0.05 : 0;
        for (let k = 0; k < n; k++) {
          const u = start + k * (w + gap);
          bar(mb, s.material, v2.add(a, v2.scale(d, u)), v2.add(a, v2.scale(d, u + w)), dp, z0 + rail, z1 - rail);
        }
        if (s.frame) {
          bar(mb, s.material, a, b, dp, z0, z0 + rail);
          bar(mb, s.material, a, b, dp, z1 - rail, z1);
        }
      } else {
        const n = Math.max(1, Math.floor((s.height + gap) / (w + gap)));
        const post = s.frame ? 0.06 : 0;
        const a2 = v2.add(a, v2.scale(d, post)), b2 = v2.sub(b, v2.scale(d, post));
        for (let k = 0; k < n; k++) {
          const zz = z0 + k * (w + gap);
          bar(mb, s.material, a2, b2, dp, zz, Math.min(z1, zz + w));
        }
        if (s.frame) {
          bar(mb, s.material, a, v2.add(a, v2.scale(d, post)), dp, z0, z1);
          bar(mb, s.material, v2.sub(b, v2.scale(d, post)), b, dp, z0, z1);
        }
      }
    }
  }
  return { name: "screens", kind: "group", meshes: mb.meshes(), children: [] };
}

export function buildPergolas(pergolas: Pergola[], z: number): SceneNode | undefined {
  if (!pergolas.length) return undefined;
  const mb = new MeshBuilder();
  for (const p of pergolas) {
    const poly = p.polygon as Vec2[];
    const pm = p.postMaterial ?? p.material;
    const { width: w, depth: dp, gap } = p.slat;
    const beamH = 0.22, beamW = 0.1;
    const zs = z + p.height;
    // the rectangle's frame: longest edge sets the axis
    const e0 = v2.sub(poly[1], poly[0]), e1 = v2.sub(poly[poly.length - 1], poly[0]);
    const long = v2.len(e0) >= v2.len(e1) ? e0 : e1;
    const ang = p.direction !== undefined ? (p.direction * Math.PI) / 180 : Math.atan2(long[1], long[0]) + Math.PI / 2;
    const d: Vec2 = [Math.cos(ang), Math.sin(ang)], nrm: Vec2 = [-d[1], d[0]];
    // extent of the polygon along / across the slats
    const along = poly.map((q) => q[0] * d[0] + q[1] * d[1]), across = poly.map((q) => q[0] * nrm[0] + q[1] * nrm[1]);
    const a0 = Math.min(...along), a1 = Math.max(...along), c0 = Math.min(...across), c1 = Math.max(...across);
    const at = (al: number, ac: number): Vec2 => [d[0] * al + nrm[0] * ac, d[1] * al + nrm[1] * ac];
    if (p.beams) {
      for (let i = 0; i < poly.length; i++) bar(mb, pm, poly[i], poly[(i + 1) % poly.length], beamW, zs - beamH, zs);
    }
    // slats across the top, overhanging the beams a little
    const n = Math.max(1, Math.floor((c1 - c0 + gap) / (w + gap)));
    const used = n * w + (n - 1) * gap, start = c0 + (c1 - c0 - used) / 2;
    for (let k = 0; k < n; k++) {
      const c = start + k * (w + gap) + w / 2;
      bar(mb, p.material, at(a0 - 0.1, c), at(a1 + 0.1, c), w, zs, zs + dp);
    }
    const posts = p.posts === true ? poly : p.posts === false ? [] : (p.posts as Vec2[]);
    for (const q of posts) mb.block(pm, q[0], q[1], z, 0.12, 0.12, p.height - (p.beams ? beamH : 0));
  }
  return { name: "pergolas", kind: "group", meshes: mb.meshes(), children: [] };
}

/** Face area of screens (m²) and plan area of pergolas, for the bill. */
export function screenArea(s: Screen): number {
  const pts = s.points as Vec2[];
  return pts.slice(1).reduce((a, p, i) => a + v2.dist(pts[i], p), 0) * s.height;
}
