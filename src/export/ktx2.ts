import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { encodeToKTX2 } from "ktx2-encoder";

/**
 * KTX2 / Basis Universal texture compression (glTF KHR_texture_basisu).
 * Textures stay compressed on the GPU (BC7/ASTC/ETC after transcoding), with mipmaps.
 * Encoding is slow-ish, so results are cached on disk by content hash; textures are
 * procedural and deterministic, so repeated builds are near-instant.
 */

export type TextureRole = "color" | "normal" | "data";
/** fast = ETC1S everywhere (smallest). high = UASTC for normal maps (sharper, larger, much slower to encode). */
export type Ktx2Quality = "fast" | "high";

const VERSION = 1; // bump when encoder settings change to invalidate the cache

function settings(role: TextureRole, quality: Ktx2Quality) {
  const linear = { isPerceptual: false, isSetKTX2SRGBTransferFunc: false };
  if (role === "normal" && quality === "high")
    return { isUASTC: true, needSupercompression: true, enableRDO: true, rdoQualityLevel: 1, isNormalMap: true, ...linear };
  if (role === "normal") return { isUASTC: false, qualityLevel: 255, compressionLevel: 1, isNormalMap: true, ...linear };
  if (role === "data") return { isUASTC: false, qualityLevel: 160, compressionLevel: 1, ...linear };
  return { isUASTC: false, qualityLevel: 180, compressionLevel: 1, isPerceptual: true, isSetKTX2SRGBTransferFunc: true };
}

function cacheDir(): string | null {
  const base = process.env.ARCHITECTURER_CACHE ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "architecturer");
  try {
    const dir = join(base, "ktx2");
    mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return null; // read-only home etc.: just don't cache
  }
}

let silenced = false;

/** Encode one square RGBA8 image to KTX2 (with mipmaps). */
export async function encodeKTX2(rgba: Uint8Array, size: number, role: TextureRole, quality: Ktx2Quality = "fast"): Promise<Uint8Array> {
  const opts = settings(role, quality);
  const key = createHash("sha1").update(rgba).update(JSON.stringify([VERSION, size, opts])).digest("hex");
  const dir = cacheDir();
  const file = dir ? join(dir, `${key}.ktx2`) : null;
  if (file)
    try {
      return new Uint8Array(readFileSync(file));
    } catch {
      /* not cached yet */
    }

  // The Basis WASM module binds console.log as its stdout when it first starts and prints
  // per-slice debug info; give it a no-op during that first call so it stays quiet for good.
  const log = console.log;
  if (!silenced) console.log = () => {};
  let out: Uint8Array;
  try {
    out = await encodeToKTX2(new Uint8Array(1), {
      imageDecoder: async () => ({ data: rgba, width: size, height: size }),
      generateMipmap: true,
      enableDebug: false,
      ...opts,
    });
  } finally {
    console.log = log;
    silenced = true;
  }
  if (file)
    try {
      writeFileSync(file, out);
    } catch {
      /* cache is best-effort */
    }
  return out;
}
