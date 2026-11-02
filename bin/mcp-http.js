#!/usr/bin/env node
import { withHeap } from "./heap.js";
withHeap(new URL("../dist/mcp/http.js", import.meta.url).href);
