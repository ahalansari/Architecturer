/**
 * Visual check for src/elements/furniture.ts (throwaway rasterizer, no deps beyond pngjs).
 *
 *   npx tsx scripts/furniture-preview.ts                # all outputs
 *   npx tsx scripts/furniture-preview.ts sofa bed       # + 4-view close-ups of these types
 *
 * Writes:
 *   out/furniture.obj/.mtl       all types in a grid (Y-up OBJ; plan -Y front faces the OBJ +Z)
 *   out/furniture.png            isometric overview of the whole grid
 *   out/furniture_sheet.png      contact sheet, one tile per type, viewed from the front-left
 *   out/furniture_sheet_back.png same, viewed from the back-right
 *   out/furniture_sheet_stretched.png  front-left, every type at 1.6x width, 0.8x depth, 1.25x height
 *   out/furniture_<type>.png     close-ups (front / front-left iso / back-right iso / top)
 * Back faces render MAGENTA, so inverted or missing faces are easy to spot.
 * Also prints bounds violations (geometry outside [-w/2,w/2]x[-d/2,d/2]x[0,h]).
 */
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { FURNITURE } from "../src/elements/furniture.js";
import { MeshBuilder, type MeshData } from "../src/geometry/mesh.js";
import { m4, type Vec3 } from "../src/geometry/math.js";

const OUT = path.resolve("out");
fs.mkdirSync(OUT, { recursive: true });

// ---------------- colors ----------------
const COLORS: Record<string, [number, number, number]> = {
  wood_oak: [190, 145, 90], wood_walnut: [115, 72, 45], wood_painted_white: [232, 229, 220],
  metal_steel: [168, 174, 180], metal_black: [50, 50, 54], metal_brass: [205, 165, 75], chrome: [205, 212, 220],
  glass: [160, 205, 230], glass_frosted: [220, 232, 238], fabric_gray: [128, 128, 135], fabric_blue: [60, 92, 155],
  fabric_beige: [212, 192, 158], fabric_red: [170, 50, 45], leather_brown: [125, 78, 45], leather_black: [38, 35, 33],
  carpet_beige: [200, 180, 145], carpet_gray: [105, 105, 112], linen_white: [246, 244, 238], ceramic_white: [250, 250, 252],
  plastic_white: [238, 238, 238], plastic_black: [32, 32, 35], rubber_black: [24, 24, 24], marble_white: [232, 232, 226],
  marble_black: [40, 40, 42], tiles_white: [240, 240, 240], mirror: [195, 220, 235], emissive_light: [255, 236, 160],
  plant_green: [70, 135, 52], concrete: [150, 150, 145], stone_gray: [122, 122, 118],
};
function colorOf(mat: string): [number, number, number] {
  if (COLORS[mat]) return COLORS[mat];
  let hsh = 2166136261;
  for (const c of mat) hsh = Math.imul(hsh ^ c.charCodeAt(0), 16777619);
  return [64 + (hsh & 127), 64 + ((hsh >> 8) & 127), 64 + ((hsh >> 16) & 127)];
}
const isGlass = (m: string) => m.startsWith("glass");
const isEmissive = (m: string) => m.startsWith("emissive");

// ---------------- geometry ----------------
interface Tri { a: Vec3; b: Vec3; c: Vec3; mat: string }

function trisOf(meshes: MeshData[], xf?: (p: Vec3) => Vec3): Tri[] {
  const out: Tri[] = [];
  for (const m of meshes) {
    const P = (i: number): Vec3 => {
      const p: Vec3 = [m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]];
      return xf ? xf(p) : p;
    };
    for (let i = 0; i < m.indices.length; i += 3) out.push({ a: P(m.indices[i]), b: P(m.indices[i + 1]), c: P(m.indices[i + 2]), mat: m.material });
  }
  return out;
}

function buildType(type: string, dims?: { width: number; depth: number; height: number }, options: Record<string, unknown> = {}) {
  const t = FURNITURE[type];
  const mb = new MeshBuilder();
  t.build(mb, { ...(dims ?? t.defaults), materials: {}, options });
  return mb.meshes();
}

function bounds(tris: Tri[]) {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const t of tris) for (const p of [t.a, t.b, t.c]) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); }
  return { min, max };
}

// ---------------- rasterizer ----------------
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

interface View { dir: Vec3; center: Vec3; halfH: number } // ortho camera looking along dir

class Img {
  rgb: Float32Array;
  depth: Float32Array;
  nrm: Float32Array;
  constructor(public w: number, public h: number, bg: [number, number, number]) {
    this.rgb = new Float32Array(w * h * 3);
    this.depth = new Float32Array(w * h).fill(Infinity);
    this.nrm = new Float32Array(w * h * 3);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const k = (y * w + x) * 3, f = 1 - (y / h) * 0.12;
        this.rgb[k] = bg[0] * f; this.rgb[k + 1] = bg[1] * f; this.rgb[k + 2] = bg[2] * f;
      }
  }
}

function render(tris: Tri[], view: View, W: number, H: number, floor = true): Img {
  const SS = 2;
  const w = W * SS, h = H * SS;
  const img = new Img(w, h, [236, 238, 242]);
  const f = norm(view.dir);
  const r = norm(cross(f, [0, 0, 1]));
  const u = cross(r, f);
  const scale = h / 2 / view.halfH;
  const proj = (p: Vec3): Vec3 => {
    const q = sub(p, view.center);
    return [w / 2 + dot(q, r) * scale, h / 2 - dot(q, u) * scale, dot(q, f)];
  };
  const L1 = norm([-0.45, -0.75, 0.9]), L2 = norm([0.6, 0.4, 0.3]);
  const all = [...tris];
  if (floor) {
    const b = bounds(tris);
    const e = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1]) * 0.25 + 0.3;
    const z = -0.0005;
    const A: Vec3 = [b.min[0] - e, b.min[1] - e, z], B: Vec3 = [b.max[0] + e, b.min[1] - e, z], C: Vec3 = [b.max[0] + e, b.max[1] + e, z], D: Vec3 = [b.min[0] - e, b.max[1] + e, z];
    all.push({ a: A, b: B, c: C, mat: "__floor" }, { a: A, b: C, c: D, mat: "__floor" });
  }
  const pass = (glass: boolean) => {
    for (const t of all) {
      if (isGlass(t.mat) !== glass) continue;
      const n = norm(cross(sub(t.b, t.a), sub(t.c, t.a)));
      if (!isFinite(n[0])) continue;
      const back = dot(n, f) > 0;
      let col: [number, number, number];
      if (t.mat === "__floor") {
        col = [205, 200, 190];
      } else if (back && !glass) {
        col = [255, 0, 255];
      } else {
        const base = colorOf(t.mat);
        const nn: Vec3 = back ? [-n[0], -n[1], -n[2]] : n;
        const k = isEmissive(t.mat) ? 1.0 : 0.38 + 0.55 * Math.max(0, dot(nn, L1)) + 0.15 * Math.max(0, dot(nn, L2));
        col = [base[0] * k, base[1] * k, base[2] * k];
      }
      const pa = proj(t.a), pb = proj(t.b), pc = proj(t.c);
      const x0 = Math.max(0, Math.floor(Math.min(pa[0], pb[0], pc[0]))), x1 = Math.min(w - 1, Math.ceil(Math.max(pa[0], pb[0], pc[0])));
      const y0 = Math.max(0, Math.floor(Math.min(pa[1], pb[1], pc[1]))), y1 = Math.min(h - 1, Math.ceil(Math.max(pa[1], pb[1], pc[1])));
      const area = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0]);
      if (Math.abs(area) < 1e-9) continue;
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const px = x + 0.5, py = y + 0.5;
          const w0 = ((pb[0] - px) * (pc[1] - py) - (pb[1] - py) * (pc[0] - px)) / area;
          const w1 = ((pc[0] - px) * (pa[1] - py) - (pc[1] - py) * (pa[0] - px)) / area;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const z = w0 * pa[2] + w1 * pb[2] + w2 * pc[2];
          const i = y * w + x;
          if (z >= img.depth[i] - (t.mat === "__floor" ? 0 : 1e-6)) continue;
          if (glass) {
            const k = i * 3;
            img.rgb[k] = img.rgb[k] * 0.6 + col[0] * 0.4; img.rgb[k + 1] = img.rgb[k + 1] * 0.6 + col[1] * 0.4; img.rgb[k + 2] = img.rgb[k + 2] * 0.6 + col[2] * 0.4;
          } else {
            img.depth[i] = z;
            img.rgb[i * 3] = col[0]; img.rgb[i * 3 + 1] = col[1]; img.rgb[i * 3 + 2] = col[2];
            img.nrm[i * 3] = n[0]; img.nrm[i * 3 + 1] = n[1]; img.nrm[i * 3 + 2] = n[2];
          }
        }
    }
  };
  pass(false);
  // outlines on depth / normal discontinuities
  const edge = new Uint8Array(w * h);
  const dthr = 0.03;
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      for (const j of [i + 1, i + w]) {
        const da = img.depth[i], db = img.depth[j];
        let e = false;
        if (isFinite(da) !== isFinite(db)) e = true;
        else if (isFinite(da) && Math.abs(da - db) > dthr) e = true;
        else if (isFinite(da) && img.nrm[i * 3] * img.nrm[j * 3] + img.nrm[i * 3 + 1] * img.nrm[j * 3 + 1] + img.nrm[i * 3 + 2] * img.nrm[j * 3 + 2] < 0.85) e = true;
        if (e) edge[i] = 1;
      }
    }
  for (let i = 0; i < w * h; i++) if (edge[i]) for (let k = 0; k < 3; k++) img.rgb[i * 3 + k] *= 0.55;
  pass(true);
  // downsample
  const out = new Img(W, H, [0, 0, 0]);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      for (let k = 0; k < 3; k++) {
        let s = 0;
        for (let dy = 0; dy < SS; dy++) for (let dx = 0; dx < SS; dx++) s += img.rgb[((y * SS + dy) * w + x * SS + dx) * 3 + k];
        out.rgb[(y * W + x) * 3 + k] = s / (SS * SS);
      }
  return out;
}

function fitView(tris: Tri[], dir: Vec3, margin = 1.12): View {
  const b = bounds(tris);
  const center: Vec3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
  const f = norm(dir), r = norm(cross(f, [0, 0, 1])), u = cross(r, f);
  let hx = 0, hy = 0;
  for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) {
    const q = sub([x, y, z], center);
    hx = Math.max(hx, Math.abs(dot(q, r)));
    hy = Math.max(hy, Math.abs(dot(q, u)));
  }
  return { dir, center, halfH: Math.max(hx, hy, 0.05) * margin };
}

// ---------------- tiny font ----------------
const FONT: Record<string, string> = {
  a: "010101111101101", b: "110101110101110", c: "011100100100011", d: "110101101101110", e: "111100110100111",
  f: "111100110100100", g: "011100101101011", h: "101101111101101", i: "111010010010111", j: "001001001101010",
  k: "101101110101101", l: "100100100100111", m: "101111111101101", n: "110101101101101", o: "010101101101010",
  p: "110101110100100", q: "010101101110011", r: "110101110101101", s: "011100010001110", t: "111010010010010",
  u: "101101101101111", v: "101101101101010", w: "101101111111101", x: "101101010101101", y: "101101010010010",
  z: "111001010100111", _: "000000000000111", "0": "111101101101111", "1": "010110010010111", "2": "110001010100111",
  "3": "110001010001110", "4": "101101111001001", "5": "111100110001110", "6": "011100111101111", "7": "111001010010010",
  "8": "111101111101111", "9": "111101111001110", ".": "000000000000010", "-": "000000111000000", " ": "000000000000000",
  "=": "000111000111000", ",": "000000000010100", ":": "000010000010000",
};
function text(img: Img, s: string, x: number, y: number, sc = 2, col: [number, number, number] = [30, 30, 30]) {
  let cx = x;
  for (const ch of s.toLowerCase()) {
    const g = FONT[ch] ?? FONT[" "];
    for (let r = 0; r < 5; r++)
      for (let c = 0; c < 3; c++)
        if (g[r * 3 + c] === "1")
          for (let dy = 0; dy < sc; dy++)
            for (let dx = 0; dx < sc; dx++) {
              const px = cx + c * sc + dx, py = y + r * sc + dy;
              if (px < 0 || py < 0 || px >= img.w || py >= img.h) continue;
              const k = (py * img.w + px) * 3;
              img.rgb[k] = col[0]; img.rgb[k + 1] = col[1]; img.rgb[k + 2] = col[2];
            }
    cx += 4 * sc;
  }
}

function blit(dst: Img, src: Img, ox: number, oy: number) {
  for (let y = 0; y < src.h; y++)
    for (let x = 0; x < src.w; x++) {
      const dx = ox + x, dy = oy + y;
      if (dx >= dst.w || dy >= dst.h) continue;
      for (let k = 0; k < 3; k++) dst.rgb[(dy * dst.w + dx) * 3 + k] = src.rgb[(y * src.w + x) * 3 + k];
    }
}

function savePng(img: Img, file: string) {
  const png = new PNG({ width: img.w, height: img.h });
  for (let i = 0; i < img.w * img.h; i++) {
    png.data[i * 4] = Math.max(0, Math.min(255, Math.round(img.rgb[i * 3])));
    png.data[i * 4 + 1] = Math.max(0, Math.min(255, Math.round(img.rgb[i * 3 + 1])));
    png.data[i * 4 + 2] = Math.max(0, Math.min(255, Math.round(img.rgb[i * 3 + 2])));
    png.data[i * 4 + 3] = 255;
  }
  fs.writeFileSync(file, PNG.sync.write(png));
  console.log("wrote", path.relative(process.cwd(), file));
}

// ---------------- main ----------------
const types = Object.keys(FURNITURE);
const FL: Vec3 = [0.55, 0.85, -0.62]; // looking from front-left (-X,-Y) down
const BR: Vec3 = [-0.55, -0.85, -0.62];

// 1) bounds checks (defaults + stretched variants + option variants)
const variants: [string, Record<string, unknown>][] = [
  ["table", { round: true }], ["side_table", { round: false }], ["desk", { drawers: "left" }], ["tv", { mount: "wall" }],
  ["bathroom_sink", { style: "pedestal" }], ["sectional_sofa", { chaise: "left" }], ["mirror", { round: true }],
  ["ceiling_light", { style: "flush" }], ["sofa", { arms: false, seats: 2 }], ["rug", { border: false }], ["curtain", { open: 1 }],
];
let bad = 0;
const check = (type: string, dims: { width: number; depth: number; height: number }, opts: Record<string, unknown>, label: string) => {
  const tris = trisOf(buildType(type, dims, opts));
  if (!tris.length) { console.log(`EMPTY ${label}`); bad++; return; }
  const b = bounds(tris), tol = 0.002;
  const v: string[] = [];
  if (b.min[0] < -dims.width / 2 - tol) v.push(`minX ${b.min[0].toFixed(3)}`);
  if (b.max[0] > dims.width / 2 + tol) v.push(`maxX ${b.max[0].toFixed(3)}`);
  if (b.min[1] < -dims.depth / 2 - tol) v.push(`minY ${b.min[1].toFixed(3)}`);
  if (b.max[1] > dims.depth / 2 + tol) v.push(`maxY ${b.max[1].toFixed(3)}`);
  if (b.min[2] < -tol) v.push(`minZ ${b.min[2].toFixed(3)}`);
  if (b.min[2] > 0.02) v.push(`floating minZ ${b.min[2].toFixed(3)}`);
  if (b.max[2] > dims.height + tol) v.push(`maxZ ${b.max[2].toFixed(3)} > ${dims.height}`);
  for (const t of tris) for (const p of [t.a, t.b, t.c]) if (!p.every(isFinite)) { v.push("NaN"); break; }
  if (v.length) { bad++; console.log(`BOUNDS ${label}: ${v.join(", ")}`); }
};
let triTotal = 0;
for (const type of types) {
  const d = FURNITURE[type].defaults;
  triTotal += trisOf(buildType(type)).length;
  check(type, d, {}, `${type} default`);
  check(type, { width: d.width * 1.6, depth: d.depth * 0.75, height: d.height * 1.25 }, {}, `${type} stretched`);
  check(type, { width: d.width * 0.7, depth: d.depth * 1.3, height: d.height * 0.85 }, {}, `${type} squeezed`);
}
for (const [type, o] of variants) check(type, FURNITURE[type].defaults, o, `${type} ${JSON.stringify(o)}`);
console.log(`bounds check: ${bad ? bad + " problems" : "all OK"}; ${types.length} types, ${triTotal} triangles at defaults`);
for (const type of types) console.log(`  ${type.padEnd(16)} ${trisOf(buildType(type)).length} tris`);

// 2) grid layout -> OBJ + overview
const COLS = 8, CELL = 3.4;
const grid: Tri[] = [];
const objLines: string[] = ["# Architecturer furniture preview", "mtllib furniture.mtl"];
const mats = new Set<string>();
let vi = 1;
types.forEach((type, i) => {
  const gx = (i % COLS) * CELL, gy = -Math.floor(i / COLS) * CELL;
  const meshes = buildType(type);
  objLines.push(`# ${type} at plan (${gx.toFixed(1)}, ${gy.toFixed(1)})`, `o ${type}`);
  for (const m of meshes) {
    mats.add(m.material);
    objLines.push(`usemtl ${m.material}`);
    const base = vi;
    for (let k = 0; k < m.positions.length; k += 3) {
      // plan Z-up -> OBJ Y-up: (x, z, -y)
      objLines.push(`v ${(m.positions[k] + gx).toFixed(4)} ${m.positions[k + 2].toFixed(4)} ${(-(m.positions[k + 1] + gy)).toFixed(4)}`);
      objLines.push(`vn ${m.normals[k].toFixed(4)} ${m.normals[k + 2].toFixed(4)} ${(-m.normals[k + 1]).toFixed(4)}`);
      vi++;
    }
    for (let k = 0; k < m.indices.length; k += 3) {
      const a = m.indices[k] + base, b = m.indices[k + 1] + base, c = m.indices[k + 2] + base;
      objLines.push(`f ${a}//${a} ${b}//${b} ${c}//${c}`);
    }
  }
  grid.push(...trisOf(meshes, (p) => [p[0] + gx, p[1] + gy, p[2]]));
});
fs.writeFileSync(path.join(OUT, "furniture.obj"), objLines.join("\n") + "\n");
fs.writeFileSync(
  path.join(OUT, "furniture.mtl"),
  [...mats].map((m) => { const c = colorOf(m); return `newmtl ${m}\nKd ${(c[0] / 255).toFixed(3)} ${(c[1] / 255).toFixed(3)} ${(c[2] / 255).toFixed(3)}\n${isGlass(m) ? "d 0.4\n" : ""}`; }).join("\n"),
);
console.log("wrote out/furniture.obj, out/furniture.mtl");
savePng(render(grid, fitView(grid, FL, 1.02), 2400, 1500), path.join(OUT, "furniture.png"));

// 3) contact sheets
const sheet = (dir: Vec3, file: string, stretch?: Vec3) => {
  const T = 300, LH = 22, cols = 8;
  const rows = Math.ceil(types.length / cols);
  const img = new Img(cols * T, rows * (T + LH), [250, 250, 250]);
  types.forEach((type, i) => {
    const d0 = FURNITURE[type].defaults;
    const dims = stretch ? { width: d0.width * stretch[0], depth: d0.depth * stretch[1], height: d0.height * stretch[2] } : d0;
    const tris = trisOf(buildType(type, dims));
    const tile = render(tris, fitView(tris, dir), T, T);
    const ox = (i % cols) * T, oy = Math.floor(i / cols) * (T + LH);
    blit(img, tile, ox, oy);
    const d = dims;
    text(img, `${type} ${+d.width.toFixed(2)}x${+d.depth.toFixed(2)}x${+d.height.toFixed(2)}`, ox + 6, oy + T + 5, 2);
  });
  savePng(img, path.join(OUT, file));
};
sheet(FL, "furniture_sheet.png");
sheet(BR, "furniture_sheet_back.png");
sheet(FL, "furniture_sheet_stretched.png", [1.6, 0.8, 1.25]);

// 4) close-ups
const closeTypes = process.argv.slice(2);
for (const arg of closeTypes) {
  const [type, optStr] = arg.split(":");
  if (!FURNITURE[type]) { console.log("unknown type", type); continue; }
  const opts: Record<string, unknown> = {};
  if (optStr) for (const kv of optStr.split(",")) { const [k, v] = kv.split("="); opts[k] = v; }
  const tris = trisOf(buildType(type, undefined, opts));
  const T = 512;
  const views: [string, Vec3][] = [["front", [0, 1, -0.12]], ["front-left", FL], ["back-right", BR], ["top", [0.001, 0.15, -1]]];
  const img = new Img(T * 4, T + 26, [250, 250, 250]);
  views.forEach(([name, dir], i) => {
    blit(img, render(tris, fitView(tris, dir), T, T), i * T, 0);
    text(img, `${arg} ${name}`, i * T + 8, T + 6, 2);
  });
  savePng(img, path.join(OUT, `furniture_${arg.replace(/[^a-z0-9_]+/gi, "_")}.png`));
}
void m4;
