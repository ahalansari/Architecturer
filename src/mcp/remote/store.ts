/**
 * Persistent auth state for the remote server: OAuth clients (dynamic registration), grants (one per
 * connected app or personal token) and their tokens. Single user, a handful of clients: one JSON file,
 * written atomically. Tokens are stored as SHA-256 hashes; the plaintext is only ever shown once.
 *
 * The CLI (`arch token create`) writes the same file while the server runs, so every access reloads the
 * file when it changed on disk.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

export type TokenKind = "access" | "refresh" | "pat";

export interface TokenRecord {
  kind: TokenKind;
  grant: string;
  /** Unix seconds; personal tokens don't expire. */
  expiresAt?: number;
}

export interface Grant {
  id: string;
  /** OAuth client id, or 'pat' for a personal access token. */
  clientId: string;
  /** Shown on the admin page: the app's name, or the token's name. */
  name: string;
  scopes: string[];
  createdAt: number;
  lastUsed?: number;
  /** Where the OAuth client redirects (shown so you can tell clients apart). */
  redirectHost?: string;
}

export interface StoredClient extends OAuthClientInformationFull {
  /** Set once a user approved this client; unapproved registrations are pruned. */
  approvedAt?: number;
}

interface State {
  version: 1;
  /** Key for signed links and session cookies. */
  secret: string;
  clients: Record<string, StoredClient>;
  grants: Record<string, Grant>;
  tokens: Record<string, TokenRecord>;
}

export const ACCESS_TTL = 3600;
export const REFRESH_TTL = 30 * 24 * 3600;
const MAX_CLIENTS = 300;

export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
const randomId = (bytes = 9) => randomBytes(bytes).toString("base64url");
const now = () => Math.floor(Date.now() / 1000);

export function defaultStateDir(): string {
  return process.env.ARCHITECTURER_STATE || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "architecturer");
}

export class AuthStore {
  private state!: State;
  private mtime = 0;
  /** lastUsed updates not yet saved (applied again after a reload, so they survive a CLI write). */
  private used = new Map<string, number>();
  private flushTimer?: NodeJS.Timeout;
  readonly file: string;

  constructor(readonly dir: string = defaultStateDir()) {
    this.file = join(dir, "auth.json");
    this.reload(true);
  }

  /** Re-read the file if something else (the CLI) changed it. */
  private reload(force = false) {
    if (!existsSync(this.file)) {
      if (force || !this.state) {
        this.state = { version: 1, secret: randomBytes(32).toString("base64url"), clients: {}, grants: {}, tokens: {} };
        this.write();
      }
      return;
    }
    const m = statSync(this.file).mtimeMs;
    if (!force && m === this.mtime) return;
    this.state = JSON.parse(readFileSync(this.file, "utf8")) as State;
    this.mtime = m;
    for (const [id, t] of this.used) if (this.state.grants[id]) this.state.grants[id].lastUsed = t;
  }

  private write() {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 1), { mode: 0o600 });
    renameSync(tmp, this.file);
    this.mtime = statSync(this.file).mtimeMs;
    this.used.clear();
  }

  /** Change state: reload first so a concurrent CLI write isn't lost, then save. */
  private mutate<T>(fn: (s: State) => T): T {
    this.reload();
    const r = fn(this.state);
    this.write();
    return r;
  }

  /** Low-value updates (last used) are saved at most once a minute. */
  private touch(grant: Grant) {
    grant.lastUsed = now();
    this.used.set(grant.id, grant.lastUsed);
    this.flushTimer ??= setTimeout(() => {
      this.flushTimer = undefined;
      if (this.used.size) this.mutate(() => undefined);
    }, 60_000).unref();
  }

  get secret(): string {
    this.reload();
    return this.state.secret;
  }

  // ---- clients ----

  getClient(id: string): StoredClient | undefined {
    this.reload();
    return this.state.clients[id];
  }

  registerClient(client: StoredClient): StoredClient {
    return this.mutate((s) => {
      // open registration: drop the oldest never-approved clients rather than grow without bound
      const ids = Object.keys(s.clients);
      if (ids.length >= MAX_CLIENTS) {
        const stale = ids.filter((i) => !s.clients[i].approvedAt).sort((a, b) => (s.clients[a].client_id_issued_at ?? 0) - (s.clients[b].client_id_issued_at ?? 0));
        for (const i of stale.slice(0, ids.length - MAX_CLIENTS + 1)) delete s.clients[i];
        if (Object.keys(s.clients).length >= MAX_CLIENTS) throw new Error("too many registered clients; revoke some on the admin page");
      }
      s.clients[client.client_id] = client;
      return client;
    });
  }

  markApproved(clientId: string) {
    this.mutate((s) => {
      const c = s.clients[clientId];
      if (c && !c.approvedAt) c.approvedAt = now();
    });
  }

  // ---- grants and tokens ----

  private issue(s: State, grant: string, kind: TokenKind, ttl?: number): string {
    const token = `arch_${kind === "access" ? "at" : kind === "refresh" ? "rt" : "pat"}_${randomBytes(32).toString("base64url")}`;
    s.tokens[hashToken(token)] = { kind, grant, ...(ttl ? { expiresAt: now() + ttl } : {}) };
    return token;
  }

  /** New OAuth grant with an access + refresh token. */
  createGrant(g: Omit<Grant, "id" | "createdAt">): { grant: Grant; access: string; refresh: string } {
    return this.mutate((s) => {
      const grant: Grant = { ...g, id: randomId(), createdAt: now() };
      s.grants[grant.id] = grant;
      return { grant, access: this.issue(s, grant.id, "access", ACCESS_TTL), refresh: this.issue(s, grant.id, "refresh", REFRESH_TTL) };
    });
  }

  /** Personal access token (for clients configured with a header: LM Studio, Claude Code, scripts). */
  createPat(name: string): { grant: Grant; token: string } {
    return this.mutate((s) => {
      const grant: Grant = { id: randomId(), clientId: "pat", name, scopes: ["plans"], createdAt: now() };
      s.grants[grant.id] = grant;
      return { grant, token: this.issue(s, grant.id, "pat") };
    });
  }

  /** Rotate a refresh token: the old one stops working, a new access + refresh pair is returned. */
  rotateRefresh(refresh: string, clientId: string): { grant: Grant; access: string; refresh: string } | undefined {
    return this.mutate((s) => {
      const h = hashToken(refresh);
      const rec = s.tokens[h];
      const grant = rec && s.grants[rec.grant];
      if (!rec || rec.kind !== "refresh" || !grant || grant.clientId !== clientId) return undefined;
      delete s.tokens[h];
      if (rec.expiresAt !== undefined && rec.expiresAt < now()) return undefined;
      // access tokens of this grant are replaced too
      for (const [k, t] of Object.entries(s.tokens)) if (t.grant === grant.id && t.kind === "access") delete s.tokens[k];
      grant.lastUsed = now();
      return { grant, access: this.issue(s, grant.id, "access", ACCESS_TTL), refresh: this.issue(s, grant.id, "refresh", REFRESH_TTL) };
    });
  }

  /** Access or personal token → its grant (undefined when unknown, expired or revoked). */
  verify(token: string): { grant: Grant; record: TokenRecord } | undefined {
    this.reload();
    const rec = this.state.tokens[hashToken(token)];
    if (!rec || rec.kind === "refresh") return undefined;
    if (rec.expiresAt !== undefined && rec.expiresAt < now()) return undefined;
    const grant = this.state.grants[rec.grant];
    if (!grant) return undefined;
    if (!grant.lastUsed || now() - grant.lastUsed > 60) this.touch(grant);
    return { grant, record: rec };
  }

  /** Revoke the grant a token belongs to (OAuth revocation endpoint). */
  revokeToken(token: string, clientId?: string) {
    this.reload();
    const rec = this.state.tokens[hashToken(token)];
    if (!rec) return;
    const grant = this.state.grants[rec.grant];
    if (clientId && grant && grant.clientId !== clientId) return;
    this.revokeGrant(rec.grant);
  }

  revokeGrant(id: string): boolean {
    return this.mutate((s) => {
      if (!s.grants[id]) return false;
      delete s.grants[id];
      for (const [k, t] of Object.entries(s.tokens)) if (t.grant === id) delete s.tokens[k];
      return true;
    });
  }

  grants(): Grant[] {
    this.reload();
    return Object.values(this.state.grants).sort((a, b) => (b.lastUsed ?? b.createdAt) - (a.lastUsed ?? a.createdAt));
  }

  /** Drop expired tokens and grants left without any token (expired refresh). */
  prune() {
    this.mutate((s) => {
      const t = now();
      for (const [k, r] of Object.entries(s.tokens)) if (r.expiresAt !== undefined && r.expiresAt < t) delete s.tokens[k];
      const live = new Set(Object.values(s.tokens).map((r) => r.grant));
      for (const id of Object.keys(s.grants)) if (!live.has(id)) delete s.grants[id];
      for (const [id, c] of Object.entries(s.clients)) if (!c.approvedAt && (c.client_id_issued_at ?? 0) < t - 86400) delete s.clients[id];
    });
  }
}
