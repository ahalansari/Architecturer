/**
 * Dev aid: render every library material into a contact sheet.
 *
 *   npx tsx scripts/texture-preview.ts                 # out/materials.png (lit swatches) + out/materials_color.png
 *   npx tsx scripts/texture-preview.ts brick_red        # out/mat_brick_red.png: 2×2 tiled color | lit | normal | orm
 *   npx tsx scripts/texture-preview.ts --time           # print generation time at 512 and 1024
 *
 * Swatches are shaded with the generated normal map + AO under a simple directional light so relief is visible.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";
import { generateTextures } from "../src/materials/textures.js";
import { MATERIAL_LIBRARY } from "../src/materials/library.js";
import type { TextureSet } from "../src/materials/types.js";

mkdirSync("out", { recursive: true });
const args = process.argv.slice(2);

/** Lambert + ambient using the tangent-space normal map (light from upper-left). */
function lit(t: TextureSet): Uint8Array {
  const out = new Uint8Array(t.size * t.size * 4);
  const L = [-0.45, 0.55, 0.7];
  const ll = Math.hypot(L[0], L[1], L[2]);
  for (let i = 0; i < t.size * t.size; i++) {
    const k = i * 4;
    const nx = t.normal[k] / 127.5 - 1, ny = t.normal[k + 1] / 127.5 - 1, nz = t.normal[k + 2] / 127.5 - 1;
    const d = Math.max(0, (nx * L[0] + ny * L[1] + nz * L[2]) / ll);
    const ao = t.orm[k] / 255;
    const s = (0.35 * ao + 0.75 * d) * 1.05;
    for (let c = 0; c < 3; c++) out[k + c] = Math.min(255, Math.round(t.baseColor[k + c] * s));
    out[k + 3] = 255;
  }
  return out;
}

function blit(dst: PNG, src: Uint8Array, srcSize: number, dx: number, dy: number, w = srcSize, h = srcSize, opaque = true) {
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = (((y % srcSize) * srcSize) + (x % srcSize)) * 4;
      const d = ((dy + y) * dst.width + dx + x) * 4;
      dst.data[d] = src[s];
      dst.data[d + 1] = src[s + 1];
      dst.data[d + 2] = src[s + 2];
      dst.data[d + 3] = opaque ? 255 : src[s + 3];
    }
}

/** Fill with an opaque gray background. */
function clear(png: PNG, v: number) {
  for (let i = 0; i < png.data.length; i += 4) png.data.set([v, v, v, 255], i);
}

function save(png: PNG, file: string) {
  writeFileSync(file, PNG.sync.write(png));
  console.log("wrote", file);
}

if (args.includes("--time")) {
  for (const size of [512, 1024]) {
    let total = 0, worst = 0, worstName = "";
    for (const [name, m] of Object.entries(MATERIAL_LIBRARY)) {
      const t0 = performance.now();
      generateTextures(m, size);
      const dt = performance.now() - t0;
      total += dt;
      if (dt > worst) [worst, worstName] = [dt, name];
    }
    const n = Object.keys(MATERIAL_LIBRARY).length;
    console.log(`size ${size}: ${n} materials, avg ${(total / n).toFixed(0)} ms, worst ${worst.toFixed(0)} ms (${worstName}), total ${(total / 1000).toFixed(1)} s`);
  }
} else if (args.length > 0) {
  // detail view: 2×2 tiled color, 2×2 tiled lit, normal, orm
  for (const name of args) {
    const m = MATERIAL_LIBRARY[name];
    if (!m) throw new Error(`unknown material ${name}`);
    const S = Number(process.env.SIZE ?? 256);
    const t = generateTextures(m, S);
    const png = new PNG({ width: S * 2 * 2 + S * 2 + 12, height: S * 2 + 8 });
    clear(png, 40);
    blit(png, t.baseColor, S, 0, 0, S * 2, S * 2);
    blit(png, lit(t), S, S * 2 + 4, 0, S * 2, S * 2);
    blit(png, t.normal, S, S * 4 + 8, 0);
    blit(png, t.orm, S, S * 4 + 8, S + 4);
    save(png, `out/mat_${name}.png`);
  }
} else {
  const names = Object.keys(MATERIAL_LIBRARY);
  const S = Number(process.env.SWATCH ?? 128), GAP = 4, COLS = 10;
  const rows = Math.ceil(names.length / COLS);
  const sheetLit = new PNG({ width: COLS * (S + GAP), height: rows * (S + GAP) });
  const sheetCol = new PNG({ width: COLS * (S + GAP), height: rows * (S + GAP) });
  clear(sheetLit, 30);
  clear(sheetCol, 30);
  const order: string[] = [];
  names.forEach((name, idx) => {
    const t = generateTextures(MATERIAL_LIBRARY[name], S);
    const x = (idx % COLS) * (S + GAP), y = Math.floor(idx / COLS) * (S + GAP);
    blit(sheetLit, lit(t), S, x, y);
    blit(sheetCol, t.baseColor, S, x, y);
    order.push(`${idx}:${name}`);
  });
  save(sheetLit, "out/materials.png");
  save(sheetCol, "out/materials_color.png");
  console.log(order.join("  "));
}
