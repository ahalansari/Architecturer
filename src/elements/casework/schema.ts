import { z } from "zod";
import { Id, Mat, Point } from "../../schema/common.js";

/**
 * Casework = built-in cabinetry: kitchens, wardrobes, vanities, media walls, shelving, desks, benches.
 * A run is a row of modules along a BACK EDGE (usually a wall's inner face). This file only holds the
 * zod schema (no geometry), so schema.ts can import it without a cycle.
 */

export const CASEWORK_TYPES = ["kitchen", "wardrobe", "vanity", "shelving", "media", "desk", "bench", "custom"] as const;
export type CaseworkType = (typeof CASEWORK_TYPES)[number];

/** Floor-standing modules that sit under the worktop / top. */
export const BASE_KINDS = [
  "base_doors", "base_drawers", "sink", "hob", "oven_base", "dishwasher", "open_shelf", "wine_rack", "basin", "desk", "bench",
] as const;
/** Floor-to-tall-height modules (no worktop over them). */
export const TALL_KINDS = ["fridge", "tall_oven", "pantry", "wardrobe", "tall_open"] as const;
/** Wall-hung modules (the `uppers` row). */
export const UPPER_KINDS = ["upper_doors", "upper_glass", "upper_open", "upper_lift", "hood"] as const;
/** Allowed in either row. */
export const SHARED_KINDS = ["corner", "filler", "end_panel", "gap"] as const;
export const MODULE_KINDS = [...BASE_KINDS, ...TALL_KINDS, ...UPPER_KINDS, ...SHARED_KINDS] as const;
export type ModuleKind = (typeof MODULE_KINDS)[number];

export const DOOR_STYLES = ["slab", "shaker", "glass", "fluted", "louvered", "mirror"] as const;
export const HANDLE_STYLES = ["bar", "knob", "edge", "gola", "push"] as const;

const CaseMaterials = z
  .object({
    front: Mat.optional().describe("Doors, drawer fronts, end panels, fillers, plinth (unless `plinth` is set)"),
    carcass: Mat.optional().describe("Cabinet boxes and interiors (shelves, sides). Default melamine_white"),
    worktop: Mat.optional().describe("Worktop / top panel / island waterfall. Kitchen default quartz_white"),
    backsplash: Mat.optional().describe("Backsplash between worktop and uppers. Default: the worktop material (e.g. tiles_subway for tiles)"),
    handle: Mat.optional().describe("Handles, gola channels, hanging rails. Default metal_steel"),
    plinth: Mat.optional().describe("Toe-kick plinth. Default: front material"),
    glass: Mat.optional().describe("Glass door panes. Default glass"),
    sink: Mat.optional().describe("Sink bowls (metal_steel) / basins (ceramic_white)"),
    tap: Mat.optional().describe("Taps / faucets. Default chrome"),
    appliance: Mat.optional().describe("Oven/hob trims, hood, freestanding fridge. Default metal_steel"),
    accent: Mat.optional().describe("Open shelves, wine rack, cornice. Default: front material"),
    cushion: Mat.optional().describe("Bench seat cushions. Default fabric_gray"),
  })
  .describe("Material per part (library names, custom materials or hex colors)");

export const CaseModuleSchema = z
  .object({
    id: Id.optional().describe("Module id (referenced by `over` in the uppers row, shown in validation messages)"),
    kind: z.enum(MODULE_KINDS).describe(
      "BASE row (`modules`): base_doors, base_drawers, sink, hob (cooktop over drawers), oven_base, dishwasher, open_shelf, wine_rack, basin (vanity), desk (knee space), bench (seat). " +
        "TALL (also in `modules`, floor to tallHeight): fridge, tall_oven (oven + microwave column), pantry, wardrobe, tall_open (bookcase). " +
        "UPPER row (`uppers`): upper_doors, upper_glass, upper_open, upper_lift, hood. " +
        "Either row: corner (L/U corner unit, added automatically at path corners), filler, end_panel, gap (empty space: window, freestanding appliance)",
    ),
    width: z
      .union([z.number().positive(), z.literal("auto")])
      .optional()
      .describe("Meters along the run. 'auto' modules share the remaining length equally. Defaults: 0.6 most units, sink/hob 0.8, wardrobe 1.0, upper_lift/hood 0.9, open_shelf/wine_rack 0.3, filler 0.05"),
    doors: z.number().int().min(0).max(4).optional().describe("Hinged doors (default 1 up to 0.62 m wide, else 2; wardrobe: 2 above 0.7 m)"),
    hinge: z.enum(["left", "right"]).optional().describe("Single door: hinge side as you face the front. Default left (corner units hinge away from the corner)"),
    drawers: z.number().int().min(1).max(6).optional().describe("base_drawers: count (default 3); hob: drawers below (default 2); wardrobe drawers interior: count"),
    topDrawer: z.boolean().optional().describe("base_doors / sink: a drawer (sink: fixed false front) above the doors. Default false (sink: true)"),
    shelves: z.number().int().min(0).max(12).optional().describe("Internal shelves (sensible default per kind)"),
    bowls: z.union([z.literal(1), z.literal(2)]).optional().describe("sink: single or double bowl (default 1, 2 when >= 0.9 m wide)"),
    sinkStyle: z.enum(["undermount", "farmhouse"]).optional().describe("sink: undermount steel bowl (default) or ceramic farmhouse/apron-front"),
    hob: z.enum(["induction", "gas"]).optional().describe("hob: cooktop type (default induction)"),
    appliance: z.enum(["integrated", "freestanding"]).optional().describe("fridge/dishwasher: hidden behind matching fronts (default) or a stainless appliance (freestanding fridge gets a bridge cabinet above)"),
    hood: z.enum(["chimney", "box", "integrated"]).optional().describe("hood: stainless chimney hood (default), a box hood clad in the front material, or integrated (a wall cabinet with a pull-out steel visor underneath)"),
    basin: z.enum(["vessel", "undermount", "integrated"]).optional().describe("basin (vanity): bowl on the top (default), under the top, or moulded into a ceramic top"),
    interior: z
      .enum(["hanging", "double_hanging", "shelves", "drawers", "shoes", "mixed"])
      .optional()
      .describe("wardrobe interior: hanging (rail + hat shelf, default), double_hanging (two rails), shelves, drawers (internal drawers + shelves), shoes (sloped shoe shelves), mixed (drawers below, rail above)"),
    clothes: z.boolean().optional().describe("wardrobe: show hanging clothes / folded stacks (default true)"),
    decor: z.boolean().optional().describe("Show contents (dishes behind glass, books, bottles, jars). Default true"),
    worktop: z.boolean().optional().describe("gap: carry the worktop across the gap (undercounter appliance). desk/bench: default true"),
    over: Id.optional().describe("Uppers row only: place this module exactly over the base/tall module with this id (e.g. a hood over the hob, a gap over the sink window)"),
    height: z.number().positive().optional().describe("Override the module height (tall / upper units; base units follow the run height)"),
    depth: z.number().positive().optional().describe("Override the depth (e.g. shallower tall_open)"),
    doorStyle: z.enum(DOOR_STYLES).optional().describe("Override the run's door style for this module"),
    open: z.boolean().optional().describe("Pose this module open (doors swung 95°, drawers pulled out) in renders and exports — for showing interiors"),
    materials: CaseMaterials.partial().optional().describe("Per-module material overrides"),
  })
  .describe("One cabinet module in a casework run. Modules are listed LEFT to RIGHT as seen standing in front of the run, facing it.");

export const CaseworkSchema = z
  .object({
    id: Id.optional(),
    type: z
      .enum(CASEWORK_TYPES)
      .default("kitchen")
      .describe("Sets sensible defaults: kitchen (0.9 high worktop, 0.6 deep, uppers), wardrobe (2.3 tall, 0.6 deep), vanity (wall-hung, 0.85 top, 0.5 deep), shelving (0.35 deep), media (low floating units 0.45 deep), desk (0.75), bench (0.45 seat), custom"),
    // ---- placement: wall | path | position ----
    wall: Id.optional().describe("PLACEMENT A (easiest): snap the back of the run to this wall's inner face. Use with from/to; a range over a wall corner makes an L-shaped run"),
    from: z.number().optional().describe("With `wall`: start distance along the wall's centerline polyline (like an opening offset). Default 0"),
    to: z.number().optional().describe("With `wall`: end distance along the wall's centerline. Default: the end of the wall"),
    side: z.enum(["left", "right"]).optional().describe("With `wall`: which face (left/right of the wall's point order). Default: the inside of a closed loop / the side with a room"),
    path: z
      .array(Point)
      .min(2)
      .optional()
      .describe("PLACEMENT B: the BACK edge as a polyline (e.g. along wall inner faces = centerline ± thickness/2). Each corner gets a corner unit (L / U kitchens)"),
    front: z.enum(["left", "right"]).optional().describe("With `path`: side of the path the fronts face. Default: away from the nearest wall"),
    position: Point.optional().describe("PLACEMENT C (freestanding: islands, peninsulas, room dividers): center of the CABINET footprint (worktop overhangs / seating extend beyond it)"),
    facing: z.enum(["north", "south", "east", "west"]).optional().describe("Freestanding: direction the fronts (doors/drawers) face"),
    rotation: z.number().optional().describe("Freestanding: degrees CCW; 0 = fronts face south (like furniture)"),
    length: z.number().positive().optional().describe("Freestanding: total length (default: sum of module widths)"),
    // ---- modules ----
    modules: z.array(CaseModuleSchema).default([]).describe("Base and tall modules, LEFT to RIGHT as seen facing the fronts (for path/wall runs: in path order from the start). For L/U runs put {kind:'corner'} between the legs' modules (inserted automatically if missing)"),
    uppers: z
      .array(CaseModuleSchema)
      .default([])
      .describe("Wall cabinets, LEFT to RIGHT. They skip spans above tall modules automatically; use {kind:'gap'} for windows and `over` to align a hood over the hob"),
    // ---- dimensions (defaults depend on type) ----
    height: z.number().positive().optional().describe("Top of the worktop / base units above the floor (kitchen 0.9, vanity 0.85, desk 0.75, media 0.5, bench 0.45)"),
    depth: z.number().positive().optional().describe("Base/tall depth incl. doors (kitchen/wardrobe 0.6, vanity 0.5, media 0.45, shelving 0.35)"),
    tallHeight: z.number().positive().optional().describe("Top of tall units (kitchen 2.2, wardrobe 2.3)"),
    toCeiling: z.boolean().optional().describe("Tall units and uppers run up to the ceiling (no dust gap)"),
    upperBottom: z.number().positive().optional().describe("Underside of wall cabinets (default: tallHeight - upperHeight, ~0.58 m above a 0.9 worktop)"),
    upperHeight: z.number().positive().optional().describe("Wall cabinet height (default 0.72)"),
    upperDepth: z.number().positive().optional().describe("Wall cabinet depth (default 0.35)"),
    plinth: z.number().min(0).optional().describe("Toe-kick height (default 0.1; 0 when `elevation` > 0)"),
    elevation: z.number().min(0).optional().describe("Lift the base row off the floor: wall-hung vanities / floating media units (vanity 0.3, media 0.2). No plinth"),
    worktopThickness: z.number().positive().optional().describe("Default 0.03 (kitchen), 0.02 (others)"),
    overhang: z.number().min(0).optional().describe("Worktop overhang past the fronts (default 0.02)"),
    backsplash: z
      .union([z.enum(["none", "upstand", "full"]), z.number().positive()])
      .optional()
      .describe("Wall protection above the worktop: upstand (0.1 m), full (up to the wall cabinets; trimmed under windows) or a height in meters. Kitchen default full, vanity upstand"),
    island: z
      .object({
        seating: z.number().min(0).default(0).describe("Worktop overhang behind the island for stools (0.25-0.35)"),
        waterfall: z.enum(["none", "left", "right", "both"]).default("none").describe("Worktop material wraps down to the floor at the ends"),
        backPanel: z.boolean().default(true).describe("Clad the back of the cabinets in the front material"),
      })
      .optional()
      .describe("Freestanding runs: island extras"),
    endPanels: z.enum(["auto", "none", "both", "left", "right"]).optional().describe("Front-material end panels; auto = on free ends (not against a wall)"),
    doorStyle: z.enum(DOOR_STYLES).optional().describe("slab (flat, default), shaker (frame + recessed panel), glass (frame + glass), fluted (vertical ribs), louvered, mirror (sliding wardrobes)"),
    handle: z.enum(HANDLE_STYLES).optional().describe("bar (default), knob, edge (thin tab pull on the top edge), gola (handleless channel; uppers/talls push-to-open), push (no handles)"),
    cornice: z.boolean().optional().describe("Crown moulding on top of uppers and tall units (classic look). Default false"),
    lighting: z.boolean().optional().describe("LED strips under the wall cabinets / floating units. Default true for kitchens with uppers and floating runs"),
    slidingDoors: z.boolean().optional().describe("Wardrobes: sliding panels across all tall modules instead of hinged doors (default false)"),
    slidingOpen: z.array(z.number().int().min(0)).default([]).describe("Sliding panels (0 = leftmost) posed open in renders"),
    materials: CaseMaterials.prefault({}),
  })
  .describe(
    "Built-in cabinetry run (kitchen, wardrobe, vanity, media wall, shelving, desk, bench) with worktop, plinth, backsplash, appliances, interiors and openable doors/drawers. Place it with wall+from/to, a back-edge path, or position+facing (islands).",
  );

export type Casework = z.output<typeof CaseworkSchema>;
export type CaseModule = z.output<typeof CaseModuleSchema>;
export type CaseMaterialsT = z.output<typeof CaseMaterials>;
