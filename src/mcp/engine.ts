/**
 * Where the heavy MCP work runs: in-process (local stdio server) or on a pool of worker threads (remote
 * HTTP server), so renders and exports never block the event loop that answers other requests.
 */
import { availableParallelism, totalmem } from "node:os";
import { Worker } from "node:worker_threads";
import { runJob, type JobRequest, type JobResult } from "./jobs.js";

export interface Engine {
  run(req: JobRequest): Promise<JobResult>;
  close(): Promise<void>;
}

export const inlineEngine: Engine = { run: runJob, close: async () => undefined };

interface Task {
  req: JobRequest;
  resolve: (r: JobResult) => void;
  reject: (e: Error) => void;
}
interface Slot {
  worker: Worker;
  task?: Task;
}

// under tsx (development) the worker is the .ts source: a tiny bootstrap registers tsx's loader first
const DEV = import.meta.url.endsWith(".ts");
const WORKER_URL = new URL(DEV ? "./worker.ts" : "./worker.js", import.meta.url);
/**
 * Heap per worker, MB: ARCHITECTURER_WORKER_HEAP_MB, else an even share of 75% of RAM (2–32 GB). Big projects
 * (a 3 million m² campus) need far more than V8's default.
 */
export function workerHeapMb(workers: number): number {
  const env = Number(process.env.ARCHITECTURER_WORKER_HEAP_MB);
  if (env > 0) return Math.floor(env);
  return Math.max(2048, Math.min(32768, Math.floor((totalmem() / 1048576) * 0.75 / Math.max(1, workers))));
}

const newWorker = (workerData: unknown, heapMb: number): Worker => {
  const resourceLimits = { maxOldGenerationSizeMb: heapMb };
  if (!DEV) return new Worker(WORKER_URL, { workerData, resourceLimits });
  const tsx = import.meta.resolve("tsx/esm/api");
  const boot = `import(${JSON.stringify(tsx)}).then((m) => { m.register(); return import(${JSON.stringify(WORKER_URL.href)}); });`;
  return new Worker(boot, { eval: true, workerData, resourceLimits });
};

export class WorkerPool implements Engine {
  private slots: Slot[] = [];
  private queue: Task[] = [];
  private closed = false;
  /** Workers that died in a row without finishing a job; past a few, stop respawning (it would loop). */
  private crashes = 0;

  constructor(
    readonly size: number,
    /** Passed to every worker (sandbox roots, cache folder). */
    private workerData: unknown,
  ) {
    for (let i = 0; i < size; i++) this.slots.push(this.spawn());
  }

  static defaultSize(): number {
    const env = Number(process.env.ARCHITECTURER_WORKERS);
    return env > 0 ? Math.floor(env) : Math.max(1, Math.min(2, availableParallelism() - 1));
  }

  /** Jobs waiting for a free worker (for health / admin pages). */
  get pending(): number {
    return this.queue.length;
  }
  get busy(): number {
    return this.slots.filter((s) => s.task).length;
  }

  private spawn(): Slot {
    const slot: Slot = { worker: newWorker(this.workerData, workerHeapMb(this.size)) };
    slot.worker.on("message", (m: { result?: JobResult; error?: string }) => {
      const t = slot.task;
      slot.task = undefined;
      this.crashes = 0;
      if (t) m.error !== undefined ? t.reject(new Error(m.error)) : t.resolve(m.result!);
      this.pump();
    });
    // a crashed worker (out of memory, native abort) fails its job and is replaced
    const replace = (why: string) => {
      const t = slot.task;
      slot.task = undefined;
      t?.reject(new Error(why));
      if (this.closed) return;
      const i = this.slots.indexOf(slot);
      if (i < 0) return;
      if (++this.crashes > 3 * this.size) {
        this.slots.splice(i, 1);
        console.error(`architecturer: ${why}; not restarting it`);
        if (!this.slots.length) for (const q of this.queue.splice(0)) q.reject(new Error(why));
        return;
      }
      this.slots[i] = this.spawn();
      this.pump();
    };
    slot.worker.on("error", (e: Error) => replace(`worker failed: ${e.message}`));
    slot.worker.on("exit", (code) => {
      if (this.slots.includes(slot)) replace(`worker exited (code ${code})`);
    });
    return slot;
  }

  private pump() {
    for (const s of this.slots) {
      if (s.task || !this.queue.length) continue;
      s.task = this.queue.shift()!;
      s.worker.postMessage(s.task.req);
    }
  }

  run(req: JobRequest): Promise<JobResult> {
    if (this.closed) return Promise.reject(new Error("server is shutting down"));
    if (!this.slots.length) return Promise.reject(new Error("no render workers are running (see the server log)"));
    return new Promise((resolve, reject) => {
      this.queue.push({ req, resolve, reject });
      this.pump();
    });
  }

  async close() {
    this.closed = true;
    for (const t of this.queue.splice(0)) t.reject(new Error("server is shutting down"));
    const slots = this.slots.splice(0);
    await Promise.all(slots.map((s) => s.worker.terminate()));
  }
}
