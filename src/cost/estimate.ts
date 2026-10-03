/**
 * Cost estimate (bill of quantities) measured from the compiled model:
 * floor / wall / ceiling finishes by material, partitions, doors, windows and treatments, built-in joinery
 * (real products such as IKEA METOD at their prices, parametric runs per metre), electrical points, light fixtures
 * and circuits, plumbing fixtures, pipe runs, stacks and heaters, furniture (vendor products at their prices,
 * the rest as allowances) and outdoor works; then preliminaries, overhead & profit, contingency, fees and VAT.
 *
 * Unit rates are keyed (e.g. "floor:herringbone", "point:double_socket") and resolve in order: project.costs.rates
 * override → researched Kuwait market rate (data/market-rates/kw, compiled to market_kw.ts, each with its source URL)
 * → built-in indicative rate. Every line records which one it used.
 */
import type { Compiled } from "../pipeline.js";
import { FURNITURE } from "../elements/furniture.js";
import { resolveLevelCasework } from "../elements/casework.js";
import { pointInPolygon, polygonArea, v2, type Vec2 } from "../geometry/math.js";
import { resolveMaterial } from "../materials/library.js";
import { roomFinishBands } from "../render/plan-sheets.js";
import type { Product } from "../elements/products.js";
import { marketRate, type MarketRate } from "./market.js";

export interface BillLine {
  code: string;
  description: string;
  qty: number;
  unit: string;
  rate: number;
  amount: number;
  basis: "measured" | "vendor" | "allowance" | "count";
  /** Rate key (override with project.costs.rates[key]). */
  key?: string;
  url?: string;
  /** Where the rate came from: vendor product page, your override, researched market rate, or the built-in fallback. */
  rateSource?: "vendor" | "override" | "market" | "indicative";
}

export interface BillSection {
  code: string;
  name: string;
  /** Retail goods (furniture) carry no contractor overhead & profit. */
  retail?: boolean;
  lines: BillLine[];
  subtotal: number;
}

export interface Bill {
  project: string;
  currency: string;
  date: string;
  sections: BillSection[];
  trades: number;
  retail: number;
  adjustments: { label: string; percent: number; amount: number }[];
  total: number;
  notes: string[];
  ratesUsed: Record<string, number>;
  /** Researched market rates used, with sources. */
  sources: MarketRate[];
  /** Share of the measured bill (before percentages) by rate source. */
  coverage: Record<"vendor" | "override" | "market" | "indicative", number>;
}

// ---------------------------------------------------------------------------
// default rates (KWD)

export const DEFAULT_RATES: Record<string, number> = {
  // floors (m²) by pattern
  "floor:wood_planks": 18, "floor:wood_grain": 18, "floor:herringbone": 28, "floor:chevron": 30, "floor:parquet": 26, "floor:tiles": 13,
  "floor:hex_tiles": 18, "floor:mosaic": 30, "floor:zellige": 35, "floor:terrazzo": 32, "floor:marble": 45, "floor:stone": 30,
  "floor:microcement": 24, "floor:concrete": 12, "floor:carpet": 9, "floor:gravel": 6, "floor:paving": 10, "floor:plaster": 15, "floor:other": 15,
  // walls (m²) by pattern
  "wall:plaster": 2.8, "wall:wallpaper": 8, "wall:grasscloth": 15, "wall:fabric": 12, "wall:tiles": 14, "wall:zellige": 34, "wall:mosaic": 28,
  "wall:hex_tiles": 18, "wall:fluted": 42, "wall:microcement": 26, "wall:marble": 48, "wall:wood_grain": 35, "wall:wood_planks": 35,
  "wall:brick": 22, "wall:stone": 30, "wall:concrete": 20, "wall:other": 10, "wainscot:panels": 32,
  skirting: 3.5, cornice: 4.5, rail: 3, "floor:border": 12, threshold: 25,
  // ceilings
  "ceiling:gypsum": 7.5, "ceiling:skim": 2.5, "ceiling:soffit": 9, "ceiling:cove": 6, "ceiling:beam": 28, "ceiling:coffer": 18,
  // construction
  partition: 16, "shell:slab": 22, "shell:exterior_wall": 30, "shell:roof": 35, "railing:glass": 95, "railing:bars": 60, "railing:solid": 40,
  // doors & windows
  "door:single": 140, "door:double": 260, "door:sliding": 320, "door:glass": 220, "door:garage": 650, "door:front": 380, "door:opening": 35,
  window: 105, "treatment:curtains": 22, "treatment:sheers": 15, "treatment:roman": 18, "treatment:roller": 18, "treatment:venetian": 20, "treatment:shutters": 45,
  // joinery (parametric runs without products)
  "joinery:kitchen_base": 150, "joinery:kitchen_upper": 105, "joinery:kitchen_tall": 280, "joinery:worktop": 85, "joinery:wardrobe": 240,
  "joinery:vanity": 220, "joinery:media": 200, "joinery:shelving": 140, "joinery:desk": 120, "joinery:bench": 120,
  "install:cabinet": 12, "install:worktop": 20, "install:appliance": 15, "appliance:dishwasher": 180, "appliance:extractor": 90,
  // electrical
  "point:switch": 12, "point:switch_2way": 16, "point:dimmer": 22, "point:double_socket": 14, "point:socket": 12, "point:usb_socket": 18,
  "point:data": 20, "point:tv": 18, "point:shaver": 28, "point:cooker": 30, "point:spur": 18, "point:fan": 35, "point:ac": 280, "point:db": 220,
  "point:smoke": 18, "point:heat": 20, "point:doorbell": 25, "point:light_point": 10, circuit: 30,
  "fixture:downlight": 9, "fixture:pendant": 45, "fixture:chandelier": 160, "fixture:ceiling": 30, "fixture:spot": 15, "fixture:track": 55,
  "fixture:wall_sconce": 28, "fixture:strip": 35, "fixture:uplight": 25,
  // plumbing
  "sanitary:wc": 140, "sanitary:basin": 90, "sanitary:shower": 320, "sanitary:bath": 750, "sanitary:sink": 110, "sanitary:floor_drain": 18, "sanitary:tap": 25,
  "plumbing:first_fix": 35, "pipe:cold": 3.5, "pipe:hot": 4.5, "pipe:waste": 6, "pipe:soil": 9, "plumbing:stack": 65, "plumbing:water_heater": 95, "plumbing:inlet": 40,
};

/** Furniture allowances (no product) by type. */
const FURNITURE_ALLOWANCE: Record<string, number> = {
  sofa: 350, sectional_sofa: 650, armchair: 140, lounge_chair: 160, accent_chair: 120, wingback_chair: 180, chair: 45, dining_bench: 90, bench: 70,
  table: 220, round_dining_table: 200, coffee_table: 80, side_table: 35, console_table: 90, desk: 120, office_chair: 70, bar_stool: 35, counter_stool: 35,
  bed: 250, platform_bed: 300, canopy_bed: 450, bunk_bed: 220, kids_bed: 150, crib: 120, daybed: 220, nightstand: 45, wardrobe: 220, dresser: 160,
  dressing_table: 120, bookshelf: 70, sideboard: 180, tv_stand: 90, tv: 220, rug: 70, mirror: 35, mirror_round: 35, mirror_arched: 50, mirror_full_length: 45,
  floor_lamp: 35, table_lamp: 18, ceiling_light: 30, curtain: 30, plant: 15, plant_large: 30, plant_herbs: 5, hanging_plant: 12, ottoman: 40,
  wall_art: 35, gallery_wall: 60, floating_shelf: 12, wall_shelves: 25, vase: 8, books_stack: 10, decor_bowl: 8, candle_set: 6, cushion: 6, throw_blanket: 10,
  sculpture: 20, tray_with_decor: 10, lantern: 12, bar_cart: 45, piano: 900, filing_cabinet: 50, toy_box: 25, coat_rack: 15, shoe_cabinet: 40,
  umbrella_stand: 8, laundry_basket: 6, ironing_board: 12, kettle: 12, coffee_machine: 60, fruit_bowl: 6, cutting_boards: 6, utensil_jar: 4,
  towel_rail: 25, towel_hook_set: 6, toilet_roll_holder: 4, bath_mat: 6, soap_dispenser: 4, shower_curtain: 6, washing_machine: 160, fridge: 220,
  stove: 150, dishwasher: 180, radiator: 60, fireplace: 600, outdoor_sofa: 280, outdoor_table: 90, garden_chair: 30, sun_lounger: 70, parasol: 45,
  planter: 25, bbq: 120, hot_tub: 1800, trash_bin: 10, bedding: 45, box: 30,
};
/** Sanitary ware modelled as furniture: priced under plumbing, not furniture. */
const SANITARY: Record<string, string> = { toilet: "wc", bathroom_sink: "basin", bathtub: "bath", freestanding_bathtub: "bath", shower: "shower", sink_counter: "sink" };
/** Landscape items left out of a fit-out bill. */
const SKIP = new Set(["tree", "bush", "hedge", "car", "bicycle", "mailbox", "lamp_post", "fence", "door_mat", "crate", "cylinder"]);

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

// ---------------------------------------------------------------------------

export function estimate(c: Compiled): Bill {
  const project = c.project!;
  const costs = project.costs;
  const cur = costs.currency;
  const used: Record<string, number> = {};
  const provenance: Record<string, { src: "override" | "market" | "indicative"; m?: MarketRate }> = {};
  /** Override → researched market rate → built-in fallback, for the key then its fallback key. */
  const lookup = (key: string): { v: number; src: "override" | "market" | "indicative"; m?: MarketRate } | undefined => {
    if (costs.rates[key] !== undefined) return { v: costs.rates[key], src: "override" };
    const m = marketRate(key);
    if (m && m.value !== null) return { v: m.value, src: "market", m };
    if (DEFAULT_RATES[key] !== undefined) return { v: DEFAULT_RATES[key], src: "indicative" };
    return undefined;
  };
  const rate = (key: string, fallback?: string): number => {
    const hit = lookup(key) ?? (fallback !== undefined ? lookup(fallback) : undefined);
    const k = lookup(key) ? key : fallback ?? key;
    const r = hit?.v ?? 0;
    used[k] = r;
    provenance[k] = { src: hit?.src ?? "indicative", m: hit?.m };
    return r;
  };
  const FX: Record<string, number> = { USD: 0.307, EUR: 0.33, GBP: 0.39, AED: 0.0836, SAR: 0.0818, QAR: 0.0843, BHD: 0.815, OMR: 0.798, KWD: 1, ...costs.exchange };
  const notes: string[] = [];
  const fx = (amount: number, from?: string) => {
    if (!from || from === cur) return amount;
    const a = FX[from], b = FX[cur];
    if (!a || !b) {
      notes.push(`no exchange rate ${from} → ${cur}; ${from} prices are added as-is (set costs.exchange)`);
      return amount;
    }
    return (amount * a) / b;
  };
  const sections = new Map<string, BillSection>();
  const sec = (code: string, name: string, retail = false) => {
    let s = sections.get(code);
    if (!s) sections.set(code, (s = { code, name, retail, lines: [], subtotal: 0 }));
    return s;
  };
  const add = (s: BillSection, l: Omit<BillLine, "amount" | "code"> & { amount?: number }) => {
    if (l.qty <= 0) return;
    const amount = round(l.amount ?? l.qty * l.rate);
    s.lines.push({ ...l, code: `${s.code}.${s.lines.length + 1}`, qty: round(l.qty), rate: round(l.rate), amount });
  };
  const products = new Map<string, Product>(project.products.map((p) => [p.id, p]));
  const label = (m: string) => (m.startsWith("#") ? `paint ${m}` : m.replace(/_/g, " "));
  const pattern = (m: string) => {
    try {
      const d = c.materials.get(m) ?? resolveMaterial(m, project.materials as never);
      return d.pattern;
    } catch {
      return "other";
    }
  };
  const D = project.defaults;

  // aggregate measured quantities across levels, then emit lines
  const floors = new Map<string, number>(), walls = new Map<string, number>(), accents = new Map<string, number>(), wainscots = new Map<string, number>();
  let skirting = 0, cornice = 0, rails = 0, borders = 0, thresholds = 0, partitions = 0, extWalls = 0, slabs = 0, roofs = 0;
  let gypsum = 0, skim = 0, soffit = 0, cove = 0, beams = 0, coffer = 0;
  const doors = new Map<string, number>(), treatments = new Map<string, number>();
  let windows = 0, windowCount = 0;
  const points = new Map<string, number>(), fixtures = new Map<string, number>(), sanitary = new Map<string, number>(), pipes = new Map<string, number>();
  let circuits = 0, stacks = 0, heaters = 0, drains = 0, inlets = 0, firstFix = 0;
  const railings = new Map<string, number>(), decks = new Map<string, number>();
  const furniture = new Map<string, { qty: number; product?: Product; type: string }>();
  const joinery = sec("E", "Built-in joinery & kitchens");

  project.levels.forEach((lv, li) => {
    const info = c.levels[li];
    if (!info) return;
    // ---- floors, walls, ceilings per room ----
    lv.rooms.forEach((r, ri) => {
      const pg = r.polygon as Vec2[];
      const area = polygonArea(pg);
      const fm = r.floorMaterial ?? D.floorMaterial;
      floors.set(fm, (floors.get(fm) ?? 0) + area);
      const cl = info.ceilings[ri];
      const H = cl?.height ?? info.height - 0.2;
      const fin = r.finishes;
      const bands = roomFinishBands(r, info, D.wallMaterial, 0.01);
      for (const b of bands) {
        const len = v2.dist(b.a, b.b);
        const wh = fin?.wainscot?.height ?? 0;
        if (b.accent && !b.partial) accents.set(b.material, (accents.get(b.material) ?? 0) + len * (H - wh));
        else walls.set(b.material, (walls.get(b.material) ?? 0) + len * (H - wh));
        if (fin?.wainscot) {
          const key = fin.wainscot.style === "panels" ? "panels" : fin.wainscot.material;
          wainscots.set(key, (wainscots.get(key) ?? 0) + len * wh);
        }
        if (fin?.skirting) skirting += len;
        if (fin?.cornice) cornice += len;
        if (fin?.pictureRail || fin?.dadoRail) rails += len;
      }
      if (fin?.floorBorder) borders += pg.reduce((a, p, i) => a + v2.dist(p, pg[(i + 1) % pg.length]), 0);
      if (fin?.threshold) thresholds += info.openings.filter((o) => o.op.type !== "window" && pg.some((p, i) => distToSeg(v2.add(o.seg.a, v2.scale(v2.norm(v2.sub(o.seg.b, o.seg.a)), o.u)), p, pg[(i + 1) % pg.length]) < 0.3)).length;
      if (cl && cl.type !== "none") {
        if (cl.structure - cl.height > 0.02 || cl.type === "tray") gypsum += area;
        else skim += area;
        if (cl.soffit && cl.type === "tray") soffit += perimeter(cl.soffit.inner);
        if (cl.cove) cove += perimeter(cl.cove.line);
        if (cl.type === "beams") beams += cl.beams.reduce((a, b) => a + v2.dist(b.a, b.b), 0);
        if (cl.type === "coffered") coffer += area;
      }
    });
    // ---- partitions / shell ----
    for (const s of info.segments) {
      const len = v2.dist(s.a, s.b), h = s.z1 - s.z0;
      const holes = s.holes.reduce((a, hh) => a + (hh.u1 - hh.u0) * ((hh.z1 ?? s.z1) - (hh.z0 ?? s.z0)), 0);
      if (s.exterior) extWalls += Math.max(0, len * h - holes);
      else partitions += Math.max(0, len * h - holes);
    }
    for (const sl of lv.slabs) slabs += polygonArea(sl.polygon as Vec2[]);
    for (const rf of lv.roofs) roofs += polygonArea(rf.polygon as Vec2[]);
    // ---- openings ----
    for (const o of info.openings) {
      if (o.op.type === "window") {
        windows += o.width * o.height;
        windowCount++;
      } else if (o.op.type === "door") {
        const front = o.seg.exterior && !o.style.match(/sliding|glass|garage/);
        const k = front ? "front" : o.style === "single" ? "single" : o.style;
        doors.set(k, (doors.get(k) ?? 0) + 1);
      } else doors.set("opening", (doors.get("opening") ?? 0) + 1);
      const t = o.op.treatment;
      if (t) {
        const tt = (t as { type?: string }).type ?? "curtains";
        const tk = ({ roller_blind: "roller", roman_blind: "roman" } as Record<string, string>)[tt] ?? tt;
        treatments.set(tk, (treatments.get(tk) ?? 0) + (o.width + 0.4) * (o.height + 0.3));
      }
    }
    // ---- services ----
    const sv = info.services;
    for (const e of sv.electrical) points.set(e.type, (points.get(e.type) ?? 0) + 1);
    for (const g of sv.groups) if (g.type !== "light_point") fixtures.set(g.type, (fixtures.get(g.type) ?? 0) + (g.type === "strip" || g.type === "track" ? 1 : g.pts.length));
    circuits += sv.circuits.length;
    const kitchenProductsCoverSink = lv.casework.some((cw) => cw.products?.some((x) => /sink|tap/i.test(products.get(x.product)?.name ?? "")));
    for (const f of sv.fixtures) {
      firstFix += f.kind === "floor_drain" ? 0 : 1;
      if (f.kind === "floor_drain") drains++;
      else if (f.kind === "dishwasher" || f.kind === "washing_machine") continue; // appliances: connection only
      else if (f.kind === "sink" && kitchenProductsCoverSink) continue;
      else if (f.kind === "basin" && !f.poly) sanitary.set("basin", (sanitary.get("basin") ?? 0) + 1);
    }
    for (const p of sv.pipes) pipes.set(p.kind, (pipes.get(p.kind) ?? 0) + polyLen(p.pts));
    for (const p of sv.points) {
      if (p.type === "stack" && p.auto !== undefined) stacks++;
      else if (p.type === "water_heater") heaters++;
      else if (p.type === "inlet") inlets++;
    }
    // ---- outdoor ----
    for (const t of lv.terraces) {
      const m = t.material;
      decks.set(m, (decks.get(m) ?? 0) + polygonArea(t.polygon as Vec2[]));
    }
    for (const r of lv.railings) railings.set(r.style, (railings.get(r.style) ?? 0) + polyLen(r.points as Vec2[]));
    // ---- furniture ----
    for (const f of lv.furniture) {
      if (SKIP.has(f.type)) continue;
      if (SANITARY[f.type] && !f.product) {
        sanitary.set(SANITARY[f.type], (sanitary.get(SANITARY[f.type]) ?? 0) + 1);
        continue;
      }
      const key = f.product ? `p:${f.product}` : `t:${f.type}`;
      const e = furniture.get(key) ?? { qty: 0, product: f.product ? products.get(f.product) : undefined, type: f.type };
      e.qty++;
      furniture.set(key, e);
    }
    // ---- joinery ----
    const runs = resolveLevelCasework(project, li, info);
    lv.casework.forEach((cw, ci) => {
      const run = runs[ci];
      const name = `${cw.id ?? `${cw.type} ${ci + 1}`}`;
      const prodMods = [...cw.modules, ...cw.uppers].filter((m) => m.product);
      if (prodMods.length || cw.products.length) {
        // real products (IKEA METOD and friends)
        const counts = new Map<string, number>();
        for (const m of prodMods) counts.set(m.product!, (counts.get(m.product!) ?? 0) + 1);
        for (const x of cw.products) counts.set(x.product, (counts.get(x.product) ?? 0) + x.qty);
        for (const [pid, q] of counts) {
          const p = products.get(pid);
          if (!p) continue;
          add(joinery, { description: `${name}: ${p.name}${p.sku ? ` (${p.vendor ?? ""} ${p.sku})` : ""}`, qty: q, unit: "no", rate: fx(p.price ?? 0, p.currency), basis: "vendor", url: p.url });
        }
        const cabinets = prodMods.length;
        const worktops = cw.products.filter((x) => /worktop/i.test(products.get(x.product)?.name ?? "")).reduce((a, x) => a + x.qty, 0);
        const appliances = cw.products.filter((x) => /oven|hob|fridge|freezer|dishwasher|hood/i.test(products.get(x.product)?.name ?? "")).reduce((a, x) => a + x.qty, 0);
        add(joinery, { description: `${name}: assembly & installation of cabinets`, qty: cabinets, unit: "no", rate: rate("install:cabinet"), basis: "count", key: "install:cabinet" });
        add(joinery, { description: `${name}: worktop cutting, jointing & fitting`, qty: worktops, unit: "no", rate: rate("install:worktop"), basis: "count", key: "install:worktop" });
        add(joinery, { description: `${name}: appliance connection`, qty: appliances, unit: "no", rate: rate("install:appliance"), basis: "count", key: "install:appliance" });
        // appliances the plan shows but no product covers
        const kinds = [...cw.modules, ...cw.uppers].map((m) => m.kind);
        const named = cw.products.map((x) => products.get(x.product)?.name ?? "").join(" ");
        if (kinds.includes("dishwasher") && !/dishwasher\b(?!.*front)/i.test(named.replace(/fronts? for dishwasher/gi, "")))
          add(joinery, { description: `${name}: integrated dishwasher (appliance allowance)`, qty: 1, unit: "no", rate: rate("appliance:dishwasher"), basis: "allowance", key: "appliance:dishwasher" });
        if (kinds.includes("hood") && !/extractor hood|cooker hood/i.test(named))
          add(joinery, { description: `${name}: extractor unit (appliance allowance)`, qty: 1, unit: "no", rate: rate("appliance:extractor"), basis: "allowance", key: "appliance:extractor" });
        return;
      }
      // parametric run: per metre / per unit
      if (!run) return;
      const len = (row: string) => [...run.base, ...run.uppers].filter((p) => p.row === row).reduce((a, p) => a + (p.x1 - p.x0), 0);
      const talls = run.base.filter((p) => p.row === "tall").length;
      if (cw.type === "kitchen") {
        add(joinery, { description: `${name}: base cabinets incl. fronts & hardware`, qty: len("base"), unit: "m", rate: rate("joinery:kitchen_base"), basis: "measured", key: "joinery:kitchen_base" });
        add(joinery, { description: `${name}: wall cabinets`, qty: len("upper"), unit: "m", rate: rate("joinery:kitchen_upper"), basis: "measured", key: "joinery:kitchen_upper" });
        add(joinery, { description: `${name}: tall units`, qty: talls, unit: "no", rate: rate("joinery:kitchen_tall"), basis: "count", key: "joinery:kitchen_tall" });
        add(joinery, { description: `${name}: worktop`, qty: run.spans.reduce((a, s) => a + (s.x1 - s.x0), 0), unit: "m", rate: rate("joinery:worktop"), basis: "measured", key: "joinery:worktop" });
      } else {
        const k = `joinery:${cw.type}`;
        const total = run.base.reduce((a, p) => a + (p.x1 - p.x0), 0);
        add(joinery, { description: `${name}: ${cw.type} joinery (supply & install)`, qty: total, unit: "m", rate: rate(k, "joinery:shelving"), basis: "measured", key: k });
        if (cw.type === "vanity") sanitary.set("basin", (sanitary.get("basin") ?? 0) + run.base.filter((p) => p.kind === "basin").length);
      }
      if (cw.type === "kitchen" && run.base.some((p) => p.kind === "sink")) sanitary.set("sink", (sanitary.get("sink") ?? 0) + 1);
    });
  });

  // ---- emit sections in order ----
  if (costs.scope === "full") {
    const s = sec("A", "Shell & structure");
    add(s, { description: "Floor slabs", qty: slabs, unit: "m²", rate: rate("shell:slab"), basis: "measured", key: "shell:slab" });
    add(s, { description: "External walls incl. render & paint", qty: extWalls, unit: "m²", rate: rate("shell:exterior_wall"), basis: "measured", key: "shell:exterior_wall" });
    add(s, { description: "Roofs incl. waterproofing & insulation", qty: roofs, unit: "m²", rate: rate("shell:roof"), basis: "measured", key: "shell:roof" });
  }
  const B = sec("B", "Partitions, floors & walls");
  add(B, { description: "Internal partitions incl. plaster both faces", qty: partitions, unit: "m²", rate: rate("partition"), basis: "measured", key: "partition" });
  for (const [m, a] of [...floors].sort((x, y) => y[1] - x[1])) {
    const k = `floor:${m}`;
    add(B, { description: `Floor finish: ${label(m)}`, qty: a, unit: "m²", rate: rate(k, `floor:${pattern(m)}`), basis: "measured", key: costs.rates[k] !== undefined ? k : `floor:${pattern(m)}` });
  }
  add(B, { description: "Floor border inlay", qty: borders, unit: "m", rate: rate("floor:border"), basis: "measured", key: "floor:border" });
  add(B, { description: "Thresholds", qty: thresholds, unit: "no", rate: rate("threshold"), basis: "count", key: "threshold" });
  for (const [m, a] of [...walls].sort((x, y) => y[1] - x[1])) {
    const k = `wall:${m}`, pk = `wall:${pattern(m)}`;
    add(B, { description: `Wall finish: ${label(m)}`, qty: a, unit: "m²", rate: rate(k, pk), basis: "measured", key: costs.rates[k] !== undefined ? k : pk });
  }
  for (const [m, a] of accents) {
    const pk = `wall:${pattern(m)}`;
    add(B, { description: `Feature / accent wall: ${label(m)}`, qty: a, unit: "m²", rate: rate(`wall:${m}`, pk), basis: "measured", key: pk });
  }
  for (const [m, a] of wainscots) {
    const k = m === "panels" ? "wainscot:panels" : `wall:${pattern(m)}`;
    add(B, { description: m === "panels" ? "Panelled wainscoting" : `Wainscot / tiled band: ${label(m)}`, qty: a, unit: "m²", rate: rate(k, "wall:other"), basis: "measured", key: k });
  }
  add(B, { description: "Skirting", qty: skirting, unit: "m", rate: rate("skirting"), basis: "measured", key: "skirting" });
  add(B, { description: "Picture / dado rails", qty: rails, unit: "m", rate: rate("rail"), basis: "measured", key: "rail" });

  const C = sec("C", "Ceilings");
  add(C, { description: "Suspended gypsum ceiling incl. paint", qty: gypsum, unit: "m²", rate: rate("ceiling:gypsum"), basis: "measured", key: "ceiling:gypsum" });
  add(C, { description: "Slab soffit skim & paint", qty: skim, unit: "m²", rate: rate("ceiling:skim"), basis: "measured", key: "ceiling:skim" });
  add(C, { description: "Tray ceiling soffit / bulkhead", qty: soffit, unit: "m", rate: rate("ceiling:soffit"), basis: "measured", key: "ceiling:soffit" });
  add(C, { description: "LED cove (profile, strip, driver)", qty: cove, unit: "m", rate: rate("ceiling:cove"), basis: "measured", key: "ceiling:cove" });
  add(C, { description: "Exposed timber beams", qty: beams, unit: "m", rate: rate("ceiling:beam"), basis: "measured", key: "ceiling:beam" });
  add(C, { description: "Coffered ceiling (extra over)", qty: coffer, unit: "m²", rate: rate("ceiling:coffer"), basis: "measured", key: "ceiling:coffer" });
  add(C, { description: "Cornice", qty: cornice, unit: "m", rate: rate("cornice"), basis: "measured", key: "cornice" });

  const Dd = sec("D", "Doors, windows & window treatments");
  const DOOR_NAMES: Record<string, string> = { front: "Entrance door set (solid, ironmongery, lock)", single: "Internal door set (leaf, frame, ironmongery)", double: "Double door set", sliding: "Sliding door set", glass: "Glazed door set", garage: "Garage door", opening: "Open doorway: lining & trims" };
  for (const [k, n] of doors) add(Dd, { description: DOOR_NAMES[k] ?? `${k} door`, qty: n, unit: "no", rate: rate(`door:${k}`, "door:single"), basis: "count", key: `door:${k}` });
  add(Dd, { description: `Windows: aluminium, double glazed (${windowCount} no)`, qty: windows, unit: "m²", rate: rate("window"), basis: "measured", key: "window" });
  for (const [k, a] of treatments) add(Dd, { description: `Window treatment: ${k.replace(/_/g, " ")}`, qty: a, unit: "m²", rate: rate(`treatment:${k}`, "treatment:curtains"), basis: "measured", key: `treatment:${k}` });

  sections.delete("E");
  if (joinery.lines.length) sections.set("E", joinery);

  const F = sec("F", "Electrical & lighting");
  const PN: Record<string, string> = {
    switch: "Switch", switch_2way: "2-way switch", dimmer: "Dimmer", double_socket: "Double socket outlet", socket: "Socket outlet", usb_socket: "USB socket", data: "Data point (Cat6)",
    tv: "TV point", shaver: "Shaver socket", cooker: "Cooker control unit", spur: "Fused spur / appliance point", fan: "Extract fan incl. ducting", ac: "Split AC unit incl. installation",
    db: "Distribution board incl. breakers & RCDs", smoke: "Smoke detector (interlinked)", heat: "Heat detector", doorbell: "Doorbell", light_point: "Lighting point",
  };
  for (const [k, n] of [...points].sort((a, b) => b[1] - a[1])) add(F, { description: `${PN[k] ?? k} — wiring & device`, qty: n, unit: "no", rate: rate(`point:${k}`), basis: "count", key: `point:${k}` });
  for (const [k, n] of fixtures) add(F, { description: `Light fixture: ${k.replace(/_/g, " ")}`, qty: n, unit: "no", rate: rate(`fixture:${k}`), basis: "count", key: `fixture:${k}` });
  // fixture prices are supply + fitting only: each fitting also needs its wiring point
  const fixtureCount = [...fixtures.values()].reduce((a, n) => a + n, 0);
  add(F, { description: "Lighting point wiring for the fixtures above (cable, conduit, box)", qty: fixtureCount, unit: "no", rate: rate("point:light_point"), basis: "count", key: "point:light_point" });
  add(F, { description: "Final circuits (cabling, containment)", qty: circuits, unit: "no", rate: rate("circuit"), basis: "count", key: "circuit" });

  const G = sec("G", "Plumbing & sanitary ware");
  const SN: Record<string, string> = { wc: "WC suite incl. cistern & seat", basin: "Basin incl. mixer & waste", shower: "Shower: mixer, drain & glass screen", bath: "Bath incl. filler & waste", sink: "Kitchen sink incl. mixer" };
  for (const [k, n] of sanitary) add(G, { description: SN[k] ?? k, qty: n, unit: "no", rate: rate(`sanitary:${k}`), basis: "count", key: `sanitary:${k}` });
  add(G, { description: "Floor drains", qty: drains, unit: "no", rate: rate("sanitary:floor_drain"), basis: "count", key: "sanitary:floor_drain" });
  add(G, { description: "First fix per fixture (valves, connections)", qty: firstFix, unit: "no", rate: rate("plumbing:first_fix"), basis: "count", key: "plumbing:first_fix" });
  const PIPE: Record<string, string> = { cold: "Cold water pipework (PPR)", hot: "Hot water pipework, insulated", waste: "Waste pipework (uPVC)", soil: "Soil pipework 100 mm (uPVC)" };
  for (const [k, m] of pipes) add(G, { description: PIPE[k], qty: m, unit: "m", rate: rate(`pipe:${k}`), basis: "measured", key: `pipe:${k}` });
  add(G, { description: "Soil / waste stack connections", qty: stacks, unit: "no", rate: rate("plumbing:stack"), basis: "count", key: "plumbing:stack" });
  add(G, { description: "Electric water heaters", qty: heaters, unit: "no", rate: rate("plumbing:water_heater"), basis: "count", key: "plumbing:water_heater" });
  add(G, { description: "Main stop valve & meter connection", qty: inlets, unit: "no", rate: rate("plumbing:inlet"), basis: "count", key: "plumbing:inlet" });

  const H = sec("H", "Furniture, furnishings & decor", true);
  const furn = [...furniture.values()].sort((a, b) => Number(!!b.product) - Number(!!a.product) || (b.product?.price ?? 0) * b.qty - (a.product?.price ?? 0) * a.qty);
  for (const f of furn) {
    if (f.product)
      add(H, { description: `${f.product.name}${f.product.sku ? ` (${f.product.vendor ?? ""} ${f.product.sku})` : ""}`, qty: f.qty, unit: "no", rate: fx(f.product.price ?? 0, f.product.currency), basis: "vendor", url: f.product.url });
    else {
      const k = `furniture:${f.type}`;
      const hit = lookup(k);
      const r = hit?.v ?? FURNITURE_ALLOWANCE[f.type] ?? Math.round(30 + 40 * ((FURNITURE[f.type]?.defaults.width ?? 0.5) * (FURNITURE[f.type]?.defaults.depth ?? 0.5)));
      used[k] = r;
      provenance[k] = { src: hit?.src ?? "indicative", m: hit?.m };
      add(H, { description: `${f.type.replace(/_/g, " ")} (allowance)`, qty: f.qty, unit: "no", rate: r, basis: "allowance", key: k });
    }
  }

  if (decks.size || railings.size) {
    const I = sec("I", "Terraces & outdoor");
    for (const [m, a] of decks) add(I, { description: `Terrace deck: ${label(m)}`, qty: a, unit: "m²", rate: rate(`floor:${m}`, `floor:${pattern(m)}`), basis: "measured", key: `floor:${pattern(m)}` });
    for (const [st, m] of railings) add(I, { description: `Balustrade: ${st}`, qty: m, unit: "m", rate: rate(`railing:${st}`), basis: "measured", key: `railing:${st}` });
  }

  // ---- totals ----
  const out = [...sections.values()].filter((s) => s.lines.length).sort((a, b) => a.code.localeCompare(b.code));
  // where every line's rate came from
  const coverage = { vendor: 0, override: 0, market: 0, indicative: 0 };
  for (const s of out)
    for (const l of s.lines) {
      l.rateSource = l.basis === "vendor" ? "vendor" : l.key ? provenance[l.key]?.src ?? "indicative" : "indicative";
      if (l.rateSource === "market" && !l.url) l.url = provenance[l.key!]?.m?.url;
      coverage[l.rateSource] += l.amount;
    }
  const pctOf = (k: string, fb: number) => {
    const m = marketRate(k);
    return m && m.value !== null ? m.value : fb;
  };
  const P = {
    preliminaries: costs.preliminaries ?? pctOf("pct:preliminaries", 4),
    overheadProfit: costs.overheadProfit ?? pctOf("pct:overheadProfit", 12),
    contingency: costs.contingency ?? pctOf("pct:contingency", 7.5),
    vat: costs.vat ?? pctOf("vat", 0),
  };
  for (const s of out) s.subtotal = round(s.lines.reduce((a, l) => a + l.amount, 0));
  const trades = round(out.filter((s) => !s.retail).reduce((a, s) => a + s.subtotal, 0));
  const retail = round(out.filter((s) => s.retail).reduce((a, s) => a + s.subtotal, 0));
  const adjustments: Bill["adjustments"] = [];
  const pct = (labelText: string, percent: number, base: number) => {
    if (percent > 0) adjustments.push({ label: labelText, percent, amount: round((base * percent) / 100) });
  };
  pct("Preliminaries & site setup (on trades)", P.preliminaries, trades);
  pct("Contractor overhead & profit (on trades)", P.overheadProfit, trades + (adjustments[0]?.amount ?? 0));
  const sub = trades + retail + adjustments.reduce((a, x) => a + x.amount, 0);
  pct("Contingency", P.contingency, sub);
  pct("Design & supervision fee", costs.designFee, sub);
  const beforeVat = trades + retail + adjustments.reduce((a, x) => a + x.amount, 0);
  pct("VAT", P.vat, beforeVat);
  const total = round(trades + retail + adjustments.reduce((a, x) => a + x.amount, 0));
  notes.unshift(
    "Quantities are measured from the model. Unit rates are researched Kuwait market prices (supply + install unless stated; source, quote and read date in Rates & sources) where one was found, otherwise indicative; vendor lines use the product page price. Override any rate in project.costs.rates.",
    "Market rates are single quoted prices or mid-points of published ranges, not tenders — several are GCC (UAE/KSA) prices converted to KWD where no Kuwait price was published; check 'low' confidence lines with a local quote.",
    "Preliminaries, overhead & profit and contingency default to published GCC percentages for contractor-led work; for a small owner-managed fit-out set project.costs.preliminaries / overheadProfit lower.",
    "Vendor prices are as read from the product pages; delivery, assembly by the vendor and promotions are not included.",
    "Excludes: HVAC (except listed AC units), permits, base-building works outside the scope, loose kitchenware and soft goods not modelled.",
  );
  return {
    project: project.name, currency: cur, date: new Date().toISOString().slice(0, 10), sections: out, trades, retail, adjustments, total,
    notes: [...new Set(notes)], ratesUsed: Object.fromEntries(Object.entries(used).sort()),
    sources: [
      ...new Map(
        [...Object.values(provenance).filter((p) => p.src === "market" && p.m).map((p) => p.m!), ...["pct:preliminaries", "pct:overheadProfit", "pct:contingency", "vat", "benchmark:fitout_per_m2"].map(marketRate).filter((m): m is MarketRate => !!m)]
          .map((m) => [m.key, m]),
      ).values(),
    ].sort((a, b) => a.key.localeCompare(b.key)),
    coverage: Object.fromEntries(Object.entries(coverage).map(([k, v]) => [k, round(v)])) as Bill["coverage"],
  };
}

function perimeter(pg: Vec2[]): number {
  return pg.reduce((a, p, i) => a + v2.dist(p, pg[(i + 1) % pg.length]), 0);
}
function polyLen(pts: Vec2[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += v2.dist(pts[i - 1], pts[i]);
  return l;
}
function distToSeg(p: Vec2, a: Vec2, b: Vec2): number {
  const ab = v2.sub(b, a), t = Math.max(0, Math.min(1, v2.dot(v2.sub(p, a), ab) / (v2.dot(ab, ab) || 1)));
  return v2.dist(p, v2.add(a, v2.scale(ab, t)));
}
void pointInPolygon;
