import assert from "node:assert/strict";
import { chmod, mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  defaultConfigPath,
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

test("credential lock serializes concurrent first-use work", async () => {
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
  const configPath = defaultConfigPath(fsLike);
  await writeConfigAtomic(
    configPath,
    { api_url: "https://api.screenrig.ai", token: "sr_live_persisted_secret" },
    fsLike,
  );
  await rm(firstPlugin, { recursive: true, force: true });
  await mkdir(replacementPlugin, { recursive: true });
  assert.equal(defaultConfigPath(fsLike), configPath);
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
