/**
 * The Architecturer MCP tools, independent of the transport: the stdio entry (server.ts) and the remote
 * HTTP server (http.ts) each build a server with createMcpServer().
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, sep } from "node:path";
import { z } from "zod";
import { listFurniture } from "../elements/furniture.js";
import { guideHeadings, guideSection } from "../guide.js";
import { readJson } from "../io.js";
import { listMaterials } from "../materials/library.js";
import { PLAN_SHEETS } from "../render/plan.js";
import { VIEW_PRESETS, type ViewPreset } from "../render/raster.js";
import { PACKAGE_IDS } from "../contracts/packages.js";
import { ELEMENT_KINDS, projectJsonSchema } from "../schema/schema.js";
import { STARTER_PROJECT } from "../templates.js";
import type { Engine } from "./engine.js";
import type { JobRequest, JobResult } from "./jobs.js";
import { KeyedLock, Workspace } from "./workspace.js";

type Json = Record<string, any>;
type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type Reply = { content: Content[]; isError?: boolean };
type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** A background export (remote mode: exports can take minutes, longer than clients wait for a reply). */
export interface ExportJob {
  id: string;
  plan: string;
  out: string;
  started: Date;
  finished?: Date;
  result?: JobResult;
  error?: string;
  promise: Promise<void>;
}

/** What the remote server adds: links instead of server paths, background exports. */
export interface RemoteHooks {
  /** Keep a rendered image for a while and return a link to it. */
  renderLink(png: Uint8Array): Promise<string>;
  /** Signed download link for a file inside the project folder. */
  fileLink(abs: string): string;
  /** Live 3D viewer page for a plan. */
  viewLink(planAbs: string): string;
  startExport(plan: string, out: string, run: () => Promise<JobResult>): ExportJob;
  exportJobs(): ExportJob[];
}

export interface ToolContext {
  ws: Workspace;
  engine: Engine;
  lock: KeyedLock;
  remote?: RemoteHooks;
}

/** 'core' = a small tool set for local models that get lost among 20+ tools. */
export type ToolProfile = "full" | "core";
const CORE = new Set(["list_projects", "get_guide", "read_project", "create_project", "add_elements", "update_element", "remove_elements", "validate", "render_plan", "render_view"]);

const INSTRUCTIONS =
  "Architecturer builds 3D architecture (walls, doors, windows, rooms, stairs, roofs, furniture) from a JSON plan file and exports textured game-ready GLB models. " +
  "Start with get_guide. Plans live in JSON files on disk; every tool takes the file path. After edits, check render_plan / render_view images.";
const REMOTE_INSTRUCTIONS =
  "Architecturer builds 3D architecture (walls, doors, windows, rooms, stairs, roofs, furniture) from JSON plans and exports textured game-ready GLB models. " +
  "Start with get_guide (pass a section for a shorter read) and list_projects. Plans are named projects on the server ('house', 'clients/villa'); every tool takes that name. " +
  "After edits, check render_plan / render_view images. Exports and files come back as download links.";

const text = (t: string): Content => ({ type: "text", text: t });
const ok = (...content: Content[]): Reply => ({ content });
const fail = (msg: string): Reply => ({ content: [text(`Error: ${msg}`)], isError: true });

/** Biggest image sent inline (base64 grows it by a third); larger renders are links only. */
const INLINE_IMAGE_MAX = 3 * 1024 * 1024;

const READ: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const ADD: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const CHANGE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const OUTPUT: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WEB: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

const PREFIX: Record<string, string> = {
  walls: "wall", openings: "", rooms: "room", slabs: "slab", stairs: "stair", furniture: "", columns: "column", railings: "railing", terraces: "terrace", roofs: "roof",
};

/** Give new elements ids so they can be edited later. */
function assignIds(project: Json, kind: string, items: Json[]) {
  const used = new Set<string>();
  for (const lv of project.levels ?? []) for (const k of ELEMENT_KINDS) for (const el of lv[k] ?? []) if (el.id) used.add(el.id);
  for (const it of items) {
    if (it.id) continue;
    const base = PREFIX[kind] || it.type || kind;
    let n = 1;
    while (used.has(`${base}_${n}`)) n++;
    it.id = `${base}_${n}`;
    used.add(it.id);
  }
}

function findLevel(project: Json, level: string): Json {
  const lv = (project.levels ?? []).find((l: Json) => l.id === level);
  if (!lv) throw new Error(`level '${level}' not found (levels: ${(project.levels ?? []).map((l: Json) => l.id).join(", ") || "none"})`);
  return lv;
}

/**
 * While a long job runs, send progress notifications when the client asked for them (a progressToken):
 * clients show them, and they keep proxies (Cloudflare closes silent responses after ~100 s) from timing out.
 */
async function keepAlive<T>(extra: Extra | undefined, what: string, p: Promise<T>): Promise<T> {
  const token = extra?._meta?.progressToken;
  if (token === undefined) return p;
  let n = 0;
  const t0 = Date.now();
  const timer = setInterval(() => {
    extra!
      .sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: ++n, message: `${what}… ${Math.round((Date.now() - t0) / 1000)} s` } })
      .catch(() => undefined);
  }, 10_000);
  try {
    return await p;
  } finally {
    clearInterval(timer);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref());

export function createMcpServer(ctx: ToolContext, profile: ToolProfile = "full"): McpServer {
  const { ws, engine, lock, remote } = ctx;
  const server = new McpServer({ name: "architecturer", version: "0.1.0" }, { instructions: remote ? REMOTE_INSTRUCTIONS : INSTRUCTIONS });

  /** registerTool, minus the tools outside the profile. */
  const tool: typeof server.registerTool = ((name: string, config: any, cb: any) => {
    if (profile === "core" && !CORE.has(name)) return undefined;
    return server.registerTool(name, config, cb);
  }) as never;

  const guard =
    <A>(fn: (a: A, extra?: Extra) => Promise<Reply>) =>
    async (a: A, extra?: Extra): Promise<Reply> => {
      try {
        return await fn(a, extra);
      } catch (e) {
        // remotely, server paths in error messages become project-relative ones
        const msg = (e as Error).message;
        return fail(remote ? msg.split(ws.root + sep).join("").split(ws.root).join(".") : msg);
      }
    };

  const load = async (file: string): Promise<Json> => {
    const j = await readJson(file);
    if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error(`${ws.show(file)} does not contain a JSON object`);
    return j as Json;
  };
  const store = async (file: string, project: Json) => {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(project, null, 2) + "\n");
  };
  const job = (file: string, project: Json, req: Omit<JobRequest, "project" | "baseDir"> & Record<string, unknown>, extra?: Extra, what = "Building") =>
    keepAlive(extra, what, engine.run({ ...req, project, baseDir: dirname(file) } as JobRequest));
  const validate = async (file: string, project: Json, extra?: Extra) => (await job(file, project, { op: "validate" }, extra, "Validating")).summary;
  /** Load, change and save a plan under the per-file lock; returns the saved project. */
  const edit = (file: string, fn: (p: Json) => string | Promise<string>) =>
    lock.run(file, async () => {
      const p = await load(file);
      const msg = await fn(p);
      await store(file, p);
      return { p, msg };
    });
  const viewLine = (file: string) => (remote ? `\nLive 3D view: ${remote.viewLink(file)}` : "");
  const images = async (r: JobResult): Promise<Content[]> => {
    const out: Content[] = [];
    for (const img of r.images ?? []) {
      if (!remote || img.byteLength <= INLINE_IMAGE_MAX) out.push({ type: "image", data: Buffer.from(img).toString("base64"), mimeType: "image/png" });
      if (remote) out.push(text(`Image link: ${await remote.renderLink(img)}`));
    }
    return out;
  };

  const PathArg = remote
    ? z.string().describe("Project name, e.g. 'house' or 'clients/villa' (see list_projects); '.json' is optional")
    : z.string().describe(`Path to the plan JSON file: absolute, or relative to the project folder ${ws.root}`);
  const LevelArg = z.string().describe("Level id, e.g. 'ground'");

  tool(
    "get_guide",
    {
      title: "Read the guide",
      description:
        "READ FIRST. Conventions, coordinate system, good practice, workflow, plus the full material and furniture libraries (long). " +
        "Pass `section` for one part: 'format' (everything but the libraries), 'materials', 'furniture', or a heading such as 'walls', 'stairs', 'workflow'.",
      inputSchema: { section: z.string().optional().describe(`format | materials | furniture | ${guideHeadings().map((h) => h.toLowerCase().split(/[ (:]/)[0]).join(" | ")}`) },
      annotations: READ,
    },
    guard(async ({ section }) => ok(text(guideSection(section)))),
  );

  tool(
    "list_projects",
    {
      title: "List projects",
      description: "Plan files in the project folder (newest first), with their names to pass to the other tools.",
      inputSchema: {},
      annotations: READ,
    },
    guard(async () => {
      const list = await ws.list();
      if (!list.length) return ok(text("No projects yet. Create one with create_project (omit `project` for a starter cabin)."));
      return ok(
        text(
          list
            .map((p) => `${p.name}${p.title ? ` — ${p.title}` : ""} (${p.levels} level${p.levels === 1 ? "" : "s"}, modified ${p.modified.toISOString().slice(0, 16).replace("T", " ")})${remote ? `\n  view: ${remote.viewLink(p.path)}` : ""}`)
            .join("\n"),
        ),
      );
    }),
  );

  tool(
    "get_schema",
    { title: "Plan JSON Schema", description: "JSON Schema of the plan file (every field with descriptions and defaults).", inputSchema: {}, annotations: READ },
    async () => ok(text(JSON.stringify(projectJsonSchema()))),
  );

  tool(
    "list_materials",
    { title: "List materials", description: "Built-in materials (procedural PBR textures).", inputSchema: {}, annotations: READ },
    async () =>
      ok(
        text(
          listMaterials().map((m) => `${m.name} (${m.pattern}): ${m.description}`).join("\n") +
            "\n\nAlso: any RAL Classic colour as paint ('ral_9010', 'ral 7016') or as a colour; any '#rrggbb'; " +
            "thousands of scanned CC0 PBR materials via search_assets → 'ambientcg:<Id>' / 'polyhaven:<id>' (usable anywhere a material is, and as a custom material base).",
        ),
      ),
  );

  tool(
    "list_styles",
    { title: "List interior styles", description: "Interior style presets (scandinavian, japandi, industrial, ...) with the material each assigns to every role. Use as project.style or room.style.", inputSchema: {}, annotations: READ },
    async () => {
      const { listStyles } = await import("../elements/styles.js");
      return ok(text(JSON.stringify(listStyles(), null, 1)));
    },
  );

  tool(
    "list_furniture",
    { title: "List furniture", description: "Furniture/fixture types with default sizes, material slots and options.", inputSchema: {}, annotations: READ },
    async () => ok(text(JSON.stringify(listFurniture(), null, 1))),
  );

  tool(
    "create_project",
    {
      title: "Create a project",
      description: "Create a new plan file. Pass a full `project` object, or omit it to get a small starter cabin to modify.",
      inputSchema: { path: PathArg, project: z.record(z.string(), z.any()).optional(), overwrite: z.boolean().default(false) },
      annotations: ADD,
    },
    guard(async ({ path, project, overwrite }, extra) => {
      const file = ws.plan(path);
      const p = (project as Json) ?? structuredClone(STARTER_PROJECT);
      const created = await lock.run(file, async () => {
        if (existsSync(file) && !overwrite) return false;
        await store(file, p);
        return true;
      });
      if (!created) return fail(`${path} already exists (pass overwrite: true to replace it)`);
      return ok(text(`Created ${ws.show(file)}\n${await validate(file, p, extra)}${viewLine(file)}`));
    }),
  );

  tool(
    "read_project",
    { title: "Read a project", description: "Return the plan JSON as stored on disk.", inputSchema: { path: PathArg }, annotations: READ },
    guard(async ({ path }) => ok(text(JSON.stringify(await load(ws.plan(path)), null, 1)))),
  );

  tool(
    "write_project",
    {
      title: "Replace a project",
      description: "Replace the whole plan file with `project` (best for large changes). Returns validation results. The file is written even when invalid so you can fix it incrementally.",
      inputSchema: { path: PathArg, project: z.record(z.string(), z.any()) },
      annotations: CHANGE,
    },
    guard(async ({ path, project }, extra) => {
      const file = ws.plan(path);
      await lock.run(file, () => store(file, project as Json));
      return ok(text(await validate(file, project as Json, extra)));
    }),
  );

  tool(
    "add_level",
    {
      title: "Add a level",
      description: "Append a level (storey). Example: {id:'upper', height:3, walls:[...]}.",
      inputSchema: { path: PathArg, level: z.record(z.string(), z.any()) },
      annotations: ADD,
    },
    guard(async ({ path, level }, extra) => {
      const file = ws.plan(path);
      const { p } = await edit(file, (p) => {
        p.levels = [...(p.levels ?? []), level];
        return "";
      });
      return ok(text(await validate(file, p, extra)));
    }),
  );

  tool(
    "add_elements",
    {
      title: "Add elements",
      description:
        "Append elements to a level. `elements` maps a collection to a list, e.g. {walls:[{id:'w1',points:[[0,0],[5,0]]}], openings:[{type:'door',at:[2,0]}], furniture:[{type:'sofa',position:[2,2],facing:'north'}]}. Elements without an id get one (returned).",
      inputSchema: {
        path: PathArg,
        level: LevelArg,
        elements: z
          .object(Object.fromEntries(ELEMENT_KINDS.map((k) => [k, z.array(z.record(z.string(), z.any())).optional()])))
          .describe("Collections: " + ELEMENT_KINDS.join(", ")),
      },
      annotations: ADD,
    },
    guard(async ({ path, level, elements }, extra) => {
      const file = ws.plan(path);
      const { p, msg } = await edit(file, (p) => {
        const lv = findLevel(p, level);
        const added: string[] = [];
        for (const [kind, items] of Object.entries(elements)) {
          if (!items) continue;
          assignIds(p, kind, items as Json[]);
          lv[kind] = [...(lv[kind] ?? []), ...items];
          added.push(`${kind}: ${(items as Json[]).map((i) => i.id).join(", ")}`);
        }
        return `Added ${added.join("; ")}`;
      });
      return ok(text(`${msg}\n${await validate(file, p, extra)}`));
    }),
  );

  tool(
    "update_element",
    {
      title: "Update an element",
      description: "Shallow-merge `changes` into one element found by id (set a field to null to delete it). Example: {id:'front_door', changes:{width:1.0, style:'double'}}.",
      inputSchema: { path: PathArg, id: z.string(), changes: z.record(z.string(), z.any()) },
      annotations: CHANGE,
    },
    guard(async ({ path, id, changes }, extra) => {
      const file = ws.plan(path);
      const { p, msg } = await edit(file, (p) => {
        for (const lv of p.levels ?? [])
          for (const k of ELEMENT_KINDS)
            for (const el of lv[k] ?? [])
              if (el.id === id) {
                for (const [key, v] of Object.entries(changes)) {
                  if (v === null) delete el[key];
                  else el[key] = v;
                }
                return `Updated ${k} '${id}' on level '${lv.id}'`;
              }
        throw new Error(`no element with id '${id}'`);
      });
      return ok(text(`${msg}\n${await validate(file, p, extra)}`));
    }),
  );

  tool(
    "remove_elements",
    { title: "Remove elements", description: "Remove elements (any collection, any level) by id.", inputSchema: { path: PathArg, ids: z.array(z.string()) }, annotations: CHANGE },
    guard(async ({ path, ids }, extra) => {
      const file = ws.plan(path);
      const { p, msg } = await edit(file, (p) => {
        const want = new Set(ids);
        const removed: string[] = [];
        for (const lv of p.levels ?? [])
          for (const k of ELEMENT_KINDS)
            if (lv[k])
              lv[k] = lv[k].filter((el: Json) => {
                if (el.id && want.has(el.id)) {
                  removed.push(el.id);
                  return false;
                }
                return true;
              });
        const missing = ids.filter((i) => !removed.includes(i));
        return `Removed: ${removed.join(", ") || "nothing"}${missing.length ? `. Not found: ${missing.join(", ")}` : ""}`;
      });
      return ok(text(`${msg}\n${await validate(file, p, extra)}`));
    }),
  );

  tool(
    "validate",
    { title: "Validate a project", description: "Validate and build the plan; returns errors, warnings and stats.", inputSchema: { path: PathArg }, annotations: READ },
    guard(async ({ path }, extra) => {
      const file = ws.plan(path);
      return ok(text(await validate(file, await load(file), extra)));
    }),
  );

  tool(
    "render_plan",
    {
      title: "Render a 2D plan",
      description:
        "2D floor plan image of one level: meter grid with coordinates, walls (with ids), doors with swings, windows, rooms with areas, stairs, furniture footprints (front edge drawn thick). " +
        "sheet 'lighting': fixture symbols with ids, rooms tinted by estimated lux, fixture legend with lumens. sheet 'finishes': floors in their material pattern, wall finish / accent bands, per-room finish schedule. " +
        "sheet 'rcp': reflected ceiling plan (ceiling heights + materials, soffits, coffers, beams, LED coves, cornices, ceiling openings, fixtures). " +
        "sheet 'false_ceiling': false ceiling setting-out (every ceiling level colour-coded and tagged above FFL, drop edges, coves, soffit widths, void depth, typical tray section). " +
        "sheet 'electrical': switches (switch legs to the lights), sockets, data / TV, appliance spurs, cooker unit, fans, detectors, DB and the circuit schedule. " +
        "sheet 'plumbing': sanitary fixtures with cold / hot supplies and waste / soil drains to stacks, floor drains, water heaters, main stop valve and the fixture schedule. " +
        "Both layouts are generated from the design (level.services.auto); add points with level.electrical / level.plumbing, drop auto points with services.omit (ids like sk.master.3 = sk3 on the sheet).",
      inputSchema: {
        path: PathArg,
        level: LevelArg.optional().describe("Default: first level"),
        sheet: z.enum(PLAN_SHEETS).optional().describe("plan (default) | lighting | finishes | rcp | false_ceiling | electrical | plumbing"),
      },
      annotations: READ,
    },
    guard(async ({ path, level, sheet }, extra) => {
      const file = ws.plan(path);
      const r = await job(file, await load(file), { op: "render_plan", level, sheet }, extra, "Rendering");
      if (!r.ok) return fail(r.summary);
      return ok(...(await images(r)), text(r.summary));
    }),
  );

  tool(
    "render_view",
    {
      title: "Render a 3D view",
      description:
        "Render the 3D model to an image. view: " +
        VIEW_PRESETS.join(", ") +
        " (iso = from south-east above). Pass `level` to cut away everything above that level's walls and see the interior. Or pass a custom camera `eye`/`target` ([x,y,z] in plan coordinates, z up).",
      inputSchema: {
        path: PathArg,
        view: z.enum(VIEW_PRESETS as unknown as [ViewPreset, ...ViewPreset[]]).default("iso"),
        level: z.string().optional(),
        focus: z.array(z.number()).min(2).max(3).optional().describe("Plan point [x, y] (or [x, y, z]) to frame instead of the whole building — use for close-ups of stairs, rooms, details"),
        radius: z.number().positive().optional().describe("Meters around `focus` to show (default 3)"),
        zoom: z.number().positive().optional().describe(">1 moves the camera closer, <1 further away"),
        cutHeight: z.number().positive().optional().describe("With `level`: cutaway height above the floor (default min(0.75*height, 2.2))"),
        room: z.string().optional().describe("Interior review: eye-level wide shot of this room (id or name) from a corner"),
        corner: z.number().int().min(0).optional().describe("With room: which corner to shoot from (0 = farthest from the centre)"),
        elevation: z.string().optional().describe("Interior review: square-on orthographic view of this wall id (kitchen runs, wardrobes, tiling, art)"),
        elevationRoom: z.string().optional().describe("With elevation: which room's side of the wall"),
        lighting: z
          .enum(["day", "night", "dusk", "both"])
          .default("day")
          .describe("night / dusk: lit only by the plan's light fixtures and lamps (walls block light) — use to judge a lighting design; both = day + night images"),
        eye: z.tuple([z.number(), z.number(), z.number()]).optional(),
        target: z.tuple([z.number(), z.number(), z.number()]).optional(),
        width: z.number().int().min(200).max(2000).default(1024),
        height: z.number().int().min(200).max(2000).default(700),
      },
      annotations: READ,
    },
    guard(async ({ path, view, level, focus, radius, zoom, cutHeight, room, corner, elevation, elevationRoom, lighting, eye, target, width, height }, extra) => {
      const file = ws.plan(path);
      const opts = { view, level, focus: focus as [number, number] | undefined, radius, zoom, cutHeight, eye, target, width, height, interior: room || elevation ? { room, corner, elevation, elevationRoom } : undefined };
      const modes = lighting === "both" ? ["day", "night"] : [lighting];
      const r = await job(file, await load(file), { op: "render_view", view: opts, modes }, extra, "Rendering");
      if (!r.ok) return fail(r.summary);
      return ok(...(await images(r)), text(r.summary));
    }),
  );

  const exportFormats = remote ? [".glb"] : [".glb", ".gltf"];
  tool(
    "export_model",
    {
      title: "Export a 3D model",
      description:
        "Export the building as a textured glTF model for game engines (Unity, Unreal, Godot, Blender). " +
        (remote
          ? "Returns a download link for the .glb (single file, textures embedded). Large exports run in the background: if the reply says the export is still running, check export_status."
          : ".glb = single file with embedded textures; .gltf = separate .bin and image files."),
      inputSchema: {
        path: PathArg,
        output: z
          .string()
          .optional()
          .describe(remote ? "Output name ending in .glb (default: exports/<project>.glb)" : "Output file path ending in .glb or .gltf (default: next to the plan, <plan>.glb)"),
        textureSize: z.number().int().min(0).max(4096).default(1024).describe("Texture resolution; 0 = untextured"),
        textureFormat: z
          .enum(["jpeg", "png", "ktx2"])
          .default("jpeg")
          .describe("jpeg = much smaller files (normal maps and transparent textures stay PNG); png = lossless; ktx2 = GPU-compressed Basis Universal with mipmaps (KHR_texture_basisu; Unity needs the KTX package, which the Architecturer Unity package installs). ktx2 is several times slower to export."),
        engine: z
          .enum(["generic", "unity", "godot"])
          .default("generic")
          .describe("unity/godot imply merge + collision. unity also orients the model so plan (x, y) == Unity world (x, z); add the Architecturer Unity package to the Unity project."),
        merge: z.boolean().default(false).describe("Merge static geometry into one mesh per level (fewer draw calls). Furniture and door leaves stay separate movable nodes."),
        collision: z
          .boolean()
          .default(false)
          .describe("Add collision nodes: '<level>-colonly' (static mesh; stairs become ramps) and '<item>-convcolonly' boxes on furniture/doors. Godot imports these natively; Unity needs the Architecturer Unity package."),
      },
      annotations: OUTPUT,
    },
    guard(async ({ path, output, textureSize, textureFormat, engine: target, merge, collision }, extra) => {
      const file = ws.plan(path);
      const project = await load(file);
      const out = output
        ? ws.output(output, exportFormats)
        : remote
          ? ws.output(`exports/${basename(file, extname(file))}.glb`, exportFormats)
          : file.replace(/\.json$/i, "") + ".glb";
      const opts = { textureSize, textureFormat, merge: merge || target !== "generic", collision: collision || target !== "generic", unityAxes: target === "unity" };
      const run = () => engine.run({ op: "export", project, baseDir: dirname(file), out, opts });
      if (!remote) {
        const r = await keepAlive(extra, "Exporting", run());
        if (!r.ok) return fail(r.summary);
        return ok(text(`Wrote ${out}\n${r.summary}`));
      }
      const j = remote.startExport(file, out, run);
      // answer within ~25 s either way: past that some clients give up on the call
      await keepAlive(extra, "Exporting", Promise.race([j.promise, sleep(25_000)]));
      return exportReply(j);
    }),
  );

  const exportReply = (j: ExportJob): Reply => {
    const name = ws.show(j.out);
    if (j.error) return fail(`export ${j.id} of ${ws.nameOf(j.plan)} failed: ${j.error}`);
    if (!j.finished)
      return ok(text(`Export ${j.id} of ${ws.nameOf(j.plan)} is still running (${Math.round((Date.now() - j.started.getTime()) / 1000)} s so far). Check again with export_status; the download link will be: ${remote!.fileLink(j.out)}`));
    if (!j.result!.ok) return fail(j.result!.summary);
    return ok(text(`Exported ${name} in ${Math.round((j.finished.getTime() - j.started.getTime()) / 1000)} s.\nDownload: ${remote!.fileLink(j.out)}\n${j.result!.summary}`));
  };

  if (remote)
    tool(
      "export_status",
      {
        title: "Export status",
        description: "Status of background exports (export_model). Pass an export id, or nothing to list recent exports with their download links.",
        inputSchema: { id: z.string().optional() },
        annotations: READ,
      },
      guard(async ({ id }) => {
        const jobs = remote.exportJobs();
        if (id) {
          const j = jobs.find((x) => x.id === id);
          return j ? exportReply(j) : fail(`no export '${id}' (recent: ${jobs.map((x) => x.id).join(", ") || "none"})`);
        }
        if (!jobs.length) return ok(text("No exports since the server started."));
        return ok(
          text(
            jobs
              .map((j) => `${j.id}: ${ws.nameOf(j.plan)} → ${ws.show(j.out)} — ${j.error ? `failed: ${j.error}` : !j.finished ? "running" : j.result!.ok ? `done, ${remote.fileLink(j.out)}` : "plan has errors"}`)
              .join("\n"),
          ),
        );
      }),
    );

  // -------------------------------------------------------------------------
  // online assets, vendor products, shopping list

  tool(
    "search_assets",
    {
      title: "Search online assets",
      description:
        "Search open CC0 libraries for photo-scanned PBR materials (ambientCG ~2000, Poly Haven ~900: woods, parquet, marble, tiles, plaster, fabrics, metals, concrete...) or furniture / decor models (Poly Haven; a local 3D-FUTURE copy when FUTURE3D_DIR is set). " +
        "Use the returned id directly: materials anywhere a material name goes (floorMaterial, walls, slots, custom material base), models as furniture.model. Downloads happen automatically on the next validate / render / export and are cached.",
      inputSchema: {
        query: z.string().describe("e.g. 'oak herringbone', 'terrazzo', 'travertine', 'velvet', 'armchair'"),
        kind: z.enum(["material", "model"]).default("material"),
        source: z.enum(["all", "ambientcg", "polyhaven", "future3d"]).default("all"),
        limit: z.number().int().min(1).max(50).default(15),
      },
      annotations: WEB,
    },
    guard(async ({ query, kind, source, limit }) => {
      const { searchAssets } = await import("../assets/online.js");
      const hits = await searchAssets(query, { kind, source, limit });
      if (!hits.length) return ok(text(`No ${kind}s found for '${query}'. Try broader words (e.g. 'wood floor', 'marble', 'chair').`));
      return ok(text(hits.map((h) => `${h.id} — ${h.name}${h.category ? ` [${h.category}]` : ""}${h.size ? `, tile ${h.size} m` : ""} (${h.source}, ${h.license})`).join("\n")));
    }),
  );

  tool(
    "search_products",
    {
      title: "Search vendor products",
      description:
        "Search a vendor catalogue for real products (currently IKEA, by market e.g. 'us/en', 'kw/en', 'ae/en', 'sa/en', 'gb/en'). " +
        "For other shops (Homecentre, Amazon, Wayfair, West Elm, Home Box...) find the product page with your own web search, then call import_product with its URL.",
      inputSchema: {
        query: z.string(),
        vendor: z.enum(["ikea"]).default("ikea"),
        market: z.string().default("us/en"),
        limit: z.number().int().min(1).max(24).default(10),
      },
      annotations: WEB,
    },
    guard(async ({ query, market, limit }) => {
      const { searchIkea } = await import("../assets/vendors.js");
      const hits = await searchIkea(query, market, limit);
      if (!hits.length) return ok(text(`IKEA ${market}: nothing found for '${query}'.`));
      return ok(text(hits.map((h) => `${h.name}${h.size ? ` (${h.size})` : ""} — ${h.price ?? "?"} ${h.currency ?? ""}\n  ${h.url}`).join("\n")));
    }),
  );

  tool(
    "import_product",
    {
      title: "Import a product",
      description:
        "Add a real product to a plan's products catalogue — from a vendor page URL (IKEA, Homecentre, Amazon, Wayfair...: name, SKU, price, size, photo colour and, when published, the vendor's 3D model) and/or fields you read yourself — and optionally place it. " +
        "Without a 3D model the product is shown as the closest parametric furniture type, sized and tinted to match. Sizes are metres. " +
        "To correct or fill in an existing product (e.g. a price you researched), pass its `id` with just the fields to change, such as {id, price, currency}. " +
        "Vendor models are for visualising designs (licence 'vendor'); check the vendor's terms before redistributing them in a game.",
      inputSchema: {
        path: PathArg,
        url: z.string().optional().describe("Product page"),
        id: z.string().optional().describe("Product id (default: from the name)"),
        name: z.string().optional(),
        vendor: z.string().optional(),
        sku: z.string().optional(),
        price: z.number().optional(),
        currency: z.string().optional(),
        type: z.string().optional().describe("Closest furniture type (list_furniture); guessed from the name when omitted"),
        width: z.number().positive().optional(),
        depth: z.number().positive().optional(),
        height: z.number().positive().optional(),
        model: z.string().optional().describe(".glb/.gltf/.obj URL or path, polyhaven:/sketchfab:/future3d: id"),
        modelRotation: z.number().optional().describe("Degrees, when the model's front does not face the viewer / -y"),
        image: z.string().optional(),
        color: z.string().optional().describe("#hex or RAL for the stand-in (default: from the photo)"),
        place: z
          .object({
            level: z.string().optional(),
            position: z.tuple([z.number(), z.number()]),
            facing: z.enum(["north", "south", "east", "west"]).optional(),
            rotation: z.number().optional(),
            id: z.string().optional(),
            count: z.number().int().min(1).max(50).optional().describe("Place several in a row (e.g. dining chairs)"),
            spacing: z.number().optional().describe("Row spacing along x (metres)"),
          })
          .optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard(async (a, extra) => {
      const { fetchProduct, guessFurnitureType, photoColor, vendorFromUrl } = await import("../assets/vendors.js");
      const file = ws.plan(a.path);
      const notes: string[] = [];
      let info: Awaited<ReturnType<typeof fetchProduct>> = { warnings: [] };
      if (a.url) {
        try {
          info = await fetchProduct(a.url);
        } catch (e) {
          notes.push(`page not read: ${(e as Error).message}`);
          info = { url: a.url, vendor: vendorFromUrl(a.url), warnings: [] };
        }
      }
      // an existing product (by id) keeps what isn't given: {id, price} just sets the price
      const prior = a.id ? ((await load(file)).products as Json[] | undefined)?.find((p) => p.id === a.id) : undefined;
      const name = a.name ?? info.name ?? prior?.name;
      if (!name) return fail("no product name: pass `name` (and size) when the page cannot be read");
      const type = a.type ?? info.type ?? prior?.type ?? guessFurnitureType(name) ?? "box";
      const image = a.image ?? info.image;
      const model = a.model ?? info.model;
      const color = a.color ?? (!model && image && !prior ? await photoColor(image) : undefined);
      const { productId } = await import("../elements/products.js");
      const placed: string[] = [];
      let existing = false;
      let slug = "";
      const prod: Json = {};
      const { p: project } = await edit(file, (project) => {
        const products = ((project.products as Json[] | undefined) ??= []);
        slug = a.id ?? productId(name, a.sku ?? info.sku, products as never, a.url ?? info.url);
        const found = products.find((p) => p.id === slug);
        existing = !!found;
        Object.assign(prod, {
          id: slug, name, vendor: a.vendor ?? info.vendor, url: a.url ?? info.url, sku: a.sku ?? info.sku, price: a.price ?? info.price, currency: a.currency ?? info.currency,
          type, model, modelRotation: a.modelRotation, width: a.width ?? info.width, depth: a.depth ?? info.depth, height: a.height ?? info.height,
          color, image, license: model && /ikea|vendor/i.test(`${info.vendor ?? a.vendor ?? ""}${model}`) ? "vendor" : undefined,
        });
        for (const k of Object.keys(prod)) if (prod[k] === undefined) delete prod[k];
        if (found) Object.assign(found, prod);
        else products.push(prod);
        if (a.place) {
          const levels = project.levels as Json[];
          const lv = a.place.level ? levels.find((l) => l.id === a.place!.level) : levels[0];
          if (!lv) throw new Error(`level '${a.place.level}' not found`);
          const furn = ((lv.furniture as Json[] | undefined) ??= []);
          const n = a.place.count ?? 1;
          for (let i = 0; i < n; i++) {
            const id = a.place.id ? (n > 1 ? `${a.place.id}_${i + 1}` : a.place.id) : `${slug}_${furn.filter((f) => f.product === slug).length + 1}`;
            const pos = [a.place.position[0] + i * (a.place.spacing ?? Number(prod.width ?? 0.6) + 0.1), a.place.position[1]];
            furn.push({ id, product: slug, position: pos, ...(a.place.facing ? { facing: a.place.facing } : {}), ...(a.place.rotation !== undefined ? { rotation: a.place.rotation } : {}) });
            placed.push(id);
          }
        }
        return "";
      });
      const size = [prod.width, prod.depth, prod.height].map((v) => (typeof v === "number" ? v.toFixed(2) : "?")).join(" × ");
      const lines = [
        `${existing ? "Updated" : "Added"} product '${slug}': ${name}${prod.vendor ? ` (${prod.vendor}${prod.sku ? ` ${prod.sku}` : ""})` : ""}`,
        `type ${type}, ${size} m${prod.price !== undefined ? `, ${prod.price} ${prod.currency ?? ""}` : ""}`,
        model ? `3D model: ${String(model).slice(0, 120)}` : `no 3D model published: shown as a parametric ${type}${color ? ` tinted ${color}` : ""}`,
        ...(placed.length ? [`placed: ${placed.join(", ")}`] : [`place it with furniture { "product": "${slug}", "position": [x, y], "facing": ... }`]),
        ...info.warnings,
        ...notes,
        await validate(file, project, extra),
      ];
      return ok(text(lines.join("\n")));
    }),
  );

  tool(
    "cost_estimate",
    {
      title: "Cost estimate",
      description:
        "Cost estimate / bill of quantities for a plan, measured from the model: partitions, floor / wall / ceiling finishes by material, doors, windows and treatments, built-in joinery (products like IKEA METOD at their real prices, custom runs per metre), electrical points, fixtures and circuits, plumbing fixtures and pipe runs, furniture (vendor prices or allowances), terraces; plus preliminaries, overhead & profit, contingency, fees, VAT. " +
        "scope 'fitout' (the project default unless project.costs.scope says otherwise) prices the interior fit-out of an existing shell; scope 'full' adds the structure and shell measured from the model and project.construction: foundations, reinforced concrete (m³ of concrete, tonnes of rebar, formwork), RC stairs, blockwork, parapets, plaster / render, roof build-up and screed. Use 'full' for a new build or whenever the user asks about concrete, steel, structure or total construction cost. " +
        "Rates are researched Kuwait market rates in KWD where available; override any line with project.costs.rates (keys are listed) and set currency / percentages in project.costs. " +
        (remote ? "Optionally saves the bill as .html / .md / .csv / .json and returns a download link." : "Optionally writes the bill as .html / .md / .csv / .json."),
      inputSchema: {
        path: PathArg,
        output: z.string().optional().describe("Write the full bill here (.html printable, .md, .csv, .json)"),
        lines: z.boolean().default(false).describe("Include every line in the reply (default: section totals)"),
        scope: z.enum(["fitout", "full"]).optional().describe("fitout = interior only; full = also foundations, RC frame, slabs, rebar, formwork, blockwork, plaster, roof (default: project.costs.scope, which defaults to fitout)"),
      },
      annotations: OUTPUT,
    },
    guard(async ({ path, output, lines, scope }, extra) => {
      const file = ws.plan(path);
      const out = output ? ws.output(output, [".html", ".md", ".csv", ".json"]) : undefined;
      const r = await job(file, await load(file), { op: "cost", output: out, lines, scope }, extra, "Estimating");
      if (!r.ok) return fail(r.summary);
      const wrote = out ? (remote ? `\nDownload: ${remote.fileLink(out)}` : `\nWrote ${out}`) : "";
      return ok(text(r.text! + wrote));
    }),
  );

  const Party = z
    .object({
      name: z.string().optional(),
      nameAr: z.string().optional().describe("Name in Arabic"),
      company: z.string().optional(),
      companyAr: z.string().optional(),
      representative: z.string().optional().describe("Who signs for the company"),
      representativeAr: z.string().optional(),
      nationality: z.string().optional(),
      nationalityAr: z.string().optional(),
      civilId: z.string().optional(),
      commercialLicence: z.string().optional(),
      phone: z.string().optional(),
      email: z.string().optional(),
      address: z.string().optional(),
      addressAr: z.string().optional(),
    })
    .describe("Anything left out is printed as a blank line to fill in by hand");
  tool(
    "generate_contract",
    {
      title: "Generate a works contract",
      description:
        "Bilingual works contract (English, then Arabic; the Arabic text prevails) for one trade package of the plan, as Word (.docx) and print-ready HTML (save as PDF). " +
        "Packages: main (the whole building), structure (هيكل أسود: foundations and RC frame), blockwork, plaster (internal + external), waterproofing (roof), tiling, painting, ceilings (gypsum), doors_windows, electrical, plumbing, joinery (kitchens, wardrobes), external (terraces, balustrades). " +
        "mode 'labour' = labour only (مصنعية فقط: the owner supplies materials, listed in the contract); 'supply' = supply and installation. The schedule of quantities is measured from the model (full-scope cost estimate); labour-only rates come from researched Kuwait labour rates, otherwise they are estimated as a share of the supply & install rate and marked * (pass rates {'labour:<key>': rate} with the contractor's prices). " +
        "Includes scope steps, specification, materials split, payment stages tied to the work (per slab for structural work), programme, delay penalty, retention, defects period (and decennial liability for structural work), variations, safety, termination and Kuwaiti law. Owner and site address default to project.contract. " +
        (remote ? "Returns download links." : "Writes the files next to the plan (contracts/) unless `output` is given."),
      inputSchema: {
        path: PathArg,
        package: z.enum(PACKAGE_IDS),
        mode: z.enum(["labour", "supply"]).optional().describe("Default: supply for main, doors_windows and joinery (always supply & install); labour for the other trades"),
        contractor: Party.optional(),
        owner: Party.optional().describe("Default: project.contract.owner"),
        location: z
          .object({ governorate: z.string(), area: z.string(), block: z.string(), street: z.string(), avenue: z.string(), plot: z.string(), house: z.string(), paci: z.string() })
          .partial()
          .optional()
          .describe("Site address; default project.contract.location"),
        date: z.string().optional().describe("Contract date YYYY-MM-DD (default today)"),
        startDate: z.string().optional().describe("Start of works YYYY-MM-DD (default a week after the contract date)"),
        durationDays: z.number().int().positive().optional().describe("Default: from the package and building size"),
        retention: z.number().min(0).max(20).optional(),
        defectsMonths: z.number().int().min(0).max(60).optional(),
        delayPenaltyPerDay: z.number().min(0).optional(),
        delayPenaltyCap: z.number().min(0).max(100).optional(),
        rates: z.record(z.string(), z.number().min(0)).optional().describe("Rate overrides: {'labour:wall:cement_plaster': 1.45} (labour) or {'<key>': rate}"),
        includeJoinery: z.boolean().optional().describe("main: include kitchens and built-in joinery (default false: let separately)"),
        extraTerms: z.array(z.object({ en: z.string(), ar: z.string() })).optional().describe("Extra special conditions, each in English and Arabic"),
        formats: z.array(z.enum(["docx", "html"])).default(["docx", "html"]),
        output: z.string().optional().describe("Base file name without extension (default contracts/<project>-<package>-<mode>)"),
      },
      annotations: OUTPUT,
    },
    guard(async (a, extra) => {
      const { packageById } = await import("../contracts/packages.js");
      const pkg = packageById(a.package);
      const mode = a.mode ?? pkg.modes[0];
      const file = ws.plan(a.path);
      const base = (a.output ?? `contracts/${basename(file, extname(file))}-${pkg.id}-${mode}`).replace(/\.(docx|html)$/i, "");
      const where = (ext: string) => (remote ? ws.output(`${base}${ext}`, [ext]) : ws.output(base.startsWith("/") ? `${base}${ext}` : `${dirname(file)}/${base}${ext}`, [ext]));
      const out = { docx: a.formats.includes("docx") ? where(".docx") : undefined, html: a.formats.includes("html") ? where(".html") : undefined };
      const options = { ...a, path: undefined, formats: undefined, output: undefined, package: pkg.id, mode };
      const r = await job(file, await load(file), { op: "contract", options, out }, extra, "Writing the contract");
      if (!r.ok) return fail(r.summary);
      const files = [out.docx, out.html].filter((x): x is string => !!x).map((f) => (remote ? `${extname(f).slice(1).toUpperCase()}: ${remote.fileLink(f)}` : `Wrote ${f}`));
      return ok(text(`${r.text}\n${files.join("\n")}\nThe contract is a draft: have it reviewed before signing.`));
    }),
  );

  tool(
    "shopping_list",
    { title: "Shopping list", description: "Bill of materials for the products placed in a plan: quantities, unit prices and totals per vendor, with links.", inputSchema: { path: PathArg }, annotations: READ },
    guard(async ({ path }) => {
      const { shoppingList } = await import("../elements/products.js");
      const project = (await load(ws.plan(path))) as never;
      const { lines, totals } = shoppingList(project);
      if (!lines.length) return ok(text("No products placed (import_product, then furniture.product)."));
      const out = lines.map((l) => `${l.quantity}× ${l.name} — ${l.vendor}${l.sku ? ` ${l.sku}` : ""}${l.unitPrice !== undefined ? ` @ ${l.unitPrice} ${l.currency ?? ""} = ${l.total} ${l.currency ?? ""}` : ""}${l.url ? `\n   ${l.url}` : ""}`);
      out.push("", ...totals.map((t) => `${t.vendor}: ${t.items} item(s), ${t.total} ${t.currency}`));
      return ok(text(out.join("\n")));
    }),
  );

  return server;
}
