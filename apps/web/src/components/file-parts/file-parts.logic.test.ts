import { describe, expect, test } from "bun:test";

import { FILE_PART_TEXT_PREVIEW_MAX_BYTES } from "@stll/api-contract/file-parts";

import {
  decodeFilePartText,
  FILE_PART_PREVIEW_KIND,
  filePartActions,
  filePartPreviewKind,
  filePartViewId,
} from "@/components/file-parts/file-parts.logic";

describe("a part's in-place preview", () => {
  test("routes PDFs through the PDF viewer, whatever the parameters", () => {
    expect(filePartPreviewKind("application/pdf")).toBe(
      FILE_PART_PREVIEW_KIND.pdf,
    );
    expect(filePartPreviewKind("APPLICATION/PDF; charset=binary")).toBe(
      FILE_PART_PREVIEW_KIND.pdf,
    );
  });

  test("shows plain, CSV and XML text as text, never markup as a page", () => {
    for (const mediaType of [
      "text/plain",
      "TEXT/PLAIN; charset=utf-8",
      "text/csv",
      "application/xml",
      "text/xml",
    ]) {
      expect(filePartPreviewKind(mediaType)).toBe(FILE_PART_PREVIEW_KIND.text);
    }
    expect(filePartPreviewKind("text/html")).toBe(FILE_PART_PREVIEW_KIND.none);
  });

  test("allows only passive raster images in the image preview", () => {
    for (const mediaType of [
      "image/png",
      "image/jpeg",
      "image/jpg",
      "image/gif",
      "image/webp",
    ]) {
      expect(filePartPreviewKind(mediaType)).toBe(FILE_PART_PREVIEW_KIND.image);
    }
    for (const mediaType of ["image/svg+xml", "image/tiff"]) {
      expect(filePartPreviewKind(mediaType)).toBe(FILE_PART_PREVIEW_KIND.none);
    }
  });

  test("offers download and saving for every type, preview only where one exists", () => {
    const cases = [
      ["application/pdf", true],
      ["image/png", true],
      ["text/plain", true],
      [
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        false,
      ],
      ["application/octet-stream", false],
      ["message/rfc822", false],
    ] as const;
    for (const [mediaType, preview] of cases) {
      expect(filePartActions({ canSave: true, mediaType })).toEqual({
        preview,
        download: true,
        save: true,
      });
    }
    expect(
      filePartActions({ canSave: false, mediaType: "application/pdf" }).save,
    ).toBe(false);
  });

  test("keys a part's preview to its file and its address", () => {
    expect(
      filePartViewId({
        fieldId: "field-1",
        part: "attachment:2",
        workspaceId: "workspace-1",
      }),
    ).toBe("file-part:workspace-1:field-1:attachment:2");
    expect(
      filePartViewId({
        fieldId: "field-1",
        part: "member:2",
        workspaceId: "workspace-1",
      }),
    ).not.toBe(
      filePartViewId({
        fieldId: "field-1",
        part: "attachment:2",
        workspaceId: "workspace-1",
      }),
    );
  });
});

describe("a text part's preview", () => {
  test("decodes declared and byte-order-marked text encodings", () => {
    expect(
      decodeFilePartText({
        buffer: Uint8Array.from([0x47, 0x72, 0xfc, 0xdf, 0x65]).buffer,
        charset: "windows-1252",
      }),
    ).toEqual({ text: "Grüße", truncated: false });
    expect(
      decodeFilePartText({
        buffer: Uint8Array.from([0xfe, 0xff, 0x00, 0x41]).buffer,
        charset: null,
      }).text,
    ).toBe("A");
  });

  test("reads a part that declares no charset in the one it was saved in", () => {
    // "Výpis z účtu" saved in windows-1250, as a Czech bank exports it.
    expect(
      decodeFilePartText({
        buffer: Uint8Array.from([
          0x56, 0xfd, 0x70, 0x69, 0x73, 0x20, 0x7a, 0x20, 0xfa, 0xe8, 0x74,
          0x75,
        ]).buffer,
        charset: null,
      }),
    ).toEqual({ text: "Výpis z účtu", truncated: false });
  });

  test("preserves generic UTF-16 byte order", () => {
    expect(
      decodeFilePartText({
        buffer: Uint8Array.from([0xfe, 0xff, 0x01, 0x7d]).buffer,
        charset: "utf-16",
      }).text,
    ).toBe("Ž");
  });

  test("shows only the first bytes of a long part and says so", () => {
    const bytes = new Uint8Array(FILE_PART_TEXT_PREVIEW_MAX_BYTES + 3);
    bytes.fill(0x61);
    const decoded = decodeFilePartText({ buffer: bytes.buffer, charset: null });
    expect(decoded.truncated).toBe(true);
    expect(decoded.text).toHaveLength(FILE_PART_TEXT_PREVIEW_MAX_BYTES);
  });
});
