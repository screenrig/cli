import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { COMMAND_SPECS } from "./command-spec.js";
import { commandHelp } from "./help.js";
import { CLI_VERSION } from "./version.js";

const bin = fileURLToPath(new URL("./bin.js", import.meta.url));
function invoke(args: string[]): { data: ReturnType<typeof commandHelp> & { version?: string } } {
  return JSON.parse(execFileSync(process.execPath, [bin, "--json", ...args], {
    encoding: "utf8", env: { ...process.env, SCREENRIG_CONFIG: "/nonexistent/screenrig-help-config" },
  }));
}

test("root help is compact and every command is discoverable through immediate children", () => {
  const root = commandHelp();
  assert.ok(root.usage.split("\n").length < 35);
  assert.doesNotMatch(root.usage, /localhost|log_socket|media upload|screen assign|--token/);
  const discovered: string[] = [];
  function visit(path: string[]): void {
    const help = commandHelp(path);
    if (help.kind === "command") {
      if (path.join(" ") !== "help") discovered.push(path.join(" "));
      assert.ok(help.synopsis.every((line) => line.startsWith(`screenrig ${path.join(" ")}`)));
      return;
    }
    for (const child of help.commands) {
      assert.equal(child.path.length, path.length + 1);
      visit(child.path);
    }
  }
  visit([]);
  assert.deepEqual(discovered.sort(), COMMAND_SPECS.map((spec) => spec.path.join(" ")).sort());
});

test("help paths, --help, and bare groups work before configuration or authentication", () => {
  for (const path of [[], ["screen"], ["screen", "assign"], ["comment"], ["comment", "set"], ["comment", "set", "playlist"]]) {
    const flagged = invoke([...path, "--help"]);
    assert.deepEqual(flagged, invoke(["help", ...path]));
    assert.deepEqual(flagged.data.path, path);
    if (flagged.data.kind === "group") assert.deepEqual(flagged, invoke(path));
  }
  const action = invoke(["screen", "assign", "--help"]).data;
  assert.match(action.usage, /--playlist-id ID --if-match REVISION/);
  assert.ok(action.options.some((option) => option.name === "--playlist-id" && option.type === "value"));
  assert.deepEqual(invoke(["comment", "show", "--help"]).data.commands.map((item) => item.name), ["screen", "playlist"]);
});

test("version aliases report version without needing a positional command", () => {
  for (const args of [["version"], ["--version"], ["-V"]]) {
    assert.equal(invoke(args).data.version, CLI_VERSION);
  }
  assert.deepEqual(invoke(["version", "--help"]).data.path, ["version"]);
});

test("unknown help paths fail rather than silently showing root help", () => {
  assert.throws(() => invoke(["help", "screen", "assgin"]), (error: unknown) => {
    const failure = error as { status: number; stdout: string };
    assert.equal(failure.status, 2);
    assert.match(failure.stdout, /Unknown help topic/);
    return true;
  });
});

test("compatibility aliases resolve canonical help", () => {
  assert.deepEqual(commandHelp(["playlist", "get"]), commandHelp(["playlist", "show"]));
  assert.deepEqual(commandHelp(["playlist", "show"]).aliases, [["playlist", "get"]]);
});

test("help appended to an invocation resolves the command without echoing argument values", () => {
  assert.deepEqual(invoke(["screen", "assign", "scr_TEST", "--help"]), invoke(["screen", "assign", "--help"]));
  assert.deepEqual(invoke(["playlist", "get", "pl_TEST", "--help"]), invoke(["playlist", "show", "--help"]));
});
