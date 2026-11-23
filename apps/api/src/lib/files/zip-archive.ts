/**
 * Reads a plain ZIP archive: every file it holds, in the archive's order,
 * with the folders it sits in. The archive is held to the bounds every
 * archive reader keeps (size, entry count, total uncompressed size and
 * compression ratio, from its index before anything is inflated), and one
 * file to `ZIP_ARCHIVE_MAX_FILE_BYTES`.
 *
 * Names are shown, never used as paths: a name that climbs out of the archive
 * (`../`), starts at a root or a drive, or uses backslashes is listed as the
 * archive states it. A file that does not open is listed with the reason:
 * encrypted, a link (never followed), a compression method other than stored
 * or deflate, too large, or damaged.
 *
 * What an operating system leaves in a folder it zips for its own use (the
 * macOS `__MACOSX/` tree and `._` AppleDouble files, `.DS_Store`, Windows'
 * `Thumbs.db` and `desktop.ini`) is not listed, so it is never a part, in
 * search text or in what an agent reads; it stays in the archive itself.
 */
import { Result } from "better-result";

import type { FilePartUnavailableReason } from "@stll/api-contract/file-parts";
import { decodeUndeclaredFileNames } from "@stll/mojibake/undeclared-charset";

import {
  hasZipMagic,
  readZipIndex,
  unreadableZipEntry,
  ZIP_METHOD_STORED,
  type ZipEntry,
} from "@/api/lib/file-scan/zip";
import {
  DocumentPackageError,
  isWithinArchiveLimits,
  readArchiveEntry,
} from "@/api/lib/files/document-archive";

/** The largest file the archive reader inflates. */
export const ZIP_ARCHIVE_MAX_FILE_BYTES = 32 * 1024 * 1024;

const ZIP_FLAG_UTF8 = 0x08_00;
const ZIP_EXTRA_UNICODE_PATH = 0x70_75;
// The high 16 bits of the external attributes hold a Unix mode; its top
// nibble is the file type.
const UNIX_FILE_TYPE_PLACE = 0x10_00_00_00;
const UNIX_DIRECTORY_TYPE = 4;
const UNIX_SYMLINK_TYPE = 10;
/** MS-DOS directory attribute, in the low byte of the external attributes. */
const DOS_DIRECTORY_ATTRIBUTE = 0x10;
/** Characters of a name shown; a longer stated name is cut. */
const MAX_NAME_CHARS = 1024;
/** The end of central directory record, all an empty archive holds. */
const EMPTY_ARCHIVE_BYTES = 22;

const hasFlag = (flags: number, flag: number): boolean =>
  Math.floor(flags / flag) % 2 === 1;

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
const lenientUtf8 = new TextDecoder("utf-8");

const decodeUtf8 = (bytes: Uint8Array): string | null =>
  Result.try(() => strictUtf8.decode(bytes)).unwrapOr(null);

/**
 * The name an Info-ZIP Unicode path field states, when it belongs to this
 * entry's stored name (its CRC-32 matches); null otherwise.
 */
const unicodePathName = (entry: ZipEntry): string | null => {
  for (const fields of [entry.extraFields.central, entry.extraFields.local]) {
    const view = new DataView(
      fields.buffer,
      fields.byteOffset,
      fields.byteLength,
    );
    for (let offset = 0; offset + 4 <= fields.byteLength;) {
      const type = view.getUint16(offset, true);
      const start = offset + 4;
      const end = start + view.getUint16(offset + 2, true);
      if (end > fields.byteLength) {
        break;
      }
      if (
        type === ZIP_EXTRA_UNICODE_PATH &&
        end - start > 5 &&
        view.getUint8(start) === 1 &&
        view.getUint32(start + 1, true) === Bun.hash.crc32(entry.name)
      ) {
        return decodeUtf8(fields.subarray(start + 5, end));
      }
      offset = end;
    }
  }
  return null;
};

/**
 * Each entry's name as the archive states it, decoded: the Unicode path an
 * Info-ZIP field gives, else the name in UTF-8 when the entry's flag says
 * so. The names left declare no charset; they are read together, as one
 * program wrote them (`decodeUndeclaredFileNames`).
 */
const statedNames = (entries: readonly ZipEntry[]): string[] => {
  const declared = entries.map(
    (entry) =>
      unicodePathName(entry) ??
      (hasFlag(entry.flags, ZIP_FLAG_UTF8)
        ? lenientUtf8.decode(entry.name)
        : null),
  );
  const undeclared = decodeUndeclaredFileNames(
    entries.flatMap((entry, index) =>
      declared[index] === null ? [entry.name] : [],
    ),
  ).names;
  let next = 0;
  return declared.map((name) => name ?? undeclared[next++] ?? "");
};

/** Names of files an operating system keeps for itself, matched in any case. */
const SYSTEM_FILE_NAMES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);
const MACOS_METADATA_FOLDER = "__macosx";
const APPLE_DOUBLE_PREFIX = "._";

/**
 * Whether a stated name is folder metadata an operating system adds when it
 * zips a folder: the `__MACOSX/` tree (resource forks and extended
 * attributes), `._` AppleDouble files, `.DS_Store`, `Thumbs.db` and
 * `desktop.ini`.
 */
const isSystemMetadataName = (name: string): boolean => {
  const segments = name.split(/[/\\]/u).filter((segment) => segment !== "");
  const fileName = segments.at(-1) ?? "";
  return (
    segments.at(0)?.toLowerCase() === MACOS_METADATA_FOLDER ||
    fileName.startsWith(APPLE_DOUBLE_PREFIX) ||
    SYSTEM_FILE_NAMES.has(fileName.toLowerCase())
  );
};

/** A stated name or folder as shown: bounded, control characters replaced. */
const shown = (text: string): string =>
  text.slice(0, MAX_NAME_CHARS).replace(/\p{Cc}/gu, "\uFFFD");

const unixFileType = (entry: ZipEntry): number =>
  Math.floor(entry.externalAttributes / UNIX_FILE_TYPE_PLACE);

const isDirectory = (entry: ZipEntry, name: string): boolean =>
  /[/\\]$/u.test(name) ||
  unixFileType(entry) === UNIX_DIRECTORY_TYPE ||
  (entry.uncompressedSize === 0 &&
    hasFlag(entry.externalAttributes % 0x1_00, DOS_DIRECTORY_ATTRIBUTE));

/** Why the entry does not open, or null when it is a file the reader reads. */
const unavailableReason = (
  entry: ZipEntry,
): FilePartUnavailableReason | null => {
  const unreadable = unreadableZipEntry(entry);
  if (unreadable === "encrypted") {
    return "encrypted";
  }
  if (unixFileType(entry) === UNIX_SYMLINK_TYPE) {
    return "link";
  }
  if (unreadable === "unsupportedCompression") {
    return "unsupported";
  }
  if (entry.uncompressedSize > ZIP_ARCHIVE_MAX_FILE_BYTES) {
    return "tooLarge";
  }
  if (
    entry.method === ZIP_METHOD_STORED &&
    entry.data.byteLength !== entry.uncompressedSize
  ) {
    return "unreadable";
  }
  return null;
};

/** One file an archive holds, as the archive lists it. */
export type ZipArchiveFile = {
  /** Its name without its folders, as stated. */
  readonly fileName: string;
  /** The folders it sits in, as stated (`smlouvy/2026`); null at the top. */
  readonly folder: string | null;
  /** Its size as the archive states it. */
  readonly sizeBytes: number;
  /** Why it does not open; null when the reader reads it. */
  readonly unavailable: FilePartUnavailableReason | null;
  readonly entry: ZipEntry;
};

const archiveFile = (entry: ZipEntry, name: string): ZipArchiveFile => {
  // Split the whole stated name first; only what is shown is bounded.
  const segments = name.split(/[/\\]/u).filter((segment) => segment !== "");
  return {
    fileName: shown(segments.at(-1) ?? name),
    folder: segments.length > 1 ? shown(segments.slice(0, -1).join("/")) : null,
    sizeBytes: entry.uncompressedSize,
    unavailable: unavailableReason(entry),
    entry,
  };
};

/** An archive of no entries: its end record alone, which a reader accepts. */
const isEmptyArchive = (bytes: Uint8Array): boolean =>
  bytes.byteLength >= EMPTY_ARCHIVE_BYTES &&
  bytes[0] === 0x50 &&
  bytes[1] === 0x4b &&
  bytes[2] === 0x05 &&
  bytes[3] === 0x06;

const invalid = (message: string) =>
  Result.err(new DocumentPackageError({ message, reason: "invalid" }));

/**
 * The files of a ZIP archive in its order; folders and system metadata are
 * not files. A file's position in this list addresses it as a part
 * (`member:N`).
 */
export const readZipArchive = async (
  bytes: Uint8Array,
): Promise<Result<ZipArchiveFile[], DocumentPackageError>> => {
  if (!hasZipMagic(bytes) && !isEmptyArchive(bytes)) {
    return invalid("The file is not a ZIP archive");
  }
  if (!(await isWithinArchiveLimits(bytes))) {
    return Result.err(
      new DocumentPackageError({
        message: "The archive exceeds the supported ZIP limits",
        reason: "limit",
      }),
    );
  }
  const index = readZipIndex(bytes);
  if (index.type === "malformed") {
    return invalid("The archive has a malformed ZIP index");
  }
  const names = statedNames(index.entries);
  return Result.ok(
    index.entries.flatMap((entry, position) => {
      const name = names[position] ?? "";
      return isDirectory(entry, name) || isSystemMetadataName(name)
        ? []
        : [archiveFile(entry, name)];
    }),
  );
};

/** A file's bytes; an entry that does not inflate to its stated size is damaged. */
export const readZipArchiveFile = (
  file: ZipArchiveFile,
): Result<Uint8Array, DocumentPackageError> =>
  file.unavailable === null
    ? readArchiveEntry(file.entry)
    : Result.err(
        new DocumentPackageError({
          message: "The archive file does not open",
          reason: "invalid",
        }),
      );
