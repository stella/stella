import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  resolveStoredEmailFileName,
  validateEmailAttachmentCount,
  validateEmailAttachmentMimeType,
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
      const result = validateEmailAttachmentMimeType(mimeType);
      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        expect(result.error.rejectReason).toBe("nested-email-attachment");
      }
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
