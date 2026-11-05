import { Document, NodeIO, type Material, type Node as GNode, type Texture } from "@gltf-transform/core";
import { dedup, tangents, unweld, weld } from "@gltf-transform/functions";
import { createHash } from "node:crypto";
import { KHRLightsPunctual, KHRTextureBasisu } from "@gltf-transform/extensions";
import { navMetadata } from "./navmeta.js";
import { attachGltfLight } from "../elements/lighting.js";
import { generateTangents } from "mikktspace";
import type { SceneNode } from "../geometry/scene.js";
import { COLLIDER } from "../elements/stairs.js";
import { prepareForGame, type GameOptions } from "./game.js";
import { encodeKTX2, type Ktx2Quality, type TextureRole } from "./ktx2.js";
import { encodeImage, hasCachedTextures, readCachedTextures, textureCacheKey, writeCachedTextures, type EncodedImage } from "./texcache.js";
import type { MaterialDef, TextureSet } from "../materials/types.js";
import { prefetchTextures, texturesFor, type Compiled } from "../pipeline.js";

export interface ExportOptions extends GameOptions {
  /**
   * Rotate the export 180° about the vertical axis so that, after Unity's glTF importer converts
   * handedness, plan (x, y) lands exactly on Unity world (x, z).
   */
  unityAxes?: boolean;
  /** Texture resolution in pixels (power of two recommended). 0 disables textures. */
  textureSize?: number;
  /**
   * Image encoding. "jpeg" (default): opaque base color and ORM as JPEG, normal maps and alpha as PNG.
   * "png": everything lossless. "ktx2": every texture as KTX2/Basis Universal with mipmaps
   * (KHR_texture_basisu, required) — stays compressed in GPU memory; needs KTX support in the engine.
   */
  textureFormat?: "png" | "jpeg" | "ktx2";
  /** KTX2 only: "high" encodes normal maps as UASTC (sharper, larger, much slower). Default "fast". */
  ktx2Quality?: Ktx2Quality;
  /** Add navigation markers (room / stair NavMesh areas, lift landings) for the engine packages. */
  navigation?: boolean;
}

interface EncodeJob {
  tex: Texture;
  rgba: Uint8Array;
  size: number;
  role: TextureRole;
  alpha: boolean;
  asJpeg: boolean;
}
type Encoded = { tex: Texture; hash: string };

/**
 * Textures waiting to be encoded (asynchronously, in finalDocument), and the materials whose
 * encoded images go into the texture cache once they are.
 */
const pending = new WeakMap<Document, { jobs: EncodeJob[]; cacheWrites: { key: string; parts: Encoded[] }[] }>();

/** 1×1 PNG standing in for an image until finalDocument encodes it. */
const PLACEHOLDER = new Uint8Array(
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64"),
);

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/**
 * Convert the compiled scene to a glTF document.
 * Plan space (Z-up) maps to glTF Y-up as (x, y, z) -> (x, z, -y).
 */
export function toGltfDocument(c: Compiled, opts: ExportOptions = {}): Document {
  if (!c.root || !c.project) throw new Error("nothing to export: " + c.errors.join("; "));
  const size = opts.textureSize ?? 512;
  const format = opts.textureFormat ?? "jpeg";
  const lossy = format === "jpeg";
  const doc = new Document();
  const jobs: EncodeJob[] = [];
  const cacheWrites: { key: string; parts: Encoded[] }[] = [];
  pending.set(doc, { jobs, cacheWrites });
  doc.getRoot().getAsset().generator = "Architecturer";
  const buffer = doc.createBuffer();
  const scene = doc.createScene(c.project.name);
  scene.setExtras({ description: c.project.description ?? "", units: "meters", upAxis: "Y", planAxes: opts.unityAxes ? "unity" : "gltf" });

  const mats = new Map<string, Material>();
  type MaterialTextures = { base: Texture; normal: Texture; orm: Texture };
  // keyed by texture cache key, or by the TextureSet when the material can't be cached
  const textures = new Map<string | TextureSet, MaterialTextures>();
  // identical images (e.g. normal maps shared by roughness variants) are stored once
  const images = new Map<string, Texture>();
  const image = (name: string, size: number, rgba: Uint8Array, alpha: boolean, role: TextureRole): Encoded => {
    const asJpeg = role !== "normal" && lossy && !alpha;
    const hash = createHash("sha1").update(rgba).digest("hex") + (alpha ? "a" : "") + (asJpeg ? "j" : "");
    let t = images.get(hash);
    if (!t) {
      t = doc.createTexture(name).setMimeType(asJpeg ? "image/jpeg" : "image/png").setImage(PLACEHOLDER);
      jobs.push({ tex: t, rgba, size, role, alpha, asJpeg });
      images.set(hash, t);
    }
    return { tex: t, hash };
  };
  const encoded = (name: string, img: EncodedImage): Texture => {
    let t = images.get(img.hash);
    if (!t) images.set(img.hash, (t = doc.createTexture(name).setMimeType(img.mime).setImage(img.data)));
    return t;
  };
  const texturesOf = (name: string, def: MaterialDef): MaterialTextures | undefined => {
    if (size <= 0) return undefined;
    const alpha = def.opacity < 1 || !!def.alphaCutoff;
    const key = format === "ktx2" ? undefined : textureCacheKey(def, size, lossy, alpha);
    let t = key ? textures.get(key) : undefined;
    if (t) return t;
    const hit = key ? readCachedTextures(key) : undefined;
    if (key && hit?.length === 3) {
      t = { base: encoded(`${name}_basecolor`, hit[0]), normal: encoded(`${name}_normal`, hit[1]), orm: encoded(`${name}_orm`, hit[2]) };
      textures.set(key, t);
      return t;
    }
    const tex = texturesFor(def, size);
    if (!tex) return undefined;
    t = textures.get(key ?? tex);
    if (t) return t;
    // JPEG artifacts would show up as bumps in normal maps, so those stay lossless
    const parts = [
      image(`${name}_basecolor`, tex.size, tex.baseColor, alpha, "color"),
      image(`${name}_normal`, tex.size, tex.normal, false, "normal"),
      image(`${name}_orm`, tex.size, tex.orm, false, "data"),
    ];
    t = { base: parts[0].tex, normal: parts[1].tex, orm: parts[2].tex };
    textures.set(key ?? tex, t);
    if (key) cacheWrites.push({ key, parts });
    return t;
  };
  const materialFor = (name: string): Material => {
    let m = mats.get(name);
    if (m) return m;
    const def: MaterialDef = c.materials.get(name)!;
    m = doc.createMaterial(name).setRoughnessFactor(1).setMetallicFactor(1).setDoubleSided(!!def.doubleSided);
    const t = texturesOf(name, def);
    const lin = def.color.map(srgbToLinear);
    if (t) {
      // textures are untinted and shared by tinted variants: the tint is the factor, opacity is baked into alpha
      m.setBaseColorFactor([lin[0], lin[1], lin[2], 1])
        .setBaseColorTexture(t.base)
        .setNormalTexture(t.normal)
        .setMetallicRoughnessTexture(t.orm)
        .setOcclusionTexture(t.orm);
    } else {
      m.setBaseColorFactor([lin[0], lin[1], lin[2], def.opacity]).setRoughnessFactor(def.roughness).setMetallicFactor(def.metalness);
    }
    if (def.alphaCutoff) m.setAlphaMode("MASK").setAlphaCutoff(def.alphaCutoff).setDoubleSided(true);
    else if (def.opacity < 1) m.setAlphaMode("BLEND");
    if (def.emissive) m.setEmissiveFactor(def.emissive.map(srgbToLinear) as [number, number, number]);
    mats.set(name, m);
    return m;
  };

  // plan (x, y, z) -> glTF (s*x, z, -s*y); s = -1 is a 180° turn about Y (still a proper rotation)
  const s = opts.unityAxes ? -1 : 1;
  const convert = (n: SceneNode): GNode => {
    const g = doc.createNode(n.name);
    if (n.extras && Object.keys(n.extras).length) g.setExtras({ kind: n.kind, ...stripUndefined(n.extras) });
    else g.setExtras({ kind: n.kind });
    if (n.translation) g.setTranslation([s * n.translation[0], n.translation[2], -s * n.translation[1]]);
    if (n.rotationZ) g.setRotation([0, Math.sin(n.rotationZ / 2), 0, Math.cos(n.rotationZ / 2)]);
    if (n.kind === "light") attachGltfLight(doc, g, n, s); // KHR_lights_punctual
    if (n.meshes.length) {
      const mesh = doc.createMesh(n.name);
      for (const md of n.meshes) {
        const count = md.positions.length / 3;
        const index = () =>
          doc.createAccessor().setType("SCALAR").setArray(count < 65536 ? new Uint16Array(md.indices) : new Uint32Array(md.indices)).setBuffer(buffer);
        const pos = new Float32Array(count * 3), nor = new Float32Array(count * 3);
        for (let i = 0; i < count; i++) {
          pos[i * 3] = s * md.positions[i * 3];
          pos[i * 3 + 1] = md.positions[i * 3 + 2];
          pos[i * 3 + 2] = -s * md.positions[i * 3 + 1];
          nor[i * 3] = s * md.normals[i * 3];
          nor[i * 3 + 1] = md.normals[i * 3 + 2];
          nor[i * 3 + 2] = -s * md.normals[i * 3 + 1];
        }
        if (md.material === COLLIDER) {
          // collision-only: positions + indices, no material (engines strip or hide these nodes)
          mesh.addPrimitive(
            doc.createPrimitive().setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(pos).setBuffer(buffer)).setIndices(index()),
          );
          continue;
        }
        const prim = doc
          .createPrimitive()
          .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(pos).setBuffer(buffer))
          .setAttribute("NORMAL", doc.createAccessor().setType("VEC3").setArray(nor).setBuffer(buffer))
          .setAttribute("TEXCOORD_0", doc.createAccessor().setType("VEC2").setArray(new Float32Array(md.uvs)).setBuffer(buffer))
          .setIndices(index())
          .setMaterial(materialFor(md.material));
        if (md.uv2) prim.setAttribute("TEXCOORD_1", doc.createAccessor().setType("VEC2").setArray(new Float32Array(md.uv2)).setBuffer(buffer));
        mesh.addPrimitive(prim);
      }
      g.setMesh(mesh);
    }
    for (const ch of n.children) g.addChild(convert(ch));
    return g;
  };
  scene.addChild(convert(prepareForGame(c.root, { ...opts, nav: opts.navigation ? navMetadata(c) : undefined })));
  return doc;
}

/** Triangles with no UV area get zero tangents; replace them with any unit vector perpendicular to the normal. */
function fixZeroTangents(doc: Document) {
  for (const mesh of doc.getRoot().listMeshes())
    for (const prim of mesh.listPrimitives()) {
      const t = prim.getAttribute("TANGENT")?.getArray() as Float32Array | undefined;
      const n = prim.getAttribute("NORMAL")?.getArray() as Float32Array | undefined;
      if (!t || !n) continue;
      for (let i = 0, j = 0; i < t.length; i += 4, j += 3) {
        if (Math.hypot(t[i], t[i + 1], t[i + 2]) > 0.5) continue;
        // pick the axis least aligned with the normal and orthogonalize
        const nx = n[j], ny = n[j + 1], nz = n[j + 2];
        const ax = Math.abs(nx) < 0.9 ? [1, 0, 0] : [0, 1, 0];
        const d = ax[0] * nx + ax[1] * ny + ax[2] * nz;
        const x = ax[0] - d * nx, y = ax[1] - d * ny, z = ax[2] - d * nz;
        const l = Math.hypot(x, y, z) || 1;
        t[i] = x / l; t[i + 1] = y / l; t[i + 2] = z / l; t[i + 3] = 1;
      }
    }
}

function stripUndefined(o: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

/** Document plus MikkTSpace tangents for normal-mapped primitives (what Unity/Unreal/Godot expect). */
async function finalDocument(c: Compiled, opts: ExportOptions): Promise<Document> {
  const size = opts.textureSize ?? 512;
  if (size > 0) {
    // paint what the texture cache doesn't have on all cores; toGltfDocument then finds it in memory
    const lossy = (opts.textureFormat ?? "jpeg") === "jpeg";
    const missing = [...c.materials.values()].filter((def) => {
      if (opts.textureFormat === "ktx2") return true;
      const key = textureCacheKey(def, size, lossy, def.opacity < 1 || !!def.alphaCutoff);
      return !key || !hasCachedTextures(key);
    });
    await prefetchTextures(missing, size);
  }
  const doc = toGltfDocument(c, opts);
  // encode first: the placeholders are identical, and dedup() below would merge them
  const { jobs, cacheWrites } = pending.get(doc)!;
  if (jobs.length && opts.textureFormat === "ktx2") {
    doc.createExtension(KHRTextureBasisu).setRequired(true);
    for (const j of jobs) j.tex.setMimeType("image/ktx2").setImage(await encodeKTX2(j.rgba, j.size, j.role, opts.ktx2Quality));
  } else await Promise.all(jobs.map(async (j) => j.tex.setImage(await encodeImage(j.rgba, j.size, j.alpha, j.asJpeg))));
  for (const w of cacheWrites)
    writeCachedTextures(w.key, w.parts.map((p) => ({ hash: p.hash, mime: p.tex.getMimeType() as EncodedImage["mime"], data: p.tex.getImage()! })));
  if (size > 0) {
    await doc.transform(unweld(), tangents({ generateTangents, overwrite: false }), weld(), dedup());
    fixZeroTangents(doc);
  }
  return doc;
}

/** Writers must know every extension the document may use, or they silently drop it. */
const io = () => new NodeIO().registerExtensions([KHRTextureBasisu, KHRLightsPunctual]);

export async function exportGLB(c: Compiled, opts: ExportOptions = {}): Promise<Uint8Array> {
  return io().writeBinary(await finalDocument(c, opts));
}

/** Write .gltf + .bin + separate image files (easier to swap textures by hand). */
export async function exportGLTF(c: Compiled, path: string, opts: ExportOptions = {}) {
  const doc = await finalDocument(c, opts);
  const ext = { "image/jpeg": "jpg", "image/ktx2": "ktx2" } as Record<string, string>;
  for (const t of doc.getRoot().listTextures()) t.setURI(`${t.getName()}.${ext[t.getMimeType()] ?? "png"}`);
  await io().write(path, doc);
}
