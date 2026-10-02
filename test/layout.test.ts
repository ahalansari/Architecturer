import assert from "node:assert/strict";
import { test } from "node:test";
import { compile } from "../src/pipeline.js";

/** A clean two-room, two-level house that should produce no layout warnings. */
function base(): any {
  const loop = [[0, 0], [10, 0], [10, 8], [0, 8]];
  return {
    defaults: { exteriorWallThickness: 0.3, wallThickness: 0.12 },
    levels: [
      {
        id: "ground",
        walls: [
          { id: "ext", points: loop, closed: true },
          { id: "mid", points: [[6, 0], [6, 8]] },
        ],
        openings: [
          { id: "front", type: "door", at: [3, 0] },
          { id: "inner", type: "door", at: [6, 2] },
          { id: "win", type: "window", at: [0, 5], width: 1.2 },
        ],
        rooms: [
          { name: "Living", polygon: [[0, 0], [6, 0], [6, 8], [0, 8]] },
          { name: "Hall", polygon: [[6, 0], [10, 0], [10, 8], [6, 8]] },
        ],
        stairs: [{ id: "st", type: "straight", start: [9.35, 1.0], direction: "north", railing: "left" }],
        furniture: [
          { id: "sofa", type: "sofa", position: [3, 6], facing: "south" },
          { id: "table", type: "table", position: [3, 3.5] },
          { id: "chair", type: "chair", position: [3, 2.85], facing: "north" },
        ],
      },
      {
        id: "upper",
        walls: [{ id: "ext2", points: loop, closed: true }],
        rooms: [{ name: "Loft", polygon: loop }],
        railings: [{ points: [[8.85, 1.0], [8.85, 5.48]] }],
        furniture: [{ id: "bed", type: "bed", position: [3, 4.5], facing: "south" }],
      },
    ],
  };
}

const warnings = (p: any) => {
  const c = compile(p);
  assert.deepEqual(c.errors, []);
  return c.warnings;
};
const expectWarning = (p: any, re: RegExp) => {
  const w = warnings(p);
  assert.ok(w.some((x) => re.test(x)), `expected ${re} in:\n${w.join("\n") || "(no warnings)"}`);
};

test("clean plan has no layout warnings", () => {
  assert.deepEqual(warnings(base()), []);
});

test("furniture straddling a wall, with a fix-it suggestion", () => {
  const p = base();
  p.levels[0].furniture.push({ id: "shelf", type: "bookshelf", position: [5.9, 6], facing: "west" });
  expectWarning(p, /'shelf'.*overlaps wall 'mid' by .* move it .* west/);
});

test("furniture outside the building on an upper level", () => {
  const p = base();
  p.levels[1].furniture.push({ id: "wardrobe", type: "wardrobe", position: [12, 3] });
  expectWarning(p, /'wardrobe'.*has no floor under it/);
});

test("furniture overlapping furniture", () => {
  const p = base();
  p.levels[0].furniture.push({ id: "arm", type: "armchair", position: [3.5, 6.1] });
  expectWarning(p, /'sofa'.*and 'arm'.*overlap|'arm'.*and 'sofa'.*overlap/);
});

test("chairs tucked under tables are fine", () => {
  assert.deepEqual(warnings(base()), []);
});

test("furniture in a door swing", () => {
  const p = base();
  // door 'inner' at (6,2) on wall running north, swings toward its left (west) side
  p.levels[0].furniture.push({ id: "plant", type: "side_table", position: [5.6, 2.2] });
  expectWarning(p, /'plant'.*(swing of door 'inner'|blocks door 'inner')/);
});

test("furniture blocking a window", () => {
  const p = base();
  p.levels[0].furniture.push({ id: "books", type: "bookshelf", position: [0.35, 5], facing: "east" });
  expectWarning(p, /'books'.*blocks window 'win'/);
});

test("furniture facing into a wall", () => {
  const p = base();
  p.levels[0].furniture.push({ id: "tvs", type: "tv_stand", position: [3, 7.6], facing: "north" });
  expectWarning(p, /'tvs'.*faces straight into wall 'ext'.*facing: 'south'/);
});

test("room with no door", () => {
  const p = base();
  p.levels[0].openings = p.levels[0].openings.filter((o: any) => o.id !== "inner");
  expectWarning(p, /room 'Hall' has no door|room 'Living' has no door|can't be reached/);
});

test("room unreachable from the entrance", () => {
  const p = base();
  p.levels[0].openings = p.levels[0].openings.filter((o: any) => o.id !== "inner");
  expectWarning(p, /room 'Hall' can't be reached|room 'Hall' has no door/);
  expectWarning(p, /room 'Loft' can't be reached/);
});

test("building with no entrance", () => {
  const p = base();
  p.levels[0].openings = p.levels[0].openings.filter((o: any) => o.id !== "front");
  expectWarning(p, /no entrance/);
});

test("stair on the top level", () => {
  const p = base();
  p.levels[1].stairs = [{ id: "up2", start: [2, 1.0], direction: "north" }];
  expectWarning(p, /'up2' is on the top level and leads nowhere/);
});

test("stair running through a wall", () => {
  const p = base();
  p.levels[0].stairs[0].start = [6.3, 1.0];
  expectWarning(p, /stair 'st' runs through wall 'mid'/);
});

test("stair arriving into a wall", () => {
  const p = base();
  p.levels[1].walls.push({ id: "blocker", points: [[6, 5.95], [10, 5.95]] });
  expectWarning(p, /arrives straight into wall 'blocker'|wall 'blocker' crosses the stairwell/);
});

test("open stair side without railing", () => {
  const p = base();
  p.levels[0].stairs[0].railing = "right"; // right side is against the exterior wall, left is open
  expectWarning(p, /stair 'st': the left side is open but has no railing/);
});

test("door opening onto nothing upstairs", () => {
  const p = base();
  p.levels[1].openings = [{ id: "jump", type: "door", at: [3, 0] }];
  expectWarning(p, /door 'jump' opens onto nothing/);
});

test("terraces: balcony gets railings on free edges only, and makes its door valid", async () => {
  const { terraceGuards } = await import("../src/elements/terraces.js");
  const p = base();
  p.levels[1].terraces = [{ id: "bal", polygon: [[1, -1.5], [5, -1.5], [5, 0], [1, 0]] }];
  p.levels[1].openings = [{ id: "bal_door", type: "door", at: [3, 0], style: "glass" }];
  const c = compile(p);
  assert.deepEqual(c.warnings, []);
  const g = terraceGuards(c.project!.levels[1].terraces[0], c.levels[1].segments, 3, 0);
  assert.equal(g.guard, "railing");
  assert.deepEqual(g.attached, [false, false, true, false]); // edge 2 runs along the exterior wall
  assert.equal(g.lines.length, 1);
  assert.equal(g.lines[0].points.length, 4); // one run around the three free sides
});

test("terraces: ground patio has no railing; openEdges and parapets", async () => {
  const { terraceGuards } = await import("../src/elements/terraces.js");
  const p = base();
  p.levels[0].terraces = [{ id: "patio", polygon: [[2, -3], [5, -3], [5, -0.15], [2, -0.15]] }];
  p.levels[1].terraces = [
    { id: "deck", polygon: [[1, -2], [5, -2], [5, 0], [1, 0]], edge: "parapet", openEdges: [0] },
  ];
  const c = compile(p);
  assert.deepEqual(c.errors, []);
  assert.equal(terraceGuards(c.project!.levels[0].terraces[0], c.levels[0].segments, 0, 0).guard, "none");
  const deck = terraceGuards(c.project!.levels[1].terraces[0], c.levels[1].segments, 3, 0);
  assert.deepEqual(deck.guarded, [false, true, false, true]);
  assert.equal(deck.lines.length, 2);
});

test("terraces: door onto a terrace-less drop still warns", () => {
  const p = base();
  p.levels[1].openings = [{ id: "jump", type: "door", at: [3, 0] }];
  assert.ok(compile(p).warnings.some((w) => /door 'jump' opens onto nothing/.test(w)));
});
