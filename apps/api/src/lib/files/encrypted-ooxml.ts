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
 * scan (which accepts such a container under its declared Office type).
 */
import { OFFICE_ARCHIVE_FORMATS } from "@stll/docx-utils/office-formats";

import {
  CompoundFile,
  CompoundFileParseError,
  hasCompoundFileSignature,
} from "@/api/lib/files/compound-file";

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
 * - `unsure`: the reader stopped at one of its limits (or failed in a way it
 *   does not describe), so the container was not read to the end.
 */
export type EncryptedOoxmlProbe =
  | { status: "encrypted" }
  | { status: "not-encrypted" }
  | { status: "unsure"; cause: Error };

const NOT_ENCRYPTED = { status: "not-encrypted" } as const;

export const probeEncryptedOoxml = (bytes: Uint8Array): EncryptedOoxmlProbe => {
  if (!hasCompoundFileSignature(bytes)) {
    return NOT_ENCRYPTED;
  }
  const parsed = Result.try({
    try: () => new CompoundFile(bytes),
    catch: (cause) => cause,
  });
  if (Result.isError(parsed)) {
    const cause = parsed.error;
    if (cause instanceof CompoundFileParseError && !cause.limitReached) {
      return NOT_ENCRYPTED;
    }
    return {
      status: "unsure",
      cause: cause instanceof Error ? cause : new Error(String(cause)),
    };
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

/** The upload scan's question: a declared Office type in its encrypted form. */
export const isEncryptedOoxmlContainer = (
  declaredMimeType: string,
  bytes: Uint8Array,
): boolean =>
  OOXML_MIME_TYPES.has(declaredMimeType) &&
  probeEncryptedOoxml(bytes).status === "encrypted";
