import { open } from "node:fs/promises";
import path from "node:path";
import { usageError } from "../problems.js";

/**
 * Container sniffing for `media upload`.
 *
 * `--content-type` is the operator's claim about the source. The bytes are the
 * fact. When the two disagree the CLI must refuse before ffmpeg runs and before
 * any declare, because ffmpeg happily re-encodes a PNG "declared" as
 * `video/mp4` into a one-frame MP4 and uploads it (UAT R1-029).
 *
 * Only the magic numbers of common signage sources are recognized. An
 * unrecognized head is not a mismatch: extension and probe decide as before.
 */

export interface SniffedMedia {
  /** Canonical declared type this container corresponds to, for comparison. */
  contentType: string;
  /** Human description used in the mismatch message. */
  description: string;
  kind: "image" | "video";
}

/** Bytes needed to classify every signature below. */
export const SNIFF_HEAD_BYTES = 64;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const EBML = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);

const ISO_BMFF_IMAGE_BRANDS = new Set(["avif", "avis", "heic", "heix", "hevc", "hevx", "mif1", "msf1"]);

function startsWith(head: Buffer, prefix: Buffer | string, offset = 0): boolean {
  const bytes = typeof prefix === "string" ? Buffer.from(prefix, "latin1") : prefix;
  return head.length >= offset + bytes.length && head.subarray(offset, offset + bytes.length).equals(bytes);
}

export function sniffMediaContainer(input: Uint8Array): SniffedMedia | undefined {
  const head = Buffer.from(input.buffer, input.byteOffset, Math.min(input.byteLength, SNIFF_HEAD_BYTES));
  if (head.length < 12) {
    return undefined;
  }
  if (startsWith(head, PNG)) {
    return { contentType: "image/png", description: "a PNG image", kind: "image" };
  }
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return { contentType: "image/jpeg", description: "a JPEG image", kind: "image" };
  }
  if (startsWith(head, "GIF87a") || startsWith(head, "GIF89a")) {
    return { contentType: "image/gif", description: "a GIF image", kind: "image" };
  }
  if (startsWith(head, "RIFF")) {
    if (startsWith(head, "WEBP", 8)) {
      return { contentType: "image/webp", description: "a WebP image", kind: "image" };
    }
    if (startsWith(head, "AVI ", 8)) {
      return { contentType: "video/x-msvideo", description: "an AVI video", kind: "video" };
    }
    return undefined;
  }
  if (startsWith(head, "ftyp", 4)) {
    const brand = head.subarray(8, 12).toString("latin1").toLowerCase();
    if (ISO_BMFF_IMAGE_BRANDS.has(brand)) {
      const avif = brand.startsWith("avi");
      return {
        contentType: avif ? "image/avif" : "image/heic",
        description: avif ? "an AVIF image" : "a HEIF/HEIC image",
        kind: "image",
      };
    }
    // MP4, QuickTime, and 3GPP share the ISO base media container. The server
    // accepts `video/mp4`, and the transcoder re-encodes any of them, so they
    // all count as the mp4 family here.
    return { contentType: "video/mp4", description: "an MP4/QuickTime (ISO BMFF) video", kind: "video" };
  }
  if (startsWith(head, EBML)) {
    // Matroska and WebM share the EBML container; the server type is video/webm.
    return { contentType: "video/webm", description: "a Matroska/WebM video", kind: "video" };
  }
  if (startsWith(head, "OggS")) {
    return { contentType: "video/ogg", description: "an Ogg container", kind: "video" };
  }
  if (startsWith(head, "BM")) {
    return { contentType: "image/bmp", description: "a BMP image", kind: "image" };
  }
  if (startsWith(head, Buffer.from([0x49, 0x49, 0x2a, 0x00])) || startsWith(head, Buffer.from([0x4d, 0x4d, 0x00, 0x2a]))) {
    return { contentType: "image/tiff", description: "a TIFF image", kind: "image" };
  }
  return undefined;
}

/** Read only the head of the file; the upload path snapshots the whole file later. */
export async function readMediaHead(filePath: string): Promise<Buffer> {
  const handle = await open(filePath, "r");
  try {
    const head = Buffer.alloc(SNIFF_HEAD_BYTES);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return head.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Refuse a declared `--content-type` the bytes contradict. Runs before any
 * transcode or declare so nothing is encoded or uploaded under the wrong type.
 * A file the sniffer does not recognize is left to extension and ffprobe.
 */
export async function assertDeclaredTypeMatchesBytes(filePath: string, declaredContentType: string | undefined): Promise<void> {
  if (!declaredContentType) {
    return;
  }
  let head: Buffer;
  try {
    head = await readMediaHead(filePath);
  } catch {
    // The upload path reports unreadable files with its own message.
    return;
  }
  const sniffed = sniffMediaContainer(head);
  if (!sniffed || sniffed.contentType === declaredContentType.toLowerCase()) {
    return;
  }
  throw usageError(
    `${path.basename(filePath)} was declared --content-type ${declaredContentType}, but its bytes are ` +
      `${sniffed.description} (${sniffed.contentType}). Nothing was transcoded or uploaded. ` +
      "Pass the source's real type, omit --content-type to use the file extension, or fix the file.",
  );
}
