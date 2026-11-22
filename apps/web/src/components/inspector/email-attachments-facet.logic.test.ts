import { describe, expect, test } from "bun:test";

import {
  decodeEmailTextAttachment,
  EMAIL_ATTACHMENT_PREVIEW_KIND,
  getEmailAttachmentActivationId,
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

  test("decodes declared and byte-order-marked text encodings", () => {
    expect(
      decodeEmailTextAttachment({
        buffer: Uint8Array.from([0x47, 0x72, 0xfc, 0xdf, 0x65]).buffer,
        charset: "windows-1252",
      }),
    ).toBe("Grüße");
    expect(
      decodeEmailTextAttachment({
        buffer: Uint8Array.from([0xfe, 0xff, 0x00, 0x41]).buffer,
        charset: null,
      }),
    ).toBe("A");
  });

  test("reads an attachment that declares no charset in the one it was saved in", () => {
    // "Výpis z účtu" saved in windows-1250, as a Czech bank exports it.
    expect(
      decodeEmailTextAttachment({
        buffer: Uint8Array.from([
          0x56, 0xfd, 0x70, 0x69, 0x73, 0x20, 0x7a, 0x20, 0xfa, 0xe8, 0x74,
          0x75,
        ]).buffer,
        charset: null,
      }),
    ).toBe("Výpis z účtu");
  });

  test("preserves generic UTF-16 byte order", () => {
    expect(
      decodeEmailTextAttachment({
        buffer: Uint8Array.from([0xfe, 0xff, 0x01, 0x7d]).buffer,
        charset: "utf-16",
      }),
    ).toBe("Ž");
  });

  test("maps attachment activation to a preview id only when supported", () => {
    expect(
      getEmailAttachmentActivationId({ id: "attachment-2", previewable: true }),
    ).toBe("attachment-2");
    expect(
      getEmailAttachmentActivationId({
        id: "attachment-2",
        previewable: false,
      }),
    ).toBeNull();
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
