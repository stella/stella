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

  test("preserves generic UTF-16 byte order and legacy text encodings", () => {
    expect(
      decodeEmailTextAttachment({
        buffer: Uint8Array.from([0xfe, 0xff, 0x01, 0x7d]).buffer,
        charset: "utf-16",
      }),
    ).toBe("Ž");

    for (const [charset, bytes, text] of [
      ["windows-1250", [0x50, 0xf8, 0xed, 0x6c, 0x69, 0x9a], "Příliš"],
      ["iso-8859-2", [0xa3, 0xf3, 0x64, 0xbc], "Łódź"],
      ["shift_jis", [0x82, 0xa0], "あ"],
      ["gbk", [0xd6, 0xd0], "中"],
    ] as const) {
      expect(
        decodeEmailTextAttachment({
          buffer: Uint8Array.from(bytes).buffer,
          charset,
        }),
      ).toBe(text);
    }
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
