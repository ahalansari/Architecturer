/**
 * Fit an imported model into a furniture item's box: extra yaw, then uniform ("contain"), exact ("stretch") or no
 * scaling, footprint centred on the item's pivot and standing on its floor.
 */
import type { MeshData } from "../geometry/mesh.js";
import type { ImportedModel } from "./registry.js";

export interface ModelFit {
  width?: number;
  depth?: number;
  height?: number;
  rotationDeg: number;
  fit: "contain" | "stretch" | "none";
  /** Material overrides: "*" = all parts, "0", "1"... = the model's n-th material. */
  materials?: Record<string, string>;
}

/** Natural size of a model after an extra yaw. */
export function rotatedSize(model: ImportedModel, rotationDeg: number): [number, number, number] {
  const r = (rotationDeg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const m of model.meshes)
    for (let i = 0; i < m.positions.length; i += 3) {
      const x = m.positions[i] * c - m.positions[i + 1] * s, y = m.positions[i] * s + m.positions[i + 1] * c;
      (x0 = Math.min(x0, x)), (x1 = Math.max(x1, x)), (y0 = Math.min(y0, y)), (y1 = Math.max(y1, y));
    }
  return [x1 - x0, y1 - y0, model.size[2]];
}

export function fitModel(model: ImportedModel, o: ModelFit): MeshData[] {
  const r = (o.rotationDeg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const m of model.meshes)
    for (let i = 0; i < m.positions.length; i += 3) {
      const x = m.positions[i] * c - m.positions[i + 1] * s, y = m.positions[i] * s + m.positions[i + 1] * c;
      (x0 = Math.min(x0, x)), (x1 = Math.max(x1, x)), (y0 = Math.min(y0, y)), (y1 = Math.max(y1, y));
    }
  const w = Math.max(1e-6, x1 - x0), d = Math.max(1e-6, y1 - y0), h = Math.max(1e-6, model.size[2]);
  const tw = o.width ?? w, td = o.depth ?? d, th = o.height ?? h;
  let sx = 1, sy = 1, sz = 1;
  if (o.fit === "stretch") (sx = tw / w), (sy = td / d), (sz = th / h);
  else if (o.fit === "contain") sx = sy = sz = Math.min(tw / w, td / d, th / h);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const over = o.materials ?? {};
  return model.meshes.map((m) => {
    const positions = new Array<number>(m.positions.length);
    const normals = new Array<number>(m.normals.length);
    for (let i = 0; i < m.positions.length; i += 3) {
      const x = m.positions[i] * c - m.positions[i + 1] * s, y = m.positions[i] * s + m.positions[i + 1] * c;
      positions[i] = (x - cx) * sx;
      positions[i + 1] = (y - cy) * sy;
      positions[i + 2] = m.positions[i + 2] * sz;
      if (m.normals.length) {
        const nx0 = m.normals[i] * c - m.normals[i + 1] * s, ny0 = m.normals[i] * s + m.normals[i + 1] * c;
        // inverse-scale the normal for non-uniform stretch
        const nx = nx0 / sx, ny = ny0 / sy, nz = m.normals[i + 2] / sz;
        const l = Math.hypot(nx, ny, nz) || 1;
        (normals[i] = nx / l), (normals[i + 1] = ny / l), (normals[i + 2] = nz / l);
      }
    }
    const idx = m.material.split(":").pop()!;
    return { material: over[idx] ?? over["*"] ?? m.material, positions, normals, uvs: m.uvs.slice(), indices: m.indices.slice() };
  });
}
