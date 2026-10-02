import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

const $ = (id) => document.getElementById(id);
const canvas = $("view");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xbfd6ea);
scene.fog = new THREE.Fog(0xbfd6ea, 80, 250);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.35;

const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 1000);
camera.position.set(20, 15, 20);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;

scene.add(new THREE.HemisphereLight(0xdfefff, 0x8a7a66, 1.2));
const sun = new THREE.DirectionalLight(0xfff3e0, 2.6);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
scene.add(sun, sun.target);

let model = null;
let levels = [];
let bounds = new THREE.Box3();
const clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e6);
renderer.clippingPlanes = [];

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();

function setStatus(t) {
  $("status").textContent = t;
}

async function loadInfo() {
  const info = await (await fetch("/info")).json();
  $("title").textContent = info.name ?? "Architecturer";
  document.title = `${info.name ?? "Plan"} · Architecturer`;
  const s = info.stats;
  $("stats").textContent = s ? `${s.triangles.toLocaleString()} tris · ${s.materials} materials` : "";
  const list = $("issueList");
  list.innerHTML = "";
  for (const e of info.errors) list.insertAdjacentHTML("beforeend", `<li class="error"></li>`), (list.lastChild.textContent = e);
  for (const w of info.warnings) list.insertAdjacentHTML("beforeend", `<li class="warn"></li>`), (list.lastChild.textContent = w);
  $("issues").hidden = !info.errors.length && !info.warnings.length;
  const prevCut = $("cut").value;
  const prevHidden = new Set(levels.filter((l) => !l.visible).map((l) => l.id));
  levels = info.levels.map((l) => ({ ...l, visible: !prevHidden.has(l.id) }));
  $("levels").innerHTML = "";
  $("cut").innerHTML = `<option value="">— none —</option>`;
  for (const l of levels) {
    const row = document.createElement("label");
    row.className = "row";
    row.innerHTML = `<input type="checkbox" ${l.visible ? "checked" : ""}/> <span></span>`;
    row.querySelector("span").textContent = l.name;
    row.querySelector("input").onchange = (e) => {
      l.visible = e.target.checked;
      applyVisibility();
    };
    $("levels").append(row);
    const opt = new Option(l.name, l.id);
    $("cut").append(opt);
  }
  $("cut").value = levels.some((l) => l.id === prevCut) ? prevCut : "";
  return info;
}

function applyVisibility() {
  if (!model) return;
  const kinds = {};
  document.querySelectorAll("input[data-kind]").forEach((i) => (kinds[i.dataset.kind] = i.checked));
  const cutId = $("cut").value;
  const cutIdx = levels.findIndex((l) => l.id === cutId);
  model.traverse((o) => {
    const k = o.userData?.kind;
    if (k === "level") {
      const idx = levels.findIndex((l) => l.id === o.userData.id);
      o.visible = (levels[idx]?.visible ?? true) && (cutIdx < 0 || idx <= cutIdx);
    } else if (k === "roof" || k === "furniture" || k === "site") o.visible = kinds[k];
    if (o.isMesh) {
      for (const m of [o.material].flat()) m.wireframe = $("wire").checked;
    }
  });
  if (cutIdx >= 0) {
    const l = levels[cutIdx];
    clipPlane.constant = l.elevation + Math.min(l.height * 0.75, 2.2);
    renderer.clippingPlanes = [clipPlane];
  } else renderer.clippingPlanes = [];
  renderer.shadowMap.enabled = $("shadows").checked;
  scene.traverse((o) => o.isMesh && o.material && (o.material.needsUpdate = true));
}

function frame(view = "iso") {
  if (bounds.isEmpty()) return;
  const c = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3()).length();
  const dirs = {
    iso: new THREE.Vector3(1, 0.75, 1.1),
    top: new THREE.Vector3(0, 1, 0.0001),
    south: new THREE.Vector3(0, 0.2, 1),
    east: new THREE.Vector3(1, 0.2, 0),
  };
  const d = dirs[view].clone().normalize();
  camera.position.copy(c).addScaledVector(d, size * 1.0);
  controls.target.copy(c);
  controls.update();
}

async function loadModel(keepCamera) {
  setStatus("building…");
  const t0 = performance.now();
  const info = await loadInfo();
  if (!info.stats?.triangles && info.errors.length) {
    setStatus("plan has errors");
    return;
  }
  const gltf = await new GLTFLoader().loadAsync(`/model.glb?t=${Date.now()}`);
  if (model) {
    scene.remove(model);
    model.traverse((o) => {
      if (o.isMesh) {
        o.geometry.dispose();
        for (const m of [o.material].flat()) {
          for (const v of Object.values(m)) if (v && v.isTexture) v.dispose();
          m.dispose();
        }
      }
    });
  }
  model = gltf.scene;
  model.traverse((o) => {
    if (/-(conv)?colonly$/.test(o.name)) o.visible = false;
    if (o.isMesh) {
      const transparent = [o.material].flat().some((m) => m.transparent);
      o.castShadow = !transparent;
      o.receiveShadow = true;
      for (const m of [o.material].flat()) {
        m.clipShadows = true;
        for (const t of [m.map, m.normalMap, m.roughnessMap, m.aoMap]) if (t) t.anisotropy = 8;
      }
    }
  });
  scene.add(model);
  // frame on the building (ignore the ground plane)
  bounds = new THREE.Box3();
  model.traverse((o) => {
    if (o.userData?.kind === "level") bounds.expandByObject(o);
  });
  if (bounds.isEmpty()) bounds.setFromObject(model);
  const c = bounds.getCenter(new THREE.Vector3());
  const r = bounds.getSize(new THREE.Vector3()).length();
  sun.position.set(c.x + r * 0.6, c.y + r, c.z + r * 0.8);
  sun.target.position.copy(c);
  const sc = sun.shadow.camera;
  sc.left = sc.bottom = -r;
  sc.right = sc.top = r;
  sc.far = r * 4;
  sc.updateProjectionMatrix();
  applyVisibility();
  if (!keepCamera) frame("iso");
  setStatus(`updated ${new Date().toLocaleTimeString()} · ${Math.round(performance.now() - t0)} ms`);
}

// picking: show the element's metadata
const ray = new THREE.Raycaster();
let downAt = null;
canvas.addEventListener("pointerdown", (e) => (downAt = [e.clientX, e.clientY]));
canvas.addEventListener("pointerup", (e) => {
  if (!model || !downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
  ray.setFromCamera(new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1), camera);
  const hit = ray.intersectObject(model, true).find((h) => {
    let o = h.object;
    while (o) {
      if (!o.visible) return false;
      o = o.parent;
    }
    return renderer.clippingPlanes.length === 0 || clipPlane.distanceToPoint(h.point) >= 0;
  });
  if (!hit) return;
  let o = hit.object;
  const chain = [];
  while (o && o !== model) {
    if (o.userData && Object.keys(o.userData).length) chain.push({ name: o.name, ...o.userData });
    o = o.parent;
  }
  const p = hit.point;
  $("picked").hidden = false;
  $("pickedInfo").textContent =
    `plan point: [${p.x.toFixed(2)}, ${(-p.z).toFixed(2)}]  z=${p.y.toFixed(2)}\n` +
    `material: ${[hit.object.material].flat()[0]?.name}\n` +
    chain
      .slice(0, 3)
      .map((c) => JSON.stringify(c))
      .join("\n");
});

document.querySelectorAll("input[data-kind], #wire, #shadows").forEach((i) => (i.onchange = applyVisibility));
$("cut").onchange = applyVisibility;
document.querySelectorAll("button[data-view]").forEach((b) => (b.onclick = () => frame(b.dataset.view)));
$("planBtn").onclick = () => {
  const level = $("cut").value || levels[0]?.id || "";
  $("planImg").src = `/plan.svg?level=${encodeURIComponent(level)}&t=${Date.now()}`;
  $("plan").hidden = false;
};
$("planClose").onclick = () => ($("plan").hidden = true);
$("plan").onclick = (e) => e.target === $("plan") && ($("plan").hidden = true);

new EventSource("/events").addEventListener("reload", () => loadModel(true).catch((e) => setStatus(String(e))));

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

loadModel(false).catch((e) => setStatus(String(e)));
