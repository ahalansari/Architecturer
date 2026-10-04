import assert from "node:assert/strict";
import { test } from "node:test";
import { compile } from "../src/pipeline.js";
import { estimate } from "../src/cost/estimate.js";
import { renderPlanSVG } from "../src/render/plan.js";
import { peakFlow, pipeLoss, waterReport } from "../src/elements/water.js";

/** Two floors 12 × 8 m: a kitchen and a bathroom downstairs, a bathroom upstairs (above, or moved east). */
function house(o: { water?: Record<string, unknown>; upBathX?: number } = {}) {
  const ux = o.upBathX ?? 0;
  const walls = (id: string, x = 0) => [
    { id: `ext_${id}`, points: [[0, 0], [12, 0], [12, 8], [0, 8]], closed: true },
    { id: `w1_${id}`, points: [[x + 3, 0], [x + 3, 4]] },
    { id: `w2_${id}`, points: [[x, 4], [x + 3, 4]] },
  ];
  const bath = (x: number) => ({ name: "Bathroom", polygon: [[x, 0], [x + 3, 0], [x + 3, 4], [x, 4]] });
  const fx = (x: number, tub = false) => [
    { type: "toilet", position: [x + 0.5, 3.6], rotation: 180 },
    { type: "bathroom_sink", position: [x + 1.6, 3.7], rotation: 180 },
    tub ? { type: "bathtub", position: [x + 1.5, 0.45] } : { type: "shower", position: [x + 2.4, 0.5] },
  ];
  return {
    name: "Water test",
    site: { ground: false },
    ...(o.water ? { water: o.water } : {}),
    levels: [
      {
        id: "g",
        height: 3.2,
        walls: walls("g"),
        openings: [{ type: "door", at: [6, 0] }, { type: "door", at: [3, 2] }],
        rooms: [bath(0), { name: "Kitchen", polygon: [[3, 0], [12, 0], [12, 8], [0, 8], [0, 4], [3, 4]] }],
        furniture: [...fx(0), { type: "sink_counter", position: [11.6, 6], rotation: 270 }],
      },
      {
        id: "f1",
        height: 3.2,
        walls: walls("f1", ux),
        openings: [{ type: "door", at: [ux + 3, 2] }],
        rooms: [bath(ux), { name: "Master bedroom", polygon: ux ? [[0, 0], [ux, 0], [ux, 8], [0, 8]] : [[3, 0], [12, 0], [12, 8], [0, 8], [0, 4], [3, 4]] }],
        furniture: fx(ux, true),
      },
    ],
  };
}

test("peak flow and pipe friction behave", () => {
  // DIN 1988-300: a single outlet keeps its own flow; many outlets are diversified
  assert.equal(peakFlow(0.15, 0.15), 0.15);
  assert.ok(peakFlow(3, 0.15) < 1 && peakFlow(3, 0.15) > 0.8);
  // 0.3 L/s in a 16.6 mm bore: about 1.4 m/s, a few hundred Pa per metre
  const { v, dp } = pipeLoss(0.3, 16.6, 1, 0, 0.007, 0.75e-6);
  assert.ok(v > 1.3 && v < 1.5, String(v));
  assert.ok(dp > 0.01 && dp < 0.025, String(dp));
});

test("water: sizes, pressures with a booster, hot waits, storage and stacks", () => {
  const c = compile(house());
  assert.ok(c.ok, c.errors.join("; "));
  const w = c.water!;
  assert.equal(w.supply, "tank_booster");
  assert.ok(w.outlets.length >= 6);
  // every outlet has enough pressure with the booster
  for (const o of w.outlets) assert.ok(Math.min(o.cold ?? 9, o.hot ?? 9) >= o.required, `${o.label} ${o.cold}/${o.hot}`);
  // the top riser carries the whole house and is the largest pipe
  const risers = w.segments.filter((s) => s.kind === "riser");
  assert.ok(risers.length === 2 && risers[0].flow >= risers[1].flow && risers[0].od >= risers[1].od);
  assert.ok(w.segments.every((s) => s.velocity <= (s.kind === "riser" || s.kind === "main" ? 1.5 : 2.0) + 1e-9));
  // hot outlets have a wait time, and lower floors see more pressure (static head)
  const hot = w.outlets.filter((o) => o.hot !== undefined);
  assert.ok(hot.every((o) => o.waitS !== undefined && o.waitL! > 0));
  // the ground floor's automatic stop valve is at the kitchen sink, far from the riser: say where it should go
  const far = w.issues.find((i) => /stop valve is [\d.]+ m from the riser/.test(i));
  assert.ok(far, w.issues.join("\n"));
  const at = JSON.parse(far!.match(/inlet at (\[[^\]]+\])/)![1]) as [number, number];
  const fed = house();
  (fed.levels[0] as Record<string, unknown>).plumbing = [{ type: "inlet", position: at }];
  const w2 = compile(fed).water!;
  assert.ok(!w2.issues.some((i) => /from the riser/.test(i)));
  // fed from the riser, the ground floor gets the extra static head
  const wc = (d: typeof w, l: number) => d.outlets.find((o) => o.level === l && o.kind === "wc")!.cold!;
  assert.ok(wc(w2, 0) > wc(w2, 1) + 0.2, `${wc(w2, 0)} vs ${wc(w2, 1)}`);
  // bathroom with a bath gets a 100 L heater
  assert.equal(w.heaters.find((h) => h.level === 1)!.litres, 100);
  // stacked bathrooms: the upper stack drops into the lower one
  const up = w.stacks.find((s) => s.level === 1)!;
  assert.ok(up.below, "upper stack continues below");
  assert.ok(!w.issues.some((i) => /no stack below/.test(i)));
  // occupants: one bedroom → two people (min); summer cold water from an exposed roof tank
  assert.equal(w.storage.occupants, 2);
  assert.equal(w.coldSummerC, 42);
  assert.ok(w.issues.some((i) => /42 °C/.test(i)));
  assert.match(waterReport(w, ["G", "F1"]), /Booster set:[\s\S]*Outlets[\s\S]*Drainage stacks/);
});

test("water: gravity tanks are too weak upstairs; a moved bathroom has no stack below", () => {
  const g = compile(house({ water: { supply: "tank_gravity" } })).water!;
  assert.ok(g.outlets.some((o) => o.level === 1 && (o.cold ?? 9) < o.required));
  assert.ok(g.issues.some((i) => /below their minimum flow pressure.*add a booster set/.test(i)));
  assert.equal(g.booster, undefined);
  const moved = compile(house({ upBathX: 7 })).water!;
  assert.ok(moved.issues.some((i) => /no stack below it \(it lands in the Kitchen/.test(i)), moved.issues.join("\n"));
  const shaded = compile(house({ water: { tank: "insulated" } })).water!;
  assert.equal(shaded.coldSummerC, 34);
  assert.ok(!shaded.issues.some((i) => /°C/.test(i)));
});

test("water: plant in the bill and hydraulics on the plumbing sheet", () => {
  const c = compile(house());
  const G = estimate(c, { scope: "full" }).sections.find((s) => s.code === "G")!;
  for (const k of ["plumbing:booster_set", "plumbing:roof_tank_gal", "plumbing:transfer_pump", "plumbing:ground_tank_m3", "plumbing:riser_m"]) assert.ok(G.lines.some((l) => l.key === k && l.amount > 0), k);
  assert.ok(!estimate(c).sections.find((s) => s.code === "G")!.lines.some((l) => l.key === "plumbing:ground_tank_m3"), "ground tank only in the full build");
  const svg = renderPlanSVG(c, "f1", { sheet: "plumbing" });
  assert.match(svg, /riser Ø\d+/);
  assert.match(svg, /\d\.\d bar · hot \d+ s/);
  assert.match(svg, /Water supply/);
});
