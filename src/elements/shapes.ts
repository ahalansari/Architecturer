import { deg2rad, m4, type Vec2, type Vec3 } from "../geometry/math.js";
import type { MeshBuilder } from "../geometry/mesh.js";
import type { Band, Shape } from "../schema/schema.js";

/**
 * Free-form solids: revolve (lathe) and sphere with material bands, openings, hollow
 * shells and glazing frames; plus plain cylinders and boxes.
 */

type RevolveLike = Extract<Shape, { type: "revolve" } | { type: "sphere" }>;

/** Profile in shape-local heights plus the axis origin (world). Band heights are shifted into the same frame. */
function revolveFrame(s: RevolveLike, levelZ: number): { profile: Vec2[]; origin: Vec3; bands: Band[] } {
  if (s.type === "revolve") {
    return { profile: s.profile as Vec2[], origin: [s.position[0], s.position[1], levelZ + s.base], bands: s.bands };
  }
  const prof: Vec2[] = [];
  for (let j = 0; j <= s.rings; j++) {
    const phi = (j / s.rings) * Math.PI;
    prof.push([Math.max(0, s.radius * Math.sin(phi)), -s.radius * Math.cos(phi)]);
  }
  // sphere bands are given relative to the level elevation, like the center
  const cz = s.center[2];
  return {
    profile: prof,
    origin: [s.center[0], s.center[1], levelZ + cz],
    bands: s.bands.map((b) => ({ ...b, from: b.from - cz, to: b.to - cz })),
  };
}

/** Insert profile points where segments cross band boundaries, so every segment is inside one band. */
function splitAtBands(profile: Vec2[], bands: Band[]): Vec2[] {
  const cuts = [...new Set(bands.flatMap((b) => [b.from, b.to]))];
  const out: Vec2[] = [profile[0]];
  for (let i = 0; i < profile.length - 1; i++) {
    const [r0, z0] = profile[i], [r1, z1] = profile[i + 1];
    const between = cuts
      .filter((c) => (c - z0) * (c - z1) < 0)
      .map((c) => (c - z0) / (z1 - z0))
      .sort((a, b) => a - b);
    for (const t of between) out.push([r0 + (r1 - r0) * t, z0 + (z1 - z0) * t]);
    out.push(profile[i + 1]);
  }
  return out;
}

/** Radius of the profile at height z (first crossing from the bottom), or null outside. */
export function radiusAt(profile: Vec2[], z: number): number | null {
  for (let i = 0; i < profile.length - 1; i++) {
    const [r0, z0] = profile[i], [r1, z1] = profile[i + 1];
    if ((z - z0) * (z - z1) <= 0 && z0 !== z1) return r0 + ((r1 - r0) * (z - z0)) / (z1 - z0);
  }
  return null;
}

const looksTransparent = (m: string) => /glass|water/i.test(m);

export function buildShape(mb: MeshBuilder, s: Shape, levelZ: number) {
  if (s.type === "cylinder") {
    mb.cylinder(s.material, [s.position[0], s.position[1], levelZ + s.base], s.radius, s.radiusTop ?? s.radius, s.height, s.segments);
    return;
  }
  if (s.type === "box") {
    const [w, d, h] = s.size;
    mb.with(m4.place(s.center[0], s.center[1], levelZ + s.center[2], deg2rad(s.rotation)), () =>
      mb.box(s.material, [-w / 2, -d / 2, -h / 2], [w / 2, d / 2, h / 2]),
    );
    return;
  }

  const { profile: raw, origin, bands } = revolveFrame(s, levelZ);
  const profile = splitAtBands(raw, bands);
  const bandAt = (seg: number): Band | undefined => {
    const zm = (profile[seg][1] + profile[seg + 1][1]) / 2;
    let hit: Band | undefined;
    for (const b of bands) if (zm >= Math.min(b.from, b.to) && zm <= Math.max(b.from, b.to)) hit = b;
    return hit;
  };
  const outerMat = (seg: number): string | null => {
    const b = bandAt(seg);
    if (!b) return s.material;
    return b.material === "none" ? null : b.material;
  };
  mb.lathe(profile, outerMat, origin, s.segments, { uvRadius: s.uvRadius });

  if (s.hollow) {
    const t = s.hollow.thickness;
    // offset each vertex inward along its (averaged) normal
    const segN: Vec2[] = [];
    for (let i = 0; i < profile.length - 1; i++) {
      const dr = profile[i + 1][0] - profile[i][0], dz = profile[i + 1][1] - profile[i][1];
      const l = Math.hypot(dr, dz) || 1;
      segN.push([dz / l, -dr / l]);
    }
    const inner: Vec2[] = profile.map(([r, z], i) => {
      const a = segN[Math.max(0, i - 1)], b = segN[Math.min(segN.length - 1, i)];
      const nx = a[0] + b[0], nz = a[1] + b[1];
      const l = Math.hypot(nx, nz) || 1;
      return [Math.max(0, r - (nx / l) * t), z - (nz / l) * t];
    });
    const innerMat = (seg: number): string | null => {
      const b = bandAt(seg);
      if (!b) return s.hollow!.innerMaterial;
      if (b.material === "none") return null;
      const want = b.inner ?? !looksTransparent(b.material);
      return want ? s.hollow!.innerMaterial : null;
    };
    mb.lathe(inner, innerMat, origin, s.segments, { inward: true, uvRadius: s.uvRadius });
    // close the shell's cut edges around openings (between outer and inner surface)
    for (let i = 1; i < profile.length - 1; i++) {
      const below = outerMat(i - 1), above = outerMat(i);
      if ((below === null) === (above === null)) continue;
      const rimMat = below ?? above!;
      // lower edge of an opening faces up (outer -> inner), upper edge faces down (inner -> outer)
      const rim: Vec2[] = above === null ? [profile[i], inner[i]] : [inner[i], profile[i]];
      mb.lathe(rim, () => rimMat, origin, s.segments, { uvRadius: s.uvRadius });
    }
  }

  // glazing frames / lattices over bands
  for (const b of bands) {
    if (!b.frame) continue;
    const f = b.frame;
    const z0 = Math.min(b.from, b.to), z1 = Math.max(b.from, b.to);
    const node = (k: number, j: number): Vec3 | null => {
      const z = z0 + ((z1 - z0) * j) / f.rows;
      const r = radiusAt(raw, z);
      if (r === null) return null;
      const a = ((k + (f.diagonals ? (j % 2) * 0.5 : 0)) / f.columns) * Math.PI * 2;
      const rr = r + f.radius; // sit on the glass
      return [origin[0] + Math.cos(a) * rr, origin[1] + Math.sin(a) * rr, origin[2] + z];
    };
    for (let j = 0; j <= f.rows; j++)
      for (let k = 0; k < f.columns; k++) {
        const p = node(k, j);
        if (!p) continue;
        const ring = node(k + 1, j);
        if (ring) mb.rod(f.material, p, ring, f.radius, 6);
        if (j < f.rows) {
          const up = node(k, j + 1);
          if (up) mb.rod(f.material, p, up, f.radius, 6);
          // diagonals: with staggered rows, link to the neighbour on the other side as well
          if (f.diagonals) {
            const up2 = node(j % 2 ? k + 1 : k - 1, j + 1);
            if (up2) mb.rod(f.material, p, up2, f.radius, 6);
          }
        }
        if (f.nodes) mb.sphere(f.material, p, f.radius * 2.6, 8, 5);
      }
  }
}

/** Largest radius and the radius at a given world height — for plans. */
export function shapeFootprint(s: Shape, levelZ: number, cutZ: number): { center: Vec2; max: number; cut: number | null } | null {
  if (s.type === "box") return null;
  if (s.type === "cylinder") {
    const h = cutZ - (levelZ + s.base);
    const top = s.radiusTop ?? s.radius;
    const cut = h >= 0 && h <= s.height ? s.radius + ((top - s.radius) * h) / s.height : null;
    return { center: s.position as Vec2, max: Math.max(s.radius, top), cut };
  }
  const { profile, origin } = revolveFrame(s, levelZ);
  return {
    center: [origin[0], origin[1]],
    max: Math.max(...profile.map((p) => p[0])),
    cut: radiusAt(profile, cutZ - origin[2]),
  };
}
