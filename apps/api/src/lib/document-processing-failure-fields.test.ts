import { describe, expect, test } from "bun:test";

import { documentProcessingFailureFields } from "@/api/lib/document-processing-failure-fields";
import {
  EXTRACTION_WORKER_ERROR_CODE,
  type ExtractionWorkerErrorCode,
  type ExtractionWorkerTermination,
  ExtractionWorkerError,
  extractionWorkerErrorCode,
  SUBPROCESS_TERMINATION_REASON,
  type SubprocessTerminationReason,
} from "@/api/lib/errors/tagged-errors";

/**
 * The class these pin: every extraction failure shares one error class, so a
 * sink that logs only the class collapses five distinct outcomes into one
 * unactionable line. The discriminator has to survive into the fields, for
 * every code, without carrying the message or any document bytes with it.
 */

const MESSAGE = "sandbox rejected 04-2019 rozsudek.pdf";

const terminationFor = (
  reason: SubprocessTerminationReason,
): ExtractionWorkerTermination => ({ reason, signalCode: "SIGKILL" });

const errorFor = (termination: ExtractionWorkerTermination | null) =>
  new ExtractionWorkerError({
    code: extractionWorkerErrorCode(termination),
    exitCode: termination === null ? 1 : null,
    message: MESSAGE,
    mimeType: "application/pdf",
    sizeBytes: 12_345,
    termination,
  });

/**
 * `null` is the parser branch: it is the one code with no termination, so it
 * cannot be derived from the reason list and has to be named here.
 */
const TERMINATIONS = [
  null,
  ...Object.values(SUBPROCESS_TERMINATION_REASON).map(terminationFor),
];

describe("documentProcessingFailureFields", () => {
  test("discriminates every extraction failure code", () => {
    const exercised = new Set<ExtractionWorkerErrorCode>();
    for (const termination of TERMINATIONS) {
      const code = extractionWorkerErrorCode(termination);
      expect(
        documentProcessingFailureFields(errorFor(termination)),
      ).toMatchObject({
        "error.code": code,
        "error.type": "ExtractionWorkerError",
        mimeType: "application/pdf",
        sizeBytes: "12345",
      });
      exercised.add(code);
    }
    // Both directions: a new code without a case here, or a case for a code
    // the union dropped, fails rather than silently going unexercised.
    expect([...exercised].toSorted()).toEqual(
      Object.values(EXTRACTION_WORKER_ERROR_CODE).toSorted(),
    );
  });

  test("carries the termination shape a code alone does not give", () => {
    expect(
      documentProcessingFailureFields(
        errorFor(terminationFor(SUBPROCESS_TERMINATION_REASON.timeout)),
      ),
    ).toMatchObject({
      signalCode: "SIGKILL",
      terminationReason: SUBPROCESS_TERMINATION_REASON.timeout,
    });
    expect(documentProcessingFailureFields(errorFor(null))).toMatchObject({
      exitCode: "1",
    });
  });

  test("never carries the message", () => {
    for (const termination of TERMINATIONS) {
      const values = Object.values(
        documentProcessingFailureFields(errorFor(termination)),
      );
      expect(values.some((value) => value.includes(MESSAGE))).toBe(false);
    }
  });

  test("still names an error that is not an extraction failure", () => {
    expect(documentProcessingFailureFields(new Error("boom"))).toMatchObject({
      "error.type": "Error",
    });
  });
});
