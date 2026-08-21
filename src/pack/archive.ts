import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { packError } from "./limits.js";
import type { ArchiveEntry } from "./types.js";

const BLOCK = 512;
const USTAR_MAGIC = "ustar\0";
const USTAR_VERSION = "00";
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

function putString(buf: Buffer, offset: number, length: number, value: string): void {
  buf.fill(0, offset, offset + length);
  if (value.length > length) {
    throw packError("path_too_long", `USTAR field overflow: ${value}`);
  }
  buf.write(value, offset, "utf8");
}

function putOctal(buf: Buffer, offset: number, length: number, value: number): void {
  const oct = value.toString(8).padStart(length - 1, "0");
  buf.fill(0, offset, offset + length);
  buf.write(oct, offset, length - 1, "ascii");
}

function checksum(header: Buffer): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) {
    sum += header[i] ?? 0;
  }
  return sum;
}

function splitName(posixPath: string): { name: string; prefix: string } {
  if (Buffer.byteLength(posixPath, "utf8") <= 100) {
    return { name: posixPath, prefix: "" };
  }
  const parts = posixPath.split("/");
  for (let i = 1; i < parts.length; i += 1) {
    const prefix = parts.slice(0, i).join("/");
    const name = parts.slice(i).join("/");
    if (Buffer.byteLength(prefix, "utf8") <= 155 && Buffer.byteLength(name, "utf8") <= 100) {
      return { name, prefix };
    }
  }
  throw packError("path_too_long", `Path cannot be encoded in ustar: ${posixPath}`);
}

function headerFor(entry: ArchiveEntry): Buffer {
  const header = Buffer.alloc(BLOCK);
  const split = splitName(entry.path);
  putString(header, 0, 100, split.name);
  putOctal(header, 100, 8, entry.type === "directory" ? 0o755 : 0o644);
  putOctal(header, 108, 8, 0);
  putOctal(header, 116, 8, 0);
  putOctal(header, 124, 12, entry.type === "file" ? entry.size : 0);
  putOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = entry.type === "directory" ? 0x35 : 0x30;
  putString(header, 257, 6, USTAR_MAGIC);
  putString(header, 263, 2, USTAR_VERSION);
  putString(header, 265, 32, "");
  putString(header, 297, 32, "");
  putOctal(header, 329, 8, 0);
  putOctal(header, 337, 8, 0);
  putString(header, 345, 155, split.prefix);
  const sum = checksum(header);
  const sumOct = `${sum.toString(8).padStart(6, "0")}\0 `;
  header.write(sumOct, 148, 8, "ascii");
  return header;
}

function padToBlock(size: number): number {
  const rem = size % BLOCK;
  return rem === 0 ? 0 : BLOCK - rem;
}

export function writeTar(entries: ArchiveEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    chunks.push(headerFor(entry));
    if (entry.type === "file") {
      const data = entry.data ?? Buffer.alloc(0);
      chunks.push(data);
      const pad = padToBlock(data.length);
      if (pad > 0) {
        chunks.push(Buffer.alloc(pad));
      }
    }
  }
  chunks.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(chunks);
}

export function gzipDeterministic(data: Buffer): Buffer {
  const deflated = deflateRawSync(data, { level: 9 });
  const header = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0xff]);
  const footer = Buffer.alloc(8);
  footer.writeUInt32LE(crc32(data), 0);
  footer.writeUInt32LE(data.length >>> 0, 4);
  return Buffer.concat([header, deflated, footer]);
}

export function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
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
