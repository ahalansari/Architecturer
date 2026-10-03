/**
 * Who is at the browser: the human pages (OAuth consent, admin, 3D viewer) need you logged in. Two ways:
 * - Cloudflare Access in front of those paths: Access adds a signed JWT header, verified here against the
 *   team's public keys (so a request that bypassed Access can't fake it).
 * - A password (ARCHITECTURER_ADMIN_PASSWORD): a login form and a signed session cookie.
 * Machine endpoints (/mcp, /token, /register) never use this; they take OAuth / personal tokens.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { RemoteConfig } from "./config.js";

export interface Identity {
  email: string;
  via: "access" | "password";
}

const SESSION_COOKIE = "arch_session";
const SESSION_TTL = 12 * 3600;

const sameText = (a: string, b: string) => {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
};

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export class Login {
  private jwks?: ReturnType<typeof createRemoteJWKSet>;

  constructor(
    private cfg: RemoteConfig,
    private secret: () => string,
  ) {
    if (cfg.access) this.jwks = createRemoteJWKSet(new URL(`https://${cfg.access.teamDomain}/cdn-cgi/access/certs`));
  }

  get methods(): ("access" | "password")[] {
    return [...(this.cfg.access ? (["access"] as const) : []), ...(this.cfg.adminPassword ? (["password"] as const) : [])];
  }

  private hmac(s: string) {
    return createHmac("sha256", this.secret()).update(s).digest("base64url");
  }

  async identify(req: IncomingMessage): Promise<Identity | undefined> {
    const jwt = req.headers["cf-access-jwt-assertion"];
    if (this.jwks && typeof jwt === "string") {
      try {
        const { payload } = await jwtVerify(jwt, this.jwks, { issuer: `https://${this.cfg.access!.teamDomain}`, audience: this.cfg.access!.aud });
        const email = typeof payload.email === "string" ? payload.email.toLowerCase() : undefined;
        // service tokens have no email: they are for machines, not for approving apps
        if (email && (!this.cfg.allowedEmails.length || this.cfg.allowedEmails.includes(email))) return { email, via: "access" };
      } catch {
        // invalid / expired: fall through to the session cookie
      }
    }
    if (this.cfg.adminPassword) {
      const v = cookies(req)[SESSION_COOKIE];
      const m = v && /^v1\.(\d+)\.([\w-]+)$/.exec(v);
      if (m && Number(m[1]) > Date.now() / 1000 && sameText(m[2], this.hmac(`session:${m[1]}`))) return { email: "admin", via: "password" };
    }
    return undefined;
  }

  checkPassword(pw: string): boolean {
    return !!this.cfg.adminPassword && sameText(pw, this.cfg.adminPassword);
  }

  /** Set-Cookie value for a new password session (Secure when the browser came over https, e.g. via the tunnel). */
  sessionCookie(https: boolean): string {
    const exp = Math.floor(Date.now() / 1000) + SESSION_TTL;
    const secure = https ? "; Secure" : "";
    return `${SESSION_COOKIE}=v1.${exp}.${this.hmac(`session:${exp}`)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL}${secure}`;
  }

  clearCookie(): string {
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  }

  /** Token for forms, tied to the user and purpose (a cross-site form post can't produce it). */
  csrf(who: Identity, purpose: string): string {
    return this.hmac(`csrf:${who.email}:${purpose}`);
  }

  checkCsrf(who: Identity, purpose: string, token: unknown): boolean {
    return typeof token === "string" && sameText(token, this.csrf(who, purpose));
  }
}
