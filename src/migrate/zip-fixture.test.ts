import { deflateRawSync, crc32 } from "node:zlib";

/**
 * A zip writer for tests: it builds archives the reader must cope with, including
 * the odd ones (zip64, encrypted, unknown methods, names that climb out of a
 * directory). It holds no tests itself.
 */
export interface ZipFixtureEntry {
  name: string;
  data?: Buffer | string;
  /** Default deflate for data over 64 bytes, stored below. */
  method?: "stored" | "deflate" | number;
  encrypted?: boolean;
  /** Stores the sizes and offset in a zip64 extra field. */
  zip64?: boolean;
  symlink?: boolean;
  directory?: boolean;
  /** A wrong CRC-32 in the directory. */
  badCrc?: boolean;
}

export function zipBytes(entries: readonly ZipFixtureEntry[], options: { zip64?: boolean; comment?: string } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const raw = Buffer.from(entry.data ?? "");
    const method = entry.method === "stored" ? 0 : entry.method === "deflate" ? 8 : typeof entry.method === "number" ? entry.method : raw.length > 64 ? 8 : 0;
    const stored = method === 8 ? deflateRawSync(raw) : raw;
    const name = Buffer.from(entry.directory && !entry.name.endsWith("/") ? `${entry.name}/` : entry.name, "utf8");
    const flags = 0x800 | (entry.encrypted ? 1 : 0);
    const crc = entry.badCrc ? (crc32(raw) ^ 0xffff) >>> 0 : crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const localRecord = Buffer.concat([local, name, stored]);
    const big = entry.zip64 === true || options.zip64 === true;
    const extra = big ? Buffer.alloc(28) : Buffer.alloc(0);
    if (big) {
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(raw.length), 4);
      extra.writeBigUInt64LE(BigInt(stored.length), 12);
      extra.writeBigUInt64LE(BigInt(offset), 20);
    }
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(big ? 0xffffffff : stored.length, 20);
    central.writeUInt32LE(big ? 0xffffffff : raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    const mode = entry.symlink ? 0o120777 : entry.directory ? 0o040755 : 0o100644;
    central.writeUInt32LE(((mode << 16) >>> 0), 38);
    central.writeUInt32LE(big ? 0xffffffff : offset, 42);
    centrals.push(Buffer.concat([central, name, extra]));
    locals.push(localRecord);
    offset += localRecord.length;
  }
  const directory = Buffer.concat(centrals);
  const comment = Buffer.from(options.comment ?? "");
  const tail: Buffer[] = [];
  if (options.zip64) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(44n, 4);
    record.writeUInt16LE(45, 12);
    record.writeUInt16LE(45, 14);
    record.writeBigUInt64LE(BigInt(entries.length), 24);
    record.writeBigUInt64LE(BigInt(entries.length), 32);
    record.writeBigUInt64LE(BigInt(directory.length), 40);
    record.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(offset + directory.length), 8);
    locator.writeUInt32LE(1, 16);
    tail.push(record, locator);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(options.zip64 ? 0xffff : entries.length, 8);
  end.writeUInt16LE(options.zip64 ? 0xffff : entries.length, 10);
  end.writeUInt32LE(options.zip64 ? 0xffffffff : directory.length, 12);
  end.writeUInt32LE(options.zip64 ? 0xffffffff : offset, 16);
  end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...locals, directory, ...tail, end, comment]);
}
