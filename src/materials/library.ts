/**
 * Built-in material library + name resolution (custom materials, library names, hex colors).
 */
import { parseColor } from "./textures.js";
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
def("plant_green", "grass", "Leafy plant foliage (bushes, hedges, house plants)", { roughness: 0.8, scale: 0.4, doubleSided: true, params: { base: "#4d8a3a", blades: 9000 } });
def("gravel", "gravel", "Loose gravel / pebbles", { roughness: 0.9, scale: 1.0 });
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
