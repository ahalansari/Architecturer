# Architecturer Tools for Unity

Sets up models exported with `arch build plan.json -o Assets/Models/house.glb --unity`
(or the MCP tool `export_model` with `engine: "unity"`).

## Install
1. Package Manager › **+** › *Add package from disk…* › pick this folder's `package.json`.
   This also installs **glTFast** (`com.unity.cloud.gltfast`), which imports `.glb` files, **KTX for Unity**
   (`com.unity.cloud.ktx`), which decodes `--texture-format ktx2` exports into GPU-compressed textures, and
   **AI Navigation** (`com.unity.ai.navigation`; Unity 6 uses its own 2.x).
2. Export your plan into the project's `Assets/` folder.

## Use
Drag the `.glb` into a scene. It is set up automatically (toggle: *Tools › Architecturer › Auto Set Up When Placed*):

| Node | Becomes |
|---|---|
| `<Level>_static` | one mesh per level (a sub-mesh per material), marked Batching/Occluder/Occludee/ReflectionProbe static |
| `<Level>-colonly` | non-convex **MeshCollider** (walls, floors, roofs, glass; stairs are smooth ramps), renderer hidden |
| `furniture/*`, `doors/*` | movable objects with their pivot at the placement point / door hinge |
| `*-convcolonly` | convex box **MeshCollider** on each movable object, renderer hidden |
| `rooms/<Room name>` | empty marker at the room's floor center (spawn points, triggers) |
| `nav/nav-area\|kind\|…` | **NavMeshModifierVolume** marking the room's floor: Indoor (27), Outdoor (28), Wet Room (29), Stairs (30), Service (31) |
| `nav/nav-lift\|id\|stop` | lift landings; consecutive stops get a **NavMeshLink** |
| `doors/*/nav-doorway\|…` | the door's closed position: an **ArchitecturerDoor** + carving **NavMeshObstacle**, off while the door is open |

Coordinates match the plan: plan `(x, y)` = Unity world `(x, z)`, height = `y`, meters.
Door leaves rotate around their local **Y** axis (the hinge).

For models spawned at runtime (e.g. glTFast `GltfAsset`), add the **Architecturer Model** component to the root.
Already-placed models: select them and run *Tools › Architecturer › Set Up Selected Models*.

## NavMesh
Placing a model also bakes its NavMesh (toggle: *Tools › Architecturer › Auto Bake NavMesh When Placed*; or
*Bake NavMesh for Selected Models*). The bake is saved under `Assets/Architecturer/NavMesh/`.

- A **NavMeshSurface** on the model root bakes from its colliders: walls, floors, stair ramps, furniture boxes (trees
  collide at the trunk). Door leaves and small items (under 0.2 m², or lower than 0.3 m) are left out of the bake.
- *Set Up Navigation Settings* (run automatically) names areas 27–31 with costs (indoor 1, outdoor 1.2, stairs 1.5,
  wet room 2, service 3) and adds the **Architecturer Person** agent: 0.25 m radius, 1.8 m tall, 0.2 m steps, 45°.
  Give your `NavMeshAgent`s that agent type (`ArchitecturerNav.PersonAgentTypeID()`).
- Doors: `GetComponent<ArchitecturerDoor>().SetOpen(false)` closes one — agents path around it.
- Lifts: agents ride a lift as a link between its landings.
- Runtime-loaded models: the **Architecturer Model** component builds the colliders and the NavMesh once loaded.

Check the same thing without Unity: the MCP tool `nav_check` (or `arch nav plan.json`) bakes the same navmesh on the
server and reports rooms that cannot be reached, and why.

## Baked lighting
Unity exports carry a second, non-overlapping UV set (`uv2`) on the merged static meshes, so they are marked
*Contribute GI* and receive lightmaps: bake with the Lighting window as usual.
