/** Procedural texture patterns the generator knows how to paint. "none" = flat color. */
export const TEXTURE_PATTERNS = [
  "none",
  "brick",
  "stone",
  "plaster",
  "concrete",
  "wood_planks",
  "wood_grain",
  "tiles",
  "marble",
  "roof_tiles",
  "shingles",
  "metal",
  "fabric",
  "carpet",
  "leather",
  "grass",
  "gravel",
  "paving",
  "siding",
  "disks",
  "herringbone",
  "chevron",
  "parquet",
  "terrazzo",
  "hex_tiles",
  "mosaic",
  "zellige",
  "wallpaper",
  "fluted",
  "microcement",
  "grasscloth",
  "palm_frond",
  "leaf_cluster",
  "palm_bark",
] as const;
export type TexturePattern = (typeof TEXTURE_PATTERNS)[number];

export type RGB = [number, number, number]; // linear-ish 0..1, treated as sRGB tint

export interface MaterialDef {
  name: string;
  /** Which procedural texture to paint. */
  pattern: TexturePattern;
  /** Multiplied with the pattern's base color (sRGB 0..1). Patterns are painted in natural colors; use white to keep them. */
  color: RGB;
  roughness: number;
  metalness: number;
  /** Real-world size in meters covered by one texture tile. */
  scale: number;
  /** < 1 makes the material alpha-blended (glass). */
  opacity: number;
  emissive?: RGB;
  doubleSided?: boolean;
  /** Bump strength multiplier for the generated normal map. */
  normalStrength: number;
  /** Optional per-pattern knobs, e.g. { mortar: "#cccccc", rows: 8 }. Patterns ignore unknown keys. */
  params?: Record<string, number | string>;
  /**
   * Photo / scanned PBR maps (downloaded or extracted from an imported model) used instead of the procedural
   * pattern. With maps, `roughness` / `metalness` multiply the map values (glTF semantics).
   */
  images?: ImageMaps;
  /** Alpha-tested cut-outs (foliage, fabric lace): texels below this alpha are discarded. */
  alphaCutoff?: number;
  /** Where the material comes from (online library, imported model) for credits and licences. */
  source?: AssetSource;
}

export interface ImageMaps {
  baseColor?: string;
  normal?: string;
  /** glTF metallicRoughness-style map: G roughness, B metalness (R ignored unless `ao` is the same file). */
  orm?: string;
  roughness?: string;
  ao?: string;
  metalness?: string;
  /** Alpha from the base colour (cut-outs / glass). */
  alpha?: boolean;
}

export interface AssetSource {
  /** e.g. "ambientcg:WoodFloor051", "polyhaven:ArmChair_01", "ikea:59305928" */
  id: string;
  title?: string;
  url?: string;
  author?: string;
  /** "CC0", "CC-BY-4.0", "vendor" (product visualisation; not for redistribution)... */
  license: string;
  /** Set when the asset could not be fetched and a stand-in is used. */
  missing?: string;
}

/** Square, tileable RGBA8 textures. `orm` packs occlusion (R), roughness (G), metalness (B) as glTF expects. */
export interface TextureSet {
  size: number;
  baseColor: Uint8Array;
  normal: Uint8Array;
  orm: Uint8Array;
}
