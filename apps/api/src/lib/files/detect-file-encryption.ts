/**
 * The one place that decides a stored file's `encrypted` attribute.
 *
 * `encrypted` is derived from the bytes: it gates the PDF and thumbnail
 * derivatives, extraction, signing, the chat model source, and what the
 * clients offer for the file. A writer that types the value in by hand records
 * a guess, and a guess made once for the common case is wrong for every file
 * that is not that case.
 *
 * Every file content writer therefore takes a `FileEncryption`, never a
 * boolean, and only this module can make one:
 *
 * - `detectFileEncryption`: bytes a caller received (an upload, a new version,
 *   an email attachment, a provider's output). PDFs go through the PDF worker;
 *   zip-based Office types (DOCX, XLSX, PPTX and their variants) are read for
 *   the password-protection container (`encrypted-ooxml.ts`); other types are
 *   not inspected and are recorded as unencrypted.
 * - `officeFileEncryption`: Office bytes an editor produced (desktop editing,
 *   collaboration publishes). Both paths only accept a readable OOXML zip
 *   (desktop edit validates the archive, folio writes it), and a zip is never
 *   the encrypted form, so these are unencrypted.
 * - `serverBuiltFileEncryption`: bytes this server built itself (filled
 *   templates, conversions, redlines, signatures). It never writes an
 *   encrypted file, and its PDF inputs are refused when encrypted.
 * - `storedFileEncryption`: a copy of an object whose stored record already
 *   carries the attribute.
 *
 * The `no-literal-derived-attribute` lint rule rejects a literal written to
 * `encrypted` anywhere else in the API (registry: scripts/derived-attributes.ts),
 * and `file-encryption-writers.test.ts` checks that every writer's input
 * requires a `FileEncryption`.
 *
 * Unsure: a PDF inspection that does not finish (the extraction timeout, a
 * killed worker) is not evidence that the file is broken, so it is not refused
 * as corrupted. The file is recorded as unencrypted: the attribute is not an
 * access control, and the consumers that open the bytes (text extraction,
 * signing) meet an encrypted PDF as their own typed failure. The upload paths
 * report the unsure outcome so a pattern of them is visible.
 *
 * Office files: a password-protected DOCX/XLSX/PPTX is recorded encrypted and
 * from then on takes every path an encrypted PDF takes (the consumers read the
 * attribute, not the type). The Office reading differs from the PDF one in
 * what a broken file means. A CFB container the reader finds malformed is
 * recorded unencrypted, not refused: Office encryption is recognised only by
 * its two streams, a container without them readable is not that, and the
 * consumers that open the bytes fail on a broken Office file on their own.
 * Only a container the reader stopped reading at one of its limits (directory
 * size, chain length, nesting) is `unsure`.
 *
 * Legacy binary .doc/.xls/.ppt files are CFB containers too, but they keep
 * their encryption flags inside the document streams (FIB, BIFF FILEPASS,
 * PowerPoint CryptSession); they are not inspected and are recorded as
 * unencrypted. ODF encryption (per entry, inside the zip) is not inspected
 * either.
 */
import { ENCRYPTED_CONTENT_ERROR_CODE } from "@stll/api-contract";

import { captureError } from "@/api/lib/analytics/capture";
import type { DesktopEditMimeType } from "@/api/lib/desktop-edit-file-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { SubprocessError } from "@/api/lib/errors/tagged-errors";
import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";
import {
  OOXML_MIME_TYPES,
  probeEncryptedOoxml,
} from "@/api/lib/files/encrypted-ooxml";
import { isEncryptedPdf } from "@/api/lib/files/pdf-utils";
import type { PdfEncryptionProbe } from "@/api/lib/files/pdf-utils";
import { PDF_MIME_TYPE } from "@/api/mime-types";

/**
 * What every consumer answers for an encrypted file's content, PDF or Office:
 * the API, MCP and chat refusals share it.
 */
export const ENCRYPTED_CONTENT_MESSAGE =
  "Encrypted document content cannot be extracted.";

/** The 422 a REST handler answers when it needs an encrypted file's content. */
export const encryptedContentError = (): HandlerError<422> =>
  new HandlerError({
    status: 422,
    code: ENCRYPTED_CONTENT_ERROR_CODE,
    message: ENCRYPTED_CONTENT_MESSAGE,
  });

/** How the attribute was established; kept for callers and tests, not stored. */
type FileEncryptionBasis =
  | "inspected"
  | "type-not-inspected"
  | "unsure"
  | "unreadable"
  | "office-editor"
  | "server-built"
  | "stored";

let mint: (encrypted: boolean, basis: FileEncryptionBasis) => FileEncryption;

/** A detector-made value of the file `encrypted` attribute. */
export class FileEncryption {
  // An ES private field makes the type nominal: an object literal or a spread
  // copy cannot stand in for a value this module produced.
  readonly #encrypted: boolean;
  readonly basis: FileEncryptionBasis;

  private constructor(encrypted: boolean, basis: FileEncryptionBasis) {
    this.#encrypted = encrypted;
    this.basis = basis;
  }

  static {
    mint = (encrypted, basis) => new FileEncryption(encrypted, basis);
  }

  /** The value a file content row records. */
  get encrypted(): boolean {
    return this.#encrypted;
  }
}

type FileEncryptionDetection =
  | { status: "known"; encryption: FileEncryption }
  /** The inspection did not finish; the file is recorded as unencrypted. */
  | {
      status: "unsure";
      encryption: FileEncryption;
      cause: Error | string;
    }
  /**
   * The PDF parser refused the bytes. Upload paths refuse the file; a path
   * that keeps unreadable files (inbound email) records it as unencrypted.
   */
  | {
      status: "unreadable";
      encryption: FileEncryption;
      cause: SubprocessError;
    };

type DetectFileEncryptionInput = {
  /** The type the file is stored under, which decides whether it is inspected. */
  mimeType: string;
  scanned: ScannedFile;
  /** Test seam for the PDF worker. */
  probe?: ((file: ScannedFile) => Promise<PdfEncryptionProbe>) | undefined;
};

export const detectFileEncryption = async ({
  mimeType,
  scanned,
  probe = isEncryptedPdf,
}: DetectFileEncryptionInput): Promise<FileEncryptionDetection> => {
  if (OOXML_MIME_TYPES.has(mimeType)) {
    return detectOoxmlEncryption(scanned);
  }
  if (mimeType !== PDF_MIME_TYPE) {
    return { status: "known", encryption: mint(false, "type-not-inspected") };
  }
  const result = await probe(scanned);
  if (result.status === "inspected") {
    return {
      status: "known",
      encryption: mint(result.encrypted, "inspected"),
    };
  }
  if (result.status === "unsure") {
    return {
      status: "unsure",
      encryption: mint(false, "unsure"),
      cause: result.cause,
    };
  }
  return {
    status: "unreadable",
    encryption: mint(false, "unreadable"),
    cause: result.cause,
  };
};

const detectOoxmlEncryption = (
  scanned: ScannedFile,
): FileEncryptionDetection => {
  const result = probeEncryptedOoxml(new Uint8Array(scanned.bytes));
  if (result.status === "unsure") {
    return {
      status: "unsure",
      encryption: mint(false, "unsure"),
      cause: result.cause,
    };
  }
  return {
    status: "known",
    encryption: mint(result.status === "encrypted", "inspected"),
  };
};

/** Reports a detection that did not inspect the file; a known one is silent. */
const reportDetection = (
  detection: FileEncryptionDetection,
  context: Record<string, string>,
): void => {
  if (detection.status === "unsure") {
    captureError(detection.cause, {
      ...context,
      stage: "file-encryption-unsure",
    });
  }
  if (detection.status === "unreadable") {
    captureError(detection.cause, context);
  }
};

/**
 * The upload paths' reading of a detection: an unreadable PDF is refused as
 * corrupted (`null`), an unsure one is reported and the file is kept.
 */
export const uploadFileEncryption = (
  detection: FileEncryptionDetection,
  context: Record<string, string>,
): FileEncryption | null => {
  reportDetection(detection, context);
  return detection.status === "unreadable" ? null : detection.encryption;
};

/**
 * The reading of a path that keeps every file (inbound email filing): the
 * detection is reported as an upload's would be, and the file is recorded
 * with the detector's value even when the inspection failed.
 */
export const retainedFileEncryption = (
  detection: FileEncryptionDetection,
  context: Record<string, string>,
): FileEncryption => {
  reportDetection(detection, context);
  return detection.encryption;
};

/** Office bytes an editor produced: a readable OOXML zip, never encrypted. */
export const officeFileEncryption = (
  _mimeType: DesktopEditMimeType,
): FileEncryption => mint(false, "office-editor");

/** Bytes this server built; it never writes an encrypted file. */
export const serverBuiltFileEncryption = (): FileEncryption =>
  mint(false, "server-built");

/** The attribute of an object whose stored record already carries it. */
export const storedFileEncryption = (content: {
  readonly encrypted: boolean;
}): FileEncryption => mint(content.encrypted, "stored");
