/**
 * Casework: parametric built-in cabinetry (kitchens, wardrobes, vanities, media walls, shelving, desks,
 * benches). A run is placed along a wall face, a back-edge path, or freestanding (islands), and is
 * built from modules (base / tall / upper rows) with carcasses, fronts, worktop, plinth, backsplash,
 * appliances and interiors. Every door, drawer and appliance door is its own "door_leaf" node with a
 * pivot and motion metadata so games and the viewer can open it.
 *
 *   schema      -> casework/schema.ts
 *   placement   -> casework/layout.ts (shared with validation and the plan renderer)
 *   modules     -> casework/modules.ts, parts in casework/parts.ts
 */
import { m4, v2, type Mat4, type Vec2, type Vec3 } from "../geometry/math.js";
import { MeshBuilder, type MeshData } from "../geometry/mesh.js";
import type { SceneNode } from "../geometry/scene.js";
import { footprint, legPoint, resolveRun, spanOutline, type CaseCtx, type Leg, type Placed, type ResolvedRun } from "./casework/layout.js";
import { BUILDERS, SLIDE_SETBACK, type LeafSpec, type Mats, type ModCtx, type WorktopCut } from "./casework/modules.js";
import { EP, FT, frontPanel, hashStr, rng, slab, type FrontStyle, type HandleStyle } from "./casework/parts.js";
import type { Casework, CaseworkType } from "./casework/schema.js";
import { COLLIDER } from "./stairs.js";
import type { PlacedOpening } from "./openings.js";
import { wallIdOf, type WallSegment } from "./walls.js";
import type { Level, Project } from "../schema/schema.js";

export { CaseworkSchema, CaseModuleSchema, CASEWORK_TYPES, MODULE_KINDS } from "./casework/schema.js";
export type { Casework, CaseModule } from "./casework/schema.js";
export { resolveRun, footprint, spanOutline, legPoint } from "./casework/layout.js";
export type { CaseCtx, ResolvedRun, Placed, Leg } from "./casework/layout.js";

// ---------------------------------------------------------------------------------------------
// materials

const COMMON: Omit<Mats, "front" | "worktop" | "backsplash" | "plinth" | "accent"> = {
  carcass: "melamine_white",
  handle: "metal_steel",
  glass: "glass",
  sink: "metal_steel",
  tap: "chrome",
  appliance: "metal_steel",
  cushion: "fabric_gray",
};

const TYPE_MATS: Record<CaseworkType, { front: string; worktop: string; sink?: string; handle?: string }> = {
  kitchen: { front: "lacquer_white", worktop: "quartz_white" },
  wardrobe: { front: "lacquer_white", worktop: "lacquer_white" },
  vanity: { front: "wood_oak", worktop: "marble_white", sink: "ceramic_white" },
  shelving: { front: "wood_oak", worktop: "wood_oak" },
  media: { front: "wood_walnut", worktop: "wood_walnut" },
  desk: { front: "lacquer_white", worktop: "wood_oak" },
  bench: { front: "lacquer_white", worktop: "wood_oak" },
  custom: { front: "lacquer_white", worktop: "quartz_white" },
};

const defined = <T extends object>(o: T | undefined) => Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined)) as Partial<T>;

export function runMaterials(run: Casework, overrides?: Partial<Mats>): Mats {
  const t = TYPE_MATS[run.type];
  const base = { ...COMMON, front: t.front, worktop: t.worktop, ...(t.sink ? { sink: t.sink } : {}), ...(t.handle ? { handle: t.handle } : {}) };
  const m = { ...base, ...defined(run.materials as Partial<Mats>), ...defined(overrides) } as Partial<Mats> & typeof base;
  return {
    ...m,
    plinth: m.plinth ?? m.front,
    accent: m.accent ?? m.front,
    backsplash: m.backsplash ?? m.worktop,
  } as Mats;
}

// ---------------------------------------------------------------------------------------------
// level context

/** Everything a run needs from its level (walls to snap to, openings, rooms, ceiling). */
export function levelCaseCtx(project: Project, lv: Level, segments: WallSegment[], openings: PlacedOpening[], elevation: number, ceiling: number): CaseCtx {
  const D = project.defaults;
  return {
    segments,
    openings,
    elevation,
    ceiling,
    rooms: lv.rooms.map((r) => r.polygon as Vec2[]),
    walls: lv.walls.map((w, i) => ({
      id: wallIdOf(w, i),
      points: w.points as Vec2[],
      closed: w.closed && w.points.length >= 3,
      thickness: w.thickness ?? (w.closed ? D.exteriorWallThickness ?? D.wallThickness : D.wallThickness),
    })),
  };
}

/** Resolve every casework run of level `li` (for validation and plan drawing). */
export function resolveLevelCasework(project: Project, li: number, info: { segments: WallSegment[]; openings: PlacedOpening[]; elevation: number }): ResolvedRun[] {
  const lv = project.levels[li];
  if (!lv.casework?.length) return [];
  const ctx = levelCaseCtx(project, lv, info.segments, info.openings, info.elevation, levelCeiling(project, li));
  return lv.casework.map((cw, i) => resolveRun(cw, i, ctx));
}

/** Ceiling height above the floor of level `li` (same rule as build.ts). */
export function levelCeiling(project: Project, li: number): number {
  const lv = project.levels[li];
  const next = project.levels[li + 1];
  const slabT = (l: Level) => l.slabThickness ?? project.defaults.slabThickness;
  return lv.ceilingHeight ?? lv.height - (next ? slabT(next) : slabT(lv));
}

// ---------------------------------------------------------------------------------------------
// build

export interface CaseworkBuild {
  node: SceneNode | null;
  resolved: ResolvedRun;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

function legMatrix(leg: Leg, floorZ: number): Mat4 {
  return m4.fromBasis([leg.X[0], leg.X[1], 0], [-leg.n[0], -leg.n[1], 0], [0, 0, 1], [leg.a[0], leg.a[1], floorZ]);
}

/** Bake a transform into mesh data (used to pose horizontally hinged leaves open). */
function transformMeshes(meshes: MeshData[], m: Mat4): MeshData[] {
  return meshes.map((src) => {
    const out: MeshData = { material: src.material, positions: [], normals: [], uvs: [...src.uvs], indices: [...src.indices] };
    for (let i = 0; i < src.positions.length; i += 3) {
      const p = m4.point(m, [src.positions[i], src.positions[i + 1], src.positions[i + 2]]);
      const n = m4.normal(m, [src.normals[i], src.normals[i + 1], src.normals[i + 2]]);
      out.positions.push(...p);
      out.normals.push(...n);
    }
    return out;
  });
}

/**
 * Build one casework run. `floorZ` is the absolute height of the floor finish the cabinets stand on.
 */
export function buildCasework(run: Casework, index: number, ctx: CaseCtx & { floorZ: number }): CaseworkBuild {
  const r = resolveRun(run, index, ctx);
  if (r.errors.length || !r.legs.length) return { node: null, resolved: r };
  const d = r.dims;
  const mb = new MeshBuilder(), col = new MeshBuilder();
  const leafNodes: SceneNode[] = [];
  const R = rng(hashStr(r.id));
  const runMats = runMaterials(run);
  const isl = run.island;

  for (const leg of r.legs) {
    const LM = legMatrix(leg, ctx.floorZ);
    const placed = [...r.base, ...r.uppers].filter((p) => p.leg === leg.index);
    const cutsByModule = new Map<Placed, WorktopCut[]>();
    const firstBase = r.base.filter((p) => p.leg === leg.index).sort((a, b) => a.x0 - b.x0);
    // waterfall ends replace the end panels
    for (const sp of r.spans.filter((s) => s.leg === leg.index)) {
      const a = firstBase.find((p) => Math.abs(p.x0 - sp.x0) < 0.01), b = firstBase.find((p) => Math.abs(p.x1 - sp.x1) < 0.01);
      if (sp.waterfallL && a) a.exposedL = false;
      if (sp.waterfallR && b) b.exposedR = false;
    }

    mb.with(LM, () => {
      for (const p of placed) {
        const M = runMaterials(run, p.module.materials as Partial<Mats> | undefined);
        // farmhouse sinks are fireclay unless a sink material is given
        if (p.kind === "sink" && p.module.sinkStyle === "farmhouse" && !run.materials.sink && !p.module.materials?.sink) M.sink = "ceramic_white";
        const leaves: LeafSpec[] = [];
        const cuts: WorktopCut[] = [];
        const sliding = !!run.slidingDoors && p.row === "tall";
        const c: ModCtx = {
          r, d, p, M, mb, leaves, cuts, R,
          style: (p.module.doorStyle ?? d.doorStyle) as FrontStyle,
          handle: d.handle as HandleStyle,
          sliding,
          yFront: -p.depth,
          decor: p.module.decor ?? true,
        };
        BUILDERS[p.kind]?.(c);
        if (cuts.length) cutsByModule.set(p, cuts);
        // plinth (recessed toe kick) under floor-standing units
        const floorStanding = p.row === "tall" || (p.row === "base" && d.elevation <= 0);
        if (floorStanding && d.plinth > 0.01 && !["gap", "desk", "end_panel"].includes(p.kind) && !p.block) {
          const x0 = p.x0 + (p.exposedL ? EP : 0), x1 = p.x1 - (p.exposedR ? EP : 0);
          const yF = -p.depth + 0.06 + (sliding ? SLIDE_SETBACK : 0);
          const pm = ["open_shelf", "tall_open", "wine_rack"].includes(p.kind) && !run.materials.plinth ? M.accent : M.plinth;
          mb.box(pm, [x0, yF, 0], [x1, -0.03, p.z0], { skip: ["-z"] });
        }
        // LED strips under wall cabinets and floating units
        if (d.lighting && p.row === "upper" && !["gap", "hood", "filler", "end_panel"].includes(p.kind))
          mb.box("emissive_light", [p.x0 + 0.03, -p.depth + 0.035, p.z0 - 0.004], [p.x1 - 0.03, -p.depth + 0.05, p.z0 - 0.0005]);
        if (d.lighting && p.row === "base" && d.elevation > 0.05 && !["gap", "filler", "end_panel"].includes(p.kind))
          mb.box("emissive_light", [p.x0 + 0.03, -p.depth + 0.05, p.z0 - 0.004], [p.x1 - 0.03, -p.depth + 0.065, p.z0 - 0.0005]);
        // crown moulding
        if (d.cornice && !d.toCeiling && (p.row === "upper" || p.row === "tall") && !["gap", "hood"].includes(p.kind)) {
          const eL = p.exposedL ? 1 : 0, eR = p.exposedR ? 1 : 0;
          const z1 = p.z1, D = p.depth;
          mb.box(M.accent, [p.x0 - eL * 0.02, -D - 0.02, z1], [p.x1 + eR * 0.02, -D + 0.06, z1 + 0.025]);
          mb.box(M.accent, [p.x0 - eL * 0.045, -D - 0.045, z1 + 0.025], [p.x1 + eR * 0.045, -D + 0.08, z1 + 0.065]);
          if (eL) mb.box(M.accent, [p.x0 - 0.045, -D - 0.045, z1], [p.x0, -0.002, z1 + 0.065]);
          if (eR) mb.box(M.accent, [p.x1, -D - 0.045, z1], [p.x1 + 0.045, -0.002, z1 + 0.065]);
        }
        // leaves -> nodes
        for (const lf of leaves) leafNodes.push(leafNode(r, leg, LM, p, lf));
      }

      // ---- worktops ----
      for (const sp of r.spans.filter((s) => s.leg === leg.index)) {
        const inSpan = [...cutsByModule.entries()].filter(([p]) => p.x0 >= sp.x0 - 0.01 && p.x1 <= sp.x1 + 0.01).flatMap(([, cs]) => cs);
        const x0 = sp.x0 - (sp.waterfallL ? d.wt : 0), x1 = sp.x1 + (sp.waterfallR ? d.wt : 0);
        const notches = inSpan.filter((c): c is Extract<WorktopCut, { kind: "notch" }> => c.kind === "notch").sort((a, b) => a.x0 - b.x0);
        const outline: Vec2[] = [[x0, sp.yf]];
        for (const n of notches) outline.push([n.x0, sp.yf], [n.x0, n.yBack], [n.x1, n.yBack], [n.x1, sp.yf]);
        outline.push([x1, sp.yf], [x1, sp.yb], [x0, sp.yb]);
        const holes = inSpan.filter((c): c is Extract<WorktopCut, { kind: "hole" }> => c.kind === "hole").map((c) => c.outline);
        // integrated vanity basins: the whole top is ceramic
        const mods = r.base.filter((p) => p.leg === leg.index && p.x0 >= sp.x0 - 0.01 && p.x1 <= sp.x1 + 0.01);
        const integrated = mods.length > 0 && mods.every((p) => p.kind === "basin" && p.module.basin === "integrated");
        const wm = integrated ? runMats.sink : runMats.worktop;
        slab(mb, wm, outline, holes, d.height - d.wt, d.height);
        if (sp.waterfallL) mb.box(wm, [x0, sp.yf, 0], [sp.x0, sp.yb, d.height - d.wt]);
        if (sp.waterfallR) mb.box(wm, [sp.x1, sp.yf, 0], [x1, sp.yb, d.height - d.wt]);
        col.with(LM, () => col.box(COLLIDER, [x0, sp.yf, d.height - d.wt], [x1, sp.yb, d.height]));
        // backsplash against the wall, trimmed around windows and doors
        if (!r.freestanding && d.backsplash !== 0) {
          const h = d.backsplash === "full" ? Math.max(0, d.upperBottom - d.height) : d.backsplash;
          if (h > 0.02) {
            const bx0 = leg.cornerStart?.interior && sp.x0 <= d.depth + d.overhang + 0.01 ? 0.012 : sp.x0;
            const pieces = leg.backed.flatMap(([a, b]) => (Math.min(b, sp.x1) - Math.max(a, bx0) > 0.02 ? splitAround(Math.max(a, bx0), Math.min(b, sp.x1), leg, d.height, h) : []));
            for (const [a, b, ph] of pieces) if (ph > 0.03 && b - a > 0.01) mb.box(runMats.backsplash, [a, -0.012, d.height], [b, -0.0005, d.height + ph]);
          }
        }
      }

      // ---- free backs of wall runs (peninsulas, room dividers): clad them where no wall is behind ----
      if (!r.freestanding) {
        const free = invert(leg.backed, leg.start, leg.end);
        for (const p of r.base.filter((q) => q.leg === leg.index && q.kind !== "gap" && !q.block)) {
          const top = p.row === "tall" ? p.z1 : d.height - d.wt;
          for (const [a, b] of free) {
            const x0 = Math.max(a, p.x0), x1 = Math.min(b, p.x1);
            if (x1 - x0 > 0.02) mb.box(runMats.front, [x0, -0.004, p.row === "base" && d.elevation > 0 ? p.z0 : 0], [x1, EP - 0.004, top]);
          }
        }
      }

      // ---- island back panel ----
      if (r.freestanding && isl?.backPanel !== false) {
        // one panel per module width so the back reads like a run of cabinets (panelled), not one slab
        const list = r.base.filter((p) => p.leg === leg.index && p.row !== "upper" && p.kind !== "gap").sort((a, b) => a.x0 - b.x0);
        const top = d.height - d.wt;
        const z0 = d.elevation > 0 ? d.elevation : 0;
        const style = (d.doorStyle === "glass" || d.doorStyle === "mirror" || d.doorStyle === "louvered" ? "slab" : d.doorStyle) as FrontStyle;
        for (const p of list) {
          const x0 = p.x0 + (p === list[0] && !p.exposedL ? 0 : 0.0015), x1 = p.x1 - (p === list[list.length - 1] && !p.exposedR ? 0 : 0.0015);
          mb.with(m4.mul(m4.translation(0, EP, 0), m4.rotationZ(Math.PI)), () =>
            frontPanel(mb, style, { front: runMats.front, glass: runMats.glass, handle: runMats.handle }, -x1, -x0, z0, top),
          );
        }
      }

      // ---- sliding wardrobe doors ----
      if (run.slidingDoors) slidingDoors(r, leg, LM, mb, runMats, leafNodes);
    });

    // ---- collision: one box per module ----
    col.with(LM, () => {
      for (const p of placed) {
        if (p.kind === "gap" || p.kind === "desk") continue;
        const z0 = p.row === "upper" ? p.z0 : 0;
        const z1 = p.row === "base" ? d.height - d.wt : p.kind === "hood" ? Math.max(p.z1, d.ceiling) : p.z1;
        col.box(COLLIDER, [p.x0, -p.depth, z0], [p.x1, 0, z1]);
      }
      if (r.freestanding && isl?.backPanel !== false) {
        const list = r.base.filter((p) => p.leg === leg.index);
        if (list.length) col.box(COLLIDER, [Math.min(...list.map((p) => p.x0)), 0, 0], [Math.max(...list.map((p) => p.x1)), EP, d.height - d.wt]);
      }
    });
  }

  const node: SceneNode = {
    name: r.id,
    kind: "casework",
    meshes: mb.meshes(),
    children: leafNodes,
    collision: col.meshes(),
    extras: {
      id: run.id,
      type: run.type,
      modules: r.base.filter((p) => p.index >= 0).map((p) => ({ id: p.id, kind: p.kind, width: r3(p.x1 - p.x0) })),
      uppers: r.uppers.filter((p) => p.index >= 0).map((p) => ({ id: p.id, kind: p.kind, width: r3(p.x1 - p.x0) })),
    },
  };
  return { node, resolved: r };
}

/** Complement of sorted intervals within [lo, hi]. */
function invert(ivs: [number, number][], lo: number, hi: number): [number, number][] {
  const out: [number, number][] = [];
  let x = lo;
  for (const [a, b] of [...ivs].sort((p, q) => p[0] - q[0])) {
    if (a > x + 0.01) out.push([x, a]);
    x = Math.max(x, b);
  }
  if (hi > x + 0.01) out.push([x, hi]);
  return out;
}

/** Backsplash pieces between x0..x1: full height except under windows (down to the sill) and doors (none). */
function splitAround(x0: number, x1: number, leg: Leg, counter: number, h: number): [number, number, number][] {
  const cuts = leg.openings
    .filter((o) => o.x1 > x0 && o.x0 < x1 && o.sill < counter + h)
    .map((o) => ({ a: Math.max(x0, o.x0), b: Math.min(x1, o.x1), h: o.type === "window" ? Math.min(h, o.sill - counter) : 0 }))
    .sort((p, q) => p.a - q.a);
  const out: [number, number, number][] = [];
  let x = x0;
  for (const c of cuts) {
    if (c.a > x) out.push([x, c.a, h]);
    out.push([Math.max(x, c.a), c.b, c.h]);
    x = Math.max(x, c.b);
  }
  if (x < x1) out.push([x, x1, h]);
  return out;
}

function leafNode(r: ResolvedRun, leg: Leg, LM: Mat4, p: Placed, lf: LeafSpec): SceneNode {
  const pivot = m4.point(LM, lf.pivot);
  let rot = leg.angle;
  let meshes = lf.mb.meshes();
  let t: Vec3 = pivot;
  const extras: Record<string, unknown> = {
    casework: r.id,
    module: p.id,
    moduleKind: p.kind,
    leaf: lf.name,
    role: lf.role,
    motion: lf.motion,
  };
  const deg = (a: number) => (a * Math.PI) / 180;
  if (lf.motion === "hinged") {
    const h = lf.hinge ?? "left";
    extras.hinge = h;
    extras.hingeAxis = h === "left" || h === "right" ? "z" : "x";
    // axis (plan coordinates, unit) about which a POSITIVE rotation opens the leaf (right-hand rule)
    extras.axis = h === "left" ? [0, 0, -1] : h === "right" ? [0, 0, 1] : h === "bottom" ? [r3(leg.X[0]), r3(leg.X[1]), 0] : [r3(-leg.X[0]), r3(-leg.X[1]), 0];
    extras.maxAngle = lf.maxAngle ?? 100;
    if (lf.open) {
      const a = deg(Math.min(95, lf.maxAngle ?? 95));
      if (h === "left") rot -= a;
      else if (h === "right") rot += a;
      else meshes = transformMeshes(meshes, m4.rotationX(h === "bottom" ? deg(85) : -deg(95)));
      extras.posedOpen = true;
    }
  } else {
    const dir = lf.slideDir ?? [0, -1];
    const w: Vec2 = v2.add(v2.scale(leg.X, dir[0]), v2.scale(leg.n, -dir[1]));
    extras.slideAxis = [r3(w[0]), r3(w[1]), 0];
    extras.slideDistance = lf.slideDist ?? 0.4;
    if (lf.open) {
      const s = (lf.slideDist ?? 0.4) * 0.85;
      t = [pivot[0] + w[0] * s, pivot[1] + w[1] * s, pivot[2]];
      extras.posedOpen = true;
    }
  }
  return { name: `${r.id}_${p.id}_${lf.name}`, kind: "door_leaf", meshes, children: [], translation: t, rotationZ: rot, extras };
}

/** Sliding panels across every contiguous run of tall modules on the leg (two tracks, overlapping). */
function slidingDoors(r: ResolvedRun, leg: Leg, LM: Mat4, mb: MeshBuilder, M: Mats, out: SceneNode[]) {
  const talls = r.base.filter((p) => p.leg === leg.index && p.row === "tall").sort((a, b) => a.x0 - b.x0);
  const groups: Placed[][] = [];
  for (const p of talls) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(g[g.length - 1].x1 - p.x0) < 0.01) g.push(p);
    else groups.push([p]);
  }
  groups.forEach((g, gi) => {
    const x0 = g[0].x0 + (g[0].exposedL ? EP : 0), x1 = g[g.length - 1].x1 - (g[g.length - 1].exposedR ? EP : 0);
    const D = Math.max(...g.map((p) => p.depth));
    const top = Math.min(...g.map((p) => p.z1));
    const span = x1 - x0;
    const n = Math.max(2, Math.round(span / 0.95));
    const ov = 0.03;
    const pw = (span + ov * (n - 1)) / n;
    // tracks
    mb.box("metal_aluminum", [x0, -D - 0.003, top - 0.045], [x1, -D + SLIDE_SETBACK, top]);
    mb.box("metal_aluminum", [x0, -D - 0.003, 0], [x1, -D + SLIDE_SETBACK, 0.012]);
    const style = (r.run.doorStyle ?? "slab") as FrontStyle;
    for (let i = 0; i < n; i++) {
      const outer = i % 2 === 0;
      const y = outer ? -D : -D + 0.04;
      const px0 = x0 + i * (pw - ov);
      const lb = new MeshBuilder();
      const h = top - 0.02 - 0.012;
      frontPanel(lb, style, { front: M.front, glass: M.glass, handle: M.handle }, 0, pw, 0, h);
      // recessed finger pull profile on the leading edges
      for (const ex of [0.004, pw - 0.016]) lb.box(M.handle, [ex, -0.003, h * 0.3], [ex + 0.012, 0.001, h * 0.7]);
      const dir = outer ? (i < n / 2 ? 1 : -1) : -1;
      const lf: LeafSpec = {
        name: `slide${i + 1}`,
        motion: "slide",
        pivot: [px0, y, 0.012],
        mb: lb,
        slideDir: [dir, 0],
        slideDist: Math.round((pw - ov) * 1000) / 1000,
        open: r.run.slidingOpen.includes(i),
        role: "sliding_door",
      };
      const holder: Placed = { ...g[0], id: `sliding${gi > 0 ? gi + 1 : ""}` };
      out.push(leafNode(r, leg, LM, holder, lf));
    }
    void FT;
  });
}

// ---------------------------------------------------------------------------------------------
// plan drawing data (world coordinates)

export interface CasePlanItem {
  poly: Vec2[];
  row: "base" | "tall" | "upper" | "worktop";
  kind: string;
  /** Front edge (for a thick line). */
  front?: [Vec2, Vec2];
  label?: string;
}

export interface CasePlanSymbol {
  type: "bowl" | "hob" | "basin";
  poly: Vec2[];
  /** hob burner centres + radii */
  rings?: { c: Vec2; r: number }[];
}

export interface CasePlan {
  id: string;
  items: CasePlanItem[];
  symbols: CasePlanSymbol[];
  labelAt: Vec2;
}

const SHORT: Record<string, string> = { dishwasher: "DW", fridge: "REF", tall_oven: "OV", oven_base: "OV", pantry: "P", wardrobe: "WR", wine_rack: "W" };

/** Footprints, worktops, sinks and hobs of a resolved run for the 2D plan. */
export function caseworkPlan(r: ResolvedRun): CasePlan {
  const items: CasePlanItem[] = [];
  const symbols: CasePlanSymbol[] = [];
  const d = r.dims;
  for (const sp of r.spans) items.push({ poly: spanOutline(r, sp), row: "worktop", kind: "worktop" });
  for (const p of [...r.base, ...r.uppers]) {
    if (p.kind === "gap") continue;
    const fp = footprint(r, p);
    items.push({ poly: fp, row: p.row, kind: p.kind, front: [fp[0], fp[1]], label: SHORT[p.kind] });
    const leg = r.legs[p.leg];
    const cx = (p.x0 + p.x1) / 2;
    if (p.kind === "sink") {
      const w = p.x1 - p.x0;
      const bowls = p.module.bowls ?? (w >= 0.88 ? 2 : 1);
      const spans: [number, number][] = bowls === 2 ? [[cx - (w - 0.14) / 2, cx - 0.025], [cx + 0.025, cx + (w - 0.14) / 2]] : [[cx - Math.min(w - 0.12, 0.72) / 2, cx + Math.min(w - 0.12, 0.72) / 2]];
      for (const [a, b] of spans) symbols.push({ type: "bowl", poly: [legPoint(leg, a, -p.depth + 0.085), legPoint(leg, b, -p.depth + 0.085), legPoint(leg, b, -0.095), legPoint(leg, a, -0.095)] });
    } else if (p.kind === "hob") {
      const hw = Math.min(Math.max(p.x1 - p.x0 - 0.08, 0.3), 0.9), hd = Math.min(Math.max(p.depth - 0.08, 0.3), 0.52);
      const cy = -p.depth / 2 - 0.01;
      const poly = [legPoint(leg, cx - hw / 2, cy - hd / 2), legPoint(leg, cx + hw / 2, cy - hd / 2), legPoint(leg, cx + hw / 2, cy + hd / 2), legPoint(leg, cx - hw / 2, cy + hd / 2)];
      const rings = [[-0.27, 0.12], [-0.27, -0.12], [0.27, 0.12], [0.27, -0.12]].map(([fx, fy]) => ({ c: legPoint(leg, cx + fx * (hw / 0.78) * 0.9, cy + fy), r: 0.08 }));
      symbols.push({ type: "hob", poly, rings });
    } else if (p.kind === "basin") {
      const cy = -p.depth / 2 - 0.02;
      const rx = Math.min(0.2, (p.x1 - p.x0) / 2 - 0.08), ry = Math.min(0.17, p.depth / 2 - 0.06);
      const poly: Vec2[] = [];
      for (let i = 0; i < 20; i++) poly.push(legPoint(leg, cx + Math.cos((i / 20) * Math.PI * 2) * rx, cy + Math.sin((i / 20) * Math.PI * 2) * ry));
      symbols.push({ type: "basin", poly });
    }
  }
  const leg0 = r.legs[0];
  const longest = r.legs.reduce((a, b) => (b.len > a.len ? b : a), leg0);
  void d;
  return { id: r.id, items, symbols, labelAt: legPoint(longest, longest.len / 2, -r.dims.depth - (r.freestanding ? 0.25 : 0.3)) };
}
