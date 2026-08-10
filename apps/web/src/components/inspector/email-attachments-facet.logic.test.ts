import { describe, expect, test } from "bun:test";

import {
  EMAIL_ATTACHMENT_PREVIEW_KIND,
  getEmailAttachmentPreviewId,
  getEmailAttachmentPreviewKind,
} from "@/components/inspector/email-attachments-facet.logic";

describe("email attachment preview kind", () => {
  test("scopes the PDF cache identity to its source email", () => {
    expect(
      getEmailAttachmentPreviewId({
        attachmentId: "attachment-2",
        fieldId: "field-1",
        workspaceId: "workspace-1",
      }),
    ).toBe("email-attachment:workspace-1:field-1:attachment-2");
  });

  test("routes PDFs through the PDF viewer", () => {
    expect(getEmailAttachmentPreviewKind("application/pdf")).toBe(
      EMAIL_ATTACHMENT_PREVIEW_KIND.pdf,
    );
    expect(
      getEmailAttachmentPreviewKind("APPLICATION/PDF; charset=binary"),
    ).toBe(EMAIL_ATTACHMENT_PREVIEW_KIND.pdf);
  });

  test("routes plain text through the passive text viewer", () => {
    expect(getEmailAttachmentPreviewKind("text/plain")).toBe(
      EMAIL_ATTACHMENT_PREVIEW_KIND.text,
    );
    expect(getEmailAttachmentPreviewKind("TEXT/PLAIN; charset=utf-8")).toBe(
      EMAIL_ATTACHMENT_PREVIEW_KIND.text,
    );
    expect(getEmailAttachmentPreviewKind("text/html")).toBe(
      EMAIL_ATTACHMENT_PREVIEW_KIND.unsupported,
    );
  });

  test("allows only passive raster images in the image preview", () => {
    for (const mimeType of [
      "image/png",
      "image/jpeg",
      "image/jpg",
      "image/gif",
      "image/webp",
    ]) {
      expect(getEmailAttachmentPreviewKind(mimeType)).toBe(
        EMAIL_ATTACHMENT_PREVIEW_KIND.image,
      );
    }

    for (const mimeType of [
      null,
      "image/svg+xml",
      "text/html",
      "application/octet-stream",
    ]) {
      expect(getEmailAttachmentPreviewKind(mimeType)).toBe(
        EMAIL_ATTACHMENT_PREVIEW_KIND.unsupported,
      );
    }
  });
});
