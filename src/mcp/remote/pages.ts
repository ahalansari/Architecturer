/** The few HTML pages a human sees on the remote server: login, OAuth consent, admin. */
import type { Grant } from "./store.js";

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const CSS = `
:root{--bg:#f6f5f2;--card:#fff;--fg:#1d1d1b;--muted:#6b6a66;--line:#e2e0da;--accent:#2f6f5e;--accent-fg:#fff;--danger:#a33a2c}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--card:#1f1f1d;--fg:#ecebe7;--muted:#a3a29c;--line:#34332f;--accent:#5fb39b;--accent-fg:#0f1513;--danger:#e0806f}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:720px;margin:48px auto;padding:0 16px}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:20px}p{margin:8px 0}.muted{color:var(--muted)}
button,.button{font:inherit;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:7px;padding:8px 14px;cursor:pointer;text-decoration:none;display:inline-block}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}button.danger{color:var(--danger)}
input{font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--fg);width:100%;max-width:320px}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:500}
code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--bg);border:1px solid var(--line);border-radius:5px;padding:2px 5px;word-break:break-all}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:14px}.err{color:var(--danger)}
.scroll{overflow-x:auto}`;

export function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}</title><style>${CSS}</style></head><body><main>${body}</main></body></html>`;
}

export function loginPage(next: string, error?: string): string {
  return page(
    "Architecturer login",
    `<div class="card"><h1>Architecturer</h1><p class="muted">Log in to continue.</p>
<form method="post" action="/login"><input type="hidden" name="next" value="${esc(next)}">
<p><input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password" aria-label="Password"></p>
${error ? `<p class="err">${esc(error)}</p>` : ""}<div class="row"><button class="primary">Log in</button></div></form></div>`,
  );
}

export function consentPage(o: { id: string; clientName: string; redirectHost: string; email: string; csrf: string }): string {
  return page(
    "Allow access?",
    `<div class="card"><h1>Allow ${esc(o.clientName)}?</h1>
<p><strong>${esc(o.clientName)}</strong> wants to use Architecturer as <strong>${esc(o.email)}</strong>: read, create and change your projects, render them and export models.</p>
<p class="muted">After you allow it, you'll be sent back to <code>${esc(o.redirectHost)}</code>. You can revoke access at any time on the <a href="/admin">admin page</a>.</p>
<form method="post" action="/authorize/decision"><input type="hidden" name="id" value="${esc(o.id)}"><input type="hidden" name="csrf" value="${esc(o.csrf)}">
<div class="row"><button class="primary" name="decision" value="allow">Allow</button><button name="decision" value="deny">Deny</button></div></form></div>`,
  );
}

export function messagePage(title: string, message: string): string {
  return page(title, `<div class="card"><h1>${esc(title)}</h1><p>${esc(message)}</p></div>`);
}

const when = (t?: number) => (t ? new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "never");

export function adminPage(o: {
  email: string;
  grants: Grant[];
  csrf: string;
  publicUrl: string;
  newToken?: { name: string; token: string };
  status: string;
  canLogout: boolean;
}): string {
  const rows = o.grants
    .map(
      (g) => `<tr><td>${esc(g.name)}${g.redirectHost ? `<br><span class="muted">${esc(g.redirectHost)}</span>` : ""}</td><td>${g.clientId === "pat" ? "personal token" : "OAuth app"}</td>
<td>${when(g.createdAt)}</td><td>${when(g.lastUsed)}</td>
<td><form method="post" action="/admin/revoke"><input type="hidden" name="csrf" value="${esc(o.csrf)}"><input type="hidden" name="grant" value="${esc(g.id)}"><button class="danger">Revoke</button></form></td></tr>`,
    )
    .join("");
  const created = o.newToken
    ? `<div class="card" style="margin-top:16px"><h2 style="margin-top:0">Token '${esc(o.newToken.name)}' created</h2><p>Copy it now; it is not shown again.</p><p><code>${esc(o.newToken.token)}</code></p>
<p class="muted">Use it as the header <code>Authorization: Bearer &lt;token&gt;</code> with <code>${esc(o.publicUrl)}/mcp</code> (or <code>/mcp/core</code> for small local models).</p></div>`
    : "";
  return page(
    "Architecturer admin",
    `<h1>Architecturer</h1><p class="muted">Logged in as ${esc(o.email)}${o.canLogout ? ` · <a href="/logout">log out</a>` : ""} · ${esc(o.status)}</p>${created}
<h2>Connected apps and tokens</h2><div class="card scroll">${
      o.grants.length ? `<table><thead><tr><th>Name</th><th>Kind</th><th>Created</th><th>Last used</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : `<p class="muted">Nothing connected yet.</p>`
    }</div>
<h2>New personal token</h2><div class="card"><p class="muted">For clients configured with a header instead of OAuth (LM Studio, Claude Code, scripts).</p>
<form method="post" action="/admin/tokens"><input type="hidden" name="csrf" value="${esc(o.csrf)}"><div class="row"><input name="name" placeholder="Name, e.g. lmstudio" required maxlength="60" aria-label="Token name"><button class="primary">Create</button></div></form></div>
<h2>Connect a client</h2><div class="card"><p>MCP server URL: <code>${esc(o.publicUrl)}/mcp</code></p>
<p class="muted">Claude (web, desktop, mobile) and ChatGPT: add it as a custom connector; they log in through this server. Small local models: <code>${esc(o.publicUrl)}/mcp/core</code> has fewer tools.</p></div>`,
  );
}
