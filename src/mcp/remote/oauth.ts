/**
 * OAuth 2.1 authorization server for the remote MCP endpoint, plugged into the SDK's mcpAuthRouter (which
 * handles request parsing, PKCE checks and error formats). Claude (web / desktop / mobile), ChatGPT and
 * LM Studio register themselves (dynamic client registration, or a client ID metadata document URL), send
 * you to the consent page, and get short-lived access tokens with rotating refresh tokens.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { redirectUriMatches } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import { InvalidClientMetadataError, InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { download } from "../../assets/cache.js";
import type { Identity, Login } from "./login.js";
import { consentPage, messagePage } from "./pages.js";
import { ACCESS_TTL, type AuthStore, type StoredClient } from "./store.js";

export const SCOPES = ["plans"];
const CODE_TTL = 5 * 60_000;
/** How long the Allow page stays valid; an older one is simply shown again (the user is logged in anyway). */
const REQUEST_TTL = 2 * 3600;
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

/** An authorization request carried by the Allow form itself (signed): survives server restarts. */
interface SignedRequest {
  client: string;
  redirect: string;
  challenge: string;
  state?: string;
  scopes?: string[];
  resource?: string;
  exp: number;
}

export class ArchOAuthProvider implements OAuthServerProvider {
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

  private sign(r: SignedRequest): string {
    const body = Buffer.from(JSON.stringify(r)).toString("base64url");
    return `${body}.${createHmac("sha256", this.store.secret).update(`authreq:${body}`).digest("base64url")}`;
  }

  private unsign(token: string): SignedRequest | undefined {
    const [body, sig] = token.split(".");
    if (!body || !sig) return undefined;
    const want = Buffer.from(createHmac("sha256", this.store.secret).update(`authreq:${body}`).digest("base64url"));
    const got = Buffer.from(sig);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return undefined;
    try {
      return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SignedRequest;
    } catch {
      return undefined;
    }
  }

  private consent(res: Response, who: Identity, client: OAuthClientInformationFull, r: SignedRequest, note?: string) {
    const token = this.sign({ ...r, exp: Math.floor(Date.now() / 1000) + REQUEST_TTL });
    res
      .status(200)
      .type("html")
      .set("cache-control", "no-store")
      .set("x-frame-options", "DENY")
      .set("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'")
      .send(consentPage({ request: token, clientName: client.client_name || hostOf(r.redirect), redirectHost: hostOf(r.redirect), username: who.username, csrf: this.login.csrf(who, "consent"), note }));
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
    this.consent(res, who, client, {
      client: client.client_id,
      redirect: params.redirectUri,
      challenge: params.codeChallenge,
      state: params.state,
      scopes: params.scopes,
      resource: params.resource?.href,
      exp: 0,
    });
  }

  /** Step 2 (POST /authorize/decision): the consent form's answer; redirects back to the client. */
  async decide(req: Request, res: Response) {
    res.setHeader("cache-control", "no-store");
    const who = await this.login.identify(req);
    const { request, decision, csrf } = (req.body ?? {}) as Record<string, string>;
    if (!who) {
      res.status(403).type("html").send(messagePage("Not logged in", "Your session ended. Start the connection again from the app."));
      return;
    }
    if (!this.login.checkCsrf(who, "consent", csrf)) {
      res.status(403).type("html").send(messagePage("Not allowed", "This form did not come from this server. Start the connection again from the app."));
      return;
    }
    const r = request ? this.unsign(request) : undefined;
    const client = r ? await this.clientsStore.getClient(r.client) : undefined;
    // the redirect must still be one the client registered (the SDK's rule: exact, or loopback on any port)
    if (!r || !client || !client.redirect_uris.some((u) => redirectUriMatches(r.redirect, String(u)))) {
      res.status(400).type("html").send(messagePage("Invalid request", "This sign-in request is not valid any more. Start the connection again from the app."));
      return;
    }
    // an old Allow page: ask again rather than fail (the user is logged in, the request is ours)
    if (r.exp < Date.now() / 1000) return this.consent(res, who, client, r, "This page had been open a long time; confirm once more.");
    const back = new URL(r.redirect);
    if (r.state !== undefined) back.searchParams.set("state", r.state);
    if (decision !== "allow") {
      back.searchParams.set("error", "access_denied");
      back.searchParams.set("error_description", "The user denied access");
      res.redirect(302, back.href);
      return;
    }
    const code = randomBytes(24).toString("base64url");
    this.store.saveCode(code, { clientId: r.client, redirectUri: r.redirect, challenge: r.challenge, scopes: r.scopes ?? [] }, CODE_TTL / 1000);
    if (this.store.getClient(r.client)) this.store.markApproved(r.client);
    back.searchParams.set("code", code);
    res.redirect(302, back.href);
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const c = this.store.peekCode(code);
    if (!c || c.clientId !== client.client_id) throw new InvalidGrantError("invalid or expired authorization code");
    return c.challenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string): Promise<OAuthTokens> {
    const c = this.store.takeCode(code); // single use, even when the exchange fails
    if (!c || c.clientId !== client.client_id) throw new InvalidGrantError("invalid or expired authorization code");
    if (redirectUri !== undefined && redirectUri !== c.redirectUri) throw new InvalidGrantError("redirect_uri does not match the authorization request");
    const scopes = c.scopes.length ? c.scopes.filter((s) => SCOPES.includes(s)) : SCOPES;
    const { access, refresh } = this.store.createGrant({
      clientId: client.client_id,
      name: client.client_name || hostOf(c.redirectUri),
      scopes: scopes.length ? scopes : SCOPES,
      redirectHost: hostOf(c.redirectUri),
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
