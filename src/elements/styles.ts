import { z } from "zod";
import { pointInPolygon, type Vec2 } from "../geometry/math.js";
import { FURNITURE } from "./furniture.js";

/**
 * Interior style presets. A style maps material ROLES (floor, walls, wood, upholstery, metal...) to
 * materials. It is applied to the raw plan before validation: anything the plan sets explicitly wins,
 * the style only fills gaps (room floors/ceilings, furniture slots left at their defaults, door/window
 * materials). Rooms can override the project style; furniture follows the room it stands in.
 */

export const STYLE_ROLES = [
  "floor", // room floor finish
  "walls", // interior wall faces (room finishes)
  "ceiling",
  "wood", // furniture timber: frames, legs, tops, shelves
  "paintedWood", // painted joinery / furniture
  "upholstery", // sofas, chairs, cushions
  "leather",
  "metal", // legs, frames, handles
  "stone", // counters, table tops
  "bedding",
  "rug",
  "door", // door leaves
  "doorFrame",
  "windowFrame",
  "cabinetFront", // casework fronts
  "cabinetCarcass",
  "worktop",
  "handle",
] as const;
export type StyleRole = (typeof STYLE_ROLES)[number];

type Palette = Partial<Record<StyleRole, string>>;
interface Preset {
  description: string;
  palette: Palette;
  /** Custom materials the palette refers to (merged into project.materials unless already defined). */
  materials?: Record<string, Record<string, unknown>>;
}

export const STYLE_PRESETS: Record<string, Preset> = {
  scandinavian: {
    description: "Light oak, white walls, soft greys and linen, black metal accents",
    palette: {
      floor: "wood_floor_light", walls: "#f4f2ee", ceiling: "paint_white", wood: "wood_oak", paintedWood: "wood_painted_white",
      upholstery: "style_scandi_fabric", leather: "leather_tan", metal: "metal_black", stone: "marble_white", bedding: "linen_white",
      rug: "carpet_beige", door: "wood_painted_white", doorFrame: "wood_painted_white", windowFrame: "plastic_white",
      cabinetFront: "wood_painted_white", cabinetCarcass: "wood_painted_white", worktop: "wood_oak", handle: "metal_black",
    },
    materials: { style_scandi_fabric: { base: "fabric_gray", color: "#d9d6cf" } },
  },
  japandi: {
    description: "Warm oak and walnut, clay and sand tones, natural textures, matte black details",
    palette: {
      floor: "wood_floor_oak", walls: "#ebe5da", ceiling: "#f1ece3", wood: "wood_oak", paintedWood: "style_japandi_clay",
      upholstery: "style_japandi_fabric", leather: "leather_tan", metal: "metal_black", stone: "style_japandi_stone", bedding: "linen_white",
      rug: "carpet_beige", door: "wood_oak", doorFrame: "wood_oak", windowFrame: "metal_black",
      cabinetFront: "wood_oak", cabinetCarcass: "wood_oak", worktop: "style_japandi_stone", handle: "metal_black",
    },
    materials: {
      style_japandi_fabric: { base: "fabric_beige", color: "#e6dccb" },
      style_japandi_clay: { base: "plaster_beige", color: "#d9c7b0" },
      style_japandi_stone: { base: "concrete", color: "#cfc8bd" },
    },
  },
  modern_minimal: {
    description: "Polished concrete, white walls, dark timber, grey upholstery, chrome",
    palette: {
      floor: "concrete_polished", walls: "#f5f5f3", ceiling: "paint_white", wood: "wood_dark", paintedWood: "paint_white",
      upholstery: "fabric_gray", leather: "leather_black", metal: "chrome", stone: "marble_white", bedding: "linen_white",
      rug: "carpet_gray", door: "paint_white", doorFrame: "paint_white", windowFrame: "metal_black",
      cabinetFront: "paint_white", cabinetCarcass: "paint_white", worktop: "marble_white", handle: "metal_steel",
    },
  },
  industrial: {
    description: "Concrete floors, raw brick and black steel, dark timber and worn leather",
    palette: {
      floor: "concrete_polished", walls: "#d8d3cb", ceiling: "concrete", wood: "wood_dark", paintedWood: "paint_black",
      upholstery: "fabric_gray", leather: "leather_brown", metal: "metal_black", stone: "concrete_dark", bedding: "linen_white",
      rug: "carpet_gray", door: "wood_dark", doorFrame: "metal_black", windowFrame: "metal_black",
      cabinetFront: "wood_dark", cabinetCarcass: "paint_black", worktop: "concrete_dark", handle: "metal_black",
    },
  },
  mid_century: {
    description: "Walnut, mustard and teal upholstery, brass details, warm white walls",
    palette: {
      floor: "wood_floor_walnut", walls: "#efe8dc", ceiling: "paint_white", wood: "wood_walnut", paintedWood: "style_mcm_teal",
      upholstery: "style_mcm_mustard", leather: "leather_tan", metal: "metal_brass", stone: "marble_white", bedding: "linen_white",
      rug: "carpet_beige", door: "wood_walnut", doorFrame: "wood_walnut", windowFrame: "wood_walnut",
      cabinetFront: "wood_walnut", cabinetCarcass: "wood_walnut", worktop: "marble_white", handle: "metal_brass",
    },
    materials: {
      style_mcm_mustard: { base: "fabric_beige", color: "#c99a3c" },
      style_mcm_teal: { base: "paint_blue", color: "#2f6f73" },
    },
  },
  classic: {
    description: "Dark walnut, deep blue velvet, brass, marble and warm cream walls",
    palette: {
      floor: "wood_floor_walnut", walls: "#ece4d6", ceiling: "#f6f1e8", wood: "wood_dark", paintedWood: "style_classic_cream",
      upholstery: "style_classic_velvet", leather: "leather_brown", metal: "metal_brass", stone: "marble_white", bedding: "linen_white",
      rug: "carpet_red", door: "style_classic_cream", doorFrame: "style_classic_cream", windowFrame: "wood_painted_white",
      cabinetFront: "style_classic_cream", cabinetCarcass: "style_classic_cream", worktop: "marble_white", handle: "metal_brass",
    },
    materials: {
      style_classic_velvet: { base: "fabric_blue", color: "#2c3e66", roughness: 0.55 },
      style_classic_cream: { base: "wood_painted_white", color: "#efe6d4" },
    },
  },
  coastal: {
    description: "Whitewashed timber, sand and sea-blue fabrics, rope and brushed metal",
    palette: {
      floor: "wood_floor_light", walls: "#f4f6f5", ceiling: "paint_white", wood: "wood_painted_white", paintedWood: "wood_painted_white",
      upholstery: "style_coastal_blue", leather: "leather_tan", metal: "metal_aluminum", stone: "marble_white", bedding: "linen_white",
      rug: "carpet_beige", door: "wood_painted_white", doorFrame: "wood_painted_white", windowFrame: "plastic_white",
      cabinetFront: "wood_painted_white", cabinetCarcass: "wood_painted_white", worktop: "marble_white", handle: "metal_aluminum",
    },
    materials: { style_coastal_blue: { base: "fabric_blue", color: "#a9c3d1" } },
  },
  luxury: {
    description: "Marble, walnut, emerald velvet and gold accents",
    palette: {
      floor: "marble_white", walls: "#ede8df", ceiling: "#f7f4ee", wood: "wood_walnut", paintedWood: "style_lux_taupe",
      upholstery: "style_lux_emerald", leather: "leather_black", metal: "metal_gold", stone: "marble_black", bedding: "linen_white",
      rug: "carpet_beige", door: "wood_walnut", doorFrame: "wood_walnut", windowFrame: "metal_black",
      cabinetFront: "wood_walnut", cabinetCarcass: "wood_walnut", worktop: "marble_white", handle: "metal_gold",
    },
    materials: {
      style_lux_emerald: { base: "fabric_green", color: "#1f5a45", roughness: 0.5 },
      style_lux_taupe: { base: "wood_painted_white", color: "#bfb2a3" },
    },
  },
  boho: {
    description: "Warm terracotta and rust fabrics, natural wood and rattan, plants, brass",
    palette: {
      floor: "wood_floor_oak", walls: "#efe4d4", ceiling: "#f6efe4", wood: "wood_teak", paintedWood: "style_boho_terracotta",
      upholstery: "style_boho_rust", leather: "leather_tan", metal: "metal_brass", stone: "tiles_terracotta", bedding: "linen_white",
      rug: "carpet_red", door: "wood_teak", doorFrame: "wood_teak", windowFrame: "wood_teak",
      cabinetFront: "wood_teak", cabinetCarcass: "wood_teak", worktop: "tiles_terracotta", handle: "metal_brass",
    },
    materials: {
      style_boho_rust: { base: "fabric_red", color: "#b5643d" },
      style_boho_terracotta: { base: "plaster_beige", color: "#c88763" },
    },
  },
  farmhouse: {
    description: "Rustic pine and oak, sage and cream joinery, black iron hardware, butcher-block tops",
    palette: {
      floor: "wood_floor_oak", walls: "#f1eee6", ceiling: "paint_white", wood: "wood_pine", paintedWood: "style_farm_sage",
      upholstery: "linen_white", leather: "leather_brown", metal: "metal_black", stone: "wood_oak", bedding: "linen_white",
      rug: "carpet_beige", door: "style_farm_cream", doorFrame: "style_farm_cream", windowFrame: "wood_painted_white",
      cabinetFront: "style_farm_sage", cabinetCarcass: "style_farm_cream", worktop: "wood_oak", handle: "metal_black",
    },
    materials: {
      style_farm_sage: { base: "wood_painted_white", color: "#a7b39b" },
      style_farm_cream: { base: "wood_painted_white", color: "#efe9dc" },
    },
  },
};

export const StyleSchema = z
  .union([
    z.enum(Object.keys(STYLE_PRESETS) as [string, ...string[]]),
    z
      .object({ base: z.enum(Object.keys(STYLE_PRESETS) as [string, ...string[]]).optional() })
      .catchall(z.string())
      .describe(`A preset to start from plus role overrides, e.g. {"base":"scandinavian","upholstery":"fabric_blue"}. Roles: ${STYLE_ROLES.join(", ")}`),
  ])
  .describe(
    `Interior style preset (${Object.keys(STYLE_PRESETS).join(", ")}) or {base, ...role overrides}. Fills in materials the plan leaves unset: room floors/walls/ceilings, furniture slots, doors, cabinetry. Explicit materials always win.`,
  );

type Json = Record<string, any>;

function resolveStyle(style: unknown): { palette: Palette; materials: Record<string, Json> } | null {
  if (!style) return null;
  if (typeof style === "string") {
    const p = STYLE_PRESETS[style];
    return p ? { palette: { ...p.palette }, materials: { ...(p.materials ?? {}) } } : null;
  }
  if (typeof style === "object") {
    const s = style as Json;
    const base = s.base && STYLE_PRESETS[s.base];
    const palette: Palette = { ...(base?.palette ?? {}) };
    for (const r of STYLE_ROLES) if (typeof s[r] === "string") palette[r] = s[r];
    return { palette, materials: { ...(base?.materials ?? {}) } };
  }
  return null;
}

/** Which style role a furniture slot's default material plays. */
export function roleOf(defaultMaterial: string, slot: string): StyleRole | null {
  const m = defaultMaterial;
  if (/^(bulb|glass|mirror|screen|water)$/.test(slot) || /glass|mirror|emissive|screen|water|plant|soil|dirt|rubber|tire/.test(m)) return null;
  if (/^linen/.test(m) && /mattress|duvet|pillow|sheet|bedding/.test(slot)) return "bedding";
  if (/^carpet/.test(m)) return "rug";
  if (/^leather/.test(m)) return "leather";
  if (/^(fabric|linen|wicker)/.test(m)) return "upholstery";
  if (/^wood_painted/.test(m)) return "paintedWood";
  if (/^wood_(?!floor)/.test(m)) return "wood";
  if (/^(metal|chrome)/.test(m)) return "metal";
  if (/^(marble|granite)/.test(m)) return "stone";
  return null;
}

/**
 * Apply project / room styles to a raw plan (returns a new object; the input is untouched).
 * Runs before schema validation so explicit values can be told apart from defaults.
 */
export function applyStyles(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const plan = structuredClone(input) as Json;
  const levels: Json[] = Array.isArray(plan.levels) ? plan.levels : [];
  const projectStyle = resolveStyle(plan.style);
  const anyRoomStyle = levels.some((l) => (l.rooms ?? []).some((r: Json) => r?.style));
  if (!projectStyle && !anyRoomStyle) return plan;

  plan.materials = plan.materials ?? {};
  const inject = (st: ReturnType<typeof resolveStyle>) => {
    if (!st) return;
    for (const [k, v] of Object.entries(st.materials)) if (!(k in plan.materials)) plan.materials[k] = v;
  };
  inject(projectStyle);

  if (projectStyle) {
    const pal = projectStyle.palette;
    plan.defaults = plan.defaults ?? {};
    const d = plan.defaults;
    if (pal.floor && d.floorMaterial === undefined) d.floorMaterial = pal.floor;
    if (pal.ceiling && d.ceilingMaterial === undefined) d.ceilingMaterial = pal.ceiling;
    if (pal.walls && d.wallMaterial === undefined) d.wallMaterial = pal.walls;
    if (pal.door && d.doorMaterial === undefined) d.doorMaterial = pal.door;
    if (pal.doorFrame && d.doorFrameMaterial === undefined) d.doorFrameMaterial = pal.doorFrame;
    if (pal.windowFrame && d.windowFrameMaterial === undefined) d.windowFrameMaterial = pal.windowFrame;
  }

  for (const lv of levels) {
    const rooms: Json[] = Array.isArray(lv.rooms) ? lv.rooms : [];
    const roomStyles = rooms.map((r) => {
      const st = resolveStyle(r?.style) ?? projectStyle;
      inject(st);
      return st;
    });
    rooms.forEach((r, i) => {
      const st = roomStyles[i];
      if (!st || !r) return;
      if (st.palette.floor && r.floorMaterial === undefined) r.floorMaterial = st.palette.floor;
      if (st.palette.ceiling && r.ceilingMaterial === undefined) r.ceilingMaterial = st.palette.ceiling;
      if (st.palette.walls) {
        r.finishes = r.finishes ?? {};
        if (r.finishes.walls === undefined) r.finishes.walls = st.palette.walls;
      }
      delete r.style; // consumed
    });
    const styleAt = (p: unknown) => {
      if (!Array.isArray(p) || p.length < 2) return projectStyle;
      const i = rooms.findIndex((r) => Array.isArray(r?.polygon) && pointInPolygon(p as Vec2, r.polygon as Vec2[]));
      return i >= 0 ? roomStyles[i] : projectStyle;
    };

    for (const f of Array.isArray(lv.furniture) ? lv.furniture : []) {
      const type = f && FURNITURE[f.type];
      const st = styleAt(f?.position);
      if (!type || !st) continue;
      f.materials = f.materials ?? {};
      for (const [slot, def] of Object.entries(type.slots as Record<string, string>)) {
        if (f.materials[slot] !== undefined) continue;
        const role = roleOf(def, slot);
        const mat = role && st.palette[role];
        if (mat) f.materials[slot] = mat;
      }
    }

    // cabinetry: fill the common material slots when the run doesn't set them
    for (const c of Array.isArray(lv.casework) ? lv.casework : []) {
      const pos = c?.position ?? c?.path?.[0];
      const st = styleAt(pos);
      if (!st || !c) continue;
      c.materials = c.materials ?? {};
      const map: Record<string, StyleRole> = { front: "cabinetFront", carcass: "cabinetCarcass", worktop: "worktop", handle: "handle", plinth: "cabinetCarcass" };
      for (const [slot, role] of Object.entries(map)) if (c.materials[slot] === undefined && st.palette[role]) c.materials[slot] = st.palette[role];
    }
  }
  delete plan.style;
  return plan;
}

export function listStyles(): { name: string; description: string; palette: Palette }[] {
  return Object.entries(STYLE_PRESETS).map(([name, p]) => ({ name, description: p.description, palette: p.palette }));
}
