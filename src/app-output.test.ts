import assert from "node:assert/strict";
import { chmod, mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import { test } from "node:test";
import { writeConfigAtomic } from "./config.js";
import { run } from "./main.js";
import { testTemp } from "./test-temp.js";
import { memoryBackend } from "./transport/fake.js";

for (const action of ["upload", "update"] as const) {
  test(`app ${action} keeps canonical and compatibility output paths across waiting modes`, async (t) => {
    const configDir = await testTemp("app-output-");
    t.after(() => rm(configDir, { recursive: true, force: true }));
    const fs = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
    await writeConfigAtomic(path.join(configDir, "screenrig", "config.json"), {
      api_url: "https://api.screenrig.ai", token: "sr_live_existing_secret",
    }, fs);
    const appDir = path.join(configDir, "app");
    await mkdir(appDir);
    await writeFile(path.join(appDir, "index.html"), "<!doctype html><html><head></head><body>hello</body></html>");
    const results = [];
    for (const noWait of [false, true]) {
      const transport = memoryBackend();
      if (action === "update") {
        transport.on("POST", "/api/v1/applications/app_EXISTING/releases", (request) => {
          assert.equal(request.headers?.["if-match"], '"7"');
          return { status: 202, headers: {}, body: {
            id: "app_EXISTING", release_id: "rel_NEW", operation_id: "op_NEW",
          } };
        });
      }
      let output = "";
      const stdout = new Writable({ write(chunk, _encoding, callback) { output += chunk; callback(); } });
      const stderr = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
      const argv = ["--json", "app", action,
        ...(action === "update" ? ["app_EXISTING", appDir, "--if-match", "7"] : [appDir]),
        ...(noWait ? ["--no-wait"] : ["--poll-ms", "1"]),
      ];
      const code = await run({
        argv, env: fs.env, stdout, stderr, fs, homedir: fs.homedir,
        cwd: () => configDir, transport,
        now: () => new Date("2026-09-10T00:00:00Z"), sleep: async () => undefined,
      });
      stdout.end();
      stderr.end();
      assert.equal(code, 0, output);
      const envelope = JSON.parse(output);
      const data = envelope.data;
      const expectedId = action === "update" ? "app_EXISTING" : "app_AAAAAAAAAAAAAAAAAAAAAAAA";
      const expectedRelease = action === "update" ? "rel_NEW" : "rel_AAAAAAAAAAAAAAAAAAAAAAAA";
      assert.equal(data.application.id, expectedId);
      assert.equal(data.application.release_id, expectedRelease);
      assert.equal(data.id, data.application.id);
      assert.equal(data.release_id, data.application.release_id);
      assert.equal(data.operation_id, data.application.operation_id);
      assert.equal(envelope.operation_id, data.application.operation_id);
      assert.equal(data.sha256, data.pack.sha256);
      assert.match(data.pack.sha256, /^[a-f0-9]{64}$/);
      assert.ok(data.pack.file_count > 0);
      const polls = transport.calls.filter((call) => call.path.startsWith("/api/v1/operations/"));
      if (noWait) {
        assert.equal(data.operation, null);
        assert.equal(polls.length, 0, "no-wait must not poll to manufacture operation state");
      } else {
        assert.equal(data.operation.id, envelope.operation_id);
        assert.equal(data.operation.state, "succeeded");
        assert.ok(polls.length > 0);
      }
      results.push(data);
    }
    assert.deepEqual(results[0].application, results[1].application);
    assert.deepEqual(results[0].pack, results[1].pack);
    assert.deepEqual(Object.keys(results[0]).sort(), Object.keys(results[1]).sort());
  });
}
