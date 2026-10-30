import assert from "node:assert/strict";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { auditAnchor, auditEntryLines, auditHeadLines, auditId, auditListLines, auditVerifyLines } from "./audit.js";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { ExitCode } from "./exit-codes.js";
import { run, type CliRuntime } from "./main.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport } from "./transport/fake.js";

const NOW = new Date("2026-10-29T17:00:00.000Z");
const ENTRY_ID = "aud_AAAAAAAAAAAAAAAAAAAAAA";
const HASH = "a".repeat(64);

interface Envelope { ok: boolean; data?: any; error?: { code: string; detail: string } }
interface Env { fs: ConfigFs; cwd: string }

function collect(stream: PassThrough): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("finish", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.resume();
  });
}

async function enrolled(): Promise<Env> {
  const configDir = await testTemp("audit-cfg-");
  const cwd = await testTemp("audit-cwd-");
  const fs: ConfigFs = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(path.join(configDir, "screenrig", "config.json"), { api_url: "https://api.screenrig.ai", project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", project_name: "Screens", organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization", token: "eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.signature_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" }, fs);
  return { fs, cwd };
}

async function cli(argv: string[], transport: FakeTransport, env: Env): Promise<{ code: number; stdout: string; envelope: Envelope }> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out = collect(stdout);
  const err = collect(stderr);
  const runtime: CliRuntime = { argv, env: env.fs.env, stdout, stderr, now: () => NOW, sleep: async () => undefined, homedir: env.fs.homedir, cwd: () => env.cwd, fs: env.fs, transport };
  const code = await run(runtime);
  stdout.end();
  stderr.end();
  const text = await out;
  await err;
  let envelope: Envelope = { ok: false };
  try { envelope = JSON.parse(text) as Envelope; } catch { /* human output */ }
  return { code, stdout: text, envelope };
}

const json = (body: unknown) => ({ status: 200, headers: { "content-type": "application/json" }, body, rawText: JSON.stringify(body) });
const file = (type: string, bytes: Buffer) => ({ status: 200, headers: { "content-type": type }, body: { async *[Symbol.asyncIterator]() { yield bytes; } } });

const ENTRY = {
  id: ENTRY_ID, at: "2026-10-29T16:00:00.000Z", scope: "prj_1", source: "cli", action: "screen.update",
  actor: { kind: "agent", id: "agt_1", name: "Claude" }, resource: { type: "screen", id: "scr_1", name: "Lobby north" },
  changes: [{ path: "/label", before: "Lobby", after: "Lobby north" }, { path: "/signing_secret", before: "(redacted)", after: "(redacted)", redacted: true }],
  revision: { type: "screen", before: 3, after: 4 }, request_id: "req_1", client: { kind: "cli", version: "26.10.1" }, seq: 12, hash: HASH,
};

test("audit list sends only the filters it was given and prints a table with the next page", async () => {
  const env = await enrolled();
  const transport = new FakeTransport().on("GET", "/api/audit", () => json({ items: [ENTRY], next_cursor: "au1_next" }));
  const result = await cli(["--json", "audit", "list", "--resource-type", "screen", "--actor-kind", "agent", "--source", "cli", "--action", "screen.*", "--field", "/label", "--since", "2026-10-01T00:00:00Z", "--limit", "20", "--after", "au1_x"], transport, env);
  assert.equal(result.code, ExitCode.Success, result.stdout);
  assert.deepEqual(JSON.parse(JSON.stringify(transport.calls[0]!.query)), {
    resource_type: "screen", actor_kind: "agent", source: "cli", action: "screen.*", field: "/label", since: "2026-10-01T00:00:00Z", limit: "20", cursor: "au1_x",
  });
  assert.equal(result.envelope.data.items[0].changes[0].before, "Lobby");
  const lines = auditListLines([ENTRY], "au1_next").join("\n");
  assert.match(lines, /screen\.update/);
  assert.match(lines, /More: --after au1_next/);
  assert.equal(auditListLines([], null)[0], "No audit entries");
});

test("audit show prints every changed field's before and after and keeps a credential redacted", async () => {
  const env = await enrolled();
  const transport = new FakeTransport().on("GET", `/api/audit/${ENTRY_ID}`, () => json(ENTRY));
  const result = await cli(["--json", "audit", "show", ENTRY_ID], transport, env);
  assert.equal(result.code, ExitCode.Success, result.stdout);
  const text = auditEntryLines(ENTRY).join("\n");
  assert.match(text, /\/label\n\s+before: "Lobby"\n\s+after:\s+"Lobby north"/);
  assert.match(text, /\/signing_secret \(redacted\)/);
  assert.match(text, /chain 12 a+/);
  assert.equal((await cli(["audit", "show", "scr_1"], transport, env)).code, ExitCode.Usage);
});

test("audit verify exits 13 with the problems when the chain does not verify, and sends the anchor", async () => {
  const env = await enrolled();
  const bad = { ok: false, checked: 5, first_seq: 1, last_seq: 5, head: { seq: 5, hash: HASH, unsealed: 0 }, problems: [{ seq: 3, code: "hash_mismatch", detail: "the entry's content does not match its hash" }] };
  const transport = new FakeTransport().on("GET", "/api/audit/verify", () => json(bad));
  const anchor = `4:${"b".repeat(64)}`;
  const result = await cli(["audit", "verify", "--anchor", anchor, "--from-seq", "2"], transport, env);
  assert.equal(result.code, ExitCode.OperationFailed, result.stdout);
  assert.equal(result.envelope.data.ok, false);
  assert.equal(result.envelope.data.problems[0].code, "hash_mismatch");
  const human = auditVerifyLines(bad).join("\n");
  assert.match(human, /does not verify/);
  assert.match(human, /3: hash_mismatch/);
  assert.deepEqual(JSON.parse(JSON.stringify(transport.calls[0]!.query)), { from_seq: "2", anchor });
  const good = new FakeTransport().on("GET", "/api/audit/verify", () => json({ ok: true, checked: 2, first_seq: 1, last_seq: 2, head: { seq: 2, hash: HASH, unsealed: 3 }, problems: [] }));
  const ok = await cli(["audit", "verify"], good, env);
  assert.equal(ok.code, ExitCode.Success);
  assert.equal(ok.envelope.data.ok, true);
  const intact = auditVerifyLines({ ok: true, checked: 2, first_seq: 1, last_seq: 2, head: { unsealed: 3 } }).join("\n");
  assert.match(intact, /The chain is intact/);
  assert.match(intact, /3 newer entries are waiting to be chained/);
  assert.throws(() => auditAnchor("12:xyz"), /SEQ:HASH/);
  assert.equal((await cli(["audit", "verify", "--anchor", "nope"], good, env)).code, ExitCode.Usage);
  assert.match(auditVerifyLines({ ok: true, checked: 1, first_seq: 1, last_seq: 1, next_seq: 2 }).join("\n"), /--from-seq 2/);
});

test("audit head prints the anchor to keep", () => {
  const text = auditHeadLines({ scope: "prj_1", seq: 7, hash: HASH, floor_seq: 0, floor_hash: "c".repeat(64), unsealed: 1, oldest_retained_seq: 1 }).join("\n");
  assert.match(text, new RegExp(`head: 7:${HASH}`));
  assert.match(text, /waiting to be chained: 1/);
  assert.equal(auditId(ENTRY_ID, "show"), ENTRY_ID);
});

test("audit export writes the renderer's file with the chain head and requires a file format", async () => {
  const env = await enrolled();
  const csv = Buffer.from(`Time,Actor\n2026-10-29,Claude\nChain head: seq 12, hash ${HASH}.\n`);
  const transport = new FakeTransport().onDownload("GET", "/api/audit", () => file("text/csv; charset=utf-8", csv));
  const result = await cli(["--json", "audit", "export", "--format", "csv", "--output", "audit.csv", "--since", "2026-07-01T00:00:00Z", "--resource-type", "playlist"], transport, env);
  assert.equal(result.code, ExitCode.Success, result.stdout);
  assert.deepEqual(JSON.parse(JSON.stringify(transport.calls[0]!.query)), { resource_type: "playlist", since: "2026-07-01T00:00:00Z", format: "csv" });
  assert.equal((await readFile(path.join(env.cwd, "audit.csv"))).toString("utf8"), csv.toString("utf8"));
  assert.equal((await cli(["audit", "export"], transport, env)).code, ExitCode.Usage);
  assert.equal((await cli(["audit", "export", "--format", "json"], transport, env)).code, ExitCode.Usage);
});
