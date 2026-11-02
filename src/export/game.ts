import { COLLIDER } from "../elements/stairs.js";
import { unwrapLightmap } from "./lightmap.js";
import type { NavArea, NavLanding } from "./navmeta.js";
import { m4, type Mat4, type Vec3 } from "../geometry/math.js";
import { MeshBuilder, type MeshData } from "../geometry/mesh.js";
import { nodeLocalMatrix, type SceneNode } from "../geometry/scene.js";

export interface GameOptions {
  /** One mesh per level for all static geometry (a sub-mesh per material). Movable things stay separate. */
  merge?: boolean;
  /** Add collision nodes: "<level>-colonly" (static, non-convex) and "<item>-convcolonly" boxes on movable items. */
  collision?: boolean;
  /** A non-overlapping second UV set on the merged static meshes, for baked lighting. */
  lightmapUV?: boolean;
  /** Navigation markers: room / stair area volumes and lift landings (names the Unity package reads). */
  nav?: { areas: NavArea[]; landings: NavLanding[] };
}

/** Marker names carry the data, since glTF importers drop extras: "nav-area|kind|sizeX|sizeY|height|label", "nav-lift|id|stop". */
function navNodes(nav: NonNullable<GameOptions["nav"]>, level: number): SceneNode[] {
  const f = (n: number) => n.toFixed(3);
  const out: SceneNode[] = [];
  for (const a of nav.areas.filter((x) => x.level === level))
    for (const [x0, y0, x1, y1] of a.rects)
      out.push({
        name: `nav-area|${a.kind}|${f(x1 - x0)}|${f(y1 - y0)}|${f(a.height)}|${a.name.replace(/\|/g, "/")}`,
        kind: "nav_area",
        meshes: [],
        children: [],
        translation: [(x0 + x1) / 2, (y0 + y1) / 2, a.z],
        extras: { navArea: a.kind, room: a.name, size: [x1 - x0, y1 - y0], height: a.height },
      });
  for (const l of nav.landings.filter((x) => x.level === level))
    out.push({ name: `nav-lift|${l.lift}|${l.stop}`, kind: "nav_link", meshes: [], children: [], translation: [l.at[0], l.at[1], l.z], extras: { lift: l.lift, stop: l.stop } });
  return out;
}

/** Nodes that keep their own pivot so games can move/animate them. */
const MOVABLE = new Set(["furniture", "door_leaf", "light_fixture"]);
/** Flat or overhead items that shouldn't block movement. */
const NO_COLLIDER = new Set(["rug", "door_mat", "ceiling_light", "curtain", "surgical_light", "medical_pendant", "privacy_curtain"]);

/** Concatenate meshes, grouping by material, transforming by `m` when given. */
export function mergeMeshes(meshes: { mesh: MeshData; m?: Mat4 }[], overrideMaterial?: string): MeshData[] {
  const groups = new Map<string, MeshData>();
  for (const { mesh, m } of meshes) {
    const key = overrideMaterial ?? mesh.material;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { material: key, positions: [], normals: [], uvs: [], indices: [] }));
    const base = g.positions.length / 3;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const p: Vec3 = [mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]];
      const n: Vec3 = [mesh.normals[i], mesh.normals[i + 1], mesh.normals[i + 2]];
      const wp = m ? m4.point(m, p) : p, wn = m ? m4.normal(m, n) : n;
      g.positions.push(wp[0], wp[1], wp[2]);
      g.normals.push(wn[0], wn[1], wn[2]);
    }
    g.uvs.push(...mesh.uvs);
    for (const i of mesh.indices) g.indices.push(i + base);
  }
  return [...groups.values()];
}

function aabb(meshes: MeshData[]): { min: Vec3; max: Vec3 } | null {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const m of meshes)
    for (let i = 0; i < m.positions.length; i += 3)
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], m.positions[i + k]);
        max[k] = Math.max(max[k], m.positions[i + k]);
      }
  return isFinite(min[0]) ? { min, max } : null;
}

/** Box collider child for a movable node (in the node's local space). */
export function boxCollider(n: SceneNode): SceneNode | null {
  if (NO_COLLIDER.has(String(n.extras?.type)) || n.kind === "light_fixture") return null;
  const meshes = [...n.meshes, ...n.children.flatMap((c) => (c.translation || c.rotationZ ? [] : c.meshes))];
  const b = aabb(meshes);
  if (!b || b.max[2] - b.min[2] < 0.05) return null;
  const mb = new MeshBuilder();
  // trees and palms collide at the trunk: people walk under the canopy
  if (n.extras?.type === "tree") mb.box(COLLIDER, [-0.18, -0.18, b.min[2]], [0.18, 0.18, b.max[2]]);
  else mb.box(COLLIDER, b.min, b.max);
  return { name: `${n.name}-convcolonly`, kind: "collider", meshes: mb.meshes(), children: [], extras: { collider: "box" } };
}

export interface Collected {
  render: { mesh: MeshData; m?: Mat4 }[];
  collide: { mesh: MeshData; m?: Mat4 }[];
  movable: { node: SceneNode; world: Mat4 }[];
  rooms: SceneNode[];
}

/** Split a subtree into static render/collision geometry and movable nodes (with world transforms). */
export function collect(n: SceneNode, parent: Mat4, out: Collected) {
  const hasT = !!(n.translation || n.rotationZ);
  const world = hasT ? m4.mul(parent, nodeLocalMatrix(n)) : parent;
  if (MOVABLE.has(n.kind)) {
    out.movable.push({ node: n, world });
    return;
  }
  const m = world === IDENTITY ? undefined : world;
  for (const mesh of n.meshes) out.render.push({ mesh, m });
  // static geometry collides as itself unless the builder supplied something simpler (stair ramps, railing walls);
  // switch / socket plates and ceiling detectors are flush fittings, not obstacles (one over a stairwell would cut it)
  if (n.name !== "services") for (const mesh of n.collision ?? n.meshes) out.collide.push({ mesh, m });
  if (n.kind === "room" || n.kind === "terrace") out.rooms.push(n);
  for (const c of n.children) collect(c, world, out);
}
export const IDENTITY = m4.identity();

/** Re-root a movable node at the top of its level, baking its accumulated transform. */
function rehome(node: SceneNode, world: Mat4, collision: boolean): SceneNode {
  // movable nodes only ever carry translation + rotation about Z, so read them back from the matrix
  const t: Vec3 = [world[12], world[13], world[14]];
  const rot = Math.atan2(world[1], world[0]);
  const copy: SceneNode = { ...node, translation: t, rotationZ: rot, children: [...node.children] };
  // doors: a marker at the hinge turned back to the closed position, where a closed door blocks the doorway
  // (the Unity package puts the NavMesh obstacle on it); the leaf itself may be modelled ajar
  if (node.kind === "door_leaf" && typeof node.extras?.closedRotationZ === "number") {
    const parentRot = rot - (node.rotationZ ?? 0);
    const delta = node.extras.closedRotationZ + parentRot - rot;
    copy.children.push({ name: `nav-doorway|${((delta * 180) / Math.PI).toFixed(1)}`, kind: "marker", meshes: [], children: [], rotationZ: delta });
  }
  if (collision) {
    const box = boxCollider(node);
    if (box) copy.children.push(box);
  }
  return copy;
}

/** Shape the scene for game engines: optional static merging and collision nodes. */
export function prepareForGame(root: SceneNode, opts: GameOptions): SceneNode {
  if (!opts.merge && !opts.collision && !opts.nav) return root;
  const out: SceneNode = { ...root, children: [] };
  let levelIndex = 0;
  for (const lvl of root.children) {
    const li = lvl.kind === "level" ? levelIndex++ : -1;
    const col: Collected = { render: [], collide: [], movable: [], rooms: [] };
    collect(lvl, IDENTITY, col);
    const children: SceneNode[] = [];
    if (opts.merge) {
      const merged = mergeMeshes(col.render);
      children.push({ name: `${lvl.name}_static`, kind: "static", meshes: opts.lightmapUV && merged.length ? unwrapLightmap(merged) : merged, children: [], extras: { static: true } });
      // rooms survive as empty marker nodes (handy for spawn points / triggers)
      if (col.rooms.length)
        children.push({
          name: "rooms",
          kind: "group",
          meshes: [],
          children: col.rooms.map((r) => {
            const b = aabb(r.meshes);
            const fz = typeof r.extras?.floorZ === "number" ? r.extras.floorZ : b?.min[2] ?? 0;
            const c: Vec3 = b ? [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, fz] : [0, 0, fz];
            return { name: r.name, kind: "room", meshes: [], children: [], translation: c, extras: r.extras };
          }),
        });
      const furniture = col.movable.filter((x) => x.node.kind === "furniture");
      const doors = col.movable.filter((x) => x.node.kind === "door_leaf");
      if (furniture.length)
        children.push({ name: "furniture", kind: "group", meshes: [], children: furniture.map((x) => rehome(x.node, x.world, !!opts.collision)) });
      if (doors.length)
        children.push({ name: "doors", kind: "group", meshes: [], children: doors.map((x) => rehome(x.node, x.world, !!opts.collision)) });
      const fixtures = col.movable.filter((x) => x.node.kind === "light_fixture");
      if (fixtures.length)
        children.push({ name: "lights", kind: "group", meshes: [], children: fixtures.map((x) => rehome(x.node, x.world, false)) });
    } else {
      // keep the original hierarchy, just attach box colliders to movable nodes
      const attach = (n: SceneNode): SceneNode => {
        const kids = n.children.map(attach);
        if (opts.collision && MOVABLE.has(n.kind)) {
          const box = boxCollider(n);
          if (box) kids.push(box);
        }
        return { ...n, children: kids };
      };
      children.push(...attach(lvl).children);
      if (lvl.meshes.length) children.unshift({ name: `${lvl.name}_meshes`, kind: "static", meshes: lvl.meshes, children: [] });
    }
    if (opts.nav && li >= 0) {
      const nn = navNodes(opts.nav, li);
      if (nn.length) children.push({ name: "nav", kind: "group", meshes: [], children: nn });
    }
    if (opts.collision && col.collide.length)
      children.push({
        name: `${lvl.name}-colonly`,
        kind: "collider",
        meshes: mergeMeshes(col.collide, COLLIDER),
        children: [],
        extras: { collider: "mesh" },
      });
    out.children.push({ ...lvl, meshes: [], children });
  }
  return out;
}
