// Contracts panel: generate a bilingual works contract for a trade package and download it (Word / print to PDF).
const $ = (id) => document.getElementById(id);

const MODE = { labour: "labour only", supply: "supply & install" };
let packages = [];
let mode = "labour";

function setMode(m) {
  mode = m;
  document.querySelectorAll("#ctMode button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.mode === m)));
}

function syncModes() {
  const p = packages.find((x) => x.id === $("ctPackage").value);
  if (!p) return;
  document.querySelectorAll("#ctMode button").forEach((b) => (b.disabled = !p.modes.includes(b.dataset.mode)));
  if (!p.modes.includes(mode)) setMode(p.modes[0]);
}

function render(files) {
  const list = $("ctList");
  list.replaceChildren();
  const groups = new Map();
  for (const f of files) {
    const k = `${f.package}-${f.mode}`;
    const g = groups.get(k) ?? { package: f.package, mode: f.mode, files: {}, modified: f.modified };
    g.files[f.ext] = f.name;
    if (f.modified > g.modified) g.modified = f.modified;
    groups.set(k, g);
  }
  const sorted = [...groups.values()].sort((a, b) => b.modified.localeCompare(a.modified));
  if (!sorted.length) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "No contracts yet.";
    list.append(li);
    return;
  }
  for (const g of sorted) {
    const p = packages.find((x) => x.id === g.package);
    const li = document.createElement("li");
    const title = document.createElement("div");
    title.textContent = `${p ? p.en.split(":")[0] : g.package} · ${MODE[g.mode]}`;
    title.title = p ? `${p.en}\n${p.ar}` : g.package;
    const links = document.createElement("div");
    links.className = "ctLinks";
    if (g.files.docx) {
      const a = document.createElement("a");
      a.href = `contracts/${encodeURIComponent(g.files.docx)}`;
      a.textContent = "Word";
      a.setAttribute("download", g.files.docx);
      links.append(a);
    }
    if (g.files.html) {
      const a = document.createElement("a");
      a.href = `contracts/${encodeURIComponent(g.files.html)}`;
      a.textContent = "Print / PDF";
      a.target = "_blank";
      links.append(a);
    }
    const when = document.createElement("span");
    when.className = "muted";
    when.textContent = new Date(g.modified).toLocaleDateString();
    links.append(when);
    li.append(title, links);
    list.append(li);
  }
}

async function refresh() {
  const r = await fetch("contracts", { cache: "no-store" });
  if (!r.ok) throw new Error(await r.text());
  const j = await r.json();
  if (!packages.length) {
    packages = j.packages;
    const sel = $("ctPackage");
    for (const p of packages) {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = p.en.split(":")[0];
      o.title = `${p.en} — ${p.ar}`;
      sel.append(o);
    }
    sel.value = packages.some((p) => p.id === "plaster") ? "plaster" : packages[0]?.id;
    syncModes();
  }
  render(j.files);
}

async function generate() {
  const btn = $("ctGenerate");
  const status = $("ctStatus");
  btn.disabled = true;
  status.textContent = "Generating… (measuring the model, writing English and Arabic)";
  try {
    const r = await fetch("contracts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ package: $("ctPackage").value, mode, contractor: $("ctContractor").value }),
    });
    const ct = r.headers.get("content-type") ?? "";
    const j = ct.includes("json") ? await r.json() : { ok: false, text: await r.text() };
    // first line: id and title; second: value, programme, retention
    status.textContent = j.ok ? j.text.split("\n").slice(0, 2).join(" — ") : `Could not generate: ${j.text}`;
    status.className = j.ok ? "muted" : "error";
    await refresh();
  } catch (e) {
    status.textContent = `Could not generate: ${e.message}`;
    status.className = "error";
  } finally {
    btn.disabled = false;
  }
}

export function initContracts() {
  if (!$("ctPackage")) return;
  document.querySelectorAll("#ctMode button").forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
  $("ctPackage").onchange = syncModes;
  $("ctGenerate").onclick = generate;
  setMode("labour");
  refresh().catch((e) => ($("ctStatus").textContent = `Contracts unavailable: ${e.message}`));
}
