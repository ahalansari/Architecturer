import * as THREE from "three";

/**
 * Day / Night switch for the viewer (self-contained: finds the sun, sky light and the model's
 * KHR_lights_punctual lights by itself, and adds its own panel section).
 *
 * Night: sun off, dark sky, environment and hemisphere light nearly off, and the plan's lights on.
 * glTF light intensities are physical (candela); like the software renderer (NIGHT_EXPOSURE in
 * src/elements/lighting.ts) they are scaled by 0.02 so ~150 lux reads as a well-lit room with
 * ACES tone mapping at exposure 1. Only a few lights near the camera cast shadows (each point-light
 * shadow is six extra renders, and every shadow map costs a texture unit).
 *
 * Every visible light adds uniforms to every material's shader, and big plans have more lamps than WebGL
 * allows (MAX_FRAGMENT_UNIFORM_VECTORS): at night a pool of the lamps that matter most from the camera is
 * on, re-picked as you move. The pool size per light type stays fixed, so shaders never recompile.
 */
const NIGHT_EXPOSURE = 0.02;
const MAX_SHADOWS = 4;
const NIGHT_SKY = 0x0b1022;

export class DayNight {
  constructor({ scene, renderer, camera }) {
    this.scene = scene;
    this.renderer = renderer;
    this.camera = camera;
    this.mode = new URLSearchParams(location.search).get("lighting") === "night" ? "night" : "day";
    this.brightness = 1;
    this.model = null;
    this.lights = [];
    this.active = new Set();
    this.frame = 0;
    // ~6 uniform vectors per spot light, ~4 per point light, plus the material's own ~250
    const maxVec = renderer.capabilities?.maxFragmentUniforms ?? 1024;
    this.budget = Math.max(8, Math.min(48, Math.floor((maxVec - 300) / 6)));
    this.shadowSet = "";
    this.day = null; // saved day settings
    this.buildUI();
    const prev = scene.onBeforeRender;
    scene.onBeforeRender = (...args) => {
      prev?.apply(scene, args);
      this.tick();
    };
    addEventListener("keydown", (e) => {
      if (e.key !== "n" && e.key !== "N") return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      this.setMode(this.mode === "day" ? "night" : "day");
    });
  }

  buildUI() {
    const panel = document.getElementById("panel");
    if (!panel) return;
    const sec = document.createElement("section");
    sec.innerHTML = `
      <h2>Lighting</h2>
      <div class="buttons">
        <button data-mode="day" title="Sunlight (N toggles)">☀️ Day</button>
        <button data-mode="night" title="Only the plan's light fixtures and lamps (N toggles)">🌙 Night</button>
      </div>
      <label class="row" data-night>Brightness <input type="range" min="0.25" max="4" step="0.05" value="1" /></label>
      <div class="muted" data-night data-count></div>`;
    sec.querySelectorAll("button[data-mode]").forEach((b) => (b.onclick = () => this.setMode(b.dataset.mode)));
    sec.querySelector("input").oninput = (e) => {
      this.brightness = Number(e.target.value);
      this.apply();
    };
    // after the "Show" section
    const sections = panel.querySelectorAll("section");
    (sections[1] ?? sections[0])?.after(sec);
    this.ui = sec;
    this.updateUI();
  }

  updateUI() {
    if (!this.ui) return;
    this.ui.querySelectorAll("button[data-mode]").forEach((b) => (b.style.borderColor = b.dataset.mode === this.mode ? "var(--accent)" : ""));
    this.ui.querySelectorAll("[data-night]").forEach((el) => (el.style.display = this.mode === "night" ? "" : "none"));
    const c = this.ui.querySelector("[data-count]");
    if (c)
      c.textContent = this.lights.length
        ? `${this.lights.length} lights${this.lights.length > this.budget ? ` · the ${this.budget} nearest on (browser limit; 📷 Photo uses all)` : ""} · ${Math.min(MAX_SHADOWS, this.lights.filter((l) => l.userData.light?.castShadow).length)} with shadows`
        : "no lights in this plan";
  }

  setMode(mode) {
    this.mode = mode;
    this.apply();
    this.updateUI();
  }

  /** The glTF scene currently shown (the group whose child is the "building" node). */
  findModel() {
    return this.scene.children.find((o) => o.children?.some((c) => c.userData?.kind === "building")) ?? null;
  }

  collect() {
    this.lights = [];
    if (!this.model) return;
    this.model.traverse((o) => {
      if (o.isLight && o.userData?.light) {
        o.userData.cd = o.userData.light.intensity ?? o.intensity;
        o.castShadow = false;
        this.lights.push(o);
      }
      // fixtures and glowing bulbs must not shadow their own light
      if (o.isMesh) {
        const inFixture = (() => {
          for (let p = o; p; p = p.parent) if (p.userData?.kind === "light_fixture") return true;
          return false;
        })();
        const glowing = [o.material].flat().some((m) => m?.emissive && m.emissive.getHex() !== 0);
        if (inFixture || glowing) o.castShadow = false;
      }
    });
    this.shadowSet = "";
  }

  apply() {
    const s = this.scene;
    const sun = s.children.find((o) => o.isDirectionalLight);
    const hemi = s.children.find((o) => o.isHemisphereLight);
    if (!this.day)
      this.day = {
        bg: s.background?.clone?.() ?? null,
        fog: s.fog?.color.clone(),
        env: s.environmentIntensity ?? 1,
        hemi: hemi?.intensity ?? 1,
        hemiSky: hemi?.color.clone(),
        hemiGround: hemi?.groundColor.clone(),
      };
    const night = this.mode === "night";
    if (sun) sun.visible = !night;
    if (hemi) {
      hemi.intensity = night ? 0.06 : this.day.hemi;
      hemi.color.copy(night ? new THREE.Color(0x3a4a7a) : this.day.hemiSky);
      hemi.groundColor.copy(night ? new THREE.Color(0x101010) : this.day.hemiGround);
    }
    s.environmentIntensity = night ? 0.015 : this.day.env;
    if (night) {
      s.background = new THREE.Color(NIGHT_SKY);
      s.fog?.color.set(NIGHT_SKY);
    } else {
      s.background = this.day.bg;
      if (s.fog && this.day.fog) s.fog.color.copy(this.day.fog);
    }
    for (const l of this.lights) l.intensity = (l.userData.cd ?? 1) * NIGHT_EXPOSURE * this.brightness;
    this.activeKey = "";
    this.updateActive(true);
    this.shadowSet = "";
    if (night) this.updateShadows(true);
  }

  /** How much a light matters from the camera: candela over distance². */
  score(l) {
    const p = l.getWorldPosition(new THREE.Vector3());
    return (l.userData.cd ?? 1) / Math.max(0.5, p.distanceToSquared(this.camera.position));
  }

  /** Switch on the pool: per type, the same count every time (so shaders keep their light count). */
  updateActive(force) {
    const night = this.mode === "night";
    const points = this.lights.filter((l) => !l.isSpotLight), spots = this.lights.filter((l) => l.isSpotLight);
    const total = points.length + spots.length;
    let on = new Set(this.lights);
    if (total > this.budget) {
      const kp = Math.round((this.budget * points.length) / total), ks = this.budget - kp;
      const pick = (ls, k) => ls.map((l) => ({ l, s: this.score(l) })).sort((a, b) => b.s - a.s).slice(0, k).map((x) => x.l);
      on = new Set([...pick(points, kp), ...pick(spots, ks)]);
    }
    const key = night ? [...on].map((l) => l.uuid).join() : "day";
    if (!force && key === this.activeKey) return;
    this.activeKey = key;
    this.active = on;
    for (const l of this.lights) l.visible = night && on.has(l);
  }

  /** Give shadows to the few castShadow lights that matter most from where the camera is. */
  updateShadows(force) {
    const cam = this.camera.position;
    const p = new THREE.Vector3();
    const ranked = this.lights
      .filter((l) => l.userData.light?.castShadow && this.active.has(l))
      .map((l) => {
        l.getWorldPosition(p);
        return { l, score: (l.userData.cd ?? 1) / Math.max(1, p.distanceToSquared(cam)) };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_SHADOWS)
      .map((x) => x.l);
    const key = ranked.map((l) => l.uuid).join();
    if (!force && key === this.shadowSet) return;
    this.shadowSet = key;
    const on = new Set(ranked);
    for (const l of this.lights) {
      const want = on.has(l);
      if (want && !l.castShadow) {
        l.shadow.mapSize.set(l.isPointLight ? 512 : 1024, l.isPointLight ? 512 : 1024);
        l.shadow.bias = -0.002;
        l.shadow.normalBias = 0.03;
        l.shadow.radius = 3;
        l.shadow.camera.near = 0.05;
        l.shadow.camera.far = l.distance || 15;
        l.shadow.camera.updateProjectionMatrix();
      }
      l.castShadow = want;
    }
  }

  tick() {
    const m = this.findModel();
    if (m !== this.model) {
      this.model = m;
      this.collect();
      this.apply();
      this.updateUI();
    }
    if (this.mode === "night" && ++this.frame % 30 === 0) {
      this.updateActive(false);
      this.updateShadows(false);
    }
  }
}
