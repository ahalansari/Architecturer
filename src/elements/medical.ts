/**
 * Medical equipment and healthcare furniture: wards, ICUs, operating theatres, imaging, clinics, dental,
 * laboratories. Same frame as furniture.ts (origin at the footprint centre on the floor, width along x, depth
 * along y, height up, FRONT toward -y) and the same parametric style: sizes scale the parts, structural
 * members keep real thicknesses. Registered into FURNITURE by furniture.ts.
 *
 * Models are generic, representative shapes for planning, clearances and visualisation. They are not any
 * manufacturer's product and say nothing about clinical suitability; real equipment rooms are set out from the
 * chosen vendor's site-planning data (shielding, magnetic fringe fields, floor loading, services).
 */
import { m4, type Vec2, type Vec3 } from "../geometry/math.js";
import type { MeshBuilder } from "../geometry/mesh.js";
import type { FurnitureSpec, FurnitureType } from "./furniture.js";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function opt<T>(s: FurnitureSpec, key: string, def: T): T {
  const v = s.options?.[key];
  if (typeof def === "number") {
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
    return (isFinite(n) ? n : def) as T;
  }
  if (typeof def === "boolean") {
    if (typeof v === "boolean") return v as T;
    if (typeof v === "string") return (/^(true|yes|1|on)$/i.test(v.trim()) ? true : /^(false|no|0|off)$/i.test(v.trim()) ? false : def) as T;
    return def;
  }
  return (typeof v === typeof def ? v : def) as T;
}

/** A castor: swivel stem and a wheel on an axle along x, resting on the floor. */
function castor(mb: MeshBuilder, mat: string, x: number, y: number, r = 0.05) {
  mb.with(m4.mul(m4.translation(x, y, r), m4.rotationY(Math.PI / 2)), () => mb.cylinder(mat, [0, 0, -0.012], r, r, 0.024, 12));
  mb.block(mat, x, y, r * 1.6, 0.03, 0.03, r * 0.8);
}

/** Four castors at the corners of a w × d frame (inset by `ins`). */
function castors(mb: MeshBuilder, mat: string, w: number, d: number, ins = 0.08, r = 0.05) {
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) castor(mb, mat, sx * (w / 2 - ins), sy * (d / 2 - ins), r);
}

/** Five-spoke castor base (IV poles, stools, monitor stands). */
function starBase(mb: MeshBuilder, frame: string, wheel: string, r: number) {
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + Math.PI / 2;
    const tip: Vec3 = [Math.cos(a) * (r - 0.03), Math.sin(a) * (r - 0.03), 0.09];
    mb.rod(frame, [0, 0, 0.11], tip, 0.014, 8);
    castor(mb, wheel, tip[0], tip[1], 0.035);
  }
  mb.cylinder(frame, [0, 0, 0.07], 0.05, 0.04, 0.06, 16);
}

/** Display facing -y: a frame with a dark screen on its front face. */
function display(mb: MeshBuilder, frame: string, glass: string, cx: number, cy: number, z0: number, w: number, h: number, t = 0.05) {
  mb.box(frame, [cx - w / 2, cy - t / 2, z0], [cx + w / 2, cy + t / 2, z0 + h]);
  const b = Math.min(w, h) * 0.07;
  mb.box(glass, [cx - w / 2 + b, cy - t / 2 - 0.004, z0 + b], [cx + w / 2 - b, cy - t / 2, z0 + h - b]);
}

/** Drawer fronts with bar handles on the -y face of a cabinet, x0..x1, from z0 up to z1. */
function drawers(mb: MeshBuilder, body: string, handle: string, x0: number, x1: number, y: number, z0: number, z1: number, n: number) {
  const zh = (z1 - z0) / n;
  for (let i = 0; i < n; i++) {
    const a = z0 + i * zh + 0.004, b = z0 + (i + 1) * zh - 0.004;
    mb.box(body, [x0 + 0.006, y - 0.018, a], [x1 - 0.006, y, b]);
    const hw = Math.min(0.25, (x1 - x0) * 0.5);
    mb.box(handle, [(x0 + x1) / 2 - hw / 2, y - 0.035, b - 0.04], [(x0 + x1) / 2 + hw / 2, y - 0.018, b - 0.025]);
  }
}

// ---------------------------------------------------------------------------
// wards and patient rooms

function buildHospitalBed(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  // the bed lies along y: head at +y (against the wall), foot toward -y
  const deck = clamp(h * 0.5, 0.4, 0.75);
  const back = (clamp(opt(s, "backrest", 30), 0, 70) * Math.PI) / 180;
  castors(mb, M.castors, w - 0.04, d - 0.2, 0.08, 0.06);
  // chassis and lifting column
  mb.box(M.frame, [-w / 2 + 0.1, -d / 2 + 0.15, 0.1], [w / 2 - 0.1, d / 2 - 0.15, 0.16]);
  mb.box(M.frame, [-0.18, -0.35, 0.16], [0.18, 0.35, deck - 0.12]);
  mb.box(M.frame, [-w / 2 + 0.04, -d / 2 + 0.08, deck - 0.12], [w / 2 - 0.04, d / 2 - 0.08, deck - 0.06]);
  // mattress: flat foot and seat, backrest section raised at the head
  const mx = w / 2 - 0.06, t = 0.14;
  const hinge = d / 2 - 0.08 - 0.75;
  mb.box(M.mattress, [-mx, -d / 2 + 0.1, deck - 0.06], [mx, hinge, deck - 0.06 + t]);
  mb.with(m4.mul(m4.translation(0, hinge, deck - 0.06), m4.rotationX(back)), () => {
    mb.box(M.mattress, [-mx, 0, 0], [mx, 0.75, t]);
    mb.box(M.linen, [-mx * 0.6, 0.42, t], [mx * 0.6, 0.7, t + 0.1]);
  });
  // sheet over the foot and seat
  mb.box(M.linen, [-mx - 0.01, -d / 2 + 0.12, deck - 0.06 + t], [mx + 0.01, hinge - 0.02, deck - 0.06 + t + 0.03]);
  // head and foot boards
  const board = (y0: number, y1: number, top: number) => {
    mb.box(M.boards, [-w / 2 + 0.03, y0, deck - 0.1], [w / 2 - 0.03, y1, top]);
    mb.box(M.frame, [-w / 2 + 0.03, y0 - 0.005, top - 0.04], [w / 2 - 0.03, y1 + 0.005, top]);
  };
  board(d / 2 - 0.06, d / 2, Math.min(h, deck + 0.5));
  board(-d / 2, -d / 2 + 0.05, Math.min(h, deck + 0.35));
  // split side rails, up
  if (opt(s, "rails", true))
    for (const sx of [-1, 1]) {
      const x = sx * (w / 2 - 0.02);
      for (const [y0, y1] of [[-d / 2 + 0.35, hinge - 0.05], [hinge + 0.05, d / 2 - 0.12]] as Vec2[]) {
        for (const z of [deck + 0.18, deck + 0.34]) mb.box(M.frame, [x - 0.015, y0, z - 0.02], [x + 0.015, y1, z + 0.02]);
        for (const y of [y0 + 0.04, y1 - 0.04]) mb.box(M.frame, [x - 0.015, y - 0.015, deck - 0.06], [x + 0.015, y + 0.015, deck + 0.36]);
      }
    }
}

function buildPatientMonitor(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, height: h } = s;
  const M = s.materials;
  const sw = Math.min(w * 0.9, 0.4), sh = sw * 0.75;
  if (opt<string>(s, "mount", "stand") === "wall") {
    // arm from a wall plate at the back; the caller sets elevation (screen bottom)
    mb.box(M.frame, [-0.06, s.depth / 2 - 0.02, h * 0.3], [0.06, s.depth / 2, h * 0.7]);
    mb.box(M.frame, [-0.025, -s.depth / 2 + 0.06, h * 0.45], [0.025, s.depth / 2 - 0.02, h * 0.55]);
    display(mb, M.frame, M.screen, 0, -s.depth / 2 + 0.04, 0, sw, Math.min(sh, h), 0.07);
    return;
  }
  starBase(mb, M.frame, M.castors, Math.min(w, s.depth) / 2);
  mb.cylinder(M.frame, [0, 0, 0.13], 0.02, 0.02, h - sh - 0.13, 12);
  mb.box(M.frame, [-0.12, -0.04, h - sh - 0.25], [0.12, 0.06, h - sh - 0.2]); // accessory basket shelf
  display(mb, M.frame, M.screen, 0, -0.02, h - sh, sw, sh, 0.08);
}

function buildIvStand(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  starBase(mb, M.frame, M.castors, Math.min(w, d) / 2);
  mb.cylinder(M.frame, [0, 0, 0.13], 0.013, 0.013, h - 0.13, 10);
  // four hooks and a bag
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    mb.rod(M.frame, [0, 0, h - 0.04], [Math.cos(a) * 0.14, Math.sin(a) * 0.14, h - 0.02], 0.005, 6);
  }
  if (opt(s, "bag", true)) {
    mb.box(M.bag, [0.06, -0.045, h - 0.32], [0.18, -0.025, h - 0.08]);
    mb.rod(M.bag, [0.12, -0.035, h - 0.32], [0.04, -0.01, 0.9], 0.003, 4);
    mb.box(M.frame, [0.03, -0.06, h - 0.62], [0.13, 0.03, h - 0.5]); // infusion pump
  }
}

function buildOverbedTable(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  // C-frame: base and column on the right (+x) so the top slides over the bed
  const bx = w / 2 - 0.12;
  mb.box(M.frame, [bx - 0.12, -d / 2, 0.05], [bx + 0.12, d / 2, 0.09]);
  mb.box(M.frame, [-w / 2 + 0.05, -0.04, 0.05], [bx, 0.04, 0.09]);
  for (const [x, y] of [[bx, -d / 2 + 0.05], [bx, d / 2 - 0.05], [-w / 2 + 0.08, 0]] as Vec2[]) castor(mb, M.castors, x, y, 0.035);
  mb.box(M.frame, [bx - 0.03, -0.03, 0.09], [bx + 0.03, 0.03, h - 0.03]);
  mb.box(M.top, [-w / 2, -d / 2 + 0.01, h - 0.03], [w / 2, d / 2, h - 0.01]);
  mb.box(M.frame, [-w / 2, -d / 2, h - 0.035], [w / 2, -d / 2 + 0.01, h]); // lipped front edge
}

function buildBedsideCabinet(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  castors(mb, M.castors, w, d, 0.05, 0.035);
  mb.box(M.body, [-w / 2, -d / 2 + 0.04, 0.07], [w / 2, d / 2, h - 0.03]);
  mb.box(M.top, [-w / 2, -d / 2 + 0.02, h - 0.03], [w / 2, d / 2, h]);
  drawers(mb, M.fronts, M.handles, -w / 2, w / 2, -d / 2 + 0.04, h * 0.62, h - 0.04, 1);
  drawers(mb, M.fronts, M.handles, -w / 2, w / 2, -d / 2 + 0.04, 0.09, h * 0.6, 1);
}

function buildBedheadUnit(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  // wall trunking at the back (+y) with gas outlets, sockets, a reading light and a nurse call
  const y = d / 2 - Math.min(d, 0.1) / 2;
  mb.box(M.body, [-w / 2, y, 0], [w / 2, d / 2, h]);
  mb.box(M.light, [-w / 2 + 0.03, y - 0.004, h - 0.06], [w / 2 - 0.03, y, h - 0.025]);
  const n = Math.max(2, Math.floor((w - 0.2) / 0.16));
  for (let i = 0; i < n; i++) {
    const x = -w / 2 + 0.1 + (i + 0.5) * ((w - 0.2) / n);
    const gas = i < 3;
    mb.box(gas ? M.outlets : M.sockets, [x - 0.04, y - 0.012, h * 0.3], [x + 0.04, y, h * 0.3 + 0.08]);
    if (gas) mb.cylinder(M.metal, [x, y - 0.02, h * 0.34 - 0.012], 0.012, 0.012, 0.024, 8);
  }
}

function buildPrivacyCurtain(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  // ceiling track around the bed space; the curtain stops 0.3 m above the floor and leaves a mesh band on top
  const shape = opt<string>(s, "shape", "u");
  const x = w / 2 - 0.03, y = d / 2 - 0.03; // room for the pleats
  const pts: Vec2[] = shape === "straight" ? [[-x, -y], [x, -y]] : shape === "l" ? [[-x, y], [-x, -y], [x, -y]] : [[-x, y], [-x, -y], [x, -y], [x, y]];
  const open = clamp(opt(s, "open", 0.15), 0, 1);
  const front = pts.length === 2 ? 0 : 1;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [a, b] = [pts[i], pts[i + 1]];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const dir: Vec3 = [(b[0] - a[0]) / len, (b[1] - a[1]) / len, 0];
    mb.rod(M.track, [a[0], a[1], h - 0.03], [b[0], b[1], h - 0.03], 0.015, 6);
    // pleated fabric as a thin zig-zag slab (like the window curtain), a mesh band above it
    const shown = i === front ? len * (1 - open) : len;
    if (shown < 0.05) continue;
    const n = Math.max(2, Math.round(shown / 0.15) * 2);
    const amp = 0.025, th = 0.006;
    const edge: Vec2[] = Array.from({ length: n + 1 }, (_, k) => [(shown * k) / n, k % 2 ? amp : -amp]);
    const profile: Vec2[] = [...edge, ...edge.map((p) => [p[0], p[1] + th] as Vec2).reverse()];
    const top = h - 0.55;
    mb.with(m4.fromBasis(dir, [-dir[1], dir[0], 0], [0, 0, 1], [a[0], a[1], 0]), () => {
      mb.prism(M.curtain, profile, 0.3, top);
      mb.prism(M.mesh, profile, top, h - 0.05);
    });
  }
}

function buildPatientRecliner(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  castors(mb, M.castors, w - 0.1, d - 0.1, 0.06, 0.04);
  mb.box(M.frame, [-w / 2 + 0.08, -d / 2 + 0.1, 0.08], [w / 2 - 0.08, d / 2 - 0.1, 0.3]);
  const seat = 0.48;
  mb.box(M.upholstery, [-w / 2 + 0.12, -d / 2 + 0.2, 0.3], [w / 2 - 0.12, d / 2 - 0.25, seat]);
  // leg rest raised in front of the seat, backrest leaning back
  mb.box(M.upholstery, [-w / 2 + 0.12, -d / 2, seat - 0.12], [w / 2 - 0.12, -d / 2 + 0.2, seat - 0.03]);
  mb.with(m4.mul(m4.translation(0, d / 2 - 0.34, seat - 0.05), m4.rotationX(-0.25)), () => mb.box(M.upholstery, [-w / 2 + 0.12, 0, 0], [w / 2 - 0.12, 0.15, h - seat]));
  for (const sx of [-1, 1]) mb.box(M.frame, [sx * (w / 2) - (sx > 0 ? 0.12 : 0), -d / 2 + 0.25, 0.3], [sx * (w / 2) + (sx > 0 ? 0 : 0.12), d / 2 - 0.2, 0.68]);
}

function buildWheelchair(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const R = clamp(d * 0.3, 0.25, 0.31);
  // big wheels at the back, castors at the front
  for (const sx of [-1, 1]) {
    mb.with(m4.mul(m4.translation(sx * (w / 2 - 0.03), d / 2 - R - 0.05, R), m4.rotationY(Math.PI / 2)), () => {
      mb.cylinder(M.tyres, [0, 0, -0.015], R, R, 0.03, 24, { top: false, bottom: false });
      mb.cylinder(M.frame, [0, 0, -0.005], R - 0.03, R - 0.03, 0.01, 24);
    });
    castor(mb, M.tyres, sx * (w / 2 - 0.1), -d / 2 + 0.12, 0.07);
    mb.rod(M.frame, [sx * (w / 2 - 0.1), -d / 2 + 0.15, 0.16], [sx * (w / 2 - 0.1), d / 2 - 0.15, 0.5], 0.012);
    mb.rod(M.frame, [sx * (w / 2 - 0.1), d / 2 - 0.15, 0.3], [sx * (w / 2 - 0.1), d / 2 - 0.12, h], 0.012);
    mb.rod(M.frame, [sx * (w / 2 - 0.1), -d / 2 + 0.2, 0.5], [sx * (w / 2 - 0.1), -d / 2 + 0.05, 0.12], 0.01); // footrest hanger
  }
  mb.box(M.seat, [-w / 2 + 0.1, -d / 2 + 0.25, 0.47], [w / 2 - 0.1, d / 2 - 0.15, 0.5]);
  mb.box(M.seat, [-w / 2 + 0.1, d / 2 - 0.15, 0.55], [w / 2 - 0.1, d / 2 - 0.13, h - 0.05]);
  mb.box(M.frame, [-w / 2 + 0.12, -d / 2 + 0.02, 0.1], [w / 2 - 0.12, -d / 2 + 0.12, 0.115]);
}

function buildStretcher(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  // trolley along y like the bed: head at +y
  castors(mb, M.castors, w - 0.1, d - 0.3, 0.06, 0.07);
  mb.box(M.frame, [-w / 2 + 0.12, -d / 2 + 0.25, 0.14], [w / 2 - 0.12, d / 2 - 0.25, 0.2]);
  for (const y of [-0.45, 0.45]) mb.box(M.frame, [-0.06, y - 0.06, 0.2], [0.06, y + 0.06, h - 0.2]);
  mb.box(M.frame, [-w / 2 + 0.05, -d / 2 + 0.05, h - 0.2], [w / 2 - 0.05, d / 2 - 0.05, h - 0.15]);
  mb.box(M.mattress, [-w / 2 + 0.07, -d / 2 + 0.07, h - 0.15], [w / 2 - 0.07, d / 2 - 0.07, h - 0.07]);
  mb.box(M.linen, [-w / 2 + 0.06, -d / 2 + 0.1, h - 0.07], [w / 2 - 0.06, d / 2 - 0.3, h - 0.05]);
  for (const sx of [-1, 1]) mb.box(M.frame, [sx * (w / 2) - 0.02 * (sx + 1), -d / 2 + 0.3, h - 0.15], [sx * (w / 2) - 0.02 * (sx - 1), d / 2 - 0.3, h]);
}

// ---------------------------------------------------------------------------
// clinics and treatment

function buildExaminationTable(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  // couch along x: head end raised at +x; a paper roll at the head
  mb.box(M.frame, [-w / 2 + 0.1, -d / 2 + 0.08, 0], [w / 2 - 0.1, d / 2 - 0.08, 0.05]);
  // height is the overall height with the head section raised; the couch top is lower
  const pad = 0.08, head = Math.min(0.65, w * 0.35), tilt = 0.3;
  const ct = Math.max(0.45, h - pad - head * Math.sin(tilt));
  mb.box(M.body, [-w / 2 + 0.25, -d / 2 + 0.12, 0.05], [w / 2 - 0.25, d / 2 - 0.12, ct]);
  drawers(mb, M.body, M.handles, -w / 2 + 0.25, -w / 2 + 0.7, -d / 2 + 0.12, 0.1, ct - 0.05, 3);
  mb.box(M.upholstery, [-w / 2, -d / 2, ct], [w / 2 - head, d / 2, ct + pad]);
  mb.with(m4.mul(m4.translation(w / 2 - head, 0, ct), m4.rotationY(-tilt)), () => mb.box(M.upholstery, [0, -d / 2, 0], [head, d / 2, pad]));
  mb.box(M.paper, [-w / 2 + 0.05, -d / 2 * 0.7, ct + pad], [w / 2 - head, d / 2 * 0.7, ct + pad + 0.003]);
  mb.with(m4.mul(m4.translation(w / 2 - 0.08, 0, ct - 0.08), m4.rotationX(Math.PI / 2)), () => mb.cylinder(M.paper, [0, 0, -d * 0.35], 0.05, 0.05, d * 0.7, 12));
}

function buildMedicalCart(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  castors(mb, M.castors, w, d, 0.06, 0.05);
  mb.box(M.body, [-w / 2 + 0.02, -d / 2 + 0.03, 0.1], [w / 2 - 0.02, d / 2, h - 0.06]);
  mb.box(M.top, [-w / 2, -d / 2, h - 0.06], [w / 2, d / 2, h - 0.03]);
  // raised rim on the work top
  for (const sx of [-1, 1]) mb.box(M.top, [sx > 0 ? w / 2 - 0.02 : -w / 2, -d / 2, h - 0.03], [sx > 0 ? w / 2 : -w / 2 + 0.02, d / 2, h]);
  mb.box(M.top, [-w / 2, d / 2 - 0.02, h - 0.03], [w / 2, d / 2, h]);
  drawers(mb, M.fronts, M.handles, -w / 2 + 0.02, w / 2 - 0.02, -d / 2 + 0.03, 0.12, h - 0.08, Math.round(clamp(opt(s, "drawers", 5), 2, 8)));
  // push handles on both ends
  for (const sx of [-1, 1]) mb.box(M.handles, [sx > 0 ? w / 2 - 0.02 : -w / 2, -d / 2 + 0.08, h - 0.2], [sx > 0 ? w / 2 : -w / 2 + 0.02, d / 2 - 0.08, h - 0.17]);
}

function buildDefibrillator(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  // AED wall cabinet: back at +y; the caller sets elevation (~1.1 m)
  mb.box(M.body, [-w / 2, -d / 2 + 0.01, 0], [w / 2, d / 2, h]);
  mb.box(M.door, [-w / 2 + 0.02, -d / 2, 0.02], [w / 2 - 0.02, -d / 2 + 0.01, h - 0.02]);
  mb.box(M.sign, [-w * 0.2, -d / 2 - 0.002, h * 0.55], [w * 0.2, -d / 2, h * 0.85]);
}

function buildScrubSink(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  // surgical scrub trough at 1.0 m with a tiled-in splash panel up to h, sensor taps per station
  const rim = Math.min(1.0, h - 0.2);
  const n = Math.max(1, Math.round(opt(s, "stations", Math.max(1, Math.round(w / 0.75)))));
  mb.box(M.body, [-w / 2, -d / 2 + 0.05, rim - 0.35], [w / 2, d / 2, rim - 0.33]);
  mb.box(M.body, [-w / 2, -d / 2, rim - 0.33], [w / 2, -d / 2 + 0.05, rim]);
  for (const sx of [-1, 1]) mb.box(M.body, [sx > 0 ? w / 2 - 0.04 : -w / 2, -d / 2, rim - 0.33], [sx > 0 ? w / 2 : -w / 2 + 0.04, d / 2, rim]);
  mb.box(M.body, [-w / 2, d / 2 - 0.15, rim - 0.33], [w / 2, d / 2, h]);
  for (let i = 0; i < n; i++) {
    const x = -w / 2 + (i + 0.5) * (w / n);
    mb.rod(M.taps, [x, d / 2 - 0.15, rim + 0.3], [x, d / 2 - 0.35, rim + 0.25], 0.012);
    mb.box(M.taps, [x - 0.04, d / 2 - 0.16, rim + 0.4], [x + 0.04, d / 2 - 0.15, rim + 0.5]); // sensor
  }
  mb.box(M.legs, [-w / 2 + 0.05, d / 2 - 0.1, 0], [w / 2 - 0.05, d / 2 - 0.05, rim - 0.35]);
}

function buildMedicineCabinet(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  mb.box(M.body, [-w / 2, -d / 2 + 0.04, 0], [w / 2, d / 2, h]);
  const split = h * 0.45;
  drawers(mb, M.body, M.handles, -w / 2, w / 2, -d / 2 + 0.04, 0.08, split, Math.max(2, Math.round(split / 0.2)));
  // glazed doors over adjustable shelves
  const n = Math.max(1, Math.round(w / 0.5));
  for (let i = 0; i < n; i++) {
    const x0 = -w / 2 + (i * w) / n, x1 = x0 + w / n;
    mb.box(M.body, [x0 + 0.005, -d / 2 + 0.02, split], [x1 - 0.005, -d / 2 + 0.04, split + 0.04]);
    mb.box(M.glass, [x0 + 0.03, -d / 2 + 0.025, split + 0.04], [x1 - 0.03, -d / 2 + 0.032, h - 0.04]);
  }
  for (let z = split + 0.35; z < h - 0.1; z += 0.35) mb.box(M.body, [-w / 2 + 0.02, -d / 2 + 0.03, z], [w / 2 - 0.02, d / 2 - 0.02, z + 0.015]);
}

function buildExamLamp(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  starBase(mb, M.frame, M.castors, Math.min(w, d) / 2);
  mb.cylinder(M.frame, [0, 0, 0.13], 0.016, 0.016, h * 0.6, 10);
  mb.rod(M.frame, [0, 0, h * 0.6 + 0.13], [0, -d / 2 + 0.12, h - 0.1], 0.01, 8);
  mb.with(m4.translation(0, -d / 2 + 0.12, h - 0.1), () => {
    mb.cylinder(M.frame, [0, 0, -0.04], 0.09, 0.07, 0.08, 20);
    mb.cylinder(M.light, [0, 0, -0.045], 0.075, 0.075, 0.005, 20);
  });
}

function buildDentalChair(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  // chair along y (head at +y), base plate, lift column, spittoon unit on the left, light arm overhead
  mb.box(M.frame, [-0.3, -d / 2 + 0.2, 0], [0.3, d / 2 - 0.4, 0.05]);
  mb.box(M.frame, [-0.15, -0.2, 0.05], [0.15, 0.2, 0.4]);
  const seat = 0.45;
  mb.box(M.upholstery, [-0.3, -0.25, seat - 0.08], [0.3, 0.3, seat]);
  mb.with(m4.mul(m4.translation(0, -0.25, seat - 0.04), m4.rotationX(-0.55)), () => mb.box(M.upholstery, [-0.25, -0.75, -0.08], [0.25, 0, 0]));
  mb.with(m4.mul(m4.translation(0, 0.3, seat - 0.06), m4.rotationX(-0.35)), () => {
    mb.box(M.upholstery, [-0.28, 0, 0], [0.28, 0.08, 0.7]);
    mb.box(M.upholstery, [-0.13, 0.0, 0.72], [0.13, 0.1, 0.9]); // headrest
  });
  for (const sx of [-1, 1]) mb.box(M.frame, [sx * 0.33 - 0.03, -0.15, seat + 0.1], [sx * 0.33 + 0.03, 0.25, seat + 0.14]);
  // spittoon / water unit at the side
  const ux = -w / 2 + 0.15;
  mb.box(M.frame, [ux - 0.12, 0.15, 0], [ux + 0.12, 0.45, 0.9]);
  mb.cylinder(M.bowl, [ux + 0.05, 0.25, 0.9], 0.08, 0.11, 0.08, 16);
  // light post and arm
  mb.cylinder(M.frame, [ux, 0.4, 0.9], 0.03, 0.03, h - 0.95, 10);
  mb.rod(M.frame, [ux, 0.4, h - 0.05], [0, 0.0, h - 0.05], 0.02);
  mb.box(M.light, [-0.15, -0.06, h - 0.2], [0.15, 0.06, h - 0.08]);
  // instrument tray on the right
  mb.rod(M.frame, [-0.15, -0.2, 0.4], [w / 2 - 0.2, -d / 2 + 0.6, 0.95], 0.02);
  mb.box(M.frame, [w / 2 - 0.45, -d / 2 + 0.45, 0.95], [w / 2 - 0.05, -d / 2 + 0.75, 1.0]);
}

// ---------------------------------------------------------------------------
// operating theatres and critical care

function buildOperatingTable(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  // along y: base plate, column, segmented top with side rails
  mb.box(M.frame, [-Math.min(0.3, w / 2), -0.55, 0], [Math.min(0.3, w / 2), 0.45, 0.08]);
  mb.box(M.frame, [-0.17, -0.25, 0.08], [0.17, 0.2, h - 0.12]);
  mb.box(M.frame, [-w / 2 + 0.03, -d / 2 + 0.05, h - 0.12], [w / 2 - 0.03, d / 2 - 0.05, h - 0.08]);
  const segs: [number, number][] = [[-d / 2, -d / 2 + 0.55], [-d / 2 + 0.57, d / 2 - 0.65], [d / 2 - 0.63, d / 2 - 0.3], [d / 2 - 0.28, d / 2]];
  for (const [y0, y1] of segs) mb.box(M.pad, [-w / 2 + 0.02, y0, h - 0.08], [w / 2 - 0.02, y1, h]);
  for (const sx of [-1, 1]) mb.box(M.metal, [sx * (w / 2) - (sx > 0 ? 0.015 : 0), -d / 2 + 0.1, h - 0.1], [sx * (w / 2) + (sx > 0 ? 0 : 0.015), d / 2 - 0.1, h - 0.07]);
}

/** Ceiling-mounted items: z = h is the ceiling, things hang down from it. */
function buildSurgicalLight(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  mb.cylinder(M.frame, [0, 0, h - 0.04], 0.12, 0.12, 0.04, 20);
  mb.cylinder(M.frame, [0, 0, h - 0.5], 0.035, 0.035, 0.46, 12);
  const heads = Math.round(clamp(opt(s, "heads", 2), 1, 3));
  const R = clamp(Math.min(w / (heads > 1 ? 4 : 2), d / 2), 0.25, 0.4);
  for (let i = 0; i < heads; i++) {
    const a = heads === 1 ? -Math.PI / 2 : (i / heads) * Math.PI * 2 + 0.3;
    const reach = heads === 1 ? Math.min(d / 2 - R, 0.4) : Math.min(w / 2, d / 2) - R;
    const c: Vec3 = [Math.cos(a) * reach, Math.sin(a) * reach, 0.02 + 0.1 * i];
    mb.rod(M.frame, [0, 0, h - 0.48 - 0.1 * i], [c[0], c[1], h - 0.48 - 0.1 * i], 0.025);
    mb.rod(M.frame, [c[0], c[1], h - 0.48 - 0.1 * i], [c[0], c[1], c[2] + 0.12], 0.02);
    // dome with a lit face underneath
    mb.lathe([[R, 0], [R * 0.95, 0.06], [R * 0.6, 0.11], [0.06, 0.13]], () => M.frame, c, 32);
    mb.cylinder(M.light, [c[0], c[1], c[2] - 0.006], R * 0.92, R * 0.92, 0.006, 32);
  }
}

function buildMedicalPendant(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  // service pendant: ceiling flange, arm, and a column with shelves, gases and power hanging to ~0.9 m above the floor
  mb.cylinder(M.frame, [0, d / 2 - 0.12, h - 0.04], 0.12, 0.12, 0.04, 20);
  mb.box(M.frame, [-0.06, -0.05, h - 0.3], [0.06, d / 2 - 0.05, h - 0.18]);
  mb.cylinder(M.frame, [0, d / 2 - 0.12, h - 0.3], 0.05, 0.05, 0.27, 12);
  const top = h - 0.3, bot = 0;
  mb.box(M.body, [-w / 2 + 0.05, -0.12, bot], [w / 2 - 0.05, 0.12, top]);
  for (const z of [bot + 0.35, bot + 0.75]) mb.box(M.shelf, [-w / 2, -d / 2, z], [w / 2, 0.14, z + 0.025]);
  for (let i = 0; i < 4; i++) {
    const x = -w / 2 + 0.1 + i * ((w - 0.2) / 3);
    mb.box(i < 2 ? M.outlets : M.sockets, [x - 0.03, -0.125, top - 0.25], [x + 0.03, -0.12, top - 0.17]);
  }
}

function buildAnesthesiaMachine(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  castors(mb, M.castors, w, d, 0.07, 0.06);
  mb.box(M.body, [-w / 2 + 0.03, -d / 2 + 0.1, 0.12], [w / 2 - 0.03, d / 2, 0.85]);
  drawers(mb, M.body, M.handles, -w / 2 + 0.03, w / 2 - 0.03, -d / 2 + 0.1, 0.15, 0.6, 3);
  mb.box(M.top, [-w / 2, -d / 2, 0.85], [w / 2, d / 2, 0.88]);
  mb.box(M.body, [-w / 2 + 0.05, 0, 0.88], [w / 2 - 0.05, d / 2 - 0.02, h - 0.35]);
  display(mb, M.body, M.screen, 0, -0.02, h - 0.35, Math.min(w * 0.7, 0.45), 0.32, 0.06);
  // flowmeters and a bellows
  mb.box(M.glass, [-w / 2 + 0.07, -0.005, 1.05], [-w / 2 + 0.22, 0.0, 1.3]);
  mb.cylinder(M.glass, [w / 2 - 0.15, -d / 2 + 0.2, 0.88], 0.07, 0.07, 0.22, 16);
  // gas cylinders at the back
  for (const x of [-0.12, 0.12]) mb.cylinder(M.cylinders, [x, d / 2 - 0.08, 0.15], 0.05, 0.05, 0.65, 12);
}

function buildVentilator(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  starBase(mb, M.frame, M.castors, Math.min(w, d) / 2);
  mb.cylinder(M.frame, [0, 0, 0.13], 0.025, 0.025, h - 0.7, 12);
  mb.box(M.body, [-w * 0.38, -d * 0.3, h - 0.62], [w * 0.38, d * 0.3, h - 0.3]);
  display(mb, M.body, M.screen, 0, -d * 0.12, h - 0.32, Math.min(w * 0.75, 0.38), 0.3, 0.05);
  mb.rod(M.tubing, [w * 0.3, -d * 0.3, h - 0.45], [w / 2 - 0.02, -d / 2 + 0.02, h - 0.2], 0.012);
}

function buildInfantIncubator(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  castors(mb, M.castors, w, d, 0.06, 0.05);
  mb.box(M.frame, [-0.1, -0.1, 0.1], [0.1, 0.1, 0.6]);
  mb.box(M.body, [-w / 2, -d / 2 + 0.035, 0.6], [w / 2, d / 2, 0.9]);
  drawers(mb, M.body, M.handles, -w / 2, w / 2, -d / 2 + 0.035, 0.62, 0.88, 1);
  mb.box(M.mattress, [-w / 2 + 0.08, -d / 2 + 0.08, 0.9], [w / 2 - 0.08, d / 2 - 0.08, 0.95]);
  // clear hood with hand ports
  const top = h - 0.15;
  mb.box(M.hood, [-w / 2 + 0.03, -d / 2 + 0.03, 0.9], [w / 2 - 0.03, d / 2 - 0.03, top]);
  for (const x of [-0.18, 0.18]) mb.with(m4.mul(m4.translation(x, -d / 2 + 0.028, 1.05), m4.rotationX(Math.PI / 2)), () => mb.cylinder(M.frame, [0, 0, -0.005], 0.06, 0.06, 0.01, 16));
  mb.box(M.body, [-w / 2 + 0.1, d / 2 - 0.12, top], [w / 2 - 0.1, d / 2 - 0.02, h]);
}

function buildDialysisMachine(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  castors(mb, M.castors, w, d, 0.06, 0.05);
  mb.box(M.body, [-w / 2, -d / 2 + 0.05, 0.1], [w / 2, d / 2, h * 0.75]);
  display(mb, M.body, M.screen, 0, -d / 2 + 0.15, h * 0.75, w * 0.85, h * 0.2, 0.06);
  for (const [x, z] of [[-0.12, 0.55], [0.12, 0.55], [0, 0.8]] as Vec2[]) mb.with(m4.mul(m4.translation(x, -d / 2 + 0.05, z), m4.rotationX(Math.PI / 2)), () => mb.cylinder(M.pumps, [0, 0, 0], 0.06, 0.06, 0.03, 16));
  mb.cylinder(M.filter, [w / 2 - 0.08, -d / 2 + 0.02, 0.6], 0.03, 0.03, 0.3, 12);
  mb.cylinder(M.frame, [-w / 2 + 0.04, 0, h * 0.75], 0.012, 0.012, h * 0.25, 8);
}

function buildPatientLift(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  // U base (open at the front), mast at the back, boom forward with a spreader bar
  for (const sx of [-1, 1]) {
    mb.box(M.frame, [sx * (w / 2) - 0.03 - sx * 0.03, -d / 2, 0.06], [sx * (w / 2) + 0.03 - sx * 0.03, d / 2, 0.11]);
    castor(mb, M.castors, sx * (w / 2 - 0.03), -d / 2 + 0.05, 0.04);
    castor(mb, M.castors, sx * (w / 2 - 0.03), d / 2 - 0.05, 0.04);
  }
  mb.box(M.frame, [-w / 2, d / 2 - 0.1, 0.06], [w / 2, d / 2, 0.11]);
  mb.box(M.frame, [-0.04, d / 2 - 0.12, 0.11], [0.04, d / 2 - 0.04, h - 0.05]);
  mb.rod(M.frame, [0, d / 2 - 0.08, h - 0.08], [0, -d / 2 + 0.15, h - 0.25], 0.03);
  mb.rod(M.frame, [0, d / 2 - 0.08, h * 0.5], [0, d / 2 - 0.35, h - 0.15], 0.025); // actuator
  mb.rod(M.frame, [0, -d / 2 + 0.15, h - 0.25], [0, -d / 2 + 0.15, h - 0.45], 0.01);
  mb.rod(M.frame, [-0.25, -d / 2 + 0.15, h - 0.45], [0.25, -d / 2 + 0.15, h - 0.45], 0.015);
  mb.box(M.body, [-0.1, d / 2 - 0.2, h * 0.35], [0.1, d / 2 - 0.12, h * 0.45]);
}

// ---------------------------------------------------------------------------
// imaging

function buildCtScanner(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  // gantry at the back (+y) facing -y, couch running out toward the front through the bore
  const gd = clamp(d * 0.2, 0.7, 1.0);
  const gy0 = d / 2 - gd;
  const bore = clamp(h * 0.36, 0.35, 0.42);
  const cz = h * 0.55;
  const R = Math.min(w / 2, cz, h - cz);
  mb.with(m4.mul(m4.translation(0, gy0, cz), m4.rotationX(-Math.PI / 2)), () => {
    // the gantry ring, lathed around the y axis: front face, outer shell, back face, bore
    mb.lathe([[bore, 0], [R, 0], [R, gd], [bore, gd], [bore, 0]], (i) => (i === 3 ? M.bore : M.body), [0, 0, 0], 48);
  });
  mb.box(M.body, [-w / 2 + 0.1, gy0 + 0.1, 0], [w / 2 - 0.1, d / 2 - 0.05, cz - R + 0.2]);
  mb.box(M.trim, [-w / 2 * 0.5, gy0 - 0.005, cz + bore + 0.1], [w / 2 * 0.5, gy0, cz + bore + 0.22]);
  // couch: pedestal and a long cradle reaching into the bore
  const ct = cz - bore + 0.08;
  mb.box(M.body, [-0.25, -d / 2 + 0.3, 0], [0.25, gy0 - 0.15, ct - 0.12]);
  mb.box(M.couch, [-0.22, -d / 2, ct - 0.12], [0.22, gy0 + gd * 0.6, ct - 0.02]);
  mb.box(M.pad, [-0.2, -d / 2 + 0.05, ct - 0.02], [0.2, gy0 - 0.1, ct + 0.04]);
}

function buildMriScanner(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const md = clamp(d * 0.36, 1.4, 1.9);
  const my0 = d / 2 - md;
  const bore = 0.35;
  const cz = clamp(h * 0.47, 0.95, 1.15);
  // magnet: a big cylinder lathed around the y axis with the bore through it, on a plinth, a cover band on top
  const R = Math.min(w / 2, cz, h - cz);
  mb.with(m4.mul(m4.translation(0, my0, cz), m4.rotationX(-Math.PI / 2)), () => {
    mb.lathe([[bore, 0], [R, 0], [R, md], [bore, md], [bore, 0]], (i) => (i === 3 ? M.bore : M.body), [0, 0, 0], 48);
  });
  mb.box(M.body, [-w / 2 + 0.15, my0 + 0.1, 0], [w / 2 - 0.15, d / 2 - 0.05, cz - R + 0.25]);
  mb.box(M.trim, [-R * 0.6, my0 + 0.3, cz + R - 0.02], [R * 0.6, d / 2 - 0.3, Math.min(h, cz + R + 0.12)]);
  // patient table
  const tz = cz - bore + 0.12;
  mb.box(M.body, [-0.3, -d / 2 + 0.2, 0], [0.3, my0, tz - 0.15]);
  mb.box(M.couch, [-0.28, -d / 2, tz - 0.15], [0.28, my0 + md * 0.5, tz - 0.05]);
  mb.box(M.pad, [-0.25, -d / 2 + 0.05, tz - 0.05], [0.25, my0 - 0.05, tz + 0.02]);
}

function buildXrayMachine(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  // radiography table along x, floor-mounted tube column behind it (+y) with an arm reaching over the table
  const th = 0.75, tw = Math.min(d * 0.6, 0.8);
  const ty = -d / 2 + tw / 2;
  mb.box(M.body, [-w / 2 * 0.4, ty - 0.2, 0], [w / 2 * 0.4, ty + 0.2, th - 0.06]);
  mb.box(M.couch, [-w / 2, ty - tw / 2, th - 0.06], [w / 2, ty + tw / 2, th]);
  mb.box(M.body, [-w / 2 * 0.95, ty - tw / 2 + 0.05, th - 0.16], [w / 2 * 0.95, ty + tw / 2 - 0.05, th - 0.06]); // bucky tray
  // rail and column
  mb.box(M.frame, [-w / 2, d / 2 - 0.15, 0], [w / 2, d / 2, 0.06]);
  mb.box(M.frame, [-0.09, d / 2 - 0.2, 0.06], [0.09, d / 2 - 0.02, h]);
  mb.box(M.frame, [-0.05, ty, h - 0.45], [0.05, d / 2 - 0.2, h - 0.35]);
  mb.box(M.body, [-0.18, ty - 0.15, h - 0.75], [0.18, ty + 0.15, h - 0.45]); // tube head
  mb.box(M.trim, [-0.13, ty - 0.13, h - 0.85], [0.13, ty + 0.13, h - 0.75]); // collimator
}

function buildUltrasoundMachine(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  castors(mb, M.castors, w, d, 0.06, 0.05);
  mb.box(M.body, [-w / 2 + 0.04, -d / 2 + 0.2, 0.1], [w / 2 - 0.04, d / 2, 0.8]);
  mb.box(M.body, [-w / 2, -d / 2, 0.8], [w / 2, d / 2 - 0.1, 0.9]); // console with keyboard
  mb.box(M.keys, [-w / 2 + 0.05, -d / 2 + 0.05, 0.9], [w / 2 - 0.05, -d / 2 + 0.3, 0.905]);
  for (const sx of [-1, 1]) mb.box(M.body, [sx * (w / 2 - 0.04) - 0.03, -d / 2 + 0.05, 0.85], [sx * (w / 2 - 0.04) + 0.03, -d / 2 + 0.12, 0.98]); // probe holders
  mb.box(M.body, [-0.04, d / 2 - 0.2, 0.9], [0.04, d / 2 - 0.12, h - 0.4]);
  display(mb, M.body, M.screen, 0, d / 2 - 0.25, h - 0.42, Math.min(w * 0.9, 0.55), 0.38, 0.05);
}

// ---------------------------------------------------------------------------
// laboratories, pharmacy, sterile services

function buildLabBench(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const top = clamp(h * 0.62, 0.75, 0.95);
  // C-frame steel legs, resin top, cabinets under, reagent shelf with a service spine
  mb.box(M.top, [-w / 2, -d / 2, top - 0.025], [w / 2, d / 2, top]);
  for (const x of [-w / 2 + 0.05, w / 2 - 0.05]) {
    mb.box(M.frame, [x - 0.025, d / 2 - 0.08, 0], [x + 0.025, d / 2 - 0.03, top - 0.025]);
    mb.box(M.frame, [x - 0.025, -d / 2 + 0.08, top - 0.08], [x + 0.025, d / 2 - 0.03, top - 0.025]);
  }
  const n = Math.max(1, Math.floor(w / 1.2));
  for (let i = 0; i < n; i++) {
    const x0 = -w / 2 + 0.1 + (i * (w - 0.2)) / n, x1 = x0 + Math.min(0.6, (w - 0.2) / n - 0.05);
    mb.box(M.body, [x0, -d / 2 + 0.08, 0.1], [x1, d / 2 - 0.1, top - 0.1]);
    drawers(mb, M.body, M.handles, x0, x1, -d / 2 + 0.08, 0.1, top - 0.1, 3);
  }
  if (opt(s, "shelf", true) && h > top + 0.3) {
    mb.box(M.frame, [-w / 2, d / 2 - 0.1, top], [w / 2, d / 2, top + 0.2]); // spine with sockets / gases
    for (const x of [-w / 2 + 0.05, w / 2 - 0.05]) mb.box(M.frame, [x - 0.015, d / 2 - 0.05, top + 0.2], [x + 0.015, d / 2 - 0.02, h]);
    mb.box(M.shelf, [-w / 2, d / 2 - 0.32, h - 0.35], [w / 2, d / 2 - 0.02, h - 0.33]);
  }
  if (opt(s, "sink", false)) mb.box(M.sink, [w / 2 - 0.55, -d / 2 + 0.15, top - 0.2], [w / 2 - 0.15, d / 2 - 0.15, top + 0.001]);
}

function buildFumeHood(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  const top = 0.9;
  mb.box(M.body, [-w / 2, -d / 2 + 0.05, 0], [w / 2, d / 2, top - 0.03]);
  drawers(mb, M.body, M.handles, -w / 2, w / 2, -d / 2 + 0.05, 0.08, top - 0.05, 1);
  mb.box(M.top, [-w / 2, -d / 2, top - 0.03], [w / 2, d / 2, top]);
  // enclosure: sides, back, top, lit header, sash window
  for (const sx of [-1, 1]) mb.box(M.body, [sx > 0 ? w / 2 - 0.1 : -w / 2, -d / 2, top], [sx > 0 ? w / 2 : -w / 2 + 0.1, d / 2, h]);
  mb.box(M.body, [-w / 2 + 0.1, d / 2 - 0.05, top], [w / 2 - 0.1, d / 2, h]);
  mb.box(M.body, [-w / 2 + 0.1, -d / 2, h - 0.35], [w / 2 - 0.1, d / 2 - 0.05, h]);
  mb.box(M.glass, [-w / 2 + 0.1, -d / 2 + 0.02, top + 0.45], [w / 2 - 0.1, -d / 2 + 0.03, h - 0.35]);
  mb.box(M.frame, [-w / 2 + 0.1, -d / 2 + 0.01, top + 0.43], [w / 2 - 0.1, -d / 2 + 0.035, top + 0.47]);
}

function buildBiosafetyCabinet(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  // on a stand; work zone with a sloped sash, filter housing on top
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) mb.box(M.frame, [sx * (w / 2 - 0.06) - 0.025, sy * (d / 2 - 0.08) - 0.025, 0], [sx * (w / 2 - 0.06) + 0.025, sy * (d / 2 - 0.08) + 0.025, 0.7]);
  const z0 = 0.7;
  mb.box(M.body, [-w / 2, -d / 2 + 0.1, z0], [w / 2, d / 2, z0 + 0.15]);
  for (const sx of [-1, 1]) mb.box(M.body, [sx > 0 ? w / 2 - 0.06 : -w / 2, -d / 2 + 0.1, z0 + 0.15], [sx > 0 ? w / 2 : -w / 2 + 0.06, d / 2, h - 0.4]);
  mb.box(M.body, [-w / 2 + 0.06, d / 2 - 0.08, z0 + 0.15], [w / 2 - 0.06, d / 2, h - 0.4]);
  mb.with(m4.mul(m4.translation(0, -d / 2 + 0.1, z0 + 0.35), m4.rotationX(-0.18)), () => mb.box(M.glass, [-w / 2 + 0.06, -0.01, 0], [w / 2 - 0.06, 0, h - 0.4 - z0 - 0.35]));
  mb.box(M.body, [-w / 2, -d / 2 + 0.05, h - 0.4], [w / 2, d / 2, h]);
  display(mb, M.body, M.screen, w / 2 - 0.25, -d / 2 + 0.05, h - 0.3, 0.2, 0.12, 0.01);
}

function buildAutoclave(mb: MeshBuilder, s: FurnitureSpec) {
  const { width: w, depth: d, height: h } = s;
  const M = s.materials;
  // floor-standing steam steriliser: cabinet with a round chamber door on the front
  mb.box(M.body, [-w / 2, -d / 2 + 0.03, 0], [w / 2, d / 2, h]);
  const r = Math.min(w, h) * 0.3;
  mb.with(m4.mul(m4.translation(0, -d / 2 + 0.075, h * 0.6), m4.rotationX(Math.PI / 2)), () => {
    mb.cylinder(M.door, [0, 0, 0], r, r, 0.03, 32);
    mb.cylinder(M.handles, [0, 0, 0.03], r * 0.25, r * 0.25, 0.04, 16);
  });
  display(mb, M.body, M.screen, 0, -d / 2 + 0.03, h - 0.2, w * 0.5, 0.12, 0.01);
  mb.box(M.door, [-w / 2 + 0.03, -d / 2, 0.05], [w / 2 - 0.03, -d / 2 + 0.03, h * 0.3]);
}

// ---------------------------------------------------------------------------

const BODY = "plastic_white", FRAME = "metal_white", WHEEL = "rubber_black", SCREEN = "screen_black";

/** Medical types (wrapped by furniture.ts' `def`, which fills sizes, slots and options). */
export const MEDICAL_FURNITURE: Record<string, FurnitureType> = {
  hospital_bed: {
    description: "Electric hospital / ICU bed (head at +y): castors, lifting column, profiling mattress, head and foot boards, split side rails. options: backrest (degrees, default 30), rails. Standard 2.2 × 1.0 m; keep 1.2 m+ clear doors and turning space.",
    defaults: { width: 1.0, depth: 2.2, height: 1.0 },
    slots: { frame: FRAME, mattress: "fabric_blue", linen: "linen_white", boards: "plastic_gray", castors: WHEEL },
    options: { backrest: { description: "Backrest angle, degrees (0 = flat)", default: 30 }, rails: { description: "Side rails up", default: true } },
    build: buildHospitalBed,
  },
  patient_monitor: {
    description: "Vital-signs monitor on a castor stand (screen facing -y); options.mount 'wall' gives a wall arm (back at +y, set elevation ~1.4).",
    defaults: { width: 0.5, depth: 0.5, height: 1.5 },
    slots: { frame: FRAME, screen: SCREEN, castors: WHEEL },
    options: { mount: { description: "stand | wall", default: "stand" } },
    build: buildPatientMonitor,
  },
  iv_stand: {
    description: "IV drip stand: five-castor base, pole with four hooks, a bag and an infusion pump (options.bag false for a bare pole).",
    defaults: { width: 0.6, depth: 0.6, height: 2.0 },
    slots: { frame: "chrome", bag: "glass_frosted", castors: WHEEL },
    options: { bag: { description: "Fluid bag and infusion pump", default: true } },
    build: buildIvStand,
  },
  overbed_table: {
    description: "Overbed table: C-frame on castors (column at +x) with a top that slides over the bed.",
    defaults: { width: 0.9, depth: 0.45, height: 0.95 },
    slots: { top: "melamine_white", frame: FRAME, castors: WHEEL },
    build: buildOverbedTable,
  },
  bedside_cabinet: {
    description: "Hospital bedside locker on castors: drawer over a door.",
    defaults: { width: 0.5, depth: 0.5, height: 0.85 },
    slots: { body: "melamine_white", top: "plastic_gray", fronts: "lacquer_blue_gray", handles: "metal_steel", castors: WHEEL },
    build: buildBedsideCabinet,
  },
  bedhead_unit: {
    description: "Bedhead services trunking on the wall behind a bed (back at +y): medical gas outlets, sockets, reading light. Set elevation ~1.4 and the width of the bed space.",
    defaults: { width: 1.6, depth: 0.1, height: 0.3 },
    slots: { body: "metal_white", outlets: "plastic_green", sockets: BODY, light: "emissive_light", metal: "chrome" },
    build: buildBedheadUnit,
  },
  privacy_curtain: {
    description: "Cubicle curtain on a ceiling track round a bed space (height = to the ceiling). options.shape 'u' (default, three sides, open toward +y wall), 'l', 'straight'; options.open 0..1 draws the front run back.",
    defaults: { width: 2.6, depth: 2.6, height: 2.7 },
    slots: { curtain: "fabric_sage", mesh: "sheer_white", track: "metal_aluminum" },
    options: { shape: { description: "u | l | straight", default: "u" }, open: { description: "How far the front run is drawn back, 0..1", default: 0.15 } },
    build: buildPrivacyCurtain,
  },
  patient_recliner: {
    description: "Treatment recliner (dialysis, chemotherapy, day care, recovery) on castors, reclined with the leg rest up.",
    defaults: { width: 0.8, depth: 1.0, height: 1.15 },
    slots: { upholstery: "leather_gray", frame: FRAME, castors: WHEEL },
    build: buildPatientRecliner,
  },
  wheelchair: {
    description: "Manual wheelchair (front toward -y): 0.65 × 1.05 m; turning circle 1.5 m.",
    defaults: { width: 0.65, depth: 1.05, height: 0.9 },
    slots: { frame: "chrome", seat: "fabric_charcoal", tyres: WHEEL },
    build: buildWheelchair,
  },
  stretcher: {
    description: "Patient trolley / stretcher (head at +y) with side rails, 0.7 × 2.0 m.",
    defaults: { width: 0.7, depth: 2.0, height: 0.85 },
    slots: { frame: FRAME, mattress: "fabric_blue", linen: "linen_white", castors: WHEEL },
    build: buildStretcher,
  },
  patient_lift: {
    description: "Mobile patient hoist: U base open to the front (-y), mast, boom and spreader bar.",
    defaults: { width: 0.7, depth: 1.25, height: 1.9 },
    slots: { frame: FRAME, body: "plastic_gray", castors: WHEEL },
    build: buildPatientLift,
  },
  examination_table: {
    description: "Examination couch along x with the head end raised at +x (height = to the top of the head section; the couch is ~0.2 m lower), drawers, paper roll.",
    defaults: { width: 1.9, depth: 0.7, height: 0.95 },
    slots: { upholstery: "leather_gray", body: "melamine_white", frame: FRAME, paper: "paper_white", handles: "metal_steel" },
    build: buildExaminationTable,
  },
  medical_cart: {
    description: "Procedure / crash / medication cart: drawers, rimmed work top, push handles (options.drawers). Red fronts make a crash cart: materials {fronts:'paint_red'}.",
    defaults: { width: 0.75, depth: 0.5, height: 1.05 },
    slots: { body: "plastic_gray", top: BODY, fronts: "paint_powder_blue", handles: "metal_steel", castors: WHEEL },
    options: { drawers: { description: "Number of drawers", default: 5 } },
    build: buildMedicalCart,
  },
  defibrillator: {
    description: "Wall AED cabinet (back at +y); set elevation ~1.0.",
    defaults: { width: 0.4, depth: 0.2, height: 0.45 },
    slots: { body: BODY, door: "glass_frosted", sign: "plastic_green" },
    build: buildDefibrillator,
  },
  scrub_sink: {
    description: "Surgical scrub trough with splash panel and sensor taps (one per station, options.stations); plumbed like a basin.",
    defaults: { width: 1.6, depth: 0.65, height: 1.6 },
    slots: { body: "metal_steel", taps: "chrome", legs: "metal_steel" },
    options: { stations: { description: "Tap stations (default one per 0.75 m)", default: undefined } },
    build: buildScrubSink,
  },
  medicine_cabinet: {
    description: "Tall drug / supplies cabinet: drawers below, glazed doors over shelves above (pharmacy, clean utility, nurse station).",
    defaults: { width: 1.0, depth: 0.45, height: 2.0 },
    slots: { body: "melamine_white", glass: "glass", handles: "metal_steel" },
    build: buildMedicineCabinet,
  },
  exam_lamp: {
    description: "Mobile examination lamp on a castor base, head reaching forward (-y).",
    defaults: { width: 0.55, depth: 0.7, height: 1.8 },
    slots: { frame: FRAME, light: "emissive_light", castors: WHEEL },
    build: buildExamLamp,
  },
  dental_chair: {
    description: "Dental treatment unit (head at +y): chair, spittoon unit and light post on the left (-x), instrument tray on the right.",
    defaults: { width: 1.6, depth: 2.0, height: 2.0 },
    slots: { upholstery: "leather_white", frame: BODY, bowl: "ceramic_white", light: "emissive_light" },
    build: buildDentalChair,
  },
  operating_table: {
    description: "Operating table (head at +y): base plate, column, four-section padded top, side rails. Keep ~3 m clear around it for the team.",
    defaults: { width: 0.55, depth: 2.1, height: 0.9 },
    slots: { frame: "metal_steel", pad: "fabric_navy", metal: "chrome" },
    build: buildOperatingTable,
  },
  surgical_light: {
    description: "Ceiling surgical light: hangs from the ceiling (height = drop; set elevation = ceiling height − height), 1–3 domes on arms (options.heads).",
    defaults: { width: 1.6, depth: 1.6, height: 1.0 },
    slots: { frame: BODY, light: "emissive_light" },
    options: { heads: { description: "Light heads, 1–3", default: 2 } },
    build: buildSurgicalLight,
  },
  medical_pendant: {
    description: "Ceiling service pendant (theatre / ICU) with shelves, gas outlets and sockets: hangs from the ceiling to the floor-ish (height = ceiling − 0.9 m clear, set elevation 0.9).",
    defaults: { width: 0.6, depth: 0.6, height: 2.0 },
    slots: { frame: BODY, body: "metal_white", shelf: "plastic_gray", outlets: "plastic_green", sockets: BODY },
    build: buildMedicalPendant,
  },
  anesthesia_machine: {
    description: "Anaesthesia workstation on castors: drawers, work shelf, flowmeters, bellows, screen, gas cylinders at the back.",
    defaults: { width: 0.8, depth: 0.75, height: 1.45 },
    slots: { body: BODY, top: "plastic_gray", screen: SCREEN, glass: "glass", handles: "metal_steel", cylinders: "paint_off_white", castors: WHEEL },
    build: buildAnesthesiaMachine,
  },
  ventilator: {
    description: "ICU ventilator on a castor stand with screen and patient circuit.",
    defaults: { width: 0.55, depth: 0.55, height: 1.35 },
    slots: { body: BODY, frame: FRAME, screen: SCREEN, tubing: "plastic_white", castors: WHEEL },
    build: buildVentilator,
  },
  infant_incubator: {
    description: "Neonatal incubator: cabinet on a column and castors, clear hood with hand ports.",
    defaults: { width: 1.0, depth: 0.6, height: 1.45 },
    slots: { body: BODY, frame: FRAME, mattress: "fabric_white", hood: "glass", handles: "metal_steel", castors: WHEEL },
    build: buildInfantIncubator,
  },
  dialysis_machine: {
    description: "Haemodialysis machine: cabinet with blood pumps, filter and screen; pair with patient_recliner or hospital_bed.",
    defaults: { width: 0.5, depth: 0.6, height: 1.55 },
    slots: { body: BODY, frame: FRAME, screen: SCREEN, pumps: "plastic_gray", filter: "glass_frosted", castors: WHEEL },
    build: buildDialysisMachine,
  },
  ct_scanner: {
    description: "CT scanner: gantry at the back (+y) with its bore facing -y, couch running out toward the front. Room ~6.5 × 4.5 m plus a control room; shielding from the vendor's planning guide.",
    defaults: { width: 2.2, depth: 4.6, height: 1.95 },
    slots: { body: BODY, bore: "plastic_gray", trim: "paint_powder_blue", couch: "plastic_gray", pad: "fabric_navy" },
    build: buildCtScanner,
  },
  mri_scanner: {
    description: "MRI scanner: magnet at the back (+y) with its bore facing -y, patient table toward the front. Needs an RF-shielded room (~7 × 5 m), equipment room and controlled access zones.",
    defaults: { width: 2.3, depth: 5.0, height: 2.4 },
    slots: { body: BODY, bore: "plastic_gray", trim: "paint_powder_blue", couch: "plastic_gray", pad: "fabric_navy" },
    build: buildMriScanner,
  },
  xray_machine: {
    description: "Radiography room set: table along x at the front, floor rail and tube column behind it (+y) with the tube over the table.",
    defaults: { width: 2.4, depth: 1.6, height: 2.2 },
    slots: { body: BODY, frame: "metal_steel", couch: "plastic_gray", trim: "plastic_black" },
    build: buildXrayMachine,
  },
  ultrasound_machine: {
    description: "Ultrasound scanner cart: console with keyboard and probe holders (operator at -y), screen on a post.",
    defaults: { width: 0.55, depth: 0.85, height: 1.5 },
    slots: { body: BODY, keys: "plastic_gray", screen: SCREEN, castors: WHEEL },
    build: buildUltrasoundMachine,
  },
  lab_bench: {
    description: "Laboratory bench: chemical-resistant top on a steel C-frame, cabinets under, service spine and reagent shelf (options.shelf, options.sink).",
    defaults: { width: 3.0, depth: 0.75, height: 1.5 },
    slots: { top: "quartz_black", frame: "metal_gunmetal", body: "melamine_white", shelf: "glass", handles: "metal_steel", sink: "ceramic_black" },
    options: { shelf: { description: "Service spine and reagent shelf", default: true }, sink: { description: "Bench sink at the +x end", default: false } },
    build: buildLabBench,
  },
  fume_hood: {
    description: "Chemical fume hood on a base cabinet: enclosure, sash, lit header (its exhaust is ducted to the roof).",
    defaults: { width: 1.5, depth: 0.85, height: 2.4 },
    slots: { body: BODY, top: "quartz_black", glass: "glass", frame: "metal_steel", handles: "metal_steel" },
    build: buildFumeHood,
  },
  biosafety_cabinet: {
    description: "Class II biosafety cabinet on a stand: work zone, sloped sash, filter housing and display.",
    defaults: { width: 1.3, depth: 0.8, height: 2.1 },
    slots: { body: BODY, frame: "metal_steel", glass: "glass", screen: SCREEN },
    build: buildBiosafetyCabinet,
  },
  autoclave: {
    description: "Floor-standing steam steriliser (CSSD, labs): cabinet with a round chamber door and control panel on the front.",
    defaults: { width: 0.8, depth: 0.9, height: 1.7 },
    slots: { body: "metal_steel", door: "metal_aluminum", handles: "chrome", screen: SCREEN },
    build: buildAutoclave,
  },
};

/** Type groups other modules check (layout rules, services, export, cost). */
export const MEDICAL = {
  /** Patient beds: count as bedrooms for sockets and loads. */
  beds: new Set(["hospital_bed"]),
  /** Hang from the ceiling: never block a floor, never collide. */
  overhead: new Set(["surgical_light", "medical_pendant"]),
  /** On a wall, back at +y. */
  wallMounted: new Set(["bedhead_unit", "defibrillator"]),
  /** Things that surround a bed rather than collide with it. */
  surrounds: new Set(["privacy_curtain"]),
  /** Round, no front to face the room. */
  noFront: new Set(["iv_stand", "privacy_curtain"]),
  /** Fine in front of a window. */
  windowOk: new Set(["privacy_curtain", "iv_stand", "patient_monitor", "wheelchair"]),
  /** Tall but see-through: no socket is hidden behind them. */
  slim: new Set(["iv_stand", "privacy_curtain", "patient_monitor", "exam_lamp", "ventilator", "patient_lift", "wheelchair"]),
};
