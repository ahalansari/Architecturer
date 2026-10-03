/**
 * OAuth 2.1 authorization server for the remote MCP endpoint, plugged into the SDK's mcpAuthRouter (which
 * handles request parsing, PKCE checks and error formats). Claude (web / desktop / mobile), ChatGPT and
 * LM Studio register themselves (dynamic client registration, or a client ID metadata document URL), send
 * you to the consent page, and get short-lived access tokens with rotating refresh tokens.
 */
import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { InvalidClientMetadataError, InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { download } from "../../assets/cache.js";
import type { Login } from "./login.js";
import { consentPage, messagePage } from "./pages.js";
import { ACCESS_TTL, type AuthStore, type StoredClient } from "./store.js";

export const SCOPES = ["plans"];
const CODE_TTL = 5 * 60_000;
const PENDING_TTL = 15 * 60_000;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Redirect URIs a client may use: https anywhere, http only to this machine, or a native app scheme. */
export function redirectAllowed(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:") return LOOPBACK.has(u.hostname);
  return !["javascript:", "data:", "file:", "vbscript:", "about:", "blob:", "ftp:", "ws:", "wss:"].includes(u.protocol);
}

const hostOf = (uri: string) => {
  try {
    const u = new URL(uri);
    return u.host || u.protocol;
  } catch {
    return uri;
  }
};

interface Pending {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  expires: number;
}
interface Code {
  clientId: string;
  params: AuthorizationParams;
  expires: number;
}

export class ArchOAuthProvider implements OAuthServerProvider {
  private pending = new Map<string, Pending>();
  private codes = new Map<string, Code>();
  /** Client ID metadata documents, cached for an hour. */
  private cimd = new Map<string, { client?: OAuthClientInformationFull; error?: string; expires: number }>();

  constructor(
    private store: AuthStore,
    private login: Login,
    private loginUrl: (next: string) => string,
  ) {
    setInterval(() => this.sweep(), 60_000).unref();
  }

  private sweep() {
    const t = Date.now();
    for (const [k, v] of this.pending) if (v.expires < t) this.pending.delete(k);
    for (const [k, v] of this.codes) if (v.expires < t) this.codes.delete(k);
    for (const [k, v] of this.cimd) if (v.expires < t) this.cimd.delete(k);
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: async (id) => (/^https:\/\//.test(id) ? this.metadataClient(id) : this.store.getClient(id)),
      registerClient: async (client) => {
        const bad = client.redirect_uris.find((u) => !redirectAllowed(String(u)));
        if (bad) throw new InvalidClientMetadataError(`redirect_uri not allowed: ${bad} (use https, a loopback http address, or an app scheme)`);
        return this.store.registerClient(client as StoredClient);
      },
    };
  }

  /** A Client ID Metadata Document: the client id is an https URL serving the client's registration. */
  private async metadataClient(url: string): Promise<OAuthClientInformationFull | undefined> {
    const hit = this.cimd.get(url);
    if (hit && hit.expires > Date.now()) return hit.client;
    let client: OAuthClientInformationFull | undefined;
    try {
      const doc = JSON.parse((await download(url, { maxBytes: 64 * 1024, timeoutMs: 5000, headers: { accept: "application/json" } })).toString("utf8"));
      if (doc?.client_id !== url) throw new Error("client_id in the document does not match its URL");
      const uris = Array.isArray(doc.redirect_uris) ? doc.redirect_uris.map(String) : [];
      if (!uris.length || !uris.every(redirectAllowed)) throw new Error("missing or disallowed redirect_uris");
      client = {
        client_id: url,
        client_name: typeof doc.client_name === "string" ? doc.client_name.slice(0, 80) : hostOf(url),
        redirect_uris: uris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      };
    } catch (e) {
      console.error(`architecturer: client metadata ${url}: ${(e as Error).message}`);
    }
    this.cimd.set(url, { client, expires: Date.now() + (client ? 3600_000 : 60_000) });
    return client;
  }

  /** Step 1 (GET /authorize): log in if needed, then ask whether to allow the client. */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const req = res.req as Request;
    res.setHeader("cache-control", "no-store");
    const who = await this.login.identify(req);
    if (!who) {
      const q = new URLSearchParams(req.method === "POST" ? (req.body as Record<string, string>) : (req.query as Record<string, string>));
      res.redirect(302, this.loginUrl(`/authorize?${q}`));
      return;
    }
    const id = randomBytes(18).toString("base64url");
    this.pending.set(id, { client, params, expires: Date.now() + PENDING_TTL });
    res
      .status(200)
      .type("html")
      .set("x-frame-options", "DENY")
      .set("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'")
      .send(consentPage({ id, clientName: client.client_name || hostOf(params.redirectUri), redirectHost: hostOf(params.redirectUri), username: who.username, csrf: this.login.csrf(who, `consent:${id}`) }));
  }

  /** Step 2 (POST /authorize/decision): the consent form's answer; redirects back to the client. */
  async decide(req: Request, res: Response) {
    res.setHeader("cache-control", "no-store");
    const who = await this.login.identify(req);
    const { id, decision, csrf } = (req.body ?? {}) as Record<string, string>;
    if (!who || !id || !this.login.checkCsrf(who, `consent:${id}`, csrf)) {
      res.status(403).type("html").send(messagePage("Not allowed", "Log in again and retry from the app."));
      return;
    }
    const p = this.pending.get(id);
    this.pending.delete(id);
    if (!p || p.expires < Date.now()) {
      res.status(400).type("html").send(messagePage("Request expired", "Start the connection again from the app."));
      return;
    }
    const back = new URL(p.params.redirectUri);
    if (p.params.state !== undefined) back.searchParams.set("state", p.params.state);
    if (decision !== "allow") {
      back.searchParams.set("error", "access_denied");
      back.searchParams.set("error_description", "The user denied access");
      res.redirect(302, back.href);
      return;
    }
    const code = randomBytes(24).toString("base64url");
    this.codes.set(code, { clientId: p.client.client_id, params: p.params, expires: Date.now() + CODE_TTL });
    if (this.store.getClient(p.client.client_id)) this.store.markApproved(p.client.client_id);
    back.searchParams.set("code", code);
    res.redirect(302, back.href);
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const c = this.codes.get(code);
    if (!c || c.clientId !== client.client_id || c.expires < Date.now()) throw new InvalidGrantError("invalid or expired authorization code");
    return c.params.codeChallenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string): Promise<OAuthTokens> {
    const c = this.codes.get(code);
    this.codes.delete(code); // single use, even when the exchange fails
    if (!c || c.clientId !== client.client_id || c.expires < Date.now()) throw new InvalidGrantError("invalid or expired authorization code");
    if (redirectUri !== undefined && redirectUri !== c.params.redirectUri) throw new InvalidGrantError("redirect_uri does not match the authorization request");
    const scopes = c.params.scopes?.length ? c.params.scopes.filter((s) => SCOPES.includes(s)) : SCOPES;
    const { access, refresh } = this.store.createGrant({
      clientId: client.client_id,
      name: client.client_name || hostOf(c.params.redirectUri),
      scopes: scopes.length ? scopes : SCOPES,
      redirectHost: hostOf(c.params.redirectUri),
    });
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL, refresh_token: refresh, scope: (scopes.length ? scopes : SCOPES).join(" ") };
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const r = this.store.rotateRefresh(refreshToken, client.client_id);
    if (!r) throw new InvalidGrantError("invalid, expired or revoked refresh token");
    return { access_token: r.access, token_type: "Bearer", expires_in: ACCESS_TTL, refresh_token: r.refresh, scope: r.grant.scopes.join(" ") };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const v = this.store.verify(token);
    if (!v) throw new InvalidTokenError("invalid, expired or revoked token");
    // personal tokens don't expire; the SDK middleware wants a time, so report a year from now
    const expiresAt = v.record.expiresAt ?? Math.floor(Date.now() / 1000) + 365 * 86400;
    return { token, clientId: v.grant.clientId, scopes: v.grant.scopes, expiresAt, extra: { grant: v.grant.id, name: v.grant.name } };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    this.store.revokeToken(request.token, client.client_id);
  }
}
