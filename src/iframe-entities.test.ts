import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { test, type TestContext } from "node:test";
import { processRuntime, run } from "./main.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport } from "./transport/fake.js";

function playlist(key: "src" | "fallback_src", address: string) {
  return { name: "Entity decoding", pages: [{
    id: "page", canvas: { width: 320, height: 180, background: "#000000FF" },
    transition: { type: "crossfade", duration_ms: 200 }, advance: { mode: "duration", after_ms: 8000 },
    primitives: [{ id: "frame", primitive: "iframe", title: "Board", layer: 0, content_fit: "fill",
      rect: { x: 0, y: 0, width: 320, height: 180 }, src: "http://example.com/", [key]: `<iframe src="${address}"></iframe>` }],
  }] };
}

async function author(t: TestContext) {
  const directory = await testTemp("iframe-entities-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = path.join(directory, "config.json");
  await writeFile(config, JSON.stringify({ api_url: "https://api.screenrig.ai", project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA",
    project_name: "Screens", organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization", token: "test-token" }), { mode: 0o600 });
  return async (command: string, input: string, document: unknown) => {
    const text = JSON.stringify(document);
    await writeFile(path.join(directory, "playlist.json"), text);
    const transport = new FakeTransport().on("POST", "/api/playlists", request => ({
      status: 201, headers: {}, body: { ...(request.body as object), id: "pl_ENTITY", revision: 1 },
    }));
    let output = "";
    const code = await run({ ...processRuntime(), argv: ["--config", config, "--json", "playlist", command, input],
      cwd: () => directory, env: {}, transport, stdin: Readable.from([text]), isStdinTty: () => false,
      stdout: new Writable({ write(chunk, _encoding, done) { output += chunk; done(); } }),
      stderr: new Writable({ write(_chunk, _encoding, done) { done(); } }),
    });
    return { code, output, calls: transport.calls };
  };
}

test("file and stdin validation and creation accept server-supported iframe entities in both sources", async t => {
  const invoke = await author(t);
  for (const prefix of ["http:&sol;&sol;", "http&colon;//", "http&#58//", "http&#x3a//", "http&#58;//", "http://"]) {
    for (const key of ["src", "fallback_src"] as const) {
      const document = playlist(key, `${prefix}example.com/`);
      for (const input of ["playlist.json", "-"]) {
        const validated = await invoke("validate", input, document);
        assert.equal(validated.code, 0, `${key} ${prefix} ${input}: ${validated.output}`);
        assert.deepEqual(validated.calls, [], "offline validation makes no HTTP request");
        const created = await invoke("create", input, document);
        assert.equal(created.code, 0, `${key} ${prefix} ${input}: ${created.output}`);
        assert.deepEqual(created.calls.map(call => [call.method, call.path]), [["POST", "/api/playlists"]]);
        assert.deepEqual(created.calls[0]!.body, document, "the server receives the authored embed unchanged");
      }
    }
  }
});

test("encoded non-HTTP iframe schemes are refused before creation", async t => {
  const invoke = await author(t);
  for (const address of ["javascript&colon;alert(1)", "ftp&#58//example.com/"]) {
    for (const key of ["src", "fallback_src"] as const) {
      for (const input of ["playlist.json", "-"]) {
        for (const command of ["validate", "create"]) {
          const result = await invoke(command, input, playlist(key, address));
          assert.equal(result.code, 2, result.output);
          const error = JSON.parse(result.output).error;
          assert.equal(error.code, "usage_error");
          if (command === "validate") assert.equal(error.errors[0].path, `/pages/0/primitives/0/${key}`);
          assert.deepEqual(result.calls, [], "a refused embed is never sent");
        }
      }
    }
  }
});
