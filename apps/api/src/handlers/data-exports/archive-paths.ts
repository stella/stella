// Archive path rules for organisation data exports: NFC-normalised,
// sanitised segments, and collision-safe allocation on case-insensitive
// file systems.

import { panic } from "better-result";

import { normalizeUnicode } from "@stll/text-normalize";

import { ZIP_COMPRESSION } from "@/api/handlers/data-exports/zip-writer";
import type { ZipCompression } from "@/api/handlers/data-exports/zip-writer";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";

// Device names Windows refuses as a file or folder name, with or without an
// extension.
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/iu;
// Control characters break shells and some unzip tools.
const CONTROL_CHARS_RE = /\p{Cc}/gu;

/**
 * One path segment: NFC (so a name typed on macOS and one typed on Windows
 * compare and extract identically), no separators or traversal, no
 * device names, no surrounding whitespace.
 */
export const sanitizeArchiveSegment = (name: string): string => {
  const normalized = normalizeUnicode(name, "NFC")
    .replace(CONTROL_CHARS_RE, "_")
    .trim();
  const sanitized = normalizeUnicode(
    sanitizeFilename(normalized),
    "NFC",
  ).trim();
  if (sanitized.length === 0) {
    return "_";
  }
  return WINDOWS_RESERVED_RE.test(sanitized) ? `_${sanitized}` : sanitized;
};

const foldKey = (path: string): string =>
  normalizeUnicode(path, "NFC").toLowerCase();

const splitExtension = (
  fileName: string,
): { base: string; extension: string } => {
  const dotIndex = fileName.lastIndexOf(".");
  // A leading dot is part of the name, not an extension separator.
  if (dotIndex <= 0) {
    return { base: fileName, extension: "" };
  }
  return {
    base: fileName.slice(0, dotIndex),
    extension: fileName.slice(dotIndex),
  };
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
    const key = foldKey(path);
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
    if (!this.#taken.has(foldKey(first))) {
      this.#taken.add(foldKey(first));
      return first;
    }
    const { base, extension } = splitExtension(segment);
    for (let n = 2; ; n++) {
      const candidate = `${prefix}${base} (${n})${extension}`;
      if (!this.#taken.has(foldKey(candidate))) {
        this.#taken.add(foldKey(candidate));
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
