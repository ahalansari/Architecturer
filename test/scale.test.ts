import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pointInPolygon, type Vec2 } from "../src/geometry/math.js";
import { boxesOverlap, GridIndex, PolygonIndex, type Box } from "../src/geometry/spatial.js";
import { inlineEngine } from "../src/mcp/engine.js";
import { runJob } from "../src/mcp/jobs.js";
import { createMcpServer } from "../src/mcp/tools.js";
import { KeyedLock, Workspace } from "../src/mcp/workspace.js";
import { condense, copyElements, duplicateLevel, massing, outline, scopeProject, selectElements, unscopeMessage } from "../src/scale.js";

type Json = Record<string, any>;

/** A ward block: W × D m of B m bays (a room with a bed and a door each), on `levels` floors. */
function wards(W: number, D: number, B: number, levels = 1): Json {
  return {
    name: "Ward block",
    levels: Array.from({ length: levels }, (_, l) => {
      const walls: Json[] = [{ id: `ext_${l}`, points: [[0, 0], [W, 0], [W, D], [0, D]], closed: true }];
      for (let x = B; x < W; x += B) for (let y = 0; y < D; y += B) walls.push({ id: `v_${l}_${x}_${y}`, points: [[x, y], [x, y + B]] });
      for (let y = B; y < D; y += B) for (let x = 0; x < W; x += B) walls.push({ id: `h_${l}_${x}_${y}`, points: [[x, y], [x + B, y]] });
      const openings: Json[] = [], rooms: Json[] = [], furniture: Json[] = [];
      for (let x = 0; x < W; x += B) for (let y = B; y < D; y += B) openings.push({ id: `d_${l}_${x}_${y}`, type: "door", at: [x + B / 2, y], width: 1.2 });
      for (let x = 0; x < W; x += B)
        for (let y = 0; y < D; y += B) {
          rooms.push({ id: `r_${l}_${x}_${y}`, name: `Ward ${x}-${y}`, polygon: [[x, y], [x + B, y], [x + B, y + B], [x, y + B]] });
          furniture.push({ id: `bed_${l}_${x}_${y}`, type: "hospital_bed", position: [x + 2, y + B / 2], facing: "east" });
        }
      return { id: `L${l}`, height: 4, walls, openings, rooms, furniture };
    }),
  };
}

test("spatial: grid queries match brute force", () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const boxes: Box[] = Array.from({ length: 900 }, () => {
    const x = rnd() * 500, y = rnd() * 300, w = rnd() < 0.1 ? rnd() * 200 : rnd() * 6, h = rnd() * 6;
    return { x0: x, y0: y, x1: x + w, y1: y + h };
  });
  const g = new GridIndex(boxes);
  for (let k = 0; k < 300; k++) {
    const x = rnd() * 520 - 10, y = rnd() * 320 - 10, s = rnd() * 30;
    const q = { x0: x, y0: y, x1: x + s, y1: y + s };
    assert.deepEqual(g.query(q), boxes.flatMap((b, i) => (boxesOverlap(b, q) ? [i] : [])));
  }
  const polys: Vec2[][] = [];
  for (let x = 0; x < 300; x += 7) for (let y = 0; y < 200; y += 9) polys.push([[x, y], [x + 7, y], [x + 7, y + 9], [x, y + 9]]);
  polys.push([[50, 50], [120, 50], [120, 90], [50, 90]]); // overlaps others: the first one still wins
  const pi = new PolygonIndex(polys);
  for (let k = 0; k < 500; k++) {
    const p: Vec2 = [rnd() * 320 - 10, rnd() * 220 - 10];
    assert.equal(pi.at(p), polys.findIndex((pg) => pointInPolygon(p, pg)));
  }
});

test("scale: outline, scoping, massing, copies", () => {
  const p = wards(60, 30, 10, 4);
  const o = outline(p);
  assert.equal(o.levels.length, 4);
  assert.equal(o.roomArea, 60 * 30 * 4);
  assert.deepEqual(o.levels[2].extent, [0, 0, 60, 30]);
  assert.equal(o.levels[3].elevation, 12);
  assert.equal(o.big, false);
  assert.equal(outline(wards(400, 200, 10)).big, true);

  // floor 2 with its neighbours (1 and 3) as context: fit-out stripped, real elevations kept
  const s = scopeProject(p, ["L2"]);
  assert.deepEqual(s.project.levels.map((l: Json) => l.id), ["L1", "L2", "L3"]);
  assert.deepEqual(s.levelMap, [1, 2, 3]);
  assert.deepEqual(s.levels, ["L2"]);
  assert.equal(s.project.levels[0].elevation, 4);
  assert.equal(s.project.levels[0].furniture.length, 0);
  assert.equal(s.project.levels[1].furniture.length, 18);
  assert.equal(unscopeMessage("levels[1].walls[3]: bad", s.levelMap), "levels[2].walls[3]: bad");
  assert.throws(() => scopeProject(p, ["nope"]), /not found/);

  const m = massing(p);
  assert.equal(m.levels[0].furniture.length, 0);
  assert.equal(m.hvac.system, "none");
  assert.equal(p.levels[0].furniture.length, 18); // the plan itself is untouched

  // typical floors: copies stack on top, ids get the level suffix, doors keep (renamed) walls
  const q = wards(30, 20, 10, 1);
  q.levels[0].openings.push({ id: "win", type: "window", wall: "ext_0", offset: 4 });
  duplicateLevel(q, "L0", ["L1", "L2"]);
  assert.deepEqual(q.levels.map((l: Json) => l.id), ["L0", "L1", "L2"]);
  assert.equal(q.levels[2].elevation, undefined);
  assert.ok(q.levels[1].walls.some((w: Json) => w.id === "ext_0_L1"));
  assert.equal(q.levels[2].openings.find((o: Json) => o.id === "win_L2").wall, "ext_0_L2");
  assert.throws(() => duplicateLevel(q, "L0", ["L1"]), /already used/);

  // a row of three more bays to the east
  const before = q.levels[0].rooms.length;
  copyElements(q, "L0", { region: [0, 0, 10, 20], kinds: ["rooms", "furniture"] }, [30, 0], 3);
  assert.equal(q.levels[0].rooms.length, before + 2 * 3);
  const c3 = q.levels[0].rooms.find((r: Json) => r.id === "r_0_0_0_c3");
  assert.deepEqual(c3.polygon[0], [90, 0]);
  assert.deepEqual(q.levels[0].furniture.find((f: Json) => f.id === "bed_0_0_0_c3").position, [92, 5]);

  const sel = selectElements(q, { level: "L0", kinds: ["rooms"], offset: 2, limit: 3 });
  assert.equal(sel.items.length, 3);
  assert.equal(sel.total, before + 6);

  const folded = condense([...Array.from({ length: 500 }, (_, i) => `room 'R${i}' has no door`), "stair 's1' leads nowhere"], 5, "warnings");
  assert.equal(folded.length, 5 + 1 + 2);
  assert.match(folded[6], /495× like: room 'R\d+' has no door/);
});

test("scale: a 30,000 m² ward floor validates quickly and scoped jobs report their scope", async () => {
  const p = wards(300, 100, 10, 2);
  let t = performance.now();
  const r = await runJob({ op: "validate", project: p, baseDir: tmpdir(), scope: { levels: ["L1"] } });
  const ms = performance.now() - t;
  assert.ok(r.ok, r.summary);
  assert.match(r.summary, /Checked level\(s\) L1 only/);
  assert.ok(ms < 60_000, `took ${ms} ms`);

  t = performance.now();
  const plan = await runJob({ op: "render_plan", project: p, baseDir: tmpdir(), level: "L1", scope: { levels: ["L1"] } });
  assert.ok(plan.ok && plan.images?.[0].byteLength, plan.summary);
  const close = await runJob({ op: "render_plan", project: p, baseDir: tmpdir(), level: "L1", region: [0, 0, 40, 30], scope: { levels: ["L1"] } });
  assert.ok(close.images![0].byteLength < plan.images![0].byteLength);
  const m = await runJob({ op: "validate", project: p, baseDir: tmpdir(), scope: { detail: "massing" } });
  assert.match(m.summary, /Massing model/);
});

test("MCP: big-project tools", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arch-scale-"));
  writeFileSync(join(dir, "campus.json"), JSON.stringify(wards(400, 200, 10, 1)));
  const server = createMcpServer({ ws: new Workspace(dir, false), engine: inlineEngine, lock: new KeyedLock() });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { type: string; text?: string }[]; isError?: boolean };
    assert.ok(!r.isError, r.content[0]?.text);
    return r.content.map((c) => c.text ?? `<${c.type}>`).join("\n");
  };
  try {
    let t = await call("project_summary", { path: "campus" });
    assert.match(t, /80,000 m² of rooms/);
    assert.match(t, /BIG PROJECT/);

    t = await call("read_project", { path: "campus" });
    assert.match(t, /too big to return whole/);
    t = await call("read_project", { path: "campus", level: "L0", kinds: ["rooms"], limit: 2 });
    assert.match(t, /^800 element\(s\) match; 2 from offset 0\. Next page: offset 2\./);

    t = await call("duplicate_level", { path: "campus", from: "L0", ids: ["L1"] });
    assert.match(t, /Added level\(s\) L1/);
    assert.match(t, /Checked level\(s\) L1 only/);

    t = await call("copy_elements", { path: "campus", level: "L1", ids: ["bed_0_0_0_L1"], offset: [0, 1], count: 1 });
    assert.match(t, /Copied 1 element/);
    t = await call("read_project", { path: "campus", ids: ["bed_0_0_0_L1_c1"] });
    assert.match(t, /"position":\[2,6\]/);
  } finally {
    await client.close();
  }
});
