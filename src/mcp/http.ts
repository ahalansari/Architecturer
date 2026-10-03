#!/usr/bin/env node
/**
 * Remote MCP server over Streamable HTTP, for running Architecturer on a home server behind a tunnel and
 * using it from any MCP client: Claude (web, desktop, mobile) and ChatGPT through OAuth, LM Studio /
 * Claude Code / scripts with a personal token. Also serves the live 3D viewer for every project and
 * signed download links for exports and renders.
 *
 *   /mcp, /mcp/core          MCP endpoint (core = a small tool set for local models); bearer token
 *   /.well-known/*, /register, /token, /revoke     OAuth discovery and token endpoints
 *   /setup, /login, /authorize, /admin, /view/<project>/   human pages: built-in login (remote/login.ts)
 *   /files/...               signed links;  /healthz  health check
 */
import { mcpAuthRouter, createOAuthMetadata } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";
import QRCode from "qrcode";
import express, { type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { createReadStream, existsSync, statSync } from "node:fs";
import type { Server } from "node:http";
import { isIP } from "node:net";
import { basename, extname } from "node:path";
import { cacheRoot } from "../assets/cache.js";
import { setSandbox, confine } from "../sandbox.js";
import { createPlanViewer, type PlanViewer } from "../server/server.js";
import { WorkerPool } from "./engine.js";
import { createMcpServer, type RemoteHooks, type ToolContext, type ToolProfile } from "./tools.js";
import { KeyedLock, Workspace } from "./workspace.js";
import { loadConfig, type RemoteConfig } from "./remote/config.js";
import { Files } from "./remote/files.js";
import { Login, type Identity } from "./remote/login.js";
import { ArchOAuthProvider, SCOPES } from "./remote/oauth.js";
import { adminPage, esc, loginPage, messagePage, page, setupPage } from "./remote/pages.js";
import { hashPassword, newTotpSecret, otpauthUri, passwordProblem, totpMatch, verifyPassword } from "./remote/crypto.js";
import { AuthStore } from "./remote/store.js";

const CONTENT_TYPES: Record<string, string> = {
  ".glb": "model/gltf-binary",
  ".png": "image/png",
  ".html": "text/html; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json",
};

export interface RemoteServer {
  url: string;
  store: AuthStore;
  /** One-time code for /setup while no account exists. */
  setupCode(): string | undefined;
  close(): Promise<void>;
}

/** Project name ↔ the path segment of its viewer ('clients/villa' ↔ 'clients~villa'). */
const viewKey = (name: string) => name.split("/").map(encodeURIComponent).join("~");
const viewName = (key: string) => key.split("~").map(decodeURIComponent).join("/");

/** Only same-site relative paths after login (no open redirect to //evil.com). */
const safeNext = (n: unknown) => (typeof n === "string" && /^\/(?![/\\])/.test(n) ? n : "/admin");

export async function startRemoteServer(cfg: RemoteConfig): Promise<RemoteServer> {
  const sandbox = { roots: [cfg.workdir, cacheRoot()], publicNetworkOnly: !cfg.allowPrivateFetch };
  setSandbox(sandbox);
  const store = new AuthStore(cfg.stateDir);
  const ws = new Workspace(cfg.workdir, true);
  const pool = new WorkerPool(cfg.workers && cfg.workers > 0 ? cfg.workers : WorkerPool.defaultSize(), { sandbox });
  const files = new Files(ws, cfg.publicUrl, cfg.stateDir, () => store.secret);
  const login = new Login(store);
  const provider = new ArchOAuthProvider(store, login, (next) => `/login?next=${encodeURIComponent(next)}`);
  const at = (p: string) => new URL(p, cfg.publicUrl).href;

  const remote: RemoteHooks = {
    renderLink: (png) => files.renderLink(png),
    fileLink: files.fileLink,
    viewLink: (abs) => at(`/view/${viewKey(ws.nameOf(abs))}/`),
    startExport: (plan, out, run) => files.startExport(plan, out, run),
    exportJobs: files.exportJobs,
  };
  const ctx: ToolContext = { ws, engine: pool, lock: new KeyedLock(), remote };

  const app = express();
  app.disable("x-powered-by");
  // behind cloudflared / a reverse proxy on the Docker network: real client IPs for rate limits
  app.set("trust proxy", "loopback, linklocal, uniquelocal");
  // DNS-rebinding protection: known host names only. IP literals are fine (rebinding needs a domain name),
  // so the Unraid WebUI link (http://<server-ip>:5178) works on the LAN.
  const hostCheck = hostHeaderValidation(cfg.allowedHosts.map((h) => h.replace(/^\[|\]$/g, "")).flatMap((h) => [h, `[${h}]`]));
  app.use((req, res, next) => {
    let host = "";
    try {
      host = new URL(`http://${req.headers.host ?? ""}`).hostname.replace(/^\[|\]$/g, "");
    } catch {
      // invalid: hostCheck answers it
    }
    if (isIP(host)) return next();
    hostCheck(req, res, next);
  });
  app.use((_req, res, next) => {
    res.set("x-content-type-options", "nosniff");
    res.set("referrer-policy", "no-referrer");
    next();
  });

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, workers: pool.size, busy: pool.busy, queued: pool.pending });
  });

  // ---- human login ----

  const html = (res: Response, body: string, status = 200) =>
    void res
      .status(status)
      .set("cache-control", "no-store")
      .set("x-frame-options", "DENY")
      .set("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; frame-ancestors 'none'")
      .type("html")
      .send(body);
  /** The logged-in user, or a redirect to log in (or to set up the first account). */
  const human = async (req: Request, res: Response): Promise<Identity | undefined> => {
    const who = await login.identify(req);
    if (who) return who;
    res.redirect(302, store.hasUsers() ? `/login?next=${encodeURIComponent(req.originalUrl)}` : "/setup");
    return undefined;
  };
  const loginLimit = rateLimit({ windowMs: 15 * 60_000, limit: cfg.loginAttempts, standardHeaders: true, legacyHeaders: false });
  const form = express.urlencoded({ extended: false, limit: "16kb" });
  const field = (req: Request, k: string) => String((req.body as Record<string, unknown> | undefined)?.[k] ?? "");

  app.get("/setup", (_req, res) => {
    if (store.hasUsers()) return void res.redirect(302, "/login");
    html(res, setupPage({}));
  });
  app.post("/setup", loginLimit, form, async (req, res) => {
    if (store.hasUsers()) return void res.redirect(303, "/login");
    const username = field(req, "username").trim();
    const again = (error: string, status = 400) => html(res, setupPage({ error, username }), status);
    if (!login.checkSetupCode(field(req, "code"))) return again("Wrong setup code. It is in the server log.", 403);
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(username)) return again("Username: letters, digits, '.', '_' or '-'.");
    const password = field(req, "password");
    if (password !== field(req, "confirm")) return again("The passwords don't match.");
    const problem = passwordProblem(password, username);
    if (problem) return again(`Password: ${problem}.`);
    const user = store.putUser(username, await hashPassword(password));
    console.error(`architecturer: account '${username}' created; setup is closed`);
    res.set("set-cookie", login.startSession(user, req)).redirect(303, "/admin");
  });

  app.get("/login", (req, res) => {
    if (!store.hasUsers()) return void res.redirect(302, "/setup");
    html(res, loginPage({ next: safeNext(req.query.next) }));
  });
  app.post("/login", loginLimit, form, async (req, res) => {
    const next = safeNext(field(req, "next"));
    const username = field(req, "username");
    const r = await login.password(username, field(req, "password"));
    if (!r.ok) return html(res, loginPage({ next, username, error: r.error }), 401);
    if (r.user.totp) return html(res, loginPage({ next, secondStep: login.secondStepToken(r.user) }));
    res.set("set-cookie", login.startSession(r.user, req)).redirect(303, next);
  });
  app.post("/login/code", loginLimit, form, async (req, res) => {
    const next = safeNext(field(req, "next"));
    const token = field(req, "token");
    const r = await login.secondStep(token, field(req, "code"));
    if (!r.ok) return html(res, /expired/.test(r.error) ? loginPage({ next, error: r.error }) : loginPage({ next, secondStep: token, error: r.error }), 401);
    res.set("set-cookie", login.startSession(r.user, req)).redirect(303, next);
  });
  app.post("/logout", form, async (req, res) => {
    const who = await login.identify(req);
    if (who && login.checkCsrf(who, "admin", field(req, "csrf"))) res.set("set-cookie", login.endSession(who));
    html(res, messagePage("Logged out", "You are logged out."));
  });

  // ---- OAuth ----

  const prm = (resource: string) => ({
    resource: at(resource),
    authorization_servers: [cfg.publicUrl.href],
    scopes_supported: SCOPES,
    bearer_methods_supported: ["header"],
    resource_name: "Architecturer",
  });
  // some clients look for the resource metadata at the root, some at the endpoint's path
  for (const [path, resource] of [["/.well-known/oauth-protected-resource", "/mcp"], ["/.well-known/oauth-protected-resource/mcp/core", "/mcp/core"]])
    app.get(path, cors(), (_req, res) => void res.json(prm(resource)));
  {
    const meta = { ...createOAuthMetadata({ provider, issuerUrl: cfg.publicUrl, scopesSupported: SCOPES }), client_id_metadata_document_supported: true };
    app.get("/.well-known/oauth-authorization-server", cors(), (_req, res) => void res.json(meta));
    app.post("/authorize/decision", loginLimit, form, (req, res, next) => void provider.decide(req, res).catch(next));
    app.use(mcpAuthRouter({ provider, issuerUrl: cfg.publicUrl, scopesSupported: SCOPES, resourceServerUrl: new URL("/mcp", cfg.publicUrl), resourceName: "Architecturer" }));
  }

  // ---- MCP ----

  const mcpCors = cors({
    origin: "*",
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["authorization", "content-type", "accept", "mcp-protocol-version", "mcp-session-id", "last-event-id"],
    exposedHeaders: ["mcp-session-id", "mcp-protocol-version", "www-authenticate"],
    maxAge: 86400,
  });
  const mcp = (profile: ToolProfile) => {
    const path = profile === "core" ? "/mcp/core" : "/mcp";
    const bearer = requireBearerAuth({ verifier: provider, resourceMetadataUrl: at(`/.well-known/oauth-protected-resource${profile === "core" ? "/mcp/core" : ""}`) });
    app.options(path, mcpCors);
    app.post(path, mcpCors, bearer, express.json({ limit: "25mb" }), async (req, res) => {
      // stateless: a fresh server + transport per request (no sessions to lose on restart)
      const server = createMcpServer(ctx, profile);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (e) {
        console.error(`architecturer: MCP request failed: ${(e as Error).message}`);
        if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    });
    // no sessions, so no server-initiated stream and nothing to delete
    app.get(path, mcpCors, bearer, (_req, res) => void res.status(405).set("allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }));
    app.delete(path, mcpCors, bearer, (_req, res) => void res.status(405).set("allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }));
  };
  mcp("core");
  mcp("full");

  // ---- signed downloads ----

  app.get("/files/:kind/*rel", (req, res) => {
    const kind = req.params.kind;
    const rel = ([] as string[]).concat((req.params as Record<string, string | string[]>).rel).join("/");
    if (kind !== "w" && kind !== "r") return void res.status(404).send("not found");
    const ok = files.check(kind, rel, req.query.e, req.query.s);
    if (ok !== "ok") return void res.status(ok === "expired" ? 410 : 403).type("html").send(messagePage(ok === "expired" ? "Link expired" : "Invalid link", ok === "expired" ? "Ask for the file again to get a fresh link." : "This link is not valid."));
    let abs: string;
    try {
      abs = kind === "r" ? confine(files.renders, rel) : confine(cfg.workdir, rel);
    } catch {
      return void res.status(403).send("forbidden");
    }
    if (kind === "w") {
      const job = files.exporting(abs);
      if (job)
        return void res
          .status(202)
          .set("retry-after", "10")
          .type("html")
          .send(page("Still exporting", `<div class="card"><h1>Still exporting</h1><p>${esc(basename(abs))} has been building for ${Math.round((Date.now() - job.started.getTime()) / 1000)} s. This page reloads every 10 s.</p></div><script>setTimeout(()=>location.reload(),10000)</script>`).replace("<head>", '<head><meta http-equiv="refresh" content="10">'));
    }
    if (!existsSync(abs) || !statSync(abs).isFile()) return void res.status(404).type("html").send(messagePage("Not found", "The file no longer exists."));
    const ext = extname(abs).toLowerCase();
    res.set("content-type", CONTENT_TYPES[ext] ?? "application/octet-stream");
    res.set("cache-control", "private, max-age=300");
    // generated files are downloads (an HTML bill rendered on this origin could run scripts); renders show inline
    res.set("content-disposition", `${kind === "r" ? "inline" : "attachment"}; filename="${basename(abs).replace(/["\\]/g, "_")}"`);
    res.set("content-security-policy", "sandbox");
    createReadStream(abs).pipe(res);
  });

  // ---- live viewer ----

  const viewers = new Map<string, { viewer: PlanViewer; used: number }>();
  setInterval(() => {
    for (const [k, v] of viewers)
      if (!v.viewer.clients && Date.now() - v.used > 10 * 60_000) {
        v.viewer.close();
        viewers.delete(k);
      }
  }, 60_000).unref();

  app.get("/view", (_req, res) => void res.redirect(301, "/view/"));
  app.get("/view/", async (req, res) => {
    if (!(await human(req, res))) return;
    const list = await ws.list();
    res.type("html").send(
      page(
        "Architecturer projects",
        `<h1>Projects</h1><div class="card">${list.length ? `<table><tbody>${list.map((p) => `<tr><td><a href="/view/${esc(viewKey(p.name))}/">${esc(p.name)}</a></td><td>${esc(p.title ?? "")}</td><td class="muted">${p.modified.toISOString().slice(0, 16).replace("T", " ")}</td></tr>`).join("")}</tbody></table>` : `<p class="muted">No projects yet.</p>`}</div>`,
      ),
    );
  });
  app.get("/view/:key{/*rest}", async (req, res, next) => {
    const rest = ([] as string[]).concat((req.params as Record<string, string | string[] | undefined>).rest ?? []).join("/");
    // the page loads everything relative to /view/<key>/
    if (!rest && !req.path.endsWith("/")) return void res.redirect(301, `/view/${encodeURIComponent(req.params.key)}/`);
    if (!(await human(req, res))) return;
    let file: string;
    try {
      file = ws.plan(viewName(req.params.key));
    } catch {
      return void res.status(404).send("not found");
    }
    if (!existsSync(file)) return void res.status(404).type("html").send(messagePage("No such project", `There is no project '${viewName(req.params.key)}'.`));
    let v = viewers.get(file);
    if (!v) {
      if (viewers.size >= 20) {
        const idle = [...viewers].filter(([, x]) => !x.viewer.clients).sort((a, b) => a[1].used - b[1].used)[0];
        if (idle) {
          idle[1].viewer.close();
          viewers.delete(idle[0]);
        }
      }
      v = { viewer: createPlanViewer(file, { engine: pool, textureSize: cfg.textureSize, showPath: ws.nameOf(file) }), used: Date.now() };
      viewers.set(file, v);
    }
    v.used = Date.now();
    const query = new URL(req.originalUrl, "http://x").searchParams;
    v.viewer.handle(req, res, rest, query).catch(next);
  });

  // ---- admin ----

  const status = () => `${pool.size} render worker${pool.size === 1 ? "" : "s"}, ${pool.busy} busy, ${pool.pending} queued`;
  /** Two-factor enrolments in progress: session → secret (only saved once a code confirms it). */
  const enrolling = new Map<string, string>();
  const admin = async (who: Identity, res: Response, extra: Partial<Parameters<typeof adminPage>[0]> = {}) => {
    const user = store.getUser(who.username)!;
    const secret = enrolling.get(who.sessionKey);
    const enrol = secret ? { secret, qr: await QRCode.toString(otpauthUri(secret, user.username, `Architecturer (${cfg.publicUrl.host})`), { type: "svg", margin: 1 }) } : undefined;
    html(
      res,
      adminPage({
        username: user.username,
        grants: store.grants(),
        sessions: store.sessions(user.username).map(({ key, session }) => ({ key, ...session, current: key === who.sessionKey })),
        csrf: login.csrf(who, "admin"),
        publicUrl: cfg.publicUrl.origin,
        twoFactor: !!user.totp,
        enrol,
        status: status(),
        ...extra,
      }),
      extra.error ? 400 : 200,
    );
  };
  /** Logged in, and the form carries this session's token. */
  const adminPost = async (req: Request, res: Response): Promise<Identity | undefined> => {
    const who = await human(req, res);
    if (!who) return undefined;
    if (!login.checkCsrf(who, "admin", field(req, "csrf"))) return void res.status(403).send("bad form token; reload the page");
    return who;
  };
  app.get("/admin", async (req, res) => {
    const who = await human(req, res);
    if (who) await admin(who, res);
  });
  app.post("/admin/tokens", form, async (req, res) => {
    const who = await adminPost(req, res);
    if (!who) return;
    const name = field(req, "name").trim().slice(0, 60) || "token";
    await admin(who, res, { newToken: { name, token: store.createPat(name).token } });
  });
  app.post("/admin/revoke", form, async (req, res) => {
    if (!(await adminPost(req, res))) return;
    store.revokeGrant(field(req, "grant"));
    res.redirect(303, "/admin");
  });
  app.post("/admin/session/revoke", form, async (req, res) => {
    const who = await adminPost(req, res);
    if (!who) return;
    const key = field(req, "session");
    if (store.sessions(who.username).some((s) => s.key === key)) store.deleteSession(key);
    res.redirect(303, "/admin");
  });
  app.post("/admin/password", loginLimit, form, async (req, res) => {
    const who = await adminPost(req, res);
    if (!who) return;
    const user = store.getUser(who.username)!;
    if (!(await verifyPassword(field(req, "current"), user.password))) return admin(who, res, { error: "The current password is wrong." });
    const password = field(req, "password");
    if (password !== field(req, "confirm")) return admin(who, res, { error: "The new passwords don't match." });
    const problem = passwordProblem(password, user.username);
    if (problem) return admin(who, res, { error: `New password: ${problem}.` });
    // every existing session (this one too) ends; continue in a fresh one
    const fresh = store.putUser(user.username, await hashPassword(password), { keepTotp: true });
    store.deleteSession(who.sessionKey);
    res.set("set-cookie", login.startSession(fresh, req)).redirect(303, "/admin");
  });
  app.post("/admin/2fa/start", form, async (req, res) => {
    const who = await adminPost(req, res);
    if (!who) return;
    enrolling.set(who.sessionKey, newTotpSecret());
    res.redirect(303, "/admin");
  });
  app.post("/admin/2fa/confirm", loginLimit, form, async (req, res) => {
    const who = await adminPost(req, res);
    if (!who) return;
    const secret = enrolling.get(who.sessionKey);
    if (!secret) return admin(who, res, { error: "Start the setup again." });
    const step = totpMatch(secret, field(req, "code"));
    if (step === undefined) return admin(who, res, { error: "That code doesn't match. Check the time on your phone and try the next code." });
    enrolling.delete(who.sessionKey);
    store.updateUser(who.username, (u) => Object.assign(u, { totp: secret, totpStep: step }));
    await admin(who, res, { notice: "Two-factor login is on. You'll need a code from the app at every login." });
  });
  app.post("/admin/2fa/disable", loginLimit, form, async (req, res) => {
    const who = await adminPost(req, res);
    if (!who) return;
    const user = store.getUser(who.username)!;
    if (!user.totp || totpMatch(user.totp, field(req, "code"), user.totpStep) === undefined) return admin(who, res, { error: "Wrong code; two-factor login is still on." });
    store.updateUser(who.username, (u) => {
      delete u.totp;
      delete u.totpStep;
    });
    await admin(who, res, { notice: "Two-factor login is off." });
  });

  app.get("/", (_req, res) =>
    void res.type("html").send(page("Architecturer", `<div class="card"><h1>Architecturer</h1><p>MCP server: <code>${esc(at("/mcp"))}</code></p><p><a href="/view/">Projects</a> · <a href="/admin">Admin</a></p></div>`)),
  );
  app.use((_req, res) => void res.status(404).type("text").send("not found"));
  // errors: a message for the log, nothing internal in the response
  app.use((err: Error & { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status === 500) console.error(`architecturer: ${err.stack ?? err.message}`);
    if (res.headersSent) return void res.end();
    res.status(status).type("text").send(status === 500 ? "internal error" : err.type === "entity.too.large" ? "request too large" : "bad request");
  });

  const prune = setInterval(() => store.prune(), 6 * 3600_000);
  prune.unref();
  store.prune();

  const server: Server = await new Promise((ok, fail) => {
    const s = app.listen(cfg.port, cfg.host, () => ok(s));
    s.on("error", fail);
  });
  // long renders answer late; never cut a response off while a worker is busy on it
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : cfg.port;

  return {
    url: `http://localhost:${port}`,
    store,
    setupCode: () => login.pendingSetupCode(),
    async close() {
      clearInterval(prune);
      for (const v of viewers.values()) v.viewer.close();
      server.closeAllConnections();
      await new Promise<void>((ok) => server.close(() => ok()));
      await pool.close();
    },
  };
}

/** `arch mcp --http` / `node dist/mcp/http.js`. */
export async function main(overrides: Parameters<typeof loadConfig>[1] = {}) {
  const cfg = loadConfig(process.env, overrides);
  const srv = await startRemoteServer(cfg);
  console.error(`Architecturer MCP server on ${cfg.host}:${cfg.port}, public URL ${cfg.publicUrl.origin}`);
  console.error(`  MCP endpoint ${new URL("/mcp", cfg.publicUrl).href} (small tool set: /mcp/core); projects in ${cfg.workdir}; state in ${cfg.stateDir}`);
  const code = srv.setupCode();
  if (code) console.error(`\n  No account yet. Open ${new URL("/setup", cfg.publicUrl).href} and enter the setup code ${code}\n  (or run: arch user add --name <you>)\n`);
  else console.error(`  admin page ${new URL("/admin", cfg.publicUrl).href}`);
  const stop = async () => {
    await srv.close();
    process.exit(0);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

if (import.meta.url === `file://${process.argv[1]}` || /[\\/]mcp[\\/]http\.(ts|js)$/.test(process.argv[1] ?? ""))
  main().catch((e) => {
    console.error(`error: ${(e as Error).message}`);
    process.exit(1);
  });

