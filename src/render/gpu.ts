/**
 * GPU renders: the WebGPU path tracer (viewer/gpu/pathtracer.js) driven from Node through Dawn (the optional
 * `webgpu` package): Metal on a Mac, Vulkan on Linux (an NVIDIA card in Docker needs the NVIDIA container runtime
 * with the graphics capability), D3D12 on Windows. Global illumination, sun and sky for Kuwait at a given date and
 * time, daylight through glass, the lighting design's lamps in candela, texture and normal maps, denoising.
 */
import { existsSync, readdirSync } from "node:fs";
import type { Compiled } from "../pipeline.js";
import { walkMeshes, type SceneNode } from "../geometry/scene.js";
import { m4, type Vec3 } from "../geometry/math.js";
import { collectLights } from "../elements/lighting.js";
import type { MaterialDef, TextureSet } from "../materials/types.js";
import { encodePNG, type Camera, type MaterialLookup } from "./raster.js";
import { prepareView, type ViewOptions } from "./view.js";
import { findRoom } from "./interior.js";
import { oidnBinary, oidnDenoise } from "./oidn.js";
import { pointInPolygon, pointSegment } from "../geometry/math.js";
import { PathTracer, tonemap, type PTScene } from "../../viewer/gpu/pathtracer.js";

const KUWAIT = { lat: 29.37, lon: 47.98, utc: 3 };

let tracer: Promise<PathTracer> | undefined;
/** Held for the life of the process: Dawn frees an unreferenced instance under a live device. */
let instance: unknown;

/** The process's path tracer (one GPU device, reused); rejects when there is no usable GPU. */
export function gpuTracer(): Promise<PathTracer> {
  if (process.env.ARCHITECTURER_GPU === "off") return Promise.reject(new Error("ARCHITECTURER_GPU=off"));
  tracer ??= (async () => {
    let wg: { create: (o: string[]) => unknown; globals: Record<string, unknown> };
    try {
      wg = (await import("webgpu" as string)) as never;
    } catch {
      throw new Error("the webgpu package (Dawn) is not installed");
    }
    Object.assign(globalThis, wg.globals);
    instance = wg.create([]);
    const pt = await PathTracer.create(instance);
    if (!pt) throw new Error(`no GPU adapter${gpuHint()}`);
    return pt;
  })();
  tracer.catch(() => (tracer = undefined));
  return tracer;
}

/** Why there is no adapter, in a container: which of device / driver / Vulkan ICD is missing. */
function gpuHint(): string {
  if (process.platform !== "linux") return "";
  const dev = existsSync("/dev/nvidiactl");
  const libDirs = ["/usr/lib/x86_64-linux-gnu", "/usr/lib/aarch64-linux-gnu", "/usr/lib64", "/usr/lib"];
  const driver = libDirs.some((d) => existsSync(`${d}/libGLX_nvidia.so.0`));
  const icds = ["/etc/vulkan/icd.d", "/usr/share/vulkan/icd.d"].flatMap((d) => (existsSync(d) ? readdirSync(d).map((f) => `${d}/${f}`) : []));
  if (!dev) return ": the container sees no NVIDIA device — add --runtime=nvidia and NVIDIA_VISIBLE_DEVICES=all";
  if (!driver) return ": an NVIDIA device is visible but not its Vulkan driver (libGLX_nvidia) — set NVIDIA_DRIVER_CAPABILITIES=all (it must include graphics)";
  if (!icds.length) return ": NVIDIA driver present but no Vulkan ICD file";
  return `: NVIDIA device and driver present (ICDs: ${icds.join(", ")}) but Vulkan reported no adapter — check the host driver supports Vulkan`;
}

/** Describe the GPU for logs and the health check. */
export async function gpuInfo(): Promise<string | null> {
  try {
    const pt = await gpuTracer();
    const i = pt.adapterInfo;
    return [i.vendor, i.architecture, i.device, i.description].filter(Boolean).join(" ") || "GPU";
  } catch {
    return null;
  }
}

const srgb2lin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/** Flatten a scene: world-space triangles, per-corner normals / UVs, tangents, materials and texture layers. */
export function buildScene(root: SceneNode, lookup: MaterialLookup, texSize: number, lightsOn: boolean, portalFilter?: (p: Vec3, n: Vec3) => boolean): PTScene {
  let n = 0;
  walkMeshes(root, (m) => (n += m.indices.length / 3));
  const tris = new Float32Array(n * 9), attrs = new Float32Array(n * 20), triMat = new Uint32Array(n);
  const matIndex = new Map<string, number>();
  const mats: number[] = [];
  const baseLayers: Uint8Array[] = [], normalLayers: Uint8Array[] = [];
  const layerOf = new Map<Uint8Array, number>();
  const layer = (data: Uint8Array | undefined, list: Uint8Array[], size: number): number => {
    if (!data || size !== texSize) return -1;
    let l = layerOf.get(data);
    if (l === undefined) {
      l = list.length;
      list.push(data);
      layerOf.set(data, l);
    }
    return l;
  };
  const material = (name: string): number => {
    let i = matIndex.get(name);
    if (i !== undefined) return i;
    let def: MaterialDef | undefined, tex: TextureSet | undefined;
    try {
      ({ def, tex } = lookup(name));
    } catch {
      def = undefined;
    }
    const d = def ?? ({ color: [1, 0, 1], roughness: 0.8, metalness: 0, scale: 1, opacity: 1, normalStrength: 1 } as unknown as MaterialDef);
    const base = tex ? layer(tex.baseColor, baseLayers, tex.size) : -1;
    const nrm = tex && d.normalStrength > 0 ? layer(tex.normal, normalLayers, tex.size) : -1;
    const e = d.emissive ?? [0, 0, 0];
    i = mats.length / 16;
    mats.push(
      srgb2lin(d.color[0]), srgb2lin(d.color[1]), srgb2lin(d.color[2]), d.opacity,
      d.roughness, d.metalness, base, texSize / Math.max(0.05, d.scale),
      srgb2lin(e[0]) * (lightsOn ? 1 : 0.15), srgb2lin(e[1]) * (lightsOn ? 1 : 0.15), srgb2lin(e[2]) * (lightsOn ? 1 : 0.15), d.alphaCutoff ?? 0,
      nrm, Math.min(2, d.normalStrength ?? 1), d.doubleSided ? 1 : 0, 0,
    );
    matIndex.set(name, i);
    return i;
  };
  let t = 0;
  const portalTris: number[] = [];
  walkMeshes(root, (m, node, world) => {
    const mi = material(m.material);
    const glass = mats[mi * 16 + 3] < 0.99 && (node.kind === "opening" || node.kind === "door_leaf");
    const P = m.positions, N = m.normals, U = m.uvs;
    const wp = (k: number): Vec3 => m4.point(world, [P[k * 3], P[k * 3 + 1], P[k * 3 + 2]]);
    const o = m4.point(world, [0, 0, 0]);
    const wn = (k: number): Vec3 => {
      const q = m4.point(world, [N[k * 3] ?? 0, N[k * 3 + 1] ?? 0, N[k * 3 + 2] ?? 1]);
      return [q[0] - o[0], q[1] - o[1], q[2] - o[2]];
    };
    for (let f = 0; f < m.indices.length; f += 3, t++) {
      const ids = [m.indices[f], m.indices[f + 1], m.indices[f + 2]];
      const p = ids.map(wp), nn = ids.map(wn);
      const uv = ids.map((k) => [U[k * 2] ?? 0, U[k * 2 + 1] ?? 0]);
      for (let c = 0; c < 3; c++) tris.set(p[c], t * 9 + c * 3);
      const a = t * 20;
      attrs.set([...nn[0], uv[0][0], ...nn[1], uv[0][1], ...nn[2], uv[1][0]], a);
      // tangent from the UV gradient (flat per triangle)
      const e1 = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]], e2 = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
      const du1 = uv[1][0] - uv[0][0], dv1 = uv[1][1] - uv[0][1], du2 = uv[2][0] - uv[0][0], dv2 = uv[2][1] - uv[0][1];
      const det = du1 * dv2 - du2 * dv1;
      const r = Math.abs(det) > 1e-12 ? 1 / det : 0;
      const T = [0, 1, 2].map((k) => (e1[k] * dv2 - e2[k] * dv1) * r);
      const B = [0, 1, 2].map((k) => (e2[k] * du1 - e1[k] * du2) * r);
      const n0 = nn[0];
      const cx = [n0[1] * T[2] - n0[2] * T[1], n0[2] * T[0] - n0[0] * T[2], n0[0] * T[1] - n0[1] * T[0]];
      const sign = cx[0] * B[0] + cx[1] * B[1] + cx[2] * B[2] < 0 ? -1 : 1;
      attrs.set([uv[1][1], uv[2][0], uv[2][1], sign, T[0], T[1], T[2], 0], a + 12);
      triMat[t] = mi;
      if (glass && portalFilter) {
        const fn = norm(cross([p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]], [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]]));
        if (portalFilter([(p[0][0] + p[1][0] + p[2][0]) / 3, (p[0][1] + p[1][1] + p[2][1]) / 3, (p[0][2] + p[1][2] + p[2][2]) / 3], fn)) portalTris.push(t);
      }
    }
  });
  // window panes (both faces' worth of a pane is one triangle pair): portals for the sky
  const portals = new Float32Array(portalTris.length * 12);
  let portalArea = 0;
  const areas = portalTris.map((ti) => {
    const q = tris.subarray(ti * 9, ti * 9 + 9);
    const e1 = [q[3] - q[0], q[4] - q[1], q[5] - q[2]], e2 = [q[6] - q[0], q[7] - q[1], q[8] - q[2]];
    return Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]) / 2;
  });
  portalArea = areas.reduce((a, b) => a + b, 0);
  let cum = 0;
  portalTris.forEach((ti, k) => {
    const q = tris.subarray(ti * 9, ti * 9 + 9);
    cum += areas[k];
    portals.set([q[0], q[1], q[2], cum / Math.max(portalArea, 1e-9), q[3] - q[0], q[4] - q[1], q[5] - q[2], areas[k], q[6] - q[0], q[7] - q[1], q[8] - q[2], 0], k * 12);
  });
  const lights: number[] = [];
  if (lightsOn)
    for (const L of collectLights(root)) {
      const s = L.intensity;
      lights.push(
        L.position[0], L.position[1], L.position[2], L.type === "spot" ? 1 : 0,
        L.color[0] * s, L.color[1] * s, L.color[2] * s, 0.04,
        L.worldDirection[0], L.worldDirection[1], L.worldDirection[2], Math.cos(L.outerConeAngle ?? Math.PI / 4),
        Math.cos(L.innerConeAngle ?? 0), 0, 0, 0,
      );
    }
  return { tris, attrs, triMat, materials: new Float32Array(mats), lights: new Float32Array(lights), texSize, baseLayers, normalLayers, portals, portalArea };
}

/** Sun direction (plan: x east, y north, z up) and elevation for Kuwait at a local date and time. */
export function sunPosition(date = "03-21", time = "10:30", where = KUWAIT): { dir: Vec3; elevation: number } {
  const [mo, da] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const doy = Math.round([0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334][(mo || 3) - 1] + (da || 21));
  const decl = ((23.44 * Math.PI) / 180) * Math.sin(((2 * Math.PI) / 365) * (284 + doy));
  const B = ((2 * Math.PI) / 364) * (doy - 81);
  const eot = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B);
  const solar = (hh || 0) + (mm || 0) / 60 + (4 * (where.lon - 15 * where.utc) + eot) / 60;
  const H = ((15 * (solar - 12)) * Math.PI) / 180;
  const lat = (where.lat * Math.PI) / 180;
  const sinA = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(H);
  const alt = Math.asin(Math.max(-1, Math.min(1, sinA)));
  let az = Math.acos(Math.max(-1, Math.min(1, (Math.sin(decl) - sinA * Math.sin(lat)) / (Math.cos(alt) * Math.cos(lat) + 1e-9))));
  if (H > 0) az = 2 * Math.PI - az;
  return { dir: [Math.sin(az) * Math.cos(alt), Math.cos(az) * Math.cos(alt), sinA], elevation: (alt * 180) / Math.PI };
}

/**
 * Preetham et al. (1999) daylight sky for a sun direction and turbidity (Kuwait: hazy, ~3.5): Perez coefficients
 * for Y, x, y, the zenith xyY (Y in cd/m²) and each channel's F(0, θs), packed for the path tracer's uniforms.
 */
export function preethamSky(sunDir: Vec3, T = 3.5): number[] | undefined {
  const ts = Math.acos(Math.max(-1, Math.min(1, sunDir[2])));
  if (sunDir[2] < 0.02) return undefined;
  const Y = [0.1787 * T - 1.463, -0.3554 * T + 0.4275, -0.0227 * T + 5.3251, 0.1206 * T - 2.5771, -0.067 * T + 0.3703];
  const x = [-0.0193 * T - 0.2592, -0.0665 * T + 0.0008, -0.0004 * T + 0.2125, -0.0641 * T - 0.8989, -0.0033 * T + 0.0452];
  const y = [-0.0167 * T - 0.2608, -0.095 * T + 0.0092, -0.0079 * T + 0.2102, -0.0441 * T - 1.6537, -0.0109 * T + 0.0529];
  const chi = (4 / 9 - T / 120) * (Math.PI - 2 * ts);
  const Yz = ((4.0453 * T - 4.971) * Math.tan(chi) - 0.2155 * T + 2.4192) * 1000;
  const t2 = ts * ts, t3 = t2 * ts;
  const xz = T * T * (0.00166 * t3 - 0.00375 * t2 + 0.00209 * ts) + T * (-0.02903 * t3 + 0.06377 * t2 - 0.03202 * ts + 0.00394) + (0.11693 * t3 - 0.21196 * t2 + 0.06052 * ts + 0.25886);
  const yz = T * T * (0.00275 * t3 - 0.0061 * t2 + 0.00317 * ts) + T * (-0.04214 * t3 + 0.0897 * t2 - 0.04153 * ts + 0.00516) + (0.15346 * t3 - 0.26756 * t2 + 0.0667 * ts + 0.26688);
  const F = (c: number[]) => (1 + c[0] * Math.exp(c[1])) * (1 + c[2] * Math.exp(c[3] * ts) + c[4] * Math.cos(ts) ** 2);
  return [...Y.slice(0, 4), ...x.slice(0, 4), ...y.slice(0, 4), Y[4], x[4], y[4], T, Math.max(Yz, 0), xz, yz, 1, F(Y), F(x), F(y), 1];
}

/** Local time of sunset (HH:MM) for a date, Kuwait. */
export function sunset(date = "03-21"): string {
  let lo = 15 * 60, hi = 21 * 60;
  const el = (m: number) => sunPosition(date, `${Math.floor(m / 60)}:${String(Math.round(m % 60)).padStart(2, "0")}`).elevation;
  for (let k = 0; k < 20; k++) {
    const mid = (lo + hi) / 2;
    if (el(mid) > 0) lo = mid;
    else hi = mid;
  }
  return `${Math.floor(lo / 60)}:${String(Math.round(lo % 60)).padStart(2, "0")}`;
}

/** Sun illuminance and sky radiance for a sun elevation (hazy Gulf air). */
export function skyFor(sunDir: Vec3) {
  const s = sunDir[2];
  const altDeg = (Math.asin(Math.max(-1, Math.min(1, s))) * 180) / Math.PI;
  const airmass = s > 0 ? 1 / (s + 0.50572 * Math.pow(altDeg + 6.07995, -1.6364)) : 40;
  const tau = [0.11, 0.19, 0.34];
  const T = tau.map((k) => Math.exp(-k * airmass));
  const up = Math.max(0, s + 0.05);
  const E = s > -0.02 ? T.map((x) => 118000 * x * Math.min(1, up * 8)) : [0, 0, 0];
  const k = 8500 * Math.pow(Math.min(1, up), 0.75) + 0.02;
  const warm = T.map((x) => 0.55 + 0.45 * x / Math.max(T[0], 1e-6));
  const zenith = [0.26, 0.42, 0.82].map((c) => c * k);
  const horizon = [0.88, 0.86, 0.82].map((c, i) => c * k * 1.05 * warm[i]);
  const night = s < -0.1;
  return {
    sun: { dir: sunDir, E, cos: Math.cos(0.0047 * 1.5) },
    sky: {
      preetham: preethamSky(sunDir),
      zenith: night ? [0.0015, 0.002, 0.004] : zenith,
      horizon: night ? [0.004, 0.004, 0.006] : horizon,
      ground: (night ? [0.001, 0.001, 0.001] : [0.36, 0.31, 0.24].map((c) => (c * (E[1] * Math.max(s, 0) + Math.PI * k)) / Math.PI)),
    },
  };
}

function cameraBasis(c: Camera) {
  const f = norm([c.target[0] - c.eye[0], c.target[1] - c.eye[1], c.target[2] - c.eye[2]]);
  let up = c.up ?? [0, 0, 1];
  let r = cross(f, up);
  if (Math.hypot(...r) < 1e-6) {
    up = Math.abs(f[1]) < 0.9 ? [0, 1, 0] : [0, 0, 1];
    r = cross(f, up);
  }
  r = norm(r);
  const u = cross(r, f);
  return { eye: c.eye, right: r, up: u, fwd: f, tanHalf: Math.tan(((c.fov ?? 45) * Math.PI) / 360), ortho: c.ortho && c.ortho > 0 ? c.ortho : 0, shift: c.shift ?? 0 };
}
const cross = (a: number[], b: number[]): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: number[]): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

const uploaded = { key: "" };
const ids = new WeakMap<object, number>();
let nextId = 1;

/** Path-traced PNG of a view. */
export async function gpuRender(c: Compiled, o: ViewOptions = {}): Promise<{ png: Buffer; renderer: string; note?: string }> {
  const pt = await gpuTracer();
  const v = prepareView(c, { ...o, textureSize: o.textureSize ?? 512 });
  const mode = o.lighting ?? "day";
  const lightsOn = mode !== "day";
  const date = o.date ?? "03-21";
  // golden hour: 45 minutes before sunset, lamps on
  const golden = (() => {
    const [h, m] = sunset(date).split(":").map(Number);
    const t = h * 60 + m - 45;
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
  })();
  const time = o.time ?? (mode === "night" ? "21:00" : mode === "dusk" ? "17:45" : mode === "golden" ? golden : "10:30");
  const sp = sunPosition(date, time);
  const env = skyFor(sp.dir);
  // one scene on the GPU at a time: re-upload only when the plan, the cut or the lamps change
  if (!ids.has(c)) ids.set(c, nextId++);
  // interior shots: that room's own window panes are the portals for the sky
  const room = o.interior?.room ? findRoom(c, o.interior.room) : undefined;
  const rc = room ? room.polygon.reduce((a, p) => [a[0] + p[0] / room.polygon.length, a[1] + p[1] / room.polygon.length], [0, 0]) : [0, 0];
  const portalFilter = room
    ? (q: Vec3, n: Vec3) => {
        const L = c.levels[room.li];
        if (q[2] < L.elevation - 0.1 || q[2] > L.elevation + L.height + 0.1) return false;
        const pg = room.polygon;
        if (!pointInPolygon([q[0], q[1]], pg) && !pg.some((a, k) => pointSegment([q[0], q[1]], a, pg[(k + 1) % pg.length]).dist < 0.5)) return false;
        // the pane itself, not the thin edges of a glass box
        const d = norm([rc[0] - q[0], rc[1] - q[1], 0]);
        return Math.abs(n[0] * d[0] + n[1] * d[1]) > 0.5;
      }
    : undefined;
  const key = `${ids.get(c)}|${v.root.children.length}|${v.texSize}|${lightsOn}|${room ? `${room.li}:${room.room.name}` : ""}`;
  if (uploaded.key !== key || !pt.scene) {
    pt.setScene(buildScene(v.root, v.lookup, v.texSize, lightsOn, portalFilter));
    uploaded.key = key;
  }
  const W = v.opts.width, H = v.opts.height;
  const t0 = Date.now();
  const spp = Math.max(4, Math.min(4096, o.samples ?? 128));
  const opts = {
    width: W,
    height: H,
    camera: cameraBasis(v.camera),
    spp,
    maxBounce: o.interior ? 6 : 5,
    clipZ: v.opts.clipZ,
    sun: env.sun,
    sky: env.sky,
    emitScale: 1500,
    denoise: o.denoise,
    // aiming at the windows only pays off inside
    portals: !!room && !process.env.PT_NO_PORTALS,
    debug: Number(process.env.PT_DEBUG_VIEW ?? 0),
  };
  // the AI denoiser when it is installed (raw image + guides), else the built-in one
  const useOidn = o.denoise !== false && !process.env.PT_NO_OIDN && !!oidnBinary();
  let hdr = await pt.render({ ...opts, aov: useOidn });
  let denoiser = o.denoise === false ? "no denoiser" : "à-trous denoiser";
  if (useOidn) {
    const g = hdr as Float32Array & { albedo: Float32Array; normal: Float32Array };
    const r = await oidnDenoise(g, g.albedo, g.normal, W, H);
    if (r) {
      hdr = r.image;
      denoiser = `OIDN${r.device ? ` (${r.device})` : ""}`;
    } else hdr = await pt.render(opts);
  }
  // night and dusk keep their mood: expose a little under the average
  const ev = (o.exposure ?? 0) + (mode === "night" ? -1.3 : mode === "dusk" ? -0.6 : mode === "golden" ? -0.2 : 0);
  const img = tonemap(hdr, W, H, ev, { bloom: mode === "day" ? 0.04 : 0.08, vignette: 0.18, warmth: mode === "golden" ? 0.25 : 0 });
  const i = pt.adapterInfo;
  const gpuName = [i.vendor, i.architecture, i.description].filter(Boolean).join(" ") || "GPU";
  return {
    png: encodePNG({ width: W, height: H, rgba: img.rgba }),
    renderer: `gpu path tracer (${gpuName}), ${spp} spp, ${denoiser}, ${pt.scene!.triangles} triangles, ${((Date.now() - t0) / 1000).toFixed(1)} s; sun ${sp.elevation.toFixed(0)}° at ${time}`,
  };
}
