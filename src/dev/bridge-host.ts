import { randomBytes } from "node:crypto";
import {
  BASELINE_FEATURES, CAPABILITY_NAMES, DEVICE_CHUNK_BYTES, ID_RE, KIND_RE, MAX_MESSAGE_BYTES, PARENT_HANDSHAKE_PROTOCOL, PRIMITIVE_ID_RE, PROTOCOL, SKIP_WINDOW_MS, WATCH_EVENTS,
  featureOf, isRecord, type BridgeMessage, type Capabilities, type CapabilityName, type Posted, type Size,
} from "./bridge-protocol.js";
import { FrameDevice, type DeviceActivity, type Outcome } from "./hardware-requests.js";
import { base64Length, unknownMembers, type Hardware } from "./hardware.js";
import { validKvKey, type KvResult, type KvStore } from "./kv.js";

/** One thing the application or the device did that the harness shows and the terminal prints. */
export interface HostEvent {
  type: string;
  level?: "debug" | "info" | "warn" | "error";
  code?: string;
  message?: string;
  detail?: Record<string, unknown>;
}

/** Where `event.emit` goes: the backend in a Player, the terminal here. */
export interface EventSink {
  emit(code: string, primitiveId: string): Promise<{ ok: true } | { ok: false; code: string; status: number; detail: string; request_id?: string }>;
}

/** What a Player's manifest says about this application's primitive and its screen. */
export interface HostManifest {
  launchParams?: unknown;
  screenLabel?: unknown;
  timezone?: unknown;
}

export interface BridgeHostOptions {
  applicationId: string;
  releaseId: string;
  primitiveId: string;
  playerOrigin: string;
  appOrigin: string;
  capabilities: Capabilities;
  /** The features the host advertises; null sends no list, which makes it the protocol "1" baseline host. */
  features: readonly string[] | null;
  viewport: Size;
  manifest?: HostManifest;
  hardware: Hardware;
  kv: KvStore;
  events: EventSink;
  clock: () => number;
  post: (message: Posted) => void;
  log: (event: HostEvent) => void;
}

export type PageEnd = "advance" | "skip" | "max_ms";

/** An answer, with what the host does once the answer is posted (the pushes that follow it). */
type HostOutcome = Outcome & { after?: () => void };

export type Trigger =
  | { device: "watch" }
  | { device: "display"; on: boolean; brightness: number | null }
  | { device: "presence"; atMs?: number }
  | { device: "key"; key: string; action: "down" | "up"; repeat?: boolean }
  | { device: "light"; lux: number; atMs?: number }
  | { device: "network"; online: boolean }
  | { device: "typing"; text: string; gapMs: number; enter: boolean; field: boolean; atMs?: number }
  | { device: "scan"; source: string; format: string; data: string; atMs?: number }
  | { device: "people"; count: number; atMs?: number }
  | { device: "sound"; dbfs: number; atMs?: number }
  | { device: "serial"; handle: string; data_base64?: string; closed?: boolean; reason?: string }
  | { device: "gpio"; pin: number; value: boolean }
  | { device: "ble"; subscription: string; value_base64: string }
  | { page: "display"; on: boolean }
  | { page: "pause"; paused: boolean }
  | { page: "leaving" };

/** What applying a trigger did: whether the frame was told, whether the Player consumed the input, and why nothing was posted. */
export interface TriggerResult {
  posted: boolean;
  consumed?: boolean;
  dropped?: string;
}

const SCAN_SOURCES = ["scanner", "nfc", "camera"];
const NFC_FORMATS = ["uid", "ndef_text", "ndef_uri"];
const FORMAT_RE = /^[a-z0-9_]{1,32}$/;
const KEYS = ["volume_up", "volume_down"];
const PARAM_NAME = /^[a-z0-9_]{1,32}$/;
const MAX_PARAMS = 16;
const MAX_PARAM_CODE_POINTS = 512;

function codePoints(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

/** The `params` and `screen` members of a context, from the manifest a Player read (contract section 2). */
export function contextMembers(manifest: HostManifest | undefined): { params?: Record<string, string>; screen?: { name?: string; timezone?: string } } {
  const out: { params?: Record<string, string>; screen?: { name?: string; timezone?: string } } = {};
  if (isRecord(manifest?.launchParams)) {
    const valid: Array<[string, string]> = [];
    for (const [name, value] of Object.entries(manifest.launchParams)) {
      if (!PARAM_NAME.test(name) || name === "ticket" || name === "policy") continue;
      if (typeof value !== "string" || codePoints(value) > MAX_PARAM_CODE_POINTS) continue;
      valid.push([name, value]);
    }
    valid.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    if (valid.length > 0) out.params = Object.fromEntries(valid.slice(0, MAX_PARAMS));
  }
  const name = typeof manifest?.screenLabel === "string" && manifest.screenLabel.length > 0 && manifest.screenLabel.length <= 200 && !/[\u0000-\u001f\u007f-\u009f]/.test(manifest.screenLabel) ? manifest.screenLabel : undefined;
  const timezone = typeof manifest?.timezone === "string" && manifest.timezone.length > 0 ? manifest.timezone : undefined;
  if (name !== undefined || timezone !== undefined) out.screen = { ...(name === undefined ? {} : { name }), ...(timezone === undefined ? {} : { timezone }) };
  return out;
}

function sanitizeSkipReason(reason: unknown): string | undefined {
  if (typeof reason !== "string") return undefined;
  const text = [...reason.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim()].slice(0, 64).join("");
  return text === "" ? undefined : text;
}

interface Limits {
  presence?: number;
  light?: { lux: number; at: number };
  people?: { count: number; at: number };
  sound?: number;
  scan?: number;
  codes: Map<string, number>;
}

type Held = "display" | "paused";

/**
 * The Player's side of the SDK bridge for one application frame: the parent
 * handshake, the context, every request kind with its capability and member
 * rules, and the pushes (kv.changed, visibility.changed, device.event). It
 * holds the device and the page timer and posts through `post`; nothing here
 * touches a browser, so the conformance fixtures run it directly.
 */
export class BridgeHost {
  generation = 0;
  nonce: string | undefined;
  active = false;
  readied = false;
  advanced = false;
  ended: PageEnd | undefined;
  readonly held = new Set<Held>();
  visibilityWatching = false;
  kvWatching = false;
  watching = new Set<string>();
  display: { on: boolean; brightness: number | null } = { on: true, brightness: 0.5 };
  darkHeld = false;
  network = { online: true };
  maxMs: number | null = null;
  controller = true;

  private activatedAt = 0;
  private startedAt = 0;
  private pausedAt: number | undefined;
  private pausedTotal = 0;
  private leftPosted = false;
  private limits: Limits = { codes: new Map() };
  private sequence = 0;
  private lastOpened: string | undefined;
  private unsubscribeKv: (() => void) | undefined;
  readonly frame: FrameDevice;
  onPageEnd: ((end: PageEnd, detail?: string) => void) | undefined;

  constructor(readonly options: BridgeHostOptions) {
    this.frame = new FrameDevice(options.hardware, options.clock, (activity: DeviceActivity) => this.options.log({ type: activity.type, detail: activity.detail }));
    this.unsubscribeKv = options.kv.subscribe((change) => this.kvChanged(change));
  }

  destroy(): void {
    this.unsubscribeKv?.();
    this.unsubscribeKv = undefined;
    this.active = false;
  }

  get capabilities(): Capabilities {
    return this.options.capabilities;
  }

  // Activation and handshake.

  private id(prefix: string): string {
    this.sequence += 1;
    return `${prefix}_${randomBytes(8).toString("hex")}`;
  }

  private newContext(): void {
    this.active = false;
    this.readied = false;
    this.advanced = false;
    this.ended = undefined;
    this.visibilityWatching = false;
    this.kvWatching = false;
    this.leftPosted = false;
    this.watching = new Set();
    this.limits = { codes: new Map() };
    this.frame.reset();
    const now = this.options.clock();
    this.activatedAt = now;
    this.startedAt = now;
    this.pausedTotal = 0;
    this.pausedAt = this.held.size > 0 ? now : undefined;
  }

  /** A frame loaded: a new generation and nonce, and the parent handshake that offers them. */
  beginActivation(): void {
    this.generation += 1;
    this.nonce = randomBytes(16).toString("hex");
    this.newContext();
    this.options.post({ protocol: PARENT_HANDSHAKE_PROTOCOL, kind: "parent.handshake", challenge: this.nonce });
  }

  /** For the conformance fixtures: the state after a handshake, without the handshake. */
  activateAs(generation: number, nonce: string): void {
    this.generation = generation;
    this.nonce = nonce;
    this.newContext();
    this.active = true;
  }

  /** The page is leaving the glass and the frame ends with it. */
  endContext(): void {
    this.leaving();
    this.active = false;
    this.nonce = undefined;
    this.frame.reset();
  }

  private envelope(kind: string, payload: Record<string, unknown>): BridgeMessage {
    return { protocol: PROTOCOL, message_id: this.id("msg"), kind, primitive_id: this.options.primitiveId, payload };
  }

  private bound(payload: Record<string, unknown>): Record<string, unknown> {
    return { ...payload, generation: this.generation, nonce: this.nonce };
  }

  contextMessage(): BridgeMessage {
    const size = this.options.viewport;
    const members = contextMembers(this.options.manifest);
    return this.envelope("context", {
      application_id: this.options.applicationId,
      release_id: this.options.releaseId,
      primitive_id: this.options.primitiveId,
      generation: this.generation,
      nonce: this.nonce,
      player_origin: this.options.playerOrigin,
      capabilities: { ...this.options.capabilities },
      viewport: { ...size },
      primitive: { ...size },
      placement: { ...size },
      ...(this.options.features === null ? {} : { features: [...this.options.features] }),
      ...(members.params ? { params: members.params } : {}),
      ...(members.screen ? { screen: members.screen } : {}),
    });
  }

  /** Re-sends the context with the same binding to refresh capabilities, features or sizes; nothing ends. */
  refreshContext(): void {
    if (this.active) this.options.post(this.contextMessage());
  }

  setViewport(size: Size): void {
    this.options.viewport = { ...size };
    if (!this.active) return;
    this.options.post(this.envelope("viewport.changed", this.bound({ viewport: { ...size }, primitive: { ...size }, placement: { ...size } })));
  }

  setCapability(name: CapabilityName, value: boolean): void {
    this.options.capabilities[name] = value;
    this.refreshContext();
  }

  setFeatures(features: readonly string[] | null): void {
    this.options.features = features;
    this.refreshContext();
  }

  supports(kind: string): boolean {
    const feature = featureOf(kind);
    return this.options.features === null ? BASELINE_FEATURES.includes(feature) : this.options.features.includes(feature);
  }

  // Inbound messages.

  /** One message from the application's window. `origin` is the sender's origin when the caller knows it. */
  async receive(data: unknown, origin?: string): Promise<void> {
    if (!isRecord(data)) return;
    if (data.protocol === PARENT_HANDSHAKE_PROTOCOL) {
      if (!this.active && data.kind === "child.handshake" && this.nonce !== undefined && data.challenge === this.nonce
        && data.parent_origin === this.options.playerOrigin && (origin === undefined || origin === this.options.appOrigin)) {
        this.active = true;
        this.options.post(this.contextMessage());
        this.options.log({ type: "activated", detail: { generation: this.generation } });
      }
      return;
    }
    if (!this.active || this.nonce === undefined) return;
    if (data.protocol !== PROTOCOL || data.primitive_id !== this.options.primitiveId) return;
    if (typeof data.message_id !== "string" || !ID_RE.test(data.message_id)) return;
    if (typeof data.kind !== "string" || !KIND_RE.test(data.kind) || !isRecord(data.payload)) return;
    const payload = data.payload;
    if (payload.generation !== this.generation || payload.nonce !== this.nonce) return;
    if (Buffer.byteLength(JSON.stringify(data)) > MAX_MESSAGE_BYTES) return;
    await this.dispatch({ message_id: data.message_id, kind: data.kind, payload });
  }

  private reply(request: { message_id: string }, outcome: Outcome, at: { generation: number; nonce: string | undefined }): void {
    if (at.generation !== this.generation || at.nonce !== this.nonce || !this.active) return;
    if (outcome.ok) {
      const message = this.envelope("response.ack", this.bound({ request_message_id: request.message_id, ...(outcome.result === undefined ? {} : { result: outcome.result }) }));
      if (JSON.stringify(message).length > MAX_MESSAGE_BYTES) {
        this.problem(request, "internal_error", 413, "The answer is larger than a message may be.", at);
        return;
      }
      this.options.post(message);
    } else {
      this.problem(request, outcome.code, outcome.status, outcome.detail, at, outcome);
    }
  }

  private problem(request: { message_id: string }, code: string, status: number, detail: string, at: { generation: number; nonce: string | undefined }, extra: { request_id?: string; current_revision?: number } = {}): void {
    if (at.generation !== this.generation || at.nonce !== this.nonce || !this.active) return;
    this.options.post(this.envelope("response.problem", this.bound({
      request_message_id: request.message_id,
      problem: { code, status, detail, request_id: extra.request_id ?? `dev_${this.sequence.toString(36).padStart(6, "0")}`, ...(extra.current_revision === undefined ? {} : { current_revision: extra.current_revision }) },
    })));
  }

  private async dispatch(request: { message_id: string; kind: string; payload: Record<string, unknown> }): Promise<void> {
    const at = { generation: this.generation, nonce: this.nonce };
    const { kind, payload } = request;
    switch (kind) {
      case "log": this.recordLog(payload); return;
      case "kv.watch": this.watchKv(); return;
      case "visibility.watch": if (this.supports(kind)) { this.visibilityWatching = true; this.options.log({ type: "visibility.watch", level: "debug" }); } return;
      case "device.watch": if (this.supports(kind)) this.deviceWatch(payload); return;
      default: break;
    }
    const handler = this.requests[kind];
    if (!handler || !this.supports(kind)) {
      this.problem(request, "not_supported", 501, `The harness does not implement ${kind.slice(0, 64)}.`, at);
      return;
    }
    if (handler.capability && !this.options.capabilities[handler.capability]) {
      this.problem(request, "forbidden", 403, `${kind} needs the ${handler.capability} capability.`, at);
      return;
    }
    try {
      const outcome = await handler.run.call(this, payload, request);
      if (outcome === undefined) return;
      this.reply(request, outcome, at);
      if (outcome.ok && at.generation === this.generation && at.nonce === this.nonce) (outcome as HostOutcome).after?.();
    } catch (error) {
      this.problem(request, "internal_error", 500, error instanceof Error ? error.message : String(error), at);
    }
  }

  private readonly requests: Record<string, { capability?: CapabilityName; run: (this: BridgeHost, payload: Record<string, unknown>, request: { message_id: string }) => HostOutcome | undefined | Promise<HostOutcome | undefined> }> = {
    "ready": { run: () => { this.readied = true; this.options.log({ type: "ready" }); return { ok: true }; } },
    "event.emit": { run: this.emitEvent },
    "page.advance": { capability: "page.advance", run: this.pageAdvance },
    "page.skip": { capability: "page.skip", run: this.pageSkip },
    "page.timing": { run: this.pageTimingRequest },
    "kv.get": { capability: "kv.read", run: this.kvGet },
    "kv.list": { capability: "kv.read", run: this.kvList },
    "kv.set": { capability: "kv.write", run: this.kvSet },
    "kv.delete": { capability: "kv.write", run: this.kvDelete },
    "device.display": { capability: "device.display", run: this.deviceDisplay },
    "device.vibrate": { capability: "device.haptics", run: this.deviceVibrate },
    "device.scanner.start": { capability: "device.camera", run: this.scannerStart },
    "device.scanner.stop": { capability: "device.camera", run: () => this.frame.scannerStop() },
    "device.serial.list": { capability: "device.serial", run: () => this.frame.serialList() },
    "device.serial.open": { capability: "device.serial", run: (payload) => { const outcome = this.frame.serialOpen(payload); if (outcome.ok) this.lastOpened = (outcome.result as { handle: string }).handle; return outcome; } },
    "device.serial.write": { capability: "device.serial", run: this.serialWrite },
    "device.serial.close": { capability: "device.serial", run: (payload) => this.frame.serialClose(payload) },
    "device.gpio.write": { capability: "device.gpio", run: this.gpioWrite },
    "device.gpio.watch": { capability: "device.gpio", run: this.gpioWatch },
    "device.ble.read": { capability: "device.ble", run: (payload) => this.frame.bleRead(payload) },
    "device.ble.watch": { capability: "device.ble", run: (payload) => this.frame.bleWatch(payload, this.watching.has("ble")) },
    "device.ble.unwatch": { capability: "device.ble", run: (payload) => this.frame.bleUnwatch(payload) },
    "device.printers": { capability: "device.print", run: () => this.frame.printers() },
    "device.print": { capability: "device.print", run: (payload) => this.frame.print(payload) },
  };

  // Notifications.

  private recordLog(payload: Record<string, unknown>): void {
    const level = payload.level === "debug" || payload.level === "info" || payload.level === "warn" || payload.level === "error" ? payload.level : "info";
    const code = typeof payload.code === "string" ? payload.code.slice(0, 64) : "";
    const message = typeof payload.message === "string" ? payload.message.slice(0, 2048) : "";
    this.options.log({ type: "log", level, code, message });
  }

  private watchKv(): void {
    if (!this.options.capabilities["kv.read"] || !this.supports("kv.watch")) return;
    this.kvWatching = true;
    this.options.log({ type: "kv.watch", level: "debug" });
  }

  private kvChanged(change: { key: string; revision?: number; deleted: boolean }): void {
    this.options.log({ type: "kv.changed", detail: { key: change.key, revision: change.revision ?? null, deleted: change.deleted } });
    if (!this.active || !this.kvWatching) return;
    this.options.post(this.envelope("kv.changed", this.bound({ key: change.key, ...(change.deleted ? {} : { revision: change.revision }), deleted: change.deleted })));
  }

  // Requests.

  private async emitEvent(payload: Record<string, unknown>): Promise<HostOutcome> {
    if (typeof payload.code !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(payload.code)) return { ok: false, code: "invalid_request", status: 400, detail: "code must be 1 to 64 of A-Z a-z 0-9 . _ -." };
    const answer = await this.options.events.emit(payload.code, this.options.primitiveId);
    return answer.ok ? { ok: true } : { ...answer };
  }

  private pageAdvance(): Outcome {
    if (this.advanced) return { ok: false, code: "forbidden", status: 403, detail: "page.advance is one-shot per activation." };
    this.advanced = true;
    this.finish("advance");
    return { ok: true };
  }

  private pageSkip(payload: Record<string, unknown>): Outcome {
    const now = this.options.clock();
    if (this.readied || now - this.activatedAt > SKIP_WINDOW_MS) return { ok: false, code: "forbidden", status: 403, detail: "page.skip is a start-time decision: not after ready, nor after the skip window." };
    const reason = sanitizeSkipReason(payload.reason);
    this.finish("skip", reason);
    return { ok: true };
  }

  private finish(end: PageEnd, detail?: string): void {
    if (this.ended) return;
    this.ended = end;
    this.options.log({ type: end === "skip" ? "page.skip" : end === "advance" ? "page.advance" : "page.end", detail: { ...(detail === undefined ? {} : { reason: detail }), reason_kind: end } });
    this.onPageEnd?.(end, detail);
  }

  /** Ends the page at its max_ms when the timer has run out. */
  checkPageEnd(): void {
    if (this.ended || this.maxMs === null || this.active === false) return;
    if (this.elapsedMs() >= this.maxMs) this.finish("max_ms");
  }

  elapsedMs(): number {
    const now = this.options.clock();
    return Math.max(0, Math.floor((this.pausedAt ?? now) - this.startedAt - this.pausedTotal));
  }

  remainingMs(): number | null {
    return this.maxMs === null ? null : Math.max(0, Math.floor(this.maxMs - this.elapsedMs()));
  }

  private pageTimingRequest(): Outcome {
    return { ok: true, result: { elapsed_ms: this.elapsedMs(), remaining_ms: this.remainingMs(), paused: this.held.size > 0 } };
  }

  /** For the conformance fixtures: the page timer as the `host.page` of a fixture states it. */
  restorePage(page: { elapsedMs: number; remainingMs: number | null; held: Held[]; visibilityWatching: boolean }): void {
    const now = this.options.clock();
    this.held.clear();
    for (const cause of page.held) this.held.add(cause);
    this.startedAt = now - page.elapsedMs;
    this.pausedTotal = 0;
    this.pausedAt = this.held.size > 0 ? now : undefined;
    this.maxMs = page.remainingMs === null ? null : page.elapsedMs + page.remainingMs;
    this.visibilityWatching = page.visibilityWatching;
  }

  /** The page's own max_ms and whether the page timer restarts. */
  startTimer(maxMs: number | null): void {
    const now = this.options.clock();
    this.maxMs = maxMs;
    this.startedAt = now;
    this.pausedTotal = 0;
    this.pausedAt = this.held.size > 0 ? now : undefined;
    this.ended = undefined;
  }

  private async kvGet(payload: Record<string, unknown>): Promise<Outcome> {
    if (!validKvKey(payload.key)) return { ok: false, code: "invalid_request", status: 400, detail: "key must be a valid key." };
    return this.kvOutcome(await this.options.kv.get(payload.key), (entry) => entry);
  }

  private async kvList(): Promise<Outcome> {
    return this.kvOutcome(await this.options.kv.list(), (items) => ({ items }));
  }

  private async kvSet(payload: Record<string, unknown>): Promise<Outcome> {
    if (!validKvKey(payload.key)) return { ok: false, code: "invalid_request", status: 400, detail: "key must be a valid key." };
    if (typeof payload.value_base64 !== "string" || base64Length(payload.value_base64) === undefined) return { ok: false, code: "invalid_request", status: 400, detail: "value_base64 must be base64." };
    if (payload.content_type !== undefined && typeof payload.content_type !== "string") return { ok: false, code: "invalid_request", status: 400, detail: "content_type must be a string." };
    if (typeof payload.idempotency_key !== "string") return { ok: false, code: "invalid_request", status: 400, detail: "idempotency_key must be a string." };
    const expected = payload.expected_revision;
    if (expected !== undefined && (typeof expected !== "number" || !Number.isSafeInteger(expected) || expected < 0)) return { ok: false, code: "invalid_request", status: 400, detail: "expected_revision must be a non-negative integer." };
    const result = await this.options.kv.set(payload.key, {
      valueBase64: payload.value_base64,
      contentType: (payload.content_type as string | undefined) ?? "application/octet-stream",
      idempotencyKey: payload.idempotency_key,
      ...(expected === undefined ? {} : { expectedRevision: expected as number }),
    });
    return this.kvOutcome(result, (entry) => entry);
  }

  private async kvDelete(payload: Record<string, unknown>): Promise<Outcome> {
    if (!validKvKey(payload.key)) return { ok: false, code: "invalid_request", status: 400, detail: "key must be a valid key." };
    if (typeof payload.idempotency_key !== "string") return { ok: false, code: "invalid_request", status: 400, detail: "idempotency_key must be a string." };
    const expected = payload.expected_revision;
    if (expected !== undefined && (typeof expected !== "number" || !Number.isSafeInteger(expected) || expected < 0)) return { ok: false, code: "invalid_request", status: 400, detail: "expected_revision must be a non-negative integer." };
    const result = await this.options.kv.delete(payload.key, { idempotencyKey: payload.idempotency_key, ...(expected === undefined ? {} : { expectedRevision: expected as number }) });
    return this.kvOutcome(result, () => undefined);
  }

  private kvOutcome<T>(result: KvResult<T>, shape: (value: T) => unknown): Outcome {
    if (result.ok) {
      const body = shape(result.value);
      return body === undefined ? { ok: true } : { ok: true, result: body };
    }
    const { problem } = result;
    return { ok: false, code: problem.code, status: problem.status, detail: problem.detail, request_id: problem.request_id, ...(problem.current_revision === undefined ? {} : { current_revision: problem.current_revision }) };
  }

  // Display, vibration.

  private effectiveOn(): boolean {
    return this.display.on && !this.darkHeld;
  }

  private displayState(): { on: boolean; brightness: number | null } {
    return { on: this.effectiveOn(), brightness: this.display.brightness };
  }

  private deviceDisplay(payload: Record<string, unknown>): Outcome {
    if (unknownMembers(payload, ["generation", "nonce", "on", "brightness"]).length > 0) return { ok: false, code: "invalid_request", status: 400, detail: "device.display takes on and brightness only." };
    if (payload.on !== undefined && typeof payload.on !== "boolean") return { ok: false, code: "invalid_request", status: 400, detail: "on must be true or false." };
    const brightness = payload.brightness;
    if (brightness !== undefined && (typeof brightness !== "number" || !Number.isFinite(brightness) || brightness < 0 || brightness > 1)) return { ok: false, code: "invalid_request", status: 400, detail: "brightness is a number from 0 to 1." };
    const before = this.displayState();
    if (payload.on !== undefined) this.display.on = payload.on;
    if (brightness !== undefined) this.display.brightness = brightness as number;
    this.options.log({ type: "device.display", detail: { requested: { on: payload.on ?? null, brightness: brightness ?? null }, effective: this.displayState() } });
    this.displayEffectiveChanged(before);
    return { ok: true, result: this.displayState() };
  }

  private deviceVibrate(payload: Record<string, unknown>): Outcome {
    if (unknownMembers(payload, ["generation", "nonce", "ms"]).length > 0) return { ok: false, code: "invalid_request", status: 400, detail: "device.vibrate takes ms only." };
    const ms = payload.ms;
    if (typeof ms !== "number" || !Number.isInteger(ms) || ms < 1 || ms > 200) return { ok: false, code: "invalid_request", status: 400, detail: "ms is a whole number from 1 to 200." };
    this.options.log({ type: "device.vibrate", detail: { ms } });
    return { ok: true };
  }

  private scannerStart(payload: Record<string, unknown>): Outcome {
    if (!this.options.capabilities["device.scan"]) return { ok: false, code: "forbidden", status: 403, detail: "device.scanner.start needs the device.scan capability as well." };
    return this.frame.scannerStart(payload);
  }

  // Serial and GPIO with their pushes.

  private serialWrite(payload: Record<string, unknown>): HostOutcome {
    const outcome = this.frame.serialWrite(payload);
    if (!outcome.ok) return outcome;
    const echo = outcome.effect?.echo as string | undefined;
    const bytes = outcome.effect?.bytes as Buffer;
    // The simulated device answers the write with the same bytes, after the ack.
    return { ok: true, ...(echo === undefined ? {} : { after: () => { this.trigger({ device: "serial", handle: echo, data_base64: bytes.toString("base64") }); } }) };
  }

  private gpioWrite(payload: Record<string, unknown>): HostOutcome {
    const outcome = this.frame.gpioWrite(payload);
    if (!outcome.ok) return outcome;
    const { pin, value } = outcome.effect as { pin: number; value: boolean };
    return { ok: true, after: () => { this.trigger({ device: "gpio", pin, value }); } };
  }

  private gpioWatch(payload: Record<string, unknown>): HostOutcome {
    const outcome = this.frame.gpioWatch(payload, this.watching.has("gpio"));
    if (!outcome.ok) return outcome;
    const added = (outcome.effect?.added as number[] | undefined) ?? [];
    // The ack goes first; each line newly in the set then posts its level at once.
    return {
      ok: true, result: outcome.result,
      after: () => {
        for (const pin of added) {
          const spec = this.options.hardware.gpio.pins.find((candidate) => candidate.pin === pin);
          if (spec && this.frame.watchedPins.includes(pin) && this.watching.has("gpio")) this.deviceEvent({ type: "gpio", pin, value: spec.value });
        }
      },
    };
  }

  // device.watch.

  private deviceWatch(payload: Record<string, unknown>): void {
    const requested = Array.isArray(payload.events) ? payload.events.filter((name): name is string => typeof name === "string") : [];
    const next = new Set<string>();
    for (const event of WATCH_EVENTS) {
      if (requested.includes(event.name) && this.options.capabilities[event.capability] && this.supports(event.feature)) next.add(event.name);
    }
    const before = this.watching;
    this.watching = next;
    if (!next.has("gpio")) this.frame.watchedPins = [];
    if (!next.has("ble")) this.frame.subscriptions.clear();
    for (const name of next) if (!before.has(name)) this.limits = { ...this.limits, ...this.fresh(name) };
    this.options.log({ type: "device.watch", level: "debug", detail: { events: [...next] } });
    if (next.has("network") && !before.has("network")) this.deviceEvent({ type: "network", online: this.network.online });
  }

  private fresh(name: string): Partial<Limits> {
    switch (name) {
      case "light": return { light: undefined };
      case "people": return { people: undefined };
      case "sound": return { sound: undefined };
      case "presence": return { presence: undefined };
      case "scan": return { scan: undefined };
      default: return {};
    }
  }

  private deviceEvent(payload: Record<string, unknown>): void {
    if (!this.active) return;
    this.options.post(this.envelope("device.event", this.bound(payload)));
    this.options.log({ type: `device.event.${String(payload.type)}`, level: "debug", detail: Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "type")) });
  }

  // Visibility.

  private cause(cause: Held, on: boolean): void {
    const now = this.options.clock();
    if (on) {
      if (this.held.has(cause)) return;
      const empty = this.held.size === 0;
      this.held.add(cause);
      if (empty) this.pausedAt = now;
      if (empty) this.postVisible(false, cause);
    } else {
      if (!this.held.has(cause)) return;
      this.held.delete(cause);
      if (this.held.size === 0) {
        if (this.pausedAt !== undefined) this.pausedTotal += now - this.pausedAt;
        this.pausedAt = undefined;
        this.postVisible(true, cause);
      }
    }
  }

  private postVisible(visible: boolean, reason: "display" | "paused" | "leaving"): void {
    if (!this.active || !this.visibilityWatching || this.leftPosted) return;
    this.options.post(this.envelope("visibility.changed", this.bound({ visible, reason })));
    this.options.log({ type: "visibility.changed", level: "debug", detail: { visible, reason } });
  }

  /** Best effort, once: the frame is about to be torn down or hidden. */
  leaving(): void {
    if (!this.active || this.leftPosted) return;
    this.postVisible(false, "leaving");
    this.leftPosted = true;
  }

  setPaused(paused: boolean): void {
    this.cause("paused", paused);
  }

  private displayEffectiveChanged(before: { on: boolean; brightness: number | null }): void {
    const after = this.displayState();
    if (after.on === before.on && after.brightness === before.brightness) return;
    if (this.watching.has("display")) this.deviceEvent({ type: "display", on: after.on, brightness: after.brightness });
    this.cause("display", !after.on);
  }

  /** The screen's schedule or an operator holds the display dark (or releases it). */
  holdDisplayDark(dark: boolean): void {
    const before = this.displayState();
    this.darkHeld = dark;
    this.displayEffectiveChanged(before);
  }

  // Triggers: the device and the page change, and the frame is told what it opted in to.

  trigger(trigger: Trigger): TriggerResult {
    const now = this.options.clock();
    if ("page" in trigger) {
      if (trigger.page === "display") { this.displayChanged(trigger.on, undefined); return { posted: false }; }
      if (trigger.page === "pause") { this.setPaused(trigger.paused); return { posted: false }; }
      this.leaving();
      return { posted: false };
    }
    switch (trigger.device) {
      case "watch": return { posted: false };
      case "display": this.displayChanged(trigger.on, trigger.brightness); return { posted: false };
      case "presence": return this.sample("presence", trigger.atMs ?? now, () => {
        const last = this.limits.presence;
        if (last !== undefined && (trigger.atMs ?? now) - last < 1000) return "at most one presence per second";
        this.limits.presence = trigger.atMs ?? now;
        this.deviceEvent({ type: "presence" });
        return undefined;
      });
      case "key": return this.key(trigger.key, trigger.action);
      case "light": return this.light(trigger.lux, trigger.atMs ?? now);
      case "network": return this.networkChanged(trigger.online);
      case "typing": return this.typing(trigger.text, trigger.gapMs, trigger.enter, trigger.field, trigger.atMs ?? now);
      case "scan": return this.scan(trigger.source, trigger.format, trigger.data, trigger.atMs ?? now);
      case "people": return this.people(trigger.count, trigger.atMs ?? now);
      case "sound": return this.sound(trigger.dbfs, trigger.atMs ?? now);
      case "serial": return this.serial(trigger);
      case "gpio": return this.gpio(trigger.pin, trigger.value);
      case "ble": return this.ble(trigger.subscription, trigger.value_base64);
    }
  }

  private sample(name: string, _at: number, work: () => string | undefined): TriggerResult {
    if (!this.watching.has(name)) return { posted: false, dropped: `the frame does not watch ${name}` };
    const dropped = work();
    return dropped === undefined ? { posted: true } : { posted: false, dropped };
  }

  private displayChanged(on: boolean, brightness: number | null | undefined): void {
    const before = this.displayState();
    this.display.on = on;
    if (brightness !== undefined) this.display.brightness = brightness;
    this.displayEffectiveChanged(before);
  }

  private key(key: string, action: "down" | "up"): TriggerResult {
    if (!this.watching.has("keys") || !KEYS.includes(key)) return { posted: false, consumed: false, dropped: this.watching.has("keys") ? "not a volume key" : "the frame does not watch keys" };
    if (action === "down") this.deviceEvent({ type: "key", key });
    return { posted: action === "down", consumed: true };
  }

  private light(lux: number, at: number): TriggerResult {
    return this.sample("light", at, () => {
      if (!Number.isFinite(lux) || lux < 0) return "lux must be a number from 0";
      const last = this.limits.light;
      if (last !== undefined) {
        if (at - last.at < 1000) return "at most one light reading per second";
        const crossed = (last.lux >= 1) !== (lux >= 1);
        const moved = last.lux === 0 ? lux !== 0 : Math.abs(lux - last.lux) / last.lux >= 0.1;
        if (!crossed && !moved) return "the change is under 10% and does not cross 1 lux";
      }
      this.limits.light = { lux, at };
      this.deviceEvent({ type: "light", lux });
      return undefined;
    });
  }

  private networkChanged(online: boolean): TriggerResult {
    if (this.network.online === online) return { posted: false, dropped: "connectivity did not change" };
    this.network.online = online;
    if (!this.watching.has("network")) return { posted: false, dropped: "the frame does not watch network" };
    this.deviceEvent({ type: "network", online });
    return { posted: true };
  }

  private people(count: number, at: number): TriggerResult {
    return this.sample("people", at, () => {
      if (!Number.isInteger(count) || count < 0 || count > 1000) return "count is a whole number from 0 to 1000";
      const last = this.limits.people;
      if (last !== undefined && (last.count === count || at - last.at < 1000)) return last.count === count ? "the count did not change" : "at most one people reading per second";
      this.limits.people = { count, at };
      this.deviceEvent({ type: "people", count });
      return undefined;
    });
  }

  private sound(dbfs: number, at: number): TriggerResult {
    return this.sample("sound", at, () => {
      if (!Number.isFinite(dbfs) || dbfs < -120 || dbfs > 0) return "dbfs is a number from -120 to 0";
      if (this.limits.sound !== undefined && at - this.limits.sound < 1000) return "at most one sound reading per second";
      this.limits.sound = at;
      this.deviceEvent({ type: "sound", dbfs });
      return undefined;
    });
  }

  private postScan(source: string, format: string, data: string, at: number): TriggerResult {
    if (data.length < 1 || data.length > 2048 || !FORMAT_RE.test(format)) return { posted: false, dropped: "a scan is 1 to 2048 characters with a format of a-z 0-9 _" };
    if (this.limits.scan !== undefined && at - this.limits.scan < 100) return { posted: false, dropped: "at most one scan per 100 ms" };
    if (source === "camera") {
      const code = `${format}:${data}`;
      const seen = this.limits.codes.get(code);
      if (seen !== undefined && at - seen < 2000) return { posted: false, dropped: "the camera posts a code again only after 2000 ms" };
      this.limits.codes.set(code, at);
    }
    this.limits.scan = at;
    this.deviceEvent({ type: "scan", source, format, data });
    return { posted: true };
  }

  private typing(text: string, gapMs: number, enter: boolean, field: boolean, at: number): TriggerResult {
    const burst = this.watching.has("scan") && !field && enter && [...text].length >= 4 && gapMs <= 50;
    if (!burst) return { posted: false, consumed: false, dropped: this.watching.has("scan") ? "not a scanner burst: it is typed into the page" : "the frame does not watch scan" };
    return { ...this.postScan("scanner", "text", text, at), consumed: true };
  }

  private scan(source: string, format: string, data: string, at: number): TriggerResult {
    if (!this.watching.has("scan")) return { posted: false, dropped: "the frame does not watch scan" };
    if (!SCAN_SOURCES.includes(source) || source === "scanner") return { posted: false, dropped: "source is nfc or camera" };
    if (source === "nfc" && !NFC_FORMATS.includes(format)) return { posted: false, dropped: "an NFC read is uid, ndef_text or ndef_uri" };
    if (source === "camera" && !this.frame.scanning) return { posted: false, dropped: "the scanner is not running (device.scanner.start)" };
    return this.postScan(source, format, data, at);
  }

  private serial(trigger: Extract<Trigger, { device: "serial" }>): TriggerResult {
    const handle = trigger.handle === "$opened" ? this.lastOpened : trigger.handle;
    if (handle === undefined || !this.frame.ports.has(handle)) return { posted: false, dropped: "the frame holds no such port" };
    if (!this.watching.has("serial")) return { posted: false, dropped: "the frame does not watch serial" };
    if (trigger.closed) {
      this.deviceEvent({ type: "serial", handle, closed: true, ...(trigger.reason === "unplugged" || trigger.reason === "error" ? { reason: trigger.reason } : {}) });
      this.frame.ports.delete(handle);
      return { posted: true };
    }
    const bytes = Buffer.from(trigger.data_base64 ?? "", "base64");
    if (bytes.length === 0) return { posted: false, dropped: "no bytes" };
    for (let offset = 0; offset < bytes.length; offset += DEVICE_CHUNK_BYTES) {
      this.deviceEvent({ type: "serial", handle, data_base64: bytes.subarray(offset, offset + DEVICE_CHUNK_BYTES).toString("base64") });
    }
    return { posted: true };
  }

  private gpio(pin: number, value: boolean): TriggerResult {
    const spec = this.options.hardware.gpio.pins.find((candidate) => candidate.pin === pin);
    if (!spec) return { posted: false, dropped: "the device has no such line" };
    const changed = spec.value !== value;
    spec.value = value;
    if (!changed) return { posted: false, dropped: "the level did not change" };
    if (!this.watching.has("gpio") || !this.frame.watchedPins.includes(pin)) return { posted: false, dropped: "the frame does not listen to this line" };
    this.deviceEvent({ type: "gpio", pin, value });
    return { posted: true };
  }

  private ble(subscription: string, valueBase64: string): TriggerResult {
    if (!this.watching.has("ble") || !this.frame.subscriptions.has(subscription)) return { posted: false, dropped: "the frame holds no such subscription" };
    const length = base64Length(valueBase64);
    if (length === undefined || length > 512) return { posted: false, dropped: "a notification is 0 to 512 bytes of base64" };
    this.deviceEvent({ type: "ble", subscription, value_base64: valueBase64 });
    return { posted: true };
  }

  /** A notification of a characteristic: the value is stored, and every subscription to it hears it. */
  bleNotify(service: string, characteristic: string, valueBase64: string): number {
    for (const peripheral of this.options.hardware.ble.peripherals) {
      for (const candidate of peripheral.services) {
        if (candidate.service !== service) continue;
        const found = candidate.characteristics.find((item) => item.characteristic === characteristic);
        if (found) found.value_base64 = valueBase64;
      }
    }
    let heard = 0;
    for (const subscription of this.frame.subscriptions.values()) {
      if (subscription.service === service && subscription.characteristic === characteristic && this.ble(subscription.subscription, valueBase64).posted) heard += 1;
    }
    return heard;
  }

  /** What the harness shows of the host. */
  state(): Record<string, unknown> {
    return {
      generation: this.generation,
      active: this.active,
      ready: this.readied,
      advanced: this.advanced,
      ended: this.ended ?? null,
      held: [...this.held],
      visibility_watching: this.visibilityWatching,
      kv_watching: this.kvWatching,
      watching: [...this.watching],
      display: this.displayState(),
      display_held_dark: this.darkHeld,
      network: { ...this.network },
      page: { elapsed_ms: this.elapsedMs(), remaining_ms: this.remainingMs(), max_ms: this.maxMs, paused: this.held.size > 0 },
      capabilities: { ...this.options.capabilities },
      features: this.options.features === null ? null : [...this.options.features],
      hardware: this.options.hardware,
      frame: this.frame.state(),
    };
  }
}

export { CAPABILITY_NAMES, PRIMITIVE_ID_RE };
