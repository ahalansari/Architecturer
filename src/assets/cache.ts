/**
 * Download cache for online assets (textures, models, product pages, images).
 * Files live under ARCHITECTURER_CACHE (default ~/.cache/architecturer), named by a hash of the URL,
 * so builds work offline once an asset has been fetched.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";

export const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Architecturer/1.0";

export function cacheRoot(): string {
  return process.env.ARCHITECTURER_CACHE || join(homedir(), ".cache", "architecturer");
}

export const hashOf = (s: string, n = 16) => createHash("sha1").update(s).digest("hex").slice(0, n);

/** Cache path for a URL (keeps the extension). */
export function cachePathFor(url: string, sub = "files", ext?: string): string {
  const clean = url.split(/[?#]/)[0];
  const e = ext ?? (extname(clean).slice(0, 8) || ".bin");
  return join(cacheRoot(), sub, hashOf(url) + e);
}

export interface FetchOptions {
  sub?: string;
  ext?: string;
  /** Re-download after this many hours (default: never). */
  maxAgeHours?: number;
  headers?: Record<string, string>;
  /** Refuse bigger downloads (default 150 MB). */
  maxBytes?: number;
  timeoutMs?: number;
}

/** Fetch a URL into the cache (or return the cached file). Throws a readable error when offline / blocked. */
export async function fetchCached(url: string, o: FetchOptions = {}): Promise<string> {
  const path = cachePathFor(url, o.sub, o.ext);
  if (existsSync(path)) {
    if (!o.maxAgeHours) return path;
    const st = await stat(path);
    if (Date.now() - st.mtimeMs < o.maxAgeHours * 3600e3) return path;
  }
  const buf = await download(url, o);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, buf);
  await rename(tmp, path);
  return path;
}

export async function download(url: string, o: FetchOptions = {}): Promise<Buffer> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? 60_000);
  try {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { "user-agent": BROWSER_UA, accept: "*/*", "accept-language": "en-US,en;q=0.9", ...(o.headers ?? {}) },
        redirect: "follow",
        signal: ctl.signal,
      });
    } catch (e) {
      throw new Error(`could not download ${url}: ${(e as Error).message} (offline, or the site blocks scripted requests)`);
    }
    if (!res.ok) throw new Error(`could not download ${url}: HTTP ${res.status}${res.status === 403 || res.status === 503 ? " (the site blocks scripted requests; pass the product details / model file directly)" : ""}`);
    const len = Number(res.headers.get("content-length") ?? 0);
    const max = o.maxBytes ?? 150 * 1024 * 1024;
    if (len > max) throw new Error(`${url} is ${(len / 1e6).toFixed(0)} MB (limit ${(max / 1e6).toFixed(0)} MB)`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > max) throw new Error(`${url} is larger than ${(max / 1e6).toFixed(0)} MB`);
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

/** JSON from a URL, cached for `maxAgeHours`. */
export async function fetchJson<T = unknown>(url: string, maxAgeHours = 24, headers?: Record<string, string>): Promise<T> {
  const p = await fetchCached(url, { sub: "json", ext: ".json", maxAgeHours, headers });
  return JSON.parse(await readFile(p, "utf8")) as T;
}

/** Text (HTML) from a URL, cached for `maxAgeHours`. */
export async function fetchText(url: string, maxAgeHours = 24): Promise<string> {
  const p = await fetchCached(url, { sub: "pages", ext: ".html", maxAgeHours, headers: { accept: "text/html,application/xhtml+xml" } });
  return readFile(p, "utf8");
}
