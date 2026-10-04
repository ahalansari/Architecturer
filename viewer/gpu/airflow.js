// Indoor airflow on the GPU: incompressible "stable fluids" on a voxel grid of one floor, with buoyancy.
// Cells: 0 air, 1 solid (walls, outside, above the ceiling), 2 supply (fixed velocity and temperature),
// 3 return (pressure 0, the air leaves). Each step: advect velocity + temperature (semi-Lagrangian, solids
// excluded from the interpolation), buoyancy and heat sources, divergence, Jacobi pressure solve (warm-started),
// projection. Units: m, s, m/s, °C. Plain JS shared by the server (Dawn) and the browser.

const WG = 4;
const HEAT_SUBSTEPS = 4;

// upwind finite-volume temperature step (advective form): heat only crosses faces between air cells, so walls
// neither absorb nor create it; supplies hold their temperature; returns follow the air reaching them
const heatStep = (name, from, to) => /* wgsl */ `
@compute @workgroup_size(${WG}, ${WG}, ${WG})
fn ${name}(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= P.nx || g.y >= P.ny || g.z >= P.nz) { return; }
  let c = vec3i(g); let i = idx(c.x, c.y, c.z);
  let k = kind[i];
  let me = ${from}[i];
  if (k == 1u) { ${to}[i] = me; return; }
  if (k == 2u) { ${to}[i] = vec4f(me.xyz, src[i].w); return; }
  let h = P.dt / f32(${HEAT_SUBSTEPS});
  var dT = 0.0;
  for (var f = 0; f < 6; f++) {
    let ax = f / 2; let sg = select(-1, 1, (f & 1) == 0);
    var o = vec3i(0); o[ax] = sg;
    let nb = c + o;
    let kn = kindAt(nb.x, nb.y, nb.z);
    if (kn == 1u) { continue; }
    let other = ${from}[idx(nb.x, nb.y, nb.z)];
    let uf = 0.5 * (me[ax] + other[ax]) * f32(sg); // outward face velocity
    if (uf < 0.0) { dT += -uf * (other.w - me.w); }
  }
  var t = me.w + h / P.dx * dT;
  if (k == 0u) { t += h * src[i].w; }
  ${to}[i] = vec4f(me.xyz, t);
}
`;

const CODE = /* wgsl */ `
struct Params { nx: u32, ny: u32, nz: u32, n: u32, dx: f32, dt: f32, beta: f32, tref: f32, nu: f32, p0: f32, p1: f32, p2: f32 };
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> kind: array<u32>;
@group(0) @binding(2) var<storage, read_write> velA: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> velB: array<vec4f>;
@group(0) @binding(4) var<storage, read> src: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> dv: array<f32>;
@group(0) @binding(6) var<storage, read> pIn: array<f32>;
@group(0) @binding(7) var<storage, read_write> pOut: array<f32>;
@group(0) @binding(8) var<storage, read_write> velC: array<vec4f>;

fn idx(x: i32, y: i32, z: i32) -> u32 { return (u32(z) * P.ny + u32(y)) * P.nx + u32(x); }
fn inside(x: i32, y: i32, z: i32) -> bool { return x >= 0 && y >= 0 && z >= 0 && x < i32(P.nx) && y < i32(P.ny) && z < i32(P.nz); }
fn kindAt(x: i32, y: i32, z: i32) -> u32 { if (!inside(x, y, z)) { return 1u; } return kind[idx(x, y, z)]; }
fn cell(g: vec3u) -> vec3i { return vec3i(g); }

// trilinear samples at a cell-space position; solids give zero velocity and no temperature weight
fn sampleB(p: vec3f, keepT: f32) -> vec4f {
  let q = clamp(p, vec3f(0.0), vec3f(f32(P.nx) - 1.001, f32(P.ny) - 1.001, f32(P.nz) - 1.001));
  let b = vec3i(floor(q)); let f = q - floor(q);
  var v = vec3f(0.0); var t = 0.0; var wt = 0.0;
  for (var k = 0; k < 8; k++) {
    let o = vec3i(k & 1, (k >> 1) & 1, (k >> 2) & 1);
    let c = b + o;
    let w = select(1.0 - f.x, f.x, o.x == 1) * select(1.0 - f.y, f.y, o.y == 1) * select(1.0 - f.z, f.z, o.z == 1);
    if (kindAt(c.x, c.y, c.z) == 1u) { continue; }
    let s = velB[idx(c.x, c.y, c.z)];
    v += s.xyz * w; t += s.w * w; wt += w;
  }
  return vec4f(v, select(keepT, t / wt, wt > 1e-6));
}
fn sample(p: vec3f, keepT: f32) -> vec4f {
  let q = clamp(p, vec3f(0.0), vec3f(f32(P.nx) - 1.001, f32(P.ny) - 1.001, f32(P.nz) - 1.001));
  let b = vec3i(floor(q)); let f = q - floor(q);
  var v = vec3f(0.0); var t = 0.0; var wt = 0.0;
  for (var k = 0; k < 8; k++) {
    let o = vec3i(k & 1, (k >> 1) & 1, (k >> 2) & 1);
    let c = b + o;
    let w = select(1.0 - f.x, f.x, o.x == 1) * select(1.0 - f.y, f.y, o.y == 1) * select(1.0 - f.z, f.z, o.z == 1);
    if (kindAt(c.x, c.y, c.z) == 1u) { continue; }
    let s = velA[idx(c.x, c.y, c.z)];
    v += s.xyz * w; t += s.w * w; wt += w;
  }
  return vec4f(v, select(keepT, t / wt, wt > 1e-6));
}

// MacCormack advection: forward, backward, then correct the forward step by half the round-trip error,
// limited to the values it was interpolated from (keeps jets sharp without overshoot)
@compute @workgroup_size(${WG}, ${WG}, ${WG})
fn advect(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= P.nx || g.y >= P.ny || g.z >= P.nz) { return; }
  let c = cell(g); let i = idx(c.x, c.y, c.z);
  let k = kind[i];
  var s = velA[i];
  if (k == 0u || k == 3u) { s = sample(vec3f(c) - s.xyz * (P.dt / P.dx), s.w); }
  velB[i] = s;
}

@compute @workgroup_size(${WG}, ${WG}, ${WG})
fn advectBack(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= P.nx || g.y >= P.ny || g.z >= P.nz) { return; }
  let c = cell(g); let i = idx(c.x, c.y, c.z);
  let k = kind[i];
  var s = velB[i];
  if (k == 0u || k == 3u) { s = sampleB(vec3f(c) + velA[i].xyz * (P.dt / P.dx), s.w); }
  velC[i] = s;
}

@compute @workgroup_size(${WG}, ${WG}, ${WG})
fn correct(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= P.nx || g.y >= P.ny || g.z >= P.nz) { return; }
  let c = cell(g); let i = idx(c.x, c.y, c.z);
  let k = kind[i];
  let a = velA[i];
  var s = velB[i];
  if (k == 0u || k == 3u) {
    var r = s + 0.5 * (a - velC[i]);
    // limiter: the range of the cells the forward step read
    let q = clamp(vec3f(c) - a.xyz * (P.dt / P.dx), vec3f(0.0), vec3f(f32(P.nx) - 1.001, f32(P.ny) - 1.001, f32(P.nz) - 1.001));
    let b = vec3i(floor(q));
    var lo = vec4f(1e9); var hi = vec4f(-1e9); var found = false;
    for (var n = 0; n < 8; n++) {
      let cc = b + vec3i(n & 1, (n >> 1) & 1, (n >> 2) & 1);
      if (kindAt(cc.x, cc.y, cc.z) == 1u) { continue; }
      let v = velA[idx(cc.x, cc.y, cc.z)];
      lo = min(lo, v); hi = max(hi, v); found = true;
    }
    // outside the range it came from: fall back to the first-order value (Selle et al. 2008)
    let bad = (r < lo) | (r > hi);
    r = select(r, s, bad);
    if (!found || any(r != r)) { r = s; }
    // eddy viscosity (turbulent mixing), no-slip at walls
    var lap = vec3f(0.0);
    for (var f = 0; f < 6; f++) {
      var o = vec3i(0); o[f / 2] = select(-1, 1, (f & 1) == 0);
      let nb = c + o;
      let kn = kindAt(nb.x, nb.y, nb.z);
      let un = select(velA[idx(nb.x, nb.y, nb.z)].xyz, vec3f(0.0), kn == 1u);
      lap += un - a.xyz;
    }
    r = vec4f(r.xyz + P.dt * P.nu / (P.dx * P.dx) * lap, r.w);
    // temperature is transported separately (finite volume, conserves heat); buoyancy from it
    s = vec4f(r.xyz, a.w);
    s.z += P.dt * 9.81 * P.beta * (a.w - P.tref);
  } else if (k == 2u) {
    s = src[i];
  } else {
    s = vec4f(0.0, 0.0, 0.0, a.w);
  }
  velB[i] = s;
}

fn vAt(x: i32, y: i32, z: i32, me: vec3f, axis: i32) -> f32 {
  let k = kindAt(x, y, z);
  if (k == 1u) { return -me[axis]; }
  return velB[idx(x, y, z)][axis];
}

${heatStep("heatAB", "velA", "velB")}
${heatStep("heatBA", "velB", "velA")}

@compute @workgroup_size(${WG}, ${WG}, ${WG})
fn divergence(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= P.nx || g.y >= P.ny || g.z >= P.nz) { return; }
  let c = cell(g); let i = idx(c.x, c.y, c.z);
  if (kind[i] == 1u) { dv[i] = 0.0; return; }
  let me = velB[i].xyz;
  let d = (vAt(c.x + 1, c.y, c.z, me, 0) - vAt(c.x - 1, c.y, c.z, me, 0) + vAt(c.x, c.y + 1, c.z, me, 1) - vAt(c.x, c.y - 1, c.z, me, 1) + vAt(c.x, c.y, c.z + 1, me, 2) - vAt(c.x, c.y, c.z - 1, me, 2)) / (2.0 * P.dx);
  dv[i] = d;
}

fn pAt(x: i32, y: i32, z: i32, me: f32) -> f32 {
  let k = kindAt(x, y, z);
  if (k == 1u || k == 2u) { return me; }
  if (k == 3u) { return 0.0; }
  return pIn[idx(x, y, z)];
}

@compute @workgroup_size(${WG}, ${WG}, ${WG})
fn jacobi(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= P.nx || g.y >= P.ny || g.z >= P.nz) { return; }
  let c = cell(g); let i = idx(c.x, c.y, c.z);
  let k = kind[i];
  if (k != 0u) { pOut[i] = 0.0; return; }
  let me = pIn[i];
  let s = pAt(c.x + 1, c.y, c.z, me) + pAt(c.x - 1, c.y, c.z, me) + pAt(c.x, c.y + 1, c.z, me) + pAt(c.x, c.y - 1, c.z, me) + pAt(c.x, c.y, c.z + 1, me) + pAt(c.x, c.y, c.z - 1, me);
  pOut[i] = (s - P.dx * P.dx * dv[i] / P.dt) / 6.0;
}

@compute @workgroup_size(${WG}, ${WG}, ${WG})
fn project(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= P.nx || g.y >= P.ny || g.z >= P.nz) { return; }
  let c = cell(g); let i = idx(c.x, c.y, c.z);
  let k = kind[i];
  var s = velB[i];
  if (k == 0u || k == 3u) {
    let me = pIn[i];
    let grad = vec3f(pAt(c.x + 1, c.y, c.z, me) - pAt(c.x - 1, c.y, c.z, me), pAt(c.x, c.y + 1, c.z, me) - pAt(c.x, c.y - 1, c.z, me), pAt(c.x, c.y, c.z + 1, me) - pAt(c.x, c.y, c.z - 1, me)) / (2.0 * P.dx);
    s = vec4f(s.xyz - P.dt * grad, s.w);
    // keep the solver honest in corners: cap at 6 m/s
    let sp = length(s.xyz);
    if (sp > 6.0) { s = vec4f(s.xyz * (6.0 / sp), s.w); }
  }
  velA[i] = s;
}
`;

export class AirflowSolver {
  constructor(device) {
    this.device = device;
    const d = device;
    const S = (ro) => ({ type: ro ? "read-only-storage" : "storage" });
    this.layout = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: S(true) },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: S(false) },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: S(false) },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: S(true) },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: S(false) },
        { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: S(true) },
        { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: S(false) },
        { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: S(false) },
      ],
    });
    const pl = d.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    const mod = d.createShaderModule({ code: CODE });
    this.pipes = Object.fromEntries(["advect", "advectBack", "correct", "divergence", "jacobi", "project", "heatAB", "heatBA"].map((e) => [e, d.createComputePipeline({ layout: pl, compute: { module: mod, entryPoint: e } })]));
  }

  /**
   * grid: {nx, ny, nz, dx}; kind: Uint32Array (0 air, 1 solid, 2 supply, 3 return);
   * src: Float32Array 4 per cell (supply: velocity xyz + temperature; air: w = heating rate K/s); t0: initial °C.
   */
  setup(grid, kind, src, t0) {
    const d = this.device, n = grid.nx * grid.ny * grid.nz;
    this.grid = { ...grid, n };
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    const buf = (size, usage = S) => d.createBuffer({ size: Math.max(16, size), usage });
    this.bufs?.forEach((b) => b.destroy());
    const kindB = buf(n * 4), srcB = buf(n * 16), velA = buf(n * 16, S | GPUBufferUsage.COPY_SRC), velB = buf(n * 16), velC = buf(n * 16), div = buf(n * 4), pA = buf(n * 4), pB = buf(n * 4);
    const params = d.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.bufs = [kindB, srcB, velA, velB, velC, div, pA, pB, params];
    d.queue.writeBuffer(kindB, 0, kind);
    d.queue.writeBuffer(srcB, 0, src);
    const init = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      if (kind[i] === 2) init.set(src.subarray(i * 4, i * 4 + 4), i * 4);
      else init[i * 4 + 3] = t0;
    }
    d.queue.writeBuffer(velA, 0, init);
    this.velA = velA;
    this.params = params;
    this.t0 = t0;
    const bg = (pin, pout) =>
      d.createBindGroup({
        layout: this.layout,
        entries: [params, kindB, velA, velB, srcB, div, pin, pout, velC].map((b, i) => ({ binding: i, resource: { buffer: b } })),
      });
    this.bgAB = bg(pA, pB);
    this.bgBA = bg(pB, pA);
  }

  /** Simulate `seconds` of flow; resolves when done. */
  async run({ seconds = 240, dt = 0.1, jacobi = 24, tref = this.t0, beta = 1 / 300, nu = 0.004, onProgress, signal } = {}) {
    const d = this.device, g = this.grid;
    const P = new ArrayBuffer(48), pu = new Uint32Array(P), pf = new Float32Array(P);
    pu[0] = g.nx; pu[1] = g.ny; pu[2] = g.nz; pu[3] = g.n;
    pf[4] = g.dx; pf[5] = dt; pf[6] = beta; pf[7] = tref;
    // explicit diffusion stays stable while nu·dt/dx² < 1/6
    pf[8] = Math.min(nu, (0.15 * g.dx * g.dx) / dt);
    d.queue.writeBuffer(this.params, 0, P);
    const wg = [Math.ceil(g.nx / WG), Math.ceil(g.ny / WG), Math.ceil(g.nz / WG)];
    const steps = Math.ceil(seconds / dt);
    const its = jacobi + (jacobi % 2); // even: the result lands back in pA
    const batch = 10;
    for (let s = 0; s < steps; s += batch) {
      const enc = d.createCommandEncoder();
      const pass = enc.beginComputePass();
      for (let k = 0; k < Math.min(batch, steps - s); k++) {
        const go = (pipe, bg) => {
          pass.setPipeline(this.pipes[pipe]);
          pass.setBindGroup(0, bg);
          pass.dispatchWorkgroups(wg[0], wg[1], wg[2]);
        };
        go("advect", this.bgAB);
        go("advectBack", this.bgAB);
        go("correct", this.bgAB);
        go("divergence", this.bgAB);
        for (let j = 0; j < its; j++) go("jacobi", j % 2 ? this.bgBA : this.bgAB);
        go("project", this.bgAB);
        for (let h = 0; h < HEAT_SUBSTEPS; h++) go(h % 2 ? "heatBA" : "heatAB", this.bgAB);
      }
      pass.end();
      d.queue.submit([enc.finish()]);
      await d.queue.onSubmittedWorkDone();
      onProgress?.(Math.min(steps, s + batch) * dt, seconds);
      if (signal?.aborted) break;
    }
  }

  /** The field: Float32Array, 4 per cell (u, v, w, °C). */
  async read() {
    const d = this.device, n = this.grid.n;
    const rb = d.createBuffer({ size: n * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = d.createCommandEncoder();
    enc.copyBufferToBuffer(this.velA, 0, rb, 0, n * 16);
    d.queue.submit([enc.finish()]);
    await rb.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(rb.getMappedRange().slice(0));
    rb.unmap();
    rb.destroy();
    return out;
  }

  destroy() {
    this.bufs?.forEach((b) => b.destroy());
    this.bufs = undefined;
  }
}
