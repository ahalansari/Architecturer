import { sceneBounds, type SceneNode } from "../geometry/scene.js";
import type { Vec3 } from "../geometry/math.js";
import { texturesFor, type Compiled } from "../pipeline.js";
import { encodePNG, renderPreset, renderScene, type LightingMode, type LightOccluderLevel, type MaterialLookup, type ViewPreset } from "./raster.js";
import { interiorCamera, type InteriorView } from "./interior.js";

export interface ViewOptions {
  view?: ViewPreset;
  /** Cut away everything above this level's walls (shows the floor plan in 3D). */
  level?: string;
  width?: number;
  height?: number;
  /** Custom camera instead of a preset. */
  eye?: Vec3;
  target?: Vec3;
  fov?: number;
  textureSize?: number;
  /** Plan point [x, y] (or [x, y, z]) to frame instead of the whole building. */
  focus?: [number, number] | [number, number, number];
  /** Meters around `focus` to keep in view (default 3). */
  radius?: number;
  /** > 1 moves the camera closer (2 = twice as close), < 1 further away. */
  zoom?: number;
  /** Cutaway height above the level floor (default: min(0.75 * level height, 2.2)). */
  cutHeight?: number;
  /** day (default) | night (artificial lights only, to judge a lighting design) | dusk */
  lighting?: LightingMode;
  /** Interior review: eye-level shot of a room, or a square-on wall elevation (see interior.ts). */
  interior?: InteriorView;
}

/** Render the compiled building to a PNG (pure JS, headless). */
export function renderViewPNG(c: Compiled, o: ViewOptions = {}): Buffer {
  if (!c.root || !c.project) throw new Error("project failed to compile: " + c.errors.join("; "));
  const texSize = o.textureSize ?? 256;
  // textures are untinted; the renderer multiplies them by def.color
  const lookup: MaterialLookup = (name) => {
    const def = c.materials.get(name)!;
    return { def, tex: texturesFor(def, texSize) };
  };

  let clipZ: number | undefined;
  let root: SceneNode = c.root;
  if (o.level) {
    const li = c.project.levels.findIndex((l) => l.id === o.level);
    if (li < 0) throw new Error(`level '${o.level}' not found (levels: ${c.project.levels.map((l) => l.id).join(", ")})`);
    const info = c.levels[li];
    clipZ = info.elevation + (o.cutHeight ?? Math.min(info.height * 0.75, 2.2));
    // drop the levels above entirely so their slabs don't get section caps
    root = { ...c.root, children: c.root.children.filter((n) => n.kind !== "level" || c.root!.children.indexOf(n) <= li) };
  }
  // frame the building, not the ground plane
  const building: SceneNode = { ...root, children: root.children.filter((n) => n.kind !== "site") };
  let bounds = sceneBounds(building);
  if (o.focus) {
    const r = o.radius ?? 3;
    const baseZ = o.level ? c.levels.find((l) => l.id === o.level)!.elevation : bounds.min[2];
    const fz = o.focus[2] ?? baseZ + 1;
    bounds = { min: [o.focus[0] - r, o.focus[1] - r, fz - r * 0.6], max: [o.focus[0] + r, o.focus[1] + r, fz + r * 0.6] };
  }
  if (o.zoom && o.zoom > 0) {
    const ctr = bounds.min.map((v, i) => (v + bounds.max[i]) / 2);
    const k = 1 / o.zoom;
    bounds = {
      min: bounds.min.map((v, i) => ctr[i] + (v - ctr[i]) * k) as Vec3,
      max: bounds.max.map((v, i) => ctr[i] + (v - ctr[i]) * k) as Vec3,
    };
  }
  const width = o.width ?? 1280, height = o.height ?? 800;
  // walls block artificial light, so lamps don't leak into neighbouring rooms
  const occluders: LightOccluderLevel[] = c.levels.map((l) => ({
    z0: l.elevation,
    z1: l.elevation + l.height,
    walls: l.segments.map((sg) => ({ a: sg.a, b: sg.b, z0: sg.z0, z1: sg.z1, holes: sg.holes })),
  }));
  const opts = { width, height, clipZ, lighting: o.lighting, occluders };
  const shot = o.interior && (o.interior.room || o.interior.elevation) ? interiorCamera(c, o.interior, width / height) : null;
  if (shot?.clipZ !== undefined) {
    // elevations show one floor: drop the levels above and cut at the top of the wall
    root = { ...c.root, children: c.root.children.filter((n) => n.kind !== "level" || c.root!.children.indexOf(n) <= shot.level) };
    opts.clipZ = shot.clipZ;
  }
  const img = shot
    ? renderScene(root, lookup, shot.camera, opts)
    : o.eye
    ? renderScene(root, lookup, { eye: o.eye, target: o.target ?? bounds.min.map((v, i) => (v + bounds.max[i]) / 2) as Vec3, fov: o.fov }, opts)
    : renderPreset(root, lookup, o.view ?? "iso", bounds, opts);
  return encodePNG(img);
}
