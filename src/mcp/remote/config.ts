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
  /** Let plans fetch from private network addresses (models on a LAN server). Off by default. */
  allowPrivateFetch: boolean;
  textureSize: number;
  /** Login-form attempts per IP per 15 minutes. */
  loginAttempts: number;
  /** Largest MCP request body (express size string): write_project of a big hospital plan is tens of MB. */
  maxRequest: string;
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

  return {
    publicUrl,
    port,
    host: env.HOST || "0.0.0.0",
    workdir: resolve(overrides.workdir ?? env.ARCHITECTURER_WORKDIR ?? process.cwd()),
    stateDir: resolve(env.ARCHITECTURER_STATE || defaultStateDir()),
    workers: env.ARCHITECTURER_WORKERS ? Number(env.ARCHITECTURER_WORKERS) : undefined,
    allowedHosts: [publicUrl.hostname, "localhost", "127.0.0.1", "[::1]", hostname(), ...list(env.ARCHITECTURER_ALLOWED_HOSTS)],
    allowPrivateFetch: /^(1|true|yes)$/i.test(env.ARCHITECTURER_ALLOW_PRIVATE_FETCH ?? ""),
    textureSize: Number(env.ARCHITECTURER_VIEWER_TEXTURE_SIZE || 512),
    loginAttempts: 20,
    maxRequest: env.ARCHITECTURER_MAX_REQUEST || "256mb",
  };
}
