/**
 * Read a vendor product page (IKEA, Homecentre, Amazon, Wayfair, West Elm, Home Box, Pottery Barn...) into a
 * product: name, vendor, SKU, price, size, photo, colour, and a 3D model when the page publishes one (IKEA does,
 * as schema.org 3DModel GLB). Sources, in order: schema.org JSON-LD (Product, 3DModel), Open Graph / product meta
 * tags, IKEA's measurement data, then measurement text ("Width: 80 cm", "200 x 90 x 75 cm", 30"D x 28"W x 35"H).
 * Pages that block scripted requests (Amazon often does) still work by passing the fields directly.
 * Only pages a user asks for are fetched; product models are for visualising designs (license "vendor").
 */
import { readFile } from "node:fs/promises";
import { FURNITURE } from "../elements/furniture.js";
import { download, fetchCached, fetchJson, fetchText } from "./cache.js";
import { decodeImage, dominantColor } from "./images.js";

export interface ProductInfo {
  name?: string;
  vendor?: string;
  url?: string;
  sku?: string;
  price?: number;
  currency?: string;
  /** Metres. */
  width?: number;
  depth?: number;
  height?: number;
  model?: string;
  image?: string;
  color?: string;
  colorName?: string;
  type?: string;
  category?: string;
  description?: string;
  warnings: string[];
}

const VENDORS: [RegExp, string][] = [
  [/ikea\./, "IKEA"], [/homecentre\./, "Homecentre"], [/amazon\./, "Amazon"], [/wayfair\./, "Wayfair"], [/westelm\./, "West Elm"],
  [/potterybarn\./, "Pottery Barn"], [/crateandbarrel\./, "Crate & Barrel"], [/homebox/, "Home Box"], [/panhome|panemirates/, "PAN Home"],
  [/danubehome/, "Danube Home"], [/zarahome/, "Zara Home"], [/hm\.com/, "H&M Home"], [/target\./, "Target"], [/walmart\./, "Walmart"],
  [/made\.com/, "Made.com"], [/habitat\./, "Habitat"], [/maisonsdumonde/, "Maisons du Monde"], [/noon\./, "noon"], [/aliexpress|alibaba/, "AliExpress"],
  [/taobao|tmall/, "Taobao"], [/jd\.com/, "JD.com"], [/hay\.(com|dk)/, "HAY"], [/muuto/, "Muuto"], [/vitra/, "Vitra"], [/hermanmiller/, "Herman Miller"],
];
export function vendorFromUrl(url: string): string | undefined {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return VENDORS.find(([re]) => re.test(h))?.[1] ?? h.replace(/^www\./, "").split(".")[0].replace(/^./, (c) => c.toUpperCase());
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// lengths

/** "32 1/4 \"" → 0.819, "80 cm" → 0.8, "800 mm", "0.8 m", "31.5 in", "2'6\"". Unitless numbers use `defUnit`. */
export function parseLength(raw: string | number | undefined, defUnit: "cm" | "mm" | "m" | "in" = "cm"): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "number") return toM(raw, defUnit);
  const s = raw.replace(/&quot;|”|″/g, '"').replace(/’|′/g, "'").replace(/,(\d{1,2})(?!\d)/, ".$1").trim();
  const ft = /(\d+(?:\.\d+)?)\s*'\s*(?:(\d+(?:\.\d+)?)\s*"?)?/.exec(s);
  if (ft && s.includes("'")) return toM(Number(ft[1]) * 12 + Number(ft[2] ?? 0), "in");
  const m = /(\d+(?:\.\d+)?)(?:\s+(\d+)\s*\/\s*(\d+))?\s*(cm|mm|m\b|in\b|inch|inches|"|ft|feet)?/i.exec(s);
  if (!m) return undefined;
  let v = Number(m[1]);
  if (m[2]) v += Number(m[2]) / Number(m[3]);
  const u = (m[4] ?? "").toLowerCase();
  const unit = u === "cm" ? "cm" : u === "mm" ? "mm" : u === "m" ? "m" : u === '"' || u.startsWith("in") ? "in" : u === "ft" || u === "feet" ? "ft" : defUnit;
  return toM(v, unit as never);
}
function toM(v: number, u: "cm" | "mm" | "m" | "in" | "ft"): number {
  const k = { cm: 0.01, mm: 0.001, m: 1, in: 0.0254, ft: 0.3048 }[u];
  return Math.round(v * k * 1000) / 1000;
}
const UNIT_CODES: Record<string, "cm" | "mm" | "m" | "in"> = { CMT: "cm", MMT: "mm", MTR: "m", INH: "in", cm: "cm", mm: "mm", m: "m", in: "in", inch: "in" };
function quant(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "number" || typeof v === "string") return parseLength(v as string);
  if (typeof v === "object") {
    const q = v as { value?: number | string; unitCode?: string; unitText?: string };
    const u = UNIT_CODES[q.unitCode ?? ""] ?? UNIT_CODES[(q.unitText ?? "").toLowerCase()] ?? "cm";
    return typeof q.value === "number" ? toM(q.value, u) : parseLength(String(q.value ?? ""), u);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// furniture type guess

const TYPE_WORDS: [RegExp, string][] = [
  [/sectional|corner sofa|l-shaped sofa/i, "sectional_sofa"], [/sofa ?bed|daybed/i, "daybed"], [/sofa|couch|loveseat|settee/i, "sofa"],
  [/armchair|accent chair|lounge chair|recliner|wingback/i, "armchair"], [/office chair|desk chair|swivel chair/i, "office_chair"],
  [/bar stool|counter stool/i, "bar_stool"], [/ottoman|pouf|footstool/i, "ottoman"], [/bench/i, "bench"],
  [/bunk bed/i, "bunk_bed"], [/crib|cot\b/i, "crib"], [/bed ?frame|\bbed\b|divan/i, "bed"], [/nightstand|bedside table|night table/i, "nightstand"],
  [/wardrobe|closet|armoire/i, "wardrobe"], [/chest of (?:\d+ )?drawers|drawer chest|dresser/i, "dresser"], [/dressing table|vanity table/i, "dressing_table"],
  [/bookcase|bookshelf|shelving unit|shelf unit/i, "bookshelf"], [/wall shelf|floating shelf/i, "floating_shelf"],
  [/tv (bench|stand|unit|cabinet)|media console/i, "tv_stand"], [/sideboard|buffet|credenza/i, "sideboard"], [/console table/i, "console_table"],
  [/coffee table/i, "coffee_table"], [/side table|end table/i, "side_table"], [/round (dining )?table/i, "round_dining_table"],
  [/desk|workstation/i, "desk"], [/dining table|kitchen table|\btable\b/i, "table"], [/dining chair|\bchair\b/i, "chair"],
  [/floor lamp/i, "floor_lamp"], [/table lamp|desk lamp/i, "table_lamp"], [/pendant|ceiling lamp|chandelier/i, "ceiling_light"],
  [/\brug\b|carpet/i, "rug"], [/full[- ]length mirror|floor mirror/i, "mirror_full_length"], [/round mirror/i, "mirror_round"], [/mirror/i, "mirror"],
  [/curtain|drape/i, "curtain"], [/artificial plant|plant pot|planter/i, "plant"], [/vase/i, "vase"], [/cushion|pillow/i, "cushion"],
  [/throw|blanket/i, "throw_blanket"], [/shoe (cabinet|rack|storage)/i, "shoe_cabinet"], [/coat rack|hall stand/i, "coat_rack"],
  [/fridge|refrigerator/i, "fridge"], [/washing machine|washer/i, "washing_machine"], [/dishwasher/i, "dishwasher"],
  [/(cooker|range|stove)\b/i, "stove"], [/toilet|\bwc\b/i, "toilet"], [/bathtub|bath tub/i, "bathtub"], [/wash ?basin|bathroom sink/i, "bathroom_sink"],
  [/television|\btv\b/i, "tv"], [/piano/i, "piano"], [/filing cabinet/i, "filing_cabinet"], [/laundry basket|hamper/i, "laundry_basket"],
];
export function guessFurnitureType(text: string): string | undefined {
  const t = TYPE_WORDS.find(([re]) => re.test(text))?.[1];
  return t && FURNITURE[t] ? t : undefined;
}

// ---------------------------------------------------------------------------
// page parsing

type J = Record<string, unknown>;
const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const decode = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));

function jsonLd(html: string): J[] {
  const out: J[] = [];
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const v = JSON.parse(m[1].trim());
      for (const x of asArray(v)) {
        if (x && typeof x === "object") {
          out.push(x as J);
          for (const g of asArray((x as J)["@graph"] as J[])) out.push(g);
        }
      }
    } catch {
      /* ignore malformed blocks */
    }
  }
  return out;
}
const isType = (o: J, t: string) => asArray(o["@type"] as string | string[]).some((x) => String(x).toLowerCase() === t.toLowerCase());
const meta = (html: string, key: string) => {
  const re = new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${key.replace(/[:.]/g, "\\$&")}["'][^>]*content=["']([^"']*)["']|<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name|itemprop)=["']${key.replace(/[:.]/g, "\\$&")}["']`, "i");
  const m = re.exec(html);
  return m ? decode(m[1] ?? m[2]) : undefined;
};

/** Parse a product page's HTML. */
export function parseProductHtml(html: string, url?: string): ProductInfo {
  const info: ProductInfo = { url, vendor: url ? vendorFromUrl(url) : undefined, warnings: [] };
  const lds = jsonLd(html);
  const prod = lds.find((o) => isType(o, "Product") || isType(o, "IndividualProduct") || isType(o, "ProductGroup"));
  if (prod) {
    info.name = String(prod.name ?? "") || undefined;
    const brand = prod.brand as J | string | undefined;
    if (brand) info.vendor = (typeof brand === "string" ? brand : String(brand.name ?? "")) || info.vendor;
    info.sku = String(prod.sku ?? prod.productID ?? prod.mpn ?? "") || undefined;
    info.color = undefined;
    info.colorName = typeof prod.color === "string" ? prod.color : undefined;
    info.category = typeof prod.category === "string" ? prod.category : undefined;
    info.description = typeof prod.description === "string" ? decode(prod.description).slice(0, 400) : undefined;
    const img = asArray(prod.image as unknown)[0] as J | string | undefined;
    info.image = typeof img === "string" ? img : (img?.contentUrl as string) ?? (img?.url as string);
    const offers = asArray(prod.offers as J | J[])[0];
    const offer = offers ? (asArray(offers.offers as J | J[])[0] ?? offers) : undefined;
    if (offer) {
      const p = offer.price ?? offer.lowPrice ?? (offer.priceSpecification as J | undefined)?.price;
      if (p !== undefined && !isNaN(Number(p))) info.price = Number(p);
      info.currency = String(offer.priceCurrency ?? (offer.priceSpecification as J | undefined)?.priceCurrency ?? "") || undefined;
    }
    info.width = quant(prod.width);
    info.depth = quant(prod.depth);
    info.height = quant(prod.height);
  }
  const model3d = lds.find((o) => isType(o, "3DModel"));
  if (model3d) {
    const enc = asArray(model3d.encoding as J | J[]).find((e) => /gltf-binary|gltf|glb/i.test(String(e.encodingFormat ?? "")) || /\.glb/i.test(String(e.contentUrl ?? "")));
    if (enc?.contentUrl) info.model = String(enc.contentUrl);
  }
  info.name ??= meta(html, "og:title") ?? /<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim();
  info.image ??= meta(html, "og:image");
  if (info.price === undefined) {
    const p = meta(html, "product:price:amount") ?? meta(html, "og:price:amount") ?? meta(html, "price");
    if (p && !isNaN(Number(p))) info.price = Number(p);
    info.currency ??= meta(html, "product:price:currency") ?? meta(html, "og:price:currency") ?? meta(html, "priceCurrency");
  }
  info.model ??= /https?:\/\/[^"'\s<>]+\.glb(?:\?[^"'\s<>]*)?/i.exec(html)?.[0];

  // IKEA measurement data: "measure":"26 3/4 \"","name":"Width"
  const ikea = (name: string) => {
    const m = new RegExp(`"measure":"((?:[^"\\\\]|\\\\.)*)","name":"${name}"`).exec(html);
    return m ? parseLength(m[1].replace(/\\"/g, '"'), "cm") : undefined;
  };
  info.width ??= ikea("Width") ?? ikea("Length") ?? ikea("Diameter");
  info.depth ??= ikea("Depth") ?? ikea("Diameter");
  info.height ??= ikea("Height") ?? ikea("Max. height");

  // free text: "Width: 80 cm" / "200 x 90 x 75 cm" / 30"D x 28"W x 35"H
  if (info.width === undefined || info.depth === undefined || info.height === undefined) {
    const text = decode(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
    const lab = (re: RegExp) => {
      const m = re.exec(text);
      return m ? parseLength(m[1]) : undefined;
    };
    info.width ??= lab(/\b(?:width|w)\s*[:=]\s*([\d.,]+(?:\s+\d+\/\d+)?\s*(?:cm|mm|m|in|inch(?:es)?|"))/i);
    info.depth ??= lab(/\b(?:depth|d)\s*[:=]\s*([\d.,]+(?:\s+\d+\/\d+)?\s*(?:cm|mm|m|in|inch(?:es)?|"))/i);
    info.height ??= lab(/\b(?:height|h)\s*[:=]\s*([\d.,]+(?:\s+\d+\/\d+)?\s*(?:cm|mm|m|in|inch(?:es)?|"))/i);
    const tagged = /(\d+(?:\.\d+)?)\s*"?\s*([LWDH])\s*x\s*(\d+(?:\.\d+)?)\s*"?\s*([LWDH])\s*x\s*(\d+(?:\.\d+)?)\s*"?\s*([LWDH])\b/i.exec(text);
    if (tagged) {
      const unit = /\d\s*"/.test(tagged[0]) || /inch/i.test(text.slice(tagged.index, tagged.index + 60)) ? "in" : "cm";
      for (let k = 1; k <= 5; k += 2) {
        const v = toM(Number(tagged[k]), unit);
        const which = tagged[k + 1].toUpperCase();
        if (which === "W" || which === "L") info.width ??= v;
        else if (which === "D") info.depth ??= v;
        else info.height ??= v;
      }
    }
    const triple = /(\d+(?:[.,]\d+)?)\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*(cm|mm|m|in|inches|")/i.exec(text);
    if (triple && (info.width === undefined || info.depth === undefined || info.height === undefined)) {
      const u = triple[4].toLowerCase() === '"' || triple[4].toLowerCase().startsWith("in") ? "in" : (triple[4].toLowerCase() as "cm" | "mm" | "m");
      const [a, b, c] = [triple[1], triple[2], triple[3]].map((x) => toM(Number(x.replace(",", ".")), u));
      // furniture listings usually read W x D x H
      info.width ??= a;
      info.depth ??= b;
      info.height ??= c;
    }
  }
  info.type = guessFurnitureType(`${info.name ?? ""} ${info.category ?? ""}`);
  if (!info.name) info.warnings.push("no product name found on the page");
  if (info.width === undefined || info.depth === undefined || info.height === undefined) info.warnings.push("size not found on the page: pass width / depth / height (metres)");
  return info;
}

/** Fetch and parse a product page. Throws when the page cannot be fetched (blocked / offline). */
export async function fetchProduct(url: string): Promise<ProductInfo> {
  const html = await fetchText(url, 24);
  if (/captcha|robot check|access denied|are you a human/i.test(html.slice(0, 20000)) && !/application\/ld\+json/.test(html))
    throw new Error(`${vendorFromUrl(url) ?? "the site"} served a bot check instead of the product page; read the page yourself and pass name / size / price / image`);
  const info = parseProductHtml(html, url);
  if (!info.name && !info.width) throw new Error(`no product data found at ${url} (is it a product page?)`);
  return info;
}

/** Dominant colour of a product photo (studio background ignored). */
export async function photoColor(imageUrl: string): Promise<string | undefined> {
  try {
    const p = /^https?:/i.test(imageUrl) ? await fetchCached(imageUrl, { sub: "product-img" }) : imageUrl;
    return dominantColor(decodeImage(new Uint8Array(await readFile(p)), p.toLowerCase()));
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// IKEA search (the site's own public search endpoint; markets like "us/en", "ae/en", "kw/en", "sa/en", "gb/en")

export interface VendorHit {
  name: string;
  description?: string;
  url: string;
  sku?: string;
  price?: number;
  currency?: string;
  image?: string;
  size?: string;
  vendor: string;
}

export async function searchIkea(query: string, market = "us/en", limit = 12): Promise<VendorHit[]> {
  const [cc, lang] = market.split("/");
  const url = `https://sik.search.blue.cdtapps.com/${cc}/${lang ?? "en"}/search-result-page?q=${encodeURIComponent(query)}&size=${limit}&types=PRODUCT`;
  const r = await fetchJson<{ searchResultPage?: { products?: { main?: { items?: { product: J }[] } } } }>(url, 12);
  const items = r.searchResultPage?.products?.main?.items ?? [];
  return items.slice(0, limit).map(({ product: p }) => {
    const sp = (p.salesPrice ?? {}) as J;
    return {
      name: `${p.name ?? ""} ${p.typeName ?? ""}`.trim(),
      description: (p.mainImageAlt as string) ?? undefined,
      url: String(p.pipUrl ?? ""),
      sku: String(p.id ?? p.itemNo ?? "") || undefined,
      price: typeof sp.numeral === "number" ? sp.numeral : undefined,
      currency: (sp.currencyCode as string) ?? undefined,
      image: (p.mainImageUrl as string) ?? undefined,
      size: (p.itemMeasureReferenceText as string) || undefined,
      vendor: "IKEA",
    };
  });
}

export { download };
