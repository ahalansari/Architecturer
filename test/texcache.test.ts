import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { exportGLB } from "../src/export/gltf.js";
import { paintInWorkers } from "../src/materials/texpool.js";
import { generateTextures } from "../src/materials/textures.js";
import type { MaterialDef } from "../src/materials/types.js";
import { compile } from "../src/pipeline.js";
import { STARTER_PROJECT } from "../src/templates.js";

// a fresh cache for this file (set before the first export reads it)
process.env.ARCHITECTURER_CACHE = mkdtempSync(join(tmpdir(), "arch-cache-"));
const dir = join(process.env.ARCHITECTURER_CACHE, "textures");

test("texture cache: a warm build is byte-identical to a cold one, and a damaged entry is rebuilt", async () => {
  const c = compile(STARTER_PROJECT);
  const cold = await exportGLB(c, { textureSize: 64 });
  const entries = readdirSync(dir).filter((f) => f.endsWith(".bin"));
  assert.ok(entries.length > 3, "one cache entry per procedural material");

  const warm = await exportGLB(compile(STARTER_PROJECT), { textureSize: 64 });
  assert.deepEqual(warm, cold);

  truncateSync(join(dir, entries[0]), 10);
  const repaired = await exportGLB(compile(STARTER_PROJECT), { textureSize: 64 });
  assert.deepEqual(repaired, cold);
});

test("texture workers paint the same pixels as the main thread", async () => {
  const defs = (["brick", "marble", "terrazzo"] as const).map(
    (pattern) => ({ pattern, params: {}, color: [1, 1, 1], roughness: 0.7, metalness: 0, opacity: 1 }) as unknown as MaterialDef,
  );
  const painted = await paintInWorkers(defs, 64);
  defs.forEach((d, i) => assert.deepEqual(painted[i], generateTextures(d, 64), d.pattern));
});
