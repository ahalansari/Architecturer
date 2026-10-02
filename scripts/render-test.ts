/**
 * Visual smoke test for src/render/raster.ts.
 *   npx tsx scripts/render-test.ts          -> out/render-*.png
 *   npx tsx scripts/render-test.ts --perf   -> also a ~200k triangle timing run
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { MeshBuilder } from "../src/geometry/mesh.js";
import { sceneBounds, type SceneNode } from "../src/geometry/scene.js";
import type { MaterialDef, TextureSet, TexturePattern } from "../src/materials/types.js";
import { encodePNG, presetCamera, renderPreset, renderScene, type MaterialLookup, type ViewPreset } from "../src/render/raster.js";

// ---------------------------------------------------------------- fake textures

function makeTex(size: number, paint: (x: number, y: number) => [number, number, number]): TextureSet {
  const baseColor = new Uint8Array(size * size * 4);
  const normal = new Uint8Array(size * size * 4);
  const orm = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      const [r, g, b] = paint(x, y);
      baseColor.set([r, g, b, 255], o);
      normal.set([128, 128, 255, 255], o);
      orm.set([255, 200, 0, 255], o);
    }
  return { size, baseColor, normal, orm };
}

/** Checkerboard with an asymmetric red "F" in the top-left cell (detects mirrored UVs). */
const checker = makeTex(128, (x, y) => {
  const cx = x >> 4, cy = y >> 4;
  const fx = x - 2, fy = y - 2;
  const inF = cx === 0 && cy === 0 && fx >= 0 && fx < 12 && fy >= 0 && fy < 12 &&
    (fx < 3 || fy < 3 || (fy >= 5 && fy < 8 && fx < 9));
  if (inF) return [220, 30, 30];
  return (cx + cy) & 1 ? [235, 235, 225] : [90, 110, 140];
});

/** Simple brick: 4 courses per tile, mortar lines, normal map grooves. */
const brick = (() => {
  const size = 128;
  const t = makeTex(size, (x, y) => {
    const course = Math.floor(y / 32);
    const off = course % 2 ? 32 : 0;
    const mortar = y % 32 < 3 || (x + off) % 64 < 3;
    if (mortar) return [200, 195, 185];
    const n = ((x * 7 + y * 13 + course * 31) % 17) - 8;
    return [170 + n, 80 + n, 60 + n];
  });
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      const course = Math.floor(y / 32);
      const off = course % 2 ? 32 : 0;
      if (y % 32 < 3 || (x + off) % 64 < 3) t.orm[o] = 120;
      // groove slopes (top edge of a brick faces up)
      if (y % 32 === 3) t.normal.set([128, 200, 230, 255], o);
      if (y % 32 === 31) t.normal.set([128, 56, 230, 255], o);
    }
  return t;
})();

const wood = makeTex(64, (x, y) => {
  const plank = Math.floor(x / 16);
  const grain = Math.sin((y + plank * 37) * 0.35 + Math.sin(x * 0.7) * 1.5) * 12;
  const seam = x % 16 === 0 ? -50 : 0;
  return [150 + grain + seam + plank * 6, 105 + grain * 0.8 + seam, 65 + grain * 0.5 + seam];
});

function mat(name: string, color: [number, number, number], pattern: TexturePattern, extra: Partial<MaterialDef> = {}): MaterialDef {
  return { name, pattern, color, roughness: 0.8, metalness: 0, scale: 1, opacity: 1, normalStrength: 1, ...extra };
}

const MATS: Record<string, { def: MaterialDef; tex?: TextureSet }> = {
  ground: { def: mat("ground", [1, 1, 1], "tiles"), tex: checker },
  floor: { def: mat("floor", [1, 1, 1], "wood_planks"), tex: wood },
  brick: { def: mat("brick", [1, 1, 1], "brick"), tex: brick },
  plaster: { def: mat("plaster", [0.92, 0.9, 0.85], "none") },
  ceiling: { def: mat("ceiling", [0.95, 0.95, 0.95], "none") },
  red: { def: mat("red", [0.85, 0.15, 0.12], "none") },
  blue: { def: mat("blue", [0.15, 0.3, 0.85], "none") },
  metal: { def: mat("metal", [0.75, 0.75, 0.78], "none", { metalness: 1 }) },
  glass: { def: mat("glass", [0.6, 0.8, 0.95], "none", { opacity: 0.25, doubleSided: true }) },
  lamp: { def: mat("lamp", [1, 0.9, 0.6], "none", { emissive: [0.9, 0.7, 0.3] }) },
  wood: { def: mat("wood", [1, 1, 1], "wood_grain"), tex: wood },
};
const lookup: MaterialLookup = (name) => MATS[name] ?? { def: mat(name, [1, 0, 1], "none") };

// ---------------------------------------------------------------- test scene

function node(name: string, kind: string, b: MeshBuilder, extra: Partial<SceneNode> = {}): SceneNode {
  return { name, kind, meshes: b.meshes(), children: [], ...extra };
}

function buildScene(): SceneNode {
  const root: SceneNode = { name: "test", kind: "building", meshes: [], children: [] };

  // site ground (checker, 1 tile = 1 m since UVs are final tile units)
  const g = new MeshBuilder();
  g.flat("ground", [[-14, -12], [14, -12], [14, 12], [-14, 12]], -0.21);
  root.children.push(node("ground", "group", g));

  // floor slab with wood finish on top
  const s = new MeshBuilder();
  s.box("plaster", [-6, -5, -0.2], [6, 5, -0.02]);
  s.flat("floor", [[-6, -5], [6, -5], [6, 5], [-6, 5]], 0);
  root.children.push(node("slab", "slab", s));

  // walls (brick), 3 m high, door gap in the south wall; bottoms skipped like a real wall generator would
  const w = new MeshBuilder();
  const H = 3;
  const sk = { skip: ["-z"] };
  w.box("brick", [-6, -5, 0], [-1, -4.8, H], sk); // south-west part
  w.box("brick", [1, -5, 0], [6, -4.8, H], sk); // south-east part
  w.box("brick", [-1, -5, 2.2], [1, -4.8, H], sk); // lintel over door
  w.box("brick", [-6, 4.8, 0], [6, 5, H], sk); // north
  w.box("brick", [-6, -4.8, 0], [-5.8, 4.8, H], sk); // west
  w.box("brick", [5.8, -4.8, 0], [6, 0, H], sk); // east (south half)
  w.box("brick", [5.8, 2, 0], [6, 4.8, H], sk); // east (north half)
  w.box("brick", [5.8, 0, 0], [6, 2, 0.9], sk); // sill wall under window
  w.box("brick", [5.8, 0, 2.4], [6, 2, H], sk); // over window
  // interior partition (plaster)
  w.box("plaster", [-0.1, 0, 0], [0.1, 4.8, H], sk);
  root.children.push(node("walls", "walls", w));

  // window glass in the east wall
  const gl = new MeshBuilder();
  gl.box("glass", [5.88, 0, 0.9], [5.92, 2, 2.4]);
  root.children.push(node("glass", "opening", gl));

  // ceiling over the north-west room only (single-sided, facing down)
  const c = new MeshBuilder();
  c.flat("ceiling", [[-5.8, 0], [-0.1, 0], [-0.1, 4.8], [-5.8, 4.8]], 2.7, true);
  root.children.push(node("ceiling", "slab", c));

  // column, sphere, lamp, orientation markers
  const o = new MeshBuilder();
  o.cylinder("metal", [3, -2, 0], 0.3, 0.3, 3, 24);
  o.sphere("blue", [-3, -2, 0.8], 0.8, 32, 20);
  o.sphere("lamp", [3, 3, 2.2], 0.25, 16, 10);
  o.box("red", [-0.5, 8, 0], [0.5, 9, 2]); // red tower = NORTH, outside
  o.box("blue", [9, -0.5, 0], [10, 0.5, 1]); // blue block = EAST, outside
  root.children.push(node("objects", "group", o));

  // transformed node: a table built at the origin, rotated 30° and moved into the NE room
  const t = new MeshBuilder();
  t.box("wood", [-0.9, -0.45, 0.72], [0.9, 0.45, 0.78]);
  for (const [x, y] of [[-0.8, -0.35], [0.8, -0.35], [-0.8, 0.35], [0.8, 0.35]] as const)
    t.box("wood", [x - 0.04, y - 0.04, 0], [x + 0.04, y + 0.04, 0.72]);
  t.box("red", [0.6, -0.1, 0.78], [0.8, 0.1, 0.98]); // marks the table's local +X end
  const table: SceneNode = node("table", "furniture", t, { translation: [2.5, 2.5, 0], rotationZ: Math.PI / 6 });
  // nested pivot: a chair parented to the table, offset along the table's local -Y and turned to face it
  const ch = new MeshBuilder();
  ch.box("blue", [-0.22, -0.22, 0.42], [0.22, 0.22, 0.47]);
  ch.box("blue", [-0.22, -0.26, 0.47], [0.22, -0.22, 0.95]); // backrest on local -Y
  for (const [x, y] of [[-0.18, -0.18], [0.18, -0.18], [-0.18, 0.18], [0.18, 0.18]] as const)
    ch.box("metal", [x - 0.02, y - 0.02, 0], [x + 0.02, y + 0.02, 0.42]);
  table.children.push(node("chair", "furniture", ch, { translation: [0, -0.8, 0] }));
  root.children.push(table);

  return root;
}

// ---------------------------------------------------------------- run

mkdirSync("out", { recursive: true });
const scene = buildScene();
const bounds = sceneBounds(scene);
const W = 1280, Hh = 800;

function save(name: string, img: { width: number; height: number; rgba: Uint8Array }) {
  writeFileSync(`out/render-${name}.png`, encodePNG(img));
}

function timed<T>(label: string, fn: () => T): T {
  const t0 = performance.now();
  const r = fn();
  console.log(`${label}: ${(performance.now() - t0).toFixed(0)} ms`);
  return r;
}

const presets: ViewPreset[] = ["iso", "top", "front", "iso_nw"];
for (const p of presets) save(p, timed(p, () => renderPreset(scene, lookup, p, bounds, { width: W, height: Hh })));

// cutaways: plan view and 3/4 view cut at 1.5 m
save("cutaway-top", timed("cutaway-top", () => renderPreset(scene, lookup, "top", bounds, { width: W, height: Hh, clipZ: 1.5 })));
save("cutaway-iso", timed("cutaway-iso", () => renderPreset(scene, lookup, "iso", bounds, { width: W, height: Hh, clipZ: 1.5 })));

// camera inside the building (near-plane clipping, perspective-correct floor)
save(
  "interior",
  timed("interior", () =>
    renderScene(scene, lookup, { eye: [-4.5, -3.5, 1.6], target: [4, 3, 1.0], fov: 70 }, { width: W, height: Hh }),
  ),
);

// grazing view over the checker ground (texture perspective / mip test)
save(
  "grazing",
  timed("grazing", () =>
    renderScene(scene, lookup, { eye: [-13, -11.5, 0.6], target: [0, 0, 0], fov: 55 }, { width: W, height: Hh, edges: false }),
  ),
);

// texture orientation close-up: straight down on the ground; the red "F" must read normally (not mirrored)
save(
  "uvcheck",
  timed("uvcheck", () =>
    renderScene(scene, lookup, { eye: [-10.5, -10.5, 5], target: [-10.5, -10.5, 0], up: [0, 1, 0], ortho: 0.6 }, { width: 400, height: 400 }),
  ),
);

if (process.argv.includes("--perf")) {
  const b = new MeshBuilder();
  // ~200k triangles: grid of spheres + boxes
  let n = 0;
  for (let i = 0; i < 18; i++)
    for (let j = 0; j < 18; j++) {
      const x = (i - 9) * 2.2, y = (j - 9) * 2.2;
      b.sphere((i + j) % 2 ? "blue" : "metal", [x, y, 1.2], 0.8, 36, 20);
      b.box("brick", [x - 0.9, y - 0.9, 0], [x + 0.9, y + 0.9, 0.4]);
      n++;
    }
  b.flat("ground", [[-25, -25], [25, -25], [25, 25], [-25, 25]], 0);
  const big: SceneNode = { name: "perf", kind: "group", meshes: b.meshes(), children: [] };
  const tris = big.meshes.reduce((s, m) => s + m.indices.length / 3, 0);
  console.log(`perf scene: ${tris} triangles`);
  const bb = sceneBounds(big);
  const cam = presetCamera(bb, "iso", W / Hh);
  renderScene(big, lookup, cam, { width: 320, height: 200 }); // warm up JIT
  save("perf", timed(`perf ${tris} tris 1280x800 ss2`, () => renderScene(big, lookup, cam, { width: W, height: Hh })));
  timed(`perf encodePNG`, () => encodePNG(renderScene(big, lookup, cam, { width: W, height: Hh, supersample: 1 })));
}
