/**
 * The CPU-heavy half of the MCP tools: compile a plan, then validate / render / export it. Pure functions of
 * (plan JSON, folder), so they run in-process for the local stdio server and in worker threads for the
 * remote HTTP server (where a 30 s export must not block other requests).
 */
import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { exportGLB, exportGLTF, type ExportOptions } from "../export/gltf.js";
import { compileWithAssets, vendorNotice, type Compiled } from "../pipeline.js";
import { renderPlanSVG, svgToPng, type PlanSheet } from "../render/plan.js";
import type { CostScope } from "../cost/estimate.js";
import type { LightingMode } from "../render/raster.js";
import { renderViewPNG, type ViewOptions } from "../render/view.js";

type Json = Record<string, any>;

interface Base {
  project: Json;
  /** Relative model paths in the plan resolve against this folder (the plan file's). */
  baseDir: string;
}
export type JobRequest =
  | (Base & { op: "validate" })
  | (Base & { op: "render_plan"; level?: string; sheet?: PlanSheet })
  | (Base & { op: "render_view"; view: ViewOptions; modes: LightingMode[] })
  | (Base & { op: "export"; out: string; opts: ExportOptions })
  | (Base & { op: "cost"; output?: string; lines: boolean; scope?: CostScope })
  // for the live viewer
  | (Base & { op: "info" })
  | (Base & { op: "plan_svg"; level?: string; sheet?: PlanSheet })
  | (Base & { op: "glb"; opts: ExportOptions })
  | (Base & { op: "bill"; format: "html" | "csv"; scope?: CostScope });

export interface JobResult {
  /** False when the plan has errors and nothing could be rendered / exported. */
  ok: boolean;
  /** Validation summary (errors, warnings, stats, levels). */
  summary: string;
  images?: Uint8Array[];
  /** Extra text for the reply (cost estimate), or a document (SVG, HTML, CSV). */
  text?: string;
  /** Binary output (GLB). */
  bytes?: Uint8Array;
  /** Structured output (viewer info). */
  data?: unknown;
}

export function summary(c: Compiled): string {
  const lines: string[] = [];
  lines.push(c.ok ? "Plan is valid." : `Plan has ${c.errors.length} error(s).`);
  for (const e of c.errors) lines.push(`ERROR: ${e}`);
  for (const w of c.warnings) lines.push(`warning: ${w}`);
  for (const n of c.notes ?? []) lines.push(`note: ${n}`);
  if (c.root) lines.push(`${c.stats.triangles} triangles, ${c.stats.nodes} nodes, ${c.stats.materials} materials.`);
  if (c.credits.length) {
    const lic = new Map<string, number>();
    for (const s of c.credits) lic.set(s.license, (lic.get(s.license) ?? 0) + 1);
    lines.push(`External assets: ${c.credits.length} (${[...lic].map(([k, v]) => `${v}× ${k}`).join(", ")}).`);
    const notice = vendorNotice(c);
    if (notice) lines.push(notice);
  }
  if (c.project)
    lines.push(
      "Levels: " +
        c.levels.map((l) => `${l.id} (z=${l.elevation}, h=${l.height})`).join(", "),
    );
  return lines.join("\n");
}

/** Write via a temp file so a half-written export is never served. */
async function writeAtomic(path: string, data: Uint8Array | string) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

/**
 * The last few compiles, by plan content: a validate followed by a render (or the viewer's info, model and
 * plan requests after a save) compile once. Renderers and exporters never modify a Compiled.
 */
const compiles = new Map<string, Promise<Compiled>>();
function compileCached(project: Json, baseDir: string): Promise<Compiled> {
  const key = createHash("sha1").update(baseDir).update("\0").update(JSON.stringify(project)).digest("hex");
  let p = compiles.get(key);
  if (p) compiles.delete(key);
  else p = compileWithAssets(project, { baseDir });
  compiles.set(key, p);
  p.catch(() => compiles.delete(key));
  while (compiles.size > 3) compiles.delete(compiles.keys().next().value!);
  return p;
}

export async function runJob(req: JobRequest): Promise<JobResult> {
  const c = await compileCached(req.project, req.baseDir);
  const sum = summary(c);
  if (req.op === "validate") return { ok: c.ok, summary: sum };
  if (req.op === "info")
    return {
      ok: c.ok,
      summary: sum,
      data: {
        name: c.project?.name,
        ok: c.ok,
        errors: c.errors,
        warnings: c.warnings,
        stats: c.stats,
        levels: c.levels.map((l) => ({ id: l.id, name: l.name, elevation: l.elevation, height: l.height })),
        elevators: c.project?.elevators ?? [],
      },
    };
  if (!c.root) return { ok: false, summary: sum };
  switch (req.op) {
    case "render_plan":
      return { ok: true, summary: sum, images: [await svgToPng(renderPlanSVG(c, req.level, { sheet: req.sheet }))] };
    case "render_view":
      return { ok: true, summary: sum, images: req.modes.map((m) => renderViewPNG(c, { ...req.view, lighting: m })) };
    case "export":
      if (extname(req.out) === ".gltf") {
        await mkdir(dirname(req.out), { recursive: true });
        await exportGLTF(c, req.out, req.opts);
      } else await writeAtomic(req.out, await exportGLB(c, req.opts));
      return { ok: true, summary: sum };
    case "plan_svg":
      return { ok: true, summary: sum, text: renderPlanSVG(c, req.level, { sheet: req.sheet }) };
    case "glb":
      return { ok: true, summary: sum, bytes: await exportGLB(c, req.opts) };
    case "bill": {
      const { estimate } = await import("../cost/estimate.js");
      const fmt = await import("../cost/format.js");
      const bill = estimate(c, { scope: req.scope });
      return { ok: true, summary: sum, text: req.format === "csv" ? fmt.billCsv(bill) : fmt.billHtml(bill) };
    }
    case "cost": {
      const { estimate } = await import("../cost/estimate.js");
      const fmt = await import("../cost/format.js");
      const bill = estimate(c, { scope: req.scope });
      if (req.output) {
        const ext = extname(req.output).toLowerCase();
        await writeAtomic(req.output, ext === ".html" ? fmt.billHtml(bill) : ext === ".csv" ? fmt.billCsv(bill) : ext === ".json" ? JSON.stringify(bill, null, 1) : fmt.billMarkdown(bill));
      }
      const keys = Object.entries(bill.ratesUsed).map(([k, v]) => `${k}=${v}`).join(", ");
      const missing = bill.unpriced.length
        ? `\n\nPRODUCTS WITHOUT A PRICE (billed as allowances, ${bill.currency}): ` +
          bill.unpriced.map((u) => `\n- ${u.id}: ${u.name} — allowance ${u.allowance}${u.url ? ` — ${u.url}` : ""}`).join("") +
          `\nFind each one's current price (its product page, or a web search for the vendor's price in the local market), then set it with import_product {path, id, price, currency} and run cost_estimate again. If a price can't be found, say the line is an allowance.`
        : "";
      return { ok: true, summary: sum, text: fmt.billMarkdown(bill, { lines: req.lines }) + missing + `\n\nRate keys used (override in project.costs.rates): ${keys}` };
    }
  }
}
