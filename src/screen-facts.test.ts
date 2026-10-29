import assert from "node:assert/strict";
import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { ScreenPatch } from "./adapters/protocol.js";
import { parseArgv } from "./argv.js";
import { cardDataKeyTemplate, screenLocationStandIn, validatePlaylistCards, type CardDetails } from "./cards.js";
import { ApiClient } from "./client.js";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { ExitCode } from "./exit-codes.js";
import { commandHelp } from "./help-tree.js";
import { run, type CliRuntime } from "./main.js";
import { screenFactsPatch } from "./screen-facts.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport } from "./transport/fake.js";
import type { TransportRequest, TransportResponse } from "./transport/types.js";

const SCREEN = "scr_AAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER = "scr_BBBBBBBBBBBBBBBBBBBBBBBB";

interface Envelope {
  ok: boolean;
  data?: any;
  error?: { code: string; detail: string; status: number };
  warnings?: Array<{ code: string; message: string }>;
}
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
  const configDir = await testTemp("facts-cfg-");
  const cwd = await testTemp("facts-cwd-");
  const fs: ConfigFs = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: "https://api.screenrig.ai", project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", project_name: "Screens", organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization", token: "eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.signature_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" },
    fs,
  );
  return { fs, cwd };
}

async function cli(argv: string[], transport: FakeTransport, env: Env): Promise<{ code: number; stdout: string; envelope: Envelope }> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const outP = collect(stdout);
  const errP = collect(stderr);
  const runtime: CliRuntime = {
    argv, env: env.fs.env, stdout, stderr,
    now: () => new Date("2026-10-27T17:00:00.000Z"),
    sleep: async () => undefined,
    homedir: env.fs.homedir, cwd: () => env.cwd, fs: env.fs, transport,
  };
  const code = await run(runtime);
  stdout.end();
  stderr.end();
  const text = await outP;
  await errP;
  let envelope: Envelope = { ok: false };
  try { envelope = JSON.parse(text) as Envelope; } catch { /* human output */ }
  return { code, stdout: text, envelope };
}

/** The screen list table of human output: the lines after the "Screens" title, header first. */
function tableOf(stdout: string): string[] {
  const lines = stdout.split("\n");
  const title = lines.indexOf("Screens");
  assert.notEqual(title, -1, stdout);
  return lines.slice(title + 1);
}

function screenRow(id: string, extra: Record<string, unknown> = {}): Record<string, any> {
  return {
    id, label: "Lobby", state: "active", revision: 3, public_id: "pub", manifest_revision: 1,
    content_access_generation: 1, online: true, created_at: "2026-10-27T16:00:00.000Z", updated_at: "2026-10-27T16:00:00.000Z",
    ...extra,
  };
}

/**
 * A screen that applies ScreenPatch the way the contract says: fields merge (a
 * string sets, null removes, a null fields clears), location replaces or clears.
 */
function screenBackend(initial: Record<string, unknown> = {}): { transport: FakeTransport; patches: TransportRequest[] } {
  const transport = new FakeTransport();
  const patches: TransportRequest[] = [];
  let row = screenRow(SCREEN, initial);
  transport.on("GET", `/api/screens/${SCREEN}`, () => ({ status: 200, headers: {}, body: row }));
  transport.on("PATCH", `/api/screens/${SCREEN}`, (req): TransportResponse => {
    patches.push(req);
    const patch = req.body as ScreenPatch;
    const next: Record<string, any> = { ...row, revision: row.revision + 1 };
    if (patch.fields === null) delete next.fields;
    else if (patch.fields) {
      const merged = { ...row.fields };
      for (const [name, value] of Object.entries(patch.fields)) {
        if (value === null) delete merged[name]; else merged[name] = value;
      }
      if (Object.keys(merged).length) next.fields = merged; else delete next.fields;
    }
    if (patch.location === null) delete next.location;
    else if (patch.location) next.location = patch.location;
    row = next;
    return { status: 200, headers: {}, body: row };
  });
  return { transport, patches };
}

const patchOf = (patches: TransportRequest[]): TransportRequest => patches.at(-1)!;

test("screen update sends fields as a merge object where null removes a field", async () => {
  const env = await enrolled();
  const { transport, patches } = screenBackend({ fields: { region: "south", old: "x" } });

  const set = await cli(["--json", "screen", "update", SCREEN, "--field", "store_number=0142", "--field", "region=north"], transport, env);
  assert.equal(set.code, 0, set.stdout);
  assert.equal(patchOf(patches).method, "PATCH");
  assert.equal(patchOf(patches).path, `/api/screens/${SCREEN}`);
  assert.deepEqual(patchOf(patches).body, { fields: { store_number: "0142", region: "north" } });
  assert.ok(patchOf(patches).headers?.["idempotency-key"], "a write always carries an Idempotency-Key");
  assert.equal(patchOf(patches).headers?.["if-match"], undefined, "no revision guard unless asked");
  assert.equal(transport.calls.length, 1, "setting a field reads nothing first");
  assert.deepEqual(set.envelope.data.fields, { region: "north", old: "x", store_number: "0142" }, "the envelope is the updated screen");

  const mixed = await cli(["--json", "screen", "update", SCREEN, "--field", "region=east", "--unset-field", "old", "--unset-field", "gone", "--expect-rev", "4"], transport, env);
  assert.equal(mixed.code, 0, mixed.stdout);
  assert.deepEqual(patchOf(patches).body, { fields: { region: "east", old: null, gone: null } });
  assert.equal(patchOf(patches).headers?.["if-match"], '"4"');

  const removal = await cli(["--json", "screen", "update", SCREEN, "--unset-field", "region"], transport, env);
  assert.equal(removal.code, 0, removal.stdout);
  assert.deepEqual(patchOf(patches).body, { fields: { region: null } });

  const cleared = await cli(["--json", "screen", "update", SCREEN, "--clear-fields"], transport, env);
  assert.equal(cleared.code, 0, cleared.stdout);
  assert.deepEqual(patchOf(patches).body, { fields: null });
  assert.equal(cleared.envelope.data.fields, undefined);
});

test("screen update trims values, keeps an equals sign inside one, and combines with the other members", async () => {
  const env = await enrolled();
  const { transport, patches } = screenBackend();
  const result = await cli(["--json", "screen", "update", SCREEN, "--name", "Lobby 2", "--timezone", "Europe/London",
    "--field", "note=  a=b  ", "--field", "url=https://example.com/menu?lang=en"], transport, env);
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(patchOf(patches).body, {
    name: "Lobby 2", timezone: "Europe/London", fields: { note: "a=b", url: "https://example.com/menu?lang=en" },
  });

  // A name any lower case word allows is a field name, whatever it spells.
  const odd = await cli(["--json", "screen", "update", SCREEN, "--field", "__proto__=x"], transport, env);
  assert.equal(odd.code, 0, odd.stdout);
  assert.equal(JSON.stringify(patchOf(patches).body), '{"fields":{"__proto__":"x"}}');
});

test("screen update sends the whole location, or null, and counts characters rather than UTF-16 units", async () => {
  const env = await enrolled();
  const { transport, patches } = screenBackend({ location: { latitude: 1, longitude: 2, name: "Old", address: "Old St" } });

  const bare = await cli(["--json", "screen", "update", SCREEN, "--location", "47.6062,-122.3321"], transport, env);
  assert.equal(bare.code, 0, bare.stdout);
  assert.deepEqual(patchOf(patches).body, { location: { latitude: 47.6062, longitude: -122.3321 } });
  assert.deepEqual(bare.envelope.data.location, { latitude: 47.6062, longitude: -122.3321 }, "the location replaces the old one whole");

  const named = await cli(["--json", "screen", "update", SCREEN, "--location", " -33.8688 , 151.2093 ", "--location-name", "  Sydney HQ ", "--address", "1 Martin Place"], transport, env);
  assert.equal(named.code, 0, named.stdout);
  assert.deepEqual(patchOf(patches).body, { location: { latitude: -33.8688, longitude: 151.2093, name: "Sydney HQ", address: "1 Martin Place" } });

  const origin = await cli(["--json", "screen", "update", SCREEN, "--location", "0,0"], transport, env);
  assert.equal(origin.code, 0, origin.stdout);
  assert.deepEqual(patchOf(patches).body, { location: { latitude: 0, longitude: 0 } });
  const edges = await cli(["--json", "screen", "update", SCREEN, "--location", "-90,180"], transport, env);
  assert.equal(edges.code, 0, edges.stdout);
  assert.deepEqual(patchOf(patches).body, { location: { latitude: -90, longitude: 180 } });

  const cleared = await cli(["--json", "screen", "update", SCREEN, "--clear-location"], transport, env);
  assert.equal(cleared.code, 0, cleared.stdout);
  assert.deepEqual(patchOf(patches).body, { location: null });

  const both = await cli(["--json", "screen", "update", SCREEN, "--clear-fields", "--clear-location"], transport, env);
  assert.equal(both.code, 0, both.stdout);
  assert.deepEqual(patchOf(patches).body, { fields: null, location: null });

  const emoji = "😀".repeat(40);
  const full = await cli(["--json", "screen", "update", SCREEN, "--location", "1,2", "--location-name", emoji, "--address", "😀".repeat(200)], transport, env);
  assert.equal(full.code, 0, full.stdout);
  assert.equal((patchOf(patches).body as ScreenPatch).location?.name, emoji);
});

test("screen update refuses a bad name, value or coordinate before any request", async () => {
  const env = await enrolled();
  const { transport } = screenBackend();
  const many = (count: number) => Array.from({ length: count }, (_, index) => ["--field", `f${String(index).padStart(2, "0")}=1`]).flat();
  const cases: Array<[string[], RegExp]> = [
    [["--field", "noequals"], /--field takes NAME=VALUE/],
    [["--field", "=value"], /--field takes a name of 1 to 32 lower case letters, digits or underscores/],
    [["--field", "Store=1"], /--field takes a name of 1 to 32 lower case letters, digits or underscores/],
    [["--field", "store-number=1"], /--field takes a name of 1 to 32/],
    [["--field", `${"a".repeat(33)}=1`], /--field takes a name of 1 to 32/],
    [["--field", "region="], /--field region takes a value of 1 to 200 characters after trimming, without control characters\. --unset-field NAME removes a field\./],
    [["--field", "region=   "], /--field region takes a value of 1 to 200 characters/],
    [["--field", `region=${"x".repeat(201)}`], /--field region takes a value of 1 to 200 characters/],
    [["--field", "region=a\nb"], /--field region takes a value of 1 to 200 characters/],
    [["--field", "region=a\u001bb"], /--field region takes a value of 1 to 200 characters/],
    [["--field", "region=a\u0085b"], /--field region takes a value of 1 to 200 characters/],
    [["--field", "region=a", "--field", "region=b"], /--field region is given more than once/],
    [many(33), /--field takes at most 32 fields/],
    [["--unset-field", "Region"], /--unset-field takes a field name/],
    [["--unset-field", "region", "--unset-field", "region"], /--unset-field region is given more than once/],
    [["--field", "region=a", "--unset-field", "region"], /--field and --unset-field both name region/],
    [["--clear-fields", "--field", "a=1"], /--field cannot be used with --clear-fields|--clear-fields cannot be used with --field/],
    [["--clear-fields", "--unset-field", "a"], /--unset-field cannot be used with --clear-fields|--clear-fields cannot be used with --unset-field/],
    [["--location", "91,0"], /--location latitude must be from -90 to 90/],
    [["--location", "-90.5,0"], /--location latitude must be from -90 to 90/],
    [["--location", "0,180.5"], /--location longitude must be from -180 to 180/],
    [["--location", "0,-181"], /--location longitude must be from -180 to 180/],
    [["--location", "47.6"], /--location takes LAT,LON as decimal numbers/],
    [["--location", "1,2,3"], /--location takes LAT,LON as decimal numbers/],
    [["--location", "north,west"], /--location takes LAT,LON as decimal numbers/],
    [["--location", "1e1,2"], /--location takes LAT,LON as decimal numbers/],
    [["--location", "1,2", "--clear-location"], /--location cannot be used with --clear-location|--clear-location cannot be used with --location/],
    [["--location-name", "Seattle"], /--location-name requires --location/],
    [["--address", "1 Main St"], /--address requires --location/],
    [["--clear-location", "--location-name", "Seattle"], /--location-name requires --location/],
    [["--location", "1,2", "--location-name", "x".repeat(41)], /--location-name takes 1 to 40 characters/],
    [["--location", "1,2", "--location-name", "😀".repeat(41)], /--location-name takes 1 to 40 characters/],
    [["--location", "1,2", "--location-name", "   "], /--location-name takes 1 to 40 characters/],
    [["--location", "1,2", "--address", "x".repeat(201)], /--address takes 1 to 200 characters/],
    [["--location", "1,2", "--address", "a\tb"], /--address takes 1 to 200 characters/],
    [["--expect-rev", "1"], /Provide at least one of --name or --playlist-id/],
  ];
  for (const [flags, message] of cases) {
    const result = await cli(["--json", "screen", "update", SCREEN, ...flags], transport, env);
    assert.equal(result.code, ExitCode.Usage, `${flags.slice(0, 4).join(" ")}: ${result.stdout}`);
    assert.equal(result.envelope.error?.code, "usage_error");
    assert.match(result.envelope.error!.detail, message, flags.slice(0, 4).join(" "));
  }
  assert.equal(transport.calls.length, 0, "nothing reached the server");

  const accepted = await cli(["--json", "screen", "update", SCREEN, ...many(32)], transport, env);
  assert.equal(accepted.code, 0, accepted.stdout);
  assert.equal(Object.keys((transport.calls.at(-1)!.body as ScreenPatch).fields as object).length, 32, "a screen holds 32 fields");
});

test("screenFactsPatch refuses the combinations the command line already declares", () => {
  assert.deepEqual(screenFactsPatch({}), {});
  assert.throws(() => screenFactsPatch({ "clear-fields": true, field: "a=1" }), /--clear-fields cannot be used with --field or --unset-field/);
  assert.throws(() => screenFactsPatch({ "clear-location": true, location: "1,2" }), /--clear-location cannot be used with --location/);
  assert.throws(() => screenFactsPatch({ address: "x" }), /--address requires --location/);
  assert.throws(() => screenFactsPatch({ field: "a=1", "unset-field": "a" }), /both name a/);
  assert.deepEqual(screenFactsPatch({ "unset-field": "a\nb" }), { fields: { a: null, b: null } });
  assert.deepEqual(screenFactsPatch({ location: "1,2", address: "Main" }), { location: { latitude: 1, longitude: 2, address: "Main" } });
});

test("screen update names the new flags when nothing is asked", async () => {
  const env = await enrolled();
  const { transport } = screenBackend();
  const result = await cli(["--json", "screen", "update", SCREEN], transport, env);
  assert.equal(result.code, ExitCode.Usage);
  assert.match(result.envelope.error!.detail, /--name or --playlist-id or --timezone or --field or --unset-field or --clear-fields or --location or --clear-location/);
  assert.equal(transport.calls.length, 0);
});

test("--field and --unset-field repeat on screen update and --field on screen list; other options still may not", () => {
  const update = parseArgv(["screen", "update", SCREEN, "--field", "a=1", "--field", "b=2", "--unset-field", "c", "--unset-field", "d"]);
  assert.equal(update.flags.field, "a=1\nb=2");
  assert.equal(update.flags["unset-field"], "c\nd");
  assert.equal(parseArgv(["screen", "list", "--field", "a=1", "--field", "b=2"]).flags.field, "a=1\nb=2");
  assert.throws(() => parseArgv(["screen", "update", SCREEN, "--location", "1,2", "--location", "3,4"]), /--location may be supplied only once/);
  assert.throws(() => parseArgv(["screen", "update", SCREEN, "--clear-fields", "--clear-fields"]), /--clear-fields may be supplied only once/);
  assert.throws(() => parseArgv(["screen", "list", "--near", "1,2,3", "--near", "1,2,4"]), /--near may be supplied only once/);
  assert.throws(() => parseArgv(["screen", "assign", SCREEN, "--playlist-id", "pl_A", "--field", "a=1"]), /does not accept --field/);
});

test("screen list sends each field as its own NAME:VALUE parameter and near as one value", async () => {
  const env = await enrolled();
  const transport = new FakeTransport().on("GET", "/api/screens", () => ({ status: 200, headers: {}, body: { items: [], next_cursor: null } }));
  const asked = () => transport.calls.at(-1)!;

  const fields = await cli(["--json", "screen", "list", "--field", "region=north", "--field", "store_number=  0142 ", "--field", "city=New:York"], transport, env);
  assert.equal(fields.code, 0, fields.stdout);
  assert.deepEqual(asked().query, {});
  assert.deepEqual(asked().queryRepeated, { field: ["region:north", "store_number:0142", "city:New:York"] });

  const near = await cli(["--json", "screen", "list", "--near", " 47.6062, -122.3321 ,25", "--tag", "Lobby", "--state", "archived", "--field", "region=north"], transport, env);
  assert.equal(near.code, 0, near.stdout);
  assert.deepEqual(asked().query, { state: "archived", tag: "Lobby", near: "47.6062,-122.3321,25" });
  assert.deepEqual(asked().queryRepeated, { field: ["region:north"] });

  const radius = await cli(["--json", "screen", "list", "--near", "0,0,0.5"], transport, env);
  assert.equal(radius.code, 0, radius.stdout);
  assert.deepEqual(asked().query, { near: "0,0,0.5" });
  assert.equal(Object.hasOwn(asked(), "queryRepeated"), false, "no field flag sends no field parameter");

  const plain = await cli(["--json", "screen", "list"], transport, env);
  assert.equal(plain.code, 0, plain.stdout);
  assert.deepEqual(asked().query, {});
  assert.equal(Object.hasOwn(asked(), "queryRepeated"), false);
});

test("screen list carries its filters on every page", async () => {
  const env = await enrolled();
  const rows = ["A", "B", "C", "D", "E"].map((letter) => screenRow(`scr_${letter.repeat(24)}`, { fields: { region: "north" } }));
  const transport = new FakeTransport().on("GET", "/api/screens", (req) => {
    const start = Number(String(req.query?.after ?? "pg_0").slice(3));
    return { status: 200, headers: {}, body: { items: rows.slice(start, start + 2), next_cursor: start + 2 < rows.length ? `pg_${start + 2}` : null } };
  });
  const listed = await cli(["--json", "screen", "list", "--field", "region=north", "--field", "tier=gold", "--near", "47.6,-122.3,25"], transport, env);
  assert.equal(listed.code, 0, listed.stdout);
  assert.equal(listed.envelope.data.items.length, 5);
  assert.equal(transport.calls.length, 3);
  transport.calls.forEach((call, index) => {
    assert.deepEqual(call.queryRepeated, { field: ["region:north", "tier:gold"] }, `page ${index + 1} repeats the field filters`);
    assert.deepEqual(call.query, index === 0 ? { near: "47.6,-122.3,25" } : { near: "47.6,-122.3,25", after: `pg_${index * 2}` });
  });
});

test("screen list refuses a malformed filter before any request", async () => {
  const env = await enrolled();
  const transport = new FakeTransport().on("GET", "/api/screens", () => ({ status: 200, headers: {}, body: { items: [], next_cursor: null } }));
  const many = Array.from({ length: 33 }, (_, index) => ["--field", `f${String(index).padStart(2, "0")}=1`]).flat();
  const cases: Array<[string[], RegExp]> = [
    [["--field", "region"], /--field takes NAME=VALUE/],
    [["--field", "Region=north"], /--field takes a name of 1 to 32/],
    [["--field", "region="], /--field region takes a value of 1 to 200 characters/],
    [["--field", `region=${"x".repeat(201)}`], /--field region takes a value of 1 to 200 characters/],
    [["--field", "region=a", "--field", "region=b"], /--field region is given more than once/],
    [many, /--field takes at most 32 fields/],
    [["--near", "47.6,-122.3"], /--near takes LAT,LON,KM as decimal numbers/],
    [["--near", "47.6,-122.3,25,1"], /--near takes LAT,LON,KM as decimal numbers/],
    [["--near", "a,b,c"], /--near takes LAT,LON,KM as decimal numbers/],
    [["--near", "1e1,2,3"], /--near takes LAT,LON,KM as decimal numbers/],
    [["--near", "47.6,-122.3,0"], /--near KM must be greater than zero/],
    [["--near", "47.6,-122.3,-5"], /--near KM must be greater than zero/],
    [["--near", "91,0,5"], /--near latitude must be from -90 to 90/],
    [["--near", "0,-181,5"], /--near longitude must be from -180 to 180/],
  ];
  for (const [flags, message] of cases) {
    const result = await cli(["--json", "screen", "list", ...flags], transport, env);
    assert.equal(result.code, ExitCode.Usage, `${flags.slice(0, 4).join(" ")}: ${result.stdout}`);
    assert.match(result.envelope.error!.detail, message, flags.slice(0, 4).join(" "));
  }
  assert.equal(transport.calls.length, 0, "nothing reached the server");
});

test("screen show, list and update print fields and location compactly, and the JSON carries them as sent", async () => {
  const env = await enrolled();
  const placed = screenRow(SCREEN, { fields: { region: "north", store_number: "0142" }, location: { latitude: 47.6062, longitude: -122.3321, name: "Seattle HQ", address: "1 Main St" } });
  const bare = screenRow(OTHER, { label: "Cafe" });
  const transport = new FakeTransport()
    .on("GET", `/api/screens/${SCREEN}`, () => ({ status: 200, headers: {}, body: placed }))
    .on("GET", `/api/screens/${OTHER}`, () => ({ status: 200, headers: {}, body: bare }))
    .on("GET", "/api/screens", () => ({ status: 200, headers: {}, body: { items: [placed, bare], next_cursor: null } }));

  const shown = await cli(["--human", "screen", "show", SCREEN], transport, env);
  assert.equal(shown.code, 0, shown.stdout);
  assert.match(shown.stdout, /^Fields: region=north, store_number=0142$/m);
  assert.match(shown.stdout, /^Location: 47\.6062, -122\.3321 \(Seattle HQ\) · 1 Main St$/m);
  const plainShow = await cli(["--human", "screen", "show", OTHER], transport, env);
  assert.doesNotMatch(plainShow.stdout, /^Fields:|^Location:/m);
  const json = await cli(["--json", "screen", "show", SCREEN], transport, env);
  assert.deepEqual(json.envelope.data.fields, { region: "north", store_number: "0142" });
  assert.deepEqual(json.envelope.data.location, { latitude: 47.6062, longitude: -122.3321, name: "Seattle HQ", address: "1 Main St" });

  const listed = await cli(["--human", "screen", "list"], transport, env);
  assert.equal(listed.code, 0, listed.stdout);
  const [header, first, second] = tableOf(listed.stdout);
  assert.match(header!, /^ID\s+LABEL\s+STATE\s+FIELDS\s+LOCATION$/);
  assert.match(first!, new RegExp(`^${SCREEN}\\s+Lobby\\s+active\\s+region=north,store_number=0142\\s+47\\.6062,-122\\.3321 \\(Seattle HQ\\)$`));
  assert.match(second!, new RegExp(`^${OTHER}\\s+Cafe\\s+active$`));

  const calm = new FakeTransport().on("GET", "/api/screens", () => ({ status: 200, headers: {}, body: { items: [bare], next_cursor: null } }));
  const plainList = await cli(["--human", "screen", "list"], calm, env);
  assert.match(tableOf(plainList.stdout)[0]!, /^ID\s+LABEL\s+STATE$/, "a fleet without fields or locations keeps its table");

  const { transport: writable } = screenBackend({ fields: { region: "south" } });
  const updated = await cli(["--human", "screen", "update", SCREEN, "--field", "store_number=0142", "--location", "47.6062,-122.3321"], writable, env);
  assert.equal(updated.code, 0, updated.stdout);
  assert.match(updated.stdout, /^Updated screen scr_A+$/m);
  assert.match(updated.stdout, /^Fields: region=south, store_number=0142$/m, "the merged fields");
  assert.match(updated.stdout, /^Location: 47\.6062, -122\.3321$/m);
  const nameOnly = await cli(["--human", "screen", "update", SCREEN, "--name", "Lobby 2"], writable, env);
  assert.doesNotMatch(nameOnly.stdout, /^Fields:|^Location:/m, "an update that leaves them alone does not print them");
});

test("server text never reaches the terminal as control characters or a malformed field name", async () => {
  const env = await enrolled();
  const hostile = screenRow(SCREEN, {
    fields: { region: "north\u001b[31m red\nline", "Bad Name": "x", "also-bad": "y", count: 5 },
    location: { latitude: 1, longitude: 2, name: "A\u001b]0;title\u0007B", address: "\n" },
  });
  const transport = new FakeTransport()
    .on("GET", `/api/screens/${SCREEN}`, () => ({ status: 200, headers: {}, body: hostile }))
    .on("GET", "/api/screens", () => ({ status: 200, headers: {}, body: { items: [hostile, screenRow(OTHER, { fields: "nope", location: { latitude: "1", longitude: 2 } })], next_cursor: null } }));
  const shown = await cli(["--human", "screen", "show", SCREEN], transport, env);
  assert.equal(shown.code, 0, shown.stdout);
  const body = shown.stdout.split("\n").filter((line) => /^(Fields|Location):/.test(line));
  assert.deepEqual(body, ["Fields: region=north [31m red line", "Location: 1, 2 (A ]0;title B)"]);
  for (const line of body) assert.doesNotMatch(line, /[\u0000-\u001f\u007f-\u009f]/);
  const listed = await cli(["--human", "screen", "list"], transport, env);
  assert.equal(listed.code, 0, listed.stdout);
  const table = tableOf(listed.stdout).slice(0, 3).join("\n");
  assert.doesNotMatch(table, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
  assert.match(table, /region=north \[31m red line/);
});

// --- card placements -----------------------------------------------------------------------

const LAYOUTS = ["full", "free", "center", "wide", "header", "footer", "corner", "chip", "strip"];
const PLACE = {
  type: "object", additionalProperties: false, required: ["name", "latitude", "longitude"],
  properties: { name: { type: "string", maxLength: 40 }, latitude: { type: "number", minimum: -90, maximum: 90 }, longitude: { type: "number", minimum: -180, maximum: 180 } },
};

function card(id: string, params: Record<string, unknown>, extra: Partial<CardDetails["params_schema"]> = {}, dynamic: string[] = []): CardDetails {
  const properties = Object.fromEntries(Object.entries(params).map(([name, schema]) => [name, dynamic.includes(name) ? { ...(schema as object), dynamic: true } : schema]));
  return {
    id, major: 1, version: "1.0.0", tier: "core", layouts: LAYOUTS, feed: "",
    params_schema: { type: "object", additionalProperties: false, properties, ...extra },
    data_schema: { type: "object", properties: Object.fromEntries(dynamic.map((name) => [name, {}])) },
    example: {},
  };
}

const CARDS: Record<string, CardDetails> = {
  // Free text with small limits, an enum, and nested text.
  text: card("text", {
    title: { type: "string", maxLength: 5 }, theme: { type: "string", enum: ["light", "dark"] },
    rows: { type: "array", items: { type: "object", properties: { label: { type: "string", maxLength: 3 } } } },
  }),
  // A location that names the place, as weather does.
  weather: card("weather", { title: { type: "string", maxLength: 5 }, location: PLACE }, { required: ["location"] }),
  // The same location through $defs, through a nullable anyOf, and as a type list.
  ref: card("ref", { location: { $ref: "#/$defs/place" } }, { $defs: { place: PLACE } }),
  nullable: card("nullable", { location: { anyOf: [{ $ref: "#/$defs/place" }, { type: "null" }] } }, { $defs: { place: PLACE } }),
  typelist: card("typelist", { location: { ...PLACE, type: ["object", "null"], default: null } }),
  // A location without a name, as clock has, and one whose name is optional.
  clock: card("clock", { location: { type: ["object", "null"], additionalProperties: false, required: ["latitude", "longitude"], properties: { latitude: { type: "number" }, longitude: { type: "number" } } } }),
  alerts: card("alerts", { location: { type: "object", additionalProperties: false, required: ["latitude", "longitude"], properties: { name: { type: "string", maxLength: 40 }, latitude: { type: "number" }, longitude: { type: "number" } } } }),
  // A location that is text, and a card with none.
  parking: card("parking", { location: { type: "string", maxLength: 120 } }),
  menu: card("menu", { title: { type: "string", maxLength: 40 }, sections: { type: "array", minItems: 1, maxItems: 3 } }, { required: ["sections"] }, ["sections"]),
};

function placement(cardId: string, params: Record<string, unknown>, data?: string) {
  return { name: "Stores", pages: [{ id: "p1", primitives: [{ id: "c1", primitive: "card", card: cardId, params, ...(data ? { data } : {}), layout: "full", content_fit: "fill" }] }] };
}

function validate(cardId: string, params: Record<string, unknown>, data?: string): Promise<void> {
  const transport = new FakeTransport().on("GET", `/api/card-types/${cardId}`, () => ({ status: 200, headers: {}, body: CARDS[cardId] }));
  return validatePlaylistCards(new ApiClient({ transport }), placement(cardId, params, data));
}

const PARAMS_PATH = "pages\\[0\\]\\.primitives\\[0\\]\\.params";

test("a text token stands for the letter x, so a limit on the param reads the shortest text", async () => {
  await validate("text", { title: "{screen.name}" });
  await validate("text", { title: "{screen.field.store_number}-{screen.timezone}" });
  await validate("text", { title: "{screen.field.a}{screen.field.b}{screen.name}" });
  await validate("text", { rows: [{ label: "{screen.field.region}" }, { label: "{screen.name}" }] });
  // Without tokens the same text is checked as written, and tokens do not excuse a wrong type or an enum.
  await assert.rejects(() => validate("text", { title: "toolong" }), /Invalid card params: .*params\/title: must NOT have more than 5 characters/);
  await assert.rejects(() => validate("text", { title: "{screen.name} and more" }), /must NOT have more than 5 characters/);
  await assert.rejects(() => validate("text", { title: 5 }), /params\/title: must be string/);
  await assert.rejects(() => validate("text", { theme: "{screen.field.theme}" }), /params\/theme: must be equal to one of the allowed values/);
  await assert.rejects(() => validate("text", { rows: [{ label: "toolong {screen.name}" }] }), /must NOT have more than 3 characters/);
  // Only the documented tokens are tokens.
  await assert.rejects(() => validate("text", { title: "{screen.id}" }), /must NOT have more than 5 characters/);
  await assert.rejects(() => validate("text", { title: "{screen.field.Store}" }), /must NOT have more than 5 characters/);
});

test("{screen.location} as the whole location param stands for the card's own location shape", async () => {
  for (const id of ["weather", "ref", "nullable", "typelist", "clock", "alerts"]) {
    await validate(id, { location: "{screen.location}", ...(id === "weather" ? { title: "{screen.name}" } : {}) });
  }
  // Inside the location, text tokens still read as x.
  await validate("weather", { location: { name: "{screen.name}", latitude: 47.6, longitude: -122.3 } });
  // A location written out is checked as before.
  await assert.rejects(() => validate("weather", { location: "Seattle" }), /params\/location: must be object/);
  await assert.rejects(() => validate("weather", { location: { name: "Seattle", latitude: 91, longitude: 0 } }), /latitude: must be <= 90/);
  // A card with no latitude and longitude refuses the token, naming params.location.
  for (const id of ["parking", "text", "menu"]) {
    await assert.rejects(() => validate(id, { location: "{screen.location}" }), new RegExp(`^.*${PARAMS_PATH}\\.location cannot be \\{screen\\.location\\}: the ${id} card's location is not a latitude and longitude\\.$`), id);
  }
});

test("the stand-in location is latitude 0 and longitude 0, plus an empty name where the card's location takes one", () => {
  assert.deepEqual(screenLocationStandIn(CARDS.weather!), { latitude: 0, longitude: 0, name: "" });
  assert.deepEqual(screenLocationStandIn(CARDS.alerts!), { latitude: 0, longitude: 0, name: "" });
  assert.deepEqual(screenLocationStandIn(CARDS.ref!), { latitude: 0, longitude: 0, name: "" });
  assert.deepEqual(screenLocationStandIn(CARDS.nullable!), { latitude: 0, longitude: 0, name: "" });
  assert.deepEqual(screenLocationStandIn(CARDS.typelist!), { latitude: 0, longitude: 0, name: "" });
  assert.deepEqual(screenLocationStandIn(CARDS.clock!), { latitude: 0, longitude: 0 });
  assert.equal(screenLocationStandIn(CARDS.parking!), undefined);
  assert.equal(screenLocationStandIn(CARDS.menu!), undefined);
  assert.equal(screenLocationStandIn({ params_schema: { type: "object", properties: { location: { $ref: "#/$defs/loop" } }, $defs: { loop: { anyOf: [{ $ref: "#/$defs/loop" }] } } } }), undefined, "a reference cycle ends");
});

test("a card data key may carry {screen.field.NAME}, checked with each token as x", async () => {
  for (const key of ["menu-main", "menu-{screen.field.store_number}", "menu/{screen.field.region}-{screen.field.store_number}", "{screen.field.store}-menu", "a.{screen.field.x}.b", "k:{screen.field.a_1}", "a".repeat(256)]) {
    assert.equal(cardDataKeyTemplate(key), key);
    await validate("menu", { title: "Lunch" }, key);
  }
  // Fields only: a key must change when a field changes, not when the name or time zone does.
  for (const key of [
    "menu-{screen.field.Store}", "menu-{screen.name}", "menu-{screen.timezone}", "menu-{screen.location}", "menu-{screen.field.}", "menu-{screen.field.store_number",
    "menu-{screen.field.store number}", "menu-{screen.field.store-number}", `menu-{screen.field.${"a".repeat(33)}}`, "menu-{screen.field.a}}", "feed:{screen.field.x}",
    "-{screen.field.x}", "menu key {screen.field.x}", "a".repeat(257), "{{screen.field.x}}",
  ]) {
    assert.throws(() => cardDataKeyTemplate(key), /Card data key must follow the K\/V key grammar and may not start with feed:/, key);
    await assert.rejects(() => validate("menu", { title: "Lunch" }, key), /K\/V key grammar/, key);
  }
  // The bound card still takes only static params, whatever its key.
  await assert.rejects(() => validate("menu", { title: "Lunch", sections: [{ title: "x" }] }, "menu-{screen.field.store_number}"), /sections is dynamic/);
});

test("a playlist write reads the tokens through the same checks", async () => {
  const transport = new FakeTransport()
    .on("GET", "/api/card-types/weather", () => ({ status: 200, headers: {}, body: CARDS.weather }))
    .on("GET", "/api/card-types/menu", () => ({ status: 200, headers: {}, body: CARDS.menu }));
  const client = new ApiClient({ transport });
  const document = {
    name: "Stores",
    pages: [{ id: "p1", primitives: [
      { id: "a", primitive: "card", card: "weather", params: { title: "{screen.name}", location: "{screen.location}" }, layout: "full", content_fit: "fill" },
      { id: "b", primitive: "card", card: "menu", params: { title: "{screen.field.store_number}" }, data: "menu-{screen.field.store_number}", layout: "center", content_fit: "fill" },
    ] }],
  };
  await validatePlaylistCards(client, document);
  const second = structuredClone(document);
  (second.pages[0]!.primitives[1] as { data: string }).data = "menu-{screen.name}";
  await assert.rejects(() => validatePlaylistCards(client, second), /K\/V key grammar/);
});

// --- help --------------------------------------------------------------------------------------

test("help lists the new options, their relationships and the tokens a card reads", () => {
  const update = commandHelp(["screen", "update"]);
  const names = update.options.map((option) => option.name);
  for (const name of ["--field", "--unset-field", "--clear-fields", "--location", "--location-name", "--address", "--clear-location"]) assert.ok(names.includes(name), name);
  for (const option of update.options.filter((candidate) => /^--(field|unset-field|clear-fields|location|location-name|address|clear-location)$/.test(candidate.name))) {
    assert.ok(option.description.length > 0 && !option.description.includes("\n"), `${option.name} has a one-line description`);
  }
  const option = (name: string) => update.options.find((candidate) => candidate.name === name)!;
  assert.deepEqual(option("--clear-fields").conflicts.sort(), ["--field", "--unset-field"]);
  assert.deepEqual(option("--field").conflicts, ["--clear-fields"]);
  assert.deepEqual(option("--clear-location").conflicts, ["--location"]);
  assert.deepEqual(option("--location").conflicts, ["--clear-location"]);
  assert.deepEqual(update.relationships, [
    { kind: "requires", options: ["--location-name", "--location"] },
    { kind: "requires", options: ["--address", "--location"] },
    { kind: "atLeastOne", options: ["--name", "--playlist-id", "--timezone", "--field", "--unset-field", "--clear-fields", "--location", "--clear-location"] },
  ]);
  const note = update.notes.join("\n");
  for (const token of ["{screen.field.NAME}", "{screen.name}", "{screen.timezone}", '"location": "{screen.location}"', "menu-{screen.field.store_number}"]) assert.ok(note.includes(token), token);
  assert.ok(update.examples.some((example) => example.includes("--field store_number=0142 --field region=north")));
  assert.ok(update.examples.some((example) => example.includes("--location 47.6062,-122.3321")));

  const list = commandHelp(["screen", "list"]);
  assert.ok(list.options.some((candidate) => candidate.name === "--field" && /repeatable/.test(candidate.description)));
  assert.ok(list.options.some((candidate) => candidate.name === "--near" && /KM kilometres/.test(candidate.description)));
  assert.ok(list.examples.some((example) => example.includes("--near 47.6062,-122.3321,25")));
  assert.match(list.notes.join("\n"), /--near LAT,LON,KM/);
});
