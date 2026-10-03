import assert from "node:assert/strict";
import { test } from "node:test";
import { compile } from "../src/pipeline.js";
import { estimate } from "../src/cost/estimate.js";
import { renderPlanSVG } from "../src/render/plan.js";

function house(extra: Record<string, unknown> = {}, ext: Record<string, unknown> = {}) {
  return {
    name: "Block house",
    site: { ground: true },
    defaults: { wallThickness: 0.2, exteriorWallThickness: 0.3 },
    ...extra,
    levels: [
      {
        id: "g",
        height: 3.2,
        walls: [
          { id: "ext", points: [[0, 0], [10, 0], [10, 8], [0, 8]], closed: true, ...ext },
          { id: "mid", points: [[5, 0], [5, 8]] },
          { id: "thin", points: [[0, 4], [5, 4]], thickness: 0.13 },
        ],
        openings: [{ type: "door", at: [2, 0] }, { type: "door", at: [5, 2] }, { type: "door", at: [2.5, 4] }],
        rooms: [
          { name: "Majlis", polygon: [[5, 0], [10, 0], [10, 8], [5, 8]] },
          { name: "Hall", polygon: [[0, 0], [5, 0], [5, 4], [0, 4]] },
          { name: "Bedroom", polygon: [[0, 4], [5, 4], [5, 8], [0, 8]] },
        ],
        columns: [{ position: [5, 4], size: 0.4 }],
      },
      {
        id: "roof",
        height: 1.2,
        walls: [],
        autoSlab: false,
        roofs: [{ polygon: [[0, 0], [10, 0], [10, 8], [0, 8]], overhang: 0 }],
      },
    ],
  };
}

test("Kuwait / GCC by default: concrete block walls, porcelain floors, flat RC roofs", () => {
  const c = compile(house());
  assert.ok(c.ok, c.errors.join("\n"));
  const p = c.project!;
  assert.equal(p.construction.system, "rc_block");
  assert.equal(p.defaults.floorMaterial, "tiles_porcelain_white");
  assert.equal(p.levels[1].roofs[0].type, "flat");
  assert.equal(p.levels[1].roofs[0].undersideMaterial, "plaster_white");
  const byWall = Object.fromEntries(c.levels[0].segments.map((s) => [s.wallId, s.construction]));
  assert.deepEqual(byWall, { ext: "block_insulated_200", mid: "block_150", thin: "block_100" });
});

test("timber_frame keeps timber defaults; explicit values always win", () => {
  const t = compile(house({ construction: { system: "timber_frame" } }));
  assert.equal(t.project!.defaults.floorMaterial, "wood_floor_oak");
  assert.equal(t.project!.levels[1].roofs[0].type, "gable");
  assert.ok(t.levels[0].segments.every((s) => s.construction === "timber_stud"));
  const rc = compile(house({}, { construction: "rc_250" }));
  const ext = rc.levels[0].segments.find((s) => s.wallId === "ext")!;
  assert.equal(ext.construction, "rc_250");
  assert.ok(Math.abs(ext.thickness - 0.28) < 1e-9, "no wall thickness given: 250 mm RC + plaster both faces");
  const sized = compile(house({}, { construction: "rc_250", thickness: 0.35 }));
  assert.equal(sized.levels[0].segments.find((s) => s.wallId === "ext")!.thickness, 0.35, "an explicit thickness is kept");
});

test("plan hatches block walls and keys the assemblies", () => {
  const c = compile(house());
  const svg = renderPlanSVG(c, "g");
  assert.match(svg, /fill="url\(#wall_block\)"/);
  assert.match(svg, /200 mm insulated block/);
  assert.match(svg, /100 mm hollow concrete block, plastered/);
  // overlay sheets stay solid
  assert.doesNotMatch(renderPlanSVG(c, "g", { sheet: "electrical" }), /fill="url\(#wall_block\)"/);
});

test("full-scope bill: foundations, concrete, rebar, formwork, blockwork, plaster, roof build-up", () => {
  const c = compile({ ...house(), costs: { scope: "full" } });
  const bill = estimate(c);
  const lines = bill.sections.flatMap((s) => s.lines);
  const find = (re: RegExp) => lines.find((l) => re.test(l.description));
  const A = bill.sections.find((s) => s.code === "A")!;
  assert.match(A.name, /Reinforced-concrete frame/);
  const ground = find(/Ground-bearing slab/)!;
  assert.ok(Math.abs(ground.qty - 10.3 * 8.3 * 0.2) < 0.05, `ground slab ${ground.qty} m³`);
  const roof = find(/Roof slab/)!;
  assert.ok(Math.abs(roof.qty - 80 * 0.2) < 0.05);
  assert.match(find(/RC columns \(measured\)/)!.unit, /m³/);
  const rebar = find(/Steel reinforcement/)!;
  assert.equal(rebar.unit, "t");
  assert.ok(rebar.qty > 1 && rebar.qty < 20, `rebar ${rebar.qty} t`);
  assert.ok(find(/Formwork/)!.qty > 80);
  assert.ok(find(/External walls: 200 mm insulated block/)!.qty > 80);
  assert.ok(find(/Internal walls: 150 mm hollow concrete block/));
  assert.ok(find(/Cement-sand plaster to internal walls/)!.qty > 0);
  assert.equal(find(/Roof: waterproofing/)!.qty, 80);
  assert.ok(!lines.some((l) => /timber/i.test(l.description)), "no timber in a Kuwaiti RC building");
  assert.ok(bill.notes.some((n) => /t of steel reinforcement/.test(n)));
  // fit-out scope bills only the partitions
  const fit = estimate(compile(house()));
  assert.ok(!fit.sections.some((s) => s.code === "A"));
  assert.ok(fit.sections.flatMap((s) => s.lines).some((l) => /Internal walls: 150 mm hollow concrete block/.test(l.description)));
});
