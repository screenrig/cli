/**
 * The simulated device the harness presents to the application: the serial
 * ports, GPIO lines, Bluetooth peripherals, printers and camera of the
 * contract's shared example device. The shapes are the conformance fixtures'
 * `host.hardware`.
 */
export interface SerialPortSpec {
  id: string;
  name: string;
  vendor_id?: number;
  product_id?: number;
  /** Another process holds the port: it is listed and cannot be opened. */
  busy?: boolean;
  /** The simulated device on the port answers every write with the same bytes. */
  echo?: boolean;
}

export interface PinSpec {
  pin: number;
  /** The level of the line: what an output drives and what a line with something connected reads. */
  value: boolean;
  busy?: boolean;
  /** Nothing is connected: the line reads its pull (up is high, down is low) and, with none, its `value`. */
  floating?: boolean;
  /** What something outside drives a floating line to (a button pressed to ground), until it is released. */
  driven?: boolean;
}

/** The bias the Player sets on an input line. */
export type GpioPull = "up" | "down" | "none";

/** What a line reads, given the bias it was requested with. */
export function pinLevel(spec: PinSpec, pull: GpioPull | undefined): boolean {
  if (spec.floating !== true) return spec.value;
  if (spec.driven !== undefined) return spec.driven;
  return pull === "up" ? true : pull === "down" ? false : spec.value;
}

export interface BleCharacteristicSpec {
  characteristic: string;
  value_base64: string;
}

export interface BleServiceSpec {
  service: string;
  characteristics: BleCharacteristicSpec[];
}

export interface PeripheralSpec {
  name: string;
  address: string;
  services: BleServiceSpec[];
}

export type PrintFormat = "escpos" | "pdf";

export interface PrinterSpec {
  id: string;
  name: string;
  formats: PrintFormat[];
  default?: boolean;
  /** The printer accepts a job and fails it. */
  failing?: boolean;
}

export interface Hardware {
  camera: { available: boolean; formats: string[] };
  serial: { ports: SerialPortSpec[] };
  gpio: { pins: PinSpec[]; chip: boolean };
  ir: { available: boolean };
  ble: { adapter: boolean; peripherals: PeripheralSpec[] };
  printers: PrinterSpec[];
}

export const SCAN_FORMATS = ["qr", "ean13", "ean8", "upca", "upce", "code128", "code39", "code93", "itf", "codabar", "datamatrix", "pdf417", "aztec"] as const;

/** The contract's shared example device. */
export function defaultHardware(): Hardware {
  return {
    camera: { available: true, formats: ["qr", "ean13", "upca", "code128"] },
    serial: {
      ports: [
        { id: "ttyUSB0", name: "FT232R USB UART", vendor_id: 1027, product_id: 24577, echo: true },
        { id: "ttyACM0", name: "Arduino Uno", vendor_id: 9025, product_id: 67, busy: true },
      ],
    },
    gpio: { chip: true, pins: [{ pin: 17, value: false, floating: true }, { pin: 27, value: true, floating: true }, { pin: 22, value: false, busy: true }] },
    ir: { available: true },
    ble: {
      adapter: true,
      peripherals: [{ name: "HRM-Strap", address: "aa:bb:cc:dd:ee:ff", services: [{ service: "180d", characteristics: [{ characteristic: "2a37", value_base64: "ABg=" }] }] }],
    },
    printers: [
      { id: "usb:epson-tm-t20", name: "Epson TM-T20", formats: ["escpos"], default: true },
      { id: "office", name: "Office laser", formats: ["pdf"] },
      { id: "jammed", name: "Jammed receipt printer", formats: ["escpos"], failing: true },
    ],
  };
}

export function cloneHardware(hardware: Hardware): Hardware {
  return JSON.parse(JSON.stringify(hardware)) as Hardware;
}

/** The members of `value` that are not in `allowed`. */
export function unknownMembers(value: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(value).filter((key) => !allowed.includes(key));
}

export const BLE_UUID = /^(?:[0-9a-f]{4}|[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
export const HANDLE = /^[A-Za-z0-9_-]{8,64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Raw byte length of canonical base64, or undefined when it is not canonical base64. */
export function base64Length(value: unknown): number | undefined {
  if (typeof value !== "string" || !BASE64.test(value)) return undefined;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

/** A port or printer id: 1 to 128 characters without control characters. */
export function validDeviceId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
}
