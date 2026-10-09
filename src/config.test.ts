import assert from "node:assert/strict";
import { chmod, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  defaultConfigPath,
  DEFAULT_API_URL,
  LOCAL_DEV_API_URL,
  readConfigFile,
  resolveConfig,
  withConfigLock,
  writeConfigAtomic,
  type ConfigFs,
} from "./config.js";
import { testTemp } from "./test-temp.js";

function realFs(home: string, env: NodeJS.Dict<string> = { XDG_CONFIG_HOME: home }): ConfigFs {
  return { mkdir, open, rename, rm, chmod, stat, homedir: () => home, env };
}

test("project identity resolves only from project config fields", async () => {
  const home = await testTemp("config-project-identity-");
  const fsLike = realFs(home);
  const configPath = path.join(home, "screenrig", "config.json");
  try {
    const previousIdentity = { api_url: DEFAULT_API_URL, account_id: "prj_previous" };
    await writeConfigAtomic(configPath, previousIdentity, fsLike);
    const withoutProject = await resolveConfig({ flags: {}, fs: fsLike });
    assert.equal(withoutProject.projectId, undefined);
    assert.equal(withoutProject.projectName, undefined);
    await writeConfigAtomic(configPath, {
      ...previousIdentity,
      project_id: "prj_current",
      project_name: "Lobby displays",
    }, fsLike);
    const current = await resolveConfig({ flags: {}, fs: fsLike });
    assert.equal(current.projectId, "prj_current");
    assert.equal(current.projectName, "Lobby displays");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("atomic config writes preserve the prior credential when replacement is interrupted", async () => {
  const home = await testTemp("config-interrupt-");
  const configPath = path.join(home, "screenrig", "config.json");
  const fsLike = realFs(home);
  await writeConfigAtomic(
    configPath,
    { api_url: "https://api.screenrig.ai", token: "sr_live_existing_secret" },
    fsLike,
  );
  const interrupted: ConfigFs = {
    ...fsLike,
    rename: async (from, to) => {
      if (to === configPath) {
        const err = new Error("simulated rename interruption") as NodeJS.ErrnoException;
        err.code = "EIO";
        throw err;
      }
      await rename(from, to);
    },
  };
  await assert.rejects(
    writeConfigAtomic(
      configPath,
      { api_url: "https://api.screenrig.ai", token: "sr_live_replacement_secret" },
      interrupted,
    ),
    /simulated rename interruption/,
  );
  assert.match(await readFile(configPath, "utf8"), /sr_live_existing_secret/);
  assert.deepEqual((await readdir(path.dirname(configPath))).sort(), ["config.json"]);
  await rm(home, { recursive: true, force: true });
});

test("credential lock serializes concurrent enrollment work", async () => {
  const home = await testTemp("config-lock-");
  const configPath = path.join(home, "screenrig", "config.json");
  const fsLike = realFs(home);
  const order: string[] = [];
  let releaseFirst: (() => void) | undefined;
  let firstStarted: (() => void) | undefined;
  const firstStartedPromise = new Promise<void>((resolve) => { firstStarted = resolve; });
  const firstReleasePromise = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const lockOptions = {
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    retryMs: 2,
    maxWaitMs: 1_000,
  };

  const first = withConfigLock(configPath, fsLike, lockOptions, async () => {
    order.push("first-acquired");
    firstStarted?.();
    await firstReleasePromise;
    order.push("first-released");
  });
  await firstStartedPromise;
  const second = withConfigLock(configPath, fsLike, lockOptions, async () => {
    order.push("second-acquired");
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(order, ["first-acquired"]);
  releaseFirst?.();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-acquired", "first-released", "second-acquired"]);
  await rm(home, { recursive: true, force: true });
});

test("default credential location survives replacement of a plugin cache", async () => {
  const home = await testTemp("config-survival-");
  const fsLike = realFs(home);
  const firstPlugin = path.join(home, ".cache", "codex", "screenrig", "old");
  const replacementPlugin = path.join(home, ".cache", "codex", "screenrig", "new");
  await mkdir(firstPlugin, { recursive: true });
  const configPath = await defaultConfigPath(fsLike);
  await writeConfigAtomic(
    configPath,
    { api_url: "https://api.screenrig.ai", token: "sr_live_persisted_secret" },
    fsLike,
  );
  await rm(firstPlugin, { recursive: true, force: true });
  await mkdir(replacementPlugin, { recursive: true });
  assert.equal(await defaultConfigPath(fsLike), configPath);
  assert.equal((await readConfigFile(configPath, fsLike))?.token, "sr_live_persisted_secret");
  assert.equal(configPath.startsWith(path.join(home, ".cache")), false);
  await rm(home, { recursive: true, force: true });
});

test("log_socket is resolved from the user config and rejected when it is a directory", async () => {
  const home = await testTemp("config-log-socket-");
  const fsLike = realFs(home);
  const dir = path.join(home, "screenrig");
  await mkdir(dir, { recursive: true });
  const configPath = path.join(dir, "config.json");
  const socketDir = path.join(home, "socks");
  await mkdir(socketDir, { recursive: true });
  await writeFile(configPath, JSON.stringify({ api_url: "https://api.screenrig.ai", log_socket: socketDir }) + "\n");
  await chmod(configPath, 0o600);
  await assert.rejects(resolveConfig({ flags: {}, fs: fsLike }), /log_socket is a directory/);

  await writeFile(configPath, JSON.stringify({ api_url: "https://api.screenrig.ai", log_socket: "/tmp/screenrig.sock" }) + "\n");
  await chmod(configPath, 0o600);
  const resolved = await resolveConfig({ flags: {}, fs: fsLike });
  assert.equal(resolved.logSocket, "/tmp/screenrig.sock");

  await writeFile(configPath, JSON.stringify({ api_url: "https://api.screenrig.ai", log_socket: "   " }) + "\n");
  await chmod(configPath, 0o600);
  const empty = await resolveConfig({ flags: {}, fs: fsLike });
  assert.equal(empty.logSocket, undefined);
  await rm(home, { recursive: true, force: true });
});

test("token paste branches are rejected instead of overriding durable credentials", async () => {
  const home = await testTemp("config-token-branch-");
  const fsLike = realFs(home, { XDG_CONFIG_HOME: home, SCREENRIG_TOKEN: "sr_live_pasted_secret" });
  await assert.rejects(
    resolveConfig({ flags: {}, fs: fsLike }),
    /Token flags and SCREENRIG_TOKEN are not supported/,
  );
  await rm(home, { recursive: true, force: true });
});

test("default config path is config.json when SCREENRIG_CONFIG is unset and local-dev is absent", async () => {
  const home = await testTemp("config-default-json-");
  const fsLike = realFs(home);
  assert.equal(await defaultConfigPath(fsLike), path.join(home, "screenrig", "config.json"));
  await rm(home, { recursive: true, force: true });
});

test("default config ignores an existing local-dev profile", async () => {
  const home = await testTemp("config-local-dev-");
  const fsLike = realFs(home);
  const dir = path.join(home, "screenrig");
  await mkdir(dir, { recursive: true });
  const localDev = path.join(dir, "config.local-dev.json");
  await writeFile(localDev, "{}\n");
  assert.equal(await defaultConfigPath(fsLike), path.join(dir, "config.json"));
  await rm(home, { recursive: true, force: true });
});

test("default resolution reuses production while alternative profiles remain untouched", async () => {
  const home = await testTemp("config-production-preference-");
  const fsLike = realFs(home);
  const dir = path.join(home, "screenrig");
  await mkdir(dir, { recursive: true });
  const production = path.join(dir, "config.json");
  const local = path.join(dir, "config.local-dev.json");
  const alternate = path.join(dir, "config.alternate.json");
  const files = [
    [production, { api_url: DEFAULT_API_URL, token: "production-test-token" }],
    [local, { api_url: LOCAL_DEV_API_URL, token: "local-test-token" }],
    [alternate, { api_url: "https://api.example.com", token: "alternate-test-token" }],
  ] as const;
  for (const [file, config] of files) await writeFile(file, JSON.stringify(config), { mode: 0o600 });
  try {
    const normal = await resolveConfig({ flags: {}, fs: fsLike });
    assert.equal(normal.apiUrl, DEFAULT_API_URL);
    assert.equal(normal.token, "production-test-token");
    const explicit = await resolveConfig({ flags: { config: alternate }, fs: fsLike });
    assert.equal(explicit.apiUrl, "https://api.example.com");
    assert.equal(explicit.token, "alternate-test-token");
    const localEnv = await resolveConfig({ flags: {}, fs: { ...fsLike, env: { ...fsLike.env, SCREENRIG_CONFIG: local } } });
    assert.equal(localEnv.apiUrl, LOCAL_DEV_API_URL);
    assert.equal(localEnv.token, "local-test-token");
    for (const [file, config] of files) assert.equal(await readFile(file, "utf8"), JSON.stringify(config));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("explicit local-dev profile resolves the documented local API", async () => {
  const home = await testTemp("config-local-dev-api-");
  const fsLike = realFs(home);
  const dir = path.join(home, "screenrig");
  const localDev = path.join(dir, "config.local-dev.json");
  await mkdir(dir, { recursive: true });
  await writeFile(localDev, "{}\n");
  await chmod(localDev, 0o600);

  const resolved = await resolveConfig({ flags: { config: localDev }, fs: fsLike });
  assert.equal(resolved.apiUrl, LOCAL_DEV_API_URL);
  assert.equal(resolved.source.apiUrl, "local-dev");
  assert.notEqual(resolved.apiUrl, DEFAULT_API_URL);

  await rm(home, { recursive: true, force: true });
});

test("local-dev profile replaces a stored production default but preserves explicit overrides", async () => {
  const home = await testTemp("config-local-dev-overrides-");
  const fsLike = realFs(home);
  const dir = path.join(home, "screenrig");
  const localDev = path.join(dir, "config.local-dev.json");
  await mkdir(dir, { recursive: true });
  await writeFile(localDev, JSON.stringify({ api_url: `${DEFAULT_API_URL}/` }) + "\n");
  await chmod(localDev, 0o600);

  let resolved = await resolveConfig({ flags: { config: localDev }, fs: fsLike });
  assert.equal(resolved.apiUrl, LOCAL_DEV_API_URL);
  assert.equal(resolved.source.apiUrl, "local-dev");

  await writeFile(localDev, JSON.stringify({ api_url: "http://127.0.0.1:8088" }) + "\n");
  resolved = await resolveConfig({ flags: { config: localDev }, fs: fsLike });
  assert.equal(resolved.apiUrl, "http://127.0.0.1:8088");
  assert.equal(resolved.source.apiUrl, "config");

  resolved = await resolveConfig({
    flags: { config: localDev, "api-url": "http://127.0.0.1:18088" },
    fs: { ...fsLike, env: { XDG_CONFIG_HOME: home, SCREENRIG_API_URL: "http://127.0.0.1:28088" } },
  });
  assert.equal(resolved.apiUrl, "http://127.0.0.1:18088");
  assert.equal(resolved.source.apiUrl, "flag");

  resolved = await resolveConfig({
    flags: { config: localDev },
    fs: { ...fsLike, env: { XDG_CONFIG_HOME: home, SCREENRIG_API_URL: "http://127.0.0.1:28088" } },
  });
  assert.equal(resolved.apiUrl, "http://127.0.0.1:28088");
  assert.equal(resolved.source.apiUrl, "env");

  await rm(home, { recursive: true, force: true });
});

test("production default config keeps the production API", async () => {
  const home = await testTemp("config-production-api-");
  const fsLike = realFs(home);
  const resolved = await resolveConfig({ flags: {}, fs: fsLike });
  assert.equal(resolved.apiUrl, DEFAULT_API_URL);
  assert.equal(resolved.source.apiUrl, "default");
  await rm(home, { recursive: true, force: true });
});

test("SCREENRIG_CONFIG wins even when config.local-dev.json exists", async () => {
  const home = await testTemp("config-env-override-");
  const override = path.join(home, "override.json");
  const fsLike = realFs(home, { XDG_CONFIG_HOME: home, SCREENRIG_CONFIG: override });
  const dir = path.join(home, "screenrig");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "config.local-dev.json"), "{}\n");
  assert.equal(await defaultConfigPath(fsLike), override);
  await rm(home, { recursive: true, force: true });
});

test("default config directory follows XDG_CONFIG_HOME", async () => {
  const home = await testTemp("config-xdg-");
  const xdg = path.join(home, "xdg");
  const fsLike = realFs(home, { XDG_CONFIG_HOME: xdg });
  assert.equal(await defaultConfigPath(fsLike), path.join(xdg, "screenrig", "config.json"));
  const dir = path.join(xdg, "screenrig");
  await mkdir(dir, { recursive: true });
  const localDev = path.join(dir, "config.local-dev.json");
  await writeFile(localDev, "{}\n");
  assert.equal(await defaultConfigPath(fsLike), path.join(dir, "config.json"));
  await rm(home, { recursive: true, force: true });
});

test("default config directory falls back to homedir/.config/screenrig when XDG is unset", async () => {
  const home = await testTemp("config-homedir-");
  const fsLike = realFs(home, {});
  assert.equal(await defaultConfigPath(fsLike), path.join(home, ".config", "screenrig", "config.json"));
  const dir = path.join(home, ".config", "screenrig");
  await mkdir(dir, { recursive: true });
  const localDev = path.join(dir, "config.local-dev.json");
  await writeFile(localDev, "{}\n");
  assert.equal(await defaultConfigPath(fsLike), path.join(dir, "config.json"));
  await rm(home, { recursive: true, force: true });
});

async function plantLock(configPath: string, fsLike: ConfigFs, owner: { pid: number; nonce: string; acquired_at: number }): Promise<string> {
  const lockPath = `${configPath}.lock`;
  await mkdir(lockPath, { recursive: true, mode: 0o700 });
  await writeFile(path.join(lockPath, "owner.json"), JSON.stringify(owner), { mode: 0o600 });
  void fsLike;
  return lockPath;
}

test("a stale lock whose owner is still alive is not reclaimed", async () => {
  const home = await testTemp("config-lock-alive-");
  const fsLike = realFs(home);
  const configPath = path.join(home, "screenrig", "config.json");
  let clock = 1_000_000;
  try {
    await plantLock(configPath, fsLike, { pid: process.pid, nonce: "holder", acquired_at: clock });
    let ran = false;
    await assert.rejects(withConfigLock(configPath, fsLike, {
      now: () => clock, sleep: async (ms) => { clock += ms; }, staleMs: 30_000, maxWaitMs: 20_000, isAlive: () => true,
    }, async () => { ran = true; }), /Timed out waiting for the credential lock/);
    assert.equal(ran, false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a lock is reclaimed when its owner is gone, or held past the stale age by an unchanged owner", async () => {
  const home = await testTemp("config-lock-reclaim-");
  const fsLike = realFs(home);
  const configPath = path.join(home, "screenrig", "config.json");
  let clock = 1_000_000;
  const options = { now: () => clock, sleep: async (ms: number) => { clock += ms; }, staleMs: 30_000, maxWaitMs: 20_000 };
  try {
    await plantLock(configPath, fsLike, { pid: 2 ** 22 + 7, nonce: "dead", acquired_at: clock });
    assert.equal(await withConfigLock(configPath, fsLike, { ...options, isAlive: () => false }, async () => "ran"), "ran");

    await plantLock(configPath, fsLike, { pid: process.pid, nonce: "stuck", acquired_at: clock - 60_000 });
    let looks = 0;
    assert.equal(await withConfigLock(configPath, fsLike, { ...options, isAlive: () => { looks += 1; return true; } }, async () => "ran"), "ran");
    assert.equal(looks, 2, "the same nonce is seen on two looks before reclaiming");
    await assert.rejects(stat(`${configPath}.lock`), (err: NodeJS.ErrnoException) => err.code === "ENOENT");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("release removes only this holder's lock", async () => {
  const home = await testTemp("config-lock-owner-");
  const fsLike = realFs(home);
  const configPath = path.join(home, "screenrig", "config.json");
  const lockPath = `${configPath}.lock`;
  try {
    await withConfigLock(configPath, fsLike, { now: () => Date.now(), sleep: async () => undefined }, async () => {
      const owner = JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8")) as { pid: number; nonce: string };
      assert.equal(owner.pid, process.pid);
      assert.match(owner.nonce, /^[0-9a-f]{32}$/);
      // Another process reclaimed the lock and holds it now.
      await writeFile(path.join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, nonce: "other", acquired_at: Date.now() }));
    });
    assert.ok((await stat(lockPath)).isDirectory(), "another holder's lock stays");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
