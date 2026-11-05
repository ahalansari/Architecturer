import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { cacheRoot } from "../assets/cache.js";
import type { MaterialDef } from "../materials/types.js";

/**
 * Image encoding for glTF export, plus an on-disk cache of each procedural material's encoded
 * textures. Painting and encoding are most of a build's time; the textures are deterministic,
 * so a material seen before (in any project) costs one file read.
 *
 * The cache key covers the material definition, size, format and the texture painter's own
 * source, so editing textures.ts invalidates it without a version bump.
 */

export interface EncodedImage {
  /** Content key used to share identical images within a document. */
  hash: string;
  mime: "image/jpeg" | "image/png";
  data: Uint8Array;
}

const VERSION = 1; // bump when encoder settings change
const JPEG_QUALITY = 90;

/** Encode a square RGBA8 image. JPEG keeps full-resolution chroma so ORM channels don't bleed into each other. */
export async function encodeImage(rgba: Uint8Array, size: number, alpha: boolean, asJpeg: boolean): Promise<Uint8Array> {
  let img = sharp(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), { raw: { width: size, height: size, channels: 4 } });
  if (!alpha) img = img.removeAlpha();
  const out = asJpeg
    ? await img.jpeg({ quality: JPEG_QUALITY, chromaSubsampling: "4:4:4" }).toBuffer()
    : await img.png({ compressionLevel: 6, adaptiveFiltering: true }).toBuffer();
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

let stamp: string | undefined;

/** Hash of the painter source (dist .js or src .ts under tsx) and encoder versions. */
function sourceStamp(): string {
  if (stamp !== undefined) return stamp;
  const here = fileURLToPath(import.meta.url);
  const h = createHash("sha1").update(JSON.stringify([VERSION, JPEG_QUALITY, sharp.versions.vips, sharp.versions.mozjpeg]));
  try {
    for (const f of ["textures", "ral"]) h.update(readFileSync(join(here, "..", "..", "materials", f + extname(here))));
    stamp = h.digest("hex");
  } catch {
    stamp = ""; // sources not found next to this file: don't cache
  }
  return stamp;
}

/** Cache key for a procedural material's encoded textures, or undefined when it can't be cached. */
export function textureCacheKey(def: MaterialDef, size: number, lossy: boolean, alpha: boolean): string | undefined {
  if (def.images || def.pattern === "none" || !sourceStamp()) return undefined;
  // same fields as texturesFor's in-memory key (color is applied as a factor, not baked in)
  const k = [def.pattern, def.roughness, def.metalness, def.opacity, def.normalStrength, def.params, size, lossy, alpha];
  return createHash("sha1").update(sourceStamp()).update(JSON.stringify(k)).digest("hex");
}

let dir: string | null | undefined;

function cacheDir(): string | null {
  if (dir !== undefined) return dir;
  try {
    dir = join(cacheRoot(), "textures");
    mkdirSync(dir, { recursive: true });
  } catch {
    dir = null; // read-only home etc.: just don't cache
  }
  return dir;
}

export function hasCachedTextures(key: string): boolean {
  const d = cacheDir();
  return !!d && existsSync(join(d, key + ".bin"));
}

/**
 * File layout: u32 header length, JSON header [{hash, mime, length}...], then the image bytes in order.
 */
export function readCachedTextures(key: string): EncodedImage[] | undefined {
  const d = cacheDir();
  if (!d) return undefined;
  try {
    const buf = readFileSync(join(d, key + ".bin"));
    const n = buf.readUInt32LE(0);
    const head = JSON.parse(buf.subarray(4, 4 + n).toString("utf8")) as { hash: string; mime: EncodedImage["mime"]; length: number }[];
    let at = 4 + n;
    if (at + head.reduce((s, h) => s + h.length, 0) !== buf.length) return undefined; // truncated
    return head.map((h) => {
      const data = new Uint8Array(buf.buffer, buf.byteOffset + at, h.length);
      at += h.length;
      return { hash: h.hash, mime: h.mime, data };
    });
  } catch {
    return undefined; // not cached yet, or a truncated file
  }
}

export function writeCachedTextures(key: string, images: EncodedImage[]) {
  const d = cacheDir();
  if (!d) return;
  const head = Buffer.from(JSON.stringify(images.map((i) => ({ hash: i.hash, mime: i.mime, length: i.data.byteLength }))), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(head.length);
  const file = join(d, key + ".bin");
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    // write then rename, so a concurrent build never reads half a file
    writeFileSync(tmp, Buffer.concat([len, head, ...images.map((i) => i.data)]));
    renameSync(tmp, file);
  } catch {
    /* cache is best-effort */
  }
}
