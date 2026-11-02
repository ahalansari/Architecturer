/**
 * Big projects (hospitals, airports, campuses: millions of m²) need more memory than Node's default heap
 * (about 4 GB). Re-run the entry point with a heap sized to the machine: ARCHITECTURER_HEAP_MB, else 75% of
 * RAM (at most 32 GB). Nothing happens when the heap is already that big.
 */
import { spawn } from "node:child_process";
import { totalmem } from "node:os";
import v8 from "node:v8";

export function withHeap(entry) {
  const want = Number(process.env.ARCHITECTURER_HEAP_MB) || Math.min(32768, Math.floor((totalmem() / 1048576) * 0.75));
  const have = v8.getHeapStatistics().heap_size_limit / 1048576;
  if (process.env.ARCHITECTURER_HEAP_SET || have >= want * 0.9) return import(entry);
  const child = spawn(process.execPath, [...process.execArgv, `--max-old-space-size=${want}`, process.argv[1], ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, ARCHITECTURER_HEAP_SET: "1" },
  });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => child.kill(sig));
  child.on("exit", (code, signal) => (signal ? process.kill(process.pid, signal) : process.exit(code ?? 1)));
  child.on("error", () => import(entry)); // could not re-run: carry on with the default heap
}
