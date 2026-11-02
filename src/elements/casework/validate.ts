/**
 * Layout checks for casework runs. Called from validate/layout.ts. Every message names the run and
 * module and says how to fix the problem (which width to change, where to move, which gap to add).
 */
import type { LevelInfo } from "../../build.js";
import { deg2rad, ensureCCW, pointInPolygon, v2, type Vec2 } from "../../geometry/math.js";
import type { Project } from "../../schema/schema.js";
import { resolveLevelCasework } from "../casework.js";
import { FURNITURE } from "../furniture.js";
import { segDir, type WallSegment } from "../walls.js";
import { footprint, spanOutline, type Leg, type Placed, type ResolvedRun } from "./layout.js";

const fmt = (n: number) => (Math.round(n * 100) / 100).toString();
const pt = (p: Vec2) => `[${fmt(p[0])}, ${fmt(p[1])}]`;

function compass(d: Vec2): string {
  const a = ((Math.atan2(d[1], d[0]) * 180) / Math.PI + 360) % 360;
  return ["east", "north-east", "north", "north-west", "west", "south-west", "south", "south-east"][Math.round(a / 45) % 8];
}

/** Separating-axis penetration depth of two convex polygons (<= 0: no overlap). */
function overlapDepth(A: Vec2[], B: Vec2[]): number {
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

/** Distance along `dir` from `p` to the first crossing of a polygon edge (Infinity if none). */
function rayHit(p: Vec2, dir: Vec2, poly: Vec2[], max: number): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const e = v2.sub(b, a);
    const den = v2.cross(dir, e);
    if (Math.abs(den) < 1e-12) continue;
    const w = v2.sub(a, p);
    const t = v2.cross(w, e) / den, s = v2.cross(w, dir) / den;
    if (t > 1e-4 && t < max && s >= 0 && s <= 1) best = Math.min(best, t);
  }
  return best;
}

const wallQuad = (s: WallSegment): Vec2[] => [s.aR, s.bR, s.bL, s.aL];

/** Height range a placed module occupies above the floor (worktop included for base units). */
function zRange(r: ResolvedRun, p: Placed): [number, number] {
  if (p.row === "upper") return [p.z0, p.kind === "hood" && p.module.hood !== "integrated" ? Math.max(p.z1, r.dims.ceiling) : p.z1];
  if (p.row === "tall") return [0, p.z1];
  return [p.kind === "gap" ? r.dims.height - r.dims.wt : r.dims.elevation > 0 ? r.dims.elevation : 0, r.dims.height];
}

const SEATS = new Set(["chair", "office_chair", "bar_stool", "counter_stool", "armchair", "bench", "garden_chair", "stool"]);
const FLAT = new Set(["rug", "door_mat", "ceiling_light", "surgical_light", "medical_pendant", "privacy_curtain"]);

/** Minimum clear depth in front of a run, by type. */
function clearance(r: ResolvedRun): number {
  switch (r.run.type) {
    case "kitchen":
    case "custom":
      return 1.0;
    case "wardrobe":
      return r.run.slidingDoors ? 0.7 : 0.8;
    case "vanity":
      return 0.7;
    case "desk":
      return 0.8;
    default:
      return 0.6;
  }
}

export function checkCasework(project: Project, levels: LevelInfo[]): string[] {
  const out: string[] = [];
  project.levels.forEach((lv, li) => {
    const info = levels[li];
    if (!info || !lv.casework?.length) return;
    const warn = (m: string) => out.push(`level '${lv.id}': ${m}`);
    const runs = resolveLevelCasework(project, li, info).filter((r) => r.legs.length && !r.errors.length);
    const segs = info.segments;

    // furniture rectangles (same conventions as build.ts)
    const furn = lv.furniture.flatMap((f, i) => {
      const t = FURNITURE[f.type];
      if (!t || FLAT.has(f.type)) return [];
      // a tree's footprint is its canopy: only the trunk stands on the floor
      const tree = f.type === "tree";
      const w = tree ? 0.5 : f.width ?? t.defaults.width, d = tree ? 0.5 : f.depth ?? t.defaults.depth, h = f.height ?? t.defaults.height;
      const rot = deg2rad(f.rotation ?? (f.facing ? { south: 0, east: 90, north: 180, west: 270 }[f.facing] : 0));
      const c = f.position as Vec2;
      const at = (x: number, y: number) => v2.add(c, v2.rotate([x, y], rot));
      return [{ name: f.id ?? `${f.type}_${i}`, type: f.type, rect: [at(-w / 2, -d / 2), at(w / 2, -d / 2), at(w / 2, d / 2), at(-w / 2, d / 2)], z0: f.elevation, z1: f.elevation + h, center: c }];
    });

    // floor-level footprints of every run (for aisles and overlaps)
    const solids = runs.map((r) => ({
      r,
      polys: [
        ...r.base.filter((p) => p.kind !== "gap" || p.worktop).map((p) => footprint(r, p)),
        ...r.spans.map((s) => spanOutline(r, s)),
      ],
    }));

    for (const r of runs) {
      const name = `casework '${r.id}'`;
      const d = r.dims;
      const all = [...r.base, ...r.uppers];
      const isWall = !r.freestanding;

      // ---- modules inside walls ----
      const reported = new Set<string>();
      let facingWall = false;
      for (const p of all) {
        if (p.kind === "gap" || facingWall) continue;
        const fp = footprint(r, p);
        const leg = r.legs[p.leg];
        for (const s of segs) {
          const [z0, z1] = zRange(r, p);
          if (z0 >= s.z1 - info.elevation - 0.01 || z1 <= s.z0 - info.elevation + 0.01) continue;
          const o = overlapDepth(fp, wallQuad(s));
          if (o <= 0.02 || reported.has(p.label)) continue;
          reported.add(p.label);
          const along = Math.abs(v2.dot(segDir(s), leg.X)) < 0.3; // wall crosses the run (runs into it)
          if (along) {
            // how far the module reaches past the wall's near face, measured along the run
            const xs = wallQuad(s).map((q) => v2.dot(v2.sub(q, leg.a), leg.X));
            const wx0 = Math.min(...xs), wx1 = Math.max(...xs);
            const end = (p.x0 + p.x1) / 2 < (wx0 + wx1) / 2;
            const depth = end ? p.x1 - wx0 : wx1 - p.x0;
            const o = Math.max(0.01, depth);
            warn(
              `${name}: ${p.label} runs ${fmt(o)} m into wall '${s.wallId}' — ${end ? "end" : "start"} the run ${fmt(o)} m earlier (${r.run.wall ? (end ? "reduce `to`" : "increase `from`") : r.freestanding ? "shorten `length` or move `position`" : "move that path point"} by ${fmt(o)}) or make the modules ${fmt(o)} m narrower`,
            );
          } else {
            // push the module out of the wall, away from the wall's centerline
            const mc = v2.lerp(fp[0], fp[2], 0.5);
            const sd = segDir(s);
            const off = v2.cross(sd, v2.sub(mc, s.a)) >= 0 ? 1 : -1;
            const dir = v2.scale(v2.perp(sd), off);
            if (v2.dot(dir, leg.n) < -0.5) {
              warn(`${name}: the fronts face ${compass(leg.n)}, straight into wall '${s.wallId}' (${p.label} sits inside it) — flip \`front\` (the side of the path the doors face)${r.run.front ? ` to '${r.run.front === "left" ? "right" : "left"}'` : ""} or use wall:'${s.wallId}' placement`);
              facingWall = true;
              break;
            }
            warn(`${name}: ${p.label} overlaps wall '${s.wallId}' by ${fmt(o)} m — move the run ${fmt(o)} m ${compass(dir)} so its back sits on the wall face${r.run.wall ? "" : " (or place it with wall:'" + s.wallId + "' to snap automatically)"}`);
          }
        }
      }

      // ---- windows and doors in the wall behind ----
      for (const leg of r.legs) {
        for (const o of leg.openings) {
          const over = (p: Placed) => Math.min(p.x1, o.x1) - Math.max(p.x0, o.x0);
          if (o.type !== "window") {
            const hit = all.filter((p) => p.leg === leg.index && p.row !== "upper" && p.kind !== "gap" && over(p) > 0.03);
            if (hit.length) warn(`${name}: ${hit.map((p) => p.label).join(", ")} block${hit.length === 1 ? "s" : ""} ${o.type} '${o.id}' in the wall behind — move the run or the ${o.type}, or put a {kind:'gap', width: ${fmt(o.x1 - o.x0 + 0.1)}} there`);
            continue;
          }
          for (const p of all.filter((q) => q.leg === leg.index && q.kind !== "gap" && over(q) > 0.05)) {
            const [z0, z1] = zRange(r, p);
            if (p.row === "base") {
              if (d.height > o.sill + 0.02 && p.kind !== "filler" && p.kind !== "end_panel")
                warn(`${name}: the worktop (${fmt(d.height)} m) runs into window '${o.id}' whose sill is at ${fmt(o.sill)} m — raise the sill to at least ${fmt(d.height + 0.05)} (sill: ${fmt(d.height + 0.05)}) or leave a gap in the run`);
              if (p.kind === "hob") warn(`${name}: hob ${p.label} is under window '${o.id}' — curtains and draughts over a hob are a fire risk and no hood fits there; swap it with the sink or move it along the run`);
              continue;
            }
            if (z1 > o.sill + 0.05 && z0 < o.top - 0.05)
              warn(
                `${name}: ${p.row === "tall" ? "tall unit" : "wall cabinet"} ${p.label} (${fmt(z0)}-${fmt(z1)} m) covers window '${o.id}' (${fmt(o.sill)}-${fmt(o.top)} m) — ${p.row === "upper" ? `put {kind:'gap', width:${fmt(o.x1 - o.x0 + 0.1)}} in uppers over it (or use over:'<sink id>')` : "move the tall unit away from the window"}`,
              );
          }
        }
      }

      // ---- doors on the level swinging into / blocked by the run ----
      for (const o of info.openings) {
        if (o.op.type === "window") continue;
        const s = o.seg;
        const sd = segDir(s), N = v2.perp(sd);
        const half = s.thickness / 2;
        const at = (u: number, w: number): Vec2 => v2.add(s.a, v2.add(v2.scale(sd, u), v2.scale(N, w)));
        const u0 = o.u - o.width / 2, u1 = o.u + o.width / 2;
        const zones: Vec2[][] = [];
        for (const side of [-1, 1]) {
          const z = [at(u0, side * half), at(u1, side * half), at(u1, side * (half + 0.6)), at(u0, side * (half + 0.6))];
          zones.push(side > 0 ? z : [...z].reverse());
        }
        if (o.op.type === "door" && !["sliding", "garage"].includes(o.style)) {
          const toward = (o.op.swing === "in") === (s.interiorSide === "left") ? 1 : -1;
          const leaves = o.style === "double" ? [{ hinge: u0, len: o.width / 2 }, { hinge: u1, len: -o.width / 2 }] : [o.op.hinge === "right" ? { hinge: u1, len: -o.width } : { hinge: u0, len: o.width }];
          for (const L of leaves) {
            const rr = Math.abs(L.len);
            const sector: Vec2[] = [at(L.hinge, toward * half)];
            for (let k = 0; k <= 8; k++) {
              const a = (k / 8) * (Math.PI / 2);
              sector.push(at(L.hinge + Math.sign(L.len) * rr * Math.cos(a), toward * (half + rr * Math.sin(a))));
            }
            zones.push(ensureCCW(sector));
          }
        }
        const hit = r.base.find((p) => p.kind !== "gap" && zones.some((z) => overlapDepth(footprint(r, p), z) > 0.03));
        if (hit) warn(`${name}: ${hit.label} is in the doorway / swing of ${o.op.type} '${o.id}' — keep 0.6 m clear in front of doors (shorten the run, or flip the door's hinge/swing)`);
      }

      // ---- clear floor in front of the fronts ----
      const need = clearance(r);
      const others = solids.filter((x) => x.r !== r);
      const legsChecked = new Set<number>();
      for (const leg of r.legs) {
        if (legsChecked.has(leg.index)) continue;
        legsChecked.add(leg.index);
        const mods = r.base.filter((p) => p.leg === leg.index && !["gap", "filler", "end_panel", "corner"].includes(p.kind));
        if (!mods.length) continue;
        let worst: { dist: number; what: string; p: Placed } | null = null;
        for (const p of mods) {
          for (let x = p.x0 + 0.05; x <= p.x1 - 0.05 + 1e-6; x += 0.1) {
            const front = v2.add(leg.a, v2.add(v2.scale(leg.X, x), v2.scale(leg.n, p.depth + (p.row === "base" ? d.overhang : 0))));
            const max = need + 0.01;
            let best = Infinity, what = "";
            for (const s of segs) {
              const t = rayHit(front, leg.n, wallQuad(s), max);
              if (t < best) (best = t), (what = `wall '${s.wallId}'`);
            }
            for (const o of others)
              for (const poly of o.polys) {
                const t = rayHit(front, leg.n, poly, max);
                if (t < best) (best = t), (what = `${o.r.freestanding ? "island" : "casework"} '${o.r.id}'`);
              }
            for (const f of furn) {
              if (SEATS.has(f.type) || f.z0 > 1.0) continue;
              const t = rayHit(front, leg.n, f.rect, max);
              if (t < best) (best = t), (what = `furniture '${f.name}'`);
            }
            // own L legs facing each other (U kitchens)
            for (const q of r.base) {
              if (q.leg === leg.index || q.kind === "gap") continue;
              const t = rayHit(front, leg.n, footprint(r, q), max);
              if (t < best) (best = t), (what = `the other leg of '${r.id}'`);
            }
            if (best < need - 0.005 && (!worst || best < worst.dist)) worst = { dist: best, what, p };
          }
        }
        if (worst) {
          const short = need - worst.dist;
          const between = worst.what.startsWith("island") || worst.what.startsWith("casework") || worst.what.startsWith("the other leg");
          warn(
            `${name}: only ${fmt(worst.dist)} m clear in front of ${worst.p.label} up to ${worst.what} — keep at least ${fmt(need)} m${r.run.type === "kitchen" ? " (1.2 m recommended between parallel runs/islands)" : ""}: move ${worst.what.startsWith("wall") || worst.what.startsWith("the other") ? `'${r.id}'` : worst.what} ${fmt(short + (between && r.run.type === "kitchen" ? 0.2 : 0))} m ${compass(worst.what.startsWith("wall") || worst.what.startsWith("the other") ? v2.scale(leg.n, -1) : leg.n)}${worst.what.startsWith("the other") ? " or make the run shallower" : ""}`,
          );
        }
      }

      // ---- island seating side ----
      if (r.freestanding && (r.run.island?.seating ?? 0) > 0) {
        const leg = r.legs[0];
        const sp = r.spans[0];
        if (sp) {
          let best = Infinity, what = "";
          for (let x = sp.x0 + 0.1; x <= sp.x1 - 0.1; x += 0.1) {
            const back = v2.add(leg.a, v2.add(v2.scale(leg.X, x), v2.scale(leg.n, -sp.yb)));
            const dir = v2.scale(leg.n, -1);
            for (const s of segs) {
              const t = rayHit(back, dir, wallQuad(s), 0.81);
              if (t < best) (best = t), (what = `wall '${s.wallId}'`);
            }
            for (const o of others)
              for (const poly of o.polys) {
                const t = rayHit(back, dir, poly, 0.81);
                if (t < best) (best = t), (what = `casework '${o.r.id}'`);
              }
          }
          if (best < 0.8) warn(`${name}: the seating side has only ${fmt(best)} m behind the overhang up to ${what} — leave at least 0.8 m for stools (1.0 m if people walk behind them); move '${r.id}' ${fmt(0.8 - best)} m ${compass(leg.n)}`);
        }
      }

      // ---- appliance clearances ----
      for (const p of r.base) {
        const leg = r.legs[p.leg];
        if (p.kind === "fridge" && (p.module.doors ?? 1) <= 1 && (p.module.appliance ?? "integrated") !== "freestanding") {
          const hinge = p.module.hinge ?? (hingeDefault(r, p));
          const atStart = p.leg === 0 && p.x0 <= leg.start + 0.01 && !r.freeStart;
          const atEnd = p.leg === r.legs.length - 1 && p.x1 >= leg.end - 0.01 && !r.freeEnd;
          if ((atStart && hinge === "left") || (atEnd && hinge === "right"))
            warn(`${name}: fridge ${p.label} is hinged against the wall — its door can't open past 90°, so the shelves and bins won't come out; add a {kind:'filler', width:0.05} between it and the wall or set hinge:'${hinge === "left" ? "right" : "left"}'`);
        }
        if (p.kind === "dishwasher") {
          const nearStart = leg.cornerStart?.interior && p.x0 <= d.depth + 0.05 + 0.02;
          const nextCorner = r.base.find((q) => q.leg === p.leg && q.kind === "corner" && Math.abs(q.x0 - p.x1) < 0.01 && q.blind);
          if (nearStart || nextCorner)
            warn(`${name}: dishwasher ${p.label} sits right at the corner — its open door blocks the corner unit and the other leg; move it at least one module away from the corner (swap it with its neighbour)`);
        }
      }

      // ---- hood over the hob ----
      const hobs = r.base.filter((p) => p.kind === "hob");
      if (isWall && hobs.length && r.uppers.some((p) => p.kind !== "gap"))
        for (const h of hobs)
          if (!r.uppers.some((u) => u.kind === "hood" && u.leg === h.leg && Math.min(u.x1, h.x1) - Math.max(u.x0, h.x0) > (h.x1 - h.x0) * 0.6))
            warn(`${name}: hob ${h.label} has no hood above it — add {kind:'hood', over:'${h.module.id ?? "<hob id>"}'} to uppers${h.module.id ? "" : " (give the hob an id)"}`);
      if (r.uppers.length && d.upperBottom - d.height < 0.45 && d.upperBottom > d.height)
        warn(`${name}: wall cabinets start only ${fmt(d.upperBottom - d.height)} m above the worktop — keep 0.5-0.6 m (raise upperBottom to ${fmt(d.height + 0.55)})`);

      // ---- furniture and other runs overlapping the cabinets ----
      for (const f of furn) {
        for (const p of all) {
          if (p.kind === "gap") continue;
          const [z0, z1] = zRange(r, p);
          if (Math.min(z1, f.z1) - Math.max(z0, f.z0) <= 0.02) continue;
          const o = overlapDepth(footprint(r, p), f.rect);
          if (o > 0.03) {
            const leg = r.legs[p.leg];
            warn(`${name}: furniture '${f.name}' at ${pt(f.center)} overlaps ${p.label} by ${fmt(o)} m — move it ${fmt(o)} m ${compass(leg.n)} (to ${pt(v2.add(f.center, v2.scale(leg.n, o)))})`);
            break;
          }
        }
      }
      for (const o of runs) {
        if (o === r || runs.indexOf(o) < runs.indexOf(r)) continue;
        let hit = false;
        for (const p of all) {
          for (const q of [...o.base, ...o.uppers]) {
            if (p.kind === "gap" || q.kind === "gap") continue;
            const [a0, a1] = zRange(r, p), [b0, b1] = zRange(o, q);
            if (Math.min(a1, b1) - Math.max(a0, b0) <= 0.02) continue;
            const dd = overlapDepth(footprint(r, p), footprint(o, q));
            if (dd > 0.03) {
              warn(`${name}: ${p.label} overlaps ${q.label} of casework '${o.id}' by ${fmt(dd)} m — shorten or move one of the runs`);
              hit = true;
              break;
            }
          }
          if (hit) break;
        }
      }

      // ---- standing on a floor ----
      if (li > 0) {
        const floorPolys = [...lv.rooms.map((x) => x.polygon as Vec2[]), ...lv.slabs.map((x) => x.polygon as Vec2[]), ...lv.terraces.map((x) => x.polygon as Vec2[])];
        const autoLoops = lv.autoSlab ? lv.walls.filter((w) => w.closed && w.points.length >= 3).map((w) => w.points as Vec2[]) : [];
        for (const p of r.base) {
          const c = v2.lerp(footprint(r, p)[0], footprint(r, p)[2], 0.5);
          if (![...floorPolys, ...autoLoops].some((poly) => pointInPolygon(c, poly))) {
            warn(`${name}: ${p.label} at ${pt(c)} has no floor under it`);
            break;
          }
        }
      }
    }
  });
  return out;
}

function hingeDefault(r: ResolvedRun, p: Placed): "left" | "right" {
  const list = r.base.filter((q) => q.leg === p.leg).sort((a, b) => a.x0 - b.x0);
  const k = list.indexOf(p);
  const next = list[k + 1], prev = list[k - 1];
  if (next && next.row === "base" && !(prev && prev.row === "base")) return "left";
  if (prev && prev.row === "base") return "right";
  return "left";
}

export type { Leg };
