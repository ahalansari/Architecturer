import assert from "node:assert/strict";
import { test } from "node:test";
import { compile } from "../src/pipeline.js";
import { estimate } from "../src/cost/estimate.js";
import { buildContract } from "../src/contracts/contract.js";
import { renderPlanSVG } from "../src/render/plan.js";

/** Three floors 10 × 8 m, a hall in the middle; the lift sits in the hall's north part with doors to the south. */
function house(lift: Record<string, unknown> = {}, o: { height?: number; furniture?: unknown[] } = {}) {
  const level = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    height: o.height ?? 3.2,
    walls: [{ id: `ext_${id}`, points: [[0, 0], [10, 0], [10, 8], [0, 8]], closed: true }, { id: `w1_${id}`, points: [[3, 0], [3, 8]] }, { id: `w2_${id}`, points: [[7, 0], [7, 8]] }],
    openings: [{ type: "door", at: [3, 2] }, { type: "door", at: [7, 2] }, ...(id === "g" ? [{ type: "door", at: [5, 0] }] : [])],
    rooms: [
      { name: "West room", polygon: [[0, 0], [3, 0], [3, 8], [0, 8]] },
      { name: "Hall", polygon: [[3, 0], [7, 0], [7, 8], [3, 8]] },
      { name: "East room", polygon: [[7, 0], [10, 0], [10, 8], [7, 8]] },
    ],
    ...extra,
  });
  return {
    name: "Lift test",
    site: { ground: false },
    levels: [level("g", { furniture: o.furniture ?? [] }), level("f1"), level("f2")],
    elevators: [{ id: "L1", shaft: { at: [5, 6.6], facing: "south" }, capacity: 6, stops: [{ level: "g" }, { level: "f1" }, { level: "f2" }], ...lift }],
  };
}

test("a lift with a shaft: RC walls on every floor, landing openings, spec and roof overrun", () => {
  const c = compile(house());
  assert.ok(c.ok, c.errors.join("; "));
  const l = c.lifts![0];
  assert.equal(l.persons, 6);
  assert.deepEqual(l.shaft, [1.55, 1.75]);
  assert.equal(l.stops, 3);
  assert.equal(l.travel, 6.4);
  for (const [i, info] of c.levels.entries()) {
    const segs = info.segments.filter((s) => s.wallId === `L1_shaft_${c.project!.levels[i].id}`);
    assert.equal(segs.length, 4, `shaft walls on level ${i}`);
    assert.ok(segs.every((s) => s.construction === "rc_200" && !s.exterior));
    assert.ok(info.openings.some((o) => o.id === `L1_door_${c.project!.levels[i].id}`));
  }
  // 3.2 m floors leave 3.0 m above the top landing; MRL traction needs 3.5 m
  assert.equal(l.overrun, 0.7);
  assert.ok(c.warnings.some((w) => /elevator 'L1': .*overrun/.test(w)));
  assert.ok(c.notes!.some((n) => /lift 'L1': 6 persons \/ 450 kg/.test(n)));
  // stops got their landing points in front of the doors, inside the hall
  assert.ok(c.project!.elevators[0].stops.every((s) => s.at && s.at[1] < 5.7 && s.at[1] > 4));
  // power supply in the schedule
  assert.equal(c.liftCircuits![0].kind, "lift");
  assert.equal(c.liftCircuits![0].rating, 32);
});

test("lift checks: furniture in the shaft, blocked landing; home lift needs no overrun or deep pit", () => {
  const blocked = compile(house({}, { furniture: [{ type: "armchair", position: [5, 6.6] }, { type: "sofa", position: [5, 5.2] }] }));
  assert.ok(blocked.warnings.some((w) => /armchair .* inside the lift shaft/.test(w)), blocked.warnings.join("\n"));
  assert.ok(blocked.warnings.some((w) => /sofa.*blocks the lift landing/.test(w)));
  const home = compile(house({ drive: "home_lift" }));
  const l = home.lifts![0];
  assert.equal(l.overrun, 0);
  assert.equal(l.pit, 0.15);
  assert.equal(home.liftCircuits![0].rating, 16);
  const tall = compile(house({}, { height: 3.8 }));
  assert.equal(tall.lifts![0].overrun, 0);
  assert.ok(!tall.warnings.some((w) => /overrun/.test(w)));
});

test("lift: cost section K, contract package and the plan symbol", () => {
  const c = compile(house());
  const bill = estimate(c);
  const K = bill.sections.find((s) => s.code === "K")!;
  assert.ok(K);
  assert.ok(K.lines.some((l) => /6-person 450 kg/.test(l.description)));
  assert.equal(K.lines.find((l) => /additional stops/.test(l.description))!.qty, 1);
  assert.ok(K.lines.some((l) => /pit 1.1 m/.test(l.description)));
  assert.ok(K.lines.some((l) => /overrun 0.7 m/.test(l.description)));
  // the shaft walls are billed with the structure (full scope) as RC walls
  const full = estimate(c, { scope: "full" });
  assert.ok(full.sections.find((s) => s.code === "A")!.lines.some((l) => /RC|reinforced concrete wall/i.test(l.description)));
  const k = buildContract(c, { package: "lifts" });
  assert.equal(k.mode, "supply");
  assert.ok(Math.abs(k.value - K.subtotal) < 0.05);
  for (const lv of ["g", "f1", "f2"]) assert.match(renderPlanSVG(c, lv), /LIFT L1/);
  // a plan without a shaft keeps the old behaviour: circulation link only
  const plain = compile({ ...house(), elevators: [{ id: "E", stops: [{ level: "g", at: [5, 4] }, { level: "f1", at: [5, 4] }] }] });
  assert.equal(plain.lifts!.length, 0);
});
