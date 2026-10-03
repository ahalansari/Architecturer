import { FURNITURE } from "./elements/furniture.js";
import { buildColumn, buildRailing, buildSlab, holesInside, railingCollider } from "./elements/misc.js";
import { buildOpening, checkOverlaps, placeOpening, type PlacedOpening } from "./elements/openings.js";
import { buildRoof } from "./elements/roofs.js";
import { buildStair, COLLIDER, type StairResult } from "./elements/stairs.js";
import { buildTerrace } from "./elements/terraces.js";
import { buildShape, shapeFootprint } from "./elements/shapes.js";
import { addLampLight, buildLights, checkUnlitRooms } from "./elements/lighting.js";
import { buildRoomFinishes, prepareFinishes, type CeilingLayout } from "./elements/finishes.js";
import { buildCasework, levelCaseCtx } from "./elements/casework.js";
import { buildWallSegment, expandWalls, resolveJoins, splitJunctions, type WallSegment } from "./elements/walls.js";
import { deg2rad, ensureCCW, offsetPolygon, polygonArea, type Vec2 } from "./geometry/math.js";
import { MeshBuilder } from "./geometry/mesh.js";
import type { SceneNode } from "./geometry/scene.js";
import { ELEMENT_KINDS, type Level, type Project } from "./schema/schema.js";

export interface LevelInfo {
  id: string;
  name: string;
  elevation: number;
  height: number;
  segments: WallSegment[];
  openings: PlacedOpening[];
  stairOutlines: Vec2[][];
  stairs: (StairResult & { id: string; target: number })[];
  /** Room ceilings as built (one per room, same order as level.rooms). */
  ceilings: CeilingLayout[];
}

export interface BuildOutput {
  root: SceneNode;
  levels: LevelInfo[];
  errors: string[];
  warnings: string[];
}

/** Room floor finishes sit this far above the slab top. */
export const FLOOR_FINISH = 0.01;

const FACING_ROT = { south: 0, east: 90, north: 180, west: 270 } as const;

export { FACING_ROT };

export function suggest(name: string, options: string[], n = 4): string[] {
  const dist = (a: string, b: string) => {
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return dp[a.length][b.length];
  };
  return [...options]
    .map((o) => ({ o, d: o.includes(name) || name.includes(o) ? 0 : dist(name, o) }))
    .sort((x, y) => x.d - y.d)
    .slice(0, n)
    .map((x) => x.o);
}

function node(name: string, kind: string, mb?: MeshBuilder, extras?: Record<string, unknown>): SceneNode {
  return { name, kind, meshes: mb ? mb.meshes() : [], children: [], extras };
}

export function levelElevations(project: Project): number[] {
  const out: number[] = [];
  project.levels.forEach((lv, i) => {
    out.push(lv.elevation ?? (i === 0 ? 0 : out[i - 1] + project.levels[i - 1].height));
  });
  return out;
}

export function buildProject(project: Project): BuildOutput {
  const errors: string[] = [];
  const warnings: string[] = [];
  const D = project.defaults;
  const elev = levelElevations(project);
  const slabT = (lv: Level) => lv.slabThickness ?? D.slabThickness;
  const root: SceneNode = { name: project.name, kind: "building", meshes: [], children: [], extras: { generator: "architecturer" } };
  const infos: LevelInfo[] = [];

  // stairwells: stairs on one level cut the slabs of the level they arrive at
  const holesByLevel = new Map<number, Vec2[][]>();

  const ids = new Set<string>();
  const checkId = (id: string | undefined, where: string) => {
    if (!id) return;
    if (ids.has(id)) warnings.push(`${where}: duplicate id '${id}'`);
    ids.add(id);
  };

  project.levels.forEach((lv, li) => {
    const z = elev[li];
    const where = (s: string) => `level '${lv.id}': ${s}`;
    const levelNode: SceneNode = {
      name: lv.name ?? lv.id,
      kind: "level",
      meshes: [],
      children: [],
      extras: { id: lv.id, elevation: z, height: lv.height },
    };
    root.children.push(levelNode);
    const err = (m: string) => errors.push(where(m));
    const warn = (m: string) => warnings.push(where(m));
    for (const kind of ELEMENT_KINDS)
      for (const el of lv[kind] as { id?: string }[]) checkId(el.id, where(kind));

    // ---- stairs (first, so their footprints are known) ----
    const stairOutlines: Vec2[][] = [];
    const stairInfos: LevelInfo["stairs"] = [];
    const stairsNode = node("stairs", "group");
    lv.stairs.forEach((s, i) => {
      const mb = new MeshBuilder(), col = new MeshBuilder();
      const r = buildStair(mb, s, z, lv.height, col);
      stairOutlines.push(...r.footprints);
      const sn = node(s.id ?? `stair${i}`, "stair", mb, { id: s.id, type: s.type, steps: r.steps });
      sn.collision = col.meshes();
      stairsNode.children.push(sn);
      const target = elev.findIndex((e, j) => j > li && Math.abs(e - r.topZ) < 0.05);
      stairInfos.push({ ...r, id: s.id ?? `stair${i}`, target });
      if (s.cutSlabAbove) {
        if (target >= 0) holesByLevel.set(target, [...(holesByLevel.get(target) ?? []), ...r.footprints]);
        else if (li < project.levels.length - 1) warn(`stair ${s.id ?? i} tops out at z=${r.topZ.toFixed(2)} which is not the elevation of any higher level`);
      }
    });

    // ---- walls + openings ----
    let segs = expandWalls(lv.walls, project, z, lv.height);
    segs = splitJunctions(segs, warnings);
    resolveJoins(segs);
    const placed: PlacedOpening[] = [];
    lv.openings.forEach((op, i) => {
      const p = placeOpening(op, i, segs, z, errors, warnings);
      if (p) {
        placed.push(p);
        const half = p.width / 2;
        p.seg.holes.push({ u0: p.u - half, u1: p.u + half, z0: p.z0, z1: p.z0 + p.height });
      }
    });
    checkOverlaps(placed, warnings);
    // room finishes paint wall faces per room side, so they must run before the walls are emitted
    const finishPlan = prepareFinishes(lv.rooms, segs, placed, z, z + FLOOR_FINISH, warn);
    const wallsNode = node("walls", "group");
    const byWall = new Map<string, MeshBuilder>();
    for (const s of segs) {
      let mb = byWall.get(s.wallId);
      if (!mb) byWall.set(s.wallId, (mb = new MeshBuilder()));
      buildWallSegment(mb, s);
    }
    for (const [id, mb] of byWall) wallsNode.children.push(node(id, "wall", mb, { id }));
    const openingsNode = node("openings", "group");
    // ceiling height for curtain tracks / blinds (window treatments)
    const treatCeil = z + (lv.ceilingHeight ?? lv.height - (li + 1 < project.levels.length ? slabT(project.levels[li + 1]) : slabT(lv)));
    for (const p of placed) openingsNode.children.push(buildOpening(p, project, { ceilingZ: treatCeil }));

    // ---- slabs ----
    const slabsNode = node("slabs", "group");
    const holes = holesByLevel.get(li) ?? [];
    const usedHoles = new Set<Vec2[]>();
    const T = slabT(lv);
    if (lv.autoSlab)
      lv.walls.forEach((w, wi) => {
        if (!w.closed || w.points.length < 3) return;
        const t = w.thickness ?? D.exteriorWallThickness ?? D.wallThickness;
        // 1 cm inside the outer face so the slab edge never z-fights with the wall
        const outline = offsetPolygon(ensureCCW(w.points as Vec2[]), Math.max(0, t / 2 - 0.01));
        const hs = holesInside(outline, holes, warn);
        hs.forEach((h) => usedHoles.add(h));
        const mb = new MeshBuilder();
        buildSlab(mb, outline, hs, z, T, lv.slabMaterial, lv.slabBottomMaterial);
        slabsNode.children.push(node(`slab_${w.id ?? `wall${wi}`}`, "slab", mb, { auto: true }));
      });
    lv.slabs.forEach((s, i) => {
      const outline = s.polygon as Vec2[];
      const hs = [...(s.holes as Vec2[][]), ...holesInside(outline, holes, warn)];
      hs.forEach((h) => usedHoles.add(h));
      const mb = new MeshBuilder();
      const mat = s.material ?? lv.slabMaterial;
      buildSlab(mb, outline, hs, z + s.offset, s.thickness ?? T, mat, s.bottomMaterial ?? lv.slabBottomMaterial, s.edgeMaterial ?? mat);
      slabsNode.children.push(node(s.id ?? `slab${i}`, "slab", mb, { id: s.id }));
    });

    // ---- rooms: floor finish + ceiling ----
    const roomsNode = node("rooms", "group");
    const nextSlab = li + 1 < project.levels.length ? slabT(project.levels[li + 1]) : T;
    const ceilingH = lv.ceilingHeight ?? lv.height - nextSlab;
    const ceilings: CeilingLayout[] = [];
    lv.rooms.forEach((r, i) => {
      const mb = new MeshBuilder();
      const poly = r.polygon as Vec2[];
      const roomHoles = holes.filter((h) => h.every((p) => insideLoose(p, poly)));
      // stairwells only cut the room floor if they're on this level's slab (arriving stairs)
      const structure = lv.height - nextSlab;
      if (r.finishes) {
        const ch = r.ceilingHeight ?? ceilingH;
        ceilings[i] = buildRoomFinishes(mb, finishPlan, i, {
          ceilingHeight: ch,
          structureHeight: structure,
          floorMaterial: r.floorMaterial ?? D.floorMaterial,
          ceilingMaterial: r.ceilingMaterial === false ? false : r.ceilingMaterial ?? D.ceilingMaterial,
          ceilingZ: z + ch - 0.01,
          floorHoles: roomHoles,
          ceilingHoles: stairOutlines.filter((h) => h.every((p) => insideLoose(p, poly))),
        });
      } else mb.flat(r.floorMaterial ?? D.floorMaterial, poly, z + FLOOR_FINISH, false, roomHoles);
      if (r.ceilingMaterial !== false && !r.finishes) {
        const ch = r.ceilingHeight ?? ceilingH;
        // stairs going up from this room need a hole in the ceiling too
        const up = stairOutlines.filter((h) => h.every((p) => insideLoose(p, poly)));
        mb.flat(r.ceilingMaterial ?? D.ceilingMaterial, poly, z + ch - 0.01, true, up);
      }
      if (!r.finishes) {
        const ch = r.ceilingHeight ?? ceilingH;
        const up = stairOutlines.filter((h) => h.every((p) => insideLoose(p, poly)));
        ceilings[i] = r.ceilingMaterial === false
          ? { room: i, type: "none", height: ch, structure, outline: poly, holes: up, beams: [] }
          : { room: i, type: "flat", material: r.ceilingMaterial ?? D.ceilingMaterial, height: ch, structure, outline: poly, holes: up, beams: [] };
      }
      roomsNode.children.push(node(r.id ?? r.name.replace(/\W+/g, "_"), "room", mb, { id: r.id, room: r.name, floorZ: z + FLOOR_FINISH, area: Math.round((polygonArea(poly) - roomHoles.reduce((a, h) => a + polygonArea(h), 0)) * 100) / 100 }));
    });

    // ---- furniture ----
    const furnNode = node("furniture", "group");
    lv.furniture.forEach((f, i) => {
      const type = FURNITURE[f.type];
      if (!type) {
        err(`furniture[${i}]: unknown type '${f.type}'. Did you mean: ${suggest(f.type, Object.keys(FURNITURE)).join(", ")}?`);
        return;
      }
      const mb = new MeshBuilder();
      const opts: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(type.options ?? {})) opts[k] = v.default;
      Object.assign(opts, f.options);
      for (const slot of Object.keys(f.materials))
        if (!(slot in type.slots)) warn(`furniture '${f.id ?? f.type + i}': unknown material slot '${slot}' (slots: ${Object.keys(type.slots).join(", ")})`);
      try {
        type.build(mb, {
          width: f.width ?? type.defaults.width,
          depth: f.depth ?? type.defaults.depth,
          height: f.height ?? type.defaults.height,
          materials: { ...type.slots, ...f.materials },
          options: opts,
        });
      } catch (e) {
        err(`furniture '${f.id ?? f.type + i}': ${(e as Error).message}`);
        return;
      }
      const rot = f.rotation ?? (f.facing ? FACING_ROT[f.facing] : 0);
      furnNode.children.push({
        name: f.id ?? `${f.type}_${i}`,
        kind: "furniture",
        meshes: mb.meshes(),
        children: [],
        // stand on the room's floor finish, not the slab (thin items like rugs would z-fight with it)
        translation: [f.position[0], f.position[1], z + FLOOR_FINISH + f.elevation],
        rotationZ: deg2rad(rot),
        extras: { id: f.id, type: f.type },
      });
      addLampLight(furnNode.children[furnNode.children.length - 1], f, type.defaults); // lamps get a warm light
    });

    // ---- casework (kitchens, wardrobes, vanities, built-ins): stands on the floor finish like furniture ----
    const caseNode = node("casework", "group");
    const caseCtx = levelCaseCtx(project, lv, segs, placed, z, ceilingH);
    lv.casework.forEach((cw, i) => {
      const b = buildCasework(cw, i, { ...caseCtx, floorZ: z + FLOOR_FINISH });
      b.resolved.errors.forEach((m) => err(m));
      b.resolved.warnings.forEach((m) => warn(m));
      if (b.node) caseNode.children.push(b.node);
    });

    // ---- lights (fixtures with punctual lights) ----
    const lightsNode = buildLights(lv, { project, levelIndex: li, z, ceilingH, segments: segs, warn, err });

    // ---- columns, railings ----
    const miscMb = new MeshBuilder(), miscCol = new MeshBuilder();
    lv.columns.forEach((c) => {
      buildColumn(miscMb, c, z, c.height ?? lv.height);
      buildColumn(miscCol, { ...c, material: COLLIDER }, z, c.height ?? lv.height);
    });
    lv.railings.forEach((r) => {
      buildRailing(miscMb, r, z + r.offset);
      railingCollider(miscCol, r, z + r.offset, COLLIDER);
    });
    const structNode = node("structure", "group", miscMb);
    structNode.collision = miscCol.meshes();

    // ---- roofs ----
    const roofsNode = node("roofs", "group");
    const loop = lv.walls.find((w) => w.closed);
    const extT = loop?.thickness ?? D.exteriorWallThickness ?? D.wallThickness;
    const extMat = loop?.exteriorMaterial ?? loop?.material ?? D.exteriorMaterial ?? D.wallMaterial;

    // ---- free-form shapes ----
    const shapesNode = node("shapes", "group");
    lv.shapes.forEach((sh, i) => {
      const mb = new MeshBuilder();
      buildShape(mb, sh, z);
      shapesNode.children.push(node(sh.id ?? `${sh.type}${i}`, "shape", mb, { id: sh.id, name: sh.name, type: sh.type }));
    });

    // ---- terraces / balconies ----
    const terracesNode = node("terraces", "group");
    lv.terraces.forEach((t, i) => {
      const mb = new MeshBuilder(), col = new MeshBuilder();
      const r = buildTerrace(mb, col, t, { z, groundZ: elev[0], segments: segs, wallMaterial: extMat });
      const tn = node(t.id ?? `terrace${i}`, "terrace", mb, {
        id: t.id,
        room: t.name,
        area: Math.round(polygonArea(t.polygon as Vec2[]) * 100) / 100,
        guard: r.guard,
        floorZ: z + t.offset,
      });
      tn.collision = col.meshes();
      terracesNode.children.push(tn);
    });
    lv.roofs.forEach((r, i) => {
      const mb = new MeshBuilder();
      buildRoof(mb, r, { baseZ: z + (r.baseHeight ?? lv.height), wallThickness: extT, wallMaterial: extMat });
      roofsNode.children.push(node(r.id ?? `roof${i}`, "roof", mb, { id: r.id, type: r.type }));
    });

    for (const h of holes) if (!usedHoles.has(h)) warn("a stairwell arriving at this level is not inside any slab");

    levelNode.children.push(
      ...[wallsNode, openingsNode, slabsNode, roomsNode, terracesNode, shapesNode, stairsNode, furnNode, caseNode, lightsNode, structNode, roofsNode].filter(
        (n) => n.meshes.length || n.children.length,
      ),
    );
    infos.push({ id: lv.id, name: lv.name ?? lv.id, elevation: z, height: lv.height, segments: segs, openings: placed, stairOutlines, stairs: stairInfos, ceilings });
  });

  // ---- site ----
  if (project.site.ground) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const pts: number[][] = [];
    project.levels.forEach((lv, i) => {
      pts.push(...infos[i].segments.flatMap((sg) => [sg.aL, sg.aR, sg.bL, sg.bR]), ...infos[i].stairOutlines.flat());
      pts.push(...lv.slabs.flatMap((s) => s.polygon), ...lv.rooms.flatMap((r) => r.polygon), ...lv.railings.flatMap((r) => r.points));
      pts.push(...lv.terraces.flatMap((t) => t.polygon));
      for (const sh of lv.shapes) {
        const fp = shapeFootprint(sh, 0, 0);
        if (fp) pts.push([fp.center[0] - fp.max, fp.center[1] - fp.max], [fp.center[0] + fp.max, fp.center[1] + fp.max]);
        else if (sh.type === "box") pts.push([sh.center[0] - sh.size[0] / 2, sh.center[1] - sh.size[1] / 2], [sh.center[0] + sh.size[0] / 2, sh.center[1] + sh.size[1] / 2]);
      }
      pts.push(...lv.columns.map((c) => c.position), ...lv.furniture.map((f) => f.position));
    });
    for (const p of pts) {
      minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
      minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
    }
    if (isFinite(minX)) {
      const m = project.site.margin;
      const mb = new MeshBuilder();
      mb.flat(project.site.groundMaterial, [[minX - m, minY - m], [maxX + m, minY - m], [maxX + m, maxY + m], [minX - m, maxY + m]], elev[0] - 0.05);
      root.children.push(node("ground", "site", mb));
    }
  }

  warnings.push(...checkUnlitRooms(project));
  return { root, levels: infos, errors, warnings };
}

function insideLoose(p: Vec2, poly: Vec2[]): boolean {
  // point-in-polygon on a slightly shrunk test so outlines touching the room edge still count
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  if (inside) return true;
  // on the boundary?
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const ab = [b[0] - a[0], b[1] - a[1]], ap = [p[0] - a[0], p[1] - a[1]];
    const l2 = ab[0] ** 2 + ab[1] ** 2;
    const t = Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1]) / (l2 || 1)));
    if (Math.hypot(a[0] + ab[0] * t - p[0], a[1] + ab[1] * t - p[1]) < 0.02) return true;
  }
  return false;
}
