import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, open, readFile, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { test } from "node:test";
import { writeConfigAtomic } from "./config.js";
import { run } from "./main.js";
import { FakeTransport } from "./transport/fake.js";

test("project export pages K/V, reports unread state and application files, and refreshes its manifest", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "screenrig-export-command-"));
  const fs = { mkdir, open, rename, rm, chmod, stat, homedir: () => directory, env: { XDG_CONFIG_HOME: directory } };
  try {
    await writeConfigAtomic(path.join(directory, "screenrig", "config.json"), {
      api_url: "https://api.screenrig.ai", token: "eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.signature_existing_secret",
    }, fs);
    let applications: Array<{ id: string; latest_ready_release: string }> = [{ id: "app_1", latest_ready_release: "rel_2" }];
    const values = Array.from({ length: 201 }, (_, index) => {
      const value = Buffer.from(`Value ${index} — 日本語`);
      return { application_id: "app_1", key: index === 200 ? "menu/title" : `item${String(index).padStart(3, "0")}`,
        value_base64: value.toString("base64"), content_type: "text/plain", bytes: value.length,
        sha256: createHash("sha256").update(value).digest("hex"), revision: index + 1 };
    });
    let kvDenied = false;
    const transport = new FakeTransport()
      .on("GET", /^\/api\/applications\/app_1\/kv(?:\/|$)/, (request) => {
        if (kvDenied && request.query?.after) return { status: 403, headers: {}, body: { code: "forbidden", title: "Forbidden", status: 403, detail: "Application state could not be read" } };
        if (request.path.endsWith("/kv")) {
          const page = request.query?.after ? values.slice(200) : values.slice(0, 200);
          return { status: 200, headers: {}, body: {
            items: page.map(({ value_base64: _value, ...summary }) => summary),
            next_cursor: request.query?.after ? null : values[199]!.key,
          } };
        }
        const key = decodeURIComponent(request.path.slice("/api/applications/app_1/kv/".length));
        return { status: 200, headers: {}, body: values.find((entry) => entry.key === key) };
      })
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
      assert.deepEqual(JSON.parse(await readFile(path.join(directory, "export", "applications/app_1/kv.json"), "utf8")), values,
        "every entry beyond the 200-row first page retains its value and metadata");
    }
    assert.equal(transport.calls.filter((request) => request.path === "/api/applications/app_1/kv" && request.query?.after === values[199]!.key).length, 2);
    assert.ok(transport.calls.some((request) => request.path === "/api/applications/app_1/kv/menu%2Ftitle"));
    kvDenied = true;
    let deniedOutput = "";
    const deniedStdout = new Writable({ write(chunk, _encoding, done) { deniedOutput += chunk; done(); } });
    const deniedStderr = new Writable({ write(_chunk, _encoding, done) { done(); } });
    assert.equal(await run({
      argv: ["--json", "project", "export", "export", "--no-media"],
      env: fs.env, stdout: deniedStdout, stderr: deniedStderr, fs, transport, homedir: fs.homedir, cwd: () => directory,
      now: () => new Date("2026-10-29T12:00:00Z"), sleep: async () => undefined,
    }), 0);
    deniedStdout.end();
    deniedStderr.end();
    const denied = JSON.parse(deniedOutput);
    assert.equal(denied.data.complete, false);
    assert.equal(denied.data.sections.find((section: { name: string }) => section.name === "applications").status, "failed");
    assert.ok(denied.warnings.some((warning: { code: string; message: string }) => warning.code === "export_section_failed" && warning.message.startsWith("applications:")));
    const deniedManifest = JSON.parse(await readFile(path.join(directory, "export", "export.json"), "utf8"));
    assert.equal(deniedManifest.files.some((file: { path: string }) => file.path === "applications/app_1/kv.json"), false,
      "failure on a continuation page never certifies a partial or stale K/V file");
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
