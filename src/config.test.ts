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

test("default config path is config.local-dev.json when that file exists", async () => {
  const home = await testTemp("config-local-dev-");
  const fsLike = realFs(home);
  const dir = path.join(home, "screenrig");
  await mkdir(dir, { recursive: true });
  const localDev = path.join(dir, "config.local-dev.json");
  await writeFile(localDev, "{}\n");
  assert.equal(await defaultConfigPath(fsLike), localDev);
  await rm(home, { recursive: true, force: true });
});

test("local-dev profile resolves the documented local API by default", async () => {
  const home = await testTemp("config-local-dev-api-");
  const fsLike = realFs(home);
  const dir = path.join(home, "screenrig");
  const localDev = path.join(dir, "config.local-dev.json");
  await mkdir(dir, { recursive: true });
  await writeFile(localDev, "{}\n");
  await chmod(localDev, 0o600);

  const resolved = await resolveConfig({ flags: {}, fs: fsLike });
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

  let resolved = await resolveConfig({ flags: {}, fs: fsLike });
  assert.equal(resolved.apiUrl, LOCAL_DEV_API_URL);
  assert.equal(resolved.source.apiUrl, "local-dev");

  await writeFile(localDev, JSON.stringify({ api_url: "http://127.0.0.1:8088" }) + "\n");
  resolved = await resolveConfig({ flags: {}, fs: fsLike });
  assert.equal(resolved.apiUrl, "http://127.0.0.1:8088");
  assert.equal(resolved.source.apiUrl, "config");

  resolved = await resolveConfig({
    flags: { "api-url": "http://127.0.0.1:18088" },
    fs: { ...fsLike, env: { XDG_CONFIG_HOME: home, SCREENRIG_API_URL: "http://127.0.0.1:28088" } },
  });
  assert.equal(resolved.apiUrl, "http://127.0.0.1:18088");
  assert.equal(resolved.source.apiUrl, "flag");

  resolved = await resolveConfig({
    flags: {},
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
  assert.equal(await defaultConfigPath(fsLike), localDev);
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
  assert.equal(await defaultConfigPath(fsLike), localDev);
  await rm(home, { recursive: true, force: true });
});
