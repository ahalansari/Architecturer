/**
 * Image helpers for downloaded / imported textures: decode JPEG / PNG, resample to a square texture,
 * pack occlusion / roughness / metalness, and pick a product's dominant colour.
 */
import { readFileSync } from "node:fs";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import type { ImageMaps, TextureSet } from "../materials/types.js";

export interface Img {
  width: number;
  height: number;
  /** RGBA8 */
  data: Uint8Array;
}

let webpReady: Promise<(b: ArrayBuffer) => Promise<{ data: Uint8ClampedArray; width: number; height: number }>> | null = null;

/** WebP → PNG (IKEA and other vendor GLBs often embed WebP textures; the texture pipeline reads PNG / JPEG). */
export async function webpToPng(buf: Uint8Array): Promise<Buffer> {
  webpReady ??= (async () => {
    // the emscripten build returns an ImageData; Node has none
    const g = globalThis as { ImageData?: unknown };
    g.ImageData ??= class {
      constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
    };
    const { readFile } = await import("node:fs/promises");
    const { createRequire } = await import("node:module");
    const req = createRequire(import.meta.url);
    const wasmPath = req.resolve("@jsquash/webp/codec/dec/webp_dec.wasm");
    const mod = await import("@jsquash/webp/decode.js");
    await mod.init(await WebAssembly.compile(await readFile(wasmPath)));
    return mod.default as never;
  })();
  const decode = await webpReady;
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const im = await decode(ab);
  const png = new PNG({ width: im.width, height: im.height });
  png.data = Buffer.from(im.data.buffer, im.data.byteOffset, im.data.byteLength);
  return PNG.sync.write(png);
}

export function decodeImage(buf: Uint8Array, hint = ""): Img {
  const isPng = buf[0] === 0x89 && buf[1] === 0x50;
  const isJpg = buf[0] === 0xff && buf[1] === 0xd8;
  if (isPng || hint.endsWith(".png")) {
    const p = PNG.sync.read(Buffer.from(buf));
    return { width: p.width, height: p.height, data: new Uint8Array(p.data) };
  }
  if (isJpg || /\.jpe?g$/i.test(hint)) {
    const j = jpeg.decode(Buffer.from(buf), { useTArray: true, maxMemoryUsageInMB: 1024, formatAsRGBA: true });
    return { width: j.width, height: j.height, data: new Uint8Array(j.data) };
  }
  throw new Error(`unsupported image format${hint ? ` (${hint})` : ""}: only JPEG and PNG can be decoded (convert WebP/KTX2 textures first)`);
}

const imgCache = new Map<string, Img>();
export function loadImage(path: string): Img {
  let im = imgCache.get(path);
  if (!im) {
    im = decodeImage(readFileSync(path), path.toLowerCase());
    if (imgCache.size > 64) imgCache.delete(imgCache.keys().next().value!);
    imgCache.set(path, im);
  }
  return im;
}

/** Box-filtered resample to size × size (wraps, for tileable textures). */
export function resample(im: Img, size: number): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const sx = im.width / size, sy = im.height / size;
  for (let y = 0; y < size; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      // sample at most a 4x4 grid per output pixel (fast enough for 4K → 512)
      const stx = Math.max(1, Math.floor((x1 - x0) / 4)), sty = Math.max(1, Math.floor((y1 - y0) / 4));
      for (let yy = y0; yy < y1; yy += sty)
        for (let xx = x0; xx < x1; xx += stx) {
          const k = ((yy % im.height) * im.width + (xx % im.width)) * 4;
          r += im.data[k];
          g += im.data[k + 1];
          b += im.data[k + 2];
          a += im.data[k + 3];
          n++;
        }
      const o = (y * size + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = a / n;
    }
  }
  return out;
}

export type { ImageMaps };

/**
 * TextureSet from image files (paths), resampled to `size`. Missing maps fall back to flat values; `rough` and
 * `metal` multiply the maps (or are the flat value without a map), like glTF factors.
 */
export function imageTextureSet(maps: ImageMaps, size: number, rough: number, metal: number, opacity: number): TextureSet {
  const n = size * size;
  const flat = (r: number, g: number, b: number, a = 255) => {
    const t = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) (t[i * 4] = r), (t[i * 4 + 1] = g), (t[i * 4 + 2] = b), (t[i * 4 + 3] = a);
    return t;
  };
  const baseColor = maps.baseColor ? resample(loadImage(maps.baseColor), size) : flat(255, 255, 255);
  if (!maps.alpha || opacity < 1) for (let i = 0; i < n; i++) baseColor[i * 4 + 3] = Math.round(Math.min(1, opacity) * 255);
  const normal = maps.normal ? resample(loadImage(maps.normal), size) : flat(128, 128, 255);
  const orm = flat(255, Math.round(rough * 255), Math.round(metal * 255));
  const ch = (p: string | undefined, c: number, from: number, k: number) => {
    if (!p) return;
    const m = resample(loadImage(p), size);
    for (let i = 0; i < n; i++) orm[i * 4 + c] = Math.round(m[i * 4 + from] * k);
  };
  if (maps.orm) {
    ch(maps.orm, 1, 1, rough);
    ch(maps.orm, 2, 2, metal);
  }
  ch(maps.roughness, 1, 0, rough);
  ch(maps.metalness, 2, 0, metal);
  ch(maps.ao, 0, 0, 1);
  for (let i = 0; i < n; i++) (normal[i * 4 + 3] = 255), (orm[i * 4 + 3] = 255);
  return { size, baseColor, normal, orm };
}

/** Average colour (sRGB 0..1) of an image. */
export function averageColor(im: Img): [number, number, number] {
  let r = 0, g = 0, b = 0, n = 0;
  const step = Math.max(1, Math.floor((im.width * im.height) / 40000));
  for (let i = 0; i < im.width * im.height; i += step) {
    r += im.data[i * 4];
    g += im.data[i * 4 + 1];
    b += im.data[i * 4 + 2];
    n++;
  }
  return [r / n / 255, g / n / 255, b / n / 255];
}

/**
 * Dominant colour of a product photo: ignores the (near-white / near-uniform) studio background found along the
 * border and returns the most common colour bucket of the rest, refined to its mean.
 */
export function dominantColor(im: Img): string {
  const { width: W, height: H, data } = im;
  const at = (x: number, y: number) => (y * W + x) * 4;
  // background estimate from the border
  let br = 0, bg = 0, bb = 0, bn = 0;
  for (let x = 0; x < W; x += Math.max(1, Math.floor(W / 64)))
    for (const y of [0, H - 1]) {
      const k = at(x, y);
      (br += data[k]), (bg += data[k + 1]), (bb += data[k + 2]), bn++;
    }
  for (let y = 0; y < H; y += Math.max(1, Math.floor(H / 64)))
    for (const x of [0, W - 1]) {
      const k = at(x, y);
      (br += data[k]), (bg += data[k + 1]), (bb += data[k + 2]), bn++;
    }
  (br /= bn), (bg /= bn), (bb /= bn);
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  const step = Math.max(1, Math.floor(Math.sqrt((W * H) / 60000)));
  for (let y = 0; y < H; y += step)
    for (let x = 0; x < W; x += step) {
      const k = at(x, y);
      const r = data[k], g = data[k + 1], b = data[k + 2], a = data[k + 3];
      if (a < 128) continue;
      if (Math.abs(r - br) + Math.abs(g - bg) + Math.abs(b - bb) < 40) continue; // background
      if (r > 238 && g > 238 && b > 238) continue; // white seamless / highlights
      const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
      const e = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
      e.n++;
      e.r += r;
      e.g += g;
      e.b += b;
      buckets.set(key, e);
    }
  let best: { n: number; r: number; g: number; b: number } | null = null;
  for (const e of buckets.values()) if (!best || e.n > best.n) best = e;
  if (!best) return "#bfbfbf";
  const hex = (v: number) => Math.round(v).toString(16).padStart(2, "0");
  return `#${hex(best.r / best.n)}${hex(best.g / best.n)}${hex(best.b / best.n)}`;
}
