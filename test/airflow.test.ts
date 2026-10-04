import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { compile } from "../src/pipeline.js";
import { voxelize, runAirflow, airflowReport, packField } from "../src/sim/airflow.js";
import { airflowSVG } from "../src/sim/airflow-svg.js";
import { gpuInfo } from "../src/render/gpu.js";

const villa = () => compile(JSON.parse(readFileSync("examples/villa.json", "utf8")));

test("airflow voxels: rooms are air up to the ceiling, walls solid, doors open, diffusers and grilles placed", () => {
  const c = villa();
  const s = voxelize(c, "ground");
  const { nx, ny, nz, dx, x0, y0 } = s.grid;
  assert.equal(s.kind.length, nx * ny * nz);
  const count = (k: number) => s.kind.filter((v) => v === k).length;
  assert.ok(count(0) > 50_000, "air");
  assert.ok(count(2) > 0 && count(3) > 0, "supplies and returns");
  const at = (x: number, y: number, z: number) => s.kind[(Math.floor(z / dx) * ny + Math.floor((y - y0) / dx)) * nx + Math.floor((x - x0) / dx)];
  // inside the living room at 1 m: air; inside an exterior wall: solid; above the ceiling: solid
  const living = c.project!.levels[0].rooms.find((r) => /living/i.test(r.name))!.polygon as [number, number][];
  const cx = living.reduce((a, p) => a + p[0], 0) / living.length, cy = living.reduce((a, p) => a + p[1], 0) / living.length;
  assert.equal(at(cx, cy, 1), 0);
  const ext = c.levels[0].segments.find((sg) => sg.exterior)!;
  assert.equal(at((ext.a[0] + ext.b[0]) / 2, (ext.a[1] + ext.b[1]) / 2, 1), 1);
  assert.ok(nz * dx < c.levels[0].height + dx);
  // an interior door is open at 1 m
  const door = c.levels[0].openings.find((o) => o.op.type === "door" && !o.seg.exterior)!;
  const d = [door.seg.b[0] - door.seg.a[0], door.seg.b[1] - door.seg.a[1]], l = Math.hypot(d[0], d[1]);
  assert.equal(at(door.seg.a[0] + (d[0] / l) * door.u, door.seg.a[1] + (d[1] / l) * door.u, 1), 0);
  // heat: the conditioned rooms' gains are all there (W)
  let w = 0;
  for (let i = 0; i < s.kind.length; i++) if (s.kind[i] === 0) w += s.src[i * 4 + 3] * 1200 * dx ** 3;
  const loads = c.hvac!.rooms.filter((r) => r.level === 0 && r.conditioned).reduce((a, r) => a + r.parts.walls + r.parts.glassConduction + r.parts.glassSolar + r.parts.infiltration + r.parts.people + r.parts.lighting + r.parts.equipment + r.parts.roof, 0);
  assert.ok(Math.abs(w - loads) / loads < 0.01, `${w} vs ${loads}`);
});

test("airflow on the GPU: rooms held near 24 °C, mixing, a sheet and the viewer field (skipped without a GPU)", async (t) => {
  if (!(await gpuInfo())) return t.skip("no GPU adapter");
  const c = villa();
  const s = voxelize(c, "ground");
  const r = await runAirflow(c, s, { seconds: 120 });
  assert.equal(r.rooms.length, c.hvac!.rooms.filter((x) => x.level === 0 && x.conditioned).length);
  for (const m of r.rooms) {
    assert.ok(m.meanT > 20 && m.meanT < 27, `${m.name} ${m.meanT}`);
    assert.ok(m.meanV > 0.01 && m.meanV < 0.5, `${m.name} ${m.meanV}`);
    assert.ok(m.adpi >= 0 && m.adpi <= 100);
  }
  assert.ok(r.field.every((v) => Number.isFinite(v)), "no NaN in the field");
  assert.match(airflowReport(r, "Ground"), /ADPI/);
  assert.match(airflowSVG(c, r), /Airflow at 1.1 m/);
  const bin = packField(c, r);
  const hl = new DataView(bin.buffer, bin.byteOffset).getUint32(0, true);
  const h = JSON.parse(new TextDecoder().decode(bin.subarray(4, 4 + hl)));
  assert.equal(bin.byteLength, 4 + Math.ceil(hl / 4) * 4 + h.nx * h.ny * h.nz * 16);
});
