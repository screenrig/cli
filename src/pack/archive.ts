import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { rethrowRule } from "./limits.js";
import { writeTar as writeUstar } from "./release-core.js";
import type { ArchiveEntry } from "./types.js";

const BLOCK = 512;
const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

export function crc32(data: Uint8Array): number {
  let value = 0xffffffff;
  for (let index = 0; index < data.length; index += 1) {
    value = CRC32_TABLE[(value ^ data[index]!) & 0xff]! ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

export function writeTar(entries: ArchiveEntry[]): Buffer {
  try {
    const tar = writeUstar(entries);
    return Buffer.from(tar.buffer, tar.byteOffset, tar.byteLength);
  } catch (error) {
    return rethrowRule(error);
  }
}

export function gzipDeterministic(data: Uint8Array): Buffer {
  const deflated = deflateRawSync(data, { level: 9 });
  const header = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0xff]);
  const footer = Buffer.alloc(8);
  footer.writeUInt32LE(crc32(data), 0);
  footer.writeUInt32LE(data.length >>> 0, 4);
  return Buffer.concat([header, deflated, footer]);
}

export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function padToBlock(size: number): number {
  const rem = size % BLOCK;
  return rem === 0 ? 0 : BLOCK - rem;
}

export function parseTar(archive: Buffer): Array<{ path: string; type: "file" | "directory"; size: number }> {
  const out: Array<{ path: string; type: "file" | "directory"; size: number }> = [];
  let offset = 0;
  while (offset + BLOCK <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const name = header.subarray(0, 100).toString("utf8").replace(/\0+$/, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0+$/, "");
    const posixPath = prefix ? `${prefix}/${name}` : name;
    const sizeRaw = header.subarray(124, 136).toString("ascii").replace(/\0+$/, "").trim();
    const size = Number.parseInt(sizeRaw, 8) || 0;
    const typeflag = header[156];
    const type = typeflag === 0x35 ? "directory" : "file";
    out.push({ path: posixPath, type, size });
    offset += BLOCK + size + padToBlock(size);
  }
  return out;
}
