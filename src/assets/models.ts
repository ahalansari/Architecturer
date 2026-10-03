/**
 * Import external 3D models (glTF / GLB incl. Draco + meshopt compression, Wavefront OBJ + MTL) into plan space:
 * z up, metres, front facing -y (glTF's +Z front), footprint centred on the origin, bottom at z = 0.
 * Every model material becomes a registered MaterialDef ("model:<key>:<n>") with its textures extracted
 * to the cache, so the rest of the pipeline (renderer, glTF / Unity export, KTX2) treats it like any other material.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { NodeIO, type Document, type Material as GMaterial, type Texture } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import type { MeshData } from "../geometry/mesh.js";
import type { AssetSource, MaterialDef, RGB } from "../materials/types.js";
import { cachePathFor, cacheRoot, download, fetchCached, hashOf } from "./cache.js";
import { registerMaterial, type ImportedModel } from "./registry.js";
import { webpToPng } from "./images.js";

let ioPromise: Promise<NodeIO> | null = null;
async function getIO(): Promise<NodeIO> {
  if (!ioPromise)
    ioPromise = (async () => {
      const draco3d = (await import("draco3dgltf")).default as { createDecoderModule: () => Promise<unknown> };
      const { MeshoptDecoder } = await import("meshoptimizer");
      await MeshoptDecoder.ready;
      return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
        "draco3d.decoder": await draco3d.createDecoderModule(),
        "meshopt.decoder": MeshoptDecoder,
      });
    })();
  return ioPromise;
}

const toSrgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

/** Download a model URL (and, for .gltf / .obj, the files it references) into the cache. */
export async function fetchModelUrl(url: string): Promise<string> {
  const ext = extname(url.split(/[?#]/)[0]).toLowerCase() || ".glb";
  const dir = join(cacheRoot(), "models", "url", hashOf(url));
  const main = join(dir, `model${ext === ".gltf" || ext === ".obj" ? ext : ".glb"}`);
  if (existsSync(main)) return main;
  const buf = await download(url);
  await mkdir(dir, { recursive: true });
  const base = url.split(/[?#]/)[0].replace(/[^/]*$/, "");
  const fetchRel = async (rel: string) => {
    if (/^(data:|https?:)/.test(rel)) return;
    const p = join(dir, decodeURIComponent(rel));
    if (existsSync(p)) return;
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, await download(new URL(rel, base).href));
  };
  if (ext === ".gltf") {
    const j = JSON.parse(buf.toString("utf8")) as { buffers?: { uri?: string }[]; images?: { uri?: string }[] };
    for (const r of [...(j.buffers ?? []), ...(j.images ?? [])]) if (r.uri) await fetchRel(r.uri);
  } else if (ext === ".obj") {
    for (const m of buf.toString("utf8").matchAll(/^mtllib\s+(.+)$/gm)) {
      const rel = m[1].trim();
      await fetchRel(rel);
      const mtl = readFileSync(join(dir, rel), "utf8");
      for (const t of mtl.matchAll(/^\s*(?:map_Kd|map_Bump|bump|norm|map_d|map_Pr)\s+(?:-\S+\s+\S+\s+)*(\S+)\s*$/gm)) await fetchRel(t[1]).catch(() => undefined);
    }
  }
  await writeFile(main, buf);
  return main;
}

// ---------------------------------------------------------------------------

interface RawMesh {
  material: number;
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
}

/** Load a model file and register its materials. `key` names the materials; `source` is stored for credits. */
export async function loadModelFile(path: string, key: string, source: AssetSource, warn: (m: string) => void = () => {}): Promise<ImportedModel> {
  const ext = extname(path).toLowerCase();
  const tag = hashOf(key, 10);
  let raw: RawMesh[];
  let mats: MaterialDef[];
  if (ext === ".obj") ({ raw, mats } = loadObj(path, tag, source, warn));
  else ({ raw, mats } = await loadGltf(path, tag, source, warn));
  if (!raw.length) throw new Error(`${path}: no triangle meshes found`);

  // bounds → centre the footprint, bottom on z = 0; OBJ files have no units: guess from the size
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const m of raw)
    for (let i = 0; i < m.positions.length; i += 3)
      for (let k = 0; k < 3; k++) (min[k] = Math.min(min[k], m.positions[i + k])), (max[k] = Math.max(max[k], m.positions[i + k]));
  let unit = 1;
  const ext3 = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  if (ext === ".obj") {
    if (ext3 > 200) unit = 0.001;
    else if (ext3 > 20) unit = 0.01;
    else if (ext3 > 8) unit = 0.0254;
    if (unit !== 1) warn(`model ${source.id}: OBJ has no units; ${ext3.toFixed(0)} units across, read as ${unit === 0.001 ? "mm" : unit === 0.01 ? "cm" : "inches"}`);
  }
  // game budget by size: ~7k triangles for a lamp, ~10k for a chair, up to 20k for a sofa or bed
  // (ARCHITECTURER_MODEL_TRIANGLES sets a fixed budget; 0 keeps full detail)
  const before = raw.reduce((a, m) => a + m.indices.length / 3, 0);
  const env = process.env.ARCHITECTURER_MODEL_TRIANGLES;
  const budget = env !== undefined ? Number(env) : Math.round(Math.min(20000, Math.max(5000, 2500 + 9000 * ext3 * unit)));
  if (budget > 0 && before > budget * 1.15) {
    await simplifyMeshes(raw, budget / before);
    const after = raw.reduce((a, m) => a + m.indices.length / 3, 0);
    warn(`model ${source.title ?? source.id}: simplified ${Math.round(before / 1000)}k → ${Math.round(after / 1000)}k triangles for real-time use (ARCHITECTURER_MODEL_TRIANGLES=0 keeps full detail)`);
  }
  const cx = (min[0] + max[0]) / 2, cy = (min[1] + max[1]) / 2, z0 = min[2];
  let triangles = 0;
  const meshes: MeshData[] = raw.map((m) => {
    const positions = m.positions.slice();
    for (let i = 0; i < positions.length; i += 3) {
      positions[i] = (positions[i] - cx) * unit;
      positions[i + 1] = (positions[i + 1] - cy) * unit;
      positions[i + 2] = (positions[i + 2] - z0) * unit;
    }
    triangles += m.indices.length / 3;
    return { material: mats[m.material]?.name ?? mats[0].name, positions, normals: m.normals, uvs: m.uvs, indices: m.indices };
  });
  if (triangles > 300_000) warn(`model ${source.id}: ${Math.round(triangles / 1000)}k triangles — heavy for real-time use; prefer a lighter LOD`);
  for (const d of mats) registerMaterial(d.name, d);
  return { key, meshes, size: [(max[0] - min[0]) * unit, (max[1] - min[1]) * unit, (max[2] - min[2]) * unit], triangles, source };
}

// ---------------------------------------------------------------------------
// glTF

async function loadGltf(path: string, tag: string, source: AssetSource, warn: (m: string) => void): Promise<{ raw: RawMesh[]; mats: MaterialDef[] }> {
  const io = await getIO();
  let doc: Document;
  try {
    doc = await io.read(path);
  } catch (e) {
    throw new Error(`${path}: could not read glTF (${(e as Error).message})`);
  }
  const root = doc.getRoot();
  const gm = root.listMaterials();
  const mats: MaterialDef[] = await Promise.all(gm.map((m, i) => gltfMaterial(m, `model:${tag}:${i}`, source, warn)));
  const fallback = gm.length;
  mats.push({ name: `model:${tag}:${fallback}`, pattern: "none", color: [0.8, 0.8, 0.8], roughness: 0.6, metalness: 0, scale: 1, opacity: 1, normalStrength: 1, source });
  const raw: RawMesh[] = [];
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  const visit = (node: ReturnType<typeof root.listNodes>[number]) => {
    const mesh = node.getMesh();
    if (mesh) {
      const W = node.getWorldMatrix();
      // normal matrix = inverse transpose of the upper 3x3
      const a = [W[0], W[1], W[2], W[4], W[5], W[6], W[8], W[9], W[10]];
      const det = a[0] * (a[4] * a[8] - a[5] * a[7]) - a[3] * (a[1] * a[8] - a[2] * a[7]) + a[6] * (a[1] * a[5] - a[2] * a[4]);
      const inv = (r: number, c: number) => {
        // cofactor / det, transposed → (inverse transpose)[r][c] = cof(r,c)/det in column-major terms
        const m = (i: number, j: number) => a[j * 3 + i];
        const rows = [0, 1, 2].filter((x) => x !== r), cols = [0, 1, 2].filter((x) => x !== c);
        const minor = m(rows[0], cols[0]) * m(rows[1], cols[1]) - m(rows[0], cols[1]) * m(rows[1], cols[0]);
        return (((r + c) % 2 ? -1 : 1) * minor) / (det || 1);
      };
      const N = [0, 1, 2].map((r) => [0, 1, 2].map((c) => inv(r, c)));
      for (const prim of mesh.listPrimitives()) {
        if (prim.getMode() !== 4) continue; // triangles only
        const pos = prim.getAttribute("POSITION");
        if (!pos) continue;
        const nor = prim.getAttribute("NORMAL"), uv = prim.getAttribute("TEXCOORD_0"), idx = prim.getIndices();
        const n = pos.getCount();
        const out: RawMesh = { material: Math.max(0, gm.indexOf(prim.getMaterial()!)), positions: [], normals: [], uvs: [], indices: [] };
        if (!prim.getMaterial()) out.material = fallback;
        const e: number[] = [];
        for (let i = 0; i < n; i++) {
          pos.getElement(i, e);
          const x = W[0] * e[0] + W[4] * e[1] + W[8] * e[2] + W[12];
          const y = W[1] * e[0] + W[5] * e[1] + W[9] * e[2] + W[13];
          const z = W[2] * e[0] + W[6] * e[1] + W[10] * e[2] + W[14];
          // glTF (x, y up, z front) → plan (x, -z, y)
          out.positions.push(x, -z, y);
          if (nor) {
            nor.getElement(i, e);
            let nx = N[0][0] * e[0] + N[0][1] * e[1] + N[0][2] * e[2];
            let ny = N[1][0] * e[0] + N[1][1] * e[1] + N[1][2] * e[2];
            let nz = N[2][0] * e[0] + N[2][1] * e[1] + N[2][2] * e[2];
            const l = Math.hypot(nx, ny, nz) || 1;
            (nx /= l), (ny /= l), (nz /= l);
            out.normals.push(nx, -nz, ny);
          }
          if (uv) {
            uv.getElement(i, e);
            out.uvs.push(e[0], e[1]);
          } else out.uvs.push(0, 0);
        }
        const flip = det < 0;
        const ind = idx ? Array.from(idx.getArray()!) : [...Array(n).keys()];
        for (let t = 0; t + 2 < ind.length; t += 3) flip ? out.indices.push(ind[t], ind[t + 2], ind[t + 1]) : out.indices.push(ind[t], ind[t + 1], ind[t + 2]);
        if (!nor) computeNormals(out);
        raw.push(out);
      }
    }
    for (const c of node.listChildren()) visit(c);
  };
  for (const n of scene?.listChildren() ?? []) visit(n);
  return { raw, mats };
}

async function gltfMaterial(m: GMaterial, name: string, source: AssetSource, warn: (m: string) => void): Promise<MaterialDef> {
  const f = m.getBaseColorFactor();
  const save = async (t: Texture | null, what: string): Promise<string | undefined> => {
    if (!t) return undefined;
    let img = t.getImage();
    let mime = t.getMimeType();
    if (!img) return undefined;
    if (mime === "image/webp") {
      try {
        img = new Uint8Array(await webpToPng(img));
        mime = "image/png";
      } catch (e) {
        warn(`model ${source.id}: ${what} WebP texture could not be decoded (${(e as Error).message}); using flat colour`);
        return undefined;
      }
    }
    if (mime !== "image/png" && mime !== "image/jpeg") {
      warn(`model ${source.id}: ${what} texture is ${mime}, which cannot be decoded; using flat colour`);
      return undefined;
    }
    const p = cachePathFor(`${name}:${what}:${hashOf(Buffer.from(img.subarray(0, 4096)).toString("base64") + img.length)}`, "model-tex", mime === "image/png" ? ".png" : ".jpg");
    if (!existsSync(p)) {
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, img);
    }
    return p;
  };
  const base = await save(m.getBaseColorTexture(), "basecolor");
  const mr = await save(m.getMetallicRoughnessTexture(), "metalrough");
  const occ = await save(m.getOcclusionTexture(), "occlusion");
  const nrm = await save(m.getNormalTexture(), "normal");
  const blend = m.getAlphaMode() === "BLEND";
  const mask = m.getAlphaMode() === "MASK";
  const e = m.getEmissiveFactor();
  return {
    name,
    pattern: "none",
    color: [toSrgb(f[0]), toSrgb(f[1]), toSrgb(f[2])] as RGB,
    roughness: m.getRoughnessFactor(),
    metalness: m.getMetallicFactor(),
    scale: 1,
    opacity: blend ? f[3] : 1,
    normalStrength: 1,
    doubleSided: m.getDoubleSided() || undefined,
    ...(e.some((v) => v > 0) ? { emissive: e.map(toSrgb) as RGB } : {}),
    ...(base || mr || nrm || occ ? { images: { baseColor: base, orm: mr, normal: nrm, ao: occ, alpha: blend || mask } } : {}),
    ...(mask ? { alphaCutoff: m.getAlphaCutoff() } : {}),
    source,
  };
}

/** Reduce each mesh to about `ratio` of its triangles (meshoptimizer), then drop unused vertices. */
async function simplifyMeshes(raw: RawMesh[], ratio: number) {
  const { MeshoptSimplifier } = await import("meshoptimizer");
  await MeshoptSimplifier.ready;
  for (const m of raw) {
    const tris = m.indices.length / 3;
    if (tris < 200) continue;
    const target = Math.max(3, Math.floor(tris * ratio) * 3);
    // attribute-aware (UVs + normals weigh in, so textures do not smear across seams); loosen the allowed error
    // a little at a time and stop short of the target rather than distort the model
    const attrs = new Float32Array((m.positions.length / 3) * 5);
    for (let v = 0; v < m.positions.length / 3; v++) {
      attrs[v * 5] = m.uvs[v * 2] ?? 0;
      attrs[v * 5 + 1] = m.uvs[v * 2 + 1] ?? 0;
      attrs[v * 5 + 2] = m.normals[v * 3] ?? 0;
      attrs[v * 5 + 3] = m.normals[v * 3 + 1] ?? 0;
      attrs[v * 5 + 4] = m.normals[v * 3 + 2] ?? 0;
    }
    let idx: Uint32Array = new Uint32Array(m.indices);
    for (const err of [0.005, 0.01, 0.02, 0.035]) {
      [idx] = MeshoptSimplifier.simplifyWithAttributes(new Uint32Array(m.indices), new Float32Array(m.positions), 3, attrs, 5, [1, 1, 0.3, 0.3, 0.3], null, target, err, []);
      if (idx.length <= target * 1.2) break;
    }
    // compact the vertex arrays to the vertices still referenced
    const remap = new Map<number, number>();
    const P: number[] = [], N: number[] = [], U: number[] = [], I: number[] = [];
    for (const v of idx) {
      let k = remap.get(v);
      if (k === undefined) {
        k = remap.size;
        remap.set(v, k);
        P.push(m.positions[v * 3], m.positions[v * 3 + 1], m.positions[v * 3 + 2]);
        if (m.normals.length) N.push(m.normals[v * 3], m.normals[v * 3 + 1], m.normals[v * 3 + 2]);
        U.push(m.uvs[v * 2] ?? 0, m.uvs[v * 2 + 1] ?? 0);
      }
      I.push(k);
    }
    Object.assign(m, { positions: P, normals: N, uvs: U, indices: I });
  }
}

function computeNormals(m: RawMesh) {
  const n = new Array(m.positions.length).fill(0);
  const P = m.positions;
  for (let t = 0; t < m.indices.length; t += 3) {
    const [a, b, c] = [m.indices[t] * 3, m.indices[t + 1] * 3, m.indices[t + 2] * 3];
    const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], v = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
    const cr = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    for (const k of [a, b, c]) for (let j = 0; j < 3; j++) n[k + j] += cr[j];
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    (n[i] /= l), (n[i + 1] /= l), (n[i + 2] /= l);
  }
  m.normals = n;
}

// ---------------------------------------------------------------------------
// OBJ + MTL

function loadObj(path: string, tag: string, source: AssetSource, warn: (m: string) => void): { raw: RawMesh[]; mats: MaterialDef[] } {
  const text = readFileSync(path, "utf8");
  const dir = dirname(path);
  const v: number[][] = [], vt: number[][] = [], vn: number[][] = [];
  const mtlNames: string[] = [];
  const mats: MaterialDef[] = [];
  const mtlDefs = new Map<string, MaterialDef>();
  const groups = new Map<number, { faces: number[][][] }>();
  let cur = -1;
  const useMat = (nm: string) => {
    let i = mtlNames.indexOf(nm);
    if (i < 0) {
      i = mtlNames.length;
      mtlNames.push(nm);
    }
    cur = i;
  };
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t[0] === "#") continue;
    const [k, ...r] = t.split(/\s+/);
    if (k === "v") v.push(r.slice(0, 3).map(Number));
    else if (k === "vt") vt.push(r.slice(0, 2).map(Number));
    else if (k === "vn") vn.push(r.slice(0, 3).map(Number));
    else if (k === "usemtl") useMat(r.join(" "));
    else if (k === "mtllib") for (const [nm, d] of parseMtl(join(dir, r.join(" ")), tag, source, warn)) mtlDefs.set(nm, d);
    else if (k === "f") {
      if (cur < 0) useMat("default");
      const g = groups.get(cur) ?? { faces: [] };
      g.faces.push(
        r.map((c) => {
          const [a, b, n] = c.split("/").map((x) => (x ? parseInt(x, 10) : 0));
          const fix = (i: number, len: number) => (i < 0 ? len + i : i - 1);
          return [fix(a, v.length), b ? fix(b, vt.length) : -1, n ? fix(n, vn.length) : -1];
        }),
      );
      groups.set(cur, g);
    }
  }
  // texture-mapped single-texture objects (3D-FUTURE: texture.png next to the obj, no mtl)
  const loneTex = ["texture.png", "texture.jpg"].map((f) => join(dir, f)).find(existsSync);
  mtlNames.forEach((nm, i) => {
    const d = mtlDefs.get(nm);
    const name = `model:${tag}:${i}`;
    mats.push(
      d ? { ...d, name }
        : { name, pattern: "none", color: [0.8, 0.8, 0.8], roughness: 0.6, metalness: 0, scale: 1, opacity: 1, normalStrength: 1, ...(loneTex ? { images: { baseColor: loneTex } } : {}), source },
    );
  });
  const raw: RawMesh[] = [];
  for (const [mi, g] of groups) {
    const m: RawMesh = { material: mi, positions: [], normals: [], uvs: [], indices: [] };
    let hasN = true;
    for (const face of g.faces) {
      const base = m.positions.length / 3;
      for (const [pi, ti, ni] of face) {
        const p = v[pi] ?? [0, 0, 0];
        // OBJ is usually Y-up like glTF: (x, y, z) → plan (x, -z, y)
        m.positions.push(p[0], -p[2], p[1]);
        const uv = ti >= 0 ? vt[ti] : [0, 0];
        m.uvs.push(uv[0], 1 - uv[1]);
        if (ni >= 0 && vn[ni]) m.normals.push(vn[ni][0], -vn[ni][2], vn[ni][1]);
        else hasN = false;
      }
      for (let k = 1; k + 1 < face.length; k++) m.indices.push(base, base + k, base + k + 1);
    }
    if (!hasN) computeNormals(m);
    raw.push(m);
  }
  return { raw, mats };
}

function parseMtl(path: string, tag: string, source: AssetSource, warn: (m: string) => void): Map<string, MaterialDef> {
  const out = new Map<string, MaterialDef>();
  if (!existsSync(path)) {
    warn(`model ${source.id}: material library ${path} not found`);
    return out;
  }
  const dir = dirname(path);
  let cur: MaterialDef | null = null;
  const file = (r: string[]) => {
    // skip options like -bm 1.0
    const rest = [...r];
    while (rest.length > 1 && rest[0].startsWith("-")) rest.splice(0, 2);
    const p = resolve(dir, rest.join(" ").replace(/\\/g, "/"));
    return existsSync(p) && /\.(png|jpe?g)$/i.test(p) ? p : undefined;
  };
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const [k, ...r] = line.trim().split(/\s+/);
    if (k === "newmtl") {
      cur = { name: `model:${tag}:${r.join(" ")}`, pattern: "none", color: [0.8, 0.8, 0.8], roughness: 0.6, metalness: 0, scale: 1, opacity: 1, normalStrength: 1, source };
      out.set(r.join(" "), cur);
    } else if (!cur) continue;
    else if (k === "Kd") cur.color = r.slice(0, 3).map(Number) as RGB;
    else if (k === "Ns") cur.roughness = Math.max(0.05, Math.min(1, 1 - Math.sqrt(Number(r[0]) / 1000)));
    else if (k === "d") cur.opacity = Number(r[0]);
    else if (k === "Tr") cur.opacity = 1 - Number(r[0]);
    else if (k === "Pr") cur.roughness = Number(r[0]);
    else if (k === "Pm") cur.metalness = Number(r[0]);
    else if (k === "map_Kd") {
      const p = file(r);
      if (p) cur.images = { ...(cur.images ?? {}), baseColor: p };
      if (p) cur.color = [1, 1, 1];
    } else if (k === "map_Bump" || k === "bump" || k === "norm") {
      const p = file(r);
      if (p && /nor/i.test(p)) cur.images = { ...(cur.images ?? {}), normal: p };
    } else if (k === "map_Pr") {
      const p = file(r);
      if (p) cur.images = { ...(cur.images ?? {}), roughness: p };
    }
  }
  return out;
}

/** Model file for a source string: URL, cached online asset, or a local path (relative to baseDir). */
export async function resolveModelPath(src: string, baseDir: string, online: (s: string) => Promise<{ path: string; source: AssetSource }>): Promise<{ path: string; source: AssetSource }> {
  if (/^https?:\/\//i.test(src)) {
    const host = new URL(src).hostname.replace(/^www\./, "");
    const vendor = /ikea\./i.test(host);
    return { path: await fetchModelUrl(src), source: { id: src, url: src, title: src.split("/").pop(), license: vendor ? "vendor" : "unknown (check the source)" } };
  }
  if (/^[a-z0-9]+:/i.test(src) && !/^[a-z]:[\\/]/i.test(src)) return online(src);
  const p = resolve(baseDir, src);
  if (!existsSync(p)) throw new Error(`model file not found: ${p}`);
  return { path: p, source: { id: src, title: src.split(/[\\/]/).pop(), license: "local file" } };
}

export { fetchCached };
