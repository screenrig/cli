import assert from "node:assert/strict";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { testTemp } from "../test-temp.js";
import { fixtureRouter, FIXTURE_TOKEN, FIXTURE_URL, registerFixtureVendor } from "./fixture-vendor.test.js";
import { fakeProject, harness } from "./project-fake.test.js";
import { zipBytes } from "./zip-fixture.test.js";

registerFixtureVendor();

const SIGNAGE = path.resolve(fileURLToPath(new URL("../../fixtures/migrate/files/signage/", import.meta.url)));

async function setup() {
  const configDir = await testTemp("scan-cfg-");
  const cwd = await testTemp("scan-cwd-");
  const project = fakeProject();
  return { project, configDir, cwd, h: await harness(project, configDir, cwd), cleanup: () => Promise.all([rm(configDir, { recursive: true, force: true }), rm(cwd, { recursive: true, force: true })]) };
}

test("migrate vendors works offline, lists the systems sorted with files last, and describes each", async () => {
  const t = await setup();
  try {
    const all = await t.h.invoke(["migrate", "vendors"]);
    assert.equal(all.code, 0);
    const ids = all.json.data.vendors.map((vendor: { id: string }) => vendor.id);
    assert.equal(ids.at(-1), "files");
    assert.deepEqual(ids.slice(0, -1), [...ids.slice(0, -1)].sort());
    const files = all.json.data.vendors.find((vendor: { id: string }) => vendor.id === "files");
    assert.equal(files.name, "Files");
    assert.deepEqual(files.inputs.flags.map((flag: { flag: string }) => flag.flag), ["--timezone", "--files"]);
    assert.deepEqual(files.inputs.env, []);
    for (const field of ["connect", "maps", "skips", "docs"]) assert.ok(Array.isArray(files[field]) && files[field].length > 0, field);
    assert.match(files.example, /^screenrig migrate scan --from files --files /);
    const one = await t.h.invoke(["migrate", "vendors", "files"]);
    assert.equal(one.json.data.vendors.length, 1);
    const human = await t.h.invoke(["migrate", "vendors", "files", "--human"]);
    assert.match(human.stdout, /files: Files\n  takes: --timezone \(optional\), --files \(required\)/);
    const unknown = await t.h.invoke(["migrate", "vendors", "nope"]);
    assert.equal(unknown.code, 2);
    assert.equal(unknown.json.error.code, "usage_error");
    assert.match(unknown.json.error.detail, /The systems are .*files\./);
    assert.equal(t.project.transport.calls.length, 0, "no request reached screenRIG");
  } finally {
    await t.cleanup();
  }
});

test("migrate vendors needs no sign-in", async () => {
  const configDir = await testTemp("scan-nocfg-");
  const cwd = await testTemp("scan-nocwd-");
  try {
    const h = await harness(fakeProject(), configDir, cwd);
    await rm(path.join(configDir, "screenrig"), { recursive: true, force: true });
    const result = await h.invoke(["migrate", "vendors", "files"]);
    assert.equal(result.code, 0);
    assert.equal(result.json.ok, true);
  } finally {
    await rm(configDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("scan reads a folder, prints the report and writes scan.json (0600) in a 0700 directory, sending nothing to screenRIG", async () => {
  const t = await setup();
  try {
    const result = await t.h.invoke(["migrate", "scan", "--from", "files", "--files", SIGNAGE]);
    assert.equal(result.code, 0, result.stdout);
    const report = result.json.data;
    assert.equal(report.schema, "screenrig.migration-report/v1");
    assert.equal(report.vendor, "files");
    assert.deepEqual(report.found, { media: 4, playlists: 2, layouts: 0, schedules: 0, groups: 2, screens: 3 });
    assert.deepEqual(report.importable, { media: 4, playlists: 2, layouts: 0, schedules: 0, groups: 2, screens: 3 });
    assert.deepEqual(report.not_imported.map((entry: { source_id: string }) => entry.source_id), ["docs/readme.txt", "playlists.csv row 7"]);
    assert.ok(report.lossy.some((entry: { kind: string; change: string }) => entry.kind === "group" && entry.change === "The group is now the tag GroundFloor."));
    assert.ok(report.notes.some((note: string) => /No time zone was known for 2 screens/.test(note)));
    assert.ok(report.notes.some((note: string) => /1 screen has no default playlist/.test(note)));
    const dir = path.join(t.cwd, "screenrig-migration-files");
    assert.equal(report.dir, dir);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(dir, "scan.json"))).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(dir), ["scan.json"]);
    const scan = JSON.parse(await readFile(path.join(dir, "scan.json"), "utf8"));
    assert.equal(scan.schema, "screenrig.migration-scan/v1");
    assert.equal(scan.inputs.files, SIGNAGE);
    const { dir: _dir, scan_file: _file, ...reported } = report;
    assert.deepEqual(scan.report, reported, "scan.json holds the report that was printed");
    assert.equal(t.project.transport.calls.length, 0);
    const human = await t.h.invoke(["migrate", "scan", "--from", "files", "--files", SIGNAGE, "--dir", "again", "--human"]);
    assert.match(human.stdout, /Scan of signage \(files\)\nCan come over:\n {2}media: 4 of 4\n/);
    assert.match(human.stdout, /Cannot come over:\n {2}It is not an image, video or audio file\. \(1\): readme\.txt/);
    assert.match(human.stdout, /\nfull list: .*again\/scan\.json\n$/);
  } finally {
    await t.cleanup();
  }
});

test("scan reads a zip the same way", async () => {
  const t = await setup();
  try {
    const entries = [];
    for (const name of ["images/welcome.png", "images/menu.png", "video/intro.mp4", "audio/theme.mp3", "docs/readme.txt", "playlists.csv", "screens.csv"]) {
      entries.push({ name, data: await readFile(path.join(SIGNAGE, name)) });
    }
    const archive = path.join(t.cwd, "signage.zip");
    await writeFile(archive, zipBytes(entries));
    const folder = await t.h.invoke(["migrate", "scan", "--from", "files", "--files", SIGNAGE, "--dir", "folder"]);
    const zip = await t.h.invoke(["migrate", "scan", "--from", "files", "--files", archive, "--dir", "zip"]);
    assert.equal(zip.code, 0, zip.stdout);
    const { dir: _a, scan_file: _b, ...fromZip } = zip.json.data;
    const { dir: _c, scan_file: _d, ...fromFolder } = folder.json.data;
    assert.deepEqual({ ...fromZip, scanned_at: "", label: "" }, { ...fromFolder, scanned_at: "", label: "" });
    assert.equal(fromZip.label, "signage");
  } finally {
    await t.cleanup();
  }
});

test("a flag the system does not take, or a required one that is missing, is a usage error naming what it takes", async () => {
  const t = await setup();
  try {
    const url = await t.h.invoke(["migrate", "scan", "--from", "files", "--files", SIGNAGE, "--url", "https://cms.example.com"]);
    assert.equal(url.code, 2);
    assert.match(url.json.error.detail, /Files does not take --url\. Files takes --timezone ZONE \(optional\), --files PATH \(required\)/);
    const region = await t.h.invoke(["migrate", "scan", "--from", "files", "--files", SIGNAGE, "--region", "eu"]);
    assert.equal(region.json.error.code, "usage_error");
    const missing = await t.h.invoke(["migrate", "scan", "--from", "files"]);
    assert.equal(missing.code, 2);
    assert.match(missing.json.error.detail, /Files needs --files/);
    assert.equal(missing.json.error.next.command, "screenrig migrate vendors files");
    const zone = await t.h.invoke(["migrate", "scan", "--from", "files", "--files", SIGNAGE, "--timezone", "Mars/Olympus"]);
    assert.match(zone.json.error.detail, /IANA time zone/);
    const unknown = await t.h.invoke(["migrate", "scan", "--from", "nope", "--files", SIGNAGE]);
    assert.equal(unknown.code, 2);
    const absent = await t.h.invoke(["migrate", "scan", "--from", "files", "--files", path.join(t.cwd, "no-such-folder")]);
    assert.match(absent.json.error.detail, /--files names a path that does not exist/);
    await assert.rejects(stat(path.join(t.cwd, "screenrig-migration-files")), { code: "ENOENT" }, "a refused scan writes nothing");
  } finally {
    await t.cleanup();
  }
});

test("--timezone is recorded and ends the no-time-zone note", async () => {
  const t = await setup();
  try {
    const result = await t.h.invoke(["migrate", "scan", "--from", "files", "--files", SIGNAGE, "--timezone", "America/Vancouver"]);
    assert.equal(result.code, 0);
    assert.ok(!result.json.data.notes.some((note: string) => /No time zone/.test(note)));
    const scan = JSON.parse(await readFile(path.join(t.cwd, "screenrig-migration-files", "scan.json"), "utf8"));
    assert.equal(scan.inputs.timezone, "America/Vancouver");
  } finally {
    await t.cleanup();
  }
});

test("a new scan replaces scan.json and leaves the map; a map bound to another vendor or account refuses it", async () => {
  const t = await setup();
  try {
    await t.h.invoke(["migrate", "scan", "--from", "files", "--files", SIGNAGE]);
    const dir = path.join(t.cwd, "screenrig-migration-files");
    const map = { schema: "screenrig.migration-map/v1", api_url: "https://api.screenrig.ai", project_id: "prj_x", vendor: "files", account: "files", seed: "s".repeat(64), tags: {}, items: { "folder:root": { id: "mfd_keep" } }, failed: {} };
    await writeFile(path.join(dir, "map.json"), JSON.stringify(map));
    const again = await t.h.invoke(["migrate", "scan", "--from", "files", "--files", SIGNAGE]);
    assert.equal(again.code, 0);
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, "map.json"), "utf8")), map);
    await writeFile(path.join(dir, "map.json"), JSON.stringify({ ...map, vendor: "xibo" }));
    const other = await t.h.invoke(["migrate", "scan", "--from", "files", "--files", SIGNAGE]);
    assert.equal(other.code, 2);
    assert.equal(other.json.error.code, "migration_dir_mismatch");
    await writeFile(path.join(dir, "map.json"), JSON.stringify({ ...map, account: "https://other.example.com" }));
    assert.equal((await t.h.invoke(["migrate", "scan", "--from", "files", "--files", SIGNAGE])).json.error.code, "migration_dir_mismatch");
  } finally {
    await t.cleanup();
  }
});

test("scan against a vendor API: the key comes from the environment, files fill in originals, and a refused key is vendor_refused", async () => {
  const t = await setup();
  try {
    const router = fixtureRouter();
    const result = await t.h.invoke(["migrate", "scan", "--from", "fixture", "--url", FIXTURE_URL], { env: { FIXTURE_TOKEN }, vendorFetch: router.fetch });
    assert.equal(result.code, 0, result.stdout);
    const report = result.json.data;
    assert.deepEqual(report.found, { media: 3, playlists: 2, layouts: 1, schedules: 4, groups: 2, screens: 3 });
    assert.deepEqual(report.importable, { media: 3, playlists: 2, layouts: 1, schedules: 3, groups: 2, screens: 3 });
    assert.deepEqual(report.not_imported.map((entry: { kind: string; source_id: string; reason: string }) => [entry.kind, entry.source_id]), [["media", "3"], ["schedule", "sc3"]]);
    assert.match(report.not_imported[1].reason, /by the month/);
    assert.ok(router.requests.every((request) => request.authorization === `Bearer ${FIXTURE_TOKEN}`));
    const refused = await t.h.invoke(["migrate", "scan", "--from", "fixture", "--url", FIXTURE_URL, "--dir", "refused"], { env: { FIXTURE_TOKEN }, vendorFetch: fixtureRouter({ refuse: true }).fetch });
    assert.equal(refused.code, 3);
    assert.equal(refused.json.error.code, "vendor_refused");
    assert.match(refused.json.error.detail, /Check FIXTURE_TOKEN/);
    assert.ok(!refused.stdout.includes(FIXTURE_TOKEN), "the key is never echoed, even when the vendor quotes it");
    await assert.rejects(stat(path.join(t.cwd, "refused")), { code: "ENOENT" });
    const missing = await t.h.invoke(["migrate", "scan", "--from", "fixture", "--url", FIXTURE_URL, "--dir", "missing"], { vendorFetch: router.fetch });
    assert.equal(missing.code, 2);
    assert.match(missing.json.error.detail, /Fixture CMS needs FIXTURE_TOKEN in the environment, or in a file passed with --credentials FILE/);
  } finally {
    await t.cleanup();
  }
});
