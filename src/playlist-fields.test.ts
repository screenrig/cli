import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Readable, Writable } from "node:stream";
import { test, type TestContext } from "node:test";
import { ExitCode } from "./exit-codes.js";
import { processRuntime, run } from "./main.js";
import { playlistIssues } from "./playlist-validate.js";
import { templateClearOption, templateSetOption } from "./playlist-fields.js";
import { FakeTransport } from "./transport/fake.js";

const TEMPLATE = "pl_AAAAAAAAAAAAAAAAAAAAAAAA";
const COPY = "pl_BBBBBBBBBBBBBBBBBBBBBBBB";
const IMAGE = "med_AAAAAAAAAAAAAAAAAAAAAAAA";

const fields = () => [
  { name: "logo", label: "Logo", type: "media", required: true },
  { name: "headline", label: "Headline", type: "text", required: true, max_length: 80 },
  { name: "link", label: "Menu link", type: "url", required: false },
];

const primitives = () => [
  { id: "brand", primitive: "image", selector: { by: "id", media_id: IMAGE }, locked: true, rect: { x: 0, y: 0, width: 400, height: 100 }, layer: 0, content_fit: "contain" },
  { id: "photo", primitive: "image", selector: { by: "id", media_id: "{field.logo}" }, rect: { x: 0, y: 100, width: 400, height: 100 }, layer: 0, content_fit: "contain" },
  { id: "headline", primitive: "card", card: "text", major: 1, layout: "full", content_fit: "fill", params: { title: "Welcome {field.headline}" } },
  { id: "menu", primitive: "iframe", src: "{field.link}", title: "Menu", rect: { x: 400, y: 0, width: 800, height: 600 }, layer: 1, content_fit: "fill" },
];

const template = (edit: (document: Record<string, any>) => void = () => undefined) => {
  const document: Record<string, any> = {
    name: "Notice template", fields: fields(),
    pages: [{ id: "notice", canvas: { width: 1920, height: 1080, background: "#000000FF" }, transition: { type: "crossfade", duration_ms: 400 }, advance: { mode: "duration", after_ms: 10000 }, primitives: primitives() }],
  };
  edit(document);
  return document;
};

test("offline validation reads fields, locked primitives and tokens", () => {
  assert.deepEqual(playlistIssues(template()), []);
  const issue = (edit: (document: Record<string, any>) => void) => playlistIssues(template(edit)).map((item) => `${item.path} ${item.message}`).join("\n");
  assert.match(issue((d) => d.fields.pop()), /\/pages\/0\/primitives\/3\/src \{field\.link\} is not a declared field/);
  assert.match(issue((d) => d.fields.push({ name: "extra", label: "Extra", type: "text" })), /\/fields\/3 \{field\.extra\} is declared but no page uses it/);
  assert.match(issue((d) => { d.fields[0].type = "text"; }), /media_id takes a media field/);
  assert.match(issue((d) => { d.fields[2].type = "text"; }), /iframe src takes a url field/);
  assert.match(issue((d) => { d.pages[0].primitives[3].title = "{field.headline}"; }), /a field token stands only in/);
  assert.match(issue((d) => { d.pages[0].primitives[1].locked = true; }), /locked primitive cannot read a field/);
  assert.match(issue((d) => { d.pages[0].primitives[3].src = "https://x.example/{field.link}"; }), /whole address/);
  assert.match(issue((d) => { d.fields[0].type = "date"; }), /fields\/0\/type/);
  // A playlist without fields reads no tokens: its text stays as written.
  assert.deepEqual(playlistIssues(template((d) => { delete d.fields; d.pages[0].primitives = [d.pages[0].primitives[2]]; })), []);
  // locked is a boolean on any primitive.
  assert.notDeepEqual(playlistIssues({ ...template(), fields: undefined, pages: [{ ...template().pages[0], primitives: [{ ...primitives()[0], locked: "yes" }] }] }), []);
});

test("repeatable value options keep line feeds and refuse repeats", () => {
  const set = templateSetOption("body=line one\nline two", templateSetOption("headline=Hello"));
  assert.deepEqual(JSON.parse(set), { headline: "Hello", body: "line one\nline two" });
  assert.throws(() => templateSetOption("headline=Again", set), /given more than once/);
  assert.throws(() => templateSetOption("Bad-Name=x"), /field name/);
  assert.throws(() => templateSetOption("headline"), /NAME=VALUE/);
  assert.deepEqual(JSON.parse(templateClearOption("link", templateClearOption("note"))), ["note", "link"]);
});

async function cli(t: TestContext, transport: FakeTransport) {
  const directory = await mkdtemp(path.join(tmpdir(), "playlist-fields-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = path.join(directory, "config.json");
  await writeFile(config, JSON.stringify({ api_url: "https://api.screenrig.ai", project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", project_name: "Screens",
    organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization", token: "test-token" }), { mode: 0o600 });
  return Object.assign(async (argv: string[], input = "") => {
    let output = "";
    const code = await run({ ...processRuntime(), argv: ["--config", config, ...argv], cwd: () => directory, env: {}, transport,
      stdin: Readable.from([input]), isStdinTty: () => false,
      stdout: new Writable({ write(chunk, _encoding, done) { output += chunk; done(); } }),
      stderr: new Writable({ write(_chunk, _encoding, done) { done(); } }),
    });
    return { code, output };
  }, { directory });
}

const answer = (body: unknown, status = 200) => ({ status, headers: { etag: '"3"' }, body });
const copy = (extra: Record<string, unknown> = {}) => ({ id: COPY, name: "Monday", revision: 3, pages: [], template_id: TEMPLATE, template_revision: 1, values: { logo: IMAGE, headline: "Open late" }, ...extra });

test("playlist create --from-template sends the values and nothing else", async (t) => {
  const bodies: Array<{ body: unknown; headers: Record<string, string | undefined> | undefined }> = [];
  const transport = new FakeTransport().on("POST", "/api/playlists", (request) => { bodies.push({ body: request.body, headers: request.headers }); return answer(copy(), 201); });
  const invoke = await cli(t, transport);
  const created = await invoke(["--json", "playlist", "create", "--from-template", TEMPLATE, "--name", "Monday", "--set", `logo=${IMAGE}`, "--set", "headline=Open late", "--note", "Monday notice"]);
  assert.equal(created.code, ExitCode.Success, created.output);
  assert.deepEqual(bodies[0]!.body, { name: "Monday", from_template: { playlist_id: TEMPLATE, values: { logo: IMAGE, headline: "Open late" } } });
  assert.equal(bodies[0]!.headers?.["screenrig-review-note"], "Monday%20notice");
  assert.ok(bodies[0]!.headers?.["idempotency-key"]);
  for (const argv of [
    ["playlist", "create", "--from-template", TEMPLATE, "--set", "headline=x"],
    ["playlist", "create", "--from-template", "not-an-id", "--name", "x"],
    ["playlist", "create", "lobby.json", "--from-template", TEMPLATE, "--name", "x"],
    ["playlist", "create", "--from-template", TEMPLATE, "--starter", "urgent-notice"],
    ["playlist", "create", "--set", "headline=x"],
    ["playlist", "create"],
  ]) assert.equal((await invoke(["--json", ...argv])).code, ExitCode.Usage, argv.join(" "));
  assert.equal(bodies.length, 1, "refused before any request");
});

test("--dry-run checks the values through expand and creates nothing", async (t) => {
  const expands: unknown[] = [];
  const transport = new FakeTransport().on("POST", `/api/playlists/${TEMPLATE}/expand`, (request) => { expands.push(request.body); return answer({ pages: [{ id: "notice" }] }); });
  const invoke = await cli(t, transport);
  const dry = await invoke(["--json", "playlist", "create", "--from-template", TEMPLATE, "--set", "headline=Hello", "--dry-run"]);
  assert.equal(dry.code, ExitCode.Success, dry.output);
  assert.deepEqual(expands, [{ values: { headline: "Hello" } }]);
  assert.equal(JSON.parse(dry.output).data.pages.length, 1);
});

test("--starter adds the built-in template, naming it only when asked", async (t) => {
  const bodies: unknown[] = [];
  const transport = new FakeTransport().on("POST", "/api/playlists", (request) => { bodies.push(request.body); return answer({ id: TEMPLATE, name: "Urgent notice", revision: 1, pages: [] }, 201); });
  const invoke = await cli(t, transport);
  assert.equal((await invoke(["--json", "playlist", "create", "--starter", "urgent-notice"])).code, ExitCode.Success);
  assert.equal((await invoke(["--json", "playlist", "create", "--starter", "urgent-notice", "--name", "Fire notice"])).code, ExitCode.Success);
  assert.deepEqual(bodies, [{ starter: "urgent-notice" }, { name: "Fire notice", starter: "urgent-notice" }]);
});

test("playlist fields shows a template or a copy, and changes values with a PATCH", async (t) => {
  const patches: Array<{ body: unknown; headers: Record<string, string | undefined> | undefined }> = [];
  const transport = new FakeTransport()
    .on("GET", `/api/playlists/${TEMPLATE}`, () => answer({ id: TEMPLATE, name: "Notice template", revision: 4, pages: [], fields: fields() }))
    .on("GET", `/api/playlists/${TEMPLATE}/instances`, () => answer({ items: [{ id: COPY, name: "Monday", revision: 3, template_revision: 1, outdated: true }] }))
    .on("GET", `/api/playlists/${COPY}`, () => answer(copy()))
    .on("PATCH", `/api/playlists/${COPY}/values`, (request) => { patches.push({ body: request.body, headers: request.headers }); return answer(copy({ revision: 4, template_revision: 4 })); });
  const invoke = await cli(t, transport);
  const shown = JSON.parse((await invoke(["--json", "playlist", "fields", TEMPLATE])).output).data;
  assert.deepEqual([shown.kind, shown.instances, shown.fields.length], ["template", 1, 3]);
  const instance = JSON.parse((await invoke(["--json", "playlist", "fields", COPY])).output).data;
  assert.deepEqual([instance.kind, instance.template_revision, instance.template_current_revision, instance.outdated], ["instance", 1, 4, true]);
  const changed = await invoke(["--json", "playlist", "fields", COPY, "--set", "headline=Closed", "--clear", "link", "--expect-rev", "3", "--note", "Closed today"]);
  assert.equal(changed.code, ExitCode.Success, changed.output);
  assert.deepEqual(patches[0]!.body, { values: { headline: "Closed", link: null } });
  assert.equal(patches[0]!.headers?.["if-match"], '"3"');
  const refreshed = await invoke(["--json", "playlist", "fields", COPY, "--refresh"]);
  assert.equal(refreshed.code, ExitCode.Success);
  assert.deepEqual(patches[1]!.body, { values: {} });
  assert.equal((await invoke(["--json", "playlist", "fields", COPY, "--set", "headline=x", "--clear", "headline"])).code, ExitCode.Usage);
  assert.equal((await invoke(["--json", "playlist", "fields", "nope"])).code, ExitCode.Usage);
});

test("playlist instances and list --templates", async (t) => {
  const transport = new FakeTransport()
    .on("GET", `/api/playlists/${TEMPLATE}/instances`, () => answer({ items: [{ id: COPY, name: "Monday", revision: 3, template_revision: 1, outdated: true }] }))
    .on("GET", "/api/playlists", () => answer({ items: [
      { id: TEMPLATE, name: "Notice template", revision: 4, fields: fields() },
      { id: COPY, name: "Monday", revision: 3, template_id: TEMPLATE },
    ] }));
  const invoke = await cli(t, transport);
  const instances = JSON.parse((await invoke(["--json", "playlist", "instances", TEMPLATE])).output).data.items;
  assert.equal(instances[0].outdated, true);
  const templates = JSON.parse((await invoke(["--json", "playlist", "list", "--templates"])).output).data.items;
  assert.deepEqual(templates.map((item: { id: string }) => item.id), [TEMPLATE]);
  const all = JSON.parse((await invoke(["--json", "playlist", "list"])).output).data.items;
  assert.equal(all.length, 2);
});

test("playlist create from a file keeps fields and refuses a template that fails offline", async (t) => {
  const bodies: unknown[] = [];
  const transport = new FakeTransport().on("POST", "/api/playlists", (request) => { bodies.push(request.body); return answer({ id: TEMPLATE, name: "Notice template", revision: 1, pages: [] }, 201); });
  const invoke = await cli(t, transport);
  const ok = path.join(invoke.directory, "template.json");
  const withoutCard = (d: Record<string, any>) => { d.pages[0].primitives = primitives().filter((primitive) => primitive.primitive !== "card"); d.fields = fields().filter((field) => field.name !== "headline"); };
  await writeFile(ok, JSON.stringify(template(withoutCard)));
  const created = await invoke(["--json", "playlist", "create", ok]);
  assert.equal(created.code, ExitCode.Success, created.output);
  assert.deepEqual((bodies[0] as { fields: unknown }).fields, fields().filter((field) => field.name !== "headline"));
  const bad = path.join(invoke.directory, "bad.json");
  await writeFile(bad, JSON.stringify(template((d) => { withoutCard(d); d.fields.pop(); })));
  assert.equal((await invoke(["--json", "playlist", "create", bad])).code, ExitCode.Usage);
  assert.equal(bodies.length, 1);
  const validated = await invoke(["--json", "playlist", "validate", bad]);
  assert.equal(validated.code, ExitCode.Usage, validated.output);
});
