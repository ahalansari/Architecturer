// 2D plan sheets (plan / lighting / finishes) in a pan-and-zoom overlay, refreshed live on reload.

const $ = (id) => document.getElementById(id);
const SHEETS = ["plan", "lighting", "finishes", "rcp", "false_ceiling", "electrical", "plumbing"];
const STORE = "architecturer.planSheet";

export class PlanViewer {
  constructor() {
    this.root = $("plan");
    this.stage = $("planStage");
    this.img = $("planImg");
    this.select = $("planLevel");
    this.levels = [];
    try {
      this.sheet = SHEETS.includes(localStorage.getItem(STORE)) ? localStorage.getItem(STORE) : "plan";
    } catch {
      this.sheet = "plan";
    }
    this.level = "";
    // view: image top-left (px in the stage) and zoom (1 = SVG pixels)
    this.view = { x: 0, y: 0, k: 1 };
    this.fitPending = true;

    document.querySelectorAll("#planBar button[data-sheet]").forEach((b) => (b.onclick = () => this.show(b.dataset.sheet)));
    this.select.onchange = () => this.show(this.sheet, this.select.value);
    $("planClose").onclick = () => this.close();
    $("planFit").onclick = () => this.fit();
    $("planIn").onclick = () => this.zoomAt(1.25);
    $("planOut").onclick = () => this.zoomAt(0.8);
    this.img.onload = () => {
      this.stage.classList.remove("loading");
      if (this.fitPending) this.fit();
      else this.apply();
      this.fitPending = false;
    };
    this.img.onerror = () => this.stage.classList.remove("loading");
    this.#bindPanZoom();
    addEventListener("keydown", (e) => {
      if (this.root.hidden || e.target instanceof HTMLSelectElement) return;
      if (e.key === "Escape") this.close();
      else if (e.key >= "1" && e.key <= String(SHEETS.length)) this.show(SHEETS[+e.key - 1]);
      else if (e.key === "+" || e.key === "=") this.zoomAt(1.25);
      else if (e.key === "-") this.zoomAt(0.8);
      else if (e.key === "0") this.fit();
      else return;
      e.preventDefault();
      e.stopPropagation();
    }, true);
    addEventListener("resize", () => !this.root.hidden && this.apply());
  }

  get isOpen() {
    return !this.root.hidden;
  }

  /** Level list from /info ({id, name}); keeps the current choice when it still exists. */
  setLevels(levels) {
    this.levels = levels;
    this.select.innerHTML = "";
    for (const l of levels) this.select.append(new Option(l.name, l.id));
    if (!levels.some((l) => l.id === this.level)) this.level = levels[0]?.id ?? "";
    this.select.value = this.level;
  }

  show(sheet = this.sheet, level = this.level) {
    level ||= this.levels[0]?.id || "";
    sheet = SHEETS.includes(sheet) ? sheet : "plan";
    const levelChanged = level !== this.level;
    const changed = sheet !== this.sheet || levelChanged || this.root.hidden;
    this.sheet = sheet;
    this.level = level;
    try {
      localStorage.setItem(STORE, this.sheet);
    } catch {}
    this.select.value = this.level;
    document.querySelectorAll("button[data-sheet]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.sheet === this.sheet)));
    // switching sheets keeps the view when the level stays the same (same drawing extents)
    if (levelChanged || this.root.hidden) this.fitPending = true;
    this.root.hidden = false;
    if (changed || !this.img.src) this.load();
  }

  /** Re-fetch the current sheet (the plan file changed) keeping pan and zoom. */
  refresh() {
    if (!this.root.hidden) this.load();
  }

  close() {
    this.root.hidden = true;
  }

  load() {
    const q = `level=${encodeURIComponent(this.level)}&sheet=${this.sheet}`;
    this.stage.classList.add("loading");
    this.img.src = `plan.svg?${q}&t=${Date.now()}`;
    const a = $("planSvg");
    a.href = `plan.svg?${q}`;
    a.download = `${this.level || "plan"}_${this.sheet}.svg`;
  }

  fit() {
    const w = this.img.naturalWidth, h = this.img.naturalHeight;
    if (!w || !h) return;
    const r = this.stage.getBoundingClientRect();
    const k = Math.min((r.width - 32) / w, (r.height - 40) / h);
    this.view = { k, x: (r.width - w * k) / 2, y: (r.height - h * k) / 2 };
    this.apply();
  }

  /** Zoom by `f` around a stage point (default: the centre). */
  zoomAt(f, sx, sy) {
    const r = this.stage.getBoundingClientRect();
    sx ??= r.width / 2;
    sy ??= r.height / 2;
    const v = this.view;
    const k = Math.min(8, Math.max(0.1, v.k * f));
    const g = k / v.k;
    this.view = { k, x: sx - (sx - v.x) * g, y: sy - (sy - v.y) * g };
    this.apply();
  }

  apply() {
    const { x, y, k } = this.view;
    // size the <img> instead of scaling it so the SVG is re-rasterised crisp at every zoom
    this.img.style.width = `${this.img.naturalWidth * k}px`;
    this.img.style.height = `${this.img.naturalHeight * k}px`;
    this.img.style.transform = `translate(${x}px, ${y}px)`;
  }

  #bindPanZoom() {
    let drag = null;
    this.stage.addEventListener("pointerdown", (e) => {
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y };
      this.stage.setPointerCapture(e.pointerId);
      this.stage.classList.add("dragging");
    });
    this.stage.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      this.view.x = drag.vx + e.clientX - drag.x;
      this.view.y = drag.vy + e.clientY - drag.y;
      this.apply();
    });
    const end = () => {
      drag = null;
      this.stage.classList.remove("dragging");
    };
    this.stage.addEventListener("pointerup", end);
    this.stage.addEventListener("pointercancel", end);
    this.stage.addEventListener("dblclick", (e) => {
      const r = this.stage.getBoundingClientRect();
      this.zoomAt(e.shiftKey ? 0.5 : 2, e.clientX - r.left, e.clientY - r.top);
    });
    this.stage.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const r = this.stage.getBoundingClientRect();
        if (e.ctrlKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) this.zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top);
        else {
          this.view.x -= e.deltaX;
          this.apply();
        }
      },
      { passive: false },
    );
  }
}
