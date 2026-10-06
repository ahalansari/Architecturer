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
code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--bg);border:1px solid var(--line);border-radius:5px;padding:2px 5px;overflow-wrap:anywhere}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:14px}.err{color:var(--danger)}
.scroll{overflow-x:auto}`;

export function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}</title><style>${CSS}</style></head><body><main>${body}</main></body></html>`;
}

export function loginPage(o: { next: string; error?: string; username?: string; secondStep?: string }): string {
  const hidden = `<input type="hidden" name="next" value="${esc(o.next)}">`;
  const body = o.secondStep
    ? `<p class="muted">Enter the 6-digit code from your authenticator app.</p>
<form method="post" action="/login/code">${hidden}<input type="hidden" name="token" value="${esc(o.secondStep)}">
<p><input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" placeholder="123456" autofocus required aria-label="Code"></p>
${o.error ? `<p class="err">${esc(o.error)}</p>` : ""}<div class="row"><button class="primary">Verify</button></div></form>`
    : `<p class="muted">Log in to continue.</p>
<form method="post" action="/login">${hidden}
<p><input name="username" placeholder="Username" autocomplete="username" value="${esc(o.username ?? "")}" ${o.username ? "" : "autofocus"} required aria-label="Username"></p>
<p><input type="password" name="password" placeholder="Password" autocomplete="current-password" ${o.username ? "autofocus" : ""} required aria-label="Password"></p>
${o.error ? `<p class="err">${esc(o.error)}</p>` : ""}<div class="row"><button class="primary">Log in</button></div></form>`;
  return page("Architecturer login", `<div class="card"><h1>Architecturer</h1>${body}</div>`);
}

export function setupPage(o: { error?: string; username?: string }): string {
  return page(
    "Set up Architecturer",
    `<div class="card"><h1>Set up Architecturer</h1>
<p>Create the account that logs in to this server. The setup code is in the server log (<code>docker logs architecturer</code>, or the container's log in Unraid).</p>
<form method="post" action="/setup">
<p><input name="code" placeholder="Setup code" autocomplete="off" required autofocus aria-label="Setup code"></p>
<p><input name="username" placeholder="Username" autocomplete="username" value="${esc(o.username ?? "")}" required maxlength="40" pattern="[A-Za-z0-9._-]+" aria-label="Username"></p>
<p><input type="password" name="password" placeholder="Password (12+ characters)" autocomplete="new-password" required minlength="12" aria-label="Password"></p>
<p><input type="password" name="confirm" placeholder="Repeat password" autocomplete="new-password" required minlength="12" aria-label="Repeat password"></p>
${o.error ? `<p class="err">${esc(o.error)}</p>` : ""}<div class="row"><button class="primary">Create account</button></div></form></div>`,
  );
}

export function consentPage(o: { request: string; clientName: string; redirectHost: string; username: string; csrf: string; note?: string }): string {
  return page(
    "Allow access?",
    `<div class="card"><h1>Allow ${esc(o.clientName)}?</h1>
<p><strong>${esc(o.clientName)}</strong> wants to use Architecturer as <strong>${esc(o.username)}</strong>: read, create and change your projects, render them and export models.</p>
<p class="muted">After you allow it, you'll be sent back to <code>${esc(o.redirectHost)}</code>. You can revoke access at any time on the <a href="/admin">admin page</a>.</p>
${o.note ? `<p><strong>${esc(o.note)}</strong></p>` : ""}<form method="post" action="/authorize/decision"><input type="hidden" name="request" value="${esc(o.request)}"><input type="hidden" name="csrf" value="${esc(o.csrf)}">
<div class="row"><button class="primary" name="decision" value="allow">Allow</button><button name="decision" value="deny">Deny</button></div></form></div>`,
  );
}

const ago = (t: Date, now: number) => {
  const s = Math.max(0, (now - t.getTime()) / 1000);
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  if (s < 45 * 86400) return `${Math.round(s / 86400)} days ago`;
  return t.toISOString().slice(0, 10);
};

export interface ProjectRow {
  name: string;
  /** Viewer link, relative to /view/. */
  href: string;
  title?: string;
  levels: number;
  modified: Date;
}

/**
 * The project browser (/view/): every plan in the workspace, newest first or by name, filtered by `q` on the
 * server (works without scripts) and live as you type (`nonce` lets the one inline script run under the CSP).
 */
export function projectsPage(o: { projects: ProjectRow[]; q: string; sort: "recent" | "name"; username: string; nonce: string; now?: number }): string {
  const now = o.now ?? Date.now();
  const words = o.q.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = (p: ProjectRow) => `${p.title ?? ""} ${p.name}`.toLowerCase();
  const match = (p: ProjectRow) => words.every((w) => hay(p).includes(w));
  const shown = o.projects.filter(match);
  const sorted = [...o.projects].sort((a, b) => (o.sort === "name" ? (a.title ?? a.name).localeCompare(b.title ?? b.name) : b.modified.getTime() - a.modified.getTime()));
  const sortLink = (s: "recent" | "name", label: string) =>
    s === o.sort ? `<strong>${label}</strong>` : `<a href="?${new URLSearchParams({ ...(o.q ? { q: o.q } : {}), sort: s })}">${label}</a>`;
  const rows = sorted
    .map((p) => {
      const folder = p.name.includes("/") ? p.name.slice(0, p.name.lastIndexOf("/") + 1) : "";
      return `<li data-k="${esc(hay(p))}"${match(p) ? "" : " hidden"}><a class="proj" href="${esc(p.href)}"><span class="t">${esc(p.title ?? p.name)}</span><span class="n"><span class="muted">${esc(folder)}</span>${esc(p.name.slice(folder.length))}</span><span class="m muted">${p.levels} level${p.levels === 1 ? "" : "s"} · <time datetime="${p.modified.toISOString()}" title="${esc(p.modified.toISOString().slice(0, 16).replace("T", " "))} UTC">${ago(p.modified, now)}</time></span></a></li>`;
    })
    .join("");
  const empty = !o.projects.length
    ? `<p class="muted">No projects yet. Create one from your AI client with <code>create_project</code>; it shows up here.</p>`
    : `<p class="muted" id="none"${shown.length ? " hidden" : ""}>No project matches “<span id="nq">${esc(o.q)}</span>”.</p>`;
  return page(
    "Projects · Architecturer",
    `<style>
main{max-width:860px}a{color:var(--accent)}.top{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:16px}
.bar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:12px}.bar input{max-width:none;flex:1 1 240px}
ul.projects{list-style:none;margin:0;padding:0}ul.projects li{border-bottom:1px solid var(--line)}ul.projects li:last-child{border-bottom:0}
a.proj{display:grid;grid-template-columns:1fr auto;gap:2px 16px;padding:12px 4px;color:inherit;text-decoration:none;border-radius:6px}
a.proj:hover,a.proj:focus-visible{background:var(--bg)}a.proj .t{font-weight:600;color:var(--accent)}a.proj .n{grid-column:1;font:13px ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
a.proj .m{grid-column:2;grid-row:1/3;align-self:center;font-size:13px;text-align:right;white-space:nowrap}
@media (max-width:520px){a.proj{grid-template-columns:1fr}a.proj .m{grid-column:1;grid-row:auto;text-align:left}}
.card.list{padding:6px 14px}
</style>
<div class="top"><h1>Projects</h1><p class="muted">${esc(o.username)} · <a href="/admin">Admin</a></p></div>
<form class="bar" method="get" action="/view/" role="search"><input type="search" name="q" id="q" value="${esc(o.q)}" placeholder="Search ${o.projects.length} project${o.projects.length === 1 ? "" : "s"}…" aria-label="Search projects" autocomplete="off"><input type="hidden" name="sort" value="${o.sort}"><span class="muted">Sort: ${sortLink("recent", "Recent")} · ${sortLink("name", "Name")}</span></form>
<div class="card list">${rows ? `<ul class="projects" id="list">${rows}</ul>` : ""}${empty}</div>
<script nonce="${esc(o.nonce)}">
const q = document.getElementById("q"), items = [...document.querySelectorAll("#list li")], none = document.getElementById("none");
q.addEventListener("input", () => {
  const w = q.value.toLowerCase().split(/\\s+/).filter(Boolean);
  let n = 0;
  for (const li of items) n += !(li.hidden = !w.every((x) => li.dataset.k.includes(x)));
  if (none) (none.hidden = n > 0), (document.getElementById("nq").textContent = q.value);
});
</script>`,
  );
}

export function messagePage(title: string, message: string): string {
  return page(title, `<div class="card"><h1>${esc(title)}</h1><p>${esc(message)}</p></div>`);
}

const when = (t?: number) => (t ? new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "never");

export interface SessionRow {
  key: string;
  createdAt: number;
  expiresAt: number;
  agent?: string;
  ip?: string;
  current: boolean;
}

export function adminPage(o: {
  username: string;
  grants: Grant[];
  sessions: SessionRow[];
  csrf: string;
  publicUrl: string;
  twoFactor: boolean;
  /** Two-factor enrolment in progress: QR code (SVG markup) and the secret for manual entry. */
  enrol?: { qr: string; secret: string };
  newToken?: { name: string; token: string };
  notice?: string;
  error?: string;
  status: string;
}): string {
  const csrf = `<input type="hidden" name="csrf" value="${esc(o.csrf)}">`;
  const rows = o.grants
    .map(
      (g) => `<tr><td>${esc(g.name)}${g.redirectHost ? `<br><span class="muted">${esc(g.redirectHost)}</span>` : ""}</td><td>${g.clientId === "pat" ? "personal token" : "OAuth app"}</td>
<td>${when(g.createdAt)}</td><td>${when(g.lastUsed)}</td>
<td><form method="post" action="/admin/revoke">${csrf}<input type="hidden" name="grant" value="${esc(g.id)}"><button class="danger">Revoke</button></form></td></tr>`,
    )
    .join("");
  const sessions = o.sessions
    .map(
      (s) => `<tr><td>${esc(s.agent ?? "unknown browser")}${s.current ? ` <strong>(this one)</strong>` : ""}<br><span class="muted">${esc(s.ip ?? "")}</span></td><td>${when(s.createdAt)}</td><td>${when(s.expiresAt)}</td>
<td>${s.current ? "" : `<form method="post" action="/admin/session/revoke">${csrf}<input type="hidden" name="session" value="${esc(s.key)}"><button class="danger">Log out</button></form>`}</td></tr>`,
    )
    .join("");
  const created = o.newToken
    ? `<div class="card" style="margin-top:16px"><h2 style="margin-top:0">Token '${esc(o.newToken.name)}' created</h2><p>Copy it now; it is not shown again.</p><p><code>${esc(o.newToken.token)}</code></p>
<p class="muted">Use it as the header <code>Authorization: Bearer &lt;token&gt;</code> with <code>${esc(o.publicUrl)}/mcp</code> (or <code>/mcp/core</code> for small local models).</p></div>`
    : "";
  const twoFactor = o.enrol
    ? `<p>Scan this with an authenticator app (1Password, Google Authenticator, Aegis...), then enter the code it shows.</p>
<div style="max-width:220px;background:#fff;padding:8px;border-radius:8px">${o.enrol.qr}</div>
<p class="muted">Or enter the key by hand: <code>${esc(o.enrol.secret.replace(/(.{4})/g, "$1 ").trim())}</code></p>
<form method="post" action="/admin/2fa/confirm">${csrf}<div class="row"><input name="code" inputmode="numeric" autocomplete="one-time-code" placeholder="123456" required aria-label="Code"><button class="primary">Turn on</button></div></form>`
    : o.twoFactor
      ? `<p>Two-factor login is <strong>on</strong>.</p><form method="post" action="/admin/2fa/disable">${csrf}<div class="row"><input name="code" inputmode="numeric" autocomplete="one-time-code" placeholder="Current code" required aria-label="Current code"><button class="danger">Turn off</button></div></form>`
      : `<p>Two-factor login is <strong>off</strong>. Recommended: this server is on the internet.</p><form method="post" action="/admin/2fa/start">${csrf}<div class="row"><button class="primary">Set up</button></div></form>`;
  return page(
    "Architecturer admin",
    `<h1>Architecturer</h1><p class="muted">Logged in as ${esc(o.username)} · <a href="/view/">projects</a> · <form method="post" action="/logout" style="display:inline">${csrf}<button style="padding:0 6px;border:0;background:none;color:inherit;text-decoration:underline">log out</button></form> · ${esc(o.status)}</p>
${o.notice ? `<p><strong>${esc(o.notice)}</strong></p>` : ""}${o.error ? `<p class="err">${esc(o.error)}</p>` : ""}${created}
<h2>Connected apps and tokens</h2><div class="card scroll">${
      o.grants.length ? `<table><thead><tr><th>Name</th><th>Kind</th><th>Created</th><th>Last used</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : `<p class="muted">Nothing connected yet.</p>`
    }</div>
<h2>New personal token</h2><div class="card"><p class="muted">For clients configured with a header instead of OAuth (LM Studio, Claude Code, scripts).</p>
<form method="post" action="/admin/tokens">${csrf}<div class="row"><input name="name" placeholder="Name, e.g. lmstudio" required maxlength="60" aria-label="Token name"><button class="primary">Create</button></div></form></div>
<h2>Two-factor login</h2><div class="card">${twoFactor}</div>
<h2>Password</h2><div class="card"><form method="post" action="/admin/password">${csrf}
<p><input type="password" name="current" placeholder="Current password" autocomplete="current-password" required aria-label="Current password"></p>
<p><input type="password" name="password" placeholder="New password (12+ characters)" autocomplete="new-password" required minlength="12" aria-label="New password"></p>
<p><input type="password" name="confirm" placeholder="Repeat new password" autocomplete="new-password" required minlength="12" aria-label="Repeat new password"></p>
<p class="muted">Changing it logs out every other browser.</p><div class="row"><button class="primary">Change password</button></div></form></div>
<h2>Browser sessions</h2><div class="card scroll"><table><thead><tr><th>Browser</th><th>Logged in</th><th>Expires</th><th></th></tr></thead><tbody>${sessions}</tbody></table></div>
<h2>Connect a client</h2><div class="card"><p>MCP server URL: <code>${esc(o.publicUrl)}/mcp</code></p>
<p class="muted">Claude (web, desktop, mobile) and ChatGPT: add it as a custom connector; they log in through this server. Small local models: <code>${esc(o.publicUrl)}/mcp/core</code> has fewer tools.</p></div>`,
  );
}
