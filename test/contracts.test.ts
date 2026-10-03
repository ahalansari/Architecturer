import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { unzipSync, strFromU8 } from "fflate";
import { compile } from "../src/pipeline.js";
import { estimate } from "../src/cost/estimate.js";
import { buildContract, contractDocument } from "../src/contracts/contract.js";
import { PACKAGES } from "../src/contracts/packages.js";
import { contractDocx, contractHtml } from "../src/contracts/render.js";

const villa = () => compile(JSON.parse(readFileSync(new URL("../examples/villa.json", import.meta.url), "utf8")));
const apartment = () => compile(JSON.parse(readFileSync(new URL("../examples/showcase_apartment.json", import.meta.url), "utf8")));

test("every construction line of the bill belongs to exactly one trade package", () => {
  for (const c of [villa(), apartment()]) {
    const bill = estimate(c, { scope: "full" });
    const trades = PACKAGES.filter((p) => p.id !== "main");
    for (const s of bill.sections) {
      if (s.code === "H") continue; // furniture is bought, not contracted
      for (const l of s.lines) {
        const owners = trades.filter((p) => p.match({ section: s.code, key: l.key, description: l.description })).map((p) => p.id);
        assert.equal(owners.length, 1, `${s.code} ${l.key} "${l.description}" → ${owners.join(", ") || "no package"}`);
      }
    }
  }
});

test("contract value, schedule and payments add up; stages follow the slabs", () => {
  const c = villa();
  const k = buildContract(c, { package: "structure", mode: "labour", date: "2026-10-01" });
  // Kuwaiti practice: skeleton labour per m² of built-up area replaces the concrete / rebar / formwork lines
  const skel = k.items.find((i) => /^Skeleton labour/.test(i.en))!;
  assert.equal(skel.unit, "m²");
  assert.ok(skel.qty > 400 && skel.rate > 0, `${skel.qty} m² × ${skel.rate}`);
  assert.equal(skel.basis, "labour-researched");
  assert.ok(!k.items.some((i) => /Steel reinforcement|Formwork/.test(i.en)));
  assert.ok(k.items.every((i) => i.amount > 0));
  const sum = k.items.reduce((a, i) => a + i.amount, 0);
  assert.ok(Math.abs(sum - k.value) < 0.01);
  assert.equal(k.payments.reduce((a, p) => a + p.pct, 0), 100);
  assert.ok(Math.abs(k.payments.reduce((a, p) => a + p.amount, 0) - k.value) < 0.005);
  // the villa has two levels: one suspended slab, then the roof
  const labels = k.payments.map((p) => p.label.en).join(" | ");
  assert.match(labels, /first suspended floor slab/);
  assert.match(labels, /roof slab/);
  assert.equal(k.startDate, "2026-10-08");
  assert.ok(k.pkg.structural);
  // labour only is cheaper than supply & install for the same quantities
  const supply = buildContract(c, { package: "structure", mode: "supply" });
  assert.ok(k.value < supply.value * 0.6, `${k.value} vs ${supply.value}`);
  // the main contract carries the main contractor's preliminaries and overhead & profit
  const main = buildContract(c, { package: "main", mode: "supply" });
  assert.equal(main.adjustments.length, 2);
  assert.ok(main.value > main.subtotal);
});

test("rate overrides, project settings and supply-only trades", () => {
  const c = compile({
    ...JSON.parse(readFileSync(new URL("../examples/villa.json", import.meta.url), "utf8")),
    contract: { owner: { name: "Owner Name", nameAr: "اسم المالك" }, location: { area: "Salwa", block: "5", plot: "12" }, retention: 10, defectsMonths: 24 },
  });
  const k = buildContract(c, { package: "plaster", mode: "labour", rates: { "labour:wall:render_external": 2.45 } });
  assert.equal(k.items.find((i) => /internal walls/.test(i.en))!.basis, "labour-researched", "researched Kuwaiti plaster labour rate");
  const render = k.items.find((i) => /External render/.test(i.en))!;
  assert.equal(render.rate, 2.45);
  assert.equal(render.basis, "override");
  assert.equal(k.retention, 10);
  assert.equal(k.defectsMonths, 24);
  assert.equal(k.owner.nameAr, "اسم المالك");
  assert.throws(() => buildContract(c, { package: "joinery", mode: "labour" }), /supply only/);
  assert.throws(() => buildContract(c, { package: "nope" }), /unknown contract package/);
});

test("documents: English then Arabic, in HTML and Word", async () => {
  const c = villa();
  const k = buildContract(c, { package: "plaster", mode: "labour", contractor: { company: "Test Co", companyAr: "شركة الاختبار" }, location: { area: "Salwa", plot: "9" } });
  const doc = contractDocument(k);
  const html = contractHtml(doc);
  assert.ok(html.indexOf("WORKS CONTRACT") < html.indexOf("عقد مقاولة"), "English first");
  assert.match(html, /<section class="sheet ar" lang="ar" dir="rtl">/);
  assert.match(html, /مصنعية فقط/);
  assert.match(html, /the Arabic text prevails/);
  assert.match(html, /يعتمد النص العربي/);
  assert.match(html, /شركة الاختبار/);
  assert.match(html, /قسيمة 9/);
  assert.match(html, /الملحق رقم \(1\)/);
  const docx = await contractDocx(doc);
  const files = unzipSync(new Uint8Array(docx));
  const xml = strFromU8(files["word/document.xml"]);
  assert.match(xml, /WORKS CONTRACT/);
  assert.match(xml, /عقد مقاولة/);
  assert.match(xml, /<w:bidi\/>/, "Arabic paragraphs are right-to-left");
  assert.match(xml, /<w:bidiVisual\/>/, "Arabic tables are right-to-left");
  assert.ok(xml.indexOf("WORKS CONTRACT") < xml.indexOf("عقد مقاولة"));
});
