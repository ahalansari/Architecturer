// Generates examples/kuwait_towers.json — the Kuwait Towers (VBB / Sune Lindström & Malene Bjørn, 1979).
//
// Sources: Wikipedia "Kuwait Towers" (heights 187 m / 147 m, ~41,000 enamelled steel discs in eight shades of
// blue/green/gray, lower sphere = water tank below + restaurants above, upper sphere = two-floor observation
// deck with a rotating floor), 248am.com (Horizon buffet upstairs, café/lounge below), interior photos
// (geodesic glazing over the observation deck), and the perspective-corrected Wikipedia photo
// "Kuwait_Towers_RB.jpg", measured at ~0.23 m/px against the 187 m main tower:
//   - main shaft ~20 m wide at the base, ~15 m under the lower sphere, ~11 m between the spheres
//   - lower sphere ~39 m, centred ~82.5 m; restaurant zone = a tall glazing band set INTO the sphere,
//     a thin see-through louvre canopy projecting ~4 m above it, and a smaller set-back glazing band
//     for the upper floor, with the disc cap above
//   - upper sphere ~21.5 m, centred ~131.4 m; geodesic glass over its upper ~60%
//   - every tower ends in a grey steel needle above a white cone
// Treat dimensions as ±5%.
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
/** True when angle a is within `w` degrees of `b`. */
const near = (a: number, b: number, w: number) => Math.abs(((a - b + 540) % 360) - 180) < w;

// texture tiles around a sphere must be a whole number to hide the seam
const DISC_TILE = 3.2; // m per texture tile (8 x 8 discs, ~0.4 m spacing)
const uvR = (radius: number) => r2((Math.round((2 * Math.PI * radius) / DISC_TILE) * DISC_TILE) / (2 * Math.PI));

// Tower feet relative to the main tower, x east / y north, from the OpenStreetMap nodes of the three towers
// (main tower ~29.3897 N 48.0032 E). The photo-measured layout used before came out mirrored north-south.
const MAIN: P = [0, 0];
const SECOND: P = [-45.3, 6.5];
const THIRD: P = [-31.7, -24.6];

// ---- main tower geometry (heights in meters above the plaza) ----
const LOWER = { c: 82.5, r: 19.4 }; // restaurant / water sphere
const UPPER = { c: 131.4, r: 10.8 }; // observation sphere
const rAt = (s: { c: number; r: number }, z: number) => r2(Math.sqrt(Math.max(0, s.r * s.r - (z - s.c) ** 2)));
// restaurant zone of the lower sphere
const GLAZE_LOW = { from: 87.0, to: 91.6 }; // tall band: lower restaurant floor
const CANOPY_Z = 91.9; // louvre canopy springs from the sphere here
const GLAZE_HIGH = { from: 93.7, to: 95.8 }; // set-back band: upper floor
const FLOOR_LOW = 87.2, FLOOR_HIGH = 92.3;
// observation sphere
const DOME = { from: 128.5, to: 141.3 }; // geodesic glass over the top ~60%
const OBS_LOW = 128.7, OBS_HIGH = 132.3;
const LIFT = 270; // lift doors face south

const levels: any[] = [];

// ---------------------------------------------------------------- ground / plaza
const LOBBY_R = 17, LOBBY_N = 40;
/** Centre of the lobby wall segment nearest to an angle (the wall is a polygon; openings must avoid its corners). */
const lobbySeg = (deg: number) => (Math.floor(deg / (360 / LOBBY_N)) + 0.5) * (360 / LOBBY_N);
const lobbyMid = LOBBY_R * Math.cos(Math.PI / LOBBY_N);
const plazaC: P = [-20, 4];
const ground: any = {
  id: "plaza",
  name: "Plaza & entrance",
  elevation: 0,
  height: 4.5,
  walls: [{ id: "lobby_wall", points: circle(0, 0, LOBBY_R, LOBBY_N), closed: true, thickness: 0.3, material: "kt_white" }],
  openings: [
    { id: "entrance", type: "door", at: polar(lobbyMid, lobbySeg(270)), style: "double", width: 2.0, height: 2.6, panelMaterial: "glass_tinted", frameMaterial: "metal_aluminum" },
    ...[200, 230, 310, 340, 20, 50, 80, 110, 140, 170].map((a, i) => ({
      id: `lobby_win${i}`,
      type: "window",
      at: polar(lobbyMid, lobbySeg(a)),
      width: 2.2,
      height: 2.6,
      sill: 0.6,
      style: "fixed",
      frameMaterial: "metal_aluminum",
    })),
  ],
  rooms: [{ id: "lobby", name: "Entrance lobby & gift shop", polygon: circle(0, 0, LOBBY_R, LOBBY_N), floorMaterial: "marble_white", ceilingMaterial: "paint_white" }],
  terraces: [
    { id: "plaza_deck", name: "Promenade plaza", polygon: circle(plazaC[0], plazaC[1], 74, 64), material: "paving_stone", thickness: 1.2, edgeMaterial: "concrete" },
  ],
  shapes: [] as any[],
  furniture: [] as any[],
  roofs: [{ id: "lobby_roof", type: "flat", polygon: circle(0, 0, LOBBY_R, LOBBY_N), overhang: 0.6, thickness: 0.4, material: "concrete", edgeMaterial: "kt_white" }],
};

// gift shop and ticket counter inside the lobby (the shaft base fills r < ~11.2)
ground.furniture.push(
  { id: "ticket_desk", type: "kitchen_counter", position: polar(14.6, 240), rotation: facingDeg(60), width: 2.4, materials: { counter: "marble_white", cabinet: "wood_walnut" } },
  ...[300, 318].map((a, i) => ({ id: `gift_shelf${i}`, type: "bookshelf", position: polar(16.4, a), rotation: facingDeg(a + 180), width: 1.4, options: { books: true } })),
  ...[205, 335].map((a, i) => ({ id: `lobby_plant${i}`, type: "plant", position: polar(15.5, a) })),
  { id: "lift_door_ground", type: "box", position: polar(10.35, LIFT), width: 1.6, depth: 0.12, height: 2.4, materials: { main: "metal_steel" } },
);

// sea all around the promontory, palms and lights on the promenade
ground.shapes.push({ type: "box", id: "sea", name: "Arabian Gulf", center: [plazaC[0], plazaC[1], -1.6], size: [900, 900, 0.2], material: "water" });
for (let i = 0; i < 20; i++) {
  const a = (i / 20) * 360 + 9;
  ground.furniture.push({ type: "tree", position: polar(66, a, plazaC), width: 4, depth: 4, height: 9, options: { kind: "palm" } });
  if (i % 2 === 0) ground.furniture.push({ type: "lamp_post", position: polar(70, a + 9, plazaC) });
}
for (let i = 0; i < 8; i++) {
  const a = (i / 8) * 360 + 22;
  ground.furniture.push({ type: "bench", position: polar(58, a, plazaC), rotation: facingDeg(a + 180), width: 1.8 });
}

// ---- the three towers (all standing on the plaza level). Each ends in a grey steel needle. ----
const needle = (from: number, to: number) => ({ from, to, material: "metal_steel" });
ground.shapes.push(
  {
    type: "revolve",
    id: "main_shaft",
    name: "Main tower shaft (187 m)",
    position: MAIN,
    material: "kt_white",
    segments: 56,
    profile: [
      [0, 0], [11.2, 0], [10.6, 0.8], [10.0, 3], [9.6, 15], [8.5, 35], [7.6, 55], [7.3, 63], [6.0, 70], [5.4, 80], [5.4, 102],
      [5.2, 115], [4.9, 122], [4.8, 131], [3.4, 140], [2.75, 142.5], [2.2, 150], [1.4, 160], [0.9, 167], [0.55, 170], [0.2, 180], [0.05, 186], [0, 187],
    ],
    bands: [needle(167, 187)],
  },
  {
    type: "sphere",
    id: "main_lower_sphere",
    name: "Restaurant sphere (water tank below)",
    center: [MAIN[0], MAIN[1], LOWER.c],
    radius: LOWER.r,
    rings: 48,
    segments: 96,
    material: "kt_discs",
    uvRadius: uvR(LOWER.r),
    hollow: { thickness: 0.35, innerMaterial: "paint_gray" },
    bands: [
      // the glazing is part of the sphere surface; the disc cladding stops at its edges
      { ...GLAZE_LOW, material: "kt_glass", frame: { material: "metal_aluminum", columns: 96, rows: 1, diagonals: false, radius: 0.045, nodes: false } },
      { ...GLAZE_HIGH, material: "kt_glass", frame: { material: "metal_aluminum", columns: 80, rows: 1, diagonals: false, radius: 0.04, nodes: false } },
    ],
  },
  {
    // thin see-through louvre canopy: a steel fascia ring at the outer edge, slats + radial ribs back to the sphere
    type: "revolve",
    id: "restaurant_canopy",
    name: "Restaurant louvre canopy",
    position: MAIN,
    material: "metal_steel",
    segments: 96,
    profile: [
      [21.9, 90.75], [22.0, 91.0], [rAt(LOWER, CANOPY_Z), CANOPY_Z],
    ],
    bands: [
      { from: 90.75, to: 91.0, material: "metal_steel" },
      { from: 91.0, to: CANOPY_Z, material: "none", frame: { material: "metal_steel", columns: 96, rows: 7, diagonals: false, radius: 0.035, nodes: false } },
    ],
  },
  {
    type: "sphere",
    id: "main_upper_sphere",
    name: "Observation sphere",
    center: [MAIN[0], MAIN[1], UPPER.c],
    radius: UPPER.r,
    rings: 36,
    segments: 60,
    material: "kt_discs",
    uvRadius: uvR(UPPER.r),
    hollow: { thickness: 0.3, innerMaterial: "paint_gray" },
    bands: [{ ...DOME, material: "kt_glass", frame: { material: "metal_black", columns: 24, rows: 6, diagonals: true, radius: 0.06, nodes: true } }],
  },
  {
    type: "revolve",
    id: "second_shaft",
    name: "Second tower shaft (147 m)",
    position: SECOND,
    material: "kt_white",
    segments: 48,
    profile: [
      [0, 0], [7.6, 0], [7.1, 0.8], [6.7, 3], [6.3, 30], [6.0, 55], [5.6, 60], [4.2, 70], [3.4, 80], [3.0, 86], [2.65, 95],
      [2.0, 105], [1.3, 115], [0.9, 123], [0.5, 130], [0.15, 142], [0, 147],
    ],
    bands: [needle(123, 147)],
  },
  {
    type: "sphere",
    id: "second_sphere",
    name: "Second tower sphere (water tank)",
    center: [SECOND[0], SECOND[1], 72.5],
    radius: 14,
    rings: 40,
    segments: 72,
    material: "kt_discs",
    uvRadius: uvR(14),
  },
  {
    type: "revolve",
    id: "third_tower",
    name: "Third tower (floodlights)",
    position: THIRD,
    material: "kt_white",
    segments: 32,
    profile: [[0, 0], [3.8, 0], [3.6, 0.6], [3.4, 3], [2.8, 40], [2.2, 65], [1.6, 81], [1.0, 90], [0.4, 104], [0.1, 111], [0, 113]],
    bands: [needle(81, 113)],
  },
);
levels.push(ground);

// ---------------------------------------------------------------- restaurant sphere
// Lower floor (behind the tall glazing): café & lounge. Upper floor (smaller, set-back windows): Horizon buffet.
const lowR = r2(rAt(LOWER, FLOOR_LOW) - 0.45);
const cafe: any = {
  id: "cafe",
  name: "Café & lounge (lower sphere)",
  elevation: FLOOR_LOW,
  height: FLOOR_HIGH - FLOOR_LOW,
  autoSlab: false,
  slabs: [{ id: "cafe_floor", polygon: circle(0, 0, lowR, 96), thickness: 0.2, material: "concrete" }],
  rooms: [{ id: "cafe_room", name: "Café & lounge", polygon: circle(0, 0, lowR, 96), floorMaterial: "wood_floor_walnut", ceilingMaterial: false }],
  furniture: [] as any[],
};
// lounge groups along the glazing: sofa facing out + coffee table
for (let i = 0; i < 14; i++) {
  const a = (i / 14) * 360 + 12;
  if (near(a, LIFT, 18)) continue; // keep the lift lobby clear
  cafe.furniture.push(
    { type: "sofa", position: polar(lowR - 3.0, a), rotation: facingDeg(a), width: 2.0, materials: { body: "fabric_beige", cushions: "fabric_beige" } },
    { type: "coffee_table", position: polar(lowR - 1.45, a), rotation: facingDeg(a) },
  );
}
// café tables in an inner ring
for (let i = 0; i < 16; i++) {
  const a = (i / 16) * 360;
  if (near(a, LIFT, 20)) continue;
  cafe.furniture.push(
    { type: "side_table", position: polar(11.0, a), width: 0.8, depth: 0.8, height: 0.74 },
    { type: "chair", position: polar(11.0, a + 4.4), rotation: facingDeg(a - 90) },
    { type: "chair", position: polar(11.0, a - 4.4), rotation: facingDeg(a + 90) },
  );
}
// coffee bar against the core (core radius ~5.4 m)
cafe.furniture.push(
  { id: "coffee_bar", type: "kitchen_counter", position: polar(7.2, 90), rotation: facingDeg(90), width: 3.2, materials: { counter: "marble_black", cabinet: "wood_walnut" } },
  ...[-0.9, 0, 0.9].map((dx, i) => ({ type: "bar_stool", position: [dx, 8.25] as P, rotation: facingDeg(270), id: `bar_stool${i}` })),
  { id: "lift_door_cafe", type: "box", position: polar(5.42, LIFT), width: 1.4, depth: 0.1, height: 2.3, materials: { main: "metal_steel" } },
);
levels.push(cafe);

const highR = r2(rAt(LOWER, FLOOR_HIGH) - 0.45);
const horizon: any = {
  id: "horizon",
  name: "Horizon restaurant (lower sphere)",
  elevation: FLOOR_HIGH,
  height: 4.0,
  autoSlab: false,
  slabs: [{ id: "horizon_floor", polygon: circle(0, 0, highR, 96), thickness: 0.3, material: "concrete" }],
  rooms: [{ id: "horizon_room", name: "Horizon buffet restaurant", polygon: circle(0, 0, highR, 96), floorMaterial: "wood_floor_oak", ceilingMaterial: false }],
  furniture: [] as any[],
};
// window ring of tables for two, then an inner ring of tables for four
for (let i = 0; i < 26; i++) {
  const a = (i / 26) * 360 + 6;
  if (near(a, LIFT, 9)) continue;
  horizon.furniture.push(
    { type: "table", position: polar(highR - 1.2, a), rotation: facingDeg(a), width: 1.1, depth: 0.8, materials: { top: "linen_white", legs: "metal_black" } },
    { type: "chair", position: polar(highR - 1.2, a + 2.3), rotation: facingDeg(a - 90), materials: { seat: "fabric_beige" } },
    { type: "chair", position: polar(highR - 1.2, a - 2.3), rotation: facingDeg(a + 90), materials: { seat: "fabric_beige" } },
  );
}
for (let i = 0; i < 16; i++) {
  const a = (i / 16) * 360 + 11;
  if (near(a, LIFT, 14)) continue;
  horizon.furniture.push(
    { type: "table", position: polar(11.4, a), rotation: facingDeg(a), width: 1.2, depth: 1.0, materials: { top: "linen_white", legs: "metal_black" } },
    { type: "chair", position: polar(12.25, a), rotation: facingDeg(a + 180), materials: { seat: "fabric_beige" } },
    { type: "chair", position: polar(10.55, a), rotation: facingDeg(a), materials: { seat: "fabric_beige" } },
  );
}
// buffet stations around the core
for (const a of [30, 90, 150, 210, 330]) {
  horizon.furniture.push({ type: "kitchen_island", position: polar(7.6, a), rotation: facingDeg(a), width: 2.6, materials: { counter: "marble_white", cabinet: "wood_dark" } });
}
horizon.furniture.push({ id: "lift_door_horizon", type: "box", position: polar(5.42, LIFT), width: 1.4, depth: 0.1, height: 2.3, materials: { main: "metal_steel" } });
levels.push(horizon);

// ---------------------------------------------------------------- observation sphere
const deckRail = (r: number) => ({ points: circle(0, 0, r, 40), closed: true, style: "glass", height: 1.05, material: "metal_steel" });
const obsLowR = r2(rAt(UPPER, OBS_LOW) - 0.4);
const obsHighR = r2(rAt(UPPER, OBS_HIGH) - 0.45);
const obsLower: any = {
  id: "observation_lower",
  name: "Observation sphere — lower floor",
  elevation: OBS_LOW,
  height: OBS_HIGH - OBS_LOW,
  autoSlab: false,
  slabs: [{ id: "obs_lower_floor", polygon: circle(0, 0, obsLowR, 48), thickness: 0.25, material: "concrete" }],
  rooms: [{ id: "obs_lower_room", name: "Viewing gallery & gift kiosk", polygon: circle(0, 0, obsLowR, 48), floorMaterial: "wood_floor_walnut", ceilingMaterial: false }],
  railings: [deckRail(obsLowR - 0.45)],
  furniture: [
    ...[0, 60, 120, 180].map((a, i) => ({ id: `obs_bench${i}`, type: "bench", position: polar(7.0, a), rotation: facingDeg(a), width: 1.8 })),
    { id: "gift_kiosk", type: "kitchen_counter", position: polar(5.6, 90), rotation: facingDeg(90), width: 2.2, materials: { counter: "wood_walnut" } },
    { id: "lift_door_obs_lower", type: "box", position: polar(4.82, LIFT), width: 1.2, depth: 0.1, height: 2.3, materials: { main: "metal_steel" } },
  ],
};
levels.push(obsLower);

const obsUpper: any = {
  id: "observation_upper",
  name: "Observation sphere — rotating floor",
  elevation: OBS_HIGH,
  height: 3.6,
  autoSlab: false,
  slabs: [{ id: "rotating_deck", polygon: circle(0, 0, obsHighR, 48), thickness: 0.3, material: "concrete" }],
  rooms: [{ id: "rotating_deck_room", name: "Rotating observation deck (turns every 30 min)", polygon: circle(0, 0, obsHighR, 48), floorMaterial: "wood_floor_oak", ceilingMaterial: false }],
  railings: [deckRail(obsHighR - 0.5)],
  furniture: [
    ...[30, 150, 210, 330].map((a, i) => ({ id: `deck_bench${i}`, type: "bench", position: polar(7.1, a), rotation: facingDeg(a), width: 1.6 })),
    { id: "food_stand", type: "kitchen_counter", position: polar(5.5, 90), rotation: facingDeg(90), width: 2.0, materials: { counter: "marble_white" } },
    ...[-0.6, 0.6].map((dx, i) => ({ id: `deck_stool${i}`, type: "bar_stool", position: [dx, 6.45] as P, rotation: facingDeg(270) })),
    { id: "lift_door_obs_upper", type: "box", position: polar(4.45, LIFT), width: 1.2, depth: 0.1, height: 2.3, materials: { main: "metal_steel" } },
  ],
};
levels.push(obsUpper);

const project = {
  name: "Kuwait Towers",
  description:
    "The Kuwait Towers (1979, VBB / Sune Lindström & Malene Bjørn): main tower 187 m with a restaurant sphere and a revolving observation sphere, second tower 147 m (water), third tower 113 m (floodlights). Spheres clad in enamelled steel discs. Dimensions measured from the perspective-corrected Wikipedia photo scaled to the published heights (±5%).",
  defaults: { wallThickness: 0.2, exteriorWallThickness: 0.3, wallMaterial: "paint_white", exteriorMaterial: "kt_white" },
  site: { ground: false },
  materials: {
    kt_white: { base: "plaster_white", color: "#f3f3f0", roughness: 0.6 },
    // dark blue-gray solar glazing, denser than plain tinted glass
    kt_glass: { base: "glass_tinted", color: "#3d4f5c", opacity: 0.62, roughness: 0.05 },
    // enamelled discs of varied sizes on a light steel backing (Wikipedia close-up)
    kt_discs: {
      base: "enamel_discs",
      scale: DISC_TILE,
      metalness: 0.15,
      roughness: 0.3,
      params: {
        cols: 8,
        rows: 8,
        size: 0.92,
        jitter: 0.35,
        palette: "#2d4f86,#3e6fae,#3e6fae,#5a93c9,#86b8de,#86b8de,#3f9e9a,#6cc3bd,#a9dbd6,#e6eef0,#e6eef0,#5c7d99",
        background: "#bdb8ab",
      },
    },
  },
  levels,
  elevators: [
    {
      id: "main_lift",
      stops: [
        { level: "plaza", at: polar(12.2, LIFT) },
        { level: "cafe", at: polar(6.6, LIFT) },
        { level: "horizon", at: polar(6.6, LIFT) },
        { level: "observation_lower", at: polar(5.9, LIFT) },
        { level: "observation_upper", at: polar(5.9, LIFT) },
      ],
    },
  ],
};

writeFileSync(new URL("../examples/kuwait_towers.json", import.meta.url), JSON.stringify(project, null, 1) + "\n");
console.log(`wrote examples/kuwait_towers.json (${levels.length} levels)`);
