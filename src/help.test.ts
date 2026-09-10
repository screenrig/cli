import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { COMMAND_SPECS } from "./command-spec.js";
import { createCommandTree, findCommand } from "./command-tree.js";
import { commandHelp, leafCommandPaths } from "./help.js";
import { CLI_VERSION } from "./version.js";

const bin = fileURLToPath(new URL("./bin.js", import.meta.url));
function invoke(args: string[]): { data: ReturnType<typeof commandHelp> & { version?: string } } {
  return JSON.parse(execFileSync(process.execPath, [bin, "--json", ...args], {
    encoding: "utf8", env: { ...process.env, SCREENRIG_CONFIG: "/nonexistent/screenrig-help-config" },
  }));
}

test("root help is compact and every command is discoverable through immediate children", () => {
  const root = commandHelp();
  const commanderHelp = root.usage.split(/\n\nAll commands:\n/)[0]!;
  assert.ok(commanderHelp.split("\n").length < 35);
  assert.doesNotMatch(root.usage, /localhost|log_socket|--token/);
  const discovered: string[] = [];
  function visit(path: string[]): void {
    const help = commandHelp(path);
    if (help.kind === "command") {
      if (path.join(" ") !== "help") discovered.push(path.join(" "));
      assert.ok(help.synopsis.every((line) => line.startsWith(`screenrig ${path.join(" ")}`)));
      assert.equal(help.usage.includes("\nAll commands:\n"), false);
      return;
    }
    for (const child of help.commands) {
      assert.equal(child.path.length, path.length + 1);
      visit(child.path);
    }
  }
  visit([]);
  assert.deepEqual(discovered.sort(), COMMAND_SPECS.map((spec) => spec.path.join(" ")).sort());
  const inventory = leafCommandPaths(createCommandTree().root);
  assert.ok(inventory.includes("help"));
  for (const path of inventory) {
    assert.ok(root.usage.includes(path), path);
  }
  assert.ok(root.commands.every((child) => child.path.length === 1));
  assert.equal(root.commands.some((child) => child.name === "generate"), false);
});

test("group help stays focused and still names descendant leaf paths", () => {
  const media = commandHelp(["media"]);
  assert.match(media.usage, /Usage: screenrig media \[options\] \[command\]/);
  assert.ok(media.commands.every((child) => child.path[0] === "media" && child.path.length === 2));
  assert.deepEqual(media.commands.map((child) => child.name), [
    "generate", "upload", "upload-batch", "show", "download", "list", "update", "delete",
  ]);
  for (const path of leafCommandPaths(findCommand(createCommandTree().root, ["media"])!)) {
    assert.ok(media.usage.includes(path), path);
  }
  assert.doesNotMatch(media.usage, /screen assign|account show|agent enroll|playlist create/);
});

test("human root --help includes every taught leaf command path", () => {
  const text = execFileSync(process.execPath, [bin, "--help"], {
    encoding: "utf8", env: { ...process.env, SCREENRIG_CONFIG: "/nonexistent/screenrig-help-config" },
  });
  for (const spec of COMMAND_SPECS) {
    const path = spec.path.join(" ");
    assert.ok(text.includes(path), path);
    for (const alias of spec.aliases ?? []) assert.ok(text.includes(alias.join(" ")), alias.join(" "));
  }
});

test("help paths, --help, and bare groups work before configuration or authentication", () => {
  for (const path of [[], ["screen"], ["screen", "assign"], ["comment"], ["comment", "set"], ["comment", "set", "playlist"]]) {
    const flagged = invoke([...path, "--help"]);
    assert.deepEqual(flagged, invoke(["help", ...path]));
    assert.deepEqual(flagged.data.path, path);
    if (flagged.data.kind === "group") assert.deepEqual(flagged, invoke(path));
  }
  const action = invoke(["screen", "assign", "--help"]).data;
  assert.match(action.usage, /Usage: screenrig screen assign \[options\] <id>/);
  for (const name of ["--playlist-id", "--if-match"]) {
    const option = action.options.find((item) => item.name === name);
    assert.equal(option?.type, "value");
    assert.ok(option?.description);
  }
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
    const envelope = JSON.parse(failure.stdout);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error.code, "usage_error");
    assert.equal(envelope.error.status, 400);
    assert.equal(Object.hasOwn(envelope, "data"), false);
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

test("negative switches are documented as booleans without value placeholders", () => {
  const help = invoke(["media", "upload", "--help"]).data;
  for (const name of ["--no-wait", "--no-transcode", "--no-progress", "--no-audio"]) {
    const option = help.options.find((item) => item.name === name);
    assert.equal(option?.type, "boolean", name);
    assert.ok(option?.description, name);
    assert.match(help.usage, new RegExp(`${name}\\s+[^<\\s]`));
  }
});
