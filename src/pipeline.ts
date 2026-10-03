import { buildProject, type LevelInfo } from "./build.js";
import { walkMeshes, type SceneNode } from "./geometry/scene.js";
import { resolveMaterial } from "./materials/library.js";
import { generateTextures } from "./materials/textures.js";
import type { MaterialDef, TextureSet } from "./materials/types.js";
import { parseProject, type Project } from "./schema/schema.js";
import { checkLayout } from "./validate/layout.js";
import { applyStyles } from "./elements/styles.js";

export interface Compiled {
  ok: boolean;
  project?: Project;
  root?: SceneNode;
  levels: LevelInfo[];
  materials: Map<string, MaterialDef>;
  errors: string[];
  warnings: string[];
  stats: { triangles: number; meshes: number; nodes: number; materials: number };
}

const MISSING: MaterialDef = {
  name: "missing",
  pattern: "none",
  color: [1, 0, 1],
  roughness: 0.8,
  metalness: 0,
  scale: 1,
  opacity: 1,
  normalStrength: 1,
};

/** Parse, validate, build geometry and resolve materials. Mesh UVs end up in texture-tile units. */
export function compile(input: unknown): Compiled {
  const empty = { levels: [], materials: new Map(), warnings: [], stats: { triangles: 0, meshes: 0, nodes: 0, materials: 0 } };
  // style presets fill in unset materials; they must see the raw plan to tell explicit values from defaults
  const parsed = parseProject(applyStyles(input));
  if (!parsed.ok || !parsed.project) return { ok: false, errors: parsed.errors, ...empty };
  const project = parsed.project;
  let built;
  try {
    built = buildProject(project);
  } catch (e) {
    return { ok: false, project, errors: [`internal build error: ${(e as Error).stack ?? e}`], ...empty };
  }
  const { root, levels, errors, warnings } = built;
  try {
    warnings.push(...checkLayout(project, levels));
  } catch (e) {
    warnings.push(`layout checks failed: ${(e as Error).message}`);
  }

  const materials = new Map<string, MaterialDef>();
  const unknown = new Set<string>();
  let triangles = 0, meshes = 0, nodes = 0;
  const countNodes = (n: SceneNode) => {
    nodes++;
    n.children.forEach(countNodes);
  };
  countNodes(root);
  walkMeshes(root, (m) => {
    let def = materials.get(m.material);
    if (!def) {
      try {
        def = resolveMaterial(m.material, project.materials as never);
      } catch (e) {
        if (!unknown.has(m.material)) errors.push((e as Error).message);
        unknown.add(m.material);
        def = { ...MISSING, name: m.material };
      }
      materials.set(m.material, def);
    }
    // meters -> texture tiles
    const s = 1 / def.scale;
    for (let i = 0; i < m.uvs.length; i++) m.uvs[i] *= s;
    triangles += m.indices.length / 3;
    meshes++;
  });
  return {
    ok: errors.length === 0,
    project,
    root,
    levels,
    materials,
    errors,
    warnings,
    stats: { triangles, meshes, nodes, materials: materials.size },
  };
}

const texCache = new Map<string, TextureSet>();

const WHITE: [number, number, number] = [1, 1, 1];

/**
 * Untinted textures for a material (cached per definition + size, ignoring `color`), so tinted variants
 * (fabric_gray / fabric_blue, paint_*...) share images. Consumers apply `def.color` as a multiplier
 * (glTF baseColorFactor, renderer material color). Undefined for flat-color materials.
 */
export function texturesFor(def: MaterialDef, size: number): TextureSet | undefined {
  if (def.pattern === "none") return undefined;
  const key = JSON.stringify([def.pattern, def.roughness, def.metalness, def.opacity, def.normalStrength, def.params, size]);
  let t = texCache.get(key);
  if (!t) texCache.set(key, (t = generateTextures({ ...def, color: WHITE }, size)));
  return t;
}
