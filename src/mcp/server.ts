#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { z } from "zod";
import { listFurniture } from "../elements/furniture.js";
import { exportGLB, exportGLTF } from "../export/gltf.js";
import { fullGuide } from "../guide.js";
import { readJson } from "../io.js";
import { listMaterials } from "../materials/library.js";
import { compile, type Compiled } from "../pipeline.js";
import { renderPlanSVG, svgToPng, PLAN_SHEETS } from "../render/plan.js";
import { VIEW_PRESETS, type ViewPreset } from "../render/raster.js";
import { renderViewPNG } from "../render/view.js";
import { ELEMENT_KINDS, projectJsonSchema } from "../schema/schema.js";
import { STARTER_PROJECT } from "../templates.js";

type Json = Record<string, any>;

/**
 * Relative paths resolve against ARCHITECTURER_WORKDIR, else the working directory. Apps like Claude
 * Desktop start servers in "/", so there we fall back to ~/Architecturer instead of the disk root.
 */
const WORKDIR =
  process.env.ARCHITECTURER_WORKDIR ?? (process.cwd() === "/" ? join(homedir(), "Architecturer") : process.cwd());
const abs = (p: string) => resolve(WORKDIR, p.replace(/^~(?=\/|$)/, homedir()));
type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

const server = new McpServer(
  { name: "architecturer", version: "0.1.0" },
  {
    instructions:
      "Architecturer builds 3D architecture (walls, doors, windows, rooms, stairs, roofs, furniture) from a JSON plan file and exports textured game-ready GLB models. " +
      "Start with get_guide. Plans live in JSON files on disk; every tool takes the file path. After edits, check render_plan / render_view images.",
  },
);

const text = (t: string): Content => ({ type: "text", text: t });
const ok = (...content: Content[]) => ({ content });
const fail = (msg: string) => ({ content: [text(`Error: ${msg}`)], isError: true });

function summary(c: Compiled): string {
  const lines: string[] = [];
  lines.push(c.ok ? "Plan is valid." : `Plan has ${c.errors.length} error(s).`);
  for (const e of c.errors) lines.push(`ERROR: ${e}`);
  for (const w of c.warnings) lines.push(`warning: ${w}`);
  if (c.root) lines.push(`${c.stats.triangles} triangles, ${c.stats.nodes} nodes, ${c.stats.materials} materials.`);
  if (c.project)
    lines.push(
      "Levels: " +
        c.levels.map((l) => `${l.id} (z=${l.elevation}, h=${l.height})`).join(", "),
    );
  return lines.join("\n");
}

async function load(path: string): Promise<Json> {
  const j = await readJson(abs(path));
  if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error(`${path} does not contain a JSON object`);
  return j as Json;
}

async function save(path: string, project: Json): Promise<Compiled> {
  const p = abs(path);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(project, null, 2) + "\n");
  return compile(project);
}

function findLevel(project: Json, level: string): Json {
  const lv = (project.levels ?? []).find((l: Json) => l.id === level);
  if (!lv) throw new Error(`level '${level}' not found (levels: ${(project.levels ?? []).map((l: Json) => l.id).join(", ") || "none"})`);
  return lv;
}

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

const guard =
  <A>(fn: (a: A) => Promise<{ content: Content[]; isError?: boolean }>) =>
  async (a: A) => {
    try {
      return await fn(a);
    } catch (e) {
      return fail((e as Error).message);
    }
  };

const PathArg = z.string().describe(`Path to the plan JSON file: absolute, or relative to the project folder ${WORKDIR}`);
const LevelArg = z.string().describe("Level id, e.g. 'ground'");

server.registerTool(
  "get_guide",
  { description: "READ FIRST. Conventions, coordinate system, good practice, workflow, plus the full material and furniture libraries.", inputSchema: {} },
  async () => ok(text(fullGuide())),
);

server.registerTool(
  "get_schema",
  { description: "JSON Schema of the plan file (every field with descriptions and defaults).", inputSchema: {} },
  async () => ok(text(JSON.stringify(projectJsonSchema()))),
);

server.registerTool(
  "list_materials",
  { description: "Built-in materials (procedural PBR textures).", inputSchema: {} },
  async () => ok(text(listMaterials().map((m) => `${m.name} (${m.pattern}): ${m.description}`).join("\n"))),
);

server.registerTool(
  "list_styles",
  { description: "Interior style presets (scandinavian, japandi, industrial, ...) with the material each assigns to every role. Use as project.style or room.style.", inputSchema: {} },
  async () => {
    const { listStyles } = await import("../elements/styles.js");
    return ok(text(JSON.stringify(listStyles(), null, 1)));
  },
);

server.registerTool(
  "list_furniture",
  { description: "Furniture/fixture types with default sizes, material slots and options.", inputSchema: {} },
  async () => ok(text(JSON.stringify(listFurniture(), null, 1))),
);

server.registerTool(
  "create_project",
  {
    description: "Create a new plan file. Pass a full `project` object, or omit it to get a small starter cabin to modify.",
    inputSchema: { path: PathArg, project: z.record(z.string(), z.any()).optional(), overwrite: z.boolean().default(false) },
  },
  guard(async ({ path, project, overwrite }) => {
    if (existsSync(abs(path)) && !overwrite) return fail(`${path} already exists (pass overwrite: true to replace it)`);
    const c = await save(path, (project as Json) ?? structuredClone(STARTER_PROJECT));
    return ok(text(`Created ${abs(path)}\n${summary(c)}`));
  }),
);

server.registerTool(
  "read_project",
  { description: "Return the plan JSON as stored on disk.", inputSchema: { path: PathArg } },
  guard(async ({ path }) => ok(text(JSON.stringify(await load(path), null, 1)))),
);

server.registerTool(
  "write_project",
  {
    description: "Replace the whole plan file with `project` (best for large changes). Returns validation results. The file is written even when invalid so you can fix it incrementally.",
    inputSchema: { path: PathArg, project: z.record(z.string(), z.any()) },
  },
  guard(async ({ path, project }) => ok(text(summary(await save(path, project as Json))))),
);

server.registerTool(
  "add_level",
  {
    description: "Append a level (storey). Example: {id:'upper', height:3, walls:[...]}.",
    inputSchema: { path: PathArg, level: z.record(z.string(), z.any()) },
  },
  guard(async ({ path, level }) => {
    const p = await load(path);
    p.levels = [...(p.levels ?? []), level];
    return ok(text(summary(await save(path, p))));
  }),
);

server.registerTool(
  "add_elements",
  {
    description:
      "Append elements to a level. `elements` maps a collection to a list, e.g. {walls:[{id:'w1',points:[[0,0],[5,0]]}], openings:[{type:'door',at:[2,0]}], furniture:[{type:'sofa',position:[2,2],facing:'north'}]}. Elements without an id get one (returned).",
    inputSchema: {
      path: PathArg,
      level: LevelArg,
      elements: z
        .object(Object.fromEntries(ELEMENT_KINDS.map((k) => [k, z.array(z.record(z.string(), z.any())).optional()])))
        .describe("Collections: " + ELEMENT_KINDS.join(", ")),
    },
  },
  guard(async ({ path, level, elements }) => {
    const p = await load(path);
    const lv = findLevel(p, level);
    const added: string[] = [];
    for (const [kind, items] of Object.entries(elements)) {
      if (!items) continue;
      assignIds(p, kind, items as Json[]);
      lv[kind] = [...(lv[kind] ?? []), ...items];
      added.push(`${kind}: ${(items as Json[]).map((i) => i.id).join(", ")}`);
    }
    return ok(text(`Added ${added.join("; ")}\n${summary(await save(path, p))}`));
  }),
);

server.registerTool(
  "update_element",
  {
    description: "Shallow-merge `changes` into one element found by id (set a field to null to delete it). Example: {id:'front_door', changes:{width:1.0, style:'double'}}.",
    inputSchema: { path: PathArg, id: z.string(), changes: z.record(z.string(), z.any()) },
  },
  guard(async ({ path, id, changes }) => {
    const p = await load(path);
    for (const lv of p.levels ?? [])
      for (const k of ELEMENT_KINDS)
        for (const el of lv[k] ?? [])
          if (el.id === id) {
            for (const [key, v] of Object.entries(changes)) {
              if (v === null) delete el[key];
              else el[key] = v;
            }
            return ok(text(`Updated ${k} '${id}' on level '${lv.id}'\n${summary(await save(path, p))}`));
          }
    return fail(`no element with id '${id}'`);
  }),
);

server.registerTool(
  "remove_elements",
  { description: "Remove elements (any collection, any level) by id.", inputSchema: { path: PathArg, ids: z.array(z.string()) } },
  guard(async ({ path, ids }) => {
    const p = await load(path);
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
    return ok(text(`Removed: ${removed.join(", ") || "nothing"}${missing.length ? `. Not found: ${missing.join(", ")}` : ""}\n${summary(await save(path, p))}`));
  }),
);

server.registerTool(
  "validate",
  { description: "Validate and build the plan; returns errors, warnings and stats.", inputSchema: { path: PathArg } },
  guard(async ({ path }) => ok(text(summary(compile(await load(path)))))),
);

server.registerTool(
  "render_plan",
  {
    description:
      "2D floor plan image of one level: meter grid with coordinates, walls (with ids), doors with swings, windows, rooms with areas, stairs, furniture footprints (front edge drawn thick). " +
      "sheet 'lighting': fixture symbols with ids, rooms tinted by estimated lux, fixture legend with lumens. sheet 'finishes': floors in their material pattern, wall finish / accent bands, per-room finish schedule. " +
      "sheet 'rcp': reflected ceiling plan (ceiling heights + materials, soffits, coffers, beams, LED coves, cornices, ceiling openings, fixtures). " +
      "sheet 'false_ceiling': false ceiling setting-out (every ceiling level colour-coded and tagged above FFL, drop edges, coves, soffit widths, void depth, typical tray section).",
    inputSchema: {
      path: PathArg,
      level: LevelArg.optional().describe("Default: first level"),
      sheet: z.enum(PLAN_SHEETS).optional().describe("plan (default) | lighting | finishes | rcp | false_ceiling"),
    },
  },
  guard(async ({ path, level, sheet }) => {
    const c = compile(await load(path));
    if (!c.root) return fail(summary(c));
    const png = await svgToPng(renderPlanSVG(c, level, { sheet }));
    return ok({ type: "image", data: png.toString("base64"), mimeType: "image/png" }, text(summary(c)));
  }),
);

server.registerTool(
  "render_view",
  {
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
  },
  guard(async ({ path, view, level, focus, radius, zoom, cutHeight, room, corner, elevation, elevationRoom, lighting, eye, target, width, height }) => {
    const c = compile(await load(path));
    if (!c.root) return fail(summary(c));
    const opts = { view, level, focus: focus as [number, number] | undefined, radius, zoom, cutHeight, eye, target, width, height, interior: room || elevation ? { room, corner, elevation, elevationRoom } : undefined };
    const modes = lighting === "both" ? (["day", "night"] as const) : ([lighting] as const);
    const images = modes.map((m) => ({ type: "image" as const, data: renderViewPNG(c, { ...opts, lighting: m }).toString("base64"), mimeType: "image/png" }));
    return ok(...images, text(summary(c)));
  }),
);

server.registerTool(
  "export_model",
  {
    description: "Export the building as a textured glTF model for game engines (Unity, Unreal, Godot, Blender). .glb = single file with embedded textures; .gltf = separate .bin and image files.",
    inputSchema: {
      path: PathArg,
      output: z.string().describe("Output file path ending in .glb or .gltf"),
      textureSize: z.number().int().min(0).max(4096).default(1024).describe("Texture resolution; 0 = untextured"),
      textureFormat: z
        .enum(["jpeg", "png", "ktx2"])
        .default("jpeg")
        .describe("jpeg = much smaller files (normal maps and transparent textures stay PNG); png = lossless; ktx2 = GPU-compressed Basis Universal with mipmaps (KHR_texture_basisu; Unity needs the KTX package, which the Architecturer Unity package installs)"),
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
  },
  guard(async ({ path, output, textureSize, textureFormat, engine, merge, collision }) => {
    const c = compile(await load(path));
    if (!c.root) return fail(summary(c));
    const out = abs(output);
    await mkdir(dirname(out), { recursive: true });
    const opts = {
      textureSize,
      textureFormat,
      merge: merge || engine !== "generic",
      collision: collision || engine !== "generic",
      unityAxes: engine === "unity",
    };
    if (extname(out) === ".gltf") await exportGLTF(c, out, opts);
    else await writeFile(out, await exportGLB(c, opts));
    return ok(text(`Wrote ${out}\n${summary(c)}`));
  }),
);

await server.connect(new StdioServerTransport());
