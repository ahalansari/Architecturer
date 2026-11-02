/**
 * Large projects (hospitals, airports, campuses: hundreds of thousands to millions of m²). All of it works on
 * the raw plan JSON, before compiling, so it stays cheap however big the plan is:
 *   - outline(): what is in a plan (levels, element counts, floor areas, extents) without reading it all
 *   - scopeProject(): a sub-project of some levels (plus the levels next to them, for stairs and risers), so an
 *     edit on floor 12 of a 30-floor hospital re-checks floor 12 instead of rebuilding the whole campus
 *   - massing(): the building without fit-out (furniture, services, lighting...) for site-wide views and exports
 *   - duplicateLevel() / copyElements(): repeat typical floors, wards or wings instead of re-typing them
 *   - selectElements(): one level / kind / region / page of a plan for read_project
 *   - condense(): long warning lists folded by kind, so a validation reply stays readable
 */
import { polygonArea, type Vec2 } from "./geometry/math.js";
import { ELEMENT_KINDS, type ElementKind } from "./schema/schema.js";

type Json = Record<string, any>;

/** Past either of these a plan counts as big: edits re-check only the levels they touch. */
export const BIG_PROJECT = { elements: 15_000, area: 60_000 };

export interface LevelOutline {
  id: string;
  name?: string;
  elevation: number;
  height: number;
  elements: number;
  counts: Partial<Record<ElementKind, number>>;
  /** Sum of room polygon areas, m². */
  roomArea: number;
  /** [minX, minY, maxX, maxY] over walls, rooms and slabs. */
  extent?: [number, number, number, number];
}

export interface Outline {
  name: string;
  levels: LevelOutline[];
  elements: number;
  roomArea: number;
  extent?: [number, number, number, number];
  elevators: number;
  products: number;
  big: boolean;
}

const isPt = (p: unknown): p is Vec2 => Array.isArray(p) && p.length >= 2 && typeof p[0] === "number" && typeof p[1] === "number";

/** Elevation and height of every level, with the schema's defaults (first level at 0, stacked, 3 m). */
export function levelStack(project: Json): { elevation: number; height: number }[] {
  const out: { elevation: number; height: number }[] = [];
  for (const lv of project.levels ?? []) {
    const prev = out[out.length - 1];
    const height = typeof lv?.height === "number" && lv.height > 0 ? lv.height : 3;
    const elevation = typeof lv?.elevation === "number" ? lv.elevation : prev ? prev.elevation + prev.height : 0;
    out.push({ elevation, height });
  }
  return out;
}

function grow(e: [number, number, number, number] | undefined, p: Vec2): [number, number, number, number] {
  if (!e) return [p[0], p[1], p[0], p[1]];
  return [Math.min(e[0], p[0]), Math.min(e[1], p[1]), Math.max(e[2], p[0]), Math.max(e[3], p[1])];
}

export function outline(project: Json): Outline {
  const stack = levelStack(project);
  let total = 0, area = 0;
  let extent: Outline["extent"];
  const levels = (project.levels ?? []).map((lv: Json, i: number): LevelOutline => {
    const counts: LevelOutline["counts"] = {};
    let n = 0;
    for (const k of ELEMENT_KINDS) {
      const c = Array.isArray(lv?.[k]) ? lv[k].length : 0;
      if (c) counts[k] = c;
      n += c;
    }
    let roomArea = 0;
    let ext: LevelOutline["extent"];
    for (const r of lv?.rooms ?? []) {
      if (!Array.isArray(r?.polygon) || !r.polygon.every(isPt)) continue;
      roomArea += polygonArea(r.polygon);
      for (const p of r.polygon) ext = grow(ext, p);
    }
    for (const w of lv?.walls ?? []) for (const p of Array.isArray(w?.points) ? w.points : []) if (isPt(p)) ext = grow(ext, p);
    for (const s of lv?.slabs ?? []) for (const p of Array.isArray(s?.polygon) ? s.polygon : []) if (isPt(p)) ext = grow(ext, p);
    total += n;
    area += roomArea;
    if (ext) extent = grow(grow(extent, [ext[0], ext[1]]), [ext[2], ext[3]]);
    return { id: String(lv?.id ?? `#${i}`), name: lv?.name, elevation: stack[i].elevation, height: stack[i].height, elements: n, counts, roomArea: Math.round(roomArea * 10) / 10, extent: ext };
  });
  return {
    name: String(project.name ?? "Untitled"),
    levels,
    elements: total,
    roomArea: Math.round(area),
    extent,
    elevators: Array.isArray(project.elevators) ? project.elevators.length : 0,
    products: Array.isArray(project.products) ? project.products.length : 0,
    big: total > BIG_PROJECT.elements || area > BIG_PROJECT.area,
  };
}

const fmtN = (n: number) => Math.round(n).toLocaleString("en-US");

/** The outline as text for the MCP reply. */
export function outlineText(o: Outline, bytes?: number): string {
  const ext = (e?: number[]) => (e ? `x ${e[0]}…${e[2]}, y ${e[1]}…${e[3]} (${fmtN(e[2] - e[0])} × ${fmtN(e[3] - e[1])} m)` : "empty");
  const lines = [
    `${o.name}: ${o.levels.length} level(s), ${fmtN(o.elements)} elements, ${fmtN(o.roomArea)} m² of rooms${bytes !== undefined ? `, ${(bytes / 1e6).toFixed(1)} MB` : ""}.`,
    `Extent: ${ext(o.extent)}. Elevators: ${o.elevators}. Products: ${o.products}.`,
  ];
  if (o.big)
    lines.push(
      "BIG PROJECT: edits re-check only the levels they touch (run validate for the whole plan). Read it piecewise (read_project with level / kinds / region / limit), " +
        "render_plan with `region` for close-ups, render_view / export_model with detail 'massing' or `levels` for site-wide work, and export_model split 'level' for one model per floor.",
    );
  lines.push("", "level | z | h | elements | room m² | extent | contents");
  for (const l of o.levels)
    lines.push(
      `${l.id}${l.name ? ` (${l.name})` : ""} | ${l.elevation} | ${l.height} | ${fmtN(l.elements)} | ${fmtN(l.roomArea)} | ${l.extent ? `${l.extent.join(", ")}` : "-"} | ${Object.entries(l.counts).map(([k, v]) => `${k} ${v}`).join(", ") || "-"}`,
    );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// level-scoped sub-projects

/** Fit-out that the levels next to a scoped one don't need: they are there for stairs, risers and floors. */
const FITOUT: ElementKind[] = ["furniture", "lights", "casework", "electrical", "plumbing", "gardens", "pumpPits", "screens", "pergolas", "shapes"];

export interface Scoped {
  project: Json;
  /** Index in the sub-project → index in the full plan (to translate 'levels[1]...' error paths back). */
  levelMap: number[];
  /** Levels checked in full. */
  levels: string[];
}

/**
 * A sub-project with only `ids` (and, with `neighbours`, the level below and above each, stripped of fit-out).
 * Levels keep their real elevations; lifts keep the stops that remain; manual HVAC zones keep the rooms that remain.
 */
export function scopeProject(project: Json, ids: string[], neighbours = true): Scoped {
  const all: Json[] = project.levels ?? [];
  const want = new Set(ids);
  const missing = ids.filter((id) => !all.some((l) => l?.id === id));
  if (missing.length) throw new Error(`level(s) not found: ${missing.join(", ")} (levels: ${all.map((l) => l?.id).join(", ")})`);
  const full = new Set(all.flatMap((l, i) => (want.has(l?.id) ? [i] : [])));
  const keep = new Set(full);
  if (neighbours) for (const i of full) for (const j of [i - 1, i + 1]) if (j >= 0 && j < all.length) keep.add(j);
  const stack = levelStack(project);
  const levelMap = [...keep].sort((a, b) => a - b);
  const levels = levelMap.map((i) => {
    const lv: Json = { ...all[i], elevation: stack[i].elevation, height: stack[i].height };
    if (!full.has(i)) {
      for (const k of FITOUT) if (Array.isArray(lv[k])) lv[k] = [];
      lv.services = { ...(lv.services ?? {}), auto: false };
    }
    return lv;
  });
  const kept = new Set(levels.map((l) => l.id));
  const sub: Json = { ...project, levels };
  if (Array.isArray(project.elevators))
    sub.elevators = project.elevators
      .map((e: Json) => ({ ...e, stops: (e?.stops ?? []).filter((s: Json) => kept.has(s?.level)) }))
      .filter((e: Json) => e.stops.length >= 2);
  const roomRefs = new Set(levels.flatMap((l) => (l.rooms ?? []).flatMap((r: Json) => [String(r?.name ?? "").toLowerCase(), String(r?.id ?? "").toLowerCase()])));
  if (Array.isArray(project.hvac?.zones))
    sub.hvac = {
      ...project.hvac,
      zones: project.hvac.zones
        .map((z: Json) => ({ ...z, rooms: (z?.rooms ?? []).filter((r: unknown) => roomRefs.has(String(r).toLowerCase())) }))
        .filter((z: Json) => z.rooms.length),
    };
  if (project.landscape?.controller?.level && !kept.has(project.landscape.controller.level)) sub.landscape = { ...project.landscape, controller: undefined };
  return { project: sub, levelMap, levels: levelMap.filter((i) => full.has(i)).map((i) => all[i].id) };
}

/** Rewrite 'levels[1]' in messages from a scoped compile to the full plan's index. */
export function unscopeMessage(msg: string, levelMap: number[]): string {
  return msg.replace(/levels\[(\d+)\]/g, (m, i) => (levelMap[+i] !== undefined ? `levels[${levelMap[+i]}]` : m));
}

/**
 * Massing model: walls, openings, slabs, roofs, stairs, columns, rooms (plain finishes) and lifts; no furniture,
 * lighting, casework, services, gardens irrigation or air conditioning. For whole-site views and light exports.
 */
export function massing(project: Json): Json {
  return {
    ...project,
    hvac: { ...(project.hvac ?? {}), system: "none", zones: [] },
    landscape: { ...(project.landscape ?? {}), irrigation: false },
    levels: (project.levels ?? []).map((lv: Json) => {
      const out: Json = { ...lv, services: { ...(lv.services ?? {}), auto: false, plates: false } };
      for (const k of ["furniture", "lights", "casework", "electrical", "plumbing", "pumpPits"] as const) if (Array.isArray(out[k])) out[k] = [];
      if (Array.isArray(out.rooms)) out.rooms = out.rooms.map((r: Json) => (r?.finishes ? { ...r, finishes: undefined } : r));
      if (Array.isArray(out.openings)) out.openings = out.openings.map((o: Json) => (o?.treatment ? { ...o, treatment: undefined } : o));
      return out;
    }),
  };
}

// ---------------------------------------------------------------------------
// bulk copies

/** Fields holding plan positions ([x, y], [x, y, z] or lists of them): moved by copyElements. */
const POINT_KEYS = new Set(["position", "polygon", "points", "at", "start", "path", "center", "shaft", "discharge"]);

function translate(v: unknown, d: Vec2): unknown {
  if (isPt(v)) return [v[0] + d[0], v[1] + d[1], ...v.slice(2)];
  if (Array.isArray(v) && v.every(isPt)) return v.map((p) => translate(p, d));
  return v;
}

function moveDeep(x: unknown, d: Vec2): unknown {
  if (Array.isArray(x)) return x.map((y) => moveDeep(y, d));
  if (!x || typeof x !== "object") return x;
  const out: Json = {};
  for (const [k, v] of Object.entries(x as Json)) out[k] = POINT_KEYS.has(k) ? translate(v, d) : moveDeep(v, d);
  return out;
}

function allIds(project: Json): Set<string> {
  const used = new Set<string>();
  for (const lv of project.levels ?? []) {
    if (lv?.id) used.add(lv.id);
    for (const k of ELEMENT_KINDS) for (const el of lv?.[k] ?? []) if (el?.id) used.add(el.id);
  }
  return used;
}

/** Copies of `els` with fresh ids (`<id><suffix>`, numbered on a clash); references between them follow. */
function cloneWithIds(els: { kind: ElementKind; el: Json }[], suffix: string, used: Set<string>, move?: Vec2): { kind: ElementKind; el: Json }[] {
  const map = new Map<string, string>();
  for (const { el } of els) {
    if (!el?.id) continue;
    let id = `${el.id}${suffix}`;
    for (let n = 2; used.has(id); n++) id = `${el.id}${suffix}_${n}`;
    used.add(id);
    map.set(el.id, id);
  }
  return els.map(({ kind, el }) => {
    const c = (move ? moveDeep(el, move) : structuredClone(el)) as Json;
    if (c.id) c.id = map.get(c.id);
    // references inside the copied set: an opening's wall, a switch's lights, an accent's wall
    if (typeof c.wall === "string" && map.has(c.wall)) c.wall = map.get(c.wall);
    if (Array.isArray(c.controls)) c.controls = c.controls.map((x: unknown) => (typeof x === "string" && map.has(x) ? map.get(x) : x));
    return { kind, el: c };
  });
}

const idSafe = (s: string) => s.replace(/[^A-Za-z0-9_\-.]/g, "_");

/**
 * Append copies of level `from` as new levels `ids` (stacked on top, same height): typical hospital / office /
 * hotel floors. Element ids get the new level's id as a suffix ('w1' → 'w1_L5').
 */
export function duplicateLevel(project: Json, from: string, ids: string[], names?: string[]): string {
  const src = (project.levels ?? []).find((l: Json) => l?.id === from);
  if (!src) throw new Error(`level '${from}' not found (levels: ${(project.levels ?? []).map((l: Json) => l?.id).join(", ")})`);
  const used = allIds(project);
  for (const id of ids) if (used.has(id) || !/^[A-Za-z0-9_\-.]+$/.test(id)) throw new Error(`'${id}' is already used or not a valid id`);
  ids.forEach((id, n) => {
    const lv: Json = { ...structuredClone(src), id, name: names?.[n] ?? id };
    delete lv.elevation; // stack on top of the level below
    const els = ELEMENT_KINDS.flatMap((k) => (Array.isArray(src[k]) ? src[k].map((el: Json) => ({ kind: k, el })) : []));
    for (const k of ELEMENT_KINDS) if (Array.isArray(lv[k])) lv[k] = [];
    for (const { kind, el } of cloneWithIds(els, `_${idSafe(id)}`, used)) lv[kind].push(el);
    used.add(id);
    project.levels.push(lv);
  });
  const n = ELEMENT_KINDS.reduce((a, k) => a + (Array.isArray(src[k]) ? src[k].length : 0), 0);
  return `Added level(s) ${ids.join(", ")} as copies of '${from}' (${n} elements each).`;
}

export interface Selection {
  ids?: string[];
  kinds?: string[];
  /** [minX, minY, maxX, maxY]: elements with a position / outline point inside. */
  region?: [number, number, number, number];
}

/** A point that stands for an element (its position, or the first point of its outline / path). */
function anchor(el: Json): Vec2 | undefined {
  for (const k of ["position", "at", "start", "center"]) if (isPt(el?.[k])) return el[k];
  for (const k of ["polygon", "points", "path"]) if (Array.isArray(el?.[k]) && el[k].length && el[k].every(isPt)) {
    const ps = el[k] as Vec2[];
    return [ps.reduce((a, p) => a + p[0], 0) / ps.length, ps.reduce((a, p) => a + p[1], 0) / ps.length];
  }
  return undefined;
}

function matches(kind: string, el: Json, sel: Selection): boolean {
  if (sel.kinds?.length && !sel.kinds.includes(kind)) return false;
  if (sel.ids?.length && !sel.ids.includes(el?.id)) return false;
  if (sel.region) {
    const p = anchor(el);
    const [x0, y0, x1, y1] = sel.region;
    if (!p || p[0] < x0 || p[0] > x1 || p[1] < y0 || p[1] > y1) return false;
  }
  return true;
}

/**
 * Copy elements of a level `count` times, each copy moved by `offset` more than the last (a row of wards, a
 * grid of patient rooms with two calls), optionally onto another level. Returns a message with the new ids.
 */
export function copyElements(project: Json, level: string, sel: Selection, offset: Vec2, count: number, toLevel?: string): string {
  const lv = (project.levels ?? []).find((l: Json) => l?.id === level);
  if (!lv) throw new Error(`level '${level}' not found`);
  const dest = toLevel ? (project.levels ?? []).find((l: Json) => l?.id === toLevel) : lv;
  if (!dest) throw new Error(`level '${toLevel}' not found`);
  if (!sel.ids?.length && !sel.region && !sel.kinds?.length) throw new Error("say what to copy: ids, kinds and/or region");
  const els = ELEMENT_KINDS.flatMap((k) => (Array.isArray(lv[k]) ? (lv[k] as Json[]).filter((el) => matches(k, el, sel)).map((el) => ({ kind: k, el })) : []));
  if (!els.length) throw new Error("nothing matched the selection");
  const used = allIds(project);
  let made = 0;
  for (let n = 1; n <= count; n++) {
    const d: Vec2 = [offset[0] * n, offset[1] * n];
    for (const { kind, el } of cloneWithIds(els, `_c${n}`, used, d)) {
      (dest[kind] ??= []).push(el);
      made++;
    }
  }
  return `Copied ${els.length} element(s) ${count} time(s) to level '${dest.id}' (${made} new; ids end in _c1…_c${count}).`;
}

/** Elements of a plan picked by level / kind / ids / region, paged (read_project on big plans). */
export function selectElements(project: Json, sel: Selection & { level?: string; offset?: number; limit?: number }): { items: { level: string; kind: string; element: Json }[]; total: number } {
  const all: { level: string; kind: string; element: Json }[] = [];
  for (const lv of project.levels ?? []) {
    if (sel.level && lv?.id !== sel.level) continue;
    for (const k of ELEMENT_KINDS) for (const el of lv?.[k] ?? []) if (matches(k, el, sel)) all.push({ level: lv.id, kind: k, element: el });
  }
  const off = sel.offset ?? 0;
  return { items: all.slice(off, off + (sel.limit ?? 500)), total: all.length };
}

/** The plan without its elements (settings, materials, products, level headers with counts). */
export function skeleton(project: Json): Json {
  return {
    ...project,
    levels: (project.levels ?? []).map((lv: Json) => {
      const out: Json = {};
      for (const [k, v] of Object.entries(lv ?? {})) {
        if ((ELEMENT_KINDS as readonly string[]).includes(k)) {
          if (Array.isArray(v) && v.length) out[k] = `<${v.length} ${k}>`;
        } else out[k] = v;
      }
      return out;
    }),
  };
}

// ---------------------------------------------------------------------------

/**
 * Fold a long list of messages: the first `max` as they are, the rest counted by kind (numbers, quoted names and
 * coordinates stripped), so 30,000 'room has no door' warnings read as one line with a count and an example.
 */
export function condense(msgs: string[], max: number, what: string): string[] {
  if (msgs.length <= max) return msgs;
  const kinds = new Map<string, { n: number; example: string }>();
  for (const m of msgs.slice(max)) {
    const k = m.replace(/'[^']*'/g, "'…'").replace(/\[[^\]]*\]/g, "[…]").replace(/-?\d+(\.\d+)?/g, "#");
    const e = kinds.get(k);
    if (e) e.n++;
    else kinds.set(k, { n: 1, example: m });
  }
  const rest = [...kinds.values()].sort((a, b) => b.n - a.n);
  return [
    ...msgs.slice(0, max),
    `… and ${msgs.length - max} more ${what} of ${kinds.size} kind(s):`,
    ...rest.slice(0, 15).map((k) => `  ${k.n}× like: ${k.example}`),
    ...(rest.length > 15 ? [`  … ${rest.length - 15} more kind(s)`] : []),
  ];
}
