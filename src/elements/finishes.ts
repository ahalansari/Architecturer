/**
 * Interior finishes for rooms: wall finishes per room side (paint, wallpaper, full-height tiles), accent walls,
 * wainscot / tile bands with a dado cap, skirting boards, cornices, picture and dado rails, feature ceilings
 * (tray with LED cove, coffered, exposed beams), floor border inlays and door thresholds.
 *
 * How it plugs into the build:
 *  1. `prepareFinishes` runs after openings have punched their holes and before walls are emitted. It finds every
 *     wall face (both sides plus free end caps), works out which room each stretch of each face looks into (probe
 *     line just in front of the face clipped against the room polygons) and writes height bands into
 *     `WallSegment.paint`, so walls.ts emits the right material per room side and per height (reveals included).
 *  2. `buildRoomFinishes` replaces a room's plain floor + flat ceiling and adds the trims. Trims are 2D profiles
 *     extruded along the room's wall faces, mitred at corners (inside and outside), stopping square at openings.
 */
import { z } from "zod";
import { Id, Mat } from "../schema/common.js";
import { ensureCCW, lineIntersect, m4, offsetPolygon, pointInPolygon, signedArea, v2, type Vec2, type Vec3 } from "../geometry/math.js";
import type { MeshBuilder } from "../geometry/mesh.js";
import type { Room } from "../schema/schema.js";
import type { PlacedOpening } from "./openings.js";
import { segDir, type FaceBand, type FaceZone, type WallSegment } from "./walls.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const Side = z.enum(["north", "south", "east", "west"]);

export const FinishesSchema = z
  .object({
    walls: Mat.optional().describe(
      "Finish for every wall face inside this room (paint, wallpaper, tiles to full height). Only this room's side of a shared wall changes; window reveals follow it",
    ),
    accents: z
      .array(
        z
          .object({
            wall: Id.optional().describe("Wall id: only its face(s) inside this room get the accent"),
            side: Side.optional().describe("Or the room's wall on that compass side, e.g. 'north' = the wall along the north edge"),
            material: Mat.describe("e.g. a wallpaper_* or slats_* material"),
            from: z.number().min(0).optional().describe("Only a height band: bottom above the finished floor (e.g. a kitchen backsplash from 0.9)"),
            to: z.number().positive().optional().describe("Top of the band above the finished floor (default: the ceiling)"),
          })
          .refine((a) => a.wall || a.side, { message: "accent needs `wall` (an id) or `side` (north/south/east/west)" }),
      )
      .default([])
      .describe("Feature walls: override `walls` above the wainscot on chosen walls"),
    wainscot: z
      .object({
        height: z.number().positive().default(0.9).describe("Top of the band above the finished floor (bathroom tiles 1.2, dado panelling 0.9)"),
        material: Mat.describe("Tiles, paint or wood for the lower band"),
        style: z.enum(["flat", "panels"]).default("flat").describe("panels = applied picture-frame mouldings (classic panelled wainscoting)"),
        panelWidth: z.number().positive().default(0.6).describe("panels: target panel width (fitted evenly per wall)"),
        cap: z
          .object({
            material: Mat.optional().describe("Default: the skirting material, else wood_painted_white"),
            size: z.number().positive().default(0.05).describe("Rail height"),
            depth: z.number().positive().default(0.025).describe("How far it projects from the wall"),
          })
          .optional()
          .describe("Dado / chair rail capping the band (tile trims: a slim cap like {size:0.02, depth:0.012, material:'metal_steel'})"),
      })
      .optional()
      .describe("Lower wall band: tiling to a height, panelled or painted wainscoting"),
    skirting: z
      .object({
        height: z.number().positive().default(0.12),
        depth: z.number().positive().default(0.018).describe("Projection from the wall"),
        material: Mat.default("wood_painted_white"),
        profile: z.enum(["square", "bevel", "ogee", "bullnose"]).default("ogee"),
      })
      .optional()
      .describe("Skirting / baseboard along every wall face of the room, mitred at corners and stopped at doors"),
    cornice: z
      .object({
        height: z.number().positive().default(0.1).describe("Drop down the wall from the ceiling"),
        depth: z.number().positive().default(0.1).describe("Projection across the ceiling"),
        material: Mat.default("plaster_white"),
        profile: z.enum(["cove", "ogee", "step", "square"]).default("cove"),
      })
      .optional()
      .describe("Cornice / crown moulding where the walls meet the ceiling"),
    pictureRail: z
      .object({
        height: z.number().positive().default(2.2).describe("Above the finished floor"),
        size: z.number().positive().default(0.04),
        depth: z.number().positive().default(0.02),
        material: Mat.default("wood_painted_white"),
        frieze: Mat.optional().describe("Different finish for the wall above the rail (frieze)"),
      })
      .optional(),
    dadoRail: z
      .object({
        height: z.number().positive().default(0.9).describe("Above the finished floor"),
        size: z.number().positive().default(0.05),
        depth: z.number().positive().default(0.025),
        material: Mat.default("wood_painted_white"),
      })
      .optional()
      .describe("Chair rail without a wainscot band (with a wainscot use wainscot.cap)"),
    ceiling: z
      .object({
        type: z.enum(["flat", "tray", "coffered", "beams"]).default("flat"),
        material: Mat.optional().describe("Default: the room's ceilingMaterial"),
        drop: z.number().positive().default(0.25).describe("tray: how far the perimeter soffit hangs below the centre"),
        inset: z.number().positive().default(0.6).describe("tray: soffit width from the walls"),
        coveLight: z.union([Mat, z.literal(false)]).default("emissive_light").describe("tray: glowing LED strip in a recessed cove slot; false = plain step"),
        spacing: z.number().positive().default(1.2).describe("coffered / beams: centre spacing (fitted evenly to the room)"),
        beamWidth: z.number().positive().optional().describe("Default: coffered 0.15, beams 0.14"),
        beamDepth: z.number().positive().optional().describe("Default: coffered 0.15, beams 0.2"),
        beamMaterial: Mat.optional().describe("Default: coffered = ceiling material, beams = wood_oak"),
        direction: z.enum(["auto", "x", "y"]).default("auto").describe("beams: run along x (east-west) or y; auto = across the shorter span"),
      })
      .optional()
      .describe("Feature ceiling replacing the flat one (height = the room's ceiling height)"),
    floorBorder: z
      .object({
        width: z.number().positive().default(0.2),
        material: Mat,
        inset: z.number().min(0).default(0).describe("Main floor strip between the wall and the border"),
      })
      .optional()
      .describe("Inlay border band of another material around the room, e.g. a marble or walnut border"),
    threshold: Mat.optional().describe("Strip across the wall thickness under each door / opening of this room (e.g. marble_white, wood_oak)"),
  })
  .describe("Interior finishes: wall finish, accent walls, wainscot/tiling, skirting, cornice, rails, feature ceiling, floor border");

export type Finishes = z.output<typeof FinishesSchema>;

// ---------------------------------------------------------------------------
// Faces
// ---------------------------------------------------------------------------

type FaceSide = "left" | "right" | "capA" | "capB";

interface Face {
  seg: WallSegment;
  side: FaceSide;
  /** Face runs p0 → p1 with the room on its left (normal n = perp(d)). */
  p0: Vec2;
  p1: Vec2;
  d: Vec2;
  n: Vec2;
  len: number;
  /** Stretches [t0, t1] (meters from p0) that look into room `room`. */
  zones: { t0: number; t1: number; room: number }[];
}

const uOf = (s: WallSegment, p: Vec2) => v2.dot(v2.sub(p, s.a), segDir(s));

/** Segment u ↔ face t (left runs with the segment, right against it). */
function faceT(f: Face, u: number): number {
  return f.side === "left" ? u - uOf(f.seg, f.seg.aL) : uOf(f.seg, f.seg.bR) - u;
}

function wallFaces(segs: WallSegment[]): Face[] {
  const out: Face[] = [];
  const add = (seg: WallSegment, side: FaceSide, p0: Vec2, p1: Vec2) => {
    const len = v2.dist(p0, p1);
    if (len < 1e-3) return;
    const d = v2.norm(v2.sub(p1, p0));
    out.push({ seg, side, p0, p1, d, n: v2.perp(d), len, zones: [] });
  };
  for (const s of segs) {
    add(s, "left", s.aL, s.bL);
    add(s, "right", s.bR, s.aR);
    if (s.freeA) add(s, "capA", s.aR, s.aL);
    if (s.freeB) add(s, "capB", s.bL, s.bR);
  }
  return out;
}

/** Parameter intervals of the segment p0 + t·d, t ∈ [0, len], that lie inside `poly`. */
export function clipToPolygon(p0: Vec2, d: Vec2, len: number, poly: Vec2[]): [number, number][] {
  const ts = [0, len];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const e = v2.sub(b, a);
    const den = v2.cross(d, e);
    if (Math.abs(den) < 1e-12) continue;
    const w = v2.sub(a, p0);
    const t = v2.cross(w, e) / den;
    const s = v2.cross(w, d) / den;
    if (s >= -1e-9 && s <= 1 + 1e-9 && t > 0 && t < len) ts.push(t);
  }
  ts.sort((x, y) => x - y);
  const out: [number, number][] = [];
  for (let i = 0; i < ts.length - 1; i++) {
    if (ts[i + 1] - ts[i] < 1e-6) continue;
    const m = (ts[i] + ts[i + 1]) / 2;
    if (!pointInPolygon(v2.add(p0, v2.scale(d, m)), poly)) continue;
    const last = out[out.length - 1];
    if (last && Math.abs(last[1] - ts[i]) < 1e-6) last[1] = ts[i + 1];
    else out.push([ts[i], ts[i + 1]]);
  }
  return out;
}

/** Subtract intervals from [a, b]. */
function subtract(a: number, b: number, cuts: [number, number][]): [number, number][] {
  let parts: [number, number][] = [[a, b]];
  for (const [c0, c1] of cuts) {
    const next: [number, number][] = [];
    for (const [p, q] of parts) {
      if (c1 <= p || c0 >= q) next.push([p, q]);
      else {
        if (c0 > p) next.push([p, c0]);
        if (c1 < q) next.push([c1, q]);
      }
    }
    parts = next;
  }
  return parts.filter(([p, q]) => q - p > 1e-4);
}

// ---------------------------------------------------------------------------
// Prepare: assign faces to rooms and paint wall segments
// ---------------------------------------------------------------------------

export interface FinishPlan {
  rooms: Room[];
  faces: Face[];
  segs: WallSegment[];
  placed: PlacedOpening[];
  /** Level elevation (slab top). */
  z: number;
  floorZ: number;
  thresholdsDone: Set<PlacedOpening>;
  warn: (m: string) => void;
}

const PROBE = 0.05;
const SIDE_VEC: Record<z.infer<typeof Side>, Vec2> = { north: [0, 1], south: [0, -1], east: [1, 0], west: [-1, 0] };

const roomLabel = (r: Room, i: number) => `room '${r.id ?? r.name ?? i}'`;

function accentMatches(a: Finishes["accents"][number], f: Face): boolean {
  if (a.wall && f.seg.wallId !== a.wall) return false;
  // the wall on the room's north side faces south (its inward normal points away from that side)
  if (a.side && v2.dot(f.n, SIDE_VEC[a.side]) > -0.7) return false;
  return true;
}

/** Paint [z0, z1) of a band list with `material`. */
function overlay(bands: FaceBand[], z0: number, z1: number, material: string): FaceBand[] {
  const out: FaceBand[] = [];
  let prev = -Infinity;
  for (const b of bands) {
    const lo = prev, hi = b.z1;
    prev = hi;
    if (hi <= z0 || lo >= z1) {
      out.push(b);
      continue;
    }
    if (lo < z0) out.push({ z1: z0, material: b.material });
    out.push({ z1: Math.min(hi, z1), material });
    if (hi > z1) out.push({ z1: hi, material: b.material });
  }
  return out;
}

function faceBands(fin: Finishes, f: Face, floorZ: number): FaceBand[] | null {
  const matching = fin.accents.filter((a) => accentMatches(a, f));
  const accent = matching.find((a) => a.from === undefined && a.to === undefined);
  const main = accent?.material ?? fin.walls ?? null;
  const bands: FaceBand[] = [];
  if (fin.wainscot) bands.push({ z1: floorZ + fin.wainscot.height, material: fin.wainscot.material });
  if (fin.pictureRail?.frieze) {
    bands.push({ z1: floorZ + fin.pictureRail.height, material: main });
    bands.push({ z1: Infinity, material: fin.pictureRail.frieze });
  } else bands.push({ z1: Infinity, material: main });
  let out = bands;
  for (const a of matching)
    if (a !== accent) out = overlay(out, a.from !== undefined ? floorZ + a.from : -Infinity, a.to !== undefined ? floorZ + a.to : Infinity, a.material);
  return out.some((b) => b.material) ? out : null;
}

/**
 * Work out which room every wall face looks into and paint the faces of rooms that have `finishes`.
 * Call after openings have added their holes and before `buildWallSegment`.
 */
export function prepareFinishes(
  rooms: Room[],
  segs: WallSegment[],
  placed: PlacedOpening[],
  levelZ: number,
  floorZ: number,
  warn: (m: string) => void,
): FinishPlan {
  const faces = wallFaces(segs);
  const polys = rooms.map((r) => ensureCCW(r.polygon as Vec2[]));
  for (const f of faces) {
    const q0 = v2.add(f.p0, v2.scale(f.n, PROBE));
    const taken: [number, number][] = [];
    polys.forEach((poly, ri) => {
      for (const [t0, t1] of clipToPolygon(q0, f.d, f.len, poly))
        for (const [a, b] of subtract(t0, t1, taken)) {
          f.zones.push({ t0: a, t1: b, room: ri });
          taken.push([a, b]);
        }
    });
  }

  const plan: FinishPlan = { rooms, faces, segs, placed, z: levelZ, floorZ, thresholdsDone: new Set(), warn };
  if (!rooms.some((r) => r.finishes)) return plan;

  for (const f of faces) {
    for (const zn of f.zones) {
      const fin = rooms[zn.room].finishes;
      if (!fin) continue;
      const bands = faceBands(fin, f, floorZ);
      if (!bands) continue;
      const s = f.seg;
      s.paint ??= { left: [], right: [] };
      if (f.side === "capA" || f.side === "capB") {
        if (zn.t1 - zn.t0 > f.len / 2) s.paint[f.side] = bands;
        continue;
      }
      const u0 = f.side === "left" ? uOf(s, s.aL) + zn.t0 : uOf(s, s.bR) - zn.t1;
      const zone: FaceZone = { u0, u1: u0 + (zn.t1 - zn.t0), bands };
      s.paint[f.side].push(zone);
    }
  }

  // modest sanity hints
  rooms.forEach((r, ri) => {
    const fin = r.finishes;
    if (!fin) return;
    const mine = faces.filter((f) => f.zones.some((z) => z.room === ri));
    if (!mine.length) {
      warn(`${roomLabel(r, ri)}: has finishes but no wall faces inside it — draw the room polygon on the wall centerlines`);
      return;
    }
    for (const a of fin.accents) {
      if (mine.some((f) => accentMatches(a, f))) continue;
      const ids = [...new Set(mine.map((f) => f.seg.wallId))].join(", ");
      warn(`${roomLabel(r, ri)}: accent ${a.wall ? `wall '${a.wall}'` : ""}${a.wall && a.side ? " on the " : ""}${a.side ? `${a.side} side` : ""} does not bound this room (walls around it: ${ids})`);
    }
  });
  return plan;
}

// ---------------------------------------------------------------------------
// Room outline helpers
// ---------------------------------------------------------------------------

/** The room's clear outline: each polygon edge moved onto the wall face that runs along it. */
function clearOutline(plan: FinishPlan, ri: number): Vec2[] {
  const poly = ensureCCW(plan.rooms[ri].polygon as Vec2[]);
  const n = poly.length;
  const lines: { p: Vec2; d: Vec2 }[] = [];
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const e = v2.norm(v2.sub(b, a));
    const inward = v2.perp(e);
    const len = v2.dist(a, b);
    let best = 0, bestOverlap = 0;
    for (const f of plan.faces) {
      if (!f.zones.some((z) => z.room === ri)) continue;
      if (Math.abs(v2.cross(f.d, e)) > 0.02 || v2.dot(f.n, inward) < 0.98) continue;
      const dist = v2.dot(v2.sub(f.p0, a), inward);
      if (Math.abs(dist) > 0.5) continue;
      const s0 = v2.dot(v2.sub(f.p0, a), e), s1 = v2.dot(v2.sub(f.p1, a), e);
      const overlap = Math.min(len, Math.max(s0, s1)) - Math.max(0, Math.min(s0, s1));
      if (overlap > bestOverlap + 1e-6) {
        bestOverlap = overlap;
        best = dist;
      }
    }
    lines.push({ p: v2.add(a, v2.scale(inward, best)), d: e });
  }
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const A = lines[(i - 1 + n) % n], B = lines[i];
    out.push(lineIntersect(A.p, A.d, B.p, B.d) ?? B.p);
  }
  return signedArea(out) > 0.01 ? out : poly;
}

/** Shrink a CCW outline by d; null when it collapses. */
function shrink(poly: Vec2[], d: number): Vec2[] | null {
  if (d <= 0) return poly;
  const out = offsetPolygon(poly, -d);
  const a = signedArea(out);
  // collapsed or flipped outlines lose area fast; also reject when any edge flipped direction
  if (a < 0.05) return null;
  for (let i = 0; i < poly.length; i++) {
    const e0 = v2.sub(poly[(i + 1) % poly.length], poly[i]), e1 = v2.sub(out[(i + 1) % out.length], out[i]);
    if (v2.dot(e0, e1) <= 0) return null;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Profiles (y = out from the wall, z = up), open at the wall (y = 0)
// ---------------------------------------------------------------------------

type Profile = Vec2[];

function arc(cy: number, cz: number, ry: number, rz: number, a0: number, a1: number, n: number): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    pts.push([cy + Math.cos(a) * ry, cz + Math.sin(a) * rz]);
  }
  return pts;
}

/** Skirting profile from the floor (z=0) to its top (z=H). */
function skirtingProfile(kind: string, H: number, D: number): Profile {
  switch (kind) {
    case "square":
      return [[0, 0], [D, 0], [D, H], [0, H]];
    case "bevel":
      return [[0, 0], [D, 0], [D, H * 0.78], [D * 0.3, H], [0, H]];
    case "bullnose":
      return [[0, 0], [D, 0], ...arc(0, H - D, D, D, 0, Math.PI / 2, 6).slice(0, -1), [0, H]];
    default: {
      // ogee: plinth face, a cyma reversa (convex then concave) and a small fillet on top
      const pts: Vec2[] = [[0, 0], [D, 0], [D, H * 0.62]];
      const n = 8;
      for (let i = 1; i <= n; i++) {
        const s = i / n;
        const y = D - D * 0.62 * (0.5 - 0.5 * Math.cos(Math.PI * s));
        const zz = H * 0.62 + H * 0.3 * (s + 0.12 * Math.sin(2 * Math.PI * s));
        pts.push([y, zz]);
      }
      pts.push([D * 0.3, H], [0, H]);
      return pts;
    }
  }
}

/** Cornice profile from the wall (z=-H) to the ceiling (z=0). */
function corniceProfile(kind: string, H: number, D: number): Profile {
  switch (kind) {
    case "square":
      return [[0, -H], [D, -H], [D, 0]];
    case "step":
      return [[0, -H], [D * 0.3, -H], [D * 0.3, -H * 0.62], [D * 0.65, -H * 0.62], [D * 0.65, -H * 0.28], [D, -H * 0.28], [D, 0]];
    case "ogee": {
      const pts: Vec2[] = [[0, -H], [D * 0.12, -H], [D * 0.12, -H * 0.86], [D * 0.2, -H * 0.82]];
      const n = 10;
      for (let i = 1; i <= n; i++) {
        const s = i / n;
        // cyma recta: concave low, convex high
        pts.push([D * 0.2 + D * 0.68 * s, -H * 0.82 + H * 0.68 * (0.5 - 0.5 * Math.cos(Math.PI * s))]);
      }
      pts.push([D * 0.88, -H * 0.1], [D, -H * 0.1], [D, 0]);
      return pts;
    }
    default:
      // cove: concave quarter ellipse with small fillets
      return [[0, -H], [D * 0.06, -H], ...arc(D, -H * 0.94 + 0, D * 0.94, H * 0.88, Math.PI, Math.PI / 2, 10).map(([y, zz]) => [y, Math.min(zz, -H * 0.06)] as Vec2), [D, 0]];
  }
}

/** Rail profile centred on z = 0 (dado / picture / wainscot cap). */
function railProfile(S: number, D: number, picture = false): Profile {
  if (picture)
    return [[0, -S / 2], [D * 0.55, -S / 2], ...arc(D * 0.55, -S * 0.1, D * 0.45, S * 0.4, -Math.PI / 2, Math.PI / 2, 6).slice(1), [D * 0.4, S * 0.3], [D * 0.4, S / 2], [0, S / 2]];
  return [[0, -S / 2], [D * 0.5, -S / 2], ...arc(D * 0.5, 0, D * 0.5, S * 0.32, -Math.PI / 2, Math.PI / 2, 6).slice(1), [D * 0.5, S / 2], [0, S / 2]];
}

// ---------------------------------------------------------------------------
// Trim extrusion along the room's faces
// ---------------------------------------------------------------------------

interface Piece {
  f: Face;
  t0: number;
  t1: number;
  k0: number;
  k1: number;
}

/** Mitre factor at a corner: how far (per meter of projection) a trim on F extends past the corner. */
function mitreK(prev: Face, next: Face, atEndOf: "prev" | "next"): number {
  const C = next.p0;
  const X = lineIntersect(v2.add(C, prev.n), prev.d, v2.add(C, next.n), next.d);
  if (!X) return 0;
  const k = atEndOf === "prev" ? v2.dot(v2.sub(X, C), prev.d) : v2.dot(v2.sub(X, C), next.d);
  return Math.max(-4, Math.min(4, k));
}

/** Pieces of the room's wall faces covering heights [za, zb], split at openings that cross that band. */
function trimPieces(plan: FinishPlan, ri: number, za: number, zb: number): Piece[] {
  const covers = (f: Face) => f.seg.z0 <= za + 1e-3 && f.seg.z1 >= zb - 1e-3;
  const mineAt = (f: Face, t: number) => f.zones.find((z) => z.room === ri && t >= z.t0 - 1e-4 && t <= z.t1 + 1e-4);
  const out: Piece[] = [];
  for (const f of plan.faces) {
    if (!covers(f)) continue;
    const cuts: [number, number][] = [];
    if (f.side === "left" || f.side === "right")
      for (const h of f.seg.holes) {
        if (h.z0 >= zb - 1e-3 || h.z1 <= za + 1e-3) continue;
        const a = faceT(f, h.u0), b = faceT(f, h.u1);
        cuts.push([Math.min(a, b), Math.max(a, b)]);
      }
    for (const zn of f.zones) {
      if (zn.room !== ri) continue;
      for (const [t0, t1] of subtract(zn.t0, zn.t1, cuts)) {
        let k0 = 0, k1 = 0;
        if (t0 < 1e-4) {
          const prev = plan.faces.find((g) => g !== f && v2.eq(g.p1, f.p0, 2e-3) && covers(g) && mineAt(g, g.len));
          if (prev && !holeAtEnd(prev, za, zb)) k0 = mitreK(prev, f, "next");
        }
        if (t1 > f.len - 1e-4) {
          const next = plan.faces.find((g) => g !== f && v2.eq(g.p0, f.p1, 2e-3) && covers(g) && mineAt(g, 0));
          if (next && !holeAtStart(next, za, zb)) k1 = mitreK(f, next, "prev");
        }
        out.push({ f, t0, t1, k0, k1 });
      }
    }
  }
  return out;
}

function holeTs(f: Face, za: number, zb: number): [number, number][] {
  if (f.side !== "left" && f.side !== "right") return [];
  return f.seg.holes
    .filter((h) => h.z0 < zb - 1e-3 && h.z1 > za + 1e-3)
    .map((h) => {
      const a = faceT(f, h.u0), b = faceT(f, h.u1);
      return [Math.min(a, b), Math.max(a, b)] as [number, number];
    });
}
const holeAtEnd = (f: Face, za: number, zb: number) => holeTs(f, za, zb).some(([, b]) => b > f.len - 1e-3);
const holeAtStart = (f: Face, za: number, zb: number) => holeTs(f, za, zb).some(([a]) => a < 1e-3);

/** Face-local frame: x along the face, y out into the room, z up from `baseZ`. */
function faceFrame(f: Face, baseZ: number) {
  return m4.fromBasis([f.d[0], f.d[1], 0], [f.n[0], f.n[1], 0], [0, 0, 1], [f.p0[0], f.p0[1], baseZ]);
}

/** Extrude an open profile (y ≥ 0, closed implicitly along y = 0) along a piece with mitred / square ends. */
function extrude(mb: MeshBuilder, mat: string, profile: Profile, p: Piece, baseZ: number) {
  const ymax = Math.max(...profile.map((q) => q[0]));
  if (p.t1 + p.k1 * ymax - (p.t0 + p.k0 * ymax) < 0.005) return;
  // orient the closed outline counter-clockwise in (y, z) so quads face outward
  const closed = signedArea(profile) < 0 ? [...profile].reverse() : profile;
  const S = (q: Vec2): Vec3 => [p.t0 + p.k0 * q[0], q[0], q[1]];
  const E = (q: Vec2): Vec3 => [p.t1 + p.k1 * q[0], q[0], q[1]];
  mb.with(faceFrame(p.f, baseZ), () => {
    for (let i = 0; i < closed.length; i++) {
      const a = closed[i], b = closed[(i + 1) % closed.length];
      if (a[0] < 1e-6 && b[0] < 1e-6) continue; // against the wall
      mb.quad(mat, S(a), S(b), E(b), E(a));
    }
    mb.polygon(mat, closed.map(S), [-1, p.k0, 0]);
    mb.polygon(mat, closed.map(E), [1, -p.k1, 0]);
  });
}

function runTrim(mb: MeshBuilder, plan: FinishPlan, ri: number, mat: string, profile: Profile, baseZ: number) {
  const zs = profile.map((q) => q[1] + baseZ);
  const za = Math.min(...zs), zb = Math.max(...zs);
  for (const p of trimPieces(plan, ri, za, zb)) extrude(mb, mat, profile, p, baseZ);
}

/** Quad whose winding is fixed up to face `n`. */
function quadFacing(mb: MeshBuilder, mat: string, a: Vec3, b: Vec3, c: Vec3, d: Vec3, n: Vec3) {
  const e1: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const cr: Vec3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
  if (cr[0] * n[0] + cr[1] * n[1] + cr[2] * n[2] >= 0) mb.quad(mat, a, b, c, d);
  else mb.quad(mat, d, c, b, a);
}

/** Bolection-style moulding cross-section: (s across the bar from its outer edge, y proud of the wall). */
const FRAME_MOULDING: Vec2[] = [[0, 0], [0, 0.005], [0.005, 0.011], [0.013, 0.016], [0.022, 0.014], [0.029, 0.008], [0.034, 0.003], [0.036, 0]];

/**
 * Picture-frame moulding on a wall plane (face-local x along the wall, z up, y out of the wall),
 * four bars with 45° mitres.
 */
function mouldingFrame(mb: MeshBuilder, mat: string, x0: number, z0: number, x1: number, z1: number) {
  const prof = FRAME_MOULDING;
  const W = prof[prof.length - 1][0];
  // side: origin, along (x,z), inward (x,z), length
  const sides: [Vec2, Vec2, Vec2, number][] = [
    [[x0, z0], [1, 0], [0, 1], x1 - x0],
    [[x1, z0], [0, 1], [-1, 0], z1 - z0],
    [[x1, z1], [-1, 0], [0, -1], x1 - x0],
    [[x0, z1], [0, -1], [1, 0], z1 - z0],
  ];
  for (const [o, al, inw, L] of sides) {
    if (L < 2 * W + 0.01) continue;
    const P = (a: number, s: number, y: number): Vec3 => [o[0] + al[0] * a + inw[0] * s, y, o[1] + al[1] * a + inw[1] * s];
    for (let i = 0; i < prof.length - 1; i++) {
      const [s0, y0] = prof[i], [s1, y1] = prof[i + 1];
      // outward normal of the profile edge in (s, y), mapped to 3D
      const ns = -(y1 - y0), ny = s1 - s0;
      const n: Vec3 = [inw[0] * ns, ny, inw[1] * ns];
      quadFacing(mb, mat, P(s0, s0, y0), P(L - s0, s0, y0), P(L - s1, s1, y1), P(s1, s1, y1), n);
    }
  }
}

/** Applied picture-frame mouldings on the wainscot band. */
function wainscotPanels(mb: MeshBuilder, plan: FinishPlan, ri: number, mat: string, z0: number, z1: number, panelW: number) {
  const stile = 0.09;
  if (z1 - z0 < 0.25) return;
  for (const p of trimPieces(plan, ri, z0, z1)) {
    // keep clear of corners (the neighbour's mouldings) and of opening edges
    const a = p.t0 + Math.max(0, p.k0) * 0.03, b = p.t1 + Math.min(0, p.k1) * 0.03;
    const len = b - a;
    const n = Math.max(1, Math.round((len - stile) / (panelW + stile)));
    const w = (len - (n + 1) * stile) / n;
    if (w < 0.18) continue;
    mb.with(faceFrame(p.f, 0), () => {
      for (let i = 0; i < n; i++) {
        const x0 = a + stile + i * (w + stile);
        mouldingFrame(mb, mat, x0, z0, x0 + w, z1);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Ceilings
// ---------------------------------------------------------------------------

/** Vertical band along a CCW outline facing into it, from za to zb. */
function innerWalls(mb: MeshBuilder, mat: string, poly: Vec2[], za: number, zb: number) {
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    // facing the polygon's inside (left of a CCW edge): quad b→a seen from the left
    mb.quad(mat, [b[0], b[1], za], [a[0], a[1], za], [a[0], a[1], zb], [b[0], b[1], zb]);
  }
}

/** Box hanging below the ceiling between plan points p→q (centreline), width w, bottom zb, top zt. No top/end faces. */
function beam(mb: MeshBuilder, mat: string, p: Vec2, q: Vec2, w: number, zb: number, zt: number, ends = false) {
  const d = v2.norm(v2.sub(q, p));
  const len = v2.dist(p, q);
  if (len < 0.01) return;
  const n = v2.perp(d);
  mb.with(m4.fromBasis([d[0], d[1], 0], [n[0], n[1], 0], [0, 0, 1], [p[0], p[1], 0]), () =>
    mb.box(mat, [0, -w / 2, zb], [len, w / 2, zt], { skip: ends ? ["+z"] : ["+z", "-x", "+x"] }),
  );
}

/** Oriented frame of an outline: x along its longest edge. */
function outlineFrame(poly: Vec2[]) {
  let best = 0, ex: Vec2 = [1, 0];
  for (let i = 0; i < poly.length; i++) {
    const e = v2.sub(poly[(i + 1) % poly.length], poly[i]);
    if (v2.len(e) > best) {
      best = v2.len(e);
      ex = v2.norm(e);
    }
  }
  // prefer the axis closest to plan east so "x"/"y" directions mean what users expect
  if (Math.abs(ex[1]) > Math.abs(ex[0])) ex = ex[1] > 0 ? [ex[1], -ex[0]] : [-ex[1], ex[0]];
  if (ex[0] < 0) ex = [-ex[0], -ex[1]];
  const ey = v2.perp(ex);
  const xs = poly.map((p) => v2.dot(p, ex)), ys = poly.map((p) => v2.dot(p, ey));
  return { ex, ey, x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

/** Evenly spaced line positions strictly inside (a, b), about `spacing` apart. */
function gridLines(a: number, b: number, spacing: number): number[] {
  const n = Math.max(1, Math.round((b - a) / spacing));
  const out: number[] = [];
  for (let i = 1; i < n; i++) out.push(a + ((b - a) * i) / n);
  return out;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * What a room's ceiling looks like in plan (recorded by the build for the reflected-ceiling and false-ceiling
 * sheets). Heights are nominal, above the level's slab top (≈ the finished floor).
 */
export interface CeilingLayout {
  /** Index in level.rooms. */
  room: number;
  type: "flat" | "tray" | "coffered" | "beams" | "none";
  /** Requested feature ceiling that did not fit (built flat instead). */
  fallback?: "tray" | "coffered" | "beams";
  material?: string;
  /** Main ceiling height. */
  height: number;
  /** Underside of the structure above (slab soffit); height..structure is the ceiling void. */
  structure: number;
  /** Clear outline (wall faces) of the ceiling. */
  outline: Vec2[];
  holes: Vec2[][];
  /** Lowered perimeter band: tray soffit or the coffered perimeter beam. */
  soffit?: { outer: Vec2[]; inner: Vec2[]; height: number; width: number; material: string };
  /** Hanging beams / coffer ribs (centrelines). */
  beams: { a: Vec2; b: Vec2; width: number; height: number; material: string }[];
  /** LED cove line around the tray step (closed). */
  cove?: { line: Vec2[]; material: string };
  cornice?: { depth: number; material: string };
}

export interface RoomFinishOptions {
  /** Nominal ceiling height above the level (for the recorded layout). */
  ceilingHeight: number;
  /** Underside of the structure above, above the level. */
  structureHeight: number;
  floorMaterial: string;
  /** false = no ceiling. */
  ceilingMaterial: string | false;
  /** Underside z of the ceiling (absolute). */
  ceilingZ: number;
  floorHoles: Vec2[][];
  ceilingHoles: Vec2[][];
}

/** Floor, ceiling and trims of a room that has `finishes`. Returns the ceiling as built. */
export function buildRoomFinishes(mb: MeshBuilder, plan: FinishPlan, ri: number, o: RoomFinishOptions): CeilingLayout {
  const room = plan.rooms[ri];
  const fin = room.finishes!;
  const label = roomLabel(room, ri);
  const poly = ensureCCW(room.polygon as Vec2[]);
  const clear = clearOutline(plan, ri);
  const floorZ = plan.floorZ;
  const warn = plan.warn;
  const headroom = o.ceilingZ - floorZ;

  // ---- floor (+ border inlay) ----
  const fb = fin.floorBorder;
  const outerB = fb ? shrink(clear, fb.inset) : null;
  const innerB = fb && outerB ? shrink(outerB, fb.width) : null;
  if (fb && outerB && innerB) {
    if (fb.inset > 0) mb.flat(o.floorMaterial, poly, floorZ, false, [outerB]);
    mb.flat(fb.material, fb.inset > 0 ? outerB : poly, floorZ, false, [innerB]);
    mb.flat(o.floorMaterial, innerB, floorZ, false, o.floorHoles);
  } else {
    if (fb) warn(`${label}: floorBorder (inset ${fb.inset} + width ${fb.width} m) leaves no floor in the middle; make it narrower`);
    mb.flat(o.floorMaterial, poly, floorZ, false, o.floorHoles);
  }

  // ---- thresholds ----
  if (fin.threshold) {
    for (const p of plan.placed) {
      if (plan.thresholdsDone.has(p) || (p.op.type !== "door" && p.op.type !== "opening") || p.z0 > plan.z + 0.05) continue;
      const mine = plan.faces.some(
        (f) => f.seg === p.seg && (f.side === "left" || f.side === "right") && f.zones.some((zn) => zn.room === ri && Math.abs(faceT(f, p.u) - (zn.t0 + zn.t1) / 2) <= (zn.t1 - zn.t0) / 2 + 1e-3),
      );
      if (!mine) continue;
      plan.thresholdsDone.add(p);
      const s = p.seg, d = segDir(s), N = v2.perp(d), half = s.thickness / 2;
      mb.with(m4.fromBasis([d[0], d[1], 0], [N[0], N[1], 0], [0, 0, 1], [s.a[0], s.a[1], 0]), () =>
        mb.box(fin.threshold!, [p.u - p.width / 2, -half, plan.z + 0.002], [p.u + p.width / 2, half, floorZ + 0.006], { skip: ["-z"] }),
      );
    }
  }

  // ---- wall trims ----
  const sk = fin.skirting;
  if (sk) runTrim(mb, plan, ri, sk.material, skirtingProfile(sk.profile, sk.height + 0.002, sk.depth), floorZ - 0.002);
  const ws = fin.wainscot;
  if (ws) {
    if (ws.height >= headroom - 0.05)
      warn(`${label}: wainscot height ${ws.height} m reaches the ceiling (${headroom.toFixed(2)} m); use finishes.walls for full-height tiling`);
    const capMat = ws.cap?.material ?? sk?.material ?? "wood_painted_white";
    if (ws.style === "panels")
      wainscotPanels(mb, plan, ri, ws.material, floorZ + (sk ? sk.height : 0) + 0.08, floorZ + ws.height - (ws.cap ? ws.cap.size : 0) - 0.08, ws.panelWidth);
    if (ws.cap && ws.height < headroom - 0.05) runTrim(mb, plan, ri, capMat, railProfile(ws.cap.size, ws.cap.depth), floorZ + ws.height - ws.cap.size / 2);
  }
  const dr = fin.dadoRail;
  if (dr) runTrim(mb, plan, ri, dr.material, railProfile(dr.size, dr.depth), floorZ + dr.height);
  const pr = fin.pictureRail;
  if (pr) {
    if (pr.height >= headroom - 0.05 || (ws && pr.height <= ws.height))
      warn(`${label}: pictureRail height ${pr.height} m should sit between the wainscot and the ceiling (${headroom.toFixed(2)} m)`);
    else runTrim(mb, plan, ri, pr.material, railProfile(pr.size, pr.depth, true), floorZ + pr.height);
  }

  // ---- ceiling ----
  const H = o.ceilingHeight;
  const toH = (zAbs: number) => Math.round((H - (o.ceilingZ - zAbs)) * 1000) / 1000;
  const layout: CeilingLayout = { room: ri, type: "flat", height: H, structure: o.structureHeight, outline: clear, holes: o.ceilingHoles, beams: [] };
  if (fin.cornice) layout.cornice = { depth: fin.cornice.depth, material: fin.cornice.material };
  if (o.ceilingMaterial === false) {
    if (fin.ceiling && fin.ceiling.type !== "flat") warn(`${label}: ceiling ${fin.ceiling.type} ignored because ceilingMaterial is false`);
    if (fin.cornice) runCornice(mb, plan, ri, fin, o.ceilingZ);
    layout.type = "none";
    return layout;
  }
  const c = fin.ceiling ?? { type: "flat" as const };
  const cm = ("material" in c && c.material) || o.ceilingMaterial;
  layout.material = cm;
  const addBeam = (mat: string, p: Vec2, q: Vec2, w: number, zb: number) => {
    beam(mb, mat, p, q, w, zb, o.ceilingZ);
    if (v2.dist(p, q) >= 0.01) layout.beams.push({ a: p, b: q, width: w, height: toH(zb), material: mat });
  };
  let corniceZ = o.ceilingZ;
  if (c.type === "tray") {
    const zS = o.ceilingZ - c.drop;
    const inner = shrink(clear, c.inset);
    if (!inner || zS - floorZ < 2.0) {
      warn(`${label}: tray ceiling ${!inner ? `inset ${c.inset} m is too wide for the room` : `soffit at ${(zS - floorZ).toFixed(2)} m leaves too little headroom (< 2.0 m)`}; using a flat ceiling`);
      mb.flat(cm, poly, o.ceilingZ, true, o.ceilingHoles);
      layout.fallback = "tray";
    } else {
      corniceZ = zS;
      layout.type = "tray";
      layout.soffit = { outer: clear, inner, height: toH(zS), width: c.inset, material: cm };
      mb.flat(cm, poly, zS, true, [inner]);
      if (c.coveLight) {
        // recessed slot at the top of the step with a glowing back (LED strip)
        const slotH = Math.min(0.07, c.drop * 0.4), slotD = 0.08;
        const back = offsetPolygon(inner, slotD);
        layout.cove = { line: offsetPolygon(inner, slotD / 2), material: c.coveLight };
        innerWalls(mb, cm, inner, zS, o.ceilingZ - slotH);
        mb.flat(cm, back, o.ceilingZ - slotH, false, [inner]); // slot floor (seen from the cutaway)
        innerWalls(mb, c.coveLight, back, o.ceilingZ - slotH, o.ceilingZ);
        mb.flat(cm, back, o.ceilingZ, true, o.ceilingHoles);
      } else {
        innerWalls(mb, cm, inner, zS, o.ceilingZ);
        mb.flat(cm, inner, o.ceilingZ, true, o.ceilingHoles);
      }
    }
  } else if (c.type === "coffered") {
    const bw = c.beamWidth ?? 0.15, bd = c.beamDepth ?? 0.15;
    const bm = c.beamMaterial ?? cm;
    const zb = o.ceilingZ - bd;
    const inner = shrink(clear, bw);
    if (!inner || zb - floorZ < 2.0 || c.spacing < bw * 2.5) {
      warn(`${label}: coffered ceiling does not fit (beams ${bw}×${bd} m, spacing ${c.spacing} m, headroom under beams ${(zb - floorZ).toFixed(2)} m); using a flat ceiling`);
      mb.flat(cm, poly, o.ceilingZ, true, o.ceilingHoles);
      layout.fallback = "coffered";
    } else {
      layout.type = "coffered";
      layout.soffit = { outer: clear, inner, height: toH(zb), width: bw, material: bm };
      mb.flat(cm, poly, o.ceilingZ, true, o.ceilingHoles);
      // perimeter beam
      mb.flat(bm, poly, zb, true, [inner]);
      innerWalls(mb, bm, inner, zb, o.ceilingZ);
      corniceZ = zb;
      const F = outlineFrame(inner);
      const at = (x: number, y: number): Vec2 => v2.add(v2.scale(F.ex, x), v2.scale(F.ey, y));
      const xl = gridLines(F.x0, F.x1, c.spacing), yl = gridLines(F.y0, F.y1, c.spacing);
      // beams along x (continuous), beams along y split where they cross the x beams
      for (const y of yl) {
        const p0 = at(F.x0 - 1, y);
        for (const [t0, t1] of clipToPolygon(p0, F.ex, F.x1 - F.x0 + 2, inner)) addBeam(bm, v2.add(p0, v2.scale(F.ex, t0)), v2.add(p0, v2.scale(F.ex, t1)), bw, zb);
      }
      for (const x of xl) {
        const p0 = at(x, F.y0 - 1);
        const cuts = yl.map((y) => [y - F.y0 + 1 - bw / 2, y - F.y0 + 1 + bw / 2] as [number, number]);
        for (const [t0, t1] of clipToPolygon(p0, F.ey, F.y1 - F.y0 + 2, inner))
          for (const [a, b] of subtract(t0, t1, cuts)) addBeam(bm, v2.add(p0, v2.scale(F.ey, a)), v2.add(p0, v2.scale(F.ey, b)), bw, zb);
      }
    }
  } else if (c.type === "beams") {
    const bw = c.beamWidth ?? 0.14, bd = c.beamDepth ?? 0.2;
    const bm = c.beamMaterial ?? "wood_oak";
    const zb = o.ceilingZ - bd;
    layout.type = "beams";
    mb.flat(cm, poly, o.ceilingZ, true, o.ceilingHoles);
    if (zb - floorZ < 2.0) warn(`${label}: beams hang down to ${(zb - floorZ).toFixed(2)} m above the floor (< 2.0 m headroom)`);
    const F = outlineFrame(clear);
    const spanX = F.x1 - F.x0, spanY = F.y1 - F.y0;
    // beams run along `dir`; "auto" spans the shorter side
    const alongX = c.direction === "x" ? true : c.direction === "y" ? false : spanY > spanX ? true : false;
    const run = alongX ? F.ex : F.ey, across = alongX ? F.ey : F.ex;
    const [a0, a1] = alongX ? [F.y0, F.y1] : [F.x0, F.x1];
    const [r0, r1] = alongX ? [F.x0, F.x1] : [F.y0, F.y1];
    for (const pos of gridLines(a0, a1, c.spacing)) {
      const p0 = v2.add(v2.scale(across, pos), v2.scale(run, r0 - 1));
      for (const [t0, t1] of clipToPolygon(p0, run, r1 - r0 + 2, clear))
        addBeam(bm, v2.add(p0, v2.scale(run, t0)), v2.add(p0, v2.scale(run, t1)), bw, zb);
    }
  } else {
    mb.flat(cm, poly, o.ceilingZ, true, o.ceilingHoles);
  }
  if (fin.cornice) runCornice(mb, plan, ri, fin, corniceZ);
  return layout;
}

function runCornice(mb: MeshBuilder, plan: FinishPlan, ri: number, fin: Finishes, z: number) {
  const k = fin.cornice!;
  runTrim(mb, plan, ri, k.material, corniceProfile(k.profile, k.height, k.depth), z + 0.002);
}

