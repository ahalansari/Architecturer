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

## Stairs
- Stairs go UP from the level they're on to the next level (rise defaults to level height) and cut a stairwell into the slab above automatically.
- start = center of the front edge of the first step; direction = walking direction. Length of a straight flight ≈ (rise/0.175 - 1) * tread (≈ 4.5 m for 3 m). Use "U" (≈ 3 m long, 2.1 m wide) or "L" in tight halls; "spiral" uses start as the center and width as radius.
- On the upper level, put railings around the open sides of the stairwell and make sure the top of the stair arrives in a corridor, not against a wall.

## Furniture
- {"type":"bed","position":[3,4],"facing":"south"} — position is the footprint center; facing is where the FRONT points (where you sit/open). rotation (deg) is the alternative; rotation 0 = facing south.
- Leave >= 0.6 m clear in front of furniture, keep it out of door swings, and place against walls by offsetting half the depth from the wall's inner face (wall centerline ± thickness/2).
- width is the object's left-right size when you face it, depth front-back. elevation lifts it (upper cabinets, wall TVs).

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

## Workflow
1. Sketch the footprint and rooms on a grid; write the plan (create_project / write_project).
2. validate until there are no errors AND no warnings. Warnings are layout bugs found geometrically: furniture inside
   walls / door swings / doorways / in front of windows / facing a wall, overlapping furniture, rooms without doors or
   unreachable from the entrance, stairs through walls, arriving into walls, or with an open side and no railing.
   Most messages say exactly how to fix them (e.g. "move it 0.12 m south (to [4.5, 9.48])").
3. render_plan for each level (ids, coordinates, door swings, furniture) to check the layout reads well.
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
