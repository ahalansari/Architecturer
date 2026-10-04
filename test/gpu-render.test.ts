import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { compile } from "../src/pipeline.js";
import { buildScene, gpuInfo, sunPosition, skyFor } from "../src/render/gpu.js";
import { prepareView, renderView } from "../src/render/view.js";
import { buildBVH } from "../viewer/gpu/bvh.js";

test("sun over Kuwait: solar noon in June is high in the south, sunrise in the east", () => {
  const noon = sunPosition("06-21", "11:50");
  assert.ok(noon.elevation > 82 && noon.elevation < 85, String(noon.elevation));
  const winter = sunPosition("12-21", "11:40");
  assert.ok(winter.elevation > 35 && winter.elevation < 39 && winter.dir[1] < 0, "winter noon: low, to the south");
  const morning = sunPosition("03-21", "07:00");
  assert.ok(morning.dir[0] > 0.9 && morning.elevation > 5 && morning.elevation < 20, JSON.stringify(morning));
  const night = sunPosition("03-21", "22:00");
  assert.ok(night.elevation < -20);
  // no sun at night, a bright sun at noon, a warm low sun at dusk
  assert.deepEqual(skyFor(night.dir).sun.E, [0, 0, 0]);
  const E = skyFor(noon.dir).sun.E;
  assert.ok(E[1] > 70000 && E[1] < 120000);
  const dusk = skyFor(sunPosition("03-21", "17:40").dir).sun.E;
  assert.ok(dusk[0] > dusk[2] * 1.5, "dusk sun is warm");
});

test("BVH: every ray hits the same triangle as brute force", () => {
  // a random soup of small triangles
  let seed = 7;
  const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const n = 3000;
  const tri = new Float32Array(n * 9);
  for (let i = 0; i < n; i++) {
    const c = [r() * 20, r() * 20, r() * 20];
    for (let k = 0; k < 9; k++) tri[i * 9 + k] = c[k % 3] + (r() - 0.5) * 1.5;
  }
  const { nodes, order, count } = buildBVH(tri, n);
  assert.ok(count < 2 * n);
  assert.equal(new Set(order).size, n);
  const hitTri = (o: number[], d: number[], i: number) => {
    const v0 = [tri[i * 9], tri[i * 9 + 1], tri[i * 9 + 2]];
    const e1 = [0, 1, 2].map((k) => tri[i * 9 + 3 + k] - v0[k]), e2 = [0, 1, 2].map((k) => tri[i * 9 + 6 + k] - v0[k]);
    const cr = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const p = cr(d, e2), det = dot(e1, p);
    if (Math.abs(det) < 1e-12) return Infinity;
    const s = [o[0] - v0[0], o[1] - v0[1], o[2] - v0[2]];
    const u = dot(s, p) / det;
    if (u < 0 || u > 1) return Infinity;
    const q = cr(s, e1), v = dot(d, q) / det;
    if (v < 0 || u + v > 1) return Infinity;
    const t = dot(e2, q) / det;
    return t > 1e-6 ? t : Infinity;
  };
  const traverse = (o: number[], d: number[]) => {
    let best = Infinity;
    const st = [0];
    while (st.length) {
      const i = st.pop()!;
      const mn = [nodes[i * 8], nodes[i * 8 + 1], nodes[i * 8 + 2]], mx = [nodes[i * 8 + 4], nodes[i * 8 + 5], nodes[i * 8 + 6]];
      let t0 = 0, t1 = best;
      for (let k = 0; k < 3; k++) {
        const inv = 1 / d[k];
        let a = (mn[k] - o[k]) * inv, b = (mx[k] - o[k]) * inv;
        if (a > b) [a, b] = [b, a];
        t0 = Math.max(t0, a);
        t1 = Math.min(t1, b);
      }
      if (t0 > t1) continue;
      const first = nodes[i * 8 + 3], cnt = nodes[i * 8 + 7];
      if (cnt > 0) for (let j = first; j < first + cnt; j++) best = Math.min(best, hitTri(o, d, order[j]));
      else st.push(first, first + 1);
    }
    return best;
  };
  for (let k = 0; k < 400; k++) {
    const o = [r() * 30 - 5, r() * 30 - 5, r() * 30 - 5];
    const tgt = [r() * 20, r() * 20, r() * 20];
    const l = Math.hypot(tgt[0] - o[0], tgt[1] - o[1], tgt[2] - o[2]);
    const d = [(tgt[0] - o[0]) / l, (tgt[1] - o[1]) / l, (tgt[2] - o[2]) / l];
    let brute = Infinity;
    for (let i = 0; i < n; i++) brute = Math.min(brute, hitTri(o, d, i));
    const t = traverse(o, d);
    assert.ok(t === brute || Math.abs(t - brute) < 1e-9, `ray ${k}: ${t} vs ${brute}`);
  }
});

test("scene flattening: triangles, materials, textures and lamps", () => {
  const c = compile(JSON.parse(readFileSync("examples/villa.json", "utf8")));
  const v = prepareView(c, { view: "iso", textureSize: 64 });
  const day = buildScene(v.root, v.lookup, 64, false);
  const n = day.triMat.length;
  assert.equal(n, c.stats.triangles);
  assert.equal(day.tris.length, n * 9);
  assert.equal(day.attrs.length, n * 20);
  assert.ok(day.tris.every(Number.isFinite) && day.attrs.every(Number.isFinite));
  const nm = day.materials.length / 16;
  assert.ok(Math.max(...day.triMat) < nm);
  assert.ok(day.baseLayers.length > 3 && day.baseLayers.every((l) => l.length === 64 * 64 * 4));
  // glass is see-through
  assert.ok([...Array(nm).keys()].some((i) => day.materials[i * 16 + 3] < 0.99));
  assert.equal(day.lights.length, 0, "lamps are off by day");
  const night = buildScene(v.root, v.lookup, 64, true);
  assert.ok(night.lights.length >= 16 && night.lights.length % 16 === 0);
});

test("GPU render (skipped without a GPU)", async (t) => {
  const info = await gpuInfo();
  if (!info) return t.skip("no GPU adapter");
  const c = compile(JSON.parse(readFileSync("examples/villa.json", "utf8")));
  const r = await renderView(c, { view: "iso", width: 320, height: 200, samples: 16, renderer: "gpu", textureSize: 128 });
  assert.match(r.renderer, /gpu path tracer/);
  assert.ok(r.png.length > 10000);
  // the CPU path stays available
  const cpu = await renderView(c, { view: "iso", width: 160, height: 100, renderer: "cpu" });
  assert.equal(cpu.renderer, "cpu");
});
