import assert from "node:assert/strict";
import { test } from "node:test";
import { compile } from "../src/pipeline.js";
import { estimate } from "../src/cost/estimate.js";
import { renderPlanSVG } from "../src/render/plan.js";
import { walkMeshes } from "../src/geometry/scene.js";
import { designPumpPits, pumpPitReport, pumpPitSVG, simulatePit, studyPit } from "../src/elements/pumppit.js";

/**
 * A basement 3.5 m down (12 × 8 m: a shower room and a plant room inside, a sunken court beside it open to the sky)
 * under a ground floor that covers only the house.
 */
function villa(o: { pits?: Record<string, unknown>[]; court?: number[][] } = {}) {
  const court = o.court ?? [[12.2, 0.2], [15.8, 0.2], [15.8, 7.8], [12.2, 7.8]];
  return {
    name: "Basement test",
    site: { ground: false },
    levels: [
      {
        id: "b",
        elevation: -3.5,
        height: 3.5,
        walls: [
          { id: "ext_b", points: [[0, 0], [12, 0], [12, 8], [0, 8]], closed: true },
          { id: "w1", points: [[4, 0], [4, 8]] },
          { id: "w2", points: [[0, 4], [4, 4]] },
        ],
        openings: [{ type: "door", at: [4, 2] }, { type: "door", at: [4, 6] }, { type: "door", at: [2, 4] }],
        rooms: [
          { name: "Shower room", polygon: [[0, 0], [4, 0], [4, 4], [0, 4]] },
          { name: "Plant room", polygon: [[0, 4], [4, 4], [4, 8], [0, 8]] },
          { name: "Gym", polygon: [[4, 0], [12, 0], [12, 8], [4, 8]] },
        ],
        furniture: [
          { type: "toilet", position: [0.5, 3.6], rotation: 180 },
          { type: "bathroom_sink", position: [1.6, 3.7], rotation: 180 },
          { type: "shower", position: [3.4, 0.5] },
        ],
        terraces: [{ id: "court", name: "Sunken court", polygon: court }],
        pumpPits: o.pits ?? [],
      },
      {
        id: "g",
        elevation: 0,
        height: 3.2,
        walls: [{ id: "ext_g", points: [[0, 0], [12, 0], [12, 8], [0, 8]], closed: true }],
        openings: [{ type: "door", at: [6, 0] }],
        rooms: [{ name: "Living", polygon: [[0, 0], [12, 0], [12, 8], [0, 8]] }],
      },
    ],
  };
}

const PITS = [
  { id: "SP1", kind: "sewage", position: [1.2, 6.8], discharge: [-2, 6.8] },
  { id: "DP1", kind: "drainage", position: [14, 1.2], discharge: [18, 1.2] },
];

test("a basement below the sewer with fixtures and an open court, and no pit: flagged", () => {
  const c = compile(villa());
  assert.ok(c.ok, c.errors.join("; "));
  const w = c.warnings.find((x) => /cannot drain to the street sewer/.test(x));
  assert.ok(w && /fixture/.test(w) && /Sunken court/.test(w), c.warnings.join("\n"));
});

test("suggested pits: a sewage pit in the plant room, a sump in the court, sized and with ordered levels", () => {
  const c = compile(villa());
  const d = designPumpPits(c.project as never, c.levels as never, { suggest: true });
  const sp = d.pits.find((p) => p.kind === "sewage")!, dp = d.pits.find((p) => p.kind === "drainage")!;
  assert.ok(sp && dp && !sp.explicit && !dp.explicit);
  assert.equal(sp.room, "Plant room");
  assert.equal(dp.room, "Sunken court");
  // the WC, basin and shower go to the sewage pit; the court's rain to the sump
  assert.ok(sp.fixtures.some((f) => f.kind === "wc") && sp.fixtures.some((f) => f.kind === "shower"));
  assert.ok(!dp.fixtures.length && dp.areas[0].name === "Sunken court");
  assert.ok(Math.abs(dp.inflow.stormLs - (3.6 * 7.6 * 0.95 * 60) / 3600) < 0.01, String(dp.inflow.stormLs));
  // EN 12056-2: WC 2.0 + basin 0.5 + shower 0.6 (+ the room's floor drain) → peak ≥ the WC's 2.0 L/s
  assert.ok(sp.inflow.peakLs >= 2);
  for (const p of [sp, dp]) {
    const L = p.levels;
    assert.ok(L.stop < L.start && L.start < (L.assist ?? L.alarm) && (L.assist ?? 0) < L.alarm && L.alarm < L.inlet && L.inlet < L.top, JSON.stringify(L));
    // the pump delivers the inflow with a self-cleansing rising main, and the static lift includes the loop above ground
    assert.ok(p.pumps.atStop.flowLs >= (p.kind === "sewage" ? p.inflow.peakLs : p.inflow.stormLs));
    assert.ok(p.pumps.atStop.velocity >= 0.7 && p.pumps.atStop.velocity <= 2.3, String(p.pumps.atStop.velocity));
    assert.ok(p.main.staticHead > 3.5 + p.depth - 1 && p.main.crestZ > 0);
  }
  assert.equal(sp.pumps.model.type, "vortex");
  assert.ok(sp.main.od >= 90, "sewage rising main DN 80 at least");
  assert.equal(dp.pumps.model.type, "drainage");
  const text = pumpPitReport(d.pits.map(studyPit), c.levels.map((l) => l.name), d.issues);
  assert.match(text, /SUGGESTED/);
  assert.match(text, /add_elements level 'b' \{ pumpPits: \[\{"id":"SP1","kind":"sewage"/);
});

test("simulation: a normal day stays under the alarm within the starts limit, sewage never stands past the timer", () => {
  // a busy household (three times the usual use), so the pumps cycle and alternate
  const c = compile(villa({ pits: [{ ...PITS[0], usage: 3 }, PITS[1]] }));
  assert.ok(c.ok && !c.warnings.some((w) => /cannot drain/.test(w)), c.warnings.join("\n"));
  const sp = c.pumpPits!.find((p) => p.id === "SP1")!;
  const day = simulatePit(sp, "day");
  assert.ok(day.stats.inLitres > 100 && Math.abs(day.stats.pumpedLitres - day.stats.inLitres) < sp.volumes.effective * 1000 + 50);
  assert.ok(day.stats.maxLevel < sp.levels.alarm && day.stats.floodAt === undefined);
  assert.ok(day.stats.maxStartsPerHour <= 12);
  assert.ok(day.stats.longestStandH <= sp.pumpOutHours + 0.6, String(day.stats.longestStandH));
  // duty / standby alternate
  assert.ok(day.stats.starts[0] > 0 && day.stats.starts[1] > 0, JSON.stringify(day.stats.starts));
  // repeatable
  assert.deepEqual(simulatePit(sp, "day").stats, day.stats);
});

test("simulation: a big court on a small sump floods in a power cut, and with one pump when it fails", () => {
  const big = [[12.2, -10], [30, -10], [30, 7.8], [12.2, 7.8]];
  const c = compile(villa({ court: big, pits: [PITS[0], { id: "DP1", kind: "drainage", position: [14, 1.2], size: [0.8, 0.8], depth: 1, pumps: 1, discharge: [32, 1.2] }] }));
  const dp = c.pumpPits!.find((p) => p.id === "DP1")!;
  assert.ok(c.warnings.some((w) => /one pump only/.test(w)));
  const storm = simulatePit(dp, "storm");
  assert.ok(storm.stats.floodAt === undefined, "the pump keeps up with the storm");
  const cut = simulatePit(dp, "power_cut");
  assert.ok(cut.stats.floodAt !== undefined && cut.stats.floodLitres > 500, JSON.stringify(cut.stats));
  const fail = simulatePit(dp, "pump_failure");
  assert.ok(fail.stats.floodAt !== undefined);
  const st = studyPit(dp);
  assert.ok(st.issues.some((i) => /Power cut.*fills to the floor.*generator/.test(i)), st.issues.join("\n"));
  assert.ok(st.issues.some((i) => /Duty pump fails.*standby pump/.test(i)));
  const svg = pumpPitSVG(st, "Basement");
  assert.match(svg, /floods \d+ L/);
});

test("explicit pits: built in 3D, drawn on the plumbing sheet, priced in section G", () => {
  const c = compile(villa({ pits: PITS }));
  const names = new Set<string>();
  let concrete = 0;
  walkMeshes(c.root!, (m, n) => {
    names.add(n.name);
    if (n.name === "pump_pits" && m.material === "concrete_dark") concrete += m.indices.length / 3;
  });
  assert.ok(names.has("pump_pits") && concrete >= 60);
  const svg = renderPlanSVG(c, "b", { sheet: "plumbing" });
  assert.match(svg, /sewage pump pit SP1/);
  assert.match(svg, /drainage sump DP1/);
  assert.match(svg, />MH</);
  const G = estimate(c).sections.find((s) => s.code === "G")!;
  assert.equal(G.lines.filter((l) => l.key === "pit:chamber_m3").length, 2);
  assert.equal(G.lines.find((l) => l.key === "pit:pump_sewage")!.qty, 2);
  assert.ok(G.lines.some((l) => l.key === "pit:rising_main_m" && /Ø90/.test(l.description)));
});

test("a pit on a wall, a drain below the alarm, and sewage into a drainage sump are caught", () => {
  const c = compile(
    villa({ pits: [{ id: "X1", kind: "drainage", position: [4, 6], depth: 0.7 }] }),
  );
  const w = c.warnings.filter((x) => /pump pit 'X1'/.test(x)).join("\n");
  assert.match(w, /overlaps wall 'w1'/);
  assert.match(w, /drains back up before the alarm sounds/);
  assert.match(w, /sewage needs a sewage pit/);
});
