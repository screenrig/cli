import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import { readAsset } from "../assets.js";
import { testTemp } from "../test-temp.js";
import { createDevSession } from "./index.js";
import type { DevSession } from "./session.js";
import type { LogEntry, ServerEvent } from "./session.js";

// The pinned runtime itself, running in a sandbox that stands for the
// application's window, answered by the session's bridge host through the same
// path the harness page relays: host to window as `message` events from the
// Player origin, window to host as parent.postMessage.

type Json = Record<string, unknown>;
type Sdk = Record<string, any>;

// Values the runtime makes live in its own realm; compare what they say, not their prototypes.
const plain = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)) as T);
function same(actual: unknown, expected: unknown, message?: string): void {
  assert.deepEqual(plain(actual), expected, message);
}

// The runtime trusts the harness as its parent on port 18890 only, so the sandbox
// claims it. No socket is opened: the session is driven directly.
const PORT = 18890;

interface Handle { session: DevSession; releaseHost: string; kv: { location: string }; close(): Promise<void> }

async function start(files: Record<string, string> = { "index.html": "<!doctype html><title>t</title><p>x</p>" }): Promise<{ handle: Handle; printed: LogEntry[]; dir: string }> {
  const dir = await testTemp("dev-sdk-");
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), text);
  }
  const printed: LogEntry[] = [];
  const created = await createDevSession({ directory: dir, port: PORT, reload: true, print: (entry) => printed.push(entry) });
  const handle: Handle = { session: created.session, releaseHost: created.releaseHost, kv: created.kv, close: () => created.session.stop() };
  return { handle, printed, dir };
}

interface Frame {
  sdk: Sdk;
  /** Bytes made in the runtime's realm, which is the only kind it accepts as a Uint8Array. */
  bytes(values: ArrayLike<number>): Uint8Array;
  window: Json & { dispatch(type: string, event: unknown): void };
  close(): void;
}

/** A new application frame: a fresh runtime, loaded, handshaken and active. */
async function frame(handle: Handle, options: { activate?: boolean } = {}): Promise<Frame> {
  const { session } = handle;
  const player = session.snapshot().player_origin as string;
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const sandbox: Json = {
    location: { protocol: "http:", hostname: handle.releaseHost, port: new URL(player).port, origin: `http://${handle.releaseHost}:${new URL(player).port}` },
    navigator: { userAgent: "dev-test" },
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, crypto, TextEncoder, TextDecoder, atob, btoa, performance, console,
    addEventListener: (type: string, listener: (event: unknown) => void) => { (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(listener); },
    removeEventListener: (type: string, listener: (event: unknown) => void) => { listeners.get(type)?.delete(listener); },
    dispatch: (type: string, event: unknown) => { for (const listener of [...(listeners.get(type) ?? [])]) listener(event); },
  };
  const origin = sandbox.location as { origin: string };
  sandbox.parent = {
    postMessage: (data: unknown, targetOrigin: string) => {
      assert.equal(targetOrigin, player, "the runtime posts to the Player origin and no other");
      const copy = structuredClone(data);
      setImmediate(() => { void session.fromApp(copy, origin.origin); });
    },
  };
  sandbox.window = sandbox;
  const context = createContext(sandbox);
  const toWindow = (event: ServerEvent): void => {
    if (event.event !== "bridge") return;
    const data = structuredClone(event.data);
    setImmediate(() => { (sandbox.dispatch as (type: string, event: unknown) => void)("message", { data, origin: player, source: sandbox.parent }); });
  };
  session.clients.add(toWindow);
  runInContext(readAsset("screenrig.runtime.js").toString("utf8"), context);
  const sdk = sandbox.screenrig as Sdk;
  assert.ok(sdk, "the runtime attaches window.screenrig");
  if (options.activate !== false) {
    session.frameLoaded();
    await sdk.waitUntilActive(3000);
  }
  const Bytes = runInContext("Uint8Array", context) as Uint8ArrayConstructor;
  return { sdk, bytes: (values) => Bytes.from(values), window: sandbox as Frame["window"], close() { session.clients.delete(toWindow); sdk.destroy(); } };
}

async function until(check: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  for (const started = Date.now(); !check(); ) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

const command = (handle: Handle, body: Json) => handle.session.command(body);
const trigger = (handle: Handle, body: Json) => handle.session.command({ command: "trigger", trigger: body });

async function rejection(promise: Promise<unknown>): Promise<string> {
  try { await promise; } catch (error) { return (error as { code: string }).code; }
  return "resolved";
}

test("the pinned runtime handshakes with the harness, reads its context and reports ready", async () => {
  const { handle, printed } = await start();
  try {
    const { sdk, close } = await frame(handle);
    assert.equal(sdk.readyState, "active");
    const context = sdk.context;
    assert.equal(context.application_id, handle.session.options.applicationId);
    assert.match(context.application_id, /^app_dev_/);
    same([context.viewport.width, context.viewport.height], [1920, 1080]);
    assert.equal(context.player_origin, "http://play.screenrig.localhost:18890");
    assert.ok(Object.values(sdk.capabilities).every((granted) => granted === true) && Object.keys(sdk.capabilities).length === 20);
    for (const feature of ["kv.watch", "device.serial", "device.gpio", "device.ble", "device.print", "visibility.watch", "page.timing", "page.skip"]) assert.ok(sdk.supports(feature), feature);
    same(context.params, {});
    assert.equal(context.screen, undefined);
    await sdk.ready();
    assert.equal(handle.session.host.readied, true);
    assert.ok(printed.some((entry) => entry.type === "activated"));
    close();
  } finally { await handle.close(); }
});

test("an application on any other port stays inert: the runtime refuses a parent it does not trust", async () => {
  const { handle } = await start();
  try {
    // The release host on a port the runtime has no row for: the Player origin it would trust differs.
    const { session } = handle;
    const listeners = new Set<(event: unknown) => void>();
    const sandbox: Json = {
      location: { protocol: "http:", hostname: handle.releaseHost, port: "8081", origin: `http://${handle.releaseHost}:8081` },
      navigator: { userAgent: "dev-test" }, setTimeout, clearTimeout, setInterval, clearInterval, crypto, TextEncoder, TextDecoder, atob, btoa, performance, console,
      addEventListener: (_type: string, listener: (event: unknown) => void) => { listeners.add(listener); }, removeEventListener: () => undefined,
      parent: { postMessage: () => assert.fail("an untrusted parent is never answered") },
    };
    sandbox.window = sandbox;
    runInContext(readAsset("screenrig.runtime.js").toString("utf8"), createContext(sandbox));
    const sdk = sandbox.screenrig as Sdk;
    const player = session.snapshot().player_origin as string;
    for (const listener of listeners) listener({ data: { protocol: "screenrig.parent-handshake/1", kind: "parent.handshake", challenge: "a".repeat(32) }, origin: player, source: sandbox.parent });
    assert.notEqual(sdk.readyState, "active");
    sdk.destroy();
  } finally { await handle.close(); }
});

test("stored values: set, get, list, delete, conflicts, and kv.changed for the application's own writes and for edits to the file", async () => {
  const { handle } = await start();
  try {
    const { sdk, close } = await frame(handle);
    const changes: Json[] = [];
    const stop = sdk.kv.onChange((change: Json) => changes.push(change));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const written = await sdk.kv.set("greeting", "hello");
    assert.equal(written.revision, 1);
    assert.equal(await sdk.kv.getText("greeting"), "hello");
    await sdk.kv.setJSON("config", { theme: "dark" });
    same(await sdk.kv.get("config").then((entry: { content_type: string }) => entry.content_type), "application/json");
    const listed = await sdk.kv.list();
    same(listed.items.map((item: { key: string; revision: number }) => [item.key, item.revision]), [["config", 1], ["greeting", 1]]);
    assert.equal(await rejection(sdk.kv.set("greeting", "stale", { expectedRevision: 5 })), "revision_conflict");
    assert.equal(await rejection(sdk.kv.get("missing")), "not_found");
    await sdk.kv.delete("greeting");
    assert.equal(await rejection(sdk.kv.getText("greeting")), "not_found");
    await until(() => changes.length >= 3, "the application's own changes");
    same(changes.slice(0, 3), [{ key: "greeting", revision: 1, deleted: false }, { key: "config", revision: 1, deleted: false }, { key: "greeting", deleted: true }]);
    changes.length = 0;
    const file = handle.kv.location;
    const document = JSON.parse(await readFile(file, "utf8"));
    document.entries.config.value = { theme: "light" };
    await writeFile(file, JSON.stringify(document));
    await until(() => changes.length >= 1, "the outside edit");
    same(changes[0], { key: "config", revision: 2, deleted: false });
    stop();
    close();
  } finally { await handle.close(); }
});

test("emit, emitConfirmed, log and the runtime's forwarded uncaught errors print as structured entries", async () => {
  const { handle, printed } = await start();
  try {
    const { sdk, window, close } = await frame(handle);
    printed.length = 0;
    sdk.emit("visit.started");
    await sdk.emitConfirmed("visit.done");
    sdk.log({ level: "warn", code: "app.cache_miss", message: "cache miss for lobby" });
    window.dispatch("error", { message: "boom is not defined", filename: "http://x/app.js", lineno: 7, colno: 3 });
    window.dispatch("unhandledrejection", { reason: new Error("rejected promise") });
    await until(() => printed.filter((entry) => entry.type === "log").length >= 3, "the log entries");
    const emits = printed.filter((entry) => entry.type === "emit");
    same(emits.map((entry) => entry.code), ["visit.started", "visit.done"]);
    assert.equal(emits[0]!.detail?.primitive_id, "prm_dev_0001");
    const logs = printed.filter((entry) => entry.type === "log");
    same(logs[0], { ...logs[0]!, level: "warn", code: "app.cache_miss", message: "cache miss for lobby" });
    same(logs.slice(1).map((entry) => [entry.level, entry.code]), [["error", "uncaught_error"], ["error", "unhandled_rejection"]]);
    assert.match(logs[1]!.message!, /boom is not defined \(http:\/\/x\/app\.js:7:3\)/);
    close();
  } finally { await handle.close(); }
});

test("the page: nextPage and skip end it, the timer ends it at max_ms, and timing reads the clock", async () => {
  const { handle, printed } = await start();
  try {
    await command(handle, { command: "loop", value: false });
    let { sdk, close } = await frame(handle);
    const timing = await sdk.pageTiming();
    assert.equal(timing.paused, false);
    assert.equal(timing.remainingMs, null);
    assert.ok(timing.elapsedMs >= 0);
    await sdk.nextPage();
    assert.equal(handle.session.host.ended, "advance");
    close();

    ({ sdk, close } = await frame(handle));
    await sdk.skip("no data today");
    assert.equal(handle.session.host.ended, "skip");
    assert.ok(printed.some((entry) => entry.type === "page.skip" && entry.detail?.reason === "no data today"));
    close();

    ({ sdk, close } = await frame(handle));
    await sdk.ready();
    assert.equal(await rejection(sdk.skip()), "skip_after_ready");
    await command(handle, { command: "timer", enabled: true, maxMs: 1000 });
    assert.ok(((await sdk.pageTiming()).remainingMs as number) <= 1000);
    await until(() => handle.session.host.ended === "max_ms", "max_ms", 3000);
    assert.ok(printed.some((entry) => entry.type === "page.end"));
    close();

    ({ sdk, close } = await frame(handle));
    assert.equal(handle.session.host.ended, undefined, "a new activation starts the page again");
    close();
  } finally { await handle.close(); }
});

test("pause, a dark display and leaving reach onVisibility, and a held page reports itself paused", async () => {
  const { handle } = await start();
  try {
    const { sdk, close } = await frame(handle);
    const seen: Json[] = [];
    sdk.onVisibility((state: Json) => seen.push(state));
    await new Promise((resolve) => setTimeout(resolve, 30));
    await command(handle, { command: "pause", paused: true });
    await until(() => seen.length >= 1, "the pause");
    assert.equal((await sdk.pageTiming()).paused, true);
    await command(handle, { command: "display", dark: true });
    await command(handle, { command: "pause", paused: false });
    await command(handle, { command: "display", dark: false });
    await until(() => seen.length >= 2, "the resume");
    same(seen, [{ visible: false, reason: "paused" }, { visible: true, reason: "display" }]);
    await command(handle, { command: "leaving" });
    await command(handle, { command: "leaving" });
    await until(() => seen.length >= 3, "leaving");
    await new Promise((resolve) => setTimeout(resolve, 40));
    same(seen.slice(2), [{ visible: false, reason: "leaving" }], "leaving is posted once");
    close();
  } finally { await handle.close(); }
});

test("device events reach the handlers the application registered, within their rate limits", async () => {
  const { handle } = await start();
  try {
    const { sdk, close } = await frame(handle);
    const device = sdk.device;
    const heard: Record<string, unknown[]> = { presence: [], key: [], light: [], network: [], display: [], scan: [], people: [], sound: [] };
    device.onPresence(() => heard.presence!.push(true));
    device.onKey((key: unknown) => heard.key!.push(key));
    device.onLight((lux: unknown) => heard.light!.push(lux));
    device.onNetwork((online: unknown) => heard.network!.push(online));
    device.onDisplay((state: unknown) => heard.display!.push(state));
    device.onScan((scan: unknown) => heard.scan!.push(scan));
    device.onPeople((count: unknown) => heard.people!.push(count));
    device.onSoundLevel((dbfs: unknown) => heard.sound!.push(dbfs));
    await until(() => (handle.session.host.state().watching as string[]).length === 8, "the device.watch");
    await until(() => heard.network!.length === 1, "the network state at the watch");
    same(heard.network, [true]);
    await trigger(handle, { device: "presence" });
    const second = await trigger(handle, { device: "presence" }) as { posted: boolean; dropped?: string };
    assert.equal(second.posted, false);
    assert.match(second.dropped!, /one presence per second/);
    await trigger(handle, { device: "key", key: "volume_up", action: "down" });
    await trigger(handle, { device: "light", lux: 120 });
    await trigger(handle, { device: "network", online: false });
    await trigger(handle, { device: "display", on: false, brightness: 0.25 });
    await trigger(handle, { device: "typing", text: "4006381333931", gapMs: 20, enter: true, field: false });
    await trigger(handle, { device: "scan", source: "nfc", format: "uid", data: "04A224B1", atMs: Date.now() + 1000 });
    await trigger(handle, { device: "people", count: 3 });
    await trigger(handle, { device: "sound", dbfs: -40.5 });
    await until(() => heard.presence!.length === 1 && heard.key!.length === 1 && heard.light!.length === 1 && heard.network!.length === 2 && heard.display!.length === 1 && heard.scan!.length === 2 && heard.people!.length === 1 && heard.sound!.length === 1, "every event");
    same(heard.key, ["volume_up"]);
    same(heard.light, [120]);
    same(heard.network, [true, false]);
    same(heard.display, [{ on: false, brightness: 0.25 }]);
    same(heard.scan, [{ source: "scanner", format: "text", data: "4006381333931" }, { source: "nfc", format: "uid", data: "04A224B1" }]);
    same([heard.people, heard.sound], [[3], [-40.5]]);
    close();
  } finally { await handle.close(); }
});

test("serial ports, GPIO lines, Bluetooth characteristics, the scanner and printers answer each request", async () => {
  const { handle } = await start();
  try {
    const { sdk, bytes, close } = await frame(handle);
    const device = sdk.device;
    const ports = await device.serial.list();
    same(ports.map((port: { id: string }) => port.id), ["ttyUSB0", "ttyACM0"]);
    assert.equal(await rejection(device.serial.open("ttyACM0", { baudRate: 9600 })), "port_busy");
    assert.equal(await rejection(device.serial.open("ttyS9", { baudRate: 9600 })), "port_not_found");
    const port = await device.serial.open("ttyUSB0", { baudRate: 115200 });
    const received: string[] = [];
    port.onData((bytes: Uint8Array) => received.push(Buffer.from(bytes).toString()));
    const closed: string[] = [];
    port.onClose((reason: string) => closed.push(reason));
    await port.write("ping\n");
    await until(() => received.length === 1, "the echo");
    assert.equal(received[0], "ping\n");
    await command(handle, { command: "serial-send", port: "ttyUSB0", text: "from the device" });
    await until(() => received.length === 2, "bytes from the device");
    assert.equal(received[1], "from the device");
    await trigger(handle, { device: "serial", handle: handle.session.host.frame.state().ports[0]!.handle, closed: true, reason: "unplugged" });
    await until(() => closed.length === 1, "the unplug");
    same(closed, ["unplugged"]);

    const lines: boolean[] = [];
    device.gpio.onChange(17, (value: boolean) => lines.push(value));
    await until(() => lines.length === 1, "the line's level at once");
    await device.gpio.write(17, true);
    await until(() => lines.length === 2, "the change the application made");
    await trigger(handle, { device: "gpio", pin: 17, value: false });
    await until(() => lines.length === 3, "the line changing");
    same(lines, [false, true, false]);
    assert.equal(await rejection(device.gpio.write(22, true)), "pin_busy");
    assert.equal(await rejection(device.gpio.write(99, true)), "pin_not_found");

    const target = { service: "180d", characteristic: "2a37", device: "HRM-Strap" };
    same([...(await device.ble.read(target))], [0, 24]);
    const notifications: number[][] = [];
    const unwatch = await device.ble.watch(target, (bytes: Uint8Array) => notifications.push([...bytes]));
    await command(handle, { command: "ble-notify", service: "180d", characteristic: "2a37", hex: "00 40" });
    await until(() => notifications.length === 1, "the notification");
    same(notifications[0], [0, 64]);
    assert.equal(await rejection(device.ble.read({ service: "180d", characteristic: "2a99" })), "characteristic_not_found");
    unwatch();

    const scans: Json[] = [];
    device.onScan((scan: Json) => scans.push(scan));
    await new Promise((resolve) => setTimeout(resolve, 30));
    same((await device.scanner.start({ formats: ["qr", "aztec"] })).formats, ["qr"]);
    await trigger(handle, { device: "scan", source: "camera", format: "qr", data: "https://example.com/menu" });
    await until(() => scans.length === 1, "the camera scan");
    await device.scanner.stop();
    assert.equal(((await trigger(handle, { device: "scan", source: "camera", format: "qr", data: "x", atMs: Date.now() + 5000 })) as { posted: boolean }).posted, false);

    const printers = await device.printers();
    same(printers.map((printer: { id: string }) => printer.id), ["usb:epson-tm-t20", "office", "jammed"]);
    await device.print({ escpos: bytes(Buffer.from("\u001b@Hello\n")) });
    await device.print({ pdf: bytes(Buffer.alloc(70_000, 7)) });
    assert.equal(await rejection(device.print({ escpos: bytes([1]), printer: "jammed" })), "print_failed");
    const jobs = handle.session.host.frame.state().printed;
    same(jobs.map((job) => [job.printer, job.format, job.bytes, job.failed]), [["usb:epson-tm-t20", "escpos", 8, false], ["office", "pdf", 70_000, false], ["jammed", "escpos", 1, true]]);
    close();
  } finally { await handle.close(); }
});

test("a capability that is revoked is refused by the runtime, and a resize reaches the application", async () => {
  const { handle } = await start();
  try {
    const { sdk, close } = await frame(handle);
    await command(handle, { command: "capability", name: "kv.write", value: false });
    await until(() => sdk.capabilities["kv.write"] === false, "the refreshed context");
    assert.equal(await rejection(sdk.kv.set("k", "v")), "capability_denied");
    await command(handle, { command: "capability", name: "kv.write", value: true });
    await until(() => sdk.capabilities["kv.write"] === true, "the capability back");
    assert.equal((await sdk.kv.set("k", "v")).revision, 1);
    await command(handle, { command: "feature", name: "device.print", value: false });
    await until(() => !sdk.supports("device.print"), "the feature gone");
    assert.equal(await rejection(sdk.device.printers()), "not_supported");
    await command(handle, { command: "viewport", width: 1080, height: 1920 });
    await until(() => sdk.context.viewport.width === 1080, "viewport.changed");
    same(sdk.context.primitive, { width: 1080, height: 1920 });
    close();
  } finally { await handle.close(); }
});

test("launch params and the screen reach the context of the next activation, and the launch URL carries the params", async () => {
  const { handle } = await start();
  try {
    const answer = await command(handle, { command: "launch", name: "Lobby East", timezone: "America/Vancouver", params: { kiosk: "B 2&3", start_page: "lobby", Bad: "x", ticket: "t" } }) as { params: Json };
    same(answer.params, { kiosk: "B 2&3", start_page: "lobby" });
    assert.equal(handle.session.frameSrc().split("?")[1], "kiosk=B+2%263&start_page=lobby");
    const { sdk, close } = await frame(handle);
    same({ ...sdk.context.params }, { kiosk: "B 2&3", start_page: "lobby" });
    same({ ...sdk.context.screen }, { name: "Lobby East", timezone: "America/Vancouver" });
    close();
    await assert.rejects(command(handle, { command: "launch", timezone: "Mars/Olympus" }), /not an IANA time zone/);
    await assert.rejects(command(handle, { command: "viewport", width: 0, height: 10 }), /whole-number/);
  } finally { await handle.close(); }
});

test("the pinned runtime drives GPIO pull and idle, infrared and UDP through the harness", async () => {
  const { handle } = await start();
  try {
    const { sdk, bytes, close } = await frame(handle);
    const { device } = sdk;
    for (const feature of ["device.gpio.pull", "device.gpio.idle", "device.ir", "device.ir.send", "device.udp", "device.hdmi_input"]) assert.ok(sdk.supports(feature), feature);

    // A pull-up reads a floating line high; a press from outside reads low; let go and it floats back up.
    const levels: boolean[] = [];
    device.gpio.onChange(17, (value: boolean) => levels.push(value), { pull: "up" });
    await until(() => levels.length === 1, "the pulled line's level");
    await trigger(handle, { device: "gpio", pin: 17, value: false });
    await trigger(handle, { device: "gpio", pin: 17, value: null });
    await until(() => levels.length === 3, "the press and its release");
    same(levels, [true, false, true]);
    same(handle.session.host.frame.state().pull, { "17": "up" });

    // An output the page wrote goes to its idle level when the page leaves.
    await device.gpio.write(27, false, { idle: true });
    same(handle.session.host.frame.state().idle, { "27": true });
    const left = (await trigger(handle, { page: "leaving" })) as { drives: unknown };
    same(left.drives, [{ pin: 27, value: true }]);

    // Infrared: the NEC wire bytes, and a received code.
    await device.ir.send(0x00ff20, { repeat: 1 });
    same(handle.session.host.frame.irSent.flatMap((sent) => sent.frames), [[255, 0, 32, 223], [255, 0, 32, 223]]);
    const codes: unknown[] = [];
    device.onIr((code: unknown) => codes.push(code));
    await until(() => handle.session.host.watching.has("ir"), "the ir watch");
    await trigger(handle, { device: "ir", wire: "ff0020df", repeat: false });
    await until(() => codes.length === 1, "the received code");
    same(codes[0], { encoding: "NEC", code: 0x00ff20, repeat: false });

    // UDP: send-only and bound sockets, datagrams in and out, and the OS closing a socket.
    const sender = await device.udp.open();
    await sender.send("192.168.1.50", 7000, "PING");
    await sender.send("projector.local", 7000, bytes([1, 2, 3]));
    same(handle.session.host.frame.state().datagrams.map((item) => [item.direction, item.host, item.bytes]), [["sent", "192.168.1.50", 4], ["sent", "projector.local", 3]]);
    assert.equal(await rejection(sender.send("example.com", 7000, "x")), "invalid_request");
    const bound = await device.udp.open(47001);
    const heard: Array<{ fromHost: string; data: number[] }> = [];
    bound.onMessage((message: { fromHost: string; data: Uint8Array }) => heard.push({ fromHost: message.fromHost, data: [...message.data] }));
    await until(() => handle.session.host.watching.has("udp"), "the udp watch");
    await command(handle, { command: "udp-inject", socket: handle.session.host.frame.state().sockets.find((socket) => socket.port === 47001)!.handle, text: "hi", host: "192.168.1.20", port: 4000 });
    await until(() => heard.length === 1, "the datagram");
    same(heard[0], { fromHost: "192.168.1.20", data: [104, 105] });
    const reasons: string[] = [];
    bound.onClose((reason: string) => reasons.push(reason));
    await trigger(handle, { device: "udp", socket: "$opened", closed: true });
    await until(() => reasons.length === 1, "the socket closing");
    same(reasons, ["error"]);
    assert.equal(await rejection(bound.send("192.168.1.1", 7000, "x")), "invalid_handle");
    for (const port of [49817, 49818]) assert.equal(await rejection(device.udp.open(port)), "port_busy");
    close();
  } finally { await handle.close(); }
});
