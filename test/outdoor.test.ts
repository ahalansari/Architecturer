import assert from "node:assert/strict";
import { test } from "node:test";
import { compile, texturesFor } from "../src/pipeline.js";
import { estimate } from "../src/cost/estimate.js";
import { resolveMaterial } from "../src/materials/library.js";
import { walkMeshes } from "../src/geometry/scene.js";

const court = (level: Record<string, unknown>) =>
  compile({
    name: "Courtyard",
    site: { ground: false },
    levels: [{ id: "g", height: 3.2, walls: [{ id: "back", points: [[0, 10], [12, 10]], height: 6 }], ...level }],
  });

const trisOf = (c: ReturnType<typeof compile>, mat: string) => {
  let n = 0;
  walkMeshes(c.root!, (m) => {
    if (m.material === mat) n += m.indices.length / 3;
  });
  return n;
};

test("foliage cards: frond and leaf textures are cut out (alpha), materials alpha-tested and double-sided", () => {
  for (const name of ["palm_frond", "olive_leaves", "leaves_green"]) {
    const def = resolveMaterial(name, {} as never);
    assert.ok(def.alphaCutoff && def.doubleSided, name);
    const t = texturesFor(def, 128)!;
    let clear = 0, solid = 0;
    for (let i = 3; i < t.baseColor.length; i += 4) t.baseColor[i] < 128 ? clear++ : solid++;
    assert.ok(clear > solid * 0.3 && solid > 200, `${name}: ${solid} solid, ${clear} clear`);
  }
});

test("trees: date palm fronds, olive and shrub leaf cards", () => {
  const c = court({
    furniture: [
      { type: "tree", position: [2, 5], width: 4, depth: 4, height: 6, options: { kind: "palm" } },
      { type: "tree", position: [6, 5], width: 2.5, depth: 2.5, height: 3, options: { kind: "olive" } },
      { type: "tree", position: [9, 5], options: { kind: "deciduous" } },
      { type: "bush", position: [11, 5] },
    ],
  });
  assert.ok(c.ok, c.errors.join("; "));
  assert.ok(trisOf(c, "palm_frond") >= 26 * 9 * 2 * 2, "26 V-folded fronds of 9 segments");
  assert.ok(trisOf(c, "palm_bark") > 100);
  assert.ok(trisOf(c, "olive_leaves") > 100);
  assert.ok(trisOf(c, "leaves_green") > 60);
});

test("screens and pergolas: slats, rails, posts; priced under terraces & outdoor", () => {
  const c = court({
    screens: [{ points: [[1, 10.3], [6, 10.3]], base: 3.4, height: 2.5, slat: { width: 0.05, depth: 0.1, gap: 0.05 } }],
    pergolas: [{ polygon: [[0, 0], [5, 0], [5, 4], [0, 4]], height: 2.8, slat: { width: 0.06, depth: 0.15, gap: 0.09 } }],
    furniture: [{ type: "water_wall", position: [10, 3] }],
  });
  assert.ok(c.ok, c.errors.join("; "));
  const names = new Set<string>();
  walkMeshes(c.root!, (_m, n) => names.add(n.name));
  assert.ok(names.has("screens") && names.has("pergolas"));
  // 5 m of 5 cm fins at 10 cm pitch: 50 fins, each a 12-triangle prism, plus two rails
  assert.ok(trisOf(c, "wood_teak") >= 50 * 12);
  assert.ok(trisOf(c, "water") >= 4 && trisOf(c, "stone_wet_dark") > 0);
  const I = estimate(c).sections.find((s) => s.code === "I")!;
  assert.equal(I.lines.find((l) => l.key === "screen:slats")!.qty, 12.5);
  assert.equal(I.lines.find((l) => l.key === "pergola:timber")!.qty, 20);
});
