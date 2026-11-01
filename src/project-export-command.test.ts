import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, open, readFile, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { test } from "node:test";
import { writeConfigAtomic } from "./config.js";
import { run } from "./main.js";
import { FakeTransport } from "./transport/fake.js";

test("project export reports application omissions in JSON and human output and clears them on refresh", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "screenrig-export-command-"));
  const fs = { mkdir, open, rename, rm, chmod, stat, homedir: () => directory, env: { XDG_CONFIG_HOME: directory } };
  try {
    await writeConfigAtomic(path.join(directory, "screenrig", "config.json"), {
      api_url: "https://api.screenrig.ai", token: "eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.signature_existing_secret",
    }, fs);
    let applications: Array<{ id: string; latest_ready_release: string }> = [{ id: "app_1", latest_ready_release: "rel_2" }];
    const transport = new FakeTransport()
      .on("GET", /^\/api\//, (request) => ({ status: 200, headers: {}, body: request.path.endsWith("/project")
        ? { id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", name: "Screens", organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization", created_at: "2026-10-29T00:00:00Z" }
        : { items: request.path.endsWith("/applications") ? applications : [], next_cursor: null } }))
      .onDownload("GET", /^\/api\//, () => ({ status: 200, headers: { "content-type": "text/csv" }, body: (async function* () { yield Buffer.from("column\nvalue\n"); })() }));
    for (const human of [false, true]) {
      let output = "";
      const stdout = new Writable({ write(chunk, _encoding, done) { output += chunk; done(); } });
      const stderr = new Writable({ write(_chunk, _encoding, done) { done(); } });
      const code = await run({
        argv: [human ? "--human" : "--json", "project", "export", "export", "--no-media"],
        env: fs.env, stdout, stderr, fs, transport, homedir: fs.homedir, cwd: () => directory,
        now: () => new Date("2026-10-29T12:00:00Z"), sleep: async () => undefined,
      });
      stdout.end();
      stderr.end();
      assert.equal(code, 0, output);
      if (human) {
        assert.match(output, /failed: application files/);
        assert.match(output, /original application archives/);
        assert.doesNotMatch(output, /Run the same command again to continue/);
      } else {
        const envelope = JSON.parse(output);
        assert.equal(envelope.ok, true);
        assert.equal(envelope.data.complete, false);
        assert.deepEqual(envelope.warnings.map((warning: { code: string }) => warning.code), ["export_application_content_omitted"]);
        assert.match(envelope.warnings[0].message, /playlist-pinned releases/);
      }
    }
    applications = [];
    let output = "";
    const stdout = new Writable({ write(chunk, _encoding, done) { output += chunk; done(); } });
    const stderr = new Writable({ write(_chunk, _encoding, done) { done(); } });
    assert.equal(await run({
      argv: ["--json", "project", "export", "export", "--no-media"],
      env: fs.env, stdout, stderr, fs, transport, homedir: fs.homedir, cwd: () => directory,
      now: () => new Date("2026-10-29T12:00:00Z"), sleep: async () => undefined,
    }), 0);
    stdout.end();
    stderr.end();
    const envelope = JSON.parse(output);
    assert.equal(envelope.data.complete, true, output);
    assert.deepEqual(envelope.warnings, []);
    const manifest = JSON.parse(await readFile(path.join(directory, "export", "export.json"), "utf8"));
    assert.equal(manifest.sections.some((section: { status: string }) => section.status === "failed"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
