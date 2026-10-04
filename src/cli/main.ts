#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { listFurniture } from "../elements/furniture.js";
import { exportGLB, exportGLTF } from "../export/gltf.js";
import { listMaterials } from "../materials/library.js";
import { loadAndCompile, readJson } from "../io.js";
import { vendorNotice, type Compiled } from "../pipeline.js";
import { PLAN_SHEETS, renderPlanSVG, svgToPng, type PlanSheet } from "../render/plan.js";
import { LIGHTING_MODES, VIEW_PRESETS, type LightingMode, type ViewPreset } from "../render/raster.js";
import { renderView } from "../render/view.js";
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
      { name: "renderer", arg: "auto|gpu|cpu", desc: "auto: GPU path tracer when there is a GPU (default); cpu: fast rasteriser" },
      { name: "samples", arg: "n", desc: "path tracer samples per pixel (default 128)" },
      { name: "time", arg: "HH:MM", desc: "local time for the sun (Kuwait; default 10:30)" },
      { name: "date", arg: "MM-DD", desc: "date for the sun (default 03-21)" },
      { name: "exposure", arg: "EV", desc: "exposure compensation (default 0, automatic)" },
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
        renderer: f.renderer as "auto" | "gpu" | "cpu" | undefined,
        samples: f.samples ? num(f.samples, "samples") : undefined,
        time: f.time as string | undefined,
        date: f.date as string | undefined,
        exposure: f.exposure !== undefined ? num(f.exposure, "exposure") : undefined,
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
      const shoot = async (o: string, m: LightingMode) => {
        const r = await renderView(c, { ...viewOpts, lighting: m });
        console.error(r.note ?? r.renderer);
        await write(o, r.png);
      };
      if (lighting === "both") for (const m of ["day", "night"] as const) await shoot(out.replace(/(\.png)?$/i, `.${m}.png`), m);
      else await shoot(out, lighting as LightingMode);
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
      if (c.credits.length) {
        const lines = c.credits.map((s) => `- ${s.title ?? s.id} — ${s.id}${s.author ? `, by ${s.author}` : ""}${s.url ? ` <${s.url}>` : ""} — licence: ${s.license}`);
        await write(`${out.replace(/\.(glb|gltf)$/i, "")}.credits.md`, `# Asset credits\n\n${lines.join("\n")}\n`);
        const notice = vendorNotice(c);
        if (notice) console.log(`note: ${notice}`);
      }
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
  mcp: {
    usage: "arch mcp [--http] [--port 5178] [--public-url https://...] [--workdir dir]",
    desc: "MCP server: over stdio for local clients (default), or --http for remote clients (OAuth, personal tokens, live viewer, download links)",
    flags: [
      { name: "http", desc: "remote server over Streamable HTTP (settings: see the README, 'Remote MCP server')" },
      { name: "port", arg: "n", desc: "HTTP port (default $PORT or 5178)" },
      { name: "public-url", arg: "url", desc: "public origin clients reach, e.g. https://arch.example.com (default $ARCHITECTURER_PUBLIC_URL)" },
      { name: "workdir", arg: "dir", desc: "project folder (default $ARCHITECTURER_WORKDIR or the current folder)" },
    ],
    async run(_file, f) {
      if (!f.http) {
        if (f.port || f["public-url"]) throw new Error("--port and --public-url need --http");
        if (typeof f.workdir === "string") process.env.ARCHITECTURER_WORKDIR = f.workdir;
        await import("../mcp/server.js");
        return -1;
      }
      const { main } = await import("../mcp/http.js");
      await main({
        port: f.port ? num(f.port, "port") : undefined,
        publicUrl: typeof f["public-url"] === "string" ? f["public-url"] : undefined,
        workdir: typeof f.workdir === "string" ? f.workdir : undefined,
      });
      return -1;
    },
  },
  user: {
    usage: "arch user <add|passwd|reset-2fa|delete|list> [--name n] [--password-stdin]",
    desc: "Accounts that log in to the remote MCP server's pages (setup, recovery when locked out); asks for the password unless --password-stdin",
    flags: [
      { name: "name", arg: "n", desc: "the username" },
      { name: "password-stdin", desc: "read the password from standard input instead of asking" },
    ],
    async run(action, f) {
      const { AuthStore } = await import("../mcp/remote/store.js");
      const { hashPassword, passwordProblem } = await import("../mcp/remote/crypto.js");
      const store = new AuthStore();
      if (action === "list") {
        const users = store.users();
        if (!users.length) console.error(`no accounts (state: ${store.file})`);
        for (const u of users) console.log(`${u.username.padEnd(24)} two-factor ${u.totp ? "on " : "off"}  password changed ${new Date(u.passwordChangedAt * 1000).toISOString().slice(0, 16).replace("T", " ")}`);
        return 0;
      }
      if (typeof f.name !== "string") throw new Error(`arch user ${action ?? "<action>"} needs --name <n>`);
      const name = f.name;
      const existing = store.getUser(name);
      const askPassword = async (): Promise<string> => {
        if (f["password-stdin"]) {
          let s = "";
          for await (const chunk of process.stdin) s += chunk;
          return s.replace(/\r?\n$/, "");
        }
        if (!process.stdin.isTTY) throw new Error("no terminal to ask for the password: use --password-stdin (docker exec needs -it to ask)");
        const ask = (q: string) =>
          new Promise<string>((ok) => {
            process.stderr.write(q);
            let s = "";
            const stdin = process.stdin;
            stdin.setRawMode(true);
            stdin.resume();
            const on = (d: Buffer) => {
              for (const ch of d.toString("utf8")) {
                if (ch === "\r" || ch === "\n") {
                  stdin.setRawMode(false);
                  stdin.pause();
                  stdin.off("data", on);
                  process.stderr.write("\n");
                  return ok(s);
                }
                if (ch === "\u0003") process.exit(130);
                if (ch === "\u007f") s = s.slice(0, -1);
                else s += ch;
              }
            };
            stdin.on("data", on);
          });
        const a = await ask("Password: ");
        if (a !== (await ask("Repeat: "))) throw new Error("the passwords don't match");
        return a;
      };
      if (action === "add" || action === "passwd") {
        if (action === "add" && existing) throw new Error(`'${name}' exists; use 'arch user passwd --name ${name}'`);
        if (action === "passwd" && !existing) throw new Error(`no account '${name}' (arch user list)`);
        if (!/^[A-Za-z0-9._-]{1,40}$/.test(name)) throw new Error("username: letters, digits, '.', '_' or '-'");
        const pw = await askPassword();
        const problem = passwordProblem(pw, name);
        if (problem) throw new Error(`password: ${problem}`);
        store.putUser(existing?.username ?? name, await hashPassword(pw), { keepTotp: true });
        console.error(action === "add" ? `created '${name}'` : `password changed for '${name}'; its browser sessions are logged out`);
        return 0;
      }
      if (action === "reset-2fa") {
        if (!existing) throw new Error(`no account '${name}' (arch user list)`);
        store.updateUser(name, (u) => {
          delete u.totp;
          delete u.totpStep;
        });
        console.error(`two-factor login turned off for '${name}'`);
        return 0;
      }
      if (action === "delete") {
        if (!store.deleteUser(name)) throw new Error(`no account '${name}' (arch user list)`);
        console.error(`deleted '${name}'`);
        return 0;
      }
      throw new Error("usage: arch user <add|passwd|reset-2fa|delete|list> [--name n]");
    },
  },
  token: {
    usage: "arch token <create|list|revoke> [--name n] [--id grant]",
    desc: "Personal access tokens for the remote MCP server (clients configured with an Authorization header); also lists / revokes connected OAuth apps",
    flags: [
      { name: "name", arg: "n", desc: "create: a name to recognise the token by (e.g. lmstudio)" },
      { name: "id", arg: "grant", desc: "revoke: the id shown by 'arch token list'" },
    ],
    async run(action, f) {
      const { AuthStore } = await import("../mcp/remote/store.js");
      const store = new AuthStore();
      if (action === "create") {
        if (typeof f.name !== "string") throw new Error("arch token create needs --name <n>");
        const { token } = store.createPat(f.name);
        console.error(`created token '${f.name}' (state: ${store.file}); it is not shown again:`);
        console.log(token);
        return 0;
      }
      if (action === "list") {
        const when = (t?: number) => (t ? new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ") : "never");
        const grants = store.grants();
        if (!grants.length) console.error(`nothing connected (state: ${store.file})`);
        for (const g of grants) console.log(`${g.id}  ${(g.clientId === "pat" ? "token" : "oauth").padEnd(5)}  ${g.name.padEnd(28)}  created ${when(g.createdAt)}  last used ${when(g.lastUsed)}`);
        return 0;
      }
      if (action === "revoke") {
        if (typeof f.id !== "string") throw new Error("arch token revoke needs --id <grant> (see arch token list)");
        if (!store.revokeGrant(f.id)) throw new Error(`no grant '${f.id}' (see arch token list)`);
        console.error(`revoked ${f.id}`);
        return 0;
      }
      throw new Error("usage: arch token <create|list|revoke> [--name n] [--id grant]");
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
  assets: {
    usage: 'arch assets "<query>" [--kind material|model] [--source ambientcg|polyhaven|future3d] [--limit 15]',
    desc: "Search open CC0 libraries (ambientCG, Poly Haven) for scanned PBR materials or furniture models; use the ids as materials / furniture.model",
    file: true,
    flags: [
      { name: "kind", arg: "material|model", desc: "default material" },
      { name: "source", arg: "name", desc: "all (default), ambientcg, polyhaven, future3d" },
      { name: "limit", arg: "n", desc: "results (default 15)" },
    ],
    async run(query, f) {
      const { searchAssets } = await import("../assets/online.js");
      const kind = ((f.kind as string) ?? "material") as "material" | "model";
      const hits = await searchAssets(query, { kind, source: f.source as string | undefined, limit: f.limit ? num(f.limit, "limit") : 15 });
      for (const h of hits) console.log(`${h.id.padEnd(40)} ${h.name}${h.category ? ` [${h.category}]` : ""}${h.size ? `  tile ${h.size} m` : ""}  (${h.license})`);
      if (!hits.length) console.log(`no ${kind}s found for '${query}'`);
    },
  },
  product: {
    usage: "arch product <url> [--add plan.json [--level id] [--at x,y] [--facing dir] [--id id]] [--type t]",
    desc: "Read a vendor product page (IKEA, Homecentre, Amazon, Wayfair...): name, price, size, colour, 3D model; --add puts it in a plan's products (and places it with --at)",
    file: true,
    flags: [
      { name: "add", arg: "plan.json", desc: "add to this plan's products" },
      { name: "level", arg: "id", desc: "level to place on (default: first)" },
      { name: "at", arg: "x,y", desc: "place an instance here" },
      { name: "facing", arg: "dir", desc: "north | south | east | west" },
      { name: "id", arg: "id", desc: "product id (default: from the name)" },
      { name: "type", arg: "type", desc: "furniture type override" },
    ],
    async run(url, f) {
      const { fetchProduct, photoColor } = await import("../assets/vendors.js");
      const info = await fetchProduct(url);
      const color = !info.model && info.image ? await photoColor(info.image) : undefined;
      const cm = (v?: number) => (v === undefined ? "?" : `${Math.round(v * 100)} cm`);
      console.log(`${info.name}\n  vendor ${info.vendor ?? "?"}  sku ${info.sku ?? "?"}  price ${info.price ?? "?"} ${info.currency ?? ""}`);
      console.log(`  size ${cm(info.width)} × ${cm(info.depth)} × ${cm(info.height)} (W × D × H)  type ${f.type ?? info.type ?? "?"}`);
      console.log(`  3D model: ${info.model ?? "none published (a parametric stand-in will be used)"}${color ? `  colour ${color}` : ""}`);
      for (const w of info.warnings) console.log(`  note: ${w}`);
      if (!f.add) return;
      const file = f.add as string;
      const project = (await readJson(file)) as Record<string, unknown>;
      const products = ((project.products as Record<string, unknown>[] | undefined) ??= []);
      const { productId } = await import("../elements/products.js");
      const id = (f.id as string) ?? productId(info.name ?? "product", info.sku, products as never, url);
      const prod: Record<string, unknown> = { id, name: info.name, vendor: info.vendor, url, sku: info.sku, price: info.price, currency: info.currency, type: (f.type as string) ?? info.type ?? "box", model: info.model, width: info.width, depth: info.depth, height: info.height, color, image: info.image, ...(info.model && info.vendor === "IKEA" ? { license: "vendor" } : {}) };
      for (const k of Object.keys(prod)) if (prod[k] === undefined) delete prod[k];
      const i = products.findIndex((p) => p.id === id);
      if (i >= 0) products[i] = prod;
      else products.push(prod);
      if (f.at) {
        const [x, y] = String(f.at).split(",").map(Number);
        const levels = project.levels as Record<string, unknown>[];
        const lv = f.level ? levels.find((l) => l.id === f.level) : levels[0];
        if (!lv) throw new Error(`level '${f.level}' not found`);
        const furn = ((lv.furniture as Record<string, unknown>[] | undefined) ??= []);
        furn.push({ id: `${id}_${furn.filter((g) => g.product === id).length + 1}`, product: id, position: [x, y], ...(f.facing ? { facing: f.facing } : {}) });
      }
      await write(file, JSON.stringify(project, null, 2) + "\n");
    },
  },
  bom: {
    usage: "arch bom <plan.json> [--csv]",
    desc: "Shopping list of the placed products: quantities, prices and totals per vendor, with links",
    file: true,
    flags: [{ name: "csv", desc: "CSV instead of text" }],
    async run(file, f) {
      const { shoppingList } = await import("../elements/products.js");
      const { lines, totals } = shoppingList((await readJson(file)) as never);
      if (f.csv) {
        const q = (v: unknown) => (v === undefined ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
        console.log("product,name,vendor,sku,quantity,unit_price,currency,total,url");
        for (const l of lines) console.log([l.product, l.name, l.vendor, l.sku, l.quantity, l.unitPrice, l.currency, l.total, l.url].map(q).join(","));
        return;
      }
      if (!lines.length) return void console.log("no products placed");
      for (const l of lines) console.log(`${String(l.quantity).padStart(3)}× ${l.name} — ${l.vendor}${l.sku ? ` ${l.sku}` : ""}${l.unitPrice !== undefined ? `  ${l.unitPrice} ${l.currency ?? ""} → ${l.total} ${l.currency ?? ""}` : ""}`);
      console.log("");
      for (const t of totals) console.log(`${t.vendor}: ${t.items} item(s), ${t.total} ${t.currency}`);
    },
  },
  hvac: {
    usage: "arch hvac <plan.json> [--brief]",
    desc: "Air conditioning: cooling loads per room, units (packaged rooftop by default), coordination issues; the drawing is `arch plan --sheet hvac`",
    file: true,
    flags: [{ name: "brief", desc: "units and issues only, no room table" }],
    async run(file, f) {
      const c = await compiled(file);
      const { hvacReport } = await import("../elements/hvac-report.js");
      if (!c.hvac) throw new Error("no HVAC design (see the warnings)");
      console.log(hvacReport(c.hvac, c.levels.map((l) => l.name), !f.brief));
    },
  },
  water: {
    usage: "arch water <plan.json> [--brief]",
    desc: "Water hydraulics: pipe sizes, pressure and hot-water wait at every outlet, booster and tanks, summer cold-water temperature, drainage stacks",
    file: true,
    flags: [{ name: "brief", desc: "no pipe sizing table" }],
    async run(file, f) {
      const c = await compiled(file);
      const { waterReport } = await import("../elements/water.js");
      if (!c.water) throw new Error("no water design: the plan has no wet rooms");
      console.log(waterReport(c.water, c.levels.map((l) => l.name), !f.brief));
    },
  },
  landscape: {
    usage: "arch landscape <plan.json>",
    desc: "Gardens and irrigation: areas, plants, spray / drip / bubbler zones, controller and summer water use; the drawing is `arch plan --sheet landscape`",
    file: true,
    flags: [],
    async run(file) {
      const c = await compiled(file);
      const { landscapeReport } = await import("../elements/landscape.js");
      if (!c.landscape) throw new Error("no landscape design (see the warnings)");
      console.log(landscapeReport(c.landscape, c.levels.map((l) => l.name)));
    },
  },
  contract: {
    usage: "arch contract <plan.json> --package <id> [--labour|--supply] [-o base] [--contractor name] [--start YYYY-MM-DD] [--days n]",
    desc: "Bilingual works contract (English, then Arabic) for a trade package, as .docx and print-ready .html: main, structure, blockwork, plaster, waterproofing, tiling, painting, ceilings, doors_windows, electrical, plumbing, hvac, lifts, landscape, joinery, external",
    file: true,
    flags: [
      { name: "package", arg: "id", desc: "trade package (see above)" },
      { name: "labour", desc: "labour only (مصنعية فقط): the owner supplies the materials" },
      { name: "supply", desc: "supply and installation" },
      { name: "o", arg: "base", desc: "output path without extension (default contracts/<plan>-<package>-<mode> next to the plan)" },
      { name: "contractor", arg: "name", desc: "contractor's company name (other details: project.contract or the MCP tool)" },
      { name: "start", arg: "date", desc: "start of works, YYYY-MM-DD" },
      { name: "days", arg: "n", desc: "programme in calendar days" },
      { name: "format", arg: "docx|html|both", desc: "default both" },
    ],
    async run(file, f) {
      const { PACKAGE_IDS, packageById } = await import("../contracts/packages.js");
      if (typeof f.package !== "string") throw new Error(`--package is required (${PACKAGE_IDS.join(", ")})`);
      if (f.labour && f.supply) throw new Error("--labour or --supply, not both");
      const pkg = packageById(f.package);
      const mode = f.labour ? "labour" : f.supply ? "supply" : pkg.modes[0];
      const c = await compiled(file);
      const { buildContract, contractDocument } = await import("../contracts/contract.js");
      const { contractDocx, contractHtml } = await import("../contracts/render.js");
      const k = buildContract(c, {
        package: pkg.id,
        mode,
        contractor: typeof f.contractor === "string" ? { company: f.contractor } : undefined,
        startDate: typeof f.start === "string" ? f.start : undefined,
        durationDays: f.days ? num(f.days, "days") : undefined,
      });
      const doc = contractDocument(k);
      const outBase = typeof f.o === "string" ? f.o.replace(/\.(docx|html)$/i, "") : `${dirname(file)}/contracts/${base(file).split("/").pop()}-${pkg.id}-${mode}`;
      const fmt = typeof f.format === "string" ? f.format : "both";
      if (!["docx", "html", "both"].includes(fmt)) throw new Error("--format must be docx, html or both");
      if (fmt !== "html") await write(`${outBase}.docx`, await contractDocx(doc));
      if (fmt !== "docx") await write(`${outBase}.html`, contractHtml(doc));
      console.log(`${k.id}: ${k.value.toFixed(3)} ${k.currency}, ${k.items.length} items, ${k.durationDays} days, ${k.payments.length} payments`);
      for (const n of k.notes) console.error(`note: ${n}`);
    },
  },
  estimate: {
    usage: "arch estimate <plan.json> [--scope fitout|full] [-o bill.html|bill.md|bill.csv|bill.json] [--summary]",
    desc: "Cost estimate / bill of quantities measured from the model: finishes, ceilings, doors & windows, joinery (IKEA METOD at real prices), electrical, plumbing, furniture, totals; --scope full adds the structure (foundations, RC concrete, rebar, formwork, blockwork, plaster, roof)",
    file: true,
    flags: [OUT, { name: "summary", desc: "print the section totals only" }, { name: "scope", arg: "s", desc: "fitout (interior only) | full (with structure and shell); default project.costs.scope" }],
    async run(file, f) {
      if (f.scope !== undefined && f.scope !== "fitout" && f.scope !== "full") throw new Error(`--scope must be fitout or full (got '${f.scope}')`);
      const c = await compiled(file);
      const { estimate } = await import("../cost/estimate.js");
      const fmt = await import("../cost/format.js");
      const bill = estimate(c, { scope: f.scope as "fitout" | "full" | undefined });
      const out = f.o as string | undefined;
      if (out) {
        const ext = extname(out).toLowerCase();
        await write(out, ext === ".html" ? fmt.billHtml(bill) : ext === ".csv" ? fmt.billCsv(bill) : ext === ".json" ? JSON.stringify(bill, null, 1) : fmt.billMarkdown(bill));
      }
      console.log(fmt.billMarkdown(bill, { lines: !f.summary && !out }));
    },
  },
  fetch: {
    usage: "arch fetch <plan.json>",
    desc: "Download / import every online material and model the plan uses into the cache (then it builds offline)",
    file: true,
    flags: [],
    async run(file) {
      const c = await loadAndCompile(file);
      report(c);
      for (const s of c.credits) console.log(`${s.missing ? "MISSING " : ""}${s.id}  ${s.title ?? ""}  (${s.license}${s.author ? `, ${s.author}` : ""})`);
      console.log(`${c.credits.length} external asset(s); cache: ${(await import("../assets/cache.js")).cacheRoot()}`);
      return c.credits.some((s) => s.missing) ? 1 : 0;
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
  for (const n of c.notes ?? []) console.error(`note: ${n}`);
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
