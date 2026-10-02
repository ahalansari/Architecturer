import { deg2rad, m4, v2, type Mat4, type Vec2, type Vec3 } from "../geometry/math.js";
import type { MeshBuilder } from "../geometry/mesh.js";
import { directionToDegrees, type Stair } from "../schema/schema.js";

export interface StairFlight {
  /** World center of the first step's front edge. */
  start: Vec2;
  /** Walking direction and its right-hand side (world, unit). */
  dir: Vec2;
  right: Vec2;
  run: number;
  width: number;
  rise: number;
  /** Railing sides: -1 = left, 1 = right (relative to walking up). */
  rails: number[];
}

export interface StairResult {
  /** World-space outlines to cut out of the slab above. */
  footprints: Vec2[][];
  /** Convex world-space outlines of each flight / landing (for clash checks). */
  solids: Vec2[][];
  flights: StairFlight[];
  /** Where you stand before climbing, and where you step off at the top (world). */
  approach: Vec2;
  arrival: Vec2;
  /** Height the stair reaches (absolute z). */
  topZ: number;
  steps: number;
}

const TREAD_T = 0.03;

/**
 * One straight flight in local coords: climbs along +y from y=0, centered on x=0.
 * `n` risers over (n-1) treads; the last riser lands on the floor/landing above.
 */
function flight(
  mb: MeshBuilder,
  n: number,
  r: number,
  t: number,
  w: number,
  mat: string,
  treadMat: string | undefined,
) {
  const run = (n - 1) * t;
  const waist = r + 0.15;
  // sawtooth side profile in (y, z)
  const prof: Vec2[] = [[0, 0]];
  for (let i = 0; i < n; i++) {
    prof.push([i * t, (i + 1) * r]);
    if (i < n - 1) prof.push([(i + 1) * t, (i + 1) * r]);
  }
  prof.push([run, n * r - waist]);
  const x0 = Math.max(0, Math.min(run * 0.9, t * (waist / r - 1)));
  prof.push([x0, 0]);
  // profile x -> local +y (run), profile y -> +z, extrusion -> +x (width)
  mb.with(m4.fromBasis([0, 1, 0], [0, 0, 1], [1, 0, 0], [0, 0, 0]), () => mb.prism(mat, prof, -w / 2, w / 2));
  if (treadMat)
    for (let i = 0; i < n - 1; i++) {
      const z = (i + 1) * r;
      mb.box(treadMat, [-w / 2 - 0.005, i * t - 0.025, z], [w / 2 + 0.005, (i + 1) * t, z + TREAD_T]);
    }
  return run;
}

/** Handrail with posts along a flight side (local coords of `flight`). */
function flightRail(mb: MeshBuilder, n: number, r: number, t: number, x: number, mat: string) {
  const H = 0.9;
  const run = (n - 1) * t;
  const nose = (i: number): Vec3 => [x, i * t, (i + 1) * r + TREAD_T];
  const every = 2;
  for (let i = 0; i < n - 1; i += every) {
    const p = nose(i);
    mb.rod(mat, [p[0], p[1] + t / 2, p[2]], [p[0], p[1] + t / 2, p[2] + H + (t / 2) * (r / t)], 0.012, 6);
  }
  const a = nose(0), b: Vec3 = [x, run, n * r + TREAD_T];
  mb.rod(mat, [a[0], a[1], a[2] + H], [b[0], b[1], b[2] + H], 0.022, 8);
  mb.rod(mat, [x, run, b[2]], [x, run, b[2] + H], 0.015, 6);
}

function landing(mb: MeshBuilder, x0: number, y0: number, x1: number, y1: number, z: number, mat: string, treadMat?: string) {
  mb.box(mat, [x0, y0, z - 0.2], [x1, y1, z]);
  if (treadMat) mb.box(treadMat, [x0 - 0.005, y0, z], [x1 + 0.005, y1, z + TREAD_T]);
}

/** Smooth ramp standing in for a flight in collision meshes (character controllers glide up it). */
function rampFlight(col: MeshBuilder, n: number, r: number, t: number, w: number, railX: number[]) {
  const run = (n - 1) * t;
  const top = n * r;
  const waist = r + 0.15;
  const x0 = Math.max(0, Math.min(run * 0.9, t * (waist / r - 1)));
  const sideways = m4.fromBasis([0, 1, 0], [0, 0, 1], [1, 0, 0], [0, 0, 0]);
  col.with(sideways, () => {
    col.prism(COLLIDER, [[0, 0], [run, top], [run, top - waist], [x0, 0]], -w / 2, w / 2);
    // railings become thin sloped walls so nobody falls off the open side
    for (const x of railX) col.prism(COLLIDER, [[0, r], [run, top], [run, top + 1.0], [0, r + 1.0]], x - 0.03, x + 0.03);
  });
}

/** Material name for collision-only geometry (exported without a render material). */
export const COLLIDER = "__collider__";

type Part =
  | { kind: "flight"; m: Mat4; n: number }
  | { kind: "landing"; x0: number; y0: number; x1: number; y1: number; z: number };

export function buildStair(mb: MeshBuilder, s: Stair, levelZ: number, levelHeight: number, col?: MeshBuilder): StairResult {
  const rise = s.rise ?? levelHeight;
  const n = Math.max(2, Math.round(rise / s.riser));
  const r = rise / n;
  const t = s.tread;
  const w = s.width;
  const ang = deg2rad(directionToDegrees(s.direction));
  const dir: Vec2 = [Math.cos(ang), Math.sin(ang)];
  const right: Vec2 = [dir[1], -dir[0]];
  const treadMat = s.treadMaterial ?? "wood_oak";
  const toWorld = (p: Vec2): Vec2 => v2.add(s.start as Vec2, v2.add(v2.scale(right, p[0]), v2.scale(dir, p[1])));
  // local frame: x = right of walking direction, y = walking direction
  const local = m4.fromBasis([right[0], right[1], 0], [dir[0], dir[1], 0], [0, 0, 1], [s.start[0], s.start[1], levelZ]);
  const railSides = (s.railing === "both" ? [-1, 1] : s.railing === "left" ? [-1] : s.railing === "right" ? [1] : []) as number[];
  const railX = railSides.map((side) => side * (w / 2 - 0.04));
  const footprints: Vec2[][] = [];

  if (s.type === "spiral") {
    mb.with(local, () => buildSpiral(mb, n, r, t, w, ang, s.turn === "left" ? 1 : -1, s, treadMat));
    // steps double as collision: wedge treads are already simple
    if (col) col.with(local, () => buildSpiral(col, n, r, t, w, ang, s.turn === "left" ? 1 : -1, { ...s, railingMaterial: COLLIDER }, COLLIDER));
    const R = w + 0.05;
    const circle: Vec2[] = [];
    for (let i = 0; i < 24; i++) circle.push(v2.add(s.start as Vec2, [Math.cos((i / 24) * 2 * Math.PI) * R, Math.sin((i / 24) * 2 * Math.PI) * R]));
    footprints.push(circle);
    const sense = s.turn === "left" ? 1 : -1;
    const dTheta = Math.min(t / (w * 0.6), (2 * Math.PI) / 12) * sense;
    const at = (a: number): Vec2 => v2.add(s.start as Vec2, [Math.cos(a) * w * 0.6, Math.sin(a) * w * 0.6]);
    return {
      footprints,
      solids: [circle],
      flights: [],
      approach: at(ang - 0.35 * sense),
      arrival: at(ang + n * dTheta + 0.35 * sense),
      topZ: levelZ + rise,
      steps: n,
    };
  }

  // lay the stair out as flights (each in its own frame) and landings, in stair-local coords
  const parts: Part[] = [];
  const I = m4.identity();
  if (s.type === "straight") {
    parts.push({ kind: "flight", m: I, n });
    const run = (n - 1) * t;
    footprints.push(([[-w / 2, 0], [w / 2, 0], [w / 2, run], [-w / 2, run]] as Vec2[]).map(toWorld));
  } else {
    const n1 = Math.min(n - 2, Math.max(2, s.split ?? Math.floor(n / 2)));
    const n2 = n - n1;
    const turn = s.turn === "left" ? -1 : 1; // sign of local x toward the turn
    const run1 = (n1 - 1) * t;
    const run2 = (n2 - 1) * t;
    parts.push({ kind: "flight", m: I, n: n1 });
    if (s.type === "L") {
      parts.push({ kind: "landing", x0: -w / 2, y0: run1, x1: w / 2, y1: run1 + w, z: n1 * r });
      // second flight heads toward the turn side from the landing's side edge; its right-hand side = (0, -turn)
      parts.push({ kind: "flight", m: m4.fromBasis([0, -turn, 0], [turn, 0, 0], [0, 0, 1], [turn * (w / 2), run1 + w / 2, n1 * r]), n: n2 });
      const ex = turn * (w / 2 + run2);
      footprints.push(
        ([[-turn * (w / 2), 0], [turn * (w / 2), 0], [turn * (w / 2), run1], [ex, run1], [ex, run1 + w], [-turn * (w / 2), run1 + w]] as Vec2[]).map(toWorld),
      );
    } else {
      // U: landing spans both flights, second flight comes back parallel
      const off = turn * (w + s.gap);
      const xa = Math.min(-w / 2, off - w / 2), xb = Math.max(w / 2, off + w / 2);
      parts.push({ kind: "landing", x0: xa, y0: run1, x1: xb, y1: run1 + w, z: n1 * r });
      parts.push({ kind: "flight", m: m4.fromBasis([-1, 0, 0], [0, -1, 0], [0, 0, 1], [off, run1, n1 * r]), n: n2 });
      const y0 = Math.min(0, run1 - run2);
      footprints.push(([[xa, y0], [xb, y0], [xb, run1 + w], [xa, run1 + w]] as Vec2[]).map(toWorld));
    }
  }

  mb.with(local, () => {
    for (const p of parts) {
      if (p.kind === "landing") landing(mb, p.x0, p.y0, p.x1, p.y1, p.z, s.material, treadMat);
      else
        mb.with(p.m, () => {
          flight(mb, p.n, r, t, w, s.material, treadMat);
          for (const x of railX) flightRail(mb, p.n, r, t, x, s.railingMaterial);
        });
    }
  });
  // world-space summaries for validation
  const toStair = (m: Mat4, p: Vec2): Vec2 => {
    const q = m4.point(m, [p[0], p[1], 0]);
    return toWorld([q[0], q[1]]);
  };
  const solids: Vec2[][] = [];
  const flights: StairFlight[] = [];
  let arrival: Vec2 = toWorld([0, 0]);
  for (const p of parts) {
    if (p.kind === "landing") {
      solids.push(([[p.x0, p.y0], [p.x1, p.y0], [p.x1, p.y1], [p.x0, p.y1]] as Vec2[]).map(toWorld));
      continue;
    }
    const run = (p.n - 1) * t;
    solids.push(([[-w / 2, 0], [w / 2, 0], [w / 2, run], [-w / 2, run]] as Vec2[]).map((q) => toStair(p.m, q)));
    const a = toStair(p.m, [0, 0]);
    const fwd = v2.norm(v2.sub(toStair(p.m, [0, 1]), a));
    flights.push({ start: a, dir: fwd, right: [fwd[1], -fwd[0]], run, width: w, rise: p.n * r, rails: railSides });
    arrival = toStair(p.m, [0, run + 0.45]);
  }
  const approach = toWorld([0, -0.45]);

  if (col)
    col.with(local, () => {
      for (const p of parts) {
        if (p.kind === "landing") col.box(COLLIDER, [p.x0, p.y0, p.z - 0.2], [p.x1, p.y1, p.z]);
        else col.with(p.m, () => rampFlight(col, p.n, r, t, w, railX));
      }
    });
  return { footprints, solids, flights, approach, arrival, topZ: levelZ + rise, steps: n };
}

function buildSpiral(
  mb: MeshBuilder,
  n: number,
  r: number,
  t: number,
  R: number,
  startAng: number,
  sense: 1 | -1,
  s: Stair,
  treadMat: string,
) {
  // undo the local frame rotation: build around the center in a frame aligned with world axes
  mb.with(m4.rotationZ(-(startAng - Math.PI / 2)), () => {
    const pole = 0.08;
    const walk = R * 0.6;
    const dTheta = Math.min(t / walk, (2 * Math.PI) / 12) * sense;
    mb.cylinder(s.railingMaterial, [0, 0, 0], pole, pole, n * r + 1.0, 16);
    const railPts: Vec3[] = [];
    for (let i = 0; i < n - 1; i++) {
      const a0 = startAng + i * dTheta, a1 = startAng + (i + 1) * dTheta + 0.02 * sense;
      const z = (i + 1) * r;
      const arc: Vec2[] = [];
      const segs = 4;
      for (let k = 0; k <= segs; k++) {
        const a = a0 + ((a1 - a0) * k) / segs;
        arc.push([Math.cos(a) * R, Math.sin(a) * R]);
      }
      const wedge: Vec2[] = [[0, 0], ...arc];
      mb.prism(treadMat, wedge, z - 0.05, z);
      const am = (a0 + a1) / 2;
      railPts.push([Math.cos(am) * (R - 0.04), Math.sin(am) * (R - 0.04), z + 0.9]);
      mb.rod(s.railingMaterial, [Math.cos(am) * (R - 0.04), Math.sin(am) * (R - 0.04), z], railPts[railPts.length - 1], 0.012, 6);
    }
    for (let i = 0; i < railPts.length - 1; i++) mb.rod(s.railingMaterial, railPts[i], railPts[i + 1], 0.02, 8);
  });
}
