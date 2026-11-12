import assert from "node:assert/strict";
import dgram from "node:dgram";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { testTemp } from "../test-temp.js";
import type { BridgeMessage } from "./bridge-protocol.js";
import { createDevSession } from "./index.js";
import type { DevSession } from "./session.js";
import { LoopbackUdp, SimulatedUdp, type UdpTransport } from "./udp.js";

// GPIO pull and idle, infrared, UDP and the HDMI input permission, driven the
// way the application's window drives them: raw bridge messages into the
// session and the posts read back. The pinned runtime knows none of the round
// three kinds, so these run the host directly.

const NONCE = "r3-nonce-0123456789abcdef";
const PORT = 18890;

interface Harness {
  session: DevSession;
  posted: BridgeMessage[];
  send(kind: string, payload?: Record<string, unknown>): Promise<BridgeMessage>;
  events(type: string): BridgeMessage[];
  watch(...events: string[]): Promise<void>;
  trigger(trigger: Record<string, unknown>): Promise<{ posted: boolean; dropped?: string; drives?: Array<{ pin: number; value: boolean }> }>;
  restart(): Promise<void>;
  close(): Promise<void>;
}

async function harness(udp: UdpTransport = new SimulatedUdp()): Promise<Harness> {
  const dir = await testTemp("dev-r3-");
  await writeFile(path.join(dir, "index.html"), "<!doctype html><title>t</title><p>x</p>");
  const { session } = await createDevSession({ directory: dir, port: PORT, reload: true, udp });
  const posted: BridgeMessage[] = [];
  session.clients.add((event) => { if (event.event === "bridge") posted.push(event.data as BridgeMessage); });
  let generation = 1;
  const activate = (): void => { session.host.activateAs(generation, NONCE); };
  activate();
  let counter = 0;
  const me: Harness = {
    session, posted,
    async send(kind, payload = {}) {
      counter += 1;
      const id = `msg_r3_${String(counter).padStart(6, "0")}`;
      const before = posted.length;
      await session.fromApp({ protocol: "1", message_id: id, kind, primitive_id: "prm_dev_0001", payload: { generation, nonce: NONCE, ...payload } }, undefined as unknown as string);
      const reply = posted.slice(before).find((message) => message.kind.startsWith("response.") && message.payload.request_message_id === id);
      assert.ok(reply, `${kind} was answered`);
      return reply;
    },
    events: (type) => posted.filter((message) => message.kind === "device.event" && message.payload.type === type),
    async watch(...names) { await session.fromApp({ protocol: "1", message_id: "msg_watch_000001", kind: "device.watch", primitive_id: "prm_dev_0001", payload: { generation, nonce: NONCE, events: names } }, undefined as unknown as string); },
    async trigger(trigger) { return (await session.command({ command: "trigger", trigger })) as Awaited<ReturnType<Harness["trigger"]>>; },
    async restart() { generation += 1; activate(); },
    close: () => session.stop(),
  };
  return me;
}

const problem = (reply: BridgeMessage): string => (reply.payload.problem as { code: string }).code;
const result = (reply: BridgeMessage): Record<string, unknown> => reply.payload.result as Record<string, unknown>;

test("a floating line reads by its pull; the harness panel state shows the pull", async () => {
  const h = await harness();
  try {
    await h.watch("gpio");
    const ack = await h.send("device.gpio.watch", { pins: [17, 27], pull: { "17": "up", "27": "down" } });
    assert.equal(ack.kind, "response.ack");
    // 17 would read low and 27 high with no bias: the pulls flip both.
    assert.deepEqual(h.events("gpio").map((event) => [event.payload.pin, event.payload.value]), [[17, true], [27, false]]);
    const frame = h.session.snapshot().host as { frame: { pull: Record<string, string>; levels: Record<string, boolean> } };
    assert.deepEqual(frame.frame.pull, { "17": "up", "27": "down" });
    assert.deepEqual([frame.frame.levels["17"], frame.frame.levels["27"]], [true, false]);
    // A button pressed to ground drives the line low, and letting go floats it to its pull again.
    assert.equal((await h.trigger({ device: "gpio", pin: 17, value: false })).posted, true);
    assert.equal((await h.trigger({ device: "gpio", pin: 17, value: null })).posted, true);
    assert.deepEqual(h.events("gpio").slice(2).map((event) => event.payload.value), [false, true]);
    // A watch that leaves the pull out lets the bias go: 17 reads its own level again, and the change is posted.
    await h.send("device.gpio.watch", { pins: [17] });
    assert.equal(h.events("gpio").at(-1)!.payload.value, false);
    assert.equal(problem(await h.send("device.gpio.watch", { pins: [17], pull: { "17": "sideways" } })), "invalid_request");
    assert.equal(problem(await h.send("device.gpio.watch", { pins: [17], pull: { "27": "up" } })), "invalid_request");
  } finally { await h.close(); }
});

test("a host without device.gpio.pull or device.gpio.idle reads the members as unknown", async () => {
  const h = await harness();
  try {
    h.session.host.setFeatures(["device.watch", "device.gpio"]);
    await h.watch("gpio");
    assert.equal(problem(await h.send("device.gpio.watch", { pins: [17], pull: { "17": "up" } })), "invalid_request");
    assert.equal(problem(await h.send("device.gpio.write", { pin: 17, value: true, idle: true })), "invalid_request");
    assert.equal((await h.send("device.gpio.write", { pin: 17, value: true })).kind, "response.ack");
    // Without idle nothing is let go at a level: the line stays where it was driven.
    assert.deepEqual(h.session.host.leaving(), []);
  } finally { await h.close(); }
});

test("lines the page wrote go to their idle level when it leaves and when its context ends; the panel shows both", async () => {
  const h = await harness();
  try {
    await h.send("device.gpio.write", { pin: 17, value: false, idle: true });
    await h.send("device.gpio.write", { pin: 27, value: true });
    assert.deepEqual(h.session.host.frame.state().idle, { "17": true, "27": false });
    assert.deepEqual((await h.trigger({ page: "leaving" })).drives, [{ pin: 17, value: true }, { pin: 27, value: false }]);
    let frame = h.session.host.frame.state();
    assert.deepEqual(frame.released.map((item) => [item.pin, item.value, item.cause]), [[17, true, "leaving"], [27, false, "leaving"]]);
    assert.deepEqual(h.session.host.frame.state().levels["17"], true);
    // Nothing is left to let go of a second time.
    assert.deepEqual((await h.trigger({ page: "leaving" })).drives, []);
    // A write without idle sets the level back to low, and a new context lets go of it.
    await h.send("device.gpio.write", { pin: 17, value: true, idle: true });
    await h.send("device.gpio.write", { pin: 17, value: true });
    await h.restart();
    frame = h.session.host.frame.state();
    assert.deepEqual(frame.released.slice(2).map((item) => [item.pin, item.value, item.cause]), [[17, false, "context"]]);
    assert.deepEqual(frame.idle, {});
    // A level that is not a boolean is refused and drives nothing.
    assert.equal(problem(await h.send("device.gpio.write", { pin: 17, value: true, idle: "high" })), "invalid_request");
  } finally { await h.close(); }
});

test("device.ir.send validates and logs the code; a received code reaches an application that watches ir", async () => {
  const h = await harness();
  try {
    assert.equal((await h.send("device.ir.send", { encoding: "NEC", code: 0x20df10, repeat: 2 })).kind, "response.ack");
    assert.equal(problem(await h.send("device.ir.send", { encoding: "NEC", code: 0x1000000 })), "invalid_request");
    assert.equal(problem(await h.send("device.ir.send", { encoding: "SONY", code: 1 })), "invalid_request");
    assert.equal(problem(await h.send("device.ir.send", { encoding: "NEC", code: 1, repeat: 11 })), "invalid_request");
    assert.equal(problem(await h.send("device.ir.send", { encoding: "NEC", code: 1, extra: 1 })), "invalid_request");
    assert.equal((await h.send("device.ir.send", { encoding: "NEC", code: 0xffffff })).kind, "response.ack");
    assert.deepEqual(h.session.host.frame.irSent.map((sent) => [sent.code, sent.repeat, sent.frames.length]), [[0x20df10, 2, 3], [0xffffff, 0, 1]]);
    assert.deepEqual(h.session.host.frame.irSent[0]!.frames[0], [0xdf, 0x20, 0x10, 0xef], "address low byte, address high byte, command, complement");
    assert.equal((await h.trigger({ device: "ir", code: 0xabcdef })).posted, false, "an application that does not watch ir hears nothing");
    await h.watch("ir");
    assert.equal((await h.trigger({ device: "ir", code: 0xabcdef, repeat: false })).posted, true);
    assert.equal((await h.trigger({ device: "ir", code: 0xabcdef, repeat: true })).posted, true);
    assert.deepEqual(h.events("ir").map((event) => [event.payload.encoding, event.payload.code, event.payload.repeat]), [["NEC", 0xabcdef, false], ["NEC", 0xabcdef, true]]);
    // Without the capability the request is forbidden, and without an emitter it is ir_unavailable.
    await h.session.command({ command: "hardware", change: "ir.emitter", value: false });
    assert.equal(problem(await h.send("device.ir.send", { encoding: "NEC", code: 1 })), "ir_unavailable");
    await h.session.command({ command: "capability", name: "device.ir", value: false });
    assert.equal(problem(await h.send("device.ir.send", { encoding: "NEC", code: 1 })), "forbidden");
  } finally { await h.close(); }
});

test("a host that only sends infrared (device.ir.send) answers a send and ignores a watch for ir", async () => {
  const h = await harness();
  try {
    h.session.host.setFeatures(["device.watch", "device.ir.send"]);
    assert.equal((await h.send("device.ir.send", { encoding: "NEC", code: 5 })).kind, "response.ack");
    await h.watch("ir");
    assert.equal(h.session.host.watching.has("ir"), false);
    h.session.host.setFeatures(["device.watch"]);
    assert.equal(problem(await h.send("device.ir.send", { encoding: "NEC", code: 5 })), "not_supported");
  } finally { await h.close(); }
});

const b64 = (text: string): string => Buffer.from(text).toString("base64");

test("simulated UDP sockets: limits, refusals, the log of sent datagrams and the inject box", async () => {
  const h = await harness();
  try {
    assert.equal(problem(await h.send("device.udp.open", { port: 49817 })), "port_busy");
    assert.equal(problem(await h.send("device.udp.open", { port: 49818 })), "port_busy");
    assert.equal(problem(await h.send("device.udp.open", { port: 0, multicast: "239.255.0.1" })), "invalid_request");
    assert.equal(problem(await h.send("device.udp.open", { port: 80 })), "invalid_request");
    assert.equal(problem(await h.send("device.udp.open", { port: 6000, multicast: "224.0.0.1" })), "invalid_request");
    const opened = await h.send("device.udp.open", { port: 6000, broadcast: true });
    const socket = result(opened).socket as string;
    assert.match(socket, /^udp_/);
    assert.equal(problem(await h.send("device.udp.open", { port: 6000 })), "port_busy", "the frame holds the port already");
    for (const port of [6001, 6002, 0]) assert.equal((await h.send("device.udp.open", { port })).kind, "response.ack");
    assert.equal(problem(await h.send("device.udp.open", { port: 6003 })), "socket_limit");
    const send = (payload: Record<string, unknown>) => h.send("device.udp.send", { socket, ...payload });
    assert.equal((await send({ host: "192.168.1.50", port: 7000, data_base64: b64("PING") })).kind, "response.ack");
    assert.equal((await send({ host: "projector.local", port: 7000, data_base64: b64("x") })).kind, "response.ack");
    assert.equal((await send({ host: "projector", port: 7000, data_base64: b64("x") })).kind, "response.ack");
    for (const host of ["example.com", "999.1.1.1", "::1", "a b"]) assert.equal(problem(await send({ host, port: 7000, data_base64: b64("x") })), "invalid_request", host);
    assert.equal(problem(await send({ host: "10.0.0.1", port: 0, data_base64: b64("x") })), "invalid_request");
    assert.equal(problem(await send({ host: "10.0.0.1", port: 7000, data_base64: "!!" })), "invalid_request");
    assert.equal(problem(await send({ host: "10.0.0.1", port: 7000, data_base64: Buffer.alloc(8193).toString("base64") })), "payload_too_large");
    assert.equal((await send({ host: "10.0.0.1", port: 7000, data_base64: Buffer.alloc(8192).toString("base64") })).kind, "response.ack");
    assert.equal(problem(await h.send("device.udp.send", { socket: "udp_nope", host: "10.0.0.1", port: 7000, data_base64: b64("x") })), "invalid_handle");
    const sent = h.session.host.frame.datagrams.filter((item) => item.direction === "sent");
    assert.equal(sent[0]!.text, "PING");
    assert.equal(sent[0]!.delivered, false, "a datagram to the LAN is recorded and never transmitted");
    // The inject box delivers a datagram to a socket; the application hears it only while it watches udp.
    const injected = await h.session.command({ command: "udp-inject", socket, text: "hello", host: "10.1.1.1", port: 5555 }) as { posted: boolean; dropped?: string };
    assert.equal(injected.posted, false);
    await h.watch("udp");
    await h.session.command({ command: "udp-inject", socket, text: "hello", host: "10.1.1.1", port: 5555 });
    assert.deepEqual(h.events("udp").map((event) => event.payload), [{ generation: 1, nonce: NONCE, type: "udp", socket, from_host: "10.1.1.1", from_port: 5555, data_base64: b64("hello") }]);
    await h.send("device.udp.close", { socket });
    assert.equal(problem(await send({ host: "10.0.0.1", port: 7000, data_base64: b64("x") })), "invalid_handle");
    assert.equal(h.session.host.frame.sockets.size, 3);
    await h.restart();
    assert.equal(h.session.host.frame.sockets.size, 0, "sockets end with the context");
  } finally { await h.close(); }
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = dgram.createSocket("udp4");
    probe.once("error", reject);
    probe.bind(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
}

async function eventually<T>(read: () => T | undefined, what: string): Promise<T> {
  for (const started = Date.now(); Date.now() - started < 3000; ) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test("loopback UDP: a local tool talks to the application's socket, and the socket's sends reach loopback only", async () => {
  const h = await harness(new LoopbackUdp());
  const tool = dgram.createSocket("udp4");
  try {
    const port = await freePort();
    await h.watch("udp");
    const socket = result(await h.send("device.udp.open", { port })).socket as string;
    // Another process holds a port the application asks for: port_busy.
    const squatter = dgram.createSocket("udp4");
    const taken = await new Promise<number>((resolve) => squatter.bind(0, "127.0.0.1", () => resolve(squatter.address().port)));
    assert.equal(problem(await h.send("device.udp.open", { port: taken })), "port_busy");
    squatter.close();
    // The tool sends the application a datagram.
    tool.send(Buffer.from("from the tool"), port, "127.0.0.1");
    const heard = await eventually(() => h.events("udp")[0], "the application to hear the tool");
    assert.equal(heard.payload.socket, socket);
    assert.equal(heard.payload.from_host, "127.0.0.1");
    assert.equal(Buffer.from(heard.payload.data_base64 as string, "base64").toString(), "from the tool");
    // The application answers the sender's address and port.
    const reply = new Promise<string>((resolve) => tool.once("message", (data) => resolve(data.toString())));
    await h.send("device.udp.send", { socket, host: "127.0.0.1", port: heard.payload.from_port, data_base64: b64("answer") });
    assert.equal(await reply, "answer");
    assert.equal(h.session.host.frame.datagrams.at(-1)!.delivered, true);
    // A datagram for the LAN is not transmitted.
    await h.send("device.udp.send", { socket, host: "192.168.1.9", port: 9, data_base64: b64("lan") });
    assert.equal(h.session.host.frame.datagrams.at(-1)!.delivered, false);
    // The socket ends with the context, and the port is free for the next activation.
    await h.restart();
    const again = result(await h.send("device.udp.open", { port })).socket as string;
    assert.notEqual(again, socket);
  } finally {
    tool.close();
    await h.close();
  }
});

test("device.hdmi_input grants the frame the camera and microphone, and a change loads the frame again", async () => {
  const h = await harness();
  try {
    const { session } = h;
    const base = "autoplay; fullscreen; clipboard-read; clipboard-write";
    assert.equal(session.frameAllow(), `${base}; camera; microphone`);
    const frames: Array<{ action: string; allow: string }> = [];
    session.clients.add((event) => { if (event.event === "frame") frames.push(event.data); });
    await session.command({ command: "capability", name: "device.hdmi_input", value: false });
    assert.equal(session.snapshot().frame_allow, base);
    assert.deepEqual(frames, [{ action: "restart", src: session.frameSrc(), allow: base }]);
    await session.command({ command: "capability", name: "device.ir", value: false });
    assert.equal(frames.length, 1, "an unrelated capability keeps the frame");
    await session.command({ command: "capabilities", values: { "device.hdmi_input": true } });
    assert.equal(frames.at(-1)!.allow, `${base}; camera; microphone`);
  } finally { await h.close(); }
});

test("the round-three features and capabilities are advertised", async () => {
  const h = await harness();
  try {
    const context = h.session.host.contextMessage().payload as { capabilities: Record<string, boolean>; features: string[] };
    for (const name of ["device.ir", "device.udp", "device.hdmi_input"]) assert.equal(context.capabilities[name], true, name);
    for (const name of ["device.gpio.pull", "device.gpio.idle", "device.ir", "device.ir.send", "device.udp", "device.hdmi_input"]) assert.ok(context.features.includes(name), name);
  } finally { await h.close(); }
});
