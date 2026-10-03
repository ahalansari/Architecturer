import assert from "node:assert/strict";
import { test } from "node:test";
import { compile } from "../src/pipeline.js";
import { renderPlanSVG, svgToPng } from "../src/render/plan.js";
import { levelFixtures, roomFinishBands, roomLux } from "../src/render/plan-sheets.js";
import type { Vec2 } from "../src/geometry/math.js";

/** Two 4 x 4 rooms, a wall between them with a door; lights and finishes in room A. */
function plan() {
  return {
    site: { ground: false },
    levels: [
      {
        id: "g",
        height: 3,
        walls: [
          { id: "ext", points: [[0, 0], [8, 0], [8, 4], [0, 4]], closed: true },
          { id: "mid", points: [[4, 0], [4, 4]] },
        ],
        openings: [{ id: "door", type: "door", at: [4, 0.8] }],
        rooms: [
          {
            id: "a",
            name: "Room A",
            polygon: [[0, 0], [4, 0], [4, 4], [0, 4]],
            floorMaterial: "wood_herringbone_oak",
            finishes: { walls: "paint_green", accents: [{ side: "north", material: "wallpaper_botanical" }], wainscot: { height: 1, material: "tiles_white" } },
          },
          { id: "b", name: "Room B", polygon: [[4, 0], [8, 0], [8, 4], [4, 4]], floorMaterial: "tiles_hex_white" },
        ],
        lights: [
          { id: "dl", type: "downlight", room: "Room A", spacing: 2, margin: 1 },
          { id: "sc", type: "wall_sconce", position: [7.9, 2] },
          { id: "led", type: "strip", points: [[4.5, 3.7], [7.5, 3.7]] },
        ],
      },
    ],
  };
}

test("fixtures are read back from the built scene (grids expanded, sconces on the wall, strip paths)", () => {
  const c = compile(plan());
  assert.ok(c.ok, c.errors.join("\n"));
  const lv = c.project!.levels[0];
  const fx = levelFixtures(c, lv);
  assert.equal(fx.filter((f) => f.type === "downlight").length, 4);
  const sc = fx.find((f) => f.type === "wall_sconce")!;
  assert.ok(Math.abs(sc.at[0] - 7.9) < 0.05, `sconce snapped to the inner face of the east wall, got ${sc.at}`);
  const strip = fx.find((f) => f.type === "strip")!;
  assert.deepEqual(strip.points, [[4.5, 3.7], [7.5, 3.7]]);
  const a = roomLux(lv.rooms[0].polygon as Vec2[], fx);
  assert.equal(a.lumens, 4 * 550);
  assert.ok(Math.abs(a.lux - (2200 * 0.5) / 16) < 1e-6);
});

test("finish bands follow the inside wall faces, skip doors, and pick up accents", () => {
  const c = compile(plan());
  const lv = c.project!.levels[0];
  const bands = roomFinishBands(lv.rooms[0], c.levels[0], "plaster_white", 0.08);
  assert.ok(bands.length >= 4);
  const north = bands.filter((b) => b.accent);
  assert.ok(north.length && north.every((b) => b.material === "wallpaper_botanical" && b.inward[1] < -0.9), "north accent band faces south into the room");
  assert.ok(bands.filter((b) => !b.accent).every((b) => b.material === "paint_green" && b.wainscot === "tiles_white"));
  // the east edge (shared wall with the door at y 0.8) is split around the door
  const east = bands.filter((b) => b.inward[0] < -0.9);
  assert.equal(east.length, 2);
  assert.ok(east.every((b) => Math.min(b.a[1], b.b[1]) > 1.2 || Math.max(b.a[1], b.b[1]) < 0.4));
  // room B has no finishes: its bands use the wall's own interior material
  assert.ok(roomFinishBands(lv.rooms[1], c.levels[0], "plaster_white", 0.08).every((b) => !b.accent));
});

test("lighting and finishes sheets render with legends", async () => {
  const c = compile(plan());
  const light = renderPlanSVG(c, "g", { sheet: "lighting" });
  assert.ok(light.includes("lighting plan"));
  assert.ok(light.includes(">dl<") && light.includes(">led<"), "fixture ids");
  assert.ok(light.includes("≈ 69 lx · 2,200 lm"), "room A illuminance");
  assert.ok(light.includes("downlight × 4"), "legend");
  const fin = renderPlanSVG(c, "g", { sheet: "finishes" });
  assert.ok(fin.includes('<pattern id="floor_0"') && fin.includes('fill="url(#floor_1)"'), "floor patterns");
  assert.ok(fin.includes("floor: wood herringbone oak") && fin.includes("accent north: wallpaper botanical"));
  assert.ok(fin.includes(">Walls<") && fin.includes("wainscot"));
  const plain = renderPlanSVG(c, "g");
  assert.ok(!plain.includes(">Fixtures<") && plain.includes(">door<"));
  for (const svg of [light, fin]) assert.ok((await svgToPng(svg)).length > 1000);
});
