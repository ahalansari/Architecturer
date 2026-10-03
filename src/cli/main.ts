#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { listFurniture } from "../elements/furniture.js";
import { exportGLB, exportGLTF } from "../export/gltf.js";
import { listMaterials } from "../materials/library.js";
import { loadAndCompile } from "../io.js";
import type { Compiled } from "../pipeline.js";
import { PLAN_SHEETS, renderPlanSVG, svgToPng, type PlanSheet } from "../render/plan.js";
import { LIGHTING_MODES, VIEW_PRESETS, type LightingMode, type ViewPreset } from "../render/raster.js";
import { renderViewPNG } from "../render/view.js";
import { projectJsonSchema } from "../schema/schema.js";
import { STARTER_PROJECT } from "../templates.js";

type Flags = Record<string, string | boolean>;
interface Flag {
  name: string;
  /** Placeholder for the value; omitted for boolean switches. */
  arg?: string;
  desc: string;
}
interface Command {
  usage: string;
  desc: string;
  file?: boolean;
  flags: Flag[];
  run(file: string, f: Flags): Promise<number | void>;
}

const OUT = { name: "o", arg: "path", desc: "output file" };

const COMMANDS: Record<string, Command> = {
  guide: {
    usage: "arch guide",
    desc: "Authoring guide for AI agents: conventions, workflow, materials, furniture (read first)",
    flags: [],
    async run() {
      const { fullGuide } = await import("../guide.js");
      console.log(fullGuide());
    },
  },
  init: {
    usage: "arch init <plan.json>",
    desc: "Write a small starter plan to modify",
    file: true,
    flags: [],
    async run(file) {
      await write(file, JSON.stringify(STARTER_PROJECT, null, 2) + "\n");
    },
  },
  validate: {
    usage: "arch validate <plan.json>",
    desc: "Check a plan: schema errors, geometry errors and layout warnings (furniture in walls/door swings, unreachable rooms, stairs...)",
    file: true,
    flags: [{ name: "strict", desc: "exit with status 1 on warnings too" }],
    async run(file, f) {
      const c = await loadAndCompile(file);
      report(c, true);
      console.log(c.ok ? (c.warnings.length ? `OK with ${c.warnings.length} warning(s)` : "OK") : "FAILED");
      return c.ok && !(f.strict && c.warnings.length) ? 0 : 1;
    },
  },
  plan: {
    usage: "arch plan <plan.json> [--level id] [--sheet plan|lighting|finishes|rcp|false_ceiling|electrical|plumbing] [-o plan.png|plan.svg]",
    desc: "2D floor plan: meter grid with coordinates, wall/opening/furniture ids, door swings, rooms with areas; lighting, finishes, reflected ceiling, false ceiling, electrical and plumbing sheets",
    file: true,
    flags: [
      { name: "level", arg: "id", desc: "level to draw (default: first)" },
      { name: "sheet", arg: "kind", desc: "plan (default) | lighting (fixture layout, lux per room, legend) | finishes (floor materials and patterns, wall finish bands, finish schedule) | rcp (reflected ceiling plan: ceiling heights, materials, soffits, beams, coves, fixtures) | false_ceiling (ceiling levels above FFL, drops, coves, soffit dimensions, void, typical section) | electrical (switches with switch legs, sockets, data/TV, appliance points, detectors, DB, circuit schedule) | plumbing (fixtures, cold/hot supplies, waste/soil drains, stacks, floor drains, heaters, fixture schedule)" },
      OUT,
    ],
    async run(file, f) {
      const sheet = (f.sheet as string | undefined) ?? "plan";
      if (!(PLAN_SHEETS as readonly string[]).includes(sheet)) throw new Error(`--sheet must be one of ${PLAN_SHEETS.join(", ")}`);
      const c = await compiled(file);
      const out = (f.o as string) ?? `${base(file)}.${sheet === "plan" ? "plan" : sheet}.png`;
      const svg = renderPlanSVG(c, f.level as string | undefined, { sheet: sheet as PlanSheet });
      await write(out, extname(out) === ".svg" ? svg : await svgToPng(svg));
    },
  },
  render: {
    usage: "arch render <plan.json> [--view iso] [--level id] [--focus x,y] [-o view.png]",
    desc: "Headless 3D render to PNG",
    file: true,
    flags: [
      { name: "view", arg: "preset", desc: `camera direction: ${VIEW_PRESETS.join(", ")} (default iso)` },
      { name: "level", arg: "id", desc: "cutaway: hide everything above this level's walls" },
      { name: "cut", arg: "meters", desc: "cutaway height above the level floor (default min(0.75*height, 2.2))" },
      { name: "focus", arg: "x,y[,z]", desc: "frame this plan point instead of the whole building" },
      { name: "radius", arg: "meters", desc: "how much to show around --focus (default 3)" },
      { name: "zoom", arg: "factor", desc: ">1 moves closer, <1 further away" },
      { name: "eye", arg: "x,y,z", desc: "explicit camera position (plan coordinates, z up)" },
      { name: "target", arg: "x,y,z", desc: "point the explicit camera looks at" },
      { name: "fov", arg: "degrees", desc: "vertical field of view for --eye (default 45)" },
      { name: "size", arg: "WxH", desc: "image size in pixels (default 1280x800)" },
      { name: "room", arg: "name|id", desc: "interior: eye-level wide shot of a room from a corner" },
      { name: "corner", arg: "n", desc: "with --room: which corner to shoot from (0 = farthest, 1, 2...)" },
      { name: "elevation", arg: "wall-id", desc: "interior: square-on orthographic view of a wall (kitchens, wardrobes, tiling, art)" },
      { name: "elevation-room", arg: "name|id", desc: "with --elevation: which room's side of the wall to look at" },
      { name: "lighting", arg: "day|night|dusk|both", desc: "night/dusk: lit by the plan's light fixtures and lamps (judge a lighting design); both = day + night images" },
      OUT,
    ],
    async run(file, f) {
      const c = await compiled(file);
      const view = (f.view as ViewPreset) ?? "iso";
      if (!VIEW_PRESETS.includes(view)) throw new Error(`unknown view '${view}' (${VIEW_PRESETS.join(", ")})`);
      const [width, height] = f.size ? nums(f.size, "size", 2, "x") : [undefined, undefined];
      const tag = f.room ? `room-${String(f.room).replace(/\W+/g, "_")}` : f.elevation ? `elev-${f.elevation}` : view;
      const out = (f.o as string) ?? `${base(file)}.${tag}${f.level ? "." + f.level : ""}.png`;
      const lighting = (f.lighting as string | undefined) ?? "day";
      if (![...LIGHTING_MODES, "both"].includes(lighting)) throw new Error(`--lighting must be day, night, dusk or both (got '${lighting}')`);
      const viewOpts = {
        view,
        level: f.level as string | undefined,
        width,
        height,
        cutHeight: f.cut ? num(f.cut, "cut") : undefined,
        focus: f.focus ? (nums(f.focus, "focus", [2, 3]) as [number, number]) : undefined,
        radius: f.radius ? num(f.radius, "radius") : undefined,
        zoom: f.zoom ? num(f.zoom, "zoom") : undefined,
        eye: f.eye ? (nums(f.eye, "eye", 3) as [number, number, number]) : undefined,
        target: f.target ? (nums(f.target, "target", 3) as [number, number, number]) : undefined,
        fov: f.fov ? num(f.fov, "fov") : undefined,
        interior:
          f.room || f.elevation
            ? {
                room: f.room as string | undefined,
                corner: f.corner ? num(f.corner, "corner") : undefined,
                elevation: f.elevation as string | undefined,
                elevationRoom: f["elevation-room"] as string | undefined,
              }
            : undefined,
      };
      if (lighting === "both")
        for (const m of ["day", "night"] as const) await write(out.replace(/(\.png)?$/i, `.${m}.png`), renderViewPNG(c, { ...viewOpts, lighting: m }));
      else await write(out, renderViewPNG(c, { ...viewOpts, lighting: lighting as LightingMode }));
    },
  },
  build: {
    usage: "arch build <plan.json> [-o model.glb|model.gltf] [--unity|--godot]",
    desc: "Export a textured glTF model for game engines",
    file: true,
    flags: [
      OUT,
      { name: "texture-size", arg: "px", desc: "texture resolution (default 512; 0 = untextured)" },
      { name: "texture-format", arg: "jpeg|png|ktx2", desc: "jpeg = small files (normal maps stay PNG), png = lossless, ktx2 = GPU-compressed Basis Universal with mipmaps (default jpeg)" },
      { name: "ktx2-quality", arg: "fast|high", desc: "ktx2 only: high = UASTC normal maps (sharper, larger, slow to encode)" },
      { name: "merge", desc: "one static mesh per level (sub-mesh per material); furniture/doors stay separate" },
      { name: "collision", desc: "add collider nodes (*-colonly static mesh, *-convcolonly boxes on movable items)" },
      { name: "unity", desc: "--merge --collision, oriented so plan (x, y) == Unity world (x, z)" },
      { name: "godot", desc: "--merge --collision (Godot turns *-colonly nodes into physics bodies)" },
    ],
    async run(file, f) {
      const c = await loadAndCompile(file);
      report(c, true);
      if (!c.root) return 1;
      const out = (f.o as string) ?? `${base(file)}.glb`;
      const textureSize = f["texture-size"] !== undefined ? num(f["texture-size"], "texture-size") : 512;
      const textureFormat = (f["texture-format"] ?? "jpeg") as "jpeg" | "png" | "ktx2";
      if (!["jpeg", "png", "ktx2"].includes(textureFormat)) throw new Error("--texture-format must be jpeg, png or ktx2");
      const ktx2Quality = (f["ktx2-quality"] ?? "fast") as "fast" | "high";
      if (!["fast", "high"].includes(ktx2Quality)) throw new Error("--ktx2-quality must be fast or high");
      const engine = f.unity ? "unity" : f.godot ? "godot" : undefined;
      const opts = { textureSize, textureFormat, ktx2Quality, merge: !!(f.merge || engine), collision: !!(f.collision || engine), unityAxes: engine === "unity" };
      if (extname(out) === ".gltf") {
        await mkdir(dirname(out), { recursive: true });
        await exportGLTF(c, out, opts);
        console.log(`wrote ${out}`);
      } else await write(out, await exportGLB(c, opts));
      return c.ok ? 0 : 1;
    },
  },
  serve: {
    usage: "arch serve <plan.json> [--port 5177]",
    desc: "Live 3D viewer in the browser; reloads whenever the file is saved",
    file: true,
    flags: [{ name: "port", arg: "n", desc: "port (default 5177)" }],
    async run(file, f) {
      const { serve } = await import("../server/server.js");
      await serve(file, { port: f.port ? num(f.port, "port") : 5177 });
      return -1; // keep running
    },
  },
  schema: {
    usage: "arch schema",
    desc: "Print the plan JSON Schema (every field, with descriptions and defaults)",
    flags: [],
    async run() {
      console.log(JSON.stringify(projectJsonSchema(), null, 2));
    },
  },
  materials: {
    usage: "arch materials",
    desc: "List the material library",
    flags: [],
    async run() {
      for (const m of listMaterials()) console.log(`${m.name.padEnd(22)} ${m.pattern.padEnd(12)} ${m.description}`);
    },
  },
  styles: {
    usage: "arch styles",
    desc: "List interior style presets (project/room `style`) and the materials they assign to each role",
    flags: [],
    async run() {
      const { listStyles } = await import("../elements/styles.js");
      for (const st of listStyles()) {
        console.log(`${st.name.padEnd(16)} ${st.description}`);
        console.log(`${"".padEnd(16)} ${Object.entries(st.palette).map(([k, v]) => `${k}=${v}`).join(" ")}`);
      }
    },
  },
  furniture: {
    usage: "arch furniture",
    desc: "List furniture types with default sizes, material slots and options",
    flags: [],
    async run() {
      for (const t of listFurniture()) {
        const opts = Object.keys(t.options ?? {});
        console.log(
          `${t.type.padEnd(18)} ${`${t.defaults.width}x${t.defaults.depth}x${t.defaults.height}`.padEnd(15)} ${t.description}` +
            `\n${"".padEnd(34)}slots: ${Object.keys(t.slots).join(", ")}${opts.length ? `; options: ${opts.join(", ")}` : ""}`,
        );
      }
    },
  },
};

function helpText(): string {
  const lines = ["arch — AI-first architecture modeler (JSON plan -> textured game-ready glTF)", "", "Commands:"];
  for (const c of Object.values(COMMANDS)) lines.push(`  ${c.usage.padEnd(70)} ${c.desc.split(":")[0]}`);
  lines.push("", "Run `arch <command> --help` for a command's options. Start with `arch guide`.");
  return lines.join("\n");
}

function commandHelp(c: Command): string {
  const lines = [c.usage, "", c.desc];
  if (c.flags.length) {
    lines.push("", "Options:");
    for (const f of c.flags) {
      const flag = (f.name.length === 1 ? `-${f.name}` : `--${f.name}`) + (f.arg ? ` <${f.arg}>` : "");
      lines.push(`  ${flag.padEnd(26)} ${f.desc}`);
    }
  }
  return lines.join("\n");
}

/** Strict flag parsing: unknown flags and missing values are errors (typos shouldn't be silently ignored). */
function parse(name: string, c: Command, argv: string[]): { pos: string[]; flags: Flags } {
  const pos: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("-") || /^-\d/.test(a)) {
      pos.push(a);
      continue;
    }
    const key = a.replace(/^-+/, "").split("=")[0];
    const inline = a.includes("=") ? a.slice(a.indexOf("=") + 1) : undefined;
    const spec = c.flags.find((f) => f.name === key);
    if (!spec) {
      const known = c.flags.map((f) => (f.name.length === 1 ? `-${f.name}` : `--${f.name}`)).join(", ") || "none";
      throw new Error(`unknown option '${a}' for 'arch ${name}' (options: ${known})`);
    }
    if (spec.arg) {
      const v = inline ?? argv[++i];
      if (v === undefined) throw new Error(`option '${a}' needs a value <${spec.arg}>`);
      flags[key] = v;
    } else flags[key] = true;
  }
  return { pos, flags };
}

const num = (v: string | boolean, name: string): number => {
  const n = Number(v);
  if (typeof v !== "string" || !isFinite(n)) throw new Error(`--${name} must be a number (got '${v}')`);
  return n;
};
function nums(v: string | boolean, name: string, count: number | number[], sep = ","): number[] {
  const parts = String(v).split(sep).map(Number);
  const ok = Array.isArray(count) ? count.includes(parts.length) : parts.length === count;
  if (!ok || parts.some((n) => !isFinite(n)))
    throw new Error(`--${name} expects ${Array.isArray(count) ? count.join(" or ") : count} numbers separated by '${sep}' (got '${v}')`);
  return parts;
}

const base = (file: string) => file.replace(/\.json$/, "");

/** Errors and warnings go to stderr; `stats` adds the geometry summary. */
function report(c: Compiled, stats = false) {
  for (const e of c.errors) console.error(`error: ${e}`);
  for (const w of c.warnings) console.error(`warning: ${w}`);
  if (stats && c.root)
    console.error(`${c.stats.triangles.toLocaleString()} triangles, ${c.stats.meshes} meshes, ${c.stats.nodes} nodes, ${c.stats.materials} materials`);
}

async function compiled(file: string): Promise<Compiled> {
  const c = await loadAndCompile(file);
  report(c);
  if (!c.root) throw new Error("plan has errors; fix them first (arch validate)");
  return c;
}

async function write(path: string, data: Uint8Array | string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
  console.log(`wrote ${path}`);
}

async function main(): Promise<number> {
  const [name, ...rest] = process.argv.slice(2);
  if (!name || name === "help" || name === "--help" || name === "-h") {
    console.log(helpText());
    return 0;
  }
  const cmd = COMMANDS[name];
  if (!cmd) {
    console.error(`unknown command '${name}'\n\n${helpText()}`);
    return 1;
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(commandHelp(cmd));
    return 0;
  }
  const { pos, flags } = parse(name, cmd, rest);
  if (cmd.file && !pos[0]) throw new Error(`missing plan file\n\n${commandHelp(cmd)}`);
  return (await cmd.run(pos[0], flags)) ?? 0;
}

main().then(
  (code) => {
    if (code !== -1) process.exit(code);
  },
  (e) => {
    console.error(`error: ${(e as Error).message}`);
    process.exit(1);
  },
);
