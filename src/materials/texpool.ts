import { availableParallelism } from "node:os";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { MaterialDef, TextureSet } from "./types.js";

/** Each worker holds a few float canvases (~30 MB at 1024 px) while it paints. */
const MAX_WORKERS = 8;

function spawn(): Worker {
  if (extname(fileURLToPath(import.meta.url)) !== ".ts") return new Worker(new URL("./texworker.js", import.meta.url));
  // under tsx a worker's entry isn't transpiled, so register tsx inside it before importing the .ts worker
  const tsx = JSON.stringify(import.meta.resolve("tsx/esm/api"));
  const entry = JSON.stringify(new URL("./texworker.ts", import.meta.url).href);
  return new Worker(`import(${tsx}).then((t) => { t.register(); return import(${entry}); })`, { eval: true });
}

/**
 * Paint procedural textures on worker threads, one per core up to MAX_WORKERS. Same pixels as
 * generateTextures (it is the same code); rejects if a worker fails.
 */
export async function paintInWorkers(defs: MaterialDef[], size: number): Promise<TextureSet[]> {
  const out = new Array<TextureSet>(defs.length);
  const workers = Array.from({ length: Math.min(defs.length, availableParallelism(), MAX_WORKERS) }, spawn);
  let next = 0;
  const run = (w: Worker) =>
    new Promise<void>((resolve, reject) => {
      const send = () => {
        if (next >= defs.length) return resolve();
        const i = next++;
        w.postMessage({ i, def: defs[i], size });
      };
      w.on("message", ({ i, t }: { i: number; t: TextureSet }) => {
        out[i] = t;
        send();
      });
      w.on("error", reject);
      w.on("exit", () => reject(new Error("texture worker exited early"))); // no-op once resolved
      send();
    });
  try {
    await Promise.all(workers.map(run));
  } finally {
    await Promise.all(workers.map((w) => w.terminate()));
  }
  return out;
}
