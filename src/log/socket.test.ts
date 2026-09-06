import assert from "node:assert/strict";
import net from "node:net";
import { Writable } from "node:stream";
import { test, type TestContext } from "node:test";
import { connectUnixLogSocket } from "./socket.js";

class HeldSocket extends Writable {
  readonly received: string[] = [];
  readonly callbacks: ((error?: Error | null) => void)[] = [];
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.received.push(chunk.toString());
    this.callbacks.push(callback);
  }
}

async function heldSink(t: TestContext) {
  const socket = new HeldSocket();
  t.mock.method(net, "createConnection", () => {
    process.nextTick(() => socket.emit("connect"));
    return socket as unknown as net.Socket;
  });
  return { socket, sink: await connectUnixLogSocket("/tmp/screenrig-test.sock") };
}

test("log close waits for every accepted write and preserves line order", async (t) => {
  const { socket, sink } = await heldSink(t);
  sink.writeLine("first");
  sink.writeLine("second");
  let closed = false;
  const closing = sink.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  socket.callbacks.shift()!();
  await Promise.resolve();
  assert.equal(closed, false);
  socket.callbacks.shift()!();
  await closing;
  assert.deepEqual(socket.received, ["first\n", "second\n"]);
  assert.equal(socket.destroyed, true);
});

test("a stalled log consumer drops lines at the bounded backlog instead of failing the command", async (t) => {
  const { socket, sink } = await heldSink(t);
  for (let i = 0; i < 40; i += 1) sink.writeLine("x".repeat(32 * 1024));
  assert.ok(sink.droppedCount() > 0);
  assert.ok(socket.writableLength <= 1024 * 1024);
  assert.equal(socket.destroyed, false);
  await sink.close();
  assert.equal(socket.destroyed, true);
});

test("log close cannot hang forever on a consumer that stops draining", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { socket, sink } = await heldSink(t);
  sink.writeLine("held");
  const closing = sink.close();
  t.mock.timers.tick(5000);
  await closing;
  assert.equal(socket.destroyed, true);
});

test("a write failure drops later lines and close still resolves", async (t) => {
  const { socket, sink } = await heldSink(t);
  sink.writeLine("held");
  const failed = new Promise<void>((resolve) => socket.once("error", () => resolve()));
  socket.callbacks.shift()!(new Error("consumer disconnected"));
  await failed;
  sink.writeLine("after-error");
  assert.ok(sink.droppedCount() >= 1);
  await sink.close();
  assert.equal(socket.destroyed, true);
});
