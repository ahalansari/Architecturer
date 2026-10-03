/**
 * Close-up renders of casework module types, door styles, handles and interiors.
 *
 *   npx tsx scripts/casework-preview.ts            # all sheets
 *   npx tsx scripts/casework-preview.ts base tall  # only some
 *
 * Writes out/casework_preview/<sheet>.png (closed) and <sheet>_open.png (doors/drawers posed open) where useful.
 * Each sheet is one run against the north wall of a long test room; the camera stands in front of it.
 */
import fs from "node:fs";
import path from "node:path";
import { compile } from "../src/pipeline.js";
import { renderViewPNG } from "../src/render/view.js";

const OUT = path.resolve("out/casework_preview");
fs.mkdirSync(OUT, { recursive: true });

type Json = Record<string, unknown>;
interface Sheet {
  name: string;
  run: Json;
  /** Also render a copy with every module posed open. */
  open?: boolean;
  /** Extra furniture/casework in the room. */
  extra?: Json[];
  eye?: [number, number, number];
  target?: [number, number, number];
  fov?: number;
}

const ROOM_W = 7, ROOM_D = 5;

const sheets: Sheet[] = [
  {
    name: "base",
    open: true,
    run: {
      type: "kitchen", doorStyle: "shaker", materials: { front: "lacquer_navy", handle: "metal_brass", backsplash: "tiles_zellige_white" },
      modules: [
        { kind: "base_doors", width: 0.5, topDrawer: true }, { kind: "base_drawers", width: 0.6 }, { id: "sink", kind: "sink", width: 0.9, bowls: 2 },
        { kind: "dishwasher" }, { id: "hob", kind: "hob", width: 0.9, hob: "gas" }, { kind: "oven_base" }, { kind: "wine_rack", width: 0.3 }, { kind: "open_shelf", width: 0.4 },
      ],
      uppers: [{ kind: "upper_doors", width: "auto" }, { kind: "upper_glass", width: 0.6 }, { kind: "hood", over: "hob", hood: "integrated" }, { kind: "upper_lift", width: "auto" }],
    },
  },
  {
    name: "tall",
    open: true,
    run: {
      type: "kitchen", cornice: true, doorStyle: "shaker", materials: { front: "lacquer_cream", handle: "metal_black" }, handle: "knob",
      modules: [{ kind: "pantry" }, { kind: "fridge" }, { kind: "tall_oven" }, { kind: "base_drawers", width: 0.6 }, { kind: "fridge", width: 0.9, appliance: "freestanding" }, { kind: "tall_open", width: 0.8 }],
      uppers: [{ kind: "upper_open", width: "auto" }],
    },
  },
  {
    name: "styles",
    run: {
      type: "custom", handle: "bar", materials: { front: "lacquer_greige", worktop: "quartz_black" },
      modules: (["slab", "shaker", "glass", "fluted", "louvered", "mirror"] as const).map((s) => ({ kind: "base_doors", width: 0.6, doorStyle: s, doors: 1 })),
      uppers: (["slab", "shaker", "glass", "fluted", "louvered", "mirror"] as const).map((s) => ({ kind: "upper_doors", width: 0.6, doorStyle: s, doors: 1 })),
    },
  },
  {
    name: "handles",
    run: {
      type: "kitchen", materials: { front: "lacquer_charcoal", worktop: "quartz_white", handle: "metal_aluminum" }, handle: "gola", backsplash: "upstand",
      modules: [{ kind: "base_drawers", width: 0.8 }, { kind: "base_doors", width: 0.6 }, { kind: "sink", width: 0.8 }, { kind: "dishwasher" }, { kind: "base_drawers", width: 0.9, drawers: 4 }],
      uppers: [{ kind: "upper_doors", width: "auto" }],
    },
  },
  {
    name: "wardrobe",
    open: true,
    run: {
      type: "wardrobe", toCeiling: true, materials: { front: "wood_oak", handle: "metal_black" }, doorStyle: "slab",
      modules: [
        { kind: "wardrobe", width: 0.9, interior: "hanging" }, { kind: "wardrobe", width: 0.9, interior: "double_hanging" }, { kind: "wardrobe", width: 0.9, interior: "mixed" },
        { kind: "wardrobe", width: 0.9, interior: "shelves" }, { kind: "wardrobe", width: 0.6, interior: "shoes", doors: 1 }, { kind: "wardrobe", width: 0.9, interior: "drawers" },
      ],
    },
  },
  {
    name: "sliding",
    run: {
      type: "wardrobe", slidingDoors: true, slidingOpen: [1], doorStyle: "mirror", materials: { front: "lacquer_white", handle: "metal_aluminum" },
      modules: [{ kind: "wardrobe", width: "auto", interior: "double_hanging" }, { kind: "wardrobe", width: "auto", interior: "mixed" }, { kind: "wardrobe", width: "auto", interior: "shoes" }],
    },
  },
  {
    name: "vanity",
    open: true,
    run: {
      type: "vanity", doorStyle: "fluted", materials: { front: "wood_walnut", worktop: "terrazzo_white", tap: "metal_brass" }, handle: "edge",
      modules: [{ kind: "basin", width: 0.8, basin: "vessel" }, { kind: "base_drawers", width: 0.5, drawers: 2 }, { kind: "basin", width: 0.8, basin: "undermount" }, { kind: "basin", width: 0.7, basin: "integrated" }],
    },
  },
  {
    name: "media_desk",
    run: {
      type: "media", materials: { front: "lacquer_sage", accent: "wood_oak" }, handle: "push",
      modules: [{ kind: "tall_open", width: 0.6 }, { kind: "base_drawers", width: 0.9, drawers: 1 }, { kind: "base_doors", width: 0.9, doorStyle: "louvered" }, { kind: "open_shelf", width: 0.6 }, { kind: "tall_open", width: 0.6 }],
    },
    extra: [
      { kind: "casework", value: { id: "study", type: "desk", path: [[0.12, 1.2], [0.12, 3.6]], materials: { front: "lacquer_white" }, handle: "edge", modules: [{ kind: "base_drawers", width: 0.45 }, { kind: "desk", width: "auto" }, { kind: "base_doors", width: 0.45 }], uppers: [{ kind: "upper_open", width: "auto" }] } },
    ],
  },
  {
    name: "island",
    run: {
      type: "kitchen", materials: { front: "lacquer_white", worktop: "marble_black", handle: "metal_brass" }, doorStyle: "shaker", cornice: true,
      path: [[0.12, 2.2], [0.12, ROOM_D - 0.12], [ROOM_W - 0.12, ROOM_D - 0.12], [ROOM_W - 0.12, 2.2]],
      modules: [
        { kind: "base_doors", width: "auto" }, { kind: "corner" },
        { kind: "base_drawers", width: "auto" }, { id: "sink", kind: "sink", width: 0.9 }, { kind: "dishwasher" }, { id: "hob", kind: "hob", width: 0.9 }, { kind: "base_drawers", width: "auto" }, { kind: "corner" },
        { kind: "base_doors", width: "auto" },
      ],
      uppers: [{ kind: "upper_doors", width: "auto" }, { kind: "corner" }, { kind: "upper_glass", width: "auto" }, { kind: "hood", over: "hob" }, { kind: "upper_doors", width: "auto" }, { kind: "corner" }, { kind: "upper_doors", width: "auto" }],
    },
    extra: [
      { kind: "casework", value: { id: "isl", type: "kitchen", position: [3.5, 2.05], facing: "north", length: 2.2, island: { seating: 0.3, waterfall: "left" }, materials: { front: "lacquer_navy", worktop: "marble_black", handle: "metal_brass" }, doorStyle: "shaker", modules: [{ kind: "base_drawers", width: "auto" }, { kind: "base_doors", width: "auto" }, { kind: "open_shelf", width: 0.4 }] } },
    ],
    eye: [3.5, 0.25, 2.3],
    target: [3.5, 3.4, 0.7],
    fov: 70,
  },
];

function project(s: Sheet, open: boolean): Json {
  const run: Json = { id: s.name, ...s.run };
  if (!run.path) {
    // centre the run on the north wall: its own length, or 4 m when some widths are 'auto'
    const mods = run.modules as Json[];
    const L = mods.some((m) => m.width === "auto") ? 4 : mods.reduce((t, m) => t + (typeof m.width === "number" ? m.width : 0.6), 0);
    run.path = [[ROOM_W / 2 - L / 2, ROOM_D - 0.12], [ROOM_W / 2 + L / 2, ROOM_D - 0.12]];
  }
  if (open) {
    run.modules = (run.modules as Json[]).map((m) => ({ ...m, open: true }));
    if (run.uppers) run.uppers = (run.uppers as Json[]).map((m) => ({ ...m, open: true }));
  }
  const casework = [run, ...(s.extra ?? []).filter((e) => e.kind === "casework").map((e) => e.value)];
  return {
    name: `casework preview: ${s.name}`,
    defaults: { exteriorWallThickness: 0.24 },
    site: { ground: false },
    levels: [
      {
        id: "g",
        height: 2.7,
        walls: [{ id: "w", points: [[0, 0], [ROOM_W, 0], [ROOM_W, ROOM_D], [0, ROOM_D]], closed: true }],
        openings: [{ type: "door", at: [0.8, 0] }],
        rooms: [{ name: "Test", polygon: [[0, 0], [ROOM_W, 0], [ROOM_W, ROOM_D], [0, ROOM_D]], floorMaterial: "wood_floor_light", ceilingMaterial: false }],
        casework,
      },
    ],
  };
}

const want = process.argv.slice(2);
for (const s of sheets) {
  if (want.length && !want.includes(s.name)) continue;
  for (const open of s.open ? [false, true] : [false]) {
    const c = compile(project(s, open));
    if (!c.ok) {
      console.error(`${s.name}: ${c.errors.join("; ")}`);
      continue;
    }
    for (const w of c.warnings) if (w.includes("casework")) console.warn(`  ${s.name}: ${w}`);
    const png = renderViewPNG(c, {
      eye: s.eye ?? [ROOM_W / 2, 0.9, 1.65],
      target: s.target ?? [ROOM_W / 2, ROOM_D, 1.1],
      fov: s.fov ?? 66,
      width: 1600,
      height: 900,
      textureSize: 512,
    });
    const file = path.join(OUT, `${s.name}${open ? "_open" : ""}.png`);
    fs.writeFileSync(file, png);
    console.log(`wrote ${path.relative(process.cwd(), file)}  (${c.stats.triangles} triangles)`);
  }
}
