import { deg2rad, m4, pointSegment, v2, type Vec2, type Vec3 } from "../geometry/math.js";
import { MeshBuilder } from "../geometry/mesh.js";
import type { SceneNode } from "../geometry/scene.js";
import type { Opening, Project } from "../schema/schema.js";
import { buildTreatment } from "./treatments.js";
import { clearRange, segDir, segLength, type WallSegment } from "./walls.js";

export interface PlacedOpening {
  op: Opening;
  id: string;
  seg: WallSegment;
  /** Center position along the segment. */
  u: number;
  width: number;
  height: number;
  /** Absolute z of the bottom of the opening. */
  z0: number;
  style: string;
}

export function openingDefaults(op: Opening) {
  const style = op.style ?? (op.type === "window" ? "casement" : "single");
  const width =
    op.width ?? (op.type === "window" ? 1.2 : op.type === "door" ? (style === "double" ? 1.6 : style === "garage" ? 2.6 : style === "sliding" ? 1.8 : 0.9) : 1.0);
  const height = op.height ?? (op.type === "window" ? 1.2 : style === "garage" ? 2.2 : 2.1);
  const sill = op.sill ?? (op.type === "window" ? 0.9 : 0);
  return { style, width, height, sill };
}

/** Find the wall segment an opening belongs to and its position along it. */
export function placeOpening(
  op: Opening,
  index: number,
  segs: WallSegment[],
  levelElevation: number,
  errors: string[],
  warnings: string[],
): PlacedOpening | null {
  const id = op.id ?? `${op.type}${index}`;
  const where = `opening '${id}'`;
  const { style, width, height, sill } = openingDefaults(op);
  let candidates = segs;
  if (op.wall) {
    candidates = segs.filter((s) => s.wallId === op.wall);
    if (!candidates.length) {
      const ids = [...new Set(segs.map((s) => s.wallId))].join(", ");
      errors.push(`${where}: wall '${op.wall}' not found on this level (walls: ${ids || "none"})`);
      return null;
    }
  }
  let seg: WallSegment | undefined;
  let u = 0;
  if (op.at) {
    let best = Infinity;
    for (const s of candidates) {
      const r = pointSegment(op.at as Vec2, s.a, s.b);
      if (r.dist < best) {
        best = r.dist;
        seg = s;
        u = r.t * segLength(s);
      }
    }
    if (!seg || best > Math.max(seg.thickness / 2 + 0.15, 0.35)) {
      errors.push(
        `${where}: point [${op.at}] is ${best.toFixed(2)} m from the nearest wall${op.wall ? ` '${op.wall}'` : ""}; put \`at\` on a wall centerline`,
      );
      return null;
    }
  } else if (op.offset !== undefined) {
    if (!op.wall) {
      errors.push(`${where}: \`offset\` needs \`wall\``);
      return null;
    }
    seg = candidates.find((s) => op.offset! >= s.dist0 - 1e-6 && op.offset! <= s.dist0 + segLength(s) + 1e-6);
    if (!seg) {
      const total = Math.max(...candidates.map((s) => s.dist0 + segLength(s)));
      errors.push(`${where}: offset ${op.offset} is beyond the end of wall '${op.wall}' (length ${total.toFixed(2)})`);
      return null;
    }
    u = op.offset - seg.dist0;
  } else {
    errors.push(`${where}: give either \`at\` (a point on the wall) or \`wall\` + \`offset\``);
    return null;
  }

  // keep the opening inside the straight part of the wall
  const [lo, hi] = clearRange(seg);
  const margin = 0.05;
  if (width > hi - lo - 2 * margin) {
    errors.push(`${where}: width ${width} does not fit in wall segment of clear length ${(hi - lo).toFixed(2)}`);
    return null;
  }
  const clamped = Math.min(Math.max(u, lo + margin + width / 2), hi - margin - width / 2);
  if (Math.abs(clamped - u) > 0.01)
    warnings.push(`${where}: moved ${Math.abs(clamped - u).toFixed(2)} m along the wall so it doesn't overlap a corner/junction`);
  u = clamped;
  const z0 = levelElevation + sill;
  if (z0 + height > seg.z1 + 1e-6) warnings.push(`${where}: top (${(sill + height).toFixed(2)} m) is above the wall top; clipped`);
  return { op, id, seg, u, width, height, z0, style };
}

/** Warn about openings that overlap each other on the same wall. */
export function checkOverlaps(placed: PlacedOpening[], warnings: string[]) {
  for (let i = 0; i < placed.length; i++)
    for (let j = i + 1; j < placed.length; j++) {
      const A = placed[i], B = placed[j];
      if (A.seg !== B.seg) continue;
      const overlapU = Math.min(A.u + A.width / 2, B.u + B.width / 2) - Math.max(A.u - A.width / 2, B.u - B.width / 2);
      const overlapZ = Math.min(A.z0 + A.height, B.z0 + B.height) - Math.max(A.z0, B.z0);
      if (overlapU > 0 && overlapZ > 0) warnings.push(`openings '${A.id}' and '${B.id}' overlap on wall '${A.seg.wallId}'`);
    }
}

const HANDLE = "metal_steel";
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Build the frame, glass and door leaves for an opening. Returns a node whose
 * frame meshes are in world space; door leaves are child nodes pivoting at their hinge.
 */
export function buildOpening(p: PlacedOpening, project: Project, ctx: { ceilingZ?: number } = {}): SceneNode {
  const { op, seg, width: w, height: h, style } = p;
  const D = project.defaults;
  const d = segDir(seg);
  const N = v2.perp(d);
  const t = seg.thickness;
  const center = v2.add(seg.a, v2.scale(d, p.u));
  const top = Math.min(p.z0 + h, seg.z1);
  const hh = top - p.z0;
  const wallAngle = Math.atan2(d[1], d[0]);
  // local frame: x along wall, y toward the wall's left side, z up from the bottom of the opening
  const frame = m4.fromBasis([d[0], d[1], 0], [N[0], N[1], 0], [0, 0, 1], [center[0], center[1], p.z0]);
  const node: SceneNode = {
    name: p.id,
    kind: "opening",
    meshes: [],
    children: [],
    extras: { id: p.id, type: op.type, style, wall: seg.wallId, width: r3(w), height: r3(hh) },
  };
  if (op.type === "opening") return node;

  const mb = new MeshBuilder();
  const isDoor = op.type === "door";
  const frameMat = op.frameMaterial ?? (isDoor ? D.doorFrameMaterial : D.windowFrameMaterial);
  const glass = op.glassMaterial ?? "glass";
  const fw = 0.06; // frame member width
  const ext = seg.interiorSide === "left" ? -1 : 1; // sign of y toward the exterior

  mb.with(frame, () => {
    if (isDoor) {
      // casing-style frame covering the reveals, protruding 1 cm on both faces
      const fd = t / 2 + 0.01;
      mb.box(frameMat, [-w / 2, -fd, 0], [-w / 2 + fw, fd, hh], { skip: ["-x", "-z"] });
      mb.box(frameMat, [w / 2 - fw, -fd, 0], [w / 2, fd, hh], { skip: ["+x", "-z"] });
      mb.box(frameMat, [-w / 2 + fw, -fd, hh - fw], [w / 2 - fw, fd, hh], { skip: ["+z", "-x", "+x"] });
    } else {
      // window: slimmer frame centered in the wall, sill board outside
      const fd = Math.min(0.08, t / 2);
      mb.box(frameMat, [-w / 2, -fd, 0], [-w / 2 + fw, fd, hh], { skip: ["-x"] });
      mb.box(frameMat, [w / 2 - fw, -fd, 0], [w / 2, fd, hh], { skip: ["+x"] });
      mb.box(frameMat, [-w / 2 + fw, -fd, hh - fw], [w / 2 - fw, fd, hh], { skip: ["+z"] });
      mb.box(frameMat, [-w / 2 + fw, -fd, 0], [w / 2 - fw, fd, fw], { skip: ["-z"] });
      if (p.z0 > seg.z0 + 0.05) {
        const y0 = ext > 0 ? fd : -t / 2 - 0.06, y1 = ext > 0 ? t / 2 + 0.06 : -fd;
        mb.box("stone_gray", [-w / 2 - 0.04, y0, -0.04], [w / 2 + 0.04, y1, 0.005]);
      }
      buildWindowSashes(mb, style, w - 2 * fw, hh - 2 * fw, fw, frameMat, glass);
    }
  });
  node.meshes = mb.meshes();
  if (op.treatment) {
    // curtains / blinds on the room side; fabric sheets come back as world-space meshes
    const tb = new MeshBuilder();
    const ceilZ = (ctx.ceilingZ ?? seg.z1) - p.z0;
    const sheets = tb.with(frame, () =>
      buildTreatment(op.treatment!, { w, h: hh, t, ins: seg.interiorSide === "left" ? 1 : -1, floorZ: seg.z0 + 0.01 - p.z0, ceilZ, frame }, tb),
    );
    node.children.push({ name: `${p.id}_treatment`, kind: "window_treatment", meshes: [...tb.meshes(), ...sheets], children: [], extras: { type: op.treatment.type, open: op.treatment.open } });
  }

  if (isDoor) {
    const cw = w - 2 * fw, ch = hh - fw - 0.01;
    const panel = op.panelMaterial ?? D.doorMaterial;
    // which side the door swings toward: "in" = interior side
    const towardLeft = (op.swing === "in") === (seg.interiorSide === "left");
    const open = deg2rad(op.openAngle);
    const leaf = (name: string, hingeU: number, leafW: number, dirSign: 1 | -1, kind: "hinged" | "slide" | "lift", yOff = 0) => {
      const lb = new MeshBuilder();
      if (kind === "lift") buildGarageDoor(lb, leafW, ch, panel);
      else if (style === "glass" || style === "sliding") buildGlassLeaf(lb, leafW, ch, dirSign, frameMat, glass);
      else buildDoorLeaf(lb, leafW, ch, dirSign, panel);
      const hingeWorld = v2.add(center, v2.add(v2.scale(d, hingeU), v2.scale(N, yOff)));
      let rot = wallAngle;
      if (kind === "hinged") rot += (dirSign > 0) === towardLeft ? open : -open;
      return {
        name: `${p.id}_${name}`,
        kind: "door_leaf",
        meshes: lb.meshes(),
        children: [],
        translation: [hingeWorld[0], hingeWorld[1], p.z0 + 0.01] as Vec3,
        rotationZ: rot,
        extras: { opening: p.id, motion: kind, hingeAxis: "z", maxAngle: 100 },
      } satisfies SceneNode;
    };
    if (style === "double") {
      node.children.push(leaf("leaf_left", -cw / 2, cw / 2, 1, "hinged"));
      node.children.push(leaf("leaf_right", cw / 2, cw / 2, -1, "hinged"));
    } else if (style === "sliding") {
      node.children.push(leaf("panel_fixed", -cw / 2, cw / 2 + 0.03, 1, "slide", -0.03));
      node.children.push(leaf("panel_slide", cw / 2, cw / 2 + 0.03, -1, "slide", 0.03));
    } else if (style === "garage") {
      node.children.push(leaf("panel", -cw / 2, cw, 1, "lift"));
    } else if (op.hinge === "right") node.children.push(leaf("leaf", cw / 2, cw, -1, "hinged"));
    else node.children.push(leaf("leaf", -cw / 2, cw, 1, "hinged"));
  }
  return node;
}

/** Solid door leaf in hinge space: extends along +x (dir=1) or -x (dir=-1) from the hinge. */
function buildDoorLeaf(mb: MeshBuilder, lw: number, lh: number, dir: 1 | -1, mat: string) {
  const x0 = dir > 0 ? 0 : -lw, x1 = dir > 0 ? lw : 0;
  const th = 0.02;
  mb.box(mat, [x0, -th, 0], [x1, th, lh]);
  // raised panels on both faces
  const inset = 0.12;
  const panels: [number, number][] = [
    [0.15, lh * 0.45],
    [lh * 0.52, lh - 0.15],
  ];
  for (const [z0, z1] of panels)
    for (const s of [-1, 1]) {
      const y0 = s > 0 ? th : -th - 0.006, y1 = s > 0 ? th + 0.006 : -th;
      mb.box(mat, [x0 + inset, y0, z0], [x1 - inset, y1, z1], { skip: [s > 0 ? "-y" : "+y"] });
    }
  // lever handles on both sides
  const hx = dir > 0 ? lw - 0.08 : -lw + 0.08;
  const lever = dir > 0 ? -0.11 : 0.11;
  for (const s of [-1, 1]) {
    const y = s * (th + 0.05);
    mb.rod(HANDLE, [hx, s * th, 1.0], [hx, y, 1.0], 0.009, 8);
    mb.rod(HANDLE, [hx, y, 1.0], [hx + lever, y, 1.0], 0.009, 8);
  }
}

function buildGlassLeaf(mb: MeshBuilder, lw: number, lh: number, dir: 1 | -1, frameMat: string, glass: string) {
  const x0 = dir > 0 ? 0 : -lw, x1 = dir > 0 ? lw : 0;
  const s = 0.06, th = 0.025;
  mb.box(frameMat, [x0, -th, 0], [x0 + s, th, lh]);
  mb.box(frameMat, [x1 - s, -th, 0], [x1, th, lh]);
  mb.box(frameMat, [x0 + s, -th, 0], [x1 - s, th, 0.12]);
  mb.box(frameMat, [x0 + s, -th, lh - s], [x1 - s, th, lh]);
  mb.quad(glass, [x0 + s, 0, 0.12], [x1 - s, 0, 0.12], [x1 - s, 0, lh - s], [x0 + s, 0, lh - s]);
  const hx = dir > 0 ? lw - 0.1 : -lw + 0.1;
  for (const sy of [-1, 1]) mb.box(HANDLE, [hx - 0.01, sy > 0 ? th : -th - 0.03, 0.8], [hx + 0.01, sy > 0 ? th + 0.03 : -th, 1.2]);
}

function buildGarageDoor(mb: MeshBuilder, lw: number, lh: number, mat: string) {
  const sections = 4;
  const gap = 0.012;
  const sh = (lh - gap * (sections - 1)) / sections;
  for (let i = 0; i < sections; i++) {
    const z0 = i * (sh + gap);
    mb.box(mat, [0, -0.025, z0], [lw, 0.025, z0 + sh]);
  }
  mb.box(mat, [0.001, -0.015, 0], [lw - 0.001, 0.015, lh], { skip: ["-z", "+z"] }); // fills the grooves, recessed
}

/** Window sashes inside the frame opening (local frame: x along wall, z from opening bottom). */
function buildWindowSashes(mb: MeshBuilder, style: string, iw: number, ih: number, fw: number, mat: string, glass: string) {
  const x0 = -iw / 2, z0 = fw;
  const sash = 0.045, sd = 0.03;
  const pane = (xa: number, xb: number, za: number, zb: number) =>
    mb.quad(glass, [xa, 0, za], [xb, 0, za], [xb, 0, zb], [xa, 0, zb]);
  const sashFrame = (xa: number, xb: number, za: number, zb: number) => {
    mb.box(mat, [xa, -sd, za], [xa + sash, sd, zb]);
    mb.box(mat, [xb - sash, -sd, za], [xb, sd, zb]);
    mb.box(mat, [xa + sash, -sd, za], [xb - sash, sd, za + sash]);
    mb.box(mat, [xa + sash, -sd, zb - sash], [xb - sash, sd, zb]);
  };
  if (style === "fixed") {
    pane(x0, x0 + iw, z0, z0 + ih);
    return;
  }
  if (style === "grid") {
    pane(x0, x0 + iw, z0, z0 + ih);
    const cols = Math.max(1, Math.round(iw / 0.4)), rows = Math.max(1, Math.round(ih / 0.4));
    const bar = 0.025;
    for (let c = 1; c < cols; c++) {
      const x = x0 + (iw * c) / cols;
      mb.box(mat, [x - bar / 2, -0.012, z0], [x + bar / 2, 0.012, z0 + ih]);
    }
    for (let r = 1; r < rows; r++) {
      const z = z0 + (ih * r) / rows;
      mb.box(mat, [x0, -0.012, z - bar / 2], [x0 + iw, 0.012, z + bar / 2]);
    }
    return;
  }
  // casement: one or two sashes, plus a transom when tall
  const n = iw > 1.0 ? 2 : 1;
  const transom = ih > 1.8 ? 0.45 : 0;
  const zTop = z0 + ih - transom;
  for (let i = 0; i < n; i++) {
    const xa = x0 + (iw * i) / n, xb = x0 + (iw * (i + 1)) / n;
    sashFrame(xa, xb, z0, zTop);
    pane(xa + sash, xb - sash, z0 + sash, zTop - sash);
  }
  if (transom) {
    mb.box(mat, [x0, -sd, zTop], [x0 + iw, sd, zTop + 0.04]);
    pane(x0, x0 + iw, zTop + 0.04, z0 + ih);
  }
}
