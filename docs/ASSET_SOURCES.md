# Asset sources

Architecturer ships about 330 procedural materials and all 217 RAL Classic colours. It also pulls scanned
materials, 3D models and real products from the sources below. Downloads are cached in `ARCHITECTURER_CACHE`
(default `~/.cache/architecturer`), so a plan builds offline once its assets have been fetched (`arch fetch plan.json`).
`arch build` writes a `<model>.credits.md` file listing every external asset and its licence.

Worked example: [`examples/vendor_lounge.json`](../examples/vendor_lounge.json): IKEA models, a Poly Haven armchair, scanned CC0 floor and rug, RAL paint and a Homecentre stand-in, with `arch bom` totals per vendor.

## Built in (no download)

| What | How to use |
| --- | --- |
| ~330 procedural PBR materials: woods (oak, walnut, ash, maple, cherry, smoked, whitewashed, ebony, bamboo...), parquet (herringbone, chevron, basketweave), natural stones (Calacatta, Nero Marquina, Emperador, Verde, travertine, onyx, granite, limestone, slate), terrazzo, zellige, subway / hex / porcelain tiles, designer paints, lacquers, metals (antique brass, bronze, gunmetal, nickel, rose gold, Corten), velvets, linens, bouclé, leathers, glass, wallpapers, slats, microcement... | `arch materials`, MCP `list_materials` |
| RAL Classic (217 colours) | Use as paint (`"ral_7016"`), as a colour (`"color": "ral 9010"`), or as a base (`{ "base": "metal_steel", "color": "ral 7016" }`) |
| Any colour | `"#c9a08a"` as a paint material or as a colour |

## Open libraries (fetched automatically)

| Source | Content | Licence | Reference |
| --- | --- | --- | --- |
| [ambientCG](https://ambientcg.com) | ~2,000 scanned and procedural PBR materials, with real-world tile sizes | CC0 | `ambientcg:WoodFloor051` (material) |
| [Poly Haven](https://polyhaven.com) | ~900 scanned PBR textures | CC0 | `polyhaven:herringbone_parquet` (material) |
| Poly Haven | ~85 furniture and decor models plus props (glTF, 1k textures) | CC0 | `polyhaven:ArmChair_01` (furniture `model`) |
| [Sketchfab](https://sketchfab.com) | Downloadable Creative Commons models. Needs `SKETCHFAB_API_TOKEN` | CC-BY / CC0 per model (credited) | `sketchfab:<uid>` |

To find assets, use `arch assets "oak herringbone"` or `arch assets chair --kind model`, or the MCP tool `search_assets`.

## Vendors (real products)

`import_product` (MCP) or `arch product <url> --add plan.json --at x,y` reads a product page. It takes the name, vendor,
SKU, price, size, the main colour of the product photo, and the vendor's own 3D model when one is published. Placed
products show up in the shopping list (`arch bom`, MCP `shopping_list`).

| Vendor | What is read |
| --- | --- |
| IKEA (all markets: us/en, kw/en, ae/en, sa/en, gb/en...) | Search (`search_products`), schema.org product data, exact measurements, and the GLB 3D model published for AR |
| Wayfair, West Elm, Pottery Barn, Crate & Barrel, Home Box, Danube, PAN Home, Zara Home, Maisons du Monde... | schema.org / Open Graph product data and measurement text. 3D models only when the page links a `.glb` |
| Homecentre, Amazon, noon, Taobao / Tmall / JD | These pages are rendered in the browser or block scripted requests. The AI reads the page with its own browser tools and passes `name`, `width`/`depth`/`height`, `price`, `image` and `color`. The item is then drawn as the closest parametric furniture type, sized and tinted to match |

Vendor models are licensed for **visualising designs**. They are tagged `license: "vendor"`, and exports print a notice.
Check the vendor's terms before redistributing them inside a game or app.

## Chinese sources

| Source | What it is | How to use it here |
| --- | --- | --- |
| **3D-FUTURE** (Alibaba, 阿里天池 Tianchi) | 16,563 textured industrial furniture models (OBJ and texture), with category, style and material labels | Apply on Tianchi (non-commercial research licence) and extract the models. Set `FUTURE3D_DIR` to the `3D-FUTURE-model` folder, then `search_assets` with `kind=model` searches it and `future3d:<model_id>` places a model |
| **3D-FRONT** (Alibaba) | 18,968 furnished room layouts that use 3D-FUTURE furniture | Research licence. A useful reference for layouts |
| **Structured3D** (Kujiale 酷家乐 / Manycore 群核) | 3,500 photo-realistic house designs with structure annotations | Academic licence. A reference only |
| 3D溜溜网 3d66.com, 知末网 znzmo.com, 欧模网 om.cn, 模型云 and similar | Very large interior model and material libraries (.max / .skp / .fbx with V-Ray or Corona materials) | Not open source: they need an account and points or VIP, and their licences restrict redistribution, so Architecturer does not scrape them. Models you download yourself convert with `blender -b -P scripts/convert_to_glb.py -- model.fbx` (export FBX or glTF from 3ds Max or SketchUp first for .max / .skp), then go in `furniture.model` as a local path |
| 酷家乐 Kujiale, 三维家 3vjia | Online design platforms with brand furniture catalogues | Proprietary, with no export API |

## Local files

`furniture.model` accepts `.glb`, `.gltf` (Draco and meshopt compression included) and `.obj` (+ `.mtl`) files. Paths are
relative to the plan file. Models are oriented with glTF's convention (Y up, front toward +Z), which becomes plan
"front faces -y". Use `modelRotation` if a model faces another way. Sizes come from the model unless `width`, `depth`
or `height` are given (`fit: contain | stretch | none`). OBJ files have no units, so centimetre and millimetre exports
are detected from their size.
