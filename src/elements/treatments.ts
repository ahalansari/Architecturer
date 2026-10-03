/**
 * Window treatments: curtains, sheers, blinds and shutters hung on the interior side of an opening.
 *
 * Built in the opening's local frame (x along the wall, y toward the wall's left side, z up from
 * the bottom of the opening; see buildOpening) and emitted in world space.
 */
import { z } from "zod";
import { m4, v3, type Mat4, type Vec2, type Vec3 } from "../geometry/math.js";
import { MeshBuilder, type MeshData } from "../geometry/mesh.js";
import { Mat } from "../schema/common.js";

export const TREATMENT_TYPES = ["curtains", "sheers", "curtains_and_sheers", "roller_blind", "roman_blind", "venetian", "shutters"] as const;
export type TreatmentType = (typeof TREATMENT_TYPES)[number];

export const TreatmentSchema = z
  .object({
    type: z.enum(TREATMENT_TYPES).describe("curtains / sheers / curtains_and_sheers (pleated, on a rod or ceiling track) | roller_blind | roman_blind | venetian | shutters (interior louvred panels)"),
    material: Mat.optional().describe("Fabric / slat / panel material. Defaults: curtains fabric_beige, sheers sheer_white, roller fabric_white, roman linen_white, venetian plastic_white, shutters wood_painted_white"),
    sheerMaterial: Mat.optional().describe("curtains_and_sheers: the sheer layer (default sheer_white)"),
    hardwareMaterial: Mat.optional().describe("Rod, track, rails (default metal_black; blinds plastic_white)"),
    open: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("0 = closed (drawn across / lowered), 1 = open (curtains stacked at the sides, blinds raised, shutters swung open). Default: curtains 1, sheers 0 (curtains_and_sheers: curtains open, sheers closed), blinds 0.35, shutters 0"),
    mount: z
      .enum(["wall", "ceiling", "recess"])
      .optional()
      .describe("wall: rod/blind on the wall above the opening (default); ceiling: track on the ceiling (floor-to-ceiling curtains); recess: blind inside the window reveal"),
    widthOverrun: z.number().min(0).optional().describe("Extra width on EACH side beyond the opening (curtains 0.25 = room to stack; blinds 0.05)"),
    heightOverrun: z.number().min(0).optional().describe("How far above the opening the rod / blind head sits (curtains 0.15, blinds 0.08)"),
    length: z.enum(["floor", "sill"]).optional().describe("Curtains: floor-length (default) or to just below the sill"),
    side: z.enum(["both", "left", "right"]).default("both").describe("Curtains: a pair, or one panel stacking to the left/right (as seen from the room)"),
  })
  .describe("Curtains, sheers, blinds or shutters on the interior side of a window or glazed door");

export type Treatment = z.output<typeof TreatmentSchema>;

export interface TreatmentContext {
  /** opening width / height (m) */
  w: number;
  h: number;
  /** wall thickness */
  t: number;
  /** +1 if the room (interior side) is local +y, else -1 */
  ins: number;
  /** z (local, from the opening bottom) of the floor and of the ceiling */
  floorZ: number;
  ceilZ: number;
  /** local frame -> world */
  frame: Mat4;
}

/** A sheet extruded from a 2D profile with smooth normals, both sides. Returns world-space MeshData. */
function sheet(material: string, frame: Mat4, pts: Vec3[], ext: Vec3, thickness: number, uScale = 1): MeshData {
  // pts: profile polyline in local coords; ext: extrusion vector (local); thickness: offset along the profile normal
  const md: MeshData = { material, positions: [], normals: [], uvs: [], indices: [] };
  const n = pts.length;
  const extDir = v3.norm(ext);
  const extLen = v3.len(ext);
  // profile normals (perpendicular to the tangent and the extrusion axis)
  const nrm: Vec3[] = pts.map((_, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    const tng = v3.norm(v3.sub(b, a));
    return v3.norm(v3.cross(extDir, tng));
  });
  const arc: number[] = [0];
  for (let i = 1; i < n; i++) arc.push(arc[i - 1] + v3.len(v3.sub(pts[i], pts[i - 1])));
  const push = (p: Vec3, nn: Vec3, u: number, v: number) => {
    const wp = m4.point(frame, p), wn = m4.normal(frame, nn);
    md.positions.push(wp[0], wp[1], wp[2]);
    md.normals.push(wn[0], wn[1], wn[2]);
    md.uvs.push(u * uScale, v);
    return md.positions.length / 3 - 1;
  };
  for (const side of [1, -1]) {
    const off = side > 0 ? thickness / 2 : -thickness / 2;
    const base = md.positions.length / 3;
    for (let i = 0; i < n; i++) {
      const p = v3.add(pts[i], v3.scale(nrm[i], off));
      const nn = v3.scale(nrm[i], side);
      push(p, nn, arc[i], 0);
      push(v3.add(p, ext), nn, arc[i], -extLen);
    }
    for (let i = 0; i + 1 < n; i++) {
      const a = base + i * 2, b = base + (i + 1) * 2;
      // front face winding depends on side
      if (side > 0) md.indices.push(a, b, b + 1, a, b + 1, a + 1);
      else md.indices.push(a, b + 1, b, a, a + 1, b + 1);
    }
  }
  // make the winding agree with the normals regardless of profile orientation
  fixWinding(md);
  return md;
}

function fixWinding(md: MeshData) {
  const P = md.positions, N = md.normals, I = md.indices;
  for (let k = 0; k < I.length; k += 3) {
    const a = I[k] * 3, b = I[k + 1] * 3, c = I[k + 2] * 3;
    const e1 = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]];
    const e2 = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
    const fn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const dot = fn[0] * (N[a] + N[b] + N[c]) + fn[1] * (N[a + 1] + N[b + 1] + N[c + 1]) + fn[2] * (N[a + 2] + N[b + 2] + N[c + 2]);
    if (dot < 0) {
      const t = I[k + 1];
      I[k + 1] = I[k + 2];
      I[k + 2] = t;
    }
  }
}

/** Pleated curtain panel: wave across x from x0 to x1 at depth y, hanging from zTop down to zBot. */
function curtainPanel(material: string, c: TreatmentContext, x0: number, x1: number, y: number, zBot: number, zTop: number, amp: number, folds: number): MeshData {
  const pts: Vec3[] = [];
  const n = Math.max(2, folds) * 8;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = x0 + (x1 - x0) * t;
    // fold depth: sine, with flattened ends where the fabric turns back to the wall
    const s = Math.sin(t * folds * Math.PI * 2);
    pts.push([x, y + c.ins * amp * s, zBot]);
  }
  return sheet(material, c.frame, pts, [0, 0, zTop - zBot], 0.004, 1);
}

/**
 * Build the treatment in the opening's local frame. Returns world-space meshes (fabric sheets) and
 * fills `mb` (already in the opening frame via mb.with) with rods, rails, slats.
 */
export function buildTreatment(tr: Treatment, c: TreatmentContext, mb: MeshBuilder): MeshData[] {
  const out: MeshData[] = [];
  const { w, h, t, ins } = c;
  const face = ins * (t / 2); // interior wall face (local y)
  const isCurtain = tr.type === "curtains" || tr.type === "sheers" || tr.type === "curtains_and_sheers";
  const hw = tr.hardwareMaterial ?? (isCurtain ? "metal_black" : "plastic_white");
  const mount = tr.mount ?? "wall";
  const Y = (d: number) => face + ins * d; // local y at distance d into the room

  if (isCurtain) {
    const over = tr.widthOverrun ?? 0.25;
    const x0 = -w / 2 - over, x1 = w / 2 + over;
    const topZ = mount === "ceiling" ? c.ceilZ - 0.005 : Math.min(c.ceilZ - 0.06, h + (tr.heightOverrun ?? 0.15));
    const botZ = (tr.length ?? "floor") === "floor" ? c.floorZ + 0.015 : -0.12;
    const hangTop = mount === "ceiling" ? topZ - 0.045 : topZ - 0.03;
    // hardware
    const yFront = 0.16, yBack = 0.09; // curtain / sheer distances from the wall face
    if (mount === "ceiling") {
      for (const d of tr.type === "curtains_and_sheers" ? [yBack, yFront] : [yFront - 0.03]) {
        const yy = Y(d);
        mb.box(hw, [x0 - 0.03, Math.min(yy - 0.015, yy + 0.015), topZ - 0.025], [x1 + 0.03, Math.max(yy - 0.015, yy + 0.015), topZ]);
      }
    } else {
      const rods = tr.type === "curtains_and_sheers" ? [yBack, yFront] : [yFront - 0.03];
      for (const d of rods) {
        const yy = Y(d);
        mb.rod(hw, [x0 - 0.06, yy, topZ], [x1 + 0.06, yy, topZ], d === yBack && rods.length > 1 ? 0.008 : 0.013, 12);
        if (d === rods[rods.length - 1]) for (const sx of [-1, 1]) mb.sphere(hw, [sx * (x1 + 0.08), yy, topZ], 0.025, 12, 8);
      }
      for (const sx of [-1, 1]) {
        const xb = sx * (x1 - 0.02);
        mb.rod(hw, [xb, Y(0), topZ], [xb, Y(rods[rods.length - 1] + 0.01), topZ], 0.007, 6);
        mb.box(hw, [xb - 0.02, Math.min(Y(0), Y(0.012)), topZ - 0.04], [xb + 0.02, Math.max(Y(0), Y(0.012)), topZ + 0.04]);
      }
    }
    const layers: { mat: string; d: number; open: number; sheer: boolean }[] = [];
    if (tr.type === "curtains") layers.push({ mat: tr.material ?? "fabric_beige", d: yFront - 0.03, open: tr.open ?? 1, sheer: false });
    if (tr.type === "sheers") layers.push({ mat: tr.material ?? "sheer_white", d: yFront - 0.03, open: tr.open ?? 0, sheer: true });
    if (tr.type === "curtains_and_sheers") {
      layers.push({ mat: tr.sheerMaterial ?? "sheer_white", d: yBack, open: 0, sheer: true });
      layers.push({ mat: tr.material ?? "fabric_beige", d: yFront, open: tr.open ?? 1, sheer: false });
    }
    const full = x1 - x0;
    for (const L of layers) {
      const open = L.open;
      const panels: [number, number, number][] = []; // [outer x, direction toward centre, closed width]
      if (tr.side === "both") panels.push([x0, 1, full / 2], [x1, -1, full / 2]);
      else if (tr.side === "left") panels.push([x0, 1, full]);
      else panels.push([x1, -1, full]);
      for (const [xo, dir, closedW] of panels) {
        const stack = Math.max(0.12, closedW * 0.22);
        const width = closedW + (stack - closedW) * open;
        const folds = Math.max(2, Math.round(closedW / (L.sheer ? 0.1 : 0.13)));
        const amp = (L.sheer ? 0.018 : 0.03) + (L.sheer ? 0.01 : 0.025) * open;
        const xa = xo, xb = xo + dir * width;
        out.push(curtainPanel(L.mat, c, Math.min(xa, xb), Math.max(xa, xb), Y(L.d), botZ, hangTop, amp, folds));
        // rings / gliders
        if (mount !== "ceiling" && !L.sheer)
          for (let i = 0; i <= folds; i++) {
            const x = Math.min(xa, xb) + (Math.abs(xb - xa) * i) / folds;
            mb.rod(hw, [x, Y(L.d), hangTop], [x, Y(L.d), topZ + 0.012], 0.003, 4);
          }
      }
    }
    return out;
  }

  if (tr.type === "shutters") {
    const mat = tr.material ?? "wood_painted_white";
    const open = tr.open ?? 0;
    const n = w > 1.0 ? 4 : 2;
    const pw = w / n;
    const y0 = Y(0.005);
    for (let i = 0; i < n; i++) {
      // panels hinge in pairs from the outer jambs; inner panels bi-fold onto the outer ones
      const leftSide = i < n / 2;
      const hingeX = leftSide ? -w / 2 : w / 2;
      const idx = leftSide ? i : n - 1 - i; // 0 = outer
      const ang = open * (Math.PI / 2) * (leftSide ? -1 : 1) * ins;
      const local = m4.mul(m4.translation(hingeX, y0, 0), m4.rotationZ(ang));
      mb.with(local, () => {
        const sx = leftSide ? 1 : -1;
        const xa = sx * idx * pw, xb = sx * (idx + 1) * pw;
        const lo = Math.min(xa, xb) + 0.002, hi = Math.max(xa, xb) - 0.002;
        const th = 0.025;
        const ya = ins > 0 ? 0 : -th, yb = ins > 0 ? th : 0;
        const st = 0.045;
        mb.box(mat, [lo, ya, 0], [lo + st, yb, h]);
        mb.box(mat, [hi - st, ya, 0], [hi, yb, h]);
        mb.box(mat, [lo + st, ya, 0], [hi - st, yb, 0.09]);
        mb.box(mat, [lo + st, ya, h - 0.07], [hi - st, yb, h]);
        mb.box(mat, [lo + st, ya, h * 0.5 - 0.03], [hi - st, yb, h * 0.5 + 0.03]);
        // louvres, tilted 40°
        const ym = (ya + yb) / 2;
        for (const [za, zb] of [[0.09, h * 0.5 - 0.03], [h * 0.5 + 0.03, h - 0.07]] as const) {
          const cnt = Math.max(2, Math.floor((zb - za) / 0.075));
          for (let k = 0; k < cnt; k++) {
            const zc = za + ((k + 0.5) * (zb - za)) / cnt;
            mb.with(m4.mul(m4.translation(0, ym, zc), m4.rotationX(40 * (Math.PI / 180) * ins)), () =>
              mb.box(mat, [lo + st, -0.032, -0.005], [hi - st, 0.032, 0.005]),
            );
          }
        }
      });
    }
    return out;
  }

  // ---- blinds ----
  const recess = mount === "recess";
  const over = recess ? -0.01 : tr.widthOverrun ?? 0.05;
  const bx0 = -w / 2 - over, bx1 = w / 2 + over;
  const head = recess ? h - 0.01 : Math.min(c.ceilZ - 0.02, h + (tr.heightOverrun ?? 0.08));
  const fullDrop = head - (recess ? 0.01 : -0.04);
  const open = tr.open ?? 0.35;
  const yb = recess ? ins * (0.08 + 0.03) : 0; // inside the reveal: just in front of the frame
  const Yb = (d: number) => (recess ? yb + ins * d : Y(d));
  if (tr.type === "roller_blind") {
    const mat = tr.material ?? "fabric_white";
    const rollR = 0.025 + 0.01 * open;
    mb.rod(hw, [bx0, Yb(0.04), head - 0.035], [bx1, Yb(0.04), head - 0.035], rollR, 16);
    for (const x of [bx0, bx1]) mb.box(hw, [x - 0.008, Math.min(Yb(0), Yb(0.07)), head - 0.07], [x + 0.008, Math.max(Yb(0), Yb(0.07)), head]);
    const drop = (1 - open) * fullDrop;
    if (drop > 0.02) {
      const yy = Yb(0.04 + rollR);
      out.push(sheet(mat, c.frame, [[bx0 + 0.01, yy, head - 0.035 - drop], [bx1 - 0.01, yy, head - 0.035 - drop]], [0, 0, drop], 0.002));
      mb.box(hw, [bx0 + 0.01, Math.min(yy - 0.008, yy + 0.008), head - 0.035 - drop - 0.02], [bx1 - 0.01, Math.max(yy - 0.008, yy + 0.008), head - 0.035 - drop]);
    }
    return out;
  }
  if (tr.type === "roman_blind") {
    const mat = tr.material ?? "linen_white";
    mb.box(hw, [bx0, Math.min(Yb(0), Yb(0.05)), head - 0.04], [bx1, Math.max(Yb(0), Yb(0.05)), head]);
    const foldH = 0.2;
    const nFolds = Math.max(2, Math.round(fullDrop / foldH));
    const fh = fullDrop / nFolds;
    // raised: folds collapse into a stack of loops at the top
    const visible = Math.max(0.06 * nFolds * open, (1 - open) * fullDrop + open * nFolds * 0.06);
    const zTop = head - 0.04;
    const pts: Vec3[] = [];
    const per = 10;
    for (let f = 0; f < nFolds; f++)
      for (let i = 0; i < per; i++) {
        const tt = (f + i / per) / nFolds;
        const zz = zTop - tt * visible;
        const local = i / per;
        const bulge = (0.012 + 0.04 * open) * Math.sin(local * Math.PI);
        pts.push([0, Yb(0.05 + bulge), zz]);
      }
    pts.push([0, Yb(0.05), zTop - visible]);
    // profile lies in the y-z plane, extrude along x
    out.push(sheet(mat, c.frame, pts.map((p) => [bx0 + 0.005, p[1], p[2]] as Vec3), [bx1 - bx0 - 0.01, 0, 0], 0.003));
    const yy = Yb(0.05);
    mb.box(hw, [bx0 + 0.005, Math.min(yy - 0.006, yy + 0.006), zTop - visible - 0.012], [bx1 - 0.005, Math.max(yy - 0.006, yy + 0.006), zTop - visible]);
    void fh;
    return out;
  }
  // venetian
  const mat = tr.material ?? "plastic_white";
  mb.box(hw, [bx0, Math.min(Yb(0.005), Yb(0.055)), head - 0.04], [bx1, Math.max(Yb(0.005), Yb(0.055)), head]);
  const pitch = 0.022;
  const nSlats = Math.max(3, Math.floor((fullDrop - 0.05) / pitch));
  const lowered = Math.round(nSlats * (1 - open));
  const zTop = head - 0.05;
  const yc = Yb(0.03);
  const tilt = (open > 0.95 ? 0 : 35) * (Math.PI / 180);
  for (let k = 0; k < nSlats; k++) {
    const stacked = k >= lowered;
    const zc = stacked ? zTop - (k - lowered) * 0.006 - 0.004 - lowered * pitch : zTop - (k + 0.5) * pitch;
    mb.with(m4.mul(m4.translation(0, yc, zc), m4.rotationX(stacked ? 0 : tilt * ins)), () =>
      mb.box(mat, [bx0 + 0.008, -0.0125, -0.0007], [bx1 - 0.008, 0.0125, 0.0007]),
    );
  }
  const bottom = zTop - lowered * pitch - (nSlats - lowered) * 0.006 - 0.012;
  mb.box(hw, [bx0 + 0.005, Math.min(yc - 0.014, yc + 0.014), bottom], [bx1 - 0.005, Math.max(yc - 0.014, yc + 0.014), bottom + 0.012]);
  // ladder cords
  for (const fx of [0.15, 0.5, 0.85]) {
    const x = bx0 + (bx1 - bx0) * fx;
    for (const dy of [-0.012, 0.012]) mb.box("fabric_white", [x - 0.002, yc + dy - 0.0005, bottom + 0.012], [x + 0.002, yc + dy + 0.0005, zTop + 0.01]);
  }
  return out;
}

export type { Vec2 };
