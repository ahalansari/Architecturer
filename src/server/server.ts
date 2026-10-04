import { createReadStream, existsSync, statSync, watch, type FSWatcher } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, dirname, extname, join, normalize, resolve, sep } from "node:path";
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

/**
 * Viewer files: revalidated on every load (a 304 when unchanged) and never kept by shared caches, so an update
 * reaches the browser at once even behind Cloudflare, which otherwise caches .js / .css for hours.
 */
function sendFile(req: IncomingMessage, res: ServerResponse, base: string, rel: string) {
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
  const st = statSync(p);
  const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
  const headers = { "content-type": MIME[extname(p)] ?? "application/octet-stream", "cache-control": "private, no-cache", etag };
  if (req.headers["if-none-match"] === etag) return void res.writeHead(304, headers).end();
  res.writeHead(200, headers);
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
export function createPlanViewer(planPath: string, opts: { textureSize?: number; engine?: Engine; showPath?: string; contractsDir?: string } = {}): PlanViewer {
  const file = resolve(planPath);
  const engine = opts.engine ?? inlineEngine;
  // contracts go where generate_contract puts them: contracts/<plan>-<package>-<mode>.docx|html
  const contractsDir = opts.contractsDir ?? join(dirname(file), "contracts");
  const planBase = basename(file, extname(file));
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
      if (path === "" || path === "index.html") return sendFile(req, res, VIEWER, "index.html");
      if (path.startsWith("viewer/")) return sendFile(req, res, VIEWER, path.slice(7));
      if (path.startsWith("three/")) return sendFile(req, res, THREE, path.slice(6));
      if (path.startsWith("vendor/three-mesh-bvh/")) return sendFile(req, res, BVH, path.slice(22));
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
        const scope = query.get("scope") === "full" ? "full" : query.get("scope") === "fitout" ? "fitout" : undefined;
        const r = await run(`bill:${csv ? "csv" : "html"}:${scope ?? ""}`, { op: "bill", format: csv ? "csv" : "html", scope });
        if (!r.ok) return void res.writeHead(422, { "content-type": "text/plain; charset=utf-8" }).end(r.summary);
        res.writeHead(200, {
          "content-type": csv ? "text/csv; charset=utf-8" : "text/html; charset=utf-8",
          "cache-control": "no-store",
          ...(csv ? { "content-disposition": 'attachment; filename="cost_estimate.csv"' } : {}),
        });
        res.end(r.text);
        return;
      }
      if (path === "contracts" && req.method === "POST") {
        // JSON only: a cross-site form cannot send it, so this is not a CSRF target
        if (!/^application\/json/.test(req.headers["content-type"] ?? "")) return void res.writeHead(415, { "content-type": "text/plain" }).end("send JSON");
        let body: { package?: string; mode?: string; contractor?: string };
        try {
          body = JSON.parse(await readBody(req, 16 * 1024));
        } catch {
          return void res.writeHead(400, { "content-type": "text/plain" }).end("bad JSON");
        }
        const { packageById } = await import("../contracts/packages.js");
        let pkg;
        try {
          pkg = packageById(String(body.package ?? ""));
        } catch (e) {
          return void res.writeHead(400, { "content-type": "text/plain" }).end((e as Error).message);
        }
        const mode = body.mode === "labour" || body.mode === "supply" ? body.mode : pkg.modes[0];
        if (!pkg.modes.includes(mode)) return void res.writeHead(400, { "content-type": "text/plain" }).end(`${pkg.id} is ${pkg.modes.join(" or ")} only`);
        const name = `${planBase}-${pkg.id}-${mode}`;
        const contractor = String(body.contractor ?? "").trim().slice(0, 120);
        const r = await engine.run({
          op: "contract",
          project: await readJson(file),
          baseDir: dirname(file),
          options: { package: pkg.id, mode, ...(contractor ? { contractor: { company: contractor } } : {}) },
          out: { docx: join(contractsDir, `${name}.docx`), html: join(contractsDir, `${name}.html`) },
        } as JobRequest);
        res.writeHead(r.ok ? 200 : 422, { "content-type": MIME[".json"], "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: r.ok, text: r.ok ? r.text : r.summary, name }));
        return;
      }
      if (path === "contracts") {
        const { PACKAGES } = await import("../contracts/packages.js");
        const files: { name: string; package: string; mode: string; ext: string; modified: string }[] = [];
        const re = new RegExp(`^${planBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-([a-z_]+)-(labour|supply)\\.(docx|html)$`);
        for (const f of existsSync(contractsDir) ? await readdir(contractsDir) : []) {
          const m = re.exec(f);
          if (m) files.push({ name: f, package: m[1], mode: m[2], ext: m[3], modified: (await stat(join(contractsDir, f))).mtime.toISOString() });
        }
        res.writeHead(200, { "content-type": MIME[".json"], "cache-control": "no-store" });
        res.end(JSON.stringify({ packages: PACKAGES.map((p) => ({ id: p.id, en: p.title.en, ar: p.title.ar, modes: p.modes })), files }));
        return;
      }
      if (path.startsWith("contracts/")) {
        const name = path.slice(10);
        if (!/^[A-Za-z0-9._ -]+\.(docx|html)$/.test(name) || !name.startsWith(`${planBase}-`) || !existsSync(join(contractsDir, name))) return void res.writeHead(404).end("not found");
        const html = name.endsWith(".html");
        res.writeHead(200, {
          "content-type": html ? MIME[".html"] : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "cache-control": "no-store",
          "content-disposition": `${html ? "inline" : "attachment"}; filename="${name.replace(/"/g, "")}"`,
          ...(html ? { "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:" } : {}),
        });
        createReadStream(join(contractsDir, name)).pipe(res);
        return;
      }
      if (path === "airflow.png" || path === "airflow.bin") {
        const level = /^[\w-]{1,64}$/.test(query.get("level") ?? "") ? query.get("level")! : undefined;
        const r = path === "airflow.png" ? await run(`airflow:${level ?? ""}`, { op: "airflow", level }) : await run(`airflowf:${level ?? ""}`, { op: "airflow_field", level });
        if (!r.ok || (path === "airflow.png" ? !r.images?.length : !r.bytes)) return void res.writeHead(422, { "content-type": "text/plain; charset=utf-8" }).end(r.summary);
        res.writeHead(200, { "content-type": path === "airflow.png" ? "image/png" : "application/octet-stream", "cache-control": "no-store" });
        res.end(path === "airflow.png" ? r.images![0] : r.bytes);
        return;
      }
      if (path === "water.json") {
        const r = await run("water_net", { op: "water_net" });
        if (!r.ok) return void res.writeHead(422, { "content-type": "text/plain; charset=utf-8" }).end(r.summary);
        res.writeHead(200, { "content-type": MIME[".json"], "cache-control": "no-store" });
        res.end(JSON.stringify(r.data));
        return;
      }
      if (path === "photo.png") {
        // path-traced still of the viewer's current camera (plan coordinates, z up)
        const vec = (k: string) => {
          const v = (query.get(k) ?? "").split(",").map(Number);
          return v.length === 3 && v.every((x) => Number.isFinite(x) && Math.abs(x) < 1e5) ? (v as [number, number, number]) : undefined;
        };
        const eye = vec("eye"), target = vec("target");
        if (!eye || !target) return void res.writeHead(400, { "content-type": "text/plain" }).end("eye and target: x,y,z");
        const int = (k: string, lo: number, hi: number, d: number) => {
          const n = Math.round(Number(query.get(k) ?? d));
          return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
        };
        const lighting = ["day", "golden", "night", "dusk"].includes(query.get("lighting") ?? "") ? (query.get("lighting") as "day" | "golden" | "night" | "dusk") : "day";
        const time = /^\d{1,2}:\d{2}$/.test(query.get("time") ?? "") ? query.get("time")! : undefined;
        const date = /^\d{1,2}-\d{1,2}$/.test(query.get("date") ?? "") ? query.get("date")! : undefined;
        const level = /^[\w-]{1,64}$/.test(query.get("level") ?? "") ? query.get("level")! : undefined;
        const view = { eye, target, fov: int("fov", 10, 120, 45), width: int("w", 200, 2400, 1280), height: int("h", 200, 2400, 800), samples: int("spp", 16, 1024, 192), level, time, date };
        const r = await run(`photo:${JSON.stringify(view)}:${lighting}`, { op: "render_view", view, modes: [lighting] });
        if (!r.ok || !r.images?.length) return void res.writeHead(422, { "content-type": "text/plain; charset=utf-8" }).end(r.summary);
        res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store", "x-renderer": encodeURIComponent(r.summary.split("\n").pop() ?? "") });
        res.end(r.images[0]);
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

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((ok, fail) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        fail(new Error("too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
    req.on("error", fail);
  });
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
