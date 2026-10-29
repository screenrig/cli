import assert from "node:assert/strict";
import test from "node:test";
import { Command } from "commander";
import { COMMAND_BUNDLES, TOP_LEVEL_COMMANDS, commandBundlesFor, type CommandBundle } from "./index.js";

test("each bundle registers exactly the top-level commands the catalog assigns it", async () => {
  const registered: Record<string, CommandBundle> = {};
  for (const bundle of Object.keys(COMMAND_BUNDLES) as CommandBundle[]) {
    const root = new Command();
    (await COMMAND_BUNDLES[bundle]()).register(root, () => () => undefined);
    for (const command of root.commands) {
      assert.equal(registered[command.name()], undefined, `${command.name()} is registered by two bundles`);
      registered[command.name()] = bundle;
    }
  }
  assert.deepEqual(registered, TOP_LEVEL_COMMANDS);
});

test("an invocation loads only its command's bundle; help and unknown commands load every bundle", () => {
  const all = Object.keys(COMMAND_BUNDLES);
  const first = Object.keys(TOP_LEVEL_COMMANDS)[0]!;
  assert.deepEqual(commandBundlesFor([first, "list"]), [TOP_LEVEL_COMMANDS[first]]);
  assert.deepEqual(commandBundlesFor(["--json", "--config", first, first, "--help"]), [TOP_LEVEL_COMMANDS[first]]);
  assert.deepEqual(commandBundlesFor(["--timeout=5", first]), [TOP_LEVEL_COMMANDS[first]]);
  assert.deepEqual(commandBundlesFor(["help", first]), all);
  assert.deepEqual(commandBundlesFor([]), all);
  assert.deepEqual(commandBundlesFor(["no-such-command"]), all);
  assert.deepEqual(commandBundlesFor(["--", first]), all);
});
