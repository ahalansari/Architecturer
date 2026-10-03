/**
 * Helpers for the plan's lighting and finishes sheets: fixture positions read back from the built scene,
 * light symbols, room illuminance estimates, material tones and SVG floor-pattern fills.
 */
import type { LevelInfo } from "../build.js";
import type { LightInfo } from "../elements/lighting.js";
import { m4, pointInPolygon, polygonArea, v2, type Mat4, type Vec2 } from "../geometry/math.js";
import { nodeLocalMatrix, type SceneNode } from "../geometry/scene.js";
import { resolveMaterial } from "../materials/library.js";
import type { MaterialDef } from "../materials/types.js";
import { texturesFor, type Compiled } from "../pipeline.js";
import type { Level } from "../schema/schema.js";

// ---------------------------------------------------------------------------------------------
// lights

export interface PlanFixture {
  id?: string;
  /** Fixture type (pendant, downlight...) or the furniture type for lamps. */
  type: string;
  lamp: boolean;
  at: Vec2;
  rotZ: number;
  lumens: number;
  kelvin?: number;
  /** Plan positions + lumens of the emitters (track heads, strip segments, lamp bulbs). */
  heads: { at: Vec2; lumens: number }[];
  /** strip / track path. */
  points?: Vec2[];
}

/** Light fixtures and lamps of a level as built (grids expanded, sconces snapped onto walls). */
export function levelFixtures(c: Compiled, lv: Level): PlanFixture[] {
  const lvNode = c.root?.children.find((n) => n.kind === "level" && n.extras?.id === lv.id);
  if (!lvNode) return [];
  const out: PlanFixture[] = [];
  // strip / track fixtures come out in spec order, one per spec with a path
  const paths = (lv.lights ?? []).filter((s) => (s.type === "strip" || s.type === "track") && s.points).map((s) => s.points as Vec2[]);
  const walk = (n: SceneNode, parent: Mat4, owner: PlanFixture | undefined) => {
    const world = n.translation || n.rotationZ ? m4.mul(parent, nodeLocalMatrix(n)) : parent;
    const o = m4.point(world, [0, 0, 0]);
    let own = owner;
    if (n.kind === "light_fixture") {
      const type = String(n.extras?.fixture ?? "ceiling");
      own = { id: n.extras?.id as string | undefined, type, lamp: false, at: [o[0], o[1]], rotZ: n.rotationZ ?? 0, lumens: Number(n.extras?.lumens ?? 0), kelvin: n.extras?.kelvin as number | undefined, heads: [] };
      if (type === "strip" || type === "track") own.points = paths.shift();
      out.push(own);
    } else if (n.kind === "furniture" && n.extras?.lumens !== undefined) {
      own = { id: n.extras?.id as string | undefined, type: String(n.extras?.type ?? "lamp"), lamp: true, at: [o[0], o[1]], rotZ: n.rotationZ ?? 0, lumens: Number(n.extras.lumens), kelvin: n.extras?.kelvin as number | undefined, heads: [] };
      out.push(own);
    } else if (n.kind === "light" && own) {
      own.heads.push({ at: [o[0], o[1]], lumens: (n.extras?.light as LightInfo | undefined)?.lumens ?? 0 });
    }
    for (const ch of n.children) walk(ch, world, own);
  };
  walk(lvNode, m4.identity(), undefined);
  return out;
}

/** Rough average illuminance: lumens of the emitters inside the room × utilisation factor / floor area. */
export const UTILISATION = 0.5;
export function roomLux(poly: Vec2[], fixtures: PlanFixture[]): { lux: number; lumens: number } {
  let lumens = 0;
  for (const f of fixtures) for (const h of f.heads) if (pointInPolygon(h.at, poly)) lumens += h.lumens;
  const area = polygonArea(poly);
  return { lumens, lux: area > 0 ? (lumens * UTILISATION) / area : 0 };
}

/** Floor tint by illuminance band (dim blue-grey → warm yellow). */
export const LUX_BANDS: { max: number; fill: string; label: string }[] = [
  { max: 50, fill: "#e6e9ef", label: "< 50 lx" },
  { max: 150, fill: "#f4f0de", label: "50–150 lx" },
  { max: 300, fill: "#fbefbc", label: "150–300 lx" },
  { max: 500, fill: "#fde58a", label: "300–500 lx" },
  { max: Infinity, fill: "#fdd65a", label: "> 500 lx" },
];
export const luxFill = (lux: number) => LUX_BANDS.find((b) => lux < b.max)!.fill;

const AMBER = "#f2b632", AMBER_DARK = "#9a6400";

/**
 * SVG for one fixture symbol. `T` maps plan → px, `r` is the symbol radius in px.
 * Conventional lighting-plan glyphs: downlight ⊙, pendant ●, chandelier ✳, ceiling ⊗, sconce half-disc on the wall,
 * spot ◎ with aim tick, uplight △, strip dashed line, track rail with heads, lamps ○ with rays.
 */
export function lightSymbol(f: PlanFixture, T: (p: Vec2) => Vec2, r: number, S: number): string {
  const [x, y] = T(f.at);
  const n = (v: number) => v.toFixed(1);
  const sw = Math.max(0.8, r * 0.16);
  const ring = (rr: number, fill: string, w = sw) => `<circle cx="${n(x)}" cy="${n(y)}" r="${n(rr)}" fill="${fill}" stroke="${AMBER_DARK}" stroke-width="${n(w)}"/>`;
  switch (f.type) {
    case "downlight":
      return ring(r * 0.75, "#ffffff") + ring(r * 0.35, AMBER, 0);
    case "spot":
      return ring(r * 0.7, "#ffffff") + ring(r * 0.3, AMBER, 0) + `<line x1="${n(x)}" y1="${n(y - r * 0.7)}" x2="${n(x)}" y2="${n(y - r * 1.15)}" stroke="${AMBER_DARK}" stroke-width="${n(sw)}"/>`;
    case "pendant":
      return ring(r, AMBER) + `<circle cx="${n(x)}" cy="${n(y)}" r="${n(r * 0.25)}" fill="${AMBER_DARK}"/>`;
    case "chandelier": {
      let rays = "";
      for (let k = 0; k < 8; k++) {
        const a = (k * Math.PI) / 4;
        rays += `<line x1="${n(x + Math.cos(a) * r * 0.55)}" y1="${n(y + Math.sin(a) * r * 0.55)}" x2="${n(x + Math.cos(a) * r * 1.35)}" y2="${n(y + Math.sin(a) * r * 1.35)}" stroke="${AMBER_DARK}" stroke-width="${n(sw)}"/>`;
      }
      return rays + ring(r * 0.55, AMBER);
    }
    case "ceiling": {
      const d = r * 0.7;
      return ring(r, "#fff6dc") + `<path d="M ${n(x - d)} ${n(y - d)} L ${n(x + d)} ${n(y + d)} M ${n(x + d)} ${n(y - d)} L ${n(x - d)} ${n(y + d)}" stroke="${AMBER_DARK}" stroke-width="${n(sw)}"/>`;
    }
    case "wall_sconce": {
      // half disc on the wall face, bulging into the room (fixture local +y)
      const fwd = v2.rotate([0, 1], f.rotZ), side = v2.rotate([1, 0], f.rotZ);
      const rm = r / S;
      const a = T(v2.add(f.at, v2.scale(side, rm))), b = T(v2.sub(f.at, v2.scale(side, rm))), tip = T(v2.add(f.at, v2.scale(fwd, rm)));
      // sweep so the arc passes through the tip
      const cross = (a[0] - x) * (tip[1] - y) - (a[1] - y) * (tip[0] - x);
      return `<path d="M ${n(a[0])} ${n(a[1])} A ${n(r)} ${n(r)} 0 0 ${cross > 0 ? 1 : 0} ${n(b[0])} ${n(b[1])} Z" fill="${AMBER}" stroke="${AMBER_DARK}" stroke-width="${n(sw)}"/>`;
    }
    case "uplight": {
      const h = r * 0.9;
      return `<polygon points="${n(x)},${n(y - h)} ${n(x + h)},${n(y + h * 0.7)} ${n(x - h)},${n(y + h * 0.7)}" fill="#ffffff" stroke="${AMBER_DARK}" stroke-width="${n(sw)}"/>` + ring(r * 0.25, AMBER, 0);
    }
    case "strip": {
      const pts = (f.points ?? [f.at]).map(T).map((p) => `${n(p[0])},${n(p[1])}`).join(" ");
      return `<polyline points="${pts}" fill="none" stroke="${AMBER}" stroke-width="${n(Math.max(2.5, r * 0.5))}" stroke-dasharray="${n(r * 0.9)} ${n(r * 0.45)}" stroke-linecap="round"/>`;
    }
    case "track": {
      const pts = (f.points ?? [f.at]).map(T).map((p) => `${n(p[0])},${n(p[1])}`).join(" ");
      let s = `<polyline points="${pts}" fill="none" stroke="#444" stroke-width="${n(Math.max(2, r * 0.3))}" stroke-linecap="round"/>`;
      for (const h of f.heads) {
        const p = T(h.at);
        s += `<circle cx="${n(p[0])}" cy="${n(p[1])}" r="${n(r * 0.45)}" fill="${AMBER}" stroke="${AMBER_DARK}" stroke-width="${n(sw)}"/>`;
      }
      return s;
    }
    default: {
      // lamps (floor / table / post) and anything unknown: small circle with four rays
      const d0 = r * 0.5, d1 = r * 0.95;
      let rays = "";
      for (let k = 0; k < 4; k++) {
        const a = Math.PI / 4 + (k * Math.PI) / 2;
        rays += `<line x1="${n(x + Math.cos(a) * d0)}" y1="${n(y + Math.sin(a) * d0)}" x2="${n(x + Math.cos(a) * d1)}" y2="${n(y + Math.sin(a) * d1)}" stroke="${AMBER_DARK}" stroke-width="${n(sw)}"/>`;
      }
      return rays + ring(r * 0.45, AMBER);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// materials

export interface Tone {
  def: MaterialDef;
  /** Average texture colour × tint (#rrggbb). */
  fill: string;
  /** Darker line colour for the pattern / outline. */
  line: string;
}

const hex = (c: number[]) => "#" + c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("");

export function materialTone(c: Compiled, name: string, cache = new Map<string, Tone>()): Tone {
  let t = cache.get(name);
  if (t) return t;
  let def = c.materials.get(name);
  if (!def) {
    try {
      def = resolveMaterial(name, (c.project?.materials ?? {}) as never);
    } catch {
      def = { name, pattern: "none", color: [0.8, 0.8, 0.8], roughness: 1, metalness: 0, scale: 1, opacity: 1, normalStrength: 1 };
    }
  }
  let rgb: number[] = [...def.color];
  const tex = texturesFor(def, 32);
  if (tex) {
    const sum = [0, 0, 0];
    const px = tex.baseColor.length / 4;
    for (let i = 0; i < tex.baseColor.length; i += 4) for (let k = 0; k < 3; k++) sum[k] += tex.baseColor[i + k];
    rgb = sum.map((s, k) => (s / px / 255) * def!.color[k]);
  }
  // plan fills read better slightly lifted toward white; lines are a darker shade of the same hue
  const fill = rgb.map((v) => v * 0.85 + 0.15);
  const lum = 0.3 * rgb[0] + 0.59 * rgb[1] + 0.11 * rgb[2];
  const line = rgb.map((v) => v * (lum > 0.5 ? 0.62 : 0.5));
  t = { def, fill: hex(fill), line: hex(lum < 0.15 ? fill.map((v) => Math.min(1, v + 0.3)) : line) };
  cache.set(name, t);
  return t;
}

/** Human label for a material name: "wood_floor_oak" → "wood floor oak". */
export const materialLabel = (name: string) => (name.startsWith("#") ? name : name.replace(/_/g, " "));

/**
 * `<pattern>` filling a floor with its material drawn to scale: planks, herringbone, parquet, tile grids,
 * hex tiles, speckle for terrazzo/stone, fine dots for carpet. `S` = px per meter.
 */
export function floorPattern(id: string, tone: Tone, S: number): string {
  const p = tone.def.pattern;
  const st = `stroke="${tone.line}" stroke-width="0.8" fill="none"`;
  const size = (m: number, min = 5) => Math.max(min, m * S);
  const pat = (w: number, h: number, body: string, rot = 0) =>
    `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${w.toFixed(2)}" height="${h.toFixed(2)}"${rot ? ` patternTransform="rotate(${rot})"` : ""}><rect width="${w.toFixed(2)}" height="${h.toFixed(2)}" fill="${tone.fill}"/>${body}</pattern>`;
  const f = (v: number) => v.toFixed(2);
  switch (p) {
    case "wood_planks":
    case "wood_grain":
    case "siding": {
      const h = size(0.16, 4), w = size(1.2, 30);
      // two rows of boards with staggered end joints
      return pat(w, h * 2, `<path d="M 0 ${f(h)} H ${f(w)} M 0 ${f(h * 2)} H ${f(w)} M ${f(w * 0.3)} 0 V ${f(h)} M ${f(w * 0.8)} ${f(h)} V ${f(h * 2)}" ${st}/>`);
    }
    case "herringbone":
    case "chevron": {
      const w = size(0.35, 10), h = w / 2;
      return pat(w, h, `<path d="M 0 ${f(h)} L ${f(w / 2)} 0 L ${f(w)} ${f(h)}" ${st}/><path d="M 0 0 L ${f(w / 2)} ${f(-h)} M ${f(w / 2)} ${f(h * 2)} L ${f(w)} ${f(h)}" ${st}/>`);
    }
    case "parquet": {
      const c = size(0.3, 8), q = c / 3;
      // basket weave: alternate cells of three horizontal / vertical slats
      return pat(c * 2, c * 2,
        `<rect x="0" y="0" width="${f(c * 2)}" height="${f(c * 2)}" ${st}/>` +
          `<path d="M 0 ${f(q)} H ${f(c)} M 0 ${f(q * 2)} H ${f(c)} M ${f(c + q)} 0 V ${f(c)} M ${f(c + q * 2)} 0 V ${f(c)}` +
          ` M ${f(q)} ${f(c)} V ${f(c * 2)} M ${f(q * 2)} ${f(c)} V ${f(c * 2)} M ${f(c)} ${f(c + q)} H ${f(c * 2)} M ${f(c)} ${f(c + q * 2)} H ${f(c * 2)}` +
          ` M ${f(c)} 0 V ${f(c * 2)} M 0 ${f(c)} H ${f(c * 2)}" ${st}/>`);
    }
    case "tiles":
    case "paving":
    case "stone": {
      const c = size(p === "tiles" ? 0.6 : 0.5, 8);
      return pat(c, c, `<path d="M 0 0 H ${f(c)} M 0 0 V ${f(c)}" ${st}/>`);
    }
    case "mosaic":
    case "zellige": {
      const c = size(p === "mosaic" ? 0.1 : 0.12, 5);
      return pat(c, c, `<path d="M 0 0 H ${f(c)} M 0 0 V ${f(c)}" stroke="${tone.line}" stroke-width="0.5" fill="none"/>`);
    }
    case "hex_tiles": {
      const r = size(0.12, 5), w = r * Math.sqrt(3), h = r * 3;
      const hx = (cx: number, cy: number) => {
        let d = "";
        for (let k = 0; k < 6; k++) {
          const a = Math.PI / 6 + (k * Math.PI) / 3;
          d += `${k ? "L" : "M"} ${f(cx + Math.cos(a) * r)} ${f(cy + Math.sin(a) * r)} `;
        }
        return d + "Z ";
      };
      return pat(w, h, `<path d="${hx(0, 0)}${hx(w, 0)}${hx(w / 2, h / 2)}${hx(0, h)}${hx(w, h)}" ${st}/>`);
    }
    case "marble": {
      const c = size(1.2, 40);
      return pat(c, c, `<path d="M 0 ${f(c * 0.2)} C ${f(c * 0.3)} ${f(c * 0.35)}, ${f(c * 0.55)} ${f(c * 0.1)}, ${f(c)} ${f(c * 0.45)} M ${f(c * 0.1)} ${f(c)} C ${f(c * 0.35)} ${f(c * 0.75)}, ${f(c * 0.6)} ${f(c * 0.85)}, ${f(c * 0.9)} ${f(c * 0.6)}" stroke="${tone.line}" stroke-width="0.6" fill="none" opacity="0.7"/>`);
    }
    case "terrazzo":
    case "gravel":
    case "concrete":
    case "microcement": {
      const c = size(0.4, 12);
      const dots = [[0.15, 0.2, 0.9], [0.6, 0.12, 0.6], [0.4, 0.55, 1.1], [0.82, 0.7, 0.7], [0.2, 0.85, 0.6], [0.7, 0.4, 0.5]];
      const big = p === "terrazzo" || p === "gravel";
      return pat(c, c, dots.map(([x, y, r]) => `<circle cx="${f(x * c)}" cy="${f(y * c)}" r="${f(r * (big ? 1.2 : 0.6))}" fill="${tone.line}" opacity="${big ? 0.8 : 0.4}"/>`).join(""));
    }
    case "carpet":
    case "fabric":
    case "grasscloth": {
      const c = 4;
      return pat(c, c, `<circle cx="1" cy="1" r="0.5" fill="${tone.line}" opacity="0.45"/><circle cx="3" cy="3" r="0.5" fill="${tone.line}" opacity="0.45"/>`);
    }
    default:
      return pat(10, 10, "");
  }
}

// ---------------------------------------------------------------------------------------------
// wall finish bands

export interface FinishBand {
  /** Band centreline in plan (inside the room, along the wall face). */
  a: Vec2;
  b: Vec2;
  material: string;
  /** Accent wall (drawn bolder). */
  accent: boolean;
  /** Accent only for a height band (e.g. a backsplash). */
  partial: boolean;
  /** Wainscot / tiled lower band material, drawn as a thin strip against the wall. */
  wainscot?: string;
  /** Inward unit normal. */
  inward: Vec2;
  /** Wall face offset from the room edge (m). */
  face: number;
}

const compass = (n: Vec2): "north" | "south" | "east" | "west" =>
  Math.abs(n[0]) > Math.abs(n[1]) ? (n[0] > 0 ? "east" : "west") : n[1] > 0 ? "north" : "south";

/**
 * Bands along the inside wall faces of a room, one per wall-backed stretch of each polygon edge,
 * interrupted at openings. Open edges (no wall on them) get no band.
 */
export function roomFinishBands(room: Level["rooms"][number], info: LevelInfo, defaultWall: string, bandW: number): FinishBand[] {
  const fin = room.finishes;
  let pg = room.polygon as Vec2[];
  let area2 = 0;
  for (let i = 0; i < pg.length; i++) area2 += v2.cross(pg[i], pg[(i + 1) % pg.length]);
  if (area2 < 0) pg = [...pg].reverse();
  const out: FinishBand[] = [];
  for (let i = 0; i < pg.length; i++) {
    const a = pg[i], b = pg[(i + 1) % pg.length];
    const len = v2.dist(a, b);
    if (len < 0.05) continue;
    const d = v2.scale(v2.sub(b, a), 1 / len);
    const inward = v2.perp(d);
    // wall segments lying on this edge (collinear centreline or face)
    const segs = info.segments.filter((s) => {
      const sd = v2.sub(s.b, s.a);
      const sl = v2.len(sd);
      if (sl < 1e-3 || Math.abs(v2.cross(v2.scale(sd, 1 / sl), d)) > 0.02) return false;
      const off = Math.abs(v2.cross(d, v2.sub(s.a, a)));
      if (off > s.thickness / 2 + 0.03) return false;
      const t0 = v2.dot(v2.sub(s.a, a), d), t1 = v2.dot(v2.sub(s.b, a), d);
      return Math.max(t0, t1) > 0.02 && Math.min(t0, t1) < len - 0.02;
    });
    if (!segs.length) continue;
    // covered intervals along the edge, minus openings
    let iv: [number, number][] = segs.map((s) => {
      const t0 = v2.dot(v2.sub(s.a, a), d), t1 = v2.dot(v2.sub(s.b, a), d);
      return [Math.max(0, Math.min(t0, t1)), Math.min(len, Math.max(t0, t1))] as [number, number];
    });
    for (const o of info.openings) {
      if (!segs.includes(o.seg)) continue;
      const sd = v2.norm(v2.sub(o.seg.b, o.seg.a));
      const mid = v2.add(o.seg.a, v2.scale(sd, o.u));
      const tm = v2.dot(v2.sub(mid, a), d);
      const c0 = tm - o.width / 2, c1 = tm + o.width / 2;
      iv = iv.flatMap(([s0, s1]) => [[s0, Math.min(s1, c0)], [Math.max(s0, c1), s1]] as [number, number][]).filter(([s0, s1]) => s1 - s0 > 0.05);
    }
    const thick = Math.max(...segs.map((s) => s.thickness));
    const wallIds = new Set(segs.map((s) => s.wallId));
    const side = compass(v2.scale(inward, -1));
    const acc = fin?.accents.find((x) => (x.wall && wallIds.has(x.wall)) || (!x.wall && x.side === side));
    const material = acc?.material ?? fin?.walls ?? segs[0][v2.cross(v2.sub(segs[0].b, segs[0].a), inward) > 0 ? "matLeft" : "matRight"] ?? defaultWall;
    const face = thick / 2;
    const inset = face; // keep clear of the perpendicular walls at the corners
    for (const [s0, s1] of iv) {
      const u0 = Math.max(s0, inset), u1 = Math.min(s1, len - inset);
      if (u1 - u0 < 0.05) continue;
      const shift = v2.scale(inward, face + bandW / 2);
      out.push({
        a: v2.add(v2.add(a, v2.scale(d, u0)), shift),
        b: v2.add(v2.add(a, v2.scale(d, u1)), shift),
        material,
        accent: !!acc,
        partial: !!acc && (acc.from !== undefined || acc.to !== undefined),
        wainscot: fin?.wainscot?.material,
        inward,
        face,
      });
    }
  }
  return out;
}

