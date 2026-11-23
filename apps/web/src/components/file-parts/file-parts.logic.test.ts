import { describe, expect, test } from "bun:test";

import { FILE_PART_TEXT_PREVIEW_MAX_BYTES } from "@stll/api-contract/file-parts";

import {
  containedFileRows,
  decodeFilePartText,
  FILE_PART_PREVIEW_KIND,
  filePartActions,
  filePartOpensInside,
  filePartPreviewKind,
  filePartViewId,
  isFilePartPdfPreviewKind,
} from "@/components/file-parts/file-parts.logic";
import { DOCX_MIME, PPTX_MIME, XLSX_MIME } from "@/lib/consts";

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

  test("opens an office part in the viewer a stored file of its type opens in", () => {
    const cases = [
      [DOCX_MIME, FILE_PART_PREVIEW_KIND.docx],
      [`${DOCX_MIME}; charset=binary`, FILE_PART_PREVIEW_KIND.docx],
      [XLSX_MIME, FILE_PART_PREVIEW_KIND.xlsx],
      [PPTX_MIME, FILE_PART_PREVIEW_KIND.pptx],
      // No viewer draws these; the server displays them as PDF renditions.
      ["application/msword", FILE_PART_PREVIEW_KIND.converted],
      ["application/vnd.ms-excel", FILE_PART_PREVIEW_KIND.converted],
      [
        "application/vnd.oasis.opendocument.text",
        FILE_PART_PREVIEW_KIND.converted,
      ],
      ["application/rtf", FILE_PART_PREVIEW_KIND.converted],
      ["application/vnd.wordperfect", FILE_PART_PREVIEW_KIND.converted],
      ["application/vnd.apple.pages", FILE_PART_PREVIEW_KIND.converted],
    ] as const;
    for (const [mediaType, kind] of cases) {
      expect(filePartPreviewKind(mediaType)).toBe(kind);
    }
  });

  test("draws only a PDF and a converted document in the PDF viewer", () => {
    const pdfKinds = Object.values(FILE_PART_PREVIEW_KIND).filter((kind) =>
      isFilePartPdfPreviewKind(kind),
    );
    expect(pdfKinds.toSorted()).toEqual([
      FILE_PART_PREVIEW_KIND.converted,
      FILE_PART_PREVIEW_KIND.pdf,
    ]);
  });

  test("offers download and saving for every type, preview only where one exists", () => {
    const cases = [
      ["application/pdf", true],
      ["image/png", true],
      ["text/plain", true],
      [DOCX_MIME, true],
      ["application/msword", true],
      ["application/zip", false],
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

describe("a part that is itself a container", () => {
  test.each([
    ["message/rfc822", "podklady.eml", "member:2"],
    ["application/zip", "starsi-spis.zip", "attachment:0"],
    ["application/octet-stream", "DZ_5528193.zfo", "member:0/attachment:1"],
    [
      "application/pkcs7-mime",
      "rozsudek.pdf.p7m",
      "member:1/member:0/member:3",
    ],
  ] as const)(
    "a %s named %s opens to the files inside it",
    (mediaType, fileName, part) => {
      expect(filePartOpensInside({ mediaType, fileName, part })).toBe(true);
    },
  );

  test("a part that previews as itself, holds no parts or sits deepest does not", () => {
    expect(
      filePartOpensInside({
        mediaType: "application/pdf",
        fileName: "usneseni.pdf",
        part: "member:0",
      }),
    ).toBe(false);
    // An XML file may be an invoice, yet it previews as its text.
    expect(
      filePartOpensInside({
        mediaType: "application/xml",
        fileName: "faktura.xml",
        part: "member:0",
      }),
    ).toBe(false);
    expect(
      filePartOpensInside({
        mediaType: "application/zip",
        fileName: "nejhlubsi.zip",
        part: "member:0/member:0/member:0/member:0",
      }),
    ).toBe(false);
  });

  test("lists every file in the container's order, the ones that open as parts", () => {
    const rows = containedFileRows([
      {
        fileName: "zaloba.pdf",
        folder: "podani",
        sizeBytes: 10,
        part: {
          part: "member:0",
          fileName: "zaloba.pdf",
          mediaType: "application/pdf",
          sizeBytes: 10,
        },
        unavailable: null,
      },
      {
        fileName: "posudek.pdf",
        folder: null,
        sizeBytes: 20,
        part: null,
        unavailable: "encrypted",
      },
    ]);
    expect(rows.map(({ type, key }) => [type, key])).toEqual([
      ["part", "member:0"],
      ["unavailable", "unavailable:1"],
    ]);
    expect(rows.at(0)).toMatchObject({ part: { detail: "podani" } });
  });
});
