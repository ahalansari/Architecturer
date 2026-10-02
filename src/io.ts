import { readFile } from "node:fs/promises";
import { compile, type Compiled } from "./pipeline.js";

export async function readJson(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error(`cannot read ${path}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${path} is not valid JSON: ${(e as Error).message}`);
  }
}

export async function loadAndCompile(path: string): Promise<Compiled> {
  return compile(await readJson(path));
}
