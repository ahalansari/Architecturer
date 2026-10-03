import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { compile } from "../src/pipeline.js";
import { interiorCamera } from "../src/render/interior.js";
import { renderViewPNG } from "../src/render/view.js";

const house = compile(JSON.parse(readFileSync(new URL("../examples/house.json", import.meta.url), "utf8")));

test("room view: eye-level camera inside the room, clear of furniture", () => {
  const shot = interiorCamera(house, { room: "Kitchen" }, 1.5);
  const [x, y, z] = shot.camera.eye;
  assert.ok(x > 6.5 && x < 12 && y > 5 && y < 10, `eye ${shot.camera.eye} inside the kitchen`);
  assert.ok(Math.abs(z - 1.51) < 0.05, "eye height ~1.5 m above the floor");
  assert.equal(shot.camera.ortho, undefined);
});

test("wall elevation: orthographic, inside the requested room, clipped to the wall top", () => {
  const shot = interiorCamera(house, { elevation: "ext", elevationRoom: "Kitchen" }, 2);
  assert.ok(shot.camera.ortho && shot.camera.ortho > 1.4);
  const [ex, ey] = shot.camera.eye, [tx, ty] = shot.camera.target;
  assert.ok(ey < ty, "looks north at the kitchen's north wall from inside");
  assert.ok(ex > 6.5 && ex < 12 && tx > 6.5 && tx < 12, "centred on the kitchen stretch of the wall");
  assert.equal(shot.level, 0);
  assert.ok(shot.clipZ && shot.clipZ > 2.9 && shot.clipZ < 3.2);
});

test("interior views render, and unknown rooms/walls give helpful errors", () => {
  const png = renderViewPNG(house, { interior: { room: "Living room" }, width: 240, height: 160 });
  assert.ok(png.length > 5000);
  assert.throws(() => interiorCamera(house, { room: "Ballroom" }, 1), /room 'Ballroom' not found \(rooms: .*Kitchen/);
  assert.throws(() => interiorCamera(house, { elevation: "nope" }, 1), /wall 'nope' not found/);
});
