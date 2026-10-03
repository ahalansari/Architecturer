import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startRemoteServer, type RemoteServer } from "../src/mcp/http.js";
import { loadConfig } from "../src/mcp/remote/config.js";

type R = { content: { type: string; text?: string; data?: string }[]; isError?: boolean };

const freePort = () =>
  new Promise<number>((ok) => {
    const s = createServer().listen(0, () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => ok(p));
    });
  });

let srv: RemoteServer;
let base: string;
let work: string;

before(async () => {
  const root = mkdtempSync(join(tmpdir(), "arch-http-"));
  work = join(root, "plans");
  const port = await freePort();
  const cfg = loadConfig(
    { ARCHITECTURER_STATE: join(root, "state"), ARCHITECTURER_WORKERS: "1" },
    { port, workdir: work, publicUrl: `http://localhost:${port}` },
  );
  cfg.host = "127.0.0.1";
  cfg.loginAttempts = 1000;
  srv = await startRemoteServer(cfg);
  base = `http://localhost:${port}`;
});

after(async () => {
  await srv?.close();
});

const b64url = (b: Buffer) => b.toString("base64url");
const USER = "ahmad";
const PASSWORD = "correct horse battery staple";
const cookieOf = (r: Response) => r.headers.get("set-cookie")!.split(";")[0];
const post = (path: string, body: Record<string, string>, cookie?: string) =>
  fetch(`${base}${path}`, { method: "POST", redirect: "manual", headers: cookie ? { cookie } : {}, body: new URLSearchParams(body) });
async function logIn(next = "/admin"): Promise<string> {
  const r = await post("/login", { username: USER, password: PASSWORD, next });
  assert.equal(r.status, 303);
  return cookieOf(r);
}
const csrfOf = async (cookie: string) => /name="csrf" value="([^"]+)"/.exec(await (await fetch(`${base}/admin`, { headers: { cookie } })).text())![1];

test("first account: setup needs the code from the log", async () => {
  let r = await fetch(`${base}/admin`, { redirect: "manual" });
  assert.equal(r.headers.get("location"), "/setup");
  const code = srv.setupCode()!;
  assert.match(code, /^[0-9A-F]{6}-[0-9A-F]{6}$/);
  r = await post("/setup", { code: "000000-000000", username: USER, password: PASSWORD, confirm: PASSWORD });
  assert.equal(r.status, 403);
  r = await post("/setup", { code, username: USER, password: "short", confirm: "short" });
  assert.equal(r.status, 400);
  r = await post("/setup", { code: code.toLowerCase(), username: USER, password: PASSWORD, confirm: PASSWORD });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), "/admin");
  r = await fetch(`${base}/admin`, { headers: { cookie: cookieOf(r) } });
  assert.match(await r.text(), /Logged in as ahmad/);
  // setup is closed once an account exists
  assert.equal(srv.setupCode(), undefined);
  r = await post("/setup", { code, username: "intruder", password: PASSWORD, confirm: PASSWORD });
  assert.equal(r.headers.get("location"), "/login");
  assert.equal(srv.store.users().length, 1);
});

/** Register, log in, approve and exchange the code, like Claude / ChatGPT do. */
async function oauthLogin(): Promise<{ access: string; refresh: string; clientId: string }> {
  const redirect = "http://127.0.0.1:33389/mcp-oauth-callback";
  let r = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirect], token_endpoint_auth_method: "none", client_name: "Test client", grant_types: ["authorization_code", "refresh_token"] }),
  });
  assert.equal(r.status, 201);
  const client = (await r.json()) as { client_id: string };

  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const q = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state: "xyz", scope: "plans" });

  r = await fetch(`${base}/authorize?${q}`, { redirect: "manual" });
  assert.equal(r.status, 302);
  assert.match(r.headers.get("location")!, /^\/login\?next=/);

  r = await post("/login", { username: USER, password: "wrong password!", next: "/admin" });
  assert.equal(r.status, 401);
  const cookie = await logIn(`/authorize?${q}`);

  r = await fetch(`${base}/authorize?${q}`, { headers: { cookie } });
  const html = await r.text();
  assert.match(html, /Allow Test client\?/);
  const id = /name="id" value="([^"]+)"/.exec(html)![1];
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1];

  // a forged form (no csrf) is refused
  r = await fetch(`${base}/authorize/decision`, { method: "POST", redirect: "manual", headers: { cookie }, body: new URLSearchParams({ id, decision: "allow" }) });
  assert.equal(r.status, 403);

  r = await fetch(`${base}/authorize/decision`, { method: "POST", redirect: "manual", headers: { cookie }, body: new URLSearchParams({ id, csrf, decision: "allow" }) });
  assert.equal(r.status, 302);
  const back = new URL(r.headers.get("location")!);
  assert.equal(back.searchParams.get("state"), "xyz");
  const code = back.searchParams.get("code")!;

  r = await fetch(`${base}/token`, {
    method: "POST",
    body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirect, client_id: client.client_id }),
  });
  assert.equal(r.status, 200, await r.clone().text());
  const tok = (await r.json()) as { access_token: string; refresh_token: string };
  // codes are single use
  r = await fetch(`${base}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id }) });
  assert.equal(r.status, 400);
  return { access: tok.access_token, refresh: tok.refresh_token, clientId: client.client_id };
}

async function connect(token: string, path = "/mcp") {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(path, base), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as R;
  return { client, call };
}

test("unauthenticated MCP requests point to the OAuth metadata", async () => {
  const r = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(r.status, 401);
  assert.match(r.headers.get("www-authenticate")!, /resource_metadata="http:\/\/localhost:\d+\/\.well-known\/oauth-protected-resource"/);
  const prm = (await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json()) as { authorization_servers: string[] };
  const as = (await (await fetch(new URL(".well-known/oauth-authorization-server", prm.authorization_servers[0]))).json()) as Record<string, unknown>;
  assert.ok(as.registration_endpoint);
  assert.equal(as.client_id_metadata_document_supported, true);
  // DNS rebinding: a page on another host name that resolves here (fetch can't set Host, so use http)
  const status = await new Promise<number>((ok, fail) =>
    request(`${base}/healthz`, { headers: { host: "attacker.example" } }, (res) => ok(res.statusCode!)).on("error", fail).end(),
  );
  assert.equal(status, 403);
});

test("registration refuses non-loopback http redirects", async () => {
  const r = await fetch(`${base}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"], token_endpoint_auth_method: "none" }) });
  assert.equal(r.status, 400);
});

test("OAuth flow, tools over HTTP, sandbox, links, refresh and revoke", async () => {
  const { access, refresh, clientId } = await oauthLogin();
  const { client, call } = await connect(access);
  try {
    const tools = (await client.listTools()).tools;
    const names = tools.map((t) => t.name);
    for (const t of ["list_projects", "create_project", "export_model", "export_status"]) assert.ok(names.includes(t), t);
    assert.equal(tools.find((t) => t.name === "read_project")!.annotations?.readOnlyHint, true);
    assert.equal(tools.find((t) => t.name === "remove_elements")!.annotations?.destructiveHint, true);

    let r = await call("create_project", { path: "cabin" });
    assert.match(r.content[0].text!, /Created cabin\.json/);
    assert.match(r.content[0].text!, /Live 3D view: http:\/\/localhost:\d+\/view\/cabin\//);
    assert.ok(!r.content[0].text!.includes(work), "no server paths in replies");

    // two edits at once must both land
    const [a, b] = await Promise.all([
      call("add_elements", { path: "cabin", level: "ground", elements: { furniture: [{ type: "sofa", position: [3, 1], facing: "north" }] } }),
      call("add_elements", { path: "cabin", level: "ground", elements: { furniture: [{ type: "armchair", position: [1.5, 1.5], facing: "east" }] } }),
    ]);
    assert.ok(!a.isError && !b.isError);
    const saved = JSON.parse(readFileSync(join(work, "cabin.json"), "utf8"));
    const types = saved.levels[0].furniture.map((f: { type: string }) => f.type);
    assert.ok(types.includes("sofa") && types.includes("armchair"), types.join(","));

    r = await call("list_projects");
    assert.match(r.content[0].text!, /^cabin/m);

    // nothing outside the project folder
    for (const p of ["../outside", "~/.ssh/config", "/etc/passwd"]) {
      r = await call("read_project", { path: p });
      assert.ok(r.isError, p);
    }
    r = await call("export_model", { path: "cabin", output: "../../escape.glb" });
    assert.ok(r.isError);

    // the server doesn't fetch private addresses for a plan
    r = await call("import_product", { path: "cabin", url: `${base}/healthz`, name: "Lamp", type: "floor_lamp" });
    assert.match(r.content[0].text!, /private network address/);

    // renders: inline image plus a link that works without the bearer token
    r = await call("render_plan", { path: "cabin" });
    assert.equal(r.content[0].type, "image");
    const link = /Image link: (\S+)/.exec(r.content[1].text!)![1];
    let res = await fetch(link);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    res = await fetch(link.replace(/s=[^&]+/, "s=forged"));
    assert.equal(res.status, 403);

    r = await call("export_model", { path: "cabin", textureSize: 64 });
    assert.ok(!r.isError, r.content[0].text);
    const dl = /(?:Download|link will be): (\S+)/.exec(r.content[0].text!)![1];
    for (let i = 0; i < 60 && (res = await fetch(dl)).status === 202; i++) await new Promise((ok) => setTimeout(ok, 1000));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "model/gltf-binary");
    assert.ok((await res.arrayBuffer()).byteLength > 20_000);
    assert.match((await call("export_status")).content[0].text!, /cabin → exports\/cabin\.glb — done/);

    r = await call("generate_contract", { path: "cabin", package: "main", formats: ["docx"] });
    assert.ok(!r.isError, r.content[0].text);
    const docxLink = /DOCX: (\S+)/.exec(r.content[0].text!)![1];
    assert.match(docxLink, /\/files\/w\/exports\/contracts\/cabin-main-supply\.docx\?/);
    res = await fetch(docxLink);
    assert.equal(res.status, 200);
    assert.equal((await res.arrayBuffer()).byteLength > 5000, true);
  } finally {
    await client.close();
  }

  // refresh rotates; the old refresh token stops working
  let r = await fetch(`${base}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: clientId }) });
  assert.equal(r.status, 200);
  const next = (await r.json()) as { access_token: string; refresh_token: string };
  r = await fetch(`${base}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: clientId }) });
  assert.equal(r.status, 400);
  // the replaced access token is gone, the new one works
  r = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${access}`, "content-type": "application/json" }, body: "{}" });
  assert.equal(r.status, 401);

  // revoking ends the grant
  r = await fetch(`${base}/revoke`, { method: "POST", body: new URLSearchParams({ token: next.refresh_token, client_id: clientId }) });
  assert.equal(r.status, 200);
  r = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${next.access_token}`, "content-type": "application/json" }, body: "{}" });
  assert.equal(r.status, 401);
});

test("personal token on the core tool set; viewer needs a login", async () => {
  copyFileSync(join(import.meta.dirname, "../examples/house.json"), join(work, "house.json"));
  const { token } = srv.store.createPat("lmstudio");
  const { client, call } = await connect(token, "/mcp/core");
  try {
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(names.length <= 10 && names.includes("render_view") && !names.includes("export_model"), names.join(","));
    const r = await call("get_guide", { section: "stairs" });
    assert.match(r.content[0].text!, /^## Stairs/);
  } finally {
    await client.close();
  }
  let r = await fetch(`${base}/view/house/info`, { redirect: "manual" });
  assert.equal(r.status, 302);
  const cookie = await logIn("/view/house/");
  r = await fetch(`${base}/view/house/info`, { headers: { cookie } });
  assert.equal(r.status, 200);
  const info = (await r.json()) as { file: string; levels: unknown[] };
  assert.equal(info.file, "house");
  assert.ok(info.levels.length > 0);
  r = await fetch(`${base}/view/house/`, { headers: { cookie } });
  assert.match(await r.text(), /src="viewer\/viewer\.js"/);

  // contracts from the viewer panel: list, generate (JSON, same site only), download
  r = await fetch(`${base}/view/house/contracts`, { headers: { cookie } });
  const listing = (await r.json()) as { packages: { id: string }[]; files: unknown[] };
  assert.ok(listing.packages.some((p) => p.id === "plaster") && listing.files.length === 0);
  r = await fetch(`${base}/view/house/contracts`, { method: "POST", headers: { cookie, "content-type": "application/json", origin: "https://evil.example" }, body: JSON.stringify({ package: "plaster" }) });
  assert.equal(r.status, 403);
  r = await fetch(`${base}/view/house/contracts`, { method: "POST", headers: { cookie }, body: new URLSearchParams({ package: "plaster" }) });
  assert.equal(r.status, 415, "form posts are refused");
  r = await fetch(`${base}/view/house/contracts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ package: "plaster" }), redirect: "manual" });
  assert.equal(r.status, 302, "needs a login");
  r = await fetch(`${base}/view/house/contracts`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ package: "plaster", mode: "labour", contractor: "Panel Co" }) });
  const made = (await r.json()) as { ok: boolean; text: string; name: string };
  assert.ok(made.ok, made.text);
  assert.equal(made.name, "house-plaster-labour");
  assert.ok(existsSync(join(work, "exports", "contracts", "house-plaster-labour.docx")));
  r = await fetch(`${base}/view/house/contracts/house-plaster-labour.docx`, { headers: { cookie } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-disposition")!, /attachment/);
  r = await fetch(`${base}/view/house/contracts/..%2F..%2Fstate%2Fauth.json`, { headers: { cookie } });
  assert.equal(r.status, 404);
  r = await fetch(`${base}/admin`, { headers: { cookie } });
  assert.match(await r.text(), /lmstudio/);
});

test("password change logs out other sessions; lockout after failures", async () => {
  const a = await logIn();
  const b = await logIn();
  const csrf = await csrfOf(a);
  const next = "a different long passphrase";
  let r = await post("/admin/password", { csrf, current: "not it at all", password: next, confirm: next }, a);
  assert.equal(r.status, 400);
  r = await post("/admin/password", { csrf, current: PASSWORD, password: next, confirm: next }, a);
  assert.equal(r.status, 303);
  const a2 = cookieOf(r);
  assert.equal((await fetch(`${base}/admin`, { redirect: "manual", headers: { cookie: b } })).status, 302, "other session ended");
  assert.equal((await fetch(`${base}/admin`, { redirect: "manual", headers: { cookie: a } })).status, 302, "old cookie ended");
  assert.equal((await fetch(`${base}/admin`, { headers: { cookie: a2 } })).status, 200);
  // back to the shared test password
  r = await post("/admin/password", { csrf: await csrfOf(a2), current: next, password: PASSWORD, confirm: PASSWORD }, a2);
  assert.equal(r.status, 303);

  const { hashPassword } = await import("../src/mcp/remote/crypto.js");
  srv.store.putUser("guest", await hashPassword(PASSWORD));
  for (let i = 0; i < 5; i++) assert.equal((await post("/login", { username: "guest", password: `wrong ${i} attempt`, next: "/admin" })).status, 401);
  r = await post("/login", { username: "guest", password: PASSWORD, next: "/admin" });
  assert.equal(r.status, 401);
  assert.match(await r.text(), /Too many failed attempts/);
  srv.store.deleteUser("guest");
});

test("two-factor login", async () => {
  const { totpCode } = await import("../src/mcp/remote/crypto.js");
  const cookie = await logIn();
  const csrf = await csrfOf(cookie);
  let r = await post("/admin/2fa/start", { csrf }, cookie);
  assert.equal(r.headers.get("location"), "/admin");
  const html = await (await fetch(`${base}/admin`, { headers: { cookie } })).text();
  assert.match(html, /<svg/);
  const secret = /enter the key by hand: <code>([A-Z2-7 ]+)<\/code>/.exec(html)![1].replace(/ /g, "");
  r = await post("/admin/2fa/confirm", { csrf, code: "000000" }, cookie);
  assert.equal(r.status, 400);
  const step = Math.floor(Date.now() / 30_000);
  r = await post("/admin/2fa/confirm", { csrf, code: totpCode(secret, step) }, cookie);
  assert.match(await r.text(), /Two-factor login is on/);

  // password alone no longer logs in: a second step asks for the code
  r = await post("/login", { username: USER, password: PASSWORD, next: "/admin" });
  assert.equal(r.status, 200);
  const page = await r.text();
  assert.match(page, /6-digit code/);
  assert.equal(r.headers.get("set-cookie"), null);
  const token = /name="token" value="([^"]+)"/.exec(page)![1];
  r = await post("/login/code", { token, code: "000000", next: "/admin" });
  assert.equal(r.status, 401);
  // the code used to turn it on can't be replayed; the next one works
  r = await post("/login/code", { token, code: totpCode(secret, step), next: "/admin" });
  assert.equal(r.status, 401);
  r = await post("/login/code", { token, code: totpCode(secret, step + 1), next: "/admin" });
  assert.equal(r.status, 303);
  assert.equal((await fetch(`${base}/admin`, { headers: { cookie: cookieOf(r) } })).status, 200);
});
