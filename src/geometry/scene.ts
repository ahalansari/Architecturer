import { m4, type Mat4, type Vec3 } from "./math.js";
import type { MeshData } from "./mesh.js";

/**
 * Intermediate scene graph produced by the builder and consumed by the
 * exporters and renderers. Plan space: Z-up, meters.
 *
 * Most nodes have no transform (meshes already in world space). Movable things
 * (furniture, door leaves) carry a pivot: their meshes are local to
 * translate(translation) * rotateZ(rotationZ), relative to the parent node.
 */
export interface SceneNode {
  name: string;
  /** building | level | walls | wall | opening | door_leaf | slab | room | stair | roof | furniture | column | group */
  kind: string;
  meshes: MeshData[];
  children: SceneNode[];
  translation?: Vec3;
  /** Radians, counter-clockwise around +Z. */
  rotationZ?: number;
  /**
   * Simplified collision geometry (same space as `meshes`). When absent, game
   * export falls back to the render meshes (static) or a bounding box (movable).
   */
  collision?: MeshData[];
  /** Copied into glTF node extras (ids, room names, element types...). */
  extras?: Record<string, unknown>;
}

export function nodeLocalMatrix(node: SceneNode): Mat4 {
  const t = node.translation ?? [0, 0, 0];
  return m4.place(t[0], t[1], t[2], node.rotationZ ?? 0);
}

/** Visit every mesh with its node's accumulated world matrix. */
export function walkMeshes(
  node: SceneNode,
  fn: (mesh: MeshData, node: SceneNode, world: Mat4) => void,
  parent: Mat4 = m4.identity(),
) {
  const world = node.translation || node.rotationZ ? m4.mul(parent, nodeLocalMatrix(node)) : parent;
  for (const m of node.meshes) fn(m, node, world);
  for (const c of node.children) walkMeshes(c, fn, world);
}

export function sceneBounds(node: SceneNode): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  walkMeshes(node, (m, _n, world) => {
    for (let i = 0; i < m.positions.length; i += 3) {
      const p = m4.point(world, [m.positions[i], m.positions[i + 1], m.positions[i + 2]]);
      for (let k = 0; k < 3; k++) {
        if (p[k] < min[k]) min[k] = p[k];
        if (p[k] > max[k]) max[k] = p[k];
      }
    }
  });
  return { min, max };
}
