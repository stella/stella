import { Result, TaggedError } from "better-result";
import { inflateRawSync } from "node:zlib";

import { declareFingerprintFields } from "@stll/errors";

import { createZipBombGuard } from "@/api/lib/file-scan/scanner";
import {
  hasZipMagic,
  readZipIndex,
  unreadableZipEntry,
  ZIP_METHOD_STORED,
  type ZipEntry,
} from "@/api/lib/file-scan/zip";
import { archivePathKey } from "@/api/lib/files/archive-path-key";
import { DOCUMENT_ARCHIVE_MAX_BYTES } from "@/api/lib/files/archive-preview-protocol";

const MAX_ENTRY_NAME_BYTES = 1024;
const MAX_PATH_DEPTH = 32;
const ZIP_EXTRA_LANGUAGE_ENCODING = 0x00_08;
const ZIP_EXTRA_UNICODE_PATH = 0x70_75;
const ZIP_FLAG_UTF8 = 0x08_00;
// The high nibble of the ZIP external attributes holds the POSIX file type.
const UNIX_FILE_TYPE_PLACE = 0x10_00_00_00;
const UNIX_DIRECTORY_TYPE = 4;
const UNIX_REGULAR_FILE_TYPE = 8;

// Bound both the ZIP index walk and the total retained decompressed contents.
// These are independent of the upload scanner's inspection budgets.
const archiveGuard = createZipBombGuard({
  maxEntries: 1000,
  maxTotalUncompressedBytes: DOCUMENT_ARCHIVE_MAX_BYTES,
  maxCompressionRatio: 1000,
});

export class DocumentPackageError extends TaggedError("DocumentPackageError")<{
  message: string;
  reason: "invalid" | "limit";
}> {
  static {
    declareFingerprintFields(this, ["reason"]);
  }
}

const invalid = (message: string) =>
  Result.err(new DocumentPackageError({ message, reason: "invalid" }));

type ArchivePath = {
  path: string;
  kind: "file" | "directory" | "implicit-directory";
};

const hasConsistentPathExtras = (fields: Uint8Array, name: Buffer): boolean => {
  const view = new DataView(
    fields.buffer,
    fields.byteOffset,
    fields.byteLength,
  );
  for (let offset = 0; offset < fields.length;) {
    if (offset + 4 > fields.length) {
      return false;
    }
    const type = view.getUint16(offset, true);
    const start = offset + 4;
    const end = start + view.getUint16(offset + 2, true);
    if (end > fields.length || type === ZIP_EXTRA_LANGUAGE_ENCODING) {
      return false;
    }
    if (
      type === ZIP_EXTRA_UNICODE_PATH &&
      (end - start !== name.length + 5 ||
        view.getUint8(start) !== 1 ||
        view.getUint32(start + 1, true) !== Bun.hash.crc32(name) ||
        !name.every((byte, index) => byte === fields[start + 5 + index]))
    ) {
      return false;
    }
    offset = end;
  }
  return true;
};

const hasZipFlag = (flags: number, flag: number): boolean =>
  Math.floor(flags / flag) % 2 === 1;

const decodeName = (entry: ZipEntry): string | undefined => {
  // Without the UTF-8 flag, non-ASCII bytes have ambiguous legacy encodings.
  const isUtf8 = hasZipFlag(entry.flags, ZIP_FLAG_UTF8);
  if (
    entry.name.length > MAX_ENTRY_NAME_BYTES ||
    (!isUtf8 && entry.name.some((byte) => byte > 0x7f)) ||
    !hasConsistentPathExtras(entry.extraFields.local, entry.name) ||
    !hasConsistentPathExtras(entry.extraFields.central, entry.name)
  ) {
    return undefined;
  }
  const text = entry.name.toString("utf-8");
  if (!Buffer.from(text).equals(entry.name)) {
    return undefined;
  }
  return text;
};

const indexPath = (
  paths: Map<string, ArchivePath>,
  name: string,
  isDirectory: boolean,
): boolean => {
  const path = isDirectory ? name.slice(0, -1) : name;
  if (/^[a-z]:|[\\\p{Cc}]/iu.test(path)) {
    return false;
  }
  const parts = path.split("/");
  if (parts.length > MAX_PATH_DEPTH) {
    return false;
  }
  let parent = "";
  const entryKind = isDirectory ? "directory" : "file";
  for (const [index, part] of parts.entries()) {
    if (part === "" || part === "." || part === "..") {
      return false;
    }
    const fullPath = parent === "" ? part : `${parent}/${part}`;
    const key = archivePathKey(fullPath);
    const previous = paths.get(key);
    const finalPart = index === parts.length - 1;
    if (
      previous !== undefined &&
      (previous.path !== fullPath ||
        previous.kind === "file" ||
        (finalPart && (!isDirectory || previous.kind === "directory")))
    ) {
      return false;
    }
    if (previous === undefined || finalPart) {
      paths.set(key, {
        path: fullPath,
        kind: finalPart ? entryKind : "implicit-directory",
      });
    }
    parent = fullPath;
  }
  return true;
};

/**
 * Whether an archive keeps to the bounds every archive reader holds it to:
 * its size, its entry count, its total uncompressed size and each entry's
 * compression ratio, all read from its index before anything is inflated.
 */
export const isWithinArchiveLimits = async (
  bytes: Uint8Array,
): Promise<boolean> =>
  bytes.length <= DOCUMENT_ARCHIVE_MAX_BYTES &&
  (await archiveGuard.scan(bytes)).length === 0;

export const openDocumentArchive = async (bytes: Uint8Array) => {
  if (!hasZipMagic(bytes)) {
    return invalid("The container is not a ZIP archive");
  }
  if (!(await isWithinArchiveLimits(bytes))) {
    return Result.err(
      new DocumentPackageError({
        message: "The container exceeds the supported ZIP limits",
        reason: "limit",
      }),
    );
  }
  const index = readZipIndex(bytes);
  if (index.type === "malformed") {
    return invalid("The container has a malformed ZIP index");
  }
  const files = new Map<string, ZipEntry>();
  const paths = new Map<string, ArchivePath>();
  for (const entry of index.entries) {
    const unixType = Math.floor(
      entry.externalAttributes / UNIX_FILE_TYPE_PLACE,
    );
    if (
      unreadableZipEntry(entry) !== null ||
      (entry.method === ZIP_METHOD_STORED &&
        entry.data.length !== entry.uncompressedSize) ||
      (unixType !== 0 &&
        unixType !== UNIX_DIRECTORY_TYPE &&
        unixType !== UNIX_REGULAR_FILE_TYPE)
    ) {
      return invalid("The container has an unsupported ZIP entry");
    }
    const fileName = decodeName(entry);
    const isDirectory = fileName?.endsWith("/") ?? false;
    if (
      fileName === undefined ||
      !indexPath(paths, fileName, isDirectory) ||
      (isDirectory && entry.uncompressedSize !== 0) ||
      (unixType === UNIX_DIRECTORY_TYPE && !isDirectory)
    ) {
      return invalid("The container has an invalid or ambiguous entry path");
    }
    files.set(fileName, entry);
  }
  return Result.ok(files);
};
export const readArchiveEntry = (entry: ZipEntry) => {
  const content = Result.try({
    try: () =>
      entry.method === ZIP_METHOD_STORED
        ? entry.data
        : inflateRawSync(entry.data, {
            maxOutputLength: Math.max(1, entry.uncompressedSize),
          }),
    catch: () =>
      new DocumentPackageError({
        message: "A ZIP entry could not be decompressed",
        reason: "invalid",
      }),
  });
  if (content.isErr()) {
    return content;
  }
  if (
    content.value.length !== entry.uncompressedSize ||
    Bun.hash.crc32(content.value) !== entry.crc32
  ) {
    return invalid("A ZIP entry failed its integrity check");
  }
  return content;
};
