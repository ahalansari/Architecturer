/**
 * A second UV set for baked lighting (glTF TEXCOORD_1 → Unity uv2): the tiled texture UVs repeat, so lightmaps need
 * their own non-overlapping layout. Architecture is mostly flat faces, so each set of connected, coplanar triangles
 * becomes one chart, projected flat at its true size and shelf-packed into the unit square with padding. All the
 * meshes passed in share one atlas (they are the sub-meshes of one engine mesh).
 */
import type { MeshData } from "../geometry/mesh.js";

type V3 = [number, number, number];

const key = (x: number, y: number, z: number) => `${Math.round(x * 1000)},${Math.round(y * 1000)},${Math.round(z * 1000)}`;

/** New meshes with `uv2` (vertices split where charts meet); the input is not modified. */
export function unwrapLightmap(meshes: MeshData[], opts: { padding?: number } = {}): MeshData[] {
  const pad = opts.padding ?? 0.004;
  interface Tri { m: number; i: number; n: V3; d: number }
  const tris: Tri[] = [];
  meshes.forEach((md, m) => {
    const P = md.positions;
    for (let i = 0; i < md.indices.length; i += 3) {
      const [a, b, c] = [md.indices[i], md.indices[i + 1], md.indices[i + 2]];
      const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
      const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
      let n: V3 = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
      const l = Math.hypot(...n) || 1;
      n = [n[0] / l, n[1] / l, n[2] / l];
      tris.push({ m, i, n, d: n[0] * P[a * 3] + n[1] * P[a * 3 + 1] + n[2] * P[a * 3 + 2] });
    }
  });
  // charts: union triangles that share an edge (by position) and lie in the same plane
  const parent = tris.map((_, k) => k);
  const find = (k: number): number => (parent[k] === k ? k : (parent[k] = find(parent[k])));
  const edges = new Map<string, number>();
  tris.forEach((t, k) => {
    const md = meshes[t.m], P = md.positions;
    const ids = [md.indices[t.i], md.indices[t.i + 1], md.indices[t.i + 2]].map((v) => key(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]));
    for (let e = 0; e < 3; e++) {
      const a = ids[e], b = ids[(e + 1) % 3];
      const ek = a < b ? `${a}|${b}` : `${b}|${a}`;
      const other = edges.get(ek);
      if (other === undefined) edges.set(ek, k);
      else {
        const o = tris[other];
        if (o.n[0] * t.n[0] + o.n[1] * t.n[1] + o.n[2] * t.n[2] > 0.999 && Math.abs(o.d - t.d) < 0.002) parent[find(k)] = find(other);
      }
    }
  });
  const charts = new Map<number, number[]>();
  tris.forEach((_, k) => {
    const r = find(k);
    let list = charts.get(r);
    if (!list) charts.set(r, (list = []));
    list.push(k);
  });
  // project each chart onto its plane (true metres) and measure it
  interface Chart { tris: number[]; u: V3; v: V3; min: [number, number]; size: [number, number]; at?: [number, number] }
  const list: Chart[] = [];
  for (const ks of charts.values()) {
    const n = tris[ks[0]].n;
    const up: V3 = Math.abs(n[2]) > 0.9 ? [0, 1, 0] : [0, 0, 1];
    let u: V3 = [up[1] * n[2] - up[2] * n[1], up[2] * n[0] - up[0] * n[2], up[0] * n[1] - up[1] * n[0]];
    const ul = Math.hypot(...u) || 1;
    u = [u[0] / ul, u[1] / ul, u[2] / ul];
    const v: V3 = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const k of ks) {
      const t = tris[k], md = meshes[t.m], P = md.positions;
      for (let e = 0; e < 3; e++) {
        const vi = md.indices[t.i + e];
        const x = P[vi * 3] * u[0] + P[vi * 3 + 1] * u[1] + P[vi * 3 + 2] * u[2];
        const y = P[vi * 3] * v[0] + P[vi * 3 + 1] * v[1] + P[vi * 3 + 2] * v[2];
        x0 = Math.min(x0, x), x1 = Math.max(x1, x), y0 = Math.min(y0, y), y1 = Math.max(y1, y);
      }
    }
    list.push({ tris: ks, u, v, min: [x0, y0], size: [Math.max(x1 - x0, 1e-4), Math.max(y1 - y0, 1e-4)] });
  }
  // shelf packing, tallest first; shrink the scale until it fits
  list.sort((a, b) => b.size[1] - a.size[1]);
  const area = list.reduce((a, c) => a + c.size[0] * c.size[1], 0);
  let scale = 1 / Math.sqrt(area * 1.6 || 1);
  for (let attempt = 0; attempt < 60; attempt++) {
    let x = pad, y = pad, shelf = 0, ok = true;
    for (const c of list) {
      const w = c.size[0] * scale, h = c.size[1] * scale;
      if (x + w + pad > 1) {
        x = pad;
        y += shelf + pad;
        shelf = 0;
      }
      if (w + 2 * pad > 1 || y + h + pad > 1) {
        ok = false;
        break;
      }
      c.at = [x, y];
      x += w + pad;
      shelf = Math.max(shelf, h);
    }
    if (ok) break;
    scale *= 0.93;
  }
  // rebuild the meshes: one vertex per (old vertex, chart)
  const out: MeshData[] = meshes.map((md) => ({ material: md.material, positions: [], normals: [], uvs: [], indices: [], uv2: [] }));
  const remap = meshes.map(() => new Map<string, number>());
  for (const c of list) {
    const [ax, ay] = c.at ?? [0, 0];
    for (const k of c.tris) {
      const t = tris[k], md = meshes[t.m], o = out[t.m], P = md.positions;
      for (let e = 0; e < 3; e++) {
        const vi = md.indices[t.i + e];
        const rk = `${vi}:${c.tris[0]}`;
        let ni = remap[t.m].get(rk);
        if (ni === undefined) {
          ni = o.positions.length / 3;
          remap[t.m].set(rk, ni);
          o.positions.push(P[vi * 3], P[vi * 3 + 1], P[vi * 3 + 2]);
          o.normals.push(md.normals[vi * 3], md.normals[vi * 3 + 1], md.normals[vi * 3 + 2]);
          o.uvs.push(md.uvs[vi * 2], md.uvs[vi * 2 + 1]);
          const x = P[vi * 3] * c.u[0] + P[vi * 3 + 1] * c.u[1] + P[vi * 3 + 2] * c.u[2];
          const y = P[vi * 3] * c.v[0] + P[vi * 3 + 1] * c.v[1] + P[vi * 3 + 2] * c.v[2];
          o.uv2!.push(ax + (x - c.min[0]) * scale, ay + (y - c.min[1]) * scale);
        }
        o.indices.push(ni);
      }
    }
  }
  return out;
}
