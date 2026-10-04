import assert from "node:assert/strict";
import { test } from "node:test";
import { compile } from "../src/pipeline.js";
import { estimate } from "../src/cost/estimate.js";
import { buildContract } from "../src/contracts/contract.js";
import { renderPlanSVG } from "../src/render/plan.js";
import { landscapeReport } from "../src/elements/landscape.js";
import { pointInPolygon, type Vec2 } from "../src/geometry/math.js";

/** A 10 × 8 m house with a lawn on three sides (west, north, east), a planting bed, palms, a tree, shrubs and a hedge. */
function villa(extra: Record<string, unknown> = {}) {
  return {
    name: "Garden test",
    site: { ground: false },
    levels: [
      {
        id: "g",
        height: 3.2,
        walls: [{ id: "ext", points: [[0, 0], [10, 0], [10, 8], [0, 8]], closed: true }],
        openings: [{ type: "door", at: [5, 0] }],
        rooms: [{ name: "Living", polygon: [[0, 0], [10, 0], [10, 8], [0, 8]] }],
        gardens: [
          { id: "west", surface: "lawn", polygon: [[-6, -2], [-0.5, -2], [-0.5, 14], [-6, 14]] },
          { id: "east", surface: "lawn", polygon: [[10.5, -2], [16, -2], [16, 14], [10.5, 14]] },
          { id: "bed", surface: "planting", polygon: [[1, 9], [9, 9], [9, 11], [1, 11]] },
          { id: "gravel", surface: "gravel", polygon: [[1, -3], [4, -3], [4, -1], [1, -1]] },
          { id: "turf", surface: "turf", polygon: [[0, 12], [10, 12], [10, 14], [0, 14]] },
        ],
        furniture: [
          { type: "tree", position: [-3, 0], options: { kind: "palm" } },
          { type: "tree", position: [13, 12], options: { kind: "palm" } },
          { type: "tree", position: [-3, 12] },
          { type: "bush", position: [7, -2] },
          { type: "hedge", position: [5, 15], width: 10 },
          { type: "sofa", position: [5, 4] },
        ],
      },
    ],
    ...extra,
  };
}

test("gardens: areas, plants, spray / drip / bubbler zones and summer water", () => {
  const c = compile(villa());
  assert.ok(c.ok, c.errors.join("; "));
  const d = c.landscape!;
  assert.equal(d.areas.lawn, 176);
  assert.equal(d.areas.planting, 16);
  assert.equal(d.areas.turf, 20);
  assert.deepEqual(d.plants, { trees: 1, palms: 2, shrubs: 1, hedgeM: 10, planters: 0 });
  const kinds = new Set(d.zones.map((z) => z.kind));
  assert.deepEqual([...kinds].sort(), ["bubbler", "drip", "spray"]);
  // spray zones stay under 40 L/min, every lawn point is near a head
  assert.ok(d.zones.filter((z) => z.kind === "spray").every((z) => z.flow <= 40));
  const heads = d.levels[0].heads;
  for (const p of [[-3, 6], [13, 6], [-0.6, 13.9]] as Vec2[]) assert.ok(heads.some((h) => Math.hypot(h.at[0] - p[0], h.at[1] - p[1]) <= h.radius + 1e-6), `coverage at ${p}`);
  // bubblers: two per palm, one per tree
  assert.equal(d.levels[0].bubblers.reduce((a, b) => a + b.n, 0), 5);
  // turf and gravel get no water
  assert.ok(!heads.some((h) => h.at[1] > 12 && h.at[0] > 0 && h.at[0] < 10));
  // lawn 176 m² × 8 + palms 2 × 150 + tree 60 + bed 16 × 4 + hedge 10 × 8 + shrub 10
  assert.ok(Math.abs(d.demand.litresPerDay - (176 * 8 + 300 + 60 + 64 + 80 + 10)) < 3, String(d.demand.litresPerDay));
  assert.match(landscapeReport(d, ["Ground"]), /Irrigation zones:[\s\S]*Water: about/);
});

test("irrigation: controller outside, pipes never pass under the house", () => {
  const c = compile(villa());
  const L = c.landscape!.levels[0];
  const house: Vec2[] = [[0, 0], [10, 0], [10, 8], [0, 8]];
  assert.ok(L.controller && !pointInPolygon(L.controller, house), `controller ${L.controller}`);
  for (const v of L.valves) assert.ok(!pointInPolygon(v.at, house));
  for (const p of L.pipes)
    for (let i = 1; i < p.pts.length; i++)
      for (let k = 0; k <= 20; k++) {
        const a = p.pts[i - 1], b = p.pts[i];
        const q: Vec2 = [a[0] + ((b[0] - a[0]) * k) / 20, a[1] + ((b[1] - a[1]) * k) / 20];
        assert.ok(!(q[0] > 0.1 && q[0] < 9.9 && q[1] > 0.1 && q[1] < 7.9), `${p.kind} ${p.zone} passes under the house at ${q}`);
      }
  // every zone has a valve and a main
  for (const z of c.landscape!.zones) {
    assert.ok(L.valves.some((v) => v.zone === z.id));
    assert.ok(L.pipes.some((p) => p.kind === "main" && p.zone === z.id));
  }
  // a set controller position wins
  const set = compile(villa({ landscape: { controller: { at: [-1, 4] } } }));
  assert.deepEqual(set.landscape!.levels[0].controller, [-1, 4]);
  // and irrigation can be switched off
  assert.equal(compile(villa({ landscape: { irrigation: false } })).landscape!.zones.length, 0);
});

test("gardens: cost section L, contract package and the landscape sheet", () => {
  const c = compile(villa());
  const bill = estimate(c);
  const L = bill.sections.find((s) => s.code === "L")!;
  assert.ok(L, "section L");
  assert.equal(L.lines.find((l) => l.key === "landscape:lawn")!.qty, 176);
  assert.equal(L.lines.find((l) => l.key === "landscape:palm")!.qty, 2);
  assert.equal(L.lines.find((l) => l.key === "landscape:hedge")!.qty, 10);
  assert.ok(L.lines.some((l) => l.key === "irrigation:controller"));
  assert.ok(L.lines.every((l) => l.amount > 0));
  // trees and hedges are not also furniture
  assert.ok(!bill.sections.find((s) => s.code === "H")?.lines.some((l) => /tree|hedge|bush/.test(l.description)));
  const k = buildContract(c, { package: "landscape", mode: "supply" });
  assert.ok(Math.abs(k.value - L.subtotal) < 0.05);
  const labour = buildContract(c, { package: "landscape", mode: "labour" });
  assert.equal(labour.mode, "labour");
  const svg = renderPlanSVG(c, "g", { sheet: "landscape" });
  assert.match(svg, /landscape and irrigation/);
  assert.match(svg, /clipPath id="lawnclip0"/);
  assert.match(svg, />Z1</);
  // a garden drawn inside a room is reported
  const bad = villa();
  (bad.levels[0].gardens as unknown[]).push({ surface: "lawn", polygon: [[2, 2], [4, 2], [4, 4], [2, 4]] });
  assert.ok(compile(bad).warnings.some((w) => /inside a room/.test(w)));
});
