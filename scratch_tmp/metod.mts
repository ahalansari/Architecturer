import { fetchProduct, searchIkea } from "../src/assets/vendors.ts";
const K = "https://www.ikea.com/kw/en/p/";
// island 2-door base: find the VOXTORP 80x60 one
const doors80 = (await searchIkea("METOD base cabinet with shelves 2 doors voxtorp oak effect 80", "kw/en", 12)).find((h) => /2 doors/i.test(h.name) && /80x60/.test(h.size ?? "") && /voxtorp-oak-effect/.test(h.url));
const list: [string, string, string][] = [
  ["metod_fridge_cab_240", "fridge", "metod-high-cab-f-fridge-freezer-w-3-doors-white-voxtorp-oak-effect-s89537875/"],
  ["metod_oven_cab_240", "tall_oven", "metod-maximera-high-cabinet-f-oven-door-2-drawers-white-voxtorp-oak-effect-s39538269/"],
  ["metod_drawers_80", "base_drawers", "metod-maximera-base-cb-4-frnts-2-low-3-md-drwrs-white-voxtorp-oak-effect-s09537898/"],
  ["metod_drawers_60", "base_drawers", "metod-maximera-base-cb-2-fronts-2-high-drawers-white-voxtorp-oak-effect-s99539082/"],
  ["metod_drawers_40", "base_drawers", "metod-maximera-base-cb-3-frnts-2-low-1-md-1-hi-drw-white-voxtorp-oak-effect-s49538283/"],
  ["metod_dishwasher_fronts", "dishwasher", "metod-2-fronts-for-dishwasher-voxtorp-oak-effect-s69539253/"],
  ["metod_sink_cab_80", "sink", "metod-maximera-base-cab-f-sink-2-fronts-2-drawers-white-voxtorp-oak-effect-s99537907/"],
  ["metod_corner_base", "corner", "metod-maximera-corner-base-cab-w-drawer-and-shelf-white-voxtorp-oak-effect-s09585747/"],
  ["metod_hob_cab_80", "hob", "metod-maximera-base-cab-f-hob-3-fronts-3-drawers-white-voxtorp-oak-effect-s49538103/"],
  ["metod_wall_80x100", "upper_doors", "metod-wall-cabinet-with-shelves-2-doors-white-voxtorp-oak-effect-s29539047/"],
  ["metod_wall_40x100", "upper_doors", "metod-wall-cabinet-with-shelves-2-doors-white-voxtorp-oak-effect-s49538061/"],
  ["metod_hood_cab_80x100", "hood", "metod-wall-cb-f-extr-hood-w-shlf-door-white-voxtorp-oak-effect-s99537894/"],
  ["ekbacken_worktop", "box", "ekbacken-worktop-white-marble-effect-laminate-20609030/"],
  ["kilsviken_sink", "box", "kilsviken-inset-sink-1-bowl-grey-beige-quartz-composite-s79590397/"],
  ["sallsjon_tap", "box", "sallsjoen-kitchen-mixer-tap-pull-down-w-spray-black-20610477/"],
  ["lagan_oven", "box", "lagan-oven-stainless-steel-colour-20613918/"],
  ["matmassig_hob", "box", "matmaessig-induction-hob-ikea-300-black-50467251/"],
  ["forsnas_fridge", "box", "forsnaes-fridge-ikea-700-integrated-10611081/"],
  ["metod_leg", "box", "metod-leg-for-cabinet-70556067/"],
  ["vedhamn_plinth", "box", "vedhamn-plinth-oak-effect-40501081/"],
  ["voxtorp_cover_panel", "box", "voxtorp-cover-panel-oak-effect-90559121/"],
  ["billsbro_handle", "box", "billsbro-handle-anthracite-00576182/"],
  ["metod_island_frame", "box", "metod-floor-anchoring-frame-f-ktchn-islnd-80557033/"],
];
if (doors80) list.push(["metod_doors_80", "base_doors", doors80.url.replace(K, "")]);
const out = [];
for (const [id, type, path] of list) {
  const p = await fetchProduct(K + path);
  const e: Record<string, unknown> = { id, name: p.name, vendor: "IKEA", sku: p.sku, price: p.price, currency: p.currency, type, url: K + path };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  console.error(`${id.padEnd(24)} ${String(p.price).padStart(6)} ${p.currency}  ${p.name}`);
  out.push(e);
}
console.log(JSON.stringify(out));
