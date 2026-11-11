import { randomBytes } from "node:crypto";
import {
  DEVICE_CHUNK_BYTES, MAX_BLE_SUBSCRIPTIONS, MAX_GPIO_PINS, MAX_IR_CODE, MAX_IR_REPEAT, MAX_PRINT_BYTES, MAX_SERIAL_PORTS, MAX_UDP_BYTES, MAX_UDP_SOCKETS, PLAYER_UDP_PORTS, PRINT_IDLE_MS,
  isRecord,
} from "./bridge-protocol.js";
import { BLE_UUID, HANDLE, SCAN_FORMATS, base64Length, pinLevel, unknownMembers, validDeviceId, type GpioPull, type Hardware, type PrintFormat, type PrinterSpec } from "./hardware.js";
import { isLoopbackHost, type UdpBound, type UdpPacket, type UdpTransport } from "./udp.js";

/** One answered request: a result for an ack, or the problem the hardware or the members earned. */
export type Outcome =
  | { ok: true; result?: unknown; /** What the host does next (bytes to echo, a line to drive); never on the wire. */ effect?: Record<string, unknown> }
  | { ok: false; code: string; status: number; detail: string; request_id?: string; current_revision?: number };

const ok = (result?: unknown, effect?: Record<string, unknown>): Outcome => ({ ok: true, ...(result === undefined ? {} : { result }), ...(effect === undefined ? {} : { effect }) });
const refuse = (code: string, status: number, detail: string): Outcome => ({ ok: false, code, status, detail });
const invalid = (detail: string): Outcome => refuse("invalid_request", 400, detail);

const BINDING = ["generation", "nonce"];

/** What an application did to the device, for the harness to show. */
export interface DeviceActivity {
  type: string;
  detail: Record<string, unknown>;
}

export interface OpenSerialPort {
  handle: string;
  port: string;
  failing?: boolean;
}

export interface BleSubscription {
  subscription: string;
  service: string;
  characteristic: string;
  device?: string;
}

interface PrintJob {
  id: string;
  nextSeq: number;
  format: PrintFormat;
  printer: PrinterSpec;
  total: number;
  chunks: Buffer[];
  received: number;
  touched: number;
}

export interface PrintedJob {
  job: string;
  printer: string;
  format: PrintFormat;
  bytes: number;
  failed: boolean;
  at: number;
  /** Text of an ESC/POS job with the control bytes replaced, or the first bytes of a PDF in hexadecimal. */
  preview: string;
}

export interface UdpSocketState {
  handle: string;
  /** The port the socket holds, `0` for none (a send-only socket the system gave a port). */
  port: number;
  broadcast: boolean;
  multicast?: string;
}

export interface UdpDatagram {
  direction: "sent" | "received";
  socket: string;
  /** The peer: where a sent datagram went, where a received one came from. */
  host: string;
  port: number;
  bytes: number;
  hex: string;
  text: string;
  /** A sent datagram that reached a loopback socket, or was only recorded because the harness never reaches the network. */
  delivered?: boolean;
  at: number;
}

export interface IrSent {
  encoding: "NEC";
  code: number;
  repeat: number;
  /** The frames handed to the emitter: the whole code `repeat` + 1 times, each as the four bytes that travel. */
  frames: number[][];
  at: number;
}

/**
 * The four bytes of a NEC frame as they travel. A code is the command in bits
 * 0 to 7 and the address in bits 8 to 23; the wire carries address bits 8 to
 * 15, address bits 16 to 23, the command and the command's complement, each
 * byte least significant bit first.
 */
export function necWire(code: number): number[] {
  const command = code & 0xff;
  return [(code >> 8) & 0xff, (code >> 16) & 0xff, command, command ^ 0xff];
}

/** The code of four wire bytes in hexadecimal, or the reason they are not a NEC frame. */
export function necFromWire(wire: string): number | string {
  if (!/^[0-9a-f]{8}$/i.test(wire)) return "wire is four bytes in hexadecimal";
  const [low, high, command, complement] = [0, 2, 4, 6].map((at) => parseInt(wire.slice(at, at + 2), 16)) as [number, number, number, number];
  if ((command ^ complement) !== 0xff) return "the last byte is not the complement of the command";
  return command | (low << 8) | (high << 16);
}

/** A line the page wrote that the Player lets go of: the level it drives and why. */
export interface GpioRelease {
  pin: number;
  value: boolean;
  cause: "leaving" | "context" | "destroyed";
  at: number;
}

/** An IPv4 literal, a `.local` name or a single-label LAN name; no DNS is consulted. */
export function validUdpHost(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 253) return false;
  const octets = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (octets) return octets.slice(1).every((part) => Number(part) <= 255);
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(value) || /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+local$/i.test(value);
}

function validPort(value: unknown, from: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= from && value <= 65535;
}

function validMulticast(value: unknown): value is string {
  const match = typeof value === "string" ? value.match(/^239\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/) : null;
  return match !== null && match.slice(1).every((part) => Number(part) <= 255);
}

function handleId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

function printable(bytes: Buffer, format: PrintFormat): string {
  if (format === "pdf") return bytes.subarray(0, 24).toString("hex");
  return bytes.toString("latin1").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "·").slice(0, 400);
}

export interface FrameState {
  scanning: boolean;
  ports: OpenSerialPort[];
  pins: number[];
  subscriptions: BleSubscription[];
  printed: PrintedJob[];
  /** The bias of each watched line that has one, by pin. */
  pull: Record<string, GpioPull>;
  /** What each line reads now, by pin. */
  levels: Record<string, boolean>;
  /** The level each line the page wrote is let go at, by pin. */
  idle: Record<string, boolean>;
  released: GpioRelease[];
  sockets: UdpSocketState[];
  datagrams: UdpDatagram[];
  udp_transport: "loopback" | "simulated";
  ir_sent: IrSent[];
}

/**
 * What one frame holds on the device: the open serial ports, the lines and
 * Bluetooth subscriptions it listens to, the scanner and the print job being
 * assembled. All of it ends with the frame's context.
 */
export class FrameDevice {
  scanning = false;
  readonly ports = new Map<string, OpenSerialPort>();
  watchedPins: number[] = [];
  readonly subscriptions = new Map<string, BleSubscription>();
  /** The bias of each watched line that has one; a line with no entry has none. */
  readonly pulls = new Map<number, GpioPull>();
  /** The lines the page wrote and the level each is let go at (the latest write's `idle`). */
  readonly written = new Map<number, boolean>();
  /** What the Player did when the page let go of lines, newest last. */
  readonly released: GpioRelease[] = [];
  readonly sockets = new Map<string, UdpSocketState>();
  /** The datagrams this frame sent and heard, newest last. */
  readonly datagrams: UdpDatagram[] = [];
  /** The codes this frame sent, newest last. */
  readonly irSent: IrSent[] = [];
  private job?: PrintJob;
  private readonly bindings = new Map<string, UdpBound>();
  private opening = 0;
  private epoch = 0;
  /** The jobs this frame printed, newest last. */
  readonly printed: PrintedJob[] = [];

  constructor(
    private readonly hardware: Hardware,
    private readonly clock: () => number,
    private readonly activity: (event: DeviceActivity) => void,
    private readonly udp: UdpTransport,
    private readonly heard: (handle: string, packet: UdpPacket) => void = () => undefined,
  ) {}

  /** The frame's context ended: everything it held goes. Lines it wrote are let go first (`releaseLines`). */
  reset(): void {
    this.epoch += 1;
    this.scanning = false;
    this.ports.clear();
    this.watchedPins = [];
    this.pulls.clear();
    this.written.clear();
    this.subscriptions.clear();
    for (const binding of this.bindings.values()) binding.close();
    this.bindings.clear();
    this.sockets.clear();
    this.job = undefined;
  }

  get udpKind(): "loopback" | "simulated" {
    return this.udp.kind;
  }

  // Scanner.

  scannerStart(payload: Record<string, unknown>): Outcome {
    if (unknownMembers(payload, [...BINDING, "formats"]).length > 0) return invalid("device.scanner.start takes only formats.");
    let wanted: string[] | undefined;
    if (payload.formats !== undefined) {
      const formats = payload.formats;
      if (!Array.isArray(formats) || formats.length < 1 || formats.length > SCAN_FORMATS.length) return invalid("formats is 1 to 13 symbology names.");
      if (formats.some((name) => typeof name !== "string" || !(SCAN_FORMATS as readonly string[]).includes(name))) return invalid("formats names an unknown symbology.");
      if (new Set(formats).size !== formats.length) return invalid("formats repeats a symbology.");
      wanted = formats as string[];
    }
    if (!this.hardware.camera.available) return refuse("camera_unavailable", 503, "The device has no camera the page may use.");
    const decoded = (wanted ?? this.hardware.camera.formats).filter((name) => this.hardware.camera.formats.includes(name));
    if (decoded.length > 0) this.scanning = true;
    this.activity({ type: "device.scanner.start", detail: { formats: decoded } });
    return ok({ formats: decoded });
  }

  scannerStop(): Outcome {
    this.scanning = false;
    this.activity({ type: "device.scanner.stop", detail: {} });
    return ok();
  }

  // Serial.

  serialList(): Outcome {
    const ports = this.hardware.serial.ports.slice(0, 16).map((port) => ({
      id: port.id, name: port.name,
      ...(port.vendor_id === undefined ? {} : { vendor_id: port.vendor_id }),
      ...(port.product_id === undefined ? {} : { product_id: port.product_id }),
    }));
    return ok({ ports });
  }

  serialOpen(payload: Record<string, unknown>): Outcome {
    if (unknownMembers(payload, [...BINDING, "port", "baud_rate", "data_bits", "stop_bits", "parity", "flow_control"]).length > 0) return invalid("device.serial.open takes port and the line settings only.");
    if (!validDeviceId(payload.port)) return invalid("port must be a port id.");
    const baud = payload.baud_rate;
    if (typeof baud !== "number" || !Number.isInteger(baud) || baud < 50 || baud > 4_000_000) return invalid("baud_rate is an integer from 50 to 4000000.");
    if (payload.data_bits !== undefined && ![5, 6, 7, 8].includes(payload.data_bits as number)) return invalid("data_bits is 5, 6, 7 or 8.");
    if (payload.stop_bits !== undefined && ![1, 2].includes(payload.stop_bits as number)) return invalid("stop_bits is 1 or 2.");
    if (payload.parity !== undefined && !["none", "even", "odd"].includes(payload.parity as string)) return invalid("parity is none, even or odd.");
    if (payload.flow_control !== undefined && !["none", "hardware"].includes(payload.flow_control as string)) return invalid("flow_control is none or hardware.");
    const spec = this.hardware.serial.ports.find((port) => port.id === payload.port);
    if (!spec) return refuse("port_not_found", 404, `No serial port is named ${payload.port}.`);
    if (spec.busy || [...this.ports.values()].some((open) => open.port === spec.id)) return refuse("port_busy", 409, `${spec.id} is held by another process.`);
    if (this.ports.size >= MAX_SERIAL_PORTS) return refuse("port_limit", 409, "A frame holds at most 4 open ports.");
    const handle = handleId("ser");
    this.ports.set(handle, { handle, port: spec.id });
    this.activity({ type: "device.serial.open", detail: { port: spec.id, handle, baud_rate: baud, data_bits: payload.data_bits ?? 8, stop_bits: payload.stop_bits ?? 1, parity: payload.parity ?? "none", flow_control: payload.flow_control ?? "none" } });
    return ok({ handle });
  }

  /** The bytes of a write that was accepted; `echo` says the simulated device answers with the same bytes. */
  serialWrite(payload: Record<string, unknown>): Outcome {
    if (unknownMembers(payload, [...BINDING, "handle", "data_base64"]).length > 0) return invalid("device.serial.write takes handle and data_base64 only.");
    if (typeof payload.handle !== "string" || payload.handle.length === 0) return invalid("handle must be a serial handle.");
    const length = base64Length(payload.data_base64);
    if (length === undefined || length < 1) return invalid("data_base64 must be 1 or more bytes of base64.");
    if (length > DEVICE_CHUNK_BYTES) return refuse("payload_too_large", 413, "A write is at most 32768 bytes.");
    const port = this.ports.get(payload.handle);
    if (!port) return refuse("invalid_handle", 404, "This frame holds no open port with that handle.");
    if (port.failing) return refuse("io_failed", 502, `${port.port} failed the write.`);
    const bytes = Buffer.from(payload.data_base64 as string, "base64");
    this.activity({ type: "device.serial.write", detail: { port: port.port, handle: port.handle, bytes: bytes.length, hex: bytes.subarray(0, 64).toString("hex"), text: bytes.subarray(0, 64).toString("latin1").replace(/[^\x20-\x7e]/g, ".") } });
    const echo = this.hardware.serial.ports.find((spec) => spec.id === port.port)?.echo ? port.handle : undefined;
    return ok(undefined, { bytes, ...(echo === undefined ? {} : { echo }) });
  }

  serialClose(payload: Record<string, unknown>): Outcome {
    if (typeof payload.handle === "string" && this.ports.delete(payload.handle)) this.activity({ type: "device.serial.close", detail: { handle: payload.handle } });
    return ok();
  }

  // GPIO.

  /** `idleOk` is whether the host advertises `device.gpio.idle`, which makes `idle` a member of the write. */
  gpioWrite(payload: Record<string, unknown>, idleOk: boolean): Outcome {
    if (unknownMembers(payload, [...BINDING, "pin", "value", ...(idleOk ? ["idle"] : [])]).length > 0) return invalid(idleOk ? "device.gpio.write takes pin, value and idle only." : "device.gpio.write takes pin and value only.");
    const pin = payload.pin;
    if (typeof pin !== "number" || !Number.isInteger(pin) || pin < 0 || pin > 255) return invalid("pin is an integer from 0 to 255.");
    if (typeof payload.value !== "boolean") return invalid("value must be true or false.");
    if (payload.idle !== undefined && typeof payload.idle !== "boolean") return invalid("idle must be true or false.");
    const problem = this.gpioProblem([pin]);
    if (problem) return problem;
    const idle = idleOk ? payload.idle ?? false : undefined;
    // Only a host with idle lets go at a level; without it the line stays where it was last driven.
    if (idle !== undefined) this.written.set(pin, idle);
    this.activity({ type: "device.gpio.write", detail: { pin, value: payload.value, ...(idle === undefined ? {} : { idle }) } });
    return ok(undefined, { pin, value: payload.value });
  }

  /** What a line reads now, by the bias the frame requested it with. */
  gpioLevel(pin: number): boolean | undefined {
    const spec = this.hardware.gpio.pins.find((candidate) => candidate.pin === pin);
    return spec === undefined ? undefined : pinLevel(spec, this.pulls.get(pin));
  }

  /** Something drives a line to a level: an output the page wrote, or the outside (a button, a signal). */
  gpioDrive(pin: number, value: boolean): void {
    const spec = this.hardware.gpio.pins.find((candidate) => candidate.pin === pin);
    if (!spec) return;
    spec.value = spec.floating === true ? spec.value : value;
    if (spec.floating === true) spec.driven = value;
  }

  /** The outside lets go of a line: it floats to its bias again. */
  gpioFloat(pin: number): void {
    const spec = this.hardware.gpio.pins.find((candidate) => candidate.pin === pin);
    if (spec) spec.driven = undefined;
  }

  /**
   * The page lets go: each line it wrote is driven to its idle level, in
   * ascending pin order, and released. What was driven is returned and kept for
   * the panel.
   */
  releaseLines(cause: GpioRelease["cause"]): Array<{ pin: number; value: boolean }> {
    const drives = [...this.written.entries()].sort(([left], [right]) => left - right).map(([pin, value]) => ({ pin, value }));
    this.written.clear();
    for (const { pin, value } of drives) {
      const spec = this.hardware.gpio.pins.find((candidate) => candidate.pin === pin);
      if (spec) {
        spec.value = value;
        // Released, a line nothing is connected to floats again.
        spec.driven = undefined;
      }
      this.released.push({ pin, value, cause, at: this.clock() });
      if (this.released.length > 20) this.released.shift();
      this.activity({ type: "device.gpio.release", detail: { pin, value, cause } });
    }
    return drives;
  }

  private gpioProblem(pins: number[]): Outcome | undefined {
    if (!this.hardware.gpio.chip) return refuse("gpio_unavailable", 503, "The device has no GPIO chip the Player can open.");
    for (const pin of pins) {
      const spec = this.hardware.gpio.pins.find((candidate) => candidate.pin === pin);
      if (!spec) return refuse("pin_not_found", 404, `The device has no line ${pin}.`);
      if (spec.busy) return refuse("pin_busy", 409, `Line ${pin} is held by another process.`);
    }
    return undefined;
  }

  /**
   * `watching` is whether the frame's latest device.watch names gpio; `pullOk`
   * whether the host advertises `device.gpio.pull`, which makes `pull` a member.
   * The effect lists the lines to post: each one newly in the set and each whose
   * level changed because its bias did.
   */
  gpioWatch(payload: Record<string, unknown>, watching: boolean, pullOk: boolean): Outcome {
    if (unknownMembers(payload, [...BINDING, "pins", ...(pullOk ? ["pull"] : [])]).length > 0) return invalid(pullOk ? "device.gpio.watch takes pins and pull only." : "device.gpio.watch takes pins only.");
    const pins = payload.pins;
    if (!Array.isArray(pins) || pins.length > MAX_GPIO_PINS || pins.some((pin) => typeof pin !== "number" || !Number.isInteger(pin) || pin < 0 || pin > 255) || new Set(pins).size !== pins.length) {
      return invalid("pins is at most 16 distinct integers from 0 to 255.");
    }
    const pulls = new Map<number, GpioPull>();
    if (payload.pull !== undefined) {
      if (!isRecord(payload.pull)) return invalid("pull is an object keyed by pin.");
      for (const [key, value] of Object.entries(payload.pull)) {
        if (!/^(?:0|[1-9]\d{0,2})$/.test(key) || !(pins as number[]).includes(Number(key))) return invalid(`pull names ${key.slice(0, 12)}, which is not a pin in pins.`);
        if (value !== "up" && value !== "down" && value !== "none") return invalid("pull is up, down or none.");
        if (value !== "none") pulls.set(Number(key), value);
      }
    }
    if (!watching) return invalid("device.gpio.watch follows a device.watch that names gpio.");
    const problem = this.gpioProblem(pins as number[]);
    if (problem) return problem;
    const before = new Map(this.watchedPins.map((pin) => [pin, this.gpioLevel(pin)]));
    this.watchedPins = [...(pins as number[])];
    this.pulls.clear();
    for (const [pin, pull] of pulls) this.pulls.set(pin, pull);
    const post = this.watchedPins.filter((pin) => !before.has(pin) || before.get(pin) !== this.gpioLevel(pin));
    this.activity({ type: "device.gpio.watch", detail: { pins: this.watchedPins, ...(pulls.size > 0 ? { pull: Object.fromEntries([...pulls].map(([pin, pull]) => [String(pin), pull])) } : {}) } });
    return ok({ pins: this.watchedPins }, { post });
  }

  // Infrared.

  /** The page sends one NEC code. */
  irSend(payload: Record<string, unknown>): Outcome {
    if (unknownMembers(payload, [...BINDING, "encoding", "code", "repeat"]).length > 0) return invalid("device.ir.send takes encoding, code and repeat only.");
    if (payload.encoding !== "NEC") return invalid("encoding is NEC.");
    const code = payload.code;
    if (typeof code !== "number" || !Number.isInteger(code) || code < 0 || code > MAX_IR_CODE) return invalid("code is a whole number from 0 to 16777215 (0xFFFFFF).");
    const repeat = payload.repeat;
    if (repeat !== undefined && (typeof repeat !== "number" || !Number.isInteger(repeat) || repeat < 0 || repeat > MAX_IR_REPEAT)) return invalid("repeat is a whole number from 0 to 10.");
    if (!this.hardware.ir.emitter) return refuse("ir_unavailable", 503, "The device has no infrared emitter the page may use.");
    const frames = Array.from({ length: (repeat ?? 0) + 1 }, () => necWire(code));
    const sent: IrSent = { encoding: "NEC", code, repeat: repeat ?? 0, frames, at: this.clock() };
    this.irSent.push(sent);
    if (this.irSent.length > 20) this.irSent.shift();
    this.activity({ type: "device.ir.send", detail: { encoding: sent.encoding, code, hex: `0x${code.toString(16).toUpperCase().padStart(6, "0")}`, repeat: sent.repeat, wire: frames[0]!.map((byte) => byte.toString(16).padStart(2, "0")).join(""), frames: frames.length } });
    return ok();
  }

  // UDP.

  /** Opens a socket; `port` 0 is a send-only socket. The socket ends with the frame's context. */
  async udpOpen(payload: Record<string, unknown>): Promise<Outcome> {
    if (unknownMembers(payload, [...BINDING, "port", "broadcast", "multicast"]).length > 0) return invalid("device.udp.open takes port, broadcast and multicast only.");
    const port = payload.port;
    if (typeof port !== "number" || !Number.isInteger(port) || (port !== 0 && !validPort(port, 1024))) return invalid("port is 0 or a whole number from 1024 to 65535.");
    if (payload.broadcast !== undefined && typeof payload.broadcast !== "boolean") return invalid("broadcast must be true or false.");
    if (payload.multicast !== undefined && !validMulticast(payload.multicast)) return invalid("multicast is an address of the form 239.x.x.x.");
    if (port === 0 && payload.multicast !== undefined) return invalid("multicast needs a port to bind.");
    if (PLAYER_UDP_PORTS.includes(port)) return refuse("port_busy", 409, `Port ${port} is the Player's own.`);
    if (port !== 0 && [...this.sockets.values()].some((open) => open.port === port)) return refuse("port_busy", 409, `This frame holds port ${port} already.`);
    if (this.sockets.size + this.opening >= MAX_UDP_SOCKETS) return refuse("socket_limit", 409, "A frame holds at most 4 UDP sockets.");
    const epoch = this.epoch;
    this.opening += 1;
    const handle = handleId("udp");
    let bind;
    try {
      bind = await this.udp.bind({ port }, (packet) => this.heard(handle, packet));
    } finally {
      this.opening -= 1;
    }
    if (!bind.ok) return refuse(bind.reason === "busy" ? "port_busy" : "io_failed", bind.reason === "busy" ? 409 : 502, bind.detail);
    if (epoch !== this.epoch) {
      // The context ended while the socket was being bound: nobody holds it.
      bind.bound.close();
      return refuse("invalid_request", 400, "The context ended before the socket opened.");
    }
    const state: UdpSocketState = { handle, port: port === 0 ? 0 : bind.bound.port, broadcast: payload.broadcast === true, ...(payload.multicast === undefined ? {} : { multicast: payload.multicast as string }) };
    this.sockets.set(handle, state);
    this.bindings.set(handle, bind.bound);
    this.activity({ type: "device.udp.open", detail: { socket: handle, port: state.port, broadcast: state.broadcast, ...(state.multicast ? { multicast: state.multicast } : {}), transport: this.udp.kind } });
    return ok({ socket: handle });
  }

  async udpSend(payload: Record<string, unknown>): Promise<Outcome> {
    if (unknownMembers(payload, [...BINDING, "socket", "host", "port", "data_base64"]).length > 0) return invalid("device.udp.send takes socket, host, port and data_base64 only.");
    if (typeof payload.socket !== "string" || payload.socket.length === 0) return invalid("socket must be a socket handle.");
    if (!validUdpHost(payload.host)) return invalid("host is an IPv4 address, a .local name or a LAN name.");
    if (!validPort(payload.port, 1)) return invalid("port is a whole number from 1 to 65535.");
    const length = base64Length(payload.data_base64);
    if (length === undefined || length < 1) return invalid("data_base64 must be 1 or more bytes of base64.");
    if (length > MAX_UDP_BYTES) return refuse("payload_too_large", 413, "A datagram is at most 8192 bytes.");
    const binding = this.bindings.get(payload.socket);
    const socket = this.sockets.get(payload.socket);
    if (!binding || !socket) return refuse("invalid_handle", 404, "This frame holds no open socket with that handle.");
    const bytes = Buffer.from(payload.data_base64 as string, "base64");
    const result = await binding.send(payload.host, payload.port, bytes);
    if (result.failed) return refuse("io_failed", 502, "The network refused the datagram.");
    this.noteDatagram({ direction: "sent", socket: socket.handle, host: payload.host, port: payload.port, bytes, delivered: result.delivered });
    return ok();
  }

  /** The operating system closed a socket on its own: it is gone. */
  udpEnded(handle: string): void {
    this.sockets.delete(handle);
    this.bindings.get(handle)?.close();
    this.bindings.delete(handle);
    this.activity({ type: "device.udp.closed", detail: { socket: handle, reason: "error" } });
  }

  /** For the conformance fixtures: a socket the frame already holds, which may fail its sends. */
  restoreSocket(state: UdpSocketState, failing: boolean): void {
    this.sockets.set(state.handle, state);
    this.bindings.set(state.handle, { port: state.port, send: async () => (failing ? { delivered: false, failed: true } : { delivered: false }), close: () => undefined });
  }

  udpClose(payload: Record<string, unknown>): Outcome {
    if (typeof payload.socket === "string" && this.sockets.delete(payload.socket)) {
      this.bindings.get(payload.socket)?.close();
      this.bindings.delete(payload.socket);
      this.activity({ type: "device.udp.close", detail: { socket: payload.socket } });
    }
    return ok();
  }

  /** A datagram the frame heard, for the panel's list. */
  noteHeard(handle: string, host: string, port: number, bytes: Buffer): void {
    this.noteDatagram({ direction: "received", socket: handle, host, port, bytes });
  }

  private noteDatagram(input: { direction: "sent" | "received"; socket: string; host: string; port: number; bytes: Buffer; delivered?: boolean }): void {
    const { bytes } = input;
    const entry: UdpDatagram = {
      direction: input.direction, socket: input.socket, host: input.host, port: input.port, bytes: bytes.length,
      hex: bytes.subarray(0, 64).toString("hex"), text: bytes.subarray(0, 64).toString("latin1").replace(/[^\x20-\x7e]/g, "."),
      ...(input.delivered === undefined ? {} : { delivered: input.delivered }), at: this.clock(),
    };
    this.datagrams.push(entry);
    if (this.datagrams.length > 30) this.datagrams.shift();
    this.activity({
      type: input.direction === "sent" ? "device.udp.send" : "device.udp.receive",
      detail: { socket: entry.socket, [input.direction === "sent" ? "to" : "from"]: `${entry.host}:${entry.port}`, bytes: entry.bytes, hex: entry.hex, text: entry.text, ...(entry.delivered === undefined ? {} : { delivered: entry.delivered ? "loopback" : isLoopbackHost(entry.host) ? "failed" : "recorded only: the harness never reaches the network" }) },
    });
  }

  // Bluetooth LE.

  private bleTarget(payload: Record<string, unknown>): { service: string; characteristic: string; device?: string } | Outcome {
    if (unknownMembers(payload, [...BINDING, "service", "characteristic", "device"]).length > 0) return invalid("A Bluetooth target is service, characteristic and device only.");
    if (typeof payload.service !== "string" || !BLE_UUID.test(payload.service)) return invalid("service must be a lower case 4, 8 or 36 character UUID.");
    if (typeof payload.characteristic !== "string" || !BLE_UUID.test(payload.characteristic)) return invalid("characteristic must be a lower case 4, 8 or 36 character UUID.");
    if (payload.device !== undefined && (typeof payload.device !== "string" || payload.device.length < 1 || payload.device.length > 64)) return invalid("device is an advertised name or an address of 1 to 64 characters.");
    return { service: payload.service, characteristic: payload.characteristic, ...(payload.device === undefined ? {} : { device: payload.device as string }) };
  }

  private bleFind(target: { service: string; characteristic: string; device?: string }): Outcome | { characteristic: { characteristic: string; value_base64: string } } {
    if (!this.hardware.ble.adapter) return refuse("ble_unavailable", 503, "The device has no Bluetooth adapter the page may use.");
    const wanted = target.device?.toLowerCase();
    const peripheral = this.hardware.ble.peripherals.find((candidate) =>
      (wanted === undefined || candidate.name.toLowerCase() === wanted || candidate.address.toLowerCase() === wanted)
      && candidate.services.some((service) => service.service === target.service));
    if (!peripheral) return refuse("device_not_found", 404, target.device ? `No peripheral ${target.device} advertises ${target.service}.` : `No peripheral advertises ${target.service}.`);
    const characteristic = peripheral.services.find((service) => service.service === target.service)?.characteristics.find((candidate) => candidate.characteristic === target.characteristic);
    if (!characteristic) return refuse("characteristic_not_found", 404, `${peripheral.name} has no characteristic ${target.characteristic} in ${target.service}.`);
    return { characteristic };
  }

  bleRead(payload: Record<string, unknown>): Outcome {
    const target = this.bleTarget(payload);
    if ("ok" in target) return target;
    const found = this.bleFind(target);
    if ("ok" in found) return found;
    this.activity({ type: "device.ble.read", detail: { ...target } });
    return ok({ value_base64: found.characteristic.value_base64 });
  }

  bleWatch(payload: Record<string, unknown>, watching: boolean): Outcome {
    const target = this.bleTarget(payload);
    if ("ok" in target) return target;
    if (!watching) return invalid("device.ble.watch follows a device.watch that names ble.");
    const found = this.bleFind(target);
    if ("ok" in found) return found;
    if (this.subscriptions.size >= MAX_BLE_SUBSCRIPTIONS) return refuse("subscription_limit", 409, "A frame holds at most 8 subscriptions.");
    const subscription = handleId("ble");
    this.subscriptions.set(subscription, { subscription, ...target });
    this.activity({ type: "device.ble.watch", detail: { subscription, ...target } });
    return ok({ subscription });
  }

  bleUnwatch(payload: Record<string, unknown>): Outcome {
    if (typeof payload.subscription === "string" && this.subscriptions.delete(payload.subscription)) this.activity({ type: "device.ble.unwatch", detail: { subscription: payload.subscription } });
    return ok();
  }

  // Printing.

  printers(): Outcome {
    return ok({ printers: this.hardware.printers.slice(0, 16).map((printer) => ({ id: printer.id, name: printer.name, formats: printer.formats, ...(printer.default ? { default: true } : {}) })) });
  }

  /** One chunk of a job. The job is assembled per frame; an idle one is discarded. */
  print(payload: Record<string, unknown>): Outcome {
    const now = this.clock();
    if (this.job && now - this.job.touched > PRINT_IDLE_MS) this.job = undefined;
    if (unknownMembers(payload, [...BINDING, "job", "seq", "last", "data_base64", "format", "total_bytes", "printer"]).length > 0) return invalid("device.print takes job, seq, last, data_base64, format, total_bytes and printer only.");
    const length = base64Length(payload.data_base64);
    if (length !== undefined && length > DEVICE_CHUNK_BYTES) return refuse("payload_too_large", 413, "A chunk is at most 32768 bytes.");
    if (typeof payload.job !== "string" || !HANDLE.test(payload.job)) return invalid("job must be 8 to 64 of A-Z a-z 0-9 _ -.");
    if (typeof payload.seq !== "number" || !Number.isInteger(payload.seq) || payload.seq < 0) return invalid("seq must be a whole number from 0.");
    if (typeof payload.last !== "boolean") return invalid("last must be true or false.");
    if (length === undefined || length < 1) return invalid("data_base64 must be 1 to 32768 bytes of base64.");
    const data = Buffer.from(payload.data_base64 as string, "base64");
    if (payload.seq === 0) {
      if (payload.format !== "escpos" && payload.format !== "pdf") return invalid("The first chunk carries format escpos or pdf.");
      const total = payload.total_bytes;
      if (typeof total !== "number" || !Number.isInteger(total) || total < 1) return invalid("The first chunk carries total_bytes, a whole number from 1.");
      if (total > MAX_PRINT_BYTES) return refuse("payload_too_large", 413, "A job is at most 4194304 bytes.");
      if (payload.printer !== undefined && !validDeviceId(payload.printer)) return invalid("printer must be a printer id.");
      let printer: PrinterSpec | undefined;
      if (payload.printer !== undefined) {
        printer = this.hardware.printers.find((candidate) => candidate.id === payload.printer);
        if (!printer) return refuse("printer_not_found", 404, `No printer is named ${payload.printer}.`);
        if (!printer.formats.includes(payload.format)) return invalid(`${printer.id} does not print ${payload.format}.`);
      } else {
        const capable = this.hardware.printers.filter((candidate) => candidate.formats.includes(payload.format as PrintFormat));
        printer = capable.find((candidate) => candidate.default) ?? capable[0];
        if (!printer) return refuse("printer_not_found", 404, `No printer prints ${payload.format}.`);
      }
      this.job = { id: payload.job, nextSeq: 0, format: payload.format, printer, total, chunks: [], received: 0, touched: now };
    } else {
      if (payload.format !== undefined || payload.total_bytes !== undefined || payload.printer !== undefined) return invalid("Only the first chunk carries format, total_bytes and printer.");
      if (!this.job || this.job.id !== payload.job) { this.job = undefined; return invalid("This chunk does not continue the job in progress."); }
    }
    const job = this.job!;
    if (payload.seq !== job.nextSeq) { this.job = undefined; return invalid(`Expected chunk ${job.nextSeq} of the job, got ${payload.seq}.`); }
    job.chunks.push(data);
    job.received += data.length;
    job.nextSeq += 1;
    job.touched = now;
    if (job.received > job.total) { this.job = undefined; return invalid("The chunks add up to more than total_bytes."); }
    if (payload.last === false) return ok();
    this.job = undefined;
    if (job.received !== job.total) return invalid("The chunks do not add up to total_bytes.");
    const bytes = Buffer.concat(job.chunks);
    const failed = job.printer.failing === true;
    this.printed.push({ job: job.id, printer: job.printer.id, format: job.format, bytes: bytes.length, failed, at: now, preview: printable(bytes, job.format) });
    if (this.printed.length > 20) this.printed.shift();
    this.activity({ type: "device.print", detail: { job: job.id, printer: job.printer.id, format: job.format, bytes: bytes.length, failed } });
    if (failed) return refuse("print_failed", 502, `${job.printer.name} accepted the job and failed it.`);
    return ok();
  }

  /** The state of the frame's hardware in the fixtures' `host.hardware` shape (open ports, watched lines, subscriptions, scanner), and what the panel adds. */
  state(): FrameState {
    return {
      scanning: this.scanning, ports: [...this.ports.values()], pins: this.watchedPins, subscriptions: [...this.subscriptions.values()], printed: this.printed,
      pull: Object.fromEntries([...this.pulls].map(([pin, pull]) => [String(pin), pull])),
      levels: Object.fromEntries(this.hardware.gpio.pins.map((spec) => [String(spec.pin), pinLevel(spec, this.pulls.get(spec.pin))])),
      idle: Object.fromEntries([...this.written].map(([pin, idle]) => [String(pin), idle])),
      released: this.released,
      sockets: [...this.sockets.values()], datagrams: this.datagrams, udp_transport: this.udp.kind, ir_sent: this.irSent,
    };
  }
}
