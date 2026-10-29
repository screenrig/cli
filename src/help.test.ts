import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
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
  // Service status, support, notes, fleet links, triggers, reviews, campaigns, notifications, alerts, migrate, sources and bi add twelve immediate root groups.
  assert.ok(commanderHelp.split("\n").length <= 61);
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
  assert.deepEqual(discovered.sort(), [
    "project token", "card preview", "card create", "card list", "card show", "card params", "card delete", "card data get", "card data put",
    "cards list", "cards show", "card-data get", "card-data put", "card-data list", "card-data delete", "feeds get",
    "recovery list",
    "recovery show",
    "recovery reconcile",
    "migrate vendors",
    "migrate scan",
    "migrate apply",
    "migrate pair",
    "reviews list",
    "reviews show",
    "reviews withdraw",
    "project list",
    "organization list",
    "organization rename",
    "project create",
    "project use",
    "project moves",
    "project move",
    "project transfer-owner",
    "project deletion-preview",
    "project delete",
    "project show",
    "project capabilities",
    "project rename",
    "invitations create",
    "invitations list",
    "invitations revoke",
    "ads networks list",
    "ads networks show",
    "ads network show",
    "ads network create",
    "ads network rate",
    "ads inventory list",
    "ads inventory update",
    "ads slots list",
    "ads slots create",
    "ads slots update",
    "ads memberships list",
    "ads memberships update",
    "ads memberships revoke",
    "ads creatives list",
    "ads creatives create",
    "ads creatives show",
    "ads campaigns list",
    "ads campaigns show",
    "ads campaigns create",
    "ads campaigns update",
    "ads campaigns preview",
    "ads campaigns activate",
    "ads campaigns pause",
    "ads campaigns resume",
    "ads campaigns accept-rates",
    "ads reviews list",
    "ads reviews approve",
    "ads reviews reject",
    "ads reviews request-changes",
    "ads reviews show",
    "ads reports spend",
    "ads reports delivery",
    "ads reports fill",
    "ads direct list",
    "ads direct show",
    "ads direct create",
    "ads direct update",
    "ads direct pause",
    "ads direct resume",
    "ads direct end",
    "ads direct report",
    "ads direct availability",
    "billing balance",
    "billing statement",
    "agent enroll",
    "agent connect",
    "agent status",
    "agent disconnect",
    "agent revoke-identity",
    "login",
    "logout",
    "service-client list",
    "service-client show",
    "service-client create",
    "service-client add-key",
    "service-client add-secret",
    "service-client remove-key",
    "service-client remove-secret",
    "service-client revoke",
    "dashboard open",
    "dashboard reset-sign-in",
    "app pack",
    "app upload",
    "app update",
    "app rename",
    "app list",
    "app show",
    "app delete",
    "media generate",
    "media upload",
    "media upload-batch",
    "media show",
    "media download",
    "media list",
    "media selector-preview",
    "media update",
    "media delete",
    "media move",
    "media folder list",
    "media folder show",
    "media folder create",
    "media folder update",
    "media folder delete",
    "media sync account add microsoft365",
    "media sync account list",
    "media sync account show",
    "media sync account update",
    "media sync account test",
    "media sync account delete",
    "media sync create sharepoint",
    "media sync list",
    "media sync show",
    "media sync update",
    "media sync run",
    "media sync delete",
    "compose catalog",
    "compose batch",
    "compose render",
    "playlist init",
    "playlist validate",
    "playlist preview",
    "playlist replace-release",
    "playlist templates",
    "playlist create",
    "playlist update",
    "playlist patch",
    "playlist rename",
    "playlist export",
    "playlist import",
    "playlist show",
    "playlist list",
    "playlist page add",
    "playlist page remove",
    "playlist page replace",
    "playlist revisions",
    "playlist revision show",
    "playlist promote",
    "playlist delete",
    "screen publish",
    "screen pair",
    "screen provision",
    "browser setup",
    "fleet-links create",
    "fleet-links list",
    "fleet-links show",
    "fleet-links update",
    "fleet-links rotate",
    "fleet-links delete",
    "triggers create",
    "triggers list",
    "triggers show",
    "triggers test",
    "triggers update",
    "triggers deliveries",
    "triggers clear",
    "triggers rotate-secret",
    "triggers delete",
    "campaign list",
    "campaign show",
    "campaign create",
    "campaign update",
    "campaign pause",
    "campaign resume",
    "campaign delete",
    "campaign screens",
    "campaign explain",
    "screen update",
    "screen list",
    "screen live frame",
    "screen live start",
    "screen live status",
    "screen live stop",
    "screen show",
    "screen storage-forecast",
    "screen assign",
    "screen set-timezone",
    "screen wall set",
    "screen wall clear",
    "screen archive",
    "screen unarchive",
    "screen delete",
    "screen rotate-public-id",
    "screen recover",
    "screen reload",
    "screen toast",
    "screen play-page",
    "screen identify",
    "screen link create",
    "screen link delete",
    "screen link show",
    "screen suspend",
    "screen resume",
    "screen replace",
    "screen command cancel",
    "screen screenshot",
    "screen tag",
    "kv get",
    "kv set",
    "kv delete",
    "kv list",
    "kv webhook create",
    "kv webhook list",
    "kv webhook rotate-secret",
    "kv webhook delete",
    "kv webhook update",
    "kv webhook deliveries",
    "comment show screen",
    "comment show playlist",
    "comment set screen",
    "comment set playlist",
    "comment delete screen",
    "comment delete playlist",
    "operations show",
    "operations wait",
    "operations cancel",
    "events list",
    "events follow",
    "notes list",
    "notes show",
    "notes add",
    "notes confirm",
    "notes resolve",
    "playback list",
    "playback plays",
    "playback totals",
    "playback completeness",
    "screen uptime",
    "screen presence",
    "screen health-history",
    "project uptime",
    "project health-trend",
    "support status",
    "support submit",
    "support history",
    "support close",
    "support follow",
    "support read",
    "feedback bug",
    "feedback feature",
    "feedback list",
    "feedback reply",
    "feedback show",
    "screen schedule show",
    "screen schedule set",
    "screen schedule clear",
    "screen takeover set",
    "screen takeover clear",
    "screen reboot",
    "screen display set",
    "screen display clear",
    "screen display-schedule show",
    "screen display-schedule set",
    "screen display-schedule clear",
    "webhooks create",
    "webhooks list",
    "webhooks show",
    "webhooks update",
    "webhooks delete",
    "webhooks rotate-secret",
    "webhooks test",
    "webhooks deliveries",
    "notifications create",
    "notifications list",
    "notifications show",
    "notifications update",
    "notifications delete",
    "notifications rotate-secret",
    "notifications test",
    "notifications resubscribe",
    "notifications deliveries",
    "alerts list",
    "alerts show",
    "alerts ack",
    "alerts snooze",
    "alerts mute",
    "alerts mutes",
    "alerts unmute",
    "bi connection create grafana",
    "bi connection create powerbi",
    "bi connection create tableau",
    "bi connection list",
    "bi connection show",
    "bi connection update",
    "bi connection test",
    "bi connection browse",
    "bi connection delete",
    "bi view create",
    "bi view list",
    "bi view show",
    "bi view update",
    "bi view test",
    "bi view delete",
    "source list",
    "source show",
    "source create",
    "source update",
    "source test",
    "source refresh",
    "source delete",
    "doctor",
    "version",
    "status",
  ].sort());
  assert.equal(root.allCommands, undefined);
  assert.doesNotMatch(root.usage, /All commands:/);
  const inventory = leafCommandPaths(createCommandTree().root);
  assert.ok(inventory.includes("help"));
  for (const path of inventory) {
    assert.ok(commandHelp([], true).usage.includes(path), path);
  }
  assert.ok(root.commands.every((child) => child.path.length === 1));
  assert.equal(root.commands.some((child) => child.name === "generate"), false);
});

test("group help stays focused and still names descendant leaf paths", () => {
  const media = commandHelp(["media"], true);
  assert.match(media.usage, /Usage: screenrig media \[options\] \[command\]/);
  assert.ok(media.commands.every((child) => child.path[0] === "media" && child.path.length === 2));
  assert.deepEqual(media.commands.map((child) => child.name), [
    "generate", "upload", "upload-batch", "show", "download", "list", "selector-preview", "update", "delete", "move", "folder", "sync",
  ]);
  for (const path of leafCommandPaths(findCommand(createCommandTree().root, ["media"])!)) {
    assert.ok(media.usage.includes(path), path);
  }
  assert.doesNotMatch(media.usage, /screen assign|project show|agent enroll|playlist create/);
});

test("explicit human inventory includes every leaf while default root stays compact", () => {
  const text = execFileSync(process.execPath, [bin, "help", "--all"], {
    encoding: "utf8", env: { ...process.env, SCREENRIG_CONFIG: "/nonexistent/screenrig-help-config" },
  });
  for (const path of leafCommandPaths(createCommandTree().root)) {
    assert.ok(text.includes(path), path);
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
  assert.match(action.usage, /Usage: screenrig screen assign \[options\] \[id\.\.\.\]/);
  for (const name of ["--playlist-id", "--expect-rev"]) {
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

test("structured discovery exposes positional cardinality, choices, defaults and examples", () => {
  const init = invoke(["playlist", "init", "--help"]).data;
  assert.deepEqual(init.arguments, [{ name: "inputs", description: "Local image/video/audio files, med_ IDs, rel_ IDs, http(s) URLs or pasted <iframe> embed codes (iframe pages) in playback order; audio becomes the soundtrack", required: true, variadic: true }]);
  assert.deepEqual(init.options.find((option) => option.name === "--fit")?.choices, ["contain", "cover", "fill"]);
  assert.equal(init.options.find((option) => option.name === "--duration-ms")?.default, undefined);
  assert.match(init.options.find((option) => option.name === "--duration-ms")?.description ?? "", /8000.*86400000 for application pages/);
  assert.ok(init.examples.length > 0);
  assert.deepEqual(init.relationships, [{ kind: "together", options: ["--target-width", "--target-height"] }]);
  const generate = invoke(["media", "generate", "--help"]).data;
  assert.equal(generate.options.find((option) => option.name === "--quality")?.default, "medium");
  assert.equal(generate.options.find((option) => option.name === "--aspect-ratio")?.default, "16:9");
  assert.deepEqual(generate.options.find((option) => option.name === "--prompt")?.conflicts, ["--prompt-file"]);
  assert.deepEqual(generate.relationships, [{ kind: "exactlyOne", options: ["--prompt", "--prompt-file"] }]);
  assert.equal(generate.usage.split("Provide exactly one").length, 2, "notes should appear only once");
});

test("agent enroll declares mutually exclusive credential sources", () => {
  const enroll = invoke(["agent", "enroll", "--help"]).data;
  assert.deepEqual(enroll.relationships, [{ kind: "atMostOne", options: ["--email", "--agentid-claim"] }]);
  assert.ok(enroll.options.some((option) => option.name === "--agentid-claim"));
  assert.equal(enroll.usage.split("Provide at most one").length, 2, "notes should appear only once");
});

test("agent enroll documents --setup-code as an optional addition to either credential source", () => {
  const enroll = invoke(["agent", "enroll", "--help"]).data;
  const option = enroll.options.find((candidate) => candidate.name === "--setup-code");
  assert.equal(option?.description, "Link the new project to the website visit that showed this setup code, such as K7QX-2MPD");
  assert.equal(option?.required, false);
  assert.ok(enroll.relationships.every((relationship) => !relationship.options.includes("--setup-code")), "the code is never required or exclusive");
  assert.ok(enroll.examples.includes('screenrig agent enroll --email operator@example.com --organization "Lobby" --setup-code K7QX-2MPD'));
  assert.match(enroll.usage, /--setup-code CODE passes the setup code a person copied from the website[^.]*\(two groups of four letters and digits, case and hyphen ignored, sent as XXXX-XXXX\) and works with --email or --agentid-claim/);
  assert.match(enroll.usage, /A pending enrollment keeps its original email or AgentID claim, name, purpose, and setup code\./);
});


test("explicit JSON inventory can be scoped to a group", () => {
  assert.deepEqual(invoke(["help", "--all"]).data.allCommands, leafCommandPaths(createCommandTree().root));
  const media = invoke(["help", "media", "--all"]).data;
  assert.ok(media.allCommands?.every((path) => path.startsWith("media ")));
  assert.ok(media.allCommands?.includes("media generate"));
});

test("declared relationships and choices reject invalid commands before authentication", () => {
  for (const args of [
    ["media", "generate"],
    ["media", "generate", "--prompt", "test", "--quality", "ultra"],
    ["playlist", "init", "med_TEST", "--name", "Test", "--output", "out.json", "--target-width", "1920"],
    ["compose", "render", "input.json", "--target-height", "1080"],
    ["playlist", "import", "bundle", "--expect-rev", "1"],
    ["notifications", "create"],
    ["notifications", "create", "--email", "owner"],
    ["notifications", "create", "--webhook", "https://hooks.example.com/x", "--conditions", "screen_offline,bogus"],
    ["notifications", "update", "ntf_NOTIFICATIONAAAAAA"],
    ["notifications", "update", "ntf_NOTIFICATIONAAAAAA", "--snooze", "soon"],
    ["alerts", "list", "--state", "closed"],
    ["alerts", "list", "--limit", "201"],
    ["alerts", "snooze", "alr_ALERTAAAAAAAAAAAAAAA"],
    ["alerts", "snooze", "alr_ALERTAAAAAAAAAAAAAAA", "--for", "soon"],
    ["alerts", "snooze", "alr_ALERTAAAAAAAAAAAAAAA", "--for", "1h", "--until", "2026-11-01T09:00:00Z"],
    ["alerts", "mute", "--for", "1h"],
    ["alerts", "mute", "--tag", "Lobby"],
    ["alerts", "mute", "--tag", "Lobby", "--for", "30d"],
  ]) {
    assert.throws(() => invoke(args), (error: unknown) => {
      const failure = error as { status: number; stdout: string };
      assert.equal(failure.status, 2);
      assert.equal(JSON.parse(failure.stdout).error.code, "usage_error");
      return true;
    });
  }
});

test("canonical vocabulary keeps legacy invocations equivalent without rewriting values", async () => {
  const { parseArgv } = await import("./argv.js");
  for (const [prefix, canonical, legacy, value, suffix] of [
    [["playlist", "init", "med_TEST"], "--screen-id", "--screen", "scr_TEST", ["--name", "Lobby", "--output", "out.json"]],
    [["screen", "pair", "234567"], "--name", "--label", "--screen", []],
    [["screen", "provision"], "--name", "--label", "Lobby", ["--print-url"]],
    [["kv", "get", "greeting"], "--app-id", "--application-id", "app_TEST", []],
    [["kv", "webhook", "create", "greeting"], "--app-id", "--application-id", "app_TEST", []],
  ] as const) {
    assert.deepEqual(parseArgv([...prefix, `${canonical}=${value}`, ...suffix]), parseArgv([...prefix, `${legacy}=${value}`, ...suffix]));
    assert.throws(() => parseArgv([...prefix, `${canonical}=${value}`, `${legacy}=${value}`, ...suffix]), /only once/);
  }
  assert.deepEqual(parseArgv(["operations", "get", "op_TEST"]), parseArgv(["operations", "show", "op_TEST"]));
  assert.deepEqual(commandHelp(["operations", "get"]), commandHelp(["operations", "show"]));
  const selector = commandHelp(["kv", "get"]).options.find(option => option.name === "--app-id");
  assert.equal(selector?.required, true);
  assert.deepEqual(selector?.aliases, ["--application-id"]);
  assert.equal(commandHelp(["kv", "get"]).options.some(option => option.name === "--application-id"), false);
  // A webhook writes an application key or a card's document: exactly one of --app-id and --card.
  for (const action of ["create", "list", "rotate-secret", "delete"]) {
    const help = commandHelp(["kv", "webhook", action]);
    const webhookSelector = help.options.find(option => option.name === "--app-id");
    assert.equal(webhookSelector?.required, false, action);
    assert.deepEqual(webhookSelector?.aliases, ["--application-id"], action);
    assert.equal(help.options.some(option => option.name === "--card"), true, action);
    assert.deepEqual(help.relationships?.map(({ kind, options }) => ({ kind, options })), [{ kind: "exactlyOne", options: ["--app-id", "--card"] }], action);
  }
  for (const action of ["update", "deliveries"]) {
    const card = commandHelp(["kv", "webhook", action]).options.find(option => option.name === "--card");
    assert.equal(card?.required, true, action);
  }
  assert.equal(commandHelp(["kv", "webhook"]).kind, "group");
});

test("value dependencies and mutation requirements fail before runtime access", async () => {
  const { executeCommand } = await import("./program.js");
  const runtime = new Proxy({}, { get() { throw new Error("Runtime must not be accessed"); } });
  for (const args of [
    ["kv", "set", "key", "--app-id", "app_TEST"],
    ["comment", "set", "screen", "scr_TEST"],
    ["comment", "set", "playlist", "pl_TEST"],
    ["screen", "provision", "--open", "--print-url"],
    ["screen", "update", "scr_TEST", "--expect-rev", "1"],
    ["media", "update", "med_TEST", "--expect-rev", "1"],
    ["feedback", "bug", "Title"],
  ]) {
    await assert.rejects(executeCommand(args, runtime as Parameters<typeof executeCommand>[1]), (error: any) => error.problem?.code === "usage_error", JSON.stringify(args));
  }
  assert.deepEqual(commandHelp(["screen", "list"]).options.find(option => option.name === "--state")?.choices, ["archived"]);
  assert.equal(commandHelp(["screen", "toast"]).options.find(option => option.name === "--level")?.default, "info");
  const set = commandHelp(["kv", "set"]);
  assert.deepEqual(set.relationships, [
    { kind: "exactlyOne", options: ["--json-value", "--file", "--value-base64"] },
  ]);
});

test("every operational command has examples that parse and stdin help matches implemented inputs", async () => {
  const { parseArgv } = await import("./argv.js");
  // Tokenize only our authored examples, preserving quoted JSON and paths.
  const words = (text: string) => [...text.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g)].map(match => match[1] ?? match[2] ?? match[3]!);
  for (const path of leafCommandPaths(createCommandTree().root)) {
    if (path === "help") continue;
    const help = commandHelp(path.split(" "));
    assert.ok(help.examples.length > 0, path);
    for (const example of help.examples) assert.doesNotThrow(() => parseArgv(words(example).slice(1)), example);
  }
  for (const action of ["validate", "preview", "create", "update"]) {
    assert.ok(commandHelp(["playlist", action]).arguments.some(argument => argument.description.includes("stdin")), action);
  }
  assert.match(commandHelp(["screen", "publish"]).usage, /does not update an existing playlist/);
});

test("notifications help, JSON help and preflight agree on option relationships and write scope", () => {
  const create = invoke(["notifications", "create", "--help"]).data;
  assert.deepEqual(create.relationships, [
    { kind: "exactlyOne", options: ["--email", "--webhook", "--slack", "--teams", "--pagerduty", "--telegram"] },
    { kind: "atLeastOne", options: ["--conditions", "--events"] },
    { kind: "requires", options: ["--email", "--conditions"] },
    { kind: "requires", options: ["--events", "--webhook"] },
    { kind: "together", options: ["--telegram", "--telegram-chat"] },
  ]);
  assert.deepEqual(create.options.find((option) => option.name === "--email")?.conflicts, ["--webhook", "--slack", "--teams", "--pagerduty", "--telegram"]);
  assert.deepEqual(create.options.find((option) => option.name === "--webhook")?.conflicts, ["--email", "--slack", "--teams", "--pagerduty", "--telegram"]);
  assert.deepEqual(create.options.find((option) => option.name === "--telegram")?.conflicts, ["--email", "--webhook", "--slack", "--teams", "--pagerduty"]);
  for (const name of ["--slack", "--teams", "--pagerduty", "--telegram"]) {
    assert.match(create.options.find((option) => option.name === name)?.description ?? "", /\bstdin\b/, `${name} reads its credential from stdin`);
  }
  assert.equal(create.options.find((option) => option.name === "--tag")?.type, "value");
  assert.match(create.options.find((option) => option.name === "--conditions")?.description ?? "", /screen_offline, display_disconnected, running_hot, storage_full, content_stuck, not_playing, loop_stalled, glass_blank, glass_frozen, crashing/);
  for (const sentence of ["Provide exactly one of --email or --webhook or --slack or --teams or --pagerduty or --telegram.", "Provide at least one of --conditions or --events.", "--email requires --conditions.", "--events requires --webhook.", "Provide --telegram and --telegram-chat together."]) {
    assert.equal(create.usage.split(sentence).length, 2, `${sentence} appears once in the human help`);
  }
  const update = commandHelp(["notifications", "update"]);
  assert.deepEqual(update.relationships.map((relationship) => relationship.kind), ["atLeastOne", "atMostOne"]);
  assert.deepEqual(update.relationships[1], { kind: "atMostOne", options: ["--email", "--url", "--destination"] });
  assert.match(update.options.find((option) => option.name === "--destination")?.description ?? "", /\bstdin\b/);
  assert.deepEqual(update.options.find((option) => option.name === "--tag")?.conflicts, ["--all-screens"]);
  assert.deepEqual(update.options.find((option) => option.name === "--description")?.conflicts, ["--clear-description"]);
  assert.match(update.options.find((option) => option.name === "--snooze")?.description ?? "", /30m, 1h, 4h, 2d.*off/);
  for (const name of ["create", "update", "delete", "rotate-secret", "test", "list", "show", "deliveries"]) {
    const help = commandHelp(["notifications", name]);
    for (const relationship of help.relationships) {
      for (const option of relationship.options) assert.ok(help.options.some((candidate) => candidate.name === option), `${name} ${option}`);
    }
    assert.ok(help.examples.every((example) => example.startsWith(`screenrig notifications ${name}`)), name);
    assert.ok(help.examples.length > 0, name);
  }
  for (const name of ["create", "update", "delete", "rotate-secret", "test"]) {
    assert.match(commandHelp(["notifications", name]).notes.join("\n"), /needs Manage access/i, `${name} states its write scope`);
  }
  assert.deepEqual(commandHelp(["notifications"]).commands.map((child) => child.name), ["create", "list", "show", "update", "delete", "rotate-secret", "test", "resubscribe", "deliveries"]);
  assert.match(commandHelp(["notifications"]).usage, /at most 20\s+notifications of every channel/);
  assert.match(commandHelp(["webhooks"]).usage, /Email and screen alerts[\s\S]*are screenrig notifications/);
});

test("alerts help, JSON help and preflight agree on option relationships, choices and scope", () => {
  const mute = commandHelp(["alerts", "mute"]);
  assert.deepEqual(mute.relationships, [
    { kind: "atLeastOne", options: ["--screen-id", "--tag"] },
    { kind: "exactlyOne", options: ["--for", "--until"] },
  ]);
  assert.deepEqual(mute.options.find((option) => option.name === "--for")?.conflicts, ["--until"]);
  assert.deepEqual(mute.options.find((option) => option.name === "--until")?.conflicts, ["--for"]);
  for (const name of ["--screen-id", "--tag", "--note"]) assert.equal(mute.options.find((option) => option.name === name)?.type, "value", name);
  for (const sentence of ["Provide at least one of --screen-id or --tag.", "Provide exactly one of --for or --until."]) {
    assert.equal(mute.usage.split(sentence).length, 2, `${sentence} appears once in the human help`);
  }
  const snooze = commandHelp(["alerts", "snooze"]);
  assert.deepEqual(snooze.relationships, [{ kind: "exactlyOne", options: ["--for", "--until"] }]);
  assert.deepEqual(snooze.arguments.map((argument) => [argument.name, argument.required]), [["id", true]]);
  const list = commandHelp(["alerts", "list"]);
  assert.deepEqual(list.options.find((option) => option.name === "--state")?.choices, ["open", "resolved", "all"]);
  assert.equal(list.options.find((option) => option.name === "--state")?.default, "open");
  assert.deepEqual(list.relationships, []);
  for (const name of ["list", "show", "ack", "snooze", "mute", "mutes", "unmute"]) {
    const help = commandHelp(["alerts", name]);
    for (const relationship of help.relationships) {
      for (const option of relationship.options) assert.ok(help.options.some((candidate) => candidate.name === option), `${name} ${option}`);
    }
    assert.ok(help.examples.length > 0, name);
    assert.ok(help.examples.every((example) => example.startsWith(`screenrig alerts ${name}`)), name);
    // The JSON a caller reads through the binary is the same document the human help prints.
    assert.deepEqual(invoke(["alerts", name, "--help"]).data, JSON.parse(JSON.stringify(help)), name);
  }
  for (const name of ["ack", "snooze", "mute", "unmute"]) {
    assert.match(commandHelp(["alerts", name]).notes.join("\n"), /Needs Manage access\./, `${name} states its write scope`);
  }
  for (const name of ["list", "show", "mutes"]) {
    assert.match(commandHelp(["alerts", name]).notes.join("\n"), /Read only access is enough\./, `${name} states its read scope`);
  }
  assert.deepEqual(commandHelp(["alerts"]).commands.map((child) => child.name), ["list", "show", "ack", "snooze", "mute", "mutes", "unmute"]);
  const group = commandHelp(["alerts"]).usage;
  assert.match(group, /screen_offline, display_disconnected, running_hot,\s+storage_full, content_stuck, not_playing, loop_stalled, glass_blank or\s+glass_frozen\)/);
  assert.match(group, /crashing is a notice, never\s+an alert/);
  assert.match(group, /has at most 50\s+current mutes/);
  assert.match(commandHelp(["notifications"]).usage, /content_stuck, not_playing, loop_stalled, glass_blank, glass_frozen or crashing/);
  assert.match(commandHelp(["notifications", "create"]).notes.join("\n"), /not_playing \(the Player shows an error instead of its content\), loop_stalled \(no media start has reached ScreenRig/);
  assert.match(commandHelp(["webhooks"]).usage, /content stuck, not playing, crashing\) are screenrig notifications/);
});

test("media upload help states the 500,000,000-byte video limit", () => {
  const help = JSON.stringify(commandHelp(["media", "upload"]));
  assert.match(help, /500,000,000 bytes \(500 MB\)/);
});
