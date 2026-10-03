import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

type R = { content: { type: string; text?: string; data?: string }[]; isError?: boolean };

test("MCP server: create, edit, validate, render, export", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arch-mcp-"));
  const plan = join(dir, "plan.json");
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StdioClientTransport({ command: "npx", args: ["tsx", "src/mcp/server.ts"] }));
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as R;
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    for (const t of ["get_guide", "create_project", "add_elements", "render_view", "export_model"]) assert.ok(tools.includes(t), t);

    const guide = await call("get_guide");
    assert.match(guide.content[0].text!, /Coordinates/);

    let r = await call("create_project", { path: plan });
    assert.match(r.content[0].text!, /Plan is valid/);

    r = await call("add_elements", {
      path: plan,
      level: "ground",
      elements: { furniture: [{ type: "sofa", position: [3, 1], facing: "north" }], openings: [{ type: "window", at: [0, 2] }] },
    });
    assert.match(r.content[0].text!, /Added .*sofa_1/);
    assert.match(r.content[0].text!, /Plan is valid/);

    r = await call("update_element", { path: plan, id: "front_door", changes: { style: "double", width: 1.4 } });
    assert.match(r.content[0].text!, /Updated openings 'front_door'/);

    // a mistake should come back as a readable error, not a crash
    r = await call("add_elements", { path: plan, level: "ground", elements: { furniture: [{ type: "sofaa", position: [1, 1] }] } });
    assert.match(r.content[0].text!, /unknown type 'sofaa'. Did you mean: sofa/);
    r = await call("remove_elements", { path: plan, ids: ["sofaa_1"] });
    assert.match(r.content[0].text!, /Plan is valid/);

    const plan2d = await call("render_plan", { path: plan });
    assert.equal(plan2d.content[0].type, "image");
    const view = await call("render_view", { path: plan, view: "iso", width: 400, height: 300 });
    assert.equal(view.content[0].type, "image");
    assert.ok(Buffer.from(view.content[0].data!, "base64").length > 10_000);

    const fit = await call("cost_estimate", { path: plan });
    assert.match(fit.content[0].text!, /fit-out only/);
    const full = await call("cost_estimate", { path: plan, scope: "full" });
    assert.match(full.content[0].text!, /A\. Structure & shell/);

    // a product without a price is an allowance the AI is asked to research; {id, price} fills it in
    r = await call("import_product", { path: plan, id: "lamp_x", name: "Lamp X", type: "floor_lamp", place: { position: [1, 1] } });
    assert.ok(!r.isError, r.content[0].text);
    r = await call("cost_estimate", { path: plan });
    assert.match(r.content[0].text!, /PRODUCTS WITHOUT A PRICE[\s\S]*lamp_x: Lamp X — allowance/);
    r = await call("import_product", { path: plan, id: "lamp_x", price: 25, currency: "KWD" });
    assert.match(r.content[0].text!, /Updated product 'lamp_x': Lamp X/);
    r = await call("cost_estimate", { path: plan, lines: true });
    assert.ok(!/PRODUCTS WITHOUT A PRICE/.test(r.content[0].text!));
    assert.match(r.content[0].text!, /Lamp X \| 1 \| no \| 25\.00/);

    const out = join(dir, "plan.glb");
    r = await call("export_model", { path: plan, output: out, textureSize: 128 });
    assert.ok(!r.isError, r.content[0].text);
    assert.ok(existsSync(out) && statSync(out).size > 50_000);
  } finally {
    await client.close();
  }
});
