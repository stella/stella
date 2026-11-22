import { describe, expect, test } from "bun:test";

import { fileTypeIcon, fileTypeLabel } from "./file-part-list.logic";

describe("a part's icon by the family of its media type", () => {
  test.each([
    ["pdf", "application/pdf", "rozsudek.pdf", "pdf"],
    [
      "word processing",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "kupni-smlouva.docx",
      "word",
    ],
    [
      "OpenDocument text",
      "application/vnd.oasis.opendocument.text",
      "plna-moc.odt",
      "openDocumentText",
    ],
    [
      "spreadsheet",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "vyuctovani-2026.xlsx",
      "excel",
    ],
    ["comma-separated values", "text/csv", "faktury.csv", "csv"],
    [
      "presentation",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "jednani-s-klientem.pptx",
      "powerpoint",
    ],
    ["xml", "application/xml", "faktura.xml", "xml"],
    ["xml stated as text", "text/xml", "podani.xml", "xml"],
    ["a signed file", "application/pkcs7-mime", "smlouva.pdf.p7m", "cades"],
    ["a zip archive", "application/zip", "prilohy.zip", "zip"],
    [
      "a zip archive by its name",
      "application/octet-stream",
      "Prilohy.ZIP",
      "zip",
    ],
  ] as const)("%s draws its format's mark", (_, mediaType, fileName, mark) => {
    expect(fileTypeIcon(mediaType, fileName)).toEqual({ type: "mark", mark });
  });

  test.each([
    ["image", "image/jpeg", "fotodokumentace.jpg", "image"],
    ["an unlisted image", "image/heic", "IMG_2041.HEIC", "image"],
    ["plain text", "text/plain", "poznamky.txt", "text"],
    ["an email", "message/rfc822", "predzalobni-vyzva.eml", "email"],
    ["an Outlook message", "application/vnd.ms-outlook", "vyzva.msg", "email"],
    ["a 7-Zip archive", "application/x-7z-compressed", "spis.7z", "archive"],
    [
      "an OpenDocument presentation",
      "application/vnd.oasis.opendocument.presentation",
      "skoleni.odp",
      "presentation",
    ],
    [
      "a Pages document",
      "application/vnd.apple.pages",
      "dopis.pages",
      "wordProcessing",
    ],
    [
      "a Numbers spreadsheet",
      "application/vnd.apple.numbers",
      "rozpocet.numbers",
      "spreadsheet",
    ],
    ["an XML-based type", "application/vnd.etsi.tsl+xml", null, "xml"],
    ["an unknown type", "application/octet-stream", "data.bin", "unknown"],
    ["an unnamed unknown type", "application/octet-stream", null, "unknown"],
  ] as const)(
    "%s draws its family's glyph",
    (_, mediaType, fileName, family) => {
      expect(fileTypeIcon(mediaType, fileName)).toEqual({
        type: "glyph",
        family,
      });
    },
  );
});

describe("the name settles a type that says nothing", () => {
  test("an opaque type with a PDF's name draws the PDF mark", () => {
    expect(fileTypeIcon("application/octet-stream", "usneseni.pdf")).toEqual({
      type: "mark",
      mark: "pdf",
    });
  });

  test("an opaque type with an archive's name draws the archive glyph", () => {
    expect(fileTypeIcon("application/octet-stream", "Prilohy.RAR")).toEqual({
      type: "glyph",
      family: "archive",
    });
  });

  test("the server's type wins over a name that claims another format", () => {
    // The media type is read from the bytes; a renamed image stays an image.
    expect(fileTypeIcon("image/png", "sken.pdf")).toEqual({
      type: "glyph",
      family: "image",
    });
  });

  test("parameters and case in the media type do not change the family", () => {
    expect(fileTypeIcon("Application/ZIP; name=spis", null)).toEqual(
      fileTypeIcon("application/zip", null),
    );
  });
});

describe("a part's format tag", () => {
  test("names the format as the matter's document list does", () => {
    expect(fileTypeLabel("application/pdf", "rozsudek.pdf")).toBe("PDF");
    expect(fileTypeLabel("application/octet-stream", "Spis.Rar")).toBe("RAR");
  });

  test("is absent when neither the type nor the name names a format", () => {
    expect(fileTypeLabel("application/octet-stream", null)).toBeUndefined();
  });
});
