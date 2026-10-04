// Types for the shared WebGPU path tracer (viewer/gpu/pathtracer.js), used by the server through Dawn.
export interface PTScene {
  tris: Float32Array;
  attrs: Float32Array;
  triMat: Uint32Array;
  materials: Float32Array;
  lights: Float32Array;
  texSize: number;
  baseLayers: Uint8Array[];
  normalLayers: Uint8Array[];
  /** Window glass for sky sampling: 12 floats per triangle (v0 + cumulative area share, e1 + area, e2 + 0). */
  portals?: Float32Array;
  portalArea?: number;
}
export interface PTRender {
  width: number;
  height: number;
  camera: { eye: number[]; right: number[]; up: number[]; fwd: number[]; tanHalf?: number; ortho?: number; shift?: number };
  spp?: number;
  maxBounce?: number;
  clipZ?: number;
  sun: { dir: number[]; E: number[]; cos?: number };
  sky: { zenith: number[]; horizon: number[]; ground: number[]; preetham?: number[] };
  cap?: number[];
  emitScale?: number;
  clampIndirect?: number;
  seed?: number;
  denoise?: boolean;
  debug?: number;
  /** Return the raw image with albedo / normal guides (Float32Array & {albedo, normal}) instead of denoising. */
  aov?: boolean;
  /** false: no window portals (exterior views). */
  portals?: boolean;
  denoiseIterations?: number;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}
export class PathTracer {
  constructor(device: unknown);
  static create(gpu: unknown): Promise<PathTracer | null>;
  adapterInfo: { vendor?: string; architecture?: string; device?: string; description?: string };
  scene: { triangles: number; buildMs: number } | null;
  setScene(sc: PTScene): void;
  destroyScene(): void;
  render(o: PTRender): Promise<Float32Array>;
}
export function tonemap(hdr: Float32Array, W: number, H: number, ev?: number, fx?: { bloom?: number; vignette?: number; warmth?: number }): { rgba: Uint8Array; exposure: number; avg: number };
