/** Worker thread for WorkerPool: runs one job at a time and keeps its asset caches warm between jobs. */
import { parentPort, workerData } from "node:worker_threads";
import { setSandbox } from "../sandbox.js";
import { runJob, type JobRequest } from "./jobs.js";

const data = workerData as { sandbox?: Parameters<typeof setSandbox>[0] } | undefined;
setSandbox(data?.sandbox);

parentPort!.on("message", async (req: JobRequest) => {
  try {
    parentPort!.postMessage({ result: await runJob(req) });
  } catch (e) {
    parentPort!.postMessage({ error: (e as Error).message });
  }
});
