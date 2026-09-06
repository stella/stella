import * as slimdom from "slimdom";

import { DocxArchiveError, loadDocxArchive } from "@/api/lib/docx-archive";

/**
 * Which structural check failed. Callers branch on this instead of matching the
 * message: `unreadable-archive` is the only failure a caller can attribute to
 * the bytes never having arrived intact, which is the advice a base64 payload
 * needs and a stored file does not. An archive that parses but breaks a
 * bounded-decompression limit is `archive-limit-exceeded`, because re-sending
 * the same bytes cannot fix it.
 */
export type DocxValidationFailure =
  | "unreadable-archive"
  | "archive-limit-exceeded"
  | "missing-document-xml"
  | "malformed-document-xml";

/**
 * Total over the archive loader's reasons, so a new one has to decide whether
 * it means the bytes never arrived intact or the archive itself is out of
 * bounds. A throw that is not a `DocxArchiveError` is a parse failure.
 */
const FAILURE_BY_ARCHIVE_REASON = {
  "load-failed": "unreadable-archive",
  "too-many-entries": "archive-limit-exceeded",
  "entry-too-large": "archive-limit-exceeded",
  "total-too-large": "archive-limit-exceeded",
} as const satisfies Record<
  DocxArchiveError["reason"],
  Extract<
    DocxValidationFailure,
    "unreadable-archive" | "archive-limit-exceeded"
  >
>;

export type ValidateDocxBufferResult =
  | { valid: true }
  | { valid: false; reason: DocxValidationFailure; error: string };

/**
 * Validate that a buffer is a structurally valid DOCX file.
 * Checks that the ZIP archive can be parsed within the bounded-decompression
 * envelope, that it contains the required `word/document.xml` entry, and
 * that document XML is well-formed.
 *
 * `error` is a bare reason with no "Invalid DOCX" prefix: every caller embeds
 * it in its own sentence.
 */
export const validateDocxBuffer = async (
  buffer: ArrayBuffer,
): Promise<ValidateDocxBufferResult> => {
  try {
    const archive = await loadDocxArchive(buffer);
    const xml = await archive.readEntryString("word/document.xml");
    if (xml === null) {
      return {
        valid: false,
        reason: "missing-document-xml",
        error: "Missing word/document.xml",
      };
    }

    let document: slimdom.Document;
    try {
      document = slimdom.parseXmlDocument(xml);
    } catch (error) {
      return {
        valid: false,
        reason: "malformed-document-xml",
        error: `Malformed document.xml: ${error instanceof Error ? error.message : "unknown error"}`,
      };
    }

    const root = document.documentElement;
    if (!root || root.localName !== "document") {
      return {
        valid: false,
        reason: "malformed-document-xml",
        error: "Malformed document.xml: missing root element",
      };
    }

    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      reason:
        error instanceof DocxArchiveError
          ? FAILURE_BY_ARCHIVE_REASON[error.reason]
          : "unreadable-archive",
      error: error instanceof Error ? error.message : "unknown error",
    };
  }
};
