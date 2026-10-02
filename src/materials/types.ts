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
}

/** Square, tileable RGBA8 textures. `orm` packs occlusion (R), roughness (G), metalness (B) as glTF expects. */
export interface TextureSet {
  size: number;
  baseColor: Uint8Array;
  normal: Uint8Array;
  orm: Uint8Array;
}
