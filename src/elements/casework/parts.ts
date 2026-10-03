/**
 * Casework building blocks in the LEG/LEAF frame: x = left->right facing the fronts, y = toward the wall,
 * z = up. Fronts (doors, drawer fronts) are built with their FRONT face at y = 0 and back at y = FT;
 * handles project toward -y.
 */
import { m4, type Vec2, type Vec3 } from "../../geometry/math.js";
import type { MeshBuilder } from "../../geometry/mesh.js";

/** Front (door / drawer) thickness. */
export const FT = 0.019;
/** Carcass panel thickness. */
export const CT = 0.018;
/** Half of the reveal between neighbouring fronts. */
export const G = 0.0015;
/** End panel thickness. */
export const EP = 0.02;

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashStr(s: string): number {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

/** CCW rounded rectangle (x/y plane). */
export function roundRect(cx: number, cy: number, w: number, d: number, r: number, seg = 3): Vec2[] {
  r = clamp(r, 0.0005, Math.min(w, d) / 2 - 0.0005);
  const hx = w / 2 - r, hy = d / 2 - r;
  const corners: [number, number, number][] = [[hx, -hy, -90], [hx, hy, 0], [-hx, hy, 90], [-hx, -hy, 180]];
  const pts: Vec2[] = [];
  for (const [ox, oy, a0] of corners)
    for (let i = 0; i <= seg; i++) {
      const a = ((a0 + (90 * i) / seg) * Math.PI) / 180;
      pts.push([cx + ox + Math.cos(a) * r, cy + oy + Math.sin(a) * r]);
    }
  return pts;
}

export function ellipse(cx: number, cy: number, rx: number, ry: number, seg: number): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    pts.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return pts;
}

const ccw = (p: Vec2[]) => {
  let a = 0;
  for (let i = 0; i < p.length; i++) a += p[i][0] * p[(i + 1) % p.length][1] - p[(i + 1) % p.length][0] * p[i][1];
  return a > 0 ? p : [...p].reverse();
};

/** Side walls between two matching loops (outward for CCW loops, inward when `inward`). */
export function loft(mb: MeshBuilder, mat: string, lo: Vec2[], zlo: number, hi: Vec2[], zhi: number, inward = false) {
  const n = lo.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a: Vec3 = [lo[i][0], lo[i][1], zlo], b: Vec3 = [lo[j][0], lo[j][1], zlo];
    const c: Vec3 = [hi[j][0], hi[j][1], zhi], d: Vec3 = [hi[i][0], hi[i][1], zhi];
    if (inward) mb.quad(mat, d, c, b, a);
    else mb.quad(mat, a, b, c, d);
  }
}

/** Horizontal slab: outline with holes, z0..z1. Hole walls face inward (skipped with `holeWalls: false`). */
export function slab(mb: MeshBuilder, mat: string, outline: Vec2[], holes: Vec2[][], z0: number, z1: number, holeWalls = true, sideMat = mat) {
  const o = ccw(outline);
  const hs = holes.map(ccw);
  mb.flat(mat, o, z1, false, hs);
  mb.flat(mat, o, z0, true, hs);
  loft(mb, sideMat, o, z0, o, z1);
  if (holeWalls) for (const h of hs) loft(mb, sideMat, h, z0, h, z1, true);
}

/** Inside faces of a box (a cavity seen from inside), leaving the `open` face out. */
export function cavity(mb: MeshBuilder, mat: string, min: Vec3, max: Vec3, open: "-y" | "+z" = "-y") {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  if (open !== "+z") mb.quad(mat, [x0, y1, z1], [x1, y1, z1], [x1, y0, z1], [x0, y0, z1]); // ceiling, facing down
  mb.quad(mat, [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]); // floor, up
  if (open !== "-y") mb.quad(mat, [x1, y0, z0], [x0, y0, z0], [x0, y0, z1], [x1, y0, z1]); // front wall facing +y
  mb.quad(mat, [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]); // back wall facing -y
  mb.quad(mat, [x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]); // left wall facing +x
  mb.quad(mat, [x1, y1, z0], [x1, y0, z0], [x1, y0, z1], [x1, y1, z1]); // right wall facing -x
}

/** Prism whose profile lies in the (y, z) plane, extruded along x from x0 to x1. */
export function prismX(mb: MeshBuilder, mat: string, profileYZ: Vec2[], x0: number, x1: number) {
  mb.with(m4.fromBasis([0, 1, 0], [0, 0, 1], [1, 0, 0], [0, 0, 0]), () => mb.prism(mat, profileYZ, x0, x1));
}

/** Cylinder along +y from y0 to y1 at (x, z). */
export function cylY(mb: MeshBuilder, mat: string, x: number, y0: number, y1: number, z: number, r0: number, r1: number, seg = 10, caps = true) {
  mb.with(m4.fromBasis([0, 0, 1], [1, 0, 0], [0, 1, 0], [x, y0, z]), () => mb.cylinder(mat, [0, 0, 0], r0, r1, y1 - y0, seg, { top: caps, bottom: caps }));
}

/** Cylinder along +x from x0 to x1 at (y, z). */
export function cylX(mb: MeshBuilder, mat: string, x0: number, x1: number, y: number, z: number, r: number, seg = 8) {
  mb.with(m4.fromBasis([0, 1, 0], [0, 0, 1], [1, 0, 0], [x0, y, z]), () => mb.cylinder(mat, [0, 0, 0], r, r, x1 - x0, seg));
}

/** Upholstered cushion: chamfered profile along x. */
export function cushion(mb: MeshBuilder, mat: string, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, r = 0.02) {
  const c = Math.min(r, (y1 - y0) / 3, (z1 - z0) / 3);
  prismX(mb, mat, [[y0 + c, z0], [y1 - c, z0], [y1, z0 + c], [y1, z1 - c], [y1 - c, z1], [y0 + c, z1], [y0, z1 - c], [y0, z0 + c]], x0 + c * 0.5, x1 - c * 0.5);
  // rounded ends: shrunken caps
  const cap = (x: number, xi: number) => {
    const shrink = (p: Vec2): Vec2 => [p[0] + Math.sign((y0 + y1) / 2 - p[0]) * c * 0.4, p[1] + Math.sign((z0 + z1) / 2 - p[1]) * c * 0.4];
    const prof: Vec2[] = [[y0 + c, z0], [y1 - c, z0], [y1, z0 + c], [y1, z1 - c], [y1 - c, z1], [y0 + c, z1], [y0, z1 - c], [y0, z0 + c]];
    prismX(mb, mat, prof.map(shrink), Math.min(x, xi), Math.max(x, xi));
  };
  cap(x0, x0 + c * 0.5);
  cap(x1 - c * 0.5, x1);
}

// ---------------------------------------------------------------------------------------------
// fronts

export type FrontStyle = "slab" | "shaker" | "glass" | "fluted" | "louvered" | "mirror";

export interface FrontMats {
  front: string;
  glass: string;
  handle: string;
}

/**
 * Door / drawer front panel covering [x0,x1] x [z0,z1], front face at y = 0, back at y = FT.
 * `frameOnly` glass fronts let you see the interior.
 */
export function frontPanel(mb: MeshBuilder, style: FrontStyle, M: FrontMats, x0: number, x1: number, z0: number, z1: number) {
  const w = x1 - x0, h = z1 - z0;
  if (w < 0.004 || h < 0.004) return;
  const box = (a: number, b: number, c: number, d: number, yf = 0, mat = M.front) => mb.box(mat, [a, yf, c], [b, FT, d]);
  if (style === "slab" || w < 0.09 || h < 0.06) {
    box(x0, x1, z0, z1);
    return;
  }
  if (style === "shaker") {
    const r = clamp(Math.min(w, h) * 0.12, 0.022, 0.07);
    box(x0, x0 + r, z0, z1);
    box(x1 - r, x1, z0, z1);
    box(x0 + r, x1 - r, z1 - r, z1);
    box(x0 + r, x1 - r, z0, z0 + r);
    // recessed centre panel with a small bevel step
    box(x0 + r, x1 - r, z0 + r, z1 - r, 0.0075);
    box(x0 + r, x1 - r, z0 + r, z0 + r + 0.006, 0.004);
    return;
  }
  if (style === "fluted") {
    const back = 0.006;
    box(x0, x1, z0, z1, back);
    const pitch = 0.026;
    const n = Math.max(2, Math.floor((w - 0.01) / pitch));
    const pw = (w - 0.006) / n;
    for (let i = 0; i < n; i++) {
      const cx = x0 + 0.003 + pw * (i + 0.5);
      const prof: Vec2[] = [];
      const seg = 6;
      for (let k = 0; k <= seg; k++) {
        const a = Math.PI - (k / seg) * Math.PI;
        prof.push([cx + Math.cos(a) * (pw / 2 - 0.0008), back - Math.sin(a) * back]);
      }
      mb.prism(M.front, prof, z0 + 0.004, z1 - 0.004);
    }
    // top / bottom lips so the ribs end cleanly
    box(x0, x1, z0, z0 + 0.004);
    box(x0, x1, z1 - 0.004, z1);
    return;
  }
  // framed styles: glass, louvered, mirror
  const thin = style === "mirror";
  const r = thin ? 0.022 : clamp(Math.min(w, h) * 0.1, 0.035, 0.06);
  const fm = thin ? M.handle : M.front;
  box(x0, x0 + r, z0, z1, 0, fm);
  box(x1 - r, x1, z0, z1, 0, fm);
  box(x0 + r, x1 - r, z1 - r, z1, 0, fm);
  box(x0 + r, x1 - r, z0, z0 + r, 0, fm);
  if (style === "glass") {
    mb.box(M.glass, [x0 + r, FT * 0.45, z0 + r], [x1 - r, FT * 0.45 + 0.004, z1 - r]);
  } else if (style === "mirror") {
    mb.box("mirror", [x0 + r, 0.004, z0 + r], [x1 - r, FT, z1 - r]);
  } else {
    // louvers: slats tilted ~40°, front edge low
    const pitch = 0.038;
    const n = Math.max(1, Math.floor((h - 2 * r) / pitch));
    const sp = (h - 2 * r) / n;
    for (let i = 0; i < n; i++) {
      const zc = z0 + r + sp * (i + 0.5);
      const hw = sp * 0.62, t = 0.0045;
      prismX(mb, M.front, [[0.002, zc - hw / 2], [0.002 + t, zc - hw / 2 - 0.002], [FT - 0.002, zc + hw / 2 - t], [FT - 0.002 - t, zc + hw / 2]], x0 + r, x1 - r);
    }
    mb.box(M.front, [x0 + r, FT - 0.003, z0 + r], [x1 - r, FT, z1 - r]); // dark back board so you can't see through
  }
}

// ---------------------------------------------------------------------------------------------
// handles (front face at y = 0, project to -y)

export type HandleStyle = "bar" | "knob" | "edge" | "gola" | "push";

/** Bar / knob / edge pull. `vertical` bars run along z. (hx, hz) is the handle centre on the front face. */
export function handle(mb: MeshBuilder, style: HandleStyle, mat: string, hx: number, hz: number, len: number, vertical: boolean, edgeZ?: number, edgeTop = true) {
  if (style === "push" || style === "gola") return;
  if (style === "knob") {
    mb.with(m4.fromBasis([1, 0, 0], [0, 0, 1], [0, -1, 0], [hx, 0, hz]), () => {
      mb.cylinder(mat, [0, 0, 0], 0.006, 0.006, 0.018, 8, { top: false, bottom: false });
      mb.cylinder(mat, [0, 0, 0.018], 0.014, 0.016, 0.012, 14, { bottom: true, top: true });
    });
    return;
  }
  if (style === "edge") {
    // tab pull folded over the top (or bottom) edge of the front
    const z = edgeZ ?? hz;
    const L = Math.min(len, 0.2);
    if (edgeTop) {
      mb.box(mat, [hx - L / 2, -0.016, z], [hx + L / 2, FT * 0.7, z + 0.0018]);
      mb.box(mat, [hx - L / 2, -0.0178, z - 0.022], [hx + L / 2, -0.016, z + 0.0018]);
    } else {
      mb.box(mat, [hx - L / 2, -0.016, z - 0.0018], [hx + L / 2, FT * 0.7, z]);
      mb.box(mat, [hx - L / 2, -0.0178, z - 0.0018], [hx + L / 2, -0.016, z + 0.022]);
    }
    return;
  }
  const stand = 0.028, r = 0.0062;
  const yb = -stand;
  if (vertical) {
    for (const pz of [hz - len / 2 + 0.02, hz + len / 2 - 0.02]) cylY(mb, mat, hx, yb, 0, pz, 0.0048, 0.0048, 8, false);
    mb.cylinder(mat, [hx, yb, hz - len / 2], r, r, len, 10);
  } else {
    for (const px of [hx - len / 2 + 0.02, hx + len / 2 - 0.02]) cylY(mb, mat, px, yb, 0, hz, 0.0048, 0.0048, 8, false);
    cylX(mb, mat, hx - len / 2, hx + len / 2, yb, hz, r, 10);
  }
}

export function barLength(w: number, tall: boolean): number {
  if (tall) return 0.45;
  return w >= 0.7 ? 0.32 : w >= 0.42 ? 0.192 : 0.128;
}

// ---------------------------------------------------------------------------------------------
// carcass

export interface CarcassOpts {
  /** Front edge of the box (y, negative). */
  yF: number;
  top?: boolean;
  bottom?: boolean;
  back?: boolean;
  shelves?: number[];
  /** Skip the side panels (when an end panel replaces them). */
  skipL?: boolean;
  skipR?: boolean;
}

/** Cabinet box between x0..x1, zb..zt, from yF back to the wall (y = 0). Shelves at the given z. */
export function carcass(mb: MeshBuilder, mat: string, x0: number, x1: number, zb: number, zt: number, o: CarcassOpts) {
  const t = CT, yF = o.yF, yB = -0.004;
  if (x1 - x0 < 2 * t + 0.01 || zt - zb < 2 * t) {
    mb.box(mat, [x0, yF, zb], [x1, yB, zt]);
    return;
  }
  if (!o.skipL) mb.box(mat, [x0, yF, zb], [x0 + t, yB, zt]);
  if (!o.skipR) mb.box(mat, [x1 - t, yF, zb], [x1, yB, zt]);
  if (o.bottom !== false) mb.box(mat, [x0 + t, yF, zb], [x1 - t, yB, zb + t]);
  if (o.top !== false) mb.box(mat, [x0 + t, yF, zt - t], [x1 - t, yB, zt]);
  if (o.back !== false) mb.box(mat, [x0 + t, -0.013, zb + t], [x1 - t, -0.005, zt - t], { skip: ["+y"] });
  for (const z of o.shelves ?? []) mb.box(mat, [x0 + t, yF + 0.02, z], [x1 - t, -0.013, z + t]);
}

// ---------------------------------------------------------------------------------------------
// decor (contents that show when doors open / behind glass)

const BOOK_MATS = ["fabric_blue", "fabric_red", "fabric_beige", "fabric_green", "linen_white", "leather_brown", "fabric_gray", "leather_tan", "fabric_white"];
const CLOTH_MATS = ["fabric_white", "fabric_blue", "fabric_gray", "fabric_beige", "linen_white", "fabric_green", "leather_black", "fabric_red", "carpet_blue"];

/** Books (and the odd object) on a shelf between x0..x1 standing at z, front of the shelf at yF. */
export function books(mb: MeshBuilder, R: () => number, x0: number, x1: number, z: number, yF: number, maxH: number, fill = 0.7) {
  let x = x0 + 0.02 + R() * 0.08;
  while (x < x1 - 0.05) {
    if (R() > fill) {
      // gap or a small object (vase / box)
      const w = 0.06 + R() * 0.1;
      if (R() < 0.5 && x + w < x1 - 0.02) {
        const r = Math.min(0.045, w / 2);
        mb.cylinder(R() < 0.5 ? "ceramic_white" : "plastic_black", [x + w / 2, yF + 0.12, z], r * 0.8, r, Math.min(maxH - 0.02, 0.12 + R() * 0.1), 12);
      }
      x += w + 0.02;
      continue;
    }
    const n = 3 + Math.floor(R() * 8);
    for (let i = 0; i < n && x < x1 - 0.03; i++) {
      const t = 0.018 + R() * 0.03;
      const h = Math.min(maxH - 0.015, 0.17 + R() * 0.12);
      const d = 0.13 + R() * 0.08;
      mb.box(BOOK_MATS[Math.floor(R() * BOOK_MATS.length)], [x, yF + 0.015, z], [Math.min(x + t, x1 - 0.01), yF + 0.015 + d, z + h]);
      x += t + 0.001;
    }
    x += 0.01;
  }
}

/** Stacks of plates, bowls and glasses on a shelf. */
export function dishes(mb: MeshBuilder, R: () => number, x0: number, x1: number, z: number, yF: number, maxH: number) {
  let x = x0 + 0.04;
  let k = 0;
  while (x < x1 - 0.06) {
    const kind = k++ % 3;
    if (kind === 0) {
      const r = 0.1 + R() * 0.03;
      if (x + 2 * r > x1 - 0.01) break;
      const n = 4 + Math.floor(R() * 5);
      for (let i = 0; i < n && 0.012 * (i + 1) < maxH; i++) mb.cylinder("ceramic_white", [x + r, yF + 0.04 + r, z + i * 0.013], r * 0.75, r, 0.012, 16);
      x += 2 * r + 0.03;
    } else if (kind === 1) {
      const r = 0.065;
      if (x + 2 * r > x1 - 0.01) break;
      for (let i = 0; i < 3 && 0.05 * (i + 1) < maxH; i++) mb.cylinder("ceramic_white", [x + r, yF + 0.05 + r, z + i * 0.045], r * 0.55, r, 0.05, 14, { top: false, bottom: true });
      x += 2 * r + 0.03;
    } else {
      for (let i = 0; i < 3 && x + 0.07 < x1 - 0.01; i++) {
        mb.cylinder("glass", [x + 0.035, yF + 0.07, z], 0.03, 0.034, Math.min(maxH - 0.01, 0.12), 12, { top: false, bottom: true });
        x += 0.075;
      }
      x += 0.02;
    }
  }
}

/** Jars, tins and boxes (pantry shelves). */
export function provisions(mb: MeshBuilder, R: () => number, x0: number, x1: number, z: number, yF: number, maxH: number) {
  let x = x0 + 0.03;
  const mats = ["glass", "metal_steel", "plastic_white", "wood_oak", "fabric_beige", "car_paint_red"];
  while (x < x1 - 0.08) {
    if (R() < 0.5) {
      const r = 0.035 + R() * 0.02;
      const h = Math.min(maxH - 0.02, 0.1 + R() * 0.14);
      mb.cylinder(mats[Math.floor(R() * 3)], [x + r, yF + 0.06 + r, z], r, r, h, 12);
      mb.cylinder("wood_oak", [x + r, yF + 0.06 + r, z + h], r * 0.9, r * 0.9, 0.012, 12);
      x += 2 * r + 0.02;
    } else {
      const w = 0.07 + R() * 0.08, h = Math.min(maxH - 0.02, 0.12 + R() * 0.15);
      mb.box(mats[3 + Math.floor(R() * 3)], [x, yF + 0.05, z], [x + w, yF + 0.05 + 0.08 + R() * 0.12, z + h]);
      x += w + 0.02;
    }
  }
}

/** Hanging clothes on a rail running along x at (yRail, zRail). */
export function clothes(mb: MeshBuilder, R: () => number, x0: number, x1: number, yRail: number, zRail: number, maxLen: number, hangerMat: string) {
  let x = x0 + 0.04;
  const depth = 0.42;
  while (x < x1 - 0.04) {
    const t = 0.012 + R() * 0.022;
    const L = Math.min(maxLen, 0.65 + R() * 0.55);
    const mat = CLOTH_MATS[Math.floor(R() * CLOTH_MATS.length)];
    const hw = Math.min(depth / 2, -yRail - 0.03);
    // hanger: hook + shoulders
    mb.rod(hangerMat, [x + t / 2, yRail, zRail + 0.01], [x + t / 2, yRail, zRail - 0.05], 0.0025, 4);
    // garment: shoulders slope, body hangs straight
    const top = zRail - 0.05;
    prismX(mb, mat, [[yRail - hw, top - 0.06], [yRail - 0.04, top], [yRail + 0.04, top], [yRail + hw, top - 0.06], [yRail + hw * 0.95, top - L], [yRail - hw * 0.95, top - L]], x, x + t);
    x += t + 0.012 + R() * 0.03;
  }
}

/** Folded clothes stacks / boxes on a shelf. */
export function folded(mb: MeshBuilder, R: () => number, x0: number, x1: number, z: number, yF: number, maxH: number) {
  let x = x0 + 0.03;
  while (x < x1 - 0.2) {
    const w = 0.26 + R() * 0.08;
    if (x + w > x1 - 0.02) break;
    let zz = z;
    const n = 2 + Math.floor(R() * 5);
    for (let i = 0; i < n && zz + 0.05 < z + maxH - 0.03; i++) {
      const th = 0.035 + R() * 0.025;
      mb.box(CLOTH_MATS[Math.floor(R() * CLOTH_MATS.length)], [x + R() * 0.01, yF + 0.04, zz], [x + w - R() * 0.01, yF + 0.33, zz + th]);
      zz += th;
    }
    x += w + 0.04;
  }
}

/** Pairs of shoes on a sloped shelf (shelf runs from the front lip up to the back). */
export function shoes(mb: MeshBuilder, R: () => number, x0: number, x1: number, z: number, yF: number, mats: string[]) {
  let x = x0 + 0.03;
  while (x < x1 - 0.2) {
    const mat = mats[Math.floor(R() * mats.length)];
    for (const dx of [0, 0.095]) {
      const sx = x + dx;
      mb.box(mat, [sx, yF + 0.03, z], [sx + 0.085, yF + 0.29, z + 0.035]);
      mb.box(mat, [sx, yF + 0.2, z + 0.035], [sx + 0.085, yF + 0.29, z + 0.09]);
    }
    x += 0.22 + R() * 0.04;
  }
}

/** Wine bottles lying in a cell, neck to the front. */
export function bottle(mb: MeshBuilder, x: number, yF: number, z: number, mat: string) {
  cylY(mb, "metal_brass", x, yF + 0.01, yF + 0.03, z, 0.0125, 0.0125, 8);
  cylY(mb, mat, x, yF + 0.03, yF + 0.09, z, 0.013, 0.014, 8, false);
  cylY(mb, mat, x, yF + 0.09, yF + 0.12, z, 0.014, 0.036, 8, false);
  cylY(mb, mat, x, yF + 0.12, yF + 0.34, z, 0.036, 0.036, 8);
}
