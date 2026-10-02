import earcut from "earcut";
import { m4, v3, type Mat4, type Vec2, type Vec3 } from "./math.js";

/**
 * One drawable chunk: triangles that share a material.
 * Positions are in plan space (Z-up, meters). UVs are in meters until
 * `scaleUVs` divides them by the material's texture size.
 */
export interface MeshData {
  material: string;
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
}

/** Planar UV projection in meters: u runs horizontally along the face, v runs "up" the face. */
export function planarUV(p: Vec3, n: Vec3): Vec2 {
  const nz = Math.abs(n[2]);
  if (nz > 0.999) {
    // horizontal face: plain top-down mapping (mirrored for downward faces so it reads correctly from below)
    return n[2] > 0 ? [p[0], -p[1]] : [p[0], p[1]];
  }
  const t = v3.norm([-n[1], n[0], 0]); // horizontal tangent = up × n
  const b = v3.cross(n, t); // "up the face"
  return [v3.dot(p, t), -v3.dot(p, b)];
}

export interface BoxOptions {
  /** Faces to skip: any of "+x","-x","+y","-y","+z","-z". */
  skip?: string[];
}

export class MeshBuilder {
  private groups = new Map<string, MeshData>();
  private stack: Mat4[] = [m4.identity()];

  get matrix(): Mat4 {
    return this.stack[this.stack.length - 1];
  }

  /** Run `fn` with an extra transform applied to everything it emits. */
  with<T>(m: Mat4, fn: () => T): T {
    this.stack.push(m4.mul(this.matrix, m));
    try {
      return fn();
    } finally {
      this.stack.pop();
    }
  }

  private group(material: string): MeshData {
    let g = this.groups.get(material);
    if (!g) {
      g = { material, positions: [], normals: [], uvs: [], indices: [] };
      this.groups.set(material, g);
    }
    return g;
  }

  private vertex(g: MeshData, p: Vec3, n: Vec3, uv: Vec2): number {
    const m = this.matrix;
    const wp = m4.point(m, p);
    const wn = m4.normal(m, n);
    g.positions.push(wp[0], wp[1], wp[2]);
    g.normals.push(wn[0], wn[1], wn[2]);
    g.uvs.push(uv[0], uv[1]);
    return g.positions.length / 3 - 1;
  }

  private tri(g: MeshData, a: number, b: number, c: number) {
    // drop zero-area triangles (they break tangent generation and waste memory)
    const P = g.positions;
    const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
    const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (cx * cx + cy * cy + cz * cz < 1e-14) return;
    if (m4.isMirroring(this.matrix)) g.indices.push(a, c, b);
    else g.indices.push(a, b, c);
  }

  /** Triangle, counter-clockwise when seen from the front. Flat normal; planar UVs unless given. */
  triangle(material: string, a: Vec3, b: Vec3, c: Vec3, uvs?: [Vec2, Vec2, Vec2]) {
    const n = v3.norm(v3.cross(v3.sub(b, a), v3.sub(c, a)));
    if (!isFinite(n[0]) || v3.len(n) < 0.5) return;
    const g = this.group(material);
    const pts = [a, b, c];
    const idx = pts.map((p, i) => this.vertex(g, p, n, uvs ? uvs[i] : planarUV(p, n)));
    this.tri(g, idx[0], idx[1], idx[2]);
  }

  /** Planar quad, counter-clockwise when seen from the front. */
  quad(material: string, a: Vec3, b: Vec3, c: Vec3, d: Vec3, uvs?: [Vec2, Vec2, Vec2, Vec2]) {
    let n = v3.cross(v3.sub(b, a), v3.sub(c, a));
    if (v3.len(n) < 1e-12) n = v3.cross(v3.sub(c, a), v3.sub(d, a));
    if (v3.len(n) < 1e-12) return; // degenerate
    n = v3.norm(n);
    const g = this.group(material);
    const pts = [a, b, c, d];
    const idx = pts.map((p, i) => this.vertex(g, p, n, uvs ? uvs[i] : planarUV(p, n)));
    this.tri(g, idx[0], idx[1], idx[2]);
    this.tri(g, idx[0], idx[2], idx[3]);
  }

  /**
   * Planar polygon (with optional holes), triangulated with earcut.
   * `normal` decides which side is the front; the outline winding does not matter.
   */
  polygon(material: string, outline: Vec3[], normal: Vec3, holes: Vec3[][] = [], uvFn?: (p: Vec3) => Vec2) {
    if (outline.length < 3) return;
    const n = v3.norm(normal);
    const t = Math.abs(n[2]) > 0.999 ? ([1, 0, 0] as Vec3) : v3.norm([-n[1], n[0], 0]);
    const b = v3.cross(n, t);
    const all = [outline, ...holes];
    const flat: number[] = [];
    const holeIdx: number[] = [];
    const pts: Vec3[] = [];
    for (let r = 0; r < all.length; r++) {
      if (r > 0) holeIdx.push(pts.length);
      for (const p of all[r]) {
        pts.push(p);
        flat.push(v3.dot(p, t), v3.dot(p, b));
      }
    }
    const tris = earcut(flat, holeIdx.length ? holeIdx : undefined, 2);
    if (!tris.length) return;
    const g = this.group(material);
    const idx = pts.map((p) => this.vertex(g, p, n, uvFn ? uvFn(p) : planarUV(p, n)));
    for (let i = 0; i < tris.length; i += 3) {
      const a = pts[tris[i]], bb = pts[tris[i + 1]], c = pts[tris[i + 2]];
      const fn = v3.cross(v3.sub(bb, a), v3.sub(c, a));
      // earcut's output winding depends on the 2D basis; orient each triangle to face `n`
      if (v3.dot(fn, n) >= 0) this.tri(g, idx[tris[i]], idx[tris[i + 1]], idx[tris[i + 2]]);
      else this.tri(g, idx[tris[i]], idx[tris[i + 2]], idx[tris[i + 1]]);
    }
  }

  /** Horizontal polygon at height z, facing up (or down when `down`). */
  flat(material: string, outline: Vec2[], z: number, down = false, holes: Vec2[][] = []) {
    const lift = (ps: Vec2[]) => ps.map((p) => [p[0], p[1], z] as Vec3);
    this.polygon(material, lift(outline), [0, 0, down ? -1 : 1], holes.map(lift));
  }

  /** Axis-aligned box between two corners (in the current transform). */
  box(material: string, min: Vec3, max: Vec3, opts: BoxOptions = {}) {
    const [x0, y0, z0] = min, [x1, y1, z1] = max;
    if (x1 - x0 < 1e-6 || y1 - y0 < 1e-6 || z1 - z0 < 1e-6) return;
    const skip = new Set(opts.skip ?? []);
    if (!skip.has("+z")) this.quad(material, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
    if (!skip.has("-z")) this.quad(material, [x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0]);
    if (!skip.has("-y")) this.quad(material, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
    if (!skip.has("+y")) this.quad(material, [x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]);
    if (!skip.has("+x")) this.quad(material, [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]);
    if (!skip.has("-x")) this.quad(material, [x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]);
  }

  /** Box by center (x,y) footprint size and z range — handy for furniture parts. */
  block(material: string, cx: number, cy: number, z0: number, sx: number, sy: number, sz: number, opts?: BoxOptions) {
    this.box(material, [cx - sx / 2, cy - sy / 2, z0], [cx + sx / 2, cy + sy / 2, z0 + sz], opts);
  }

  /**
   * Vertical cylinder / cone frustum standing on `base`. Smooth sides, flat caps.
   * UVs wrap around the circumference in meters.
   */
  cylinder(
    material: string,
    base: Vec3,
    radiusBottom: number,
    radiusTop: number,
    height: number,
    segments = 16,
    caps: { top?: boolean; bottom?: boolean } = { top: true, bottom: true },
  ) {
    const g = this.group(material);
    const [cx, cy, cz] = base;
    if (height <= 1e-6) return;
    const slope = (radiusBottom - radiusTop) / height;
    const circ = 2 * Math.PI * Math.max(radiusBottom, radiusTop);
    const ring: number[][] = [];
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      const n = v3.norm([c, s, slope]);
      const u = (i / segments) * circ;
      const lo = this.vertex(g, [cx + c * radiusBottom, cy + s * radiusBottom, cz], n, [u, 0]);
      const hi = this.vertex(g, [cx + c * radiusTop, cy + s * radiusTop, cz + height], n, [u, -height]);
      ring.push([lo, hi]);
    }
    for (let i = 0; i < segments; i++) {
      const [a, b] = ring[i], [c, d] = ring[i + 1];
      this.tri(g, a, c, d);
      this.tri(g, a, d, b);
    }
    const disc = (r: number, z: number, up: boolean) => {
      if (r < 1e-6) return;
      const pts: Vec2[] = [];
      for (let i = 0; i < segments; i++) {
        const a = (i / segments) * Math.PI * 2;
        pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
      }
      this.flat(material, pts, z, !up);
    };
    if (caps.top !== false) disc(radiusTop, cz + height, true);
    if (caps.bottom !== false) disc(radiusBottom, cz, false);
  }

  /** Cylinder between two arbitrary points (rods, rails, legs at an angle). */
  rod(material: string, a: Vec3, b: Vec3, radius: number, segments = 10) {
    const d = v3.sub(b, a);
    const len = v3.len(d);
    if (len < 1e-6) return;
    const z = v3.norm(d);
    const ref: Vec3 = Math.abs(z[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const x = v3.norm(v3.cross(ref, z));
    const y = v3.cross(z, x);
    this.with(m4.fromBasis(x, y, z, a), () => this.cylinder(material, [0, 0, 0], radius, radius, len, segments));
  }

  /** UV sphere (or ellipsoid via scale) centered at c. */
  sphere(material: string, c: Vec3, radius: number, wSeg = 16, hSeg = 10, scale: Vec3 = [1, 1, 1]) {
    const g = this.group(material);
    const rows: number[][] = [];
    for (let j = 0; j <= hSeg; j++) {
      const phi = (j / hSeg) * Math.PI;
      const row: number[] = [];
      for (let i = 0; i <= wSeg; i++) {
        const th = (i / wSeg) * Math.PI * 2;
        const n: Vec3 = [Math.sin(phi) * Math.cos(th), Math.sin(phi) * Math.sin(th), Math.cos(phi)];
        const p: Vec3 = [c[0] + n[0] * radius * scale[0], c[1] + n[1] * radius * scale[1], c[2] + n[2] * radius * scale[2]];
        const nn = v3.norm([n[0] / scale[0], n[1] / scale[1], n[2] / scale[2]]);
        row.push(this.vertex(g, p, nn, [(i / wSeg) * Math.PI * 2 * radius, (j / hSeg) * Math.PI * radius]));
      }
      rows.push(row);
    }
    for (let j = 0; j < hSeg; j++)
      for (let i = 0; i < wSeg; i++) {
        const a = rows[j][i], b = rows[j][i + 1], c2 = rows[j + 1][i], d = rows[j + 1][i + 1];
        if (j > 0) this.tri(g, a, c2, b);
        if (j < hSeg - 1) this.tri(g, b, c2, d);
      }
  }

  /**
   * Prism: a 2D profile (any winding) in the local XY plane, extruded along +Z from z0 to z1.
   * Wrap in `with(m4.fromBasis(...))` to extrude along any axis.
   */
  prism(material: string, profile: Vec2[], z0: number, z1: number, opts: { caps?: boolean; sides?: boolean } = {}) {
    if (profile.length < 3) return;
    let area = 0;
    for (let i = 0; i < profile.length; i++) {
      const p = profile[i], q = profile[(i + 1) % profile.length];
      area += p[0] * q[1] - q[0] * p[1];
    }
    const ccw = area > 0 ? profile : [...profile].reverse();
    if (opts.sides !== false)
      for (let i = 0; i < ccw.length; i++) {
        const p = ccw[i], q = ccw[(i + 1) % ccw.length];
        this.quad(material, [p[0], p[1], z0], [q[0], q[1], z0], [q[0], q[1], z1], [p[0], p[1], z1]);
      }
    if (opts.caps !== false) {
      this.flat(material, ccw, z1, false);
      this.flat(material, ccw, z0, true);
    }
  }

  /**
   * Surface of revolution around the vertical axis through `center` (x, y, base z).
   * `profile` is [radius, height] from bottom to top; faces point away from the axis
   * (or toward it when `inward`). Each profile segment gets the material returned by
   * `materialAt(i)` (null = leave open). Normals are smoothed across gentle bends.
   * UVs: u = angle * uvRadius (meters around), v = distance along the profile.
   */
  lathe(
    profile: Vec2[],
    materialAt: (segment: number) => string | null,
    center: Vec3,
    segments = 48,
    opts: { inward?: boolean; uvRadius?: number } = {},
  ) {
    const n = profile.length;
    if (n < 2) return;
    const uvR = opts.uvRadius ?? Math.max(...profile.map((p) => p[0]));
    const flip = opts.inward ? -1 : 1;
    // per-segment outward normal in (r, z): (dz, -dr) for a bottom-to-top profile
    const segN: Vec2[] = [];
    const arc: number[] = [0];
    for (let i = 0; i < n - 1; i++) {
      const dr = profile[i + 1][0] - profile[i][0], dz = profile[i + 1][1] - profile[i][1];
      const l = Math.hypot(dr, dz) || 1;
      segN.push([dz / l, -dr / l]);
      arc.push(arc[i] + l);
    }
    // smooth a vertex normal with its neighbour segment when the bend is gentle (< ~35°)
    const vNormal = (i: number, seg: number): Vec2 => {
      const other = i === seg ? seg - 1 : seg + 1;
      const a = segN[seg];
      if (other < 0 || other >= segN.length) return a;
      const b = segN[other];
      if (a[0] * b[0] + a[1] * b[1] < 0.82) return a;
      const s: Vec2 = [a[0] + b[0], a[1] + b[1]];
      const l = Math.hypot(s[0], s[1]) || 1;
      return [s[0] / l, s[1] / l];
    };
    for (let seg = 0; seg < n - 1; seg++) {
      const mat = materialAt(seg);
      if (!mat) continue;
      const [r0, z0] = profile[seg], [r1, z1] = profile[seg + 1];
      if (r0 < 1e-6 && r1 < 1e-6) continue;
      const g = this.group(mat);
      const n0 = vNormal(seg, seg), n1 = vNormal(seg + 1, seg);
      const ring = (r: number, z: number, nn: Vec2, v: number) => {
        const idx: number[] = [];
        for (let k = 0; k <= segments; k++) {
          const a = (k / segments) * Math.PI * 2;
          const c = Math.cos(a), s = Math.sin(a);
          idx.push(
            this.vertex(
              g,
              [center[0] + c * r, center[1] + s * r, center[2] + z],
              [c * nn[0] * flip, s * nn[0] * flip, nn[1] * flip],
              [a * uvR, -v],
            ),
          );
        }
        return idx;
      };
      const lo = ring(r0, z0, n0, arc[seg]), hi = ring(r1, z1, n1, arc[seg + 1]);
      for (let k = 0; k < segments; k++) {
        const a = lo[k], b = lo[k + 1], c = hi[k + 1], d = hi[k];
        if (flip > 0) {
          this.tri(g, a, b, c);
          this.tri(g, a, c, d);
        } else {
          this.tri(g, a, c, b);
          this.tri(g, a, d, c);
        }
      }
    }
  }

  /** Merge another builder's output (already in world space) into this one. */
  append(other: MeshBuilder) {
    for (const src of other.meshes()) {
      const g = this.group(src.material);
      const base = g.positions.length / 3;
      g.positions.push(...src.positions);
      g.normals.push(...src.normals);
      g.uvs.push(...src.uvs);
      for (const i of src.indices) g.indices.push(i + base);
    }
  }

  meshes(): MeshData[] {
    return [...this.groups.values()].filter((g) => g.indices.length > 0);
  }

  get empty(): boolean {
    return this.meshes().length === 0;
  }
}
