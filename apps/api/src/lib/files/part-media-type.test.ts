import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { TextDecoder as LabelledTextDecoder } from "node:util";

import { assertProperty } from "@stll/property-testing";

import { declaredMimeMatchesMagic } from "@/api/lib/file-scan/magic";
import {
  detectEmbeddedPayload,
  OPAQUE_EMBEDDED_MIME_TYPE,
} from "@/api/lib/files/embedded-payload-format";
import { DOCX_MIME_TYPE, PDF_MIME_TYPE, RTF_MIME_TYPE } from "@/api/mime-types";

import { partMediaType } from "./part-media-type";

const encode = (text: string) => new TextEncoder().encode(text);
const pdf = encode("%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n");
const rtf = encode("{\\rtf1\\ansi Usnesení o nákladech řízení}");
const text = encode("Předvolání k jednání dne 4. 12. 2026");
const xml = encode('<?xml version="1.0"?><podani><vec>Žaloba</vec></podani>');
const png = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d,
]);
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
const binary = Uint8Array.from([0x00, 0xf5, 0xfe, 0xff, 0x13, 0x37]);
// Single-byte text a UTF-8 reading rejects; each charset writes every listed
// letter as one byte, and ASCII as ASCII.
const singleByte = (
  source: string,
  letters: Readonly<Record<string, number>>,
) =>
  Uint8Array.from(source, (char) => letters[char] ?? char.codePointAt(0) ?? 0);
const windows1252 = singleByte("Grüße aus Wien", { ü: 0xfc, ß: 0xdf });
const windows1250 = singleByte("Žaloba o náhradu škody, lhůta běží", {
  Ž: 0x8e,
  á: 0xe1,
  š: 0x9a,
  ů: 0xf9,
  ě: 0xec,
  ž: 0x9e,
  í: 0xed,
});
const utf16 = (source: string, byteOrder: "le" | "be") => {
  const littleEndian = Buffer.from(source, "utf16le");
  return byteOrder === "le"
    ? Uint8Array.from([0xff, 0xfe, ...littleEndian])
    : Uint8Array.from([0xfe, 0xff, ...littleEndian.swap16()]);
};
const docx = new Uint8Array(
  await Bun.file(
    new URL("fixtures/folio-core-0.58.5/saved.docx", import.meta.url),
  ).arrayBuffer(),
);

type Case = {
  rule: string;
  bytes: Uint8Array;
  stated: string | null;
  /** The charset the container declares for the part; none by default. */
  charset?: string;
  fileName: string | null;
  expected: string;
};

const CASES: Case[] = [
  // The bytes decide wherever they show a type.
  {
    rule: "PDF bytes override an image claim",
    bytes: pdf,
    stated: "image/png",
    fileName: "scan.png",
    expected: PDF_MIME_TYPE,
  },
  {
    rule: "RTF bytes override a generic claim and a PDF name",
    bytes: rtf,
    stated: "application/octet-stream",
    fileName: "usneseni.pdf",
    expected: RTF_MIME_TYPE,
  },
  {
    rule: "text bytes override a PDF claim",
    bytes: text,
    stated: "application/pdf",
    fileName: "predvolani.pdf",
    expected: "text/plain",
  },
  {
    rule: "XML bytes override a text claim",
    bytes: xml,
    stated: "text/plain",
    fileName: "podani.txt",
    expected: "application/xml",
  },
  {
    rule: "DOCX bytes override a ZIP claim and a neutral name",
    bytes: docx,
    stated: "application/zip",
    fileName: "smlouva.bin",
    expected: DOCX_MIME_TYPE,
  },
  // A claim the bytes cannot show stands only where they bear it out.
  {
    rule: "an image claim with its magic stands",
    bytes: png,
    stated: "image/png",
    fileName: null,
    expected: "image/png",
  },
  {
    rule: "an image claim with parameters keeps only its essence",
    bytes: jpeg,
    stated: 'IMAGE/JPEG; name="foto.jpg"',
    fileName: "foto.jpg",
    expected: "image/jpeg",
  },
  {
    rule: "an image claim the magic contradicts is opaque",
    bytes: jpeg,
    stated: "image/png",
    fileName: "foto.png",
    expected: OPAQUE_EMBEDDED_MIME_TYPE,
  },
  {
    rule: "a PDF claim on bytes without the PDF signature is opaque",
    bytes: binary,
    stated: PDF_MIME_TYPE,
    fileName: "rozsudek.pdf",
    expected: OPAQUE_EMBEDDED_MIME_TYPE,
  },
  {
    rule: "a text claim on binary bytes is opaque",
    bytes: binary,
    stated: "text/plain",
    fileName: "poznamka.txt",
    expected: OPAQUE_EMBEDDED_MIME_TYPE,
  },
  // Text the detector cannot read as UTF-8 stays text in the charset it
  // declares: a byte-order mark, or the charset its container states.
  {
    rule: "windows-1252 text under its declared charset stays text",
    bytes: windows1252,
    stated: "text/plain",
    charset: "windows-1252",
    fileName: "gruss.txt",
    expected: "text/plain",
  },
  {
    rule: "windows-1250 text under its declared charset stays text",
    bytes: windows1250,
    stated: "text/plain",
    charset: "windows-1250",
    fileName: "zaloba.txt",
    expected: "text/plain",
  },
  {
    rule: "UTF-16 text with a little-endian byte-order mark stays text",
    bytes: utf16("Lhůta: 15. 10. 2026", "le"),
    stated: "text/plain",
    fileName: "lhuta.txt",
    expected: "text/plain",
  },
  {
    rule: "UTF-16 text with a big-endian byte-order mark stays text",
    bytes: utf16("Lhůta: 15. 10. 2026", "be"),
    stated: null,
    fileName: "lhuta.txt",
    expected: "text/plain",
  },
  {
    rule: "single-byte text without a declared charset is text in the charset it was saved in",
    bytes: windows1250,
    stated: "text/plain",
    fileName: "zaloba.txt",
    expected: "text/plain",
  },
  {
    rule: "binary bytes under a declared charset are opaque",
    bytes: binary,
    stated: "text/plain",
    charset: "windows-1252",
    fileName: "poznamka.txt",
    expected: OPAQUE_EMBEDDED_MIME_TYPE,
  },
  {
    rule: "binary bytes behind a UTF-16 byte-order mark are opaque",
    bytes: Uint8Array.from([0xff, 0xfe, 0x00, 0x00, 0x13, 0x37, 0x01, 0x00]),
    stated: "text/plain",
    fileName: "poznamka.txt",
    expected: OPAQUE_EMBEDDED_MIME_TYPE,
  },
  {
    rule: "an XML claim on binary bytes is opaque",
    bytes: binary,
    stated: "application/xml",
    fileName: null,
    expected: OPAQUE_EMBEDDED_MIME_TYPE,
  },
  {
    rule: "a structured XML claim on binary bytes is opaque",
    bytes: binary,
    stated: "application/atom+xml",
    fileName: null,
    expected: OPAQUE_EMBEDDED_MIME_TYPE,
  },
  {
    rule: "a JSON claim on binary bytes is opaque",
    bytes: binary,
    stated: "application/json",
    fileName: null,
    expected: OPAQUE_EMBEDDED_MIME_TYPE,
  },
  // A generic or missing claim falls back to the name's extension.
  {
    rule: "a generic claim takes the name's image type when the magic agrees",
    bytes: jpeg,
    stated: "application/octet-stream",
    fileName: "FOTO.JPG",
    expected: "image/jpeg",
  },
  {
    rule: "no claim takes the name's image type when the magic agrees",
    bytes: png,
    stated: null,
    fileName: "plan.png",
    expected: "image/png",
  },
  {
    rule: "an empty claim takes the name's image type when the magic agrees",
    bytes: png,
    stated: "",
    fileName: "plan.png",
    expected: "image/png",
  },
  {
    rule: "a name whose type the magic contradicts is opaque",
    bytes: jpeg,
    stated: "application/octet-stream",
    fileName: "plan.png",
    expected: OPAQUE_EMBEDDED_MIME_TYPE,
  },
  {
    rule: "a name whose type is text, on binary bytes, is opaque",
    bytes: binary,
    stated: null,
    fileName: "poznamka.txt",
    expected: OPAQUE_EMBEDDED_MIME_TYPE,
  },
  {
    rule: "no claim and no name is opaque",
    bytes: binary,
    stated: null,
    fileName: null,
    expected: OPAQUE_EMBEDDED_MIME_TYPE,
  },
];

describe("the media type of a part of a file", () => {
  test.each(CASES)(
    "$rule",
    async ({ bytes, stated, charset, fileName, expected }) => {
      expect(
        await partMediaType({
          bytes,
          stated,
          charset: charset ?? null,
          fileName,
        }),
      ).toBe(expected);
    },
  );

  test("the single-byte fixtures are the text they stand for", () => {
    expect(new LabelledTextDecoder("windows-1252").decode(windows1252)).toBe(
      "Grüße aus Wien",
    );
    expect(new LabelledTextDecoder("windows-1250").decode(windows1250)).toBe(
      "Žaloba o náhradu škody, lhůta běží",
    );
  });

  const claims = fc.constantFrom(
    null,
    "",
    "application/octet-stream",
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "text/plain",
    "text/html",
    "application/xml",
    "application/json",
    "application/vnd.ms-excel",
  );
  const names = fc.constantFrom(
    null,
    "priloha",
    "priloha.pdf",
    "priloha.png",
    "priloha.jpg",
    "priloha.txt",
    "priloha.xml",
    "priloha.xls",
  );
  const charsets = fc.constantFrom(
    null,
    "utf-8",
    "utf-16",
    "windows-1250",
    "windows-1252",
  );
  const byteOrderMarks = fc.constantFrom(
    [0xef, 0xbb, 0xbf],
    [0xff, 0xfe],
    [0xfe, 0xff],
  );
  const contents = fc.oneof(
    fc.uint8Array({ maxLength: 64 }),
    fc.constantFrom(pdf, rtf, text, xml, png, jpeg, binary),
    fc.constantFrom(windows1250, windows1252, utf16("Lhůta", "le")),
    fc
      .tuple(fc.constantFrom(pdf, png, jpeg), fc.uint8Array({ maxLength: 32 }))
      .map(([head, tail]) => Uint8Array.from([...head, ...tail])),
    fc
      .tuple(byteOrderMarks, fc.uint8Array({ maxLength: 32 }))
      .map(([head, tail]) => Uint8Array.from([...head, ...tail])),
  );
  const startsWithByteOrderMark = (bytes: Uint8Array) =>
    (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) ||
    (bytes[0] === 0xff && bytes[1] === 0xfe) ||
    (bytes[0] === 0xfe && bytes[1] === 0xff);

  test("a part is never typed as what its bytes contradict", async () => {
    await assertProperty(
      "a part is never typed as what its bytes contradict",
      fc.asyncProperty(
        contents,
        claims,
        charsets,
        names,
        async (bytes, stated, charset, fileName) => {
          const mediaType = await partMediaType({
            bytes,
            stated,
            charset,
            fileName,
          });
          expect(declaredMimeMatchesMagic(mediaType, bytes)).toBe(true);
          // Text is what the detector read as text, or text in the charset
          // its byte-order mark or its container declares.
          if (
            /^text\/|[/+](?:xml|json)$/u.test(mediaType) &&
            detectEmbeddedPayload(bytes).mimeType !== mediaType
          ) {
            expect(charset !== null || startsWithByteOrderMark(bytes)).toBe(
              true,
            );
            // A NUL byte is text only as half of a UTF-16 code unit.
            if (!startsWithByteOrderMark(bytes) && charset !== "utf-16") {
              expect(bytes.includes(0x00)).toBe(false);
            }
          }
        },
      ),
    );
  });
});
