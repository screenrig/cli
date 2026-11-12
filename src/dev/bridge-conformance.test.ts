import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { DEVICE_SOURCES, FEATURE_NAMES, advertises, allCapabilities, isRecord, type BridgeMessage, type Capabilities, type Posted } from "./bridge-protocol.js";
import { BridgeHost, contextMembers, type EventSink, type HostEvent, type Trigger, type TriggerResult } from "./bridge-host.js";
import { HANDLE, defaultHardware, type Hardware } from "./hardware.js";
import { SimulatedUdp } from "./udp.js";
import { type KvDelete, type KvEntry, type KvResult, type KvStore, type KvSummary, type KvWrite } from "./kv.js";

// The host half of the SDK bridge conformance corpora (contract section 10):
// every fixture whose required features this host advertises is fed to a
// BridgeHost, and what it posts is compared with the fixture's expectation.
// Backend requests are answered from the fixture's own `backend.response`, and
// asserted against its `backend.request`.

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface IndexEntry { path: string; kind: string; bytes: number; sha256: string; requires?: string[]; requiresSources?: string[]; runs?: string[] }

interface Fixture {
  name: string;
  kind: string;
  requires?: string[];
  requiresSources?: string[];
  runs?: string[];
  host: {
    primitiveId: string; generation: number; nonce: string; applicationId?: string; releaseId?: string; controller: boolean;
    advanced?: boolean; readied?: boolean;
    capabilities?: Record<string, boolean>; features?: string[];
    display?: { on: boolean; brightness: number | null }; network?: { online: boolean }; darkHeld?: boolean; watching?: string[];
    hardware?: FixtureHardware;
    page?: { elapsedMs: number; remainingMs: number | null; paused: boolean; visibilityWatching: boolean; held: Array<"display" | "paused"> };
  };
  manifest?: { primitive?: { launchParams?: unknown }; screenLabel?: unknown; timezone?: unknown } | null;
  in?: BridgeMessage;
  backend?: { request: { method: string; path: string; headers?: Record<string, string>; body?: Json }; response: { status: number; body?: Json } } | null;
  then?: Array<{ in: BridgeMessage; reply: Json | null }>;
  expect: {
    reply?: Json | null; hostChosen?: string[]; backendRequests?: string; context?: Json | null;
    deliveries?: Array<{ trigger: Json; message: Json | null; consumed?: boolean; drives?: Array<{ pin: number; value: boolean }> }>;
    /** The frames a send hands to the infrared emitter. */
    emits?: number[][];
  };
}

interface FixtureHardware {
  camera: { available: boolean; formats: string[]; scanning: boolean };
  serial: { ports: Hardware["serial"]["ports"]; open: Array<{ handle: string; port: string; failing?: boolean }> };
  gpio: { pins: Hardware["gpio"]["pins"]; watched: number[]; pull?: Record<string, "up" | "down" | "none">; chip?: boolean };
  ble: { adapter: boolean; peripherals: Hardware["ble"]["peripherals"]; subscriptions: Array<{ subscription: string; service: string; characteristic: string }> };
  ir?: Hardware["ir"];
  udp?: { open: Array<{ socket: string; port: number; failing?: boolean }>; busy: number[] };
  printers: Hardware["printers"];
}

const root = new URL("../../vendor/protocol/fixtures/", import.meta.url);
const ALL_FEATURES: readonly string[] = FEATURE_NAMES;

function corpus(directory: string): Array<{ entry: IndexEntry; fixture: Fixture }> {
  const base = new URL(`${directory}/`, root);
  const index = JSON.parse(readFileSync(new URL("index.json", base), "utf8")) as { files: IndexEntry[] };
  const listed = new Set(index.files.map((entry) => entry.path));
  const present = readdirSync(base).filter((name) => name !== "index.json");
  assert.deepEqual([...present].sort(), [...listed].sort(), `${directory} holds a file index.json does not list, or lacks a listed one`);
  return index.files.map((entry) => {
    const bytes = readFileSync(new URL(entry.path, base));
    assert.equal(bytes.length, entry.bytes, `${directory}/${entry.path} size differs from index.json`);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256, `${directory}/${entry.path} digest differs from index.json`);
    return { entry, fixture: JSON.parse(bytes.toString("utf8")) as Fixture };
  });
}

// Index v2: a runner runs the files whose `requires` it advertises and whose `requiresSources` it supports.
function applicable(entry: IndexEntry, fixture: Fixture): boolean {
  const requires = entry.requires ?? fixture.requires ?? [];
  const sources = entry.requiresSources ?? fixture.requiresSources ?? [];
  const runs = entry.runs ?? fixture.runs ?? ["host", "sdk"];
  return runs.includes("host") && requires.every((feature) => advertises(ALL_FEATURES, feature)) && sources.every((source) => DEVICE_SOURCES.includes(source));
}

/** A fixture's own backend response, as the store or the report sink answers it. */
class FixtureBackend implements KvStore, EventSink {
  requests = 0;
  constructor(private readonly fixture: Fixture) {}

  private answer<T>(method: string, pathEnd: string, check: (request: NonNullable<Fixture["backend"]>["request"]) => void, shape: (body: Json) => T): KvResult<T> {
    const backend = this.fixture.backend;
    assert.ok(backend, `${this.fixture.name}: the host made a backend request the fixture does not expect`);
    this.requests += 1;
    assert.equal(backend.request.method, method);
    assert.ok(backend.request.path.endsWith(pathEnd), `${backend.request.path} should end with ${pathEnd}`);
    check(backend.request);
    const { status, body } = backend.response;
    if (status >= 200 && status < 300) return { ok: true, value: shape(body ?? null) };
    const problem = body as { code: string; detail: string; request_id: string; current_revision?: number };
    return {
      ok: false,
      problem: { code: problem.code, status, detail: problem.detail, request_id: problem.request_id, ...(problem.current_revision === undefined ? {} : { current_revision: problem.current_revision }) },
    };
  }

  async get(key: string): Promise<KvResult<KvEntry>> {
    return this.answer("GET", `/kv/${key}`, () => undefined, (body) => body as unknown as KvEntry);
  }

  async list(): Promise<KvResult<KvSummary[]>> {
    return this.answer("GET", "/kv", () => undefined, (body) => (body as unknown as { items: KvSummary[] }).items);
  }

  async set(key: string, input: KvWrite): Promise<KvResult<KvEntry>> {
    return this.answer("PUT", `/kv/${key}`, (request) => {
      assert.equal(request.headers?.["If-Match"], input.expectedRevision === undefined ? undefined : String(input.expectedRevision));
      assert.equal(request.headers?.["Idempotency-Key"], input.idempotencyKey);
      assert.deepEqual(request.body, { value_base64: input.valueBase64, content_type: input.contentType });
    }, (body) => body as unknown as KvEntry);
  }

  async delete(key: string, input: KvDelete): Promise<KvResult<null>> {
    return this.answer("DELETE", `/kv/${key}`, (request) => {
      assert.equal(request.headers?.["If-Match"], input.expectedRevision === undefined ? undefined : String(input.expectedRevision));
      assert.equal(request.headers?.["Idempotency-Key"], input.idempotencyKey);
    }, () => null);
  }

  async emit(code: string, primitiveId: string): ReturnType<EventSink["emit"]> {
    const backend = this.fixture.backend;
    assert.ok(backend, `${this.fixture.name}: the host reported an event the fixture does not expect`);
    this.requests += 1;
    assert.equal(backend.request.method, "POST");
    assert.equal(backend.request.path, "/screen/reports");
    assert.deepEqual((backend.request.body as { context: Json }).context, { primitive_id: primitiveId, code });
    const { status, body } = backend.response;
    if (status >= 200 && status < 300) return { ok: true };
    const problem = body as { code: string; detail: string; request_id: string };
    return { ok: false, code: problem.code, status, detail: problem.detail, request_id: problem.request_id };
  }

  subscribe(): () => void { return () => undefined; }
  async close(): Promise<void> { return undefined; }
}

function hardwareOf(fixture: Fixture): Hardware {
  const given = fixture.host.hardware;
  if (!given) return defaultHardware();
  return {
    camera: { available: given.camera.available, formats: given.camera.formats },
    serial: { ports: given.serial.ports },
    gpio: { pins: given.gpio.pins, chip: given.gpio.chip !== false },
    ir: given.ir ?? { emitter: true, receiver: true },
    ble: { adapter: given.ble.adapter, peripherals: given.ble.peripherals },
    printers: given.printers,
  };
}

function build(fixture: Fixture): { host: BridgeHost; posted: Posted[]; logs: HostEvent[]; backend: FixtureBackend; clock: { now: number } } {
  const posted: Posted[] = [];
  const logs: HostEvent[] = [];
  const clock = { now: 1_000_000 };
  const backend = new FixtureBackend(fixture);
  const capabilities = { ...allCapabilities(true), ...(fixture.host.capabilities ?? {}) } as Capabilities;
  const host = new BridgeHost({
    applicationId: fixture.host.applicationId ?? "app_bridge", releaseId: fixture.host.releaseId ?? "rel_bridge", primitiveId: fixture.host.primitiveId,
    playerOrigin: "http://play.screenrig.localhost:18890", appOrigin: "http://r-0000000000000000000000000000000000000000.apps.screenrig.localhost:18890",
    capabilities, features: fixture.host.features ?? [...ALL_FEATURES], viewport: { width: 1920, height: 1080 },
    hardware: hardwareOf(fixture), udp: new SimulatedUdp(fixture.host.hardware?.udp?.busy ?? []), kv: backend, events: backend, clock: () => clock.now,
    post: (message) => { posted.push(message); }, log: (event) => { logs.push(event); },
  });
  host.activateAs(fixture.host.generation, fixture.host.nonce);
  host.advanced = fixture.host.advanced ?? false;
  host.readied = fixture.host.readied ?? false;
  if (fixture.host.display) host.display = { ...fixture.host.display };
  if (fixture.host.network) host.network = { ...fixture.host.network };
  host.darkHeld = fixture.host.darkHeld ?? false;
  host.watching = new Set(fixture.host.watching ?? []);
  const given = fixture.host.hardware;
  if (given) {
    host.frame.scanning = given.camera.scanning;
    for (const open of given.serial.open) host.frame.ports.set(open.handle, { ...open });
    host.frame.watchedPins = [...given.gpio.watched];
    for (const [pin, pull] of Object.entries(given.gpio.pull ?? {})) host.frame.pulls.set(Number(pin), pull);
    for (const subscription of given.ble.subscriptions) host.frame.subscriptions.set(subscription.subscription, { ...subscription });
    for (const open of given.udp?.open ?? []) host.frame.restoreSocket({ handle: open.socket, port: open.port, broadcast: false }, open.failing === true);
  }
  if (fixture.host.page) host.restorePage(fixture.host.page);
  return { host, posted, logs, backend, clock };
}

function pointer(value: Json, path: string): { parent: Record<string, Json>; key: string } | undefined {
  const keys = path.split("/").slice(1);
  let current: Json = value;
  for (const key of keys.slice(0, -1)) {
    if (!isRecord(current)) return undefined;
    current = (current as Record<string, Json>)[key] as Json;
  }
  return isRecord(current) ? { parent: current as Record<string, Json>, key: keys.at(-1)! } : undefined;
}

/** Equal except at the pointers the host chooses: there any value of the right type will do. */
function assertSame(actual: unknown, expected: Json | null, chosen: string[], label: string): void {
  const left = JSON.parse(JSON.stringify(actual)) as Json;
  const right = JSON.parse(JSON.stringify(expected)) as Json;
  for (const path of chosen) {
    const a = pointer(left, path);
    const e = pointer(right, path);
    if (!a || !e || !(a.key in a.parent)) continue;
    const value = a.parent[a.key];
    if (path === "/message_id") assert.equal(typeof value, "string", `${label}: ${path}`);
    else if (path.endsWith("/handle") || path.endsWith("/subscription") || path.endsWith("/socket")) assert.match(String(value), HANDLE, `${label}: ${path}`);
    else assert.equal(typeof value, typeof e.parent[e.key], `${label}: ${path}`);
    a.parent[a.key] = null;
    e.parent[e.key] = null;
  }
  assert.deepEqual(left, right, label);
}

function responses(posted: Posted[]): Posted[] {
  return posted.filter((message) => "kind" in message && typeof message.kind === "string" && message.kind.startsWith("response."));
}

async function runFixture(fixture: Fixture): Promise<void> {
  const { host, posted, backend } = build(fixture);
  const chosen = fixture.expect.hostChosen ?? [];
  if (fixture.in) {
    await host.receive(fixture.in);
    const replies = responses(posted);
    const expected = fixture.expect.reply ?? null;
    if (expected === null) assert.equal(replies.length, 0, `${fixture.name}: expected no reply, got ${JSON.stringify(replies)}`);
    else {
      assert.equal(replies.length, 1, `${fixture.name}: expected one reply`);
      assertSame(replies[0], expected, chosen, `${fixture.name}: reply`);
    }
    if (fixture.expect.emits !== undefined) assert.deepEqual(host.frame.irSent.flatMap((sent) => sent.frames), fixture.expect.emits, `${fixture.name}: the frames handed to the emitter`);
    const expectedBackend = fixture.expect.backendRequests;
    if (expectedBackend === "one") assert.equal(backend.requests, 1, `${fixture.name}: backend requests`);
    else if (expectedBackend === "none") assert.equal(backend.requests, 0, `${fixture.name}: backend requests`);
    // Everything the request pushed besides its reply is what a {device: "watch"} trigger names.
    const immediate = posted.filter((message) => !responses(posted).includes(message));
    posted.length = 0;
    for (const [index, step] of (fixture.then ?? []).entries()) {
      await host.receive(step.in);
      const stepReplies = responses(posted);
      assert.equal(stepReplies.length, 1, `${fixture.name}: step ${index + 1} reply`);
      assertSame(stepReplies[0], step.reply, chosen, `${fixture.name}: step ${index + 1} reply`);
      posted.length = 0;
    }
    await deliver(fixture, host, posted, immediate, chosen);
  } else {
    // A context fixture: no message, only what the host puts in the context payload.
    const manifest = fixture.manifest;
    const members = contextMembers({ launchParams: manifest?.primitive?.launchParams, screenLabel: manifest?.screenLabel, timezone: manifest?.timezone });
    assert.deepEqual(JSON.parse(JSON.stringify(members)), fixture.expect.context ?? {}, `${fixture.name}: context members`);
  }
}

async function deliver(fixture: Fixture, host: BridgeHost, posted: Posted[], immediate: Posted[], chosen: string[]): Promise<void> {
  const first = (fixture.expect.deliveries ?? []).map((delivery) => (delivery.trigger as { atMs?: number }).atMs).find((at) => at !== undefined);
  for (const [index, delivery] of (fixture.expect.deliveries ?? []).entries()) {
    const label = `${fixture.name}: delivery ${index + 1} ${JSON.stringify(delivery.trigger)}`;
    const trigger = JSON.parse(JSON.stringify(delivery.trigger)) as Record<string, Json>;
    if (typeof trigger.atMs === "number" && first !== undefined) trigger.atMs = trigger.atMs - first + 5_000_000;
    let result: TriggerResult;
    let pushed: Posted[];
    if (trigger.device === "watch") {
      result = { posted: false };
      pushed = immediate.splice(0, 1);
    } else {
      posted.length = 0;
      result = host.trigger(trigger as unknown as Trigger);
      pushed = posted.splice(0);
    }
    if (delivery.message === null) assert.equal(pushed.length, 0, `${label}: expected nothing, got ${JSON.stringify(pushed)}`);
    else {
      assert.equal(pushed.length, 1, `${label}: expected one message`);
      assertSame(pushed[0], delivery.message, chosen, label);
    }
    if (delivery.consumed !== undefined) assert.equal(result.consumed, delivery.consumed, `${label}: consumed`);
    if (delivery.drives !== undefined) assert.deepEqual(result.drives, delivery.drives, `${label}: the levels driven on release`);
  }
}

for (const directory of ["sdk-bridge", "sdk-bridge-device", "sdk-bridge-page"]) {
  const fixtures = corpus(directory);
  test(`${directory}: every fixture this host implements passes`, async () => {
    let ran = 0;
    for (const { entry, fixture } of fixtures) {
      if (!applicable(entry, fixture)) continue;
      await runFixture(fixture);
      ran += 1;
    }
    assert.ok(ran > 0);
    assert.equal(ran, fixtures.filter(({ entry, fixture }) => (entry.runs ?? fixture.runs ?? ["host", "sdk"]).includes("host")).length, "the harness advertises every feature, so it runs every host fixture");
  });
}

test("the harness advertises every feature the corpora name", () => {
  for (const [directory, key] of [["sdk-bridge-device", "deviceFeatures"], ["sdk-bridge-page", "pageFeatures"]] as const) {
    const index = JSON.parse(readFileSync(new URL(`${directory}/index.json`, root), "utf8")) as Record<string, string[]>;
    for (const feature of index[key]!) assert.ok(ALL_FEATURES.includes(feature), `${feature} is not advertised`);
  }
  const device = JSON.parse(readFileSync(new URL("sdk-bridge-device/index.json", root), "utf8")) as { deviceSources: string[] };
  for (const source of device.deviceSources) assert.ok(DEVICE_SOURCES.includes(source), `${source} is not simulated`);
  const base = JSON.parse(readFileSync(new URL("sdk-bridge/index.json", root), "utf8")) as { hostFeatures: string[] };
  for (const feature of base.hostFeatures) assert.ok(ALL_FEATURES.includes(feature), `${feature} is not advertised`);
});
