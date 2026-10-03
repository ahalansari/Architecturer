import { createReadStream, existsSync, watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readJson } from "../io.js";
import { inlineEngine, type Engine } from "../mcp/engine.js";
import type { JobRequest, JobResult } from "../mcp/jobs.js";
import { PLAN_SHEETS, type PlanSheet } from "../render/plan.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const VIEWER = join(ROOT, "viewer");
const THREE = join(ROOT, "node_modules/three");
const BVH = join(ROOT, "node_modules/three-mesh-bvh");
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
  let p: string;
  try {
    p = normalize(join(base, decodeURIComponent(rel)));
  } catch {
    return void res.writeHead(400).end("bad path");
  }
  if (!(p === base || p.startsWith(base + sep)) || !existsSync(p)) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": MIME[extname(p)] ?? "application/octet-stream" });
  createReadStream(p).pipe(res);
}

export interface PlanViewer {
  /** Serve one viewer request; `path` is relative to the viewer's root ("" or "index.html" = the page). */
  handle(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams): Promise<void>;
  close(): void;
  /** Open live-reload connections (the remote server closes viewers nobody watches). */
  readonly clients: number;
}

/**
 * The live 3D viewer for one plan file: the page, three.js, and the model / plan / estimate built from the
 * file. Builds run on `engine` (worker threads on the remote server) and are cached until the file changes;
 * browsers reload over server-sent events whenever the file is saved.
 */
export function createPlanViewer(planPath: string, opts: { textureSize?: number; engine?: Engine; showPath?: string } = {}): PlanViewer {
  const file = resolve(planPath);
  const engine = opts.engine ?? inlineEngine;
  // one cache per file version; concurrent requests share the in-flight build
  let cache: { mtime: number; project: Promise<unknown>; results: Map<string, Promise<JobResult>> } | undefined;
  const run = async (key: string, req: Omit<JobRequest, "project" | "baseDir"> & Record<string, unknown>): Promise<JobResult> => {
    const m = (await stat(file)).mtimeMs;
    if (!cache || cache.mtime !== m) cache = { mtime: m, project: readJson(file), results: new Map() };
    const c = cache;
    let r = c.results.get(key);
    if (!r) {
      r = c.project.then((project) => engine.run({ ...req, project, baseDir: dirname(file) } as JobRequest));
      c.results.set(key, r);
      r.catch(() => c.results.delete(key));
    }
    return r;
  };

  const clients = new Set<ServerResponse>();
  let timer: NodeJS.Timeout | undefined;
  const watcher: FSWatcher = watch(dirname(file), (_e, name) => {
    if (name && resolve(dirname(file), name.toString()) !== file) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      for (const c of clients) c.write(`event: reload\ndata: ${Date.now()}\n\n`);
    }, 150);
  });
  // proxies (Cloudflare) drop event streams that stay silent for ~100 s
  const ping = setInterval(() => {
    for (const c of clients) c.write(": ping\n\n");
  }, 30_000);
  ping.unref();

  return {
    get clients() {
      return clients.size;
    },
    close() {
      watcher.close();
      clearInterval(ping);
      clearTimeout(timer);
      for (const c of clients) c.end();
    },
    async handle(req, res, path, query) {
      if (path === "" || path === "index.html") return sendFile(res, VIEWER, "index.html");
      if (path.startsWith("viewer/")) return sendFile(res, VIEWER, path.slice(7));
      if (path.startsWith("three/")) return sendFile(res, THREE, path.slice(6));
      if (path.startsWith("vendor/three-mesh-bvh/")) return sendFile(res, BVH, path.slice(22));
      if (path === "events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.write(": hi\n\n");
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      if (path === "info") {
        const r = await run("info", { op: "info" });
        res.writeHead(200, { "content-type": MIME[".json"], "cache-control": "no-store" });
        res.end(JSON.stringify({ file: opts.showPath ?? file, ...(r.data as object) }));
        return;
      }
      if (path === "model.glb") {
        const format = query.get("format") === "ktx2" ? "ktx2" : "jpeg";
        const r = await run(`glb:${format}`, { op: "glb", opts: { textureSize: opts.textureSize ?? 512, textureFormat: format } });
        if (!r.ok) return void res.writeHead(422, { "content-type": "text/plain; charset=utf-8" }).end(r.summary);
        res.writeHead(200, { "content-type": MIME[".glb"], "cache-control": "no-store" });
        res.end(r.bytes);
        return;
      }
      if (path === "estimate.html" || path === "estimate.csv") {
        const csv = path.endsWith(".csv");
        const r = await run(`bill:${csv ? "csv" : "html"}`, { op: "bill", format: csv ? "csv" : "html" });
        if (!r.ok) return void res.writeHead(422, { "content-type": "text/plain; charset=utf-8" }).end(r.summary);
        res.writeHead(200, {
          "content-type": csv ? "text/csv; charset=utf-8" : "text/html; charset=utf-8",
          "cache-control": "no-store",
          ...(csv ? { "content-disposition": 'attachment; filename="cost_estimate.csv"' } : {}),
        });
        res.end(r.text);
        return;
      }
      if (path === "plan.svg") {
        const sheet = query.get("sheet") || "plan";
        if (!(PLAN_SHEETS as readonly string[]).includes(sheet)) return void res.writeHead(400).end(`sheet must be one of ${PLAN_SHEETS.join(", ")}`);
        const level = query.get("level") || undefined;
        const r = await run(`svg:${sheet}:${level ?? ""}`, { op: "plan_svg", level, sheet: sheet as PlanSheet });
        if (!r.ok) return void res.writeHead(422, { "content-type": "text/plain; charset=utf-8" }).end(r.summary);
        res.writeHead(200, { "content-type": MIME[".svg"], "cache-control": "no-store" });
        res.end(r.text);
        return;
      }
      res.writeHead(404).end("not found");
    },
  };
}

/** Serve the 3D viewer for a plan file; browsers reload automatically when the file changes. */
export async function serve(planPath: string, opts: { port: number; textureSize?: number }) {
  const viewer = createPlanViewer(planPath, opts);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      await viewer.handle(req, res, url.pathname.slice(1), url.searchParams);
    } catch (e) {
      // never write headers twice (a failure after the response started would crash the server)
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" }).end((e as Error).message);
      else res.end();
    }
  });
  await new Promise<void>((ok) => server.listen(opts.port, ok));
  console.error(`Architecturer viewer: http://localhost:${opts.port}  (watching ${resolve(planPath)})`);
}
