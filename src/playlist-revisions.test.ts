import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Readable, Writable } from "node:stream";
import { test, type TestContext } from "node:test";
import { commandHelp } from "./help-tree.js";
import { processRuntime, run } from "./main.js";
import { networkError } from "./problems.js";
import { FakeTransport } from "./transport/fake.js";

const PLAYLIST = "pl_AAAAAAAAAAAAAAAAAAAAAAAA";

/** A CLI with a stored credential. */
async function revisionsCli(t: TestContext, transport: FakeTransport) {
  const directory = await mkdtemp(path.join(tmpdir(), "playlist-revisions-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = path.join(directory, "config.json");
  await writeFile(config, JSON.stringify({ api_url: "https://api.screenrig.ai", project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", project_name: "Screens",
    organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization", token: "test-token" }), { mode: 0o600 });
  return async (argv: string[]) => {
    let output = "";
    const code = await run({ ...processRuntime(), argv: ["--config", config, ...argv], cwd: () => directory, env: {}, transport,
      stdin: Readable.from([""]), isStdinTty: () => false,
      stdout: new Writable({ write(chunk, _encoding, done) { output += chunk; done(); } }),
      stderr: new Writable({ write(_chunk, _encoding, done) { done(); } }),
    });
    return { code, output };
  };
}

const revision = (number: number, extra: Record<string, unknown> = {}) => ({
  revision: number, created_at: `2026-10-${String(number).padStart(2, "0")}T10:00:00Z`, change: "edited", name: "Lobby", page_count: 3, current: false, ...extra,
});

const problem = (status: number, code: string, detail: string) => ({
  status, headers: { "content-type": "application/problem+json" },
  body: { type: `https://screenrig.ai/problems/${code.replaceAll("_", "-")}`, title: code, status, detail, code },
});

test("playlist revisions reads one page, passes --after, and names the next page", async t => {
  const queries: unknown[] = [];
  const transport = new FakeTransport().on("GET", `/api/playlists/${PLAYLIST}/revisions`, request => {
    queries.push(request.query ?? {});
    assert.equal(request.headers?.["idempotency-key"], undefined, "a read carries no write key");
    return { status: 200, headers: {}, body: { items: [
      revision(9, { current: true, change: "promoted", restored_from: 5, author: { type: "agent", id: "agt_TEST", name: "Lobby agent" } }),
      revision(8, { author: { type: "person", name: "Ana" } }),
      revision(7, { change: "baseline", name: "Lobby (old)" }),
    ], next_cursor: "cur_NEXT" } };
  });
  const invoke = await revisionsCli(t, transport);
  const first = await invoke(["--json", "playlist", "revisions", PLAYLIST]);
  assert.equal(first.code, 0, first.output);
  const data = JSON.parse(first.output).data;
  assert.deepEqual(data.items.map((item: { revision: number }) => item.revision), [9, 8, 7]);
  assert.equal(data.next_cursor, "cur_NEXT");
  const human = await invoke(["--human", "playlist", "revisions", PLAYLIST, "--after", "cur_PREVIOUS"]);
  assert.equal(human.code, 0, human.output);
  assert.deepEqual(queries, [{}, { after: "cur_PREVIOUS" }]);
  assert.match(human.output, new RegExp(`^Playlist ${PLAYLIST} revisions \\(3\\)$`, "m"));
  assert.match(human.output, /^9 \(current\)\s+promoted from 5\s+3\s+2026-10-09T10:00:00Z\s+Lobby agent \(agent\)\s+Lobby$/m);
  assert.match(human.output, /^8\s+edited\s+3\s+2026-10-08T10:00:00Z\s+Ana \(person\)\s+Lobby$/m);
  assert.match(human.output, /^7\s+baseline\s+3\s+2026-10-07T10:00:00Z\s+—\s+Lobby \(old\)$/m);
  assert.match(human.output, new RegExp(`^next: screenrig playlist revisions ${PLAYLIST} --after cur_NEXT$`, "m"));
});

test("the last page of playlist revisions offers no next page", async t => {
  const transport = new FakeTransport().on("GET", `/api/playlists/${PLAYLIST}/revisions`, () => ({ status: 200, headers: {}, body: { items: [revision(1, { current: true, change: "baseline" })], next_cursor: null } }));
  const invoke = await revisionsCli(t, transport);
  const answer = await invoke(["--human", "playlist", "revisions", PLAYLIST]);
  assert.equal(answer.code, 0, answer.output);
  assert.doesNotMatch(answer.output, /next:/);
});

test("playlist revision show prints the revision and the playlist at it", async t => {
  const transport = new FakeTransport().on("GET", `/api/playlists/${PLAYLIST}/revisions/3`, () => ({ status: 200, headers: {}, body: {
    revision: revision(3, { change: "promoted", restored_from: 1, author: { type: "person", name: "Ana" } }),
    playlist: { id: PLAYLIST, name: "Lobby", revision: 3, pages: [{ id: "welcome" }] },
  } }));
  const invoke = await revisionsCli(t, transport);
  const json = await invoke(["--json", "playlist", "revision", "show", PLAYLIST, "--revision", "3"]);
  assert.equal(json.code, 0, json.output);
  const data = JSON.parse(json.output).data;
  assert.equal(data.revision.revision, 3);
  assert.equal(data.playlist.revision, 3);
  const human = await invoke(["--human", "playlist", "revision", "show", PLAYLIST, "--revision", "3"]);
  assert.match(human.output, new RegExp(`^Playlist ${PLAYLIST} revision 3$`, "m"));
  assert.match(human.output, /^change: promoted from 1$/m);
  assert.match(human.output, /^author: Ana \(person\)$/m);
  assert.match(human.output, /"pages": \[/);
});

test("playlist revision show needs a whole revision number and sends nothing without one", async t => {
  const transport = new FakeTransport();
  const invoke = await revisionsCli(t, transport);
  for (const argv of [["playlist", "revision", "show", PLAYLIST], ["playlist", "revision", "show", PLAYLIST, "--revision", "0"], ["playlist", "revision", "show", PLAYLIST, "--revision", "latest"]]) {
    const answer = await invoke(["--json", ...argv]);
    assert.equal(answer.code, 2, answer.output);
    assert.equal(JSON.parse(answer.output).error.code, "usage_error");
  }
  assert.equal(transport.calls.length, 0);
});

test("playlist revision show reports a revision the playlist never had as not_found", async t => {
  const transport = new FakeTransport().on("GET", `/api/playlists/${PLAYLIST}/revisions/40`, () => problem(404, "not_found", "The playlist has no revision 40."));
  const invoke = await revisionsCli(t, transport);
  const answer = await invoke(["--json", "playlist", "revision", "show", PLAYLIST, "--revision", "40"]);
  assert.equal(answer.code, 4, answer.output);
  assert.equal(JSON.parse(answer.output).error.code, "not_found");
});

test("playlist promote copies a revision forward with the revision guard and a saved write key", async t => {
  const seen: Array<{ body: unknown; match: string | undefined; key: string | undefined }> = [];
  const transport = new FakeTransport().on("POST", `/api/playlists/${PLAYLIST}/revisions/3/promote`, request => {
    seen.push({ body: request.body, match: request.headers?.["if-match"], key: request.headers?.["idempotency-key"] });
    return { status: 200, headers: { etag: '"10"' }, body: { id: PLAYLIST, name: "Lobby", revision: 10, pages: [] } };
  });
  const invoke = await revisionsCli(t, transport);
  const json = await invoke(["--json", "playlist", "promote", PLAYLIST, "--revision", "3", "--expect-rev", "9"]);
  assert.equal(json.code, 0, json.output);
  assert.equal(seen[0]?.body, undefined);
  assert.equal(seen[0]?.match, '"9"');
  assert.ok(seen[0]?.key);
  assert.equal(JSON.parse(json.output).data.revision, 10);
  const human = await invoke(["--human", "playlist", "promote", PLAYLIST, "--revision", "3", "--expect-rev", "9"]);
  assert.equal(human.code, 0, human.output);
  assert.match(human.output, new RegExp(`^Promoted revision 3 of ${PLAYLIST}: it is now the current revision 10\\. The name is unchanged and every screen showing the playlist updates\\.$`, "m"));
});

test("promoting content equal to the current content says nothing changed", async t => {
  const transport = new FakeTransport().on("POST", `/api/playlists/${PLAYLIST}/revisions/9/promote`, () => ({ status: 200, headers: {}, body: { id: PLAYLIST, name: "Lobby", revision: 9 } }));
  const invoke = await revisionsCli(t, transport);
  const answer = await invoke(["--human", "playlist", "promote", PLAYLIST, "--revision", "9", "--expect-rev", "9"]);
  assert.equal(answer.code, 0, answer.output);
  assert.match(answer.output, /holds the playlist's current content; nothing changed/);
});

test("playlist promote requires --revision and --expect-rev before any request", async t => {
  const transport = new FakeTransport();
  const invoke = await revisionsCli(t, transport);
  for (const argv of [
    ["playlist", "promote", PLAYLIST],
    ["playlist", "promote", PLAYLIST, "--revision", "3"],
    ["playlist", "promote", PLAYLIST, "--expect-rev", "9"],
    ["playlist", "promote", PLAYLIST, "--revision", "3", "--expect-rev", "current"],
  ]) {
    const answer = await invoke(["--json", ...argv]);
    assert.equal(answer.code, 2, answer.output);
    assert.equal(JSON.parse(answer.output).error.code, "usage_error");
  }
  assert.equal(transport.calls.length, 0);
});

test("playlist promote surfaces a stale guard as revision_conflict and a Propose credential as forbidden", async t => {
  const transport = new FakeTransport()
    .on("POST", `/api/playlists/${PLAYLIST}/revisions/3/promote`, request => request.headers?.["if-match"] === '"9"'
      ? problem(412, "revision_conflict", "The playlist changed since you read it.")
      : problem(403, "forbidden", "This credential's writes are proposed for review."));
  const invoke = await revisionsCli(t, transport);
  const stale = await invoke(["--json", "playlist", "promote", PLAYLIST, "--revision", "3", "--expect-rev", "9"]);
  assert.notEqual(stale.code, 0);
  const conflict = JSON.parse(stale.output).error;
  assert.equal(conflict.code, "revision_conflict");
  assert.match(conflict.hint, /--expect-rev/);
  const refused = await invoke(["--json", "playlist", "promote", PLAYLIST, "--revision", "3", "--expect-rev", "10"]);
  assert.notEqual(refused.code, 0);
  assert.equal(JSON.parse(refused.output).error.code, "forbidden");
});

test("an interrupted playlist promote retries with the same saved write key", async t => {
  const keys: string[] = [];
  const transport = new FakeTransport().on("POST", `/api/playlists/${PLAYLIST}/revisions/3/promote`, request => {
    keys.push(request.headers!["idempotency-key"]!);
    if (keys.length === 1) throw networkError("Connection ended after the write");
    return { status: 200, headers: {}, body: { id: PLAYLIST, name: "Lobby", revision: 10 } };
  });
  const invoke = await revisionsCli(t, transport);
  const argv = ["playlist", "promote", PLAYLIST, "--revision", "3", "--expect-rev", "9"];
  assert.notEqual((await invoke(argv)).code, 0);
  const answer = await invoke(argv);
  assert.equal(answer.code, 0, answer.output);
  assert.equal(keys.length, 2);
  assert.equal(new Set(keys).size, 1);
});

test("help for the revision commands states scope, recovery and the next page", () => {
  const promote = commandHelp(["playlist", "promote"]);
  assert.deepEqual(promote.options.filter((option) => option.required).map((option) => option.name).sort(), ["--expect-rev", "--revision"]);
  assert.ok(promote.examples.every((example) => example.startsWith("screenrig playlist promote ")));
  const notes = promote.notes.join("\n");
  for (const phrase of [/new current revision/, /keeps its current name/, /every screen showing the playlist updates/, /credential that publishes live/, /Propose access credential gets forbidden/, /revision_conflict/, /playlist show ID/]) {
    assert.match(notes, phrase);
  }
  const revisions = commandHelp(["playlist", "revisions"]);
  assert.equal(revisions.options.find((option) => option.name === "--after")?.type, "value");
  assert.match(revisions.notes.join("\n"), /data\.next_cursor is a string[^.]*--after/);
  assert.match(revisions.notes.join("\n"), /Read only access is enough\./);
  const show = commandHelp(["playlist", "revision", "show"]);
  assert.equal(show.options.find((option) => option.name === "--revision")?.required, true);
  assert.ok(show.examples.length > 0);
  assert.deepEqual(commandHelp(["playlist", "revision"]).commands.map((child) => child.name), ["show"]);
});
