// Archive path rules for organisation data exports: NFC-normalised,
// sanitised segments, and collision-safe allocation on case-insensitive
// file systems.

import { panic } from "better-result";

import { compareCodeUnit } from "@stll/collation";
import { normalizeUnicode } from "@stll/text-normalize";

import { archivePathKey } from "@/api/handlers/data-exports/archive-path-key";
import { ZIP_COMPRESSION } from "@/api/handlers/data-exports/zip-writer";
import type { ZipCompression } from "@/api/handlers/data-exports/zip-writer";
import { sanitizeFilenamePreservingExtension } from "@/api/lib/sanitize-filename";

/** Stable naming order shared by planning and packing. */
export const compareArchiveNames = (
  a: { name: string; id: string },
  b: { name: string; id: string },
): number =>
  compareCodeUnit(
    normalizeUnicode(a.name, "NFC"),
    normalizeUnicode(b.name, "NFC"),
  ) || compareCodeUnit(a.id, b.id);

// Device names Windows refuses as a file or folder name, with or without an
// extension.
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/iu;
// Control characters break shells and some unzip tools.
const CONTROL_CHARS_RE = /\p{Cc}/gu;

/** File systems cap one name at 255 bytes (ext4, APFS) or UTF-16 units. */
export const MAX_SEGMENT_BYTES = 255;
/**
 * Bytes a sanitised segment leaves free for suffixes added later: a version
 * marker ` (v12345)` and a collision counter ` (12345)`.
 */
const SUFFIX_RESERVE_BYTES = 24;
/** Longer "extensions" are part of the name and may be shortened. */
const MAX_EXTENSION_BYTES = 32;

const encoder = new TextEncoder();
const utf8Bytes = (text: string): number => encoder.encode(text).byteLength;

/** The longest prefix of `text`, by whole code points, within `maxBytes`. */
export const truncateUtf8 = (text: string, maxBytes: number): string => {
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const size = utf8Bytes(character);
    if (bytes + size > maxBytes) {
      break;
    }
    bytes += size;
    end += character.length;
  }
  return text.slice(0, end);
};

const splitExtension = (
  fileName: string,
): { base: string; extension: string } => {
  const dotIndex = fileName.lastIndexOf(".");
  // A leading dot is part of the name, not an extension separator; an
  // overlong tail is part of the name too, so it may be shortened.
  if (
    dotIndex <= 0 ||
    utf8Bytes(fileName.slice(dotIndex)) > MAX_EXTENSION_BYTES
  ) {
    return { base: fileName, extension: "" };
  }
  return {
    base: fileName.slice(0, dotIndex),
    extension: fileName.slice(dotIndex),
  };
};

export const SEGMENT_SUFFIX_RESERVE = {
  /** The final suffix: the result may use the whole byte limit. */
  final: 0,
  /** A suffix that may still be followed by a collision counter. */
  open: SUFFIX_RESERVE_BYTES,
} as const;

type SuffixReserve =
  (typeof SEGMENT_SUFFIX_RESERVE)[keyof typeof SEGMENT_SUFFIX_RESERVE];

/**
 * `segment` with `suffix` inserted before its extension, the base shortened
 * by UTF-8 bytes so the result, plus `reserve`, stays within
 * MAX_SEGMENT_BYTES.
 */
export const withSegmentSuffix = (
  segment: string,
  suffix: string,
  reserve: SuffixReserve = SEGMENT_SUFFIX_RESERVE.final,
): string => {
  const { base, extension } = splitExtension(segment);
  const room =
    MAX_SEGMENT_BYTES - reserve - utf8Bytes(suffix) - utf8Bytes(extension);
  return `${truncateUtf8(base, room).trimEnd()}${suffix}${extension}`;
};

/**
 * One path segment: NFC (so a name typed on macOS and one typed on Windows
 * compare and extract identically), no separators or traversal, no
 * device names, no surrounding whitespace, and short enough by UTF-8 bytes
 * that suffixes added later still fit the file-system limit. The extension
 * survives shortening.
 */
export const sanitizeArchiveSegment = (name: string): string => {
  const normalized = normalizeUnicode(name, "NFC")
    .replace(CONTROL_CHARS_RE, "_")
    .trim();
  // The shared sanitiser cuts at 255 UTF-16 units; keeping the extension
  // there lets the byte budget below shorten the name, never the extension.
  const sanitized = normalizeUnicode(
    sanitizeFilenamePreservingExtension(normalized),
    "NFC",
  ).trim();
  if (sanitized.length === 0) {
    return "_";
  }
  const named = WINDOWS_RESERVED_RE.test(sanitized)
    ? `_${sanitized}`
    : sanitized;
  const { base, extension } = splitExtension(named);
  const room = MAX_SEGMENT_BYTES - SUFFIX_RESERVE_BYTES - utf8Bytes(extension);
  return `${truncateUtf8(base, room).trimEnd()}${extension}`;
};

/**
 * Hands out unique archive paths. Two paths collide when they are equal
 * after NFC and case folding, because extracting both onto a
 * case-insensitive file system (the default on Windows and macOS) would
 * overwrite one with the other. A colliding name gets ` (n)` before its
 * extension. Allocation is order-dependent, so callers feed it in a
 * deterministic order.
 */
export class ArchivePathAllocator {
  readonly #taken = new Set<string>();

  /** Reserve a fixed path (manifest, metadata) that must not be renamed. */
  reserve(path: string): string {
    const key = archivePathKey(path);
    if (this.#taken.has(key)) {
      return panic(`Archive path already allocated: ${path}`);
    }
    this.#taken.add(key);
    return path;
  }

  /** Allocate `directory/fileName`, suffixing the file name on collision. */
  allocate(directory: string, fileName: string): string {
    const segment = sanitizeArchiveSegment(fileName);
    const prefix = directory.length > 0 ? `${directory}/` : "";
    const first = `${prefix}${segment}`;
    if (!this.#taken.has(archivePathKey(first))) {
      this.#taken.add(archivePathKey(first));
      return first;
    }
    for (let n = 2; ; n++) {
      const candidate = `${prefix}${withSegmentSuffix(segment, ` (${n})`)}`;
      if (!this.#taken.has(archivePathKey(candidate))) {
        this.#taken.add(archivePathKey(candidate));
        return candidate;
      }
    }
  }
}

// Formats that are already compressed (OOXML/ODF are ZIP containers);
// deflating them again costs CPU for no gain.
const STORED_MIME_TYPES = new Set([
  "application/pdf",
  "application/zip",
  "application/gzip",
  "application/x-7z-compressed",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
  "application/epub+zip",
]);

const DEFLATE_MIME_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/rtf",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.ms-outlook",
  "message/rfc822",
  "image/svg+xml",
  "image/bmp",
  "image/tiff",
]);

/**
 * STORED for already-compressed formats and media, DEFLATE for text and
 * legacy binary office formats. Unknown types are stored: the writer would
 * fall back to STORED anyway when deflate does not shrink the entry, and
 * deflating opaque binaries is wasted CPU.
 */
export const compressionForMimeType = (mimeType: string): ZipCompression => {
  const type = mimeType.toLowerCase().split(";")[0]?.trim() ?? "";
  if (STORED_MIME_TYPES.has(type)) {
    return ZIP_COMPRESSION.STORE;
  }
  if (type.startsWith("text/") || DEFLATE_MIME_TYPES.has(type)) {
    return ZIP_COMPRESSION.DEFLATE;
  }
  return ZIP_COMPRESSION.STORE;
};
