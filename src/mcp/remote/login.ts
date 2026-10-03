/**
 * Built-in login for the human pages (OAuth consent, admin, 3D viewer): user accounts with scrypt
 * passwords, optional TOTP two-factor codes, server-side sessions in an HttpOnly cookie, and lockout
 * after repeated failures. Machine endpoints (/mcp, /token, /register) never use this; they take OAuth /
 * personal tokens.
 *
 * The first account is created on /setup with a one-time code printed in the server log, so whoever
 * reaches a fresh server first can't claim it. `arch user` (CLI) manages accounts too.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { dummyHash, totpMatch, verifyPassword } from "./crypto.js";
import type { AuthStore, User } from "./store.js";
import { SESSION_TTL } from "./store.js";

export interface Identity {
  username: string;
  /** Hash of the session id: ties form tokens to this session. */
  sessionKey: string;
}

const COOKIE = "arch_session";
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;
const SECOND_STEP_TTL = 5 * 60;

const same = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) {
      try {
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        // malformed cookie: ignore
      }
    }
  }
  return out;
}

export type LoginResult = { ok: true; user: User } | { ok: false; error: string };

export class Login {
  private failures = new Map<string, { count: number; until?: number }>();
  /** One-time code for creating the first account (while there is none). */
  private setupCode?: string;

  constructor(private store: AuthStore) {}

  private hmac(s: string) {
    return createHmac("sha256", this.store.secret).update(s).digest("base64url");
  }

  /** The current setup code, creating one if the server has no account yet. */
  pendingSetupCode(): string | undefined {
    if (this.store.hasUsers()) return (this.setupCode = undefined);
    return (this.setupCode ??= `${randomBytes(3).toString("hex")}-${randomBytes(3).toString("hex")}`.toUpperCase());
  }

  checkSetupCode(code: string): boolean {
    const want = this.pendingSetupCode();
    return !!want && same(code.trim().toUpperCase(), want);
  }

  async identify(req: IncomingMessage): Promise<Identity | undefined> {
    const id = cookies(req)[COOKIE];
    if (!id) return undefined;
    const s = this.store.session(id);
    return s && { username: s.user.username, sessionKey: s.key };
  }

  private locked(key: string): number | undefined {
    const f = this.failures.get(key);
    if (f?.until && f.until > Date.now()) return Math.ceil((f.until - Date.now()) / 60_000);
    return undefined;
  }

  private failed(key: string) {
    const f = this.failures.get(key) ?? { count: 0 };
    if (f.until && f.until <= Date.now()) Object.assign(f, { count: 0, until: undefined });
    f.count++;
    if (f.count >= MAX_FAILURES) f.until = Date.now() + LOCK_MS;
    this.failures.set(key, f);
  }

  /** Step 1: username + password. */
  async password(username: string, password: string): Promise<LoginResult> {
    const key = username.trim().toLowerCase();
    const mins = this.locked(key);
    if (mins) return { ok: false, error: `Too many failed attempts. Try again in ${mins} min.` };
    const user = key ? this.store.getUser(key) : undefined;
    // hash even for unknown users, so response time doesn't reveal which usernames exist
    const good = await verifyPassword(password, user?.password ?? (await dummyHash()));
    if (!user || !good) {
      this.failed(key);
      return { ok: false, error: "Wrong username or password." };
    }
    this.failures.delete(key);
    return { ok: true, user };
  }

  /** Signed, short-lived proof that step 1 passed, carried to the two-factor form. */
  secondStepToken(user: User): string {
    const exp = Math.floor(Date.now() / 1000) + SECOND_STEP_TTL;
    const u = Buffer.from(user.username).toString("base64url");
    return `${u}.${exp}.${this.hmac(`2fa:${user.username}:${user.passwordChangedAt}:${exp}`)}`;
  }

  /** Step 2: the TOTP code, with the token from step 1. */
  async secondStep(token: string, code: string): Promise<LoginResult> {
    const [u, exp, sig] = token.split(".");
    let username = "";
    try {
      username = Buffer.from(u ?? "", "base64url").toString("utf8");
    } catch {
      // bad token
    }
    const user = username ? this.store.getUser(username) : undefined;
    if (!user?.totp || !sig || Number(exp) < Date.now() / 1000 || !same(sig, this.hmac(`2fa:${user.username}:${user.passwordChangedAt}:${exp}`)))
      return { ok: false, error: "The login expired. Start again." };
    const key = `2fa:${user.username.toLowerCase()}`;
    const mins = this.locked(key);
    if (mins) return { ok: false, error: `Too many wrong codes. Try again in ${mins} min.` };
    const step = totpMatch(user.totp, code, user.totpStep);
    if (step === undefined) {
      this.failed(key);
      return { ok: false, error: "Wrong code." };
    }
    this.failures.delete(key);
    this.store.updateUser(user.username, (x) => (x.totpStep = step));
    return { ok: true, user };
  }

  /** Start a session; returns the Set-Cookie value. */
  startSession(user: User, req: IncomingMessage & { ip?: string; secure?: boolean }): string {
    const id = this.store.createSession(user.username, { agent: req.headers["user-agent"], ip: req.ip });
    return `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL}${req.secure ? "; Secure" : ""}`;
  }

  endSession(who: Identity): string {
    this.store.deleteSession(who.sessionKey);
    return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  }

  /** Token for forms, tied to the session and purpose (a cross-site form post can't produce it). */
  csrf(who: Identity, purpose: string): string {
    return this.hmac(`csrf:${who.sessionKey}:${purpose}`);
  }

  checkCsrf(who: Identity, purpose: string, token: unknown): boolean {
    return typeof token === "string" && same(token, this.csrf(who, purpose));
  }
}
