import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { compile } from "../src/pipeline.js";
import { STARTER_PROJECT } from "../src/templates.js";

const house = JSON.parse(readFileSync(new URL("../examples/house.json", import.meta.url), "utf8"));

test("example house compiles without errors or warnings", () => {
  const c = compile(house);
  assert.deepEqual(c.errors, []);
  assert.deepEqual(c.warnings, []);
  assert.ok(c.stats.triangles > 10_000);
});

test("starter template compiles", () => {
  const c = compile(STARTER_PROJECT);
  assert.ok(c.ok, c.errors.join("\n"));
});

test("schema errors carry a readable path", () => {
  const c = compile({ levels: [{ id: "g", walls: [{ points: [[0, 0]] }] }] });
  assert.equal(c.ok, false);
  assert.match(c.errors[0], /levels\[0\]\.walls\[0\]\.points/);
});

test("openings off the wall are reported", () => {
  const c = compile({ levels: [{ id: "g", walls: [{ points: [[0, 0], [5, 0]] }], openings: [{ type: "door", at: [2, 3] }] }] });
  assert.match(c.errors.join("\n"), /m from the nearest wall/);
});

test("unknown materials suggest alternatives", () => {
  const c = compile({ levels: [{ id: "g", walls: [{ points: [[0, 0], [5, 0]], material: "redbrick" }] }] });
  assert.match(c.errors.join("\n"), /brick_red/);
});

test("T-junction walls split and join", () => {
  const c = compile({
    levels: [{ id: "g", walls: [{ id: "a", points: [[0, 0], [10, 0]] }, { id: "b", points: [[5, 0], [5, 4]] }] }],
  });
  assert.ok(c.ok);
  assert.equal(c.levels[0].segments.filter((s) => s.wallId === "a").length, 2);
});

test("stairs cut the slab above", () => {
  const sq = [[0, 0], [8, 0], [8, 8], [0, 8]];
  const c = compile({
    levels: [
      { id: "g", walls: [{ points: sq, closed: true }], stairs: [{ start: [2, 1], direction: "north", railing: "both" }] },
      { id: "u", walls: [{ points: sq, closed: true }] },
    ],
  });
  assert.ok(c.ok, c.errors.join("\n"));
  assert.deepEqual(c.warnings, []);
});

test("game export: merged static mesh, colliders, unity axes", async () => {
  const { toGltfDocument } = await import("../src/export/gltf.js");
  const doc = toGltfDocument(compile(house), { textureSize: 0, merge: true, collision: true, unityAxes: true });
  const names = doc.getRoot().listNodes().map((n) => n.getName());
  assert.ok(names.includes("Ground floor_static"));
  assert.ok(names.includes("Ground floor-colonly"));
  assert.ok(names.includes("sofa_1-convcolonly"));
  assert.ok(!names.includes("rug_0-convcolonly"), "rugs don't block movement");
  const living = doc.getRoot().listNodes().find((n) => n.getName() === "Living_room")!;
  const [x, , z] = living.getTranslation();
  // glTF x = -plan x, z = plan y; Unity's importer flips x back
  assert.ok(Math.abs(x + 3.5) < 1e-6 && Math.abs(z - 2.5) < 1e-6);
  const collider = doc.getRoot().listNodes().find((n) => n.getName() === "Ground floor-colonly")!;
  assert.equal(collider.getMesh()!.listPrimitives()[0].getMaterial(), null);
});
