import assert from "node:assert/strict";
import { test } from "node:test";
import { compile } from "../src/pipeline.js";
import { estimate } from "../src/cost/estimate.js";
import { buildContract } from "../src/contracts/contract.js";
import { renderPlanSVG } from "../src/render/plan.js";

/** Two floors, 12 × 10 m; west and north bedrooms upstairs with the same window, so only orientation differs. */
function house(o: { ceiling?: number; hvac?: Record<string, unknown>; upperRooms?: unknown[] } = {}) {
  const room = (name: string, poly: number[][]) => ({ name, polygon: poly, ...(o.ceiling ? { ceilingHeight: o.ceiling } : {}) });
  const loop = { id: "ext", points: [[0, 0], [12, 0], [12, 10], [0, 10]], closed: true };
  return {
    name: "HVAC test",
    site: { ground: false },
    hvac: o.hvac ?? {},
    levels: [
      {
        id: "g",
        height: 3.6,
        walls: [loop, { id: "w1", points: [[6, 0], [6, 10]] }, { id: "w2", points: [[0, 6], [6, 6]] }, { id: "w3", points: [[9, 0], [9, 4]] }, { id: "w4", points: [[6, 4], [12, 4]] }],
        openings: [
          { type: "door", at: [3, 0] },
          { type: "door", at: [6, 8] },
          { type: "door", at: [6, 2] },
          { type: "door", at: [7.5, 4] },
          { type: "window", at: [0, 3], width: 2 },
          { type: "window", at: [9, 10], width: 2 },
        ],
        rooms: [
          room("Living room", [[0, 0], [6, 0], [6, 6], [0, 6]]),
          room("Kitchen", [[0, 6], [6, 6], [6, 10], [0, 10]]),
          room("Hall", [[6, 4], [12, 4], [12, 10], [6, 10]]),
          room("Bathroom", [[6, 0], [9, 0], [9, 4], [6, 4]]),
          room("Garage", [[9, 0], [12, 0], [12, 4], [9, 4]]),
        ],
      },
      {
        id: "u",
        height: 3.6,
        walls: [loop, { id: "u1", points: [[6, 0], [6, 10]] }, { id: "u2", points: [[0, 5], [6, 5]] }],
        openings: [
          { type: "window", at: [0, 2.5], width: 1.5 },
          { type: "window", at: [3, 10], width: 1.5 },
          { type: "door", at: [6, 2.5] },
          { type: "door", at: [6, 7.5] },
        ],
        rooms: o.upperRooms ?? [room("West bedroom", [[0, 0], [6, 0], [6, 5], [0, 5]]), room("North bedroom", [[0, 5], [6, 5], [6, 10], [0, 10]]), room("Landing", [[6, 0], [12, 0], [12, 10], [6, 10]])],
      },
    ],
  };
}

test("room loads: orientation, roof, unconditioned rooms, Kuwaiti sizing", () => {
  const c = compile(house({ ceiling: 3.0 }));
  assert.ok(c.ok, c.errors.join("; "));
  const h = c.hvac!;
  const by = (n: string) => h.rooms.find((r) => r.name === n)!;
  const west = by("West bedroom"), north = by("North bedroom");
  assert.equal(west.exposures.find((e) => e.glass > 0)?.orientation, "W");
  assert.equal(north.exposures.find((e) => e.glass > 0)?.orientation, "N");
  assert.ok(west.parts.glassSolar > north.parts.glassSolar * 3, `${west.parts.glassSolar} vs ${north.parts.glassSolar}`);
  assert.ok(west.roof > 0 && by("Living room").roof === 0, "top floor under the roof, ground floor not");
  for (const n of ["Bathroom", "Garage"]) assert.equal(by(n).conditioned, false, n);
  assert.ok(by("Kitchen").parts.equipment > by("Living room").parts.equipment);
  // Kuwaiti villas run at roughly 15–35 m² per TR
  assert.ok(h.totals.m2PerTR > 12 && h.totals.m2PerTR < 40, `${h.totals.m2PerTR} m²/TR`);
  assert.ok(h.rooms.every((r) => !r.conditioned || (r.total > 0 && r.supply > 0)));
});

test("packaged units: small floors share one unit and riser; big floors split", () => {
  const c = compile(house({ ceiling: 3.0 }));
  const h = c.hvac!;
  assert.equal(h.system, "packaged");
  assert.equal(h.units.length, 1, h.units.map((u) => `${u.id} ${u.load}`).join(", "));
  const u = h.units[0];
  assert.ok(u.onRoof && u.size >= u.load && [5, 7.5, 10, 12.5, 15].includes(u.size));
  assert.equal(new Set(u.rooms.map((r) => r.level)).size, 2);
  assert.ok(h.levels.every((l) => l.shafts.length === 1), "the riser runs through both floors");
  assert.equal(h.circuits.length, 1);
  assert.match(h.circuits[0].label, /packaged unit .* TR on the roof/);
  // supply ducts: the branches leaving the riser carry the floor's whole supply air
  const lv = h.levels[0];
  const shaft = lv.shafts[0].at;
  const fromShaft = lv.ducts.filter((d) => d.kind === "supply" && Math.hypot(d.pts[0][0] - shaft[0], d.pts[0][1] - shaft[1]) < 1e-6);
  const floorSupply = h.rooms.filter((r) => r.level === 0 && r.conditioned).reduce((a, r) => a + r.supply, 0);
  assert.ok(Math.abs(fromShaft.reduce((a, d) => a + d.airflow, 0) - floorSupply) <= lv.terminals.length, "air is conserved at the riser");
  assert.ok(lv.terminals.some((t) => t.kind === "return") && lv.thermostats.length + h.levels[1].thermostats.length === 1);
  // a smaller maximum splits the floors into more units
  const many = compile(house({ ceiling: 3.0, hvac: { maxUnitTR: 2 } })).hvac!;
  assert.ok(many.units.length >= 3, `${many.units.length} units`);
});

test("coordination: ducts need a false ceiling", () => {
  const flat = compile(house()).hvac!;
  assert.ok(flat.issues.some((i) => /no false ceiling/.test(i)), flat.issues.join("\n"));
  const ok = compile(house({ ceiling: 3.0 })).hvac!;
  assert.ok(!ok.issues.some((i) => /false ceiling|too shallow/.test(i)), ok.issues.join("\n"));
});

test("split and none systems", () => {
  const split = compile(house({ ceiling: 3.0, hvac: { system: "split" } })).hvac!;
  const cond = split.rooms.filter((r) => r.conditioned);
  assert.ok(split.units.length >= cond.length);
  assert.ok(split.units.every((u) => u.kind === "split" && [1, 1.5, 2, 2.5, 3].includes(u.size)));
  assert.equal(split.levels.reduce((a, l) => a + l.splits.length, 0), split.units.length);
  assert.equal(split.levels.reduce((a, l) => a + l.ducts.length, 0), 0);
  const none = compile(house({ hvac: { system: "none" } })).hvac!;
  assert.equal(none.units.length, 0);
  assert.ok(none.rooms.every((r) => !r.conditioned));
});

test("cost section J, the hvac contract package and the plan sheet", () => {
  const c = compile(house({ ceiling: 3.0 }));
  const bill = estimate(c);
  const J = bill.sections.find((s) => s.code === "J")!;
  assert.ok(J, "air conditioning in the bill");
  assert.ok(J.lines.some((l) => l.unit === "TR" && /packaged unit/i.test(l.description)));
  assert.ok(J.lines.some((l) => /Ductwork/.test(l.description) && l.qty > 10));
  assert.ok(!bill.notes.some((n) => /Excludes: HVAC/.test(n)));
  const k = buildContract(c, { package: "hvac" });
  assert.equal(k.mode, "supply");
  assert.ok(Math.abs(k.value - J.subtotal) < 0.05, `${k.value} vs ${J.subtotal}`); // lines recomputed from rounded quantities
  assert.ok(k.items.every((i) => !/^[A-Za-z]/.test(i.ar.trim().charAt(0)) || i.ar.startsWith("توريد")), "Arabic item names");
  const svg = renderPlanSVG(c, "g", { sheet: "hvac" });
  assert.match(svg, /air conditioning layout/);
  assert.match(svg, /PU-1 riser/);
  assert.match(svg, /stroke-dasharray/); // return ducts
  const elec = renderPlanSVG(c, "g", { sheet: "electrical" });
  if (c.levels[0].services.electrical.some((e) => e.type === "db")) assert.match(elec, /AC-1/);
});

test("air side: index runs, fan static, noise and air changes", async () => {
  const { diffuserNC, ductLoss } = await import("../src/elements/airside.js");
  // a 300 × 200 duct at 200 L/s: about 3.3 m/s, under 1 Pa/m
  const d = ductLoss(200, 0.3, 0.2, 1, 0);
  assert.ok(d.v > 3.2 && d.v < 3.4 && d.paPerM > 0.4 && d.paPerM < 1, JSON.stringify(d));
  assert.equal(diffuserNC(2.5), 25);
  assert.ok(diffuserNC(4) > 33);
  const { readFileSync } = await import("node:fs");
  const c = compile(JSON.parse(readFileSync("examples/villa.json", "utf8")));
  const air = c.hvac!.air!;
  const u = air.units[0];
  assert.ok(u.supplyPa > 30 && u.returnPa > 20 && u.riserPa > 0, JSON.stringify(u));
  assert.equal(u.espPa, Math.round((u.supplyPa + u.returnPa) * 1.15));
  assert.ok(u.fanW > 200 && u.sfp > 0.3 && u.sfp < 3);
  assert.ok(u.indexSupply && u.indexReturn);
  // every duct has a velocity and friction; every supplied room has a neck within its NC limit
  assert.equal(air.ducts.length, c.hvac!.levels.reduce((a, l) => a + l.ducts.length, 0));
  for (const r of air.rooms) {
    assert.ok(r.ach > 2 && r.ach < 20, `${r.name} ${r.ach}`);
    assert.ok(r.neckVelocity <= (r.ncTarget <= 30 ? 2.5 : r.ncTarget <= 35 ? 3 : 3.5) + 1e-9 || r.neck === 400);
  }
  if (u.espPa > u.standardPa) assert.ok(air.issues.some((i) => /high-static/.test(i)));
});
