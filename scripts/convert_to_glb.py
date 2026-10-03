"""
Convert downloaded models (.fbx, .obj, .dae, .3ds, .stl, .ply, .blend, .usd/.usdz) to .glb with Blender,
so they can be used as furniture.model. Typical for files from model sites that ship FBX / 3DS / OBJ
(3D溜溜 3d66, 知末 znzmo, CGTrader, TurboSquid, Free3D...).

    blender -b -P scripts/convert_to_glb.py -- input.fbx [output.glb] [--scale 0.01] [--apply-transforms]

  --scale 0.01        multiply sizes (models exported in centimetres: 0.01; millimetres: 0.001)
  --apply-transforms  bake object transforms (helps with odd pivots / negative scales)

.max (3ds Max) and .skp (SketchUp) can't be opened by Blender: export FBX or glTF from 3ds Max / SketchUp first.
V-Ray / Corona materials don't survive the trip; textures referenced as plain bitmaps usually do.
"""
import os
import sys

import bpy

argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
if not argv:
    print(__doc__)
    sys.exit(1)

src = os.path.abspath(argv[0])
dst = os.path.abspath(argv[1]) if len(argv) > 1 and not argv[1].startswith("--") else os.path.splitext(src)[0] + ".glb"
scale = float(argv[argv.index("--scale") + 1]) if "--scale" in argv else 1.0
apply_transforms = "--apply-transforms" in argv

bpy.ops.wm.read_factory_settings(use_empty=True)
ext = os.path.splitext(src)[1].lower()
if ext == ".fbx":
    bpy.ops.import_scene.fbx(filepath=src)
elif ext == ".obj":
    bpy.ops.wm.obj_import(filepath=src)
elif ext == ".dae":
    bpy.ops.wm.collada_import(filepath=src)
elif ext == ".3ds":
    bpy.ops.import_scene.max3ds(filepath=src)
elif ext == ".stl":
    bpy.ops.wm.stl_import(filepath=src)
elif ext == ".ply":
    bpy.ops.wm.ply_import(filepath=src)
elif ext in (".usd", ".usda", ".usdc", ".usdz"):
    bpy.ops.wm.usd_import(filepath=src)
elif ext == ".blend":
    bpy.ops.wm.open_mainfile(filepath=src)
elif ext in (".gltf", ".glb"):
    bpy.ops.import_scene.gltf(filepath=src)
else:
    sys.exit(f"unsupported input {ext}")

if scale != 1.0:
    for ob in bpy.context.scene.objects:
        if ob.parent is None:
            ob.scale = [s * scale for s in ob.scale]
if apply_transforms or scale != 1.0:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)

bpy.ops.export_scene.gltf(filepath=dst, export_format="GLB", export_yup=True, export_apply=True)
print(f"wrote {dst}")
