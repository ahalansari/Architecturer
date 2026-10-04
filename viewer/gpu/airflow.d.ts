// Types for the shared GPU airflow solver (viewer/gpu/airflow.js).
export class AirflowSolver {
  constructor(device: unknown);
  setup(grid: { nx: number; ny: number; nz: number; dx: number }, kind: Uint32Array, src: Float32Array, t0: number): void;
  run(o?: { seconds?: number; dt?: number; jacobi?: number; tref?: number; beta?: number; nu?: number; onProgress?: (done: number, total: number) => void; signal?: AbortSignal }): Promise<void>;
  read(): Promise<Float32Array>;
  destroy(): void;
}
