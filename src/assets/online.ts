/**
 * Open asset libraries (all CC0 unless noted):
 *  - ambientCG (ambientcg.com): ~2000 scanned / procedural PBR materials → material "ambientcg:<AssetId>"
 *  - Poly Haven (polyhaven.com): ~900 scanned PBR textures → material "polyhaven:<id>",
 *    and furniture / decor models → furniture model "polyhaven:<Model_Id>"
 *  - Sketchfab (sketchfab.com, CC licences, needs SKETCHFAB_API_TOKEN) → model "sketchfab:<uid>"
 *  - 3D-FUTURE (Alibaba Tianchi; 16k textured furniture models, research licence, download it yourself and set
 *    FUTURE3D_DIR) → model "future3d:<model_id>"
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { unzipSync } from "fflate";
import type { MaterialDef, TexturePattern } from "../materials/types.js";
import { cacheRoot, download, fetchCached, fetchJson } from "./cache.js";

export interface AssetHit {
  id: string;
  kind: "material" | "model";
  name: string;
  source: string;
  category?: string;
  tags: string[];
  /** Real-world size of one texture tile (m), or model size when known. */
  size?: number;
  preview?: string;
  license: string;
}

// ---------------------------------------------------------------------------
// pattern guess (plan hatching + offline stand-in)

const PATTERN_HINTS: [RegExp, TexturePattern][] = [
  [/herringbone/i, "herringbone"],
  [/chevron/i, "chevron"],
  [/parquet/i, "parquet"],
  [/hex/i, "hex_tiles"],
  [/mosaic/i, "mosaic"],
  [/zellige/i, "zellige"],
  [/terrazzo/i, "terrazzo"],
  [/marble|onyx/i, "marble"],
  [/tile|ceramic/i, "tiles"],
  [/floor.*wood|wood.*floor|plank|laminate/i, "wood_planks"],
  [/wood|bark|veneer|oak|walnut/i, "wood_grain"],
  [/brick/i, "brick"],
  [/paving|cobble/i, "paving"],
  [/stone|granite|slate|rock|travertine|limestone/i, "stone"],
  [/concrete|cement|asphalt/i, "concrete"],
  [/plaster|stucco|paint|wall/i, "plaster"],
  [/carpet|rug/i, "carpet"],
  [/fabric|cloth|linen|velvet|leather|wool/i, "fabric"],
  [/metal|steel|iron|alumin|copper|brass|gold/i, "metal"],
  [/gravel|pebble|ground|dirt|sand/i, "gravel"],
  [/grass|moss/i, "grass"],
  [/roof/i, "roof_tiles"],
];
export function guessPattern(text: string): TexturePattern {
  for (const [re, p] of PATTERN_HINTS) if (re.test(text)) return p;
  return "plaster";
}

const metalLike = (t: string) => /metal|steel|iron|alumin|copper|brass|gold|chrome|bronze/i.test(t);

// ---------------------------------------------------------------------------
// materials

/** Download + register an online material; returns its MaterialDef (image maps in the cache). */
export async function fetchOnlineMaterial(name: string, res: "1k" | "2k" = "1k"): Promise<MaterialDef> {
  const [src, ...rest] = name.split(":");
  const id = rest.join(":");
  if (src.toLowerCase() === "ambientcg") return ambientCG(name, id, res);
  if (src.toLowerCase() === "polyhaven") return polyHavenTexture(name, id, res);
  throw new Error(`unknown material source "${src}" (ambientcg, polyhaven)`);
}

interface AcgAsset {
  assetId: string;
  displayName: string;
  displayCategory?: string;
  tags?: string[];
  dimensionX?: number;
  downloadFolders?: { default?: { downloadFiletypeCategories?: { zip?: { downloads?: { attribute: string; downloadLink: string }[] } } } };
  previewImage?: Record<string, string>;
  maps?: string[];
}

async function ambientCG(name: string, id: string, res: string): Promise<MaterialDef> {
  const info = await fetchJson<{ foundAssets: AcgAsset[] }>(
    `https://ambientcg.com/api/v2/full_json?id=${encodeURIComponent(id)}&include=downloadData,dimensionsData,displayData,tagData`,
    24 * 30,
  );
  const a = info.foundAssets[0];
  if (!a) throw new Error(`ambientCG has no asset "${id}" (search_assets to find ids)`);
  const attr = `${res.toUpperCase()}-JPG`;
  const dl = a.downloadFolders?.default?.downloadFiletypeCategories?.zip?.downloads ?? [];
  const link = (dl.find((d) => d.attribute === attr) ?? dl.find((d) => /JPG/.test(d.attribute)))?.downloadLink;
  if (!link) throw new Error(`ambientCG "${a.assetId}" has no JPG download`);
  const dir = join(cacheRoot(), "ambientcg", `${a.assetId}_${attr}`);
  if (!existsSync(join(dir, ".done"))) {
    const zip = await fetchCached(link, { sub: "zips", ext: ".zip" });
    const files = unzipSync(new Uint8Array(await readFile(zip)));
    await mkdir(dir, { recursive: true });
    for (const [f, data] of Object.entries(files)) if (/\.(jpe?g|png)$/i.test(f)) await writeFile(join(dir, f.split("/").pop()!), data);
    await writeFile(join(dir, ".done"), "");
  }
  const files = readdirSync(dir);
  const pick = (re: RegExp) => {
    const f = files.find((x) => re.test(x));
    return f ? join(dir, f) : undefined;
  };
  const text = `${a.assetId} ${a.displayCategory ?? ""} ${(a.tags ?? []).join(" ")}`;
  const metal = pick(/_Metalness\./i);
  const opacity = pick(/_Opacity\./i);
  return {
    name,
    pattern: guessPattern(text),
    color: [1, 1, 1],
    roughness: 1,
    metalness: metal ? 1 : 0,
    scale: a.dimensionX ? a.dimensionX / 100 : 2,
    opacity: 1,
    normalStrength: 1,
    images: { baseColor: pick(/_Color\./i), normal: pick(/_NormalGL\./i), roughness: pick(/_Roughness\./i), ao: pick(/_AmbientOcclusion\./i), metalness: metal, alpha: !!opacity },
    ...(opacity ? { alphaCutoff: 0.5 } : {}),
    source: { id: `ambientcg:${a.assetId}`, title: a.displayName, url: `https://ambientcg.com/a/${a.assetId}`, author: "ambientCG", license: "CC0" },
  };
}

interface PhInfo {
  name: string;
  type: number;
  categories?: string[];
  tags?: string[];
  dimensions?: number[];
  authors?: Record<string, string>;
}
type PhFiles = Record<string, Record<string, Record<string, { url: string; include?: Record<string, { url: string }> }>>>;

async function polyHavenTexture(name: string, id: string, res: string): Promise<MaterialDef> {
  const info = await fetchJson<PhInfo>(`https://api.polyhaven.com/info/${encodeURIComponent(id)}`, 24 * 30).catch(() => null);
  if (!info || !info.name) throw new Error(`Poly Haven has no texture "${id}" (search_assets to find ids)`);
  const files = await fetchJson<PhFiles>(`https://api.polyhaven.com/files/${encodeURIComponent(id)}`, 24 * 30);
  const get = async (map: string) => {
    const u = files[map]?.[res]?.jpg?.url ?? files[map]?.[res]?.png?.url;
    return u ? fetchCached(u, { sub: "polyhaven" }) : undefined;
  };
  const text = `${id} ${(info.categories ?? []).join(" ")} ${(info.tags ?? []).join(" ")}`;
  const arm = await get("arm");
  return {
    name,
    pattern: guessPattern(text),
    color: [1, 1, 1],
    roughness: 1,
    metalness: metalLike(text) ? 1 : 0,
    scale: info.dimensions?.[0] ? info.dimensions[0] / 1000 : 2,
    opacity: 1,
    normalStrength: 1,
    images: { baseColor: await get("Diffuse"), normal: await get("nor_gl"), orm: arm, ao: arm },
    source: { id: `polyhaven:${id}`, title: info.name, url: `https://polyhaven.com/a/${id}`, author: Object.keys(info.authors ?? {}).join(", "), license: "CC0" },
  };
}

// ---------------------------------------------------------------------------
// models

/** Download an online model; returns the local path of its .gltf / .glb / .obj and its source info. */
export async function fetchOnlineModel(spec: string): Promise<{ path: string; source: { id: string; title?: string; url?: string; author?: string; license: string } }> {
  const [src, ...rest] = spec.split(":");
  const id = rest.join(":");
  switch (src.toLowerCase()) {
    case "polyhaven": {
      const info = await fetchJson<PhInfo>(`https://api.polyhaven.com/info/${encodeURIComponent(id)}`, 24 * 30).catch(() => null);
      if (!info?.name) throw new Error(`Poly Haven has no model "${id}" (search_assets kind=model)`);
      const files = await fetchJson<PhFiles>(`https://api.polyhaven.com/files/${encodeURIComponent(id)}`, 24 * 30);
      const g = files.gltf?.["1k"]?.gltf ?? files.gltf?.["2k"]?.gltf;
      if (!g) throw new Error(`Poly Haven "${id}" has no glTF download`);
      const dir = join(cacheRoot(), "models", "polyhaven", id);
      const main = join(dir, g.url.split("/").pop()!);
      if (!existsSync(main)) {
        for (const [rel, f] of Object.entries(g.include ?? {})) {
          const p = join(dir, rel);
          if (existsSync(p)) continue;
          await mkdir(dirname(p), { recursive: true });
          await writeFile(p, await download(f.url));
        }
        await mkdir(dir, { recursive: true });
        await writeFile(main, await download(g.url));
      }
      return { path: main, source: { id: `polyhaven:${id}`, title: info.name, url: `https://polyhaven.com/a/${id}`, author: Object.keys(info.authors ?? {}).join(", "), license: "CC0" } };
    }
    case "sketchfab": {
      const token = process.env.SKETCHFAB_API_TOKEN;
      if (!token) throw new Error("sketchfab models need SKETCHFAB_API_TOKEN (sketchfab.com → Settings → Password & API); only downloadable, CC-licensed models work");
      const meta = await fetchJson<{ name: string; license?: { label?: string; slug?: string }; user?: { displayName?: string; username?: string }; viewerUrl?: string }>(`https://api.sketchfab.com/v3/models/${id}`, 24 * 7);
      const dir = join(cacheRoot(), "models", "sketchfab", id);
      if (!existsSync(join(dir, ".done"))) {
        const res = await fetch(`https://api.sketchfab.com/v3/models/${id}/download`, { headers: { authorization: `Token ${token}` } });
        if (!res.ok) throw new Error(`sketchfab download of ${id} failed: HTTP ${res.status} (is the model downloadable?)`);
        const j = (await res.json()) as { glb?: { url: string }; gltf?: { url: string } };
        if (j.glb?.url) {
          await mkdir(dir, { recursive: true });
          await writeFile(join(dir, "model.glb"), await download(j.glb.url));
        } else if (j.gltf?.url) {
          const files = unzipSync(new Uint8Array(await download(j.gltf.url)));
          for (const [f, data] of Object.entries(files)) {
            if (f.endsWith("/")) continue;
            await mkdir(dirname(join(dir, f)), { recursive: true });
            await writeFile(join(dir, f), data);
          }
        } else throw new Error(`sketchfab ${id}: no glTF download offered`);
        await writeFile(join(dir, ".done"), "");
      }
      const path = existsSync(join(dir, "model.glb")) ? join(dir, "model.glb") : findFile(dir, /\.gltf$/i);
      if (!path) throw new Error(`sketchfab ${id}: no .gltf in the download`);
      const lic = meta.license?.label ?? meta.license?.slug ?? "see sketchfab";
      return { path, source: { id: `sketchfab:${id}`, title: meta.name, url: meta.viewerUrl ?? `https://sketchfab.com/3d-models/${id}`, author: meta.user?.displayName ?? meta.user?.username, license: lic } };
    }
    case "future3d": {
      const root = process.env.FUTURE3D_DIR;
      if (!root) throw new Error("future3d models need FUTURE3D_DIR pointing at the extracted 3D-FUTURE-model folder (Alibaba Tianchi dataset, research licence)");
      const dir = join(root, id);
      const path = ["raw_model.obj", "normalized_model.obj"].map((f) => join(dir, f)).find(existsSync);
      if (!path) throw new Error(`3D-FUTURE model ${id} not found in ${root}`);
      return { path, source: { id: `future3d:${id}`, title: id, url: "https://tianchi.aliyun.com/specials/promotion/alibaba-3d-future", author: "Alibaba 3D-FUTURE", license: "3D-FUTURE research licence (non-commercial)" } };
    }
  }
  throw new Error(`unknown model source "${src}" (polyhaven:, sketchfab:, future3d:, a URL or a local .glb/.gltf/.obj path)`);
}

function findFile(dir: string, re: RegExp): string | undefined {
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, f.name);
    if (f.isDirectory()) {
      const r = findFile(p, re);
      if (r) return r;
    } else if (re.test(f.name)) return p;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// search

const tokens = (q: string) => q.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
function score(q: string[], hay: string): number {
  let s = 0;
  for (const t of q) {
    if (hay.includes(` ${t} `)) s += 3;
    else if (hay.includes(t)) s += 1;
    else return -1;
  }
  return s;
}

/** Search the open libraries (and a local 3D-FUTURE copy) for materials or models. */
export async function searchAssets(query: string, o: { kind?: "material" | "model"; source?: string; limit?: number } = {}): Promise<AssetHit[]> {
  const kind = o.kind ?? "material";
  const limit = o.limit ?? 20;
  const q = tokens(query);
  const src = (o.source ?? "all").toLowerCase();
  const hits: (AssetHit & { rank: number })[] = [];
  const errors: string[] = [];
  if (kind === "material" && (src === "all" || src === "ambientcg")) {
    try {
      const r = await fetchJson<{ foundAssets: AcgAsset[] }>(
        `https://ambientcg.com/api/v2/full_json?type=Material&q=${encodeURIComponent(query)}&limit=${Math.min(60, limit * 2)}&sort=Popular&include=displayData,tagData,dimensionsData,imageData`,
        24,
      );
      r.foundAssets.forEach((a, i) =>
        hits.push({
          id: `ambientcg:${a.assetId}`, kind, name: a.displayName, source: "ambientCG", category: a.displayCategory, tags: a.tags ?? [],
          size: a.dimensionX ? a.dimensionX / 100 : undefined, preview: a.previewImage?.["256-PNG"], license: "CC0", rank: 100 - i,
        }),
      );
    } catch (e) {
      errors.push(`ambientCG: ${(e as Error).message}`);
    }
  }
  if (src === "all" || src === "polyhaven") {
    try {
      const all = await fetchJson<Record<string, PhInfo & { download_count?: number; thumbnail_url?: string }>>(
        `https://api.polyhaven.com/assets?t=${kind === "material" ? "textures" : "models"}`,
        24,
      );
      for (const [id, a] of Object.entries(all)) {
        const hay = ` ${id.replace(/_/g, " ").toLowerCase()} ${a.name.toLowerCase()} ${(a.categories ?? []).join(" ")} ${(a.tags ?? []).join(" ")} `;
        const s = q.length ? score(q, hay) : 0;
        if (s < 0) continue;
        hits.push({
          id: `polyhaven:${id}`, kind, name: a.name, source: "Poly Haven", category: (a.categories ?? []).join(", "), tags: a.tags ?? [],
          size: kind === "material" && a.dimensions?.[0] ? a.dimensions[0] / 1000 : undefined, preview: a.thumbnail_url, license: "CC0",
          rank: s * 10 + Math.log10(1 + (a.download_count ?? 0)),
        });
      }
    } catch (e) {
      errors.push(`Poly Haven: ${(e as Error).message}`);
    }
  }
  if (kind === "model" && (src === "all" || src === "future3d") && process.env.FUTURE3D_DIR) {
    try {
      const infoPath = [join(process.env.FUTURE3D_DIR, "model_info.json"), join(dirname(process.env.FUTURE3D_DIR), "model_info.json")].find(existsSync);
      if (infoPath) {
        const list = JSON.parse(readFileSync(infoPath, "utf8")) as { model_id: string; super_category?: string; category?: string; style?: string; theme?: string; material?: string }[];
        for (const m of list) {
          const hay = ` ${[m.super_category, m.category, m.style, m.theme, m.material].filter(Boolean).join(" ").toLowerCase()} `;
          const s = score(q, hay);
          if (s < 0) continue;
          hits.push({ id: `future3d:${m.model_id}`, kind, name: [m.style, m.category].filter(Boolean).join(" "), source: "3D-FUTURE", category: m.super_category, tags: [m.material, m.theme].filter(Boolean) as string[], license: "research", rank: s * 10 });
        }
      }
    } catch (e) {
      errors.push(`3D-FUTURE: ${(e as Error).message}`);
    }
  }
  if (!hits.length && errors.length) throw new Error(errors.join("; "));
  hits.sort((a, b) => b.rank - a.rank);
  return hits.slice(0, limit).map(({ rank: _r, ...h }) => h);
}
