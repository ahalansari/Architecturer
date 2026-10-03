/**
 * Fetch / import every external asset a plan references before the (synchronous) compile:
 * online materials (ambientcg:, polyhaven:) and furniture / product models (URLs, polyhaven:, sketchfab:,
 * future3d:, local files). Models' natural sizes fill in missing furniture / product sizes. Failures become
 * warnings: materials get a procedural stand-in, models fall back to the parametric furniture.
 */
import { resolve } from "node:path";
import { ONLINE_RE } from "../materials/library.js";
import type { AssetSource, MaterialDef } from "../materials/types.js";
import { applyProducts } from "../elements/products.js";
import { loadModelFile, resolveModelPath } from "./models.js";
import { fetchOnlineMaterial, fetchOnlineModel, guessPattern } from "./online.js";
import { rotatedSize } from "./place.js";
import { externalMaterial, getModel, registerMaterial, registerModel } from "./registry.js";

export interface PrepareResult {
  input: unknown;
  warnings: string[];
  /** Informational: models simplified, vendor sizes corrected, texture formats converted... */
  notes: string[];
}

type Json = Record<string, unknown>;

const SKIP_KEYS = new Set(["model", "url", "image", "name", "notes", "description", "id", "vendor", "sku"]);

/** Run `fn` over items with at most `n` in flight. */
async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

const failed = new Map<string, string>();

export async function prepareAssets(raw: unknown, opts: { baseDir: string }): Promise<PrepareResult> {
  const warnings: string[] = [];
  const notes: string[] = [];
  if (!raw || typeof raw !== "object") return { input: raw, warnings, notes };
  const input = structuredClone(raw) as Json;

  // ---- online materials referenced anywhere (material fields, custom material bases, product materials) ----
  const mats = new Set<string>();
  const walk = (v: unknown, key?: string) => {
    if (typeof v === "string") {
      if (!SKIP_KEYS.has(key ?? "") && ONLINE_RE.test(v.trim())) mats.add(v.trim());
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(input);
  await pool([...mats], 4, async (name) => {
    if (externalMaterial(name)) return;
    try {
      registerMaterial(name, await fetchOnlineMaterial(name));
    } catch (e) {
      const msg = (e as Error).message;
      warnings.push(`material '${name}': ${msg}; using a procedural stand-in`);
      const stand: MaterialDef = {
        name, pattern: guessPattern(name), color: [0.8, 0.78, 0.74], roughness: 0.7, metalness: 0, scale: 1.5, opacity: 1, normalStrength: 1,
        source: { id: name, license: "unknown", missing: msg },
      };
      registerMaterial(name, stand);
    }
  });

  // ---- models: products first (so their sizes are known), then furniture ----
  const products = Array.isArray(input.products) ? (input.products as Json[]) : [];
  const levels = Array.isArray(input.levels) ? (input.levels as Json[]) : [];
  const keyFor = (src: string) => (/^(https?:|[a-z0-9]+:)/i.test(src) && !/^[a-z]:[\\/]/i.test(src) ? src : resolve(opts.baseDir, src));
  const titles = new Map<string, string>();
  for (const p of products) if (typeof p.model === "string" && typeof p.name === "string") titles.set(p.model, p.name);
  const load = async (src: string): Promise<string | null> => {
    const key = keyFor(src);
    if (getModel(key)) return key;
    if (failed.has(key)) {
      warnings.push(`model '${src}': ${failed.get(key)}`);
      return null;
    }
    try {
      const { path, source } = await resolveModelPath(src, opts.baseDir, fetchOnlineModel);
      if (titles.has(src)) source.title = titles.get(src);
      registerModel(await loadModelFile(path, key, source as AssetSource, (w) => notes.push(w)));
      return key;
    } catch (e) {
      const msg = (e as Error).message;
      failed.set(key, msg);
      warnings.push(`model '${src}': ${msg}`);
      return null;
    }
  };
  const srcs = new Set<string>();
  for (const p of products) if (typeof p.model === "string") srcs.add(p.model);
  for (const lv of levels) for (const f of (lv.furniture as Json[]) ?? []) if (f && typeof f.model === "string") srcs.add(f.model);
  const keys = new Map<string, string | null>();
  await pool([...srcs], 3, async (s) => void keys.set(s, await load(s)));

  // rewrite to canonical keys and fill natural sizes
  /** Canonical model key (or drop a model that failed to load). */
  const canon = (o: Json): boolean => {
    const k = keys.get(o.model as string);
    if (k === undefined) return getModel(o.model as string) !== undefined;
    if (k === null) {
      delete o.model;
      return false;
    }
    o.model = k;
    return true;
  };
  /** Missing sizes from the model (proportionally when some are given). */
  const fill = (o: Json) => {
    if (!canon(o)) return;
    const k = o.model as string;
    const m = getModel(k)!;
    const [w, d, h] = rotatedSize(m, Number(o.modelRotation ?? 0));
    // with only some sizes given, keep proportions: derive the rest from the given ones
    const given = (["width", "depth", "height"] as const).filter((x) => typeof o[x] === "number");
    if (given.length && given.length < 3) {
      const nat = { width: w, depth: d, height: h };
      const s = Math.min(...given.map((x) => (o[x] as number) / nat[x]));
      for (const x of ["width", "depth", "height"] as const) if (o[x] === undefined) o[x] = Math.round(nat[x] * s * 1000) / 1000;
    } else if (!given.length) {
      o.width = Math.round(w * 1000) / 1000;
      o.depth = Math.round(d * 1000) / 1000;
      o.height = Math.round(h * 1000) / 1000;
    }
  };
  for (const p of products)
    if (p.model) {
      // a real model knows its own size: vendor page sizes are kept as information (and for stand-ins if the
      // model fails), but placements use the model's geometry unless the furniture item sizes it itself
      if (canon(p) && getModel(p.model as string)) {
        const m = getModel(p.model as string)!;
        const [w, d, h] = rotatedSize(m, Number(p.modelRotation ?? 0));
        const given = [p.width, p.depth, p.height] as (number | undefined)[];
        const off = given.some((v, i) => typeof v === "number" && Math.abs(v - [w, d, h][i]) > Math.max(0.05, 0.12 * [w, d, h][i]));
        if (off) notes.push(`product '${p.id}': listed size ${given.map((v) => v?.toFixed(2) ?? "?").join("×")} differs from its model (${[w, d, h].map((v) => v.toFixed(2)).join("×")}); using the model`);
        delete p.width, delete p.depth, delete p.height;
      }
      // credit vendor / product models by the product, not the file name
      const m = typeof p.model === "string" ? getModel(p.model) : undefined;
      if (m)
        Object.assign(m.source, {
          title: p.name ?? m.source.title,
          author: p.vendor ?? m.source.author,
          url: p.url ?? m.source.url,
          license: (p.license as string | undefined) ?? m.source.license,
        });
    }
  // product sizes now flow into furniture via applyProducts; furniture models fill their own
  const expanded = applyProducts(input);
  const out = expanded.input as Json;
  for (const lv of (out.levels as Json[]) ?? []) for (const f of (lv.furniture as Json[]) ?? []) if (f && typeof f.model === "string") {
    if (!keys.has(f.model)) keys.set(f.model, getModel(f.model) ? f.model : await load(f.model));
    fill(f);
  }
  return { input: out, warnings, notes };
}

/** Credits for the external assets a compiled plan uses (for exports and the README of a game build). */
export function creditsFor(materials: Iterable<MaterialDef>): AssetSource[] {
  const seen = new Map<string, AssetSource>();
  for (const m of materials) if (m.source && !m.source.id.startsWith("RAL")) seen.set(m.source.id, m.source);
  return [...seen.values()];
}
