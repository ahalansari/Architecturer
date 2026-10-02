import assert from "node:assert/strict";
import { test } from "node:test";
import { radiusAt } from "../src/elements/shapes.js";
import { walkMeshes } from "../src/geometry/scene.js";
import { compile } from "../src/pipeline.js";

const tower = (extra: object = {}) => ({
  site: { ground: false },
  levels: [
    {
      id: "g",
      shapes: [
        { type: "revolve", id: "shaft", position: [0, 0], material: "plaster_white", profile: [[0, 0], [3, 0], [1.5, 10], [0, 20]] },
        {
          type: "sphere",
          id: "ball",
          center: [0, 0, 12],
          radius: 4,
          material: "enamel_discs",
          hollow: { thickness: 0.2, innerMaterial: "paint_gray" },
          bands: [
            { from: 11, to: 13, material: "glass", frame: { columns: 12 } },
            { from: 14, to: 14.5, material: "none" },
          ],
        },
      ],
      ...extra,
    },
  ],
});

const materialsOf = (c: ReturnType<typeof compile>, id: string) => {
  const mats = new Set<string>();
  walkMeshes(c.root!, (m, n) => n.name === id && mats.add(m.material));
  return mats;
};

test("revolve and sphere shapes build with bands, hollow shell and frame", () => {
  const c = compile(tower());
  assert.deepEqual(c.errors, []);
  const ball = materialsOf(c, "ball");
  for (const m of ["enamel_discs", "glass", "paint_gray", "metal_black"]) assert.ok(ball.has(m), `ball uses ${m}`);
  assert.ok(materialsOf(c, "shaft").has("plaster_white"));
});

test("radiusAt interpolates the profile", () => {
  assert.equal(radiusAt([[3, 0], [1, 10]], 5), 2);
  assert.equal(radiusAt([[3, 0], [1, 10]], 11), null);
});

test("elevators connect floors that have no stairs", () => {
  const room = (z: number) => ({ name: `Deck ${z}`, polygon: [[-5, -5], [5, -5], [5, 5], [-5, 5]], ceilingMaterial: false });
  const plan: any = {
    site: { ground: false },
    levels: [
      {
        id: "g",
        walls: [{ id: "lobby", points: [[-6, -6], [6, -6], [6, 6], [-6, 6]], closed: true }],
        openings: [{ id: "door", type: "door", at: [0, -6] }],
        rooms: [{ name: "Lobby", polygon: [[-6, -6], [6, -6], [6, 6], [-6, 6]] }],
        terraces: [{ id: "plaza", polygon: [[-20, -20], [20, -20], [20, -6.15], [-20, -6.15]] }],
      },
      { id: "deck", elevation: 50, autoSlab: false, slabs: [{ polygon: [[-5, -5], [5, -5], [5, 5], [-5, 5]] }], rooms: [room(50)] },
    ],
    elevators: [{ id: "lift", stops: [{ level: "g", at: [0, 2] }, { level: "deck", at: [0, 2] }] }],
  };
  assert.deepEqual(compile(plan).warnings, []);
  plan.elevators = [];
  const w = compile(plan).warnings.join("\n");
  assert.match(w, /room 'Deck 50' has no door|can't be reached/);
});

test("kuwait towers example validates clean", async () => {
  const { readFileSync } = await import("node:fs");
  const c = compile(JSON.parse(readFileSync(new URL("../examples/kuwait_towers.json", import.meta.url), "utf8")));
  assert.deepEqual(c.errors, []);
  assert.deepEqual(c.warnings, []);
});
