/** Remote server settings, from the environment (the Docker image sets most of them). */
import { hostname } from "node:os";
import { resolve } from "node:path";
import { defaultStateDir } from "./store.js";

export interface RemoteConfig {
  /** Public origin clients reach (https://arch.example.com); the OAuth issuer and every link use it. */
  publicUrl: URL;
  port: number;
  host: string;
  workdir: string;
  stateDir: string;
  workers?: number;
  /** Host headers accepted (DNS-rebinding protection). */
  allowedHosts: string[];
  /** Login with Cloudflare Access: team domain (myteam.cloudflareaccess.com) and the application's AUD tag(s). */
  access?: { teamDomain: string; aud: string[] };
  /** Emails allowed to log in (Access); empty = whoever the Access policy lets through. */
  allowedEmails: string[];
  /** Login with a password instead of (or as well as) Cloudflare Access. */
  adminPassword?: string;
  /** Let plans fetch from private network addresses (models on a LAN server). Off by default. */
  allowPrivateFetch: boolean;
  textureSize: number;
}

const list = (v: string | undefined) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export function loadConfig(env = process.env, overrides: Partial<{ port: number; workdir: string; publicUrl: string }> = {}): RemoteConfig {
  const port = overrides.port ?? Number(env.PORT || env.ARCHITECTURER_PORT || 5178);
  const pub = overrides.publicUrl ?? env.ARCHITECTURER_PUBLIC_URL ?? `http://localhost:${port}`;
  let publicUrl: URL;
  try {
    publicUrl = new URL(pub);
  } catch {
    throw new Error(`ARCHITECTURER_PUBLIC_URL is not a URL: ${pub}`);
  }
  if (publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash) throw new Error("ARCHITECTURER_PUBLIC_URL must be an origin only, e.g. https://arch.example.com");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(publicUrl.hostname);
  if (publicUrl.protocol !== "https:" && !local) throw new Error("ARCHITECTURER_PUBLIC_URL must be https (OAuth clients refuse plain http)");

  const team = env.CF_ACCESS_TEAM_DOMAIN?.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const aud = list(env.CF_ACCESS_AUD);
  if (!!team !== aud.length > 0) throw new Error("set both CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD (or neither)");

  return {
    publicUrl,
    port,
    host: env.HOST || "0.0.0.0",
    workdir: resolve(overrides.workdir ?? env.ARCHITECTURER_WORKDIR ?? process.cwd()),
    stateDir: resolve(defaultStateDir()),
    workers: env.ARCHITECTURER_WORKERS ? Number(env.ARCHITECTURER_WORKERS) : undefined,
    allowedHosts: [publicUrl.hostname, "localhost", "127.0.0.1", "[::1]", hostname(), ...list(env.ARCHITECTURER_ALLOWED_HOSTS)],
    access: team ? { teamDomain: team, aud } : undefined,
    allowedEmails: list(env.ARCHITECTURER_ALLOWED_EMAILS).map((e) => e.toLowerCase()),
    adminPassword: env.ARCHITECTURER_ADMIN_PASSWORD || undefined,
    allowPrivateFetch: /^(1|true|yes)$/i.test(env.ARCHITECTURER_ALLOW_PRIVATE_FETCH ?? ""),
    textureSize: Number(env.ARCHITECTURER_VIEWER_TEXTURE_SIZE || 512),
  };
}
