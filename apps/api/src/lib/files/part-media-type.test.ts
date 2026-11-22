import { describe, expect, test } from "bun:test";
import fc from "fast-check";

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
const docx = new Uint8Array(
  await Bun.file(
    new URL("fixtures/folio-core-0.58.5/saved.docx", import.meta.url),
  ).arrayBuffer(),
);

type Case = {
  rule: string;
  bytes: Uint8Array;
  stated: string | null;
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
  test.each(CASES)("$rule", async ({ bytes, stated, fileName, expected }) => {
    expect(await partMediaType({ bytes, stated, fileName })).toBe(expected);
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
  const contents = fc.oneof(
    fc.uint8Array({ maxLength: 64 }),
    fc.constantFrom(pdf, rtf, text, xml, png, jpeg, binary),
    fc
      .tuple(fc.constantFrom(pdf, png, jpeg), fc.uint8Array({ maxLength: 32 }))
      .map(([head, tail]) => Uint8Array.from([...head, ...tail])),
  );

  test("a part is never typed as what its bytes contradict", async () => {
    await assertProperty(
      "a part is never typed as what its bytes contradict",
      fc.asyncProperty(
        contents,
        claims,
        names,
        async (bytes, stated, fileName) => {
          const mediaType = await partMediaType({ bytes, stated, fileName });
          expect(declaredMimeMatchesMagic(mediaType, bytes)).toBe(true);
          // Text is only ever what the detector read as text.
          if (/^text\/|[/+](?:xml|json)$/u.test(mediaType)) {
            expect(detectEmbeddedPayload(bytes).mimeType).toBe(mediaType);
          }
        },
      ),
    );
  });
});
