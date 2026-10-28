import assert from "node:assert/strict";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { testTemp } from "../test-temp.js";
import { loadCredentials, parseCredentialFile, scrubSecrets } from "./credentials.js";
import { fixtureRouter, FIXTURE_TOKEN, FIXTURE_URL, registerFixtureVendor } from "./fixture-vendor.test.js";
import { createVendorHttp } from "./http.js";
import { openLocalFiles } from "./local-files.js";
import { fakeProject, harness } from "./project-fake.test.js";
import { resolveMedia, runScan } from "./scan.js";
import { MigrationDir } from "./state.js";
import type { SourceCatalog, VendorAdapter } from "./types.js";

registerFixtureVendor();

const adapter: Pick<VendorAdapter, "id" | "name" | "credentials"> = {
  id: "demo",
  name: "Demo CMS",
  credentials: [
    { env: "DEMO_ID", secret: false, required: true, help: "The client id." },
    { env: "DEMO_SECRET", secret: true, required: true, help: "The client secret." },
    { env: "DEMO_REGION", secret: false, required: false, help: "Optional." },
  ],
};

test("a credential file is NAME=VALUE lines with comments, quotes and an export prefix", () => {
  assert.deepEqual(parseCredentialFile("﻿# keys\nDEMO_ID=abc\r\nexport DEMO_SECRET = 'p ss=word' \nQUOTED=\"two words\"\n\nnot a pair\n=novalue\nEMPTY=\n"), {
    DEMO_ID: "abc", DEMO_SECRET: "p ss=word", QUOTED: "two words", EMPTY: "",
  });
});

test("with a file the values come from it alone; without one, from the environment; undeclared names are ignored", async () => {
  const file = await loadCredentials(adapter, { file: "keys.env", env: { DEMO_ID: "from-env", DEMO_SECRET: "from-env" }, read: async () => "DEMO_ID=from-file\nDEMO_SECRET=file-secret\nOTHER=x\n" });
  assert.deepEqual(file, { DEMO_ID: "from-file", DEMO_SECRET: "file-secret" });
  const env = await loadCredentials(adapter, { env: { DEMO_ID: "e1", DEMO_SECRET: "e2", DEMO_REGION: "eu", PATH: "/bin" } });
  assert.deepEqual(env, { DEMO_ID: "e1", DEMO_SECRET: "e2", DEMO_REGION: "eu" });
  // A file does not fall back to the environment for a name it lacks.
  await assert.rejects(loadCredentials(adapter, { file: "keys.env", env: { DEMO_SECRET: "from-env", DEMO_ID: "from-env" }, read: async () => "DEMO_ID=only\n" }), /DEMO_SECRET in the --credentials file/);
});

test("a missing required variable is named and its help given, never a value", async () => {
  const error = await loadCredentials(adapter, { env: { DEMO_ID: "visible-id" } }).catch((caught: unknown) => caught as { problem: { detail: string; code: string; next?: { command: string } } });
  const problem = (error as { problem: { detail: string; code: string; next?: { command: string } } }).problem;
  assert.equal(problem.code, "usage_error");
  assert.match(problem.detail, /Demo CMS needs DEMO_SECRET in the environment, or in a file passed with --credentials FILE\. The client secret\./);
  assert.ok(!problem.detail.includes("visible-id"));
  assert.equal(problem.next?.command, "screenrig migrate vendors demo");
  await assert.rejects(loadCredentials(adapter, { file: "x", env: {}, read: async () => { throw new Error("EACCES: /private/path/keys.env"); } }), (caught: unknown) => {
    const detail = (caught as { problem: { detail: string } }).problem.detail;
    assert.equal(detail, "Cannot read the --credentials file. It holds NAME=VALUE lines.");
    return true;
  });
});

test("scrubSecrets removes every value, however it is quoted", () => {
  assert.equal(scrubSecrets("bad key hunter2hunter2 and hunter2hunter2 again; other-secret-9", ["hunter2hunter2", "other-secret-9", "ab"]), "bad key [redacted] and [redacted] again; [redacted]");
  assert.equal(scrubSecrets("keep ab", ["ab"]), "keep ab", "values too short to be a key are left alone");
});

async function tree(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const item of await readdir(root, { withFileTypes: true })) {
    const full = path.join(root, item.name);
    if (item.isDirectory()) out.push(...await tree(full));
    else out.push(full);
  }
  return out;
}

test("the key appears in no envelope, report, error or file of the migration directory, even when the vendor or the adapter quotes it", async () => {
  const configDir = await testTemp("cred-cfg-");
  const cwd = await testTemp("cred-cwd-");
  try {
    const project = fakeProject();
    const h = await harness(project, configDir, cwd);
    const everything: string[] = [];
    const record = (result: { stdout: string; stderr: string }): void => {
      everything.push(result.stdout, result.stderr);
    };
    // Scan and apply with the key in a file.
    const keys = path.join(cwd, "fixture.env");
    await writeFile(keys, `FIXTURE_TOKEN=${FIXTURE_TOKEN}\n`);
    const scan = await h.invoke(["migrate", "scan", "--from", "fixture", "--url", FIXTURE_URL, "--dir", "mig", "--credentials", keys], { vendorFetch: fixtureRouter().fetch });
    record(scan);
    assert.equal(scan.code, 0, scan.stdout);
    const apply = await h.invoke(["migrate", "apply", "--dir", "mig", "--no-transcode", "--credentials", keys], { vendorFetch: fixtureRouter().fetch });
    record(apply);
    assert.equal(apply.code, 0, apply.stdout);
    // A vendor that refuses and quotes the key in its body.
    record(await h.invoke(["migrate", "scan", "--from", "fixture", "--url", FIXTURE_URL, "--dir", "refused", "--credentials", keys], { vendorFetch: fixtureRouter({ refuse: true }).fetch }));
    record(await h.invoke(["migrate", "apply", "--dir", "mig", "--dry-run", "--human"]));
    for (const text of everything) assert.ok(!text.includes(FIXTURE_TOKEN), "a command output holds the key");
    for (const file of await tree(path.join(cwd, "mig"))) assert.ok(!(await readFile(file, "utf8")).includes(FIXTURE_TOKEN), `${file} holds the key`);
    assert.ok(!JSON.stringify(project.transport.calls).includes(FIXTURE_TOKEN), "nothing sent to screenRIG holds the key");
    const operationLog = await tree(configDir);
    for (const file of operationLog) assert.ok(!(await readFile(file, "utf8")).includes(FIXTURE_TOKEN), `${file} holds the key`);
  } finally {
    await rm(configDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("an adapter that throws with the key in its message is scrubbed before the message is shown", async () => {
  const cwd = await testTemp("cred-throw-");
  try {
    const leaky: VendorAdapter = {
      id: "leaky", name: "Leaky CMS", inputs: {}, credentials: [{ env: "LEAKY_KEY", secret: true, required: true, help: "A key." }],
      connect: [], maps: [], skips: [], docs: [], example: "",
      async open(input) {
        return { scan: async () => { throw new Error(`request failed with Authorization: Bearer ${input.credentials.LEAKY_KEY}`); }, fetchMedia: async () => ({ bytes: 0 }) };
      },
    };
    const http = createVendorHttp({ vendor: "leaky", name: "Leaky CMS", credentialNames: [], fetch, sleep: async () => undefined, now: () => 0 });
    const dir = new MigrationDir(path.join(cwd, "mig"));
    await assert.rejects(
      runScan({ adapter: leaky, flags: {}, dir, env: { LEAKY_KEY: "super-secret-key-value" }, now: () => new Date(0), http }),
      (error: unknown) => {
        const detail = (error as { problem: { detail: string; code: string } }).problem.detail;
        assert.match(detail, /Authorization: Bearer \[redacted\]/);
        assert.ok(!detail.includes("super-secret-key-value"));
        return true;
      },
    );
    await assert.rejects(readFile(path.join(cwd, "mig", "scan.json")), { code: "ENOENT" });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// ---- where the bytes come from -----------------------------------------------------------------------

const SIGNAGE = path.resolve(fileURLToPath(new URL("../../fixtures/migrate/files/signage/", import.meta.url)));

function mediaCatalog(media: SourceCatalog["media"]): SourceCatalog {
  return { account: "a", label: "a", media, playlists: [], layouts: [], groups: [], screens: [], schedules: [], not_imported: [], notes: [] };
}

test("resolveMedia: the API's file wins, a derivative gives way to the same-name original, and the rest are listed with what to do", async () => {
  const files = await openLocalFiles(SIGNAGE);
  const png = (await readFile(path.join(SIGNAGE, "images", "welcome.png"))).length;
  const resolved = resolveMedia({ name: "Demo CMS" }, mediaCatalog([
    { id: "api", name: "Api", filename: "welcome.png", kind: "image", fetch: { n: 1 }, original: true },
    { id: "derived", name: "Derived", filename: "INTRO.MP4", kind: "video", fetch: { n: 2 }, original: false },
    { id: "derived-alone", name: "Derived alone", filename: "nothing.mp4", kind: "video", fetch: { n: 3 }, original: false },
    { id: "local", name: "Local", filename: "Menu.PNG", kind: "image", original: true },
    { id: "sized", name: "Sized", filename: "welcome.png", kind: "image", bytes: png, original: true },
    { id: "wrong-size", name: "Wrong size", filename: "welcome.png", kind: "image", bytes: png + 1, original: true },
    { id: "absent", name: "Absent", filename: "absent.png", kind: "image", original: true },
  ]), files);
  assert.deepEqual(resolved.media.map((item) => [item.id, item.local]), [
    ["api", undefined], ["derived", "video/intro.mp4"], ["derived-alone", undefined], ["local", "images/menu.png"], ["sized", "images/welcome.png"],
  ]);
  assert.deepEqual(resolved.notImported.map((entry) => [entry.source_id, entry.next]), [
    ["wrong-size", "Download welcome.png from Demo CMS into a folder and rerun migrate scan with --files DIR."],
    ["absent", "Download absent.png from Demo CMS into a folder and rerun migrate scan with --files DIR."],
  ]);
  assert.deepEqual(resolved.lossy.map((entry) => [entry.source_id, entry.change]), [
    ["derived-alone", "Only Demo CMS's re-encoded copy is available, not the original. Put the original in --files and rescan to import it instead."],
  ]);
  const without = resolveMedia({ name: "Demo CMS" }, mediaCatalog([{ id: "local", name: "Local", filename: "Menu.PNG", kind: "image", original: true }]), undefined);
  assert.equal(without.media.length, 0);
  assert.equal(without.notImported[0]!.reason, "Demo CMS does not hand out this file.");
});

test("resolveMedia: two files of the same name in --files make the media not_imported, naming the count", async () => {
  const dir = await testTemp("cred-dupe-");
  try {
    const bytes = await readFile(path.join(SIGNAGE, "images", "welcome.png"));
    await writeFile(path.join(dir, "a.png"), bytes);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.join(dir, "sub"));
    await writeFile(path.join(dir, "sub", "A.PNG"), bytes);
    const files = await openLocalFiles(dir);
    const resolved = resolveMedia({ name: "Demo CMS" }, mediaCatalog([{ id: "x", name: "X", filename: "a.png", kind: "image", original: true }]), files);
    assert.equal(resolved.media.length, 0);
    assert.equal(resolved.notImported[0]!.reason, "There are 2 files named a.png in --files.");
    assert.match(resolved.notImported[0]!.next ?? "", /rerun migrate scan/);
    assert.equal(files.match("Á.png").length, 0);
    assert.equal((await openLocalFiles(dir)).match("a.PNG", bytes.length).length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("file names match without regard to case or Unicode normal form", async () => {
  const dir = await testTemp("cred-nfc-");
  try {
    const bytes = await readFile(path.join(SIGNAGE, "images", "welcome.png"));
    await writeFile(path.join(dir, "Café.png"), bytes);
    const files = await openLocalFiles(dir);
    assert.equal(files.match("café.PNG").length, 1, "the decomposed spelling finds the composed file");
    assert.equal(files.match("Café.png").length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
