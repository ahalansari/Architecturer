import assert from "node:assert/strict";
import { test } from "node:test";
import { compile } from "../src/pipeline.js";
import { estimate } from "../src/cost/estimate.js";
import { billCsv, billHtml, billMarkdown } from "../src/cost/format.js";
import { shoppingList } from "../src/elements/products.js";
import { marketRate, marketRates } from "../src/cost/market.js";

function flat(extra: Record<string, unknown> = {}, kitchen: Record<string, unknown> = {}) {
  return {
    name: "Cost test",
    site: { ground: false },
    products: [
      { id: "sofa1", name: "Test sofa", vendor: "Shop", price: 300, currency: "KWD", type: "sofa" },
      { id: "lamp1", name: "Test lamp", vendor: "Shop", price: 20, currency: "USD", type: "floor_lamp" },
      { id: "base80", name: "METOD base cabinet 80", vendor: "IKEA", price: 100, currency: "KWD", type: "box" },
      { id: "worktop", name: "Worktop 186 cm", vendor: "IKEA", price: 30, currency: "KWD", type: "box" },
    ],
    levels: [
      {
        id: "g",
        height: 3,
        walls: [
          { id: "ext", points: [[0, 0], [8, 0], [8, 5], [0, 5]], closed: true },
          { id: "mid", points: [[4, 0], [4, 5]] },
        ],
        openings: [
          { id: "front", type: "door", at: [2, 0] },
          { id: "d1", type: "door", at: [4, 2.5] },
          { id: "w1", type: "window", at: [6, 5], width: 1.5, height: 1.2 },
        ],
        rooms: [
          { id: "liv", name: "Living room", polygon: [[0, 0], [4, 0], [4, 5], [0, 5]], floorMaterial: "wood_herringbone_oak", finishes: { walls: "paint_sage", skirting: {} } },
          { id: "kit", name: "Kitchen", polygon: [[4, 0], [8, 0], [8, 5], [4, 5]], floorMaterial: "tiles_porcelain_white" },
        ],
        furniture: [
          { id: "s", product: "sofa1", position: [2, 4.2], facing: "south" },
          { id: "l", product: "lamp1", position: [0.5, 4.5] },
          { id: "t", type: "coffee_table", position: [2, 3] },
        ],
        casework: [
          {
            id: "k", type: "kitchen", system: "ikea_metod", path: [[4.2, 4.9], [7.9, 4.9]],
            modules: [{ kind: "base_drawers", width: 0.8, product: "base80" }, { kind: "sink", width: 0.8, product: "base80" }, { kind: "base_doors", width: 0.6 }, { kind: "filler", width: "auto" }],
            products: [{ product: "worktop", qty: 2 }],
            ...kitchen,
          },
        ],
        lights: [{ id: "dl", type: "downlight", room: "Living room", spacing: 1.5, margin: 0.75 }],
        ...extra,
      },
    ],
  };
}

test("METOD runs: IKEA dimensions and METOD widths", () => {
  const ok = compile(flat());
  assert.ok(ok.ok, ok.errors.join("\n"));
  assert.ok(!ok.warnings.some((w) => /METOD cabinets come in/.test(w)), ok.warnings.join("\n"));
  const odd = compile(flat({}, { modules: [{ kind: "base_drawers", width: 0.75, product: "base80" }, { kind: "filler", width: "auto" }] }));
  assert.ok(odd.warnings.some((w) => /75 cm wide — METOD cabinets come in 20\/30\/40\/60\/80 cm/.test(w)));
  const bad = compile(flat({}, { products: [{ product: "nope", qty: 1 }] }));
  assert.ok(bad.errors.some((e) => /casework 'k': unknown product 'nope'/.test(e)));
});

test("shopping list counts casework modules and run products", () => {
  const { lines } = shoppingList(flat() as never);
  const q = Object.fromEntries(lines.map((l) => [l.product, l.quantity]));
  assert.deepEqual(q, { sofa1: 1, lamp1: 1, base80: 2, worktop: 2 });
});

test("cost estimate: measured quantities, vendor prices, allowances, percentages", () => {
  const c = compile(flat());
  const bill = estimate(c);
  const line = (re: RegExp) => bill.sections.flatMap((s) => s.lines).find((l) => re.test(l.description))!;
  // floors by room area
  assert.equal(line(/Floor finish: wood herringbone oak/).qty, 20);
  // researched market rate, with its source in the appendix
  const hb = line(/Floor finish: wood herringbone oak/);
  assert.equal(hb.rateSource, "market");
  assert.equal(hb.rate, marketRate("floor:herringbone")!.value);
  assert.ok(bill.sources.some((m) => m.key === "floor:herringbone" && /^https?:\/\//.test(m.url)));
  assert.equal(line(/^Test sofa/).rateSource, "vendor");
  const cov = Object.values(bill.coverage).reduce((a, x) => a + x, 0);
  assert.ok(Math.abs(cov - bill.trades - bill.retail) < 0.05, `coverage ${cov} vs ${bill.trades + bill.retail}`);
  // vendor prices, currency conversion (USD → KWD), casework products
  assert.equal(line(/^Test sofa/).amount, 300);
  assert.equal(line(/^Test lamp/).rate, 6.14);
  assert.equal(line(/k: METOD base cabinet 80/).qty, 2);
  assert.equal(line(/k: assembly & installation/).qty, 2);
  // allowance for unproduced furniture, doors, windows, electrical, plumbing
  assert.equal(line(/coffee table \(allowance\)/).basis, "allowance");
  assert.equal(line(/Entrance door set/).qty, 1);
  assert.equal(line(/Internal door set/).qty, 1);
  assert.ok(Math.abs(line(/Windows: aluminium/).qty - 1.8) < 1e-9);
  assert.ok(line(/Double socket outlet/).qty >= 4);
  assert.equal(line(/Light fixture: downlight/).qty, 9);
  // furniture carries no overhead & profit; contingency on everything
  const op = bill.adjustments.find((a) => /overhead/.test(a.label))!;
  const prelim = bill.adjustments.find((a) => /Preliminaries/.test(a.label))!;
  assert.ok(Math.abs(op.amount - (bill.trades + prelim.amount) * (op.percent / 100)) < 0.02);
  assert.ok(Math.abs(bill.total - (bill.trades + bill.retail + bill.adjustments.reduce((a, x) => a + x.amount, 0))) < 0.02);
  // overrides
  const c2 = compile({ ...flat(), costs: { rates: { "floor:herringbone": 40 }, contingency: 0, currency: "KWD" } });
  const b2 = estimate(c2);
  const hb2 = b2.sections.flatMap((s) => s.lines).find((l) => /herringbone/.test(l.description))!;
  assert.equal(hb2.rate, 40);
  assert.equal(hb2.rateSource, "override");
  assert.ok(!b2.adjustments.some((a) => /Contingency/.test(a.label)));
  // formats
  assert.match(billMarkdown(bill), /\*\*Total\*\*/);
  assert.match(billCsv(bill), /^section,ref,description/);
  assert.match(billHtml(bill), /<title>Cost estimate — Cost test<\/title>/);
});

test("market rates: every researched rate is sourced and positive", () => {
  const all = marketRates();
  assert.ok(all.length > 100);
  for (const m of all) {
    assert.ok(m.value! > 0 || m.key === "vat", m.key);
    assert.match(m.url, /^https?:\/\//, m.key);
    assert.ok(m.source && m.accessed, m.key);
  }
  // window treatment types map onto the researched keys
  assert.ok(marketRate("treatment:roller") && marketRate("treatment:roman") && marketRate("treatment:curtains_and_sheers"));
});
