/** Password hashing (scrypt) and time-based one-time codes (TOTP, RFC 6238) for the built-in login. */
import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

const scrypt = (pw: string, salt: Buffer, len: number, o: ScryptOptions) =>
  new Promise<Buffer>((ok, fail) => scryptCb(pw, salt, len, o, (e, key) => (e ? fail(e) : ok(key))));

// ~64 MB and ~0.1 s per hash: cheap for one login, expensive for guessing
const N = 2 ** 16, R = 8, P = 1, LEN = 32;
const MAXMEM = 128 * N * R * 2;

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw.normalize("NFKC"), salt, LEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, key] = stored.split("$");
  if (alg !== "scrypt" || !salt || !key) return false;
  const want = Buffer.from(key, "base64url");
  const got = await scrypt(pw.normalize("NFKC"), Buffer.from(salt, "base64url"), want.length, { N: +n, r: +r, p: +p, maxmem: 128 * +n * +r * 2 });
  return got.length === want.length && timingSafeEqual(got, want);
}

/** A hash to compare against when the user doesn't exist, so timing doesn't reveal valid usernames. */
let dummy: Promise<string> | undefined;
export const dummyHash = () => (dummy ??= hashPassword(randomBytes(16).toString("hex")));

export function passwordProblem(pw: string, username?: string): string | undefined {
  if (pw.length < 12) return "use at least 12 characters";
  if (pw.length > 256) return "use at most 256 characters";
  if (username && pw.toLowerCase().includes(username.toLowerCase())) return "don't include the username";
  if (new Set(pw).size < 5) return "use more different characters";
  return undefined;
}

// ---- TOTP ----

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32(buf: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function unbase32(s: string): Buffer {
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const c of s.replace(/=+$/, "").toUpperCase()) {
    const i = B32.indexOf(c);
    if (i < 0) continue;
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const newTotpSecret = () => base32(randomBytes(20));

/** The 6-digit code for a 30 s time step. */
export function totpCode(secret: string, step = Math.floor(Date.now() / 30_000)): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", unbase32(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, "0");
}

/**
 * The time step a code matches (allowing one step of clock drift either way), or undefined. Steps at or
 * before `lastStep` are refused, so a code can't be replayed.
 */
export function totpMatch(secret: string, code: string, lastStep = -1): number | undefined {
  const c = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return undefined;
  const now = Math.floor(Date.now() / 30_000);
  for (const step of [now, now - 1, now + 1]) {
    if (step <= lastStep) continue;
    const want = Buffer.from(totpCode(secret, step));
    if (timingSafeEqual(want, Buffer.from(c))) return step;
  }
  return undefined;
}

export const otpauthUri = (secret: string, account: string, issuer: string) =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
