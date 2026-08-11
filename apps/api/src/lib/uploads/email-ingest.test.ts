import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  detectEmailContainer,
  resolveStoredEmailFileName,
  validateEmailAttachmentCount,
  validateEmailAttachmentMimeType,
  validateEmailIngestContainer,
} from "@/api/lib/uploads/email-ingest-policy";

describe("validateEmailAttachmentCount", () => {
  test("accepts the bounded maximum", () => {
    expect(Result.isOk(validateEmailAttachmentCount(50))).toBe(true);
  });

  test("rejects instead of truncating excess attachments", () => {
    const result = validateEmailAttachmentCount(51);

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.status).toBe(422);
      expect(result.error.rejectReason).toBe("too-many-attachments");
    }
  });
});

describe("email attachment policy", () => {
  test("rejects nested email containers", () => {
    for (const mimeType of ["message/rfc822", "application/vnd.ms-outlook"]) {
      const result = validateEmailAttachmentMimeType(
        new Uint8Array(),
        mimeType,
      );
      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        expect(result.error.rejectReason).toBe("nested-email-attachment");
      }
    }
  });

  test("detects nested EML content despite generic metadata", () => {
    const bytes = new TextEncoder().encode(
      "From: sender@example.com\r\nSubject: nested\r\n\r\nbody",
    );

    expect(detectEmailContainer(bytes)).toBe("eml");
    expect(
      Result.isError(
        validateEmailAttachmentMimeType(bytes, "application/octet-stream"),
      ),
    ).toBe(true);
    expect(
      Result.isOk(validateEmailIngestContainer(bytes, "message/rfc822")),
    ).toBe(true);
  });

  test("rejects an email container that differs from its declared MIME", () => {
    const bytes = new TextEncoder().encode(
      "From: sender@example.com\r\nSubject: mismatch\r\n\r\nbody",
    );
    const result = validateEmailIngestContainer(
      bytes,
      "application/vnd.ms-outlook",
    );

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.rejectReason).toBe("email-container-mismatch");
    }
  });

  test("preserves the source email extension in stored file metadata", () => {
    expect(
      String(resolveStoredEmailFileName("SPA review", "message/rfc822")),
    ).toBe("SPA review.eml");
    expect(
      String(
        resolveStoredEmailFileName(
          "Matter update.msg",
          "application/vnd.ms-outlook",
        ),
      ),
    ).toBe("Matter update.msg");
  });
});
