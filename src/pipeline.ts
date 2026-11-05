import { buildProject, type LevelInfo } from "./build.js";
import { walkMeshes, type SceneNode } from "./geometry/scene.js";
import { resolveMaterial } from "./materials/library.js";
import { generateTextures } from "./materials/textures.js";
import { paintInWorkers } from "./materials/texpool.js";
import type { MaterialDef, TextureSet } from "./materials/types.js";
import { parseProject, type Project } from "./schema/schema.js";
import { checkLayout } from "./validate/layout.js";
import { designHvac, hvacNode, type HvacDesign } from "./elements/hvac.js";
import { designAirside } from "./elements/airside.js";
import { applyLifts, designLifts, liftSpec, liftsNode, type LiftDesign } from "./elements/lifts.js";
import type { Circuit } from "./elements/services.js";
import { designLandscape, type LandscapeDesign } from "./elements/landscape.js";
import { designWater, type WaterDesign } from "./elements/water.js";
import { designPumpPits, pumpPitsNode, type PitDesign } from "./elements/pumppit.js";
import { constructionSystem } from "./elements/construction.js";
import { applyStyles } from "./elements/styles.js";
import { applyProducts } from "./elements/products.js";
import { creditsFor, prepareAssets } from "./assets/prepare.js";
import type { AssetSource } from "./materials/types.js";
import { imageTextureSet } from "./assets/images.js";

export interface Compiled {
  ok: boolean;
  project?: Project;
  root?: SceneNode;
  levels: LevelInfo[];
  materials: Map<string, MaterialDef>;
  errors: string[];
  warnings: string[];
  stats: { triangles: number; meshes: number; nodes: number; materials: number };
  /** External assets used (online materials, imported / vendor models) with their licences. */
  credits: AssetSource[];
  /** Informational messages (not problems): models simplified for real-time use, vendor sizes corrected... */
  notes?: string[];
  /** Air conditioning: cooling loads, units, ducted layout and coordination issues. */
  hvac?: HvacDesign;
  /** Lifts with a shaft: spec, checks, geometry for plans and the bill. */
  lifts?: LiftDesign[];
  /** Power supplies for the lifts (electrical schedule). */
  liftCircuits?: Circuit[];
  /** Gardens: areas, plants, irrigation zones and water demand. */
  landscape?: LandscapeDesign;
  /** Water supply hydraulics: pipe sizes, pressures, hot-water waits, storage, drainage stacks. */
  water?: WaterDesign;
  /** Pump pits of floors below the sewer: sizing, pumps, rising mains (simulated by the pump_pit tool). */
  pumpPits?: PitDesign[];
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
  const empty = { levels: [], materials: new Map(), warnings: [], stats: { triangles: 0, meshes: 0, nodes: 0, materials: 0 }, credits: [] };
  // products expand into furniture first; style presets then fill unset materials (they must see the raw plan
  // to tell explicit values from defaults)
  const prod = applyProducts(input);
  if (prod.errors.length) return { ok: false, errors: prod.errors, ...empty };
  const lifted = applyLifts(prod.input);
  if (lifted.errors.length) return { ok: false, errors: lifted.errors, ...empty };
  const parsed = parseProject(applyStyles(lifted.input));
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

  // lifts: spec, checks, power supply; car, landing doors and roof overrun in 3D
  let lifts: LiftDesign[] = [];
  let liftCircuits: Circuit[] = [];
  try {
    const d = designLifts(project as never, levels);
    lifts = d.lifts;
    liftCircuits = d.circuits;
    for (const l of lifts) for (const i of l.issues) warnings.push(`elevator '${l.id}': ${i}`);
    const node = liftsNode(lifts, levels);
    if (node) root.children.push(node);
  } catch (e) {
    warnings.push(`lift design failed: ${(e as Error).message}`);
  }

  // gardens: areas, plants and the irrigation design
  let landscape: LandscapeDesign | undefined;
  try {
    landscape = designLandscape(project as never, levels);
    for (const i of landscape.issues.filter((i) => /inside a room/.test(i))) warnings.push(i);
  } catch (e) {
    warnings.push(`landscape design failed: ${(e as Error).message}`);
  }

  // water: hydraulics of the plumbing layout
  let water: WaterDesign | undefined;
  try {
    if (levels.some((l) => l.services.points.some((p) => p.type === "inlet"))) water = designWater(project as never, levels, landscape?.demand.litresPerDay ?? 0);
  } catch (e) {
    warnings.push(`water design failed: ${(e as Error).message}`);
  }

  // pump pits: basements below the sewer, sized; missing ones are flagged
  let pumpPits: PitDesign[] | undefined;
  try {
    const d = designPumpPits(project as never, levels);
    pumpPits = d.pits;
    warnings.push(...d.issues);
    for (const p of d.pits) for (const i of p.issues) warnings.push(`pump pit '${p.id}': ${i}`);
    const node = pumpPitsNode(d.pits, levels);
    if (node) root.children.push(node);
  } catch (e) {
    warnings.push(`pump pit design failed: ${(e as Error).message}`);
  }

  // air conditioning: loads, units, ducted layout, and the equipment in 3D
  let hvac: HvacDesign | undefined;
  try {
    hvac = designHvac(project as never, levels, project.construction?.exteriorWall ?? constructionSystem(project.construction).exteriorWall);
    hvac.air = designAirside(hvac, levels, project.levels.map((l) => l.rooms));
    const node = hvacNode(hvac, levels, (l) => project.levels[l].rooms.length);
    if (node) root.children.push(node);
  } catch (e) {
    warnings.push(`air conditioning design failed: ${(e as Error).message}`);
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
    hvac,
    lifts,
    liftCircuits,
    landscape,
    water,
    pumpPits,
    notes: lifts.length ? lifts.map((l) => liftSpec(l)) : undefined,
    materials,
    errors,
    warnings,
    stats: { triangles, meshes, nodes, materials: materials.size },
    credits: creditsFor(materials.values()),
  };
}

/**
 * compile() after fetching / importing the external assets the plan references (online materials, models,
 * vendor products). `baseDir` resolves relative model paths (the plan file's folder).
 */
export async function compileWithAssets(input: unknown, opts: { baseDir: string }): Promise<Compiled> {
  const prep = await prepareAssets(input, opts);
  const c = compile(prep.input);
  c.warnings.unshift(...prep.warnings);
  c.notes = [...prep.notes, ...(c.notes ?? [])];
  return c;
}

/** One-line licence notice for exports that contain vendor models (empty when there are none). */
export function vendorNotice(c: Compiled): string {
  const v = c.credits.filter((s) => s.license === "vendor");
  return v.length
    ? `Contains ${v.length} vendor product model(s) (${[...new Set(v.map((s) => s.url?.match(/https?:\/\/(?:www\.)?([^/]+)/)?.[1] ?? s.id))].slice(0, 3).join(", ")}): fine for visualising a design; check the vendor's terms before redistributing them in a game or app.`
    : "";
}

const texCache = new Map<string, TextureSet>();

const WHITE: [number, number, number] = [1, 1, 1];

/**
 * Untinted textures for a material (cached per definition + size, ignoring `color`), so tinted variants
 * (fabric_gray / fabric_blue, paint_*...) share images. Consumers apply `def.color` as a multiplier
 * (glTF baseColorFactor, renderer material color). Undefined for flat-color materials.
 */
export function texturesFor(def: MaterialDef, size: number): TextureSet | undefined {
  if (def.images) {
    const key = JSON.stringify(["img", def.images, def.roughness, def.metalness, def.opacity, size]);
    let t = texCache.get(key);
    if (!t) {
      try {
        texCache.set(key, (t = imageTextureSet(def.images, size, def.roughness, def.metalness, def.opacity)));
      } catch {
        return undefined; // unreadable image: flat colour
      }
    }
    return t;
  }
  if (def.pattern === "none") return undefined;
  const key = proceduralKey(def, size);
  let t = texCache.get(key);
  if (!t) texCache.set(key, (t = generateTextures({ ...def, color: WHITE }, size)));
  return t;
}

const proceduralKey = (def: MaterialDef, size: number) =>
  JSON.stringify([def.pattern, def.roughness, def.metalness, def.opacity, def.normalStrength, def.params, size]);

/**
 * Paint these materials' procedural textures on worker threads, so later texturesFor calls find them
 * ready. Best-effort: anything it doesn't paint is painted on demand as before.
 */
export async function prefetchTextures(defs: Iterable<MaterialDef>, size: number): Promise<void> {
  const todo = new Map<string, MaterialDef>();
  for (const def of defs) {
    if (def.images || def.pattern === "none") continue;
    const key = proceduralKey(def, size);
    if (!texCache.has(key)) todo.set(key, { ...def, color: WHITE });
  }
  if (todo.size < 2) return; // not worth starting workers
  try {
    const sets = await paintInWorkers([...todo.values()], size);
    [...todo.keys()].forEach((k, i) => texCache.set(k, sets[i]));
  } catch {
    /* painted on demand */
  }
}
