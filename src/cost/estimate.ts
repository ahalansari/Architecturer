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
import { ensureCCW, offsetPolygon, pointInPolygon, polygonArea, v2, type Vec2 } from "../geometry/math.js";
import { constructionSystem, SLAB_TYPES, WALL_ASSEMBLIES, type WallAssemblyId } from "../elements/construction.js";
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

export type CostScope = "fitout" | "full";

export interface Bill {
  project: string;
  currency: string;
  date: string;
  /** fitout: interior fit-out of an existing shell; full: also the structure and shell. */
  scope: CostScope;
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
  /** Products with no vendor price, billed as allowances instead (worth researching). */
  unpriced: { id: string; name: string; url?: string; allowance: number }[];
  /** Built-up area: ground plus suspended floor slabs, m². */
  floorArea: number;
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
  // structure (RC: cement + steel) and masonry
  "struct:concrete_m3": 32, "struct:rebar_t": 260, "struct:formwork_m2": 4.5, "struct:blinding_m3": 25, "earthworks:m3": 3.5, "substructure:bitumen": 1.5,
  "struct:timber_floor": 25, "wall:block_100": 4.5, "wall:block_150": 5.5, "wall:block_200": 6.5, "wall:block_insulated_200": 9,
  "wall:cement_plaster": 2.2, "wall:render_external": 3.5, "wall:drywall": 9, "wall:glass_partition": 60, "wall:timber_stud": 14,
  "roof:waterproofing": 4, "roof:insulation": 4, "roof:screed_tiles": 7, "roof:tiles": 12, "floor:screed": 2.5,
  "screen:slats": 45, "pergola:timber": 55, "railing:glass": 95, "railing:bars": 60, "railing:solid": 40,
  // doors & windows
  "door:single": 140, "door:double": 260, "door:sliding": 320, "door:glass": 220, "door:garage": 650, "door:front": 380, "door:opening": 35,
  window: 105, "treatment:curtains": 22, "treatment:sheers": 15, "treatment:roman": 18, "treatment:roller": 18, "treatment:venetian": 20, "treatment:shutters": 45,
  // joinery (parametric runs without products)
  "joinery:kitchen_base": 150, "joinery:kitchen_upper": 105, "joinery:kitchen_tall": 280, "joinery:worktop": 85, "joinery:wardrobe": 240,
  "joinery:vanity": 220, "joinery:media": 200, "joinery:shelving": 140, "joinery:desk": 120, "joinery:bench": 120,
  "install:cabinet": 12, "install:worktop": 20, "install:appliance": 15, "lift:base": 9500, "lift:per_stop": 1200, "lift:home_lift": 8000, "lift:pit": 650, "lift:overrun": 900, "lift:power_supply": 150,
  "landscape:lawn": 3.5, "landscape:turf": 8, "landscape:planting": 6, "landscape:gravel": 2.5, "landscape:mulch": 2, "landscape:paving": 9, "landscape:sand": 1,
  "landscape:tree": 35, "landscape:palm": 180, "landscape:shrub": 4, "landscape:hedge": 9,
  "irrigation:spray_head": 4, "irrigation:drip_m": 0.5, "irrigation:bubbler": 3, "irrigation:emitter": 1, "irrigation:pipe_m": 0.8, "irrigation:valve": 35,
  "irrigation:valve_box": 25, "irrigation:controller": 90,
  "hvac:packaged_tr": 320, "hvac:ducted_split_tr": 300, "hvac:split_tr": 220, "hvac:duct_m2": 9, "hvac:diffuser": 15, "hvac:return_grille": 12, "hvac:thermostat": 25, "hvac:power_supply": 120, "hvac:commissioning": 60,
  "appliance:dishwasher": 180, "appliance:extractor": 90, "appliance:oven": 160, "appliance:hob": 110, "appliance:fridge": 260, "appliance:microwave": 60,
  // electrical
  "point:switch": 12, "point:switch_2way": 16, "point:dimmer": 22, "point:double_socket": 14, "point:socket": 12, "point:usb_socket": 18,
  "point:data": 20, "point:tv": 18, "point:shaver": 28, "point:cooker": 30, "point:spur": 18, "point:fan": 35, "point:ac": 280, "point:db": 220,
  "point:smoke": 18, "point:heat": 20, "point:doorbell": 25, "point:light_point": 10, circuit: 30,
  "fixture:downlight": 9, "fixture:pendant": 45, "fixture:chandelier": 160, "fixture:ceiling": 30, "fixture:spot": 15, "fixture:track": 55,
  "fixture:wall_sconce": 28, "fixture:strip": 35, "fixture:uplight": 25,
  // plumbing
  "sanitary:wc": 140, "sanitary:basin": 90, "sanitary:shower": 320, "sanitary:bath": 750, "sanitary:sink": 110, "sanitary:floor_drain": 18, "sanitary:tap": 25,
  "plumbing:first_fix": 35, "pipe:cold": 3.5, "pipe:hot": 4.5, "pipe:waste": 6, "pipe:soil": 9, "plumbing:stack": 65, "plumbing:water_heater": 95, "plumbing:inlet": 40,
  "plumbing:booster_set": 220, "plumbing:transfer_pump": 110, "plumbing:roof_tank_gal": 0.13, "plumbing:ground_tank_m3": 55, "plumbing:riser_m": 6,
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

/** `scope` overrides project.costs.scope for this bill. */
export function estimate(c: Compiled, opts: { scope?: CostScope } = {}): Bill {
  const project = c.project!;
  const costs = project.costs;
  const scope: CostScope = opts.scope ?? costs.scope;
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
  const unpriced = new Map<string, Bill["unpriced"][number]>();
  const priced = (p: Product) => typeof p.price === "number" && p.price > 0;
  const productLabel = (p: Product) => `${p.name}${p.sku ? ` (${p.vendor ?? ""} ${p.sku})` : ""}`;
  /** Allowance for a loose / furniture item of this type: researched rate, built-in allowance, or by size. */
  const furnitureAllowance = (type: string): { rate: number; key: string } => {
    const k = `furniture:${type}`;
    const hit = lookup(k);
    const r = hit?.v ?? FURNITURE_ALLOWANCE[type] ?? Math.round(30 + 40 * ((FURNITURE[type]?.defaults.width ?? 0.5) * (FURNITURE[type]?.defaults.depth ?? 0.5)));
    used[k] = r;
    provenance[k] = { src: hit?.src ?? "indicative", m: hit?.m };
    return { rate: r, key: k };
  };
  /** What a kitchen / joinery product is, from its name and type, to price it when the vendor price is missing. */
  const productKind = (p: Product): string => {
    const n = `${p.name} ${p.type}`.toLowerCase();
    if (/mixer|\btap\b|faucet/.test(n)) return "tap";
    if (/worktop|countertop|benchtop|work top/.test(n)) return "worktop";
    if (/\bfronts?\b|\bdoors?\b|cover panel|plinth|deco strip/.test(n)) return "cabinetry";
    if (/dishwasher/.test(n)) return "dishwasher";
    if (/extractor|cooker hood|\bhood\b/.test(n)) return "extractor";
    if (/\boven\b/.test(n)) return "oven";
    if (/\bhob\b|cooktop|induction/.test(n)) return "hob";
    if (/fridge|refrigerator|freezer/.test(n)) return "fridge";
    if (/microwave/.test(n)) return "microwave";
    if (/\bsink\b/.test(n) && !/cabinet/.test(n)) return "sink";
    if (/kitchen|cabinet|metod|havstorp|drawer|wardrobe|\bpax\b|enhet|knoxhult|shelf|shelving/.test(n)) return "cabinetry";
    return "other";
  };
  /** Rate (per item) and its key for a product without a price; worktops by their length. */
  const productAllowance = (p: Product, kind: string): { rate: number; key: string; how: string } => {
    if (kind === "worktop") {
      const m = typeof p.width === "number" && p.width > 0.3 ? p.width : 2.4;
      return { rate: rate("joinery:worktop") * m, key: "joinery:worktop", how: `worktop allowance, ${round(m, 2)} m` };
    }
    const key = ({ tap: "sanitary:tap", sink: "sanitary:sink", dishwasher: "appliance:dishwasher", extractor: "appliance:extractor", oven: "appliance:oven", hob: "appliance:hob", fridge: "appliance:fridge", microwave: "appliance:microwave" } as Record<string, string>)[kind];
    if (key) return { rate: rate(key), key, how: `${kind} allowance` };
    const f = furnitureAllowance(p.type);
    return { ...f, how: `${p.type.replace(/_/g, " ")} allowance` };
  };
  const noteUnpriced = (p: Product, allowance: number) => {
    const u = unpriced.get(p.id) ?? { id: p.id, name: p.name, url: p.url, allowance: 0 };
    u.allowance = round(u.allowance + allowance);
    unpriced.set(p.id, u);
  };
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
  let skirting = 0, cornice = 0, rails = 0, borders = 0, thresholds = 0, screed = 0;
  // structure: wall areas by assembly, slab areas (ground-bearing / suspended), roofs, columns
  const wallArea = new Map<WallAssemblyId, { area: number; exterior: boolean }>();
  let stairM3 = 0, parapetArea = 0, groundSlab = 0, suspSlab = 0, flatRoof = 0, pitchedRoof = 0, roofSlabM3 = 0, groundM3 = 0, suspM3 = 0, columnsM3 = 0, rcWallM3 = 0, rcWallArea = 0;
  const sys = constructionSystem(project.construction);
  const slabType = SLAB_TYPES[project.construction.slab ?? sys.slab];
  let gypsum = 0, skim = 0, soffit = 0, cove = 0, beams = 0, coffer = 0;
  const doors = new Map<string, number>(), treatments = new Map<string, number>();
  let windows = 0, windowCount = 0;
  const points = new Map<string, number>(), fixtures = new Map<string, number>(), sanitary = new Map<string, number>(), pipes = new Map<string, number>();
  let circuits = 0, stacks = 0, heaters = 0, drains = 0, inlets = 0, firstFix = 0;
  const railings = new Map<string, number>(), decks = new Map<string, number>();
  let screensM2 = 0, pergolaM2 = 0;
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
      if (!/terrace|outdoor|balcony|garden|roof/i.test(r.name ?? "")) screed += area;
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
    // ---- walls by construction, slabs, roofs, columns ----
    for (const s of info.segments) {
      const len = v2.dist(s.a, s.b), h = s.z1 - s.z0;
      const holes = s.holes.reduce((a, hh) => a + (hh.u1 - hh.u0) * ((hh.z1 ?? s.z1) - (hh.z0 ?? s.z0)), 0);
      const area = Math.max(0, len * h - holes);
      const id = s.construction ?? "block_200";
      const w = wallArea.get(id) ?? { area: 0, exterior: !!s.exterior };
      w.area += area;
      wallArea.set(id, w);
      if (WALL_ASSEMBLIES[id].kind === "rc") (rcWallM3 += area * WALL_ASSEMBLIES[id].core), (rcWallArea += area);
    }
    const T = lv.slabThickness ?? D.slabThickness;
    const ground = li === 0;
    const addSlab = (area: number, t: number) => {
      if (ground) (groundSlab += area), (groundM3 += area * t);
      else (suspSlab += area), (suspM3 += area * t);
    };
    if (lv.autoSlab)
      for (const w of lv.walls) {
        if (!w.closed || w.points.length < 3) continue;
        const t = w.thickness ?? D.exteriorWallThickness ?? D.wallThickness;
        addSlab(polygonArea(offsetPolygon(ensureCCW(w.points as Vec2[]), t / 2)), T);
      }
    for (const sl of lv.slabs) addSlab(Math.max(0, polygonArea(sl.polygon as Vec2[]) - sl.holes.reduce((a, h) => a + polygonArea(h as Vec2[]), 0)), sl.thickness ?? T);
    for (const rf of lv.roofs) {
      const a = polygonArea(offsetPolygon(ensureCCW(rf.polygon as Vec2[]), rf.overhang));
      if (rf.type === "flat") flatRoof += a;
      else pitchedRoof += a / Math.cos((rf.pitch * Math.PI) / 180);
      roofSlabM3 += (rf.type === "flat" ? a : a / Math.cos((rf.pitch * Math.PI) / 180)) * rf.thickness;
    }
    // RC stairs: waist slab + steps ≈ 1.1 m³ per metre of rise per metre of width (spiral: steel, not counted)
    for (const st of lv.stairs) if (st.type !== "spiral") stairM3 += 1.1 * st.width * (st.rise ?? info.height);
    for (const rf of lv.roofs) if (rf.type === "flat" && rf.parapet > 0) parapetArea += rf.parapet * perimeter(offsetPolygon(ensureCCW(rf.polygon as Vec2[]), rf.overhang) as Vec2[]);
    for (const col of lv.columns) columnsM3 += (col.shape === "round" ? Math.PI * (col.size / 2) ** 2 : col.size ** 2) * (col.height ?? info.height);
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
    for (const sc of lv.screens) screensM2 += polyLen(sc.points as Vec2[]) * sc.height;
    for (const pg of lv.pergolas) pergolaM2 += Math.abs(polygonArea(pg.polygon as Vec2[]));
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
        // cabinetry with no vendor price is priced per metre of the run instead (supply & install)
        const unpricedCabinetry: Product[] = [];
        for (const [pid, q] of counts) {
          const p = products.get(pid);
          if (!p) continue;
          if (priced(p)) {
            add(joinery, { description: `${name}: ${productLabel(p)}`, qty: q, unit: "no", rate: fx(p.price!, p.currency), basis: "vendor", url: p.url });
            continue;
          }
          const kind = productKind(p);
          if (kind === "cabinetry" && run) {
            unpricedCabinetry.push(p);
            continue;
          }
          const a = productAllowance(p, kind);
          add(joinery, { description: `${name}: ${productLabel(p)} — no vendor price, ${a.how}`, qty: q, unit: "no", rate: a.rate, basis: "allowance", key: a.key, url: p.url });
          noteUnpriced(p, a.rate * q);
        }
        if (unpricedCabinetry.length && run) {
          const len = (row: string) => [...run.base, ...run.uppers].filter((x) => x.row === row).reduce((a, x) => a + (x.x1 - x.x0), 0);
          const talls = run.base.filter((x) => x.row === "tall").length;
          const what = unpricedCabinetry.map((p) => p.name).join("; ");
          const before = joinery.lines.reduce((a, l) => a + l.amount, 0);
          add(joinery, { description: `${name}: base cabinets incl. fronts & hardware — no vendor price for ${what}, per-metre allowance`, qty: len("base"), unit: "m", rate: rate("joinery:kitchen_base"), basis: "allowance", key: "joinery:kitchen_base" });
          add(joinery, { description: `${name}: wall cabinets — per-metre allowance`, qty: len("upper"), unit: "m", rate: rate("joinery:kitchen_upper"), basis: "allowance", key: "joinery:kitchen_upper" });
          add(joinery, { description: `${name}: tall units — allowance`, qty: talls, unit: "no", rate: rate("joinery:kitchen_tall"), basis: "allowance", key: "joinery:kitchen_tall" });
          const share = (joinery.lines.reduce((a, l) => a + l.amount, 0) - before) / unpricedCabinetry.length;
          for (const p of unpricedCabinetry) noteUnpriced(p, share);
        }
        // the per-metre allowance already includes installing those cabinets
        const cabinets = prodMods.filter((m) => !unpricedCabinetry.some((p) => p.id === m.product)).length;
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
  const full = scope === "full";
  const ratio = (key: string, fallback: number) => marketRate(key)?.value ?? fallback;
  const gfa = groundSlab + suspSlab;
  let structureTotal = 0;
  if (full) {
    // A. Structure: reinforced concrete (cement + steel) measured from slabs, roofs, columns and RC walls
    const s = sec("A", `Structure & shell — ${sys.label}`);
    const C = project.construction;
    const rcRoof = slabType.rc ? roofSlabM3 : 0;
    const frameBase = suspSlab + flatRoof + pitchedRoof;
    const frameRatio = C.frameRatio ?? ratio("ratio:frame_m3_per_m2", 0.09);
    const frameM3 = sys.frame ? (columnsM3 > 0 ? columnsM3 + frameBase * frameRatio * 0.6 : frameBase * frameRatio) : columnsM3;
    const fdnPerM2 = { isolated: 0.3, raft: 0.6, strip: 0.25 }[C.foundation];
    const fdnM3 = groundSlab * fdnPerM2;
    const slabC = slabType.rc ? (groundM3 + suspM3 + rcRoof) * slabType.concrete : 0;
    const rebarKg = {
      slab: C.rebar.slab ?? ratio("ratio:rebar_kg_per_m3_slab", 100),
      frame: C.rebar.frame ?? ratio("ratio:rebar_kg_per_m3_frame", 180),
      foundation: C.rebar.foundation ?? ratio("ratio:rebar_kg_per_m3_foundation", 90),
      wall: C.rebar.wall ?? 120,
    };
    const stairC = slabType.rc ? stairM3 : 0;
    const rebarT = ((slabC + stairC) * rebarKg.slab + frameM3 * rebarKg.frame + fdnM3 * rebarKg.foundation + rcWallM3 * rebarKg.wall) / 1000;
    const n0 = s.lines.length;
    add(s, { description: "Excavation, backfill & compaction for foundations", qty: fdnM3 * 2.5, unit: "m³", rate: rate("earthworks:m3"), basis: "measured", key: "earthworks:m3" });
    add(s, { description: "Plain concrete blinding under foundations & ground slab (100 mm)", qty: groundSlab * 0.1, unit: "m³", rate: rate("struct:blinding_m3"), basis: "measured", key: "struct:blinding_m3" });
    add(s, { description: `Reinforced concrete foundations (${C.foundation} footings + tie beams, ${fdnPerM2} m³ per m² of footprint)`, qty: fdnM3, unit: "m³", rate: rate("struct:concrete_m3"), basis: "allowance", key: "struct:concrete_m3" });
    add(s, { description: "Bitumen coating to buried concrete", qty: fdnM3 * 3 + groundSlab * 0.15, unit: "m²", rate: rate("substructure:bitumen"), basis: "measured", key: "substructure:bitumen" });
    if (slabType.rc) {
      add(s, { description: "Ground-bearing slab", qty: groundM3 * slabType.concrete, unit: "m³", rate: rate("struct:concrete_m3"), basis: "measured", key: "struct:concrete_m3" });
      add(s, { description: `Suspended floor slabs: ${slabType.label}`, qty: suspM3 * slabType.concrete, unit: "m³", rate: rate("struct:concrete_m3"), basis: "measured", key: "struct:concrete_m3" });
      add(s, { description: "Roof slab", qty: rcRoof * slabType.concrete, unit: "m³", rate: rate("struct:concrete_m3"), basis: "measured", key: "struct:concrete_m3" });
    } else add(s, { description: `Floors: ${slabType.label}`, qty: suspSlab + groundSlab, unit: "m²", rate: rate("struct:timber_floor"), basis: "measured", key: "struct:timber_floor" });
    add(s, {
      description: columnsM3 > 0 ? "RC columns (measured) & beams (by ratio)" : `RC columns & beams (${frameRatio} m³ per m² of floor)`,
      qty: frameM3, unit: "m³", rate: rate("struct:concrete_m3"), basis: columnsM3 > 0 ? "measured" : "allowance", key: "struct:concrete_m3",
    });
    if (slabType.rc) add(s, { description: "RC staircases (waist slab & steps)", qty: stairM3, unit: "m³", rate: rate("struct:concrete_m3"), basis: "measured", key: "struct:concrete_m3" });
    add(s, { description: "Reinforced concrete walls", qty: rcWallM3, unit: "m³", rate: rate("struct:concrete_m3"), basis: "measured", key: "struct:concrete_m3" });
    add(s, {
      description: `Steel reinforcement (rebar) — ${rebarKg.slab} kg/m³ slabs, ${rebarKg.frame} frame, ${rebarKg.foundation} foundations`,
      qty: rebarT, unit: "t", rate: rate("struct:rebar_t"), basis: "measured", key: "struct:rebar_t",
    });
    add(s, { description: "Formwork (slab soffits, columns & beams, foundation sides, RC walls)", qty: (slabType.rc ? suspSlab + flatRoof + pitchedRoof + stairC * 4 : 0) + frameM3 * 9 + fdnM3 * 1.5 + rcWallArea * 2, unit: "m²", rate: rate("struct:formwork_m2"), basis: "measured", key: "struct:formwork_m2" });
    // masonry: exterior walls, then plaster / render
    let inside = 0, outside = 0;
    for (const [id, w] of wallArea) {
      const a = WALL_ASSEMBLIES[id];
      if (!w.exterior) continue;
      if (a.kind !== "rc") add(s, { description: `External walls: ${a.label}`, qty: w.area, unit: "m²", rate: rate(a.costKey), basis: "measured", key: a.costKey });
      if (a.plastered) (inside += w.area), (outside += w.area);
    }
    add(s, { description: "Roof parapets: 200 mm hollow concrete block", qty: parapetArea, unit: "m²", rate: rate("wall:block_200"), basis: "measured", key: "wall:block_200" });
    outside += parapetArea;
    inside += parapetArea;
    add(s, { description: "Cement-sand plaster to inner face of external walls & parapets", qty: inside, unit: "m²", rate: rate("wall:cement_plaster"), basis: "measured", key: "wall:cement_plaster" });
    add(s, { description: "External render to facades", qty: outside, unit: "m²", rate: rate("wall:render_external"), basis: "measured", key: "wall:render_external" });
    // roof build-up
    add(s, { description: "Roof: screed to falls + protection tiles", qty: flatRoof, unit: "m²", rate: rate("roof:screed_tiles"), basis: "measured", key: "roof:screed_tiles" });
    add(s, { description: "Roof: waterproofing membrane", qty: flatRoof + pitchedRoof, unit: "m²", rate: rate("roof:waterproofing"), basis: "measured", key: "roof:waterproofing" });
    add(s, { description: "Roof: thermal insulation", qty: flatRoof + pitchedRoof, unit: "m²", rate: rate("roof:insulation"), basis: "measured", key: "roof:insulation" });
    add(s, { description: "Roof tiles on pitched roofs", qty: pitchedRoof, unit: "m²", rate: rate("roof:tiles"), basis: "measured", key: "roof:tiles" });
    add(s, { description: "Sand-cement floor screed", qty: screed, unit: "m²", rate: rate("floor:screed"), basis: "measured", key: "floor:screed" });
    structureTotal = s.lines.slice(n0).reduce((a, l) => a + l.amount, 0);

    if (rebarT > 0) notes.push(`Structure: ${round(slabC + stairC + frameM3 + fdnM3 + rcWallM3 + groundSlab * 0.1, 1)} m³ of concrete and ${round(rebarT, 1)} t of steel reinforcement for ${round(gfa, 0)} m² of floor (${round(rebarT * 1000 / Math.max(1, slabC + stairC + frameM3 + fdnM3 + rcWallM3), 0)} kg/m³ on average).`);
  }
  const B = sec("B", "Partitions, floors & walls");
  // internal walls by what they are built of, then plaster both faces
  let plasterFaces = 0;
  for (const [id, w] of [...wallArea].sort((x, y) => y[1].area - x[1].area)) {
    const a = WALL_ASSEMBLIES[id];
    if (w.exterior) continue;
    if (a.kind !== "rc") add(B, { description: `Internal walls: ${a.label}`, qty: w.area, unit: "m²", rate: rate(a.costKey), basis: "measured", key: a.costKey });
    if (a.plastered) plasterFaces += 2 * w.area;
  }
  add(B, { description: "Cement-sand plaster to internal walls (both faces)", qty: plasterFaces, unit: "m²", rate: rate("wall:cement_plaster"), basis: "measured", key: "wall:cement_plaster" });
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
  add(C, { description: "Decorative ceiling beams", qty: beams, unit: "m", rate: rate("ceiling:beam"), basis: "measured", key: "ceiling:beam" });
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
  // water supply plant, from the hydraulics
  const wd = c.water;
  if (wd) {
    const riser = wd.segments.filter((s) => s.kind === "riser" || (s.kind === "main" && /riser/.test(s.label))).reduce((a, s) => a + s.length, 0);
    if (riser) add(G, { description: `Rising main ${[...new Set(wd.segments.filter((s) => s.kind === "riser").map((s) => `Ø${s.od}`))].join("/")} ${wd.pipe}, insulated, with isolating valves at each floor`, qty: riser, unit: "m", rate: rate("plumbing:riser_m"), basis: "measured", key: "plumbing:riser_m" });
    if (wd.booster) add(G, { description: `Booster pump set ${wd.booster.flowM3h} m³/h at ${wd.booster.headM} m with pressure vessel and controls`, qty: 1, unit: "no", rate: rate("plumbing:booster_set"), basis: "count", key: "plumbing:booster_set" });
    if (wd.supply !== "mains") {
      add(G, { description: `Roof water tanks, GRP, ${wd.storage.roof.tanks}, with float valve, overflow and stand`, qty: Math.round(wd.storage.roof.litres / 4.546), unit: "gal", rate: rate("plumbing:roof_tank_gal"), basis: "measured", key: "plumbing:roof_tank_gal" });
      if (wd.transfer) add(G, { description: `Transfer pump, ground tank to roof, ${wd.transfer.flowM3h} m³/h at ${wd.transfer.headM} m, with float switches`, qty: 1, unit: "no", rate: rate("plumbing:transfer_pump"), basis: "count", key: "plumbing:transfer_pump" });
      if (full) add(G, { description: `Ground water tank ${wd.storage.ground.m3} m³: excavation, waterproofed RC, access cover`, qty: wd.storage.ground.m3, unit: "m³", rate: rate("plumbing:ground_tank_m3"), basis: "measured", key: "plumbing:ground_tank_m3" });
    }
  }

  const H = sec("H", "Furniture, furnishings & decor", true);
  const furn = [...furniture.values()].sort((a, b) => Number(!!b.product) - Number(!!a.product) || (b.product?.price ?? 0) * b.qty - (a.product?.price ?? 0) * a.qty);
  for (const f of furn) {
    if (f.product && priced(f.product))
      add(H, { description: productLabel(f.product), qty: f.qty, unit: "no", rate: fx(f.product.price!, f.product.currency), basis: "vendor", url: f.product.url });
    else if (f.product) {
      const a = furnitureAllowance(f.product.type);
      add(H, { description: `${productLabel(f.product)} — no vendor price, ${f.product.type.replace(/_/g, " ")} allowance`, qty: f.qty, unit: "no", rate: a.rate, basis: "allowance", key: a.key, url: f.product.url });
      noteUnpriced(f.product, a.rate * f.qty);
    } else {
      const a = furnitureAllowance(f.type);
      add(H, { description: `${f.type.replace(/_/g, " ")} (allowance)`, qty: f.qty, unit: "no", rate: a.rate, basis: "allowance", key: a.key });
    }
  }

  if (decks.size || railings.size || screensM2 || pergolaM2) {
    const I = sec("I", "Terraces & outdoor");
    for (const [m, a] of decks) add(I, { description: `Terrace deck: ${label(m)}`, qty: a, unit: "m²", rate: rate(`floor:${m}`, `floor:${pattern(m)}`), basis: "measured", key: `floor:${pattern(m)}` });
    for (const [st, m] of railings) add(I, { description: `Balustrade: ${st}`, qty: m, unit: "m", rate: rate(`railing:${st}`), basis: "measured", key: `railing:${st}` });
    if (screensM2) add(I, { description: "Slatted timber screens / louvres (hardwood, oiled) on steel brackets", qty: screensM2, unit: "m²", rate: rate("screen:slats"), basis: "measured", key: "screen:slats" });
    if (pergolaM2) add(I, { description: "Timber pergola: posts, perimeter beams and slats, oiled, on footings", qty: pergolaM2, unit: "m²", rate: rate("pergola:timber"), basis: "measured", key: "pergola:timber" });
  }

  // ---- K. lifts (the shaft walls are in the structure, as RC walls) ----
  if (c.lifts?.length) {
    const K = sec("K", "Lifts");
    for (const l of c.lifts) {
      const home = l.drive === "home_lift";
      add(K, {
        description: `Lift '${l.id}': ${l.persons}-person ${l.kg} kg ${l.driveLabel.split(" (")[0]}, car, landing doors, controller, 2 stops, testing and handover`,
        qty: 1,
        unit: "no",
        rate: rate(home ? "lift:home_lift" : "lift:base"),
        basis: "count",
        key: home ? "lift:home_lift" : "lift:base",
      });
      add(K, { description: `Lift '${l.id}': additional stops`, qty: l.stops - 2, unit: "no", rate: rate("lift:per_stop"), basis: "count", key: "lift:per_stop" });
      if (l.pit > 0.3) add(K, { description: `Lift '${l.id}': pit ${l.pit} m deep — excavation, waterproofed RC, ladder`, qty: 1, unit: "no", rate: rate("lift:pit"), basis: "count", key: "lift:pit" });
      if (l.overrun > 0) add(K, { description: `Lift '${l.id}': RC overrun ${l.overrun} m above the roof, with waterproofing`, qty: 1, unit: "no", rate: rate("lift:overrun"), basis: "count", key: "lift:overrun" });
      add(K, { description: `Lift '${l.id}': 3-phase power supply, isolator and shaft lighting`, qty: 1, unit: "no", rate: rate("lift:power_supply"), basis: "count", key: "lift:power_supply" });
    }
  }

  // ---- L. landscape and irrigation, from the garden design ----
  const ls = c.landscape;
  if (ls && (Object.values(ls.areas).some((a) => a > 0) || Object.values(ls.plants).some((n) => n > 0))) {
    const Ls = sec("L", "Landscape & irrigation");
    const SURF: Record<string, string> = {
      lawn: "Natural lawn: 150 mm sweet soil with fertiliser, levelled, grass rolls laid and watered in",
      turf: "Artificial turf 35–40 mm on compacted base with sand infill",
      planting: "Planting bed: 300 mm sweet soil, ground cover and seasonal plants",
      gravel: "Decorative gravel 50 mm on weed membrane, steel edging",
      mulch: "Bark mulch 75 mm on weed membrane",
      paving: "Garden paving (interlock / stone) on sand bed and compacted base",
      sand: "Sand area, levelled and compacted",
    };
    for (const [k, a] of Object.entries(ls.areas)) if (a > 0) add(Ls, { description: SURF[k], qty: a, unit: "m²", rate: rate(`landscape:${k}`), basis: "measured", key: `landscape:${k}` });
    const P = ls.plants;
    if (P.palms) add(Ls, { description: "Palm trees (date palm, 3–4 m trunk), pit, sweet soil and staking", qty: P.palms, unit: "no", rate: rate("landscape:palm"), basis: "count", key: "landscape:palm" });
    if (P.trees) add(Ls, { description: "Trees 2.5–3 m (conocarpus / ficus / albizia), pit, sweet soil and staking", qty: P.trees, unit: "no", rate: rate("landscape:tree"), basis: "count", key: "landscape:tree" });
    if (P.shrubs) add(Ls, { description: "Shrubs 0.6–1 m, planted", qty: P.shrubs, unit: "no", rate: rate("landscape:shrub"), basis: "count", key: "landscape:shrub" });
    if (P.hedgeM) add(Ls, { description: "Hedge planting, 3 plants per metre", qty: P.hedgeM, unit: "m", rate: rate("landscape:hedge"), basis: "measured", key: "landscape:hedge" });
    const lv = ls.levels;
    const n = (f: (l: (typeof lv)[number]) => number) => lv.reduce((a, l) => a + f(l), 0);
    const heads = n((l) => l.heads.length);
    const drip = n((l) => l.drip.reduce((a, d) => a + polyLen(d.pts), 0));
    const bubblers = n((l) => l.bubblers.reduce((a, b) => a + b.n, 0));
    const emitters = n((l) => l.emitters.reduce((a, e) => a + e.n, 0));
    // mains to several zones share a trench: measure the route once (0.25 m cells)
    const pipe = n((l) => {
      const cells = new Set<string>();
      for (const p of l.pipes)
        for (let k = 1; k < p.pts.length; k++) {
          const [a0, b0] = [p.pts[k - 1], p.pts[k]];
          const steps = Math.max(1, Math.round(Math.hypot(b0[0] - a0[0], b0[1] - a0[1]) / 0.25));
          for (let t = 0; t < steps; t++) {
            const x = a0[0] + ((b0[0] - a0[0]) * (t + 0.5)) / steps, y = a0[1] + ((b0[1] - a0[1]) * (t + 0.5)) / steps;
            cells.add(`${Math.round(x * 4)},${Math.round(y * 4)}`);
          }
        }
      return cells.size * 0.25;
    });
    const valves = n((l) => l.valves.length);
    if (heads) add(Ls, { description: "Pop-up spray heads with adjustable nozzles, swing joints", qty: heads, unit: "no", rate: rate("irrigation:spray_head"), basis: "count", key: "irrigation:spray_head" });
    if (drip) add(Ls, { description: "Drip line 16 mm with 2 L/h pressure-compensating emitters at 300 mm", qty: drip, unit: "m", rate: rate("irrigation:drip_m"), basis: "measured", key: "irrigation:drip_m" });
    if (bubblers) add(Ls, { description: "Tree bubblers on 16 mm risers", qty: bubblers, unit: "no", rate: rate("irrigation:bubbler"), basis: "count", key: "irrigation:bubbler" });
    if (emitters) add(Ls, { description: "Point emitters at shrubs and planters", qty: emitters, unit: "no", rate: rate("irrigation:emitter"), basis: "count", key: "irrigation:emitter" });
    if (pipe) add(Ls, { description: "PE pipe 25–32 mm (mainline and laterals), trenching 300 mm, sleeves under paths", qty: pipe, unit: "m", rate: rate("irrigation:pipe_m"), basis: "measured", key: "irrigation:pipe_m" });
    if (valves) {
      add(Ls, { description: "Solenoid zone valves 1\" with fittings", qty: valves, unit: "no", rate: rate("irrigation:valve"), basis: "count", key: "irrigation:valve" });
      add(Ls, { description: "Valve box (in-ground, lockable lid)", qty: lv.filter((l) => l.valves.length).length, unit: "no", rate: rate("irrigation:valve_box"), basis: "count", key: "irrigation:valve_box" });
      add(Ls, { description: `Irrigation controller, ${valves}-station, with rain/heat sensor and wiring to the valves`, qty: 1, unit: "no", rate: rate("irrigation:controller"), basis: "count", key: "irrigation:controller" });
    }
    // check the itemised irrigation against Kuwaiti whole-system prices per m²
    const irr = Ls.lines.filter((l) => l.key?.startsWith("irrigation:")).reduce((x, l) => x + l.amount, 0);
    const bs = marketRate("benchmark:irrigation_spray_m2"), bd = marketRate("benchmark:irrigation_drip_m2");
    if (irr && bs?.value && bd?.value) {
      const lawn = ls.areas.lawn, bed = ls.areas.planting;
      const lo = lawn * (bs.low ?? bs.value) + bed * (bd.low ?? bd.value), hi = lawn * (bs.high ?? bs.value) + bed * (bd.high ?? bd.value);
      if (lawn + bed > 20) notes.push(`Irrigation: itemised at ${round(irr, 0)} ${cur}; Kuwaiti contractors quote whole systems at about ${round(lo, 0)}–${round(hi, 0)} ${cur} for ${round(lawn, 0)} m² of lawn and ${round(bed, 0)} m² of beds (${bs.source.split(":")[0]}).`);
    }
    if (ls.demand.litresPerDay)
      notes.push(`Landscape: about ${ls.demand.litresPerDay} L of water a day in summer (${ls.demand.m3PerMonth} m³/month) over ${ls.zones.length} irrigation zone(s); plants and lawn are priced as supplied and planted, with no maintenance period.`);
  }

  // ---- J. air conditioning, from the HVAC design ----
  const hv = c.hvac;
  if (hv && hv.system !== "none" && hv.units.length) {
    const J = sec("J", "Air conditioning (HVAC)");
    const KIND = { packaged: "Rooftop packaged unit", ducted_split: "Ducted split unit with roof condenser", split: "Wall split unit with roof condenser" } as const;
    const key = { packaged: "hvac:packaged_tr", ducted_split: "hvac:ducted_split_tr", split: "hvac:split_tr" } as const;
    const bySize = new Map<string, { kind: keyof typeof KIND; size: number; n: number }>();
    for (const u of hv.units) {
      const k = `${u.kind}:${u.size}`;
      const e = bySize.get(k) ?? { kind: u.kind, size: u.size, n: 0 };
      e.n++;
      bySize.set(k, e);
    }
    for (const e of bySize.values())
      add(J, {
        description: `${KIND[e.kind]} ${e.size} TR${e.n > 1 ? ` (${e.n} no)` : ""}${e.kind === "packaged" ? ", on steel base with anti-vibration mounts, connections and start-up" : ", refrigerant piping and condensate drain"}`,
        qty: e.size * e.n,
        unit: "TR",
        rate: rate(key[e.kind]),
        basis: "measured",
        key: key[e.kind],
      });
    const ducts = hv.levels.flatMap((l) => l.ducts);
    const sheet = ducts.reduce((a, d) => a + polyLen(d.pts) * 2 * (d.w + d.h), 0);
    add(J, { description: "Ductwork: galvanised sheet steel, insulated, incl. hangers, risers and fittings (by surface area)", qty: sheet, unit: "m²", rate: rate("hvac:duct_m2"), basis: "measured", key: "hvac:duct_m2" });
    const terms = hv.levels.flatMap((l) => l.terminals);
    add(J, { description: "Supply air diffusers 600×600 with plenum boxes and flexible connections", qty: terms.filter((t) => t.kind === "supply").length, unit: "no", rate: rate("hvac:diffuser"), basis: "count", key: "hvac:diffuser" });
    add(J, { description: "Return air grilles with plenum boxes", qty: terms.filter((t) => t.kind === "return").length, unit: "no", rate: rate("hvac:return_grille"), basis: "count", key: "hvac:return_grille" });
    add(J, { description: "Wall thermostats incl. control wiring", qty: hv.levels.reduce((a, l) => a + l.thermostats.length, 0), unit: "no", rate: rate("hvac:thermostat"), basis: "count", key: "hvac:thermostat" });
    add(J, { description: "Power supply to each unit: cable from the DB, isolator", qty: hv.units.length, unit: "no", rate: rate("hvac:power_supply"), basis: "count", key: "hvac:power_supply" });
    add(J, { description: "Testing, air balancing and commissioning", qty: hv.units.length, unit: "unit", rate: rate("hvac:commissioning"), basis: "count", key: "hvac:commissioning" });
    const perTR = hv.totals.tr ? J.lines.reduce((x, l) => x + l.amount, 0) / hv.totals.tr : 0;
    const bench = marketRate("benchmark:hvac_per_tr_installed");
    notes.push(
      `Air conditioning: ${hv.totals.tr} TR for ${hv.totals.area} m² conditioned (${hv.totals.m2PerTR} m²/TR), sized from room cooling loads at Kuwait design conditions; section J works out at ${round(perTR, 0)} ${cur}/TR` +
        (bench?.value ? ` (Kuwaiti all-in villa AC contracts quote ${bench.low ?? bench.value}–${bench.high ?? bench.value} ${cur}/TR)` : "") +
        `${hv.issues.length ? `; ${hv.issues.length} coordination issue(s) in the HVAC design` : ""}.`,
    );
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
  if (full && gfa > 0) {
    // compare like with like: a skeleton contract price includes the contractor's preliminaries and margin
    const withMarkup = (structureTotal * (1 + P.preliminaries / 100) * (1 + P.overheadProfit / 100)) / gfa;
    const bench = marketRate("benchmark:skeleton_m2");
    notes.push(
      `Structure & shell: ${round(structureTotal / gfa, 1)} ${cur}/m² of floor (${round(gfa, 0)} m²), ${round(withMarkup, 1)} ${cur}/m² with preliminaries and overhead & profit` +
        (bench?.value
          ? `; Kuwaiti skeleton (هيكل أسود) contracts quote ${bench.low ?? bench.value}–${bench.high ?? bench.value} ${cur}/m² of built-up area (${bench.source}) — those prices also carry water tanks, boundary walls, site works, basements and the contractor's risk on small jobs, which this model does not.`
          : "."),
    );
  }
  notes.unshift(
    "Quantities are measured from the model. Unit rates are researched Kuwait market prices (supply + install unless stated; source, quote and read date in Rates & sources) where one was found, otherwise indicative; vendor lines use the product page price. Override any rate in project.costs.rates.",
    "Market rates are single quoted prices or mid-points of published ranges, not tenders — several are GCC (UAE/KSA) prices converted to KWD where no Kuwait price was published; check 'low' confidence lines with a local quote.",
    "Preliminaries, overhead & profit and contingency default to published GCC percentages for contractor-led work; for a small owner-managed fit-out set project.costs.preliminaries / overheadProfit lower.",
    "Vendor prices are as read from the product pages; delivery, assembly by the vendor and promotions are not included.",
    `Excludes: ${hv && hv.system !== "none" && hv.units.length ? "" : "HVAC (except listed AC units), "}permits and authority fees, base-building works outside the scope, loose kitchenware and soft goods not modelled.`,
  );
  if (unpriced.size)
    notes.unshift(
      `${unpriced.size} product(s) have no vendor price and are billed as allowances instead (marked 'no vendor price'): ${[...unpriced.values()].map((u) => u.name).join("; ")}. Find their prices and set them on the products (price + currency) for a firmer total.`,
    );
  if (!full)
    notes.unshift(
      "Scope: fit-out only — the structure and shell (foundations, reinforced concrete frame and slabs, rebar, formwork, blockwork, plaster / render, roof build-up) are NOT included. Ask for scope 'full' (project.costs.scope) to add them.",
    );
  return {
    project: project.name, currency: cur, date: new Date().toLocaleDateString("en-CA"), scope, sections: out, trades, retail, adjustments, total,
    notes: [...new Set(notes)], ratesUsed: Object.fromEntries(Object.entries(used).sort()),
    sources: [
      ...new Map(
        [...Object.values(provenance).filter((p) => p.src === "market" && p.m).map((p) => p.m!), ...["pct:preliminaries", "pct:overheadProfit", "pct:contingency", "vat", "benchmark:fitout_per_m2"].map(marketRate).filter((m): m is MarketRate => !!m)]
          .map((m) => [m.key, m]),
      ).values(),
    ].sort((a, b) => a.key.localeCompare(b.key)),
    coverage: Object.fromEntries(Object.entries(coverage).map(([k, v]) => [k, round(v)])) as Bill["coverage"],
    unpriced: [...unpriced.values()],
    floorArea: round(gfa),
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
