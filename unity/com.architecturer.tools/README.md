# Architecturer Tools for Unity

Sets up models exported with `arch build plan.json -o Assets/Models/house.glb --unity`
(or the MCP tool `export_model` with `engine: "unity"`).

## Install
1. Package Manager › **+** › *Add package from disk…* › pick this folder's `package.json`.
   This also installs **glTFast** (`com.unity.cloud.gltfast`), which imports `.glb` files, and **KTX for Unity**
   (`com.unity.cloud.ktx`), which decodes `--texture-format ktx2` exports into GPU-compressed textures.
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

Coordinates match the plan: plan `(x, y)` = Unity world `(x, z)`, height = `y`, meters.
Door leaves rotate around their local **Y** axis (the hinge).

For models spawned at runtime (e.g. glTFast `GltfAsset`), add the **Architecturer Model** component to the root.
Already-placed models: select them and run *Tools › Architecturer › Set Up Selected Models*.

Not set: lightmap static (the textures use tiled UVs; use realtime/mixed lighting or generate a second UV set).
