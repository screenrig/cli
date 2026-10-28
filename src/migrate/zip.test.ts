import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { testTemp } from "../test-temp.js";
import { ZipArchive } from "./zip.js";
import { zipBytes, type ZipFixtureEntry } from "./zip-fixture.test.js";

async function archive(dir: string, entries: ZipFixtureEntry[], options?: Parameters<typeof zipBytes>[1]): Promise<ZipArchive> {
  const file = path.join(dir, "fixture.zip");
  await writeFile(file, zipBytes(entries, options));
  return ZipArchive.open(file);
}

const big = Buffer.from("A line of text that deflates well.\n".repeat(40));

test("stored and deflated entries read back and extract with a verified checksum", async () => {
  const dir = await testTemp("zip-rt-");
  try {
    const zip = await archive(dir, [
      { name: "small.txt", data: "tiny", method: "stored" },
      { name: "nested/big.txt", data: big, method: "deflate" },
      { name: "empty.bin", data: "" },
    ]);
    assert.deepEqual(zip.entries.map((entry) => [entry.name, entry.bytes, entry.method]), [
      ["small.txt", 4, 0], ["nested/big.txt", big.length, 8], ["empty.bin", 0, 0],
    ]);
    assert.equal((await zip.read(zip.entries[0]!)).toString(), "tiny");
    assert.deepEqual(await zip.read(zip.entries[1]!), big);
    const out = path.join(dir, "out.txt");
    assert.deepEqual(await zip.extract(zip.entries[1]!, out), { bytes: big.length });
    assert.deepEqual(await readFile(out), big);
    assert.equal((await stat(out)).mode & 0o777, 0o600);
    const empty = path.join(dir, "empty.out");
    await zip.extract(zip.entries[2]!, empty);
    assert.equal((await stat(empty)).size, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("head returns the first bytes of a deflated entry without reading the rest", async () => {
  const dir = await testTemp("zip-head-");
  try {
    const noise = randomBytes(200_000);
    const zip = await archive(dir, [{ name: "noise.bin", data: noise, method: "deflate" }]);
    assert.deepEqual(await zip.head(zip.entries[0]!, 64), noise.subarray(0, 64));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("zip64 sizes and offsets in the directory and the end records are read", async () => {
  const dir = await testTemp("zip-64-");
  try {
    const zip = await archive(dir, [{ name: "a.txt", data: "first" }, { name: "b/c.txt", data: big }], { zip64: true });
    assert.deepEqual(zip.entries.map((entry) => [entry.name, entry.bytes]), [["a.txt", 5], ["b/c.txt", big.length]]);
    assert.equal((await zip.read(zip.entries[0]!)).toString(), "first");
    assert.deepEqual(await zip.read(zip.entries[1]!), big);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an archive comment does not hide the end record", async () => {
  const dir = await testTemp("zip-comment-");
  try {
    const zip = await archive(dir, [{ name: "a.txt", data: "x" }], { comment: "made by a tool\u0000with a nul" });
    assert.equal(zip.entries.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("encrypted entries and unknown compression methods are listed as unreadable and never read", async () => {
  const dir = await testTemp("zip-enc-");
  try {
    const zip = await archive(dir, [
      { name: "secret.png", data: "ciphertext", encrypted: true },
      { name: "odd.mp4", data: "bytes", method: 99 },
      { name: "fine.png", data: "ok" },
    ]);
    assert.equal(zip.entries[0]!.unreadable, "encrypted");
    assert.deepEqual(zip.entries[1]!.unreadable, { method: 99 });
    assert.equal(zip.entries[2]!.unreadable, undefined);
    await assert.rejects(zip.read(zip.entries[0]!), /cannot be read out/);
    await assert.rejects(zip.extract(zip.entries[1]!, path.join(dir, "never")), /cannot be read out/);
    await assert.rejects(stat(path.join(dir, "never")), { code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("names that climb out of a directory or start at the root stay strings and write nowhere", async () => {
  const dir = await testTemp("zip-names-");
  try {
    const zip = await archive(dir, [
      { name: "../evil.png", data: "one" },
      { name: "/etc/absolute.png", data: "two" },
      { name: "a/../../third.png", data: "three" },
      { name: "C:\\windows\\fourth.png", data: "four" },
    ]);
    assert.deepEqual(zip.entries.map((entry) => entry.name), ["../evil.png", "/etc/absolute.png", "a/../../third.png", "C:\\windows\\fourth.png"]);
    const out = path.join(dir, "staged.bin");
    await zip.extract(zip.entries[0]!, out);
    assert.equal((await readFile(out)).toString(), "one");
    await assert.rejects(stat(path.join(dir, "..", "evil.png")), { code: "ENOENT" });
    await assert.rejects(stat("/etc/absolute.png"), { code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("directories, symlinks, dot files and macOS resource forks are skipped", async () => {
  const dir = await testTemp("zip-skip-");
  try {
    const zip = await archive(dir, [
      { name: "media", directory: true },
      { name: "media/link.png", data: "target", symlink: true },
      { name: ".DS_Store", data: "x" },
      { name: "media/.hidden.png", data: "x" },
      { name: ".git/config", data: "x" },
      { name: "__MACOSX/media/._a.png", data: "x" },
      { name: "media/a.png", data: "kept" },
    ]);
    assert.deepEqual(zip.entries.map((entry) => entry.name), ["media/a.png"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a wrong checksum or size fails the extraction and leaves no file", async () => {
  const dir = await testTemp("zip-crc-");
  try {
    const zip = await archive(dir, [{ name: "bad.png", data: big, badCrc: true }]);
    const out = path.join(dir, "bad.out");
    await assert.rejects(zip.extract(zip.entries[0]!, out), /fails its checksum/);
    await assert.rejects(stat(out), { code: "ENOENT" });
    await assert.rejects(zip.read(zip.entries[0]!), /fails its checksum/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("extraction never overwrites an existing file", async () => {
  const dir = await testTemp("zip-excl-");
  try {
    const zip = await archive(dir, [{ name: "a.png", data: "new" }]);
    const out = path.join(dir, "taken");
    await writeFile(out, "old");
    await assert.rejects(zip.extract(zip.entries[0]!, out), { code: "EEXIST" });
    assert.equal((await readFile(out)).toString(), "old");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a file that is not a zip, or is cut short, is refused with a clear sentence", async () => {
  const dir = await testTemp("zip-bad-");
  try {
    const plain = path.join(dir, "plain.zip");
    await writeFile(plain, Buffer.alloc(100, 7));
    await assert.rejects(ZipArchive.open(plain), /not a zip archive/);
    const tiny = path.join(dir, "tiny.zip");
    await writeFile(tiny, "PK");
    await assert.rejects(ZipArchive.open(tiny), /too small/);
    await assert.rejects(ZipArchive.open(path.join(dir, "missing.zip")), /Cannot open the zip/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
