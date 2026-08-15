#!/usr/bin/env node
import { run } from "./main.js";

const code = await run();
process.exit(code);
