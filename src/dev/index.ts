import { createHash } from "node:crypto";
import type { Server } from "node:http";
import path from "node:path";
import { CliError, makeProblem, usageError } from "../problems.js";
import { ExitCode } from "../exit-codes.js";
import type { Hardware } from "./hardware.js";
import { FileKvStore, RemoteKvStore, type KvRead, type KvStore } from "./kv.js";
import { DEV_PORT, playerOrigin, releaseHostFor } from "./origins.js";
import { createDevServer } from "./server.js";
import { LoopbackUdp, type UdpTransport } from "./udp.js";
import { DevSession, type LogEntry } from "./session.js";
import { watchDirectory, type WatchHandle } from "./watcher.js";

export interface DevOptions {
  /** Absolute path of the application directory. */
  directory: string;
  port: number;
  /** The K/V file, absolute. Defaults to `.screenrig-dev/kv.json` in the directory. */
  kvFile?: string;
  /** Read this application's real store (read-only) instead of the file. */
  kvFrom?: { applicationId: string; read: KvRead };
  reload: boolean;
  print?: (entry: LogEntry) => void;
  hardware?: Hardware;
  /**
   * Where the application's UDP sockets bind. `app dev` binds real sockets on
   * 127.0.0.1 only (so a tool on this machine can talk to the application); a
   * session made without it simulates them and holds no socket.
   */
  udp?: UdpTransport;
  /** Tests listen on a port the runtime would not trust; the command itself never does. */
  allowAnyPort?: boolean;
}

export interface DevHandle {
  session: DevSession;
  server: Server;
  /** The harness page. */
  url: string;
  appUrl: string;
  releaseHost: string;
  kv: { mode: "file" | "remote"; location: string };
  watching: "events" | "poll";
  close(): Promise<void>;
}

/** The runtime trusts the development parent on one port only; another port would leave every application inert. */
export function assertDevPort(port: number): void {
  if (port !== DEV_PORT) {
    throw new CliError(makeProblem("unsupported_port", "Unsupported port", 400,
      `The runtime trusts the development harness as its parent only on port ${DEV_PORT}: an application served from port ${port} would refuse the handshake and run without the SDK.`, {
        hint: `Run without --port, or with --port ${DEV_PORT}. If ${DEV_PORT} is in use, stop the other app dev first.`,
        next: { command: "screenrig app dev ./DIRECTORY", reason: `Serves the application and the harness on port ${DEV_PORT}.` },
      }), ExitCode.Usage);
  }
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") reject(usageError(`Port ${port} on 127.0.0.1 is already in use. Stop the other process (another app dev?) and run the command again.`));
      else reject(error);
    });
    // Loopback only: the harness serves the developer's own files and drives a fake device.
    server.listen(port, "127.0.0.1", () => resolve());
  });
}

export interface CreatedSession {
  session: DevSession;
  releaseHost: string;
  kv: { mode: "file" | "remote"; location: string };
  /** The K/V file when the store is one, so the watcher can leave it alone. */
  kvFile: string | undefined;
  warn(message: string): void;
}

/**
 * Everything but the sockets: the K/V store, the session and its first build.
 * The server and the watcher are `startDevServer`'s; tests that drive the
 * bridge directly use this.
 */
export async function createDevSession(options: DevOptions): Promise<CreatedSession> {
  const releaseHost = releaseHostFor(options.directory);
  const tag = createHash("sha1").update(options.directory).digest("hex").slice(0, 12);
  const applicationId = options.kvFrom?.applicationId ?? `app_dev_${tag}`;
  let session: DevSession | undefined;
  const fileKv = options.kvFrom ? undefined : path.resolve(options.kvFile ?? path.join(options.directory, ".screenrig-dev", "kv.json"));
  let kv: KvStore;
  if (options.kvFrom) {
    kv = new RemoteKvStore(applicationId, options.kvFrom.read);
  } else {
    const store = new FileKvStore(fileKv!, applicationId, { onProblem: (message) => session?.record({ type: "kv.problem", level: "error", message }) });
    await store.open();
    kv = store;
  }
  const kvLocation = options.kvFrom ? applicationId : fileKv!;
  session = new DevSession({
    directory: options.directory, port: options.port, releaseHost, applicationId, releaseId: `rel_dev_${tag}`,
    kv, kvMode: options.kvFrom ? "remote" : "file", kvLocation, autoReload: options.reload,
    hardware: options.hardware, udp: options.udp, print: options.print,
  });
  await session.start();
  const warn = (message: string): void => { session!.record({ type: "harness.warning", level: "warn", message }); };
  if (fileKv) {
    const relative = path.relative(options.directory, fileKv);
    const inside = !relative.startsWith("..") && !path.isAbsolute(relative);
    if (inside && !relative.split(path.sep).some((part) => part.startsWith("."))) {
      warn(`The K/V file ${fileKv} is inside the application directory, so app pack would ship it. Keep it in a dot directory such as .screenrig-dev.`);
    }
  }
  return { session, releaseHost, kv: { mode: options.kvFrom ? "remote" : "file", location: kvLocation }, kvFile: fileKv, warn };
}

export async function startDevServer(options: DevOptions): Promise<DevHandle> {
  if (!options.allowAnyPort) assertDevPort(options.port);
  const { session, releaseHost, kv, kvFile, warn } = await createDevSession({ ...options, udp: options.udp ?? new LoopbackUdp() });
  const server = createDevServer(session);
  try {
    await listen(server, options.port);
  } catch (error) {
    await session.stop();
    throw error;
  }
  const watcher: WatchHandle = watchDirectory(options.directory, () => { void session.rebuild(); }, {
    ignore: (absolute) => kvFile !== undefined && absolute === kvFile,
    onWarning: warn,
  });
  return {
    session, server, url: `${playerOrigin(options.port)}/`, appUrl: session.frameSrc(), releaseHost, kv, watching: watcher.mode,
    async close() {
      watcher.close();
      await session.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => { server.close(() => resolve()); });
    },
  };
}
