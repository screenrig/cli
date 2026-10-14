import assert from "node:assert/strict";
import { chmod, mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { test } from "node:test";
import { NOTES_REVIEW_PROMPT, NOTES_TRUST_LINE, noteLines, notesHint, parseNoteAbout, parseNoteTtl, selfNoteCounts } from "./agent-notes.js";
import { eventTypeMatches } from "./commands.js";
import { AGENT_CAPABILITIES } from "./adapters/protocol.js";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { ExitCode } from "./exit-codes.js";
import { run, type CliRuntime } from "./main.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport } from "./transport/fake.js";
import type { TransportResponse } from "./transport/types.js";

const NOW = new Date("2026-10-13T12:00:00Z");
const AGENT = {
  id: "agt_AAAAAAAAAAAAAAAAAAAAAAAA", name: "ScreenRig CLI", agent_type: "cli", capabilities: [...AGENT_CAPABILITIES],
  state: "active", authenticated_requests: 1, metered_credits: 0, created_at: "2026-10-01T12:00:00Z",
};

async function invoke(argv: string[], transport: FakeTransport, extra: Partial<CliRuntime> = {}) {
  const dir = await testTemp("notes-cfg-");
  const fs: ConfigFs = { mkdir, open, rename, rm, chmod, stat, homedir: () => dir, env: { XDG_CONFIG_HOME: dir } };
  await writeConfigAtomic(path.join(dir, "screenrig", "config.json"), {
    api_url: "https://api.screenrig.ai", project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", project_name: "Screens",
    organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization",
    token: "eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.signature_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr",
  }, fs);
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  stdout.on("data", (chunk) => out.push(Buffer.from(chunk)));
  stderr.on("data", (chunk) => err.push(Buffer.from(chunk)));
  const runtime: CliRuntime = { argv, env: fs.env, stdout, stderr, now: () => NOW, sleep: async () => undefined, homedir: fs.homedir, cwd: () => dir, fs, transport, ...extra };
  try {
    const code = await run(runtime);
    stdout.end();
    stderr.end();
    return { code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), dir };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const ok = (body: unknown, status = 200): TransportResponse => ({ status, headers: { "content-type": "application/json" }, body });

function note(overrides: Record<string, unknown> = {}) {
  return {
    id: "nte_AAAAAAAAAAAAAAAAAAAAAAAA", body: "Lobby screen is portrait.\nRender pages at 1080x1920.",
    about: { type: "screen", id: "scr_AAAAAAAAAAAAAAAAAAAAAAAA" }, state: "open",
    author: { agent_id: "agt_BBBBBBBBBBBBBBBBBBBBBBBB", name: "Deploy bot", agent_type: "claude-code" },
    created_at: "2026-10-13T09:00:00Z", confirmed_at: null, review_at: "2027-01-11T09:00:00Z", expires_at: null,
    resolved_at: null, resolution: null, new: false, due: false, ...overrides,
  };
}

const NO_NETWORK = () => { throw new Error("no request expected"); };

test("--about takes screen:ID, playlist:ID, or a bare ID whose prefix names its type", () => {
  assert.deepEqual(parseNoteAbout("screen:scr_AAAA"), { type: "screen", id: "scr_AAAA" });
  assert.deepEqual(parseNoteAbout("playlist:pl_AAAA"), { type: "playlist", id: "pl_AAAA" });
  assert.deepEqual(parseNoteAbout("scr_AAAA"), { type: "screen", id: "scr_AAAA" });
  assert.deepEqual(parseNoteAbout("stage_pl_AAAA"), { type: "playlist", id: "stage_pl_AAAA" });
  for (const bad of ["med_AAAA", "media:med_AAAA", "screen:pl_AAAA", "playlist:", "AAAA", ":scr_AAAA"]) {
    assert.throws(() => parseNoteAbout(bad), (error: any) => error.problem?.code === "usage_error", bad);
  }
});

test("--ttl takes hours or days from 1h to 365d and sends seconds", () => {
  assert.equal(parseNoteTtl("1h"), 3600);
  assert.equal(parseNoteTtl("12h"), 43200);
  assert.equal(parseNoteTtl("3d"), 259200);
  assert.equal(parseNoteTtl("365d"), 31536000);
  assert.equal(parseNoteTtl("8760h"), 31536000);
  for (const bad of ["0h", "366d", "8761h", "30m", "3", "d", "1.5d", "-1d", "03d", "3D"]) {
    assert.throws(() => parseNoteTtl(bad), (error: any) => error.problem?.code === "usage_error", bad);
  }
});

test("the notes hint names new and due notes and stays silent otherwise", () => {
  assert.equal(notesHint({ open: 9, new: 3, due: 1 }), "3 new project notes, 1 due for review: screenrig notes");
  assert.equal(notesHint({ new: 1 }), "1 new project note: screenrig notes");
  assert.equal(notesHint({ due: 2 }), "2 project notes due for review: screenrig notes");
  assert.equal(notesHint({ due: 1 }), "1 project note due for review: screenrig notes");
  assert.equal(notesHint({ open: 4, new: 0, due: 0 }), undefined);
  assert.equal(notesHint(undefined), undefined);
  assert.deepEqual(selfNoteCounts({ agent: AGENT, notes: { open: 2, new: 1, due: "x" } }), { open: 2, new: 1, due: 0 });
  assert.equal(selfNoteCounts({ agent: AGENT }), undefined);
  assert.equal(selfNoteCounts({ notes: [1] }), undefined);
});

test("note text prints as text: line breaks stay, terminal controls do not", () => {
  const lines = noteLines(note({ body: "first\r\nsecond \u001b[31mred\u001b[0m\u0007", author: { name: "Bot\u001b]0;x", agent_type: "cli" } }), NOW);
  assert.equal(lines.some((line) => /[\u0000-\u0008\u000b-\u001f\u007f]/.test(line)), false);
  assert.deepEqual(lines.slice(1), ["  first", "  second �[31mred�[0m�"]);
  assert.match(lines[0]!, /^nte_\S+  Bot�\]0;x \(cli\) · 3h ago · screen scr_/);
});

test("a resolved note shows how it was resolved; an open ttl note shows when it expires", () => {
  const replaced = noteLines(note({ state: "resolved", resolution: { cause: "replaced", reason: "A new note replaced this note.", by: null, replaced_by: "nte_NEW" } }), NOW);
  assert.match(replaced[0]!, /^nte_AAAAAAAAAAAAAAAAAAAAAAAA \[resolved\]  Deploy bot/);
  assert.equal(replaced[1], "  resolved (replaced by nte_NEW): A new note replaced this note.");
  const byAgent = noteLines(note({ state: "resolved", resolution: { cause: "resolved", reason: "Wrong screen", by: { kind: "agent", name: "Ops", agent_type: "cli" } } }), NOW);
  assert.equal(byAgent[1], "  resolved (resolved) by Ops: Wrong screen");
  const ttl = noteLines(note({ about: null, expires_at: "2026-10-16T12:00:00Z" }), NOW);
  assert.match(ttl[0]!, /3h ago · expires in 3d$/);
});

test("events follow --type prints one type or a family and always passes stream frames", () => {
  assert.equal(eventTypeMatches("note.added", "note."), true);
  assert.equal(eventTypeMatches("note.added", "note.added"), true);
  assert.equal(eventTypeMatches("note.resolved", "note.added"), false);
  assert.equal(eventTypeMatches("notes.added", "note."), false);
  assert.equal(eventTypeMatches("screen.online", "note."), false);
  assert.equal(eventTypeMatches("stream.resync_required", "note."), true);
  assert.equal(eventTypeMatches(undefined, "note."), false);
  assert.equal(eventTypeMatches("screen.online", undefined), true);
});

test("screenrig notes lists open notes with author, age, markers, and the review prompt", async () => {
  const transport = new FakeTransport().on("GET", "/api/notes", () => ok({
    items: [note({ new: true }), note({ id: "nte_BBBBBBBBBBBBBBBBBBBBBBBB", body: "Menu prices change on Mondays.", about: null, author: { agent_id: AGENT.id, name: "ScreenRig CLI", agent_type: "cli" }, created_at: "2026-10-10T12:00:00Z" })],
    next_cursor: "",
    review: [note({ id: "nte_CCCCCCCCCCCCCCCCCCCCCCCC", body: "The kitchen screen stays on the menu playlist.", created_at: "2026-07-01T12:00:00Z", due: true })],
    counts: { open: 3, new: 1, due: 1 },
  }));
  const result = await invoke(["notes", "--human"], transport);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0]!.path, "/api/notes");
  assert.deepEqual(Object.entries(transport.calls[0]!.query ?? {}).filter(([, value]) => value !== undefined), []);
  const text = result.stdout;
  assert.ok(text.includes(NOTES_TRUST_LINE), text);
  assert.match(text, /nte_AAAAAAAAAAAAAAAAAAAAAAAA \[new\]  Deploy bot \(claude-code\) · 3h ago · screen scr_AAAAAAAAAAAAAAAAAAAAAAAA\n  Lobby screen is portrait\.\n  Render pages at 1080x1920\./);
  assert.match(text, /nte_BBBBBBBBBBBBBBBBBBBBBBBB  ScreenRig CLI \(cli\) · 3d ago\n  Menu prices change on Mondays\./);
  assert.ok(text.indexOf(NOTES_REVIEW_PROMPT) > text.indexOf("Menu prices"), text);
  assert.match(text, /nte_CCCCCCCCCCCCCCCCCCCCCCCC \[due\]  Deploy bot \(claude-code\) · 104d ago/);

  const quiet = new FakeTransport().on("GET", "/api/notes", () => ok({ items: [note()], next_cursor: "", review: [], counts: { open: 1, new: 0, due: 0 } }));
  const plain = await invoke(["notes", "list", "--human"], quiet);
  assert.equal(plain.code, 0, plain.stdout);
  assert.equal(plain.stdout.includes("Still true?"), false);

  const empty = new FakeTransport().on("GET", "/api/notes", () => ok({ items: [], next_cursor: "", review: [], counts: { open: 0, new: 0, due: 0 } }));
  assert.match((await invoke(["notes", "--human"], empty)).stdout, /No open notes\./);
});

test("notes list sends its filters and --json passes the API answer through", async () => {
  const answer = { items: [note()], next_cursor: "nc_2", review: [], counts: { open: 7, new: 0, due: 0 }, extra_field: { kept: true } };
  const transport = new FakeTransport().on("GET", "/api/notes", () => ok(answer));
  const result = await invoke(["notes", "list", "--all", "--about", "playlist:pl_AAAA", "--author", "agt_BBBBBBBBBBBBBBBBBBBBBBBB", "--limit", "5", "--after", "nc_1"], transport);
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(transport.calls[0]!.query, { state: "all", about_id: "pl_AAAA", author_id: "agt_BBBBBBBBBBBBBBBBBBBBBBBB", after: "nc_1", limit: "5" });
  assert.deepEqual(JSON.parse(result.stdout).data, answer);
  assert.equal(result.stderr, "");

  const resolved = new FakeTransport().on("GET", "/api/notes", () => ok({ items: [], next_cursor: "" }));
  assert.equal((await invoke(["notes", "--resolved", "--about", "scr_AAAA"], resolved)).code, 0);
  assert.equal(resolved.calls[0]!.query?.state, "resolved");
  assert.equal(resolved.calls[0]!.query?.about_id, "scr_AAAA");

  for (const argv of [["notes", "--all", "--resolved"], ["notes", "--about", "med_AAAA"], ["notes", "--author", "nobody"], ["notes", "--limit", "0"]]) {
    const refused = new FakeTransport().on("GET", "/api/notes", NO_NETWORK);
    const answer = await invoke(argv, refused);
    assert.equal(answer.code, ExitCode.Usage, `${argv.join(" ")}: ${answer.stdout}`);
    assert.equal(refused.calls.length, 0, argv.join(" "));
  }
});

test("notes add sends the body, subject, ttl and replacement with an idempotency key", async () => {
  const created = note({ id: "nte_NEWNEWNEWNEWNEWNEWNEWNEWN", about: { type: "playlist", id: "pl_AAAA" } });
  const transport = new FakeTransport().on("POST", "/api/notes", () => ok(created, 201));
  const result = await invoke(["notes", "add", "  Menu prices change on Mondays.  ", "--about", "pl_AAAA", "--ttl", "3d", "--replaces", "nte_OLDOLDOLDOLDOLDOLDOLDOLDO", "--human"], transport);
  assert.equal(result.code, 0, result.stdout);
  const call = transport.calls[0]!;
  assert.deepEqual(call.body, { body: "Menu prices change on Mondays.", about: { type: "playlist", id: "pl_AAAA" }, ttl_seconds: 259200, replaces: "nte_OLDOLDOLDOLDOLDOLDOLDOLDO" });
  assert.ok(call.headers?.["idempotency-key"]);
  assert.match(result.stdout, /Added note nte_NEWNEWNEWNEWNEWNEWNEWNEWN\. nte_OLDOLDOLDOLDOLDOLDOLDOLDO is resolved as replaced\./);

  const json = await invoke(["notes", "add", "Plain fact."], new FakeTransport().on("POST", "/api/notes", () => ok(created, 201)));
  const envelope = JSON.parse(json.stdout);
  assert.deepEqual(envelope.data, created);
  assert.deepEqual(envelope.warnings, []);
});

test("notes add that matches an open note says it confirmed that note", async () => {
  const existing = note({ confirmed_at: NOW.toISOString() });
  const transport = new FakeTransport().on("POST", "/api/notes", (req) => {
    assert.deepEqual(req.body, { body: "Lobby screen is portrait.", about: { type: "screen", id: "scr_AAAAAAAAAAAAAAAAAAAAAAAA" } });
    return ok(existing, 200);
  });
  const human = await invoke(["notes", "add", "Lobby screen is portrait.", "--about", "screen:scr_AAAAAAAAAAAAAAAAAAAAAAAA", "--human"], transport);
  assert.equal(human.code, 0, human.stdout);
  assert.match(human.stdout, /^Matched open note nte_AAAAAAAAAAAAAAAAAAAAAAAA; confirmed it\.$/m);
  const json = await invoke(["notes", "add", "Lobby screen is portrait.", "--about", "screen:scr_AAAAAAAAAAAAAAAAAAAAAAAA"], transport);
  const envelope = JSON.parse(json.stdout);
  assert.deepEqual(envelope.data, existing);
  assert.deepEqual(envelope.warnings, [{ code: "note_matched_open", message: "Matched open note nte_AAAAAAAAAAAAAAAAAAAAAAAA; confirmed it." }]);
});

test("notes add reads --file and stdin, and takes exactly one source", async () => {
  const dir = await testTemp("notes-file-");
  try {
    await writeFile(path.join(dir, "note.md"), "\nFrom a file.\nSecond line.\n");
    const transport = new FakeTransport().on("POST", "/api/notes", () => ok(note(), 201));
    const fromFile = await invoke(["notes", "add", "--file", "note.md"], transport, { cwd: () => dir });
    assert.equal(fromFile.code, 0, fromFile.stdout);
    assert.deepEqual(transport.calls[0]!.body, { body: "From a file.\nSecond line." });
    const fromStdin = await invoke(["notes", "add", "-"], transport, { stdin: Readable.from([Buffer.from("From stdin.\n")]), isStdinTty: () => false });
    assert.equal(fromStdin.code, 0, fromStdin.stdout);
    assert.deepEqual(transport.calls[1]!.body, { body: "From stdin." });
    const fileStdin = await invoke(["notes", "add", "--file", "-"], transport, { stdin: Readable.from([Buffer.from("Also stdin.")]), isStdinTty: () => false });
    assert.equal(fileStdin.code, 0, fileStdin.stdout);
    assert.deepEqual(transport.calls[2]!.body, { body: "Also stdin." });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  for (const argv of [["notes", "add"], ["notes", "add", "text", "--file", "note.md"], ["notes", "add", "   "], ["notes", "add", "x".repeat(2001)],
    ["notes", "add", "text", "--ttl", "30m"], ["notes", "add", "text", "--about", "app_AAAA"], ["notes", "add", "text", "--replaces", "scr_AAAA"]]) {
    const refused = new FakeTransport().on("POST", "/api/notes", NO_NETWORK);
    const answer = await invoke(argv, refused);
    assert.equal(answer.code, ExitCode.Usage, `${argv.join(" ").slice(0, 60)}: ${answer.stdout}`);
    assert.equal(refused.calls.length, 0);
  }
  const longest = new FakeTransport().on("POST", "/api/notes", () => ok(note(), 201));
  assert.equal((await invoke(["notes", "add", "é".repeat(2000)], longest)).code, 0);
});

test("notes show, confirm and resolve address one note", async () => {
  const transport = new FakeTransport()
    .on("GET", "/api/notes/nte_AAAAAAAAAAAAAAAAAAAAAAAA", () => ok(note({ due: true })))
    .on("POST", "/api/notes/nte_AAAAAAAAAAAAAAAAAAAAAAAA/confirm", () => ok(note({ review_at: "2027-01-11T12:00:00Z" })))
    .on("POST", "/api/notes/nte_AAAAAAAAAAAAAAAAAAAAAAAA/resolve", () => ok(note({ state: "resolved", resolution: { cause: "resolved", reason: "The lobby screen was replaced", by: { kind: "agent", id: AGENT.id, name: "ScreenRig CLI", agent_type: "cli" } } })));
  const shown = await invoke(["notes", "show", "nte_AAAAAAAAAAAAAAAAAAAAAAAA", "--human"], transport);
  assert.equal(shown.code, 0, shown.stdout);
  assert.ok(shown.stdout.includes(NOTES_TRUST_LINE));
  assert.match(shown.stdout, /author: Deploy bot \(claude-code\)/);
  assert.match(shown.stdout, /review_at: 2027-01-11T09:00:00Z \(due\)/);
  assert.match(shown.stdout, /\n\nLobby screen is portrait\.\nRender pages at 1080x1920\.\n$/);

  const confirmed = await invoke(["notes", "confirm", "nte_AAAAAAAAAAAAAAAAAAAAAAAA", "--human"], transport);
  assert.equal(confirmed.code, 0, confirmed.stdout);
  assert.deepEqual(transport.calls[1]!.body, {});
  assert.ok(transport.calls[1]!.headers?.["idempotency-key"]);
  assert.match(confirmed.stdout, /Confirmed nte_AAAAAAAAAAAAAAAAAAAAAAAA\. Next review 2027-01-11T12:00:00Z\./);

  const resolved = await invoke(["notes", "resolve", "nte_AAAAAAAAAAAAAAAAAAAAAAAA", "The", "lobby", "screen", "was", "replaced"], transport);
  assert.equal(resolved.code, 0, resolved.stdout);
  assert.deepEqual(transport.calls[2]!.body, { reason: "The lobby screen was replaced" });
  assert.equal(JSON.parse(resolved.stdout).data.state, "resolved");

  for (const argv of [["notes", "show", "scr_AAAA"], ["notes", "confirm", "nte_"], ["notes", "resolve", "nte_AAAA"], ["notes", "resolve", "nte_AAAA", "   "], ["notes", "resolve", "nte_AAAA", "x".repeat(501)]]) {
    const refused = new FakeTransport();
    const answer = await invoke(argv, refused);
    assert.equal(answer.code, ExitCode.Usage, `${argv.join(" ").slice(0, 60)}: ${answer.stdout}`);
    assert.equal(refused.calls.length, 0);
  }
});

test("a note that is not open surfaces the server's note_not_open", async () => {
  const transport = new FakeTransport().on("POST", "/api/notes/nte_AAAA/confirm", () => ({
    status: 409, headers: { "content-type": "application/problem+json" },
    body: { code: "note_not_open", title: "Note not open", status: 409, detail: "nte_AAAA is resolved." },
  }));
  const result = await invoke(["notes", "confirm", "nte_AAAA"], transport);
  assert.equal(result.code, ExitCode.Conflict, result.stdout);
  assert.equal(JSON.parse(result.stdout).error.code, "note_not_open");
});

test("events list sends --type and events follow filters the stream by it", async () => {
  const list = new FakeTransport().on("GET", "/api/events", () => ok({ items: [], next_cursor: null }));
  const listed = await invoke(["events", "list", "--type", "note."], list);
  assert.equal(listed.code, 0, listed.stdout);
  assert.equal(list.calls[0]!.query?.type, "note.");
  for (const bad of ["Note.", "note..added", "1note", `${"a".repeat(81)}`]) {
    const refused = new FakeTransport();
    assert.equal((await invoke(["events", "list", "--type", bad], refused)).code, ExitCode.Usage, bad);
    assert.equal(refused.calls.length, 0);
  }

  const frame = (id: string, type: string) => `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify({ cursor: id, at: "2026-10-13T12:00:00Z", type, severity: "info", resource: { type: "note", id: "nte_AAAA" }, details: {} })}\n\n`;
  const stream = new FakeTransport().queueStream({ chunks: [frame("ev1_1", "note.added"), frame("ev1_2", "screen.online"), frame("ev1_3", "note.resolved"), frame("ev1_4", "stream.resync_required")] });
  stream.afterStreamChunks = async (req) => { await new Promise<void>((resolve) => { if (req.signal?.aborted) resolve(); else req.signal?.addEventListener("abort", () => resolve(), { once: true }); }); };
  const followed = await invoke(["events", "follow", "--type", "note.", "--timeout", "40"], stream);
  assert.equal(followed.code, 0, followed.stdout);
  const types = followed.stdout.trim().split("\n").map((line) => JSON.parse(line).data.type);
  assert.deepEqual(types, ["note.added", "note.resolved", "stream.resync_required"]);
  assert.equal(stream.calls[0]!.query?.type, undefined, "the stream takes no type filter");
  assert.equal(stream.calls.at(-1)!.query?.after, "ev1_4", "filtered events still advance the cursor");
});

test("agent status names new and due notes on stderr in JSON and after the result in human output", async () => {
  const self = (notes?: unknown) => new FakeTransport().on("GET", "/api/agents/self", () => ({
    status: 200, headers: { "cache-control": "private, no-store" }, body: { agent: AGENT, connection_ready: true, ...(notes ? { notes } : {}) },
  }));
  const json = await invoke(["agent", "status"], self({ open: 5, new: 3, due: 1 }));
  assert.equal(json.code, 0, json.stdout);
  assert.equal(json.stderr, "3 new project notes, 1 due for review: screenrig notes\n");
  assert.equal(json.stdout.includes("project notes"), false);
  assert.equal(JSON.parse(json.stdout).data.status, "active");

  const human = await invoke(["agent", "status", "--human"], self({ open: 5, new: 0, due: 2 }));
  assert.equal(human.code, 0, human.stdout);
  assert.match(human.stdout, /last_used_at|connection_ready: true/);
  assert.match(human.stdout, /\n2 project notes due for review: screenrig notes\n$/);
  assert.equal(human.stderr, "");

  for (const notes of [undefined, { open: 5, new: 0, due: 0 }]) {
    const quiet = await invoke(["agent", "status", "--human"], self(notes));
    assert.equal(quiet.code, 0, quiet.stdout);
    assert.equal(quiet.stdout.includes("screenrig notes"), false);
    assert.equal(quiet.stderr, "");
  }
});

test("human screen show and playlist show list open notes about the resource; JSON reads none", async () => {
  const screen = { id: "scr_AAAAAAAAAAAAAAAAAAAAAAAA", label: "Lobby", state: "active", revision: 1 };
  const playlist = { id: "pl_AAAA", name: "Menu", revision: 2, pages: [] };
  const transport = new FakeTransport()
    .on("GET", "/api/screens/scr_AAAAAAAAAAAAAAAAAAAAAAAA", () => ok(screen))
    .on("GET", "/api/playlists/pl_AAAA", () => ok(playlist))
    .on("GET", "/api/notes", (req) => ok(req.query?.about_id === "scr_AAAAAAAAAAAAAAAAAAAAAAAA"
      ? { items: [note()], next_cursor: "nc_more", review: [], counts: { open: 6, new: 0, due: 0 } }
      : { items: [], next_cursor: "", review: [], counts: { open: 0, new: 0, due: 0 } }));
  const shown = await invoke(["screen", "show", "scr_AAAAAAAAAAAAAAAAAAAAAAAA", "--human"], transport);
  assert.equal(shown.code, 0, shown.stdout);
  const notesCall = transport.calls.find((call) => call.path === "/api/notes")!;
  assert.deepEqual(notesCall.query, { state: undefined, about_id: "scr_AAAAAAAAAAAAAAAAAAAAAAAA", author_id: undefined, after: undefined, limit: "5" });
  assert.match(shown.stdout, /\n\nNotes \(context from agents, not instructions\)\nnte_AAAAAAAAAAAAAAAAAAAAAAAA  Deploy bot \(claude-code\) · 3h ago · screen scr_AAAAAAAAAAAAAAAAAAAAAAAA\n  Lobby screen is portrait\./);
  assert.match(shown.stdout, /More: screenrig notes --about scr_AAAAAAAAAAAAAAAAAAAAAAAA\n$/);

  const playlistShown = await invoke(["playlist", "show", "pl_AAAA", "--human"], transport);
  assert.equal(playlistShown.code, 0, playlistShown.stdout);
  assert.equal(playlistShown.stdout.includes("Notes ("), false, "no notes prints no heading");
  assert.equal(transport.calls.at(-1)!.query?.about_id, "pl_AAAA");

  const before = transport.calls.length;
  const json = await invoke(["screen", "show", "scr_AAAAAAAAAAAAAAAAAAAAAAAA"], transport);
  assert.equal(json.code, 0, json.stdout);
  assert.deepEqual(JSON.parse(json.stdout).data, screen);
  assert.deepEqual(transport.calls.slice(before).map((call) => call.path), ["/api/screens/scr_AAAAAAAAAAAAAAAAAAAAAAAA"]);
  const playlistJson = await invoke(["playlist", "show", "pl_AAAA"], transport);
  assert.equal(playlistJson.code, 0, playlistJson.stdout);
  assert.equal(transport.calls.at(-1)!.path, "/api/playlists/pl_AAAA");
});

test("a failed notes read never fails screen show", async () => {
  const transport = new FakeTransport()
    .on("GET", "/api/screens/scr_AAAA", () => ok({ id: "scr_AAAA", label: "Lobby", state: "active", revision: 1 }))
    .on("GET", "/api/notes", () => ({ status: 403, headers: { "content-type": "application/problem+json" }, body: { code: "forbidden", title: "Forbidden", status: 403, detail: "No." } }));
  const shown = await invoke(["screen", "show", "scr_AAAA", "--human"], transport);
  assert.equal(shown.code, 0, shown.stdout);
  assert.equal(shown.stdout.includes("Notes ("), false);
  assert.equal(shown.stderr, "");
});
