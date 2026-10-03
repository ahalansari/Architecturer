import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { gridPoints, kelvinToLinearRGB, collectLights, type LightInfo } from "../src/elements/lighting.js";
import { toGltfDocument } from "../src/export/gltf.js";
import type { SceneNode } from "../src/geometry/scene.js";
import type { Vec2 } from "../src/geometry/math.js";
import { compile, texturesFor } from "../src/pipeline.js";
import { renderScene, type MaterialLookup } from "../src/render/raster.js";

/** Two 4 x 4 rooms side by side, a wall between them with a door. */
function twoRooms(level: Record<string, unknown> = {}) {
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
        openings: [
          { id: "door", type: "door", at: [4, 0.8] },
          { id: "win", type: "window", at: [2, 0], width: 1.4 },
        ],
        rooms: [
          { id: "a", name: "Room A", polygon: [[0, 0], [4, 0], [4, 4], [0, 4]] },
          { id: "b", name: "Room B", polygon: [[4, 0], [8, 0], [8, 4], [4, 4]] },
        ],
        ...level,
      },
    ],
  };
}

const findAll = (n: SceneNode, kind: string, out: SceneNode[] = []): SceneNode[] => {
  if (n.kind === kind) out.push(n);
  for (const c of n.children) findAll(c, kind, out);
  return out;
};

test("downlight grid fills a room evenly and skips the notch of an L-shaped room", () => {
  const rect = gridPoints([[0, 0], [4, 0], [4, 3], [0, 3]], 1, 0.5);
  assert.equal(rect.length, 12);
  for (const [x, y] of rect) assert.ok(x >= 0.5 - 1e-9 && x <= 3.5 + 1e-9 && y >= 0.5 - 1e-9 && y <= 2.5 + 1e-9);
  const L: Vec2[] = [[0, 0], [4, 0], [4, 2], [2, 2], [2, 4], [0, 4]];
  const pts = gridPoints(L, 1, 0.5);
  assert.ok(pts.length > 0);
  assert.ok(pts.every(([x, y]) => !(x > 2 && y > 2)), "no lights in the cut-out corner");

  const c = compile(twoRooms({ lights: [{ id: "dl", type: "downlight", room: "Room A", spacing: 1.2, margin: 0.6 }] }));
  assert.deepEqual(c.errors, []);
  const fixtures = findAll(c.root!, "light_fixture");
  assert.equal(fixtures.length, 9); // 3 x 3 in a 4 x 4 room
  // flush with the ceiling: pivot at the ceiling surface
  const ceil = 3 - 0.2 - 0.01;
  for (const f of fixtures) assert.ok(Math.abs(f.translation![2] - ceil) < 1e-6);
});

test("glTF export carries KHR_lights_punctual lights with physical intensities and orientation", () => {
  const c = compile(
    twoRooms({
      lights: [
        { id: "p", type: "pendant", shade: "dome", position: [2, 2], hangHeight: 2.1, lumens: 800 },
        { id: "g", type: "pendant", shade: "globe", position: [6, 2], lumens: 600, kelvin: 3000 },
        { id: "s", type: "wall_sconce", position: [3.9, 2.5] },
      ],
      furniture: [{ type: "floor_lamp", position: [0.5, 3.5] }, { type: "table_lamp", position: [7.5, 3.5], options: { light: false } }],
    }),
  );
  assert.deepEqual(c.errors, []);
  const doc = toGltfDocument(c, { textureSize: 0 });
  const nodes = doc.getRoot().listNodes().filter((n) => n.getExtension("KHR_lights_punctual"));
  // dome pendant (spot) + globe (point) + sconce up & down (2 spots) + floor lamp (point); table lamp opted out
  assert.equal(nodes.length, 5);
  const lights = nodes.map((n) => ({ n, l: n.getExtension<import("@gltf-transform/extensions").Light>("KHR_lights_punctual")! }));
  const byName = (s: string) => lights.find((x) => x.n.getName().startsWith(s))!;
  const dome = byName("p_light");
  assert.equal(dome.l.getType(), "spot");
  const outer = dome.l.getOuterConeAngle();
  assert.ok(Math.abs(dome.l.getIntensity() - 800 / (2 * Math.PI * (1 - Math.cos(outer)))) < 0.05);
  // spot points down: node rotation turns glTF -Z into -Y
  const q = dome.n.getRotation();
  assert.ok(Math.abs(q[0] + Math.SQRT1_2) < 1e-6 && Math.abs(q[3] - Math.SQRT1_2) < 1e-6, `rotation ${q}`);
  const globe = byName("g_light");
  assert.equal(globe.l.getType(), "point");
  assert.ok(Math.abs(globe.l.getIntensity() - 600 / (4 * Math.PI)) < 0.01);
  const [r, g, b] = globe.l.getColor();
  const want = kelvinToLinearRGB(3000);
  assert.ok(Math.abs(r - want[0]) < 1e-3 && Math.abs(g - want[1]) < 1e-3 && Math.abs(b - want[2]) < 1e-3);
  assert.ok(r > g && g > b, "3000 K is warm");
  assert.ok(globe.l.getRange()! > 3, "range covers the room");
  assert.ok(byName("floor_lamp"), "floor lamps get a light automatically");
  // sconce emitters: one up, one down
  const sc = lights.filter((x) => x.n.getName().startsWith("s_light"));
  assert.equal(sc.length, 2);

  // unity axes and game merge keep the lights
  const merged = toGltfDocument(c, { textureSize: 0, merge: true, collision: true, unityAxes: true });
  assert.equal(merged.getRoot().listNodes().filter((n) => n.getExtension("KHR_lights_punctual")).length, 5);
});

test("wall sconces snap onto the wall face and face into the room", () => {
  const c = compile(twoRooms({ lights: [{ id: "s", type: "wall_sconce", position: [4.3, 2.5], style: "glow" }] }));
  const f = findAll(c.root!, "light_fixture")[0];
  // wall 'mid' is 0.2 thick at x=4: the face on room B's side is at x = 4.1
  assert.ok(Math.abs(f.translation![0] - 4.102) < 1e-3, `x ${f.translation![0]}`);
  const L = collectLights(c.root!)[0];
  assert.ok(L.position[0] > 4.15, "the light sits in front of the wall, in room B");
});

test("lighting checks: low pendants, unlit rooms, lights outside rooms, above the ceiling", () => {
  const warn = (lights: unknown[], furniture: unknown[] = []) => compile(twoRooms({ lights, furniture })).warnings.join("\n");
  const low = warn([{ id: "p", type: "pendant", position: [2, 2], hangHeight: 1.6 }, { type: "downlight", room: "b" }]);
  assert.match(low, /light 'p' hangs down to 1.6 m over a walkway/);
  const overTable = warn([{ id: "p", type: "pendant", position: [2, 2], hangHeight: 1.6 }, { type: "downlight", room: "b" }], [{ type: "table", position: [2, 2] }]);
  assert.doesNotMatch(overTable, /hangs down/);
  assert.match(warn([{ type: "pendant", position: [2, 2] }]), /room 'Room B' has no light/);
  assert.doesNotMatch(warn([{ type: "pendant", position: [2, 2] }, { type: "ceiling", room: "Room B" }]), /has no light/);
  assert.match(warn([{ id: "x", type: "pendant", position: [9, 2] }]), /light 'x' at \[9, 2\] is not inside any room/);
  assert.match(warn([{ id: "h", type: "spot", position: [2, 2], height: 3.5 }]), /above the ceiling/);
  // plans without lighting stay quiet
  assert.doesNotMatch(compile(twoRooms()).warnings.join("\n"), /no light/);
  const bad = compile(twoRooms({ lights: [{ type: "downlight", room: "Garage" }] }));
  assert.match(bad.errors.join("\n"), /room 'Garage' not found/);
});

test("window treatments generate geometry on the room side", () => {
  const withTr = (treatment: Record<string, unknown>) => {
    const p = twoRooms();
    (p.levels[0].openings as Record<string, unknown>[])[1].treatment = treatment;
    const c = compile(p);
    assert.deepEqual(c.errors, []);
    const t = findAll(c.root!, "window_treatment")[0];
    assert.ok(t, "treatment node");
    let ys: number[] = [], xs: number[] = [], tris = 0;
    for (const m of t.meshes) {
      tris += m.indices.length / 3;
      for (let i = 0; i < m.positions.length; i += 3) {
        xs.push(m.positions[i]);
        ys.push(m.positions[i + 1]);
      }
    }
    return { t, tris, minY: Math.min(...ys), maxY: Math.max(...ys), w: Math.max(...xs) - Math.min(...xs), mats: t.meshes.map((m) => m.material) };
  };
  for (const type of ["curtains", "sheers", "curtains_and_sheers", "roller_blind", "roman_blind", "venetian", "shutters"]) {
    const r = withTr({ type });
    assert.ok(r.tris > 10, `${type} has geometry`);
    // south wall (y = 0, 0.25 thick), interior is +y: everything hangs inside
    assert.ok(r.minY > 0.05, `${type} is on the interior side (minY ${r.minY})`);
  }
  assert.ok(withTr({ type: "sheers" }).mats.includes("sheer_white"));
  // closed curtains span the window; open ones are stacked to the sides (two narrow panels)
  const closed = withTr({ type: "curtains", open: 0 }), open = withTr({ type: "curtains", open: 1 });
  assert.ok(closed.w >= 1.4 + 0.4, `closed width ${closed.w}`);
  const fabric = (r: ReturnType<typeof withTr>) => r.t.meshes.filter((m) => m.material === "fabric_beige").reduce((a, m) => a + m.positions.length, 0);
  assert.equal(fabric(closed), fabric(open), "same pleat count, stacked");
});

test("night render: lights brighten their room and walls stop light leaking next door", () => {
  const c = compile(
    twoRooms({
      openings: [],
      lights: [{ type: "ceiling", style: "flush", position: [2, 2], lumens: 2000 }],
    }),
  );
  const lookup: MaterialLookup = (name) => {
    const def = c.materials.get(name)!;
    return { def, tex: texturesFor(def, 16) };
  };
  const cam = { eye: [4, 2, 2.0] as [number, number, number], target: [4, 2, 0] as [number, number, number], up: [0, 1, 0] as [number, number, number], ortho: 2.1 };
  // cut below the ceiling to look down into both rooms
  const view = c.levels.map((l) => ({ z0: l.elevation, z1: l.elevation + l.height, walls: l.segments.map((s) => ({ a: s.a, b: s.b, z0: s.z0, z1: s.z1, holes: s.holes })) }));
  const night = renderScene(c.root!, lookup, cam, { width: 200, height: 100, supersample: 1, clipZ: 2.0, lighting: "night", occluders: view, edges: false });
  const day = renderScene(c.root!, lookup, cam, { width: 200, height: 100, supersample: 1, clipZ: 2.0, edges: false });
  const lum = (img: { rgba: Uint8Array; width: number }, x: number, y: number) => {
    const o = (y * img.width + x) * 4;
    return img.rgba[o] + img.rgba[o + 1] + img.rgba[o + 2];
  };
  // plan x 2 (room A) -> pixel 50, x 6 (room B) -> pixel 150; y 2 -> row 50
  const a = lum(night, 50, 60), b = lum(night, 150, 60);
  assert.ok(a > 150, `room A is lit (${a})`);
  assert.ok(b < a / 6, `room B stays dark (${b} vs ${a})`);
  assert.ok(lum(day, 150, 60) > b * 3, "day is brighter than an unlit room at night");
  // light colour: warm
  const o = (60 * 200 + 50) * 4;
  assert.ok(night.rgba[o] >= night.rgba[o + 2], "2700 K reads warm");
});

test("lighting showcase example validates cleanly", () => {
  const p = JSON.parse(readFileSync(new URL("../examples/lighting_showcase.json", import.meta.url), "utf8"));
  const c = compile(p);
  assert.deepEqual(c.errors, []);
  assert.deepEqual(c.warnings, []);
  const lights = collectLights(c.root!);
  assert.ok(lights.length >= 30);
  const types = new Set(findAll(c.root!, "light_fixture").map((f) => f.extras!.fixture));
  for (const t of ["pendant", "chandelier", "ceiling", "downlight", "track", "wall_sconce", "strip", "uplight"]) assert.ok(types.has(t), t);
  assert.ok(lights.every((l: LightInfo) => l.intensity > 0 && l.color.every((v) => v >= 0 && v <= 1)));
});
