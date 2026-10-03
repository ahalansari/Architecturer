import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { MeshData } from "../src/geometry/mesh.js";
import { walkMeshes, type SceneNode } from "../src/geometry/scene.js";
import { MATERIAL_LIBRARY } from "../src/materials/library.js";
import { generateTextures } from "../src/materials/textures.js";
import { compile } from "../src/pipeline.js";

const showcase = JSON.parse(readFileSync(new URL("../examples/finishes_showcase.json", import.meta.url), "utf8"));

/** Two 4 × 4 rooms split by wall "mid" (x = 4), door in it, window in A's south wall. */
function twoRooms(finA: Record<string, unknown>, finB?: Record<string, unknown>) {
  return {
    site: { ground: false },
    levels: [
      {
        id: "g",
        height: 3,
        walls: [
          { id: "ext", points: [[0, 0], [8, 0], [8, 4], [0, 4]], closed: true, thickness: 0.3 },
          { id: "mid", points: [[4, 0], [4, 4]], thickness: 0.12 },
        ],
        openings: [
          { id: "door", type: "door", at: [4, 2] },
          { id: "win", type: "window", at: [2, 0], sill: 0.6 },
        ],
        rooms: [
          { name: "A", polygon: [[0, 0], [4, 0], [4, 4], [0, 4]], finishes: finA },
          { name: "B", polygon: [[4, 0], [8, 0], [8, 4], [4, 4]], ...(finB ? { finishes: finB } : {}) },
        ],
      },
    ],
  };
}

function find(root: SceneNode, pred: (n: SceneNode) => boolean): SceneNode | undefined {
  if (pred(root)) return root;
  for (const c of root.children) {
    const r = find(c, pred);
    if (r) return r;
  }
}

function meshesOf(node: SceneNode, material: string): MeshData[] {
  const out: MeshData[] = [];
  walkMeshes(node, (m) => m.material === material && out.push(m));
  return out;
}

function zRange(ms: MeshData[]): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (const m of ms) for (let i = 2; i < m.positions.length; i += 3) (lo = Math.min(lo, m.positions[i])), (hi = Math.max(hi, m.positions[i]));
  return [lo, hi];
}

test("finishes showcase compiles without errors or warnings", () => {
  const c = compile(showcase);
  assert.deepEqual(c.errors, []);
  assert.deepEqual(c.warnings, []);
});

test("room wall finish paints only that room's side of a shared wall", () => {
  const c = compile(twoRooms({ walls: "tiles_white" }));
  assert.ok(c.ok, c.errors.join("\n"));
  const mid = find(c.root!, (n) => n.kind === "wall" && n.name === "mid")!;
  const tiles = meshesOf(mid, "tiles_white");
  assert.ok(tiles.length, "mid wall has tiled faces");
  // every tiled face normal points west (into room A); B keeps the default paint
  for (const m of tiles)
    for (let i = 0; i < m.normals.length; i += 3) if (Math.abs(m.normals[i]) > 0.9) assert.ok(m.normals[i] < 0, "tile face points into room A");
  assert.ok(meshesOf(mid, "plaster_white").length, "room B side keeps the wall material");
  // window reveals in room A's exterior wall are tiled too
  const ext = find(c.root!, (n) => n.kind === "wall" && n.name === "ext")!;
  const revealTiles = meshesOf(ext, "tiles_white").some((m) => {
    for (let i = 0; i < m.normals.length; i += 3) if (Math.abs(m.normals[i + 2]) > 0.9) return true; // sill / head
    return false;
  });
  assert.ok(revealTiles, "window sill/head reveal tiled");
});

test("wainscot band height, accents and frieze split wall faces by height", () => {
  const c = compile(twoRooms({ walls: "paint_white", wainscot: { height: 1.2, material: "tiles_subway" }, accents: [{ wall: "mid", material: "wallpaper_damask_gold" }] }));
  assert.ok(c.ok, c.errors.join("\n"));
  const walls = find(c.root!, (n) => n.name === "walls")!;
  const [, top] = zRange(meshesOf(walls, "tiles_subway"));
  assert.ok(Math.abs(top - (0.01 + 1.2)) < 1e-6, `wainscot top ${top}`);
  const mid = find(c.root!, (n) => n.kind === "wall" && n.name === "mid")!;
  const [lo] = zRange(meshesOf(mid, "wallpaper_damask_gold"));
  assert.ok(Math.abs(lo - 1.21) < 1e-6, "accent sits above the wainscot");
  const ext = find(c.root!, (n) => n.kind === "wall" && n.name === "ext")!;
  assert.equal(meshesOf(ext, "wallpaper_damask_gold").length, 0, "accent only on the chosen wall");
});

test("skirting follows the walls, stops at the door and sits on the floor finish", () => {
  const c = compile(twoRooms({ skirting: { material: "wood_oak", height: 0.12 } }));
  assert.ok(c.ok, c.errors.join("\n"));
  const room = find(c.root!, (n) => n.kind === "room" && n.extras?.room === "A")!;
  const sk = meshesOf(room, "wood_oak");
  const [lo, hi] = zRange(sk);
  assert.ok(lo < 0.01 && lo > 0.005 && Math.abs(hi - 0.13) < 0.005, `skirting z ${lo}..${hi}`);
  // nothing in the doorway (door 0.9 wide centred at y = 2 on x = 4)
  for (const m of sk)
    for (let i = 0; i < m.positions.length; i += 3) {
      const x = m.positions[i], y = m.positions[i + 1];
      assert.ok(!(x > 3.8 && Math.abs(y - 2) < 0.44), `skirting vertex in the doorway at ${x.toFixed(3)}, ${y.toFixed(3)}`);
    }
  // runs along all four inner faces: inner face of ext at x = 0.15 and mid at x = 3.94
  const xs = sk.flatMap((m) => m.positions.filter((_, i) => i % 3 === 0));
  assert.ok(Math.min(...xs) < 0.16 && Math.max(...xs) > 3.93);
});

test("feature ceilings: tray with cove light, coffered beams, floor border, thresholds", () => {
  const c = compile(
    twoRooms(
      { ceiling: { type: "tray" }, cornice: {}, floorBorder: { material: "marble_black", width: 0.2 }, threshold: "marble_white" },
      { ceiling: { type: "coffered", beamMaterial: "wood_walnut" }, threshold: "marble_white" },
    ),
  );
  assert.ok(c.ok, c.errors.join("\n"));
  assert.deepEqual(c.warnings.filter((w) => !/no entrance/.test(w)), []);
  const A = find(c.root!, (n) => n.kind === "room" && n.extras?.room === "A")!;
  const B = find(c.root!, (n) => n.kind === "room" && n.extras?.room === "B")!;
  assert.ok(meshesOf(A, "emissive_light").length, "tray cove LED");
  assert.ok(meshesOf(A, "marble_black").length, "floor border");
  assert.ok(meshesOf(B, "wood_walnut")[0].indices.length > 100, "coffer beams");
  // one threshold for the shared door, built by the first room only
  assert.ok(meshesOf(A, "marble_white").length && !meshesOf(B, "marble_white").length);
});

test("finish hints: unknown accent wall, over-tall wainscot, tray that does not fit", () => {
  const c = compile(
    twoRooms({ accents: [{ wall: "nope", material: "paint_blue" }], wainscot: { height: 3, material: "tiles_white" }, ceiling: { type: "tray", inset: 3 } }),
  );
  const w = c.warnings.join("\n");
  assert.match(w, /accent wall 'nope' does not bound this room/);
  assert.match(w, /wainscot height 3 m reaches the ceiling/);
  assert.match(w, /tray ceiling inset 3 m is too wide/);
});

test("finish textures tile seamlessly", () => {
  const S = 64;
  const patterns = new Set(["herringbone", "chevron", "parquet", "terrazzo", "hex_tiles", "mosaic", "zellige", "wallpaper", "fluted", "microcement", "grasscloth"]);
  const names = Object.keys(MATERIAL_LIBRARY).filter((n) => patterns.has(MATERIAL_LIBRARY[n].pattern));
  assert.ok(names.length >= 30);
  for (const name of names) {
    const t = generateTextures(MATERIAL_LIBRARY[name], S);
    const px = (x: number, y: number) => {
      const k = (y * S + x) * 4;
      return t.baseColor[k] + t.baseColor[k + 1] + t.baseColor[k + 2];
    };
    // the wrap-around seam must look like any other neighbouring column / row pair (no harsher than the worst)
    const colDiff = (x: number) => { let d = 0; for (let i = 0; i < S; i++) d += Math.abs(px(x, i) - px((x + 1) % S, i)); return d; };
    const rowDiff = (y: number) => { let d = 0; for (let i = 0; i < S; i++) d += Math.abs(px(i, y) - px(i, (y + 1) % S)); return d; };
    const cols = Array.from({ length: S - 1 }, (_, x) => colDiff(x)), rows = Array.from({ length: S - 1 }, (_, y) => rowDiff(y));
    assert.ok(colDiff(S - 1) <= Math.max(...cols) * 1.1 + 2 * S, `${name}: u seam ${colDiff(S - 1)} vs worst ${Math.max(...cols)}`);
    assert.ok(rowDiff(S - 1) <= Math.max(...rows) * 1.1 + 2 * S, `${name}: v seam ${rowDiff(S - 1)} vs worst ${Math.max(...rows)}`);
  }
});
