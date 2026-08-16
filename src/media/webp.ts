/**
 * Minimal WebP container reader.
 *
 * ffmpeg cannot demux animated WebP, so ffprobe reports no stream for those
 * files. The CLI still has to know whether such a source is a real WebP and
 * whether its canvas already fits the delivery bound, which the RIFF header
 * answers without decoding any pixels.
 */

export interface WebpContainer {
  animated: boolean;
  /** Zero when the chunk that carries the canvas size is absent. */
  width: number;
  height: number;
}

const RIFF = 0x52494646;
const WEBP = 0x57454250;

export function readWebpContainer(bytes: Buffer): WebpContainer | undefined {
  if (bytes.length < 16) {
    return undefined;
  }
  if (bytes.readUInt32BE(0) !== RIFF || bytes.readUInt32BE(8) !== WEBP) {
    return undefined;
  }

  let offset = 12;
  let result: WebpContainer = { animated: false, width: 0, height: 0 };
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const payload = offset + 8;
    if (size > bytes.length - payload) {
      break;
    }

    if (id === "VP8X" && size >= 10) {
      const flags = bytes.readUInt8(payload);
      result = {
        animated: (flags & 0x02) !== 0,
        width: bytes.readUIntLE(payload + 4, 3) + 1,
        height: bytes.readUIntLE(payload + 7, 3) + 1,
      };
      // VP8X is always first and carries the authoritative canvas size.
      return result;
    }
    if (id === "VP8L" && size >= 5 && bytes.readUInt8(payload) === 0x2f) {
      const bits = bytes.readUInt32LE(payload + 1);
      return { animated: false, width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (id === "VP8 " && size >= 10) {
      // Uncompressed data chunk of a VP8 key frame: 3-byte start code then 2+2 dimensions.
      const start = payload + 3;
      if (bytes.readUInt8(start) === 0x9d && bytes.readUInt8(start + 1) === 0x01 && bytes.readUInt8(start + 2) === 0x2a) {
        return {
          animated: false,
          width: bytes.readUInt16LE(start + 3) & 0x3fff,
          height: bytes.readUInt16LE(start + 5) & 0x3fff,
        };
      }
    }

    offset = payload + size + (size % 2);
  }
  return result;
}
