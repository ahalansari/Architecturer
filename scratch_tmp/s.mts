import { searchIkea } from "../src/assets/vendors.ts";
for (const q of JSON.parse(process.argv[2]) as string[]) {
  const hits = await searchIkea(q, "kw/en", 10).catch((e) => [{ name: "ERR " + e.message, price: 0, url: "" }] as any);
  console.log("==", q);
  for (const h of hits) console.log(`  ${String(h.price).padStart(7)} ${h.currency ?? ""} | ${h.name}${h.size ? ` (${h.size})` : ""} | ${h.url.replace("https://www.ikea.com/kw/en/p/", "")}`);
}
