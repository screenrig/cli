// screenRIG application SDK: the types of window.screenrig.
// Generated; do not edit. `screenrig app types` rewrites this file.
//
// Keep it in your TypeScript project (for example beside your sources, and
// covered by tsconfig "include") and window.screenrig is typed. It declares
// types only and adds nothing to your build.

export type ReadyState = "inert" | "active" | "failed";
export interface Size {
    width: number;
    height: number;
}
/** Which gated methods do anything for the current activation. The keys are dotted: read them with bracket notation. */
export interface Capabilities {
    /** `screenrig.nextPage()`: this frame may end the application's turn on an application-advance page. */
    "page.advance": boolean;
    /** `screenrig.skip()`: this frame may tell the Player its page has nothing to show. */
    "page.skip": boolean;
    /** `screenrig.kv.get()`, `kv.list()` and `kv.onChange()`. */
    "kv.read": boolean;
    /** `screenrig.kv.set()` and `kv.delete()`. */
    "kv.write": boolean;
    /** `screenrig.device.display.get()`, `.set()` and `device.onDisplay()`: set the display's brightness, darken or wake it, and hear display changes. */
    "device.display": boolean;
    /** `screenrig.device.onPresence()`: hear that somebody moved in front of the screen. */
    "device.presence": boolean;
    /** `screenrig.device.onKey()`: receive the hardware volume keys. */
    "device.keys": boolean;
    /** `screenrig.device.onLight()`: hear the ambient light level. The device has a light sensor. */
    "device.light": boolean;
    /** `screenrig.device.onNetwork()`: hear the device's internet connectivity change. */
    "device.network": boolean;
    /** `screenrig.device.vibrate()`: play a haptic tick. The device has a vibrator. */
    "device.haptics": boolean;
    /** `screenrig.device.onScan()`: hear what the device reads: keyboard-wedge scanners and badge readers, NFC tags, the camera scanner. */
    "device.scan": boolean;
    /** `screenrig.device.scanner` and `device.onPeople()`: use the device's camera to read QR codes and barcodes and to count the people in view. The camera is analysed on the device; no image leaves it. */
    "device.camera": boolean;
    /** `screenrig.device.onSoundLevel()`: hear the microphone level. No audio leaves the device. */
    "device.sound": boolean;
    /** `screenrig.device.serial`: list and open the device's serial ports. */
    "device.serial": boolean;
    /** `screenrig.device.gpio`: drive and hear the device's GPIO lines. */
    "device.gpio": boolean;
    /** `screenrig.device.ble`: read and follow Bluetooth LE characteristics. Read and notify only. */
    "device.ble": boolean;
    /** `screenrig.device.print()` and `device.printers()`: print on the device's printers. */
    "device.print": boolean;
}
/** The screen this page is playing on. */
export interface ContextScreen {
    /** The screen's name, at most 200 characters. */
    name?: string;
    /** The screen's IANA time zone, such as `America/Vancouver`; absent when the screen has none. */
    timezone?: string;
}
/** Where this document is running. A description: nothing in it is meant to be signed, forwarded or sent back to screenRIG. */
export interface ContextPayload {
    /** The `app_` id from `app upload`. The key/value store belongs to it. */
    application_id: string;
    /** The immutable release serving this origin. */
    release_id: string;
    /** The primitive this document fills on the current page. */
    primitive_id: string;
    /** Runtime bookkeeping for this activation; applications never need it. */
    generation: number;
    /** Runtime bookkeeping for this activation; applications never need it. */
    nonce: string;
    /** The origin of the Player that hosts this page. */
    player_origin: string;
    /** The same booleans as `screenrig.capabilities`. */
    capabilities: Capabilities;
    /** The surface the Player is rendering into. */
    viewport: Size;
    /** The rect this document occupies inside the viewport. */
    primitive: Size;
    /** Present when the runtime knows which screen is playing. */
    screen_id?: string;
    /** The message kinds and features the Player implements, when it lists them. Read it with `screenrig.supports()`. */
    features?: readonly string[];
    /**
     * The launch params of this application on this screen: the playlist's
     * `params`, with the screen's facts filled in (the values the web Player puts
     * on the launch URL). At most 16 entries; each name is 1 to 32 lower case
     * letters, digits or underscores and is not `ticket` or `policy`; each value is
     * a string of at most 512 characters. Always present: `{}` when the page sets
     * none. A param is a hint, not a credential; do not trust one for anything
     * that matters.
     */
    params: Readonly<Record<string, string>>;
    /** The screen this page is playing on, when the Player tells it. */
    screen?: ContextScreen;
}
export interface LogPayload {
    level: "debug" | "info" | "warn" | "error";
    /** Sanitized to `[A-Za-z0-9._-]`, at most 64 characters. */
    code: string;
    /** At most 2048 bytes. */
    message: string;
}
/**
 * What every throw and every rejected promise of `window.screenrig` is: an
 * `Error` with a stable `code`. Branch on `code`, never on the message.
 *
 * Codes the runtime raises itself: `inert` (called before the Player activated
 * the page), `capability_denied`, `not_supported` (the Player lacks the
 * feature), `skip_after_ready`, `activation_timeout`, `ack_timeout` (the Player
 * did not reply in time; the request may still have been accepted),
 * `destroyed`, and `invalid_key`, `invalid_value`, `invalid_revision`,
 * `invalid_handler`, `invalid_timeout`, `invalid_log`, `invalid_event` and
 * `invalid_request` for arguments it refuses before sending anything, and
 * `invalid_response` for an answer it cannot read.
 *
 * A request the backend or the Player refuses rejects with that problem's
 * code, for example `not_found`, `revision_conflict`, `quota_exceeded`,
 * `rate_limited` and `forbidden`. The hardware methods add `camera_unavailable`,
 * `port_not_found`, `port_busy`, `port_limit`, `invalid_handle`, `pin_not_found`,
 * `pin_busy`, `gpio_unavailable`, `ble_unavailable`, `device_not_found`,
 * `characteristic_not_found`, `subscription_limit`, `printer_not_found`,
 * `print_failed`, `payload_too_large` and `io_failed`.
 */
export interface ScreenRigError extends Error {
    readonly code: string;
}
/** The options of `screenrig.kv.set`. */
export interface KvSetOptions {
    /** Defaults to `text/plain` for a string value and `application/octet-stream` for a `Uint8Array`. */
    contentType?: string;
    /** Write only if the entry is still at this revision; a stale revision rejects `revision_conflict`. A non-negative integer. */
    expectedRevision?: number;
    /** Send the same key on every attempt of a write that may be retried: the store applies it once. */
    idempotencyKey?: string;
}
/** The options of `screenrig.kv.delete`. */
export interface KvDeleteOptions {
    /** Send the same key on every attempt of a delete that may be retried: the store applies it once. */
    idempotencyKey?: string;
}
/** One changed key of this application, as pushed by the Player. */
export interface KvChange {
    key: string;
    /** The entry's new revision; absent when the key was deleted. */
    revision?: number;
    deleted: boolean;
}
/** A stored key without its value, as `screenrig.kv.list` returns it. */
export interface KvSummary {
    /** The `app_` id whose store holds the key. */
    application_id: string;
    key: string;
    content_type: string;
    /** The length of the value in bytes. */
    bytes: number;
    /** The SHA-256 of the value, as 64 lowercase hex characters. */
    sha256: string;
    /** Changes on every write of the key. Pass it as `expectedRevision` to write only if nobody wrote first. */
    revision: number;
}
/** A stored key and its value, as `screenrig.kv.get` and `screenrig.kv.set` return it. */
export interface KvEntry extends KvSummary {
    /** The value's bytes, base64 encoded. */
    value_base64: string;
}
/** What `screenrig.kv.list` resolves with. */
export interface KvList {
    /** Up to 200 keys, in ascending key order. */
    items: KvSummary[];
}
export interface ScreenRigKv {
    /**
     * Reads one entry. Needs the `kv.read` capability. Rejects `not_found` when
     * the key is not stored.
     */
    get(key: string): Promise<KvEntry>;
    /**
     * Reads one entry and resolves with its value decoded as UTF-8 text. Needs the
     * `kv.read` capability; rejects as `get` does.
     */
    getText(key: string): Promise<string>;
    /**
     * Reads one entry and resolves with its value parsed as JSON. Needs the
     * `kv.read` capability; rejects as `get` does, and `invalid_value` when the
     * value is not JSON.
     */
    getJSON<T = unknown>(key: string): Promise<T>;
    /**
     * Lists the keys this application has stored, without their values, up to 200
     * in ascending key order. Needs the `kv.read` capability.
     */
    list(): Promise<KvList>;
    /**
     * Writes `value`, a string or the bytes of a `Uint8Array`, and resolves with
     * the stored entry. Needs the `kv.write` capability. A key is 1 to 256 UTF-8
     * bytes and does not begin with `_screenrig/`. Rejects `revision_conflict`
     * when `options.expectedRevision` is stale, and `quota_exceeded` or
     * `rate_limited` past the store's limits.
     */
    set(key: string, value: string | Uint8Array, options?: KvSetOptions): Promise<KvEntry>;
    /**
     * Writes `JSON.stringify(value)` with the content type `application/json` and
     * resolves as `set` does. Rejects `invalid_value` for a value JSON cannot
     * represent (`undefined`, a function, a symbol); otherwise as `set`.
     */
    setJSON(key: string, value: unknown, options?: KvSetOptions): Promise<KvEntry>;
    /**
     * Deletes one entry and resolves with no value. Needs the `kv.write`
     * capability. Pass `expectedRevision` to delete only if the entry is still at
     * the revision you read; a stale revision rejects `revision_conflict`.
     */
    delete(key: string, expectedRevision?: number, options?: KvDeleteOptions): Promise<void>;
    /**
     * Call `handler` whenever a key of this application changes, whoever wrote
     * it: an agent, the API, an incoming webhook, or an app on any screen. It
     * carries the key and revision, not the value; read the value with `get`.
     * Needs the `kv.read` capability and a Player that supports `kv.watch`
     * (`supports("kv.watch")`); otherwise the handler never runs. Returns a
     * function that removes the handler.
     */
    onChange(handler: (change: KvChange) => void): () => void;
}
/** The display state `screenrig.device.display` reads and sets. */
export interface DeviceDisplayState {
    /** Whether the display is lit. */
    on: boolean;
    /** The brightness setting, 0 to 1; null when the Player cannot report it. */
    brightness: number | null;
}
/** What `screenrig.device.display.set` changes. An omitted member is unchanged; `{}` only reads. */
export interface DeviceDisplaySet {
    /** `false` darkens the display, `true` lights it again. */
    on?: boolean;
    /** The display brightness, 0 (the lowest backlight the device allows, not off) to 1. */
    brightness?: number;
}
/** A hardware key a page can hear. */
export type DeviceKey = "volume_up" | "volume_down";
export interface ScreenRigDeviceDisplay {
    /**
     * Reads the display state. Rejects `not_supported` when the Player does not
     * advertise `device.display`, `capability_denied` without the `device.display`
     * capability, and the Player's problem otherwise.
     */
    get(): Promise<DeviceDisplayState>;
    /**
     * Sets the display's `on` and `brightness` and resolves with the resulting
     * state, which can differ: while the screen's display schedule or an operator
     * holds the display dark, `on: true` does not light it. Rejects
     * `invalid_request` for a non-boolean `on`, a `brightness` outside 0 to 1 or
     * an unknown member (nothing is sent), then as `get` does. The Player restores
     * the display when the page leaves the screen.
     */
    set(state: DeviceDisplaySet): Promise<DeviceDisplayState>;
}
/** Why a page is not visible: the display went dark, an operator paused playback, or the page is leaving the glass. */
export type VisibilityReason = "display" | "paused" | "leaving";
/** What `screenrig.onVisibility` reports. */
export interface VisibilityState {
    /** `false` while the page is not on the glass; `true` when playback resumes. */
    visible: boolean;
    /** Why it changed. On `visible: true`, the reason that ended. */
    reason: VisibilityReason;
}
/** What `screenrig.pageTiming()` resolves with. */
export interface PageTiming {
    /** How long this page has been on the glass this time, in milliseconds, paused time excluded. */
    elapsedMs: number;
    /** How long until the Player moves on, in milliseconds; `null` when the page has no scheduled end, such as the only page of a playlist. */
    remainingMs: number | null;
    /** Whether playback is held: the display is dark or an operator paused it. */
    paused: boolean;
}
/** Where a scan came from: a keyboard-wedge scanner or badge reader, an NFC tag, or the device camera. */
export type ScanSource = "scanner" | "nfc" | "camera";
/** The symbologies the camera scanner decodes. */
export type ScanFormat = "qr" | "ean13" | "ean8" | "upca" | "upce" | "code128" | "code39" | "code93" | "itf" | "codabar" | "datamatrix" | "pdf417" | "aztec";
/** One scan. */
export interface ScanEvent {
    source: ScanSource;
    /**
     * What was read: a `ScanFormat` for the camera, `text` for a keyboard-wedge
     * scanner or badge reader, and `uid`, `ndef_text` or `ndef_uri` for an NFC tag.
     * Another name is a format this SDK does not list: treat it as opaque.
     */
    format: string;
    /** The text read, at most 2048 characters. A tag's `uid` is upper case hexadecimal without separators. */
    data: string;
}
/** The options of `screenrig.device.scanner.start`. */
export interface ScannerOptions {
    /** The symbologies to decode; every one by default. Unknown names reject `invalid_request`. */
    formats?: readonly ScanFormat[];
}
/** What `scanner.start` resolves with. */
export interface ScannerState {
    /** The symbologies now being decoded: the ones asked for that this device can decode. */
    formats: ScanFormat[];
}
export interface ScreenRigDeviceScanner {
    /**
     * Starts decoding QR codes and barcodes from the device camera; each one
     * arrives as a scan with source `camera` at the `onScan` handlers. Needs the
     * `device.camera` and `device.scan` capabilities. Rejects `not_supported` when
     * the Player does not advertise them, `capability_denied` without them,
     * `invalid_request` (before anything is sent) for a bad `formats`,
     * `camera_unavailable` when the camera cannot open, and the Player's problem
     * otherwise. The camera is analysed on the device; no image leaves it. The
     * Player stops the scanner when the page leaves the screen.
     */
    start(options?: ScannerOptions): Promise<ScannerState>;
    /** Stops the camera scanner. Needs the `device.camera` capability; resolves when the scanner is stopped or was not running. */
    stop(): Promise<void>;
}
/** A serial port the device offers. */
export interface SerialPortInfo {
    /** Pass this to `serial.open`. */
    id: string;
    /** A name to show people. */
    name: string;
    /** The USB vendor id, when the port is a USB device. */
    vendorId?: number;
    /** The USB product id, when the port is a USB device. */
    productId?: number;
}
/** The line settings of `serial.open`. */
export interface SerialOptions {
    /** Bits per second, an integer from 50 to 4000000. */
    baudRate: number;
    /** 8 by default. */
    dataBits?: 5 | 6 | 7 | 8;
    /** 1 by default. */
    stopBits?: 1 | 2;
    /** `none` by default. */
    parity?: "none" | "even" | "odd";
    /** `none` by default. */
    flowControl?: "none" | "hardware";
}
/** Why a serial port closed without `close()`: it was unplugged, an error ended it, or the page's context ended. */
export type SerialCloseReason = "unplugged" | "error" | "context";
export type SerialDataBits = 5 | 6 | 7 | 8;
export type SerialStopBits = 1 | 2;
export type SerialParity = "none" | "even" | "odd";
export type SerialFlowControl = "none" | "hardware";
/** An open serial port. */
export interface ScreenRigSerialPort {
    /** The id the port was opened with. */
    readonly id: string;
    /**
     * Writes bytes (a `Uint8Array`, or a string sent as UTF-8) and resolves when
     * the Player has handed them all to the port. Writes are sent in order, in
     * chunks of at most 32768 bytes; one call writes at most 1048576 bytes
     * (`invalid_request` before anything is sent). Rejects `invalid_handle` once
     * the port is closed.
     */
    write(data: Uint8Array | string): Promise<void>;
    /**
     * Calls `handler` with each chunk the port receives, in order. Bytes that
     * arrived before the first handler was added (up to 65536) are delivered to it
     * first. Returns a function that removes the handler.
     */
    onData(handler: (bytes: Uint8Array) => void): () => void;
    /** Calls `handler` once if the port closes by itself (unplugged, an error, the end of the page's context). Returns a function that removes the handler. */
    onClose(handler: (reason: SerialCloseReason) => void): () => void;
    /** Closes the port. Resolves when it is closed; closing a closed port resolves. */
    close(): Promise<void>;
}
export interface ScreenRigDeviceSerial {
    /**
     * Lists the serial ports (at most 16). Needs the `device.serial` capability.
     * Rejects `not_supported` when the Player does not advertise `device.serial`,
     * `capability_denied` without the capability, and the Player's problem
     * otherwise.
     */
    list(): Promise<SerialPortInfo[]>;
    /**
     * Opens a port from `list()` (or a port name the device documents) and
     * resolves with it. At most 4 ports are open at once. Rejects as `list` does,
     * `invalid_request` (before anything is sent) for bad options, and
     * `port_not_found`, `port_busy`, `port_limit` or `io_failed` from the Player.
     * Open ports close when the page leaves the screen.
     */
    open(port: string, options: SerialOptions): Promise<ScreenRigSerialPort>;
}
export interface ScreenRigDeviceGpio {
    /**
     * Drives a GPIO line as an output: `true` is high. `pin` is an integer from 0
     * to 255, the line number of the device's GPIO chip (on a Raspberry Pi, the
     * BCM number). Needs the `device.gpio` capability. Rejects `not_supported`
     * when the Player does not advertise `device.gpio`, `capability_denied`
     * without the capability, `invalid_request` (before anything is sent) for a
     * bad `pin` or `value`, and `pin_not_found`, `pin_busy` or `gpio_unavailable`
     * from the Player.
     */
    write(pin: number, value: boolean): Promise<void>;
    /**
     * Calls `handler` with the level of a line, first for the level it has when
     * the Player starts watching it, then whenever it changes (the Player filters
     * contact bounce). Needs the `device.gpio` capability and a Player that
     * advertises `device.gpio` and `device.watch`; otherwise the handler never
     * runs. At most 16 lines are watched at once. Returns a function that removes
     * the handler.
     */
    onChange(pin: number, handler: (value: boolean) => void): () => void;
}
/** A Bluetooth LE characteristic. */
export interface BleTarget {
    /** The service UUID: 4, 8 or 36 hexadecimal characters, the 36-character form with dashes. */
    service: string;
    /** The characteristic UUID, in the same forms. */
    characteristic: string;
    /** Only a peripheral with this advertised name or this address (`aa:bb:cc:dd:ee:ff`); at most 64 characters. Absent: any peripheral that advertises the service. */
    device?: string;
}
export interface ScreenRigDeviceBle {
    /**
     * Reads a characteristic (at most 512 bytes). Needs the `device.ble`
     * capability. Rejects `not_supported` when the Player does not advertise
     * `device.ble`, `capability_denied` without the capability,
     * `invalid_request` (before anything is sent) for a malformed target, and
     * `ble_unavailable`, `device_not_found`, `characteristic_not_found` or
     * `io_failed` from the Player. There is no pairing and no writing.
     */
    read(target: BleTarget): Promise<Uint8Array>;
    /**
     * Follows a characteristic's notifications: calls `handler` with each value.
     * Resolves with a function that stops following once the Player has
     * subscribed. At most 8 subscriptions are held at once. Rejects as `read`
     * does, and `subscription_limit`. Subscriptions end when the page leaves the
     * screen.
     */
    watch(target: BleTarget, handler: (bytes: Uint8Array) => void): Promise<() => void>;
}
/** A printer the device offers. */
export interface PrinterInfo {
    /** Pass this as `print({ printer })`. */
    id: string;
    /** A name to show people. */
    name: string;
    /** What it prints. */
    formats: PrintFormat[];
    /** Whether it is the device's default printer. */
    default?: boolean;
}
export type PrintFormat = "escpos" | "pdf";
/** One job for `screenrig.device.print`: exactly one of `escpos` and `pdf`. */
export interface PrintJob {
    /** Raw ESC/POS commands for a receipt printer on USB or the network. */
    escpos?: Uint8Array;
    /** A PDF document, printed through the device's print service. */
    pdf?: Uint8Array;
    /** A printer id from `printers()`; the device's default printer when absent. */
    printer?: string;
}
export interface ScreenRigDevice {
    readonly display: ScreenRigDeviceDisplay;
    /**
     * Calls `handler` whenever the effective display state changes, whoever
     * changed it: this page, the screen's display schedule, an operator. Needs the
     * `device.display` capability and a Player that supports `device.watch`
     * (`supports("device.watch")`); otherwise the handler never runs. Returns a
     * function that removes the handler.
     */
    onDisplay(handler: (state: DeviceDisplayState) => void): () => void;
    /**
     * Calls `handler` when the device sees somebody move in front of the screen,
     * at most once per second. The camera is analysed on the device; no image
     * leaves it. Needs the `device.presence` capability and `device.watch`
     * support; otherwise the handler never runs. Returns a function that removes
     * the handler.
     */
    onPresence(handler: () => void): () => void;
    /**
     * Calls `handler` for every key-down of a hardware volume key, auto-repeat
     * included. While a handler exists the Player consumes the key instead of
     * changing the device volume. Needs the `device.keys` capability and
     * `device.watch` support; otherwise the handler never runs. Returns a
     * function that removes the handler.
     */
    onKey(handler: (key: DeviceKey) => void): () => void;
    /**
     * Calls `handler` with the ambient light in lux, first for the reading the
     * Player takes at the watch, then whenever it changes by at least 10% or
     * crosses 1 lux, at most once per second. Needs the `device.light`
     * capability (the device has a light sensor) and `device.watch` support;
     * otherwise the handler never runs. Returns a function that removes the
     * handler.
     */
    onLight(handler: (lux: number) => void): () => void;
    /**
     * Calls `handler` with whether the device has validated internet connectivity
     * whenever it changes. The Player also posts the current state when a watch
     * adds `network` (the first handler's registration, and a new context), so
     * that first handler hears the state at once; a handler added later hears the
     * changes after it. Needs the `device.network` capability and `device.watch`
     * support; otherwise the handler never runs. Returns a function that removes
     * the handler.
     */
    onNetwork(handler: (online: boolean) => void): () => void;
    /**
     * Plays one haptic tick of `ms` milliseconds (1 to 200, 12 by default) and
     * resolves when the Player has started it. Rejects `not_supported` when the
     * Player does not advertise `device.vibrate`, `capability_denied` without the
     * `device.haptics` capability (the device has a vibrator), `invalid_request`
     * for an `ms` that is not an integer from 1 to 200 (nothing is sent), and the
     * Player's problem otherwise.
     */
    vibrate(ms?: number): Promise<void>;
    /**
     * Calls `handler` with each scan: a keyboard-wedge barcode scanner or badge
     * reader (a burst of keystrokes that ends in Enter, which the Player takes
     * from the page instead of typing it), an NFC tag, or the camera scanner once
     * `scanner.start()` runs. Needs the `device.scan` capability and a Player that
     * supports `device.watch` and `device.scan`; otherwise the handler never
     * runs. Returns a function that removes the handler.
     */
    onScan(handler: (scan: ScanEvent) => void): () => void;
    /** The camera scanner: QR codes and barcodes. Its results arrive at `onScan`. */
    readonly scanner: ScreenRigDeviceScanner;
    /**
     * Calls `handler` with the number of people the device's camera sees, first
     * for the count at the watch, then whenever it changes, at most once per
     * second. The camera is analysed on the device; no image leaves it. Needs the
     * `device.camera` capability and a Player that supports `device.watch` and
     * `device.camera`; otherwise the handler never runs. Returns a function that
     * removes the handler.
     */
    onPeople(handler: (count: number) => void): () => void;
    /**
     * Calls `handler` with the microphone level in dBFS (-120 to 0) of the last
     * second, at most once per second. No audio leaves the device. Needs the
     * `device.sound` capability and a Player that supports `device.watch` and
     * `device.sound`; otherwise the handler never runs. Returns a function that
     * removes the handler.
     */
    onSoundLevel(handler: (dbfs: number) => void): () => void;
    /** Serial ports. */
    readonly serial: ScreenRigDeviceSerial;
    /** GPIO lines. */
    readonly gpio: ScreenRigDeviceGpio;
    /** Bluetooth LE characteristics: read and notify. */
    readonly ble: ScreenRigDeviceBle;
    /**
     * Prints a job and resolves when the printer or its spooler has it. Exactly
     * one of `escpos` and `pdf`, from 1 byte to 4194304 bytes (sent in chunks).
     * Needs the `device.print` capability. Rejects `not_supported` when the Player
     * does not advertise `device.print`, `capability_denied` without the
     * capability, `invalid_request` (before anything is sent) for a bad job, and
     * `printer_not_found`, `print_failed` or `payload_too_large` from the Player.
     */
    print(job: PrintJob): Promise<void>;
    /** Lists the printers (at most 16) and which formats each prints. Needs the `device.print` capability; rejects as `print` does. */
    printers(): Promise<PrinterInfo[]>;
}
/** The runtime screenRIG injects into an application as `window.screenrig`. */
export interface ScreenRig {
    /**
     * `inert` until the Player's handshake and context arrive, then `active`;
     * `failed` when the runtime refused to start. A page that is not on screen
     * yet stays `inert`, so wait for `active` with `waitUntilActive()` instead of
     * treating `inert` at load as "outside screenRIG".
     */
    readonly readyState: ReadyState;
    /** Where this document is running; `null` until the page is active. */
    readonly context: ContextPayload | null;
    /** Which gated methods do anything for this activation. Subscribe with `onCapabilities` rather than reading it once. */
    readonly capabilities: Capabilities;
    /** The application's key/value store. */
    readonly kv: ScreenRigKv;
    /** The device this page runs on: its display, presence sensing, volume keys, light sensor, connectivity and haptics. */
    readonly device: ScreenRigDevice;
    /**
     * Resolves when the Player has activated this page, or at once when it
     * already has. It does not declare the application rendered. Rejects
     * `activation_timeout` after `timeoutMs` (default 10000, at most 300000).
     */
    waitUntilActive(timeoutMs?: number): Promise<void>;
    /** Tells the Player the application is rendered and on screen. Call it after `waitUntilActive()` resolves. Rejects `inert` before then. */
    ready(): Promise<void>;
    /** Leaves a diagnostic for the Player and runtime to collect: 32 lines per client, 2048 bytes of message each. Not an application event; use `emit` for that. */
    log(entry: LogPayload): void;
    /** Records a named application event the agent can read in the project event log. `code` is sanitized to `[A-Za-z0-9._-]`, at most 64 characters. */
    emit(code: string): void;
    /**
     * Like `emit`, and resolves only once the Player confirms the backend
     * accepted the event. Rejects with the backend's problem when it refuses the
     * event, and `ack_timeout` after 10 seconds without a reply. Do not retry
     * automatically after a timeout: the backend may already have accepted it.
     */
    emitConfirmed(code: string): Promise<void>;
    /**
     * Ends this application's turn on an application-advance page where this
     * primitive is the controller. One-shot per activation. Rejects
     * `capability_denied` without the `page.advance` capability.
     */
    nextPage(): Promise<void>;
    /**
     * Tells the Player this page has nothing to show this time: the screen moves
     * on at once and counts no play. It is a start-time decision: call it
     * instead of `ready()`, within ten seconds of activation. Rejects
     * `capability_denied` without the `page.skip` capability (the controller, or
     * the page's only application, on a page without images or video),
     * `skip_after_ready` once `ready()` was called for this activation,
     * `not_supported` when the Player does not support it, and `forbidden` when
     * the Player keeps the page (the window passed, the operator holds the page,
     * or every other page has skipped too): render the fallback, then `ready()`.
     * `reason` is optional text for the Player log.
     */
    skip(reason?: string): Promise<void>;
    /** Calls `handler` when the viewport or the primitive's rect changes. Returns a function that removes the handler. */
    onResize(handler: (size: {
        viewport: Size;
        primitive: Size;
    }) => void): () => void;
    /** Calls `handler` when the granted capabilities change; read `capabilities` inside it. Returns a function that removes the handler. */
    onCapabilities(handler: (capabilities: Capabilities) => void): () => void;
    /**
     * Calls `handler` when the page stops or starts being on the glass: the
     * display went dark (its schedule, idle, an operator), an operator paused
     * playback, or the page is leaving. `leaving` is sent best effort just before
     * the page is torn down. When playback resumes `visible` is `true` and
     * `reason` names what ended. Needs no capability and a Player that supports
     * `visibility.watch` (`supports("visibility.watch")`); otherwise the handler
     * never runs. Throws `invalid_handler` for a non-function. Returns a function
     * that removes the handler.
     */
    onVisibility(handler: (state: VisibilityState) => void): () => void;
    /**
     * Resolves with how long this page has been on the glass, how long until the
     * Player moves on and whether playback is held. Needs no capability. Rejects
     * `inert` before activation, `not_supported` when the Player does not support
     * `page.timing`, and `invalid_response` for an answer it cannot read.
     */
    pageTiming(): Promise<PageTiming>;
    /**
     * Whether the Player that hosts the page implements a message kind or
     * feature, such as `"page.skip"`, `"kv.watch"`, `"visibility.watch"`,
     * `"page.timing"`, `"device.display"`, `"device.watch"`, `"device.vibrate"`,
     * `"device.scan"`, `"device.camera"`, `"device.sound"`, `"device.serial"`,
     * `"device.gpio"`, `"device.ble"` or `"device.print"`. `supports` says what the Player can
     * do; `capabilities` says what this page may do. A request for a feature the
     * Player lacks rejects `not_supported` without being sent.
     */
    supports(kind: string): boolean;
    /** Tears down the runtime's listeners. An application that runs its whole turn and lets the Player replace the document does not need to call it. */
    destroy(): void;
}

declare global {
    interface Window {
        /**
         * The screenRIG runtime. The packer injects it into the application, so it
         * is there in every packed application. It is absent when the same build
         * runs outside screenRIG: guard with `if (!window.screenrig)` to render
         * your own content there.
         */
        screenrig: ScreenRig;
    }
}
