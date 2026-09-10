import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { test } from "node:test";
import { run, processRuntime } from "./main.js";
import { FakeTransport } from "./transport/fake.js";

async function invoke(argv: string[], transport = new FakeTransport(), authenticated = false, tty = false) {
  const directory = await mkdtemp(path.join(tmpdir(), "screenrig-output-"));
  const config = path.join(directory, "config.json");
  if (authenticated) await writeFile(config, JSON.stringify({ api_url: "https://api.screenrig.ai", token: "test-only-token" }), { mode: 0o600 });
  let stdout = "", stderr = "";
  try {
    const code = await run({ ...processRuntime(), argv: ["--config", config, ...argv], env: {}, transport,
      isStderrTty: () => tty,
      stdout: new Writable({ write(chunk, _encoding, done) { stdout += chunk; done(); } }),
      stderr: new Writable({ write(chunk, _encoding, done) { stderr += chunk; done(); } }),
    });
    return { code, stdout, stderr };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("operations default to JSON regardless of terminal; --json remains compatible", async () => {
  const expected = await invoke(["--json", "version"]);
  assert.equal(expected.code, 0);
  assert.equal(JSON.parse(expected.stdout).ok, true);
  for (const argv of [["version"], ["--version"], ["-V"], ["version", "--json"]]) {
    for (const tty of [false, true]) assert.deepEqual(await invoke(argv, undefined, false, tty), expected);
  }
  const human = await invoke(["version", "--human"]);
  assert.match(human.stdout, /^screenrig \d/);
  assert.equal(human.stderr, "");
});

test("help stays readable by default and offers structured discovery", async () => {
  for (const argv of [[], ["--help"], ["screen"], ["help", "screen"], ["screen", "assign", "--help"]]) {
    assert.match((await invoke(argv)).stdout, /^Usage:/);
    const structured = await invoke(["--json", ...argv]);
    assert.equal(JSON.parse(structured.stdout).ok, true);
    assert.ok(Array.isArray(JSON.parse(structured.stdout).data.options));
  }
});

test("usage and auth failures default to JSON, with prose only on explicit request", async () => {
  for (const argv of [["screen", "show"], ["screen", "list", "--bogus"], ["screen", "list"]]) {
    const json = await invoke(argv);
    assert.notEqual(json.code, 0);
    assert.equal(JSON.parse(json.stdout).ok, false);
    assert.equal(json.stderr, "");
    const human = await invoke(["--human", ...argv]);
    assert.equal(human.code, json.code);
    assert.equal(human.stdout, "");
    assert.notEqual(human.stderr, "");
  }
});

test("output flags conflict across command levels, including help", async () => {
  for (const argv of [["--json", "version", "--human"], ["--human", "screen", "--json", "list"], ["--human", "--json", "--help"]]) {
    const result = await invoke(argv);
    assert.equal(result.code, 2);
    assert.equal(JSON.parse(result.stdout).error.code, "usage_error");
  }
  const literal = await invoke(["playlist", "validate", "--", "--human"]);
  assert.equal(literal.code, 2);
  assert.equal(JSON.parse(literal.stdout).ok, false);
});

test("empty event lists emit one default JSON result without a human-text sentinel", async () => {
  const transport = new FakeTransport().on("GET", "/api/v1/events", () => ({ status: 200, headers: {}, body: { items: [], next_cursor: null } }));
  const result = await invoke(["events", "list"], transport, true);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout).data, { items: [], next_cursor: null });
  assert.equal(result.stdout.trim().split("\n").length, 1);
  const human = await invoke(["--human", "events", "list"], transport, true);
  assert.equal(human.stdout, "");
});

test("default event streams emit NDJSON without an extra final result", async () => {
  const transport = new FakeTransport();
  for (let i = 1; i <= 2; i++) transport.pushStream(`id: ev1_${i}\ndata: ${JSON.stringify({ type: "account.created", at: "2026-09-10T00:00:00Z", severity: "info", message: `event ${i}` })}\n\n`);
  const result = await invoke(["events", "follow", "--timeout", "30"], transport, true);
  assert.equal(result.code, 0);
  const lines = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((line) => line.data.message), ["event 1", "event 2"]);
  assert.ok(lines.every((line) => line.ok));
  assert.equal(result.stderr, "");
  const empty = await invoke(["events", "follow", "--timeout", "20"], new FakeTransport(), true);
  assert.equal(empty.code, 0);
  assert.deepEqual(JSON.parse(empty.stdout).data, { items: [] });
});
