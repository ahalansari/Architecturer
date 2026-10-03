/**
 * Products: real items from vendors (IKEA, Homecentre, Amazon, Wayfair...) or open libraries, kept in the
 * project's `products` catalogue and placed as furniture with `product: "<id>"`. A product contributes its furniture
 * type (for layout rules, sockets, plumbing...), its 3D model when the vendor publishes one, its size, and — for
 * parametric stand-ins without a model — its colour. `shoppingList` turns the placed products into a bill of
 * materials with prices per vendor.
 */
import { z } from "zod";
import { Id, Mat } from "../schema/common.js";
import { FURNITURE } from "./furniture.js";

export const ProductSchema = z
  .object({
    id: Id,
    name: z.string(),
    vendor: z.string().optional().describe("IKEA, Homecentre, Amazon, Wayfair, Poly Haven..."),
    url: z.string().optional().describe("Product page"),
    sku: z.string().optional().describe("Article / item number"),
    price: z.number().min(0).optional().describe("Unit price"),
    currency: z.string().optional().describe("ISO code: USD, KWD, AED, EUR..."),
    type: z.string().describe("Closest furniture type (list_furniture): drives layout checks, services and the stand-in model"),
    model: z.string().optional().describe("3D model: a .glb/.gltf/.obj URL or path, polyhaven:<id>, sketchfab:<uid>, future3d:<id>"),
    modelRotation: z.number().optional().describe("Extra yaw (degrees) when the model's front does not face -y"),
    width: z.number().positive().optional().describe("Metres, left-right facing the front"),
    depth: z.number().positive().optional(),
    height: z.number().positive().optional(),
    color: z.string().optional().describe("Main colour (#hex or RAL) for the stand-in when there is no model"),
    materials: z.record(z.string(), Mat).optional().describe("Slot materials for the stand-in, e.g. {fabric:'velvet_navy', frame:'wood_oak'}"),
    image: z.string().optional(),
    license: z.string().optional().describe("vendor (visualisation only, not for redistribution), CC0, CC-BY..."),
    notes: z.string().optional(),
  })
  .describe("A purchasable / downloadable item placed via furniture.product");
export type Product = z.output<typeof ProductSchema>;

const slugify = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/**
 * Product id from its name: the part before " - " / "," (vendors put the colourway there: "POÄNG Armchair -
 * birch veneer/Knisa light beige" → "poang_armchair"); the SKU is appended when that id is taken by another item.
 */
export function productId(name: string, sku: string | undefined, existing: { id: string; sku?: string; url?: string }[], url?: string): string {
  const head = slugify(name.split(/\s[-–—|]\s|,/)[0]).slice(0, 32).replace(/_+$/g, "") || "product";
  const clash = existing.find((p) => p.id === head);
  if (!clash || (sku && clash.sku === sku) || (url && clash.url === url)) return head;
  const tail = (sku ?? "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(-8) || String(existing.filter((p) => p.id.startsWith(head)).length + 1);
  return `${head}_${tail}`;
}

const SLOT_PRIORITY = ["fabric", "upholstery", "duvet", "body", "main", "cushion", "frame", "top", "wood", "shade", "metal"];
/** Slots that take the product colour along with the primary one (sofa cushions, pillowcases of a duvet set). */
const TINT_ALSO: Record<string, string[]> = { body: ["cushions"], duvet: ["pillows"] };

/** Main material slot of a furniture type (the one a product colour tints). */
export function primarySlot(type: string): string | undefined {
  const slots = Object.keys(FURNITURE[type]?.slots ?? {});
  return SLOT_PRIORITY.find((s) => slots.includes(s)) ?? slots[0];
}

type Json = Record<string, unknown>;

/**
 * Expand `furniture.product` references in a raw plan (before parsing): fills type, model, size and stand-in
 * materials unless the furniture item sets them itself. Returns errors for unknown product ids.
 */
export function applyProducts(input: unknown): { input: unknown; errors: string[] } {
  const errors: string[] = [];
  if (!input || typeof input !== "object") return { input, errors };
  const p = input as Json;
  const products = Array.isArray(p.products) ? (p.products as Json[]) : [];
  const levels = Array.isArray(p.levels) ? (p.levels as Json[]) : [];
  const ids = new Set(products.map((x) => x.id));
  for (const lv of levels)
    for (const [ci, cw] of ((lv.casework as Json[]) ?? []).entries()) {
      const refs = [...(((cw.modules as Json[]) ?? []).map((m) => m.product)), ...(((cw.uppers as Json[]) ?? []).map((m) => m.product)), ...(((cw.products as Json[]) ?? []).map((x) => x.product))];
      for (const r of refs) if (r !== undefined && !ids.has(r)) errors.push(`level '${lv.id}': casework '${cw.id ?? ci}': unknown product '${r}'`);
    }
  if (!levels.some((l) => Array.isArray(l.furniture) && (l.furniture as Json[]).some((f) => f && f.product))) return { input, errors };
  const out: Json = { ...p, materials: { ...((p.materials as Json) ?? {}) }, levels: levels.map((l) => ({ ...l })) };
  const mats = out.materials as Json;
  for (const lv of out.levels as Json[]) {
    if (!Array.isArray(lv.furniture)) continue;
    lv.furniture = (lv.furniture as Json[]).map((f, i) => {
      if (!f || typeof f !== "object" || !f.product) return f;
      const pr = products.find((x) => x.id === f.product);
      if (!pr) {
        errors.push(`level '${lv.id}': furniture[${i}]${f.id ? ` '${f.id}'` : ""}: unknown product '${f.product}' (products: ${products.map((x) => x.id).join(", ") || "none"})`);
        return { type: "box", ...f };
      }
      const g: Json = { ...f };
      g.type ??= pr.type;
      if (pr.model && g.model === undefined) g.model = pr.model;
      if (pr.modelRotation !== undefined && g.modelRotation === undefined) g.modelRotation = pr.modelRotation;
      // a placement that sizes a model item itself (e.g. only its height) scales it proportionally instead
      const ownSize = ["width", "depth", "height"].some((k) => g[k] !== undefined);
      if (!(ownSize && g.model)) for (const k of ["width", "depth", "height"]) if (g[k] === undefined && pr[k] !== undefined) g[k] = pr[k];
      if (!g.model) {
        const m: Json = { ...((pr.materials as Json) ?? {}), ...((g.materials as Json) ?? {}) };
        const slot = primarySlot(String(g.type));
        if (pr.color && slot && m[slot] === undefined) {
          const name = `product_${pr.id}`;
          const slots = FURNITURE[String(g.type)]?.slots ?? {};
          mats[name] ??= { base: slots[slot] ?? "plaster_white", color: pr.color };
          m[slot] = name;
          // upholstered pieces: the cushions match the body; a duvet set includes the pillowcases
          for (const extra of TINT_ALSO[slot] ?? [])
            if (slots[extra] && m[extra] === undefined) {
              mats[`${name}_${extra}`] ??= { base: slots[extra], color: pr.color };
              m[extra] = `${name}_${extra}`;
            }
        }
        g.materials = m;
      }
      return g;
    });
  }
  return { input: out, errors };
}

export interface ShoppingLine {
  product: string;
  name: string;
  vendor: string;
  sku?: string;
  url?: string;
  quantity: number;
  unitPrice?: number;
  currency?: string;
  total?: number;
  levels: string[];
}

/** Bill of materials for the products placed in a (parsed or raw) plan. */
type CaseRef = { product?: string };
type CaseRun = { modules?: CaseRef[]; uppers?: CaseRef[]; products?: { product: string; qty?: number }[] };

export function shoppingList(project: { products?: Product[]; levels: { id: string; furniture?: { product?: string }[]; casework?: CaseRun[] }[] }): { lines: ShoppingLine[]; totals: { vendor: string; currency: string; total: number; items: number }[] } {
  const lines = new Map<string, ShoppingLine>();
  const add = (lvId: string, id: string | undefined, qty: number) => {
    if (!id) return;
    const p = project.products?.find((x) => x.id === id);
    if (!p) return;
    const l = lines.get(p.id) ?? { product: p.id, name: p.name, vendor: p.vendor ?? "—", sku: p.sku, url: p.url, quantity: 0, unitPrice: p.price, currency: p.currency, levels: [] };
    l.quantity += qty;
    if (!l.levels.includes(lvId)) l.levels.push(lvId);
    lines.set(p.id, l);
  };
  for (const lv of project.levels) {
    for (const f of lv.furniture ?? []) add(lv.id, f.product, 1);
    // built-in cabinetry: each module that is a real cabinet, plus the run's worktops, appliances and fittings
    for (const cw of lv.casework ?? []) {
      for (const m of [...(cw.modules ?? []), ...(cw.uppers ?? [])]) add(lv.id, m.product, 1);
      for (const x of cw.products ?? []) add(lv.id, x.product, x.qty ?? 1);
    }
  }
  const out = [...lines.values()]
    .map((l) => ({ ...l, total: l.unitPrice !== undefined ? Math.round(l.unitPrice * l.quantity * 100) / 100 : undefined }))
    .sort((a, b) => a.vendor.localeCompare(b.vendor) || a.name.localeCompare(b.name));
  const totals = new Map<string, { vendor: string; currency: string; total: number; items: number }>();
  for (const l of out) {
    const k = `${l.vendor}|${l.currency ?? "?"}`;
    const t = totals.get(k) ?? { vendor: l.vendor, currency: l.currency ?? "?", total: 0, items: 0 };
    t.total = Math.round((t.total + (l.total ?? 0)) * 100) / 100;
    t.items += l.quantity;
    totals.set(k, t);
  }
  return { lines: out, totals: [...totals.values()] };
}
