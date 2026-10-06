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

## Construction (what it's built of)
- project.construction.system defaults to "rc_block" — Kuwait / GCC practice: reinforced-concrete frame, slabs and flat roof (cement + steel rebar),
  hollow concrete block walls (insulated 200 mm block outside; 100/150/200 mm inside, picked from each wall's thickness), cement-sand plaster both faces,
  porcelain-tile floors and flat RC roofs with parapets by default. Other systems: loadbearing_block, steel_frame, timber_frame (only for timber-built regions).
- Per wall: "construction": "block_100" | "block_150" | "block_200" | "block_insulated_200" | "rc_200" | "rc_250" (shear / basement walls) | "drywall" | "glass" | "timber_stud".
- Kuwaiti villas: exterior 0.25-0.3 (20 cm block + plaster + insulation), interior 0.15-0.2, flat roof with a 1.0-1.2 m parapet, columns 0.3-0.4 at the grid.
- The plan sheet hatches walls by construction; costs.scope "full" bills foundations, concrete (m³), rebar (t), formwork, blockwork, plaster/render and the roof build-up.

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
- Put roofs on the top level: {"type":"flat","polygon":<exterior wall points>,"overhang":0,"parapet":1.1} is the Kuwait/GCC norm (RC slab, waterproofing, insulation, tiles); pitched {"type":"gable","pitch":35,"overhang":0.5} for other regions. Types: flat (+parapet), gable, hip, shed. Gable/hip/shed use the polygon's bounding rectangle; for L-shaped buildings use one roof per rectangular wing or a flat roof.

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
- IKEA METOD kitchens: casework {"system":"ikea_metod", ...} uses METOD sizes (worktop 0.918, wall cabinets 37 deep,
  tall 220/240 + legs: set tallHeight / upperHeight to match) and warns when a module is not 20/30/40/60/80 cm (fill the
  rest with {"kind":"filler","width":"auto"}). Link each module to its real combination ("product":"<id>") and put
  worktops, sink, tap, appliances, legs, plinths, panels and handles in the run's "products": [{product, qty}].

## Cost estimate
- cost_estimate (arch estimate -o bill.html): bill of quantities measured from the model, vendor items at their prices,
  the rest at indicative rates (KWD). project.costs: {currency, scope fitout|full, rates:{key:rate}, exchange,
  preliminaries, overheadProfit, contingency, designFee, vat}. The reply lists every rate key used. Use scope "full" for
  a new build (structure: concrete, rebar, formwork, blockwork). Products without a price are allowances: research
  their prices and set them with import_product {id, price, currency}.

## Air conditioning (project.hvac)
- Designed automatically: cooling loads per room at Kuwait conditions (48 °C / 24 °C) from the walls' construction,
  glass by orientation, the roof, people, the lighting design, appliances and fresh air; then the units. Default system
  "packaged": rooftop packaged units, ducted, one per floor (small floors share one unit through one riser); also
  "ducted_split", "split" (wall units per room) or "none". Bathrooms (extract), garages and outdoor rooms are not cooled.
- hvac_design: units (TR, L/s, kW, breaker), room loads, coordination issues; render_plan sheet "hvac": ducts to scale,
  diffusers, return grilles, the riser, thermostat, roof units. Cost: section J of cost_estimate. Contract: package hvac.
- Air side (in hvac_design): duct velocities and pressure drops, supply / return index runs, the external static
  pressure the fan needs vs a standard unit (high-static option flagged), fan power, diffuser necks with NC noise
  against the room (bedrooms NC 30), air changes per hour and throw.
- Ducts run in false ceilings: give conditioned rooms a ceilingHeight about 0.3–0.4 m below the slab soffit, or the
  design reports where ducts would be exposed. Steer it with hvac {zones:[{rooms:[...], shaft:[x,y]}], omitRooms,
  maxUnitTR, glazing:{u, shgc}, outdoorTemp}.

## Lifts (project.elevators)
- {id, stops:[{level},{level},...], shaft:{at:[x,y], facing:"south"}, capacity: 5, drive: "mrl_traction"} builds the
  lift: a 200 mm RC shaft on every level between the lowest and highest stop, a landing opening at each stop, slab
  openings, the car, landing doors, and an overrun on the roof when the top floor is lower than the lift's overhead.
  capacity (persons) sets the car / shaft / door (4: 1.4 × 1.6 m shaft, 5: 1.5 × 1.65, 6: 1.55 × 1.75, 8: 1.65 × 1.9
  wheelchair, 13: 1.7 × 2.55); drive mrl_traction (pit 1.1 m, overhead 3.5 m) | hydraulic | home_lift (pit 0.15 m,
  overhead 2.6 m). Checks: landing inside a room and clear (1.2 m, 1.5 m for 630 kg+), furniture in the shaft,
  doors / windows blocked, walls or stairs through the shaft. Cost section K, contract package "lifts".
- Without shaft, an elevator only links levels for the circulation check (stops need at).

## Airflow study and rendering (GPU)
- airflow_study (arch airflow): 3D simulation of how the conditioned air moves on a floor — the HVAC diffusers and
  returns, the rooms' heat gains, interior doors open. Per room: occupied-zone temperature, head-to-ankle difference,
  air speed, draught / stagnant shares, ADPI (aim 80%+); issues such as rooms that run warm, draughts, a return beside
  a supply. Image: temperature and air movement at 1.1 m. Fix by moving diffusers / returns (hvac zones) or splitting
  airflow over more diffusers, then re-run. Needs the server's GPU.
- render_view path-traces on the GPU when there is one (physical sky, AI denoiser): time "HH:MM" and date "MM-DD"
  place the Kuwaiti sun (06-21 high summer sun, 12-21 low winter sun); lighting "golden" = 45 min before sunset with
  the lamps on, the warm architectural-photography look. Photographic shots: eye [x, y, 1.6] + target with lens 24
  (exteriors) or room + lens 16–20 (interiors); verticals stay straight (two-point perspective). samples 128 default,
  256+ for finals. renderer "cpu" for a quick rasterised check.

## Water supply and drainage (project.water)
- Hydraulics of the plumbing layout, automatic: peak flows, pipe sizes, pressure at each outlet, booster set, hot-water
  wait at each hot outlet, summer cold-water temperature, roof / ground tanks, heaters, drainage stacks lining up.
- project.water {supply: "tank_booster" (default: roof tanks + booster set) | "tank_gravity" | "mains", boosterBar
  2.5, tank: "exposed" | "shaded" | "insulated", pipe: "ppr" | "pex" | "copper", occupants, litresPerPersonDay 450}.
- water_design (arch water) reports it; render_plan sheet "plumbing" shows sizes, the riser (R) and under each
  fixture its pressure and hot wait (red when low / slow). Fix slow hot water by moving the heater (level.plumbing
  water_heater) nearer the outlets; fix stacks that do not line up by stacking the bathrooms.

## Basement pump pits (level.pumpPits)
- A floor more than 1 m below ground cannot drain to the street sewer: its WCs, showers, laundry need a sewage pit,
  its sunken courts / light wells a drainage sump. Validation warns when a basement needs one and has none.
- level.pumpPits: {id, kind: "sewage" | "drainage", position, size [x, y] (default 1.0 × 1.0 for two pumps), depth
  (default from the switch levels and the incoming drain), pumps 2 (duty / standby), pump ("S-11" … "S-30" vortex,
  "G-15" / "G-22" grinder, "D-04" … "D-22" drainage; default the smallest that works), discharge [x, y] (the sewer
  manhole — set it), catchment [terrace / garden ids], extraArea m², groundwaterLh, rainfallMmH 60, usage 1,
  powerCutHours 4, pumpOutHours (6 for sewage)}. Put a sewage pit in a plant / service room, a sump in the court.
- pump_pit (arch pumppit) designs and simulates them — with no pits yet it suggests where, with the add_elements
  call: pump on its curve, rising main (0.7–2.3 m/s, loop above ground), switch levels, then the pit level through a
  normal day, the design storm, a power cut and a failed pump (alarm, flooding, starts per hour), one chart per pit.
  Pits show in 3D, on the plumbing sheet (P = pumps, MH = sewer connection) and in section G of the cost.

## Courtyards and facades (photographic exteriors)
- level.screens: slatted timber along a line — {points, base, height, direction: "vertical" (fins) | "horizontal"
  (louvres), slat {width, depth, gap}, offset, material "wood_teak"}: facade screens, privacy, sun shading.
- level.pergolas: {polygon, height 2.8, slat {width, depth, gap}, direction (deg), posts true | [[x, y]...] | false,
  material}: striped shade over seating, terraces, car ports.
- Plants are cut-out leaf cards with real silhouettes and shadows: tree kind "palm" (date palm, height 5–8, width
  4–5), "olive" (2.5–3.5 m), "deciduous" (shade tree), bush; options.seed varies the shape.
- furniture water_wall: wet dark-stone panel, water sheet, basin with a warm LED line; outdoor_lounge (built-in L
  bench: stone plinth, LED in the shadow gap, cushions; options.shape l | straight) with a stone_table inside the L;
  agave and grass_clump for gravel beds and planters (watered by drip like shrubs).
- Cladding / paving: travertine_slabs, limestone_slabs (120 × 60 staggered, fine joints); garden paving can take them
  as material. Light it: uplights at palm bases, strips under benches and steps (level.lights), lighting "golden".

## Gardens and irrigation (level.gardens, project.landscape)
- level.gardens: [{polygon, surface: "lawn"|"turf"|"planting"|"gravel"|"mulch"|"paving"|"sand", irrigation: true}]
  outside the rooms (roof gardens on an upper level work too). Plants are furniture: tree (options.kind "palm" |
  "deciduous" | "conifer", height), bush, hedge (width = length), planter.
- Irrigation is designed automatically: pop-up spray heads on natural lawns (3.5 m head-to-head), drip lines on
  planting beds, drip along hedges and at shrubs and planters, bubblers at trees (two per palm), zones capped by
  flow, a controller on the outside wall nearest the gardens (or by the water inlet) and the valve box a metre out,
  pipes routed round the building, summer water use. Artificial turf, gravel and paving get no water.
- landscape_design: zones, run times, water per day / month; render_plan sheet "landscape"; cost section L;
  contract package "landscape". Settings: project.landscape {irrigation, controller:{level, at}, sprinklerSpacing,
  dripSpacing, lawnLitresPerDay, bedLitresPerDay}.

## Works contracts
- generate_contract (arch contract): bilingual contract (English, then Arabic, Arabic prevails) per trade package as
  .docx + print-ready .html: main, structure (هيكل أسود), blockwork, plaster, waterproofing, tiling, painting, ceilings,
  doors_windows, electrical, plumbing, hvac, lifts, landscape, joinery, external. mode labour (مصنعية فقط, owner supplies materials) or supply.
  Quantities come from the full-scope bill; pass the contractor's labour prices as rates {"labour:<key>": rate}.
  Owner and site address: project.contract {owner, location, retention, defectsMonths, delayPenaltyPerDay}.
  Ask the user for the parties' details (names, civil IDs, phones) or leave them as blanks to fill in by hand.

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

const materialSection = () =>
  "## Material library\n" +
  listMaterials()
    .map((m) => `- ${m.name}: ${m.description}`)
    .join("\n");

const furnitureSection = () =>
  "## Furniture types (width x depth x height)\n" +
  listFurniture()
    .map((f) => {
      const opts = Object.keys(f.options ?? {});
      return `- ${f.type} (${f.defaults.width}x${f.defaults.depth}x${f.defaults.height}; slots: ${Object.keys(f.slots).join(", ")}${opts.length ? `; options: ${opts.join(", ")}` : ""}): ${f.description}`;
    })
    .join("\n");

export function fullGuide(): string {
  return `${GUIDE}\n${materialSection()}\n\n${furnitureSection()}\n`;
}

/** Headings of the format guide, for fetching one part at a time (small context windows). */
export const guideHeadings = (): string[] => [...GUIDE.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());

/**
 * Part of the guide: 'format' (conventions without the libraries), 'materials', 'furniture', or one
 * section by (the start of) its heading, e.g. 'stairs'. Undefined / 'all' = everything.
 */
export function guideSection(section?: string): string {
  const s = section?.trim().toLowerCase();
  if (!s || s === "all") return fullGuide();
  if (s === "format") return GUIDE;
  if (s === "materials") return materialSection();
  if (s === "furniture") return furnitureSection();
  const parts = GUIDE.split(/^(?=## )/m);
  const hit = parts.find((p) => p.slice(3).toLowerCase().startsWith(s));
  if (hit) return hit.trim();
  throw new Error(`no guide section '${section}'. Sections: format, materials, furniture, ${guideHeadings().map((h) => h.toLowerCase()).join(", ")}`);
}
