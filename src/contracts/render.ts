/** Contract documents as print-ready HTML (save as PDF from the browser) and Word (.docx): English, then Arabic. */
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Packer,
  PageNumber,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  ShadingType,
  TableLayoutType,
} from "docx";
import type { Block, ContractDoc } from "./contract.js";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// ---------------------------------------------------------------------------
// HTML

function htmlBlocks(blocks: Block[]): string {
  return blocks
    .map((b) => {
      switch (b.t) {
        case "title":
          return `<h1>${esc(b.text)}</h1>${b.sub ? `<div class="sub">${esc(b.sub)}</div>` : ""}`;
        case "meta":
          return `<div class="meta">${esc(b.text)}</div>`;
        case "h":
          return `<h2>${esc(b.text)}</h2>`;
        case "p":
          return `<p>${esc(b.text)}</p>`;
        case "list":
          return `<ol>${b.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ol>`;
        case "fields":
          return `<table class="fields"><caption>${esc(b.title)}</caption>${b.rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}</table>`;
        case "table": {
          const cell = (v: string, i: number, tag: string) => `<${tag}${b.numeric.includes(i) ? ' class="n"' : ""}>${esc(v)}</${tag}>`;
          return `<table class="grid"><thead><tr>${b.head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${b.rows
            .map((r) => `<tr>${r.map((v, i) => cell(v, i, "td")).join("")}</tr>`)
            .join("")}</tbody>${b.foot ? `<tfoot>${b.foot.map((r) => `<tr>${r.map((v, i) => cell(v, i, "td")).join("")}</tr>`).join("")}</tfoot>` : ""}</table>`;
        }
        case "sign":
          return `<div class="sign">${b.parties.map((p) => `<div><strong>${esc(p.title)}</strong>${p.lines.map((l) => `<div>${esc(l)}</div>`).join("")}</div>`).join("")}</div>`;
        case "break":
          return `<div class="break"></div>`;
      }
    })
    .join("\n");
}

export function contractHtml(doc: ContractDoc): string {
  const k = doc.contract;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(`${k.id} — ${k.pkg.title.en}`)}</title>
<style>
@page { size: A4; margin: 16mm 15mm 18mm; }
* { box-sizing: border-box; }
body { margin: 0; background: #ecebe7; color: #111; font: 10.5pt/1.55 "Segoe UI", Arial, Helvetica, sans-serif; }
.toolbar { position: sticky; top: 0; z-index: 1; display: flex; gap: 10px; justify-content: center; align-items: center; padding: 8px 12px; background: #1d1d1b; color: #eee; font-size: 13px; }
.toolbar button { font: inherit; padding: 6px 14px; border-radius: 6px; border: 0; background: #2f6f5e; color: #fff; cursor: pointer; }
.sheet { background: #fff; max-width: 210mm; margin: 16px auto; padding: 16mm 15mm; box-shadow: 0 1px 4px rgba(0,0,0,.15); }
.ar { direction: rtl; font-family: "Noto Naskh Arabic", "Traditional Arabic", "Simplified Arabic", "Geeza Pro", Tahoma, Arial, sans-serif; font-size: 11.5pt; }
h1 { text-align: center; font-size: 18pt; margin: 0; letter-spacing: .5px; }
.sub { text-align: center; font-weight: 600; font-size: 12pt; margin-top: 2px; }
.meta { text-align: center; color: #555; font-size: 9pt; margin: 4px 0 14px; }
h2 { font-size: 11.5pt; margin: 16px 0 6px; padding-bottom: 2px; border-bottom: 1px solid #999; break-after: avoid; }
p { margin: 6px 0; text-align: justify; }
ol { margin: 4px 0; padding-inline-start: 22px; } li { margin: 2px 0; }
table { width: 100%; border-collapse: collapse; margin: 8px 0; break-inside: auto; }
tr { break-inside: avoid; }
.fields caption { text-align: start; font-weight: 700; padding: 6px 0 3px; }
.fields th, .fields td { border: 1px solid #bbb; padding: 3px 7px; text-align: start; font-weight: normal; }
.fields th { width: 32%; background: #f6f5f2; }
.grid { font-size: 9pt; }
.grid th, .grid td { border: 1px solid #888; padding: 3px 5px; vertical-align: top; text-align: start; }
.grid thead th { background: #e9e8e3; }
.grid tfoot td { font-weight: 700; background: #f6f5f2; }
.grid .n { text-align: end; white-space: nowrap; font-variant-numeric: tabular-nums; }
.sign { display: grid; grid-template-columns: 1fr 1fr; gap: 28px; margin-top: 22px; break-inside: avoid; }
.sign div div { margin-top: 10px; }
.break { break-after: page; }
@media print {
  body { background: #fff; }
  .toolbar { display: none; }
  .sheet { box-shadow: none; margin: 0; padding: 0; max-width: none; }
  .sheet + .sheet { break-before: page; }
}
@media (max-width: 700px) { .sheet { padding: 16px; margin: 0; } .sign { grid-template-columns: 1fr; } .grid { font-size: 8pt; } }
</style></head>
<body>
<div class="toolbar"><span>${esc(k.id)}</span><button onclick="window.print()">Print / Save as PDF</button></div>
<section class="sheet" lang="en">${htmlBlocks(doc.en)}</section>
<section class="sheet ar" lang="ar" dir="rtl">${htmlBlocks(doc.ar)}</section>
</body></html>
`;
}

// ---------------------------------------------------------------------------
// Word

const FONT = { ascii: "Arial", hAnsi: "Arial", cs: "Arial", eastAsia: "Arial" };

function run(text: string, rtl: boolean, o: { bold?: boolean; size?: number; color?: string } = {}) {
  const size = o.size ?? (rtl ? 22 : 20);
  return new TextRun({ text, rightToLeft: rtl, font: FONT, size, sizeComplexScript: size + (rtl ? 0 : 2), bold: o.bold, boldComplexScript: o.bold, color: o.color });
}

function para(text: string, rtl: boolean, o: { bold?: boolean; size?: number; center?: boolean; after?: number; before?: number; color?: string; list?: number; keepNext?: boolean } = {}) {
  return new Paragraph({
    bidirectional: rtl,
    alignment: o.center ? AlignmentType.CENTER : AlignmentType.BOTH,
    spacing: { after: o.after ?? 100, before: o.before ?? 0, line: 276 },
    keepNext: o.keepNext,
    ...(o.list !== undefined ? { indent: { start: 400, hanging: 400 } } : {}),
    children: [run(text, rtl, o)],
  });
}

const thin = { style: BorderStyle.SINGLE, size: 4, color: "888888" };
const none = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };

function cell(text: string, rtl: boolean, o: { bold?: boolean; shade?: string; dxa?: number; borders?: boolean; numeric?: boolean } = {}) {
  const b = o.borders === false ? none : thin;
  return new TableCell({
    width: o.dxa ? { size: o.dxa, type: WidthType.DXA } : undefined,
    borders: { top: b, bottom: b, left: b, right: b },
    shading: o.shade ? { type: ShadingType.CLEAR, color: "auto", fill: o.shade } : undefined,
    margins: { top: 40, bottom: 40, left: 80, right: 80 },
    children: text.split("\n").map(
      (line) =>
        new Paragraph({
          bidirectional: rtl,
          alignment: o.numeric ? (rtl ? AlignmentType.LEFT : AlignmentType.RIGHT) : undefined,
          children: [run(line, rtl, { bold: o.bold, size: rtl ? 19 : 17 })],
        }),
    ),
  });
}

/** Usable page width in twips (A4, 1000-twip margins). */
const PAGE_W = 11906 - 2000;

/** Column widths (twips) for a table: the widest-text column gets the slack. */
function columnWidths(head: string[], rows: string[][], numeric: number[]): number[] {
  const weight = head.map((h, i) => (numeric.includes(i) ? 1.1 : i === 0 ? 0.45 : Math.max(1, ...rows.map((r) => (r[i] ?? "").length / 12), h.length / 12)));
  const desc = weight.indexOf(Math.max(...weight));
  weight[desc] = Math.max(weight[desc], 3.2);
  const total = weight.reduce((a, w) => a + w, 0);
  return weight.map((w) => Math.round((w / total) * PAGE_W));
}

function docxBlocks(blocks: Block[], rtl: boolean, first: boolean): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [];
  let pageBreak = !first;
  const push = (x: Paragraph | Table) => out.push(x);
  for (const b of blocks) {
    switch (b.t) {
      case "title":
        push(new Paragraph({ bidirectional: rtl, alignment: AlignmentType.CENTER, pageBreakBefore: pageBreak, spacing: { after: 40 }, children: [run(b.text, rtl, { bold: true, size: 34 })] }));
        pageBreak = false;
        if (b.sub) push(para(b.sub, rtl, { bold: true, center: true, size: rtl ? 26 : 24, after: 40 }));
        break;
      case "meta":
        push(para(b.text, rtl, { center: true, size: 17, color: "555555", after: 200 }));
        break;
      case "h":
        push(
          new Paragraph({
            bidirectional: rtl,
            alignment: AlignmentType.BOTH,
            keepNext: true,
            pageBreakBefore: pageBreak,
            spacing: { before: 220, after: 80 },
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "999999", space: 2 } },
            children: [run(b.text, rtl, { bold: true, size: rtl ? 24 : 22 })],
          }),
        );
        pageBreak = false;
        break;
      case "p":
        push(para(b.text, rtl));
        break;
      case "list":
        // numbers written into the text: list numbering restarts are rendered inconsistently across viewers
        b.items.forEach((item, i) => push(para(`${rtl ? `(${i + 1})` : `${i + 1}.`}\t${item}`, rtl, { list: i, after: 40 })));
        break;
      case "fields":
        push(para(b.title, rtl, { bold: true, before: 120, after: 40, keepNext: true }));
        push(
          new Table({
            width: { size: PAGE_W, type: WidthType.DXA },
            columnWidths: [Math.round(PAGE_W * 0.32), Math.round(PAGE_W * 0.68)],
            layout: TableLayoutType.FIXED,
            visuallyRightToLeft: rtl,
            rows: b.rows.map(([k, v]) => new TableRow({ children: [cell(k, rtl, { shade: "F6F5F2", dxa: Math.round(PAGE_W * 0.32) }), cell(v, rtl, { dxa: Math.round(PAGE_W * 0.68) })] })),
          }),
        );
        push(para("", rtl, { after: 60 }));
        break;
      case "table": {
        const w = columnWidths(b.head, b.rows, b.numeric);
        const head = new TableRow({ tableHeader: true, children: b.head.map((h, i) => cell(h, rtl, { bold: true, shade: "E9E8E3", dxa: w[i] })) });
        const body = b.rows.map((r) => new TableRow({ cantSplit: true, children: r.map((v, i) => cell(v, rtl, { numeric: b.numeric.includes(i), dxa: w[i] })) }));
        const foot = (b.foot ?? []).map((r) => new TableRow({ cantSplit: true, children: r.map((v, i) => cell(v, rtl, { bold: true, shade: "F6F5F2", numeric: b.numeric.includes(i), dxa: w[i] })) }));
        push(new Table({ width: { size: PAGE_W, type: WidthType.DXA }, columnWidths: w, layout: TableLayoutType.FIXED, visuallyRightToLeft: rtl, rows: [head, ...body, ...foot] }));
        push(para("", rtl, { after: 60 }));
        break;
      }
      case "sign":
        push(
          new Table({
            width: { size: PAGE_W, type: WidthType.DXA },
            columnWidths: [PAGE_W / 2, PAGE_W / 2],
            layout: TableLayoutType.FIXED,
            visuallyRightToLeft: rtl,
            rows: [new TableRow({ children: b.parties.map((p) => cell([p.title, ...p.lines.map((l) => `\n${l}`)].join("\n"), rtl, { borders: false, dxa: PAGE_W / 2, bold: false })) })],
          }),
        );
        push(para("", rtl, { after: 120 }));
        break;
      case "break":
        pageBreak = true;
        break;
    }
  }
  return out;
}

export async function contractDocx(doc: ContractDoc): Promise<Buffer> {
  const k = doc.contract;
  const d = new Document({
    creator: "Architecturer",
    title: `${k.id} — ${k.pkg.title.en}`,
    description: `${k.pkg.title.en} / ${k.pkg.title.ar}`,
    styles: { default: { document: { run: { font: FONT, size: 20 } } } },
    sections: [
      {
        properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1000, bottom: 1000, left: 1000, right: 1000 } } },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [run(`${k.id} · `, false, { size: 16, color: "777777" }), new TextRun({ children: [PageNumber.CURRENT, " / ", PageNumber.TOTAL_PAGES], size: 16, color: "777777", font: FONT })],
              }),
            ],
          }),
        },
        children: [...docxBlocks(doc.en, false, true), ...docxBlocks(doc.ar, true, doc.en.length === 0)],
      },
    ],
  });
  return Packer.toBuffer(d);
}
