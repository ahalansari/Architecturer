/** Airflow study sheet: temperature at a height as a heat map, air-speed arrows, walls, diffusers and per-room results. */
import pngjs from "pngjs";
import type { Compiled } from "../pipeline.js";
import type { AirflowResult } from "./airflow.js";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Cool blue → comfortable green → warm red, around 24 °C. */
export function tempColor(t: number): [number, number, number] {
  const stops: [number, [number, number, number]][] = [
    [16, [40, 70, 190]],
    [20, [60, 150, 230]],
    [23, [110, 200, 170]],
    [24.5, [170, 220, 120]],
    [26, [250, 210, 80]],
    [28, [240, 130, 50]],
    [31, [200, 40, 40]],
  ];
  if (t <= stops[0][0]) return stops[0][1];
  for (let k = 1; k < stops.length; k++)
    if (t <= stops[k][0]) {
      const [ta, ca] = stops[k - 1], [tb, cb] = stops[k];
      const f = (t - ta) / (tb - ta);
      return [0, 1, 2].map((i) => Math.round(ca[i] + (cb[i] - ca[i]) * f)) as [number, number, number];
    }
  return stops[stops.length - 1][1];
}

export function airflowSVG(c: Compiled, r: AirflowResult, o: { height?: number } = {}): string {
  const g = r.grid;
  const z = o.height ?? 1.1;
  const k = Math.min(g.nz - 1, Math.max(0, Math.floor(z / g.dx)));
  const S = Math.max(4, Math.min(9, Math.floor(1100 / Math.max(g.nx, g.ny))));
  const W = g.nx * S, H = g.ny * S;
  const at = (i: number, j: number, kk: number) => (kk * g.ny + j) * g.nx + i;
  // heat map (north up: row 0 of the image is the largest y)
  const png = new pngjs.PNG({ width: g.nx, height: g.ny });
  for (let j = 0; j < g.ny; j++)
    for (let i = 0; i < g.nx; i++) {
      const n = at(i, j, k);
      const o4 = ((g.ny - 1 - j) * g.nx + i) * 4;
      const kd = r.kind[n];
      if (kd === 1) {
        // wall (inside the plan) or outside
        const any = [0, Math.floor(g.nz / 2)].some((kk) => r.kind[at(i, j, kk)] !== 1);
        png.data.set(any ? [70, 70, 74, 255] : [0, 0, 0, 0], o4);
        continue;
      }
      const [cr, cg, cb] = tempColor(r.field[n * 4 + 3]);
      png.data.set([cr, cg, cb, 255], o4);
    }
  const img = pngjs.PNG.sync.write(png).toString("base64");
  const out: string[] = [];
  const X = (x: number) => ((x - g.x0) / g.dx) * S;
  const Y = (y: number) => H - ((y - g.y0) / g.dx) * S;
  out.push(`<image href="data:image/png;base64,${img}" x="0" y="0" width="${W}" height="${H}" style="image-rendering:pixelated" preserveAspectRatio="none"/>`);
  // arrows: mean horizontal air movement every ~0.5 m
  const step = Math.max(2, Math.round(0.5 / g.dx));
  for (let j = Math.floor(step / 2); j < g.ny; j += step)
    for (let i = Math.floor(step / 2); i < g.nx; i += step) {
      const n = at(i, j, k);
      if (r.kind[n] === 1) continue;
      const u = r.field[n * 4], v = r.field[n * 4 + 1];
      const sp = Math.hypot(u, v);
      if (sp < 0.03) continue;
      const len = Math.min(1, sp / 0.5) * step * S * 0.9;
      const cx = (i + 0.5) * S, cy = H - (j + 0.5) * S;
      const ex = cx + (u / sp) * len, ey = cy - (v / sp) * len;
      const hx = (u / sp) * 4, hy = -(v / sp) * 4;
      out.push(`<line x1="${cx.toFixed(1)}" y1="${cy.toFixed(1)}" x2="${ex.toFixed(1)}" y2="${ey.toFixed(1)}" stroke="#1b1b1b" stroke-opacity="${(0.35 + Math.min(0.6, sp)).toFixed(2)}" stroke-width="1.1"/>`);
      out.push(`<path d="M${ex.toFixed(1)},${ey.toFixed(1)} l${(-hx - hy * 0.6).toFixed(1)},${(-hy + hx * 0.6).toFixed(1)} M${ex.toFixed(1)},${ey.toFixed(1)} l${(-hx + hy * 0.6).toFixed(1)},${(-hy - hx * 0.6).toFixed(1)}" stroke="#1b1b1b" stroke-opacity="${(0.35 + Math.min(0.6, sp)).toFixed(2)}" stroke-width="1.1" fill="none"/>`);
    }
  // rooms without air conditioning, then the walls
  const rms = c.project!.levels[r.level].rooms;
  const studied = new Set(r.rooms.map((m) => m.room));
  rms.forEach((rm, ri) => {
    if (studied.has(ri) || /terrace|balcony|patio|deck|garden|yard|roof/i.test(rm.name)) return;
    const pg = rm.polygon as [number, number][];
    out.push(`<polygon points="${pg.map((p) => `${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(" ")}" fill="#f2f0eb" fill-opacity="0.85"/>`);
    const cx = pg.reduce((a, p) => a + p[0], 0) / pg.length, cy = pg.reduce((a, p) => a + p[1], 0) / pg.length;
    out.push(`<text x="${X(cx).toFixed(1)}" y="${Y(cy).toFixed(1)}" text-anchor="middle" font-size="11" fill="#888">${esc(rm.name)} · not conditioned</text>`);
  });
  for (const sg of c.levels[r.level].segments) out.push(`<line x1="${X(sg.a[0]).toFixed(1)}" y1="${Y(sg.a[1]).toFixed(1)}" x2="${X(sg.b[0]).toFixed(1)}" y2="${Y(sg.b[1]).toFixed(1)}" stroke="#3a3a3e" stroke-width="${Math.max(2, (sg.thickness / g.dx) * S).toFixed(1)}" stroke-linecap="square"/>`);
  for (const op of c.levels[r.level].openings) {
    if (op.op.type === "window" || op.seg.exterior) continue;
    const d = [op.seg.b[0] - op.seg.a[0], op.seg.b[1] - op.seg.a[1]];
    const l = Math.hypot(d[0], d[1]) || 1;
    const u = [d[0] / l, d[1] / l];
    const c0 = [op.seg.a[0] + u[0] * op.u, op.seg.a[1] + u[1] * op.u];
    const p0 = [c0[0] - (u[0] * op.width) / 2, c0[1] - (u[1] * op.width) / 2], p1 = [c0[0] + (u[0] * op.width) / 2, c0[1] + (u[1] * op.width) / 2];
    out.push(`<line x1="${X(p0[0]).toFixed(1)}" y1="${Y(p0[1]).toFixed(1)}" x2="${X(p1[0]).toFixed(1)}" y2="${Y(p1[1]).toFixed(1)}" stroke="#fbfaf7" stroke-width="${Math.max(2.5, (op.seg.thickness / g.dx) * S + 1).toFixed(1)}"/>`);
  }
  // diffusers and grilles
  const hv = c.hvac!.levels[r.level];
  for (const t of hv.terminals) {
    const x = X(t.at[0]), y = Y(t.at[1]), s = 0.3 / g.dx * S;
    out.push(t.kind === "supply" ? `<rect x="${x - s}" y="${y - s}" width="${2 * s}" height="${2 * s}" fill="none" stroke="#0b4fa8" stroke-width="2"/><path d="M${x - s},${y - s} L${x + s},${y + s} M${x + s},${y - s} L${x - s},${y + s}" stroke="#0b4fa8" stroke-width="1.2"/>` : `<rect x="${x - s}" y="${y - s * 0.6}" width="${2 * s}" height="${1.2 * s}" fill="none" stroke="#8a2be2" stroke-width="2"/>`);
  }
  // room results
  const rooms = rms;
  for (const m of r.rooms) {
    const pg = rooms[m.room].polygon as [number, number][];
    const cx = pg.reduce((a, p) => a + p[0], 0) / pg.length, cy = pg.reduce((a, p) => a + p[1], 0) / pg.length;
    const bad = m.adpi < 60 || m.meanT > 26 || m.draught > 20;
    out.push(
      `<g transform="translate(${X(cx).toFixed(1)},${Y(cy).toFixed(1)})"><rect x="-74" y="-25" width="148" height="50" rx="5" fill="#ffffffe6" stroke="${bad ? "#c0392b" : "#999"}"/>` +
        `<text y="-9" text-anchor="middle" font-size="11.5" font-weight="bold" fill="#222">${esc(m.name.slice(0, 24))}</text>` +
        `<text y="6" text-anchor="middle" font-size="10.5" fill="#222">${m.meanT} °C · ${m.meanV} m/s</text>` +
        `<text y="19" text-anchor="middle" font-size="10" fill="${bad ? "#c0392b" : "#555"}">ADPI ${m.adpi}% · draught ${m.draught}%</text></g>`,
    );
  }
  // legend
  const lx = W + 24;
  const leg: string[] = [`<text x="${lx}" y="24" font-size="15" font-weight="bold" fill="#222">Airflow at ${z} m</text>`, `<text x="${lx}" y="42" font-size="11" fill="#666">${esc(c.levels[r.level].name)} · ${r.seconds} s of flow</text>`];
  for (let q = 0; q <= 15; q++) {
    const t = 16 + q;
    const [cr, cg, cb] = tempColor(t);
    leg.push(`<rect x="${lx}" y="${60 + q * 14}" width="22" height="14" fill="rgb(${cr},${cg},${cb})"/>`);
    if (q % 3 === 0) leg.push(`<text x="${lx + 28}" y="${71 + q * 14}" font-size="10.5" fill="#333">${t} °C</text>`);
  }
  let ly = 60 + 16 * 14 + 18;
  leg.push(`<rect x="${lx}" y="${ly - 9}" width="12" height="12" fill="none" stroke="#0b4fa8" stroke-width="2"/><text x="${lx + 20}" y="${ly + 1}" font-size="11" fill="#333">supply diffuser</text>`);
  ly += 18;
  leg.push(`<rect x="${lx}" y="${ly - 7}" width="12" height="8" fill="none" stroke="#8a2be2" stroke-width="2"/><text x="${lx + 20}" y="${ly + 1}" font-size="11" fill="#333">return grille</text>`);
  ly += 18;
  leg.push(`<line x1="${lx}" y1="${ly - 3}" x2="${lx + 14}" y2="${ly - 3}" stroke="#1b1b1b" stroke-width="1.2"/><text x="${lx + 20}" y="${ly + 1}" font-size="11" fill="#333">air movement (0.5 m/s = full)</text>`);
  ly += 26;
  leg.push(`<text x="${lx}" y="${ly}" font-size="10" fill="#666">ADPI: share of the occupied zone</text><text x="${lx}" y="${ly + 13}" font-size="10" fill="#666">with good mixing (aim 80%+).</text><text x="${lx}" y="${ly + 30}" font-size="10" fill="#666">Indicative study, not certified CFD.</text>`);
  const TW = W + 250, TH = Math.max(H, 420);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${TW} ${TH}" width="${TW}" height="${TH}" font-family="Helvetica, Arial, sans-serif"><rect width="${TW}" height="${TH}" fill="#fbfaf7"/>${out.join("")}${leg.join("")}</svg>`;
}
