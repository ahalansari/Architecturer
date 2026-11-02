#!/usr/bin/env node
import { withHeap } from "./heap.js";
withHeap(new URL("../dist/mcp/server.js", import.meta.url).href);
