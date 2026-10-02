// Generates examples/kuwait_towers.json — the Kuwait Towers (VBB / Sune Lindström & Malene Bjørn, 1979).
//
// Sources: Wikipedia "Kuwait Towers" (heights 187 m / 147 m, upper sphere at 123 m, ~41,000 enamelled
// steel discs in eight shades of blue/green/gray, lower sphere = water tank below + restaurants above,
// upper sphere = two-floor observation deck with a rotating floor), 248am.com (Horizon buffet upstairs,
// café/lounge below), and photographs. Sphere sizes/elevations and shaft profiles are estimated from
// elevation photos scaled to the published 187 m height (~0.55 m per pixel); treat them as ±5%.
//
// Run: npx tsx scripts/kuwait-towers.mts
import { writeFileSync } from "node:fs";

type P = [number, number];
const r2 = (n: number) => Math.round(n * 100) / 100;
const circle = (cx: number, cy: number, r: number, n = 48): P[] =>
  Array.from({ length: n }, (_, i) => [r2(cx + Math.cos((i / n) * 2 * Math.PI) * r), r2(cy + Math.sin((i / n) * 2 * Math.PI) * r)]);
const polar = (r: number, deg: number, c: P = [0, 0]): P => [r2(c[0] + r * Math.cos((deg * Math.PI) / 180)), r2(c[1] + r * Math.sin((deg * Math.PI) / 180))];
/** Furniture rotation so the item's FRONT faces the given direction (degrees, CCW from east). front = -y at rotation 0. */
const facingDeg = (dir: number) => r2(dir + 90);

// texture tiles around a sphere must be a whole number to hide the seam
const DISC_TILE = 3.2; // m per texture tile (8 x 8 discs, ~0.4 m spacing)
const uvR = (radius: number) => r2((Math.round((2 * Math.PI * radius) / DISC_TILE) * DISC_TILE) / (2 * Math.PI));

const MAIN: P = [0, 0];
const SECOND: P = [-40, -4];
const THIRD: P = [-20, 13];

// ---- main tower geometry (heights in meters above the plaza) ----
const LOWER = { c: 76, r: 17 }; // restaurant / water sphere
const UPPER = { c: 121, r: 10 }; // observation sphere
const ring = { z0: 77.3, z1: 87.2 }; // where the restaurant ring meets the lower sphere
const rAt = (s: { c: number; r: number }, z: number) => Math.sqrt(Math.max(0, s.r * s.r - (z - s.c) ** 2));

const levels: any[] = [];
/** Centre of the lobby wall segment nearest to an angle (the wall is a 32-gon; openings must avoid its corners). */
const seg32 = (deg: number) => (Math.floor(deg / 11.25) + 0.5) * 11.25;

// ---------------------------------------------------------------- ground / plaza
const plazaC: P = [-18, 3];
const ground: any = {
  id: "plaza",
  name: "Plaza & entrance",
  elevation: 0,
  height: 4.5,
  walls: [{ id: "lobby_wall", points: circle(0, 0, 13, 32), closed: true, thickness: 0.3, material: "kt_white" }],
  openings: [
    { id: "entrance", type: "door", at: polar(13 * Math.cos(Math.PI / 32), seg32(270)), style: "double", width: 2.0, height: 2.6, panelMaterial: "glass_tinted", frameMaterial: "metal_aluminum" },
    ...[200, 230, 310, 340, 20, 50, 80, 110, 140, 170].map((a, i) => ({
      id: `lobby_win${i}`,
      type: "window",
      at: polar(13 * Math.cos(Math.PI / 32), seg32(a)),
      width: 2.2,
      height: 2.6,
      sill: 0.6,
      style: "fixed",
      frameMaterial: "metal_aluminum",
    })),
  ],
  rooms: [{ id: "lobby", name: "Entrance lobby & gift shop", polygon: circle(0, 0, 13, 32), floorMaterial: "marble_white", ceilingMaterial: "paint_white" }],
  terraces: [
    { id: "plaza_deck", name: "Promenade plaza", polygon: circle(plazaC[0], plazaC[1], 72, 64), material: "paving_stone", thickness: 1.2, edgeMaterial: "concrete" },
  ],
  shapes: [] as any[],
  furniture: [] as any[],
  roofs: [{ id: "lobby_roof", type: "flat", polygon: circle(0, 0, 13, 32), overhang: 0.6, thickness: 0.4, material: "concrete", edgeMaterial: "kt_white" }],
};

// gift shop and ticket counter inside the lobby (shaft base occupies r < ~9)
ground.furniture.push(
  { id: "ticket_desk", type: "kitchen_counter", position: polar(11.2, 240), rotation: facingDeg(60), width: 2.4, materials: { counter: "marble_white", cabinet: "wood_walnut" } },
  ...[300, 320].map((a, i) => ({ id: `gift_shelf${i}`, type: "bookshelf", position: polar(12.4, a), rotation: facingDeg(a + 180), width: 1.4, options: { books: true } })),
  ...[205, 335].map((a, i) => ({ id: `lobby_plant${i}`, type: "plant", position: polar(11.4, a) })),
  // lift doors on the shaft
  { id: "lift_door_ground", type: "box", position: polar(9.15, 270), rotation: 0, width: 1.6, depth: 0.12, height: 2.4, materials: { main: "metal_steel" } },
);

// sea all around the promontory, palms and lights on the promenade
ground.shapes.push({ type: "box", id: "sea", name: "Arabian Gulf", center: [plazaC[0], plazaC[1], -1.6], size: [900, 900, 0.2], material: "water" });
for (let i = 0; i < 20; i++) {
  const a = (i / 20) * 360 + 9;
  ground.furniture.push({ type: "tree", position: polar(64, a, plazaC), width: 4, depth: 4, height: 9, options: { kind: "palm" } });
  if (i % 2 === 0) ground.furniture.push({ type: "lamp_post", position: polar(68, a + 9, plazaC) });
}
for (let i = 0; i < 8; i++) {
  const a = (i / 8) * 360 + 22;
  ground.furniture.push({ type: "bench", position: polar(56, a, plazaC), rotation: facingDeg(a + 180), width: 1.8 });
}

// ---- the three towers (all standing on the plaza level) ----
ground.shapes.push(
  {
    type: "revolve",
    id: "main_shaft",
    name: "Main tower shaft (187 m)",
    position: MAIN,
    material: "kt_white",
    segments: 48,
    profile: [
      [0, 0], [9.0, 0], [8.6, 0.6], [7.2, 2.5], [6.2, 5.5], [5.6, 10], [5.2, 20], [4.9, 40], [4.7, 59], [4.6, 76], [4.3, 93],
      [3.9, 106], [3.6, 113], [3.4, 121], [3.0, 131], [2.5, 138], [1.9, 146], [1.3, 156], [0.8, 166], [0.45, 176], [0.15, 185], [0.05, 187], [0, 187],
    ],
  },
  {
    type: "sphere",
    id: "main_lower_sphere",
    name: "Restaurant sphere (water tank below)",
    center: [MAIN[0], MAIN[1], LOWER.c],
    radius: LOWER.r,
    rings: 44,
    segments: 72,
    material: "kt_discs",
    uvRadius: uvR(LOWER.r),
    hollow: { thickness: 0.35, innerMaterial: "paint_gray" },
    bands: [{ from: ring.z0, to: ring.z1, material: "none" }],
  },
  {
    // the cantilevered restaurant ring: sloping soffit, tall glazing, white lip, near-flat roof back to the sphere
    type: "revolve",
    id: "restaurant_ring",
    name: "Restaurant ring",
    position: MAIN,
    material: "kt_white",
    segments: 72,
    profile: [
      [r2(rAt(LOWER, ring.z0)), ring.z0], [19.6, 78.6], [20.6, 85.6], [20.95, 85.8], [20.95, 86.25], [r2(rAt(LOWER, ring.z1)), ring.z1],
    ],
    hollow: { thickness: 0.3, innerMaterial: "paint_gray" },
    bands: [{ from: 78.6, to: 85.6, material: "kt_glass", frame: { material: "metal_aluminum", columns: 72, rows: 2, diagonals: false, radius: 0.045, nodes: false } }],
  },
  {
    type: "sphere",
    id: "main_upper_sphere",
    name: "Observation sphere",
    center: [MAIN[0], MAIN[1], UPPER.c],
    radius: UPPER.r,
    rings: 32,
    segments: 48,
    material: "kt_discs",
    uvRadius: uvR(UPPER.r),
    hollow: { thickness: 0.3, innerMaterial: "paint_gray" },
    bands: [{ from: 117.6, to: 125.4, material: "kt_glass", frame: { material: "metal_black", columns: 24, rows: 3, diagonals: true, radius: 0.06, nodes: true } }],
  },
  {
    type: "revolve",
    id: "second_shaft",
    name: "Second tower shaft (147 m)",
    position: SECOND,
    material: "kt_white",
    segments: 40,
    profile: [
      [0, 0], [7.2, 0], [6.9, 0.6], [5.6, 2.5], [4.8, 5.5], [4.3, 10], [4.0, 30], [3.8, 57], [3.7, 71], [3.4, 85], [2.9, 92],
      [2.2, 100], [1.6, 110], [1.0, 122], [0.5, 135], [0.15, 145], [0, 147],
    ],
  },
  {
    type: "sphere",
    id: "second_sphere",
    name: "Second tower sphere (water tank)",
    center: [SECOND[0], SECOND[1], 71],
    radius: 14,
    rings: 36,
    segments: 64,
    material: "kt_discs",
    uvRadius: uvR(14),
  },
  {
    type: "revolve",
    id: "third_tower",
    name: "Third tower (floodlights)",
    position: THIRD,
    material: "kt_white",
    segments: 24,
    profile: [[0, 0], [3.4, 0], [3.1, 0.5], [2.4, 2.5], [2.0, 6], [1.8, 20], [1.5, 50], [1.1, 75], [0.7, 92], [0.35, 104], [0.1, 112], [0, 113]],
  },
);
levels.push(ground);

// ---------------------------------------------------------------- restaurant sphere
// lower floor: café & lounge; upper floor: Horizon buffet restaurant (photos: white-clothed tables along the glazing)
const cafe: any = {
  id: "cafe",
  name: "Café & lounge (lower sphere)",
  elevation: 78.7,
  height: 3.6,
  autoSlab: false,
  slabs: [{ id: "cafe_floor", polygon: circle(0, 0, 19.35, 72), thickness: 0.15, material: "concrete" }],
  rooms: [{ id: "cafe_room", name: "Café & lounge", polygon: circle(0, 0, 19.35, 72), floorMaterial: "wood_floor_walnut", ceilingMaterial: false }],
  furniture: [] as any[],
};
// lounge groups along the glazing: sofa facing out + coffee table
for (let i = 0; i < 12; i++) {
  const a = (i / 12) * 360 + 15;
  if (Math.abs(((a - 270 + 540) % 360) - 180) < 20) continue; // keep the lift lobby clear
  cafe.furniture.push(
    { type: "sofa", position: polar(15.4, a), rotation: facingDeg(a), width: 2.0, materials: { body: "fabric_beige", cushions: "fabric_beige" } },
    { type: "coffee_table", position: polar(17.0, a), rotation: facingDeg(a) },
  );
}
// café tables in an inner ring
for (let i = 0; i < 14; i++) {
  const a = (i / 14) * 360;
  if (Math.abs(((a - 270 + 540) % 360) - 180) < 22) continue;
  cafe.furniture.push(
    { type: "side_table", position: polar(10.6, a), width: 0.8, depth: 0.8, height: 0.74 },
    { type: "chair", position: polar(10.6, a + 4.6), rotation: facingDeg(a - 90) },
    { type: "chair", position: polar(10.6, a - 4.6), rotation: facingDeg(a + 90) },
  );
}
// coffee bar against the core
cafe.furniture.push(
  { id: "coffee_bar", type: "kitchen_counter", position: polar(6.4, 90), rotation: facingDeg(90), width: 3.2, materials: { counter: "marble_black", cabinet: "wood_walnut" } },
  ...[-0.9, 0, 0.9].map((dx, i) => ({ type: "bar_stool", position: [dx, 7.45] as P, rotation: facingDeg(270), id: `bar_stool${i}` })),
  { id: "lift_door_cafe", type: "box", position: polar(4.62, 270), width: 1.4, depth: 0.1, height: 2.3, materials: { main: "metal_steel" } },
);
levels.push(cafe);

const horizon: any = {
  id: "horizon",
  name: "Horizon restaurant (lower sphere)",
  elevation: 82.3,
  height: 3.9,
  autoSlab: false,
  slabs: [{ id: "horizon_floor", polygon: circle(0, 0, 19.95, 72), thickness: 0.3, material: "concrete" }],
  rooms: [{ id: "horizon_room", name: "Horizon buffet restaurant", polygon: circle(0, 0, 19.95, 72), floorMaterial: "wood_floor_oak", ceilingMaterial: false }],
  furniture: [] as any[],
};
// window ring of tables for two, then an inner ring of tables for four
for (let i = 0; i < 30; i++) {
  const a = (i / 30) * 360 + 6;
  if (Math.abs(((a - 270 + 540) % 360) - 180) < 9) continue;
  horizon.furniture.push(
    { type: "table", position: polar(18.1, a), rotation: facingDeg(a), width: 1.1, depth: 0.8, materials: { top: "linen_white", legs: "metal_black" } },
    { type: "chair", position: polar(18.1, a + 1.9), rotation: facingDeg(a - 90), materials: { seat: "fabric_beige" } },
    { type: "chair", position: polar(18.1, a - 1.9), rotation: facingDeg(a + 90), materials: { seat: "fabric_beige" } },
  );
}
for (let i = 0; i < 18; i++) {
  const a = (i / 18) * 360 + 10;
  if (Math.abs(((a - 270 + 540) % 360) - 180) < 14) continue;
  const c = polar(13.4, a);
  horizon.furniture.push(
    { type: "table", position: c, rotation: facingDeg(a), width: 1.2, depth: 1.0, materials: { top: "linen_white", legs: "metal_black" } },
    { type: "chair", position: polar(14.25, a), rotation: facingDeg(a + 180), materials: { seat: "fabric_beige" } },
    { type: "chair", position: polar(12.55, a), rotation: facingDeg(a), materials: { seat: "fabric_beige" } },
  );
}
// buffet stations around the core
for (const a of [30, 90, 150, 210, 330]) {
  horizon.furniture.push({ type: "kitchen_island", position: polar(7.6, a), rotation: facingDeg(a), width: 2.6, materials: { counter: "marble_white", cabinet: "wood_dark" } });
}
horizon.furniture.push({ id: "lift_door_horizon", type: "box", position: polar(4.5, 270), width: 1.4, depth: 0.1, height: 2.3, materials: { main: "metal_steel" } });
levels.push(horizon);

// ---------------------------------------------------------------- observation sphere
const deckRail = (r: number) => ({ points: circle(0, 0, r, 40), closed: true, style: "glass", height: 1.05, material: "metal_steel" });
const obsLower: any = {
  id: "observation_lower",
  name: "Observation sphere — lower floor",
  elevation: 118.2,
  height: 3.5,
  autoSlab: false,
  slabs: [{ id: "obs_lower_floor", polygon: circle(0, 0, 9.2, 48), thickness: 0.25, material: "concrete" }],
  rooms: [{ id: "obs_lower_room", name: "Viewing gallery & gift kiosk", polygon: circle(0, 0, 9.2, 48), floorMaterial: "wood_floor_walnut", ceilingMaterial: false }],
  furniture: [
    ...[0, 60, 120, 180].map((a, i) => ({ id: `obs_bench${i}`, type: "bench", position: polar(6.3, a), rotation: facingDeg(a), width: 1.8 })),
    { id: "gift_kiosk", type: "kitchen_counter", position: polar(4.6, 90), rotation: facingDeg(90), width: 2.2, materials: { counter: "wood_walnut" } },
    { id: "lift_door_obs_lower", type: "box", position: polar(3.42, 270), width: 1.2, depth: 0.1, height: 2.3, materials: { main: "metal_steel" } },
  ],
};
levels.push(obsLower);

const obsUpper: any = {
  id: "observation_upper",
  name: "Observation sphere — rotating floor",
  elevation: 121.7,
  height: 3.6,
  autoSlab: false,
  slabs: [{ id: "rotating_deck", polygon: circle(0, 0, 9.6, 48), thickness: 0.3, material: "concrete" }],
  rooms: [{ id: "rotating_deck_room", name: "Rotating observation deck (turns every 30 min)", polygon: circle(0, 0, 9.6, 48), floorMaterial: "wood_floor_oak", ceilingMaterial: false }],
  railings: [deckRail(9.1)],
  furniture: [
    ...[30, 150, 210, 330].map((a, i) => ({ id: `deck_bench${i}`, type: "bench", position: polar(6.6, a), rotation: facingDeg(a), width: 1.6 })),
    { id: "food_stand", type: "kitchen_counter", position: polar(4.3, 90), rotation: facingDeg(90), width: 2.0, materials: { counter: "marble_white" } },
    ...[-0.6, 0.6].map((dx, i) => ({ id: `deck_stool${i}`, type: "bar_stool", position: [dx, 5.25] as P, rotation: facingDeg(270) })),
    { id: "lift_door_obs_upper", type: "box", position: polar(3.37, 270), width: 1.2, depth: 0.1, height: 2.3, materials: { main: "metal_steel" } },
  ],
};
levels.push(obsUpper);

const project = {
  name: "Kuwait Towers",
  description:
    "The Kuwait Towers (1979, VBB / Sune Lindström & Malene Bjørn): main tower 187 m with a restaurant sphere and a revolving observation sphere, second tower 147 m (water), third tower 113 m (floodlights). Spheres clad in enamelled steel discs. Dimensions estimated from photos scaled to published heights.",
  defaults: { wallThickness: 0.2, exteriorWallThickness: 0.3, wallMaterial: "paint_white", exteriorMaterial: "kt_white" },
  site: { ground: false },
  materials: {
    kt_white: { base: "plaster_white", color: "#f3f3f0", roughness: 0.6 },
    // dark blue-gray solar glazing (photos), denser than plain tinted glass
    kt_glass: { base: "glass_tinted", color: "#3d4f5c", opacity: 0.62, roughness: 0.05 },
    kt_discs: {
      base: "enamel_discs",
      scale: DISC_TILE,
      params: { cols: 8, rows: 8, size: 0.9, palette: "#173f58,#1f5470,#1f5470,#2a6d88,#2a6d88,#3a86a0,#24564c,#2f6a5c,#3f7d6c,#5b7883,#8fa6af", background: "#1b2428" },
    },
  },
  levels,
  elevators: [
    {
      id: "main_lift",
      stops: [
        { level: "plaza", at: polar(10.4, 270) },
        { level: "cafe", at: polar(5.8, 270) },
        { level: "horizon", at: polar(5.7, 270) },
        { level: "observation_lower", at: polar(4.5, 270) },
        { level: "observation_upper", at: polar(4.5, 270) },
      ],
    },
  ],
};

writeFileSync(new URL("../examples/kuwait_towers.json", import.meta.url), JSON.stringify(project, null, 1) + "\n");
console.log(`wrote examples/kuwait_towers.json (${levels.length} levels)`);
