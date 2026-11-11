import { randomBytes } from "node:crypto";
import { DEVICE_CHUNK_BYTES, MAX_BLE_SUBSCRIPTIONS, MAX_GPIO_PINS, MAX_PRINT_BYTES, MAX_SERIAL_PORTS, PRINT_IDLE_MS } from "./bridge-protocol.js";
import { BLE_UUID, HANDLE, SCAN_FORMATS, base64Length, unknownMembers, validDeviceId, type Hardware, type PrintFormat, type PrinterSpec } from "./hardware.js";

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

function handleId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

function printable(bytes: Buffer, format: PrintFormat): string {
  if (format === "pdf") return bytes.subarray(0, 24).toString("hex");
  return bytes.toString("latin1").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "·").slice(0, 400);
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
  private job?: PrintJob;
  /** The jobs this frame printed, newest last. */
  readonly printed: PrintedJob[] = [];

  constructor(private readonly hardware: Hardware, private readonly clock: () => number, private readonly activity: (event: DeviceActivity) => void) {}

  reset(): void {
    this.scanning = false;
    this.ports.clear();
    this.watchedPins = [];
    this.subscriptions.clear();
    this.job = undefined;
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

  gpioWrite(payload: Record<string, unknown>): Outcome {
    if (unknownMembers(payload, [...BINDING, "pin", "value"]).length > 0) return invalid("device.gpio.write takes pin and value only.");
    const pin = payload.pin;
    if (typeof pin !== "number" || !Number.isInteger(pin) || pin < 0 || pin > 255) return invalid("pin is an integer from 0 to 255.");
    if (typeof payload.value !== "boolean") return invalid("value must be true or false.");
    const problem = this.gpioProblem([pin]);
    if (problem) return problem;
    const spec = this.hardware.gpio.pins.find((candidate) => candidate.pin === pin)!;
    this.activity({ type: "device.gpio.write", detail: { pin, value: payload.value } });
    return ok(undefined, { pin, value: payload.value, changed: spec.value !== payload.value });
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

  /** `watching` is whether the frame's latest device.watch names gpio. */
  gpioWatch(payload: Record<string, unknown>, watching: boolean): Outcome {
    if (unknownMembers(payload, [...BINDING, "pins"]).length > 0) return invalid("device.gpio.watch takes pins only.");
    const pins = payload.pins;
    if (!Array.isArray(pins) || pins.length > MAX_GPIO_PINS || pins.some((pin) => typeof pin !== "number" || !Number.isInteger(pin) || pin < 0 || pin > 255) || new Set(pins).size !== pins.length) {
      return invalid("pins is at most 16 distinct integers from 0 to 255.");
    }
    if (!watching) return invalid("device.gpio.watch follows a device.watch that names gpio.");
    const problem = this.gpioProblem(pins as number[]);
    if (problem) return problem;
    const added = (pins as number[]).filter((pin) => !this.watchedPins.includes(pin));
    this.watchedPins = [...(pins as number[])];
    this.activity({ type: "device.gpio.watch", detail: { pins: this.watchedPins } });
    return ok({ pins: this.watchedPins }, { added });
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

  /** The state of the frame's hardware in the fixtures' `host.hardware` shape (open ports, watched lines, subscriptions, scanner). */
  state(): { scanning: boolean; ports: OpenSerialPort[]; pins: number[]; subscriptions: BleSubscription[]; printed: PrintedJob[] } {
    return { scanning: this.scanning, ports: [...this.ports.values()], pins: this.watchedPins, subscriptions: [...this.subscriptions.values()], printed: this.printed };
  }
}
