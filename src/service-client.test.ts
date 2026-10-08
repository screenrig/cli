import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify, type KeyObject } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { ExitCode } from "./exit-codes.js";
import { run } from "./main.js";
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

function serviceToken(): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "EdDSA", typ: "at+jwt" })}.${part({ sub: `client:${CLIENT}`, client_id: CLIENT, prj: PROJECT, scope: "access:manage screens content", exp: Math.floor(NOW.getTime() / 1000) + 900, jti: `j${Math.random()}` })}.${"c2lnbmF0dXJl".repeat(4)}`;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): TransportResponse {
  return { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers }, body };
}

function form(req: TransportRequest): URLSearchParams {
  return new URLSearchParams(String(req.body));
}

function server(onToken: (req: TransportRequest) => TransportResponse): FakeTransport {
  return new FakeTransport()
    .on("GET", "/.well-known/oauth-authorization-server", () => json(200, {
      issuer: API, token_endpoint: `${API}/oauth/token`, revocation_endpoint: `${API}/oauth/revoke`,
      token_endpoint_auth_methods_supported: ["none", "private_key_jwt", "client_secret_basic"],
    }))
    .on("POST", "/oauth/token", onToken)
    .on("GET", "/api/project", () => json(200, { id: PROJECT, name: "Screens", organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization", revision: 1, status: "active" }));
}

async function cli(dir: string, argv: string[], transport: FakeTransport, env: Record<string, string> = {}) {
  const fs: ConfigFs = { mkdir, open, rename, rm, chmod, stat, homedir: () => dir, env: { XDG_CONFIG_HOME: dir, ...env } };
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  stdout.on("data", (chunk) => out.push(Buffer.from(chunk)));
  stderr.on("data", (chunk) => err.push(Buffer.from(chunk)));
  const code = await run({ argv, env: fs.env, stdout, stderr, now: () => NOW, sleep: async () => undefined, homedir: () => dir, cwd: () => dir, fs, transport });
  return { code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), fs };
}

test("a SCREENRIG_CLIENT_SECRET run uses HTTP Basic, keeps its token in memory and never touches the stored config", async () => {
  const dir = await testTemp("service-secret-");
  const configPath = path.join(dir, "screenrig", "config.json");
  try {
    await writeConfigAtomic(configPath, { api_url: API, project_id: "prj_OTHERAAAAAAAAAAAAAAAAAAA", token: "sr_live_stored_other_secret" },
      { mkdir, open, rename, rm, chmod, stat, homedir: () => dir, env: {} });
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
    const result = await cli(dir, ["--json", "project", "show"], transport, { SCREENRIG_CLIENT_ID: CLIENT, SCREENRIG_CLIENT_SECRET: SECRET });
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

test("a SCREENRIG_CLIENT_KEY_FILE run signs an assertion that meets the server's rules", async () => {
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
      const result = await cli(dir, ["--json", "project", "show"], transport, { SCREENRIG_CLIENT_ID: CLIENT, SCREENRIG_CLIENT_KEY_FILE: keyFile });
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
      await assert.rejects(stat(path.join(dir, "screenrig", "config.json")), (err: NodeJS.ErrnoException) => err.code === "ENOENT");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("a refused service token is minted again once; there is no refresh token", async () => {
  const dir = await testTemp("service-renew-");
  try {
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
    const result = await cli(dir, ["--json", "screen", "list"], transport, { SCREENRIG_CLIENT_ID: CLIENT, SCREENRIG_CLIENT_SECRET: SECRET });
    assert.equal(result.code, 0, result.stdout);
    assert.equal(minted, 2);
    assert.ok(transport.oauthCalls.every((call) => form(call).get("grant_type") !== "refresh_token"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("service-client env mode refuses agent commands and incomplete variables before any request", async () => {
  const dir = await testTemp("service-refuse-");
  try {
    const transport = new FakeTransport();
    for (const argv of [["login"], ["logout"], ["agent", "enroll", "--email", "a@example.com", "--organization", "X"]]) {
      const result = await cli(dir, ["--json", ...argv], transport, { SCREENRIG_CLIENT_ID: CLIENT, SCREENRIG_CLIENT_SECRET: SECRET });
      assert.equal(result.code, ExitCode.Usage, argv.join(" "));
    }
    for (const env of [{ SCREENRIG_CLIENT_ID: CLIENT }, { SCREENRIG_CLIENT_SECRET: SECRET }, { SCREENRIG_CLIENT_ID: "not-a-client", SCREENRIG_CLIENT_SECRET: SECRET },
      { SCREENRIG_CLIENT_ID: CLIENT, SCREENRIG_CLIENT_SECRET: SECRET, SCREENRIG_CLIENT_KEY_FILE: "/nonexistent" }] as Array<Record<string, string>>) {
      const result = await cli(dir, ["--json", "project", "show"], transport, env);
      assert.equal(result.code, ExitCode.Config, JSON.stringify(Object.keys(env)));
      assert.ok(!result.stdout.includes(SECRET));
    }
    assert.equal(transport.calls.length + transport.oauthCalls.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("service-client create sends only a public key and writes a generated secret to a new 0600 file, never stdout", async () => {
  const dir = await testTemp("service-manage-");
  const fs: ConfigFs = { mkdir, open, rename, rm, chmod, stat, homedir: () => dir, env: {} };
  try {
    const agentToken = "sr_live_agent_manage_secret";
    await writeConfigAtomic(path.join(dir, "screenrig", "config.json"), { api_url: API, project_id: PROJECT, project_name: "Screens",
      organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization", token: agentToken, oauth_unavailable_until: new Date(NOW.getTime() + 3600_000).toISOString() }, fs);
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
