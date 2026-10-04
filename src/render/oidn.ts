/**
 * Intel Open Image Denoise: the AI denoiser production renderers use, run as its command-line tool on the path
 * tracer's raw HDR image with albedo and normal guides. On an NVIDIA card it runs on CUDA, on a Mac on Metal.
 * Found at ARCHITECTURER_OIDN (the oidnDenoise binary or its install folder), /opt/oidn, or
 * ~/.cache/architecturer/oidn-*; without it the path tracer's own à-trous denoiser is used.
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
let found: string | null | undefined;

/** Path of oidnDenoise, or null. */
export function oidnBinary(): string | null {
  if (found !== undefined) return found;
  const cands: string[] = [];
  const env = process.env.ARCHITECTURER_OIDN;
  if (env) cands.push(env, join(env, "bin", "oidnDenoise"));
  cands.push("/opt/oidn/bin/oidnDenoise");
  const cache = join(homedir(), ".cache", "architecturer");
  if (existsSync(cache)) for (const d of readdirSync(cache).filter((d) => d.startsWith("oidn-")).sort().reverse()) cands.push(join(cache, d, "bin", "oidnDenoise"));
  found = cands.find((p) => existsSync(p) && !p.endsWith("/")) ?? null;
  return found;
}

function pfm(data: Float32Array, W: number, H: number, stride: number): Buffer {
  const head = Buffer.from(`PF\n${W} ${H}\n-1.0\n`, "ascii");
  const body = new Float32Array(W * H * 3);
  // PFM rows run bottom to top
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const s = ((H - 1 - y) * W + x) * stride, d = (y * W + x) * 3;
      body[d] = data[s];
      body[d + 1] = data[s + 1];
      body[d + 2] = data[s + 2];
    }
  return Buffer.concat([head, Buffer.from(body.buffer)]);
}

function readPfm(buf: Buffer, W: number, H: number): Float32Array {
  // header: three lines
  let off = 0;
  for (let lines = 0; lines < 3; off++) if (buf[off] === 0x0a) lines++;
  const body = new Float32Array(buf.buffer.slice(buf.byteOffset + off, buf.byteOffset + off + W * H * 12));
  const out = new Float32Array(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const s = (y * W + x) * 3, d = ((H - 1 - y) * W + x) * 4;
      out[d] = body[s];
      out[d + 1] = body[s + 1];
      out[d + 2] = body[s + 2];
      out[d + 3] = 1;
    }
  return out;
}

/**
 * Denoise an HDR image (4 floats per pixel) with albedo and normal guides (4 floats per pixel each).
 * Resolves null when OIDN is not installed or fails.
 */
export async function oidnDenoise(color: Float32Array, albedo: Float32Array, normal: Float32Array, W: number, H: number): Promise<{ image: Float32Array; device: string } | null> {
  const bin = oidnBinary();
  if (!bin) return null;
  // OIDN on a GPU works in half precision (max 65504): bring the average to ~1 and clamp the sun disc
  let sum = 0, n = 0;
  for (let i = 0; i < W * H; i += 7) {
    const l = 0.2126 * color[i * 4] + 0.7152 * color[i * 4 + 1] + 0.0722 * color[i * 4 + 2];
    if (l > 1e-4) {
      sum += Math.log(l);
      n++;
    }
  }
  const scale = n ? Math.exp(sum / n) : 1;
  const scaled = new Float32Array(color.length);
  for (let i = 0; i < color.length; i++) scaled[i] = Math.min(color[i] / scale, 3e4);
  const dir = await mkdtemp(join(tmpdir(), "oidn-"));
  try {
    await Promise.all([
      writeFile(join(dir, "c.pfm"), pfm(scaled, W, H, 4)),
      writeFile(join(dir, "a.pfm"), pfm(albedo, W, H, 4)),
      writeFile(join(dir, "n.pfm"), pfm(normal, W, H, 4)),
    ]);
    const { stdout, stderr } = await run(bin, ["--hdr", join(dir, "c.pfm"), "--alb", join(dir, "a.pfm"), "--nrm", join(dir, "n.pfm"), "-q", "high", "-o", join(dir, "o.pfm"), "-v", "1"], { timeout: 120_000, maxBuffer: 1 << 20 });
    const dev = /Device\s*:\s*(.+)/i.exec(stdout + stderr)?.[1]?.trim() ?? "";
    const image = readPfm(await readFile(join(dir, "o.pfm")), W, H);
    let bad = 0;
    for (let i = 0; i < image.length; i++) {
      if (!Number.isFinite(image[i])) {
        image[i] = 0;
        bad++;
      } else image[i] = (i & 3) === 3 ? 1 : Math.max(0, image[i]) * scale;
    }
    if (bad > image.length / 100) return null;
    return { image, device: dev };
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
