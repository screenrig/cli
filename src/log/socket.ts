import net from "node:net";
import { configError } from "../problems.js";
import { redactText } from "../redact.js";
import type { LogSink } from "./types.js";

class UnixSocketSink implements LogSink {
  private failed: Error | undefined;
  private readonly writes: Promise<void>[] = [];

  constructor(
    private readonly socket: net.Socket,
    private readonly socketPath: string,
  ) {
    this.socket.on("error", (err) => {
      this.failed = err;
    });
  }

  writeLine(line: string): void {
    if (this.failed) {
      throw configError(
        `Failed to write operation log to ${this.socketPath}: ${redactText(this.failed.message)}. ` +
          "The consumer must already be listening.",
      );
    }
    const payload = line.endsWith("\n") ? line : `${line}\n`;
    const write = new Promise<void>((resolve, reject) => {
      this.socket.write(payload, (err) => {
        if (err) {
          this.failed = err;
          reject(
            configError(
              `Failed to write operation log to ${this.socketPath}: ${redactText(err.message)}. ` +
                "The consumer must already be listening.",
            ),
          );
          return;
        }
        resolve();
      });
    });
    this.writes.push(write);
    void write.catch(() => undefined);
  }

  async close(): Promise<void> {
    if (this.writes.length > 0) {
      await Promise.all(this.writes);
    }
    if (this.socket.destroyed) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.socket.end(() => resolve());
      this.socket.once("error", reject);
    }).catch((err) => {
      throw configError(
        `Failed to close log_socket ${this.socketPath}: ${redactText(err instanceof Error ? err.message : "socket close failed")}.`,
      );
    });
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
