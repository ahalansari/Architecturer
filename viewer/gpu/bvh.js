// Bounding volume hierarchy for the path tracer: binned SAH, children stored side by side.
// Shared by the server (Node + Dawn) and the viewer (browser WebGPU); plain JS, no imports.
//
// Input: triangle corners, 9 floats per triangle. Output:
//   nodes: Float32Array, 8 floats per node: min.xyz, (leaf: first triangle | inner: left child),
//          max.xyz, triangle count (0 = inner node; the right child is left + 1). Indices are stored as float
//          values, not bit patterns: GPUs may flush denormal floats to zero on load.
//   order: Uint32Array, the triangle order the leaves refer to

const BINS = 12;
const LEAF = 4;

export function buildBVH(tri, n) {
  const bmin = new Float32Array(n * 3), bmax = new Float32Array(n * 3), cen = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      const a = tri[i * 9 + k], b = tri[i * 9 + 3 + k], c = tri[i * 9 + 6 + k];
      const lo = Math.min(a, b, c), hi = Math.max(a, b, c);
      bmin[i * 3 + k] = lo;
      bmax[i * 3 + k] = hi;
      cen[i * 3 + k] = (lo + hi) / 2;
    }
  }
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const cap = Math.max(1, 2 * n);
  const nodes = new Float32Array(cap * 8);
  let count = 1;
  // work items: node index, first, count
  const stack = [[0, 0, n]];
  const binMin = new Float32Array(BINS * 3), binMax = new Float32Array(BINS * 3), binN = new Uint32Array(BINS);
  const area = (x0, y0, z0, x1, y1, z1) => {
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
    return dx < 0 ? 0 : 2 * (dx * dy + dy * dz + dz * dx);
  };
  while (stack.length) {
    const [ni, first, cnt] = stack.pop();
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    let cx0 = Infinity, cy0 = Infinity, cz0 = Infinity, cx1 = -Infinity, cy1 = -Infinity, cz1 = -Infinity;
    for (let j = first; j < first + cnt; j++) {
      const t = order[j] * 3;
      if (bmin[t] < x0) x0 = bmin[t];
      if (bmin[t + 1] < y0) y0 = bmin[t + 1];
      if (bmin[t + 2] < z0) z0 = bmin[t + 2];
      if (bmax[t] > x1) x1 = bmax[t];
      if (bmax[t + 1] > y1) y1 = bmax[t + 1];
      if (bmax[t + 2] > z1) z1 = bmax[t + 2];
      if (cen[t] < cx0) cx0 = cen[t];
      if (cen[t + 1] < cy0) cy0 = cen[t + 1];
      if (cen[t + 2] < cz0) cz0 = cen[t + 2];
      if (cen[t] > cx1) cx1 = cen[t];
      if (cen[t + 1] > cy1) cy1 = cen[t + 1];
      if (cen[t + 2] > cz1) cz1 = cen[t + 2];
    }
    const o = ni * 8;
    nodes[o] = x0; nodes[o + 1] = y0; nodes[o + 2] = z0;
    nodes[o + 4] = x1; nodes[o + 5] = y1; nodes[o + 6] = z1;
    const leaf = () => {
      nodes[o + 3] = first;
      nodes[o + 7] = cnt;
    };
    if (cnt <= LEAF) {
      leaf();
      continue;
    }
    // binned SAH over the centroid bounds
    const cmin = [cx0, cy0, cz0], ext = [cx1 - cx0, cy1 - cy0, cz1 - cz0];
    let bestCost = Infinity, bestAxis = -1, bestBin = 0;
    for (let ax = 0; ax < 3; ax++) {
      if (ext[ax] < 1e-9) continue;
      binN.fill(0);
      binMin.fill(Infinity);
      binMax.fill(-Infinity);
      const sc = BINS / ext[ax];
      for (let j = first; j < first + cnt; j++) {
        const t = order[j];
        const b = Math.min(BINS - 1, ((cen[t * 3 + ax] - cmin[ax]) * sc) | 0);
        binN[b]++;
        for (let k = 0; k < 3; k++) {
          if (bmin[t * 3 + k] < binMin[b * 3 + k]) binMin[b * 3 + k] = bmin[t * 3 + k];
          if (bmax[t * 3 + k] > binMax[b * 3 + k]) binMax[b * 3 + k] = bmax[t * 3 + k];
        }
      }
      // sweep from the left and the right
      const leftA = new Float64Array(BINS), leftN = new Uint32Array(BINS);
      let lx0 = Infinity, ly0 = Infinity, lz0 = Infinity, lx1 = -Infinity, ly1 = -Infinity, lz1 = -Infinity, ln = 0;
      for (let b = 0; b < BINS - 1; b++) {
        ln += binN[b];
        if (binN[b]) {
          lx0 = Math.min(lx0, binMin[b * 3]); ly0 = Math.min(ly0, binMin[b * 3 + 1]); lz0 = Math.min(lz0, binMin[b * 3 + 2]);
          lx1 = Math.max(lx1, binMax[b * 3]); ly1 = Math.max(ly1, binMax[b * 3 + 1]); lz1 = Math.max(lz1, binMax[b * 3 + 2]);
        }
        leftA[b] = ln ? area(lx0, ly0, lz0, lx1, ly1, lz1) : 0;
        leftN[b] = ln;
      }
      let rx0 = Infinity, ry0 = Infinity, rz0 = Infinity, rx1 = -Infinity, ry1 = -Infinity, rz1 = -Infinity, rn = 0;
      for (let b = BINS - 1; b > 0; b--) {
        rn += binN[b];
        if (binN[b]) {
          rx0 = Math.min(rx0, binMin[b * 3]); ry0 = Math.min(ry0, binMin[b * 3 + 1]); rz0 = Math.min(rz0, binMin[b * 3 + 2]);
          rx1 = Math.max(rx1, binMax[b * 3]); ry1 = Math.max(ry1, binMax[b * 3 + 1]); rz1 = Math.max(rz1, binMax[b * 3 + 2]);
        }
        const nl = leftN[b - 1];
        if (!nl || !rn) continue;
        const cost = leftA[b - 1] * nl + (rn ? area(rx0, ry0, rz0, rx1, ry1, rz1) : 0) * rn;
        if (cost < bestCost) {
          bestCost = cost;
          bestAxis = ax;
          bestBin = b;
        }
      }
    }
    const leafCost = area(x0, y0, z0, x1, y1, z1) * cnt;
    if (bestAxis < 0 || (bestCost >= leafCost && cnt <= 16)) {
      if (bestAxis < 0 && cnt > 16) {
        // all centroids coincide: split in the middle
        bestAxis = 0;
        bestBin = -1;
      } else {
        leaf();
        continue;
      }
    }
    let mid;
    if (bestBin < 0) mid = first + (cnt >> 1);
    else {
      const sc = BINS / ext[bestAxis];
      let i = first, j = first + cnt - 1;
      while (i <= j) {
        const t = order[i];
        const b = Math.min(BINS - 1, ((cen[t * 3 + bestAxis] - cmin[bestAxis]) * sc) | 0);
        if (b < bestBin) i++;
        else {
          order[i] = order[j];
          order[j] = t;
          j--;
        }
      }
      mid = i;
      if (mid === first || mid === first + cnt) mid = first + (cnt >> 1);
    }
    const left = count;
    count += 2;
    nodes[o + 3] = left;
    nodes[o + 7] = 0;
    stack.push([left, first, mid - first], [left + 1, mid, first + cnt - mid]);
  }
  return { nodes: nodes.slice(0, count * 8), order, count };
}
