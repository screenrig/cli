import { crc32, createInflateRaw } from "node:zlib";
import { createReadStream } from "node:fs";
import { open, rm, type FileHandle } from "node:fs/promises";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { usageError } from "../problems.js";

/**
 * A zip reader that runs in this process: the central directory, stored and
 * deflate entries, zip64, and a CRC-32 and size check on every byte read out.
 * An entry name is only ever a string: nothing here joins it to a filesystem
 * path, so "../x" and "/etc/x" are names like any other and write nowhere.
 */
export interface ZipEntry {
  /** The name as the archive stores it. */
  name: string;
  /** Uncompressed size. */
  bytes: number;
  compressedBytes: number;
  method: number;
  crc32: number;
  /** Local header position; the data follows it. */
  offset: number;
  /** Why the entry cannot be read out: it is encrypted, or uses a compression method this reader lacks. */
  unreadable?: "encrypted" | { method: number };
}

const EOCD = 0x06054b50;
const EOCD64 = 0x06064b50;
const EOCD64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const STORED = 0;
const DEFLATE = 8;
const U16 = 0xffff;
const U32 = 0xffffffff;

function safeNumber(value: bigint, what: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw usageError(`This zip's ${what} is larger than this CLI can address.`);
  return Number(value);
}

async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await handle.read(buffer, done, length - done, position + done);
    if (bytesRead === 0) throw usageError("This zip ends before its directory says it does; the file is truncated or damaged.");
    done += bytesRead;
  }
  return buffer;
}

function decodeName(raw: Buffer, utf8Flag: boolean): string {
  if (utf8Flag) return raw.toString("utf8");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    return raw.toString("latin1");
  }
}

/** The entries a person expects: files, without directories, links, dot files or macOS resource forks. */
function wanted(name: string, madeByUnix: boolean, attributes: number): boolean {
  if (name === "" || name.endsWith("/") || name.endsWith("\\")) return false;
  if (madeByUnix) {
    const type = (attributes >>> 16) & 0o170000;
    if (type === 0o120000 || type === 0o040000) return false;
  }
  for (const segment of name.split(/[\\/]/)) {
    if (segment === "__MACOSX") return false;
    if (segment.startsWith(".") && segment !== "." && segment !== "..") return false;
  }
  return true;
}

export class ZipArchive {
  private constructor(
    private readonly file: string,
    readonly entries: readonly ZipEntry[],
  ) {}

  static async open(file: string): Promise<ZipArchive> {
    let handle: FileHandle;
    try {
      handle = await open(file, "r");
    } catch {
      throw usageError("Cannot open the zip file for reading.");
    }
    try {
      return new ZipArchive(file, await ZipArchive.readDirectory(handle));
    } finally {
      await handle.close();
    }
  }

  private static async readDirectory(handle: FileHandle): Promise<ZipEntry[]> {
    const size = (await handle.stat()).size;
    if (size < 22) throw usageError("This file is too small to be a zip archive.");
    const tailLength = Math.min(size, 22 + 0xffff);
    const tailStart = size - tailLength;
    const tail = await readAt(handle, tailStart, tailLength);
    let eocd = -1;
    for (let at = tail.length - 22; at >= 0; at -= 1) {
      if (tail.readUInt32LE(at) === EOCD && at + 22 + tail.readUInt16LE(at + 20) === tail.length) {
        eocd = at;
        break;
      }
    }
    if (eocd < 0) throw usageError("This file is not a zip archive: its end-of-directory record is missing.");
    let count = tail.readUInt16LE(eocd + 10);
    let directorySize = tail.readUInt32LE(eocd + 12);
    let directoryOffset = tail.readUInt32LE(eocd + 16);
    if (count === U16 || directorySize === U32 || directoryOffset === U32) {
      const locatorAt = tailStart + eocd - 20;
      if (locatorAt < 0) throw usageError("This zip needs zip64 records that are missing.");
      const locator = await readAt(handle, locatorAt, 20);
      if (locator.readUInt32LE(0) !== EOCD64_LOCATOR) throw usageError("This zip needs zip64 records that are missing.");
      const record = await readAt(handle, safeNumber(locator.readBigUInt64LE(8), "directory position"), 56);
      if (record.readUInt32LE(0) !== EOCD64) throw usageError("This zip's zip64 end-of-directory record is damaged.");
      count = safeNumber(record.readBigUInt64LE(32), "entry count");
      directorySize = safeNumber(record.readBigUInt64LE(40), "directory size");
      directoryOffset = safeNumber(record.readBigUInt64LE(48), "directory position");
    }
    const directory = await readAt(handle, directoryOffset, directorySize);
    const entries: ZipEntry[] = [];
    let at = 0;
    for (let index = 0; index < count; index += 1) {
      if (at + 46 > directory.length || directory.readUInt32LE(at) !== CENTRAL) {
        throw usageError("This zip's directory is damaged.");
      }
      const madeBy = directory.readUInt16LE(at + 4);
      const flags = directory.readUInt16LE(at + 8);
      const method = directory.readUInt16LE(at + 10);
      const crc = directory.readUInt32LE(at + 16);
      let compressed = directory.readUInt32LE(at + 20);
      let bytes = directory.readUInt32LE(at + 24);
      const nameLength = directory.readUInt16LE(at + 28);
      const extraLength = directory.readUInt16LE(at + 30);
      const commentLength = directory.readUInt16LE(at + 32);
      const attributes = directory.readUInt32LE(at + 38);
      let offset = directory.readUInt32LE(at + 42);
      const nameEnd = at + 46 + nameLength;
      const extraEnd = nameEnd + extraLength;
      if (extraEnd + commentLength > directory.length) throw usageError("This zip's directory is damaged.");
      const name = decodeName(directory.subarray(at + 46, nameEnd), (flags & 0x800) !== 0);
      // The zip64 extra field carries, in this order, only the fields that overflowed.
      let extra = nameEnd;
      while (extra + 4 <= extraEnd) {
        const id = directory.readUInt16LE(extra);
        const length = directory.readUInt16LE(extra + 2);
        if (id === 0x0001) {
          let cursor = extra + 4;
          const take = (): number => {
            if (cursor + 8 > extra + 4 + length) throw usageError("This zip's zip64 extra field is damaged.");
            const value = safeNumber(directory.readBigUInt64LE(cursor), "entry size");
            cursor += 8;
            return value;
          };
          if (bytes === U32) bytes = take();
          if (compressed === U32) compressed = take();
          if (offset === U32) offset = take();
        }
        extra += 4 + length;
      }
      at = extraEnd + commentLength;
      if (!wanted(name, (madeBy >>> 8) === 3, attributes)) continue;
      const unreadable: ZipEntry["unreadable"] = (flags & 0x1) !== 0 || (flags & 0x40) !== 0
        ? "encrypted"
        : method === STORED || method === DEFLATE ? undefined : { method };
      entries.push({ name, bytes, compressedBytes: compressed, method, crc32: crc, offset, ...(unreadable ? { unreadable } : {}) });
    }
    return entries;
  }

  /** The decompressed bytes of one entry as they come, without the CRC-32 check. */
  private async stream(entry: ZipEntry): Promise<Readable> {
    if (entry.unreadable) throw usageError("This zip entry cannot be read out.");
    const handle = await open(this.file, "r");
    let start: number;
    try {
      const local = await readAt(handle, entry.offset, 30);
      if (local.readUInt32LE(0) !== LOCAL) throw usageError("This zip entry's header is damaged.");
      start = entry.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
    } finally {
      await handle.close();
    }
    if (entry.compressedBytes === 0) return Readable.from([]);
    const raw = createReadStream(this.file, { start, end: start + entry.compressedBytes - 1 });
    if (entry.method === STORED) return raw;
    const inflate = createInflateRaw();
    raw.on("error", (error) => inflate.destroy(error));
    inflate.on("close", () => raw.destroy());
    return raw.pipe(inflate);
  }

  /** The first `length` bytes of an entry, enough to tell what kind of file it is. */
  async head(entry: ZipEntry, length = 64): Promise<Buffer> {
    const stream = await this.stream(entry);
    const parts: Buffer[] = [];
    let have = 0;
    try {
      for await (const chunk of stream) {
        parts.push(chunk as Buffer);
        have += (chunk as Buffer).length;
        if (have >= length) break;
      }
    } finally {
      stream.destroy();
    }
    return Buffer.concat(parts).subarray(0, length);
  }

  private verifying(entry: ZipEntry): Transform {
    let total = 0;
    let crc = 0;
    return new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        total += chunk.length;
        if (total > entry.bytes) {
          callback(usageError("A zip entry holds more bytes than its directory says; the archive is damaged."));
          return;
        }
        crc = crc32(chunk, crc);
        callback(null, chunk);
      },
      flush(callback) {
        if (total !== entry.bytes || crc !== entry.crc32) callback(usageError("A zip entry fails its checksum; the archive is damaged."));
        else callback();
      },
    });
  }

  /** A whole entry in memory, checksum verified. For small text files. */
  async read(entry: ZipEntry): Promise<Buffer> {
    const parts: Buffer[] = [];
    await pipeline(await this.stream(entry), this.verifying(entry), new Writable({
      write(chunk: Buffer, _encoding, callback) {
        parts.push(chunk);
        callback();
      },
    }));
    return Buffer.concat(parts);
  }

  /** Writes an entry to `destination` (created exclusively, mode 0600), checksum verified; a failed read leaves no file. */
  async extract(entry: ZipEntry, destination: string): Promise<{ bytes: number }> {
    const source = await this.stream(entry);
    let handle: FileHandle;
    try {
      handle = await open(destination, "wx", 0o600);
    } catch (error) {
      source.destroy();
      throw error;
    }
    try {
      await pipeline(source, this.verifying(entry), handle.createWriteStream());
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(destination, { force: true });
      throw error;
    }
    return { bytes: entry.bytes };
  }
}
