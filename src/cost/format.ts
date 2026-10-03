/** Bill output: Markdown (chat / docs), CSV (spreadsheets), HTML (printable bill of quantities). */
import type { Bill } from "./estimate.js";

const money = (n: number, cur: string) => `${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur}`;
const num = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });
/** Money columns: always two decimals. */
const amt = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function billMarkdown(b: Bill, opts: { lines?: boolean } = {}): string {
  const out: string[] = [`# Cost estimate — ${b.project}`, ``, `${b.date} · all amounts in ${b.currency}`, ``];
  out.push(`| Section | Amount |`, `|---|---:|`);
  for (const s of b.sections) out.push(`| ${s.code}. ${s.name} | ${money(s.subtotal, b.currency)} |`);
  for (const a of b.adjustments) out.push(`| ${a.label} (${a.percent}%) | ${money(a.amount, b.currency)} |`);
  out.push(`| **Total** | **${money(b.total, b.currency)}** |`, ``);
  if (opts.lines !== false)
    for (const s of b.sections) {
      out.push(`## ${s.code}. ${s.name}`, ``, `| Ref | Description | Qty | Unit | Rate | Amount |`, `|---|---|---:|---|---:|---:|`);
      for (const l of s.lines) out.push(`| ${l.code} | ${l.description}${l.basis === "allowance" ? " ⁽ᵃ⁾" : ""} | ${num(l.qty)} | ${l.unit} | ${amt(l.rate)} | ${amt(l.amount)} |`);
      out.push(`| | **Subtotal** | | | | **${amt(s.subtotal)}** |`, ``);
    }
  out.push(`⁽ᵃ⁾ allowance (no product chosen yet).`, ``, ...b.notes.map((n) => `- ${n}`));
  return out.join("\n");
}

export function billCsv(b: Bill): string {
  const q = (v: unknown) => (v === undefined ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const rows = [["section", "ref", "description", "qty", "unit", "rate", "amount", "basis", "rate_key", "url"].join(",")];
  for (const s of b.sections) for (const l of s.lines) rows.push([s.name, l.code, l.description, l.qty, l.unit, l.rate, l.amount, l.basis, l.key, l.url].map(q).join(","));
  for (const a of b.adjustments) rows.push(["adjustments", "", `${a.label} (${a.percent}%)`, "", "", "", a.amount, "percent", "", ""].map(q).join(","));
  rows.push(["total", "", "", "", "", "", b.total, "", "", ""].map(q).join(","));
  return rows.join("\n") + "\n";
}

export function billHtml(b: Bill): string {
  const sec = b.sections
    .map(
      (s) => `<section><h2><span>${s.code}</span>${esc(s.name)}</h2><table><thead><tr><th>Ref</th><th>Description</th><th class="r">Qty</th><th>Unit</th><th class="r">Rate</th><th class="r">Amount</th></tr></thead><tbody>${s.lines
        .map(
          (l) =>
            `<tr class="${l.basis}"><td class="ref">${l.code}</td><td>${l.url ? `<a href="${esc(l.url)}">${esc(l.description)}</a>` : esc(l.description)}${l.basis === "allowance" ? ' <span class="tag">allowance</span>' : l.basis === "vendor" ? ' <span class="tag v">vendor price</span>' : ""}</td><td class="r">${num(l.qty)}</td><td>${l.unit}</td><td class="r">${amt(l.rate)}</td><td class="r">${amt(l.amount)}</td></tr>`,
        )
        .join("")}</tbody><tfoot><tr><td></td><td>Subtotal ${s.code}</td><td></td><td></td><td></td><td class="r">${amt(s.subtotal)}</td></tr></tfoot></table></section>`,
    )
    .join("");
  const summary = [
    ...b.sections.map((s) => `<tr><td>${s.code}. ${esc(s.name)}</td><td class="r">${amt(s.subtotal)}</td></tr>`),
    `<tr class="sub"><td>Trades subtotal</td><td class="r">${amt(b.trades)}</td></tr>`,
    `<tr class="sub"><td>Furniture &amp; furnishings</td><td class="r">${amt(b.retail)}</td></tr>`,
    ...b.adjustments.map((a) => `<tr><td>${esc(a.label)} (${a.percent}%)</td><td class="r">${amt(a.amount)}</td></tr>`),
    `<tr class="total"><td>Total (${b.currency})</td><td class="r">${amt(b.total)}</td></tr>`,
  ].join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cost estimate — ${esc(b.project)}</title>
<style>
:root{--ink:#1f2328;--muted:#6b7280;--line:#e5e7eb;--accent:#2b4f80;--bg:#fff;--soft:#f7f7f5}
@media (prefers-color-scheme:dark){:root{--ink:#e8e8e8;--muted:#a0a4ab;--line:#3a3b3e;--accent:#8db4ea;--bg:#1b1c1e;--soft:#232427}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1000px;margin:0 auto;padding:32px 16px 64px}h1{font-size:24px;margin:0}h2{font-size:15px;margin:28px 0 8px;display:flex;gap:10px;align-items:center}
h2 span{background:var(--accent);color:var(--bg);border-radius:4px;padding:1px 7px;font-size:12px}.meta{color:var(--muted);margin:4px 0 20px}
table{width:100%;border-collapse:collapse}th,td{padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{text-align:left;font-size:12px;color:var(--muted);font-weight:600}
.r{text-align:right;white-space:nowrap}.ref{color:var(--muted);white-space:nowrap;font-size:12px}tfoot td{font-weight:600;border-bottom:2px solid var(--ink)}
.summary{background:var(--soft);border-radius:10px;padding:12px 16px;margin:8px 0 8px}.summary td{border-bottom:1px solid var(--line)}.summary .sub td{color:var(--muted)}
.summary .total td{font-size:18px;font-weight:700;border-bottom:none;padding-top:10px}.tag{font-size:11px;color:var(--muted);border:1px solid var(--line);border-radius:10px;padding:0 6px;white-space:nowrap}
.tag.v{color:var(--accent);border-color:var(--accent)}a{color:inherit;text-decoration-color:var(--line)}ul{color:var(--muted);padding-left:18px}
.wrap{overflow-x:auto}@media print{body{font-size:11px}main{padding:0}a{text-decoration:none}}
</style></head><body><main>
<h1>Cost estimate — ${esc(b.project)}</h1><div class="meta">Bill of quantities · ${b.date} · amounts in ${b.currency}</div>
<div class="summary"><table>${summary}</table></div>
<div class="wrap">${sec}</div>
<h2>Notes</h2><ul>${b.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>
</main></body></html>
`;
}
