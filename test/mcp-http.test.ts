import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
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
    { ARCHITECTURER_STATE: join(root, "state"), ARCHITECTURER_ADMIN_PASSWORD: "pw-for-tests", ARCHITECTURER_WORKERS: "1" },
    { port, workdir: work, publicUrl: `http://localhost:${port}` },
  );
  cfg.host = "127.0.0.1";
  srv = await startRemoteServer(cfg);
  base = `http://localhost:${port}`;
});

after(async () => {
  await srv?.close();
});

const b64url = (b: Buffer) => b.toString("base64url");

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

  r = await fetch(`${base}/login`, { method: "POST", redirect: "manual", body: new URLSearchParams({ password: "wrong", next: "/admin" }) });
  assert.equal(r.status, 401);
  r = await fetch(`${base}/login`, { method: "POST", redirect: "manual", body: new URLSearchParams({ password: "pw-for-tests", next: `/authorize?${q}` }) });
  assert.equal(r.status, 303);
  const cookie = r.headers.get("set-cookie")!.split(";")[0];

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
  r = await fetch(`${base}/login`, { method: "POST", redirect: "manual", body: new URLSearchParams({ password: "pw-for-tests", next: "/view/house/" }) });
  const cookie = r.headers.get("set-cookie")!.split(";")[0];
  r = await fetch(`${base}/view/house/info`, { headers: { cookie } });
  assert.equal(r.status, 200);
  const info = (await r.json()) as { file: string; levels: unknown[] };
  assert.equal(info.file, "house");
  assert.ok(info.levels.length > 0);
  r = await fetch(`${base}/view/house/`, { headers: { cookie } });
  assert.match(await r.text(), /src="viewer\/viewer\.js"/);
  r = await fetch(`${base}/admin`, { headers: { cookie } });
  assert.match(await r.text(), /lmstudio/);
});
