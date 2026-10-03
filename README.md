# Architecturer

AI-first 3D architecture modeler. An AI model (or you) writes a **JSON building plan** with walls, doors, windows, rooms, stairs, roofs and furniture. Architecturer turns it into a **textured, game-ready glTF/GLB model**.

- **Declarative plan format** with field-level descriptions and readable validation errors (`levels[0].openings[3]: point [2,3] is 1.40 m from the nearest wall…`).
- **Layout validator** that catches the mistakes AI authors actually make, and says how to fix them:
  - furniture inside walls, door swings, doorways or in front of windows; furniture facing a wall; overlapping furniture
  - rooms with no door, or unreachable from the entrance
  - stairs through walls, arriving into walls or onto nothing, or with an open side and no railing
  - doors that open onto a drop
  - Example: `furniture 'toilet_19' at [4.45, 9.6] overlaps wall 'ext' by 0.1 m — move it 0.1 m south (to [4.45, 9.5])`
- **Geometry kernel**:
  - Walls are mitered at corners; T-junctions and crossings are joined automatically.
  - Doors and windows are cut into walls, with frames, sills and glass. Door leaves are separate nodes that pivot at the hinge.
  - Floors are auto-generated slabs, and stairs cut their own stairwells.
  - Stairs: straight, L, U and spiral.
  - Roofs: gable, hip, shed and flat with parapet.
  - Rooms get floor finishes and ceilings.
  - Terraces, balconies and patios are a single element: a slab, with railings or a parapet added automatically on the edges that aren't against the building.
  - 63 parametric furniture types, including cars and outdoor/garden items.
  - Free-form shapes for landmarks: revolved profiles (towers, domes, spheres with rings), with material bands, openings, hollow walk-in shells and geodesic glazing frames. Elevators link floors.
- **Procedural PBR textures**, 100 tileable materials: base color, normal and occlusion/roughness/metal maps, with MikkTSpace tangents. Exported files pass the Khronos glTF validator with no errors or warnings.
- **AI feedback loop**: headless PNG renders (3D views, cutaways, 2D plans with a coordinate grid and element ids). An agent can look at its own result and fix it.
- **Interfaces**: an MCP server (for Claude and other MCP clients), a CLI, and a live-reloading three.js viewer.

## Quick start

```bash
npm install          # also builds dist/
npx tsx src/cli/main.ts serve examples/house.json     # open http://localhost:5177
```

```bash
npx tsx src/cli/main.ts build examples/house.json -o out/house.glb --texture-size 1024
```

## CLI

| Command | What it does |
|---|---|
| `arch guide` | Authoring guide for AI agents: conventions, plus the material and furniture lists |
| `arch init plan.json` | Starter plan |
| `arch validate plan.json [--strict]` | Errors, layout warnings, stats (`--strict` fails on warnings) |
| `arch plan plan.json --level ground [--sheet lighting\|finishes\|rcp\|false_ceiling\|electrical\|plumbing] -o plan.png` | 2D floor plan (`.svg` or `.png`). `--sheet lighting`: fixture symbols, estimated lux per room and a fixture legend. `--sheet finishes`: floors drawn in their material pattern, wall finish and accent bands, and a per-room finish schedule. `--sheet rcp`: reflected ceiling plan. `--sheet false_ceiling`: false ceiling plan with every ceiling level tagged above FFL. `--sheet electrical` / `plumbing`: services layouts |
| `arch render plan.json --view iso [--level ground] [--focus x,y --radius 3] [--zoom 2] -o view.png` | Headless 3D render. `--level` cuts away everything above that level (`--cut` sets the height); `--focus` frames a close-up |
| `arch build plan.json -o model.glb [--unity\|--godot] [--texture-format jpeg\|png\|ktx2]` | Export; `.gltf` writes separate image files |
| `arch assets "oak herringbone" [--kind model]` | Search CC0 scanned materials / models (ambientCG, Poly Haven) |
| `arch product <url> --add plan.json --at x,y` | Import a vendor product (IKEA, Wayfair...) with its 3D model, price and size |
| `arch bom plan.json [--csv]` | Shopping list of placed products |
| `arch estimate plan.json -o bill.html` | Cost estimate / bill of quantities measured from the model (also `.md`, `.csv`, `.json`) |
| `arch fetch plan.json` | Download all online assets into the cache (then builds work offline) |
| `arch mcp [--http]` | MCP server over stdio, or `--http` for the remote server ([docs/REMOTE_MCP.md](docs/REMOTE_MCP.md)) |
| `arch token create --name n` / `list` / `revoke --id g` | Personal tokens and connected apps of the remote server |
| `arch serve plan.json` | Live viewer that reloads whenever the file is saved, with a first-person **walk mode** and 2D plan, lighting and finishes sheets (pan/zoom, per level, SVG download) |
| `arch schema` / `materials` / `furniture` | Reference |

Every command has `--help`, and unknown options are errors. During development, `arch` is `npx tsx src/cli/main.ts`. After `npm run build` it is `node bin/arch.js`.

## MCP server (for AI agents)

`.mcp.json` registers the server for Claude Code in this folder. For other clients:

```json
{ "mcpServers": { "architecturer": { "command": "node", "args": ["/abs/path/to/Architecturer/dist/mcp/server.js"] } } }
```

Claude Desktop: add the server to `~/Library/Application Support/Claude/claude_desktop_config.json`, then quit and reopen the app. Use the absolute Node path, because Desktop doesn't use your shell's PATH:

```json
{ "mcpServers": { "architecturer": {
  "command": "/usr/local/bin/node",
  "args": ["/abs/path/to/Architecturer/dist/mcp/server.js"],
  "env": { "ARCHITECTURER_WORKDIR": "/Users/you/Architecturer" }
} } }
```

Relative plan paths resolve against `ARCHITECTURER_WORKDIR`. Without it they resolve against the server's working directory, or `~/Architecturer` when the server is started from `/`, as Claude Desktop does.

| Tool | Purpose |
|---|---|
| `get_guide`, `get_schema`, `list_materials`, `list_furniture` | Learn the format (`get_guide` takes a `section` for a shorter read) |
| `list_projects`, `create_project`, `read_project`, `write_project`, `add_level` | Whole-plan operations |
| `add_elements`, `update_element`, `remove_elements` | Incremental edits by id. Every edit returns validation results. |
| `validate` | Errors and warnings |
| `render_plan`, `render_view` | Return PNG images so the model can see its work |
| `search_assets`, `search_products`, `import_product`, `shopping_list`, `cost_estimate` | Scanned CC0 materials / models, IKEA catalogue search, vendor product import with 3D models, bill of materials, cost estimate |
| `export_model` | `.glb` / `.gltf` for game engines (`export_status` on the remote server) |

### Remote MCP server

`arch mcp --http` (or the Docker image) serves the same tools over HTTP so that Claude on the web, desktop and mobile, ChatGPT, LM Studio and Claude Code can use one shared server from anywhere:
- OAuth login, or personal tokens for header-configured clients.
- Projects addressed by name.
- Download links for exports and renders.
- Background exports.
- A live 3D viewer for every project.
- Render work in worker threads.

`compose.yaml` runs it behind a Cloudflare Tunnel. For setup, Unraid notes, client configuration and the security model, see [docs/REMOTE_MCP.md](docs/REMOTE_MCP.md).

## Plan format in 30 seconds

Units are meters. Plan x points east and y points north. Angles are measured counter-clockwise from east. See `examples/house.json`, or run `arch guide`.

Examples:
- `examples/house.json`: two-storey family house with a garden
- `examples/villa.json`: L-shaped villa, designed by an AI agent using only the docs
- `examples/kuwait_towers.json`: the Kuwait Towers, with the restaurant and observation-sphere interiors, rebuilt from photos (generated by `scripts/kuwait-towers.mts`)
- `examples/showcase.json`: every roof, stair, door and window style
- `examples/showcase_apartment.json`: a fully designed interior (cabinetry, finishes, lighting, decor, style), furnished with 28 real IKEA Kuwait products (25 with IKEA's own 3D models) and an IKEA METOD kitchen in VOXTORP oak effect. `arch estimate` gives the full bill. The first build downloads the models, which are cached after that
- `examples/kitchen_showcase.json`, `examples/finishes_showcase.json`, `examples/lighting_showcase.json`: feature showcases

```json
{
  "name": "Cabin",
  "defaults": { "exteriorWallThickness": 0.25, "exteriorMaterial": "siding_white" },
  "levels": [{
    "id": "ground", "height": 2.8,
    "walls": [{ "id": "ext", "points": [[0,0],[6,0],[6,4],[0,4]], "closed": true }],
    "openings": [{ "type": "door", "at": [1.5, 0] }, { "type": "window", "at": [4, 0], "width": 1.4 }],
    "rooms": [{ "name": "Main room", "polygon": [[0,0],[6,0],[6,4],[0,4]], "floorMaterial": "wood_floor_oak" }],
    "furniture": [{ "type": "bed", "position": [4.6, 2.9], "facing": "west", "width": 1.4 }],
    "roofs": [{ "type": "gable", "polygon": [[0,0],[6,0],[6,4],[0,4]], "pitch": 30 }]
  }]
}
```

## Interior design suite

- **Cabinetry** (`level.casework`): parametric kitchens, wardrobes, vanities, media walls, shelving, desks and bench seats.
  - **Kitchens:** straight, L, U and island layouts, with tall units, appliances (integrated or freestanding), sinks, hobs and hoods.
  - **Uppers:** wall cabinets skip over windows and tall units, and align over the hob or sink.
  - **Finish options:** door styles (slab, shaker, glass, fluted, louvered, mirror), handles (bar, knob, edge, gola, push), worktops with waterfalls and seating overhangs, backsplashes and LED strips.
  - **Wardrobes:** interiors with rails, shelves, drawers and shoes, behind hinged or sliding doors.
  - **Moving parts:** every door and drawer is a movable node with its true hinge axis or slide direction.
- **Finishes** (`room.finishes`):
  - **Walls:** paint or wallpaper per room (only on that room's side of shared walls), feature walls, and tiling to a height or full height.
  - **Trims:** skirting, dado and picture rails, cornices, and panelled wainscot.
  - **Ceilings and floors:** tray ceilings with an LED cove, coffered and beamed ceilings, floor borders and thresholds.
  - **38 new materials,** including herringbone, chevron, terrazzo, zellige, hex tiles, wallpapers, slats, microcement and grasscloth.
- **Lighting** (`level.lights`):
  - **Fixtures:** pendants, chandeliers, downlight grids, spots and tracks, sconces, LED strips and uplights.
  - **Real lights:** physically based units, exported as glTF lights (KHR_lights_punctual). Lamps light up automatically.
  - **Night renders:** `--lighting night`, plus Day/Night in the viewer.
  - **Window treatments:** curtains, sheers, Roman and roller blinds, venetians and shutters.
- **117 furniture and decor types,** including wall art, gallery walls, plants, mirrors, vases, cushions, throws, lounge chairs, sideboards, beds, bathroom and kitchen accessories.
- **Style presets** (`project.style`, `room.style`): scandinavian, japandi, modern_minimal, industrial, mid_century, classic, coastal, luxury, boho and farmhouse. A style fills every unset material by role (floors, walls, wood, upholstery, metal, stone, cabinetry...). Explicit choices always win.
- **Materials, products and models** ([docs/ASSET_SOURCES.md](docs/ASSET_SOURCES.md)):
  - **About 330 procedural materials and all 217 RAL Classic colours** built in, covering wood species, parquet, natural stones, terrazzo, zellige, designer paints, metals, velvets, linens and leathers.
  - **Thousands of scanned CC0 materials and models** from ambientCG and Poly Haven, used by id (`ambientcg:WoodFloor051`, `polyhaven:ArmChair_01`). Find them with `arch assets "travertine"` or MCP `search_assets`.
  - **Real products from vendor pages:** `import_product` / `arch product <url>` reads IKEA, Wayfair, West Elm and other pages for name, price, size, colour and the vendor's 3D model (IKEA publishes GLBs, including Draco-compressed ones). Pages that cannot be read (Homecentre, Amazon) still work with fields the AI passes in, using a sized and tinted parametric stand-in. `arch bom` / `shopping_list` gives the bill of materials.
  - **Your own files:** `.glb` / `.gltf` / `.obj` models, and 3D-FUTURE (Alibaba) furniture. FBX and similar convert via `scripts/convert_to_glb.py`. Builds write `<model>.credits.md` with every asset's licence.
- **Cost estimate** (`arch estimate`, MCP `cost_estimate`): a bill of quantities measured from the model.
  - **Measured:** partitions, floor, wall and ceiling finishes by material, doors, windows and treatments, joinery, electrical points and fixtures, plumbing fixtures and pipe runs, furniture.
  - **Priced:** vendor items (for example IKEA METOD kitchens) at their real prices; everything else at researched Kuwait market rates (about 150 rates, each with its source URL, quote, read date and confidence; see [docs/COST_RATES.md](docs/COST_RATES.md)), with built-in indicative rates as the fallback. Every rate can be overridden in `project.costs.rates`, and each bill line says which kind of rate it used.
  - **Totals:** preliminaries, overhead and profit, contingency, fees and VAT. The bill is written as printable HTML, Markdown, CSV or JSON.
- **IKEA METOD kitchens:** set casework `system: "ikea_metod"` for METOD sizes and checks. Each module links to the real METOD/MAXIMERA product, and run `products` covers worktops, sink, tap, appliances and fittings.
- **Electrical and plumbing** (`level.electrical`, `level.plumbing`, `level.services`):
  - **Generated from the design:** switches at door latch sides, wired to the light groups (2-way at further doors and double-bed bedsides), sockets for beds, desks, TV walls, sofas and lamps, worktop sockets clear of the sink and hob, appliance spurs, a cooker unit, shaver sockets, extract fans, smoke and heat detectors, the distribution board, a doorbell and a circuit schedule.
  - **Plumbing:** fixtures from furniture and casework get cold and hot supplies and waste or soil drains run along the walls to a stack in the room corner, plus floor drains, a water heater per wet room and the main stop valve.
  - **Refine it:** add points (AC units, extra sockets, switches with `controls`), place your own stacks and heaters, or drop auto points with `services.omit`. Switch and socket plates, detectors and the DB are modelled in 3D.
- **Design review:**
  - `arch plan --sheet lighting|finishes|rcp|false_ceiling|electrical|plumbing` (MCP `render_plan` `sheet`) draws lighting, finishes, reflected ceiling, false ceiling, electrical and plumbing plans. Light symbols also appear on the normal plan.
  - `arch render --room Kitchen` gives an eye-level shot from a clear corner. `--elevation <wall> --elevation-room <room>` gives a square-on wall elevation.
  - The validator checks clearances, aisles, hob-under-window, cabinets over windows, pendant heights and unlit rooms.
- **Showcase:** `examples/showcase_apartment.json`, a Japandi apartment that uses all of the above, furnished with real IKEA products: KIVIK, SKANSNÄS, IDANÄS, BOASTAD, RIDSPÖ and others.

## Plans in the viewer

The **Plans** section of the viewer panel opens the 2D sheets: **2D plan**, **💡 Lighting**, **🎨 Finishes**, **Reflected ceiling**, **False ceiling**, **⚡ Electrical** and **🚿 Plumbing**.

- Switch sheets with the tabs or the keys 1 to 7, and pick the level from the dropdown.
- Drag to pan; zoom with the wheel, a double-click, + / − or Fit (0).
- **SVG** downloads the sheet. The open sheet refreshes whenever the plan file is saved.

## Walk mode

In the viewer, click **🚶 Walk**, or double-click any floor, to explore the design in first person.

- **Move:** W A S D, mouse to look (or drag when the browser can't capture the mouse), Shift to run, Space to jump.
- **Doors:** E opens or closes the nearest one; walking into a closed door also opens it. Doors swing on their hinges, and sliding and garage doors slide or lift.
- **Floors:** `[` and `]` change floor, taking the lift stops when the plan has elevators. F toggles fly mode. X exits.
- **Physics:** you stay on floors under gravity, walk up stairs step by step, and walls, glass, railings and furniture block you. Collision uses a BVH, so large models stay smooth: the Kuwait Towers' 194k triangles take 0.04 ms per frame.
- **Display:** the current room and floor are shown at the top.

## Using the models in a game engine

```bash
arch build plan.json -o MyUnityProject/Assets/Models/house.glb --unity   # or --godot
```

`--unity` / `--godot` turn on:
- **Merged meshes**: one static mesh per level, with a sub-mesh per material. Furniture and door leaves stay separate so they can move.
- **Collision nodes**: `<Level>-colonly` is static. Walls, floors and roofs keep their own geometry, stairs become smooth ramps, and railings become thin walls. `<item>-convcolonly` is a box on each movable item.
- **Godot** turns these suffixes into physics bodies on import.
- **Unity** needs the bundled package in [`unity/com.architecturer.tools`](unity/com.architecturer.tools/README.md). It is tested with Unity 6 + glTFast 6.20: colliders are set up when you drop the model into a scene, and `--unity` orients the model so plan `(x, y)` = Unity `(x, z)`.

### Texture formats

| `--texture-format` | House example | Notes |
|---|---|---|
| `jpeg` (default) | 13.4 MB | JPEG color/ORM, PNG normal maps; works everywhere |
| `png` | 21.0 MB | lossless |
| `ktx2` | **5.4 MB** | Basis Universal (`KHR_texture_basisu`, required) with mipmaps; stays compressed in GPU memory (BC7/ASTC/ETC2 after transcoding). Unity: installed by the Architecturer package (KTX for Unity). Add `--ktx2-quality high` for sharper UASTC normal maps (larger, slower) |

KTX2 encoding is cached in `~/.cache/architecturer/ktx2` (override with `ARCHITECTURER_CACHE`). A cold build of the house takes ~16 s; later builds take ~3 s. Preview a KTX2 build in the viewer with `http://localhost:5177/?format=ktx2`.

Without these flags:

- glTF 2.0 is Y-up and in meters. Plan (x, y, z) maps to glTF (x, z, −y).
- The node hierarchy is `Building › Level › walls | openings | slabs | rooms | stairs | furniture | structure | roofs`. Each node's `extras` carries `kind`, `id`, room names and areas, door motion data, and similar metadata.
- Furniture and door leaves have their pivot at their placement point or hinge, so they can be moved or animated.
- Materials are standard metallic-roughness PBR with base color, normal and ORM textures. Glass uses alpha blending.
- Unity: use glTFast. Unreal: Interchange glTF import. Godot: import directly. Blender: File › Import › glTF.

## Layout

```
src/schema      plan schema (zod) and JSON Schema
src/elements    walls, openings, stairs, roofs, slabs, furniture
src/geometry    math and MeshBuilder (primitives, world-scaled UVs)
src/materials   material library and procedural texture generator
src/export      glTF/GLB writer
src/render      software rasterizer (3D) and SVG floor plans
src/cli, src/mcp, src/server   interfaces (src/mcp/http.ts + src/mcp/remote: remote server, OAuth)
viewer/         three.js viewer
```

`npm test` runs the build and MCP end-to-end tests.
