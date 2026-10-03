import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Document, NodeIO } from "@gltf-transform/core";
import { PNG } from "pngjs";
import { dominantColor } from "../src/assets/images.js";
import { loadModelFile } from "../src/assets/models.js";
import { guessFurnitureType, parseLength, parseProductHtml } from "../src/assets/vendors.js";
import { applyProducts, shoppingList } from "../src/elements/products.js";
import { listMaterials, resolveMaterial } from "../src/materials/library.js";
import { parseColor } from "../src/materials/textures.js";
import { compileWithAssets } from "../src/pipeline.js";
import { exportGLB } from "../src/export/gltf.js";
import type { SceneNode } from "../src/geometry/scene.js";

process.env.ARCHITECTURER_CACHE = mkdtempSync(join(tmpdir(), "arch-cache-"));
const dir = mkdtempSync(join(tmpdir(), "arch-assets-"));

function png(w: number, h: number, px: (x: number, y: number) => [number, number, number]): Buffer {
  const p = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = px(x, y);
      const k = (y * w + x) * 4;
      (p.data[k] = r), (p.data[k + 1] = g), (p.data[k + 2] = b), (p.data[k + 3] = 255);
    }
  return PNG.sync.write(p);
}

/** A 1 (x) × 0.5 (y, up) × 2 (z, front) glTF box with a red texture. */
async function makeGlb(path: string) {
  const doc = new Document();
  const buf = doc.createBuffer();
  const P: number[] = [], I: number[] = [];
  const [hx, hy, hz] = [0.5, 0.25, 1];
  const corners = [[-hx, 0, -hz], [hx, 0, -hz], [hx, 2 * hy, -hz], [-hx, 2 * hy, -hz], [-hx, 0, hz], [hx, 0, hz], [hx, 2 * hy, hz], [-hx, 2 * hy, hz]];
  for (const c of corners) P.push(...c);
  I.push(0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5);
  const tex = doc.createTexture("red").setImage(png(8, 8, () => [200, 30, 30])).setMimeType("image/png");
  const mat = doc.createMaterial("paint").setBaseColorTexture(tex).setBaseColorFactor([1, 1, 1, 1]).setRoughnessFactor(0.4);
  const prim = doc
    .createPrimitive()
    .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(new Float32Array(P)).setBuffer(buf))
    .setAttribute("TEXCOORD_0", doc.createAccessor().setType("VEC2").setArray(new Float32Array(16)).setBuffer(buf))
    .setIndices(doc.createAccessor().setType("SCALAR").setArray(new Uint16Array(I)).setBuffer(buf))
    .setMaterial(mat);
  const node = doc.createNode("box").setMesh(doc.createMesh("box").addPrimitive(prim)).setTranslation([3, 0, 0]);
  doc.createScene().addChild(node);
  await new NodeIO().write(path, doc);
}

test("RAL colours and the extended library", () => {
  assert.deepEqual(parseColor("ral 7016"), parseColor("#373f43"));
  assert.equal(resolveMaterial("RAL_9010").name, "ral_9010");
  assert.deepEqual(resolveMaterial("ral-3020").color, parseColor(resolveMaterial("ral_3020").color as never) ?? resolveMaterial("ral_3020").color);
  const names = new Set(listMaterials().map((m) => m.name));
  assert.ok(names.size >= 300, `library has ${names.size}`);
  for (const n of ["marble_calacatta", "travertine", "wood_floor_smoked_oak", "paint_sage", "velvet_navy", "metal_antique_brass", "tiles_subway_green", "glass_fluted"]) assert.ok(names.has(n), n);
  assert.throws(() => resolveMaterial("ambientcg:Nope001"), /has not been fetched/);
});

test("lengths and product pages", () => {
  assert.equal(parseLength('32 1/4 "'), 0.819);
  assert.equal(parseLength("80 cm"), 0.8);
  assert.equal(parseLength("800 mm"), 0.8);
  assert.equal(parseLength("2'6\""), 0.762);
  assert.equal(parseLength("1,5 m"), 1.5);
  const ikea = parseProductHtml(
    `<html><script type="application/ld+json">{"@context":"https://schema.org/","@type":"Product","name":"POÄNG Armchair","brand":{"@type":"Brand","name":"IKEA"},"sku":"593.059.28","category":"Fabric armchairs","width":"26 3/4 \\"","depth":"32 1/4 \\"","height":"39 3/8 \\"","image":[{"@type":"ImageObject","contentUrl":"https://x/img.jpg"}],"offers":{"@type":"Offer","price":"149.00","priceCurrency":"USD"}}</script>
     <script type="application/ld+json">{"@context":"http://schema.org/","@type":"3DModel","encoding":[{"@type":"MediaObject","contentUrl":"https://x/model.glb?cn=pip","encodingFormat":"model/gltf-binary"}]}</script></html>`,
    "https://www.ikea.com/us/en/p/poaeng/",
  );
  assert.equal(ikea.vendor, "IKEA");
  assert.deepEqual([ikea.width, ikea.depth, ikea.height], [0.679, 0.819, 1]);
  assert.equal(ikea.price, 149);
  assert.equal(ikea.model, "https://x/model.glb?cn=pip");
  assert.equal(ikea.type, "armchair");
  const generic = parseProductHtml(
    `<html><head><meta property="og:title" content="Linen 3-seater sofa, olive"><meta property="og:image" content="https://shop/sofa.jpg"><meta property="product:price:amount" content="245.5"><meta property="product:price:currency" content="KWD"></head><body><p>Dimensions: 210 x 92 x 80 cm</p></body></html>`,
    "https://www.homecentre.com/kw/en/p/123",
  );
  assert.equal(generic.vendor, "Homecentre");
  assert.deepEqual([generic.width, generic.depth, generic.height, generic.price, generic.currency, generic.type], [2.1, 0.92, 0.8, 245.5, "KWD", "sofa"]);
  const amazon = parseProductHtml(`<title>Mid-century Accent Chair</title><table><tr><td>Product Dimensions</td><td>30"D x 28"W x 35"H</td></tr></table>`, "https://www.amazon.com/dp/B0");
  assert.deepEqual([amazon.width, amazon.depth, amazon.height], [0.711, 0.762, 0.889]);
  assert.equal(guessFurnitureType("HEMNES Chest of 6 drawers"), "dresser");
  assert.equal(guessFurnitureType("MALM Bed frame, high"), "bed");
});

test("dominant colour ignores the studio background", () => {
  const p = PNG.sync.read(png(60, 60, (x, y) => (x > 15 && x < 45 && y > 15 && y < 45 ? [40, 90, 160] : [250, 250, 250])));
  const c = dominantColor({ width: 60, height: 60, data: new Uint8Array(p.data) });
  const rgb = parseColor(c)!;
  assert.ok(rgb[2] > 0.55 && rgb[0] < 0.25, c);
});

test("glTF and OBJ import: axes, centring, units, textures", async () => {
  const glb = join(dir, "box.glb");
  await makeGlb(glb);
  const m = await loadModelFile(glb, glb, { id: "box", license: "test" });
  assert.deepEqual(m.size.map((v) => +v.toFixed(3)), [1, 2, 0.5], "glTF (x, y up, z front) → plan (x, depth, height)");
  const xs = m.meshes[0].positions.filter((_, i) => i % 3 === 0);
  assert.ok(Math.abs(Math.min(...xs) + 0.5) < 1e-6, "centred despite the node translation");
  const mat = resolveMaterial(m.meshes[0].material);
  assert.ok(mat.images?.baseColor?.endsWith(".png") && mat.roughness === 0.4);

  writeFileSync(join(dir, "t.mtl"), "newmtl wood\nKd 0.6 0.4 0.2\nNs 200\n");
  writeFileSync(join(dir, "t.obj"), "mtllib t.mtl\nv -40 0 -30\nv 40 0 -30\nv 40 90 -30\nv -40 90 30\nusemtl wood\nf 1 2 3\nf 1 3 4\n");
  const o = await loadModelFile(join(dir, "t.obj"), "t.obj", { id: "t", license: "test" }, () => {});
  assert.deepEqual(o.size.map((v) => +v.toFixed(2)), [0.8, 0.6, 0.9], "OBJ in centimetres detected");
  assert.deepEqual(resolveMaterial(o.meshes[0].material).color, [0.6, 0.4, 0.2]);
});

test("products: models, stand-ins, sizes from the model, shopping list, credits", async () => {
  const glb = join(dir, "chair.glb");
  await makeGlb(glb);
  const plan = {
    site: { ground: false },
    products: [
      { id: "box_chair", name: "Box chair", vendor: "Testco", price: 99.5, currency: "KWD", type: "armchair", model: "chair.glb" },
      { id: "olive_sofa", name: "Olive sofa", vendor: "Homecentre", price: 245, currency: "KWD", type: "sofa", width: 2.1, depth: 0.92, height: 0.8, color: "#77794e" },
    ],
    levels: [
      {
        id: "g",
        walls: [{ id: "ext", points: [[0, 0], [6, 0], [6, 5], [0, 5]], closed: true }],
        openings: [{ id: "door", type: "door", at: [1, 0] }],
        rooms: [{ id: "r", name: "Living room", polygon: [[0, 0], [6, 0], [6, 5], [0, 5]] }],
        furniture: [
          { id: "c1", product: "box_chair", position: [4.5, 3.5] },
          { id: "c2", product: "box_chair", position: [4.5, 1.5], height: 0.25 },
          { id: "s1", product: "olive_sofa", position: [2, 4.3], facing: "south" },
        ],
      },
    ],
  };
  const c = await compileWithAssets(plan, { baseDir: dir });
  assert.ok(c.ok, c.errors.join("\n"));
  const fur = c.project!.levels[0].furniture;
  assert.deepEqual([fur[0].width, fur[0].depth, fur[0].height], [1, 2, 0.5], "natural model size");
  assert.deepEqual([fur[1].width, fur[1].depth, fur[1].height], [0.5, 1, 0.25], "one size given: proportional");
  assert.equal(fur[2].materials.body, "product_olive_sofa");
  assert.equal(fur[2].materials.cushions, "product_olive_sofa_cushions");
  assert.deepEqual(c.materials.get("product_olive_sofa")?.color, parseColor("#77794e"));
  const nodes: SceneNode[] = [];
  const walk = (n: SceneNode) => (n.kind === "furniture" && nodes.push(n), n.children.forEach(walk));
  walk(c.root!);
  const n1 = nodes.find((n) => n.name === "c1")!;
  assert.ok(n1.meshes[0].material.startsWith("model:") && n1.extras?.product === "box_chair");
  assert.ok(c.credits.some((s) => s.license === "local file"));
  const glbOut = await exportGLB(c, { textureSize: 64 });
  assert.ok(glbOut.length > 1000);
  const bom = shoppingList(plan as never);
  assert.deepEqual(bom.totals, [{ vendor: "Homecentre", currency: "KWD", total: 245, items: 1 }, { vendor: "Testco", currency: "KWD", total: 199, items: 2 }]);
  // unknown product → readable error
  const bad = applyProducts({ products: [], levels: [{ id: "g", furniture: [{ product: "nope", position: [0, 0] }] }] });
  assert.match(bad.errors[0], /unknown product 'nope'/);
});
