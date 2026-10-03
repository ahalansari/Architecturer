/**
 * Works contracts generated from a plan: the package's schedule of quantities (measured by the cost estimate,
 * at its rates, or at labour-only rates), payment stages, programme and the bilingual articles. The result is
 * a renderer-neutral document (English part, then Arabic part) that render.ts turns into HTML or Word.
 */
import { estimate, type BillLine } from "../cost/estimate.js";
import { marketRate } from "../cost/market.js";
import { polygonArea, type Vec2 } from "../geometry/math.js";
import type { Compiled } from "../pipeline.js";
import { bi, packageById, type Bi, type BuildingFacts, type Mode, type TradePackage } from "./packages.js";
import { itemAr, unitAr } from "./terms.js";

export interface Party {
  name?: string;
  nameAr?: string;
  company?: string;
  companyAr?: string;
  representative?: string;
  representativeAr?: string;
  nationality?: string;
  nationalityAr?: string;
  civilId?: string;
  commercialLicence?: string;
  phone?: string;
  email?: string;
  address?: string;
  addressAr?: string;
}

export interface SiteLocation {
  governorate?: string;
  area?: string;
  block?: string;
  street?: string;
  avenue?: string;
  plot?: string;
  house?: string;
  paci?: string;
}

export interface ContractOptions {
  package: string;
  mode?: Mode;
  owner?: Party;
  contractor?: Party;
  location?: SiteLocation;
  /** Contract date, ISO (default today). */
  date?: string;
  /** Start of works, ISO (default: 7 days after the contract date). */
  startDate?: string;
  durationDays?: number;
  retention?: number;
  defectsMonths?: number;
  delayPenaltyPerDay?: number;
  delayPenaltyCap?: number;
  /** Rate overrides: 'labour:<key>' (or '<key>' for labour-only contracts) → rate. */
  rates?: Record<string, number>;
  /** Main contract: also kitchens and built-in joinery (default: let separately). */
  includeJoinery?: boolean;
  /** Extra special conditions, in both languages. */
  extraTerms?: Bi[];
}

export type RateBasis = "bill" | "override" | "labour-researched" | "labour-estimated";

export interface ContractItem {
  ref: string;
  en: string;
  ar: string;
  unit: string;
  qty: number;
  rate: number;
  amount: number;
  basis: RateBasis;
}

export interface Payment {
  no: number;
  label: Bi;
  pct: number;
  amount: number;
}

export interface Contract {
  id: string;
  pkg: TradePackage;
  mode: Mode;
  project: string;
  currency: string;
  date: string;
  startDate: string;
  endDate: string;
  durationDays: number;
  items: ContractItem[];
  subtotal: number;
  adjustments: { label: Bi; pct: number; amount: number }[];
  value: number;
  payments: Payment[];
  retention: number;
  defectsMonths: number;
  penaltyPerDay: number;
  penaltyCap: number;
  owner: Party;
  contractor: Party;
  location: SiteLocation;
  extraTerms: Bi[];
  /** Warnings for whoever generates the contract (not printed). */
  notes: string[];
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const r2 = (x: number) => Math.round(x * 100) / 100;
const addDays = (iso: string, d: number) => new Date(Date.parse(iso) + d * 86400e3).toISOString().slice(0, 10);

/** Where a labour-only rate for a bill item can be found in the researched rates (labour:<key> or a family rate). */
function labourKeys(key: string): string[] {
  const out = [`labour:${key}`];
  if (/^floor:(marble|terrazzo|stone)/.test(key)) out.push("labour:floor:marble");
  else if (/^floor:(tiles|hex_tiles|mosaic|zellige|paving)/.test(key)) out.push("labour:floor:tiles");
  if (/^wall:(tiles|zellige|mosaic|hex_tiles|marble|stone)/.test(key)) out.push("labour:wall:tiles");
  if (key === "wall:block_insulated_200") out.push("labour:wall:block_200");
  if (/^(point|fixture):/.test(key)) out.push("labour:electrical_point");
  if (/^sanitary:/.test(key)) out.push("labour:plumbing_fixture");
  return out;
}

export function buildContract(c: Compiled, opts: ContractOptions): Contract {
  if (!c.project) throw new Error("the plan has errors; fix them first");
  const pkg = packageById(opts.package);
  const mode: Mode = opts.mode ?? pkg.modes[0];
  if (!pkg.modes.includes(mode)) throw new Error(`${pkg.id} is let as ${pkg.modes.join(" or ")} only (supply and installation by a specialist)`);
  const project = c.project;
  const settings = (project as { contract?: Record<string, unknown> }).contract ?? {};
  const bill = estimate(c, { scope: "full" });
  const notes: string[] = [];

  // ---- schedule of quantities ----
  const lines: { section: string; line: BillLine }[] = [];
  for (const s of bill.sections)
    for (const line of s.lines) {
      const l = { section: s.code, key: line.key, description: line.description };
      if (pkg.match(l) || (pkg.id === "main" && opts.includeJoinery && s.code === "E")) lines.push({ section: s.code, line });
    }
  if (!lines.length) throw new Error(`the plan has nothing for the '${pkg.id}' package (no ${pkg.title.en.toLowerCase()} measured)`);
  const costRates = project.costs.rates;
  // Kuwaiti contractors price skeleton labour per m² of built-up area (formwork, steel fixing and casting
  // together), not per m³ / t / m²: with that rate, one line replaces the concrete, rebar and formwork lines
  const skeleton = mode === "labour" && (pkg.id === "structure" || pkg.id === "main") && bill.floorArea > 0
    ? opts.rates?.["labour:skeleton_m2"] ?? costRates["labour:skeleton_m2"] ?? marketRate("labour:skeleton_m2")?.value ?? undefined
    : undefined;
  const SKELETON_KEYS = /^struct:(concrete_m3|rebar_t|formwork_m2|blinding_m3)$/;
  let skeletonAt = -1;
  if (skeleton !== undefined && skeleton !== null) {
    skeletonAt = lines.findIndex(({ line }) => SKELETON_KEYS.test(line.key ?? ""));
    for (let i = lines.length - 1; i >= 0; i--) if (SKELETON_KEYS.test(lines[i].line.key ?? "") && i !== skeletonAt) lines.splice(i, 1);
    notes.push(
      `Skeleton labour is one rate per m² of built-up area (${bill.floorArea} m² × ${skeleton}), as Kuwaiti contractors price it. Such rates often include laying the block walls: if this contractor's does, don't let the blockwork package separately.`,
    );
  }
  let estimated = 0;
  const items: ContractItem[] = lines.map(({ line }, i) => {
    if (i === skeletonAt) {
      const own = opts.rates?.["labour:skeleton_m2"] ?? costRates["labour:skeleton_m2"];
      const rate = r3(skeleton as number);
      return {
        ref: `${i + 1}`,
        en: "Skeleton labour: formwork, steel fixing and casting of foundations, tie beams, slabs, columns, beams and stairs, per m² of built-up area",
        ar: "مصنعية الهيكل الأسود: النجارة والحدادة والصب للأساسات والميد والأسقف والأعمدة والجسور والدرج، للمتر المربع من مسطح البناء",
        unit: "m²",
        qty: bill.floorArea,
        rate,
        amount: r3(bill.floorArea * rate),
        basis: own !== undefined ? "override" : "labour-researched",
      };
    }
    let rate = line.rate;
    let basis: RateBasis = "bill";
    const key = line.key;
    const own = key !== undefined ? opts.rates?.[mode === "labour" ? `labour:${key}` : key] ?? (mode === "labour" ? opts.rates?.[key] : undefined) : undefined;
    if (own !== undefined) {
      rate = own;
      basis = "override";
    } else if (mode === "labour") {
      const keys = key ? labourKeys(key) : [];
      const fromProject = keys.map((k) => costRates[k]).find((v) => v !== undefined);
      const researched = keys.map((k) => marketRate(k)).find((m) => m && m.value !== null);
      if (fromProject !== undefined) {
        rate = fromProject;
        basis = "override";
      } else if (researched) {
        rate = researched.value!;
        basis = "labour-researched";
      } else {
        rate = line.rate * pkg.labourShare;
        basis = "labour-estimated";
        estimated++;
      }
    }
    rate = r3(rate);
    return { ref: `${i + 1}`, en: line.description, ar: itemAr(key, line.description), unit: line.unit, qty: line.qty, rate, amount: r3(line.qty * rate), basis };
  });
  if (estimated)
    notes.push(
      `${estimated} labour-only rate(s) are estimated at ${Math.round(pkg.labourShare * 100)}% of the supply & install rate (marked *): agree them with the contractor or pass rates {"labour:<key>": rate}.`,
    );
  const subtotal = r3(items.reduce((a, it) => a + it.amount, 0));

  // the main contractor's preliminaries and overhead & profit (trade contracts' rates already carry theirs)
  const adjustments: Contract["adjustments"] = [];
  if (pkg.id === "main" && mode === "supply")
    for (const a of bill.adjustments) {
      const pre = /prelim/i.test(a.label), ohp = /overhead/i.test(a.label);
      if (!pre && !ohp) continue;
      adjustments.push({
        label: pre ? bi("Preliminaries and site establishment", "التجهيزات والمصاريف العامة للموقع") : bi("Contractor's overhead and profit", "المصاريف الإدارية وأرباح المقاول"),
        pct: a.percent,
        amount: r3((subtotal * a.percent) / 100),
      });
    }
  const value = r3(subtotal + adjustments.reduce((a, x) => a + x.amount, 0));

  // ---- programme and payments ----
  const suspended = Math.max(0, c.levels.length - 1);
  const roomArea = project.levels.reduce((a, l) => a + l.rooms.reduce((s, r) => s + polygonArea(r.polygon as Vec2[]), 0), 0);
  const floorArea = roomArea > 0 ? roomArea : 150 * c.levels.length;
  const facts: BuildingFacts = { levels: c.levels.length, suspendedSlabs: suspended, floorArea };
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const startDate = opts.startDate ?? addDays(date, 7);
  const durationDays = opts.durationDays ?? pkg.durationDays(facts);
  const stages = pkg.milestones(facts, mode);
  let left = value;
  const payments: Payment[] = stages.map((m, i) => {
    const amount = i === stages.length - 1 ? r3(left) : r3((value * m.pct) / 100);
    left -= amount;
    return { no: i + 1, label: m.label, pct: m.pct, amount };
  });
  const retention = opts.retention ?? (settings.retention as number | undefined) ?? 5;
  const penaltyPerDay = opts.delayPenaltyPerDay ?? (settings.delayPenaltyPerDay as number | undefined) ?? Math.max(1, Math.round(value * 0.001 * 2) / 2);
  const slug = (project.name || "project").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24).toUpperCase() || "PROJECT";
  return {
    id: `${slug}-${pkg.id.toUpperCase()}-${date.replace(/-/g, "")}`,
    pkg,
    mode,
    project: project.name,
    currency: project.costs.currency,
    date,
    startDate,
    endDate: addDays(startDate, durationDays),
    durationDays,
    items,
    subtotal,
    adjustments,
    value,
    payments,
    retention,
    defectsMonths: opts.defectsMonths ?? (settings.defectsMonths as number | undefined) ?? 12,
    penaltyPerDay,
    penaltyCap: opts.delayPenaltyCap ?? (settings.delayPenaltyCap as number | undefined) ?? 10,
    owner: { ...((settings.owner as Party | undefined) ?? {}), ...(opts.owner ?? {}) },
    contractor: opts.contractor ?? {},
    location: { ...((settings.location as SiteLocation | undefined) ?? {}), ...(opts.location ?? {}) },
    extraTerms: opts.extraTerms ?? [],
    notes,
  };
}

// ---------------------------------------------------------------------------
// the document: blocks a renderer lays out (English part, then Arabic part)

export type Block =
  | { t: "title"; text: string; sub?: string }
  | { t: "meta"; text: string }
  | { t: "h"; text: string }
  | { t: "p"; text: string }
  | { t: "list"; items: string[] }
  | { t: "fields"; title: string; rows: [string, string][] }
  | { t: "table"; head: string[]; rows: string[][]; foot?: string[][]; numeric: number[] }
  | { t: "sign"; parties: { title: string; lines: string[] }[] }
  | { t: "break" };

export interface ContractDoc {
  en: Block[];
  ar: Block[];
  contract: Contract;
}

const BLANK = "....................................";
const money = (x: number) => x.toLocaleString("en-US", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const fmtDate = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
};
const qtyText = (q: number) => (Number.isInteger(q) ? String(q) : r2(q).toFixed(2));

export function contractDocument(k: Contract): ContractDoc {
  return { en: english(k), ar: arabic(k), contract: k };
}

function locationText(l: SiteLocation, lang: "en" | "ar"): string {
  const parts: [string, string, string | undefined][] = [
    ["Governorate", "محافظة", l.governorate],
    ["Area", "منطقة", l.area],
    ["Block", "قطعة", l.block],
    ["Street", "شارع", l.street],
    ["Avenue", "جادة", l.avenue],
    ["Plot", "قسيمة", l.plot],
    ["House", "منزل", l.house],
    ["PACI no.", "الرقم الآلي", l.paci],
  ];
  const filled = parts.filter((p) => p[2]);
  if (!filled.length) return lang === "en" ? `Area ${BLANK}, Block ......, Plot ......` : `منطقة ${BLANK} قطعة (......) قسيمة (......)`;
  return filled.map(([en, ar, v]) => `${lang === "en" ? en : ar} ${v}`).join(lang === "en" ? ", " : "، ");
}

function partyRows(p: Party, role: "owner" | "contractor", lang: "en" | "ar"): [string, string][] {
  const v = (x?: string) => x || BLANK;
  const en = lang === "en";
  const name = en ? p.name : p.nameAr ?? p.name;
  const rows: [string, string][] = [];
  if (role === "contractor" && (p.company || p.companyAr || !p.name)) {
    rows.push([en ? "Company" : "الشركة / المؤسسة", v(en ? p.company : p.companyAr ?? p.company)]);
    rows.push([en ? "Commercial licence no." : "رقم الترخيص التجاري", v(p.commercialLicence)]);
    rows.push([en ? "Represented by" : "ويمثلها في التوقيع", v(en ? p.representative ?? p.name : p.representativeAr ?? p.nameAr ?? p.representative ?? p.name)]);
  } else rows.push([en ? "Name" : "الاسم", v(name)]);
  rows.push([en ? "Nationality" : "الجنسية", v(en ? p.nationality : p.nationalityAr ?? p.nationality)]);
  rows.push([en ? "Civil ID no." : "الرقم المدني", v(p.civilId)]);
  rows.push([en ? "Phone" : "الهاتف", v(p.phone)]);
  if (p.email) rows.push([en ? "Email" : "البريد الإلكتروني", p.email]);
  rows.push([en ? "Address" : "العنوان", v(en ? p.address : p.addressAr ?? p.address)]);
  return rows;
}

function scheduleTable(k: Contract, lang: "en" | "ar"): Block {
  const en = lang === "en";
  const cur = en ? k.currency : k.currency === "KWD" ? "د.ك" : k.currency;
  const mark = (b: RateBasis) => (b === "labour-estimated" ? " *" : "");
  const foot: string[][] = [];
  if (k.adjustments.length) {
    foot.push(["", en ? "Subtotal" : "المجموع", "", "", "", money(k.subtotal)]);
    for (const a of k.adjustments) foot.push(["", `${en ? a.label.en : a.label.ar} (${a.pct}%)`, "", "", "", money(a.amount)]);
  }
  foot.push(["", en ? `Contract value (${cur})` : `قيمة العقد (${cur})`, "", "", "", money(k.value)]);
  return {
    t: "table",
    head: en ? ["No.", "Description", "Unit", "Qty", `Rate (${cur})`, `Amount (${cur})`] : ["م", "البيان", "الوحدة", "الكمية", `سعر الوحدة (${cur})`, `المبلغ (${cur})`],
    rows: k.items.map((it) => [it.ref, en ? it.en : it.ar, en ? it.unit : unitAr(it.unit), qtyText(it.qty), money(it.rate) + mark(it.basis), money(it.amount)]),
    foot,
    numeric: [3, 4, 5],
  };
}

function paymentTable(k: Contract, lang: "en" | "ar"): Block {
  const en = lang === "en";
  const cur = en ? k.currency : k.currency === "KWD" ? "د.ك" : k.currency;
  return {
    t: "table",
    head: en
      ? ["No.", "Stage", "%", `Amount (${cur})`, `Retention ${k.retention}%`, `Net payable (${cur})`]
      : ["الدفعة", "المرحلة", "النسبة", `المبلغ (${cur})`, `المحجوز ${k.retention}%`, `الصافي المستحق (${cur})`],
    rows: k.payments.map((p) => {
      const held = r3((p.amount * k.retention) / 100);
      return [String(p.no), en ? p.label.en : p.label.ar, `${p.pct}%`, money(p.amount), money(held), money(r3(p.amount - held))];
    }),
    foot: [
      ["", en ? "Total" : "الإجمالي", "100%", money(k.value), money(r3((k.value * k.retention) / 100)), money(r3(k.value - (k.value * k.retention) / 100))],
      ["", en ? `Retention released at the end of the ${k.defectsMonths}-month defects liability period` : `يصرف المحجوز بعد انتهاء فترة الضمان ومدتها ${k.defectsMonths} شهراً`, "", "", money(r3((k.value * k.retention) / 100)), ""],
    ],
    numeric: [2, 3, 4, 5],
  };
}

function english(k: Contract): Block[] {
  const labour = k.mode === "labour";
  const p = k.pkg;
  const n = { i: 0 };
  const art = (title: string) => ({ t: "h" as const, text: `Article ${++n.i}: ${title}` });
  const contractor = k.contractor.company || k.contractor.name || BLANK;
  const b: Block[] = [
    { t: "title", text: "WORKS CONTRACT", sub: `${p.title.en}${labour ? " — labour only" : " — supply and installation"}` },
    { t: "meta", text: `Contract no. ${k.id} · Date ${fmtDate(k.date)} · Project: ${k.project}` },
    { t: "p", text: `This contract is made on ${fmtDate(k.date)} between:` },
    { t: "fields", title: "First party (the Owner)", rows: partyRows(k.owner, "owner", "en") },
    { t: "fields", title: "Second party (the Contractor)", rows: partyRows(k.contractor, "contractor", "en") },
    {
      t: "p",
      text: `Whereas the first party owns the plot located at ${locationText(k.location, "en")}, and wishes to carry out the ${p.title.en.toLowerCase()} for the project "${k.project}" in accordance with the approved drawings; and whereas the second party has inspected the site and the drawings and has agreed to carry out these works on the terms below; the parties, having full legal capacity to contract, have agreed as follows:`,
    },
    art("Preamble and contract documents"),
    {
      t: "p",
      text: "The preamble above forms an integral part of this contract, together with: Annex 1, the schedule of quantities and prices; Annex 2, the payment schedule; and the approved drawings of the project. In case of conflict, this contract prevails, then the annexes, then the drawings.",
    },
    art("Scope of works"),
    { t: "p", text: `The second party shall carry out the following works${labour ? " (labour only, with the materials supplied by the first party as set out in Article 4)" : ", supplying all materials, labour and equipment"}:` },
    { t: "list", items: p.scope.map((x) => x.en) },
    art("Specification and quality"),
    { t: "list", items: [...p.spec.map((x) => x.en), "All work shall follow good engineering practice in Kuwait and the instructions of the first party's supervising engineer. The first party or the engineer may inspect the works at any time and reject defective work, which the second party shall remove and redo at its own cost."] },
    art("Materials, labour and equipment"),
    ...(labour
      ? ([
          { t: "p", text: "The first party shall supply the following materials to site in good time for the works:" },
          { t: "list", items: p.ownerSupplies.map((x) => x.en) },
          { t: "p", text: "The second party shall request materials in writing at least 3 working days before they are needed, store and use them properly, and is responsible for any loss or for wastage above 5%, which shall be deducted from its payments at cost." },
        ] as Block[])
      : ([{ t: "p", text: "The second party shall supply all materials, which shall be new, to the approved specification and to samples approved by the first party before ordering. Ownership of materials passes to the first party on delivery to site; the second party bears the risk of loss or damage until handover." }] as Block[])),
    { t: "p", text: "The second party shall provide at its own cost:" },
    { t: "list", items: p.contractorProvides.map((x) => x.en) },
    art("Contract price"),
    {
      t: "p",
      text: `The contract price is ${money(k.value)} ${k.currency} (in words: ${BLANK}), calculated from the quantities and unit rates in Annex 1. The quantities are estimated from the drawings; the final account shall be based on the quantities actually executed, measured jointly on site${p.measurement ? ` (${p.measurement.en.charAt(0).toLowerCase()}${p.measurement.en.slice(1)})` : ""}, at the contract rates. The rates are fixed for the duration of the contract and include everything needed to complete each item.`,
    },
    art("Payments"),
    {
      t: "p",
      text: `The first party shall pay the contract price in the stages set out in Annex 2. Each payment falls due on completion of its stage, as verified by the first party or its engineer, and shall be paid within 7 days of verification. ${k.retention}% of each payment is retained and released at the end of the defects liability period, after any defects have been made good. The final payment is made on handover and agreement of the final account.`,
    },
    art("Programme and delay"),
    {
      t: "p",
      text: `The second party shall start the works on ${fmtDate(k.startDate)} (or within 7 days of the first party's written notice to start, if later) and complete them within ${k.durationDays} calendar days, that is by ${fmtDate(k.endDate)}. The period is extended only for delays caused by the first party, by variations, or by force majeure, notified in writing within 7 days of their occurrence. For each day of delay beyond the completion date the second party shall pay a penalty of ${money(k.penaltyPerDay)} ${k.currency}, deducted from its payments, up to a maximum of ${k.penaltyCap}% of the contract price.`,
    },
    art("Variations"),
    {
      t: "p",
      text: "No variation, addition or omission shall be made without the first party's written instruction. Additional work is valued at the contract rates where they apply, otherwise at a rate agreed in writing before the work is carried out. Omitted work is deducted at the contract rates.",
    },
    art("Obligations of the second party"),
    {
      t: "list",
      items: [
        "Comply with the laws of the State of Kuwait, the regulations of Kuwait Municipality and the competent authorities, and the labour and residency laws for all its workers.",
        "Take all safety measures on site, provide its workers with protective equipment, and bear sole responsibility for any injury to its workers or to third parties, or damage to property, arising from its work.",
        "Protect the works of other trades, neighbouring properties and public utilities, and make good any damage it causes at its own cost.",
        "Not assign or subcontract the works or any part of them without the first party's written consent.",
        "Keep the site clean and tidy, remove its debris, and maintain a competent foreman on site during working hours.",
        "Not stop or slow down the works except as allowed under Article 9.",
      ],
    },
    art("Obligations of the first party"),
    {
      t: "list",
      items: [
        "Give the second party access to the site and provide water and electricity for the works.",
        labour ? "Supply the materials listed in Article 4 in good time." : "Approve samples and shop drawings within 7 days of their submission.",
        "Make the payments on time. If a verified payment remains unpaid 14 days after the second party's written notice, the second party may suspend the works until it is paid, and the completion date is extended by the period of suspension.",
      ],
    },
    art("Handover and defects liability"),
    {
      t: "p",
      text: `On completion the parties shall inspect the works together and record any defects, which the second party shall make good before handover is signed. The second party shall make good, at its own cost, any defect appearing within ${k.defectsMonths} months of handover within 7 days of written notice; failing that, the first party may have it made good by others and deduct the cost from the retention or any sum due to the second party.${p.structural ? " In addition, the second party remains liable under the Kuwaiti Civil Code for ten years from handover for the total or partial collapse of the structure, and for defects that threaten its stability or safety." : ""}`,
    },
    art("Termination"),
    {
      t: "p",
      text: "The first party may terminate this contract by written notice if the second party abandons the works for 7 consecutive days, fails to make satisfactory progress, repeatedly executes defective work, or subcontracts without consent, and fails to remedy the breach within 7 days of written notice. The first party may then complete the works by others at the second party's cost, and the second party is entitled only to the value of work properly executed, less those costs and any penalties. The second party may terminate if the first party fails to pay a verified payment within 30 days of written notice.",
    },
    art("Governing law and disputes"),
    { t: "p", text: "This contract is governed by the laws of the State of Kuwait. The parties shall seek to settle any dispute amicably within 15 days; failing that, the courts of the State of Kuwait have jurisdiction." },
  ];
  if (k.extraTerms.length) b.push(art("Special conditions"), { t: "list", items: k.extraTerms.map((x) => x.en) });
  b.push(
    art("Language and copies"),
    { t: "p", text: "This contract is written in English and Arabic. In case of any difference between the two texts, the Arabic text prevails. It is made in two original copies, one for each party to act upon." },
    {
      t: "sign",
      parties: [
        { title: "First party (Owner)", lines: ["Name: " + (k.owner.name || BLANK), "Signature: ...............................", "Date: ......../......../........"] },
        { title: "Second party (Contractor)", lines: [`Name: ${contractor}`, "Signature and stamp: ...............................", "Date: ......../......../........"] },
      ],
    },
    { t: "sign", parties: [{ title: "Witness 1", lines: ["Name: " + BLANK, "Signature: ..............................."] }, { title: "Witness 2", lines: ["Name: " + BLANK, "Signature: ..............................."] }] },
    { t: "break" },
    { t: "h", text: "Annex 1: Schedule of quantities and prices" },
    {
      t: "p",
      text: `Quantities measured from the project model; ${labour ? "rates for labour only" : "rates for supply and installation"}.${k.items.some((i) => i.basis === "labour-estimated") ? " Rates marked * are estimates to be confirmed with the contractor." : ""}`,
    },
    scheduleTable(k, "en"),
    { t: "h", text: "Annex 2: Payment schedule" },
    paymentTable(k, "en"),
  );
  return b;
}

function arabic(k: Contract): Block[] {
  const labour = k.mode === "labour";
  const p = k.pkg;
  const ARTS = ["الأول", "الثاني", "الثالث", "الرابع", "الخامس", "السادس", "السابع", "الثامن", "التاسع", "العاشر", "الحادي عشر", "الثاني عشر", "الثالث عشر", "الرابع عشر", "الخامس عشر"];
  const n = { i: 0 };
  const art = (title: string) => ({ t: "h" as const, text: `البند ${ARTS[n.i++] ?? n.i}: ${title}` });
  const cur = k.currency === "KWD" ? "د.ك" : k.currency;
  const contractor = k.contractor.companyAr || k.contractor.company || k.contractor.nameAr || k.contractor.name || BLANK;
  const b: Block[] = [
    { t: "title", text: "عقد مقاولة", sub: `${p.title.ar}${labour ? " — مصنعية فقط" : " — توريد وتركيب"}` },
    { t: "meta", text: `رقم العقد ${k.id} · التاريخ ${fmtDate(k.date)} · المشروع: ${k.project}` },
    { t: "p", text: `إنه في يوم .................. الموافق ${fmtDate(k.date)} تم الاتفاق بين كل من:` },
    { t: "fields", title: "الطرف الأول (المالك)", rows: partyRows(k.owner, "owner", "ar") },
    { t: "fields", title: "الطرف الثاني (المقاول)", rows: partyRows(k.contractor, "contractor", "ar") },
    {
      t: "p",
      text: `حيث إن الطرف الأول يملك القسيمة الكائنة في ${locationText(k.location, "ar")}، ويرغب في تنفيذ ${p.title.ar} لمشروع "${k.project}" طبقاً للمخططات المعتمدة، وحيث إن الطرف الثاني قد عاين الموقع والمخططات ووافق على تنفيذ هذه الأعمال وفق الشروط التالية، فقد اتفق الطرفان وهما بكامل أهليتهما القانونية للتعاقد على ما يلي:`,
    },
    art("التمهيد ومستندات العقد"),
    { t: "p", text: "يعتبر التمهيد السابق جزءاً لا يتجزأ من هذا العقد، وكذلك: الملحق رقم (1) جدول الكميات والأسعار، والملحق رقم (2) جدول الدفعات، والمخططات المعتمدة للمشروع. وفي حال التعارض يقدم هذا العقد ثم الملاحق ثم المخططات." },
    art("نطاق الأعمال"),
    { t: "p", text: `يلتزم الطرف الثاني بتنفيذ الأعمال التالية${labour ? " (مصنعية فقط، على أن يورد الطرف الأول المواد حسب البند الرابع)" : " شاملة توريد جميع المواد والعمالة والمعدات"}:` },
    { t: "list", items: p.scope.map((x) => x.ar) },
    art("المواصفات والجودة"),
    { t: "list", items: [...p.spec.map((x) => x.ar), "تنفذ جميع الأعمال طبقاً للأصول الفنية المتعارف عليها في دولة الكويت وتعليمات المهندس المشرف من قبل الطرف الأول، وللطرف الأول أو المهندس معاينة الأعمال في أي وقت ورفض الأعمال المخالفة، ويلتزم الطرف الثاني بإزالتها وإعادة تنفيذها على حسابه."] },
    art("المواد والعمالة والمعدات"),
    ...(labour
      ? ([
          { t: "p", text: "يلتزم الطرف الأول بتوريد المواد التالية إلى الموقع في الوقت المناسب للأعمال:" },
          { t: "list", items: p.ownerSupplies.map((x) => x.ar) },
          { t: "p", text: "يلتزم الطرف الثاني بطلب المواد كتابياً قبل الحاجة إليها بثلاثة أيام عمل على الأقل، وبتخزينها واستعمالها بالشكل السليم، ويتحمل مسؤولية أي فقد أو هدر يزيد على 5%، وتخصم قيمته من مستحقاته بسعر التكلفة." },
        ] as Block[])
      : ([{ t: "p", text: "يلتزم الطرف الثاني بتوريد جميع المواد على أن تكون جديدة ومطابقة للمواصفات وللعينات المعتمدة من الطرف الأول قبل التوريد، وتنتقل ملكية المواد للطرف الأول عند توريدها للموقع، ويتحمل الطرف الثاني مخاطر فقدها أو تلفها حتى التسليم." }] as Block[])),
    { t: "p", text: "يوفر الطرف الثاني على نفقته الخاصة:" },
    { t: "list", items: p.contractorProvides.map((x) => x.ar) },
    art("قيمة العقد"),
    {
      t: "p",
      text: `قيمة هذا العقد ${money(k.value)} ${cur} (فقط ${BLANK} لا غير)، محسوبة من الكميات وأسعار الوحدات الواردة في الملحق رقم (1). والكميات تقديرية من المخططات، ويتم الحساب الختامي على أساس الكميات المنفذة فعلياً والمقاسة في الموقع بحضور الطرفين${p.measurement ? ` (${p.measurement.ar})` : ""} وبأسعار العقد. والأسعار ثابتة طوال مدة العقد وشاملة كل ما يلزم لإنجاز كل بند.`,
    },
    art("الدفعات"),
    {
      t: "p",
      text: `يدفع الطرف الأول قيمة العقد على دفعات حسب الملحق رقم (2)، وتستحق كل دفعة عند إنجاز مرحلتها والتحقق منها من قبل الطرف الأول أو مهندسه، وتصرف خلال 7 أيام من التحقق. ويحتجز من كل دفعة نسبة ${k.retention}% تصرف بعد انتهاء فترة الضمان وإصلاح أي عيوب، وتصرف الدفعة الأخيرة عند التسليم واعتماد الحساب الختامي.`,
    },
    art("مدة التنفيذ وغرامة التأخير"),
    {
      t: "p",
      text: `يبدأ الطرف الثاني الأعمال بتاريخ ${fmtDate(k.startDate)} (أو خلال 7 أيام من إخطار الطرف الأول الكتابي بالبدء أيهما لاحق)، وينجزها خلال ${k.durationDays} يوماً تقويمياً أي في موعد أقصاه ${fmtDate(k.endDate)}. ولا تمدد المدة إلا بسبب تأخير من الطرف الأول أو أعمال إضافية أو قوة قاهرة يتم الإخطار بها كتابياً خلال 7 أيام من وقوعها. وعن كل يوم تأخير بعد موعد الإنجاز يلتزم الطرف الثاني بغرامة قدرها ${money(k.penaltyPerDay)} ${cur} تخصم من مستحقاته، بحد أقصى ${k.penaltyCap}% من قيمة العقد.`,
    },
    art("الأعمال الإضافية والتعديلات"),
    { t: "p", text: "لا يجوز إجراء أي تعديل أو إضافة أو إلغاء إلا بأمر كتابي من الطرف الأول. وتحسب الأعمال الإضافية بأسعار العقد إن وجدت، وإلا بسعر يتفق عليه كتابياً قبل التنفيذ، وتخصم الأعمال الملغاة بأسعار العقد." },
    art("التزامات الطرف الثاني"),
    {
      t: "list",
      items: [
        "الالتزام بقوانين دولة الكويت ولوائح بلدية الكويت والجهات المختصة وقوانين العمل والإقامة لجميع عماله.",
        "اتخاذ جميع إجراءات السلامة في الموقع وتوفير معدات الوقاية لعماله، ويتحمل وحده المسؤولية عن أي إصابة لعماله أو للغير أو أي ضرر بالممتلكات ينتج عن أعماله.",
        "حماية أعمال البنود الأخرى والعقارات المجاورة والمرافق العامة، وإصلاح أي ضرر يتسبب فيه على نفقته.",
        "عدم التنازل عن الأعمال أو التعاقد عليها من الباطن كلياً أو جزئياً إلا بموافقة كتابية من الطرف الأول.",
        "المحافظة على نظافة الموقع وإزالة مخلفاته، ووجود مراقب كفء في الموقع خلال ساعات العمل.",
        "عدم إيقاف الأعمال أو إبطائها إلا وفق ما يسمح به البند التاسع.",
      ],
    },
    art("التزامات الطرف الأول"),
    {
      t: "list",
      items: [
        "تمكين الطرف الثاني من الموقع وتوفير الماء والكهرباء اللازمين للأعمال.",
        labour ? "توريد المواد الواردة في البند الرابع في الوقت المناسب." : "اعتماد العينات والمخططات التنفيذية خلال 7 أيام من تقديمها.",
        "سداد الدفعات في مواعيدها، وفي حال عدم سداد دفعة معتمدة بعد 14 يوماً من إخطار الطرف الثاني الكتابي يحق له إيقاف الأعمال حتى السداد، وتمدد مدة التنفيذ بقدر مدة الإيقاف.",
      ],
    },
    art("الاستلام وفترة الضمان"),
    {
      t: "p",
      text: `عند الانتهاء يعاين الطرفان الأعمال معاً وتسجل الملاحظات، ويلتزم الطرف الثاني بإصلاحها قبل توقيع محضر الاستلام. ويلتزم الطرف الثاني على نفقته بإصلاح أي عيب يظهر خلال ${k.defectsMonths} شهراً من الاستلام خلال 7 أيام من إخطاره كتابياً، وإلا جاز للطرف الأول إصلاحه بواسطة الغير وخصم التكلفة من المحجوز أو من أي مستحقات للطرف الثاني.${p.structural ? " ويظل الطرف الثاني فضلاً عن ذلك مسؤولاً وفقاً للقانون المدني الكويتي لمدة عشر سنوات من التسليم عما يحدث من تهدم كلي أو جزئي في المبنى، وعن العيوب التي يترتب عليها تهديد متانته وسلامته." : ""}`,
    },
    art("فسخ العقد"),
    {
      t: "p",
      text: "يحق للطرف الأول فسخ العقد بإخطار كتابي إذا ترك الطرف الثاني العمل 7 أيام متتالية، أو قصر في سير الأعمال، أو تكرر منه تنفيذ أعمال مخالفة، أو تعاقد من الباطن دون موافقة، ولم يصحح المخالفة خلال 7 أيام من إخطاره كتابياً. وللطرف الأول عندئذ استكمال الأعمال بواسطة الغير على حساب الطرف الثاني، ولا يستحق الطرف الثاني إلا قيمة الأعمال المنفذة بشكل سليم مخصوماً منها تلك التكاليف وأي غرامات. ويحق للطرف الثاني الفسخ إذا لم يسدد الطرف الأول دفعة معتمدة خلال 30 يوماً من إخطاره كتابياً.",
    },
    art("القانون الواجب التطبيق وتسوية النزاعات"),
    { t: "p", text: "يخضع هذا العقد لقوانين دولة الكويت، ويسعى الطرفان لتسوية أي نزاع ودياً خلال 15 يوماً، وإلا تختص محاكم دولة الكويت بنظره." },
  ];
  if (k.extraTerms.length) b.push(art("شروط خاصة"), { t: "list", items: k.extraTerms.map((x) => x.ar) });
  b.push(
    art("اللغة ونسخ العقد"),
    { t: "p", text: "حرر هذا العقد باللغتين العربية والإنجليزية، وفي حال الاختلاف بين النصين يعتمد النص العربي. وحرر من نسختين أصليتين بيد كل طرف نسخة للعمل بموجبها." },
    {
      t: "sign",
      parties: [
        { title: "الطرف الأول (المالك)", lines: ["الاسم: " + (k.owner.nameAr || k.owner.name || BLANK), "التوقيع: ...............................", "التاريخ: ......../......../........"] },
        { title: "الطرف الثاني (المقاول)", lines: [`الاسم: ${contractor}`, "التوقيع والختم: ...............................", "التاريخ: ......../......../........"] },
      ],
    },
    { t: "sign", parties: [{ title: "الشاهد الأول", lines: ["الاسم: " + BLANK, "التوقيع: ..............................."] }, { title: "الشاهد الثاني", lines: ["الاسم: " + BLANK, "التوقيع: ..............................."] }] },
    { t: "break" },
    { t: "h", text: "الملحق رقم (1): جدول الكميات والأسعار" },
    { t: "p", text: `الكميات محسوبة من نموذج المشروع، ${labour ? "والأسعار مصنعية فقط" : "والأسعار توريد وتركيب"}.${k.items.some((i) => i.basis === "labour-estimated") ? " الأسعار المعلمة بـ (*) تقديرية ويتم تأكيدها مع المقاول." : ""}` },
    scheduleTable(k, "ar"),
    { t: "h", text: "الملحق رقم (2): جدول الدفعات" },
    paymentTable(k, "ar"),
  );
  return b;
}
