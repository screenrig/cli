import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { crc32, inflateRawSync } from "node:zlib";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { packDirectory } from "./pack/index.js";
import { testTemp } from "./test-temp.js";

const BLOCK = 512;
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtures = fileURLToPath(new URL("../fixtures/pack/ok-app", import.meta.url));

interface RestrictedArchiveInspection {
  tar: Buffer;
  paths: string[];
  gzipMembers: 1;
}

function gzipPayloadOffset(archive: Buffer): number {
  assert.equal(archive[0], 0x1f, "gzip ID1");
  assert.equal(archive[1], 0x8b, "gzip ID2");
  assert.equal(archive[2], 8, "gzip compression method must be deflate");
  const flags = archive[3] ?? 0;
  assert.equal(flags & 0xe0, 0, "gzip reserved flags must be zero");
  let offset = 10;
  if (flags & 0x04) {
    const extraLength = archive.readUInt16LE(offset);
    offset += 2 + extraLength;
  }
  for (const flag of [0x08, 0x10]) {
    if (flags & flag) {
      while (offset < archive.length && archive[offset++] !== 0) {
        // Scan the zero-terminated name/comment field.
      }
    }
  }
  if (flags & 0x02) offset += 2;
  assert.ok(offset < archive.length - 8, "gzip header must precede payload and trailer");
  return offset;
}

function inspectRestrictedArchive(archive: Buffer): RestrictedArchiveInspection {
  const payloadOffset = gzipPayloadOffset(archive);
  const inflated = inflateRawSync(archive.subarray(payloadOffset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  const tar = Buffer.from(inflated.buffer);
  const deflateBytes = inflated.engine.bytesWritten;
  const trailerOffset = payloadOffset + deflateBytes;
  assert.equal(trailerOffset + 8, archive.length, "archive must contain exactly one gzip member and no trailing bytes");
  assert.equal(archive.readUInt32LE(trailerOffset), crc32(tar), "gzip CRC32 must cover the one tar payload");
  assert.equal(archive.readUInt32LE(trailerOffset + 4), tar.length >>> 0, "gzip ISIZE must match the tar payload");

  const paths: string[] = [];
  let offset = 0;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) {
      assert.ok(offset + BLOCK * 2 === tar.length, "tar must end with exactly two zero blocks and no trailing stream");
      assert.ok(tar.subarray(offset + BLOCK, offset + BLOCK * 2).every((byte) => byte === 0), "second tar end block must be zero");
      break;
    }
    assert.equal(header.subarray(257, 263).toString("latin1"), "ustar\0", "every entry must use USTAR magic");
    assert.equal(header.subarray(263, 265).toString("ascii"), "00", "every entry must use USTAR version 00");
    const typeflag = header[156];
    assert.ok(typeflag === 0x30 || typeflag === 0x35, "only USTAR regular-file and directory entries are allowed");
    assert.ok(header.subarray(157, 257).every((byte) => byte === 0), "link name must be empty");
    const name = header.subarray(0, 100).toString("utf8").replace(/\0+$/, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0+$/, "");
    paths.push(prefix ? `${prefix}/${name}` : name);
    const sizeText = header.subarray(124, 136).toString("ascii").replace(/\0+$/, "").trim();
    const size = Number.parseInt(sizeText, 8) || 0;
    offset += BLOCK + size + ((BLOCK - (size % BLOCK)) % BLOCK);
  }
  assert.ok(paths.includes("index.html"));
  assert.ok(paths.includes("_screenrig/runtime.js"));
  return { tar, paths, gzipMembers: 1 };
}

test("packer emits one gzip member containing only restricted USTAR entries", async () => {
  const packed = await packDirectory(fixtures);
  const inspected = inspectRestrictedArchive(packed.archive);
  assert.equal(inspected.gzipMembers, 1);
  assert.deepEqual(inspected.paths, packed.entries.map((entry) => entry.path));
});

test("actual CLI archive is accepted by the real extractor", async (t) => {
  const extractor = process.env.SCREENRIG_EXTRACTOR_BIN;
  if (!extractor) {
    t.skip("set SCREENRIG_EXTRACTOR_BIN to run the cross-component acceptance gate");
    return;
  }

  const temp = await testTemp("extractor-integration-");
  const archivePath = path.join(temp, "application.tar.gz");
  const outputPath = path.join(temp, "output");
  await mkdir(outputPath);
  try {
    const cli = spawnSync(
      process.execPath,
      [path.join(packageRoot, "dist", "bin.js"), "--json", "app", "pack", fixtures, "--output", archivePath],
      { cwd: packageRoot, encoding: "utf8", env: { ...process.env, XDG_CONFIG_HOME: path.join(temp, "config") } },
    );
    assert.equal(cli.status, 0, cli.stderr || cli.stdout);
    const envelope = JSON.parse(cli.stdout) as { ok: true; data: { sha256: string } };
    assert.equal(envelope.ok, true);

    const archive = await readFile(archivePath);
    inspectRestrictedArchive(archive);
    const extracted = spawnSync(extractor, ["--input", archivePath, "--output", outputPath], { encoding: "utf8" });
    assert.equal(extracted.status, 0, extracted.stderr || extracted.stdout);
    assert.equal(extracted.stderr, "");
    const result = JSON.parse(extracted.stdout) as {
      version: string;
      ok: boolean;
      archive_sha256: string;
      file_count: number;
      entry_count: number;
      entries: Array<{ path: string; type: string }>;
    };
    assert.equal(result.version, "screenrig.extractor/1");
    assert.equal(result.ok, true);
    assert.equal(result.archive_sha256, envelope.data.sha256);
    assert.equal(result.file_count, 4);
    assert.equal(result.entry_count, 6);
    assert.deepEqual(result.entries.map((entry) => entry.path), [
      "_screenrig",
      "_screenrig/runtime.js",
      "assets",
      "assets/app.css",
      "index.html",
      "screenrig.json",
    ]);
    const html = await readFile(path.join(outputPath, "index.html"), "utf8");
    assert.match(html, /data-screenrig-sdk="1"/);
    assert.deepEqual(await readFile(path.join(outputPath, "_screenrig", "runtime.js")), await readFile(path.join(packageRoot, "assets", "screenrig.runtime.js")));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
