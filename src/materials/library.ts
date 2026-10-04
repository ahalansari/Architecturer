/**
 * Built-in material library + name resolution (custom materials, library names, hex colors).
 */
import { parseColor } from "./textures.js";
import { externalMaterial } from "../assets/registry.js";
import { RAL } from "./ral.js";
import { TEXTURE_PATTERNS, type MaterialDef, type RGB, type TexturePattern } from "./types.js";

/** User/AI-defined material, usually declared in a building plan's `materials` section. */
export interface CustomMaterialSpec {
  /** Library material name, another custom material name, or a raw pattern name. */
  base?: string;
  pattern?: TexturePattern;
  /** "#rrggbb" or [r,g,b] (0..1, or 0..255). Multiplied into the pattern's natural colors. */
  color?: string | [number, number, number];
  roughness?: number;
  metalness?: number;
  /** Meters covered by one texture tile. */
  scale?: number;
  opacity?: number;
  emissive?: string | [number, number, number];
  doubleSided?: boolean;
  normalStrength?: number;
  params?: Record<string, number | string>;
}

type Opts = Partial<Omit<MaterialDef, "name" | "pattern" | "color">> & { color?: string | RGB };

const LIB: Record<string, MaterialDef> = {};
const DESCRIPTIONS: Record<string, string> = {};

const WHITE: RGB = [1, 1, 1];

/** Register a library entry. Defaults: white tint, roughness 0.8, non-metal, 1 m tile, opaque. */
function def(name: string, pattern: TexturePattern, description: string, o: Opts = {}) {
  const color = o.color === undefined ? WHITE : typeof o.color === "string" ? parseColor(o.color)! : o.color;
  LIB[name] = {
    name,
    pattern,
    color,
    roughness: o.roughness ?? 0.8,
    metalness: o.metalness ?? 0,
    scale: o.scale ?? 1,
    opacity: o.opacity ?? 1,
    normalStrength: o.normalStrength ?? 1,
    ...(o.emissive ? { emissive: o.emissive } : {}),
    ...(o.doubleSided ? { doubleSided: true } : {}),
    ...(o.alphaCutoff ? { alphaCutoff: o.alphaCutoff } : {}),
    ...(o.params ? { params: o.params } : {}),
  };
  DESCRIPTIONS[name] = description;
}

// --- Masonry -------------------------------------------------------------
def("brick_red", "brick", "Red clay brick, running bond, light mortar", { roughness: 0.85, scale: 1.0 });
def("brick_brown", "brick", "Dark brown brick, running bond", { roughness: 0.85, params: { brickColor: "#6e4431", mortar: "#a49d92" } });
def("brick_white", "brick", "White-painted / light brick", { roughness: 0.8, params: { brickColor: "#e4e0d8", mortar: "#c4bfb5", variation: 0.3 } });
def("brick_yellow", "brick", "Yellow / buff stock brick", { roughness: 0.85, params: { brickColor: "#c9a46b", mortar: "#beb8ad" } });
def("brick_gray", "brick", "Gray engineering brick", { roughness: 0.8, params: { brickColor: "#7b7a78", mortar: "#b5b1aa" } });
def("stone_gray", "stone", "Gray cut stone blocks with mortar", { roughness: 0.9, scale: 1.6 });
def("stone_beige", "stone", "Beige / sandstone cut stone blocks", { roughness: 0.9, scale: 1.6, params: { stoneColor: "#cdbb9a", mortar: "#988c78" } });
def("stone_dark", "stone", "Dark basalt-like cut stone", { roughness: 0.85, scale: 1.6, params: { stoneColor: "#5d5c5a", mortar: "#8a877f" } });

// --- Walls / paint ------------------------------------------------------------
def("plaster_white", "plaster", "Smooth white interior plaster", { roughness: 0.9, scale: 2.0 });
def("plaster_beige", "plaster", "Warm beige plaster / render", { roughness: 0.9, scale: 2.0, color: "#f2e3c6" });
def("plaster_gray", "plaster", "Light gray plaster", { roughness: 0.9, scale: 2.0, color: "#c2c2c0" });
def("stucco", "plaster", "Textured white exterior stucco / render", { roughness: 0.95, scale: 1.5, normalStrength: 2.5, color: "#fdfcfa" });
def("stucco_beige", "plaster", "Textured warm beige exterior stucco / render", { roughness: 0.95, scale: 1.5, normalStrength: 2.5, color: "#ece4d4" });
def("paint_white", "plaster", "Painted wall, white", { roughness: 0.75, scale: 2.0, normalStrength: 0.4 });
def("paint_gray", "plaster", "Painted wall, gray", { roughness: 0.75, scale: 2.0, normalStrength: 0.4, color: "#9ea0a2" });
def("paint_black", "plaster", "Painted wall, black / charcoal", { roughness: 0.7, scale: 2.0, normalStrength: 0.4, color: "#2a2b2d" });
def("paint_blue", "plaster", "Painted wall, soft blue", { roughness: 0.75, scale: 2.0, normalStrength: 0.4, color: "#7e9fc7" });
def("paint_green", "plaster", "Painted wall, sage green", { roughness: 0.75, scale: 2.0, normalStrength: 0.4, color: "#93b28c" });
def("paint_yellow", "plaster", "Painted wall, warm yellow", { roughness: 0.75, scale: 2.0, normalStrength: 0.4, color: "#ecd27e" });
def("paint_red", "plaster", "Painted wall, brick red", { roughness: 0.75, scale: 2.0, normalStrength: 0.4, color: "#b24a3c" });
def("paint_beige", "plaster", "Painted wall, beige", { roughness: 0.75, scale: 2.0, normalStrength: 0.4, color: "#e6d6ba" });
def("concrete", "concrete", "Light gray poured concrete with faint form lines", { roughness: 0.9, scale: 2.0 });
def("concrete_dark", "concrete", "Dark gray concrete", { roughness: 0.9, scale: 2.0, color: "#8a8a8c" });
def("concrete_polished", "concrete", "Polished concrete floor (no form lines)", { roughness: 0.35, scale: 3.0, normalStrength: 0.3, params: { formLines: 0, pores: 250 } });
def("asphalt", "concrete", "Dark asphalt road surface", { roughness: 0.95, scale: 2.0, color: "#4a4a4d", normalStrength: 1.5, params: { formLines: 0, pores: 3000 } });

// --- Wood ---------------------------------------------------------------------
def("wood_floor_oak", "wood_planks", "Oak floor planks", { roughness: 0.55, scale: 1.2 });
def("wood_floor_walnut", "wood_planks", "Dark walnut floor planks", { roughness: 0.5, scale: 1.2, params: { wood: "#6b4530" } });
def("wood_floor_light", "wood_planks", "Light ash / maple floor planks", { roughness: 0.55, scale: 1.2, params: { wood: "#d6b88e", contrast: 0.7 } });
def("wood_floor_gray", "wood_planks", "Weathered gray wood planks (decks)", { roughness: 0.8, scale: 1.2, params: { wood: "#9a9188" } });
def("wood_oak", "wood_grain", "Oak wood grain (furniture, doors, trim)", { roughness: 0.55, scale: 0.8 });
def("wood_walnut", "wood_grain", "Dark walnut wood grain", { roughness: 0.5, scale: 0.8, params: { wood: "#6b4530" } });
def("wood_pine", "wood_grain", "Light pine wood grain", { roughness: 0.6, scale: 0.8, params: { wood: "#d9b680", contrast: 1.2 } });
def("wood_dark", "wood_grain", "Dark stained wood (espresso)", { roughness: 0.45, scale: 0.8, params: { wood: "#3e2a1f" } });
def("wood_painted_white", "wood_grain", "White-painted wood (doors, trim, cabinets)", { roughness: 0.45, scale: 0.8, params: { wood: "#eeece6", contrast: 0.15 } });

// --- Tiles / stone surfaces -------------------------------------------------------
def("tiles_white", "tiles", "White glazed ceramic tiles, 20 cm", { roughness: 0.15, scale: 0.8 });
def("tiles_gray", "tiles", "Gray ceramic tiles, 20 cm", { roughness: 0.25, scale: 0.8, params: { tile: "#9c9d9e", grout: "#c7c5c0" } });
def("tiles_black", "tiles", "Black glossy tiles with gray grout", { roughness: 0.15, scale: 0.8, params: { tile: "#222326", grout: "#8d8b87" } });
def("tiles_blue", "tiles", "Blue glazed ceramic tiles", { roughness: 0.15, scale: 0.8, params: { tile: "#4f7fb8", grout: "#d9d7d1" } });
def("tiles_subway", "tiles", "White subway tiles (running bond)", { roughness: 0.12, scale: 0.6, params: { cols: 4, rows: 8, offset: 0.5, groutWidth: 0.005 } });
def("tiles_floor_large", "tiles", "Large 60 cm beige floor tiles", { roughness: 0.3, scale: 1.2, params: { count: 2, tile: "#ddd6c9", grout: "#b9b2a5", groutWidth: 0.004 } });
def("tiles_terracotta", "tiles", "Terracotta floor tiles", { roughness: 0.7, scale: 1.2, params: { count: 4, tile: "#b4643f", grout: "#c9bfae", variation: 3 } });
def("marble_white", "marble", "Polished white Carrara-style marble", { roughness: 0.15, scale: 2.0 });
def("marble_black", "marble", "Polished black marble with white veins", { roughness: 0.15, scale: 2.0, params: { base: "#1d1d20", vein: "#c9c9c9" } });
def("marble_beige", "marble", "Polished beige marble", { roughness: 0.18, scale: 2.0, params: { base: "#e6d9c3", vein: "#a38f73" } });
def("granite", "gravel", "Speckled granite countertop", { roughness: 0.2, scale: 0.4, normalStrength: 0.05, params: { stones: 90, base: "#8f8c88" } });

// --- Roofing --------------------------------------------------------------------
def("roof_tiles_red", "roof_tiles", "Terracotta clay roof tiles", { roughness: 0.75, scale: 1.0 });
def("roof_tiles_brown", "roof_tiles", "Brown clay roof tiles", { roughness: 0.75, scale: 1.0, params: { tile: "#7a4a33" } });
def("roof_tiles_gray", "roof_tiles", "Gray concrete roof tiles", { roughness: 0.8, scale: 1.0, params: { tile: "#6e6e6c" } });
def("shingles_gray", "shingles", "Gray asphalt shingles", { roughness: 0.95, scale: 1.0 });
def("shingles_black", "shingles", "Black / charcoal asphalt shingles", { roughness: 0.95, scale: 1.0, color: "#5a5a5a" });
def("shingles_brown", "shingles", "Brown asphalt shingles", { roughness: 0.95, scale: 1.0, params: { base: "#6e5444" } });
def("roof_slate", "shingles", "Dark slate roof (uniform tabs)", { roughness: 0.7, scale: 1.0, params: { base: "#4c5157", tabs: 3, jitter: 0, rows: 7, variation: 0.6 } });
def("roof_metal", "metal", "Standing-seam metal roof panels (seams run down the slope)", { roughness: 0.45, metalness: 0.7, scale: 1.0, color: "#6d7378", params: { seams: 2, brush: 0.3 } });
def("metal_corrugated", "metal", "Corrugated galvanized metal sheet (sheds, fences, roofs)", { roughness: 0.4, metalness: 0.9, scale: 1.0, color: "#b4b8bc", params: { corrugated: 13, brush: 0.4 } });

// --- Metals ------------------------------------------------------------------------
def("metal_steel", "metal", "Brushed stainless steel", { roughness: 0.35, metalness: 1, scale: 0.5, color: "#c8cacd" });
def("metal_aluminum", "metal", "Brushed aluminum", { roughness: 0.4, metalness: 1, scale: 0.5, color: "#d5d7da" });
def("metal_black", "metal", "Black powder-coated / matte black metal", { roughness: 0.5, metalness: 0.6, scale: 0.5, color: "#2b2c2e", normalStrength: 0.3 });
def("metal_brass", "metal", "Brushed brass", { roughness: 0.3, metalness: 1, scale: 0.5, color: "#d9b26a" });
def("metal_copper", "metal", "Brushed copper", { roughness: 0.3, metalness: 1, scale: 0.5, color: "#d8916a" });
def("metal_gold", "metal", "Polished gold", { roughness: 0.2, metalness: 1, scale: 0.5, color: "#f0c96a", normalStrength: 0.3 });
def("metal_iron", "metal", "Dark wrought iron", { roughness: 0.6, metalness: 0.8, scale: 0.5, color: "#4a4a4c" });
def("chrome", "metal", "Polished chrome", { roughness: 0.06, metalness: 1, scale: 0.5, color: "#f2f3f5", normalStrength: 0.05, params: { brush: 0.2 } });

// --- Glass / mirror / liquids ---------------------------------------------------------------
def("glass", "none", "Clear window glass (transparent, double-sided)", { roughness: 0.05, opacity: 0.25, color: "#dcebf0", doubleSided: true, normalStrength: 0 });
def("glass_frosted", "none", "Frosted / translucent glass", { roughness: 0.55, opacity: 0.6, color: "#eef3f5", doubleSided: true, normalStrength: 0 });
def("glass_tinted", "none", "Dark tinted glass", { roughness: 0.05, opacity: 0.45, color: "#5d6c72", doubleSided: true, normalStrength: 0 });
def("mirror", "none", "Mirror (perfectly smooth metal)", { roughness: 0.02, metalness: 1, color: "#f5f5f5", normalStrength: 0 });
def("water", "none", "Water surface (semi-transparent blue)", { roughness: 0.05, opacity: 0.7, color: "#3d6b80", doubleSided: true, normalStrength: 0 });

// --- Soft furnishings -------------------------------------------------------------------
def("fabric_gray", "fabric", "Gray woven upholstery fabric", { roughness: 0.95, scale: 0.3, color: "#8e8f92" });
def("fabric_blue", "fabric", "Blue woven upholstery fabric", { roughness: 0.95, scale: 0.3, color: "#4d6b98" });
def("fabric_beige", "fabric", "Beige woven fabric", { roughness: 0.95, scale: 0.3, color: "#d8c9ac" });
def("fabric_red", "fabric", "Red woven fabric", { roughness: 0.95, scale: 0.3, color: "#a83a35" });
def("fabric_green", "fabric", "Green woven fabric", { roughness: 0.95, scale: 0.3, color: "#5e7f55" });
def("fabric_white", "fabric", "White woven fabric (bedding, curtains)", { roughness: 0.95, scale: 0.3 });
def("sheer_white", "fabric", "Translucent white sheer / voile curtain fabric", { roughness: 0.95, scale: 0.2, color: "#f7f5f0", opacity: 0.55, doubleSided: true, params: { threads: 120 }, normalStrength: 0.3 });
def("linen_white", "fabric", "Fine white linen (bedding, tablecloths)", { roughness: 0.95, scale: 0.25, color: "#f4f1ea", params: { threads: 96 }, normalStrength: 0.6 });
def("leather_brown", "leather", "Brown pebble-grain leather", { roughness: 0.55, scale: 0.4 });
def("leather_black", "leather", "Black leather", { roughness: 0.5, scale: 0.4, params: { base: "#232224" } });
def("leather_tan", "leather", "Tan / cognac leather", { roughness: 0.55, scale: 0.4, params: { base: "#a8703f" } });
def("carpet_beige", "carpet", "Beige cut-pile carpet", { roughness: 1, scale: 0.5, color: "#e3d4b8" });
def("carpet_gray", "carpet", "Gray cut-pile carpet", { roughness: 1, scale: 0.5, color: "#8e8e8e" });
def("carpet_red", "carpet", "Deep red carpet / rug", { roughness: 1, scale: 0.5, color: "#8f2c2a" });
def("carpet_blue", "carpet", "Navy blue carpet / rug", { roughness: 1, scale: 0.5, color: "#34466e" });

// --- Plastics, ceramics, misc ---------------------------------------------------------------
def("ceramic_white", "none", "Glazed white ceramic / porcelain (sinks, toilets)", { roughness: 0.1, color: "#f4f4f2", normalStrength: 0 });
def("plastic_white", "none", "Smooth white plastic", { roughness: 0.4, color: "#efefef", normalStrength: 0 });
def("plastic_black", "none", "Smooth black plastic", { roughness: 0.4, color: "#1c1c1e", normalStrength: 0 });
def("plastic_gray", "none", "Smooth gray plastic", { roughness: 0.45, color: "#8c8d90", normalStrength: 0 });
def("rubber_black", "none", "Matte black rubber", { roughness: 0.95, color: "#161617", normalStrength: 0 });
def("screen_black", "none", "Glossy black screen (TV, monitor)", { roughness: 0.08, color: "#0b0c0e", normalStrength: 0 });
def("emissive_light", "none", "Glowing lamp / bulb / light panel (emissive)", { roughness: 0.4, color: "#fff8ec", emissive: [1, 0.94, 0.82], normalStrength: 0 });

// --- Exterior / landscape -----------------------------------------------------------------
def("grass", "grass", "Lawn grass (top-down)", { roughness: 0.95, scale: 1.0 });
def("palm_frond", "palm_frond", "Date-palm frond card (leaflets cut out of the card)", { roughness: 0.65, scale: 1, doubleSided: true, alphaCutoff: 0.5, normalStrength: 0.3 });
def("olive_leaves", "leaf_cluster", "Olive foliage card: narrow silver-green leaves", { roughness: 0.7, scale: 1, doubleSided: true, alphaCutoff: 0.5, normalStrength: 0.3 });
def("leaves_green", "leaf_cluster", "Broadleaf foliage card (shade trees, shrubs)", { roughness: 0.7, scale: 1, doubleSided: true, alphaCutoff: 0.5, normalStrength: 0.3, params: { style: "broad" } });
def("palm_bark", "palm_bark", "Date-palm trunk: diamond leaf-base scars", { roughness: 0.9, scale: 1.0 });
def("plant_green", "grass", "Leafy plant foliage (bushes, hedges, house plants)", { roughness: 0.8, scale: 0.4, doubleSided: true, params: { base: "#4d8a3a", blades: 9000 } });
def("gravel", "gravel", "Loose gravel / pebbles", { roughness: 0.9, scale: 1.0 });
def("grass_artificial", "grass", "Artificial grass (even, bright)", { roughness: 0.75, scale: 0.6, params: { base: "#4f9a36", blades: 14000 } });
def("mulch", "concrete", "Bark mulch on planting beds", { roughness: 1, scale: 1.2, color: "#6b4528", normalStrength: 2.5, params: { formLines: 0, pores: 9000 } });
def("dirt", "concrete", "Bare soil / dirt", { roughness: 1, scale: 2.0, color: "#7a5c40", normalStrength: 2, params: { formLines: 0, pores: 4000 } });
def("sand", "carpet", "Sand", { roughness: 1, scale: 1.0, color: "#dcc9a0", normalStrength: 0.6 });
def("paving_stone", "paving", "Square stone paving slabs (50 cm)", { roughness: 0.85, scale: 1.0 });
def("paving_brick", "paving", "Red brick pavers, running bond", { roughness: 0.85, scale: 1.0, params: { style: "bricks" } });
def("flagstone", "paving", "Irregular flagstone paving", { roughness: 0.85, scale: 2.0, params: { style: "flagstone" } });
def("siding_white", "siding", "White horizontal lap siding / clapboard", { roughness: 0.6, scale: 1.0 });
def("siding_blue", "siding", "Blue horizontal lap siding", { roughness: 0.6, scale: 1.0, color: "#7f9cbd" });
def("siding_gray", "siding", "Gray horizontal lap siding", { roughness: 0.6, scale: 1.0, color: "#9a9c9e" });
def("enamel_discs", "disks", "Enamelled steel discs in blues/greens/grays on a dark backing (Kuwait Towers spheres)", {
  roughness: 0.35, metalness: 0.3, scale: 2.4, normalStrength: 1.2,
});
def("enamel_discs_silver", "disks", "Silver/white enamelled steel discs", {
  roughness: 0.3, metalness: 0.5, scale: 2.4, params: { palette: "#c9d1d6,#b3bec5,#dfe5e8,#a3afb7" },
});
def("siding_red", "siding", "Barn-red horizontal siding", { roughness: 0.65, scale: 1.0, color: "#9c3b30" });
def("siding_yellow", "siding", "Pale yellow horizontal siding", { roughness: 0.6, scale: 1.0, color: "#ecd9a0" });

// --- Vehicles / outdoor furniture ------------------------------------------------------------
def("car_paint_red", "none", "Glossy red car paint", { roughness: 0.22, metalness: 0.35, color: "#a3161a", normalStrength: 0 });
def("car_paint_blue", "none", "Glossy metallic blue car paint", { roughness: 0.22, metalness: 0.45, color: "#1f4a8c", normalStrength: 0 });
def("car_paint_white", "none", "Glossy white car paint", { roughness: 0.2, metalness: 0.15, color: "#f1f1ee", normalStrength: 0 });
def("car_paint_black", "none", "Glossy black car paint", { roughness: 0.18, metalness: 0.35, color: "#141518", normalStrength: 0 });
def("car_paint_silver", "none", "Metallic silver car paint", { roughness: 0.25, metalness: 0.75, color: "#b9bcc0", normalStrength: 0 });
def("tire_rubber", "none", "Tire rubber (dark, matte)", { roughness: 0.9, color: "#1b1b1c", normalStrength: 0 });
def("emissive_red", "none", "Glowing red light (tail lights, signals)", { roughness: 0.3, color: "#ff3a2a", emissive: [1, 0.12, 0.06], normalStrength: 0 });
def("plastic_green", "none", "Smooth dark green plastic (wheelie bins, garden items)", { roughness: 0.5, color: "#2f5b37", normalStrength: 0 });
def("wood_teak", "wood_grain", "Teak wood (outdoor furniture, decking)", { roughness: 0.7, scale: 0.8, params: { wood: "#a3713f", contrast: 0.8 } });
def("wicker", "fabric", "Woven wicker / rattan (outdoor furniture, baskets)", { roughness: 0.85, scale: 0.25, color: "#c79a62", normalStrength: 3, params: { threads: 20 } });
def("wicker_gray", "fabric", "Gray synthetic rattan weave", { roughness: 0.8, scale: 0.25, color: "#8a8784", normalStrength: 3, params: { threads: 20 } });
def("bark", "wood_grain", "Tree bark (dark, rough)", { roughness: 0.95, scale: 0.5, normalStrength: 2.5, params: { wood: "#4b3a2b", contrast: 1.6 } });
def("plant_dark_green", "grass", "Dark green needles / dense foliage (conifers, hedges)", { roughness: 0.85, scale: 0.4, doubleSided: true, params: { base: "#2c5a2e", blades: 9000 } });

// --- Interior decor: art paints, ceramics, soft goods, food -------------------------------------
def("art_cream", "none", "Warm cream art paper / canvas ground", { roughness: 0.9, color: "#f1e9d8", normalStrength: 0 });
def("art_terracotta", "none", "Flat terracotta art paint", { roughness: 0.85, color: "#c4643f", normalStrength: 0 });
def("art_navy", "none", "Flat navy art paint", { roughness: 0.85, color: "#203651", normalStrength: 0 });
def("art_mustard", "none", "Flat mustard art paint", { roughness: 0.85, color: "#d8a23a", normalStrength: 0 });
def("art_sage", "none", "Flat sage green art paint", { roughness: 0.85, color: "#9aae8c", normalStrength: 0 });
def("art_blush", "none", "Flat blush pink art paint", { roughness: 0.85, color: "#e6b9a8", normalStrength: 0 });
def("art_charcoal", "none", "Flat charcoal art paint", { roughness: 0.85, color: "#34373b", normalStrength: 0 });
def("art_sky", "none", "Flat pale sky blue art paint", { roughness: 0.85, color: "#a8c6db", normalStrength: 0 });
def("ceramic_black", "none", "Matte black ceramic (vases, pots)", { roughness: 0.45, color: "#232325", normalStrength: 0 });
def("ceramic_sage", "none", "Satin sage green ceramic", { roughness: 0.35, color: "#a3b49a", normalStrength: 0 });
def("ceramic_blush", "none", "Satin blush pink ceramic", { roughness: 0.35, color: "#e2b8aa", normalStrength: 0 });
def("terracotta", "concrete", "Unglazed terracotta (plant pots)", { roughness: 0.9, scale: 0.6, color: "#c06a43", normalStrength: 0.6, params: { formLines: 0, pores: 1500 } });
def("glass_amber", "none", "Amber bottle glass", { roughness: 0.08, opacity: 0.6, color: "#a8641e", doubleSided: true, normalStrength: 0 });
def("glass_green", "none", "Green bottle glass", { roughness: 0.08, opacity: 0.6, color: "#3e6e4a", doubleSided: true, normalStrength: 0 });
def("wax", "none", "Candle wax (ivory)", { roughness: 0.6, color: "#f2ebdc", normalStrength: 0 });
def("paper_white", "none", "Paper (book pages, toilet roll)", { roughness: 0.95, color: "#f4f1e8", normalStrength: 0 });
def("fabric_boucle", "fabric", "Cream boucle (nubby looped upholstery)", { roughness: 1, scale: 0.15, color: "#ece5d8", normalStrength: 4, params: { threads: 40 } });
def("knit_cream", "fabric", "Chunky cream knit (throws, poufs)", { roughness: 1, scale: 0.3, color: "#e9e1d0", normalStrength: 3.5, params: { threads: 14 } });
def("velvet_emerald", "fabric", "Emerald green velvet", { roughness: 0.65, scale: 0.3, color: "#1f5a48", normalStrength: 0.3, params: { threads: 160 } });
def("velvet_rust", "fabric", "Rust / burnt orange velvet", { roughness: 0.65, scale: 0.3, color: "#a24f2c", normalStrength: 0.3, params: { threads: 160 } });
def("velvet_blush", "fabric", "Blush pink velvet", { roughness: 0.65, scale: 0.3, color: "#d9a79a", normalStrength: 0.3, params: { threads: 160 } });
def("towel_white", "fabric", "Fluffy white terry towel", { roughness: 1, scale: 0.2, color: "#f3f2ee", normalStrength: 3, params: { threads: 48 } });
def("towel_gray", "fabric", "Gray terry towel", { roughness: 1, scale: 0.2, color: "#a3a5a6", normalStrength: 3, params: { threads: 48 } });
def("plant_olive", "grass", "Silvery olive / eucalyptus foliage", { roughness: 0.8, scale: 0.4, doubleSided: true, params: { base: "#7f8f68", blades: 9000 } });
def("petal_pink", "none", "Pink flower petals", { roughness: 0.6, color: "#e8a1b0", normalStrength: 0 });
def("petal_white", "none", "White flower petals", { roughness: 0.6, color: "#f6f2ea", normalStrength: 0 });
def("pampas", "fabric", "Fluffy beige pampas grass plumes", { roughness: 1, scale: 0.15, color: "#e2d3b5", normalStrength: 3, params: { threads: 30 } });
def("fruit_red", "none", "Red apple skin", { roughness: 0.35, color: "#b3262a", normalStrength: 0 });
def("fruit_orange", "none", "Orange peel", { roughness: 0.55, color: "#ec8a1e", normalStrength: 0 });
def("fruit_yellow", "none", "Lemon / banana yellow", { roughness: 0.5, color: "#f1d23f", normalStrength: 0 });
def("fruit_green", "none", "Green apple / lime", { roughness: 0.4, color: "#8dbb3c", normalStrength: 0 });

// --- Interior finishes: parquet, terrazzo, decorative tiles, wallcoverings ------------------------
def("wood_herringbone_oak", "herringbone", "Oak herringbone parquet, 90 × 450 mm blocks", { roughness: 0.5, scale: 1.27 });
def("wood_herringbone_walnut", "herringbone", "Walnut herringbone parquet, 90 × 450 mm blocks", { roughness: 0.45, scale: 1.27, params: { wood: "#6e4a33" } });
def("wood_herringbone_light", "herringbone", "Pale white-oak herringbone (Scandinavian), 70 × 420 mm blocks", { roughness: 0.55, scale: 1.19, params: { wood: "#d8bf98", contrast: 0.7, ratio: 6 } });
def("wood_chevron_walnut", "chevron", "Walnut chevron parquet (45° mitred blocks)", { roughness: 0.45, scale: 1.2, params: { wood: "#6b4530" } });
def("wood_chevron_oak", "chevron", "Oak chevron parquet (45° mitred blocks)", { roughness: 0.5, scale: 1.2, params: { wood: "#b58b5c" } });
def("wood_parquet_oak", "parquet", "Oak basketweave parquet, 25 cm squares of three strips", { roughness: 0.5, scale: 1.0 });
def("terrazzo_white", "terrazzo", "Polished white terrazzo with gray, black and ochre chips", { roughness: 0.25, scale: 1.0, normalStrength: 0.5 });
def("terrazzo_pink", "terrazzo", "Polished blush terrazzo with burgundy, white and rose chips", {
  roughness: 0.25, scale: 1.0, normalStrength: 0.5, params: { base: "#e7c4b6", palette: "#f6efe8,#c97d6c,#8e3b33,#d9a593,#ffffff,#6d6a68,#e2a48f" },
});
def("terrazzo_green", "terrazzo", "Polished pale terrazzo with green and white chips", {
  roughness: 0.25, scale: 1.0, normalStrength: 0.5, params: { base: "#dfe2d8", palette: "#f4f4ef,#4f7a62,#2f4f3f,#9fb9a2,#c9c5bc" },
});
def("tiles_hex_white", "hex_tiles", "White matte hexagon floor tiles, 15 cm", { roughness: 0.35, scale: 0.9 });
def("tiles_hex_terracotta", "hex_tiles", "Terracotta hexagon floor tiles, 20 cm", { roughness: 0.75, scale: 1.2, params: { tile: "#b5623d", grout: "#cbbfae", variation: 3 } });
def("tiles_hex_black", "hex_tiles", "Black hexagon tiles with light grout, 15 cm", { roughness: 0.3, scale: 0.9, params: { tile: "#26272a", grout: "#bdb9b1" } });
def("tiles_penny_white", "hex_tiles", "White penny-round mosaic, 19 mm", { roughness: 0.15, scale: 0.6, params: { style: "penny", cols: 32, groutWidth: 0.003 } });
def("tiles_mosaic_blue", "mosaic", "Blue blend glass mosaic, 25 mm (pools, showers)", { roughness: 0.1, scale: 0.8 });
def("tiles_mosaic_green", "mosaic", "Green blend glass mosaic, 25 mm", { roughness: 0.1, scale: 0.8, params: { palette: "#2f6b55,#3f8a6c,#5aa486,#24533f,#7fbea0" } });
def("tiles_zellige_green", "zellige", "Moroccan zellige, deep green handmade glossy tiles, 10 cm", { roughness: 0.12, scale: 0.8 });
def("tiles_zellige_white", "zellige", "Moroccan zellige, white handmade glossy tiles, 10 cm", { roughness: 0.12, scale: 0.8, params: { tile: "#ece7dc", grout: "#dcd6ca", variation: 0.5 } });
def("tiles_zellige_blue", "zellige", "Moroccan zellige, indigo handmade glossy tiles, 10 cm", { roughness: 0.12, scale: 0.8, params: { tile: "#2f5d86" } });
def("tiles_zellige_pink", "zellige", "Moroccan zellige, dusty pink handmade glossy tiles, 10 cm", { roughness: 0.12, scale: 0.8, params: { tile: "#d8a294", variation: 0.7 } });
def("wallpaper_stripes_sage", "wallpaper", "Regency stripe wallpaper, sage on cream", { roughness: 0.6, scale: 0.9, params: { style: "stripes", base: "#ece7d9", ink: "#9fae90", accent: "#f8f5ec" } });
def("wallpaper_stripes_navy", "wallpaper", "Regency stripe wallpaper, navy on ivory", { roughness: 0.6, scale: 0.9, params: { style: "stripes", base: "#efeadf", ink: "#2c3b58", accent: "#c4a467" } });
def("wallpaper_damask_gold", "wallpaper", "Damask wallpaper, metallic gold ornament on cream, 53 cm repeat", {
  roughness: 0.55, scale: 1.06, params: { style: "damask", base: "#ebe1c9", ink: "#c09a55", accent: "#c9ab6e", metallic: 0.6 },
});
def("wallpaper_damask_green", "wallpaper", "Damask wallpaper, tone-on-tone deep green", { roughness: 0.6, scale: 1.06, params: { style: "damask", base: "#2e4237", ink: "#425a4c" } });
def("wallpaper_artdeco_navy", "wallpaper", "Art-deco fan wallpaper, gold scallops on navy", {
  roughness: 0.55, scale: 0.9, params: { style: "artdeco", base: "#1c2944", ink: "#c7a35d", accent: "#c7a35d", metallic: 0.6, repeats: 4 },
});
def("wallpaper_botanical", "wallpaper", "Botanical leaf-print wallpaper, greens on cream", { roughness: 0.65, scale: 1.06, params: { style: "botanical", base: "#efeadc", ink: "#4d6c48", accent: "#8ea67c" } });
def("wallpaper_trellis_blue", "wallpaper", "Ogee trellis wallpaper, blue-gray on white", { roughness: 0.6, scale: 1.06, params: { style: "trellis", base: "#eef0ec", ink: "#7591a8", accent: "#7591a8" } });
def("slats_oak", "fluted", "Oak acoustic slat wall panel on black felt (27 mm slats, 40 mm pitch)", { roughness: 0.6, scale: 0.8, normalStrength: 1.2 });
def("slats_walnut", "fluted", "Walnut acoustic slat wall panel on black felt", { roughness: 0.55, scale: 0.8, normalStrength: 1.2, params: { wood: "#6b4530" } });
def("fluted_white", "fluted", "Fluted (concave channel) wall panelling, painted white, 50 mm", { roughness: 0.7, scale: 0.8, params: { style: "flutes" } });
def("reeded_oak", "fluted", "Reeded oak (convex half-rounds), 50 mm — fronts, bar panels", { roughness: 0.55, scale: 0.8, params: { style: "reeds", wood: "#b58a5d", contrast: 0.8, variation: 0.5 } });
def("beadboard_white", "fluted", "Painted tongue-and-groove beadboard, 10 cm boards (wainscoting)", { roughness: 0.55, scale: 0.8, params: { style: "beadboard" } });
def("microcement_gray", "microcement", "Gray microcement: seamless trowelled walls and floors", { roughness: 0.55, scale: 2.5 });
def("microcement_sand", "microcement", "Warm sand microcement", { roughness: 0.55, scale: 2.5, params: { base: "#cfc2ac" } });
def("microcement_white", "microcement", "Off-white microcement", { roughness: 0.55, scale: 2.5, params: { base: "#e4e0d8", mottle: 0.6 } });
def("tadelakt_terracotta", "microcement", "Burnished terracotta tadelakt lime plaster (bathrooms, hammams)", { roughness: 0.45, scale: 2.0, params: { base: "#b9724f", polish: 0.85, mottle: 1.4 } });
def("grasscloth_natural", "grasscloth", "Natural grasscloth wallcovering, 45 cm paper panels", { roughness: 0.85, scale: 0.9 });
def("grasscloth_blue", "grasscloth", "Indigo-dyed grasscloth wallcovering", { roughness: 0.85, scale: 0.9, params: { base: "#6f8aa3", backing: "#435263" } });
def("linen_wallcovering", "fabric", "Fine linen wallcovering (oatmeal)", { roughness: 0.9, scale: 0.4, color: "#ddd2c0", normalStrength: 0.7, params: { threads: 140 } });

// --- Cabinetry: lacquered / painted fronts, carcass board, engineered stone worktops --------------
def("lacquer_white", "none", "Satin white lacquered cabinet fronts", { roughness: 0.32, color: "#f1efea", normalStrength: 0 });
def("lacquer_cream", "none", "Satin cream / ivory painted cabinet fronts", { roughness: 0.35, color: "#ece4d3", normalStrength: 0 });
def("lacquer_greige", "none", "Satin greige (warm gray-beige) cabinet fronts", { roughness: 0.35, color: "#c4bbad", normalStrength: 0 });
def("lacquer_sage", "none", "Satin sage green painted cabinet fronts", { roughness: 0.38, color: "#8e9e88", normalStrength: 0 });
def("lacquer_navy", "none", "Satin navy painted cabinet fronts", { roughness: 0.35, color: "#2b3a52", normalStrength: 0 });
def("lacquer_charcoal", "none", "Matte charcoal / anthracite cabinet fronts", { roughness: 0.5, color: "#3a3c3f", normalStrength: 0 });
def("melamine_white", "none", "White melamine board (cabinet carcasses, shelves)", { roughness: 0.5, color: "#ebe9e4", normalStrength: 0 });
def("quartz_white", "marble", "White engineered quartz worktop with faint veining", { roughness: 0.18, scale: 2.0, normalStrength: 0.2, params: { base: "#f1f0ec", vein: "#c9c8c4", veins: 0.45 } });
def("quartz_gray", "marble", "Concrete-gray engineered quartz worktop", { roughness: 0.25, scale: 2.0, normalStrength: 0.2, params: { base: "#9a9893", vein: "#b6b4ae", veins: 0.3 } });
def("quartz_black", "marble", "Black engineered quartz worktop with subtle veins", { roughness: 0.2, scale: 2.0, normalStrength: 0.2, params: { base: "#232325", vein: "#6c6c6e", veins: 0.4 } });

// --- Extended palette: more species, stones, designer paints, metals, fabrics, tiles -------------------------
const WOODS: [string, string, string, number?][] = [
  ["ash", "Ash (pale, straight grain)", "#d9c3a0", 0.9],
  ["maple", "Hard maple (creamy, fine grain)", "#e3cfaa", 0.6],
  ["birch", "Birch / birch plywood faces", "#e6d4b3", 0.6],
  ["cherry", "American cherry (reddish brown)", "#a3593a", 0.9],
  ["mahogany", "Mahogany (deep red-brown)", "#7a3b26", 0.9],
  ["sapele", "Sapele (striped red-brown)", "#8c4a2f", 1.2],
  ["acacia", "Acacia (golden brown, lively grain)", "#a8723f", 1.3],
  ["cedar", "Western red cedar (cladding, saunas)", "#b06c45", 1.0],
  ["smoked_oak", "Smoked / fumed oak (dark brown-gray)", "#6e5442", 0.9],
  ["whitewashed_oak", "Whitewashed / limed oak", "#d9cfc0", 0.5],
  ["ebony", "Ebony / black-stained wood", "#2a211c", 0.6],
  ["rosewood", "Rosewood (dark, purple-brown)", "#5a2f26", 1.1],
  ["bamboo", "Bamboo (pale straw, nodes)", "#d7b87a", 0.8],
];
for (const [k, d, c, con] of WOODS) {
  if (!LIB[`wood_${k}`]) def(`wood_${k}`, "wood_grain", `${d} wood grain`, { roughness: 0.55, scale: 0.8, params: { wood: c, contrast: con ?? 1 } });
  if (!LIB[`wood_floor_${k}`]) def(`wood_floor_${k}`, "wood_planks", `${d} floor planks`, { roughness: 0.55, scale: 1.2, params: { wood: c, contrast: con ?? 1 } });
}
def("wood_herringbone_smoked", "herringbone", "Smoked oak herringbone parquet", { roughness: 0.5, scale: 1.27, params: { wood: "#6e5442" } });
def("wood_herringbone_whitewashed", "herringbone", "Whitewashed oak herringbone parquet", { roughness: 0.55, scale: 1.27, params: { wood: "#d9cfc0", contrast: 0.5 } });
def("wood_chevron_light", "chevron", "Pale oak chevron parquet", { roughness: 0.55, scale: 1.2, params: { wood: "#d6bc93", contrast: 0.7 } });
def("vinyl_plank_gray", "wood_planks", "Gray luxury vinyl plank (LVT)", { roughness: 0.45, scale: 1.2, normalStrength: 0.4, params: { wood: "#a39d95", contrast: 0.5 } });
def("cork", "gravel", "Natural cork (floors, pin boards)", { roughness: 0.9, scale: 0.3, normalStrength: 0.6, params: { stones: 400, base: "#b48a5e" } });

def("stone_wet_dark", "stone", "Dark stone, wet (water walls): glossy charcoal with a faint texture", { roughness: 0.12, scale: 1.2, normalStrength: 0.8, color: "#3a3c3e" });
def("travertine_slabs", "tiles", "Honed travertine slabs 120 × 60 cm, staggered, fine joints (paving and cladding)", { roughness: 0.5, scale: 2.4, normalStrength: 0.5, params: { cols: 2, rows: 4, offset: 0.5, groutWidth: 0.0025, tile: "#dfcfb2", grout: "#c9b796", variation: 1.4 } });
def("limestone_slabs", "tiles", "Pale limestone slabs 120 × 60 cm, staggered, fine joints (paving and cladding)", { roughness: 0.6, scale: 2.4, normalStrength: 0.5, params: { cols: 2, rows: 4, offset: 0.5, groutWidth: 0.0025, tile: "#e7dfcf", grout: "#d2c8b4", variation: 1.1 } });
def("travertine", "marble", "Beige travertine (honed, banded)", { roughness: 0.45, scale: 2.0, normalStrength: 0.6, params: { base: "#dccbad", vein: "#b9a17c", veins: 0.25 } });
def("travertine_silver", "marble", "Silver / gray travertine", { roughness: 0.45, scale: 2.0, normalStrength: 0.6, params: { base: "#c9c4b9", vein: "#9b968c", veins: 0.25 } });
def("marble_calacatta", "marble", "Calacatta marble: white with bold gray-gold veins", { roughness: 0.15, scale: 2.4, params: { base: "#f3f1ec", vein: "#a69477", veins: 0.8 } });
def("marble_nero_marquina", "marble", "Nero Marquina: black marble with crisp white veins", { roughness: 0.12, scale: 2.0, params: { base: "#141416", vein: "#e9e9e6", veins: 0.6 } });
def("marble_emperador", "marble", "Emperador marble: chocolate brown with cream veins", { roughness: 0.15, scale: 2.0, params: { base: "#5b3f2e", vein: "#c8ad8c", veins: 0.7 } });
def("marble_verde", "marble", "Verde Guatemala: deep green marble with white veins", { roughness: 0.15, scale: 2.0, params: { base: "#1f3d32", vein: "#c9d6cc", veins: 0.7 } });
def("marble_rosa", "marble", "Rosa Portogallo: pale pink marble", { roughness: 0.15, scale: 2.0, params: { base: "#e9cfc4", vein: "#c79f92", veins: 0.5 } });
def("onyx_honey", "marble", "Honey onyx (translucent amber banding)", { roughness: 0.1, scale: 2.0, params: { base: "#e1a85c", vein: "#f6dfb1", veins: 0.9 } });
def("granite_black", "gravel", "Black granite (Absolute Black) worktop", { roughness: 0.15, scale: 0.4, normalStrength: 0.05, params: { stones: 90, base: "#232325" } });
def("granite_gray", "gravel", "Salt-and-pepper gray granite", { roughness: 0.2, scale: 0.4, normalStrength: 0.05, params: { stones: 120, base: "#a5a3a0" } });
def("limestone", "plaster", "Honed limestone (pale, uniform)", { roughness: 0.6, scale: 1.5, normalStrength: 0.8, color: "#e3dccd" });
def("slate_floor", "tiles", "Dark slate floor tiles, 40 cm", { roughness: 0.6, scale: 1.2, normalStrength: 1.5, params: { count: 3, tile: "#3e4246", grout: "#5c5f62", variation: 2 } });
def("stone_limestone_blocks", "stone", "Limestone ashlar blocks (facades)", { roughness: 0.85, scale: 1.6, params: { stoneColor: "#e1d7c3", mortar: "#c9bfab" } });
def("sandstone", "stone", "Red sandstone blocks", { roughness: 0.9, scale: 1.6, params: { stoneColor: "#b9785a", mortar: "#a99682" } });

def("brick_whitewashed", "brick", "Whitewashed brick (lime-washed, some red showing)", { roughness: 0.85, params: { brickColor: "#e2d9cf", mortar: "#eeeae3", variation: 0.6 } });
def("brick_black", "brick", "Black / charcoal glazed brick", { roughness: 0.6, params: { brickColor: "#2c2b2b", mortar: "#4d4b49" } });
def("brick_reclaimed", "brick", "Reclaimed London stock brick (mixed tones)", { roughness: 0.9, params: { brickColor: "#b28a62", mortar: "#b8b0a2", variation: 1.6 } });

def("tiles_subway_green", "tiles", "Glossy bottle-green subway tiles", { roughness: 0.1, scale: 0.6, params: { cols: 4, rows: 8, offset: 0.5, groutWidth: 0.005, tile: "#2f5c47", grout: "#d9d5cc" } });
def("tiles_subway_navy", "tiles", "Glossy navy subway tiles", { roughness: 0.1, scale: 0.6, params: { cols: 4, rows: 8, offset: 0.5, groutWidth: 0.005, tile: "#26344d", grout: "#d9d5cc" } });
def("tiles_subway_black", "tiles", "Black subway tiles, white grout", { roughness: 0.12, scale: 0.6, params: { cols: 4, rows: 8, offset: 0.5, groutWidth: 0.005, tile: "#1f2022", grout: "#d9d5cc" } });
def("tiles_subway_cream", "tiles", "Crackle-glaze cream subway tiles", { roughness: 0.15, scale: 0.6, params: { cols: 4, rows: 8, offset: 0.5, groutWidth: 0.005, tile: "#ece2cc", grout: "#d9d2c3", variation: 1.4 } });
def("tiles_square_sage", "tiles", "Sage green square tiles, 10 cm", { roughness: 0.2, scale: 0.8, params: { count: 8, tile: "#9db29a", grout: "#e3e0d6" } });
def("tiles_porcelain_gray", "tiles", "Large-format gray porcelain, 60 × 60 cm", { roughness: 0.35, scale: 1.2, params: { count: 2, tile: "#8f8f8c", grout: "#7c7b78", groutWidth: 0.002 } });
def("tiles_porcelain_white", "tiles", "Large-format white porcelain, 60 × 60 cm", { roughness: 0.3, scale: 1.2, params: { count: 2, tile: "#ebeae6", grout: "#d1cfca", groutWidth: 0.002 } });
def("tiles_porcelain_concrete", "concrete", "Concrete-look porcelain slabs", { roughness: 0.45, scale: 1.2, params: { formLines: 0, pores: 600 } });
def("tiles_zellige_terracotta", "zellige", "Terracotta zellige, handmade glossy tiles", { roughness: 0.15, scale: 0.8, params: { tile: "#b9653f", variation: 0.6 } });
def("tiles_zellige_black", "zellige", "Black zellige, handmade glossy tiles", { roughness: 0.12, scale: 0.8, params: { tile: "#1f2023", grout: "#3a3a3a" } });
def("tiles_hex_sage", "hex_tiles", "Sage green hexagon tiles, 15 cm", { roughness: 0.3, scale: 0.9, params: { tile: "#9bae97", grout: "#e3e0d6" } });
def("terrazzo_black", "terrazzo", "Black terrazzo with white and gray chips", { roughness: 0.25, scale: 1.0, normalStrength: 0.5, params: { base: "#2a2a2c", palette: "#f2f0ea,#8f8d89,#bcb8b0,#5a5856" } });
def("terrazzo_terracotta", "terrazzo", "Terracotta terrazzo with cream and rust chips", { roughness: 0.25, scale: 1.0, normalStrength: 0.5, params: { base: "#c7805f", palette: "#f2e6d6,#8e3b26,#e0b08f,#5b2a1e" } });
def("quartz_calacatta", "marble", "Calacatta-look quartz worktop", { roughness: 0.15, scale: 2.4, normalStrength: 0.2, params: { base: "#f4f3ef", vein: "#a9987c", veins: 0.7 } });

const PAINTS: [string, string, string][] = [
  ["off_white", "Off-white (soft, warm)", "#f1ede4"], ["warm_white", "Warm white", "#f4efe3"], ["greige", "Greige (gray-beige)", "#c9c0b2"],
  ["taupe", "Taupe", "#a39586"], ["sand", "Sand", "#dccbb0"], ["clay", "Clay pink-beige", "#c9a08a"], ["terracotta", "Terracotta", "#b8674a"],
  ["ochre", "Ochre", "#c99a3e"], ["mustard", "Mustard", "#d4a73f"], ["sage", "Sage green", "#a4b49a"], ["olive", "Olive green", "#7c7f52"],
  ["forest", "Forest green", "#2f4a3a"], ["mint", "Mint", "#c3dccd"], ["teal", "Teal", "#2f6b6b"], ["powder_blue", "Powder blue", "#b7cbdc"],
  ["navy", "Navy", "#26324a"], ["slate_blue", "Slate blue", "#5f7386"], ["lavender", "Lavender", "#bdb2cf"], ["dusty_pink", "Dusty pink", "#d8b0a8"],
  ["burgundy", "Burgundy / oxblood", "#5f2328"], ["charcoal", "Charcoal", "#3b3d40"], ["stone", "Stone gray", "#b3ada3"],
];
for (const [k, d, c] of PAINTS) if (!LIB[`paint_${k}`]) def(`paint_${k}`, "plaster", `Painted wall, ${d.toLowerCase()} (matt emulsion)`, { roughness: 0.78, scale: 2.0, normalStrength: 0.4, color: c });
def("plaster_lime", "plaster", "Lime plaster, hand-trowelled (cloudy, matte)", { roughness: 0.95, scale: 1.5, normalStrength: 1.6, color: "#ece6da" });
def("plaster_venetian", "microcement", "Polished Venetian plaster (stucco veneziano)", { roughness: 0.25, scale: 2.0, params: { base: "#e6ddd0", polish: 0.95, mottle: 1.1 } });
def("rammed_earth", "concrete", "Rammed earth wall (layered ochre strata)", { roughness: 0.95, scale: 1.5, normalStrength: 1.4, color: "#c49a72", params: { formLines: 6, pores: 1200 } });
def("concrete_board_formed", "concrete", "Board-formed concrete (timber shutter marks)", { roughness: 0.9, scale: 1.5, normalStrength: 1.8, params: { formLines: 10, pores: 900 } });

const METALS: [string, string, string, number][] = [
  ["antique_brass", "Antique / aged brass", "#a98a4f", 0.45], ["bronze", "Oil-rubbed bronze", "#5c4632", 0.45], ["gunmetal", "Gunmetal gray", "#4d5156", 0.35],
  ["nickel", "Brushed nickel", "#b9b6ae", 0.3], ["rose_gold", "Rose gold", "#d9a28e", 0.25], ["zinc", "Zinc (matte gray cladding)", "#8d9399", 0.55],
];
for (const [k, d, c, r] of METALS) def(`metal_${k}`, "metal", d, { roughness: r, metalness: 1, scale: 0.5, color: c });
def("metal_corten", "concrete", "Corten weathering steel (rust patina)", { roughness: 0.85, scale: 1.0, normalStrength: 0.8, color: "#8c4a26", params: { formLines: 0, pores: 2500 } });
def("metal_white", "metal", "White powder-coated metal", { roughness: 0.45, metalness: 0.3, scale: 0.5, color: "#ecebe7", normalStrength: 0.2 });

const FABRICS: [string, string, string][] = [
  ["cream", "Cream", "#ece6d8"], ["charcoal", "Charcoal", "#3d3f43"], ["terracotta", "Terracotta", "#b56a4c"], ["olive", "Olive", "#77794e"],
  ["mustard", "Mustard", "#c79a3a"], ["navy", "Navy", "#2a3550"], ["sage", "Sage", "#9fb09a"], ["rust", "Rust", "#9c4c2e"], ["blush", "Blush", "#dcb3a7"],
];
for (const [k, d, c] of FABRICS) if (!LIB[`fabric_${k}`]) def(`fabric_${k}`, "fabric", `${d} woven upholstery fabric`, { roughness: 0.95, scale: 0.3, color: c });
for (const [k, d, c] of [["navy", "Navy", "#24304a"], ["mustard", "Mustard", "#c4962f"], ["olive", "Olive", "#5d6239"], ["gray", "Dove gray", "#9a9a98"], ["burgundy", "Burgundy", "#5e2229"], ["teal", "Teal", "#1f5559"]] as const)
  def(`velvet_${k}`, "fabric", `${d} velvet`, { roughness: 0.65, scale: 0.3, color: c, normalStrength: 0.3, params: { threads: 160 } });
def("linen_natural", "fabric", "Natural flax linen (oatmeal)", { roughness: 0.95, scale: 0.35, color: "#d8cdb9", normalStrength: 1.2, params: { threads: 70 } });
def("linen_charcoal", "fabric", "Charcoal washed linen", { roughness: 0.95, scale: 0.35, color: "#4a4b4d", normalStrength: 1.2, params: { threads: 70 } });
def("fabric_boucle_gray", "fabric", "Gray boucle", { roughness: 1, scale: 0.15, color: "#b3afa8", normalStrength: 4, params: { threads: 40 } });
def("wool_felt_gray", "fabric", "Gray wool felt (acoustic panels, pinboards)", { roughness: 1, scale: 0.3, color: "#8d8e90", normalStrength: 0.5, params: { threads: 220 } });
for (const [k, d, c] of [["cognac", "Cognac", "#8e4f26"], ["white", "Off-white", "#ebe6dc"], ["olive", "Olive", "#5f5f39"], ["burgundy", "Oxblood", "#4f1f22"], ["gray", "Gray", "#7b7a77"]] as const)
  if (!LIB[`leather_${k}`]) def(`leather_${k}`, "leather", `${d} leather`, { roughness: 0.55, scale: 0.4, color: c });
def("rattan_cane", "fabric", "Woven rattan cane webbing (chair seats, cabinet doors)", { roughness: 0.8, scale: 0.12, color: "#d7b583", normalStrength: 3, params: { threads: 24 } });
def("jute", "carpet", "Natural jute / sisal (rugs)", { roughness: 1, scale: 0.4, color: "#bfa178", normalStrength: 2 });
def("carpet_charcoal", "carpet", "Charcoal wall-to-wall carpet", { roughness: 1, scale: 0.5, color: "#55565a" });
def("carpet_cream", "carpet", "Cream wool carpet", { roughness: 1, scale: 0.5, color: "#e5ddcc" });

for (const [k, d, c, r] of [["black", "Satin black", "#202123", 0.35], ["terracotta", "Terracotta", "#b46a4f", 0.38], ["olive", "Olive", "#6f7150", 0.38], ["blue_gray", "Blue-gray", "#6f8292", 0.36], ["pink", "Dusty pink", "#d6aea4", 0.36], ["forest", "Forest green", "#2f4a3b", 0.36]] as const)
  def(`lacquer_${k}`, "none", `${d} lacquered / painted cabinet fronts`, { roughness: r, color: c, normalStrength: 0 });
def("glass_bronze", "none", "Bronze-tinted glass", { roughness: 0.05, opacity: 0.5, color: "#8d6a4a", doubleSided: true, normalStrength: 0 });
def("glass_smoked", "none", "Smoked gray glass", { roughness: 0.05, opacity: 0.55, color: "#4a4c4f", doubleSided: true, normalStrength: 0 });
def("glass_blue", "none", "Blue-green architectural glass", { roughness: 0.05, opacity: 0.35, color: "#7fa7a6", doubleSided: true, normalStrength: 0 });
def("glass_fluted", "fluted", "Fluted / reeded glass (privacy screens, cabinet doors)", { roughness: 0.15, opacity: 0.55, scale: 0.4, color: "#e6eef0", doubleSided: true, params: { style: "reeds" } });

export const MATERIAL_LIBRARY: Record<string, MaterialDef> = LIB;

/** Representative library material for each raw pattern name (used when `base` is a pattern). */
const PATTERN_DEFAULT: Record<TexturePattern, string> = {
  none: "plastic_white",
  brick: "brick_red",
  stone: "stone_gray",
  plaster: "plaster_white",
  concrete: "concrete",
  wood_planks: "wood_floor_oak",
  wood_grain: "wood_oak",
  tiles: "tiles_white",
  marble: "marble_white",
  roof_tiles: "roof_tiles_red",
  shingles: "shingles_gray",
  metal: "metal_steel",
  fabric: "fabric_white",
  carpet: "carpet_beige",
  leather: "leather_brown",
  grass: "grass",
  gravel: "gravel",
  paving: "paving_stone",
  siding: "siding_white",
  disks: "enamel_discs",
  herringbone: "wood_herringbone_oak",
  chevron: "wood_chevron_oak",
  parquet: "wood_parquet_oak",
  terrazzo: "terrazzo_white",
  hex_tiles: "tiles_hex_white",
  mosaic: "tiles_mosaic_blue",
  zellige: "tiles_zellige_white",
  wallpaper: "wallpaper_stripes_sage",
  fluted: "slats_oak",
  microcement: "microcement_gray",
  grasscloth: "grasscloth_natural",
  palm_frond: "palm_frond",
  leaf_cluster: "olive_leaves",
  palm_bark: "palm_bark",
};

function clone(m: MaterialDef, name: string): MaterialDef {
  return {
    ...m,
    name,
    color: [...m.color] as RGB,
    ...(m.emissive ? { emissive: [...m.emissive] as RGB } : {}),
    ...(m.params ? { params: { ...m.params } } : {}),
  };
}

const normName = (s: string) => s.trim().toLowerCase().replace(/[\s-]+/g, "_");
const isPattern = (s: string): s is TexturePattern => (TEXTURE_PATTERNS as readonly string[]).includes(s);
const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
/** Online library references: ambientcg:<AssetId>, polyhaven:<asset_id>. */
export const ONLINE_RE = /^(ambientcg|polyhaven):[\w.-]+$/i;

/** RAL Classic paint: "ral_9010", "RAL 7016", "ral-3020". */
function ralMaterial(name: string): MaterialDef | undefined {
  const m = /^ral[\s_-]?(\d{4})$/i.exec(name.trim());
  if (!m || !RAL[m[1]]) return undefined;
  const [label, hex] = RAL[m[1]];
  return { ...hexMaterial(`ral_${m[1]}`, parseColor(hex)!), roughness: 0.6, source: { id: `RAL ${m[1]}`, title: label, license: "colour reference" } };
}

/** Flat painted material for a bare hex color. */
function hexMaterial(name: string, color: RGB): MaterialDef {
  return { name, pattern: "plaster", color, roughness: 0.75, metalness: 0, scale: 2, opacity: 1, normalStrength: 0.3 };
}

function colorField(v: unknown, field: string, owner: string): RGB {
  const c = parseColor(v);
  if (!c) throw new Error(`Material "${owner}": invalid ${field} ${JSON.stringify(v)} — use "#rrggbb" or [r,g,b] with 0..1 components.`);
  return c;
}

/**
 * Resolve a material reference.
 * Order: custom materials (inheriting from `base`), then the built-in library, then a bare "#rrggbb" color.
 * Throws a helpful error listing close matches otherwise.
 */
export function resolveMaterial(nameOrDef: string, custom?: Record<string, CustomMaterialSpec>): MaterialDef {
  return resolveInner(nameOrDef, custom ?? {}, []);
}

function findCustom(name: string, custom: Record<string, CustomMaterialSpec>): [string, CustomMaterialSpec] | undefined {
  if (Object.prototype.hasOwnProperty.call(custom, name)) return [name, custom[name]];
  const n = normName(name);
  for (const k of Object.keys(custom)) if (normName(k) === n) return [k, custom[k]];
  return undefined;
}

function resolveInner(raw: string, custom: Record<string, CustomMaterialSpec>, chain: string[]): MaterialDef {
  if (typeof raw !== "string" || !raw.trim()) throw new Error(`Material name must be a non-empty string (got ${JSON.stringify(raw)}).`);
  const name = raw.trim();

  const found = findCustom(name, custom);
  if (found) {
    const [key, spec] = found;
    if (chain.includes(key)) throw new Error(`Custom material cycle: ${[...chain, key].join(" -> ")}. A material cannot (indirectly) use itself as base.`);
    return applySpec(key, spec, custom, [...chain, key]);
  }

  const n = normName(name);
  if (LIB[n]) return clone(LIB[n], n);
  if (HEX_RE.test(name)) return hexMaterial(name, parseColor(name)!);
  const ral = ralMaterial(name);
  if (ral) return ral;
  const ext = externalMaterial(name);
  if (ext) return { ...ext, color: [...ext.color] as RGB, ...(ext.images ? { images: { ...ext.images } } : {}) };
  if (ONLINE_RE.test(name)) throw new Error(`Online material "${name}" has not been fetched yet (it is downloaded automatically by the CLI / MCP tools; offline? see search_assets)`);
  if (isPattern(n)) return clone(LIB[PATTERN_DEFAULT[n]], n);

  throw new Error(unknownMessage(name, custom));
}

function applySpec(key: string, spec: CustomMaterialSpec, custom: Record<string, CustomMaterialSpec>, chain: string[]): MaterialDef {
  let m: MaterialDef;
  if (spec.base !== undefined) {
    const b = spec.base.trim();
    // a base named like the custom material itself refers to the library entry / pattern, not itself
    const bc = findCustom(b, custom);
    if (bc && bc[0] !== key) m = resolveInner(bc[0], custom, chain);
    else if (LIB[normName(b)]) m = clone(LIB[normName(b)], key);
    else if (isPattern(normName(b))) m = clone(LIB[PATTERN_DEFAULT[normName(b) as TexturePattern]], key);
    else if (HEX_RE.test(b)) m = hexMaterial(key, parseColor(b)!);
    else if (ralMaterial(b)) m = { ...ralMaterial(b)!, name: key };
    else if (externalMaterial(b)) {
      const e = externalMaterial(b)!;
      m = { ...e, color: [...e.color] as RGB, ...(e.images ? { images: { ...e.images } } : {}), name: key };
    } else if (parseColor(b)) m = hexMaterial(key, parseColor(b)!);
    else throw new Error(`Custom material "${key}": unknown base "${b}". ` + unknownMessage(b, custom));
  } else if (spec.pattern) {
    m = clone(LIB[PATTERN_DEFAULT[spec.pattern]] ?? LIB.plaster_white, key);
  } else if (LIB[normName(key)]) {
    // overriding a library material in place, e.g. { "brick_red": { scale: 0.8 } }
    m = clone(LIB[normName(key)], key);
  } else {
    m = clone(LIB.plaster_white, key);
  }
  m.name = key;

  if (spec.pattern !== undefined) {
    if (!isPattern(spec.pattern)) throw new Error(`Custom material "${key}": unknown pattern "${spec.pattern}". Valid patterns: ${TEXTURE_PATTERNS.join(", ")}.`);
    m.pattern = spec.pattern;
  }
  if (spec.color !== undefined) m.color = colorField(spec.color, "color", key);
  if (spec.emissive !== undefined) m.emissive = colorField(spec.emissive, "emissive", key);
  const num = (v: number | undefined, field: string, lo: number, hi: number): number | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== "number" || !isFinite(v)) throw new Error(`Custom material "${key}": ${field} must be a number (got ${JSON.stringify(v)}).`);
    return Math.min(hi, Math.max(lo, v));
  };
  m.roughness = num(spec.roughness, "roughness", 0, 1) ?? m.roughness;
  m.metalness = num(spec.metalness, "metalness", 0, 1) ?? m.metalness;
  m.opacity = num(spec.opacity, "opacity", 0, 1) ?? m.opacity;
  m.normalStrength = num(spec.normalStrength, "normalStrength", 0, 10) ?? m.normalStrength;
  const sc = num(spec.scale, "scale", 0.001, 1000);
  if (sc !== undefined) m.scale = sc;
  if (spec.doubleSided !== undefined) m.doubleSided = !!spec.doubleSided;
  if (spec.params) m.params = { ...(m.params ?? {}), ...spec.params };
  if (m.opacity < 1 && spec.doubleSided === undefined && m.doubleSided === undefined) m.doubleSided = true;
  return m;
}

/** Levenshtein distance (small strings). */
function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

/** Rank known names by similarity: shared word parts, substrings, then edit distance. */
export function suggestMaterials(name: string, custom: Record<string, CustomMaterialSpec> = {}, max = 6): string[] {
  const n = normName(name);
  const words = n.split("_").filter((w) => w.length > 1);
  const all = [...new Set([...Object.keys(custom), ...Object.keys(LIB)])];
  const scored = all.map((cand) => {
    const c = normName(cand);
    let score = editDistance(n, c);
    if (c.includes(n) || n.includes(c)) score -= 6;
    for (const w of words) if (c.includes(w)) score -= 4;
    // candidate parts found inside the query, e.g. "redbrick" → brick_red
    for (const w of c.split("_")) if (w.length > 2 && n.includes(w)) score -= 4;
    return { cand, score };
  });
  scored.sort((a, b) => a.score - b.score || a.cand.localeCompare(b.cand));
  return scored.slice(0, max).map((s) => s.cand);
}

function unknownMessage(name: string, custom: Record<string, CustomMaterialSpec>): string {
  const sugg = suggestMaterials(name, custom);
  return (
    `Unknown material "${name}". Did you mean: ${sugg.join(", ")}? ` +
    `Use a built-in library name (list_materials), a "#rrggbb" color for flat paint, ` +
    `or define it under "materials" as { "base": "<library material or pattern>", "color": "#rrggbb", ... }. ` +
    `Patterns: ${TEXTURE_PATTERNS.join(", ")}.`
  );
}

/** All built-in materials with a short description. */
export function listMaterials(): { name: string; pattern: string; description: string }[] {
  return Object.keys(LIB).map((name) => ({ name, pattern: LIB[name].pattern, description: DESCRIPTIONS[name] ?? "" }));
}
