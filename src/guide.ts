import { listFurniture } from "./elements/furniture.js";
import { listMaterials } from "./materials/library.js";

/** Concise authoring guide for AI agents. Kept short on purpose: it is read on every session. */
export const GUIDE = `# Architecturer plan format — quick guide

Interfaces: MCP tools (get_schema, create_project/write_project, validate, render_plan, render_view, export_model)
or the CLI (arch schema, arch validate, arch plan, arch render, arch build; arch <cmd> --help). Same features.

A building is one JSON document: { name, defaults, materials, site, levels: [...] }.
Each level holds: walls, openings, rooms, slabs, stairs, furniture, columns, railings, roofs.
Call get_schema for every field; this guide covers conventions and good practice.

## Coordinates
- Meters. Plan x = EAST, plan y = NORTH, heights are up. Use a 2D plan grid (e.g. building spans 0..12 x 0..10).
- Angles in degrees counter-clockwise from east: 0=east, 90=north, 180=west, 270=south. Compass words also accepted where noted.
- Level elevation defaults to stacking: previous elevation + previous height. Level height (default 3) is floor-to-floor and the default wall height.

## Walls
- A wall is a polyline of CENTERLINE points: {"id":"ext","points":[[0,0],[12,0],[12,10],[0,10]],"closed":true}.
- Exterior loop: closed:true; it gets exteriorMaterial outside and interiorMaterial inside, and (autoSlab) a floor slab.
- Interior walls: separate polylines whose endpoints touch other walls ([4,0]->[4,10] touching the exterior loop). Corners, T-junctions and crossings are joined automatically; endpoints within half a wall thickness of another wall snap onto it.
- Typical thickness: exterior 0.25-0.35, interior 0.1-0.15 (set defaults.exteriorWallThickness / wallThickness once).
- Give every wall an id so openings and edits can reference it.

## Openings (doors / windows / empty openings)
- Easiest placement: "at": a point on the wall centerline at the CENTER of the opening, e.g. {"type":"door","at":[6,0]}.
- Alternative: {"wall":"ext","offset":7.5} = distance along that wall's polyline.
- Defaults: door 0.9x2.1, window 1.2x1.2 with sill 0.9. Keep openings >= 0.1 m from wall corners/junctions (they get nudged otherwise) and don't overlap them.
- Door styles: single, double, glass, sliding, garage. Window styles: casement, fixed, grid. Doors take hinge (left/right along wall direction), swing (in/out), openAngle.
- Every room needs a way in: a door or an "opening" in one of its walls.

## Rooms
- {"name":"Kitchen","polygon":[...],"floorMaterial":"tiles_white"} — use wall centerlines as the outline. Produces the floor finish and the ceiling (visible from below only) and names the space in the exported model.

## Interior finishes (room.finishes)
- Per room, applied only to that room's side of shared walls: {"finishes": {
    "walls": "wallpaper_stripes_sage",                     // every wall face in the room (paint, wallpaper, full-height tiles)
    "accents": [{"side": "north", "material": "wallpaper_damask_gold"},   // feature wall by compass side or {"wall": "<id>"}
                {"wall": "w_kit", "material": "tiles_zellige_white", "from": 0.9, "to": 1.5}],  // height band = backsplash
    "wainscot": {"height": 0.9, "material": "paint_green", "style": "panels", "cap": {"size": 0.05}},  // tiles to 1.2: {"height":1.2,"material":"tiles_subway"}
    "skirting": {"height": 0.12, "profile": "ogee"},          // square | bevel | ogee | bullnose; stops at doors, mitred
    "cornice": {"profile": "cove"},                           // cove | ogee | step | square
    "pictureRail": {"height": 2.2, "frieze": "paint_white"}, "dadoRail": {"height": 0.9},
    "ceiling": {"type": "tray", "drop": 0.25, "inset": 0.6},  // flat | tray (LED cove) | coffered {spacing, beamWidth} | beams {spacing, direction}
    "floorBorder": {"width": 0.2, "material": "marble_black"}, "threshold": "marble_white"}}
- Heights are above the finished floor. Window reveals follow the wall finish (a tiled bathroom gets tiled reveals).
- Full-height tiling = "walls"; a wainscot as tall as the ceiling is a warning. Tray/coffered/beam ceilings keep >= 2.0 m headroom.
- Finish materials: wood_herringbone_*, wood_chevron_*, wood_parquet_oak, terrazzo_*, tiles_hex_*, tiles_penny_white,
  tiles_mosaic_*, tiles_zellige_*, wallpaper_* (stripes, damask, artdeco, botanical, trellis), slats_oak/walnut, fluted_white,
  reeded_oak, beadboard_white, microcement_*, tadelakt_terracotta, grasscloth_*, linen_wallcovering.
  Custom: {"base": "wallpaper", "params": {"style": "damask", "base": "#203040", "ink": "#c9a85c", "metallic": 0.6}}.
- Example: examples/finishes_showcase.json. Review with render_view eye-level shots (eye at z 1.6 inside the room, fov 70).

## Stairs
- Stairs go UP from the level they're on to the next level (rise defaults to level height) and cut a stairwell into the slab above automatically.
- start = center of the front edge of the first step; direction = walking direction. Length of a straight flight ≈ (rise/0.175 - 1) * tread (≈ 4.5 m for 3 m). Use "U" (≈ 3 m long, 2.1 m wide) or "L" in tight halls; "spiral" uses start as the center and width as radius.
- On the upper level, put railings around the open sides of the stairwell and make sure the top of the stair arrives in a corridor, not against a wall.

## Furniture
- {"type":"bed","position":[3,4],"facing":"south"} — position is the footprint center; facing is where the FRONT points (where you sit/open). rotation (deg) is the alternative; rotation 0 = facing south.
- Leave >= 0.6 m clear in front of furniture, keep it out of door swings, and place against walls by offsetting half the depth from the wall's inner face (wall centerline ± thickness/2).
- width is the object's left-right size when you face it, depth front-back. elevation lifts it (upper cabinets, wall TVs).

## Casework: kitchens, wardrobes, vanities, built-ins (level.casework)
- Use casework (not kitchen_counter/wardrobe furniture) for fitted cabinetry. A run = modules in a row along a wall:
  {"id":"kitchen","type":"kitchen","wall":"ext","from":21.2,"to":26.0,"doorStyle":"shaker","materials":{"front":"lacquer_sage","worktop":"quartz_white","backsplash":"tiles_subway"},
   "modules":[{"kind":"fridge"},{"kind":"base_drawers"},{"id":"sink","kind":"sink","width":0.9},{"kind":"dishwasher"},{"id":"hob","kind":"hob"},{"kind":"base_doors","width":"auto"}],
   "uppers":[{"kind":"upper_doors","width":"auto"},{"kind":"gap","over":"sink","width":1.3},{"kind":"hood","over":"hob"},{"kind":"upper_glass","width":"auto"}]}
- Placement: wall + from/to (distances along the wall CENTERLINE, like opening offsets; snaps to the inner face; a range across a wall
  corner gives an L), or path = the BACK edge (wall face = centerline ± thickness/2; L/U paths get corner units), or position + facing
  for islands (position = cabinet footprint centre; island:{seating:0.3, waterfall:"both"}).
- Modules are listed LEFT to RIGHT as you stand facing the fronts. For L/U runs put {"kind":"corner"} between each leg's modules.
  Widths default to 0.6 (sink/hob 0.8, wardrobe 1.0); "auto" modules share the rest. Tall units (fridge, tall_oven, pantry,
  wardrobe, tall_open) go in modules; uppers skip over them automatically. Leave {"kind":"gap"} in uppers in front of windows.
- type sets heights: kitchen 0.9 worktop / uppers to 2.2; vanity wall-hung 0.85; wardrobe 2.3 (toCeiling:true to the ceiling,
  slidingDoors:true); media low floating units; desk 0.75; bench 0.45 with cushions. doorStyle slab|shaker|glass|fluted|louvered|mirror,
  handle bar|knob|edge|gola|push. Kitchen clearance: >= 1.0 m in front (1.2 m to an island); keep the hob away from windows.
- Every door/drawer is an openable door_leaf node (hinged/slide with pivot, axis, slideAxis); module open:true poses it open for renders.

## Terraces, balconies, decks, patios
- One element does it all: {"id":"balcony","polygon":[[1,-1.5],[5.5,-1.5],[5.5,0],[1,0]],"railingStyle":"glass"} on the level it opens from.
- Edges along this level's walls are detected as attached to the building and get no railing; the free edges get a
  railing automatically when the floor is > 0.5 m above the ground (edge "auto"; or "railing" | "parapet" | "none").
- Ground-level patios/decks: put them on the ground level (no railing is added). Use openEdges:[i] to leave edge i
  (point i -> i+1) open for steps; supports:true adds columns under free corners.
- Add a door from the room onto it; terraces count as floor for the validator (furniture, doors, reachability).

## Outdoor
- Cars, garden furniture, trees, hedges and fences are furniture types placed outside the walls on the ground level
  (see the furniture list). Driveways/paths: slabs with a thin thickness on the ground level, e.g. material "asphalt".

## Landmarks and free-form shapes (towers, domes, spheres)
- level.shapes: "revolve" (a [radius, height] profile spun around a vertical axis, listed bottom to top; start and end
  at radius 0 for a closed solid), "sphere", "cylinder" (radiusTop 0 = cone), "box". Example shaft:
  {"type":"revolve","position":[0,0],"material":"plaster_white","profile":[[0,0],[9,0],[6,5],[4.6,60],[0.1,187],[0,187]]}
- bands: [{from, to, material}] re-skin a height range (window strips); material "none" leaves an opening (where a
  ring/balcony revolve attaches); frame:{columns, rows, diagonals} adds mullions / a geodesic lattice.
- hollow:{thickness, innerMaterial} makes a shell you can stand inside: put floors in it as levels with explicit
  elevation, slabs (circle polygons) and rooms with ceilingMaterial:false (the shell is the ceiling).
- Texture seams around shapes vanish when 2*pi*uvRadius is a whole number of texture tiles.
- elevators (project level): {"id":"lift","stops":[{"level":"ground","at":[0,-10]},{"level":"deck","at":[0,-5]}]}
  link floors for the reachability checks (rooms reached only by lift).
- Example: examples/kuwait_towers.json (generated by scripts/kuwait-towers.mts).

## Roofs
- Put roofs on the top level: {"type":"gable","polygon":<exterior wall points>,"pitch":35,"overhang":0.5}. Types: gable, hip, shed, flat (+parapet). Gable/hip/shed use the polygon's bounding rectangle; for L-shaped buildings use one roof per rectangular wing or a flat roof.

## Materials
- Use library names (list below), a hex color "#a0b0c0" (painted), or define custom ones: "materials": {"my_brick": {"base":"brick_red","color":"#ffdddd","scale":1.2}}.
- Every surface gets a seamless procedural PBR texture (base color, normal, roughness/AO) in the export.
- RAL Classic colours: "ral_9010" (paint) or as a colour anywhere: {"base":"metal_steel","color":"ral 7016"}.
- Scanned CC0 materials (photo textures, real-world tile size): search_assets "oak herringbone" / "travertine" /
  "velvet" → use the id like any material: "floorMaterial":"polyhaven:herringbone_parquet", "ambientcg:Marble012",
  or as a base to tint: {"base":"ambientcg:Fabric062","color":"#c9a08a"}. Fetched and cached automatically.

## Real products and 3D models
- Vendors: search_products (IKEA, any market e.g. "kw/en") or find a product page yourself (Homecentre, Amazon, Wayfair,
  West Elm...), then import_product {path, url, place:{position,facing}}: name, price, size, colour and the vendor's 3D
  model (IKEA publishes GLBs) go into project.products; furniture {"product":"<id>","position":[x,y]} places more.
  When a page cannot be read, pass name / width / depth / height (m) / price / image / type yourself: the item is then
  drawn as the closest parametric type, sized and tinted. shopping_list totals the placed products per vendor.
- Open models: search_assets kind=model → furniture {"type":"armchair","model":"polyhaven:ArmChair_01",...}; also
  sketchfab:<uid> (SKETCHFAB_API_TOKEN), future3d:<id> (FUTURE3D_DIR), any .glb/.gltf/.obj URL or local path.
  The type still drives layout checks and services; size comes from the model unless width/depth/height are given
  (fit contain|stretch|none); modelRotation fixes models whose front does not face -y.
- Vendor models are for visualising designs (licence "vendor"); exports list every asset in <model>.credits.md.

## Lighting design (level.lights) and window treatments
- Fixtures: pendant (shade dome|globe|cone|drum|cluster, hangHeight = bottom above the floor), chandelier, ceiling
  (style flush|semi_flush), downlight (recessed), spot / track (aim:[x,y,z], track runs along points), wall_sconce
  (snaps onto the nearest wall; style updown|up|down|glow), strip (LED along points: under wall cabinets height ~1.4,
  coves direction "up"), uplight (floor). height: meters or "ceiling" (default for ceiling fixtures).
- Grid: {"type":"downlight","room":"Kitchen","spacing":1.2,"margin":0.6} lays out an even grid in the room.
- Photometry: kelvin (2700 warm living/bedrooms, 3000 kitchens/baths, 4000 work), lumens per fixture (strip: per m),
  dim 0..1, beamAngle. Exported as real KHR_lights_punctual lights (candela); floor_lamp, table_lamp, ceiling_light and
  lamp_post furniture get a warm light automatically (options: {"light": false} to opt out, "lumens", "kelvin").
- Layer it: ambient (downlights / ceiling) + task (island pendants ~0.75 m above the top, under-cabinet strips) + accent
  (sconces, uplights, lamps). Pendants hang >= 2.0 m except over tables, islands and nightstands; every room needs a light.
- Judge it: render_view lighting:"night" (or "both"; CLI --lighting night) shows only artificial light, walls block it.
- Window treatments: opening.treatment = {"type":"curtains"|"sheers"|"curtains_and_sheers"|"roller_blind"|"roman_blind"|
  "venetian"|"shutters", "open":0..1, "mount":"wall"|"ceiling"|"recess", "material":"fabric_blue"} — hung on the room side.

## Interior styles and review views
- project.style / room.style: a preset (scandinavian, japandi, modern_minimal, industrial, mid_century, classic,
  coastal, luxury, boho, farmhouse; list_styles) or {"base":"japandi","upholstery":"fabric_blue"}. It fills only
  what you leave unset: room floors/walls/ceilings, furniture material slots (by role: wood, upholstery, metal,
  stone, bedding, rug...), doors/frames, cabinetry fronts/carcass/worktop/handles. Furniture follows the style of
  the room it stands in. Set one project style, then override per room or per item for accents.
- Check interiors like a designer: render_view room=<name> (eye-level shot from a clear corner; corner=1,2.. for
  other angles) and elevation=<wall id> elevationRoom=<room> (flat square-on view of one wall: kitchen runs,
  wardrobes, tiling heights, art placement). CLI: arch render plan.json --room Kitchen / --elevation w1.

## Workflow
1. Sketch the footprint and rooms on a grid; write the plan (create_project / write_project).
2. validate until there are no errors AND no warnings. Warnings are layout bugs found geometrically: furniture inside
   walls / door swings / doorways / in front of windows / facing a wall, overlapping furniture, rooms without doors or
   unreachable from the entrance, stairs through walls, arriving into walls, or with an open side and no railing.
   Most messages say exactly how to fix them (e.g. "move it 0.12 m south (to [4.5, 9.48])").
3. render_plan for each level (ids, coordinates, door swings, furniture) to check the layout reads well.
   Interiors: render_plan sheet="lighting" (fixture layout, ~lux per room, aim for 100-300 lx in living spaces,
   300+ over kitchen worktops), sheet="finishes" (floor patterns, wall finish and accent bands, finish schedule),
   sheet="rcp" (reflected ceiling plan: heights, materials, soffits, beams, coves, fixtures) and sheet="false_ceiling"
   (ceiling levels above FFL; lower service rooms with room.ceilingHeight, e.g. bathrooms 2.4-2.5 for a services void).
   sheet="electrical" and sheet="plumbing" show the services layout generated from the design: switches at the
   latch side of doors (one rocker per light group, 2-way at further doors and double-bed bedsides), sockets for the
   furniture and round the walls, worktop sockets, appliance spurs, cooker unit, fans, detectors, DB, circuits;
   fixtures with cold / hot supplies and drains to stacks, floor drains, water heaters. Refine with level.electrical
   (extra points, AC units, switches with "controls"), level.plumbing (your own stacks / heaters / inlet replace the
   automatic ones) and level.services.omit (auto ids such as sk.master.3, shown as sk3 on the sheet).
4. render_view: iso plus a cutaway per level (level=<id>); close-ups with focus=[x, y] (+ radius, zoom).
5. export_model to .glb (engine "unity"/"godot" adds merged meshes + colliders; textureFormat "ktx2" for the
   smallest, GPU-compressed textures). Y-up, meters; furniture and door
   leaves are separate nodes with pivots; node extras carry ids/room names.
`;

export function fullGuide(): string {
  const mats = listMaterials()
    .map((m) => `- ${m.name}: ${m.description}`)
    .join("\n");
  const furn = listFurniture()
    .map((f) => {
      const opts = Object.keys(f.options ?? {});
      return `- ${f.type} (${f.defaults.width}x${f.defaults.depth}x${f.defaults.height}; slots: ${Object.keys(f.slots).join(", ")}${opts.length ? `; options: ${opts.join(", ")}` : ""}): ${f.description}`;
    })
    .join("\n");
  return `${GUIDE}\n## Material library\n${mats}\n\n## Furniture types (width x depth x height)\n${furn}\n`;
}
