import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { compile } from "../src/pipeline.js";
import { toGltfDocument } from "../src/export/gltf.js";
import { coverRects, roomNavKind } from "../src/export/navmeta.js";
import { navReport, navStudy, navSVG } from "../src/sim/nav.js";
import { walkMeshes } from "../src/geometry/scene.js";

const house = () => JSON.parse(readFileSync(new URL("../examples/house.json", import.meta.url), "utf8"));

/** Two floors 10 × 8 m linked only by a lift in the hall (no stairs). */
function liftOnly(furniture: unknown[] = []) {
  const level = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    height: 3.2,
    walls: [{ id: `ext_${id}`, points: [[0, 0], [10, 0], [10, 8], [0, 8]], closed: true }, { id: `w1_${id}`, points: [[3, 0], [3, 8]] }],
    openings: [{ id: `d_${id}`, type: "door", at: [3, 2] }, ...(id === "g" ? [{ id: "front_door", type: "door", at: [6, 0] }] : [])],
    rooms: [
      { name: id === "g" ? "Guest room" : "Bedroom", polygon: [[0, 0], [3, 0], [3, 8], [0, 8]] },
      { name: id === "g" ? "Hall" : "Landing", polygon: [[3, 0], [10, 0], [10, 8], [3, 8]] },
    ],
    ...extra,
  });
  return {
    name: "Lift only",
    site: { ground: true, margin: 3 },
    levels: [level("g", { furniture }), level("f1")],
    elevators: [{ id: "L1", shaft: { at: [6.5, 6.6], facing: "south" }, capacity: 8, stops: [{ level: "g" }, { level: "f1" }] }],
  };
}

test("house: every room reached on foot (stairs connect), upstairs is stairs-only for a wheelchair, 0.8 m doors flagged", async () => {
  const c = compile(house());
  const s = await navStudy(c);
  assert.equal(s.entrance.door, "front_door");
  const up = s.rooms.filter((r) => r.level === 1);
  assert.ok(s.rooms.every((r) => r.person.reached), s.rooms.filter((r) => !r.person.reached).map((r) => `${r.name}: ${r.person.why}`).join("; "));
  // the stairs are walked: upstairs is further than downstairs
  const hall = s.rooms.find((r) => r.name === "Hall")!;
  assert.ok(up.every((r) => r.person.distance! > hall.person.distance! + 5));
  assert.ok(up.every((r) => !r.wheelchair.reached && /stairs/.test(r.wheelchair.why!)), JSON.stringify(up.map((r) => r.wheelchair)));
  const bath = s.rooms.find((r) => r.level === 0 && r.name === "Bathroom")!;
  assert.match(bath.wheelchair.why!, /door 'door_bath' is 0.8 m/);
  assert.ok(s.narrowDoors.some((d) => d.id === "door_bath"));
  assert.ok(s.rooms.find((r) => r.name === "Living room")!.wheelchair.reached, "a 0.9 m door lets a wheelchair through");
  const text = navReport(s, c.levels.map((l) => l.name));
  assert.match(text, /Recast navmesh/);
  assert.match(navSVG(c, s), /Upper floor/);
});

test("a lift links floors for both agents; furniture across a door is named as the blocker", async () => {
  let s = await navStudy(compile(liftOnly()));
  const bed = s.rooms.find((r) => r.name === "Bedroom")!;
  assert.ok(bed.person.reached && bed.wheelchair.reached, JSON.stringify(bed));
  // a wardrobe in front of the guest room door
  s = await navStudy(compile(liftOnly([{ id: "blocker", type: "wardrobe", position: [3.6, 2], rotation: 90 }])));
  const guest = s.rooms.find((r) => r.name === "Guest room")!;
  assert.ok(!guest.person.reached);
  assert.match(guest.person.why!, /furniture in the way, first blocker \(wardrobe\)/);
});

test("Unity export: NavMesh area markers, lift landings, closed-door markers and lightmap UVs", () => {
  const c = compile(liftOnly());
  const doc = toGltfDocument(c, { textureSize: 0, merge: true, collision: true, unityAxes: true, lightmapUV: true, navigation: true });
  const names = doc.getRoot().listNodes().map((n) => n.getName());
  const areas = names.filter((n) => n.startsWith("nav-area|"));
  assert.ok(areas.some((n) => /^nav-area\|indoor\|3\.000\|8\.000\|3\.200\|Guest room$/.test(n)), areas.join("\n"));
  assert.deepEqual(names.filter((n) => n.startsWith("nav-lift|")).sort(), ["nav-lift|L1|0", "nav-lift|L1|1"]);
  assert.ok(names.filter((n) => n.startsWith("nav-doorway|")).length >= 3);
  for (const n of doc.getRoot().listNodes().filter((n) => n.getName().endsWith("_static"))) {
    for (const p of n.getMesh()!.listPrimitives()) {
      const uv = p.getAttribute("TEXCOORD_1");
      assert.ok(uv, `${n.getName()} has lightmap UVs`);
      const a = uv!.getArray()!;
      assert.ok(Math.min(...a) >= 0 && Math.max(...a) <= 1);
    }
  }
  // generic exports stay as they were
  const plain = toGltfDocument(c, { textureSize: 0 });
  assert.ok(!plain.getRoot().listNodes().some((n) => n.getName().startsWith("nav-")));
});

test("room kinds and rectangle cover", () => {
  assert.equal(roomNavKind("Master Bath"), "wet");
  assert.equal(roomNavKind("Laundry"), "wet");
  assert.equal(roomNavKind("Plant Room"), "service");
  assert.equal(roomNavKind("Roof Terrace"), "outdoor");
  assert.equal(roomNavKind("Family Great Room"), "indoor");
  // an L: two rectangles, exact
  const L = coverRects([[0, 0], [4, 0], [4, 2], [2, 2], [2, 5], [0, 5]]);
  assert.equal(L.reduce((a, r) => a + (r[2] - r[0]) * (r[3] - r[1]), 0), 4 * 2 + 2 * 3);
  assert.equal(L.length, 2);
});

test("site ground sits at street level when a basement comes first, with the sunken court cut out", () => {
  const plan = {
    name: "Basement first",
    site: { ground: true, margin: 2 },
    levels: [
      { id: "b", elevation: -3.5, height: 3.5, walls: [{ id: "eb", points: [[0, 0], [8, 0], [8, 6], [0, 6]], closed: true }], rooms: [{ name: "Gym", polygon: [[0, 0], [8, 0], [8, 6], [0, 6]] }], terraces: [{ id: "court", name: "Sunken court", polygon: [[8.2, 0], [10, 0], [10, 6], [8.2, 6]] }] },
      { id: "g", elevation: 0, height: 3, walls: [{ id: "eg", points: [[0, 0], [8, 0], [8, 6], [0, 6]], closed: true }], rooms: [{ name: "Living", polygon: [[0, 0], [8, 0], [8, 6], [0, 6]] }] },
    ],
  };
  const c = compile(plan);
  let groundZ: number | undefined, area = 0, box = 0;
  walkMeshes(c.root!, (m, n) => {
    if (n.kind !== "site") return;
    groundZ = m.positions[2];
    const xs = m.positions.filter((_, i) => i % 3 === 0), ys = m.positions.filter((_, i) => i % 3 === 1);
    box = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
    for (let i = 0; i < m.indices.length; i += 3) {
      const [a, b, d] = [m.indices[i], m.indices[i + 1], m.indices[i + 2]].map((k) => [m.positions[k * 3], m.positions[k * 3 + 1]]);
      area += Math.abs((b[0] - a[0]) * (d[1] - a[1]) - (d[0] - a[0]) * (b[1] - a[1])) / 2;
    }
  });
  assert.ok(groundZ !== undefined && Math.abs(groundZ + 0.05) < 1e-6, String(groundZ));
  // the court's 1.8 × 6 m is a hole in the ground
  assert.ok(Math.abs(box - area - 1.8 * 6) < 0.01, `${box} - ${area}`);
  // and the court has no railing (its floor is the basement's)
  assert.ok(!c.warnings.some((w) => /court/.test(w) && /railing/.test(w)));
});
