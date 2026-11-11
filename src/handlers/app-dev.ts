// Command handler for `app dev`, loaded on demand.
import path from "node:path";
import { flagBool, flagNumber, flagString, type ParsedArgs } from "../command-input.js";
import { requireToken } from "../client.js";
import type { KvRead } from "../dev/kv.js";
import type { LogEntry } from "../dev/session.js";
import { successEnvelope } from "../envelope.js";
import { ExitCode } from "../exit-codes.js";
import { CliError, usageError } from "../problems.js";
import { openExternalUrl } from "../open-url.js";
import type { CliRuntime } from "../runtime.js";
import { clientFor, commandHandler, streamToken, type CommandHandler, type CommandResult, type ResolvedCommandConfig } from "../commands.js";
import { requireAppDirectory } from "./app.js";

const local = commandHandler(appDev, false);
const signedIn = commandHandler(appDev, true);

/** `--kv-from` reads the application's real store, which takes the signed-in CLI; every other run needs no credential. */
export const handleAppDev: CommandHandler = (args, runtime) => (flagString(args.flags, "kv-from") ? signedIn : local)(args, runtime);

function remoteReader(args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig): KvRead {
  const token = requireToken(resolved.token);
  // --timeout is how long the harness runs; it is not each request's deadline.
  const requestArgs: ParsedArgs = { ...args, flags: { ...args.flags, timeout: false } };
  return async (apiPath) => {
    try {
      const client = clientFor(runtime, requestArgs, resolved.apiUrl, await streamToken(runtime, token));
      return { ok: true, body: (await client.call({ method: "GET", path: apiPath })).body };
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      const { code, status, detail, request_id, current_revision } = error.problem;
      return { ok: false, problem: { code, status, detail, ...(request_id ? { request_id } : {}), ...(current_revision === undefined ? {} : { current_revision }) } };
    }
  };
}

async function appDev(args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig): Promise<CommandResult> {
  const dir = args.positionals[2];
  if (!dir) throw usageError("app dev requires a directory.");
  // The harness loads only for this command: the dev modules are a chunk of their own.
  const { assertDevPort, startDevServer } = await import("../dev/index.js");
  const { DEV_PORT } = await import("../dev/origins.js");
  const { devEventData, formatDevLine } = await import("../dev/output.js");
  const directory = await requireAppDirectory(runtime, dir, "app dev ./DIRECTORY");
  const port = flagNumber(args.flags, "port") ?? DEV_PORT;
  assertDevPort(port);
  const json = !flagBool(args.flags, "human");

  let kvFrom: { applicationId: string; read: KvRead } | undefined;
  const from = flagString(args.flags, "kv-from");
  if (from !== undefined) {
    if (!/^(?:(?:stage|qa|development)_)?app_[A-Za-z0-9_-]+$/.test(from)) throw usageError("--kv-from must be an application identifier (app_...).");
    const read = remoteReader(args, runtime, resolved);
    const probe = await read(`/api/applications/${encodeURIComponent(from)}/kv`);
    if (!probe.ok) throw usageError(`Cannot read the stored values of ${from}: ${probe.problem.detail}`, { command: "screenrig app list", reason: "Lists the applications this project can read." });
    kvFrom = { applicationId: from, read };
  }
  const kvFlag = flagString(args.flags, "kv");

  // The started line comes first; what the build printed while the server came up follows it.
  let announced = false;
  const early: LogEntry[] = [];
  const write = (entry: LogEntry): void => {
    runtime.stdout.write(`${json ? JSON.stringify(successEnvelope(devEventData(entry))) : formatDevLine(entry)}\n`);
  };
  const print = (entry: LogEntry): void => {
    if (announced) write(entry); else early.push(entry);
  };
  const handle = await startDevServer({
    directory, port, reload: !flagBool(args.flags, "no-reload"), print,
    ...(kvFlag ? { kvFile: path.resolve(runtime.cwd(), kvFlag) } : {}),
    ...(kvFrom ? { kvFrom } : {}),
  });
  const started = { event: "started", url: handle.url, app_url: handle.appUrl, directory, release_host: handle.releaseHost, port, kv: handle.kv, reload: !flagBool(args.flags, "no-reload"), watching: handle.watching };
  if (json) runtime.stdout.write(`${JSON.stringify(successEnvelope(started))}\n`);
  else {
    runtime.stdout.write([
      "screenRIG app dev", `  harness    ${handle.url}`, `  app        ${handle.appUrl}`, `  directory  ${directory}`,
      `  stored     ${handle.kv.mode === "remote" ? `real store of ${handle.kv.location} (read-only)` : handle.kv.location}`,
      `  reload     ${started.reload ? "on file changes" : "off (use the Reload button)"}`, "Press Ctrl-C to stop.", "",
    ].join("\n"));
  }
  announced = true;
  for (const entry of early.splice(0)) write(entry);
  if (flagBool(args.flags, "open")) {
    const opened = await (runtime.openUrl ?? openExternalUrl)(handle.url).catch(() => false);
    if (!opened) runtime.stderr.write(`Open ${handle.url} in a browser.\n`);
  }

  const stopped = new AbortController();
  const stop = (): void => stopped.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const timeoutMs = flagNumber(args.flags, "timeout");
  const timer = timeoutMs && timeoutMs > 0 ? setTimeout(stop, timeoutMs) : undefined;
  try {
    await new Promise<void>((resolve) => {
      if (stopped.signal.aborted) resolve();
      else stopped.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  } finally {
    clearTimeout(timer);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await handle.close();
  }
  if (json) runtime.stdout.write(`${JSON.stringify(successEnvelope({ event: "stopped" }))}\n`);
  return { envelope: successEnvelope({ event: "stopped" }), exitCode: ExitCode.Success, human: "", output: "stream" };
}
