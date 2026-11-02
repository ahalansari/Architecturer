import { FACING_ROT, type LevelInfo } from "../build.js";
import { FURNITURE } from "../elements/furniture.js";
import { MEDICAL } from "../elements/medical.js";
import { checkCasework } from "../elements/casework/validate.js";
import { segDir, segLength, type WallSegment } from "../elements/walls.js";
import { deg2rad, ensureCCW, offsetPolygon, pointInPolygon, v2, type Vec2 } from "../geometry/math.js";
import { boxOf, GridIndex, PolygonIndex } from "../geometry/spatial.js";
import type { Furniture, Project } from "../schema/schema.js";

/**
 * Layout checks that need geometry: furniture clashing with walls, other furniture,
 * door swings, doorways and windows; unreachable rooms; stairs through walls or
 * arriving nowhere. Everything here is a warning: the model still exports, but an
 * AI author should fix these before calling a building done.
 */

// ---------- geometry helpers ----------

/** Penetration depth of two convex polygons (separating-axis test). <= 0 means they don't overlap. */
export function overlapDepth(A: Vec2[], B: Vec2[]): number {
  let depth = Infinity;
  for (const poly of [A, B])
    for (let i = 0; i < poly.length; i++) {
      const e = v2.sub(poly[(i + 1) % poly.length], poly[i]);
      if (v2.len(e) < 1e-9) continue;
      const n = v2.norm(v2.perp(e));
      let aMin = Infinity, aMax = -Infinity, bMin = Infinity, bMax = -Infinity;
      for (const p of A) {
        const d = v2.dot(p, n);
        aMin = Math.min(aMin, d);
        aMax = Math.max(aMax, d);
      }
      for (const p of B) {
        const d = v2.dot(p, n);
        bMin = Math.min(bMin, d);
        bMax = Math.max(bMax, d);
      }
      const o = Math.min(aMax, bMax) - Math.max(aMin, bMin);
      if (o <= 0) return o;
      depth = Math.min(depth, o);
    }
  return depth;
}

const fmt = (n: number) => (Math.round(n * 100) / 100).toString();
const pt = (p: Vec2) => `[${fmt(p[0])}, ${fmt(p[1])}]`;

function compass(d: Vec2): string {
  const a = ((Math.atan2(d[1], d[0]) * 180) / Math.PI + 360) % 360;
  const names = ["east", "north-east", "north", "north-west", "west", "south-west", "south", "south-east"];
  return names[Math.round(a / 45) % 8];
}

const wallQuad = (s: WallSegment): Vec2[] => [s.aR, s.bR, s.bL, s.aL];

// ---------- furniture model ----------

interface Item {
  f: Furniture;
  name: string;
  type: string;
  rect: Vec2[]; // CCW corners: front-left, front-right, back-right, back-left
  center: Vec2;
  front: Vec2; // unit vector the front faces
  w: number;
  d: number;
  z0: number; // relative to the level floor
  z1: number;
}

/** Items that lie flat on the floor or hang overhead and never block anything. */
const FLAT = new Set(["rug", "door_mat", "bath_mat"]);
const OVERHEAD = new Set(["ceiling_light", "hanging_plant", ...MEDICAL.overhead]);
const SEATS = new Set(["chair", "office_chair", "bar_stool", "counter_stool", "armchair", "bench", "garden_chair", "dining_bench", "ottoman"]);
const TABLES = new Set(["table", "desk", "kitchen_island", "coffee_table", "side_table", "dresser", "piano", "kitchen_counter", "outdoor_table", "console_table", "round_dining_table", "dressing_table", "stone_table"]);
/** Symmetric objects without a meaningful front. */
const NO_FRONT = new Set(["box", "cylinder", "crate", "plant", "rug", "door_mat", "table", "coffee_table", "side_table", "floor_lamp", "table_lamp", "ceiling_light", "kitchen_island", "bunk_bed", "outdoor_table", "parasol", "planter", "bush", "tree", "hedge", "agave", "grass_clump", "water_wall", "stone_table", "fence", "hot_tub", "lamp_post", "car", "bicycle", "vase", "books_stack", "decor_bowl", "candle_set", "sculpture", "lantern", "plant_large", "round_dining_table", "ottoman", "umbrella_stand", "coat_rack", "fruit_bowl", "utensil_jar", "laundry_basket", "tray_with_decor", "throw_blanket", ...MEDICAL.noFront]);
/** Mounted flat on a wall (back at +Y): never "faces into a wall", fine beside/over windows. */
const WALL_MOUNTED = new Set(["wall_art", "gallery_wall", "floating_shelf", "wall_clock", "mirror", "mirror_round", "mirror_arched", "mirror_full_length", "towel_rail", "towel_hook_set", "toilet_roll_holder", "shower_curtain", ...MEDICAL.wallMounted]);
/** Small decor that rests on other furniture (sofas, counters, tables): no overlap warning when raised above the other item's base. */
const ON_TOP = new Set(["bedding", "vase", "books_stack", "decor_bowl", "candle_set", "cushion", "throw_blanket", "sculpture", "tray_with_decor", "lantern", "kettle", "coffee_machine", "fruit_bowl", "cutting_boards", "utensil_jar", "plant_herbs", "soap_dispenser", "table_lamp"]);
/** Canopies that other furniture is meant to stand under. */
const CANOPY = new Set(["parasol", "tree", ...MEDICAL.surrounds]);
/** Things that are fine in front of a window. */
const WINDOW_OK = new Set(["curtain", "plant", "shower", "floor_lamp", "table_lamp", "bathtub", "radiator", "bush", "planter", "hedge", "fence", "trash_bin", "bicycle", "garden_chair", "sun_lounger", "plant_large", "lantern", "tree", "agave", "grass_clump", "bush", ...MEDICAL.windowOk]);
const FACING_NAMES: Record<number, string> = { 0: "south", 90: "east", 180: "north", 270: "west" };

function items(lv: Project["levels"][number]): Item[] {
  return lv.furniture.flatMap((f, i) => {
    const t = FURNITURE[f.type];
    if (!t) return [];
    const w = f.width ?? t.defaults.width, d = f.depth ?? t.defaults.depth, h = f.height ?? t.defaults.height;
    const rotDeg = f.rotation ?? (f.facing ? FACING_ROT[f.facing] : 0);
    const rot = deg2rad(rotDeg);
    const c = f.position as Vec2;
    const at = (x: number, y: number) => v2.add(c, v2.rotate([x, y], rot));
    return [
      {
        f,
        name: f.id ?? `${f.type}_${i}`,
        type: f.type,
        rect: [at(-w / 2, -d / 2), at(w / 2, -d / 2), at(w / 2, d / 2), at(-w / 2, d / 2)],
        center: c,
        front: v2.rotate([0, -1], rot),
        w,
        d,
        z0: f.elevation,
        z1: f.elevation + h,
      },
    ];
  });
}

const label = (it: Item) => (it.name === it.type || it.name.startsWith(it.type + "_") ? `'${it.name}'` : `'${it.name}' (${it.type})`);

// ---------- the checks ----------

export function checkLayout(project: Project, levels: LevelInfo[]): string[] {
  const out: string[] = [];
  const graph = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (a === b) return;
    if (!graph.has(a)) graph.set(a, new Set());
    if (!graph.has(b)) graph.set(b, new Set());
    graph.get(a)!.add(b);
    graph.get(b)!.add(a);
  };
  const roomKey = (li: number, ri: number) => `${li}:${ri}`;
  const roomName = new Map<string, string>();
  let entrances = 0;

  /** Floor regions of a level (rooms, slabs, closed wall loops), used for "is there a floor here". */
  const floors = (li: number): Vec2[][] => {
    const lv = project.levels[li];
    return [
      ...lv.rooms.map((r) => r.polygon as Vec2[]),
      ...lv.slabs.map((s) => s.polygon as Vec2[]),
      ...lv.terraces.map((t) => t.polygon as Vec2[]),
      ...(lv.autoSlab ? lv.walls.filter((w) => w.closed && w.points.length >= 3).map((w) => offsetPolygon(ensureCCW(w.points as Vec2[]), (w.thickness ?? 0.2) / 2)) : []),
    ];
  };
  const floorIdx: PolygonIndex[] = [];
  const onFloor = (li: number, p: Vec2) => (floorIdx[li] ??= new PolygonIndex(floors(li))).at(p) >= 0;
  /** Stairwells cut into a level by stairs arriving from below. */
  const wells = (li: number) => levels.flatMap((L) => L.stairs.filter((s) => s.target === li).flatMap((s) => s.footprints));
  const roomIdx: PolygonIndex[] = [];
  const roomAt = (li: number, p: Vec2): number => (roomIdx[li] ??= new PolygonIndex(project.levels[li].rooms.map((r) => r.polygon as Vec2[]))).at(p);
  /** Graph node for a point: a room, the outside (ground level), or an unnamed open area. */
  const nodeAt = (li: number, p: Vec2): string => {
    const ri = roomAt(li, p);
    if (ri >= 0) return roomKey(li, ri);
    const ti = project.levels[li].terraces.findIndex((t) => pointInPolygon(p, t.polygon as Vec2[]));
    if (ti >= 0) return li === 0 && project.levels[li].terraces[ti].offset < 0.5 ? "outside" : `terrace:${li}:${ti}`;
    return li === 0 ? "outside" : onFloor(li, p) ? `open:${li}` : `void:${li}`;
  };

  project.levels.forEach((lv, li) => {
    const info = levels[li];
    const where = `level '${lv.id}'`;
    const warn = (m: string) => out.push(`${where}: ${m}`);
    const segs = info.segments;
    const its = items(lv);
    lv.rooms.forEach((r, ri) => roomName.set(roomKey(li, ri), r.name));
    // big floors: only nearby walls / furniture are compared (ascending order keeps "first match wins")
    const segIdx = new GridIndex(segs.map((s) => boxOf([s.a, s.b], s.thickness / 2 + 0.05)));
    const itemIdx = new GridIndex(its.map((it) => boxOf(it.rect)));
    const itemsNear = (zone: Vec2[]) => itemIdx.query(boxOf(zone, 0.01)).map((k) => its[k]);

    // --- furniture vs walls ---
    for (const it of its) {
      if (OVERHEAD.has(it.type)) continue;
      // a tree's footprint is its canopy, which may overhang walls: only the trunk has to clear them
      const rect = it.type === "tree" ? ([[-0.25, -0.25], [0.25, -0.25], [0.25, 0.25], [-0.25, 0.25]] as Vec2[]).map((q) => v2.add(it.center, q)) : it.rect;
      let worst: { need: number; seg: WallSegment; dir: Vec2 } | null = null;
      for (const si of segIdx.query(boxOf(rect))) {
        const s = segs[si];
        if (it.z0 >= s.z1 - info.elevation - 0.01) continue; // above the wall
        const d = segDir(s), N = v2.perp(d), len = segLength(s);
        // overlap along the wall?
        const us = rect.map((p) => v2.dot(v2.sub(p, s.a), d));
        if (Math.max(...us) <= 0.02 || Math.min(...us) >= len - 0.02) continue;
        const side = Math.sign(v2.dot(v2.sub(it.center, s.a), N)) || 1;
        const ws = rect.map((p) => v2.dot(v2.sub(p, s.a), N) * side);
        const need = s.thickness / 2 - Math.min(...ws);
        // the item must actually reach into the wall band (not sit entirely beyond it)
        if (need > 0.02 && Math.min(...ws) < s.thickness / 2 && Math.max(...ws) > -s.thickness / 2) {
          // inside a door/opening hole at floor level is reported by the doorway check instead
          const inHole = s.holes.some((h) => h.z0 - info.elevation < 0.05 && Math.min(...us) >= h.u0 - 0.01 && Math.max(...us) <= h.u1 + 0.01);
          if (!inHole && (!worst || need > worst.need)) worst = { need, seg: s, dir: v2.scale(N, side) };
        }
      }
      if (worst)
        warn(
          `furniture ${label(it)} at ${pt(it.center)} overlaps wall '${worst.seg.wallId}' by ${fmt(worst.need)} m — move it ${fmt(worst.need)} m ${compass(worst.dir)} (to ${pt(v2.add(it.center, v2.scale(worst.dir, worst.need)))})`,
        );
    }

    // --- furniture vs furniture ---
    for (let i = 0; i < its.length; i++)
      for (const j of itemIdx.query(itemIdx.boxes[i])) {
        if (j <= i) continue;
        const A = its[i], B = its[j];
        if (FLAT.has(A.type) || FLAT.has(B.type) || OVERHEAD.has(A.type) || OVERHEAD.has(B.type)) continue;
        if (Math.min(A.z1, B.z1) - Math.max(A.z0, B.z0) <= 0.02) continue; // stacked (tv on a stand, lamp on a table)
        if ((SEATS.has(A.type) && TABLES.has(B.type)) || (SEATS.has(B.type) && TABLES.has(A.type))) continue; // tucked-in chairs
        if (CANOPY.has(A.type) || CANOPY.has(B.type)) continue; // things meant to stand under a parasol / tree
        if ((A.type === "outdoor_lounge" && TABLES.has(B.type)) || (B.type === "outdoor_lounge" && TABLES.has(A.type))) continue; // the table inside the L
        if ((ON_TOP.has(A.type) && A.z0 >= B.z0 + 0.05) || (ON_TOP.has(B.type) && B.z0 >= A.z0 + 0.05)) continue; // decor resting on it
        const depth = overlapDepth(A.rect, B.rect);
        if (depth > 0.05) warn(`furniture ${label(A)} and ${label(B)} overlap by ${fmt(depth)} m`);
      }

    // --- facing into a wall ---
    const inWall = (p: Vec2) => segIdx.queryPoint(p).map((k) => segs[k]).find((s) => pointInPolygon(p, wallQuad(s)));
    for (const it of its) {
      if (NO_FRONT.has(it.type) || WALL_MOUNTED.has(it.type)) continue;
      const frontPt = v2.add(it.center, v2.scale(it.front, it.d / 2 + 0.15));
      const backPt = v2.sub(it.center, v2.scale(it.front, it.d / 2 + 0.15));
      const wf = inWall(frontPt);
      if (wf && !inWall(backPt)) {
        const back = v2.scale(it.front, -1);
        const deg = Math.round(((Math.atan2(back[1], back[0]) * 180) / Math.PI + 360 + 90) % 360);
        const name = FACING_NAMES[deg];
        warn(`furniture ${label(it)} faces straight into wall '${wf.wallId}' — its front should face the room${name ? ` (use facing: '${name}')` : ""}`);
      }
    }

    // --- furniture on stairs / without a floor ---
    const lvWells = wells(li);
    for (const it of its) {
      if (OVERHEAD.has(it.type)) continue;
      for (const st of info.stairs)
        for (const solid of st.solids)
          if (overlapDepth(it.rect, solid) > 0.05) {
            warn(`furniture ${label(it)} overlaps stair '${st.id}'`);
            break;
          }
      if (li > 0 && !onFloor(li, it.center)) warn(`furniture ${label(it)} at ${pt(it.center)} has no floor under it (outside every room/slab of this level)`);
      else if (lvWells.some((h) => pointInPolygon(it.center, h))) warn(`furniture ${label(it)} at ${pt(it.center)} stands over the stairwell opening`);
    }

    // --- openings: swings, doorways, windows, where they lead ---
    for (const o of info.openings) {
      const s = o.seg;
      const d = segDir(s), N = v2.perp(d);
      const half = s.thickness / 2;
      const at = (u: number, w: number): Vec2 => v2.add(s.a, v2.add(v2.scale(d, u), v2.scale(N, w)));
      const u0 = o.u - o.width / 2, u1 = o.u + o.width / 2;
      const sill = o.z0 - info.elevation;
      const reported = new Set<string>();

      if (o.op.type === "window") {
        for (const it of itemsNear([at(u0, -half - 0.35), at(u1, -half - 0.35), at(u1, half + 0.35), at(u0, half + 0.35)])) {
          if (WINDOW_OK.has(it.type) || FLAT.has(it.type) || WALL_MOUNTED.has(it.type)) continue;
          // only tall things matter: furniture below the sill (or under 1.2 m by a low window) is normal
          if (it.z1 <= Math.max(sill + 0.15, 1.2) || it.z0 >= sill + o.height) continue;
          // and only if it covers a real part of the window's width
          const us = it.rect.map((p) => v2.dot(v2.sub(p, s.a), d));
          const covered = Math.min(Math.max(...us), u1) - Math.max(Math.min(...us), u0);
          if (covered < Math.min(0.4, o.width * 0.35)) continue;
          for (const side of [-1, 1]) {
            const zone = [at(u0, side * half), at(u1, side * half), at(u1, side * (half + 0.35)), at(u0, side * (half + 0.35))];
            if (overlapDepth(it.rect, side > 0 ? zone : [...zone].reverse()) > 0.03 && !reported.has(it.name)) {
              reported.add(it.name);
              warn(`furniture ${label(it)} (${fmt(it.z1)} m tall) blocks window '${o.id}' (sill at ${fmt(sill)} m)`);
            }
          }
        }
        continue;
      }

      // doors and openings: both sides must lead somewhere, and stay clear
      const sides = [-1, 1].map((side) => at(o.u, side * (half + 0.3)));
      const nodes = sides.map((p) => nodeAt(li, p));
      for (let k = 0; k < 2; k++)
        if (nodes[k].startsWith("void:"))
          warn(`${o.op.type} '${o.id}' opens onto nothing on its ${k === 0 ? "right" : "left"} side (no floor at ${fmt(info.elevation)} m) — add a slab/balcony or move it`);
      link(nodes[0], nodes[1]);
      if (nodes.includes("outside") && nodes.some((n) => n !== "outside")) entrances++;

      for (const it of itemsNear([at(u0, -half - 0.6), at(u1, -half - 0.6), at(u1, half + 0.6), at(u0, half + 0.6)])) {
        if (FLAT.has(it.type) || OVERHEAD.has(it.type) || CANOPY.has(it.type) || it.z0 > 1.8) continue;
        // clear zone 0.6 m deep on both sides of the doorway
        for (const side of [-1, 1]) {
          const zone = [at(u0, side * half), at(u1, side * half), at(u1, side * (half + 0.6)), at(u0, side * (half + 0.6))];
          if (overlapDepth(it.rect, side > 0 ? zone : [...zone].reverse()) > 0.05 && !reported.has(it.name)) {
            reported.add(it.name);
            warn(`furniture ${label(it)} blocks ${o.op.type} '${o.id}' (keep 0.6 m clear in front of doorways)`);
          }
        }
      }

      // swing arcs of hinged leaves
      if (o.op.type !== "door" || ["sliding", "garage"].includes(o.style)) continue;
      const toward = (o.op.swing === "in") === (s.interiorSide === "left") ? 1 : -1;
      const leaves =
        o.style === "double"
          ? [{ hinge: u0, len: o.width / 2 }, { hinge: u1, len: -o.width / 2 }]
          : [o.op.hinge === "right" ? { hinge: u1, len: -o.width } : { hinge: u0, len: o.width }];
      for (const L of leaves) {
        const r = Math.abs(L.len);
        const sector: Vec2[] = [at(L.hinge, toward * half)];
        for (let k = 0; k <= 8; k++) {
          const a = (k / 8) * (Math.PI / 2);
          sector.push(at(L.hinge + Math.sign(L.len) * r * Math.cos(a), toward * (half + r * Math.sin(a))));
        }
        const poly = ensureCCW(sector);
        for (const it of itemsNear(poly)) {
          if (FLAT.has(it.type) || OVERHEAD.has(it.type) || CANOPY.has(it.type) || it.z0 > 2.0 || reported.has(it.name)) continue;
          if (overlapDepth(it.rect, poly) > 0.03) {
            reported.add(it.name);
            warn(`furniture ${label(it)} is inside the swing of door '${o.id}' — move it, or flip the door with hinge/swing`);
          }
        }
      }
    }

    // --- rooms: access and overlaps ---
    // doors / openings by position: a big floor has thousands, and each room only looks at its own
    const passIdx = new GridIndex(info.openings.map((o) => boxOf([v2.add(o.seg.a, v2.scale(segDir(o.seg), o.u))], o.seg.thickness / 2 + 0.31)));
    lv.rooms.forEach((r, ri) => {
      const key = roomKey(li, ri);
      if (!graph.has(key)) graph.set(key, new Set());
      const touching = passIdx.query(boxOf(r.polygon as Vec2[])).some((oi) => {
        const o = info.openings[oi];
        if (o.op.type === "window") return false;
        const d = segDir(o.seg), N = v2.perp(d);
        const c = v2.add(o.seg.a, v2.scale(d, o.u));
        return [-1, 1].some((side) => pointInPolygon(v2.add(c, v2.scale(N, side * (o.seg.thickness / 2 + 0.3))), r.polygon as Vec2[]));
      });
      const hasLift = project.elevators.some((e) => e.stops.some((st) => st.level === lv.id && pointInPolygon(st.at as Vec2, r.polygon as Vec2[])));
      const hasStair = hasLift || info.stairs.some((st) => roomAt(li, st.approach) === ri) || levels.some((L) => L.stairs.some((st) => st.target === li && roomAt(li, st.arrival) === ri));
      if (!touching && !hasStair) warn(`room '${r.name}' has no door or opening into it`);
    });
    const roomBoxes = new GridIndex(lv.rooms.map((r) => boxOf(r.polygon as Vec2[])));
    for (let a = 0; a < lv.rooms.length; a++)
      for (const b of roomBoxes.query(roomBoxes.boxes[a])) {
        if (b <= a) continue;
        const area = sharedArea(lv.rooms[a].polygon as Vec2[], lv.rooms[b].polygon as Vec2[]);
        if (area > 0.5) warn(`rooms '${lv.rooms[a].name}' and '${lv.rooms[b].name}' overlap by about ${fmt(area)} m²`);
      }

    // --- stairs ---
    for (const st of info.stairs) {
      const spec = lv.stairs.find((x, k) => (x.id ?? `stair${k}`) === st.id);
      if (st.target < 0) {
        // an explicit rise means the author is aiming somewhere on purpose (mezzanine, roof hatch...)
        if (li === project.levels.length - 1 && spec?.rise === undefined) warn(`stair '${st.id}' is on the top level and leads nowhere (there is no level above)`);
        // otherwise build.ts already warned about the mismatched height
      }
      for (const s of segs)
        for (const solid of st.solids)
          if (overlapDepth(solid, wallQuad(s)) > 0.03) {
            warn(`stair '${st.id}' runs through wall '${s.wallId}'`);
            break;
          }
      if (st.target >= 0) {
        const up = levels[st.target];
        const upWhere = `level '${project.levels[st.target].id}'`;
        for (const s of up.segments)
          if (st.footprints.some((fp) => overlapDepth(ensureCCW(fp), wallQuad(s)) > 0.05))
            out.push(`${upWhere}: wall '${s.wallId}' crosses the stairwell of stair '${st.id}' (from ${where})`);
        const wallAtTop = up.segments.find((s) => pointInPolygon(st.arrival, wallQuad(s)));
        if (wallAtTop) warn(`stair '${st.id}' arrives straight into wall '${wallAtTop.wallId}' on ${upWhere} — turn or move the stair`);
        else if (!onFloor(st.target, st.arrival) || st.footprints.some((fp) => pointInPolygon(st.arrival, fp)))
          warn(`stair '${st.id}' arrives at ${pt(st.arrival)} on ${upWhere} where there is no floor to step onto`);
        link(nodeAt(li, st.approach), nodeAt(st.target, st.arrival));
      }
      if (inWall(st.approach)) warn(`stair '${st.id}' starts against a wall — there is no room to step onto the first tread`);
      // open sides without a railing
      for (const fl of st.flights) {
        if (fl.rise < 0.6) continue;
        for (const side of [-1, 1]) {
          if (fl.rails.includes(side)) continue;
          const mid = v2.add(fl.start, v2.add(v2.scale(fl.dir, fl.run * 0.6), v2.scale(fl.right, side * (fl.width / 2 + 0.12))));
          const walled = !!inWall(mid) || st.solids.some((sol) => pointInPolygon(mid, sol));
          if (!walled) {
            warn(`stair '${st.id}': the ${side < 0 ? "left" : "right"} side is open but has no railing (railing is '${spec?.railing}'; sides are relative to walking up)`);
            break;
          }
        }
      }
    }
  });

  // --- elevators link their stops ---
  for (const e of project.elevators) {
    const nodes = e.stops.flatMap((st) => {
      const li = project.levels.findIndex((l) => l.id === st.level);
      if (li < 0) {
        out.push(`elevator '${e.id}': unknown level '${st.level}' (levels: ${project.levels.map((l) => l.id).join(", ")})`);
        return [];
      }
      const n = nodeAt(li, st.at as Vec2);
      if (n.startsWith("void:")) out.push(`elevator '${e.id}': stop on level '${st.level}' at ${pt(st.at as Vec2)} is not on any floor`);
      return [n];
    });
    for (let i = 1; i < nodes.length; i++) link(nodes[0], nodes[i]);
  }

  // --- reachability from the outside ---
  const roomsWithKeys = [...roomName.keys()];
  if (roomsWithKeys.length) {
    if (!entrances) out.push("building has no entrance: no door or opening connects a ground-level room to the outside");
    else {
      const seen = new Set<string>(["outside"]);
      const queue = ["outside"];
      while (queue.length) for (const n of graph.get(queue.shift()!) ?? []) if (!seen.has(n)) (seen.add(n), queue.push(n));
      for (const key of roomsWithKeys)
        if (!seen.has(key)) {
          const li = Number(key.split(":")[0]);
          out.push(`level '${project.levels[li].id}': room '${roomName.get(key)}' can't be reached from the entrance (check doors/openings and stairs)`);
        }
    }
  }
  out.push(...checkCasework(project, levels)); // kitchens, wardrobes, built-ins
  return dedupe(out);
}

function dedupe(a: string[]) {
  return [...new Set(a)];
}

/** Approximate overlap area of two simple polygons by sampling a 0.2 m grid. */
function sharedArea(A: Vec2[], B: Vec2[]): number {
  const box = (P: Vec2[]) => [Math.min(...P.map((p) => p[0])), Math.min(...P.map((p) => p[1])), Math.max(...P.map((p) => p[0])), Math.max(...P.map((p) => p[1]))];
  const [ax0, ay0, ax1, ay1] = box(A), [bx0, by0, bx1, by1] = box(B);
  const x0 = Math.max(ax0, bx0), y0 = Math.max(ay0, by0), x1 = Math.min(ax1, bx1), y1 = Math.min(ay1, by1);
  if (x1 - x0 < 0.3 || y1 - y0 < 0.3) return 0;
  const step = 0.2;
  let n = 0;
  for (let x = x0 + step / 2; x < x1; x += step)
    for (let y = y0 + step / 2; y < y1; y += step) if (pointInPolygon([x, y], A) && pointInPolygon([x, y], B)) n++;
  return n * step * step;
}
