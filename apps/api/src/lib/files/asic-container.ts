import { Result, TaggedError } from "better-result";
import { promisify } from "node:util";
import { inflateRaw } from "node:zlib";

import {
  type ASIC_E_FILE_FORMAT,
  ASIC_S_FILE_FORMAT,
} from "@stll/api-contract/legal-file-formats";
import { declareFingerprintFields } from "@stll/errors";

import { createZipBombGuard } from "@/api/lib/file-scan/scanner";
import {
  hasZipMagic,
  readZipIndex,
  type ZipEntry,
} from "@/api/lib/file-scan/zip";
import { archivePathKey } from "@/api/lib/files/archive-path-key";
import { ASIC_CONTAINER_MAX_BYTES } from "@/api/lib/files/asic-preview-protocol";

const MIMETYPE_ENTRY = "mimetype";
const METADATA_DIRECTORY = "META-INF";
const METADATA_KEY = archivePathKey(METADATA_DIRECTORY);
const MAX_ENTRY_NAME_BYTES = 1024;
const MAX_PATH_DEPTH = 32;
const MAX_MIMETYPE_BYTES = 64;
const ZIP_EXTRA_LANGUAGE_ENCODING = 0x00_08;
const ZIP_EXTRA_UNICODE_PATH = 0x70_75;
const ZIP_FLAG_UTF8 = 0x08_00;
const ZIP_METHOD_STORED = 0;
const ZIP_METHOD_DEFLATE = 8;
const ZIP_FLAG_ENCRYPTED = 0x00_01;
const ZIP_FLAG_STRONG_ENCRYPTION = 0x00_40;
// The high nibble of the ZIP external attributes holds the POSIX file type.
const UNIX_FILE_TYPE_PLACE = 0x10_00_00_00;
const UNIX_DIRECTORY_TYPE = 4;
const UNIX_REGULAR_FILE_TYPE = 8;

// Bound both the ZIP index walk and the total retained decompressed contents.
// These are independent of the upload scanner's inspection budgets.
const archiveGuard = createZipBombGuard({
  maxEntries: 1000,
  maxTotalUncompressedBytes: ASIC_CONTAINER_MAX_BYTES,
  maxCompressionRatio: 1000,
});
const inflate = promisify(inflateRaw);

export type AsicMimeType =
  typeof ASIC_E_FILE_FORMAT.mimeType | typeof ASIC_S_FILE_FORMAT.mimeType;

type AsicMember = { fileName: string; bytes: Uint8Array };
type NamedEntry = { fileName: string; entry: ZipEntry };

export class AsicParseError extends TaggedError("AsicParseError")<{
  message: string;
  reason: "invalid" | "limit";
}> {
  static {
    declareFingerprintFields(this, ["reason"]);
  }
}

const invalid = (message: string) =>
  Result.err(new AsicParseError({ message, reason: "invalid" }));

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
    return;
  }
  const text = entry.name.toString("utf-8");
  if (!Buffer.from(text).equals(entry.name)) {
    return;
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

const indexMembers = (entries: readonly ZipEntry[]) => {
  const paths = new Map<string, ArchivePath>();
  const payload: NamedEntry[] = [];
  const metadata = new Set<string>();
  let mimetype: ZipEntry | undefined;
  for (const entry of entries) {
    const unixType = Math.floor(
      entry.externalAttributes / UNIX_FILE_TYPE_PLACE,
    );
    if (
      hasZipFlag(entry.flags, ZIP_FLAG_ENCRYPTED) ||
      hasZipFlag(entry.flags, ZIP_FLAG_STRONG_ENCRYPTION) ||
      (entry.method !== ZIP_METHOD_STORED &&
        entry.method !== ZIP_METHOD_DEFLATE) ||
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
    const root = fileName.split("/", 1).at(0);
    if (root === undefined) {
      return invalid("The container has an invalid entry path");
    }
    const rootKey = archivePathKey(root);
    if (rootKey === MIMETYPE_ENTRY) {
      if (fileName !== MIMETYPE_ENTRY) {
        return invalid("The container has an ambiguous mimetype entry");
      }
      mimetype = entry;
    } else if (rootKey === METADATA_KEY) {
      if (!fileName.startsWith(`${METADATA_DIRECTORY}/`)) {
        return invalid("The container has an ambiguous metadata directory");
      }
      if (!isDirectory && entry.uncompressedSize > 0) {
        metadata.add(fileName.slice(METADATA_DIRECTORY.length + 1));
      }
    } else if (!isDirectory) {
      payload.push({ fileName, entry });
    }
  }
  return Result.ok({ payload, metadata, mimetype });
};

// ETSI EN 319 162-1 §§4.3.3.2, 4.4.3.2 and 4.4.4.2. Only use entry
// names for recognition. The signature and manifest bytes are never parsed.
const SIMPLE_EVIDENCE = new Set([
  "signatures.xml",
  "signature.p7s",
  "signatures.p7s", // Also used in the ETSI Annex B.1.1 example.
  "timestamp.tst",
  "evidencerecord.ers",
  "evidencerecord.xml",
]);
const EXTENDED_MANIFEST = /^ASiCManifest[^/]*\.xml$/u;
const EVIDENCE_RECORD_MANIFEST = /^ASiCEvidenceRecordManifest[^/]*\.xml$/u;

const hasExtendedEvidence = (metadata: ReadonlySet<string>): boolean => {
  const names = [...metadata];
  return (
    names.some((name) => /signatures?[^/]*\.xml$/u.test(name)) ||
    (names.some((name) => EXTENDED_MANIFEST.test(name)) &&
      names.some((name) =>
        /^[^/]*(?:signature[^/]*\.p7s|timestamp[^/]*\.tst)$/u.test(name),
      )) ||
    (names.some((name) => EVIDENCE_RECORD_MANIFEST.test(name)) &&
      names.some((name) =>
        /^[^/]*evidencerecord[^/]*\.(?:ers|xml)$/u.test(name),
      ))
  );
};

const hasExpectedProfile = ({
  payload,
  metadata,
  hasMimeType,
  expectedMimeType,
}: {
  payload: readonly NamedEntry[];
  metadata: ReadonlySet<string>;
  hasMimeType: boolean;
  expectedMimeType: AsicMimeType;
}): boolean => {
  const first = payload.at(0);
  const isSimple =
    payload.length === 1 &&
    first !== undefined &&
    !first.fileName.includes("/") &&
    [...metadata].filter((name) => SIMPLE_EVIDENCE.has(name)).length === 1 &&
    ![...metadata].some(
      (name) =>
        EXTENDED_MANIFEST.test(name) || EVIDENCE_RECORD_MANIFEST.test(name),
    );
  const isExtended = payload.length > 0 && hasExtendedEvidence(metadata);
  const expectsSimple = expectedMimeType === ASIC_S_FILE_FORMAT.mimeType;
  // One root document and signatures.xml alone may describe either profile.
  if (!hasMimeType && isSimple && isExtended) {
    return false;
  }
  return expectsSimple ? isSimple : isExtended;
};

const readEntryBytes = async (entry: ZipEntry) => {
  const content = await Result.tryPromise({
    try: async () =>
      entry.method === ZIP_METHOD_STORED
        ? entry.data
        : await inflate(entry.data, {
            maxOutputLength: Math.max(1, entry.uncompressedSize),
          }),
    catch: () =>
      new AsicParseError({
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

export const readAsicContainer = async (
  bytes: Uint8Array,
  expectedMimeType: AsicMimeType,
): Promise<Result<{ members: AsicMember[] }, AsicParseError>> => {
  if (!hasZipMagic(bytes)) {
    return invalid("The container is not a ZIP archive");
  }
  if (
    bytes.length > ASIC_CONTAINER_MAX_BYTES ||
    (await archiveGuard.scan(bytes)).length !== 0
  ) {
    return Result.err(
      new AsicParseError({
        message: "The container exceeds the supported ZIP limits",
        reason: "limit",
      }),
    );
  }
  const index = readZipIndex(bytes);
  if (index.type === "malformed") {
    return invalid("The container has a malformed ZIP index");
  }
  const inventory = indexMembers(index.entries);
  if (inventory.isErr()) {
    return Result.err(inventory.error);
  }
  const { payload, metadata, mimetype } = inventory.value;
  if (mimetype !== undefined) {
    if (mimetype.uncompressedSize > MAX_MIMETYPE_BYTES) {
      return invalid("The container has an invalid mimetype entry");
    }
    // Some legacy producer output compresses mimetype. Treat it as a bounded
    // label, independently of the optional ZIP magic-number placement.
    const marker = await readEntryBytes(mimetype);
    if (marker.isErr()) {
      return Result.err(marker.error);
    }
    if (new TextDecoder().decode(marker.value) !== expectedMimeType) {
      return invalid("The container does not match the expected ASiC format");
    }
  }
  if (
    !hasExpectedProfile({
      payload,
      metadata,
      hasMimeType: mimetype !== undefined,
      expectedMimeType,
    })
  ) {
    return invalid("The container does not match the expected ASiC format");
  }
  const members: AsicMember[] = [];
  for (const { entry, fileName } of payload) {
    const member = await readEntryBytes(entry);
    if (member.isErr()) {
      return Result.err(member.error);
    }
    members.push({ fileName, bytes: member.value });
  }
  return Result.ok({ members });
};
