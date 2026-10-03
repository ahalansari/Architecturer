/**
 * Ceiling sheets for the 2D plan, drawn from the ceiling layouts the build recorded (LevelInfo.ceilings):
 *  - reflected ceiling plan (RCP): ceiling materials, soffits, coffers, beams, coves, cornices, openings in the
 *    ceiling and the light fixtures, as seen looking up (mirrored onto the plan so it overlays the floor plan);
 *  - false ceiling plan: the suspended-ceiling setting-out: every ceiling level colour-coded and tagged (FCL above
 *    the finished floor), drops, LED coves, soffit dimensions and the void above.
 */
import type { CeilingLayout } from "../elements/finishes.js";
import { polygonArea, signedArea, v2, type Vec2 } from "../geometry/math.js";
import type { Tone } from "./plan-sheets.js";

export interface CeilDraw {
  px: (p: Vec2) => Vec2;
  /** px per meter. */
  S: number;
  fs: number;
}

const f1 = (v: number) => v.toFixed(1);
const pts = (d: CeilDraw, ps: Vec2[]) => ps.map((p) => d.px(p).map(f1).join(",")).join(" ");
const ring = (d: CeilDraw, ps: Vec2[]) => "M " + ps.map((p) => d.px(p).map(f1).join(" ")).join(" L ") + " Z";
const ccw = (ps: Vec2[]) => (signedArea(ps) < 0 ? [...ps].reverse() : ps);
export const fmtH = (h: number) => `+${h.toFixed(2)}`;

/** Ceiling levels present, highest first, each with a fill colour (highest = lightest). */
export function ceilingLevels(ceilings: CeilingLayout[]): Map<string, string> {
  const hs = new Set<number>();
  for (const c of ceilings) {
    if (c.type === "none") continue;
    hs.add(round(c.height));
    if (c.soffit) hs.add(round(c.soffit.height));
    for (const b of c.beams) hs.add(round(b.height));
  }
  const ramp = ["#ffffff", "#dcebf7", "#bcd7ef", "#98c0e4", "#79a9d6", "#5d91c6", "#4a7bb0"];
  const out = new Map<string, string>();
  [...hs].sort((a, b) => b - a).forEach((h, i) => out.set(h.toFixed(2), ramp[Math.min(i, ramp.length - 1)]));
  return out;
}
const round = (h: number) => Math.round(h * 100) / 100;
export const levelKey = (h: number) => round(h).toFixed(2);

function holesSVG(d: CeilDraw, holes: Vec2[][]): string {
  let s = "";
  for (const h of holes) {
    s += `<polygon points="${pts(d, h)}" fill="#ffffff" stroke="#555" stroke-width="1"/>`;
    // void: diagonals corner to corner of the bounding box clipped visually by the outline
    const q = h.map(d.px);
    const xs = q.map((p) => p[0]), ys = q.map((p) => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    s += `<path d="M ${f1(x0)} ${f1(y0)} L ${f1(x1)} ${f1(y1)} M ${f1(x1)} ${f1(y0)} L ${f1(x0)} ${f1(y1)}" stroke="#999" stroke-width="0.8"/>`;
  }
  return s;
}

function beamsSVG(d: CeilDraw, c: CeilingLayout, fill: (h: number, mat: string) => string, stroke: string): string {
  let s = "";
  for (const b of c.beams) {
    const dir = v2.norm(v2.sub(b.b, b.a)), n = v2.scale(v2.perp(dir), b.width / 2);
    s += `<polygon points="${pts(d, [v2.add(b.a, n), v2.add(b.b, n), v2.sub(b.b, n), v2.sub(b.a, n)])}" fill="${fill(b.height, b.material)}" stroke="${stroke}" stroke-width="0.8"/>`;
  }
  return s;
}

function coveSVG(d: CeilDraw, c: CeilingLayout): string {
  if (!c.cove) return "";
  const w = Math.max(1.6, d.S * 0.03);
  return `<polygon points="${pts(d, c.cove.line)}" fill="none" stroke="#f2b632" stroke-width="${f1(w)}" stroke-dasharray="${f1(w * 3)} ${f1(w * 1.6)}"/>`;
}

function corniceSVG(d: CeilDraw, c: CeilingLayout): string {
  if (!c.cornice || c.type === "none") return "";
  // the cornice runs around the walls (outer edge of a tray soffit sits against the walls too)
  const k = c.cornice.depth;
  const inner = offsetIn(c.outline, k);
  return inner ? `<polygon points="${pts(d, inner)}" fill="none" stroke="#8a8a8a" stroke-width="0.7"/>` : "";
}

function offsetIn(poly: Vec2[], k: number): Vec2[] | null {
  const p = ccw(poly);
  const n = p.length;
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = p[(i + n - 1) % n], b = p[i], c = p[(i + 1) % n];
    const n0 = v2.perp(v2.norm(v2.sub(b, a))), n1 = v2.perp(v2.norm(v2.sub(c, b)));
    const m = v2.norm(v2.add(n0, n1));
    const cos = v2.dot(m, n0);
    if (Math.abs(cos) < 0.2) return null;
    out.push(v2.add(b, v2.scale(m, k / cos)));
  }
  return polygonArea(out) > 0.05 ? out : null;
}

/** Reflected ceiling plan of one room: ceiling material, soffit band (hatched), beams, cove, cornice, voids. */
export function rcpRoom(d: CeilDraw, c: CeilingLayout, tone: (m: string) => Tone): string {
  if (c.type === "none") return `<polygon points="${pts(d, c.outline)}" fill="url(#hatch_open)" stroke="none"/>`;
  const t = tone(c.material!);
  let s = `<polygon points="${pts(d, c.outline)}" fill="${t.fill}" fill-opacity="0.55" stroke="none"/>`;
  if (c.soffit) {
    const st = tone(c.soffit.material);
    s += `<path d="${ring(d, ccw(c.soffit.outer))} ${ring(d, [...ccw(c.soffit.inner)].reverse())}" fill="${st.fill}" fill-opacity="0.7" fill-rule="evenodd" stroke="none"/>`;
    s += `<path d="${ring(d, ccw(c.soffit.outer))} ${ring(d, [...ccw(c.soffit.inner)].reverse())}" fill="url(#hatch_soffit)" fill-rule="evenodd" stroke="none"/>`;
    s += `<polygon points="${pts(d, c.soffit.inner)}" fill="none" stroke="#555" stroke-width="1.1"/>`;
  }
  s += beamsSVG(d, c, (_h, m) => tone(m).fill, "#6b5a45");
  s += corniceSVG(d, c);
  s += coveSVG(d, c);
  s += holesSVG(d, c.holes);
  return s;
}

/** False ceiling plan of one room: each level filled with its colour, drop edges bold, cove, soffit dimension. */
export function fcpRoom(d: CeilDraw, c: CeilingLayout, levels: Map<string, string>): { svg: string; tags: { at: Vec2; text: string }[] } {
  const tags: { at: Vec2; text: string }[] = [];
  if (c.type === "none") return { svg: `<polygon points="${pts(d, c.outline)}" fill="url(#hatch_open)" stroke="none"/>`, tags };
  const col = (h: number) => levels.get(levelKey(h)) ?? "#ffffff";
  let s = `<polygon points="${pts(d, c.outline)}" fill="${col(c.height)}" stroke="none"/>`;
  if (c.soffit) {
    s += `<path d="${ring(d, ccw(c.soffit.outer))} ${ring(d, [...ccw(c.soffit.inner)].reverse())}" fill="${col(c.soffit.height)}" fill-rule="evenodd" stroke="none"/>`;
    // drop edge: bold line where the level changes
    s += `<polygon points="${pts(d, c.soffit.inner)}" fill="none" stroke="#1d4f86" stroke-width="1.6"/>`;
    // soffit width dimension across the band on its longest edge, and its level tag beside it
    const o = ccw(c.soffit.outer);
    let bi = 0, bl = 0;
    o.forEach((p, i) => {
      const l = v2.dist(p, o[(i + 1) % o.length]);
      if (l > bl) (bl = l), (bi = i);
    });
    const a = o[bi], b = o[(bi + 1) % o.length];
    const dir = v2.norm(v2.sub(b, a)), n = v2.perp(dir);
    const m = v2.lerp(a, b, 0.5);
    s += dimension(d, m, v2.add(m, v2.scale(n, c.soffit.width)), c.soffit.width.toFixed(2));
    tags.push({ at: v2.add(v2.lerp(a, b, 0.25), v2.scale(n, c.soffit.width / 2)), text: fmtH(c.soffit.height) });
  }
  s += beamsSVG(d, c, (h) => col(h), "#1d4f86");
  if (c.beams.length) tags.push({ at: v2.lerp(c.beams[0].a, c.beams[0].b, 0.5), text: fmtH(c.beams[0].height) });
  s += coveSVG(d, c);
  s += holesSVG(d, c.holes);
  return { svg: s, tags };
}

/** Dimension line a→b with end ticks and the text along it. */
export function dimension(d: CeilDraw, a: Vec2, b: Vec2, text: string): string {
  const A = d.px(a), B = d.px(b);
  const dir = v2.norm(v2.sub(B, A)), n = v2.perp(dir);
  const t = 3.5;
  const tick = (P: Vec2) => {
    const p0 = v2.add(P, v2.scale(v2.add(dir, n), t * 0.7)), p1 = v2.sub(P, v2.scale(v2.add(dir, n), t * 0.7));
    return `M ${f1(p0[0])} ${f1(p0[1])} L ${f1(p1[0])} ${f1(p1[1])}`;
  };
  const mid = v2.lerp(A, B, 0.5);
  let ang = (Math.atan2(dir[1], dir[0]) * 180) / Math.PI;
  if (ang > 90) ang -= 180;
  if (ang < -90) ang += 180;
  const size = Math.max(8, d.fs - 4);
  const off = v2.scale(v2.perp(v2.norm([Math.cos((ang * Math.PI) / 180), Math.sin((ang * Math.PI) / 180)])), size * 0.55);
  return (
    `<path d="M ${f1(A[0])} ${f1(A[1])} L ${f1(B[0])} ${f1(B[1])} ${tick(A)} ${tick(B)}" stroke="#1d4f86" stroke-width="0.9" fill="none"/>` +
    `<text x="${f1(mid[0] + off[0])}" y="${f1(mid[1] + off[1] + size * 0.35)}" font-size="${size}" fill="#1d4f86" text-anchor="middle" transform="rotate(${ang.toFixed(1)} ${f1(mid[0] + off[0])} ${f1(mid[1] + off[1])})" stroke="#ffffff" stroke-width="2.5" paint-order="stroke">${text}</text>`
  );
}

/** Small level tag: rounded box with the height. */
export function levelTag(d: CeilDraw, at: Vec2, text: string, fill = "#ffffff"): string {
  const [x, y] = d.px(at);
  const size = Math.max(8, d.fs - 4);
  const w = text.length * size * 0.58 + 6, h = size + 4;
  return `<rect x="${f1(x - w / 2)}" y="${f1(y - h / 2)}" width="${f1(w)}" height="${f1(h)}" rx="3" fill="${fill}" stroke="#1d4f86" stroke-width="0.8"/><text x="${f1(x)}" y="${f1(y + size * 0.36)}" font-size="${size}" font-weight="bold" fill="#1d4f86" text-anchor="middle">${text}</text>`;
}

/**
 * Typical section through a tray ceiling for the legend: slab, void with hangers, soffit drop, cove and the main
 * ceiling, annotated with this project's numbers. Drawn `w` px wide from (x, y); returns the svg and its height.
 */
export function traySection(x: number, y: number, w: number, c: CeilingLayout): { svg: string; height: number } {
  const so = c.soffit!;
  const k = 90; // px per meter vertically (schematic horizontally)
  const voidM = Math.max(0, c.structure - c.height), drop = c.height - so.height;
  const slabT = y + 4, slabB = slabT + 12;
  const yMain = slabB + (voidM > 0.005 ? Math.max(16, voidM * k) : 0);
  const ySoffit = yMain + Math.max(16, drop * k);
  const wallX = x + 10, stepX = wallX + w * 0.4, right = x + w - 4;
  const s: string[] = [];
  s.push(`<rect x="${x}" y="${slabT}" width="10" height="${f1(ySoffit + 30 - slabT)}" fill="#3a3a3a"/>`);
  s.push(`<rect x="${wallX}" y="${slabT}" width="${f1(right - wallX)}" height="12" fill="url(#hatch_slab)" stroke="#555" stroke-width="0.8"/>`);
  // hangers in the void
  for (const hx of [wallX + (stepX - wallX) * 0.5, stepX + (right - stepX) * 0.55])
    s.push(`<line x1="${f1(hx)}" y1="${slabB}" x2="${f1(hx)}" y2="${f1(hx < stepX ? ySoffit - 4 : yMain)}" stroke="#888" stroke-width="0.8" stroke-dasharray="2 2"/>`);
  // soffit box (board line + framing) and the main ceiling
  s.push(`<path d="M ${wallX} ${f1(ySoffit)} H ${f1(stepX)} V ${f1(yMain + 6)}" stroke="#1d4f86" stroke-width="2" fill="none"/>`);
  s.push(`<path d="M ${f1(stepX + 7)} ${f1(yMain)} H ${f1(right)}" stroke="#1d4f86" stroke-width="2" fill="none"/>`);
  if (c.cove) s.push(`<circle cx="${f1(stepX + 2.5)}" cy="${f1(yMain + 3)}" r="2.6" fill="#f2b632" stroke="#9a6400" stroke-width="0.6"/>`);
  const t = (tx: number, ty: number, str: string, anchor = "start", bold = false) =>
    s.push(`<text x="${f1(tx)}" y="${f1(ty)}" font-size="9"${bold ? ' font-weight="bold"' : ""} fill="#1d4f86" text-anchor="${anchor}">${str}</text>`);
  t(right, yMain + 12, `FCL ${fmtH(c.height)}`, "end", true);
  t(wallX + 3, ySoffit + 11, `soffit ${fmtH(so.height)}`, "start", true);
  t(wallX + 3, ySoffit + 21, `${so.width.toFixed(2)} m wide, drop ${drop.toFixed(2)}`);
  if (voidM > 0.005) t(right, slabB + (yMain - slabB) / 2 + 3, `void ${voidM.toFixed(2)} m`, "end");
  else t(right, slabB + 10 + 12, "fixed to the slab", "end");
  if (c.cove) t(stepX + 8, voidM > 0.005 ? yMain - 3 : yMain + 22, "LED cove");
  return { svg: s.join(""), height: ySoffit + 30 - y };
}
