import { describe, expect, test } from "bun:test";

import { MAX_EMAIL_TEXT_ATTACHMENT_PREVIEW_BYTES } from "@stll/api-contract";

import {
  EMAIL_ATTACHMENT_RESPONSE_DISPOSITION,
  getEmailAttachmentResponseBytes,
} from "./email-attachment-preview";

describe("email attachment response bounds", () => {
  const oversized = new Uint8Array(MAX_EMAIL_TEXT_ATTACHMENT_PREVIEW_BYTES + 1);

  test("bounds inline plain-text previews", () => {
    expect(
      getEmailAttachmentResponseBytes({
        bytes: oversized,
        disposition: EMAIL_ATTACHMENT_RESPONSE_DISPOSITION.inline,
        mimeType: "text/plain; charset=utf-8",
      }).byteLength,
    ).toBe(MAX_EMAIL_TEXT_ATTACHMENT_PREVIEW_BYTES);
  });

  test("preserves downloads and non-text previews", () => {
    for (const [disposition, mimeType] of [
      [EMAIL_ATTACHMENT_RESPONSE_DISPOSITION.download, "text/plain"],
      [EMAIL_ATTACHMENT_RESPONSE_DISPOSITION.inline, "application/pdf"],
    ] as const) {
      expect(
        getEmailAttachmentResponseBytes({
          bytes: oversized,
          disposition,
          mimeType,
        }),
      ).toBe(oversized);
    }
  });
});
