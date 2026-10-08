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
  ["playlist", "import", "bundle", "--expect-rev", "1"],
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

test("a lone - is accepted wherever the help documents stdin, and only there", () => {
  for (const [argv, name] of [
    [["kv", "set", "key", "--application-id", "app_TEST", "--file", "-"], "file"],
    [["screen", "schedule", "set", "scr_TEST", "--file", "-"], "file"],
    [["screen", "display-schedule", "set", "scr_TEST", "--file", "-"], "file"],
    [["media", "generate", "--prompt-file", "-"], "prompt-file"],
    [["comment", "set", "screen", "scr_TEST", "--file", "-"], "file"],
    [["playback", "plays", "--from", "7d", "--format", "csv", "--output", "-"], "output"],
  ] as const) {
    const parsed = parseArgv([...argv]);
    assert.equal(parsed.flags[name], "-", JSON.stringify(argv));
  }
  // --body-file does not document stdin, so a lone - is still read as a missing value.
  assert.throws(() => parseArgv(["feedback", "bug", "Title", "--body-file", "-"]), (error: unknown) => error instanceof CliError && /--body-file requires a value/.test(error.problem.detail));
});

test("option values never appear in usage errors; an unknown option is named only by its plain name", () => {
  assert.throws(() => parseArgv(["screen", "list", "--timeout=private-secret"]), (error: unknown) => error instanceof CliError && !JSON.stringify(error.problem).includes("private-secret"));
  assert.throws(() => parseArgv(["screen", "list", "--unknown-flag=private-secret"]), (error: unknown) => error instanceof CliError
    && error.problem.detail === "screen list does not accept --unknown-flag. See command help for supported options."
    && !JSON.stringify(error.problem).includes("private-secret"));
  assert.throws(() => parseArgv(["screen", "list", "-x"]), (error: unknown) => error instanceof CliError && error.problem.detail.includes("does not accept -x"));
  // A name that is not a plain option shape (a pasted credential, say) is never echoed.
  for (const argv of [["screen", "list", "--sr_live_private_secret"], ["screen", "list", `--${"a".repeat(60)}`]]) {
    assert.throws(() => parseArgv(argv), (error: unknown) => error instanceof CliError && error.problem.code === "usage_error"
      && !JSON.stringify(error.problem).includes("private_secret") && !JSON.stringify(error.problem).includes("a".repeat(60)));
  }
});

test("an unknown subcommand is named when it is a plain command word", () => {
  assert.throws(() => parseArgv(["screen", "frobnicate"]), (error: unknown) => error instanceof CliError && /frobnicate/.test(error.problem.detail));
});

test("conflicting options are named by their declared flags", () => {
  assert.throws(() => parseArgv(["media", "upload", "poster.png", "--no-transcode", "--codec", "h264"]),
    (error: unknown) => error instanceof CliError && /--no-transcode cannot be used with --codec|--codec cannot be used with --no-transcode/.test(error.problem.detail));
});
