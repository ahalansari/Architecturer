import { parentPort } from "node:worker_threads";
import { generateTextures } from "./textures.js";
import type { MaterialDef } from "./types.js";

/** Worker side of texpool: paints one material per message and hands the pixels back without copying. */
parentPort!.on("message", ({ i, def, size }: { i: number; def: MaterialDef; size: number }) => {
  const t = generateTextures(def, size);
  parentPort!.postMessage({ i, t }, [t.baseColor.buffer, t.normal.buffer, t.orm.buffer] as ArrayBuffer[]);
});
