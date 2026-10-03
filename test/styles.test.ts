import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { STYLE_PRESETS, applyStyles } from "../src/elements/styles.js";
import { resolveMaterial } from "../src/materials/library.js";
import { compile } from "../src/pipeline.js";

const house = JSON.parse(readFileSync(new URL("../examples/house.json", import.meta.url), "utf8"));

test("every style preset only uses resolvable materials", () => {
  for (const [name, p] of Object.entries(STYLE_PRESETS)) {
    const custom = (p.materials ?? {}) as Record<string, any>;
    for (const [role, mat] of Object.entries(p.palette)) assert.doesNotThrow(() => resolveMaterial(mat!, custom), `${name}.${role} = ${mat}`);
  }
});

test("project style fills unset materials, explicit ones win", () => {
  const plan = structuredClone(house);
  plan.style = "japandi";
  const styled: any = applyStyles(plan);
  const sofa = styled.levels[0].furniture.find((f: any) => f.type === "sofa");
  assert.equal(sofa.materials.body, "style_japandi_fabric");
  const explicit = styled.levels[0].rooms.find((r: any) => r.name === "Living room");
  assert.equal(explicit.floorMaterial, "wood_floor_oak"); // set explicitly in the plan: kept
  assert.ok(styled.materials.style_japandi_fabric);
  for (const name of Object.keys(STYLE_PRESETS)) {
    const c = compile({ ...structuredClone(house), style: name });
    assert.deepEqual(c.errors, [], name);
  }
});

test("room style overrides the project style for furniture inside it", () => {
  const plan = structuredClone(house);
  plan.style = "scandinavian";
  plan.levels[0].rooms.find((r: any) => r.name === "Dining").style = { base: "industrial", upholstery: "leather_black" };
  const styled: any = applyStyles(plan);
  const chair = styled.levels[0].furniture.find((f: any) => f.type === "chair");
  assert.equal(chair.materials.frame, "wood_dark"); // industrial wood
  assert.equal(chair.materials.seat, "leather_black"); // role override
  const sofa = styled.levels[0].furniture.find((f: any) => f.type === "sofa");
  assert.equal(sofa.materials.body, "style_scandi_fabric"); // living room keeps the project style
});
