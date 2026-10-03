/**
 * Getting files out of the remote server: signed, expiring download links (a chat app can show a link but
 * can't send our bearer token with it), rendered images kept for a day, and background exports.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JobResult } from "../jobs.js";
import type { ExportJob } from "../tools.js";
import type { Workspace } from "../workspace.js";

/** 'w' = a file in the project folder, 'r' = a rendered image. */
export type LinkKind = "w" | "r";

const FILE_TTL = 7 * 86400;
const RENDER_TTL = 86400;

export class Files {
  readonly renders: string;
  private jobs = new Map<string, ExportJob>();

  constructor(
    private ws: Workspace,
    private publicUrl: URL,
    stateDir: string,
    private secret: () => string,
  ) {
    this.renders = join(stateDir, "renders");
    setInterval(() => this.cleanRenders(), 3600_000).unref();
  }

  private sig(kind: LinkKind, rel: string, exp: number) {
    return createHmac("sha256", this.secret()).update(`file:${kind}:${rel}:${exp}`).digest("base64url");
  }

  link(kind: LinkKind, rel: string, ttl = kind === "r" ? RENDER_TTL : FILE_TTL): string {
    const exp = Math.floor(Date.now() / 1000) + ttl;
    const path = rel.split("/").map(encodeURIComponent).join("/");
    return new URL(`/files/${kind}/${path}?e=${exp}&s=${this.sig(kind, rel, exp)}`, this.publicUrl).href;
  }

  /** 'ok', 'expired' or 'bad' for a link's parts. */
  check(kind: LinkKind, rel: string, e: unknown, s: unknown): "ok" | "expired" | "bad" {
    const exp = Number(e);
    if (typeof s !== "string" || !Number.isInteger(exp)) return "bad";
    const want = Buffer.from(this.sig(kind, rel, exp));
    const got = Buffer.from(s);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return "bad";
    return exp < Date.now() / 1000 ? "expired" : "ok";
  }

  fileLink = (abs: string) => this.link("w", this.ws.show(abs));

  async renderLink(png: Uint8Array): Promise<string> {
    await mkdir(this.renders, { recursive: true });
    const name = `${new Date().toISOString().slice(0, 10)}-${randomBytes(9).toString("base64url")}.png`;
    await writeFile(join(this.renders, name), png);
    return this.link("r", name);
  }

  private cleanRenders() {
    if (!existsSync(this.renders)) return;
    const cutoff = Date.now() - RENDER_TTL * 1000;
    for (const f of readdirSync(this.renders)) {
      const p = join(this.renders, f);
      try {
        if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
      } catch {
        // already gone
      }
    }
  }

  // ---- background exports ----

  startExport(plan: string, out: string, run: () => Promise<JobResult>): ExportJob {
    // the same output already being built: report that job instead of starting a second one
    for (const j of this.jobs.values()) if (j.out === out && !j.finished) return j;
    const id = randomBytes(4).toString("hex");
    const job = { id, plan, out, started: new Date() } as ExportJob;
    job.promise = run().then(
      (r) => {
        job.result = r;
        job.finished = new Date();
      },
      (e: Error) => {
        job.error = e.message;
        job.finished = new Date();
      },
    );
    this.jobs.set(id, job);
    // keep the last 50
    for (const k of [...this.jobs.keys()].slice(0, Math.max(0, this.jobs.size - 50))) if (this.jobs.get(k)!.finished) this.jobs.delete(k);
    return job;
  }

  exportJobs = (): ExportJob[] => [...this.jobs.values()].reverse();

  /** An export still writing this file (the download link answers "still exporting"). */
  exporting(abs: string): ExportJob | undefined {
    for (const j of this.jobs.values()) if (j.out === abs && !j.finished) return j;
    return undefined;
  }
}
