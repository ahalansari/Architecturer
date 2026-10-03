import { z } from "zod";

/**
 * The building plan format. This is the main interface for AI agents:
 * every field has a description, and `z.toJSONSchema(ProjectSchema)` is served to them.
 *
 * Coordinates: meters. Plan x = east, plan y = north, z/height = up.
 * Angles: degrees, counter-clockwise, 0 = east (+x), 90 = north (+y).
 */

import { Direction, Id, Mat, Point, Polygon, Vec3 } from "./common.js";
import { StyleSchema } from "../elements/styles.js";
import { FinishesSchema } from "../elements/finishes.js";
import { LightSchema } from "../elements/lighting.js";
import { ElectricalSchema, PlumbingSchema, ServicesSchema } from "../elements/services.js";
import { ProductSchema } from "../elements/products.js";
import { TreatmentSchema } from "../elements/treatments.js";
import { CaseworkSchema } from "../elements/casework/schema.js";

export { Direction, Id, Mat, Point, Polygon, Vec3 };

export const CustomMaterialSchema = z
  .object({
    base: z.string().optional().describe("Library material, texture pattern, online material (ambientcg:<Id>, polyhaven:<id>) or RAL colour to start from, e.g. 'brick_red', 'plaster', 'polyhaven:herringbone_parquet', 'ral_7016'"),
    pattern: z.string().optional().describe("Texture pattern (brick, stone, plaster, concrete, wood_planks, wood_grain, tiles, marble, roof_tiles, shingles, metal, fabric, carpet, leather, grass, gravel, paving, siding, herringbone, chevron, parquet, terrazzo, hex_tiles, mosaic, zellige, wallpaper, fluted, microcement, grasscloth, none)"),
    color: z.union([z.string(), z.tuple([z.number(), z.number(), z.number()])]).optional().describe("Tint multiplied with the pattern / photo: '#rrggbb' or a RAL Classic code like 'ral 7016'"),
    roughness: z.number().min(0).max(1).optional(),
    metalness: z.number().min(0).max(1).optional(),
    scale: z.number().positive().optional().describe("Meters covered by one texture tile"),
    opacity: z.number().min(0).max(1).optional(),
    emissive: z.union([z.string(), z.tuple([z.number(), z.number(), z.number()])]).optional(),
    doubleSided: z.boolean().optional(),
    normalStrength: z.number().min(0).optional(),
    params: z.record(z.string(), z.union([z.number(), z.string()])).optional().describe("Pattern knobs, e.g. {mortar:'#ddd'} for brick, {count:4} for tiles"),
  })
  .describe("Custom material definition");

export const WallSchema = z
  .object({
    id: Id.optional(),
    points: z.array(Point).min(2).describe("Wall centerline as a polyline. Each consecutive pair is one wall segment."),
    closed: z.boolean().default(false).describe("Connect the last point back to the first (a closed loop, e.g. the exterior walls)"),
    thickness: z.number().positive().optional().describe("Default: project defaults.wallThickness (0.2)"),
    height: z.number().positive().optional().describe("Default: the level's wall height (level.height)"),
    baseOffset: z.number().default(0).describe("Bottom of the wall relative to the level elevation"),
    material: Mat.optional().describe("Material for both faces (overridden by the more specific fields)"),
    interiorMaterial: Mat.optional().describe("Closed loops only: face pointing inside the loop"),
    exteriorMaterial: Mat.optional().describe("Closed loops only: face pointing outside the loop"),
    leftMaterial: Mat.optional().describe("Face on the left when walking along the points"),
    rightMaterial: Mat.optional().describe("Face on the right when walking along the points"),
    topMaterial: Mat.optional(),
  })
  .describe("A wall or chain of walls. Corners and T-junctions between walls are joined automatically.");

export const OpeningSchema = z
  .object({
    id: Id.optional(),
    type: z.enum(["door", "window", "opening"]).describe("'opening' is an empty hole/archway with no frame"),
    wall: Id.optional().describe("Wall id to place the opening in. Optional when `at` is given."),
    at: Point.optional().describe("Plan point on (or near) the wall centerline where the CENTER of the opening goes. Easiest way to place openings."),
    offset: z.number().optional().describe("Alternative to `at`: distance along the wall's polyline from its first point to the opening center (requires `wall`)"),
    width: z.number().positive().optional().describe("Default: door 0.9, double door 1.6, window 1.2, opening 1.0"),
    height: z.number().positive().optional().describe("Default: door 2.1, window 1.2, opening 2.1"),
    sill: z.number().min(0).optional().describe("Height of the bottom of the opening above the floor. Default: window 0.9, others 0"),
    style: z
      .enum(["single", "double", "glass", "sliding", "garage", "fixed", "casement", "grid"])
      .optional()
      .describe("door: single | double | glass | sliding | garage. window: fixed | casement | grid (with muntins). Defaults: single / casement"),
    hinge: z.enum(["left", "right"]).default("left").describe("Doors: hinge at the start (left) or end (right) of the opening along the wall direction"),
    swing: z.enum(["in", "out"]).default("in").describe("Doors: open toward the wall's interior/left side ('in') or exterior/right side ('out')"),
    openAngle: z.number().min(0).max(180).default(0).describe("Doors: how far the leaf is open in degrees (0 = closed). Leaves are exported as separate nodes pivoting at the hinge."),
    frameMaterial: Mat.optional(),
    panelMaterial: Mat.optional().describe("Door leaf material"),
    glassMaterial: Mat.optional(),
    treatment: TreatmentSchema.optional().describe("Windows / glazed doors: curtains, sheers, blinds or shutters on the interior side"),
  })
  .describe("Door, window or empty opening cut into a wall");

export const RoomSchema = z
  .object({
    id: Id.optional(),
    name: z.string().describe("e.g. 'Kitchen'. Exported as metadata so games can find rooms."),
    polygon: Polygon.describe("Room outline. Using wall centerlines is fine; the floor extends under the walls."),
    floorMaterial: Mat.optional().describe("Default: wood_floor_oak"),
    ceilingMaterial: z.union([Mat, z.literal(false)]).optional().describe("Default: plaster_white. false = no ceiling"),
    ceilingHeight: z.number().positive().optional().describe("Default: level.ceilingHeight"),
    style: StyleSchema.optional().describe("Interior style for this room (overrides the project style): fills its floor, walls, ceiling and the furniture standing in it"),
    finishes: FinishesSchema.optional(),
  })
  .describe("A room: generates a floor finish and a ceiling (visible from below only), and tags the space with a name");

export const SlabSchema = z
  .object({
    id: Id.optional(),
    polygon: Polygon,
    holes: z.array(Polygon).default([]).describe("Cut-outs, e.g. stairwells (stairs cut the slab above automatically)"),
    thickness: z.number().positive().optional().describe("Default: level.slabThickness"),
    offset: z.number().default(0).describe("Top of slab relative to level elevation"),
    material: Mat.optional().describe("Top surface. Default: level.slabMaterial (concrete)"),
    edgeMaterial: Mat.optional().describe("Slab edge (visible on terraces/balconies). Default: same as material"),
    bottomMaterial: Mat.optional().describe("Underside. Default: level.slabBottomMaterial (plaster_white)"),
  })
  .describe("Floor slab / terrace / balcony floor. Top surface sits at level elevation + offset.");

export const StairSchema = z
  .object({
    id: Id.optional(),
    type: z.enum(["straight", "L", "U", "spiral"]).default("straight"),
    start: Point.describe("straight/L/U: center of the FRONT edge of the first step. spiral: center of the spiral."),
    direction: Direction.default(90).describe("Walking direction up the first flight (spiral: angle where the first step starts)"),
    width: z.number().positive().default(1.0).describe("Flight width (spiral: radius = width)"),
    rise: z.number().positive().optional().describe("Total height climbed. Default: level.height (reaches the next level)"),
    riser: z.number().positive().default(0.175).describe("Target riser height; the step count is rounded from rise/riser"),
    tread: z.number().positive().default(0.28).describe("Tread depth"),
    turn: z.enum(["left", "right"]).default("left").describe("L/U/spiral: which way the stair turns while climbing"),
    split: z.number().int().positive().optional().describe("L/U: number of risers in the first flight (default: half)"),
    gap: z.number().min(0).default(0.1).describe("U: gap between the two flights"),
    material: Mat.default("plaster_white").describe("Stair structure"),
    treadMaterial: Mat.optional().describe("Default: wood_oak. Adds tread boards on each step."),
    railing: z.enum(["both", "left", "right", "none"]).default("right"),
    railingMaterial: Mat.default("metal_black"),
    cutSlabAbove: z.boolean().default(true).describe("Automatically cut a stairwell hole in the next level's slabs"),
  })
  .describe("Staircase going UP from this level");

export const FurnitureSchema = z
  .object({
    id: Id.optional(),
    type: z.string().describe("Furniture type, see list_furniture (bed, sofa, table, chair, kitchen_counter, toilet, box, ...)"),
    position: Point.describe("Center of the object's footprint"),
    rotation: z.number().optional().describe("Degrees counter-clockwise. At 0 the front faces south (-y)."),
    facing: z.enum(["north", "south", "east", "west"]).optional().describe("Alternative to rotation: the direction the FRONT of the object faces"),
    width: z.number().positive().optional().describe("Size along the object's local x (left-right when facing it)"),
    depth: z.number().positive().optional(),
    height: z.number().positive().optional(),
    elevation: z.number().default(0).describe("Height above the floor (e.g. upper cabinets 1.5, ceiling lights)"),
    materials: z.record(z.string(), Mat).default({}).describe("Override material slots, e.g. {frame:'wood_walnut', fabric:'fabric_blue'}"),
    options: z.record(z.string(), z.unknown()).default({}).describe("Type-specific options, see list_furniture"),
    product: Id.optional().describe("Id of an entry in project.products (vendor item): supplies type, model, size and price"),
    model: z.string().optional().describe(
      "Use a real 3D model instead of the parametric one: polyhaven:<Model_Id> (CC0), sketchfab:<uid>, future3d:<id>, a .glb/.gltf/.obj URL or a local path. The type still drives layout rules and services",
    ),
    modelRotation: z.number().default(0).describe("Extra yaw (degrees) applied to the model when its front does not face -y"),
    fit: z.enum(["contain", "stretch", "none"]).default("contain").describe("Model sizing to width/depth/height: contain = uniform scale to fit, stretch = exact size, none = natural size"),
  })
  .describe("A furniture item or fixture. Exported as its own node with a pivot at its position.");

export const ColumnSchema = z
  .object({
    id: Id.optional(),
    position: Point,
    shape: z.enum(["square", "round"]).default("square"),
    size: z.number().positive().default(0.3).describe("Side length or diameter"),
    height: z.number().positive().optional().describe("Default: level.height"),
    material: Mat.default("concrete"),
  })
  .describe("Structural column");

export const RoofSchema = z
  .object({
    id: Id.optional(),
    type: z.enum(["flat", "gable", "hip", "shed"]).default("gable"),
    polygon: Polygon.describe("Footprint to cover: use the same points as the exterior wall loop (centerline); the roof grows by half the wall thickness plus `overhang`. gable/hip/shed use the polygon's oriented bounding rectangle."),
    baseHeight: z.number().optional().describe("Height of the eaves above the level elevation. Default: level.height"),
    pitch: z.number().min(0).max(75).default(30).describe("Slope in degrees (ignored for flat)"),
    overhang: z.number().min(0).default(0.4),
    thickness: z.number().positive().default(0.2),
    ridge: z.enum(["long", "short"]).default("long").describe("gable/hip: ridge runs along the longer or shorter side. shed: slope falls across this axis."),
    material: Mat.optional().describe("Default: roof_tiles_red (flat: concrete)"),
    undersideMaterial: Mat.default("wood_painted_white"),
    edgeMaterial: Mat.optional().describe("Fascia / roof edge. Default: undersideMaterial (flat roof without overhang: the exterior wall material)"),
    gableMaterial: Mat.optional().describe("gable: material for the triangular gable walls. Default: same as the walls below (plaster_white)"),
    parapet: z.number().min(0).default(0).describe("flat: parapet wall height around the edge"),
  })
  .describe("Roof placed on this level (usually the top level)");

export const RailingSchema = z
  .object({
    id: Id.optional(),
    points: z.array(Point).min(2),
    closed: z.boolean().default(false),
    height: z.number().positive().default(1.0),
    offset: z.number().default(0).describe("Base height relative to level elevation"),
    style: z.enum(["bars", "glass", "solid"]).default("bars"),
    material: Mat.default("metal_black"),
  })
  .describe("Balcony / terrace / void railing");

export const TerraceSchema = z
  .object({
    id: Id.optional(),
    name: z.string().default("Terrace").describe("Exported as metadata like room names"),
    polygon: Polygon.describe(
      "Floor outline. Edges that run along this level's walls (centerline or outer face) count as attached to the building and get no railing.",
    ),
    offset: z.number().default(0).describe("Floor height relative to the level elevation"),
    thickness: z.number().positive().default(0.2),
    material: Mat.default("paving_stone").describe("Floor surface (wood_floor_gray, tiles_terracotta, concrete, ...)"),
    edgeMaterial: Mat.optional().describe("Slab edge. Default: the level's exterior wall material"),
    bottomMaterial: Mat.default("plaster_white"),
    edge: z
      .enum(["auto", "railing", "parapet", "none"])
      .default("auto")
      .describe("What guards the free edges. auto = railing when the floor is more than 0.5 m above the ground, otherwise none (a patio)"),
    railingStyle: z.enum(["bars", "glass", "solid"]).default("glass"),
    railingMaterial: Mat.default("metal_black"),
    height: z.number().positive().default(1.0).describe("Railing / parapet height"),
    parapetMaterial: Mat.optional().describe("Default: the level's exterior wall material"),
    parapetThickness: z.number().positive().default(0.15),
    openEdges: z
      .array(z.number().int().min(0))
      .default([])
      .describe("Indices of edges to leave open (edge i runs from polygon point i to i+1), e.g. where steps lead down"),
    supports: z.boolean().default(false).describe("Add columns under the free outer corners, down to the ground (cantilevered balconies)"),
    supportSize: z.number().positive().default(0.25),
    supportMaterial: Mat.default("concrete"),
  })
  .describe("Terrace, balcony, deck or patio: floor slab plus railings/parapet on the free edges, all in one element");


export const BandSchema = z
  .object({
    from: z.number().describe("Band start height (same frame as the profile heights)"),
    to: z.number().describe("Band end height"),
    material: z.union([Mat, z.literal("none")]).describe("Material for this height range, or 'none' to leave an opening (e.g. where a ring attaches)"),
    inner: z.boolean().optional().describe("Hollow shapes: add the inner surface for this band. Default true, except for glass/water materials"),
    frame: z
      .object({
        material: Mat.default("metal_black"),
        columns: z.number().int().min(3).default(24).describe("Mullions around the circumference"),
        rows: z.number().int().min(1).default(1).describe("Horizontal divisions inside the band"),
        diagonals: z.boolean().default(true).describe("Triangulate the panels (geodesic look)"),
        radius: z.number().positive().default(0.05).describe("Mullion radius"),
        nodes: z.boolean().default(true).describe("Round node plates where members meet"),
      })
      .optional()
      .describe("Add a glazing frame / lattice over this band"),
  })
  .describe("A height range of a revolved shape with its own material (windows, stripes, openings)");

const RevolveCommon = {
  id: Id.optional(),
  name: z.string().optional(),
  material: Mat,
  segments: z.number().int().min(6).max(256).default(48).describe("Facets around the circumference"),
  bands: z.array(BandSchema).default([]),
  hollow: z
    .object({
      thickness: z.number().positive().default(0.3),
      innerMaterial: Mat.default("plaster_white"),
    })
    .optional()
    .describe("Make the shell walk-in: adds an inner surface so interiors (floors inside a sphere) look closed"),
  uvRadius: z
    .number()
    .positive()
    .optional()
    .describe("Radius used for texture mapping around (default: the largest radius). Pick it so 2*pi*uvRadius is a whole number of texture tiles to hide the seam"),
};

export const ShapeSchema = z
  .discriminatedUnion("type", [
    z.object({
      type: z.literal("revolve"),
      position: Point.describe("Axis position"),
      base: z.number().default(0).describe("Height of profile z=0 relative to the level elevation"),
      profile: z
        .array(z.tuple([z.number().min(0), z.number()]))
        .min(2)
        .describe("[[radius, height], ...] listed from the BOTTOM to the TOP. Start/end at radius 0 to close the solid (e.g. [[0,0],[8,0],[5,10],...,[0,187]])"),
      ...RevolveCommon,
    }),
    z.object({
      type: z.literal("sphere"),
      center: Vec3,
      radius: z.number().positive(),
      rings: z.number().int().min(4).max(128).default(32).describe("Facets from pole to pole"),
      ...RevolveCommon,
    }),
    z.object({
      type: z.literal("cylinder"),
      id: Id.optional(),
      name: z.string().optional(),
      position: Point,
      base: z.number().default(0),
      radius: z.number().positive(),
      radiusTop: z.number().min(0).optional().describe("Default: radius (0 = cone)"),
      height: z.number().positive(),
      segments: z.number().int().min(3).max(256).default(32),
      material: Mat,
    }),
    z.object({
      type: z.literal("box"),
      id: Id.optional(),
      name: z.string().optional(),
      center: Vec3,
      size: Vec3.describe("[width, depth, height]"),
      rotation: z.number().default(0).describe("Degrees counter-clockwise around the vertical axis"),
      material: Mat,
    }),
  ])
  .describe(
    "Free-form solids for landmarks and structures the architectural elements can't express: revolve (towers, domes, spheres-with-rings, columns with entasis), sphere, cylinder/cone, box. Static geometry; collides as itself.",
  );

export const LevelSchema = z
  .object({
    id: Id,
    name: z.string().optional(),
    elevation: z.number().optional().describe("Height of the floor surface. Default: previous level elevation + previous level height (first level: 0)"),
    height: z.number().positive().default(3).describe("Floor-to-floor height; default wall height"),
    ceilingHeight: z.number().positive().optional().describe("Default: height - slabThickness"),
    slabThickness: z.number().positive().optional().describe("Default: project defaults.slabThickness (0.2)"),
    autoSlab: z.boolean().default(true).describe("Generate a floor slab under each closed wall loop (outer edge of the walls)"),
    slabMaterial: Mat.default("concrete").describe("Top of auto slabs (and default for explicit slabs). Usually hidden under room floors."),
    slabBottomMaterial: Mat.default("plaster_white").describe("Underside of this level's slabs (seen from the level below where there is no room ceiling, e.g. canopies)"),
    walls: z.array(WallSchema).default([]),
    openings: z.array(OpeningSchema).default([]),
    rooms: z.array(RoomSchema).default([]),
    slabs: z.array(SlabSchema).default([]),
    stairs: z.array(StairSchema).default([]),
    furniture: z.array(FurnitureSchema).default([]),
    columns: z.array(ColumnSchema).default([]),
    railings: z.array(RailingSchema).default([]),
    terraces: z.array(TerraceSchema).default([]),
    shapes: z.array(ShapeSchema).default([]),
    roofs: z.array(RoofSchema).default([]),
    casework: z.array(CaseworkSchema).default([]).describe("Built-in cabinetry runs: kitchens (with islands), wardrobes, vanities, media walls, shelving, desks, benches"),
    lights: z.array(LightSchema).default([]).describe("Light fixtures (pendants, downlight grids, sconces, LED strips...) with real light sources"),
    electrical: z.array(ElectricalSchema).default([]).describe("Extra electrical points (switches, sockets, data, appliance points, AC, detectors) on top of the automatic layout"),
    plumbing: z.array(PlumbingSchema).default([]).describe("Stacks, floor drains, water heaters, the main stop valve, taps (replace / add to the automatic plumbing layout)"),
    services: ServicesSchema,
  })
  .describe("One storey of the building");

export const ElevatorSchema = z
  .object({
    id: Id,
    stops: z
      .array(
        z.object({
          level: Id,
          at: Point.describe("Landing point in front of the elevator doors on that level (must be inside a room or floor)"),
        }),
      )
      .min(2),
  })
  .describe("Connects levels for circulation checks (rooms reached only by elevator). Model the shaft and doors with walls/openings/shapes");

export const ProjectSchema = z
  .object({
    $schema: z.string().optional(),
    version: z.literal(1).default(1),
    name: z.string().default("Untitled"),
    description: z.string().optional(),
    style: StyleSchema.optional(),
    defaults: z
      .object({
        wallThickness: z.number().positive().default(0.2),
        exteriorWallThickness: z.number().positive().optional().describe("Default thickness for closed wall loops"),
        slabThickness: z.number().positive().default(0.2),
        wallMaterial: Mat.default("plaster_white"),
        exteriorMaterial: Mat.optional().describe("Exterior face of closed wall loops. Default: wallMaterial"),
        floorMaterial: Mat.default("wood_floor_oak"),
        ceilingMaterial: Mat.default("plaster_white"),
        doorFrameMaterial: Mat.default("wood_painted_white"),
        doorMaterial: Mat.default("wood_oak"),
        windowFrameMaterial: Mat.default("plastic_white"),
      })
      .prefault({}),
    materials: z.record(z.string(), CustomMaterialSchema).default({}).describe("Custom materials by name"),
    costs: z
      .object({
        currency: z.string().default("KWD").describe("Bill currency"),
        scope: z.enum(["fitout", "full"]).default("fitout").describe("fitout: interior fit-out of an existing shell; full: adds slabs, exterior walls and roofs"),
        rates: z.record(z.string(), z.number().min(0)).default({}).describe("Unit-rate overrides by key, e.g. {'floor:wood_herringbone_oak': 28, 'paint': 3, 'door:single': 150, 'point:double_socket': 14} (arch estimate lists every key used)"),
        exchange: z.record(z.string(), z.number().positive()).default({}).describe("Currency → bill currency, e.g. {USD: 0.307}"),
        preliminaries: z.number().min(0).max(50).default(4).describe("% on trades: site setup, protection, cleaning"),
        overheadProfit: z.number().min(0).max(50).default(12).describe("Contractor overhead & profit, % on trades (not on retail furniture)"),
        contingency: z.number().min(0).max(50).default(7.5).describe("% on everything"),
        designFee: z.number().min(0).max(50).default(0).describe("% on everything"),
        vat: z.number().min(0).max(50).default(0).describe("% (Kuwait: 0)"),
      })
      .prefault({})
      .describe("Cost estimate settings (arch estimate / MCP cost_estimate)"),
    products: z.array(ProductSchema).default([]).describe("Vendor / library items (import_product) placed with furniture.product; shopping_list totals them"),
    site: z
      .object({
        ground: z.boolean().default(true).describe("Add a ground plane around the building"),
        groundMaterial: Mat.default("grass"),
        margin: z.number().min(0).default(6).describe("How far the ground extends beyond the building"),
      })
      .prefault({}),
    levels: z.array(LevelSchema).min(1),
    elevators: z.array(ElevatorSchema).default([]),
  })
  .describe("Architecturer building plan");

export type Project = z.output<typeof ProjectSchema>;
export type ProjectInput = z.input<typeof ProjectSchema>;
export type Level = z.output<typeof LevelSchema>;
export type Wall = z.output<typeof WallSchema>;
export type Opening = z.output<typeof OpeningSchema>;
export type Room = z.output<typeof RoomSchema>;
export type Slab = z.output<typeof SlabSchema>;
export type Stair = z.output<typeof StairSchema>;
export type Furniture = z.output<typeof FurnitureSchema>;
export type Column = z.output<typeof ColumnSchema>;
export type Roof = z.output<typeof RoofSchema>;
export type Railing = z.output<typeof RailingSchema>;
export type Terrace = z.output<typeof TerraceSchema>;
export type Shape = z.output<typeof ShapeSchema>;
export type Band = z.output<typeof BandSchema>;
export type Elevator = z.output<typeof ElevatorSchema>;

/** Element collections on a level, in a fixed order (used by editing tools). */
export const ELEMENT_KINDS = ["walls", "openings", "rooms", "slabs", "stairs", "furniture", "columns", "railings", "terraces", "shapes", "roofs", "lights", "casework", "electrical", "plumbing"] as const;
export type ElementKind = (typeof ELEMENT_KINDS)[number];

export function directionToDegrees(d: number | "north" | "south" | "east" | "west"): number {
  if (typeof d === "number") return d;
  return { east: 0, north: 90, west: 180, south: 270 }[d];
}

export function projectJsonSchema(): unknown {
  return z.toJSONSchema(ProjectSchema, { io: "input", unrepresentable: "any" });
}

export interface ParseResult {
  ok: boolean;
  project?: Project;
  errors: string[];
}

/** Parse + validate with AI-readable error messages ("levels[0].walls[2].points: ..."). */
export function parseProject(input: unknown): ParseResult {
  const r = ProjectSchema.safeParse(input);
  if (r.success) return { ok: true, project: r.data, errors: [] };
  const errors = r.error.issues.map((i) => {
    const path = i.path.reduce<string>((s, p) => (typeof p === "number" ? `${s}[${p}]` : s ? `${s}.${String(p)}` : String(p)), "");
    return `${path || "(root)"}: ${i.message}`;
  });
  return { ok: false, errors };
}
