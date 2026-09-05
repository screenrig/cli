import net from "node:net";
import { configError } from "../problems.js";
import { redactText } from "../redact.js";
import type { LogSink } from "./types.js";

const MAX_PENDING_LOG_BYTES = 1024 * 1024;
const LOG_CLOSE_TIMEOUT_MS = 5000;

class UnixSocketSink implements LogSink {
  private failed: Error | undefined;

  constructor(
    private readonly socket: net.Socket,
    private readonly socketPath: string,
  ) {
    this.socket.on("error", (err) => { this.failed = err; });
  }

  private writeError() {
    return configError(
      `Failed to write operation log to ${this.socketPath}: ${redactText(this.failed?.message ?? "socket closed")}. ` +
        "The consumer must already be listening and reading.",
    );
  }

  writeLine(line: string): void {
    if (this.failed || this.socket.destroyed) throw this.writeError();
    const payload = line.endsWith("\n") ? line : `${line}\n`;
    if (this.socket.writableLength + Buffer.byteLength(payload) > MAX_PENDING_LOG_BYTES) {
      this.failed = new Error("log consumer is not draining the bounded write buffer");
      this.socket.destroy();
      throw this.writeError();
    }
    // Socket end waits for all write callbacks. Keeping a Promise per completed
    // line would retain the entire history of a long-running events command.
    this.socket.write(payload, (err) => { if (err) this.failed = err; });
  }

  async close(): Promise<void> {
    if (this.failed) {
      this.socket.destroy();
      throw this.writeError();
    }
    if (this.socket.destroyed) return;
    try {
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timer);
          this.socket.removeListener("finish", onFinish);
          this.socket.removeListener("error", onError);
          this.socket.removeListener("close", onClose);
          if (error) reject(error);
          else if (this.failed) reject(this.writeError());
          else resolve();
        };
        const onFinish = () => finish();
        const onError = (error: Error) => finish(error);
        const onClose = () => finish(this.socket.writableFinished ? undefined : new Error("socket closed before log flush"));
        const timer = setTimeout(() => finish(new Error("log consumer did not drain before close timed out")), LOG_CLOSE_TIMEOUT_MS);
        this.socket.once("finish", onFinish);
        this.socket.once("error", onError);
        this.socket.once("close", onClose);
        this.socket.end();
      });
    } catch (error) {
      throw configError(
        `Failed to close log_socket ${this.socketPath}: ${redactText(error instanceof Error ? error.message : "socket close failed")}.`,
      );
    } finally {
      this.socket.destroy();
    }
  }
}

export async function connectUnixLogSocket(socketPath: string): Promise<LogSink> {
  return new Promise<LogSink>((resolve, reject) => {
    let settled = false;
    const socket = net.createConnection({ path: socketPath });
    const fail = (err: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      const code = (err as NodeJS.ErrnoException).code;
      const hint =
        code === "ENOENT" || code === "ECONNREFUSED"
          ? " The consumer must already be listening."
          : "";
      reject(
        configError(
          `Cannot connect to log_socket ${socketPath}: ${redactText(err.message)}.${hint}`,
        ),
      );
    };
    socket.once("error", fail);
    socket.once("connect", () => {
      if (settled) {
        return;
      }
      settled = true;
      socket.removeListener("error", fail);
      resolve(new UnixSocketSink(socket, socketPath));
    });
  });
}
