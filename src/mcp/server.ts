#!/usr/bin/env node
/** Local MCP server over stdio (Claude Code, Claude Desktop, any local MCP client). The remote one is http.ts. */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { inlineEngine } from "./engine.js";
import { createMcpServer } from "./tools.js";
import { KeyedLock, Workspace } from "./workspace.js";

/**
 * Relative paths resolve against ARCHITECTURER_WORKDIR, else the working directory. Apps like Claude
 * Desktop start servers in "/", so there we fall back to ~/Architecturer instead of the disk root.
 */
const WORKDIR =
  process.env.ARCHITECTURER_WORKDIR ?? (process.cwd() === "/" ? join(homedir(), "Architecturer") : process.cwd());

const server = createMcpServer({ ws: new Workspace(WORKDIR, false), engine: inlineEngine, lock: new KeyedLock() });
await server.connect(new StdioServerTransport());
