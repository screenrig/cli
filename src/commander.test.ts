import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parseArgv } from "./argv.js";
import { commandHelp } from "./help.js";
import { CliError } from "./problems.js";

const usage = (error: unknown) => error instanceof CliError && error.problem.code === "usage_error";

test("negated options only become flags when explicitly supplied", () => {
  const plain = parseArgv(["media", "upload", "clip.mp4"]);
  for (const name of ["no-wait", "no-audio", "no-transcode", "no-progress"]) assert.equal(Object.hasOwn(plain.flags, name), false);
  const provided = parseArgv(["media", "upload", "clip.mp4", "--no-wait", "--no-audio", "--no-progress"]);
  for (const name of ["no-wait", "no-audio", "no-progress"]) assert.equal(provided.flags[name], true);
  assert.equal(Object.hasOwn(parseArgv(["media", "upload", "clip.mp4"]).flags, "no-wait"), false, "parse state must not leak between invocations");
});

test("global options retain their meaning around nested command paths", () => {
  for (const argv of [
    ["--json", "--timeout", "5", "screen", "show", "scr_TEST"],
    ["screen", "--json", "show", "scr_TEST", "--timeout", "5"],
    ["screen", "show", "scr_TEST", "--timeout", "5", "--json"],
  ]) {
    assert.deepEqual({ ...parseArgv(argv).flags }, { json: true, timeout: "5" });
    assert.deepEqual(parseArgv(argv).positionals, ["screen", "show", "scr_TEST"]);
  }
});

test("missing option values cannot swallow switches or use text after the terminator", () => {
  for (const argv of [
    ["app", "upload", "site", "--name", "--no-wait"],
    ["app", "upload", "--name", "--no-wait", "--", "--name=--no-wait"],
    ["screen", "list", "--timeout", "--json"],
    ["--help", "-h"], ["--version", "-V"],
  ]) assert.throws(() => parseArgv(argv), usage);
  assert.equal(parseArgv(["app", "upload", "site", "--name=--no-wait"]).flags.name, "--no-wait");
  assert.equal(parseArgv(["app", "pack", "--", "--help"]).positionals[2], "--help");
});

test("command-specific flags are scoped to their command", () => {
  assert.throws(() => parseArgv(["screen", "list", "--name", "Lobby"]), usage);
  assert.throws(() => parseArgv(["--name", "Lobby", "screen", "update", "scr_TEST", "--if-match", "1"]), usage);
  assert.equal(parseArgv(["screen", "update", "scr_TEST", "--name", "Lobby", "--if-match", "1"]).flags.name, "Lobby");
});

test("required options are discoverable and enforced before dispatch", () => {
  assert.throws(() => parseArgv(["screen", "assign", "scr_TEST"]), usage);
  const help = commandHelp(["screen", "assign"]);
  for (const name of ["--playlist-id", "--if-match"]) assert.equal(help.options.find((option) => option.name === name)?.required, true);
  assert.doesNotThrow(() => parseArgv(["screen", "assign", "--help"]));
});

test("Commander errors use one secret-safe envelope and never raw output", () => {
  const bin = fileURLToPath(new URL("bin.js", import.meta.url));
  for (const argv of [["--json", "screen", "list", "--private-secret=value"], ["--json", "screen", "list", "--timeout", "private-secret"]]) {
    assert.throws(() => execFileSync(process.execPath, [bin, ...argv], { encoding: "utf8", stdio: "pipe" }), (error: unknown) => {
      const result = error as { status: number; stdout: string; stderr: string };
      assert.equal(result.status, 2);
      assert.equal(result.stderr, "");
      const envelope = JSON.parse(result.stdout);
      assert.equal(envelope.ok, false);
      assert.equal(envelope.error.code, "usage_error");
      assert.doesNotMatch(result.stdout, /private-secret/);
      return true;
    });
  }
});
