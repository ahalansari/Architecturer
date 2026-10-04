// WebGPU path tracer: one compute pass per sample, accumulated per pixel, then an edge-aware à-trous denoiser.
// Runs the same in the browser (navigator.gpu) and in Node (Dawn, the `webgpu` package), on whatever GPU is there.
//
// Physical units: radiance in cd/m² (nits). Sun illuminance ~100 klx, sky ~5–10 knits, lamps in candela, so
// daylight through a window and a downlight at night come out in the right proportion; exposure is automatic.
//
// Scene (built by the host from its meshes):
//   tris      Float32Array, 9 per triangle (corners, world space)
//   attrs     Float32Array, 20 per triangle: n0.xyz u0.x | n1.xyz u0.y | n2.xyz u1.x | u1.y u2.x u2.y tangentSign | t.xyz 0
//   triMat    Uint32Array, material per triangle
//   materials Float32Array, 16 per material: r g b opacity | roughness metalness baseLayer texelsPerMeter |
//             emit.rgb alphaCutoff | normalLayer normalStrength doubleSided 0
//   lights    Float32Array, 16 per light: pos.xyz type(0 point, 1 spot) | rgb·candela radius | dir.xyz cosOuter | cosInner 0 0 0
//   texSize, baseLayers: Uint8Array[] (sRGB RGBA), normalLayers: Uint8Array[] (RGBA)
import { buildBVH } from "./bvh.js";

const WG = 8;

const TRACE = /* wgsl */ `
struct Params {
  eye: vec3f, tanHalf: f32,
  right: vec3f, ortho: f32,
  up: vec3f, clipZ: f32,
  fwd: vec3f, frame: u32,
  sunDir: vec3f, sunCos: f32,
  sunE: vec3f, nLights: u32,
  skyZenith: vec3f, maxBounce: u32,
  skyHorizon: vec3f, width: u32,
  ground: vec3f, height: u32,
  capColor: vec3f, texSize: f32,
  emitScale: f32, clampIndirect: f32, seed: u32, pad: u32,
};
struct Material { color: vec4f, pbr: vec4f, emit: vec4f, extra: vec4f };
struct Light { pos: vec4f, col: vec4f, dir: vec4f, cone: vec4f };

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> nodes: array<vec4f>;
@group(0) @binding(2) var<storage, read> tris: array<vec4f>;
@group(0) @binding(3) var<storage, read> attrs: array<vec4f>;
@group(0) @binding(4) var<storage, read> mats: array<Material>;
@group(0) @binding(5) var<storage, read> lights: array<Light>;
@group(0) @binding(6) var<storage, read_write> accum: array<vec4f>;
@group(0) @binding(7) var<storage, read_write> aux: array<vec4f>;
@group(0) @binding(8) var baseTex: texture_2d_array<f32>;
@group(0) @binding(9) var normTex: texture_2d_array<f32>;
@group(0) @binding(10) var samp: sampler;

const PI = 3.14159265;
const NOHIT = 0xffffffffu;

var<private> rng: u32;
fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
// PCG: a full-period LCG step, hashed on output (iterating the hash itself falls into short cycles for
// some seeds, and those pixels repeat the same few paths every sample: black specks)
fn rnd() -> f32 {
  rng = rng * 747796405u + 2891336453u;
  let w = ((rng >> ((rng >> 28u) + 4u)) ^ rng) * 277803737u;
  return f32(((w >> 22u) ^ w) >> 8u) * (1.0 / 16777216.0);
}

struct Hit { t: f32, tri: u32, u: f32, v: f32 };

fn boxT(ro: vec3f, inv: vec3f, n: u32, tmax: f32) -> f32 {
  let a = nodes[n * 2u].xyz; let b = nodes[n * 2u + 1u].xyz;
  let t0 = (a - ro) * inv; let t1 = (b - ro) * inv;
  let lo = min(t0, t1); let hi = max(t0, t1);
  let tn = max(max(lo.x, lo.y), max(lo.z, 0.0));
  let tf = min(min(hi.x, hi.y), min(hi.z, tmax));
  return select(1e30, tn, tn <= tf);
}

fn intersect(ro: vec3f, rd: vec3f, tmax: f32) -> Hit {
  var h = Hit(tmax, NOHIT, 0.0, 0.0);
  let inv = 1.0 / select(rd, vec3f(1e-12) * sign(rd + vec3f(1e-30)), abs(rd) < vec3f(1e-12));
  var stack: array<u32, 48>;
  var sp = 0u;
  var n = 0u;
  if (boxT(ro, inv, 0u, tmax) >= 1e30) { return h; }
  loop {
    let a = nodes[n * 2u]; let b = nodes[n * 2u + 1u];
    let cnt = u32(b.w); let first = u32(a.w);
    if (cnt > 0u) {
      for (var i = first; i < first + cnt; i++) {
        let v0 = tris[i * 3u].xyz; let e1 = tris[i * 3u + 1u].xyz; let e2 = tris[i * 3u + 2u].xyz;
        let p = cross(rd, e2); let det = dot(e1, p);
        if (abs(det) < 1e-12) { continue; }
        let id = 1.0 / det; let s = ro - v0;
        let u = dot(s, p) * id;
        if (u < 0.0 || u > 1.0) { continue; }
        let q = cross(s, e1); let v = dot(rd, q) * id;
        if (v < 0.0 || u + v > 1.0) { continue; }
        let t = dot(e2, q) * id;
        if (t > 1e-4 && t < h.t) {
          if (ro.z + rd.z * t > P.clipZ) { continue; }
          h = Hit(t, i, u, v);
        }
      }
      if (sp == 0u) { break; }
      sp--; n = stack[sp];
      continue;
    }
    var c0 = first; var c1 = first + 1u;
    var d0 = boxT(ro, inv, c0, h.t); var d1 = boxT(ro, inv, c1, h.t);
    if (d1 < d0) { let tc = c0; c0 = c1; c1 = tc; let td = d0; d0 = d1; d1 = td; }
    if (d0 >= 1e30) {
      if (sp == 0u) { break; }
      sp--; n = stack[sp];
      continue;
    }
    n = c0;
    if (d1 < 1e30 && sp < 48u) { stack[sp] = c1; sp++; }
  }
  return h;
}

struct Surf { p: vec3f, n: vec3f, ng: vec3f, uv: vec2f, t: vec3f, tsign: f32, mat: u32, back: bool };

fn surface(ro: vec3f, rd: vec3f, h: Hit) -> Surf {
  let i = h.tri;
  let e1 = tris[i * 3u + 1u].xyz; let e2 = tris[i * 3u + 2u].xyz;
  let a0 = attrs[i * 5u]; let a1 = attrs[i * 5u + 1u]; let a2 = attrs[i * 5u + 2u]; let a3 = attrs[i * 5u + 3u]; let a4 = attrs[i * 5u + 4u];
  let w = 1.0 - h.u - h.v;
  var n = normalize(a0.xyz * w + a1.xyz * h.u + a2.xyz * h.v + vec3f(1e-9));
  var ng = normalize(cross(e1, e2));
  let uv = vec2f(a0.w, a1.w) * w + vec2f(a2.w, a3.x) * h.u + a3.yz * h.v;
  let back = dot(ng, rd) > 0.0;
  if (back) { ng = -ng; }
  if (dot(n, ng) < 0.0) { n = -n; }
  return Surf(ro + rd * h.t, n, ng, uv, a4.xyz, a3.w, u32(tris[i * 3u].w), back);
}

fn sky(d: vec3f, withSun: bool) -> vec3f {
  if (d.z < 0.0) { return P.ground * (1.0 - d.z * 0.3); }
  let k = pow(clamp(d.z, 0.0, 1.0), 0.45);
  var c = mix(P.skyHorizon, P.skyZenith, k);
  let cs = dot(d, P.sunDir);
  // forward-scattering glow around the sun (dusty Gulf air)
  c += (P.skyHorizon * 0.6) * pow(max(cs, 0.0), 8.0) * select(0.0, 1.0, P.sunDir.z > -0.05);
  if (withSun && cs > P.sunCos) {
    let solid = 2.0 * PI * (1.0 - P.sunCos);
    c += P.sunE / solid;
  }
  return c;
}

fn fresnel(f0: vec3f, c: f32) -> vec3f { return f0 + (vec3f(1.0) - f0) * pow(1.0 - clamp(c, 0.0, 1.0), 5.0); }
fn ggxD(nh: f32, a: f32) -> f32 { let a2 = a * a; let d = nh * nh * (a2 - 1.0) + 1.0; return a2 / (PI * d * d); }
fn smithG(nv: f32, nl: f32, a: f32) -> f32 {
  let k = a * 0.5;
  return (nv / (nv * (1.0 - k) + k)) * (nl / (nl * (1.0 - k) + k));
}
// diffuse + GGX specular, times cos
fn bsdf(n: vec3f, v: vec3f, l: vec3f, albedo: vec3f, rough: f32, metal: f32) -> vec3f {
  let nl = dot(n, l); let nv = dot(n, v);
  if (nl <= 0.0 || nv <= 0.0) { return vec3f(0.0); }
  let h = normalize(v + l);
  let a = max(rough * rough, 0.006);
  let f0 = mix(vec3f(0.04), albedo, metal);
  let F = fresnel(f0, dot(v, h));
  let spec = F * ggxD(max(dot(n, h), 0.0), a) * smithG(nv, nl, a) / max(4.0 * nv * nl, 1e-4);
  let diff = (vec3f(1.0) - F) * (1.0 - metal) * albedo / PI;
  return (diff + spec) * nl;
}

fn basis(n: vec3f) -> mat3x3f {
  let s = select(-1.0, 1.0, n.z >= 0.0);
  let a = -1.0 / (s + n.z); let b = n.x * n.y * a;
  return mat3x3f(vec3f(1.0 + s * n.x * n.x * a, s * b, -s * n.x), vec3f(b, s + n.y * n.y * a, -n.y), n);
}

// transmittance towards a light: passes glass, stops at anything else
fn shadow(p: vec3f, d: vec3f, dist: f32) -> vec3f {
  var o = p; var left = dist; var T = vec3f(1.0);
  for (var k = 0; k < 6; k++) {
    let h = intersect(o, d, left);
    if (h.tri == NOHIT) { return T; }
    let m = mats[u32(tris[h.tri * 3u].w)];
    if (dot(m.emit.rgb, m.emit.rgb) > 0.0) {
      // lamp diffusers and shades do not shadow their own lamp
    } else if (m.color.w >= 0.99) {
      if (m.emit.w <= 0.0) { return vec3f(0.0); }
      // alpha-tested cut-outs (foliage): treat as half-blocking
      T *= 0.5;
    } else {
      T *= mix(vec3f(1.0), m.color.rgb, m.color.w) * (1.0 - 0.4 * m.color.w);
    }
    o = o + d * (h.t + 1e-3); left -= h.t + 1e-3;
    if (left <= 0.0) { return T; }
  }
  return T;
}

fn lightContrib(L: Light, p: vec3f, n: vec3f, v: vec3f, albedo: vec3f, rough: f32, metal: f32, ldir: ptr<function, vec3f>, ldist: ptr<function, f32>) -> vec3f {
  let jit = (vec3f(rnd(), rnd(), rnd()) - 0.5) * L.col.w;
  let d = L.pos.xyz + jit - p;
  let dist2 = max(dot(d, d), 1e-4);
  let dist = sqrt(dist2);
  let l = d / dist;
  var I = L.col.rgb;
  if (L.pos.w > 0.5) {
    let c = dot(-l, L.dir.xyz);
    I *= smoothstep(L.dir.w, L.cone.x, c);
  }
  *ldir = l; *ldist = dist;
  return I / dist2 * bsdf(n, v, l, albedo, rough, metal);
}

@compute @workgroup_size(${WG}, ${WG})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= P.width || gid.y >= P.height) { return; }
  let pix = gid.y * P.width + gid.x;
  rng = pcg(pix ^ pcg(P.frame * 9781u + P.seed));
  let jx = rnd(); let jy = rnd();
  let sx = ((f32(gid.x) + jx) / f32(P.width)) * 2.0 - 1.0;
  let sy = 1.0 - ((f32(gid.y) + jy) / f32(P.height)) * 2.0;
  let aspect = f32(P.width) / f32(P.height);
  var ro: vec3f; var rd: vec3f;
  if (P.ortho > 0.0) {
    ro = P.eye + P.right * (sx * P.ortho * aspect) + P.up * (sy * P.ortho);
    rd = P.fwd;
  } else {
    ro = P.eye;
    rd = normalize(P.fwd + P.right * (sx * P.tanHalf * aspect) + P.up * (sy * P.tanHalf));
  }
  let spread = select(2.0 * P.tanHalf / f32(P.height), 0.0, P.ortho > 0.0);
  var thr = vec3f(1.0);
  var rad = vec3f(0.0);
  var bounce = 0u;
  var passes = 0u;
  var travelled = select(0.0, 2.0 * P.ortho / f32(P.height) * 400.0, P.ortho > 0.0);
  var specLast = true;
  var firstAlbedo = vec3f(0.0); var firstN = vec3f(0.0); var firstT = 1e6;
  loop {
    if (bounce > P.maxBounce || passes > 24u) { break; }
    passes++;
    let h = intersect(ro, rd, 1e5);
    if (h.tri == NOHIT) {
      var s = sky(rd, bounce == 0u || specLast);
      if (bounce == 0u) { firstAlbedo = vec3f(1.0); firstN = -rd; }
      var c = thr * s;
      if (bounce >= 2u) { c = min(c, vec3f(P.clampIndirect)); }
      rad += c;
      break;
    }
    let sf = surface(ro, rd, h);
    let m = mats[sf.mat];
    travelled += h.t;
    // texture level of detail from the ray footprint (pixel cone)
    let tpm = m.pbr.w;
    let lod = log2(max(1.0, travelled * max(spread, 4e-4) * tpm / max(abs(dot(sf.ng, rd)), 0.25))) + f32(bounce);
    var albedo = m.color.rgb;
    var alpha = 1.0;
    if (m.pbr.z >= 0.0) {
      let tx = textureSampleLevel(baseTex, samp, sf.uv, i32(m.pbr.z), lod);
      albedo *= tx.rgb; alpha = tx.a;
    }
    // cut-outs: carry on through
    if (alpha < m.emit.w) { ro = sf.p + rd * 1e-3; continue; }
    // the cutaway's section: a ray from the camera that lands on the inside of a cut solid
    if (bounce == 0u && sf.back && P.clipZ < 1e8 && m.extra.z < 0.5) {
      rad += thr * P.capColor * 2000.0;
      firstAlbedo = P.capColor; firstN = -rd; firstT = h.t;
      break;
    }
    var n = sf.n;
    if (m.extra.x >= 0.0) {
      let nt = textureSampleLevel(normTex, samp, sf.uv, i32(m.extra.x), lod).xyz * 2.0 - 1.0;
      let tg = normalize(sf.t - n * dot(sf.t, n) + vec3f(1e-7));
      let bt = cross(n, tg) * sf.tsign;
      var nn = normalize(tg * nt.x * m.extra.y + bt * nt.y * m.extra.y + n * max(nt.z, 0.05));
      // bumps tilt the normal at most ~35°: steeper and paths leak under the surface (dark speckles)
      let c0 = dot(nn, n);
      if (c0 < 0.82) { nn = normalize(n * 0.82 + normalize(nn - n * c0 + vec3f(1e-7)) * 0.572); }
      if (dot(nn, sf.ng) > 0.05) { n = nn; }
    }
    let v = -rd;
    // at grazing angles a bumped / interpolated normal can face away from the eye, and the surface would
    // reflect nothing at all (black specks): bend it back into view
    let nv0 = dot(n, v);
    if (nv0 < 0.05) { n = normalize(n + v * (0.05 - nv0) * 1.02); }
    if (bounce == 0u) { firstAlbedo = albedo; firstN = n; firstT = h.t; }
    // emission (lamp diffusers): seen directly or in a mirror; lamps light the room through the light list
    if (bounce == 0u || specLast) { rad += thr * m.emit.rgb * P.emitScale; }
    // glass: reflect or pass straight through (thin panes, no refraction offset)
    if (m.color.w < 0.99) {
      let F = fresnel(vec3f(0.04), abs(dot(n, v))).x;
      if (rnd() < F) {
        rd = reflect(rd, n);
        ro = sf.p + sf.ng * 1e-3;
        bounce++;
      } else {
        // passing a pane is not a bounce: what lies behind is what the pixel shows
        thr *= mix(vec3f(1.0), albedo, m.color.w) * (1.0 - 0.4 * m.color.w);
        ro = sf.p + rd * 1e-3;
      }
      specLast = true;
      continue;
    }
    let rough = clamp(m.pbr.x, 0.08, 1.0);
    let metal = m.pbr.y;
    let po = sf.p + sf.ng * 1e-3;
    var direct = vec3f(0.0);
    // sun: sample its disc
    if (P.sunDir.z > -0.02 && dot(P.sunE, P.sunE) > 0.0) {
      let bs = basis(P.sunDir);
      let r = sqrt(rnd()) * sqrt(max(0.0, 1.0 - P.sunCos * P.sunCos));
      let ph = 2.0 * PI * rnd();
      let l = normalize(bs * vec3f(r * cos(ph), r * sin(ph), 1.0));
      let f = bsdf(n, v, l, albedo, rough, metal);
      if (dot(sf.ng, l) > 0.0 && max(f.x, max(f.y, f.z)) > 0.0) { direct += P.sunE * f * shadow(po, l, 1e5); }
    }
    // lamps: pick one of a few candidates by unshadowed contribution (resampled importance sampling)
    if (P.nLights > 0u) {
      var wsum = 0.0; var pick = vec3f(0.0); var pdir = vec3f(0.0); var pdist = 0.0; var pw = 0.0;
      let M = min(8u, P.nLights);
      for (var k = 0u; k < M; k++) {
        let li = min(u32(rnd() * f32(P.nLights)), P.nLights - 1u);
        var ld: vec3f; var ds: f32;
        let c = lightContrib(lights[li], sf.p, n, v, albedo, rough, metal, &ld, &ds);
        let w = (c.x + c.y + c.z) * f32(P.nLights);
        wsum += w;
        if (w > 0.0 && rnd() * wsum < w) { pick = c; pdir = ld; pdist = ds; pw = w; }
      }
      if (pw > 0.0 && dot(sf.ng, pdir) > 0.0) {
        let wgt = wsum / f32(M) / pw * f32(P.nLights);
        direct += pick * wgt * shadow(po, pdir, max(pdist - 0.12, 0.01));
      }
    }
    var c = thr * direct;
    if (bounce >= 1u) { c = min(c, vec3f(P.clampIndirect)); }
    rad += c;
    // next direction: diffuse or specular lobe
    let f0 = mix(vec3f(0.04), albedo, metal);
    let ps = clamp(max(f0.x, max(f0.y, f0.z)) * 0.5 + metal * 0.5 + (1.0 - rough) * 0.25, 0.1, 0.9);
    var l: vec3f;
    let bs = basis(n);
    if (rnd() < ps) {
      // GGX half-vector
      let a = rough * rough;
      let u1 = rnd(); let u2 = rnd();
      let ct = sqrt((1.0 - u1) / (1.0 + (a * a - 1.0) * u1));
      let st = sqrt(1.0 - ct * ct);
      let hh = bs * vec3f(st * cos(2.0 * PI * u2), st * sin(2.0 * PI * u2), ct);
      l = reflect(-v, hh);
      specLast = rough < 0.25;
    } else {
      let r = sqrt(rnd()); let ph = 2.0 * PI * rnd();
      l = bs * vec3f(r * cos(ph), r * sin(ph), sqrt(max(0.0, 1.0 - r * r)));
      specLast = false;
    }
    // a bumped normal can send the sample under the real surface: mirror it back above
    if (dot(l, sf.ng) <= 0.0) { l = l - 2.0 * dot(l, sf.ng) * sf.ng; }
    if (dot(l, n) <= 0.0) { break; }
    // pdf of the mixture
    let hv = normalize(v + l);
    let a = max(rough * rough, 0.006);
    let pdfS = ggxD(max(dot(n, hv), 0.0), a) * max(dot(n, hv), 0.0) / max(4.0 * dot(v, hv), 1e-4);
    let pdfD = max(dot(n, l), 0.0) / PI;
    let pdf = ps * pdfS + (1.0 - ps) * pdfD;
    if (pdf < 1e-6) { break; }
    thr *= bsdf(n, v, l, albedo, rough, metal) / pdf;
    ro = po; rd = l;
    bounce++;
    if (bounce > 2u) {
      let q = clamp(max(thr.x, max(thr.y, thr.z)), 0.05, 0.95);
      if (rnd() > q) { break; }
      thr /= q;
    }
  }
  if (any(rad != rad)) { rad = vec3f(0.0); }
  // debug views: 1 = first-hit albedo, 2 = first-hit normal, 3 = number of passes
  if (P.pad == 1u) { rad = firstAlbedo * 1000.0; }
  if (P.pad == 2u) { rad = (firstN * 0.5 + 0.5) * 1000.0; }
  if (P.pad == 3u) { rad = vec3f(f32(passes) * 100.0, f32(bounce) * 100.0, 0.0); }
  // w: luminance² for the per-pixel variance the denoiser uses
  let lr = dot(rad, vec3f(0.2126, 0.7152, 0.0722));
  accum[pix] += vec4f(rad, lr * lr);
  aux[pix * 2u] += vec4f(firstAlbedo, firstT);
  aux[pix * 2u + 1u] += vec4f(firstN, 0.0);
}
`;

// À-trous wavelet denoiser on the demodulated image (lighting / albedo), guided by normal, depth and albedo.
const DENOISE = /* wgsl */ `
struct DP { width: u32, height: u32, step: u32, last: u32, sigmaL: f32, frames: f32, p0: f32, p1: f32 };
@group(0) @binding(0) var<uniform> D: DP;
@group(0) @binding(1) var<storage, read> src: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> dst: array<vec4f>;
@group(0) @binding(3) var<storage, read> aux: array<vec4f>;
fn lum(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }
@compute @workgroup_size(${WG}, ${WG})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= D.width || gid.y >= D.height) { return; }
  let i = gid.y * D.width + gid.x;
  let ap = aux[i * 2u] / D.frames; let np = normalize(aux[i * 2u + 1u].xyz + vec3f(1e-6));
  let cp = src[i].rgb;
  let lp = lum(cp);
  // noise level from the 3×3 neighbourhood (SVGF): a pixel whose samples all came out the same (often all
  // zero in dim corners) has no variance of its own but is just as noisy as its neighbours
  var vn = 0.0; var nn = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let xx = i32(gid.x) + x; let yy = i32(gid.y) + y;
      if (xx < 0 || yy < 0 || xx >= i32(D.width) || yy >= i32(D.height)) { continue; }
      vn += max(src[u32(yy) * D.width + u32(xx)].w, 0.0); nn += 1.0;
    }
  }
  let sigma = D.sigmaL * sqrt(max(vn / max(nn, 1.0), max(src[i].w, 0.0))) + 1e-4;
  var K = array<f32, 3>(0.375, 0.25, 0.0625);
  var sum = vec3f(0.0); var wsum = 0.0; var vsum = 0.0;
  for (var dy = -2; dy <= 2; dy++) {
    for (var dx = -2; dx <= 2; dx++) {
      let x = i32(gid.x) + dx * i32(D.step); let y = i32(gid.y) + dy * i32(D.step);
      if (x < 0 || y < 0 || x >= i32(D.width) || y >= i32(D.height)) { continue; }
      let j = u32(y) * D.width + u32(x);
      let aq = aux[j * 2u] / D.frames; let nq = normalize(aux[j * 2u + 1u].xyz + vec3f(1e-6));
      let cq = src[j].rgb;
      let wn = pow(max(dot(np, nq), 0.0), 64.0);
      let wz = exp(-abs(ap.w - aq.w) / (0.03 * max(ap.w, 0.1) * f32(D.step) + 1e-3));
      let wa = exp(-dot(ap.rgb - aq.rgb, ap.rgb - aq.rgb) * 40.0);
      let wl = exp(-abs(lp - lum(cq)) / sigma);
      let w = K[abs(dx)] * K[abs(dy)] * wn * wz * wa * wl;
      sum += cq * w; wsum += w; vsum += w * w * max(src[j].w, 0.0);
    }
  }
  let ws = max(wsum, 1e-6);
  dst[i] = vec4f(sum / ws, vsum / (ws * ws));
}
`;

const PREP = /* wgsl */ `
struct DP { width: u32, height: u32, step: u32, last: u32, sigmaL: f32, frames: f32, p0: f32, p1: f32 };
@group(0) @binding(0) var<uniform> D: DP;
@group(0) @binding(1) var<storage, read> accum: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> dst: array<vec4f>;
@group(0) @binding(3) var<storage, read> aux: array<vec4f>;
@compute @workgroup_size(${WG}, ${WG})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= D.width || gid.y >= D.height) { return; }
  let i = gid.y * D.width + gid.x;
  let c = accum[i].rgb / D.frames;
  let a = aux[i * 2u].rgb / D.frames;
  // demodulate (or remodulate on the way back); w carries the variance of the demodulated mean
  if (D.last == 0u) {
    let m = dot(c, vec3f(0.2126, 0.7152, 0.0722));
    let v = max(accum[i].w / D.frames - m * m, 0.0) / D.frames;
    let la = max(dot(a, vec3f(0.2126, 0.7152, 0.0722)), 0.02);
    dst[i] = vec4f(c / max(a, vec3f(0.02)), v / (la * la));
  }
  else { dst[i] = vec4f(accum[i].rgb * max(a, vec3f(0.02)), 1.0); }
}
`;

export class PathTracer {
  /** @param {GPUDevice} device */
  constructor(device) {
    this.device = device;
    const mk = (code) => device.createComputePipeline({ layout: "auto", compute: { module: device.createShaderModule({ code }), entryPoint: "main" } });
    this.trace = mk(TRACE);
    this.denoise = mk(DENOISE);
    this.prep = mk(PREP);
    this.scene = null;
  }

  static async create(gpu) {
    const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) return null;
    const lim = adapter.limits;
    const device = await adapter.requestDevice({
      requiredLimits: {
        maxStorageBufferBindingSize: Math.min(lim.maxStorageBufferBindingSize, 1 << 30),
        maxBufferSize: Math.min(lim.maxBufferSize, 1 << 30),
        maxTextureArrayLayers: lim.maxTextureArrayLayers,
      },
    });
    const pt = new PathTracer(device);
    pt.adapterInfo = adapter.info ?? {};
    // Dawn (Node) frees the instance when nothing holds it, even while its device is in use
    pt.gpu = gpu;
    return pt;
  }

  buffer(data, usage) {
    const size = Math.max(16, Math.ceil(data.byteLength / 16) * 16);
    const b = this.device.createBuffer({ size, usage: usage | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(b, 0, data.buffer, data.byteOffset, data.byteLength);
    return b;
  }

  textureArray(layers, size, srgb) {
    const n = Math.max(1, layers.length);
    const mips = Math.floor(Math.log2(size)) + 1;
    const tex = this.device.createTexture({
      size: [size, size, n],
      format: srgb ? "rgba8unorm-srgb" : "rgba8unorm",
      mipLevelCount: mips,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    layers.forEach((data, li) => {
      let cur = data, s = size;
      for (let m = 0; m < mips; m++) {
        this.device.queue.writeTexture({ texture: tex, mipLevel: m, origin: [0, 0, li] }, cur, { bytesPerRow: s * 4, rowsPerImage: s }, [s, s, 1]);
        if (s === 1) break;
        cur = downsample(cur, s, srgb);
        s >>= 1;
      }
    });
    return tex;
  }

  /** Upload a scene; builds the BVH and reorders the triangles. */
  setScene(sc) {
    const n = sc.triMat.length;
    const t0 = Date.now();
    const { nodes, order } = buildBVH(sc.tris, n);
    const tris = new Float32Array(n * 12);
    const attrs = new Float32Array(n * 20);
    for (let k = 0; k < n; k++) {
      const i = order[k], s = i * 9, o = k * 12;
      tris[o] = sc.tris[s]; tris[o + 1] = sc.tris[s + 1]; tris[o + 2] = sc.tris[s + 2];
      tris[o + 3] = sc.triMat[i];
      for (let c = 0; c < 3; c++) {
        tris[o + 4 + c] = sc.tris[s + 3 + c] - sc.tris[s + c];
        tris[o + 8 + c] = sc.tris[s + 6 + c] - sc.tris[s + c];
      }
      attrs.set(sc.attrs.subarray(i * 20, i * 20 + 20), k * 20);
    }
    if (this.scene) this.destroyScene();
    const S = GPUBufferUsage.STORAGE;
    const lights = sc.lights.length ? sc.lights : new Float32Array(16);
    this.scene = {
      nodes: this.buffer(nodes, S),
      tris: this.buffer(tris, S),
      attrs: this.buffer(attrs, S),
      mats: this.buffer(sc.materials, S),
      lights: this.buffer(lights, S),
      nLights: sc.lights.length / 16,
      base: this.textureArray(sc.baseLayers, sc.texSize, true),
      norm: this.textureArray(sc.normalLayers, sc.texSize, false),
      texSize: sc.texSize,
      triangles: n,
      buildMs: Date.now() - t0,
    };
    this.sampler = this.device.createSampler({ addressModeU: "repeat", addressModeV: "repeat", magFilter: "linear", minFilter: "linear", mipmapFilter: "linear", maxAnisotropy: 1 });
  }

  destroyScene() {
    const s = this.scene;
    if (!s) return;
    for (const k of ["nodes", "tris", "attrs", "mats", "lights", "base", "norm"]) s[k].destroy();
    this.scene = null;
  }

  /**
   * Render: returns linear HDR RGBA (Float32Array, cd/m²) after denoising.
   * o: {width, height, camera:{eye, right, up, fwd, tanHalf, ortho}, spp, maxBounce, clipZ, sun:{dir, E[3], cos}, sky:{zenith, horizon, ground},
   *     cap, emitScale, denoise, onProgress}
   */
  async render(o) {
    const d = this.device, s = this.scene;
    const W = o.width, H = o.height, N = W * H;
    const S = GPUBufferUsage.STORAGE;
    const accum = d.createBuffer({ size: N * 16, usage: S | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    const aux = d.createBuffer({ size: N * 32, usage: S | GPUBufferUsage.COPY_DST });
    const tmpA = d.createBuffer({ size: N * 16, usage: S | GPUBufferUsage.COPY_SRC });
    const tmpB = d.createBuffer({ size: N * 16, usage: S | GPUBufferUsage.COPY_SRC });
    const pbuf = d.createBuffer({ size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const P = new ArrayBuffer(256), pf = new Float32Array(P), pu = new Uint32Array(P);
    const v3 = (off, v, w, asU) => {
      pf[off] = v[0]; pf[off + 1] = v[1]; pf[off + 2] = v[2];
      if (asU) pu[off + 3] = w; else pf[off + 3] = w;
    };
    const c = o.camera;
    v3(0, c.eye, c.tanHalf ?? 0.4);
    v3(4, c.right, c.ortho ?? 0);
    v3(8, c.up, o.clipZ ?? 1e9);
    v3(12, c.fwd, 0, true);
    v3(16, o.sun.dir, o.sun.cos ?? Math.cos(0.0047));
    v3(20, o.sun.E, s.nLights, true);
    v3(24, o.sky.zenith, o.maxBounce ?? 5, true);
    v3(28, o.sky.horizon, W, true);
    v3(32, o.sky.ground, H, true);
    v3(36, o.cap ?? [0.1, 0.1, 0.11], s.texSize);
    pf[40] = o.emitScale ?? 800;
    pf[41] = o.clampIndirect ?? 6e4;
    pu[42] = (o.seed ?? 1) >>> 0;
    pu[43] = o.debug ?? 0;
    const bg = d.createBindGroup({
      layout: this.trace.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: pbuf } },
        { binding: 1, resource: { buffer: s.nodes } },
        { binding: 2, resource: { buffer: s.tris } },
        { binding: 3, resource: { buffer: s.attrs } },
        { binding: 4, resource: { buffer: s.mats } },
        { binding: 5, resource: { buffer: s.lights } },
        { binding: 6, resource: { buffer: accum } },
        { binding: 7, resource: { buffer: aux } },
        { binding: 8, resource: s.base.createView({ dimension: "2d-array" }) },
        { binding: 9, resource: s.norm.createView({ dimension: "2d-array" }) },
        { binding: 10, resource: this.sampler },
      ],
    });
    const spp = Math.max(1, o.spp ?? 64);
    const gx = Math.ceil(W / WG), gy = Math.ceil(H / WG);
    for (let f = 0; f < spp; f++) {
      pu[15] = f;
      d.queue.writeBuffer(pbuf, 0, P);
      const enc = d.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(this.trace);
      pass.setBindGroup(0, bg);
      pass.dispatchWorkgroups(gx, gy);
      pass.end();
      d.queue.submit([enc.finish()]);
      // keep the queue short so a big render does not trip the GPU watchdog, and report progress
      if ((f & 3) === 3 || f === spp - 1) {
        await d.queue.onSubmittedWorkDone();
        o.onProgress?.(f + 1, spp);
        if (o.signal?.aborted) break;
      }
    }
    // denoise: demodulate → à-trous × iterations → remodulate (into accum)
    const dpb = d.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const DP = new ArrayBuffer(32), du = new Uint32Array(DP), df = new Float32Array(DP);
    const step = (pipe, a, b, stepN, last, sigma) => {
      du[0] = W; du[1] = H; du[2] = stepN; du[3] = last; df[4] = sigma; df[5] = spp;
      d.queue.writeBuffer(dpb, 0, DP);
      const g = d.createBindGroup({
        layout: pipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: dpb } },
          { binding: 1, resource: { buffer: a } },
          { binding: 2, resource: { buffer: b } },
          { binding: 3, resource: { buffer: aux } },
        ],
      });
      const enc = d.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(pipe);
      pass.setBindGroup(0, g);
      pass.dispatchWorkgroups(gx, gy);
      pass.end();
      d.queue.submit([enc.finish()]);
    };
    let out = tmpA;
    const its = o.denoise === false ? 0 : (o.denoiseIterations ?? (spp >= 256 ? 3 : 4));
    if (its) {
      step(this.prep, accum, tmpA, 0, 0, 0);
      let a = tmpA, b = tmpB;
      const sigma = o.denoiseSigma ?? 4;
      for (let k = 0; k < its; k++) {
        step(this.denoise, a, b, 1 << k, 0, sigma);
        [a, b] = [b, a];
      }
      // remodulate: a holds the filtered lighting
      step(this.prep, a, b, 0, 1, 0);
      out = b;
    } else {
      out = accum;
    }
    const read = d.createBuffer({ size: N * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = d.createCommandEncoder();
    enc.copyBufferToBuffer(out, 0, read, 0, N * 16);
    d.queue.submit([enc.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const hdr = new Float32Array(read.getMappedRange().slice(0));
    read.unmap();
    if (!its) for (let i = 0; i < N * 4; i++) hdr[i] = i % 4 === 3 ? 1 : hdr[i] / spp;
    for (const b of [accum, aux, tmpA, tmpB, pbuf, dpb, read]) b.destroy();
    return hdr;
  }
}

function downsample(src, s, srgb) {
  const h = s >> 1, out = new Uint8Array(h * h * 4);
  const toLin = (v) => (srgb ? Math.pow(v / 255, 2.2) : v / 255);
  const toOut = (v) => Math.round((srgb ? Math.pow(v, 1 / 2.2) : v) * 255);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < h; x++)
      for (let c = 0; c < 4; c++) {
        const a = src[((2 * y) * s + 2 * x) * 4 + c], b = src[((2 * y) * s + 2 * x + 1) * 4 + c];
        const e = src[((2 * y + 1) * s + 2 * x) * 4 + c], f = src[((2 * y + 1) * s + 2 * x + 1) * 4 + c];
        out[(y * h + x) * 4 + c] = c === 3 ? (a + b + e + f + 2) >> 2 : toOut((toLin(a) + toLin(b) + toLin(e) + toLin(f)) / 4);
      }
  return out;
}

/** Linear HDR → sRGB 8-bit with automatic exposure (key 0.18 on the log-average) and ACES filmic. */
export function tonemap(hdr, W, H, ev = 0) {
  const N = W * H;
  let sum = 0, n = 0;
  for (let i = 0; i < N; i += 7) {
    const l = 0.2126 * hdr[i * 4] + 0.7152 * hdr[i * 4 + 1] + 0.0722 * hdr[i * 4 + 2];
    if (l > 1e-3) {
      sum += Math.log(l);
      n++;
    }
  }
  const avg = n ? Math.exp(sum / n) : 1;
  const exposure = (0.18 / avg) * Math.pow(2, ev);
  const out = new Uint8Array(N * 4);
  const aces = (x) => Math.min(1, Math.max(0, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)));
  const srgb = (x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);
  for (let i = 0; i < N; i++) {
    for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.round(srgb(aces(hdr[i * 4 + c] * exposure)) * 255);
    out[i * 4 + 3] = 255;
  }
  return { rgba: out, exposure, avg };
}
