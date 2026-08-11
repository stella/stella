import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { validateEmailAttachmentCount } from "@/api/lib/uploads/email-ingest-policy";

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
