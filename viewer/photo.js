// 📷 Photo: the server path-traces the current camera (GPU when it has one) and shows the still with a download.
const $ = (id) => document.getElementById(id);

let ui;
let lastUrl;
let busy = false;

function overlay() {
  if (ui) return ui;
  ui = document.createElement("div");
  ui.id = "photo";
  ui.hidden = true;
  ui.innerHTML = `
    <div id="photoBar">
      <strong>📷 Photo</strong>
      <label>Time <input id="phTime" type="time" value="10:30" step="900" /></label>
      <label>Date <select id="phDate">
        <option value="12-21">21 Dec (low winter sun)</option>
        <option value="03-21" selected>21 Mar</option>
        <option value="06-21">21 Jun (high summer sun)</option>
        <option value="09-21">21 Sep</option>
      </select></label>
      <label>Light <select id="phLight"><option value="auto">as the view</option><option value="day">Day</option><option value="golden">Golden hour</option><option value="dusk">Dusk</option><option value="night">Night</option></select></label>
      <label>Quality <select id="phSpp"><option value="64">Draft</option><option value="192" selected>Good</option><option value="512">Final</option></select></label>
      <button id="phRender">Render</button>
      <a id="phSave" class="button" download="photo.png" hidden>Save PNG</a>
      <span id="phStatus" class="muted" aria-live="polite"></span>
      <button id="phClose" title="Close (Esc)">✕</button>
    </div>
    <div id="photoStage"><img id="phImg" alt="path-traced view" /></div>`;
  document.body.append(ui);
  $("phClose").onclick = () => (ui.hidden = true);
  addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !ui.hidden) ui.hidden = true;
  });
  return ui;
}

// glTF (y up) → plan (z up): plan = (x, -z, y)
const toPlan = (v) => [v.x, -v.z, v.y].map((n) => +n.toFixed(3)).join(",");

export function initPhoto({ camera, controls, lighting, cut }) {
  const btn = $("photoBtn");
  if (!btn) return;
  const render = async () => {
    if (busy) return;
    busy = true;
    const o = overlay();
    o.hidden = false;
    const mode = lighting();
    if (mode === "night" && $("phTime").value === "10:30") $("phTime").value = "21:00";
    const dpr = Math.min(2, devicePixelRatio || 1);
    const w = Math.min(2000, Math.round(innerWidth * dpr * 0.8)), h = Math.min(2000, Math.round((w * innerHeight) / innerWidth));
    const q = new URLSearchParams({
      eye: toPlan(camera.position),
      target: toPlan(controls.target),
      fov: String(Math.round(camera.fov)),
      w: String(w),
      h: String(h),
      spp: $("phSpp").value,
      lighting: $("phLight").value === "auto" ? (mode === "night" ? (+$("phTime").value.split(":")[0] < 19 ? "dusk" : "night") : "day") : $("phLight").value,
      time: $("phTime").value,
      date: $("phDate").value,
    });
    if (cut()) q.set("level", cut());
    // golden hour and dusk follow the date's sunset (45 min before, 30 min after); night left at the day's
    // default time is 21:00
    const light = q.get("lighting");
    if (light === "golden" || light === "dusk" || (light === "night" && q.get("time") === "10:30")) q.delete("time");
    $("phStatus").textContent = "Rendering… (path tracing on the server)";
    $("phStatus").className = "muted";
    $("phRender").disabled = true;
    const t0 = performance.now();
    try {
      const r = await fetch(`photo.png?${q}`, { cache: "no-store" });
      if (!r.ok) throw new Error(await r.text());
      const blob = await r.blob();
      if (lastUrl) URL.revokeObjectURL(lastUrl);
      lastUrl = URL.createObjectURL(blob);
      $("phImg").src = lastUrl;
      $("phSave").href = lastUrl;
      $("phSave").hidden = false;
      const how = decodeURIComponent(r.headers.get("x-renderer") ?? "");
      $("phStatus").textContent = `${((performance.now() - t0) / 1000).toFixed(1)} s · ${how.replace(/^Rendered with /, "").replace(/\.$/, "")}`;
    } catch (e) {
      $("phStatus").textContent = `Could not render: ${e.message}`;
      $("phStatus").className = "error";
    } finally {
      busy = false;
      $("phRender").disabled = false;
    }
  };
  btn.onclick = render;
  overlay();
  $("phRender").onclick = render;
  addEventListener("keydown", (e) => {
    if ((e.key === "p" || e.key === "P") && !e.metaKey && !e.ctrlKey && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLSelectElement)) render();
  });
}
