#!/usr/bin/env node
import { run } from "./main.js";

// Let Node drain stdout/stderr before terminating. Forced process.exit can
// truncate large JSON envelopes when output is piped to another process.
process.exitCode = await run();
