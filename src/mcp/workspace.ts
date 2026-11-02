/**
 * Plan files as the MCP tools see them. Locally a path is any file path (relative to the project folder).
 * Remotely it is a project name inside the project folder ('house', 'clients/villa'), because a phone or a
 * hosted chat app has no idea where files live on the server, and nothing outside that folder is reachable.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, relative, resolve, sep } from "node:path";
import { confine } from "../sandbox.js";

export interface ProjectInfo {
  /** Name to pass back to the tools. */
  name: string;
  path: string;
  title?: string;
  levels: number;
  modified: Date;
}

/** Plan headers by file (path → mtime/size and what list() shows), so listing a folder of 100 MB plans stays fast. */
const listed = new Map<string, { mtime: number; size: number; info?: { title?: string; levels: number } }>();
/** Plans past this size are not listed (parsing them only to show a name would take seconds each). */
const LIST_MAX_BYTES = 1e9;

export class Workspace {
  constructor(
    readonly root: string,
    readonly remote: boolean,
  ) {}

  /** Absolute path of a plan file ('.json' is added when the name has no extension). */
  plan(p: string): string {
    const name = extname(p) ? p : `${p}.json`;
    if (this.remote && extname(name).toLowerCase() !== ".json") throw new Error(`'${p}' is not a project (projects are .json files; see list_projects)`);
    return this.resolve(name, "plan");
  }

  /**
   * Absolute path for an output file; `exts` are the allowed extensions. Remotely outputs always go to
   * exports/, so a bill or model can never overwrite a project.
   */
  output(p: string, exts: string[]): string {
    const ext = extname(p).toLowerCase();
    if (!exts.includes(ext)) throw new Error(`output must end in ${exts.join(" / ")} (got '${p}')`);
    if (!this.remote) return this.resolve(p, "output");
    const rel = p.replace(/^\/+/, "").replace(/^exports\//, "");
    return confine(join(this.root, "exports"), rel, "output");
  }

  private resolve(p: string, what: string): string {
    if (!this.remote) return resolve(this.root, p.replace(/^~(?=\/|$)/, homedir()));
    if (/^~/.test(p)) throw new Error(`${what} '${p}': use a project name or a path inside the project folder`);
    // '/house' means the project folder's house, unless it is already a full path inside the folder
    const abs = resolve(this.root, p);
    const rel = abs === this.root || abs.startsWith(this.root + sep) ? p : p.replace(/^\/+/, "");
    return confine(this.root, rel, what);
  }

  /** How a path is shown to the client: relative to the project folder remotely (no server paths leak). */
  show(abs: string): string {
    if (!this.remote) return abs;
    return relative(this.root, abs).split(sep).join("/");
  }

  /** Project name of a plan path (what list_projects returns). */
  nameOf(abs: string): string {
    return this.show(abs).replace(/\.json$/i, "");
  }

  /** Plan files (JSON with a `levels` array) up to three folders deep, newest first. */
  async list(limit = 200): Promise<ProjectInfo[]> {
    const out: ProjectInfo[] = [];
    const walk = async (dir: string, depth: number) => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (out.length >= limit || e.name.startsWith(".") || e.name === "node_modules") continue;
        const p = join(dir, e.name);
        if (e.isDirectory() && depth < 3) await walk(p, depth + 1);
        else if (e.isFile() && e.name.endsWith(".json")) {
          try {
            const st = await stat(p);
            if (st.size > LIST_MAX_BYTES) continue;
            let hit = listed.get(p);
            if (!hit || hit.mtime !== st.mtimeMs || hit.size !== st.size) {
              const j = JSON.parse(await readFile(p, "utf8"));
              hit = { mtime: st.mtimeMs, size: st.size, info: j && Array.isArray(j.levels) ? { title: typeof j.name === "string" ? j.name : undefined, levels: j.levels.length } : undefined };
              listed.set(p, hit);
            }
            if (!hit.info) continue;
            out.push({ name: this.remote ? this.nameOf(p) : relative(this.root, p).replace(/\.json$/i, ""), path: p, title: hit.info.title, levels: hit.info.levels, modified: st.mtime });
          } catch {
            // not a plan
          }
        }
      }
    };
    await walk(this.root, 0);
    return out.sort((a, b) => b.modified.getTime() - a.modified.getTime());
  }
}

/** Serialises read-modify-write edits per file, so two concurrent add_elements calls can't lose one. */
export class KeyedLock {
  private tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}
