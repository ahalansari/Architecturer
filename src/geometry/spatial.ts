// Spatial indexes for big floors. A hospital or airport level has thousands of rooms, walls and doors, and
// "which room is this point in" / "which walls are near this edge" asked against every element turns a
// build quadratic. A uniform grid over bounding boxes answers both in roughly constant time.

import { pointInPolygon, type Vec2 } from "./math.js";

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function boxOf(pts: readonly Vec2[], pad = 0): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    if (p[0] < x0) x0 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[0] > x1) x1 = p[0];
    if (p[1] > y1) y1 = p[1];
  }
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
}

export const boxesOverlap = (a: Box, b: Box) => a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;

/** Below this many items a query just returns everything (cheaper than the grid, and the same answer). */
const SMALL = 48;
/** Never more cells than this along one axis (a 3 km site with 0.5 m doors still gets a sane grid). */
const MAX_CELLS = 4096;

/**
 * Uniform grid over item bounding boxes. `query` returns the items whose box overlaps the query box, in
 * ascending index order (so `find`-style callers keep "first match wins"). It is a candidate filter: callers
 * still run their exact test, padding the query box by whatever tolerance that test allows.
 */
export class GridIndex {
  readonly boxes: Box[];
  private cell = 1;
  private gx0 = 0;
  private gy0 = 0;
  private cells = new Map<number, number[]>();
  private seen: Uint32Array;
  private stamp = 0;

  constructor(boxes: Box[], cell?: number) {
    this.boxes = boxes;
    this.seen = new Uint32Array(boxes.length);
    if (boxes.length <= SMALL) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, size = 0, n = 0;
    for (const b of boxes) {
      if (!(b.x1 >= b.x0 && b.y1 >= b.y0)) continue;
      x0 = Math.min(x0, b.x0);
      y0 = Math.min(y0, b.y0);
      x1 = Math.max(x1, b.x1);
      y1 = Math.max(y1, b.y1);
      // typical size of the small side: long walls span many cells, rooms and doors a few
      size += Math.max(0.25, Math.min(b.x1 - b.x0, b.y1 - b.y0));
      n++;
    }
    if (!n) return;
    const extent = Math.max(x1 - x0, y1 - y0, 1);
    this.cell = Math.max(cell ?? (2 * size) / n, extent / MAX_CELLS, 0.25);
    this.gx0 = x0;
    this.gy0 = y0;
    boxes.forEach((b, i) => {
      if (!(b.x1 >= b.x0 && b.y1 >= b.y0)) return;
      const [i0, j0, i1, j1] = this.range(b);
      for (let ci = i0; ci <= i1; ci++)
        for (let cj = j0; cj <= j1; cj++) {
          const k = ci * 8192 + cj;
          const list = this.cells.get(k);
          if (list) list.push(i);
          else this.cells.set(k, [i]);
        }
    });
  }

  get size() {
    return this.boxes.length;
  }

  private range(b: Box): [number, number, number, number] {
    const c = (v: number, o: number) => Math.min(MAX_CELLS, Math.max(0, Math.floor((v - o) / this.cell)));
    return [c(b.x0, this.gx0), c(b.y0, this.gy0), c(b.x1, this.gx0), c(b.y1, this.gy0)];
  }

  query(b: Box): number[] {
    const out: number[] = [];
    if (!this.cells.size) {
      this.boxes.forEach((x, i) => boxesOverlap(x, b) && out.push(i));
      return out;
    }
    if (++this.stamp === 0xffffffff) {
      this.seen.fill(0);
      this.stamp = 1;
    }
    const [i0, j0, i1, j1] = this.range(b);
    for (let ci = i0; ci <= i1; ci++)
      for (let cj = j0; cj <= j1; cj++)
        for (const i of this.cells.get(ci * 8192 + cj) ?? []) {
          if (this.seen[i] === this.stamp) continue;
          this.seen[i] = this.stamp;
          if (boxesOverlap(this.boxes[i], b)) out.push(i);
        }
    return out.sort((a, c) => a - c);
  }

  queryPoint(p: Vec2, pad = 0): number[] {
    return this.query({ x0: p[0] - pad, y0: p[1] - pad, x1: p[0] + pad, y1: p[1] + pad });
  }
}

/** Polygons of one floor (rooms, gardens): the first one holding a point, in O(1) on floors with thousands. */
export class PolygonIndex {
  readonly grid: GridIndex;

  constructor(readonly polys: readonly Vec2[][]) {
    this.grid = new GridIndex(polys.map((p) => boxOf(p)));
  }

  /** Index of the first polygon containing `p` (same as `polys.findIndex(pointInPolygon)`), or -1. */
  at(p: Vec2): number {
    for (const i of this.grid.queryPoint(p)) if (pointInPolygon(p, this.polys[i])) return i;
    return -1;
  }

  /** Polygons whose bounding box overlaps `b`, ascending. */
  near(b: Box): number[] {
    return this.grid.query(b);
  }
}

const segmentGrids = new WeakMap<readonly unknown[], { n: number; grid: GridIndex }>();

/**
 * Segments (walls) whose bounding box comes within `reach` of `p`, ascending. The grid is built on first use
 * of an array and rebuilt if its length changes, so pass the final segment list (after junction splitting).
 */
export function segmentsNear<T extends { a: Vec2; b: Vec2 }>(segs: readonly T[], p: Vec2, reach: number): T[] {
  let g = segmentGrids.get(segs);
  if (!g || g.n !== segs.length) segmentGrids.set(segs, (g = { n: segs.length, grid: new GridIndex(segs.map((s) => boxOf([s.a, s.b]))) }));
  return g.grid.queryPoint(p, reach).map((i) => segs[i]);
}
