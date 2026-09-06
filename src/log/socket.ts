import net from "node:net";
import { configError } from "../problems.js";
import { redactText } from "../redact.js";
import type { LogSink } from "./types.js";

const MAX_PENDING_LOG_BYTES = 1024 * 1024;
const LOG_CLOSE_TIMEOUT_MS = 5000;

/** Counts every line and never writes. Used when connect fails. */
export class DroppingLogSink implements LogSink {
  private dropped = 0;

  writeLine(_line: string): void {
    this.dropped += 1;
  }

  async close(): Promise<void> {}

  droppedCount(): number {
    return this.dropped;
  }
}

class UnixSocketSink implements LogSink {
  private failed = false;
  private dropped = 0;

  constructor(private readonly socket: net.Socket) {
    this.socket.on("error", () => {
      this.failed = true;
    });
  }

  writeLine(line: string): void {
    if (this.failed || this.socket.destroyed) {
      this.dropped += 1;
      return;
    }
    const payload = line.endsWith("\n") ? line : `${line}\n`;
    if (this.socket.writableLength + Buffer.byteLength(payload) > MAX_PENDING_LOG_BYTES) {
      this.dropped += 1;
      return;
    }
    // Socket end waits for all write callbacks. Keeping a Promise per completed
    // line would retain the entire history of a long-running events command.
    this.socket.write(payload, (err) => {
      if (err) {
        this.failed = true;
      }
    });
  }

  droppedCount(): number {
    return this.dropped;
  }

  async close(): Promise<void> {
    if (this.socket.destroyed) {
      return;
    }
    try {
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          this.socket.removeListener("finish", onFinish);
          this.socket.removeListener("error", onError);
          this.socket.removeListener("close", onClose);
          resolve();
        };
        const onFinish = () => finish();
        const onError = () => finish();
        const onClose = () => finish();
        const timer = setTimeout(finish, LOG_CLOSE_TIMEOUT_MS);
        this.socket.once("finish", onFinish);
        this.socket.once("error", onError);
        this.socket.once("close", onClose);
        this.socket.end();
      });
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
      resolve(new UnixSocketSink(socket));
    });
  });
}
