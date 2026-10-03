/**
 * Air-conditioning sheet symbols, drawn from the HVAC design (Compiled.hvac): ducts at their real width, supply
 * diffusers (square with diagonals), return grilles (square with bars), the riser / shaft, thermostats, wall splits
 * and the roof units' outlines.
 */
import type { Duct, HvacUnit, Terminal } from "../elements/hvac.js";
import { v2, type Vec2 } from "../geometry/math.js";

export const AC = { supply: "#2f6fc1", supplyFill: "#d9e7f8", ret: "#2e8b67", retFill: "#dcefe6", shaft: "#555555", unit: "#8a4fbf" };

const f1 = (v: number) => v.toFixed(1);
const pt = (p: Vec2) => `${f1(p[0])},${f1(p[1])}`;

/** A duct run: a band as wide as the duct (S px per metre), supply solid, return dashed outline. */
export function ductSVG(d: Duct, T: (p: Vec2) => Vec2, S: number): string {
  const w = Math.max(3, d.w * S);
  const pts = d.pts.map(T).map(pt).join(" ");
  const color = d.kind === "supply" ? AC.supply : AC.ret;
  const fill = d.kind === "supply" ? AC.supplyFill : AC.retFill;
  return (
    `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="${f1(w + 1.6)}" stroke-linejoin="miter" stroke-linecap="square"${d.kind === "return" ? ` stroke-dasharray="${f1(w * 0.9)} ${f1(w * 0.45)}"` : ""} opacity="0.9"/>` +
    `<polyline points="${pts}" fill="none" stroke="${fill}" stroke-width="${f1(w)}" stroke-linejoin="miter" stroke-linecap="square"/>`
  );
}

/** Supply diffuser (square, 4-way diagonals) or return grille (square, bars). `r` = half size in px. */
export function terminalSVG(t: Pick<Terminal, "kind" | "at">, T: (p: Vec2) => Vec2, r: number): string {
  const [x, y] = T(t.at);
  const color = t.kind === "supply" ? AC.supply : AC.ret;
  const sq = `<rect x="${f1(x - r)}" y="${f1(y - r)}" width="${f1(2 * r)}" height="${f1(2 * r)}" fill="#ffffff" stroke="${color}" stroke-width="1.3"/>`;
  if (t.kind === "supply")
    return sq + `<path d="M ${f1(x - r)} ${f1(y - r)} L ${f1(x + r)} ${f1(y + r)} M ${f1(x + r)} ${f1(y - r)} L ${f1(x - r)} ${f1(y + r)}" stroke="${color}" stroke-width="1"/>`;
  let bars = "";
  for (let k = 1; k < 4; k++) bars += `<line x1="${f1(x - r)}" y1="${f1(y - r + (k * r) / 2)}" x2="${f1(x + r)}" y2="${f1(y - r + (k * r) / 2)}" stroke="${color}" stroke-width="1"/>`;
  return sq + bars;
}

/** The riser: a hatched square of the shaft size. */
export function shaftSVG(at: Vec2, size: number, T: (p: Vec2) => Vec2, S: number): string {
  const [x, y] = T(at);
  const h = Math.max(6, (size * S) / 2);
  return (
    `<rect x="${f1(x - h)}" y="${f1(y - h)}" width="${f1(2 * h)}" height="${f1(2 * h)}" fill="#efefef" stroke="${AC.shaft}" stroke-width="1.6"/>` +
    `<path d="M ${f1(x - h)} ${f1(y - h)} L ${f1(x + h)} ${f1(y + h)} M ${f1(x + h)} ${f1(y - h)} L ${f1(x - h)} ${f1(y + h)}" stroke="${AC.shaft}" stroke-width="1"/>`
  );
}

export function thermostatSVG(at: Vec2, T: (p: Vec2) => Vec2, r: number): string {
  const [x, y] = T(at);
  return `<circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(r)}" fill="#ffffff" stroke="${AC.unit}" stroke-width="1.3"/><text x="${f1(x)}" y="${f1(y + r * 0.42)}" font-size="${f1(r * 1.25)}" font-weight="bold" fill="${AC.unit}" text-anchor="middle">T</text>`;
}

/** Wall split indoor unit: a bar along the wall with the air arrow into the room. */
export function splitSVG(at: Vec2, dir: Vec2, T: (p: Vec2) => Vec2, S: number): string {
  const along: Vec2 = [-dir[1], dir[0]];
  const a = T(v2.add(at, v2.scale(along, -0.45))), b = T(v2.add(at, v2.scale(along, 0.45)));
  const c = T(v2.add(at, v2.scale(dir, 0.1))), tip = T(v2.add(at, v2.scale(dir, 0.6)));
  const w = Math.max(4, 0.2 * S);
  return (
    `<line x1="${f1(a[0])}" y1="${f1(a[1])}" x2="${f1(b[0])}" y2="${f1(b[1])}" stroke="${AC.unit}" stroke-width="${f1(w)}"/>` +
    `<line x1="${f1(c[0])}" y1="${f1(c[1])}" x2="${f1(tip[0])}" y2="${f1(tip[1])}" stroke="${AC.supply}" stroke-width="1.3" marker-end="url(#arrow)"/>`
  );
}

/** A roof unit's outline (on the top floor's sheet: dashed, it sits on the roof above). */
export function roofUnitSVG(u: HvacUnit, T: (p: Vec2) => Vec2): string {
  if (!u.footprint) return "";
  return `<polygon points="${u.footprint.map(T).map(pt).join(" ")}" fill="#f3ecfa" fill-opacity="0.7" stroke="${AC.unit}" stroke-width="1.6" stroke-dasharray="7 4"/>`;
}
