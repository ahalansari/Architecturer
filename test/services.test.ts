import assert from "node:assert/strict";
import { test } from "node:test";
import type { SceneNode } from "../src/geometry/scene.js";
import { pointInPolygon, type Vec2 } from "../src/geometry/math.js";
import { compile } from "../src/pipeline.js";
import { renderPlanSVG, svgToPng } from "../src/render/plan.js";

/** Hall (front door) → bedroom (door, double bed + nightstands, desk) and a bathroom (WC, basin, shower). */
function flat(level: Record<string, unknown> = {}) {
  return {
    site: { ground: false },
    levels: [
      {
        id: "g",
        height: 3,
        walls: [
          { id: "ext", points: [[0, 0], [10, 0], [10, 6], [0, 6]], closed: true },
          { id: "w1", points: [[3, 0], [3, 6]] },
          { id: "w2", points: [[3, 3.5], [10, 3.5]] },
        ],
        openings: [
          { id: "front", type: "door", at: [1.5, 0] },
          { id: "d_bed", type: "door", at: [3, 1.5], hinge: "right" },
          { id: "d_bath", type: "door", at: [3, 4.8] },
          { id: "win", type: "window", at: [6.5, 0], width: 1.6 },
        ],
        rooms: [
          { id: "hall", name: "Entry hall", polygon: [[0, 0], [3, 0], [3, 6], [0, 6]] },
          { id: "bed", name: "Bedroom", polygon: [[3, 0], [10, 0], [10, 3.5], [3, 3.5]] },
          { id: "bath", name: "Bathroom", polygon: [[3, 3.5], [10, 3.5], [10, 6], [3, 6]] },
        ],
        furniture: [
          { id: "bed1", type: "bed", position: [8.95, 1.75], width: 1.8, depth: 2.1, facing: "west" },
          { id: "ns1", type: "nightstand", position: [9.7, 3.0], facing: "west" },
          { id: "ns2", type: "nightstand", position: [9.7, 0.5], facing: "west" },
          { id: "desk1", type: "desk", position: [5, 3.1], facing: "south" },
          { id: "wc1", type: "toilet", position: [9.6, 5.0], facing: "west" },
          { id: "basin1", type: "bathroom_sink", position: [6.5, 5.75], facing: "south" },
          { id: "sh1", type: "shower", position: [4.0, 5.2], facing: "east" },
        ],
        lights: [
          { id: "bed_dl", type: "downlight", room: "Bedroom", spacing: 1.8, margin: 0.9 },
          { id: "bath_dl", type: "downlight", room: "Bathroom", spacing: 2, margin: 1 },
        ],
        ...level,
      },
    ],
  };
}

const findAll = (n: SceneNode, name: string, out: SceneNode[] = []): SceneNode[] => {
  if (n.name === name) out.push(n);
  for (const c of n.children) findAll(c, name, out);
  return out;
};

test("electrical layout: switches at doors, bedside sockets and 2-way switches, desk, DB, detectors, light points", () => {
  const c = compile(flat());
  assert.ok(c.ok, c.errors.join("\n"));
  assert.deepEqual(c.warnings.filter((w) => w.includes("services")), []);
  const E = c.levels[0].services.electrical;
  const by = (id: string) => E.find((e) => e.id === id)!;
  // bedroom switch beside its door, inside the bedroom, at 1.2 m, controlling the downlights
  const sw = by("sw.bed.1");
  assert.equal(sw.type, "switch");
  assert.ok(sw.at[0] > 3 && Math.abs(sw.at[0] - 3.1) < 0.02 && sw.height === 1.2, `switch on the bedroom face of w1: ${sw.at}`);
  assert.deepEqual(sw.controls, ["bed_dl"]);
  // hall has no designed lights: a lighting point, switched at the front door
  assert.ok(E.some((e) => e.type === "light_point" && e.room === 0));
  assert.ok(by("sw.hall.1").controls[0].startsWith("lp.hall"));
  // double bed with nightstands: sockets over both nightstands + 2-way switches
  const bedside = E.filter((e) => e.label === "bedside");
  assert.equal(bedside.length, 2);
  assert.ok(bedside.every((e) => e.height === 0.7 && Math.abs(e.at[0] - 9.9) < 0.02));
  assert.equal(E.filter((e) => e.type === "switch_2way" && e.room === 1).length, 2);
  // desk socket + data at 0.95, DB beside the front door, doorbell outside, smoke detectors in hall + bedroom
  assert.ok(E.some((e) => e.type === "data" && e.height === 0.95));
  const db = E.find((e) => e.type === "db")!;
  assert.ok(db && db.room === 0 && Math.abs(db.at[1] - 0.1) < 0.02);
  assert.ok(E.find((e) => e.type === "doorbell")!.at[1] < 0);
  assert.equal(E.filter((e) => e.type === "smoke").length, 2);
  // bathroom: extract fan + shaver, no general sockets
  assert.ok(E.some((e) => e.type === "fan" && e.room === 2) && E.some((e) => e.type === "shaver" && e.room === 2));
  assert.ok(!E.some((e) => e.type === "double_socket" && e.room === 2));
  // circuits: every point except data / tv / db / light points on a circuit
  assert.ok(E.filter((e) => !["data", "tv", "db", "light_point"].includes(e.type)).every((e) => e.circuit), "circuit assigned");
});

test("plumbing layout: fixtures, stack in the corner nearest the WC, floor drain, heater, inlet and pipe runs", () => {
  const c = compile(flat());
  const S = c.levels[0].services;
  const kinds = S.fixtures.map((f) => f.kind).sort();
  assert.deepEqual(kinds, ["basin", "floor_drain", "shower", "wc"]);
  const stack = S.points.find((p) => p.type === "stack")!;
  assert.equal(stack.size, 100);
  assert.ok(stack.at[0] > 9.5 && stack.at[1] > 5.5, `SVP near the WC corner: ${stack.at}`);
  assert.ok(S.points.some((p) => p.type === "water_heater" && p.room === 2));
  assert.ok(S.points.some((p) => p.type === "inlet"));
  const bathPoly = [[3, 3.5], [10, 3.5], [10, 6], [3, 6]] as Vec2[];
  const soil = S.pipes.filter((p) => p.kind === "soil");
  assert.equal(soil.length, 1);
  assert.ok(soil[0].pts.every((p) => pointInPolygon(p, bathPoly)), "soil run stays in the bathroom");
  assert.equal(S.pipes.filter((p) => p.kind === "hot").length, 2, "hot to basin + shower");
});

test("explicit points, omit and plates", () => {
  const c = compile(
    flat({
      electrical: [
        { id: "ac1", type: "ac", position: [6.5, 3.4] },
        { id: "sw_x", type: "dimmer", position: [3.05, 2.6], controls: ["bed_dl"] },
      ],
      plumbing: [{ id: "my_stack", type: "stack", position: [3.2, 3.7] }],
      services: { omit: ["sd.bed.1", "fan.bath.1"] },
    }),
  );
  assert.ok(c.ok, c.errors.join("\n"));
  const S = c.levels[0].services;
  const ac = S.electrical.find((e) => e.id === "ac1")!;
  assert.ok(ac.height === 2.3 && Math.abs(ac.at[1] - 3.4) < 0.02, `AC snapped to the bedroom face: ${ac.at}`);
  assert.equal(S.electrical.find((e) => e.id === "sw_x")!.gangs, 1);
  assert.ok(!S.electrical.some((e) => e.id === "sd.bed.1" || e.id === "fan.bath.1"), "omitted");
  assert.ok(!S.points.some((p) => p.type === "stack" && p.auto), "explicit stack replaces the auto one");
  assert.ok(findAll(c.root!, "services").length === 1, "plates node");
  const off = compile(flat({ services: { plates: false, auto: false } }));
  assert.equal(findAll(off.root!, "services").length, 0);
  assert.equal(off.levels[0].services.electrical.length, 0);
});

test("electrical and plumbing sheets", async () => {
  const c = compile(flat());
  const el = renderPlanSVG(c, "g", { sheet: "electrical" });
  assert.ok(el.includes("electrical layout") && el.includes(">Circuits<") && el.includes("2-way switch"));
  assert.ok(el.includes(">sw1<") || el.includes(">sk1<"), "short ids");
  const pl = renderPlanSVG(c, "g", { sheet: "plumbing" });
  assert.ok(pl.includes("plumbing layout") && pl.includes("Fixture schedule") && pl.includes("SVP Ø100") && pl.includes("WC Ø100"));
  for (const svg of [el, pl]) assert.ok((await svgToPng(svg)).length > 1000);
});
