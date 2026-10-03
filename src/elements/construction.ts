/**
 * Construction systems: what the building is actually made of. The default is the Kuwait / GCC practice —
 * a reinforced-concrete frame (columns, beams, slabs: cement + steel rebar) with hollow concrete block walls,
 * insulated block on the outside, cement-sand plaster (لياسة) both faces, and a flat RC roof with screed,
 * waterproofing membrane, thermal insulation and protection tiles. Timber framing is an explicit choice.
 *
 * The system sets defaults (wall assemblies, slab type, roof type, floor finish) and drives the cost estimate
 * (concrete m³, rebar tonnes, formwork, blockwork by thickness, plaster) and the plan's wall hatching.
 */
import { z } from "zod";

export type WallKind = "block" | "rc" | "drywall" | "timber" | "glass";

export interface WallAssembly {
  label: string;
  kind: WallKind;
  /** Structural core thickness (m), e.g. the block. */
  core: number;
  /** Finish build-up per face (m): cement plaster ~15 mm; 0 for drywall (board is part of the core). */
  face: number;
  /** Cost key of the core (per m², or per m³ for rc). */
  costKey: string;
  /** Faces get cement plaster (internal) / render (external) lines in the estimate. */
  plastered: boolean;
}

export const WALL_ASSEMBLIES = {
  block_100: { label: "100 mm hollow concrete block", kind: "block", core: 0.1, face: 0.015, costKey: "wall:block_100", plastered: true },
  block_150: { label: "150 mm hollow concrete block", kind: "block", core: 0.15, face: 0.015, costKey: "wall:block_150", plastered: true },
  block_200: { label: "200 mm hollow concrete block", kind: "block", core: 0.2, face: 0.015, costKey: "wall:block_200", plastered: true },
  block_insulated_200: { label: "200 mm insulated block (Thermostone / AAC or insulated hollow block)", kind: "block", core: 0.2, face: 0.015, costKey: "wall:block_insulated_200", plastered: true },
  rc_200: { label: "200 mm reinforced concrete wall", kind: "rc", core: 0.2, face: 0.015, costKey: "struct:rc_wall", plastered: true },
  rc_250: { label: "250 mm reinforced concrete wall", kind: "rc", core: 0.25, face: 0.015, costKey: "struct:rc_wall", plastered: true },
  drywall: { label: "Gypsum board on metal studs", kind: "drywall", core: 0.1, face: 0, costKey: "wall:drywall", plastered: false },
  glass: { label: "Glazed partition", kind: "glass", core: 0.06, face: 0, costKey: "wall:glass_partition", plastered: false },
  timber_stud: { label: "Timber stud wall, boarded both faces", kind: "timber", core: 0.12, face: 0, costKey: "wall:timber_stud", plastered: false },
} as const satisfies Record<string, WallAssembly>;
export type WallAssemblyId = keyof typeof WALL_ASSEMBLIES;
export const WALL_ASSEMBLY_IDS = Object.keys(WALL_ASSEMBLIES) as [WallAssemblyId, ...WallAssemblyId[]];

export const SLAB_TYPES = {
  rc_solid: { label: "Solid reinforced concrete slab", concrete: 1, rc: true },
  rc_ribbed: { label: "Ribbed RC slab with hollow block infill (hordi)", concrete: 0.65, rc: true },
  steel_deck: { label: "Composite slab on steel deck", concrete: 0.8, rc: true },
  timber_joist: { label: "Timber joist floor", concrete: 0, rc: false },
} as const;
export type SlabTypeId = keyof typeof SLAB_TYPES;

export interface ConstructionSystem {
  label: string;
  exteriorWall: WallAssemblyId;
  /** null: pick from each wall's drawn thickness (block 100 / 150 / 200). */
  interiorWall: WallAssemblyId | null;
  slab: SlabTypeId;
  /** Has an RC frame (columns + beams) carrying the slabs. */
  frame: boolean;
  roof: "flat" | "gable";
  roofUnderside: string;
  floorMaterial: string;
}

export const CONSTRUCTION_SYSTEMS = {
  rc_block: {
    label: "Reinforced-concrete frame + concrete block walls (Kuwait / GCC)",
    exteriorWall: "block_insulated_200", interiorWall: null, slab: "rc_solid", frame: true,
    roof: "flat", roofUnderside: "plaster_white", floorMaterial: "tiles_porcelain_white",
  },
  loadbearing_block: {
    label: "Load-bearing block walls + RC slabs",
    exteriorWall: "block_200", interiorWall: null, slab: "rc_solid", frame: false,
    roof: "flat", roofUnderside: "plaster_white", floorMaterial: "tiles_porcelain_white",
  },
  steel_frame: {
    label: "Steel frame + composite slabs, block / drywall infill",
    exteriorWall: "block_insulated_200", interiorWall: "drywall", slab: "steel_deck", frame: true,
    roof: "flat", roofUnderside: "plaster_white", floorMaterial: "tiles_porcelain_white",
  },
  timber_frame: {
    label: "Timber frame (North America / Northern Europe)",
    exteriorWall: "timber_stud", interiorWall: "timber_stud", slab: "timber_joist", frame: false,
    roof: "gable", roofUnderside: "wood_painted_white", floorMaterial: "wood_floor_oak",
  },
} as const satisfies Record<string, ConstructionSystem>;
export type ConstructionSystemId = keyof typeof CONSTRUCTION_SYSTEMS;
const SYSTEM_IDS = Object.keys(CONSTRUCTION_SYSTEMS) as [ConstructionSystemId, ...ConstructionSystemId[]];

export const ConstructionSchema = z
  .object({
    system: z
      .enum(SYSTEM_IDS)
      .default("rc_block")
      .describe(
        "rc_block (default; Kuwait / GCC): RC frame, slabs and roof (cement + steel rebar), hollow concrete block walls, insulated block outside, cement plaster both faces, flat roof. loadbearing_block | steel_frame | timber_frame",
      ),
    exteriorWall: z.enum(WALL_ASSEMBLY_IDS).optional().describe("Assembly of closed (exterior) wall loops. Default from the system (rc_block: block_insulated_200)"),
    interiorWall: z
      .enum(WALL_ASSEMBLY_IDS)
      .optional()
      .describe("Assembly of interior walls. Default: rc_block picks block_100 / 150 / 200 from each wall's thickness (core = thickness − 2 × 15 mm plaster)"),
    slab: z.enum(Object.keys(SLAB_TYPES) as [SlabTypeId, ...SlabTypeId[]]).optional().describe("rc_solid | rc_ribbed (hordi) | steel_deck | timber_joist"),
    foundation: z.enum(["isolated", "raft", "strip"]).default("isolated").describe("Footings (isolated pads + tie beams is typical for Kuwaiti villas; raft on poor soil)"),
    rebar: z
      .object({
        slab: z.number().positive().optional().describe("kg of rebar per m³ of slab concrete"),
        frame: z.number().positive().optional().describe("kg per m³ of columns & beams"),
        foundation: z.number().positive().optional().describe("kg per m³ of foundations"),
        wall: z.number().positive().optional().describe("kg per m³ of RC walls"),
      })
      .prefault({})
      .describe("Reinforcement ratios (defaults: researched engineering norms)"),
    frameRatio: z.number().positive().optional().describe("m³ of RC columns + beams per m² of floor, used where columns are not modelled"),
  })
  .prefault({})
  .describe("What the building is built of: drives wall assemblies, slab/roof defaults, plan wall hatching and the structural bill (concrete, rebar, formwork, blockwork, plaster)");
export type Construction = z.output<typeof ConstructionSchema>;

export function constructionSystem(c: Construction | undefined): ConstructionSystem {
  return CONSTRUCTION_SYSTEMS[c?.system ?? "rc_block"];
}

/** The block size whose core + plaster best fits a drawn thickness. */
function blockFor(thickness: number): WallAssemblyId {
  const core = thickness - 0.03;
  return core < 0.125 ? "block_100" : core < 0.175 ? "block_150" : "block_200";
}

/** Assembly of one wall: wall.construction > project construction (exterior / interior) > system default. */
export function wallAssembly(c: Construction | undefined, wall: { construction?: WallAssemblyId }, closed: boolean, thickness: number): WallAssemblyId {
  if (wall.construction) return wall.construction;
  const sys = constructionSystem(c);
  if (closed) return c?.exteriorWall ?? sys.exteriorWall;
  return c?.interiorWall ?? sys.interiorWall ?? blockFor(thickness);
}

/** Overall thickness of an assembly (core + finishes both faces). */
export const assemblyThickness = (id: WallAssemblyId) => WALL_ASSEMBLIES[id].core + 2 * WALL_ASSEMBLIES[id].face;

/**
 * Fill system-dependent defaults on the raw plan before schema parsing (so an explicit value always wins):
 * floor finish, and roof type / underside for roofs that don't say.
 */
export function applyConstructionDefaults(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const p = input as Record<string, unknown>;
  const sysId = ((p.construction as { system?: string } | undefined)?.system ?? "rc_block") as ConstructionSystemId;
  const sys: ConstructionSystem | undefined = CONSTRUCTION_SYSTEMS[sysId];
  if (!sys) return input;
  const defaults = { ...((p.defaults as object | undefined) ?? {}) } as Record<string, unknown>;
  if (defaults.floorMaterial === undefined) defaults.floorMaterial = sys.floorMaterial;
  const levels = Array.isArray(p.levels)
    ? p.levels.map((lv) => {
        if (!lv || typeof lv !== "object" || !Array.isArray((lv as { roofs?: unknown }).roofs)) return lv;
        const roofs = (lv as { roofs: unknown[] }).roofs.map((r) => {
          if (!r || typeof r !== "object") return r;
          const rr = { ...(r as Record<string, unknown>) };
          rr.type ??= sys.roof;
          rr.undersideMaterial ??= sys.roofUnderside;
          return rr;
        });
        return { ...(lv as object), roofs };
      })
    : p.levels;
  return { ...p, defaults, levels };
}
