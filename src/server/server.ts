import { createReadStream, existsSync, watch } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exportGLB } from "../export/gltf.js";
import { loadAndCompile } from "../io.js";
import type { Compiled } from "../pipeline.js";
import { PLAN_SHEETS, renderPlanSVG, type PlanSheet } from "../render/plan.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const VIEWER = join(ROOT, "viewer");
const THREE = join(ROOT, "node_modules/three");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".glb": "model/gltf-binary",
  ".wasm": "application/wasm",
};

function sendFile(res: ServerResponse, base: string, rel: string) {
  const p = normalize(join(base, rel));
  if (!p.startsWith(base) || !existsSync(p)) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": MIME[extname(p)] ?? "application/octet-stream" });
  createReadStream(p).pipe(res);
}

/** Serve the 3D viewer for a plan file; browsers reload automatically when the file changes. */
export async function serve(planPath: string, opts: { port: number; textureSize?: number }) {
  const file = resolve(planPath);
  let cache: { mtime: number; compiled: Compiled; glb: Map<string, Uint8Array> } | undefined;
  // compiles fetch online assets (seconds on a cold cache): concurrent requests share one in-flight build
  let building: { mtime: number; p: Promise<NonNullable<typeof cache>> } | undefined;
  const current = async () => {
    const m = (await stat(file)).mtimeMs;
    if (cache && cache.mtime === m) return cache;
    if (!building || building.mtime !== m) {
      const p = loadAndCompile(file).then((compiled) => (cache = { mtime: m, compiled, glb: new Map() }));
      building = { mtime: m, p };
      p.catch(() => undefined).finally(() => {
        if (building?.p === p) building = undefined;
      });
    }
    return building.p;
  };
  const clients = new Set<ServerResponse>();

  let timer: NodeJS.Timeout | undefined;
  watch(dirname(file), (_e, name) => {
    if (name && resolve(dirname(file), name.toString()) !== file) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      for (const c of clients) c.write(`event: reload\ndata: ${Date.now()}\n\n`);
    }, 150);
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/" || url.pathname === "/index.html") return sendFile(res, VIEWER, "index.html");
      if (url.pathname.startsWith("/viewer/")) return sendFile(res, VIEWER, url.pathname.slice(8));
      if (url.pathname.startsWith("/three/")) return sendFile(res, THREE, url.pathname.slice(7));
      if (url.pathname.startsWith("/vendor/three-mesh-bvh/")) return sendFile(res, join(ROOT, "node_modules/three-mesh-bvh"), url.pathname.slice(23));
      if (url.pathname === "/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.write(": hi\n\n");
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      const cur = await current();
      const c = cur.compiled;
      if (url.pathname === "/info") {
        res.writeHead(200, { "content-type": MIME[".json"] });
        res.end(
          JSON.stringify({
            file,
            name: c.project?.name,
            ok: c.ok,
            errors: c.errors,
            warnings: c.warnings,
            stats: c.stats,
            levels: c.levels.map((l) => ({ id: l.id, name: l.name, elevation: l.elevation, height: l.height })),
            elevators: c.project?.elevators ?? [],
          }),
        );
        return;
      }
      if (url.pathname === "/model.glb") {
        if (!c.root) {
          res.writeHead(422).end(c.errors.join("\n"));
          return;
        }
        const format = url.searchParams.get("format") === "ktx2" ? "ktx2" : "jpeg";
        let glb = cur.glb.get(format);
        if (!glb) cur.glb.set(format, (glb = await exportGLB(c, { textureSize: opts.textureSize ?? 512, textureFormat: format })));
        res.writeHead(200, { "content-type": MIME[".glb"], "cache-control": "no-store" });
        res.end(glb);
        return;
      }
      if (url.pathname === "/plan.svg") {
        const sheet = url.searchParams.get("sheet") || "plan";
        if (!(PLAN_SHEETS as readonly string[]).includes(sheet)) return void res.writeHead(400).end(`sheet must be one of ${PLAN_SHEETS.join(", ")}`);
        const svg = renderPlanSVG(c, url.searchParams.get("level") || undefined, { sheet: sheet as PlanSheet });
        res.writeHead(200, { "content-type": MIME[".svg"], "cache-control": "no-store" });
        res.end(svg);
        return;
      }
      res.writeHead(404).end("not found");
    } catch (e) {
      // never write headers twice (a failure after the response started would crash the server)
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" }).end((e as Error).stack ?? String(e));
      else res.end();
    }
  });
  await new Promise<void>((ok) => server.listen(opts.port, ok));
  console.error(`Architecturer viewer: http://localhost:${opts.port}  (watching ${file})`);
}
