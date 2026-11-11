import { createHash } from "node:crypto";
import { allCapabilities, CAPABILITY_NAMES, FEATURE_NAMES, isRecord, type CapabilityName, type Posted, type Size } from "./bridge-protocol.js";
import { BridgeHost, contextMembers, type EventSink, type HostEvent, type Trigger } from "./bridge-host.js";
import { defaultHardware, type Hardware } from "./hardware.js";
import type { KvStore } from "./kv.js";
import { buildDevRelease, type DevRelease, type Refusal } from "./release.js";
import { appOrigin, playerOrigin } from "./origins.js";
import type { UdpTransport } from "./udp.js";

/** One line of the event log: shown on the page and, for the kinds in TERMINAL, printed. */
export interface LogEntry {
  seq: number;
  at: string;
  type: string;
  level?: "debug" | "info" | "warn" | "error";
  code?: string;
  message?: string;
  detail?: Record<string, unknown>;
}

/** Kinds worth a line in the terminal; the page shows all of them. */
export const TERMINAL_TYPES: ReadonlySet<string> = new Set([
  "emit", "log", "release.built", "release.refused", "release.changed", "activated", "page.advance", "page.skip", "page.end", "kv.changed", "kv.problem", "harness.warning",
]);

export type ServerEvent =
  | { event: "state"; data: unknown }
  | { event: "bridge"; data: Posted }
  | { event: "log"; data: LogEntry }
  | { event: "frame"; data: { action: "reload" | "restart"; src: string; allow: string } };

export interface SessionOptions {
  directory: string;
  port: number;
  releaseHost: string;
  applicationId: string;
  releaseId: string;
  kv: KvStore;
  kvMode: "file" | "remote";
  kvLocation: string;
  autoReload: boolean;
  hardware?: Hardware;
  /** Where the application's UDP sockets bind. Without one they are simulated and hold no socket; `app dev` binds loopback. */
  udp?: UdpTransport;
  clock?: () => number;
  /** Where terminal lines go. */
  print?: (entry: LogEntry) => void;
}

export const VIEWPORT_PRESETS: Record<string, Size> = {
  "1920x1080": { width: 1920, height: 1080 },
  "3840x2160": { width: 3840, height: 2160 },
  "1080x1920": { width: 1080, height: 1920 },
};

const MAX_LOG = 500;
/** What every frame may do, as the Permissions Policy `allow` attribute says it. */
const FRAME_ALLOW = "autoplay; fullscreen; clipboard-read; clipboard-write";
const PRIMITIVE_ID = "prm_dev_0001";

function isSize(value: unknown): value is Size {
  return isRecord(value) && Number.isInteger(value.width) && Number.isInteger(value.height)
    && (value.width as number) >= 1 && (value.width as number) <= 8192 && (value.height as number) >= 1 && (value.height as number) <= 8192;
}

/** A command the harness page sent that cannot be carried out. */
export class CommandError extends Error {}

function digestOf(release: DevRelease): string {
  const hash = createHash("sha256");
  for (const path of [...release.files.keys()].sort()) hash.update(`${path}\0${release.files.get(path)!.etag}\0`);
  return hash.digest("hex");
}

/**
 * Everything the harness knows: the release being served, the bridge host and
 * its device, the launch settings the page edits, and the event log. The HTTP
 * server and the page are two views of it; every change reaches the page as a
 * state event.
 */
export class DevSession {
  release: DevRelease | undefined;
  refusal: Refusal | undefined;
  host: BridgeHost;
  viewport: Size = { ...VIEWPORT_PRESETS["1920x1080"]! };
  preset = "1920x1080";
  screen: { name: string; timezone: string } = { name: "", timezone: "" };
  params: Record<string, string> = {};
  timer: { enabled: boolean; maxMs: number } = { enabled: false, maxMs: 15_000 };
  loop = true;
  readonly log: LogEntry[] = [];
  readonly clients = new Set<(event: ServerEvent) => void>();
  private seq = 0;
  private revision = 0;
  private digest = "";
  private snapshotQueued = false;
  private interval: ReturnType<typeof setInterval> | undefined;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly hardware: Hardware;
  private readonly clock: () => number;
  private building: Promise<void> = Promise.resolve();
  private changedSinceLoad = false;

  constructor(readonly options: SessionOptions) {
    this.clock = options.clock ?? (() => Date.now());
    this.hardware = options.hardware ?? defaultHardware();
    this.host = this.newHost();
  }

  private newHost(): BridgeHost {
    const events: EventSink = {
      emit: async (code, primitiveId) => {
        this.record({ type: "emit", code, detail: { primitive_id: primitiveId } });
        return { ok: true };
      },
    };
    const capabilities = this.host?.capabilities ?? allCapabilities(true);
    const host = new BridgeHost({
      applicationId: this.options.applicationId,
      releaseId: this.options.releaseId,
      primitiveId: PRIMITIVE_ID,
      playerOrigin: playerOrigin(this.options.port),
      appOrigin: appOrigin(this.options.releaseHost, this.options.port),
      capabilities,
      features: this.host ? this.host.options.features : [...FEATURE_NAMES],
      viewport: { ...this.viewport },
      manifest: this.manifest(),
      hardware: this.hardware,
      ...(this.options.udp ? { udp: this.options.udp } : {}),
      kv: this.options.kv,
      events,
      clock: this.clock,
      post: (message) => this.broadcast({ event: "bridge", data: message }),
      log: (event) => this.hostEvent(event),
    });
    host.onPageEnd = (end, detail) => this.pageEnded(end, detail);
    return host;
  }

  private manifest(): { launchParams?: unknown; screenLabel?: unknown; timezone?: unknown } {
    return {
      ...(Object.keys(this.params).length > 0 ? { launchParams: this.params } : {}),
      screenLabel: this.screen.name,
      ...(this.screen.timezone ? { timezone: this.screen.timezone } : {}),
    };
  }

  /** Builds the first release and starts the page timer's clock. */
  async start(): Promise<void> {
    await this.rebuild();
    this.interval = setInterval(() => {
      this.host.checkPageEnd();
      if (this.clients.size > 0 && this.host.active) this.queueState();
    }, 250);
    this.interval.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.interval);
    clearTimeout(this.restartTimer);
    this.host.endContext();
    this.host.destroy();
    await this.options.kv.close();
  }

  // The release.

  /** Rebuilds from the directory; the app reloads when the files changed and the build is accepted. */
  rebuild(): Promise<void> {
    this.building = this.building.then(async () => {
      const result = await buildDevRelease(this.options.directory, this.revision + 1);
      if (!result.ok) {
        this.refusal = result.refusal;
        this.record({ type: "release.refused", level: "error", code: result.refusal.code, message: result.refusal.detail, detail: { ...(result.refusal.file ? { file: result.refusal.file } : {}), ...(result.refusal.line ? { line: result.refusal.line } : {}), serving: this.release ? "the last accepted build" : "nothing" } });
        this.queueState();
        return;
      }
      const digest = digestOf(result.release);
      const first = this.release === undefined;
      this.refusal = undefined;
      if (!first && digest === this.digest) {
        this.queueState();
        return;
      }
      this.revision += 1;
      this.digest = digest;
      this.release = result.release;
      this.record({ type: first ? "release.built" : "release.changed", message: `${result.release.file_count} files, ${result.release.expanded_bytes} bytes`, detail: { revision: this.revision, file_count: result.release.file_count, expanded_bytes: result.release.expanded_bytes, sdk_sha256: result.release.sdk_sha256 ?? null } });
      if (!first) {
        if (this.options.autoReload) this.restart("files changed");
        else { this.changedSinceLoad = true; this.queueState(); }
      } else this.queueState();
    });
    return this.building;
  }

  // The log and the stream to the page.

  record(event: HostEvent): LogEntry {
    const entry: LogEntry = { seq: ++this.seq, at: new Date().toISOString(), ...event } as LogEntry;
    this.log.push(entry);
    if (this.log.length > MAX_LOG) this.log.shift();
    this.broadcast({ event: "log", data: entry });
    if (TERMINAL_TYPES.has(entry.type)) this.options.print?.(entry);
    return entry;
  }

  private hostEvent(event: HostEvent): void {
    this.record(event);
    if (event.type === "ready" || event.type === "activated" || event.type === "device.display" || event.type === "visibility.watch" || event.type === "device.watch") this.queueState();
  }

  private broadcast(event: ServerEvent): void {
    for (const client of this.clients) {
      try { client(event); } catch { /* a closed stream is dropped by the server */ }
    }
    if (event.event === "bridge" || event.event === "log") this.queueState();
  }

  /** The state, coalesced: one event per tick however many changes happened in it. */
  queueState(): void {
    if (this.snapshotQueued || this.clients.size === 0) return;
    this.snapshotQueued = true;
    setImmediate(() => {
      this.snapshotQueued = false;
      for (const client of this.clients) {
        try { client({ event: "state", data: this.snapshot() }); } catch { /* see broadcast */ }
      }
    });
  }

  /**
   * The `allow` attribute of the application's frame. A frame whose page holds
   * the `device.hdmi_input` capability may use the camera and the microphone, so
   * `screenrig.device.hdmiInput.open()` gets the browser's capture device; a
   * frame without it may not. The policy applies when the frame loads.
   */
  frameAllow(): string {
    return this.host.capabilities["device.hdmi_input"] ? `${FRAME_ALLOW}; camera; microphone` : FRAME_ALLOW;
  }

  frameSrc(): string {
    const query = new URLSearchParams(contextMembers({ launchParams: this.params }).params ?? {}).toString();
    return `${appOrigin(this.options.releaseHost, this.options.port)}/index.html${query ? `?${query}` : ""}`;
  }

  snapshot(): Record<string, unknown> {
    return {
      directory: this.options.directory,
      port: this.options.port,
      player_origin: playerOrigin(this.options.port),
      app_origin: appOrigin(this.options.releaseHost, this.options.port),
      frame_src: this.frameSrc(),
      frame_allow: this.frameAllow(),
      application_id: this.options.applicationId,
      release_id: this.options.releaseId,
      release: this.release ? { revision: this.release.revision, file_count: this.release.file_count, expanded_bytes: this.release.expanded_bytes, built_at: this.release.built_at, sdk_sha256: this.release.sdk_sha256 ?? null } : null,
      refusal: this.refusal ?? null,
      changed_since_load: this.changedSinceLoad,
      auto_reload: this.options.autoReload,
      kv: { mode: this.options.kvMode, location: this.options.kvLocation },
      viewport: this.viewport,
      preset: this.preset,
      screen: this.screen,
      params: this.params,
      timer: this.timer,
      loop: this.loop,
      capability_names: CAPABILITY_NAMES,
      feature_names: FEATURE_NAMES,
      host: this.host.state(),
      log_tail: this.log.length,
    };
  }

  // Activation.

  /** The page loaded the application's frame. */
  frameLoaded(): void {
    this.changedSinceLoad = false;
    this.host.beginActivation();
    this.host.startTimer(this.timer.enabled ? this.timer.maxMs : null);
    this.queueState();
  }

  /** Ends the activation and loads the frame again: a new generation. */
  restart(reason = "restart"): void {
    clearTimeout(this.restartTimer);
    this.host.leaving();
    this.record({ type: "restart", level: "debug", message: reason });
    this.broadcast({ event: "frame", data: { action: "restart", src: this.frameSrc(), allow: this.frameAllow() } });
    this.changedSinceLoad = false;
    this.queueState();
  }

  private pageEnded(end: "advance" | "skip" | "max_ms", detail?: string): void {
    this.queueState();
    if (!this.loop) return;
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => this.restart(`page ended (${end}${detail ? `: ${detail}` : ""})`), 1200);
    this.restartTimer.unref();
  }

  /** A message the application's window posted, relayed by the page. */
  async fromApp(data: unknown, origin: string): Promise<void> {
    await this.host.receive(data, origin);
  }

  // Commands from the panel.

  async command(raw: unknown): Promise<unknown> {
    if (!isRecord(raw) || typeof raw.command !== "string") throw new CommandError("A command is an object with a command name.");
    const name = raw.command;
    switch (name) {
      case "frame-loaded": this.frameLoaded(); return {};
      case "restart": this.restart("restart requested"); return {};
      case "reload": this.restart("reload requested"); return {};
      case "capability": return this.setCapability(raw);
      case "capabilities": return this.setCapabilities(raw);
      case "feature": return this.setFeature(raw);
      case "viewport": return this.setViewport(raw);
      case "launch": return this.setLaunch(raw);
      case "timer": return this.setTimer(raw);
      case "loop": this.loop = raw.value === true; this.queueState(); return {};
      case "pause": this.host.setPaused(raw.paused === true); this.queueState(); return {};
      case "display": this.host.holdDisplayDark(raw.dark === true); this.queueState(); return {};
      case "leaving": this.host.leaving(); this.queueState(); return {};
      case "trigger": return this.fire(raw.trigger);
      case "ble-notify": return this.bleNotify(raw);
      case "serial-send": return this.serialSend(raw);
      case "udp-inject": return this.udpInject(raw);
      case "hardware": return this.setHardware(raw);
      case "clear-log": this.log.length = 0; this.queueState(); return {};
      default: throw new CommandError(`Unknown command ${name.slice(0, 40)}.`);
    }
  }

  private setCapability(raw: Record<string, unknown>): unknown {
    if (typeof raw.name !== "string" || !(CAPABILITY_NAMES as readonly string[]).includes(raw.name) || typeof raw.value !== "boolean") throw new CommandError("capability needs a capability name and true or false.");
    const allowBefore = this.frameAllow();
    this.host.setCapability(raw.name as CapabilityName, raw.value);
    this.allowChanged(allowBefore);
    this.queueState();
    return {};
  }

  private setCapabilities(raw: Record<string, unknown>): unknown {
    if (!isRecord(raw.values)) throw new CommandError("capabilities needs a values object.");
    const allowBefore = this.frameAllow();
    for (const [name, value] of Object.entries(raw.values)) {
      if (!(CAPABILITY_NAMES as readonly string[]).includes(name) || typeof value !== "boolean") throw new CommandError(`${name.slice(0, 40)} is not a capability set to true or false.`);
      this.host.options.capabilities[name as CapabilityName] = value;
    }
    this.host.refreshContext();
    this.allowChanged(allowBefore);
    this.queueState();
    return {};
  }

  /** A frame's permissions are fixed when it loads: when they change, it loads again (a new generation). */
  private allowChanged(before: string): void {
    if (this.frameAllow() !== before) this.restart(`the frame's camera and microphone permission changed (device.hdmi_input)`);
  }

  private setFeature(raw: Record<string, unknown>): unknown {
    if (typeof raw.name !== "string" || !(FEATURE_NAMES as readonly string[]).includes(raw.name) || typeof raw.value !== "boolean") throw new CommandError("feature needs a feature name and true or false.");
    const current = new Set(this.host.options.features ?? []);
    if (raw.value) current.add(raw.name); else current.delete(raw.name);
    this.host.setFeatures(FEATURE_NAMES.filter((feature) => current.has(feature)));
    this.queueState();
    return {};
  }

  private setViewport(raw: Record<string, unknown>): unknown {
    const size = { width: raw.width, height: raw.height };
    if (!isSize(size)) throw new CommandError("viewport needs whole-number width and height from 1 to 8192.");
    this.viewport = { width: size.width, height: size.height };
    const key = `${size.width}x${size.height}`;
    this.preset = key in VIEWPORT_PRESETS ? key : "custom";
    this.host.setViewport(this.viewport);
    this.queueState();
    return {};
  }

  private setLaunch(raw: Record<string, unknown>): unknown {
    const name = raw.name === undefined ? this.screen.name : raw.name;
    const timezone = raw.timezone === undefined ? this.screen.timezone : raw.timezone;
    if (typeof name !== "string" || typeof timezone !== "string") throw new CommandError("name and timezone are text.");
    if (timezone !== "") {
      try { new Intl.DateTimeFormat("en", { timeZone: timezone }); } catch { throw new CommandError(`${timezone.slice(0, 60)} is not an IANA time zone.`); }
    }
    let params = this.params;
    if (raw.params !== undefined) {
      if (!isRecord(raw.params)) throw new CommandError("params is an object of text values.");
      params = {};
      for (const [key, value] of Object.entries(raw.params)) {
        if (typeof value !== "string") throw new CommandError(`Launch param ${key.slice(0, 40)} must be text.`);
        params[key] = value;
      }
    }
    this.screen = { name, timezone };
    this.params = params;
    this.host.options.manifest = this.manifest();
    // A launch URL and a manifest changed: the application starts over with them.
    this.restart("launch settings changed");
    return { params: contextMembers({ launchParams: params }).params ?? {} };
  }

  private setTimer(raw: Record<string, unknown>): unknown {
    const maxMs = raw.maxMs === undefined ? this.timer.maxMs : raw.maxMs;
    if (typeof maxMs !== "number" || !Number.isInteger(maxMs) || maxMs < 1000 || maxMs > 86_400_000) throw new CommandError("maxMs is a whole number of milliseconds from 1000 to 86400000.");
    const enabled = raw.enabled === undefined ? this.timer.enabled : raw.enabled === true;
    this.timer = { enabled, maxMs };
    this.host.startTimer(enabled ? maxMs : null);
    this.queueState();
    return {};
  }

  private fire(raw: unknown): unknown {
    if (!isRecord(raw)) throw new CommandError("trigger needs a trigger object.");
    const device = raw.device;
    const page = raw.page;
    const allowed = ["display", "presence", "key", "light", "network", "typing", "scan", "people", "sound", "serial", "gpio", "ble", "ir", "udp"];
    if (!(typeof device === "string" && allowed.includes(device)) && !(page === "leaving" || page === "context")) throw new CommandError("trigger names a device event.");
    const result = this.host.trigger(raw as unknown as Trigger);
    this.record({ type: result.posted ? "harness.fired" : "harness.dropped", level: result.posted ? "debug" : "info", message: result.posted ? `${String(device ?? page)} sent` : `${String(device ?? page)} not sent${result.dropped ? `: ${result.dropped}` : ""}`, detail: { trigger: raw, ...(result.consumed === undefined ? {} : { consumed: result.consumed }), ...(result.drives && result.drives.length > 0 ? { drives: result.drives } : {}) } });
    this.queueState();
    return result;
  }

  private bleNotify(raw: Record<string, unknown>): unknown {
    const { service, characteristic } = raw;
    if (typeof service !== "string" || typeof characteristic !== "string") throw new CommandError("ble-notify needs service and characteristic.");
    const bytes = typeof raw.hex === "string" ? Buffer.from(raw.hex.replace(/[^0-9a-f]/gi, ""), "hex") : Buffer.from(String(raw.text ?? ""), "utf8");
    if (bytes.length > 512) throw new CommandError("A notification is at most 512 bytes.");
    const heard = this.host.bleNotify(service, characteristic, bytes.toString("base64"));
    this.record({ type: "harness.fired", level: "debug", message: `ble notify ${characteristic}: ${bytes.length} bytes, ${heard} subscription${heard === 1 ? "" : "s"} heard it` });
    this.queueState();
    return { heard };
  }

  private serialSend(raw: Record<string, unknown>): unknown {
    const handle = typeof raw.handle === "string" ? raw.handle : [...this.host.frame.ports.values()].find((port) => port.port === raw.port)?.handle;
    if (handle === undefined) throw new CommandError("The application has no open port to send to.");
    const bytes = typeof raw.hex === "string" ? Buffer.from(raw.hex.replace(/[^0-9a-f]/gi, ""), "hex") : Buffer.from(String(raw.text ?? ""), "utf8");
    if (bytes.length === 0) throw new CommandError("Nothing to send.");
    return this.fire({ device: "serial", handle, data_base64: bytes.toString("base64") });
  }

  /** A datagram arrives at a socket the application opened, from a peer the operator names (the loopback address and a port by default). */
  private udpInject(raw: Record<string, unknown>): unknown {
    const socket = typeof raw.socket === "string" ? raw.socket : [...this.host.frame.sockets.values()][0]?.handle;
    if (socket === undefined) throw new CommandError("The application has no open UDP socket to send to.");
    const bytes = typeof raw.hex === "string" ? Buffer.from(raw.hex.replace(/[^0-9a-f]/gi, ""), "hex") : Buffer.from(String(raw.text ?? ""), "utf8");
    if (bytes.length === 0) throw new CommandError("Nothing to send.");
    if (bytes.length > 8192) throw new CommandError("A datagram is at most 8192 bytes.");
    const host = raw.host === undefined || raw.host === "" ? "127.0.0.1" : raw.host;
    const port = raw.port === undefined || raw.port === "" ? 40000 : raw.port;
    if (typeof host !== "string" || host.length > 253) throw new CommandError("host is the sender's address.");
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) throw new CommandError("port is a whole number from 1 to 65535.");
    return this.fire({ device: "udp", socket, from_host: host, from_port: port, data_base64: bytes.toString("base64") });
  }

  private setHardware(raw: Record<string, unknown>): unknown {
    const hardware = this.hardware;
    const id = typeof raw.id === "string" ? raw.id : "";
    const value = raw.value === true;
    switch (raw.change) {
      case "serial.echo": this.port(id).echo = value; break;
      case "serial.busy": this.port(id).busy = value; break;
      case "printer.failing": { const printer = hardware.printers.find((candidate) => candidate.id === id); if (!printer) throw new CommandError("No such printer."); printer.failing = value; break; }
      case "pin.floating": { const pin = hardware.gpio.pins.find((candidate) => String(candidate.pin) === id); if (!pin) throw new CommandError("No such line."); pin.floating = value; pin.driven = undefined; break; }
      case "ir.available": hardware.ir.available = value; break;
      case "pin.busy": { const pin = hardware.gpio.pins.find((candidate) => String(candidate.pin) === id); if (!pin) throw new CommandError("No such line."); pin.busy = value; break; }
      case "gpio.chip": hardware.gpio.chip = value; break;
      case "ble.adapter": hardware.ble.adapter = value; break;
      case "camera.available": hardware.camera.available = value; break;
      case "network": this.host.trigger({ device: "network", online: value }); break;
      default: throw new CommandError("Unknown hardware change.");
    }
    this.queueState();
    return {};
  }

  /** The stored values for the page's table: key, revision, type and a short preview. */
  async kvView(): Promise<Record<string, unknown>> {
    const base = { mode: this.options.kvMode, location: this.options.kvLocation };
    const list = await this.options.kv.list();
    if (!list.ok) return { ...base, items: [], problem: list.problem.detail };
    const items = [];
    for (const summary of list.value) {
      const entry = await this.options.kv.get(summary.key);
      let preview = "";
      if (entry.ok) {
        const bytes = Buffer.from(entry.value.value_base64, "base64");
        preview = /^text\/|json|xml/.test(summary.content_type) ? bytes.subarray(0, 200).toString("utf8") : `${bytes.length} bytes`;
      }
      items.push({ key: summary.key, revision: summary.revision, content_type: summary.content_type, bytes: summary.bytes, preview });
    }
    return { ...base, items };
  }

  private port(id: string) {
    const port = this.hardware.serial.ports.find((candidate) => candidate.id === id);
    if (!port) throw new CommandError("No such serial port.");
    return port;
  }
}
