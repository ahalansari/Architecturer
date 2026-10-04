// Simulations in the 3D view:
//  🌬 Airflow — particles carried by the server's GPU airflow study of a floor, coloured by temperature.
//  💧 Water — the supply network with water moving at its design velocity (cold blue, hot red); open a hot tap
//            to watch the hot water travel from the heater, with the wait the hydraulics predict.
import * as THREE from "three";

const $ = (id) => document.getElementById(id);
// plan (x east, y north, z up) → glTF / three (x, z up, -y)
const V = (x, y, z) => new THREE.Vector3(x, z, -y);

/** Same scale as the airflow sheet: 16 °C blue … 24 °C green … 31 °C red. */
export function tempColor(t, out = new THREE.Color()) {
  const stops = [[16, [40, 70, 190]], [20, [60, 150, 230]], [23, [110, 200, 170]], [24.5, [170, 220, 120]], [26, [250, 210, 80]], [28, [240, 130, 50]], [31, [200, 40, 40]]];
  let c = stops[stops.length - 1][1];
  if (t <= stops[0][0]) c = stops[0][1];
  else
    for (let k = 1; k < stops.length; k++)
      if (t <= stops[k][0]) {
        const [ta, ca] = stops[k - 1], [tb, cb] = stops[k];
        const f = (t - ta) / (tb - ta);
        c = ca.map((v, i) => v + (cb[i] - v) * f);
        break;
      }
  return out.setRGB(c[0] / 255, c[1] / 255, c[2] / 255, THREE.SRGBColorSpace);
}

class Airflow {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = "airflow";
    scene.add(this.group);
    this.N = 4000;
  }

  async load(level) {
    const r = await fetch(`airflow.bin${level ? `?level=${encodeURIComponent(level)}` : ""}`, { cache: "no-store" });
    if (!r.ok) throw new Error(await r.text());
    const buf = await r.arrayBuffer();
    const hl = new DataView(buf).getUint32(0, true);
    this.h = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hl)));
    this.f = new Float32Array(buf, 4 + Math.ceil(hl / 4) * 4);
    const { nx, ny, nz } = this.h;
    this.fluid = [];
    for (let i = 0; i < nx * ny * nz; i++) if (Number.isFinite(this.f[i * 4 + 3])) this.fluid.push(i);
    this.build();
    return this.h;
  }

  /** Trilinear sample of (u, v, w, T) at a plan point; null outside the air. */
  sample(x, y, z) {
    const { nx, ny, nz, dx, x0, y0, z0 } = this.h;
    const gx = (x - x0) / dx - 0.5, gy = (y - y0) / dx - 0.5, gz = (z - z0) / dx - 0.5;
    const i0 = Math.floor(gx), j0 = Math.floor(gy), k0 = Math.floor(gz);
    const fx = gx - i0, fy = gy - j0, fz = gz - k0;
    const acc = [0, 0, 0, 0];
    let wt = 0;
    for (let c = 0; c < 8; c++) {
      const i = i0 + (c & 1), j = j0 + ((c >> 1) & 1), k = k0 + ((c >> 2) & 1);
      if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) continue;
      const q = ((k * ny + j) * nx + i) * 4;
      if (!Number.isFinite(this.f[q + 3])) continue;
      const w = (c & 1 ? fx : 1 - fx) * ((c >> 1) & 1 ? fy : 1 - fy) * ((c >> 2) & 1 ? fz : 1 - fz);
      for (let m = 0; m < 4; m++) acc[m] += this.f[q + m] * w;
      wt += w;
    }
    return wt > 0.05 ? acc.map((v) => v / wt) : null;
  }

  spawn(p) {
    const { nx, ny, dx, x0, y0, z0, terminals } = this.h;
    const sup = terminals.filter((t) => t.kind === "supply");
    if (sup.length && Math.random() < 0.35) {
      // just under a diffuser, where the jets start
      const t = sup[(Math.random() * sup.length) | 0];
      const top = this.topAt(t.at[0], t.at[1]);
      p.set(t.at[0] + (Math.random() - 0.5) * 0.6, t.at[1] + (Math.random() - 0.5) * 0.6, top - 0.1 - Math.random() * 0.2);
    } else {
      const q = this.fluid[(Math.random() * this.fluid.length) | 0];
      const i = q % nx, j = Math.floor(q / nx) % ny, k = Math.floor(q / (nx * ny));
      p.set(x0 + (i + Math.random()) * dx, y0 + (j + Math.random()) * dx, z0 + (k + Math.random()) * dx);
    }
  }

  topAt(x, y) {
    const { nz, dx, z0 } = this.h;
    for (let k = nz - 1; k >= 0; k--) if (this.sample(x, y, z0 + (k + 0.5) * dx)) return z0 + (k + 0.5) * dx;
    return z0 + 2.5;
  }

  build() {
    this.group.clear();
    const N = this.N;
    this.p = Array.from({ length: N }, () => new THREE.Vector3());
    this.age = new Float32Array(N);
    this.life = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      this.spawn(this.p[i]);
      this.life[i] = 4 + Math.random() * 6;
      this.age[i] = Math.random() * this.life[i];
    }
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(N * 6);
    this.col = new Float32Array(N * 6);
    g.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(this.col, 3));
    this.lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false }));
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 5;
    this.group.add(this.lines);
    // the particles themselves: soft round sprites ~8 cm across
    const pg = new THREE.BufferGeometry();
    this.dot = new Float32Array(N * 3);
    this.dotCol = new Float32Array(N * 3);
    pg.setAttribute("position", new THREE.BufferAttribute(this.dot, 3));
    pg.setAttribute("color", new THREE.BufferAttribute(this.dotCol, 3));
    this.points = new THREE.Points(pg, new THREE.PointsMaterial({ size: 0.16, map: dotTexture(), vertexColors: true, transparent: true, alphaTest: 0.05, depthWrite: false, sizeAttenuation: true }));
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;
    this.group.add(this.points);
  }

  update(dt) {
    if (!this.h) return;
    const c = new THREE.Color();
    const speedup = 1.5;
    for (let i = 0; i < this.N; i++) {
      const p = this.p[i];
      let s = this.sample(p.x, p.y, p.z);
      this.age[i] += dt;
      if (!s || this.age[i] > this.life[i]) {
        this.spawn(p);
        this.age[i] = 0;
        s = this.sample(p.x, p.y, p.z) ?? [0, 0, 0, 24];
      }
      const h = dt * speedup;
      p.x += s[0] * h;
      p.y += s[1] * h;
      p.z += s[2] * h;
      // a streak along the motion, ~0.35 s long (visible even when the air is slow)
      const sp = Math.hypot(s[0], s[1], s[2]);
      const k = Math.max(0.6, 0.12 / Math.max(sp, 1e-3));
      const a = V(p.x, p.y, p.z), b = V(p.x - s[0] * k, p.y - s[1] * k, p.z - s[2] * k);
      this.pos.set([a.x, a.y, a.z, b.x, b.y, b.z], i * 6);
      tempColor(s[3], c);
      const fade = Math.min(1, this.age[i] / 0.5, (this.life[i] - this.age[i]) / 0.5);
      this.col.set([c.r * fade, c.g * fade, c.b * fade, c.r * fade * 0.15, c.g * fade * 0.15, c.b * fade * 0.15], i * 6);
      this.dot.set([a.x, a.y, a.z], i * 3);
      this.dotCol.set([c.r * fade, c.g * fade, c.b * fade], i * 3);
    }
    this.lines.geometry.attributes.position.needsUpdate = true;
    this.lines.geometry.attributes.color.needsUpdate = true;
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.color.needsUpdate = true;
  }

  dispose() {
    this.group.removeFromParent();
    this.lines?.geometry.dispose();
  }
}

let dotTex;
function dotTexture() {
  if (dotTex) return dotTex;
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d");
  const r = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  r.addColorStop(0, "rgba(255,255,255,1)");
  r.addColorStop(0.5, "rgba(255,255,255,0.85)");
  r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, 32, 32);
  return (dotTex = new THREE.CanvasTexture(c));
}

class Water {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.name = "water";
    scene.add(this.group);
    this.t = 0;
    this.tap = null;
  }

  async load() {
    const r = await fetch("water.json", { cache: "no-store" });
    if (!r.ok) throw new Error(await r.text());
    this.w = await r.json();
    this.group.clear();
    // each segment as a 3D polyline: along the plan path at its start height, then up / down to its end
    this.paths = this.w.segments.map((s) => {
      const pts = [];
      if (s.kind === "riser") pts.push(V(s.pts[0][0], s.pts[0][1], s.z[0]), V(s.pts[0][0], s.pts[0][1], s.z[1]));
      else {
        for (const p of s.pts) pts.push(V(p[0], p[1], s.z[0]));
        const last = s.pts[s.pts.length - 1];
        if (Math.abs(s.z[1] - s.z[0]) > 0.01) pts.push(V(last[0], last[1], s.z[1]));
      }
      const lens = [0];
      for (let i = 1; i < pts.length; i++) lens.push(lens[i - 1] + pts[i].distanceTo(pts[i - 1]));
      return { s, pts, lens, total: lens[lens.length - 1] };
    });
    this.lines = [];
    for (const p of this.paths) {
      const g = new THREE.BufferGeometry().setFromPoints(p.pts);
      const hot = p.s.water === "hot";
      const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: hot ? 0xd8452f : 0x2f7fd8, transparent: true, opacity: 0.55 }));
      line.renderOrder = 4;
      line.userData.level = p.s.level;
      this.lines.push(line);
      this.group.add(line);
    }
    // droplets: spaced 0.25 m, moving at the pipe's velocity
    const n = this.paths.reduce((a, p) => a + Math.max(1, Math.floor(p.total / 0.25)), 0);
    this.dropPos = new Float32Array(n * 3);
    this.dropCol = new Float32Array(n * 3);
    this.drops = [];
    for (const [pi, p] of this.paths.entries()) {
      const k = Math.max(1, Math.floor(p.total / 0.25));
      for (let i = 0; i < k; i++) this.drops.push({ pi, off: (i / k) * p.total });
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(this.dropPos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(this.dropCol, 3));
    this.points = new THREE.Points(g, new THREE.PointsMaterial({ size: 0.09, map: dotTexture(), vertexColors: true, transparent: true, alphaTest: 0.05, depthWrite: false, sizeAttenuation: true }));
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;
    this.group.add(this.points);
    // the hot front for an opened tap
    this.front = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xff2a00, linewidth: 3 }));
    this.front.renderOrder = 7;
    this.group.add(this.front);
    return this.w;
  }

  at(p, d) {
    let i = 1;
    while (i < p.lens.length - 1 && p.lens[i] < d) i++;
    const a = p.pts[i - 1], b = p.pts[i];
    const seg = p.lens[i] - p.lens[i - 1] || 1;
    return a.clone().lerp(b, Math.min(1, Math.max(0, (d - p.lens[i - 1]) / seg)));
  }

  openTap(outletId) {
    const o = this.w.outlets.find((x) => x.id === outletId);
    if (!o?.hotPath?.length) return null;
    const pi = o.hotPath[o.hotPath.length - 1];
    this.tap = { o, path: this.paths[pi], t: 0 };
    return o;
  }

  /** Hide the floors above the cut (risers belong to the floor they serve). */
  showUpTo(maxLevel) {
    if (this.maxLevel === maxLevel || !this.lines) return;
    this.maxLevel = maxLevel;
    for (const l of this.lines) l.visible = l.userData.level <= maxLevel;
  }

  update(dt, onTap) {
    if (!this.paths) return;
    this.t += dt;
    const cold = new THREE.Color(0x3a8ff0), hot = new THREE.Color(0xff4a2a), still = new THREE.Color(0x9aa3ad);
    for (const [i, d] of this.drops.entries()) {
      const p = this.paths[d.pi];
      // water only moves in a pipe whose tap is open (all of them at once would be a peak-demand picture)
      if (p.s.level > (this.maxLevel ?? Infinity)) {
        this.dropPos.set([0, -1e4, 0], i * 3);
        continue;
      }
      const moving = !this.tap || this.tap.o.coldPath.includes(d.pi) || this.tap.o.hotPath.includes(d.pi);
      const v = moving ? Math.max(0.05, p.s.velocity) : 0;
      d.off = (d.off + v * dt) % p.total;
      const q = this.at(p, d.off);
      this.dropPos.set([q.x, q.y, q.z], i * 3);
      const c = !moving ? still : p.s.water === "hot" ? hot : cold;
      this.dropCol.set([c.r, c.g, c.b], i * 3);
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.color.needsUpdate = true;
    if (this.tap) {
      const T = this.tap;
      T.t += dt;
      const v = Math.max(0.05, T.path.s.velocity);
      // the front: water at the heater's temperature reaching along the hot branch
      const d = Math.min(T.path.total, (v * T.t) / 1.15);
      const pts = [];
      for (let k = 0; k <= 30; k++) pts.push(this.at(T.path, (d * k) / 30));
      this.front.geometry.dispose();
      this.front.geometry = new THREE.BufferGeometry().setFromPoints(pts);
      onTap?.(T.t, d >= T.path.total, T.o);
    }
  }

  dispose() {
    this.group.removeFromParent();
  }
}

export function initSim({ scene, cut, levels, addFrameHook }) {
  const sec = $("sim");
  if (!sec) return;
  let air = null, water = null;
  const status = $("simStatus");
  const say = (t, cls = "muted") => {
    status.textContent = t;
    status.className = cls;
  };
  $("airBtn").onclick = async () => {
    if (air) {
      air.dispose();
      air = null;
      $("airBtn").setAttribute("aria-pressed", "false");
      $("airLegend").hidden = true;
      say("");
      return;
    }
    const level = cut() || undefined;
    say("Simulating airflow on the server's GPU…");
    $("airBtn").disabled = true;
    try {
      air = new Airflow(scene);
      const h = await air.load(level);
      $("airBtn").setAttribute("aria-pressed", "true");
      $("airLegend").hidden = false;
      $("airSheet").href = `airflow.png?level=${encodeURIComponent(h.level)}`;
      const worst = [...h.rooms].sort((a, b) => a.adpi - b.adpi)[0];
      say(`${h.levelName}: ${h.rooms.length} rooms${worst ? ` · lowest ADPI ${worst.adpi}% (${worst.name})` : ""}${h.issues.length ? ` · ${h.issues.length} issue(s) on the sheet` : ""}. Tip: cut above this floor to see inside.`);
    } catch (e) {
      air?.dispose();
      air = null;
      say(`Airflow unavailable: ${e.message}`, "error");
    } finally {
      $("airBtn").disabled = false;
    }
  };
  $("waterBtn").onclick = async () => {
    if (water) {
      water.dispose();
      water = null;
      $("waterBtn").setAttribute("aria-pressed", "false");
      $("tapRow").hidden = true;
      say("");
      return;
    }
    try {
      water = new Water(scene);
      const w = await water.load();
      $("waterBtn").setAttribute("aria-pressed", "true");
      const sel = $("tapSel");
      sel.innerHTML = "";
      for (const o of w.outlets.filter((o) => o.hotPath?.length)) sel.append(new Option(`${o.label} · ${o.room} (${o.waitS} s)`, o.id));
      $("tapRow").hidden = !sel.options.length;
      say(`Supply network: cold blue, hot red, moving at design velocity. Summer "cold" water ≈ ${w.coldSummerC} °C.`);
    } catch (e) {
      water?.dispose();
      water = null;
      say(`Water network unavailable: ${e.message}`, "error");
    }
  };
  $("tapBtn").onclick = () => {
    if (!water) return;
    const o = water.openTap($("tapSel").value);
    if (o) say(`Opened the ${o.label} in ${o.room}: waiting for hot water…`);
  };
  addFrameHook((dt) => {
    air?.update(dt);
    if (water) {
      const ids = levels().map((l) => l.id);
      const ci = ids.indexOf(cut());
      water.showUpTo(ci < 0 ? Infinity : ci);
    }
    water?.update(dt, (t, arrived, o) => {
      if (arrived && !water.tap.done) {
        water.tap.done = true;
        say(`Hot water reached the ${o.label} in ${o.room} after ${t.toFixed(0)} s (${o.waitL} L run off; predicted ${o.waitS} s).`);
      } else if (!arrived) say(`Opened the ${o.label} in ${o.room}: ${t.toFixed(1)} s…`);
    });
  });
}
