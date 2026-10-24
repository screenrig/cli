#!/usr/bin/env node
import { run } from "./main.js";
import { NODE_RUNTIME_REQUIREMENT, nodeRuntimeSupported } from "./node-runtime.js";

// Let Node drain stdout/stderr before terminating. Forced process.exit can
// truncate large JSON envelopes when output is piped to another process.
if (!nodeRuntimeSupported(process.versions.node)) {
  process.stderr.write(`ScreenRig requires ${NODE_RUNTIME_REQUIREMENT}; upgrade the active node runtime, then retry.\n`);
  process.exitCode = 69;
} else {
  process.exitCode = await run();
}
