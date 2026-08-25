import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
    import path from "node:path";
    import type { OperationLogger } from "./log/types.js";
    import { configError } from "./problems.js";
    import { redactToken, tokenLookupId } from "./redact.js";

    export interface ScreenRigConfig {
      api_url: string;
      token?: string;
      /** Path to an already-listening AF_UNIX socket for NDJSON operation logs. */
      log_socket?: string;
      account_id?: string;
      agent_id?: string;
      last_agent?: {
        id: string;
        name: string;
        agent_type: string;
        state: "revoked";
        revoked_at?: string;
      };
      agent_connection?: {
        private_jwk: {
          kty: "OKP";
          crv: "X25519";
          x: string;
          d: string;
        };
        name?: string;
        connection_id?: string;
        connection_token?: string;
        approval_url?: string;
        expires_at?: string;
        pending_agent_id?: string;
      };
      enrollment?: {
        client_id: string;
        idempotency_key: string;
        /** Exact trimmed contact address retained only until enrollment verifies. */
        email?: string;
      };
      screen_provision?: {
        idempotency_key: string;
        label?: string;
      };
      browser_setup?: {
        idempotency_key: string;
        code: string;
      };
      updated_at?: string;
    }

    export const DEFAULT_API_URL = "https://api.screenrig.ai";
    export const LOCAL_DEV_API_URL = "http://api.screenrig.localhost:8088";

    export interface ConfigFs {
      mkdir: typeof mkdir;
      open: typeof open;
      rename: typeof rename;
      rm: typeof rm;
      chmod: typeof chmod;
      stat: typeof stat;
      homedir: () => string;
      env: NodeJS.Dict<string>;
      logger?: OperationLogger;
    }

    const DEFAULT_CONFIG_NAME = "config.json";
    const LOCAL_DEV_CONFIG_NAME = "config.local-dev.json";

    function defaultConfigDir(fsLike: Pick<ConfigFs, "homedir" | "env">): string {
      const xdg = fsLike.env.XDG_CONFIG_HOME;
      if (xdg && xdg.length > 0) {
        return path.join(xdg, "screenrig");
      }
      if (process.platform === "win32") {
        const appdata = fsLike.env.APPDATA;
        if (appdata && appdata.length > 0) {
          return path.join(appdata, "screenrig");
        }
      }
      return path.join(fsLike.homedir(), ".config", "screenrig");
    }

    async function configPathExists(filePath: string, fsLike: Pick<ConfigFs, "stat">): Promise<boolean> {
      try {
        await fsLike.stat(filePath);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return false;
        }
        throw err;
      }
    }

    export async function defaultConfigPath(
      fsLike: Pick<ConfigFs, "homedir" | "env" | "stat">,
    ): Promise<string> {
      const fromEnv = fsLike.env.SCREENRIG_CONFIG;
      if (fromEnv && fromEnv.length > 0) {
        return fromEnv;
      }
      const dir = defaultConfigDir(fsLike);
      const localDev = path.join(dir, LOCAL_DEV_CONFIG_NAME);
      if (await configPathExists(localDev, fsLike)) {
        return localDev;
      }
      return path.join(dir, DEFAULT_CONFIG_NAME);
    }

    function modeOf(value: { mode: number }): number {
      return value.mode & 0o777;
    }

    export function isWorldOrGroupReadable(mode: number): boolean {
      return (mode & 0o077) !== 0;
    }

    async function fsyncDir(dir: string, fsLike: ConfigFs): Promise<void> {
      const handle = await fsLike.open(dir, "r");
      try {
        await handle.sync();
      } catch {
        // Directory fsync is best-effort on filesystems that reject it.
      } finally {
        await handle.close();
      }
    }

    export async function readConfigFile(
      configPath: string,
      fsLike: ConfigFs,
      options: { repair?: boolean } = {},
    ): Promise<ScreenRigConfig | undefined> {
      return withConfigLog(fsLike, "config.read", configPath, async () => {
      let info;
      try {
        info = await fsLike.stat(configPath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          return undefined;
        }
        throw err;
      }
      if (isWorldOrGroupReadable(modeOf(info))) {
        if (!options.repair) {
          throw configError(
            `Refusing to read group/world-readable config at ${configPath}`,
            {
              command: `screenrig doctor --repair-config --config ${configPath}`,
              reason: "Repair permissions to user-only (0600) before reading the token file.",
            },
          );
        }
        await fsLike.chmod(configPath, 0o600);
      }
      const handle = await fsLike.open(configPath, "r");
      try {
        const raw = await handle.readFile("utf8");
        const parsed = JSON.parse(raw) as ScreenRigConfig;
        if (!parsed || typeof parsed !== "object") {
          throw configError("Config file is not a JSON object.");
        }
        return parsed;
      } catch (err) {
        if (err instanceof SyntaxError) {
          throw configError(`Config file is not valid JSON: ${configPath}`);
        }
        throw err;
      } finally {
        await handle.close();
      }
      });
    }

    /**
     * Keep `log_socket` across rewrites that build a fresh object. Spread
     * `current` first when the rest of the file should survive; use this when
     * the write is intentionally sparse (enrollment pending, disconnect).
     */
    export function preserveLogSocket(
      current: ScreenRigConfig | undefined,
      next: ScreenRigConfig,
    ): ScreenRigConfig {
      const fromNext = typeof next.log_socket === "string" ? next.log_socket.trim() : "";
      const fromCurrent = typeof current?.log_socket === "string" ? current.log_socket.trim() : "";
      const logSocket = fromNext || fromCurrent;
      if (logSocket) {
        return { ...next, log_socket: logSocket };
      }
      if ("log_socket" in next) {
        const { log_socket: _omit, ...rest } = next;
        return rest;
      }
      return next;
    }

    async function withConfigLog<T>(
      fsLike: Pick<ConfigFs, "logger">,
      op: string,
      configPath: string,
      work: () => Promise<T>,
    ): Promise<T> {
      const logger = fsLike.logger;
      if (!logger?.enabled) {
        return work();
      }
      return logger.withLocal({ op, message: op, config_path: configPath }, async (span) => {
        try {
          const result = await work();
          span.finish({ outcome: "ok", config_path: configPath });
          return result;
        } catch (err) {
          span.error(err, { config_path: configPath });
          throw err;
        }
      });
    }

    export async function writeConfigAtomic(
      configPath: string,
      config: ScreenRigConfig,
      fsLike: ConfigFs,
    ): Promise<void> {
      return withConfigLog(fsLike, "config.write", configPath, async () => {
      const dir = path.dirname(configPath);
      await fsLike.mkdir(dir, { recursive: true, mode: 0o700 });
      try {
        await fsLike.chmod(dir, 0o700);
      } catch {
        // chmod after mkdir is best-effort when umask already produced 0700.
      }
      const tmp = `${configPath}.${process.pid}.${Date.now()}.tmp`;
      const body = `${JSON.stringify(config, null, 2)}\n`;
      try {
        const handle = await fsLike.open(tmp, "w", 0o600);
        try {
          await handle.writeFile(body, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await fsLike.chmod(tmp, 0o600);
        await fsLike.rename(tmp, configPath);
        await fsLike.chmod(configPath, 0o600);
        await fsyncDir(dir, fsLike);
      } catch (err) {
        await fsLike.rm(tmp, { force: true }).catch(() => undefined);
        throw err;
      }
      });
    }

    export interface ConfigLockOptions {
      sleep: (ms: number) => Promise<void>;
      now: () => number;
      retryMs?: number;
      staleMs?: number;
      maxWaitMs?: number;
    }

    /**
     * Serialize explicit enrollment across CLI processes. The lock lives beside
     * the durable config, never in a replaceable plugin/cache directory.
     */
    export async function withConfigLock<T>(
      configPath: string,
      fsLike: ConfigFs,
      options: ConfigLockOptions,
      callback: () => Promise<T>,
    ): Promise<T> {
      return withConfigLog(fsLike, "config.lock", configPath, async () => {
      const dir = path.dirname(configPath);
      const lockPath = `${configPath}.lock`;
      const retryMs = options.retryMs ?? 50;
      const staleMs = options.staleMs ?? 30_000;
      const maxWaitMs = options.maxWaitMs ?? 10_000;
      const started = options.now();
      await fsLike.mkdir(dir, { recursive: true, mode: 0o700 });
      await fsLike.chmod(dir, 0o700).catch(() => undefined);

      while (true) {
        try {
          await fsLike.mkdir(lockPath, { mode: 0o700 });
          break;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
            throw err;
          }
          try {
            const info = await fsLike.stat(lockPath);
            if (options.now() - info.mtimeMs > staleMs) {
              const abandoned = `${lockPath}.stale.${process.pid}.${options.now()}`;
              try {
                await fsLike.rename(lockPath, abandoned);
                await fsLike.rm(abandoned, { recursive: true, force: true });
              } catch (reclaimError) {
                const code = (reclaimError as NodeJS.ErrnoException).code;
                if (code !== "ENOENT" && code !== "EEXIST") {
                  throw reclaimError;
                }
              }
              continue;
            }
          } catch (statError) {
            if ((statError as NodeJS.ErrnoException).code !== "ENOENT") {
              throw statError;
            }
            continue;
          }
          if (options.now() - started >= maxWaitMs) {
            throw configError(`Timed out waiting for the credential lock at ${lockPath}.`);
          }
          await options.sleep(retryMs);
        }
      }

      try {
        return await callback();
      } finally {
        await fsLike.rm(lockPath, { recursive: true, force: true });
      }
      });
    }

    export interface ResolvedConfig {
      apiUrl: string;
      token?: string;
      accountId?: string;
      agentId?: string;
      enrollment?: ScreenRigConfig["enrollment"];
      agentConnection?: ScreenRigConfig["agent_connection"];
      lastAgent?: ScreenRigConfig["last_agent"];
      configPath: string;
      logSocket?: string;
      source: {
        apiUrl: "flag" | "env" | "config" | "local-dev" | "default";
        token: "config" | "none";
      };
    }

    export async function validateLogSocketPath(
      value: unknown,
      fsLike: Pick<ConfigFs, "stat">,
    ): Promise<string | undefined> {
      if (value === undefined || value === null) {
        return undefined;
      }
      if (typeof value !== "string") {
        throw configError("log_socket must be a string path to an already-listening Unix socket.");
      }
      const socketPath = value.trim();
      if (socketPath.length === 0) {
        return undefined;
      }
      try {
        const info = await fsLike.stat(socketPath);
        if (info.isDirectory()) {
          throw configError(`log_socket is a directory: ${socketPath}. Set it to a Unix socket path whose consumer is already listening.`);
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return socketPath;
        }
        throw err;
      }
      return socketPath;
    }

    export async function resolveConfig(options: {
      flags: Record<string, string | boolean>;
      fs: ConfigFs;
      repair?: boolean;
    }): Promise<ResolvedConfig> {
      const configPath =
        (typeof options.flags.config === "string" && options.flags.config) ||
        (await defaultConfigPath(options.fs));
      const file = await readConfigFile(configPath, options.fs, { repair: options.repair });
      const flagApi = typeof options.flags["api-url"] === "string" ? options.flags["api-url"] : undefined;
      const envApi = options.fs.env.SCREENRIG_API_URL;
      const flagToken = options.flags.token;
      const envToken = options.fs.env.SCREENRIG_TOKEN;
      if (flagToken !== undefined || envToken) {
        throw configError(
          "Token flags and SCREENRIG_TOKEN are not supported. ScreenRig enrollment or passkey-approved agent connection stores a distinct credential in the user config.",
        );
      }

      const localDevProfile = path.basename(configPath) === LOCAL_DEV_CONFIG_NAME;
      let apiUrl = localDevProfile ? LOCAL_DEV_API_URL : DEFAULT_API_URL;
      let apiSource: ResolvedConfig["source"]["apiUrl"] = localDevProfile ? "local-dev" : "default";
      const storedApiUrl = file?.api_url?.replace(/\/+$/, "");
      if (storedApiUrl && (!localDevProfile || storedApiUrl !== DEFAULT_API_URL)) {
        apiUrl = storedApiUrl;
        apiSource = "config";
      }
      if (envApi) {
        apiUrl = envApi;
        apiSource = "env";
      }
      if (flagApi) {
        apiUrl = flagApi;
        apiSource = "flag";
      }

      let token: string | undefined;
      let tokenSource: ResolvedConfig["source"]["token"] = "none";
      if (file?.token) {
        token = file.token;
        tokenSource = "config";
      }
      const logSocket = await validateLogSocketPath(file?.log_socket, options.fs);
      return {
        apiUrl: apiUrl.replace(/\/+$/, ""),
        token,
        accountId: file?.account_id,
        agentId: file?.agent_id,
        enrollment: file?.enrollment,
        agentConnection: file?.agent_connection,
        lastAgent: file?.last_agent,
        configPath,
        logSocket,
        source: { apiUrl: apiSource, token: tokenSource },
      };
    }

    export function describeToken(token: string | undefined): string {
      if (!token) {
        return "(none)";
      }
      const id = tokenLookupId(token);
      return id ? redactToken(token) : "sr_live_***";
    }
