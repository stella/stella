import { Result } from "better-result";

/**
 * Recognizes a password-protected OOXML document (DOCX, XLSX, PPTX and their
 * macro, template, slideshow and binary-workbook variants).
 *
 * Office does not encrypt inside the zip. It encrypts the whole package and
 * wraps it in a Compound File Binary container (MS-OFFCRYPTO): the root
 * storage holds an `EncryptionInfo` stream (the key data) and an
 * `EncryptedPackage` stream (the encrypted zip). Both stream names in the root
 * storage are the signature; nothing else in an OOXML file looks like that.
 *
 * Read through `detectFileEncryption` (what a file row records) and the upload
 * scan, which accepts such a container under its declared Office type and
 * skips its compound-file warning only when the whole directory is exactly
 * the encrypted layout (`isExactEncryptedOoxmlLayout`).
 */
import { OFFICE_ARCHIVE_FORMATS } from "@stll/docx-utils/office-formats";

import {
  CompoundFile,
  hasCompoundFileSignature,
} from "@/api/lib/files/compound-file";
import type { CompoundFileParseError } from "@/api/lib/files/compound-file";

/** The zip-based Office types an encrypted container can be declared as. */
export const OOXML_MIME_TYPES: ReadonlySet<string> = new Set(
  Object.values(OFFICE_ARCHIVE_FORMATS)
    .filter((format) => format.family !== "odf")
    .map((format) => format.mimeType),
);

const ENCRYPTION_INFO_STREAM = "ENCRYPTIONINFO";
const ENCRYPTED_PACKAGE_STREAM = "ENCRYPTEDPACKAGE";

/**
 * - `encrypted`: a CFB container whose root holds both encryption streams.
 * - `not-encrypted`: anything else, including bytes that are not a CFB
 *   container and a container the reader found malformed.
 * - `unsure`: the reader stopped at one of its limits, so the container was
 *   not read to the end.
 */
export type EncryptedOoxmlProbe =
  | { status: "encrypted" }
  | { status: "not-encrypted" }
  | { status: "unsure"; cause: CompoundFileParseError };

const NOT_ENCRYPTED = { status: "not-encrypted" } as const;

export const probeEncryptedOoxml = (bytes: Uint8Array): EncryptedOoxmlProbe => {
  if (!hasCompoundFileSignature(bytes)) {
    return NOT_ENCRYPTED;
  }
  const parsed = CompoundFile.parse(bytes);
  if (Result.isError(parsed)) {
    return parsed.error.limitReached
      ? { status: "unsure", cause: parsed.error }
      : NOT_ENCRYPTED;
  }
  // CFB names compare case-insensitively.
  const rootStreams = new Set(
    parsed.value.streamEntries
      .filter((stream) => stream.path.length === 1)
      .map((stream) => stream.entry.name.toUpperCase()),
  );
  return rootStreams.has(ENCRYPTION_INFO_STREAM) &&
    rootStreams.has(ENCRYPTED_PACKAGE_STREAM)
    ? { status: "encrypted" }
    : NOT_ENCRYPTED;
};

/**
 * The complete directory of a password-protected OOXML package as Office
 * writes it (MS-OFFCRYPTO 2.3.4.x, the "StrongEncryptionDataSpace" data
 * space): the two encryption streams and the `\u0006DataSpaces` storage with
 * its fixed children. Keys are `[kind, ...path]`, so a name containing `/`
 * cannot pass for a nested entry.
 */
const ENCRYPTED_OOXML_LAYOUT: ReadonlySet<string> = new Set(
  (
    [
      ["stream", "EncryptionInfo"],
      ["stream", "EncryptedPackage"],
      ["storage", "\u0006DataSpaces"],
      ["stream", "\u0006DataSpaces", "Version"],
      ["stream", "\u0006DataSpaces", "DataSpaceMap"],
      ["storage", "\u0006DataSpaces", "DataSpaceInfo"],
      [
        "stream",
        "\u0006DataSpaces",
        "DataSpaceInfo",
        "StrongEncryptionDataSpace",
      ],
      ["storage", "\u0006DataSpaces", "TransformInfo"],
      [
        "storage",
        "\u0006DataSpaces",
        "TransformInfo",
        "StrongEncryptionTransform",
      ],
      [
        "stream",
        "\u0006DataSpaces",
        "TransformInfo",
        "StrongEncryptionTransform",
        "\u0006Primary",
      ],
    ] as const
  ).map((key) => JSON.stringify(key)),
);

/**
 * Whether the bytes, declared as an OOXML type, are a compound file whose
 * whole directory is exactly `ENCRYPTED_OOXML_LAYOUT`: every entry reachable
 * from the root, with its kind and nesting, and no allocated entry outside
 * the tree. Anything else (an extra or missing entry, a macro storage, a
 * malformed container, a reader limit) is not that layout.
 */
export const isExactEncryptedOoxmlLayout = (
  declaredMimeType: string,
  bytes: Uint8Array,
): boolean => {
  if (
    !OOXML_MIME_TYPES.has(declaredMimeType) ||
    !hasCompoundFileSignature(bytes)
  ) {
    return false;
  }
  const parsed = CompoundFile.parse(bytes);
  if (Result.isError(parsed) || parsed.value.unreachableEntryCount !== 0) {
    return false;
  }
  const keys = parsed.value.tree.map(({ kind, path }) =>
    JSON.stringify([kind, ...path]),
  );
  return (
    keys.length === ENCRYPTED_OOXML_LAYOUT.size &&
    new Set(keys).size === keys.length &&
    keys.every((key) => ENCRYPTED_OOXML_LAYOUT.has(key))
  );
};

/** The upload scan's question: a declared Office type in its encrypted form. */
export const isEncryptedOoxmlContainer = (
  declaredMimeType: string,
  bytes: Uint8Array,
): boolean =>
  OOXML_MIME_TYPES.has(declaredMimeType) &&
  probeEncryptedOoxml(bytes).status === "encrypted";
