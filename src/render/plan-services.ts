/**
 * Electrical and plumbing sheet symbols, drawn from the services layout the build recorded (LevelInfo.services).
 * Wall symbols sit on the wall face and point into the room (conventional plan symbols: sockets as half circles
 * with outlet strokes, switches as a circle with a lever and one tick per gang, triangles for data...).
 */
import type { ElecPoint, LightGroup, PipeRun, PlumbFixture, PlumbPoint } from "../elements/services.js";
import { v2, type Vec2 } from "../geometry/math.js";

export const EL = { power: "#c0392b", switch: "#222222", data: "#1f7a8c", appliance: "#7b3fa0", detector: "#555555", db: "#222222" };
export const PL = { cold: "#1f6fd1", hot: "#d0362b", waste: "#8d6e4a", soil: "#6b4423" };

const f1 = (v: number) => v.toFixed(1);
const txt = (x: number, y: number, s: string, size: number, color: string, bold = false) =>
  `<text x="${f1(x)}" y="${f1(y + size * 0.35)}" font-size="${size.toFixed(1)}"${bold ? ' font-weight="bold"' : ""} fill="${color}" text-anchor="middle">${s}</text>`;

const ABBR: Record<string, string> = { dishwasher: "DW", oven: "OV", fridge: "FR", washer: "WM", hood: "HD", heater: "WH", cooker: "C" };

/**
 * One electrical point. `T` maps plan → px; `n` (px space, unit) is the into-room direction for wall points.
 * r = symbol size in px.
 */
export function elecSymbol(e: ElecPoint, T: (p: Vec2) => Vec2, r: number): string {
  const P = T(e.at);
  const n: Vec2 = e.n ? v2.norm(v2.sub(T(v2.add(e.at, e.n)), P)) : [0, -1];
  const a: Vec2 = [-n[1], n[0]]; // along the wall
  const at = (u: number, w: number): Vec2 => v2.add(P, v2.add(v2.scale(a, u), v2.scale(n, w)));
  const pt = (q: Vec2) => `${f1(q[0])},${f1(q[1])}`;
  const sw = Math.max(0.9, r * 0.17);
  const half = (rr: number, color: string, fill = "#ffffff") => {
    const p0 = at(-rr, 0), p1 = at(rr, 0);
    const cross = (p0[0] - P[0]) * (n[1]) - (p0[1] - P[1]) * (n[0]);
    return `<path d="M ${pt(p0)} A ${f1(rr)} ${f1(rr)} 0 0 ${cross > 0 ? 1 : 0} ${pt(p1)} Z" fill="${fill}" stroke="${color}" stroke-width="${f1(sw)}"/>`;
  };
  const stroke = (p: Vec2, q: Vec2, color: string, w = sw) => `<line x1="${f1(p[0])}" y1="${f1(p[1])}" x2="${f1(q[0])}" y2="${f1(q[1])}" stroke="${color}" stroke-width="${f1(w)}"/>`;
  const box = (w: number, h: number, color: string, fill = "#ffffff") => `<polygon points="${[at(-w / 2, 0), at(w / 2, 0), at(w / 2, h), at(-w / 2, h)].map(pt).join(" ")}" fill="${fill}" stroke="${color}" stroke-width="${f1(sw)}"/>`;
  const C = at(0, r * 0.55);
  switch (e.type) {
    case "socket":
    case "double_socket":
    case "usb_socket": {
      let s = half(r * 0.8, EL.power);
      const outs = e.type === "double_socket" ? [-0.35, 0.35] : [0];
      for (const u of outs) s += stroke(at(u * r, r * 0.8 * Math.sqrt(1 - u * u)), at(u * r * 1.5, r * 1.45), EL.power);
      if (e.type === "usb_socket") s += txt(C[0], C[1], "U", r * 0.7, EL.power, true);
      return s;
    }
    case "shaver":
      return half(r * 0.8, EL.power) + txt(...at(0, r * 0.38), "S", r * 0.65, EL.power, true);
    case "switch":
    case "switch_2way":
    case "dimmer": {
      const c = at(0, r * 0.7);
      const dir = v2.norm(v2.add(n, a));
      const end = v2.add(c, v2.scale(dir, r * 1.5));
      let s = stroke(c, end, EL.switch);
      const g = e.gangs ?? 1;
      for (let k = 0; k < g; k++) {
        const base = v2.sub(end, v2.scale(dir, k * r * 0.32));
        s += stroke(base, v2.add(base, v2.scale(v2.perp(dir), -r * 0.45)), EL.switch);
      }
      if (e.type === "switch_2way") {
        const dir2 = v2.norm(v2.sub(n, a));
        s += stroke(c, v2.add(c, v2.scale(dir2, r * 1.2)), EL.switch);
      }
      if (e.type === "dimmer") s += `<path d="M ${pt(v2.add(c, v2.scale(a, -r * 0.9)))} L ${pt(v2.add(c, v2.scale(a, r * 0.9)))}" stroke="${EL.switch}" stroke-width="${f1(sw)}" marker-end="url(#arrow)"/>`;
      return s + `<circle cx="${f1(c[0])}" cy="${f1(c[1])}" r="${f1(r * 0.38)}" fill="#ffffff" stroke="${EL.switch}" stroke-width="${f1(sw)}"/>`;
    }
    case "data":
      return `<polygon points="${[at(-r * 0.7, 0), at(r * 0.7, 0), at(0, r * 1.2)].map(pt).join(" ")}" fill="#ffffff" stroke="${EL.data}" stroke-width="${f1(sw)}"/>`;
    case "tv":
      return box(r * 2, r * 1.1, EL.data) + txt(...at(0, r * 0.55), "TV", r * 0.62, EL.data, true);
    case "cooker":
      return box(r * 1.5, r * 1.3, EL.appliance) + txt(...at(0, r * 0.65), "C", r * 0.8, EL.appliance, true);
    case "spur":
      return box(r * 1.5, r * 1.3, EL.appliance) + txt(...at(0, r * 0.65), ABBR[e.label ?? ""] ?? "FS", r * 0.6, EL.appliance, true);
    case "ac":
      return box(r * 3, r * 1.1, EL.data, "#eef6f8") + txt(...at(0, r * 0.55), "AC", r * 0.62, EL.data, true);
    case "db":
      return box(r * 2.6, r * 1.2, EL.db, "#ffffff") + `<polygon points="${[at(-r * 1.3, 0), at(r * 1.3, 0), at(-r * 1.3, r * 1.2)].map(pt).join(" ")}" fill="${EL.db}"/>` + txt(...at(r * 0.55, r * 0.75), "DB", r * 0.55, EL.db, true);
    case "doorbell":
      return `<circle cx="${f1(C[0])}" cy="${f1(C[1])}" r="${f1(r * 0.5)}" fill="#ffffff" stroke="${EL.switch}" stroke-width="${f1(sw)}"/><circle cx="${f1(C[0])}" cy="${f1(C[1])}" r="${f1(r * 0.18)}" fill="${EL.switch}"/>`;
    case "fan":
      return `<circle cx="${f1(P[0])}" cy="${f1(P[1])}" r="${f1(r)}" fill="#ffffff" stroke="${EL.appliance}" stroke-width="${f1(sw)}"/>` +
        [0, 120, 240].map((deg) => {
          const t = (deg * Math.PI) / 180;
          const q = v2.add(P, [Math.cos(t) * r * 0.75, Math.sin(t) * r * 0.75]);
          return `<path d="M ${pt(P)} Q ${pt(v2.add(P, [Math.cos(t + 0.9) * r * 0.7, Math.sin(t + 0.9) * r * 0.7]))} ${pt(q)}" fill="none" stroke="${EL.appliance}" stroke-width="${f1(sw)}"/>`;
        }).join("");
    case "light_point": {
      const d = r * 0.6;
      return `<circle cx="${f1(P[0])}" cy="${f1(P[1])}" r="${f1(r * 0.85)}" fill="#ffffff" stroke="${EL.switch}" stroke-width="${f1(sw)}"/><path d="M ${f1(P[0] - d)} ${f1(P[1] - d)} L ${f1(P[0] + d)} ${f1(P[1] + d)} M ${f1(P[0] + d)} ${f1(P[1] - d)} L ${f1(P[0] - d)} ${f1(P[1] + d)}" stroke="${EL.switch}" stroke-width="${f1(sw)}"/>`;
    }
    case "smoke":
    case "heat":
      return `<circle cx="${f1(P[0])}" cy="${f1(P[1])}" r="${f1(r * 0.8)}" fill="#ffffff" stroke="${EL.detector}" stroke-width="${f1(sw)}"/>` + txt(P[0], P[1], e.type === "smoke" ? "S" : "H", r * 0.85, EL.detector, true);
  }
  return "";
}

/** Switch legs: a curved dashed line from each switch to the nearest fixture of every group it controls, and the group's fixtures chained. */
export function switchWiring(switches: ElecPoint[], groups: LightGroup[], T: (p: Vec2) => Vec2): string {
  const arc = (a: Vec2, b: Vec2) => {
    const A = T(a), B = T(b);
    const m = v2.lerp(A, B, 0.5), d = v2.sub(B, A);
    const c = v2.add(m, v2.scale(v2.perp(d), 0.22));
    return `<path d="M ${f1(A[0])} ${f1(A[1])} Q ${f1(c[0])} ${f1(c[1])} ${f1(B[0])} ${f1(B[1])}" fill="none" stroke="#6b6b6b" stroke-width="0.9" stroke-dasharray="4 3"/>`;
  };
  const out: string[] = [];
  const chained = new Set<LightGroup>();
  for (const s of switches) {
    const start = s.n ? v2.add(s.at, v2.scale(s.n, 0.12)) : s.at;
    for (const gid of s.controls) {
      const g = groups.find((x) => x.id === gid && (x.room === s.room || s.room < 0)) ?? groups.find((x) => x.id === gid);
      if (!g || !g.pts.length) continue;
      const first = g.pts.reduce((p, q) => (v2.dist(q, start) < v2.dist(p, start) ? q : p));
      out.push(arc(start, first));
      if (chained.has(g)) continue;
      chained.add(g);
      // nearest-neighbour chain through the group
      const rest = g.pts.filter((p) => p !== first);
      let cur = first;
      while (rest.length) {
        const k = rest.reduce((bi, q, i) => (v2.dist(q, cur) < v2.dist(rest[bi], cur) ? i : bi), 0);
        out.push(arc(cur, rest[k]));
        cur = rest.splice(k, 1)[0];
      }
    }
  }
  return out.join("");
}

export function pipeSVG(p: PipeRun, T: (q: Vec2) => Vec2): string {
  const pts = p.pts.map(T).map((q) => `${f1(q[0])},${f1(q[1])}`).join(" ");
  const style =
    p.kind === "soil" ? `stroke="${PL.soil}" stroke-width="3" stroke-dasharray="9 3"`
    : p.kind === "waste" ? `stroke="${PL.waste}" stroke-width="2.2" stroke-dasharray="6 3"`
    : p.kind === "cold" ? `stroke="${PL.cold}" stroke-width="${p.size > 15 ? 2.2 : 1.5}"`
    : `stroke="${PL.hot}" stroke-width="1.5"`;
  return `<polyline points="${pts}" fill="none" ${style} stroke-linejoin="round" stroke-linecap="round"/>`;
}

export function plumbPointSymbol(p: PlumbPoint, T: (q: Vec2) => Vec2, r: number): string {
  const [x, y] = T(p.at);
  switch (p.type) {
    case "stack":
      return `<circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(r * ((p.size ?? 100) >= 100 ? 1 : 0.8))}" fill="${PL.soil}" stroke="#ffffff" stroke-width="1.2"/><circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(r * 0.35)}" fill="#ffffff"/>`;
    case "water_heater":
      return `<circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(r * 1.1)}" fill="#ffffff" stroke="${PL.hot}" stroke-width="1.4"/>` + txt(x, y, "WH", r * 0.75, PL.hot, true);
    case "inlet":
      return `<polygon points="${f1(x - r)},${f1(y - r * 0.6)} ${f1(x + r)},${f1(y + r * 0.6)} ${f1(x + r)},${f1(y - r * 0.6)} ${f1(x - r)},${f1(y + r * 0.6)}" fill="${PL.cold}" stroke="${PL.cold}" stroke-width="1"/>`;
    default:
      return "";
  }
}

export function fixtureSymbol(f: PlumbFixture, T: (q: Vec2) => Vec2, r: number): string {
  const [x, y] = T(f.at);
  if (f.kind === "floor_drain") {
    const h = r * 0.8;
    return `<rect x="${f1(x - h)}" y="${f1(y - h)}" width="${f1(h * 2)}" height="${f1(h * 2)}" fill="#ffffff" stroke="${PL.waste}" stroke-width="1.2"/><path d="M ${f1(x - h)} ${f1(y)} H ${f1(x + h)} M ${f1(x)} ${f1(y - h)} V ${f1(y + h)}" stroke="${PL.waste}" stroke-width="0.8"/>`;
  }
  if (f.kind === "tap") return `<circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(r * 0.5)}" fill="${PL.cold}"/><path d="M ${f1(x - r)} ${f1(y - r * 0.7)} H ${f1(x + r)}" stroke="${PL.cold}" stroke-width="1.6"/>`;
  // connection point: drain outlet (dark) with supply dots
  let s = `<circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(r * 0.42)}" fill="${f.kind === "wc" ? PL.soil : PL.waste}"/>`;
  if (f.cold) s += `<circle cx="${f1(x - r * 0.7)}" cy="${f1(y)}" r="${f1(r * 0.25)}" fill="${PL.cold}"/>`;
  if (f.hot) s += `<circle cx="${f1(x + r * 0.7)}" cy="${f1(y)}" r="${f1(r * 0.25)}" fill="${PL.hot}"/>`;
  return s;
}
