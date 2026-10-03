/**
 * In-memory registry of prepared external assets (online materials, imported models), filled by the async
 * `prepareAssets` step and read synchronously by material resolution and the build.
 */
import type { MeshData } from "../geometry/mesh.js";
import type { AssetSource, MaterialDef } from "../materials/types.js";

export interface ImportedModel {
  /** Canonical source key (what furniture.model is rewritten to). */
  key: string;
  /** Meshes in model space: plan axes (z up, front toward -y), metres, footprint centred on 0,0, bottom at z 0. */
  meshes: MeshData[];
  /** Natural size [width x, depth y, height z]. */
  size: [number, number, number];
  triangles: number;
  source: AssetSource;
}

const materials = new Map<string, MaterialDef>();
const models = new Map<string, ImportedModel>();

const key = (s: string) => s.trim().toLowerCase();

export function registerMaterial(name: string, def: MaterialDef) {
  materials.set(key(name), def);
}
export function externalMaterial(name: string): MaterialDef | undefined {
  return materials.get(key(name));
}
export function externalMaterialNames(): string[] {
  return [...materials.values()].map((m) => m.name);
}
export function registerModel(m: ImportedModel) {
  models.set(m.key, m);
}
export function getModel(k: string): ImportedModel | undefined {
  return models.get(k);
}
