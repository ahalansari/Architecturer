// Inspect the KTX2 images inside a .glb: codec, size, mip levels, color space per texture role.
import { NodeIO } from "@gltf-transform/core";
import { KHRTextureBasisu } from "@gltf-transform/extensions";
import { read } from "ktx-parse";

const doc = await new NodeIO().registerExtensions([KHRTextureBasisu]).read(process.argv[2]);
const MODEL: Record<number, string> = { 163: "ETC1S", 166: "UASTC" };
const TRANSFER: Record<number, string> = { 1: "linear", 2: "sRGB" };
const rows = new Map<string, number>();
let bad = 0;
for (const t of doc.getRoot().listTextures()) {
  const k = read(t.getImage()!);
  const dfd = k.dataFormatDescriptor[0];
  const role = t.getName().replace(/^.*_/, "");
  const want = role === "basecolor" ? "sRGB" : "linear";
  const got = TRANSFER[dfd.transferFunction];
  if (got !== want || k.levels.length < 2) bad++;
  const key = `${role.padEnd(10)} ${MODEL[dfd.colorModel] ?? dfd.colorModel} ${got} ${k.pixelWidth}px mips=${k.levels.length} zstd=${k.supercompressionScheme === 2}`;
  rows.set(key, (rows.get(key) ?? 0) + 1);
}
for (const [k, n] of rows) console.log(`${String(n).padStart(3)} x ${k}`);
console.log(bad ? `${bad} texture(s) with wrong color space or no mipmaps` : "all textures OK");
process.exit(bad ? 1 : 0);
