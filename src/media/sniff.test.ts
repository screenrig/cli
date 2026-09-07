import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { CliError } from "../problems.js";
import { testTemp } from "../test-temp.js";
import { assertDeclaredTypeMatchesBytes, sniffMediaContainer } from "./sniff.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(12)]);
const GIF = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(10)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([16, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(8)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(8)]);
const MOV = Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from("ftypqt  "), Buffer.alloc(8)]);
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), Buffer.alloc(8)]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(12)]);

test("sniffMediaContainer recognizes the common signage containers and nothing else", () => {
  assert.equal(sniffMediaContainer(PNG)?.contentType, "image/png");
  assert.equal(sniffMediaContainer(JPEG)?.contentType, "image/jpeg");
  assert.equal(sniffMediaContainer(GIF)?.contentType, "image/gif");
  assert.equal(sniffMediaContainer(WEBP)?.contentType, "image/webp");
  assert.equal(sniffMediaContainer(MP4)?.contentType, "video/mp4");
  // QuickTime shares the ISO BMFF container the server files under video/mp4.
  assert.equal(sniffMediaContainer(MOV)?.contentType, "video/mp4");
  assert.equal(sniffMediaContainer(HEIC)?.contentType, "image/heic");
  assert.equal(sniffMediaContainer(WEBM)?.contentType, "video/webm");
  assert.equal(sniffMediaContainer(Buffer.from("hello world, not a container")), undefined);
  assert.equal(sniffMediaContainer(Buffer.alloc(4)), undefined, "a head too short to classify is unknown");
});

test("a declared --content-type the bytes contradict fails as usage_error naming both types", async () => {
  const dir = await testTemp("sniff-");
  const png = path.join(dir, "photo.png");
  await writeFile(png, PNG);
  await assert.rejects(
    () => assertDeclaredTypeMatchesBytes(png, "video/mp4"),
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.problem.code, "usage_error");
      assert.match(error.problem.detail ?? "", /photo\.png was declared --content-type video\/mp4/);
      assert.match(error.problem.detail ?? "", /a PNG image \(image\/png\)/);
      assert.match(error.problem.detail ?? "", /Nothing was transcoded or uploaded/);
      return true;
    },
  );
  // Same family but a different type is still a contradiction.
  await assert.rejects(() => assertDeclaredTypeMatchesBytes(png, "image/jpeg"), /a PNG image/);
  // Agreement, case-insensitive, passes.
  await assertDeclaredTypeMatchesBytes(png, "image/png");
  await assertDeclaredTypeMatchesBytes(png, "IMAGE/PNG");
  // No declaration means nothing to contradict.
  await assertDeclaredTypeMatchesBytes(png, undefined);
  // Unrecognized bytes are left to the extension and ffprobe.
  const opaque = path.join(dir, "clip.mp4");
  await writeFile(opaque, Buffer.from("not any container we know"));
  await assertDeclaredTypeMatchesBytes(opaque, "video/mp4");
  await assertDeclaredTypeMatchesBytes(opaque, "image/png");
  // A missing file is reported by the upload path, not the sniffer.
  await assertDeclaredTypeMatchesBytes(path.join(dir, "absent.png"), "video/mp4");
});
