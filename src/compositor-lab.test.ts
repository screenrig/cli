import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { request } from "node:http";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../tools/compositor/server.mjs", import.meta.url));

let child: ChildProcess;
let port = 0;

before(async () => {
  child = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: "0", HOST: "127.0.0.1" }, stdio: ["ignore", "pipe", "inherit"] });
  port = await new Promise<number>((resolve, reject) => {
    let out = "";
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`lab exited ${code} before listening`)));
    child.stdout!.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const match = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(out);
      if (match) resolve(Number(match[1]));
    });
  });
});

after(async () => {
  if (child.exitCode === null) {
    child.removeAllListeners("exit");
    const closed = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill();
    await closed;
  }
});

function call(method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

const spec = (image: string) => JSON.stringify({ input: JSON.stringify({ width: 1920, height: 1080, image, fullpage: { title: "Hello" } }) });

test("the lab refuses a Host that is not loopback with its own port", async () => {
  assert.equal((await call("GET", "/api/runs", { host: `127.0.0.1:${port}` })).status, 200);
  assert.equal((await call("GET", "/api/runs", { host: `localhost:${port}` })).status, 200);
  for (const host of ["attacker.example", `attacker.example:${port}`, "127.0.0.1", `127.0.0.1:${port + 1}`, `127.0.0.1.attacker.example:${port}`]) {
    assert.equal((await call("GET", "/api/runs", { host })).status, 403, host);
  }
});

test("generate needs a JSON content type and a same-origin page", async () => {
  const host = `127.0.0.1:${port}`;
  const body = spec("./a.png");
  const text = await call("POST", "/api/generate", { host, "content-type": "text/plain", "content-length": String(Buffer.byteLength(body)) }, body);
  assert.equal(text.status, 415);
  const none = await call("POST", "/api/generate", { host, "content-length": String(Buffer.byteLength(body)) }, body);
  assert.equal(none.status, 415);
  const cross = await call("POST", "/api/generate", { host, origin: "https://attacker.example", "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) }, body);
  assert.equal(cross.status, 403);
});

test("generate refuses image paths outside the run directory before rendering", async () => {
  const host = `127.0.0.1:${port}`;
  for (const image of ["/etc/hosts", "../../../../etc/hosts", "./../x.png", "media/../../x.png", "../examples/wordmark.png"]) {
    const body = spec(image);
    const res = await call("POST", "/api/generate", { host, "content-type": "application/json; charset=utf-8", "content-length": String(Buffer.byteLength(body)) }, body);
    assert.equal(res.status, 400, image);
    assert.match(JSON.parse(res.text).error, /outside the lab's working directory/, image);
  }
  const logo = JSON.stringify({ input: JSON.stringify({ pages: [{ id: "a", logo: { src: "/etc/hosts", corner: "top-left" }, fullpage: { title: "x" } }] }) });
  const res = await call("POST", "/api/generate", { host, "content-type": "application/json", "content-length": String(Buffer.byteLength(logo)) }, logo);
  assert.equal(res.status, 400);
  assert.match(JSON.parse(res.text).error, /outside/);
});
