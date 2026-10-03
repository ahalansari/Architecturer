import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { SceneNode } from "../src/geometry/scene.js";
import { compile } from "../src/pipeline.js";
import { renderPlanSVG } from "../src/render/plan.js";

/** 6 x 5 m room (walls 0.24: inner faces at x 0.12 / 5.88, y 0.12 / 4.88) with a door on the south wall. */
function room(casework: unknown[], extra: Record<string, unknown> = {}): any {
  return {
    defaults: { exteriorWallThickness: 0.24 },
    levels: [
      {
        id: "g",
        height: 2.7,
        walls: [{ id: "ext", points: [[0, 0], [6, 0], [6, 5], [0, 5]], closed: true }],
        openings: [{ id: "door", type: "door", at: (extra.door as number[]) ?? [1, 0] }, ...((extra.openings as unknown[]) ?? [])],
        rooms: [{ name: "Kitchen", polygon: [[0, 0], [6, 0], [6, 5], [0, 5]] }],
        furniture: (extra.furniture as unknown[]) ?? [],
        casework,
      },
    ],
  };
}

const kitchen = (over: Record<string, unknown> = {}) => ({
  id: "k",
  type: "kitchen",
  path: [[1.5, 4.88], [4.5, 4.88]],
  modules: [
    { id: "doors", kind: "base_doors", width: 0.6 },
    { id: "drw", kind: "base_drawers", width: 0.6 },
    { id: "sink", kind: "sink", width: 0.8 },
    { id: "dw", kind: "dishwasher", width: 0.6 },
    { id: "hob", kind: "hob", width: "auto" },
  ],
  uppers: [{ kind: "upper_doors", width: "auto" }, { kind: "hood", over: "hob" }],
  ...over,
});

function nodes(root: SceneNode | undefined, pred: (n: SceneNode) => boolean, out: SceneNode[] = []): SceneNode[] {
  if (!root) return out;
  if (pred(root)) out.push(root);
  for (const c of root.children) nodes(c, pred, out);
  return out;
}

const ok = (p: unknown) => {
  const c = compile(p);
  assert.deepEqual(c.errors, []);
  return c;
};
const expectWarning = (p: unknown, re: RegExp) => {
  const c = ok(p);
  assert.ok(c.warnings.some((w) => re.test(w)), `expected ${re} in:\n${c.warnings.join("\n") || "(no warnings)"}`);
};

test("kitchen run builds without warnings; doors and drawers are separate leaves with pivots and motion data", () => {
  const c = ok(room([kitchen()]));
  assert.deepEqual(c.warnings, []);
  const run = nodes(c.root, (n) => n.kind === "casework")[0];
  assert.ok(run && run.meshes.length > 0 && run.collision && run.collision.length > 0);
  const leaves = nodes(run, (n) => n.kind === "door_leaf");
  const hinged = leaves.filter((n) => n.extras?.motion === "hinged" && n.extras?.hingeAxis === "z");
  const drawers = leaves.filter((n) => n.extras?.motion === "slide");
  assert.ok(hinged.length >= 4, `hinged doors: ${hinged.length}`);
  assert.ok(drawers.length >= 5, `drawers: ${drawers.length}`);
  // fronts face south (run along the north wall): drawers slide along -y
  for (const d of drawers) {
    assert.deepEqual(d.extras?.slideAxis, [0, -1, 0]);
    assert.ok((d.extras?.slideDistance as number) > 0.3);
  }
  // the single base door (0.6 wide, hinge left) pivots on its front-left edge: x = 1.5 + end panel + reveal, y = front plane (4.88 - 0.6)
  const door = leaves.find((n) => n.extras?.module === "doors")!;
  assert.equal(door.extras?.hinge, "left");
  assert.deepEqual(door.extras?.axis, [0, 0, -1]);
  const [x, y, z] = door.translation!;
  assert.ok(Math.abs(x - 1.5215) < 1e-3, `hinge x ${x}`);
  assert.ok(Math.abs(y - 4.28) < 1e-3, `hinge y ${y}`);
  assert.ok(Math.abs(z - (0.01 + 0.1 + 0.0015)) < 1e-3, `hinge z ${z} (floor finish + plinth)`);
  assert.ok(Math.abs(door.rotationZ! - 0) < 1e-9);
  // drop-down appliance doors hinge on a horizontal axis along the run
  const dw = leaves.find((n) => n.extras?.module === "dw")!;
  assert.equal(dw.extras?.hingeAxis, "x");
  assert.deepEqual(dw.extras?.axis, [1, 0, 0]);
});

test("open: true poses doors open and drawers out", () => {
  const closed = ok(room([kitchen()]));
  const open = ok(room([kitchen({ modules: kitchen().modules.map((m) => ({ ...m, open: true })) })]));
  const leaf = (c: ReturnType<typeof compile>, mod: string, name: string) => nodes(c.root, (n) => n.kind === "door_leaf" && n.extras?.module === mod && n.extras?.leaf === name)[0];
  assert.ok(Math.abs(leaf(open, "doors", "door").rotationZ! + (95 * Math.PI) / 180) < 1e-6);
  const d0 = leaf(closed, "drw", "drawer1").translation!, d1 = leaf(open, "drw", "drawer1").translation!;
  assert.ok(d0[1] - d1[1] > 0.3, "drawer pulled toward the room");
});

test("wall placement over a corner makes an L with a blind corner unit and a filler", () => {
  // ext loop: north wall runs from [6,5] to [0,5] (distance 11..17), west wall from [0,5] to [0,0] (17..22)
  const c = ok(
    room([
      {
        id: "L",
        wall: "ext",
        from: 13,
        to: 19.6,
        modules: [{ kind: "base_drawers", width: "auto" }, { kind: "corner" }, { kind: "base_doors", width: "auto" }],
        uppers: [],
      },
    ]),
  );
  const run = nodes(c.root, (n) => n.kind === "casework")[0];
  const mods = run.extras!.modules as { kind: string }[];
  assert.ok(mods.some((m) => m.kind === "corner"));
  assert.deepEqual(c.warnings, []);
});

test("auto widths fill the run, overflow is reported with the amount", () => {
  const c = ok(room([kitchen({ modules: [{ kind: "base_drawers", width: 2 }, { kind: "sink", width: 1.4 }], uppers: [] })]));
  assert.ok(c.warnings.some((w) => /need 3\.4 m but only 3 m is available.*reduce widths by 0\.4/.test(w)), c.warnings.join("\n"));
  const short = ok(room([kitchen({ modules: [{ kind: "base_drawers", width: 1 }], uppers: [] })]));
  assert.ok(short.warnings.some((w) => /fill 1 of 3 m — 2 m is left empty/.test(w)), short.warnings.join("\n"));
});

test("wall cabinets over a window, a hob under it and a worktop above the sill are reported", () => {
  const win = { openings: [{ id: "win", type: "window", at: [4.2, 5], width: 1.0, sill: 0.85 }] };
  const p = room([kitchen()], win);
  expectWarning(p, /wall cabinet .* covers window 'win'.*\{kind:'gap'/);
  expectWarning(p, /hob .* is under window 'win'/);
  expectWarning(p, /worktop \(0\.9 m\) runs into window 'win'.*sill: 0\.95/);
});

test("aisle in front of a run and island clearance", () => {
  const island = { id: "isl", position: [3, 3.3], facing: "north", length: 2, modules: [{ kind: "base_doors", width: "auto" }], island: { seating: 0.3 } };
  expectWarning(room([kitchen(), island]), /only 0\.\d+ m clear in front of .* up to island 'isl' — keep at least 1 m/);
  const far = { ...island, position: [3, 2.4] };
  const c = ok(room([kitchen(), far]));
  assert.ok(!c.warnings.some((w) => /clear in front/.test(w)), c.warnings.join("\n"));
});

test("fridge hinged against a wall and dishwasher at a corner are reported", () => {
  const p = room([
    {
      id: "k",
      path: [[0.12, 0.12], [0.12, 4.88], [3, 4.88]],
      modules: [{ id: "f", kind: "fridge", hinge: "left", width: 0.6 }, { kind: "base_drawers", width: "auto" }, { kind: "corner" }, { id: "dw", kind: "dishwasher" }, { kind: "base_doors", width: "auto" }],
    },
  ], { door: [4, 0] });
  expectWarning(p, /fridge .*f is hinged against the wall/);
  expectWarning(p, /dishwasher .*dw sits right at the corner/);
});

test("runs inside walls, blocking doors, and furniture in the cabinets are reported", () => {
  expectWarning(room([kitchen({ path: [[1.5, 4.95], [4.5, 4.95]] })]), /overlaps wall 'ext' by 0\.07 m — move the run 0\.07 m south/);
  expectWarning(room([kitchen({ path: [[3.5, 4.88], [6.3, 4.88]], modules: [{ kind: "base_drawers", width: "auto" }] })]), /runs 0\.42 m into wall 'ext'/);
  expectWarning(room([kitchen({ path: [[0.4, 0.12], [2.4, 0.12]], modules: [{ kind: "base_drawers", width: "auto" }], uppers: [] })]), /block.* door 'door'/);
  expectWarning(room([kitchen()], { furniture: [{ id: "chairX", type: "armchair", position: [2, 4.5] }] }), /furniture 'chairX' .* overlaps k\//);
});

test("wrong rows are errors; unknown wall is an error", () => {
  const bad = compile(room([kitchen({ modules: [{ kind: "upper_glass" }] })]));
  assert.ok(bad.errors.some((e) => /upper_glass.*move it to `uppers`/.test(e)), bad.errors.join("\n"));
  const noWall = compile(room([{ id: "w", wall: "nope", modules: [{ kind: "base_doors" }] }]));
  assert.ok(noWall.errors.some((e) => /wall 'nope' not found/.test(e)));
});

test("sliding wardrobe panels slide along the run; uppers skip tall units; hood aligns over the hob", () => {
  const c = ok(
    room([
      { id: "wr", type: "wardrobe", path: [[0.12, 1], [0.12, 3.4]], slidingDoors: true, modules: [{ kind: "wardrobe", width: "auto" }, { kind: "wardrobe", width: "auto", interior: "mixed" }] },
      kitchen({ path: [[2, 4.88], [5.88, 4.88]], modules: [{ kind: "pantry" }, ...kitchen().modules] }),
    ]),
  );
  const panels = nodes(c.root, (n) => n.kind === "door_leaf" && n.extras?.role === "sliding_door");
  assert.ok(panels.length >= 2);
  for (const p of panels) assert.equal(Math.abs((p.extras!.slideAxis as number[])[1]), 1, "west wall run: panels slide north/south");
  const inner = nodes(c.root, (n) => n.kind === "door_leaf" && String(n.extras?.leaf).startsWith("inner_drawer"));
  assert.ok(inner.length >= 3, "mixed interior has internal drawers");
  const k = nodes(c.root, (n) => n.kind === "casework" && n.name === "k")[0];
  const uppers = k.extras!.uppers as { kind: string; width: number }[];
  const mods = k.extras!.modules as { id: string; kind: string; width: number }[];
  const hob = mods.find((m) => m.kind === "hob")!;
  assert.equal(uppers.find((u) => u.kind === "hood")!.width, hob.width);
  // uppers fill the run minus the pantry (0.6) and the hood
  const total = uppers.reduce((s, u) => s + u.width, 0);
  assert.ok(Math.abs(total - (3.88 - 0.6)) < 0.01, `uppers total ${total}`);
});

test("vanity, media wall, bench and desk types build", () => {
  const c = ok(
    room([
      { id: "v", type: "vanity", path: [[0.12, 1.5], [0.12, 3.1]], modules: [{ kind: "basin", width: "auto" }, { kind: "basin", width: "auto", basin: "undermount" }] },
      { id: "m", type: "media", path: [[5.88, 1.0], [5.88, 4.0]], modules: [{ kind: "tall_open", width: 0.6 }, { kind: "base_drawers", width: "auto" }, { kind: "tall_open", width: 0.6 }] },
      { id: "b", type: "bench", path: [[2.5, 0.12], [1.8, 0.12]], front: "left", modules: [{ kind: "bench", width: "auto" }] },
      { id: "d", type: "desk", path: [[1.2, 4.88], [3.6, 4.88]], modules: [{ kind: "base_drawers", width: 0.45 }, { kind: "desk", width: "auto" }] },
    ]),
  );
  const runs = nodes(c.root, (n) => n.kind === "casework");
  assert.equal(runs.length, 4);
  for (const r of runs) assert.ok(r.meshes.length > 0, r.name);
});

test("plan drawing shows casework runs; game export keeps leaves movable with colliders", async () => {
  const c = ok(room([kitchen()]));
  const svg = renderPlanSVG(c, "g");
  assert.ok(svg.includes(">k<"), "run label");
  assert.ok(svg.includes("stroke-dasharray"), "wall cabinets dashed");
  const { toGltfDocument } = await import("../src/export/gltf.js");
  const doc = toGltfDocument(c, { textureSize: 0, merge: true, collision: true });
  const names = doc.getRoot().listNodes().map((n) => n.getName());
  assert.ok(names.some((n) => /^k_dw_door-convcolonly$/.test(n)), "drop-down door gets a box collider");
  assert.ok(names.some((n) => /^k_drw_drawer1$/.test(n)));
});

test("showcase example compiles without errors or warnings", () => {
  const p = JSON.parse(readFileSync(new URL("../examples/kitchen_showcase.json", import.meta.url), "utf8"));
  const c = ok(p);
  assert.deepEqual(c.warnings, []);
  assert.ok(nodes(c.root, (n) => n.kind === "casework").length >= 5);
});
