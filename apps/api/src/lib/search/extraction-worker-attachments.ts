/**
 * How the extraction worker tells its parent about email attachments whose
 * text did not make it into the output. The worker's stdout carries only the
 * extracted text, so each such attachment is written to stderr as one line
 * the parent reads back after a successful exit.
 */

import { normalizeMimeType } from "@/api/lib/search/extractable-mime-types";

export const ATTACHMENT_EXTRACTION_OUTCOME = {
  /** The attachment is in a form the parsers do not read (encrypted, scanned, unknown format). */
  skipped: "skipped",
  /** A parser failed on an attachment it should have read. */
  failed: "failed",
} as const;

type AttachmentExtractionOutcome =
  (typeof ATTACHMENT_EXTRACTION_OUTCOME)[keyof typeof ATTACHMENT_EXTRACTION_OUTCOME];

export type AttachmentExtractionIssue = {
  outcome: AttachmentExtractionOutcome;
  mimeType: string;
  errorType: string;
  /** The converter's error code, when it reported one. */
  errorCode: string | null;
};

const LINE_PREFIX = "extraction-worker attachment";
const NO_CODE = "-";

/**
 * Converter codes for input the parsers deliberately do not read, as opposed
 * to a parser failing on input it does.
 */
const EXPECTED_ERROR_CODES = new Set(["encrypted", "needsOcr", "unsupported"]);

const errorCodeOf = (error: unknown): string | null =>
  error instanceof Error &&
  "code" in error &&
  typeof error.code === "string" &&
  /^[A-Za-z]+$/u.test(error.code)
    ? error.code
    : null;

export const classifyAttachmentError = (
  error: unknown,
  mimeType: string,
): AttachmentExtractionIssue => {
  const errorCode = errorCodeOf(error);
  return {
    outcome:
      errorCode !== null && EXPECTED_ERROR_CODES.has(errorCode)
        ? ATTACHMENT_EXTRACTION_OUTCOME.skipped
        : ATTACHMENT_EXTRACTION_OUTCOME.failed,
    mimeType,
    errorType: error instanceof Error ? error.constructor.name : "UnknownError",
    errorCode,
  };
};

/**
 * The MIME type as one space-free `type/subtype` token: the value comes from
 * the email, and the line separates its fields with spaces.
 */
const lineMimeType = (mimeType: string): string =>
  normalizeMimeType(mimeType).replaceAll(/\s+/gu, "") || NO_CODE;

export const formatAttachmentIssue = ({
  outcome,
  mimeType,
  errorType,
  errorCode,
}: AttachmentExtractionIssue): string =>
  `${[LINE_PREFIX, outcome, lineMimeType(mimeType), errorType, errorCode ?? NO_CODE].join(" ")}\n`;

const isOutcome = (value: string): value is AttachmentExtractionOutcome =>
  value === ATTACHMENT_EXTRACTION_OUTCOME.skipped ||
  value === ATTACHMENT_EXTRACTION_OUTCOME.failed;

/** Read the attachment lines back out of a worker's stderr; other lines are ignored. */
export const parseAttachmentIssues = (
  stderr: string,
): AttachmentExtractionIssue[] =>
  stderr.split("\n").flatMap((line) => {
    if (!line.startsWith(`${LINE_PREFIX} `)) {
      return [];
    }
    const [outcome, mimeType, errorType, errorCode] = line
      .slice(LINE_PREFIX.length + 1)
      .split(" ");
    if (
      outcome === undefined ||
      !isOutcome(outcome) ||
      mimeType === undefined ||
      errorType === undefined ||
      errorCode === undefined
    ) {
      return [];
    }
    return [
      {
        outcome,
        mimeType,
        errorType,
        errorCode: errorCode === NO_CODE ? null : errorCode,
      },
    ];
  });
