import { Document, NodeIO, type Material, type Node as GNode, type Texture } from "@gltf-transform/core";
import { dedup, tangents, unweld, weld } from "@gltf-transform/functions";
import { createHash } from "node:crypto";
import { encode as encodeJPEG } from "jpeg-js";
import { generateTangents } from "mikktspace";
import { PNG } from "pngjs";
import type { SceneNode } from "../geometry/scene.js";
import { COLLIDER } from "../elements/stairs.js";
import { prepareForGame, type GameOptions } from "./game.js";
import type { MaterialDef, TextureSet } from "../materials/types.js";
import { texturesFor, type Compiled } from "../pipeline.js";

export interface ExportOptions extends GameOptions {
  /**
   * Rotate the export 180° about the vertical axis so that, after Unity's glTF importer converts
   * handedness, plan (x, y) lands exactly on Unity world (x, z).
   */
  unityAxes?: boolean;
  /** Texture resolution in pixels (power of two recommended). 0 disables textures. */
  textureSize?: number;
  /**
   * Image encoding for opaque base color and ORM maps (default "jpeg", much smaller).
   * Normal maps and base colors with alpha are always PNG.
   */
  textureFormat?: "png" | "jpeg";
}

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

function png(size: number, rgba: Uint8Array, alpha: boolean): Uint8Array {
  const img = new PNG({ width: size, height: size, colorType: alpha ? 6 : 2 });
  img.data = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  return new Uint8Array(PNG.sync.write(img, { colorType: alpha ? 6 : 2 }));
}

const JPEG_QUALITY = 90;

function jpeg(size: number, rgba: Uint8Array): Uint8Array {
  return new Uint8Array(encodeJPEG({ width: size, height: size, data: rgba }, JPEG_QUALITY).data);
}

/**
 * Convert the compiled scene to a glTF document.
 * Plan space (Z-up) maps to glTF Y-up as (x, y, z) -> (x, z, -y).
 */
export function toGltfDocument(c: Compiled, opts: ExportOptions = {}): Document {
  if (!c.root || !c.project) throw new Error("nothing to export: " + c.errors.join("; "));
  const size = opts.textureSize ?? 512;
  const lossy = (opts.textureFormat ?? "jpeg") === "jpeg";
  const doc = new Document();
  doc.getRoot().getAsset().generator = "Architecturer";
  const buffer = doc.createBuffer();
  const scene = doc.createScene(c.project.name);
  scene.setExtras({ description: c.project.description ?? "", units: "meters", upAxis: "Y", planAxes: opts.unityAxes ? "unity" : "gltf" });

  const mats = new Map<string, Material>();
  const textures = new Map<TextureSet, { base: Texture; normal: Texture; orm: Texture }>();
  // identical images (e.g. normal maps shared by roughness variants) are stored once
  const images = new Map<string, Texture>();
  const image = (name: string, size: number, rgba: Uint8Array, alpha: boolean, allowJpeg: boolean): Texture => {
    const asJpeg = allowJpeg && lossy && !alpha;
    const key = createHash("sha1").update(rgba).digest("hex") + (alpha ? "a" : "") + (asJpeg ? "j" : "");
    let t = images.get(key);
    if (!t) {
      t = doc.createTexture(name);
      if (asJpeg) t.setMimeType("image/jpeg").setImage(jpeg(size, rgba));
      else t.setMimeType("image/png").setImage(png(size, rgba, alpha));
      images.set(key, t);
    }
    return t;
  };
  const materialFor = (name: string): Material => {
    let m = mats.get(name);
    if (m) return m;
    const def: MaterialDef = c.materials.get(name)!;
    m = doc.createMaterial(name).setRoughnessFactor(1).setMetallicFactor(1).setDoubleSided(!!def.doubleSided);
    const tex = size > 0 ? texturesFor(def, size) : undefined;
    const lin = def.color.map(srgbToLinear);
    if (tex) {
      let t = textures.get(tex);
      if (!t) {
        const alpha = def.opacity < 1;
        // JPEG artifacts would show up as bumps in normal maps, so those stay lossless
        t = {
          base: image(`${name}_basecolor`, tex.size, tex.baseColor, alpha, true),
          normal: image(`${name}_normal`, tex.size, tex.normal, false, false),
          orm: image(`${name}_orm`, tex.size, tex.orm, false, true),
        };
        textures.set(tex, t);
      }
      // textures are untinted and shared by tinted variants: the tint is the factor, opacity is baked into alpha
      m.setBaseColorFactor([lin[0], lin[1], lin[2], 1])
        .setBaseColorTexture(t.base)
        .setNormalTexture(t.normal)
        .setMetallicRoughnessTexture(t.orm)
        .setOcclusionTexture(t.orm);
    } else {
      m.setBaseColorFactor([lin[0], lin[1], lin[2], def.opacity]).setRoughnessFactor(def.roughness).setMetallicFactor(def.metalness);
    }
    if (def.opacity < 1) m.setAlphaMode("BLEND");
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
        mesh.addPrimitive(prim);
      }
      g.setMesh(mesh);
    }
    for (const ch of n.children) g.addChild(convert(ch));
    return g;
  };
  scene.addChild(convert(prepareForGame(c.root, opts)));
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
  const doc = toGltfDocument(c, opts);
  if ((opts.textureSize ?? 512) > 0) {
    await doc.transform(unweld(), tangents({ generateTangents, overwrite: false }), weld(), dedup());
    fixZeroTangents(doc);
  }
  return doc;
}

export async function exportGLB(c: Compiled, opts: ExportOptions = {}): Promise<Uint8Array> {
  return new NodeIO().writeBinary(await finalDocument(c, opts));
}

/** Write .gltf + .bin + separate PNG/JPEG textures (easier to swap textures by hand). */
export async function exportGLTF(c: Compiled, path: string, opts: ExportOptions = {}) {
  const doc = await finalDocument(c, opts);
  for (const t of doc.getRoot().listTextures()) t.setURI(`${t.getName()}.${t.getMimeType() === "image/jpeg" ? "jpg" : "png"}`);
  await new NodeIO().write(path, doc);
}
