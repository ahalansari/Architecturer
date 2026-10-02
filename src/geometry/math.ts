// Small vector / matrix helpers. Plan space is Z-up, in meters:
// x = east, y = north, z = up. Export converts to glTF's Y-up.

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

export const EPS = 1e-6;

export const v2 = {
  add: (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]],
  sub: (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]],
  scale: (a: Vec2, s: number): Vec2 => [a[0] * s, a[1] * s],
  dot: (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1],
  cross: (a: Vec2, b: Vec2) => a[0] * b[1] - a[1] * b[0],
  len: (a: Vec2) => Math.hypot(a[0], a[1]),
  dist: (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]),
  norm: (a: Vec2): Vec2 => {
    const l = Math.hypot(a[0], a[1]) || 1;
    return [a[0] / l, a[1] / l];
  },
  /** Left-hand perpendicular (rotate +90°). */
  perp: (a: Vec2): Vec2 => [-a[1], a[0]],
  lerp: (a: Vec2, b: Vec2, t: number): Vec2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
  eq: (a: Vec2, b: Vec2, tol = 1e-4) => Math.abs(a[0] - b[0]) < tol && Math.abs(a[1] - b[1]) < tol,
  rotate: (a: Vec2, rad: number): Vec2 => {
    const c = Math.cos(rad), s = Math.sin(rad);
    return [a[0] * c - a[1] * s, a[0] * s + a[1] * c];
  },
};

export const v3 = {
  add: (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ],
  len: (a: Vec3) => Math.hypot(a[0], a[1], a[2]),
  norm: (a: Vec3): Vec3 => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  },
  lerp: (a: Vec3, b: Vec3, t: number): Vec3 => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ],
};

/** Intersect lines p + t*d and q + s*e. Returns null when parallel. */
export function lineIntersect(p: Vec2, d: Vec2, q: Vec2, e: Vec2): Vec2 | null {
  const den = v2.cross(d, e);
  if (Math.abs(den) < 1e-9) return null;
  const t = v2.cross(v2.sub(q, p), e) / den;
  return [p[0] + d[0] * t, p[1] + d[1] * t];
}

/** Signed area of a polygon (positive = counter-clockwise). */
export function signedArea(poly: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export function ensureCCW(poly: Vec2[]): Vec2[] {
  return signedArea(poly) < 0 ? [...poly].reverse() : poly;
}

export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/** Distance from p to segment ab, plus the parameter t∈[0,1] of the closest point. */
export function pointSegment(p: Vec2, a: Vec2, b: Vec2): { dist: number; t: number } {
  const ab = v2.sub(b, a);
  const l2 = v2.dot(ab, ab);
  const t = l2 < EPS ? 0 : Math.max(0, Math.min(1, v2.dot(v2.sub(p, a), ab) / l2));
  return { dist: v2.dist(p, v2.add(a, v2.scale(ab, t))), t };
}

/** Offset a simple polygon outward (positive d) using mitered corners. Polygon must be CCW. */
export function offsetPolygon(poly: Vec2[], d: number): Vec2[] {
  const n = poly.length;
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const prev = poly[(i - 1 + n) % n], cur = poly[i], next = poly[(i + 1) % n];
    const d0 = v2.norm(v2.sub(cur, prev)), d1 = v2.norm(v2.sub(next, cur));
    // outward normal of a CCW polygon edge is the right-hand perpendicular
    const n0: Vec2 = [d0[1], -d0[0]], n1: Vec2 = [d1[1], -d1[0]];
    const p0 = v2.add(prev, v2.scale(n0, d)), p1 = v2.add(cur, v2.scale(n1, d));
    out.push(lineIntersect(p0, d0, p1, d1) ?? v2.add(cur, v2.scale(n1, d)));
  }
  return out;
}

export const deg2rad = (d: number) => (d * Math.PI) / 180;

// ---- 4x4 matrices, column-major (same layout as glTF / three.js) ----
export type Mat4 = Float64Array;

export const m4 = {
  identity(): Mat4 {
    const m = new Float64Array(16);
    m[0] = m[5] = m[10] = m[15] = 1;
    return m;
  },
  translation(x: number, y: number, z: number): Mat4 {
    const m = m4.identity();
    m[12] = x; m[13] = y; m[14] = z;
    return m;
  },
  rotationZ(rad: number): Mat4 {
    const m = m4.identity();
    const c = Math.cos(rad), s = Math.sin(rad);
    m[0] = c; m[1] = s; m[4] = -s; m[5] = c;
    return m;
  },
  rotationX(rad: number): Mat4 {
    const m = m4.identity();
    const c = Math.cos(rad), s = Math.sin(rad);
    m[5] = c; m[6] = s; m[9] = -s; m[10] = c;
    return m;
  },
  rotationY(rad: number): Mat4 {
    const m = m4.identity();
    const c = Math.cos(rad), s = Math.sin(rad);
    m[0] = c; m[2] = -s; m[8] = s; m[10] = c;
    return m;
  },
  scaling(x: number, y: number, z: number): Mat4 {
    const m = m4.identity();
    m[0] = x; m[5] = y; m[10] = z;
    return m;
  },
  /** Build a matrix from basis vectors (columns) and an origin. */
  fromBasis(xAxis: Vec3, yAxis: Vec3, zAxis: Vec3, origin: Vec3): Mat4 {
    const m = m4.identity();
    m.set([...xAxis, 0, ...yAxis, 0, ...zAxis, 0, ...origin, 1]);
    return m;
  },
  mul(a: Mat4, b: Mat4): Mat4 {
    const o = new Float64Array(16);
    for (let c = 0; c < 4; c++)
      for (let r = 0; r < 4; r++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
        o[c * 4 + r] = s;
      }
    return o;
  },
  /** Compose: translate(x,y,z) * rotZ(rad). The usual placement for plan objects. */
  place(x: number, y: number, z: number, rotZ = 0): Mat4 {
    return m4.mul(m4.translation(x, y, z), m4.rotationZ(rotZ));
  },
  point(m: Mat4, p: Vec3): Vec3 {
    return [
      m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
      m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
      m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
    ];
  },
  /** Transform a normal with the inverse-transpose of the upper 3x3. */
  normal(m: Mat4, n: Vec3): Vec3 {
    const a = m[0], b = m[4], c = m[8], d = m[1], e = m[5], f = m[9], g = m[2], h = m[6], i = m[10];
    // cofactor matrix == inverse-transpose * det; normalizing removes det
    const r: Vec3 = [
      (e * i - f * h) * n[0] + (f * g - d * i) * n[1] + (d * h - e * g) * n[2],
      (c * h - b * i) * n[0] + (a * i - c * g) * n[1] + (b * g - a * h) * n[2],
      (b * f - c * e) * n[0] + (c * d - a * f) * n[1] + (a * e - b * d) * n[2],
    ];
    return v3.scale(v3.norm(r), m4.isMirroring(m) ? -1 : 1);
  },
  isMirroring(m: Mat4): boolean {
    const det =
      m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
    return det < 0;
  },
};

export const polygonArea = (poly: Vec2[]) => Math.abs(signedArea(poly));

export function polygonCentroid(poly: Vec2[]): Vec2 {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const f = p[0] * q[1] - q[0] * p[1];
    a += f;
    cx += (p[0] + q[0]) * f;
    cy += (p[1] + q[1]) * f;
  }
  if (Math.abs(a) < 1e-9) return poly[0];
  return [cx / (3 * a), cy / (3 * a)];
}
