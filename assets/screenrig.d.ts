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
 * `invalid_request` for arguments it refuses before sending anything.
 *
 * A request the backend or the Player refuses rejects with that problem's
 * code, for example `not_found`, `revision_conflict`, `quota_exceeded`,
 * `rate_limited` and `forbidden`.
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
     * Whether the Player that hosts the page implements a message kind or
     * feature, such as `"page.skip"`, `"kv.watch"`, `"device.display"`,
     * `"device.watch"` or `"device.vibrate"`. `supports` says what the Player can
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
