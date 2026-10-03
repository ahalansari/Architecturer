/**
 * Process-wide limits for the remote (HTTP) MCP server. Locally nothing is restricted; remotely a plan,
 * a tool argument or a vendor page must not be able to read files outside the project folder or make the
 * server fetch addresses on the private network (router, NAS admin pages, cloud metadata endpoints).
 */
import { realpathSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { dirname, resolve, sep } from "node:path";

interface Policy {
  /** Local files may only be read below these folders. */
  roots: string[];
  /** Refuse URLs that resolve to private / loopback / link-local addresses. */
  publicNetworkOnly: boolean;
}

let policy: Policy | undefined;

export function setSandbox(p: Policy | undefined) {
  policy = p && { ...p, roots: p.roots.map((r) => realOrSelf(resolve(r))) };
}

export const sandboxed = () => policy !== undefined;

/** Real path of the deepest existing ancestor joined with the rest (so symlinks can't escape a root). */
function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const parent = dirname(p);
    return parent === p ? p : resolve(realOrSelf(parent), p.slice(parent.length + 1));
  }
}

export function isInside(p: string, root: string): boolean {
  return p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** `p` resolved against `root`; throws when it (or a symlink on its way) leads outside `root`. */
export function confine(root: string, p: string, what = "path"): string {
  const abs = resolve(root, p);
  if (!isInside(realOrSelf(abs), realOrSelf(resolve(root)))) throw new Error(`${what} '${p}' is outside the project folder`);
  return abs;
}

/** Throws when the sandbox is active and `p` is outside every allowed root. Returns the absolute path. */
export function checkLocalPath(p: string, what = "file"): string {
  const abs = resolve(p);
  if (!policy) return abs;
  const real = realOrSelf(abs);
  if (!policy.roots.some((r) => isInside(real, r))) throw new Error(`${what} '${p}' is outside the project folder`);
  return abs;
}

const PRIVATE = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const)
  PRIVATE.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["64:ff9b::", 96]] as const)
  PRIVATE.addSubnet(net, bits, "ipv6");

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    if (mapped) return PRIVATE.check(mapped[1], "ipv4");
    return PRIVATE.check(ip, "ipv6");
  }
  return v === 4 ? PRIVATE.check(ip, "ipv4") : true;
}

/** Throws unless `url` is http(s) and (in the sandbox) every address it resolves to is public. */
export async function checkUrl(url: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`not a URL: ${url}`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`only http(s) URLs can be fetched (got ${u.protocol})`);
  if (!policy?.publicNetworkOnly) return u;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true, verbatim: true }).catch(() => [])).map((a) => a.address);
  if (!addrs.length) throw new Error(`could not resolve ${u.hostname}`);
  if (addrs.some(isPrivateAddress)) throw new Error(`refusing to fetch ${u.hostname}: it resolves to a private network address`);
  return u;
}
