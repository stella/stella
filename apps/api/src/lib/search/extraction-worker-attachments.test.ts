import { describe, expect, test } from "bun:test";

import {
  ATTACHMENT_EXTRACTION_OUTCOME,
  formatAttachmentIssue,
  parseAttachmentIssues,
} from "@/api/lib/search/extraction-worker-attachments";

describe("attachment issue lines", () => {
  test("carry an attachment MIME type with parameters or spaces as type/subtype", () => {
    const stderr = [
      formatAttachmentIssue({
        outcome: ATTACHMENT_EXTRACTION_OUTCOME.failed,
        mimeType: 'Application/PDF; name="signed contract.pdf"',
        errorType: "Error",
        errorCode: "malformed",
      }),
      formatAttachmentIssue({
        outcome: ATTACHMENT_EXTRACTION_OUTCOME.skipped,
        mimeType: " text / plain ",
        errorType: "Error",
        errorCode: null,
      }),
    ].join("");

    expect(parseAttachmentIssues(stderr)).toEqual([
      {
        outcome: ATTACHMENT_EXTRACTION_OUTCOME.failed,
        mimeType: "application/pdf",
        errorType: "Error",
        errorCode: "malformed",
      },
      {
        outcome: ATTACHMENT_EXTRACTION_OUTCOME.skipped,
        mimeType: "text/plain",
        errorType: "Error",
        errorCode: null,
      },
    ]);
  });
});
