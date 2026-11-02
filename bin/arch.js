#!/usr/bin/env node
import { withHeap } from "./heap.js";
withHeap(new URL("../dist/cli/main.js", import.meta.url).href);
