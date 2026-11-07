import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify, type KeyObject } from "node:crypto";
import { renameSync, symlinkSync } from "node:fs";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { ExitCode } from "./exit-codes.js";
import { run } from "./main.js";
import type { SignedRawPut } from "./runtime.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport } from "./transport/fake.js";
import type { TransportRequest, TransportResponse } from "./transport/types.js";

const API = "https://api.screenrig.ai";
const NOW = new Date();
const PROJECT = "prj_AAAAAAAAAAAAAAAAAAAAAAAA";
const CLIENT = "scl_AAAAAAAAAAAAAAAAAAAAAAAA";
const SECRET = "sr_cs_never_printed_secret_value_0123456789abcdef";

type JWK = Record<string, string>;

/** RFC 7638, written out here so the test does not share the CLI's code. */
function thumbprint(jwk: JWK): string {
  const members = jwk.kty === "RSA" ? ["e", "kty", "n"] : jwk.kty === "EC" ? ["crv", "kty", "x", "y"] : ["crv", "kty", "x"];
  return createHash("sha256").update(`{${members.map((name) => `"${name}":"${jwk[name]}"`).join(",")}}`).digest("base64url");
}

function decodePart(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

function serviceToken(scope = "access:manage screens content"): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "EdDSA", typ: "at+jwt" })}.${part({ sub: `client:${CLIENT}`, client_id: CLIENT, prj: PROJECT, scope, exp: Math.floor(NOW.getTime() / 1000) + 900, jti: `j${Math.random()}` })}.${"c2lnbmF0dXJl".repeat(4)}`;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): TransportResponse {
  return { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers }, body };
}

function form(req: TransportRequest): URLSearchParams {
  return new URLSearchParams(String(req.body));
}

function server(onToken: (req: TransportRequest) => TransportResponse, projectResponse = json(200, { id: PROJECT, name: "Screens", organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization", revision: 1, status: "active" })): FakeTransport {
  return new FakeTransport()
    .on("GET", "/.well-known/oauth-authorization-server", () => json(200, {
      issuer: API, token_endpoint: `${API}/oauth/token`, revocation_endpoint: `${API}/oauth/revoke`,
      token_endpoint_auth_methods_supported: ["none", "private_key_jwt", "client_secret_basic"],
    }))
    .on("POST", "/oauth/token", onToken)
    .on("GET", "/api/project", () => projectResponse);
}

async function cli(dir: string, argv: string[], transport: FakeTransport, signedRawPut?: SignedRawPut) {
  const fs: ConfigFs = { mkdir, open, rename, rm, chmod, stat, homedir: () => dir, settings: { XDG_CONFIG_HOME: dir } };
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  stdout.on("data", (chunk) => out.push(Buffer.from(chunk)));
  stderr.on("data", (chunk) => err.push(Buffer.from(chunk)));
  const code = await run({ argv, settings: fs.settings, stdout, stderr, now: () => NOW, sleep: async () => undefined, homedir: () => dir, cwd: () => dir, fs, transport, signedRawPut });
  return { code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), fs };
}

/** Save the service client in dir's default config with login --client-id; nothing is sent. */
async function saveClient(dir: string, credential: { secretFile: string } | { keyFile: string }): Promise<void> {
  const transport = new FakeTransport();
  const flag = "secretFile" in credential ? ["--client-secret-file", credential.secretFile] : ["--client-key-file", credential.keyFile];
  const result = await cli(dir, ["--json", "login", "--client-id", CLIENT, ...flag], transport);
  assert.equal(result.code, 0, result.stdout);
  assert.ok(!result.stdout.includes(SECRET) && !result.stderr.includes(SECRET));
  assert.equal(transport.calls.length + transport.oauthCalls.length, 0, "saving a service client sends nothing");
}

async function writeSecret(dir: string): Promise<string> {
  const file = path.join(dir, "client-secret.txt");
  await writeFile(file, `${SECRET}\n`, { mode: 0o600 });
  return file;
}

const UPLOADER_PLAYLIST = "pl_AAAAAAAAAAAAAAAAAAAAAAAA";
const UPLOADER_MEDIA = "med_AAAAAAAAAAAAAAAAAAAAAAAA";
const UPLOADER_FOLDER = "mfd_AAAAAAAAAAAAAAAAAAAAAAAA";
const uploadScope = { playlist_ids: [UPLOADER_PLAYLIST], folder_ids: [UPLOADER_FOLDER], access: "propose" };
const outsideUploadScope = json(403, { status: 403, title: "Outside upload scope", errors: [{ code: "outside_upload_scope", detail: "This request is outside the uploader's scope.", upload_scope: uploadScope }] });

for (const method of ["key", "secret"] as const) {
  test(`a scoped uploader using a ${method} can read, upload and propose pages without project display access`, async t => {
    const dir = await testTemp("service-uploader-");
    t.after(() => rm(dir, { recursive: true, force: true }));
    if (method === "key") {
      const keyFile = path.join(dir, "client.jwk");
      await writeFile(keyFile, JSON.stringify(generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" })), { mode: 0o600 });
      await saveClient(dir, { keyFile });
    } else {
      await saveClient(dir, { secretFile: await writeSecret(dir) });
    }
    const configPath = path.join(dir, "screenrig", "config.json");
    const before = await readFile(configPath, "utf8");
    const imageFile = path.join(dir, "poster.png");
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ioAAAAASUVORK5CYII=", "base64");
    await writeFile(imageFile, bytes);
    const token = serviceToken("access:propose content playlists");
    const transport = server(() => json(200, { access_token: token, token_type: "Bearer", expires_in: 900 }), outsideUploadScope);
    const page = { id: "regular", canvas: { width: 1920, height: 1080, background: "#000000FF" },
      transition: { type: "crossfade", duration_ms: 600 }, advance: { mode: "duration", after_ms: 10000 },
      primitives: [{ id: "media", primitive: "image", selector: { by: "id", media_id: UPLOADER_MEDIA }, rect: { x: 0, y: 0, width: 1920, height: 1080 }, layer: 0, content_fit: "contain" }] };
    const playlist = { id: UPLOADER_PLAYLIST, name: "Menu", revision: 7, pages: [page] };
    const media = { id: UPLOADER_MEDIA, filename: "poster.png", primitive: "image", folder_id: UPLOADER_FOLDER };
    const pending = { status: "pending_review", review: { id: "rvw_TEST", state: "pending", kind: "playlist_change", subject: { id: UPLOADER_PLAYLIST, type: "playlist", name: "Menu" }, url: "https://screenrig.ai/dashboard/reviews/rvw_TEST" } };
    const operation = { id: "op_UPLOAD", kind: "media.upload", state: "queued", created_at: NOW.toISOString(), updated_at: NOW.toISOString() };
    transport
      .on("GET", "/api/playlists", () => json(200, { items: [playlist], next_cursor: null }))
      .on("GET", `/api/playlists/${UPLOADER_PLAYLIST}`, () => json(200, playlist))
      .on("GET", "/api/reviews", () => json(200, { items: [], next_cursor: null, pending_count: 0 }))
      .on("GET", `/api/media/${UPLOADER_MEDIA}`, () => json(200, media))
      .on("GET", `/api/media-folders/${UPLOADER_FOLDER}`, () => json(200, { id: UPLOADER_FOLDER, name: "Menu" }))
      .on("GET", "/api/media", request => {
        assert.equal(request.query?.folder, UPLOADER_FOLDER);
        return json(200, { items: [media], next_cursor: null });
      })
      .on("PUT", `/api/playlists/${UPLOADER_PLAYLIST}/pages/regular`, request => {
        assert.equal(request.headers?.["if-match"], '"7"');
        assert.deepEqual(request.body, page);
        return json(202, pending);
      })
      .on("POST", `/api/playlists/${UPLOADER_PLAYLIST}/pages`, request => {
        assert.deepEqual(request.body, { page: { ...page, id: "lunch" } });
        return json(202, pending);
      })
      .on("POST", "/api/media/uploads", request => {
        assert.equal((request.body as { folder_id?: string }).folder_id, UPLOADER_FOLDER);
        return json(201, { id: "upload_TEST", operation, method: "PUT", upload_url: "https://storage.example.invalid/upload",
          headers: { "content-type": "image/png" }, expires_at: "2099-01-01T00:00:00Z" }, { "cache-control": "private, no-store" });
      })
      .on("POST", "/api/media/uploads/upload_TEST/commit", () => json(202, operation))
      .on("GET", "/api/playlists/pl_BBBBBBBBBBBBBBBBBBBBBBBB", () => outsideUploadScope)
      .on("GET", "/api/screens", () => outsideUploadScope);
    let puts = 0;
    const signedPut: SignedRawPut = async request => {
      puts += 1;
      assert.deepEqual(request.body, bytes);
      return { status: 200 };
    };
    const commands = [
      ["playlist", "list"], ["playlist", "show", UPLOADER_PLAYLIST], ["media", "show", UPLOADER_MEDIA],
      ["media", "list", "--folder", UPLOADER_FOLDER],
      ["playlist", "page", "replace", UPLOADER_PLAYLIST, "regular", "--media", UPLOADER_MEDIA],
      ["playlist", "page", "add", UPLOADER_PLAYLIST, "--page-id", "lunch", "--media", UPLOADER_MEDIA],
      ["media", "upload", imageFile, "--folder", UPLOADER_FOLDER, "--no-transcode", "--no-wait"],
    ];
    for (const command of commands) {
      const result = await cli(dir, ["--json", ...command], transport, signedPut);
      assert.equal(result.code, ExitCode.Success, result.stdout);
      const envelope = JSON.parse(result.stdout);
      assert.equal(envelope.context, undefined, "no display names are invented or borrowed");
      if (command[1] === "page") assert.equal(envelope.data.status, "pending_review");
    }
    assert.equal(puts, 1);
    assert.equal(transport.calls.filter(call => call.path === "/api/media/uploads/upload_TEST/commit").length, 1);
    for (const command of [["playlist", "show", "pl_BBBBBBBBBBBBBBBBBBBBBBBB"], ["screen", "list"], ["project", "show"]]) {
      const result = await cli(dir, ["--json", ...command], transport);
      assert.equal(result.code, ExitCode.Auth, result.stdout);
      assert.equal(JSON.parse(result.stdout).error.code, "outside_upload_scope", "the requested operation's refusal is retained");
    }
    const calls = transport.calls.length;
    const mismatch = await cli(dir, ["--project-id", "prj_BBBBBBBBBBBBBBBBBBBBBBBB", "playlist", "list"], transport);
    assert.equal(JSON.parse(mismatch.stdout).error.code, "config_error");
    assert.equal(transport.calls.length, calls, "a mismatched project never reaches the API");
    assert.ok(transport.calls.every(call => call.headers?.authorization === `Bearer ${token}`));
    assert.equal(await readFile(configPath, "utf8"), before, "credentials and project state stay out of the saved config");
  });
}

test("a service client's unrelated project-context failures still stop before its requested operation", async t => {
  const dir = await testTemp("service-context-refusal-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  await saveClient(dir, { secretFile: await writeSecret(dir) });
  for (const [status, code] of [[403, "insufficient_access"], [500, "internal_error"], [500, "outside_upload_scope"]] as const) {
    const transport = server(() => json(200, { access_token: serviceToken(), token_type: "Bearer", expires_in: 900 }),
      json(status, { status, code, title: "Refused", detail: "Project context unavailable." }));
    const result = await cli(dir, ["playlist", "list"], transport);
    assert.notEqual(result.code, ExitCode.Success);
    assert.equal(JSON.parse(result.stdout).error.code, code);
    assert.ok(transport.calls.every(call => call.path === "/api/project"));
  }
});

test("login --client-id saves the client and its secret file in the config; the secret itself is never stored", async () => {
  const dir = await testTemp("service-save-");
  try {
    const secretFile = await writeSecret(dir);
    await saveClient(dir, { secretFile });
    const config = JSON.parse(await readFile(path.join(dir, "screenrig", "config.json"), "utf8")) as Record<string, unknown>;
    assert.deepEqual(config.service_client, { client_id: CLIENT, secret_file: secretFile });
    assert.ok(!JSON.stringify(config).includes(SECRET));
    assert.equal((await stat(path.join(dir, "screenrig", "config.json"))).mode & 0o777, 0o600);
    const logout = await cli(dir, ["--json", "logout"], new FakeTransport());
    assert.equal(logout.code, 0, logout.stdout);
    assert.equal(JSON.parse(logout.stdout).data.service_client_id, CLIENT);
    const after = JSON.parse(await readFile(path.join(dir, "screenrig", "config.json"), "utf8")) as Record<string, unknown>;
    assert.equal(after.service_client, undefined);
    assert.equal(await readFile(secretFile, "utf8"), `${SECRET}\n`, "logout leaves the secret file");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a saved client secret signs in with HTTP Basic, keeps its token in memory and never writes the config", async () => {
  const dir = await testTemp("service-secret-");
  const configPath = path.join(dir, "screenrig", "config.json");
  try {
    await saveClient(dir, { secretFile: await writeSecret(dir) });
    const before = await readFile(configPath, "utf8");
    const beforeStat = await stat(configPath);
    let minted = 0;
    const token = serviceToken();
    const transport = server((req) => {
      minted += 1;
      const body = form(req);
      assert.equal(body.get("grant_type"), "client_credentials");
      assert.equal(body.get("client_secret"), null, "a secret never travels in the body");
      // RFC 6749 §2.3.1: both parts are form-urlencoded inside Basic; the server decodes them.
      const [id, secret] = Buffer.from((req.headers?.authorization ?? "").replace(/^Basic /, ""), "base64").toString("utf8").split(":");
      assert.deepEqual([decodeURIComponent(id!), decodeURIComponent(secret!)], [CLIENT, SECRET]);
      return json(200, { access_token: token, token_type: "Bearer", expires_in: 900, scope: "access:manage screens content" });
    });
    const result = await cli(dir, ["--json", "project", "show"], transport);
    assert.equal(result.code, 0, result.stdout);
    assert.equal(minted, 1);
    assert.equal(transport.calls[0]?.headers?.authorization, `Bearer ${token}`);
    assert.ok(!result.stdout.includes(SECRET) && !result.stderr.includes(SECRET) && !result.stdout.includes("eyJ"));
    assert.equal(await readFile(configPath, "utf8"), before);
    assert.equal((await stat(configPath)).mtimeMs, beforeStat.mtimeMs);
    assert.deepEqual((await readdirSafe(path.join(dir, "screenrig"))).sort(), ["config.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function readdirSafe(dir: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  return readdir(dir).catch(() => []);
}

test("a saved key file signs an assertion that meets the server's rules", async () => {
  for (const [type, options, alg] of [
    ["ed25519", {}, "EdDSA"],
    ["ec", { namedCurve: "P-256" }, "ES256"],
    ["rsa", { modulusLength: 2048 }, "RS256"],
  ] as const) {
    const dir = await testTemp("service-key-");
    try {
      const { privateKey, publicKey } = generateKeyPairSync(type as "ed25519", options as never) as unknown as { privateKey: KeyObject; publicKey: KeyObject };
      const privateJwk = privateKey.export({ format: "jwk" }) as JWK;
      const publicJwk = publicKey.export({ format: "jwk" }) as JWK;
      const keyFile = path.join(dir, "client.jwk");
      await writeFile(keyFile, JSON.stringify(privateJwk), { mode: 0o600 });
      await saveClient(dir, { keyFile });
      const kid = thumbprint(publicJwk);
      let checked = false;
      const transport = server((req) => {
        const body = form(req);
        assert.equal(body.get("grant_type"), "client_credentials");
        assert.equal(body.get("client_id"), CLIENT);
        assert.equal(body.get("client_assertion_type"), "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
        assert.equal(req.headers?.authorization, undefined);
        const assertion = body.get("client_assertion")!;
        const header = decodePart(assertion.split(".")[0]!);
        assert.equal(header.alg, alg);
        assert.equal(header.kid, kid);
        for (const name of ["jku", "x5u", "jwk", "x5c"]) assert.equal((header as Record<string, unknown>)[name], undefined);
        checked = true;
        return json(200, { access_token: serviceToken(), token_type: "Bearer", expires_in: 900 });
      });
      const result = await cli(dir, ["--json", "project", "show"], transport);
      assert.equal(result.code, 0, result.stdout);
      assert.ok(checked);
      const assertion = form(transport.oauthCalls.find((call) => call.path === "/oauth/token")!).get("client_assertion")!;
      const [head, body, signature] = assertion.split(".") as [string, string, string];
      const data = Buffer.from(`${head}.${body}`);
      const proof = Buffer.from(signature, "base64url");
      const valid = alg === "EdDSA" ? verify(null, data, publicKey, proof)
        : alg === "ES256" ? verify("sha256", data, { key: publicKey, dsaEncoding: "ieee-p1363" }, proof)
          : verify("sha256", data, publicKey, proof);
      assert.ok(valid, `${alg} signature verifies with the registered public key`);
      const payload = decodePart(body) as { iss: string; sub: string; aud: unknown; jti: string; iat: number; exp: number };
      assert.deepEqual([payload.iss, payload.sub, payload.aud], [CLIENT, CLIENT, API], "iss = sub = client_id; aud is the issuer as one string");
      assert.ok(payload.jti && payload.iat <= Math.floor(Date.now() / 1000) + 1);
      assert.ok(payload.exp - payload.iat <= 300 && payload.exp > payload.iat);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("a refused service token is minted again once; there is no refresh token", async () => {
  const dir = await testTemp("service-renew-");
  try {
    await saveClient(dir, { secretFile: await writeSecret(dir) });
    let minted = 0;
    let refuse = true;
    const transport = server(() => { minted += 1; return json(200, { access_token: serviceToken(), token_type: "Bearer", expires_in: 900 }); });
    transport.on("GET", "/api/screens", () => {
      if (refuse) {
        refuse = false;
        return { status: 401, headers: { "www-authenticate": 'Bearer error="invalid_token"', "content-type": "application/problem+json" }, body: { status: 401, code: "unauthorized", title: "Unauthorized", detail: "expired" } };
      }
      return json(200, { items: [], next_cursor: null });
    });
    const result = await cli(dir, ["--json", "screen", "list"], transport);
    assert.equal(result.code, 0, result.stdout);
    assert.equal(minted, 2);
    assert.ok(transport.oauthCalls.every((call) => form(call).get("grant_type") !== "refresh_token"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a service client's config refuses agent commands, and login --client-id refuses bad input, before any request", async () => {
  const dir = await testTemp("service-refuse-");
  try {
    const transport = new FakeTransport();
    const secretFile = await writeSecret(dir);
    for (const argv of [["login", "--client-id", "not-a-client", "--client-secret-file", secretFile], ["login", "--client-id", CLIENT],
      ["login", "--client-id", CLIENT, "--client-secret-file", secretFile, "--client-key-file", secretFile],
      ["login", "--client-id", CLIENT, "--client-secret-file", secretFile, "--access", "read"]]) {
      const result = await cli(dir, ["--json", ...argv], transport);
      assert.equal(result.code, ExitCode.Usage, argv.join(" "));
    }
    for (const argv of [["login", "--client-id", CLIENT, "--client-key-file", path.join(dir, "missing.pem")], ["login", "--client-id", CLIENT, "--client-key-file", secretFile]]) {
      const result = await cli(dir, ["--json", ...argv], transport);
      assert.equal(result.code, ExitCode.Config, argv.join(" "));
    }
    await saveClient(dir, { secretFile });
    for (const argv of [["agent", "enroll", "--email", "a@example.com", "--organization", "X"], ["project", "token"]]) {
      const result = await cli(dir, ["--json", ...argv], transport);
      assert.equal(result.code, ExitCode.Usage, argv.join(" "));
    }
    await rm(secretFile);
    const missing = await cli(dir, ["--json", "project", "show"], transport);
    assert.equal(missing.code, ExitCode.Config, missing.stdout);
    assert.equal(transport.calls.length + transport.oauthCalls.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("login --client-id refuses a config that holds an agent sign-in", async () => {
  const dir = await testTemp("service-mixed-");
  const configPath = path.join(dir, "screenrig", "config.json");
  try {
    await writeConfigAtomic(configPath, { api_url: API, project_id: "prj_OTHERAAAAAAAAAAAAAAAAAAA", token: "eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.signature_stored_other_secret" },
      { mkdir, open, rename, rm, chmod, stat, homedir: () => dir, settings: {} });
    const before = await readFile(configPath, "utf8");
    const result = await cli(dir, ["--json", "login", "--client-id", CLIENT, "--client-secret-file", await writeSecret(dir)], new FakeTransport());
    assert.equal(result.code, ExitCode.Usage, result.stdout);
    assert.equal(await readFile(configPath, "utf8"), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("service-client create sends only a public key and writes a generated secret to a new 0600 file, never stdout", async () => {
  const dir = await testTemp("service-manage-");
  const fs: ConfigFs = { mkdir, open, rename, rm, chmod, stat, homedir: () => dir, settings: {} };
  try {
    const agentToken = "eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.signature_agent_manage_secret";
    await writeConfigAtomic(path.join(dir, "screenrig", "config.json"), { api_url: API, project_id: PROJECT, project_name: "Screens",
      organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization", token: agentToken }, fs);
    const { privateKey } = generateKeyPairSync("ed25519");
    await writeFile(path.join(dir, "key.jwk"), JSON.stringify(privateKey.export({ format: "jwk" })), { mode: 0o600 });
    const view = { id: CLIENT, project_id: PROJECT, name: "CI", capabilities: ["screens"], access: "read", state: "active", created_by: "agent:agt_X",
      keys: [{ kid: "k1", alg: "EdDSA", thumbprint: "t", jwk: {}, added_at: NOW.toISOString() }], secrets: [{ id: "css_AAAA", hint: "cdef", added_at: NOW.toISOString() }],
      created_at: NOW.toISOString(), updated_at: NOW.toISOString(), authenticated_requests: 0, tokens_issued: 0 };
    const transport = new FakeTransport()
      .on("POST", "/api/service-clients", (req) => {
        const body = req.body as { name: string; capabilities: string[]; access: string; key: Record<string, unknown>; secret: boolean };
        assert.equal(req.headers?.authorization, `Bearer ${agentToken}`);
        assert.deepEqual([body.name, body.capabilities, body.access, body.secret], ["CI", ["screens", "content"], "read", true]);
        assert.equal(body.key.kty, "OKP");
        assert.equal(body.key.d, undefined, "the private key never leaves this machine");
        return json(201, { client: view, secret: SECRET });
      })
      .on("POST", `/api/service-clients/${CLIENT}/revoke`, () => json(200, { client: { ...view, state: "revoked" }, propagation: "applied" }))
      .on("POST", `/api/service-clients/${CLIENT}/keys/k1/remove`, () => json(200, { client: view }));
    const created = await cli(dir, ["--json", "service-client", "create", "--name", "CI", "--capability", "screens", "--capability", "content", "--access", "read", "--key-file", "key.jwk", "--secret-file", "ci.secret"], transport);
    assert.equal(created.code, 0, created.stdout);
    assert.ok(!created.stdout.includes(SECRET) && !created.stderr.includes(SECRET));
    assert.equal((JSON.parse(created.stdout) as { data: { secret_file: string } }).data.secret_file, path.join(dir, "ci.secret"));
    assert.equal((await readFile(path.join(dir, "ci.secret"), "utf8")).trim(), SECRET);
    assert.equal((await stat(path.join(dir, "ci.secret"))).mode & 0o777, 0o600);

    const again = await cli(dir, ["--json", "service-client", "add-secret", CLIENT, "--secret-file", "ci.secret"], transport);
    assert.notEqual(again.code, 0, "an existing secret file is never overwritten");
    assert.equal((await readFile(path.join(dir, "ci.secret"), "utf8")).trim(), SECRET);
    assert.equal(transport.calls.filter((call) => call.path.endsWith("/secrets")).length, 0);

    assert.equal((await cli(dir, ["--json", "service-client", "revoke", CLIENT], transport)).code, ExitCode.Usage);
    const revoked = await cli(dir, ["--json", "service-client", "revoke", CLIENT, "--yes"], transport);
    assert.equal(revoked.code, 0, revoked.stdout);
    assert.equal((JSON.parse(revoked.stdout) as { data: { propagation: string } }).data.propagation, "applied");
    assert.equal((await cli(dir, ["--json", "service-client", "remove-key", CLIENT, "--kid", "k1"], transport)).code, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("service-client writes the secret through the file it created, not through the path it reopens", async () => {
  const dir = await testTemp("service-secret-swap-");
  const fs: ConfigFs = { mkdir, open, rename, rm, chmod, stat, homedir: () => dir, settings: {} };
  try {
    const agentToken = "eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.signature_agent_manage_secret";
    await writeConfigAtomic(path.join(dir, "screenrig", "config.json"), { api_url: API, project_id: PROJECT, project_name: "Screens",
      organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization", token: agentToken }, fs);
    const view = { id: CLIENT, project_id: PROJECT, name: "CI", capabilities: ["screens"], access: "read", state: "active", created_by: "agent:agt_X",
      keys: [], secrets: [{ id: "css_AAAA", hint: "cdef", added_at: NOW.toISOString() }],
      created_at: NOW.toISOString(), updated_at: NOW.toISOString(), authenticated_requests: 0, tokens_issued: 0 };
    const victim = path.join(dir, "victim.txt");
    await writeFile(victim, "victim\n", { mode: 0o644 });
    const transport = new FakeTransport().on("POST", "/api/service-clients", () => {
      // Between creating the file and receiving the secret, the path is replaced by a link.
      renameSync(path.join(dir, "ci.secret"), path.join(dir, "ci.secret.original"));
      symlinkSync(victim, path.join(dir, "ci.secret"));
      return json(201, { client: view, secret: SECRET });
    });
    const created = await cli(dir, ["--json", "service-client", "create", "--name", "CI", "--capability", "screens", "--access", "read", "--secret-file", "ci.secret"], transport);
    assert.equal(created.code, 0, created.stdout);
    assert.equal(await readFile(victim, "utf8"), "victim\n", "the replacement target is untouched");
    assert.equal((await readFile(path.join(dir, "ci.secret.original"), "utf8")).trim(), SECRET);
    assert.equal((await stat(path.join(dir, "ci.secret.original"))).mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
