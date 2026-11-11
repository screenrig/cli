import dgram from "node:dgram";

/**
 * The harness's UDP seam. An application's `device.udp` sockets bind through a
 * transport: the real one opens loopback sockets (127.0.0.1 only, so a tool on
 * this machine can send the application a datagram and hear what it sends back
 * to a loopback address), the simulated one holds no socket at all. Either way
 * a datagram addressed to any other host is recorded and shown, never
 * transmitted: the harness never reaches the network.
 */

export interface UdpPacket {
  fromHost: string;
  fromPort: number;
  data: Buffer;
}

export interface UdpBound {
  /** The port the socket holds: the one asked for, or the one the system chose for port 0. */
  readonly port: number;
  /** Sends one datagram; `delivered` says whether it left (loopback) or was only recorded. */
  send(host: string, port: number, data: Buffer): Promise<{ delivered: boolean; failed?: boolean }>;
  close(): void;
}

export type UdpBind = { ok: true; bound: UdpBound } | { ok: false; reason: "busy" | "failed"; detail: string };

export interface UdpTransport {
  readonly kind: "loopback" | "simulated";
  bind(request: { port: number }, onPacket: (packet: UdpPacket) => void): Promise<UdpBind>;
}

/** An address on this machine's loopback interface. */
export function isLoopbackHost(host: string): boolean {
  return host === "localhost" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/** No socket: binds always work, nothing is delivered. The conformance runs and the tests that must not touch the network use it. */
export class SimulatedUdp implements UdpTransport {
  readonly kind = "simulated" as const;
  constructor(private readonly busy: readonly number[] = []) {}

  async bind(request: { port: number }): Promise<UdpBind> {
    if (this.busy.includes(request.port)) return { ok: false, reason: "busy", detail: `Port ${request.port} is held by another process.` };
    return {
      ok: true,
      bound: { port: request.port, send: async () => ({ delivered: false }), close: () => undefined },
    };
  }
}

/** Binds on 127.0.0.1 with `node:dgram`. */
export class LoopbackUdp implements UdpTransport {
  readonly kind = "loopback" as const;

  bind(request: { port: number }, onPacket: (packet: UdpPacket) => void): Promise<UdpBind> {
    return new Promise((resolve) => {
      const socket = dgram.createSocket({ type: "udp4", reuseAddr: false });
      let settled = false;
      socket.once("error", (error: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        try { socket.close(); } catch { /* never opened */ }
        resolve({ ok: false, reason: error.code === "EADDRINUSE" || error.code === "EACCES" ? "busy" : "failed", detail: `${error.code ?? "error"}: ${error.message}` });
      });
      socket.once("listening", () => {
        settled = true;
        socket.on("error", () => undefined);
        socket.on("message", (data, remote) => onPacket({ fromHost: remote.address, fromPort: remote.port, data }));
        resolve({
          ok: true,
          bound: {
            port: socket.address().port,
            send: (host, port, data) => new Promise((done) => {
              if (!isLoopbackHost(host)) { done({ delivered: false }); return; }
              socket.send(data, port, "127.0.0.1", (error) => done(error === null ? { delivered: true } : { delivered: false, failed: true }));
            }),
            close: () => { try { socket.close(); } catch { /* already closed */ } },
          },
        });
      });
      socket.bind(request.port, "127.0.0.1");
    });
  }
}
