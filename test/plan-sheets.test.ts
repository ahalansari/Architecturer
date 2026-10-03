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

/** Three rooms: a tray-ceiling lounge, a lowered bathroom and a beamed kitchen under a 3.0 m level (slab 0.2). */
function ceilings() {
  return {
    site: { ground: false },
    levels: [
      {
        id: "g",
        height: 3,
        walls: [
          { id: "ext", points: [[0, 0], [12, 0], [12, 5], [0, 5]], closed: true },
          { id: "m1", points: [[5, 0], [5, 5]] },
          { id: "m2", points: [[8, 0], [8, 5]] },
        ],
        openings: [
          { id: "d1", type: "door", at: [5, 1] },
          { id: "d2", type: "door", at: [8, 1] },
        ],
        rooms: [
          { id: "lounge", name: "Lounge", polygon: [[0, 0], [5, 0], [5, 5], [0, 5]], finishes: { ceiling: { type: "tray", drop: 0.25, inset: 0.6 }, cornice: {} } },
          { id: "bath", name: "Bath", polygon: [[5, 0], [8, 0], [8, 5], [5, 5]], ceilingHeight: 2.5, floorMaterial: "tiles_white" },
          { id: "kit", name: "Kitchen", polygon: [[8, 0], [12, 0], [12, 5], [8, 5]], finishes: { ceiling: { type: "beams", spacing: 1.2 } } },
        ],
        lights: [{ id: "dl", type: "downlight", room: "Lounge", spacing: 2, margin: 1.5 }],
      },
    ],
  };
}

test("the build records each room's ceiling layout (heights, soffit, cove, beams, void)", () => {
  const c = compile(ceilings());
  assert.ok(c.ok, c.errors.join("\n"));
  const [lounge, bath, kit] = c.levels[0].ceilings;
  assert.equal(lounge.type, "tray");
  assert.equal(lounge.height, 2.8);
  assert.equal(lounge.structure, 2.8);
  assert.ok(Math.abs(lounge.soffit!.height - 2.55) < 1e-6 && lounge.soffit!.width === 0.6);
  assert.ok(lounge.cove && lounge.cove.line.length === 4, "LED cove around the recess");
  assert.ok(lounge.cornice);
  assert.equal(bath.type, "flat");
  assert.equal(bath.height, 2.5);
  assert.equal(kit.type, "beams");
  assert.ok(kit.beams.length >= 2 && kit.beams.every((b) => Math.abs(b.height - 2.6) < 1e-6));
});

test("reflected ceiling and false ceiling sheets", async () => {
  const c = compile(ceilings());
  const rcp = renderPlanSVG(c, "g", { sheet: "rcp" });
  assert.ok(rcp.includes("reflected ceiling plan"));
  assert.ok(rcp.includes("CH 2.80") && rcp.includes("CH 2.50"), "ceiling heights");
  assert.ok(rcp.includes("tray, soffit 2.55 · LED cove"));
  assert.ok(rcp.includes("url(#hatch_soffit)") && rcp.includes(">dl<"), "soffit hatch and fixture ids");
  assert.ok(!rcp.includes("stroke-dasharray=\"3 2\""), "no door swings looking up");
  const fcp = renderPlanSVG(c, "g", { sheet: "false_ceiling" });
  assert.ok(fcp.includes("false ceiling plan"));
  for (const t of ["FCL +2.80", "FCL +2.55", "FCL +2.50", "FCL +2.60"]) assert.ok(fcp.includes(t), t);
  assert.ok(fcp.includes("void 0.30 m"), "bathroom void under the slab");
  assert.ok(fcp.includes(">0.60<"), "soffit width dimension");
  assert.ok(fcp.includes("Typical tray section"));
  for (const svg of [rcp, fcp]) assert.ok((await svgToPng(svg)).length > 1000);
});
