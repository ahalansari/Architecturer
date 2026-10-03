/**
 * Dev aid for interior finishes: contact sheet of the finish materials (each swatch = 2×2 tiles, lit with the
 * normal map so relief reads), in library order.
 *
 *   npx tsx scripts/finishes-preview.ts                       # out/finishes.png: every material using a finish pattern
 *   npx tsx scripts/finishes-preview.ts terrazzo_pink slats_oak # just these
 *   SWATCH=192 COLS=5 npx tsx scripts/finishes-preview.ts      # bigger swatches
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";
import { MATERIAL_LIBRARY } from "../src/materials/library.js";
import { generateTextures } from "../src/materials/textures.js";

const FINISH_PATTERNS = new Set(["herringbone", "chevron", "parquet", "terrazzo", "hex_tiles", "mosaic", "zellige", "wallpaper", "fluted", "microcement", "grasscloth"]);
const args = process.argv.slice(2);
const names = args.length ? args : Object.keys(MATERIAL_LIBRARY).filter((n) => FINISH_PATTERNS.has(MATERIAL_LIBRARY[n].pattern) || n === "linen_wallcovering");
const S = Number(process.env.SWATCH ?? 128), COLS = Number(process.env.COLS ?? 6), GAP = 6;
const W = S * 2;
const rows = Math.ceil(names.length / COLS);
const png = new PNG({ width: COLS * (W + GAP), height: rows * (W + GAP) });
for (let i = 0; i < png.data.length; i += 4) png.data.set([32, 32, 34, 255], i);
const L = [-0.45, 0.55, 0.7], ll = Math.hypot(L[0], L[1], L[2]);
names.forEach((name, idx) => {
  const m = MATERIAL_LIBRARY[name];
  if (!m) throw new Error(`unknown material ${name}`);
  const t = generateTextures(m, S);
  const ox = (idx % COLS) * (W + GAP), oy = Math.floor(idx / COLS) * (W + GAP);
  for (let y = 0; y < W; y++)
    for (let x = 0; x < W; x++) {
      const k = (((y % S) * S) + (x % S)) * 4;
      const nx = t.normal[k] / 127.5 - 1, ny = t.normal[k + 1] / 127.5 - 1, nz = t.normal[k + 2] / 127.5 - 1;
      const d = Math.max(0, (nx * L[0] + ny * L[1] + nz * L[2]) / ll);
      const s = (0.35 * (t.orm[k] / 255) + 0.75 * d) * 1.05;
      const o = ((oy + y) * png.width + ox + x) * 4;
      for (let ch = 0; ch < 3; ch++) png.data[o + ch] = Math.min(255, Math.round(t.baseColor[k + ch] * m.color[ch] * s));
    }
});
mkdirSync("out", { recursive: true });
writeFileSync("out/finishes.png", PNG.sync.write(png));
console.log("wrote out/finishes.png:", names.map((n, i) => `${i}:${n}`).join("  "));
