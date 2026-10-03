/**
 * Lighting design: light fixtures (`level.lights`) with visible geometry and real punctual lights.
 *
 * Every fixture becomes a node of kind "light_fixture" (pivot at its mount point, emissive parts in
 * its meshes) with one or more child nodes of kind "light" whose `extras.light` holds a
 * {@link LightInfo}: physical intensity in candela, linear color from the color temperature, spot
 * cone angles and the emission direction in the node's local (plan, Z-up) frame. The glTF exporter
 * turns those into KHR_lights_punctual lights; the software renderer lights night renders with them.
 *
 * Furniture lamps (floor_lamp, table_lamp, ceiling_light) get an automatic warm light too.
 */
import { z } from "zod";
import type { Document, Node as GNode } from "@gltf-transform/core";
import { KHRLightsPunctual } from "@gltf-transform/extensions";
import { m4, pointInPolygon, pointSegment, polygonArea, polygonCentroid, v2, v3, type Mat4, type Vec2, type Vec3 } from "../geometry/math.js";
import { MeshBuilder } from "../geometry/mesh.js";
import { nodeLocalMatrix, type SceneNode } from "../geometry/scene.js";
import { Direction, Id, Mat, Point } from "../schema/common.js";
import type { Furniture, Level, Project, Room } from "../schema/schema.js";
import { FURNITURE } from "./furniture.js";
import { segDir, segLength, type WallSegment } from "./walls.js";

// ---------------------------------------------------------------- schema

export const LIGHT_TYPES = ["pendant", "chandelier", "ceiling", "downlight", "spot", "track", "wall_sconce", "strip", "uplight"] as const;
export type LightType = (typeof LIGHT_TYPES)[number];

export const LightSchema = z
  .object({
    id: Id.optional(),
    type: z
      .enum(LIGHT_TYPES)
      .describe(
        "pendant (shade on a cord) | chandelier | ceiling (flush / semi-flush) | downlight (recessed, trim flush with the ceiling) | spot (surface spot, aimable) | track (rail with spot heads along `points`) | wall_sconce | strip (LED strip along `points`: under cabinets, coves, stairs) | uplight (floor canister washing a wall/plant)",
      ),
    position: Point.optional().describe("Plan point of the fixture. wall_sconce: a point at/near the wall face, it snaps onto the nearest wall"),
    room: z
      .string()
      .optional()
      .describe("Room id or name. Without `position`: downlight/spot fill the room with an even GRID (see spacing/margin); other types go to the room's centre"),
    spacing: z.number().positive().default(1.2).describe("Grid: distance between fixtures (m)"),
    margin: z.number().min(0).optional().describe("Grid: distance from the room outline (wall centerlines) to the outer fixtures. Default spacing/2"),
    points: z.array(Point).min(2).optional().describe("strip / track: path of the strip or rail in plan"),
    height: z
      .union([z.number(), z.literal("ceiling")])
      .optional()
      .describe(
        "Mount height above the floor, or 'ceiling' (snaps to the room's ceiling). Default: 'ceiling' for ceiling fixtures; wall_sconce 1.8 (centre); strip 1.4 (underside of wall cabinets); uplight 0",
      ),
    hangHeight: z
      .number()
      .positive()
      .optional()
      .describe("pendant / chandelier: height of the fixture's BOTTOM above the floor. Over a dining table ~1.5-1.6 (0.75 m above the top); elsewhere keep >= 2.0. Default: ceiling - 0.6 (min 2.05)"),
    shade: z.enum(["dome", "globe", "cone", "drum", "cluster"]).default("dome").describe("pendant shade style"),
    style: z
      .string()
      .optional()
      .describe("ceiling: flush | semi_flush. wall_sconce: updown | up | down | glow. downlight: round | square"),
    size: z.number().positive().optional().describe("Shade / fixture diameter (m). Defaults: dome 0.4, globe 0.3, cone 0.3, drum 0.5, cluster 0.5, chandelier 0.7, ceiling 0.4, downlight 0.1"),
    count: z.number().int().min(1).max(24).optional().describe("chandelier arms (default 6), cluster globes (default 5), track heads (default 3)"),
    kelvin: z.number().min(1000).max(10000).default(2700).describe("Color temperature: 2700 warm (living, bedroom), 3000 (kitchen, bath), 4000 neutral (work), 5000+ cool"),
    lumens: z
      .number()
      .positive()
      .optional()
      .describe("Light output per fixture (strip: per meter). Defaults: pendant 800, chandelier 2400, ceiling 1600, downlight 550, spot/track head 450, wall_sconce 450, strip 400/m, uplight 350"),
    dim: z.number().min(0).max(1).default(1).describe("Dimmer level multiplying the output (0 = off)"),
    color: z.string().optional().describe("Colored light '#rrggbb' instead of a white color temperature"),
    beamAngle: z.number().min(5).max(170).optional().describe("Full beam angle in degrees (downlight 60, spot/track 36, uplight 40)"),
    aim: z
      .tuple([z.number(), z.number(), z.number()])
      .optional()
      .describe("spot / track / uplight: point [x, y, z] (z above the floor) the beam is aimed at. Default: straight down (uplight: up)"),
    direction: z.enum(["down", "up"]).default("down").describe("strip: which way it shines (under-cabinet / stair: down, cove: up)"),
    facing: Direction.optional().describe("wall_sconce: the direction it faces (away from the wall); auto-detected from the nearest wall"),
    material: Mat.optional().describe("Fixture body / shade outside (default metal_black; downlight trim plastic_white)"),
    shadeMaterial: Mat.optional().describe("drum shade fabric (default linen_white)"),
    castShadow: z.boolean().optional().describe("Hint for renderers/engines that this light should cast shadows (default true except downlights and strips)"),
  })
  .describe("Light fixture with a real light source (exported as KHR_lights_punctual; lights night renders)");

export type LightSpec = z.output<typeof LightSchema>;

/** Physical light attached to a scene node (`extras.light` of a node of kind "light"). */
export interface LightInfo {
  type: "point" | "spot";
  /** Linear RGB, max component 1. */
  color: [number, number, number];
  /** Luminous intensity in candela (KHR_lights_punctual units). */
  intensity: number;
  /** Distance cutoff (m), sized to the room. */
  range?: number;
  /** Spot cone half-angles (radians). */
  innerConeAngle?: number;
  outerConeAngle?: number;
  /** Emission axis (spots), unit vector in the node's local plan frame (Z up). */
  direction: Vec3;
  castShadow: boolean;
  kelvin: number;
  lumens: number;
}

// ---------------------------------------------------------------- photometry

/** Black-body color temperature to linear RGB (unnormalized), Tanner Helland's fit. */
function blackbody(k: number): [number, number, number] {
  const t = Math.max(1000, Math.min(40000, k)) / 100;
  let r: number, g: number, b: number;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  return [r, g, b].map((c) => {
    const s = Math.max(0, Math.min(255, c)) / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
}

/**
 * White point the light colors are balanced for, like a camera's white balance indoors. Unbalanced,
 * 2700 K comes out deep orange next to the white emissive bulbs; balanced to 3800 K (and slightly
 * desaturated) it reads as warm white.
 */
export const WHITE_BALANCE_K = 3800;

/** Color temperature to linear RGB (max channel 1), white-balanced to {@link WHITE_BALANCE_K}. */
export function kelvinToLinearRGB(k: number): [number, number, number] {
  const c = blackbody(k), wb = blackbody(WHITE_BALANCE_K);
  // slightly desaturated (exponent < 1): renders and engines show no lurid oranges/blues
  const lin = [c[0] / wb[0], c[1] / wb[1], c[2] / wb[2]].map((v) => Math.pow(v, 0.8));
  const m = Math.max(...lin);
  return [lin[0] / m, lin[1] / m, lin[2] / m];
}

function hexToLinear(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const lin = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  const mx = Math.max(...lin, 1e-6);
  return [lin[0] / mx, lin[1] / mx, lin[2] / mx];
}

/** Point light: lumens spread over the full sphere. */
export const pointCandela = (lm: number) => lm / (4 * Math.PI);
/** Spot light: lumens spread over the cone's solid angle 2π(1 - cos(half angle)). */
export const spotCandela = (lm: number, halfAngle: number) => lm / (2 * Math.PI * (1 - Math.cos(Math.min(halfAngle, Math.PI / 2))));

/**
 * Exposure used to display physical light (candela, lux) in renderers: radiance = albedo/π · E · NIGHT_EXPOSURE.
 * ~150 lux on a white wall comes out mid-bright. The viewer scales glTF light intensities by the same factor at night.
 */
export const NIGHT_EXPOSURE = 0.02;

const DEFAULT_LUMENS: Record<LightType, number> = {
  pendant: 800, chandelier: 2400, ceiling: 1600, downlight: 550, spot: 450, track: 450, wall_sconce: 450, strip: 400, uplight: 350,
};
const DEFAULT_BEAM: Partial<Record<LightType, number>> = { downlight: 60, spot: 36, track: 36, uplight: 40 };
const CEILING_TYPES = new Set<LightType>(["pendant", "chandelier", "ceiling", "downlight", "spot", "track"]);
const GRID_TYPES = new Set<LightType>(["downlight", "spot"]);
/** Furniture a pendant may hang low over. */
const LOW_PENDANT_OK = new Set(["table", "dining_table", "kitchen_island", "desk", "coffee_table", "side_table", "nightstand", "bedside_table", "dresser", "outdoor_table", "kitchen_counter", "bar_counter", "bed"]);
const DEG = Math.PI / 180;

// ---------------------------------------------------------------- build context

export interface LightContext {
  project: Project;
  levelIndex: number;
  /** Level elevation. */
  z: number;
  /** Default ceiling height above the level elevation. */
  ceilingH: number;
  segments: WallSegment[];
  warn(msg: string): void;
  err(msg: string): void;
}

interface Emitter {
  pos: Vec3;
  dir: Vec3;
  type: "point" | "spot";
  lumens: number;
  inner?: number;
  outer?: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const fmtP = (p: Vec2) => `[${r2(p[0])}, ${r2(p[1])}]`;

function circle(r: number, n = 24, cx = 0, cy = 0): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) out.push([cx + Math.cos((i / n) * 2 * Math.PI) * r, cy + Math.sin((i / n) * 2 * Math.PI) * r]);
  return out;
}

function findRoom(rooms: Room[], key: string): Room | undefined {
  const k = key.toLowerCase();
  return rooms.find((r) => r.id === key) ?? rooms.find((r) => r.name.toLowerCase() === k);
}

function roomAt(rooms: Room[], p: Vec2): Room | undefined {
  return rooms.find((r) => pointInPolygon(p, r.polygon as Vec2[]));
}

/** Distance from p to the polygon outline. */
function edgeDistance(p: Vec2, poly: Vec2[]): number {
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) d = Math.min(d, pointSegment(p, poly[i], poly[(i + 1) % poly.length]).dist);
  return d;
}

/** Even grid of points inside a room polygon (centered, `margin` from the outline). */
export function gridPoints(poly: Vec2[], spacing: number, margin?: number): Vec2[] {
  const m = margin ?? spacing / 2;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of poly) {
    x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]);
    y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
  }
  const axis = (a: number, b: number): number[] => {
    const span = b - a - 2 * m;
    if (span <= 1e-6) return [(a + b) / 2];
    const n = Math.max(1, Math.round(span / spacing) + 1);
    if (n === 1) return [(a + b) / 2];
    return Array.from({ length: n }, (_, i) => a + m + (span * i) / (n - 1));
  };
  const out: Vec2[] = [];
  for (const y of axis(y0, y1))
    for (const x of axis(x0, x1)) {
      const p: Vec2 = [x, y];
      if (pointInPolygon(p, poly) && edgeDistance(p, poly) >= Math.min(m, spacing / 2) * 0.7) out.push(p);
    }
  return out;
}

/** Ceiling height (above level elevation) of the room at p. */
function ceilingAt(ctx: LightContext, rooms: Room[], p: Vec2): number {
  const r = roomAt(rooms, p);
  return r?.ceilingHeight ?? ctx.ceilingH;
}

// ---------------------------------------------------------------- geometry helpers

/** Bowl / dome surface by revolving a quarter ellipse. Open side at z = 0 when `down`. */
function shell(mb: MeshBuilder, outer: string, inner: string | null, cz: number, R: number, H: number, topR: number, shape: "dome" | "cone", openDown = true) {
  const prof: Vec2[] = [];
  const n = shape === "cone" ? 1 : 10;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const r = shape === "cone" ? R + (topR - R) * t : topR + (R - topR) * Math.cos((t * Math.PI) / 2);
    const h = shape === "cone" ? H * t : H * Math.sin((t * Math.PI) / 2);
    prof.push([r, h]);
  }
  if (!openDown) {
    // bowl opening upward: mirror the profile (bottom = small radius)
    const mir = prof.map(([r, h]) => [r, H - h] as Vec2).reverse();
    mb.lathe(mir, () => outer, [0, 0, cz], 28);
    if (inner) mb.lathe(mir.map(([r, h]) => [Math.max(0, r - 0.003), h] as Vec2), () => inner, [0, 0, cz], 28, { inward: true });
    return;
  }
  mb.lathe(prof, () => outer, [0, 0, cz], 28);
  if (inner) mb.lathe(prof.map(([r, h]) => [Math.max(0, r - 0.003), h] as Vec2), () => inner, [0, 0, cz], 28, { inward: true });
  // rolled rim
  mb.flat(outer, circle(R, 28), cz, true, [circle(R - 0.004, 28)]);
}

/** Frame whose +Z points along `dir` with origin `o`. */
function alongFrame(dir: Vec3, o: Vec3): Mat4 {
  const zA = v3.norm(dir);
  const ref: Vec3 = Math.abs(zA[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const xA = v3.norm(v3.cross(ref, zA));
  const yA = v3.cross(zA, xA);
  return m4.fromBasis(xA, yA, zA, o);
}

/** Cylindrical spot head at `o` shining along `dir`; returns the lens centre. */
function spotHead(mb: MeshBuilder, mat: string, o: Vec3, dir: Vec3, len = 0.12, r = 0.035): Vec3 {
  mb.with(alongFrame(dir, o), () => {
    mb.cylinder(mat, [0, 0, -len * 0.25], r, r, len, 20, { top: false, bottom: true });
    mb.flat("emissive_light", circle(r - 0.005, 20), len * 0.75 - 0.006, false);
    mb.lathe([[r - 0.004, len * 0.75 - 0.03], [r - 0.004, len * 0.75]], () => mat, [0, 0, 0], 20, { inward: true });
  });
  return v3.add(o, v3.scale(v3.norm(dir), len * 0.75 + 0.01));
}

function coneAngles(beamDeg: number): { inner: number; outer: number } {
  const half = (beamDeg / 2) * DEG;
  return { inner: Math.min(half * 0.65, Math.PI / 2 - 0.02), outer: Math.min(half * 1.35, Math.PI / 2) };
}

// ---------------------------------------------------------------- fixtures

interface Placed {
  name: string;
  spec: LightSpec;
  /** Plan position of the pivot. */
  at: Vec2;
  /** Pivot height above the level elevation. */
  mountZ: number;
  rotZ: number;
  ceilZ: number;
}

/** Build fixture geometry + emitters in the pivot's local frame. */
function buildFixture(p: Placed, mb: MeshBuilder, ctx: LightContext): Emitter[] {
  const s = p.spec;
  const mat = s.material ?? (s.type === "downlight" ? "plastic_white" : "metal_black");
  const lm = (s.lumens ?? DEFAULT_LUMENS[s.type]) * s.dim;
  const down: Vec3 = [0, 0, -1], up: Vec3 = [0, 0, 1];
  const style = s.style;
  switch (s.type) {
    case "pendant":
    case "chandelier": {
      const hang = s.hangHeight ?? Math.min(p.ceilZ - 0.3, Math.max(2.05, p.ceilZ - 0.6));
      const bottom = hang - p.mountZ; // negative: below the canopy
      if (s.type === "chandelier") {
        const R = (s.size ?? 0.7) / 2, n = s.count ?? 6;
        const armZ = bottom + 0.12;
        mb.cylinder(mat, [0, 0, -0.03], 0.07, 0.07, 0.03, 20, { top: false });
        mb.rod(mat, [0, 0, -0.03], [0, 0, armZ + 0.32], 0.008, 8);
        mb.cylinder(mat, [0, 0, bottom], 0.02, 0.045, 0.12, 16);
        mb.sphere(mat, [0, 0, armZ + 0.1], 0.06, 16, 10, [1, 1, 1.6]);
        mb.cylinder(mat, [0, 0, armZ + 0.1], 0.015, 0.015, 0.22, 8, { bottom: false });
        for (let i = 0; i < n; i++) {
          const a = (i / n) * 2 * Math.PI, c = Math.cos(a), sn = Math.sin(a);
          // S-curved arm: out and up
          mb.rod(mat, [c * 0.04, sn * 0.04, armZ + 0.06], [c * R * 0.55, sn * R * 0.55, armZ], 0.007, 6);
          mb.rod(mat, [c * R * 0.55, sn * R * 0.55, armZ], [c * (R - 0.02), sn * (R - 0.02), armZ + 0.08], 0.007, 6);
          const cx = c * (R - 0.02), cy = sn * (R - 0.02);
          mb.cylinder(mat, [cx, cy, armZ + 0.08], 0.03, 0.035, 0.015, 14);
          mb.cylinder("plastic_white", [cx, cy, armZ + 0.095], 0.012, 0.012, 0.08, 10, { bottom: false });
          mb.sphere("emissive_light", [cx, cy, armZ + 0.195], 0.016, 10, 8, [1, 1, 1.7]);
        }
        // top ring tying the arms
        return [{ pos: [0, 0, armZ + 0.19], dir: down, type: "point", lumens: lm }];
      }
      const shade = s.shade;
      const D = s.size ?? { dome: 0.4, globe: 0.3, cone: 0.3, drum: 0.5, cluster: 0.5 }[shade];
      const R = D / 2;
      if (shade === "cluster") {
        const n = s.count ?? 5;
        mb.cylinder(mat, [0, 0, -0.025], R * 0.5, R * 0.5, 0.025, 24, { top: false });
        let cz = 0;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * 2 * Math.PI + 0.4;
          const rr = i === 0 && n > 3 ? 0 : R * 0.42;
          const x = Math.cos(a) * rr, y = Math.sin(a) * rr;
          const gr = 0.065 + 0.012 * ((i * 7) % 3);
          const zc = bottom + gr + ((i * 5) % 4) * 0.09;
          cz += zc;
          mb.rod(mat, [x, y, -0.025], [x, y, zc + gr], 0.002, 4);
          mb.cylinder(mat, [x, y, zc + gr * 0.85], 0.012, 0.012, 0.03, 10);
          mb.sphere("emissive_light", [x, y, zc], gr, 18, 12);
        }
        return [{ pos: [0, 0, cz / n], dir: down, type: "point", lumens: lm }];
      }
      mb.cylinder(mat, [0, 0, -0.025], 0.06, 0.06, 0.025, 20, { top: false });
      if (shade === "globe") {
        const zc = bottom + R;
        mb.rod(mat, [0, 0, -0.025], [0, 0, zc + R + 0.03], 0.003, 6);
        mb.cylinder(mat, [0, 0, zc + R * 0.9], 0.04, 0.035, 0.05, 16);
        mb.sphere("emissive_light", [0, 0, zc], R, 28, 18);
        return [{ pos: [0, 0, zc], dir: down, type: "point", lumens: lm }];
      }
      if (shade === "drum") {
        const H = Math.min(0.35, D * 0.6);
        const sm = s.shadeMaterial ?? "linen_white";
        mb.rod(mat, [0, 0, -0.025], [0, 0, bottom + H * 0.6], 0.003, 6);
        mb.cylinder(sm, [0, 0, bottom], R, R, H, 32, { top: false, bottom: false });
        mb.lathe([[R - 0.003, 0], [R - 0.003, H]], () => sm, [0, 0, bottom], 32, { inward: true });
        mb.flat("emissive_light", circle(R - 0.005, 32), bottom + 0.015, true);
        for (let i = 0; i < 3; i++) {
          const a = (i / 3) * 2 * Math.PI;
          mb.rod(mat, [0, 0, bottom + H * 0.6], [Math.cos(a) * (R - 0.004), Math.sin(a) * (R - 0.004), bottom + H - 0.005], 0.0025, 4);
        }
        return [{ pos: [0, 0, bottom + H * 0.45], dir: down, type: "point", lumens: lm }];
      }
      // dome / cone: opaque metal shade, white inside, light pours downward
      const H = shade === "dome" ? R * 0.8 : R * 1.15;
      mb.rod(mat, [0, 0, -0.025], [0, 0, bottom + H], 0.003, 6);
      shell(mb, mat, "plastic_white", bottom, R, H, 0.03, shade === "dome" ? "dome" : "cone");
      mb.sphere("emissive_light", [0, 0, bottom + H * 0.35], Math.min(0.045, R * 0.3), 14, 10);
      const ang = shade === "dome" ? { inner: 45 * DEG, outer: 72 * DEG } : { inner: 30 * DEG, outer: 55 * DEG };
      return [{ pos: [0, 0, bottom + H * 0.3], dir: down, type: "spot", lumens: lm, ...ang }];
    }
    case "ceiling": {
      const R = (s.size ?? 0.4) / 2;
      if (style === "semi_flush") {
        mb.cylinder(mat, [0, 0, -0.025], 0.07, 0.07, 0.025, 20, { top: false });
        mb.rod(mat, [0, 0, -0.025], [0, 0, -0.17], 0.006, 6);
        shell(mb, "emissive_light", null, -0.17 - R * 0.45, R, R * 0.45, 0.02, "dome", false);
        mb.flat(mat, circle(R, 28), -0.17, true, [circle(R - 0.012, 28)]);
        return [{ pos: [0, 0, -0.2], dir: down, type: "point", lumens: lm }];
      }
      // flush: metal rim + shallow opal diffuser
      mb.cylinder(mat, [0, 0, -0.03], R, R, 0.03, 32, { top: false, bottom: false });
      mb.flat(mat, circle(R, 32), -0.03, true, [circle(R * 0.9, 32)]);
      shell(mb, "emissive_light", null, -0.03 - R * 0.18, R * 0.9, R * 0.18, 0.001, "dome", false);
      return [{ pos: [0, 0, -0.06], dir: down, type: "spot", lumens: lm, inner: 50 * DEG, outer: 88 * DEG }];
    }
    case "downlight": {
      const R = (s.size ?? 0.1) / 2;
      const beam = coneAngles(s.beamAngle ?? DEFAULT_BEAM.downlight!);
      if (style === "square") {
        const sq = (r: number): Vec2[] => [[-r, -r], [r, -r], [r, r], [-r, r]];
        mb.flat(mat, sq(R), -0.004, true, [sq(R * 0.78)]);
        mb.flat("emissive_light", sq(R * 0.78), -0.002, true);
        mb.box(mat, [-R, -R, -0.004], [R, R, 0], { skip: ["+z", "-z"] });
      } else {
        mb.flat(mat, circle(R, 24), -0.004, true, [circle(R * 0.78, 24)]);
        mb.flat("emissive_light", circle(R * 0.78, 24), -0.002, true);
        mb.cylinder(mat, [0, 0, -0.004], R, R, 0.004, 24, { top: false, bottom: false });
      }
      return [{ pos: [0, 0, -0.03], dir: down, type: "spot", lumens: lm, ...beam }];
    }
    case "spot": {
      const beam = coneAngles(s.beamAngle ?? DEFAULT_BEAM.spot!);
      mb.cylinder(mat, [0, 0, -0.02], 0.045, 0.045, 0.02, 20, { top: false });
      const pivot: Vec3 = [0, 0, -0.08];
      mb.rod(mat, [0, 0, -0.02], pivot, 0.008, 8);
      const dir = aimDir(s, p, pivot, ctx, down);
      const lens = spotHead(mb, mat, pivot, dir);
      return [{ pos: lens, dir, type: "spot", lumens: lm, ...beam }];
    }
    case "track": {
      // geometry in level-plan coordinates relative to the pivot (= first point)
      const pts = (s.points ?? []) as Vec2[];
      const beam = coneAngles(s.beamAngle ?? DEFAULT_BEAM.track!);
      const rel = pts.map((q) => [q[0] - p.at[0], q[1] - p.at[1]] as Vec2);
      const lens = rel.slice(1).map((q, i) => v2.dist(q, rel[i]));
      const total = lens.reduce((a, b) => a + b, 0);
      for (let i = 0; i + 1 < rel.length; i++) {
        const a = rel[i], b = rel[i + 1];
        const d = v2.norm(v2.sub(b, a));
        mb.with(m4.fromBasis([d[0], d[1], 0], [-d[1], d[0], 0], [0, 0, 1], [a[0], a[1], 0]), () =>
          mb.box(mat, [-0.015, -0.017, -0.035], [lens[i] + 0.015, 0.017, 0]),
        );
      }
      const n = s.count ?? 3;
      const out: Emitter[] = [];
      for (let k = 0; k < n; k++) {
        const at = pathPoint(rel, lens, total * ((k + 0.5) / n));
        const pivot: Vec3 = [at[0], at[1], -0.1];
        mb.rod(mat, [at[0], at[1], -0.035], pivot, 0.008, 8);
        const dir = aimDir(s, p, pivot, ctx, down);
        out.push({ pos: spotHead(mb, mat, pivot, dir), dir, type: "spot", lumens: lm, ...beam });
      }
      return out;
    }
    case "wall_sconce": {
      // local frame: origin on the wall face at the mount height, +y out of the wall
      const st = style ?? "updown";
      mb.box(mat, [-0.04, 0, -0.07], [0.04, 0.012, 0.07]);
      const y = 0.11;
      mb.rod(mat, [0, 0.012, 0], [0, y - 0.035, 0], 0.008, 8);
      const ang = { inner: 18 * DEG, outer: 45 * DEG };
      if (st === "glow") {
        mb.sphere("emissive_light", [0, y, 0], 0.07, 20, 12, [1, 0.75, 1.3]);
        return [{ pos: [0, y, 0], dir: down, type: "point", lumens: lm }];
      }
      if (st === "up" || st === "down") {
        const isUp = st === "up";
        mb.with(m4.translation(0, y, 0), () =>
          mb.with(isUp ? m4.rotationX(Math.PI) : m4.identity(), () => shell(mb, mat, "plastic_white", -0.04, 0.08, 0.1, 0.025, "cone")),
        );
        mb.flat("emissive_light", circle(0.05, 20, 0, y), isUp ? 0.02 : -0.02, !isUp);
        return [{ pos: [0, y, isUp ? 0.03 : -0.03], dir: isUp ? up : down, type: "spot", lumens: lm, inner: 25 * DEG, outer: 60 * DEG }];
      }
      // up/down cylinder
      mb.cylinder(mat, [0, y, -0.09], 0.04, 0.04, 0.18, 24, { top: false, bottom: false });
      mb.lathe([[0.037, -0.09], [0.037, 0.09]], () => "plastic_white", [0, y, 0], 24, { inward: true });
      mb.flat("emissive_light", circle(0.034, 20, 0, y), -0.06, true);
      mb.flat("emissive_light", circle(0.034, 20, 0, y), 0.06, false);
      return [
        { pos: [0, y, 0.1], dir: up, type: "spot", lumens: lm / 2, ...ang },
        { pos: [0, y, -0.1], dir: down, type: "spot", lumens: lm / 2, ...ang },
      ];
    }
    case "strip": {
      const pts = ((s.points ?? []) as Vec2[]).map((q) => [q[0] - p.at[0], q[1] - p.at[1]] as Vec2);
      const lens = pts.slice(1).map((q, i) => v2.dist(q, pts[i]));
      const total = lens.reduce((a, b) => a + b, 0);
      const isUp = s.direction === "up";
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i], b = pts[i + 1];
        const d = v2.norm(v2.sub(b, a));
        mb.with(m4.fromBasis([d[0], d[1], 0], [-d[1], d[0], 0], [0, 0, 1], [a[0], a[1], 0]), () => {
          const z0 = isUp ? 0 : -0.009, z1 = isUp ? 0.009 : 0;
          mb.box("metal_aluminum", [0, -0.008, z0], [lens[i], 0.008, z1], { skip: [isUp ? "+z" : "-z"] });
          const ez = isUp ? z1 : z0;
          mb.quad(
            "emissive_light",
            [0, -0.006, ez], [lens[i], -0.006, ez], [lens[i], 0.006, ez], [0, 0.006, ez],
          );
          if (!isUp) mb.flat("emissive_light", [[0, -0.006], [lens[i], -0.006], [lens[i], 0.006], [0, 0.006]], z0, true);
          else mb.flat("emissive_light", [[0, -0.006], [lens[i], -0.006], [lens[i], 0.006], [0, 0.006]], z1, false);
        });
      }
      // one emitter per ~0.9 m (max 6) keeps engines happy
      const n = Math.max(1, Math.min(6, Math.ceil(total / 0.9)));
      const out: Emitter[] = [];
      for (let k = 0; k < n; k++) {
        const at = pathPoint(pts, lens, total * ((k + 0.5) / n));
        out.push({
          pos: [at[0], at[1], isUp ? 0.02 : -0.02],
          dir: isUp ? up : down,
          type: "spot",
          lumens: (lm * total) / n,
          inner: 35 * DEG,
          outer: 80 * DEG,
        });
      }
      return out;
    }
    case "uplight": {
      const beam = coneAngles(s.beamAngle ?? DEFAULT_BEAM.uplight!);
      mb.cylinder(mat, [0, 0, 0], 0.07, 0.065, 0.09, 24, { bottom: false });
      mb.flat("emissive_light", circle(0.05, 20), 0.0905, false);
      const dir = aimDir(s, p, [0, 0, 0.1], ctx, up);
      return [{ pos: [0, 0, 0.1], dir, type: "spot", lumens: lm, ...beam }];
    }
  }
}

function pathPoint(pts: Vec2[], lens: number[], t: number): Vec2 {
  for (let i = 0; i < lens.length; i++) {
    if (t <= lens[i] || i === lens.length - 1) return v2.lerp(pts[i], pts[i + 1], lens[i] > 0 ? Math.min(1, t / lens[i]) : 0);
    t -= lens[i];
  }
  return pts[0];
}

/** Aim direction in the pivot's local frame (fixtures with aim have no rotation). */
function aimDir(s: LightSpec, p: Placed, local: Vec3, _ctx: LightContext, fallback: Vec3): Vec3 {
  if (!s.aim) return fallback;
  const target: Vec3 = [s.aim[0] - p.at[0], s.aim[1] - p.at[1], s.aim[2] - p.mountZ];
  const d = v3.sub(target, local);
  return v3.len(d) > 1e-3 ? v3.norm(d) : fallback;
}

// ---------------------------------------------------------------- placement

function snapToWall(pos: Vec2, segs: WallSegment[], facing: number | undefined): { at: Vec2; rotZ: number } | null {
  let best: { seg: WallSegment; dist: number; t: number } | null = null;
  for (const s of segs) {
    const r = pointSegment(pos, s.a, s.b);
    if (r.dist < (best?.dist ?? Infinity)) best = { seg: s, dist: r.dist, t: r.t };
  }
  if (!best || best.dist > best.seg.thickness / 2 + 0.6) return null;
  const s = best.seg;
  const d = segDir(s);
  const left = v2.perp(d);
  const foot = v2.add(s.a, v2.scale(d, best.t * segLength(s)));
  let side = Math.sign(v2.dot(v2.sub(pos, foot), left));
  if (best.dist < 0.02) {
    if (facing !== undefined) side = Math.sign(Math.cos(facing * DEG) * left[0] + Math.sin(facing * DEG) * left[1]) || 1;
    else side = s.interiorSide === "left" ? 1 : -1;
  }
  const n = v2.scale(left, side || 1);
  const at = v2.add(foot, v2.scale(n, s.thickness / 2 + 0.002));
  return { at, rotZ: Math.atan2(n[1], n[0]) - Math.PI / 2 };
}

const toDeg = (d: number | "north" | "south" | "east" | "west") =>
  typeof d === "number" ? d : { east: 0, north: 90, west: 180, south: 270 }[d];

function place(lv: Level, s: LightSpec, i: number, ctx: LightContext): Placed[] {
  const rooms = lv.rooms;
  const base = s.id ?? `${s.type}${i}`;
  const where = `light '${base}'`;
  const mk = (at: Vec2, name: string, rotZ = 0): Placed => {
    const ceilZ = ceilingAt(ctx, rooms, at) - 0.01;
    const h = s.height ?? (CEILING_TYPES.has(s.type) ? "ceiling" : s.type === "wall_sconce" ? 1.8 : s.type === "strip" ? 1.4 : 0);
    let mountZ = h === "ceiling" ? ceilZ : h;
    if (s.type === "uplight" && h !== "ceiling") mountZ = h + 0.01;
    return { name, spec: s, at, mountZ, rotZ, ceilZ };
  };
  if (s.type === "strip" || s.type === "track") {
    if (!s.points) {
      ctx.err(`${where}: ${s.type} needs \`points\` (the path in plan)`);
      return [];
    }
    return [mk(s.points[0] as Vec2, base)];
  }
  if (!s.position) {
    if (!s.room) {
      ctx.err(`${where}: give \`position\` (or \`room\` for a grid / room-centre fixture)`);
      return [];
    }
    const room = findRoom(rooms, s.room);
    if (!room) {
      ctx.err(`${where}: room '${s.room}' not found on this level (rooms: ${rooms.map((r) => r.id ?? r.name).join(", ") || "none"})`);
      return [];
    }
    const poly = room.polygon as Vec2[];
    if (GRID_TYPES.has(s.type)) {
      const pts = gridPoints(poly, s.spacing, s.margin);
      if (!pts.length) ctx.warn(`${where}: the grid in room '${room.name}' is empty — reduce margin or spacing`);
      return pts.map((p, k) => mk(p, `${base}_${k + 1}`));
    }
    return [mk(polygonCentroid(poly), base)];
  }
  const pos = s.position as Vec2;
  if (s.type === "wall_sconce") {
    const snap = snapToWall(pos, ctx.segments, s.facing !== undefined ? toDeg(s.facing) : undefined);
    if (snap) return [mk(snap.at, base, snap.rotZ)];
    if (s.facing === undefined) ctx.warn(`${where} at ${fmtP(pos)} is not near a wall; give \`facing\` or move it onto a wall`);
    return [mk(pos, base, ((s.facing !== undefined ? toDeg(s.facing) : 270) - 90) * DEG)];
  }
  return [mk(pos, base)];
}

// ---------------------------------------------------------------- scene nodes

function roomRange(rooms: Room[], at: Vec2, pos: Vec3, z: number, ceil: number, cd: number): number {
  const room = roomAt(rooms, at);
  if (!room) return Math.min(30, Math.max(3, Math.sqrt(cd / 0.3)));
  let far = 0;
  for (const q of room.polygon as Vec2[])
    for (const qz of [z, z + ceil]) far = Math.max(far, Math.hypot(q[0] - pos[0], q[1] - pos[1], qz - pos[2]));
  return Math.round((far * 1.3 + 0.75) * 100) / 100;
}

function lightNodes(name: string, emitters: Emitter[], spec: { kelvin: number; color?: string; castShadow?: boolean; type: string }, rangeAt: (local: Vec3, cd: number) => number): SceneNode[] {
  const color = (spec.color && hexToLinear(spec.color)) || kelvinToLinearRGB(spec.kelvin);
  const shadowDefault = !(spec.type === "downlight" || spec.type === "strip");
  return emitters
    .filter((e) => e.lumens > 0)
    .map((e, k) => {
      const cd = e.type === "spot" ? spotCandela(e.lumens, e.outer!) : pointCandela(e.lumens);
      const light: LightInfo = {
        type: e.type,
        color: color.map((c) => Math.round(c * 1000) / 1000) as [number, number, number],
        intensity: Math.round(cd * 100) / 100,
        range: rangeAt(e.pos, cd),
        ...(e.type === "spot" ? { innerConeAngle: Math.round(e.inner! * 1e4) / 1e4, outerConeAngle: Math.round(e.outer! * 1e4) / 1e4 } : {}),
        direction: e.dir.map((v) => Math.round(v * 1e4) / 1e4) as Vec3,
        castShadow: spec.castShadow ?? shadowDefault,
        kelvin: spec.kelvin,
        lumens: Math.round(e.lumens),
      };
      return {
        name: emitters.length > 1 ? `${name}_light${k + 1}` : `${name}_light`,
        kind: "light",
        meshes: [],
        children: [],
        translation: e.pos,
        extras: { light },
      } satisfies SceneNode;
    });
}

/** Build the `lights` group of a level (fixtures with child light nodes) and run the lighting checks. */
export function buildLights(lv: Level, ctx: LightContext): SceneNode {
  const group: SceneNode = { name: "lights", kind: "group", meshes: [], children: [] };
  const placedAll: Placed[] = [];
  (lv.lights ?? []).forEach((s, i) => {
    for (const p of place(lv, s, i, ctx)) {
      const mb = new MeshBuilder();
      const emitters = buildFixture(p, mb, ctx);
      placedAll.push(p);
      const pivotWorld = m4.place(p.at[0], p.at[1], ctx.z + p.mountZ, p.rotZ);
      const rangeAt = (local: Vec3, cd: number) => {
        const w = m4.point(pivotWorld, local);
        return roomRange(lv.rooms, p.at, w, ctx.z, ceilingAt(ctx, lv.rooms, p.at), cd);
      };
      group.children.push({
        name: p.name,
        kind: "light_fixture",
        meshes: mb.meshes(),
        children: lightNodes(p.name, emitters, s, rangeAt),
        translation: [p.at[0], p.at[1], ctx.z + p.mountZ],
        rotationZ: p.rotZ || undefined,
        extras: { id: s.id, fixture: s.type, lumens: Math.round(emitters.reduce((a, e) => a + e.lumens, 0)), kelvin: s.kelvin },
      });
    }
  });
  checkLights(lv, placedAll, ctx);
  return group;
}

// ---------------------------------------------------------------- furniture lamps

/** Lamp furniture that gets a light automatically (opt out with options.light = false). */
export const LAMP_TYPES = new Set(["floor_lamp", "table_lamp", "ceiling_light", "lamp_post"]);

/** Attach a warm light to a lamp furniture node (floor_lamp, table_lamp, ceiling_light). */
export function addLampLight(node: SceneNode | undefined, f: Furniture, defaults: { width: number; depth: number; height: number }) {
  if (!node || !LAMP_TYPES.has(f.type) || f.options.light === false) return;
  const w = f.width ?? defaults.width, d = f.depth ?? defaults.depth, h = f.height ?? defaults.height;
  const o = f.options as Record<string, unknown>;
  const kelvin = typeof o.kelvin === "number" ? o.kelvin : 2700;
  let e: Emitter;
  if (f.type === "floor_lamp") {
    const sh = Math.min(0.4, Math.max(0.15, h * 0.2));
    e = { pos: [0, 0, h - sh + sh * 0.35], dir: [0, 0, -1], type: "point", lumens: 1200 };
  } else if (f.type === "lamp_post") {
    const head = Math.min(0.62, h * 0.2);
    e = { pos: [0, 0, h - head + 0.05 + head * 0.1 + head * 0.25], dir: [0, 0, -1], type: "point", lumens: 1500 };
  } else if (f.type === "table_lamp") {
    const sh = h * 0.42;
    e = { pos: [0, 0, h - sh + sh * 0.35], dir: [0, 0, -1], type: "point", lumens: 450 };
  } else {
    const R = Math.min(w, d) / 2 - 0.004;
    if (o.style === "flush") e = { pos: [0, 0, h * 0.3], dir: [0, 0, -1], type: "spot", lumens: 1100, inner: 50 * DEG, outer: 88 * DEG };
    else {
      const sh = Math.min(h * 0.45, R * 1.1);
      e = { pos: [0, 0, sh * 0.3], dir: [0, 0, -1], type: "spot", lumens: 1000, inner: 45 * DEG, outer: 72 * DEG };
    }
  }
  if (typeof o.lumens === "number" && o.lumens > 0) e.lumens = o.lumens;
  // range: generous (rooms aren't known here)
  const nodes = lightNodes(node.name, [e], { kelvin, castShadow: f.type !== "table_lamp" && f.type !== "lamp_post", type: f.type }, (_l, cd) =>
    Math.round(Math.min(12, Math.max(4, Math.sqrt(cd / 0.4))) * 100) / 100,
  );
  node.children.push(...nodes);
  node.extras = { ...node.extras, lumens: e.lumens, kelvin };
}

// ---------------------------------------------------------------- checks

const TABLE_LIKE = (t: string) => LOW_PENDANT_OK.has(t) || /table|desk|island|counter/.test(t);

function furnitureRect(f: Furniture, dims: (t: string) => { width: number; depth: number } | undefined): Vec2[] | null {
  const dd = dims(f.type);
  const w = f.width ?? dd?.width ?? 0.6, d = f.depth ?? dd?.depth ?? 0.6;
  const rot = ((f.rotation ?? (f.facing ? { south: 0, east: 90, north: 180, west: 270 }[f.facing] : 0)) * Math.PI) / 180;
  const c = Math.cos(rot), s = Math.sin(rot);
  return ([[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]] as Vec2[]).map(([x, y]) => [
    f.position[0] + x * c - y * s,
    f.position[1] + x * s + y * c,
  ]);
}

const furnitureDims = (t: string) => FURNITURE[t]?.defaults;

function checkLights(lv: Level, placed: Placed[], ctx: LightContext) {
  const rooms = lv.rooms;
  for (const p of placed) {
    const s = p.spec;
    const where = `light '${p.name}'`;
    const room = roomAt(rooms, p.at);
    const onTerrace = lv.terraces.some((t) => pointInPolygon(p.at, t.polygon as Vec2[]));
    if (!room && !onTerrace && s.type !== "wall_sconce" && s.type !== "uplight")
      ctx.warn(`${where} at ${fmtP(p.at)} is not inside any room — move it into a room (or onto a terrace)`);
    if (typeof s.height === "number" && s.height > p.ceilZ + 0.011)
      ctx.warn(`${where}: height ${s.height} m is above the ceiling (${r2(p.ceilZ + 0.01)} m)${room ? ` of '${room.name}'` : ""}`);
    if (s.type === "pendant" || s.type === "chandelier") {
      const bottom = s.hangHeight ?? Math.min(p.ceilZ - 0.3, Math.max(2.05, p.ceilZ - 0.6));
      if (bottom >= p.ceilZ) ctx.warn(`${where}: hangHeight ${bottom} m is at or above the ceiling (${r2(p.ceilZ + 0.01)} m)`);
      else if (bottom < 2.0) {
        const over = lv.furniture.find((f) => {
          if (!TABLE_LIKE(f.type)) return false;
          const r = furnitureRect(f, furnitureDims);
          return !!r && (pointInPolygon(p.at, r) || edgeDistance(p.at, r) < 0.1);
        });
        // cabinetry counts too: pendants over an island or a counter run are task lights
        const overCasework = ((lv as unknown as { casework?: Record<string, any>[] }).casework ?? []).some((c) => {
          const depth = (c.depth ?? 0.6) + (c.island ? 0.45 : 0.1);
          if (Array.isArray(c.position)) {
            const rot = ((typeof c.rotation === "number" ? c.rotation : ({ south: 0, east: 90, north: 180, west: 270 } as Record<string, number>)[c.facing ?? "south"] ?? 0) * Math.PI) / 180;
            const dx = p.at[0] - c.position[0], dy = p.at[1] - c.position[1];
            const lx = dx * Math.cos(rot) + dy * Math.sin(rot), ly = -dx * Math.sin(rot) + dy * Math.cos(rot);
            return Math.abs(lx) <= (c.length ?? 2.4) / 2 + 0.1 && Math.abs(ly) <= depth / 2 + 0.25;
          }
          const path: Vec2[] = Array.isArray(c.path) ? c.path : [];
          return path.some((a, i) => i < path.length - 1 && edgeDistance(p.at, [a, path[i + 1]]) < depth);
        });
        if (!over && !overCasework)
          ctx.warn(
            `${where} hangs down to ${r2(bottom)} m over a walkway (keep >= 2.0 m, or hang it over a table / island / nightstand) — raise hangHeight or move it`,
          );
      }
    }
  }
}

/**
 * Rooms without any light (only when the plan uses lighting at all). Run once per project after
 * the build so lights from every level are known.
 */
export function checkUnlitRooms(project: Project): string[] {
  const out: string[] = [];
  // only plans with a lighting design (level.lights) are checked; a lone floor lamp doesn't count
  const hasLights = project.levels.some((lv) => (lv.lights ?? []).length > 0);
  if (!hasLights) return out;
  for (const lv of project.levels) {
    const pts: Vec2[] = [];
    for (const s of lv.lights ?? []) {
      if (s.position) pts.push(s.position as Vec2);
      if (s.points) for (let i = 0; i + 1 < s.points.length; i++) pts.push(v2.lerp(s.points[i] as Vec2, s.points[i + 1] as Vec2, 0.5));
      if (s.room && !s.position) {
        const r = findRoom(lv.rooms, s.room);
        if (r) pts.push(polygonCentroid(r.polygon as Vec2[]));
      }
    }
    for (const f of lv.furniture) if (LAMP_TYPES.has(f.type) && f.options.light !== false) pts.push(f.position as Vec2);
    for (const r of lv.rooms) {
      const poly = r.polygon as Vec2[];
      if (polygonArea(poly) < 2.5) continue;
      // sconces sit on the wall face: count points within 0.25 m of the room as inside
      if (!pts.some((p) => pointInPolygon(p, poly) || edgeDistance(p, poly) < 0.2))
        out.push(`level '${lv.id}': room '${r.name}' has no light — add a ceiling fixture, downlights (\`{"type":"downlight","room":"${r.id ?? r.name}"}\`) or a lamp`);
    }
  }
  return out;
}

// ---------------------------------------------------------------- consumers

export interface WorldLight extends LightInfo {
  name: string;
  /** World position (plan space, Z up). */
  position: Vec3;
  /** World emission direction (unit). */
  worldDirection: Vec3;
}

/** All lights in a scene with world transforms. */
export function collectLights(root: SceneNode): WorldLight[] {
  const out: WorldLight[] = [];
  const visit = (n: SceneNode, parent: Mat4) => {
    const world = n.translation || n.rotationZ ? m4.mul(parent, nodeLocalMatrix(n)) : parent;
    const L = n.extras?.light as LightInfo | undefined;
    if (n.kind === "light" && L) {
      const o = m4.point(world, [0, 0, 0]);
      const d = v3.norm(v3.sub(m4.point(world, L.direction), o));
      out.push({ ...L, name: n.name, position: o, worldDirection: d });
    }
    for (const c of n.children) visit(c, world);
  };
  visit(root, m4.identity());
  return out;
}

const lightExt = new WeakMap<Document, KHRLightsPunctual>();

/**
 * glTF: attach a KHR_lights_punctual light to a converted node of kind "light" and orient it
 * (glTF spots shine along the node's local -Z). `s` = -1 for unityAxes.
 */
export function attachGltfLight(doc: Document, g: GNode, n: SceneNode, s: number) {
  const L = n.extras?.light as LightInfo | undefined;
  if (n.kind !== "light" || !L) return;
  let ext = lightExt.get(doc);
  if (!ext) lightExt.set(doc, (ext = doc.createExtension(KHRLightsPunctual)));
  const l = ext.createLight(n.name).setType(L.type).setColor(L.color).setIntensity(L.intensity);
  if (L.range) l.setRange(L.range);
  if (L.type === "spot") l.setInnerConeAngle(L.innerConeAngle ?? 0).setOuterConeAngle(L.outerConeAngle ?? Math.PI / 4);
  g.setExtension("KHR_lights_punctual", l);
  // plan (x, y, z) -> glTF (s x, z, -s y); rotate glTF -Z onto the direction
  const d = L.direction;
  const b = v3.norm([s * d[0], d[2], -s * d[1]]);
  // q = (a × b, 1 + a·b) with a = (0, 0, -1)
  let q: [number, number, number, number] = [b[1], -b[0], 0, 1 - b[2]];
  if (q[3] < 1e-6) q = [1, 0, 0, 0];
  const ql = Math.hypot(...q);
  g.setRotation(q.map((v) => v / ql) as [number, number, number, number]);
}
