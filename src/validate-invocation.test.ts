import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgv } from "./argv.js";
import { executeCommand } from "./program.js";
import { CliError } from "./problems.js";
import type { CliRuntime } from "./runtime.js";

const invalid = [
  ["screen", "update", "scr_TEST", "--name", "Lobby", "--expect-rev", "1", "--dry-run"],
  ["screen", "list", "--name", "Lobby"],
  ["screen", "show", "scr_TEST", "extra"],
  ["screen", "list", "--timeout", "oops"],
  ["screen", "list", "--timeout"],
  ["screen", "list", "--timeout="],
  ["screen", "list", "--timeout", "-1"],
  ["screen", "list", "--timeout", "Infinity"],
  ["screen", "list", "--timeout", "1.5"],
  ["screen", "list", "--json=false"],
  ["screen", "list", "--json", "--json"],
  ["screen", "list", "--state", "archived", "--state", "archived"],
  ["screen", "list", "-x"],
  ["screen", "show", "scr_TEST", "--name=secret"],
  ["screen", "archive", "scr_TEST", "--expect-rev", "oops"],
  ["media", "upload", "poster.png", "--no-transcode", "--codec", "h264"],
  ["media", "update", "med_TEST", "--tag", "x", "--clear-tag", "--expect-rev", "1"],
  ["feedback", "bug", "Title", "--body", "x", "--body-file", "x.md"],
  ["kv", "set", "key", "--application-id", "app_TEST", "--json-value", "{}", "--file", "x"],
  ["compose", "render", "page.json", "--target-width", "1920"],
  ["events", "list", "--after", "a", "--cursor", "b"],
  ["playlist", "import", "bundle", "--update", "pl_TEST"],
];

for (const [index, argv] of invalid.entries()) {
  test(`invalid invocation ${index + 1} is rejected before accessing runtime`, async () => {
    const runtime = new Proxy({} as CliRuntime, { get() { assert.fail("invalid invocation accessed runtime"); } });
    await assert.rejects(async () => executeCommand(argv, runtime), (error: unknown) => error instanceof CliError && error.problem.code === "usage_error");
  });
}

test("supported values, aliases, empty byte payload, and help paths remain valid", () => {
  for (const argv of [
    ["screen", "update", "scr_TEST", "--name=Lobby=North", "--expect-rev", '"1"'],
    ["screen", "screenshot", "scr_TEST", "--timeout", "0"],
    ["events", "follow", "--timeout", "0"],
    ["playlist", "get", "pl_TEST"],
    ["app", "pack", "--", "--directory"],
    ["kv", "set", "key", "--application-id", "app_TEST", "--value-base64=", "--content-type", "text/plain"],
    ["--help"], ["--version"], ["screen"], ["comment", "show"],
    ["screen", "assign", "--help"], ["help", "comment", "show", "screen"], ["help", "help"],
  ]) assert.doesNotThrow(() => parseArgv(argv), JSON.stringify(argv));
  assert.equal(parseArgv(["app", "pack", "--", "--directory"]).positionals[2], "--directory");
});

test("unknown option names and invalid values never appear in usage errors", () => {
  for (const argv of [["screen", "list", "--private-secret=value"], ["screen", "list", "--timeout=private-secret"]]) {
    assert.throws(() => parseArgv(argv), (error: unknown) => error instanceof CliError && !JSON.stringify(error.problem).includes("private-secret"));
  }
});
