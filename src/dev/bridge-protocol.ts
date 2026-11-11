/**
 * Constants of the SDK bridge (protocol "1") as the host side needs them. The
 * contract is `screenrig.sdk-bridge/v1`; the conformance fixtures under
 * `vendor/protocol/fixtures/sdk-bridge*` pin every value here.
 */
export const PROTOCOL = "1";
export const PARENT_HANDSHAKE_PROTOCOL = "screenrig.parent-handshake/1";
export const MAX_MESSAGE_BYTES = 65_536;
export const DEVICE_CHUNK_BYTES = 32_768;
export const MAX_SERIAL_PORTS = 4;
export const MAX_BLE_SUBSCRIPTIONS = 8;
export const MAX_GPIO_PINS = 16;
export const MAX_PRINT_BYTES = 4_194_304;
export const PRINT_IDLE_MS = 30_000;
/** A frame may ask the Player to skip its page only this long after activation. */
export const SKIP_WINDOW_MS = 10_000;

export const CAPABILITY_NAMES = [
  "page.advance", "page.skip", "kv.read", "kv.write",
  "device.display", "device.presence", "device.keys", "device.light", "device.network", "device.haptics",
  "device.scan", "device.camera", "device.sound", "device.serial", "device.gpio", "device.ble", "device.print",
] as const;
export type CapabilityName = (typeof CAPABILITY_NAMES)[number];
export type Capabilities = Record<CapabilityName, boolean>;

/** In the order the fixtures list them. */
export const FEATURE_NAMES = [
  "ready", "log", "event.emit", "page.advance", "page.skip", "kv.get", "kv.list", "kv.set", "kv.delete", "kv.watch",
  "device.display", "device.watch", "device.vibrate", "device.scan", "device.camera", "device.sound", "device.serial", "device.gpio", "device.ble", "device.print",
  "visibility.watch", "page.timing", "context.params", "context.screen",
] as const;

/** What a host that sends no `features` list implements. */
export const BASELINE_FEATURES: readonly string[] = [
  "context", "ready", "log", "event.emit", "page.advance", "viewport.changed", "kv.get", "kv.list", "kv.set", "kv.delete", "response.ack", "response.problem",
];

/** Hardware kinds are advertised by device, not by kind. */
const KIND_FEATURES: Readonly<Record<string, string>> = {
  "device.scanner.start": "device.camera", "device.scanner.stop": "device.camera",
  "device.serial.list": "device.serial", "device.serial.open": "device.serial", "device.serial.write": "device.serial", "device.serial.close": "device.serial",
  "device.gpio.write": "device.gpio", "device.gpio.watch": "device.gpio",
  "device.ble.read": "device.ble", "device.ble.watch": "device.ble", "device.ble.unwatch": "device.ble",
  "device.print": "device.print", "device.printers": "device.print",
};

export function featureOf(kind: string): string {
  return Object.prototype.hasOwnProperty.call(KIND_FEATURES, kind) ? KIND_FEATURES[kind]! : kind;
}

/** `device.watch` event names in the order the SDK sends them, each with the capability and the feature it needs. */
export const WATCH_EVENTS: ReadonlyArray<{ name: string; capability: CapabilityName; feature: string }> = [
  { name: "display", capability: "device.display", feature: "device.display" },
  { name: "presence", capability: "device.presence", feature: "device.watch" },
  { name: "keys", capability: "device.keys", feature: "device.watch" },
  { name: "light", capability: "device.light", feature: "device.watch" },
  { name: "network", capability: "device.network", feature: "device.watch" },
  { name: "scan", capability: "device.scan", feature: "device.scan" },
  { name: "people", capability: "device.camera", feature: "device.camera" },
  { name: "sound", capability: "device.sound", feature: "device.sound" },
  { name: "serial", capability: "device.serial", feature: "device.serial" },
  { name: "gpio", capability: "device.gpio", feature: "device.gpio" },
  { name: "ble", capability: "device.ble", feature: "device.ble" },
];

export interface BridgeMessage {
  protocol: typeof PROTOCOL;
  message_id: string;
  kind: string;
  primitive_id: string;
  payload: Record<string, unknown>;
}

export interface HandshakeOffer {
  protocol: typeof PARENT_HANDSHAKE_PROTOCOL;
  kind: "parent.handshake";
  challenge: string;
}

export type Posted = BridgeMessage | HandshakeOffer;

export interface Size {
  width: number;
  height: number;
}

export interface BridgeProblem {
  code: string;
  status: number;
  detail: string;
  request_id: string;
  current_revision?: number;
}

export function allCapabilities(value: boolean): Capabilities {
  return Object.fromEntries(CAPABILITY_NAMES.map((name) => [name, value])) as Capabilities;
}

export const ID_RE = /^[A-Za-z0-9._-]{8,128}$/;
export const PRIMITIVE_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
export const KIND_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
