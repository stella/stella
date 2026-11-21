import { describe, expect, test } from "bun:test";

import { ZipArchive } from "@stll/docx-core/zip";

import {
  contentMatchesConvertibleMime,
  type ConversionContent,
  conversionContent,
} from "@/api/lib/files/conversion-content";
import type { ConvertibleMime } from "@/api/lib/files/pdf-derivative-policy";
import {
  compoundFileWithStreams,
  iworkPackage,
  odfPackage,
  ooxmlPackage,
  ooxmlRelationships,
  packageOf,
  wordPerfectFile,
} from "@/api/tests/helpers/converted-document-fixtures";
import { splitPng } from "@/api/tests/helpers/image-fixtures";
import { legacyWordFile } from "@/api/tests/helpers/legacy-word-fixture";

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
const bytesOf = (...values: number[]): Uint8Array => new Uint8Array(values);

const WORD_MAIN =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const SHEET_MAIN =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";
const PRESENTATION_MAIN =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml";

const spreadsheetBinary = () =>
  compoundFileWithStreams(["Workbook", "CompObj"]);
const flatSpreadsheet = () =>
  encode(
    '<?xml version="1.0" encoding="UTF-8"?><office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" office:mimetype="application/vnd.oasis.opendocument.spreadsheet"/>',
  );

/** One synthetic file of every convertible type, each its declared format. */
const SAMPLES = {
  "application/msword": () => legacyWordFile(["ordinary text"]),
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    async () => await ooxmlPackage(PRESENTATION_MAIN),
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
    async () => await ooxmlPackage(SHEET_MAIN),
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    async () => await ooxmlPackage(WORD_MAIN),
  "application/vnd.ms-excel": spreadsheetBinary,
  "application/vnd.ms-powerpoint": () =>
    compoundFileWithStreams(["PowerPoint Document"]),
  "application/vnd.ms-works": () => compoundFileWithStreams(["MN0", "CompObj"]),
  "application/vnd.oasis.opendocument.presentation": async () =>
    await odfPackage("application/vnd.oasis.opendocument.presentation"),
  "application/vnd.oasis.opendocument.spreadsheet": async () =>
    await odfPackage("application/vnd.oasis.opendocument.spreadsheet"),
  "application/vnd.oasis.opendocument.text": async () =>
    await odfPackage("application/vnd.oasis.opendocument.text"),
  "application/rtf": () => encode("{\\rtf1 synthetic text}"),
  "application/vnd.apple.numbers": async () => await iworkPackage(),
  "application/vnd.apple.pages": async () => await iworkPackage(),
  "application/vnd.wordperfect": () => wordPerfectFile(["Synthetic text"]),
  "application/wordperfect": () => wordPerfectFile(["Synthetic text"]),
  "application/wordperfect5.1": () => wordPerfectFile(["Synthetic text"]),
  "application/x-iwork-numbers-sffnumbers": async () =>
    await iworkPackage({ "index.xml.gz": "" }),
  "application/x-iwork-pages-sffpages": async () =>
    await packageOf({ "index.xml": "<sl:document/>" }),
  "application/x-wordperfect": () => wordPerfectFile(["Synthetic text"]),
  "application/xhtml+xml": () =>
    encode(
      '<?xml version="1.0"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><body/></html>',
    ),
  "image/bmp": () => bytesOf(0x42, 0x4d, 0, 0),
  "image/gif": () => encode("GIF89a"),
  "image/jpeg": () => bytesOf(0xff, 0xd8, 0xff, 0xe0),
  "image/png": () => splitPng(4, 4),
  "image/tiff": () => bytesOf(0x49, 0x49, 0x2a, 0),
  "image/webp": () => encode("RIFF\u0000\u0000\u0000\u0000WEBPVP8 "),
  "text/csv": () => encode("a,b\n1,2\n"),
  "text/html": () => encode("<!DOCTYPE html><html><body>x</body></html>"),
  "text/plain": () => encode("Synthetic notes"),
} as const satisfies Record<
  ConvertibleMime,
  () => Promise<Uint8Array> | Uint8Array
>;

describe("conversion content", () => {
  test.each(Object.entries(SAMPLES))(
    "%s converts when its bytes are that format",
    async (mime, build) => {
      expect(
        await contentMatchesConvertibleMime(
          mime as keyof typeof SAMPLES,
          await build(),
        ),
      ).toBe(true);
    },
  );

  test.each([
    ["a binary spreadsheet", spreadsheetBinary, "application/vnd.ms-excel"],
    [
      "an OpenDocument spreadsheet",
      async () =>
        await odfPackage("application/vnd.oasis.opendocument.spreadsheet"),
      "application/vnd.oasis.opendocument.spreadsheet",
    ],
    [
      "an OOXML workbook",
      async () => await ooxmlPackage(SHEET_MAIN),
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
    ["a flat OpenDocument spreadsheet", flatSpreadsheet, null],
  ] as const)(
    "%s converts under its own type only",
    async (_name, build, ownType: ConvertibleMime | null) => {
      const bytes = await build();
      for (const [mime] of Object.entries(SAMPLES)) {
        const declared = mime as keyof typeof SAMPLES;
        // Plain text and CSV convert any content; tested below.
        if (declared === "text/plain" || declared === "text/csv") {
          continue;
        }
        expect({
          declared,
          matches: await contentMatchesConvertibleMime(declared, bytes),
        }).toEqual({ declared, matches: declared === ownType });
      }
    },
  );

  test("plain text and CSV convert whatever they hold: the converter imports them as text", async () => {
    for (const bytes of [spreadsheetBinary(), flatSpreadsheet()]) {
      expect(await contentMatchesConvertibleMime("text/plain", bytes)).toBe(
        true,
      );
      expect(await contentMatchesConvertibleMime("text/csv", bytes)).toBe(true);
    }
  });

  test.each([
    ["a Works 4 document", ["MN0"], "works-binary"],
    ["a Works 5 or later document", ["CONTENTS", "SPELLING"], "works-binary"],
    ["a Word document", ["WordDocument", "1Table"], "word-binary"],
    ["a presentation", ["PowerPoint Document"], "presentation-binary"],
    ["a file of two formats", ["WordDocument", "Workbook"], "unrecognised"],
    ["a file of no format", ["Ole"], "unrecognised"],
  ] as const)(
    "reads %s from its compound file streams",
    async (_name, streams, expected: ConversionContent) => {
      expect(await conversionContent(compoundFileWithStreams(streams))).toBe(
        expected,
      );
    },
  );

  test.each([
    [
      "a macro-enabled Word document",
      async () =>
        await ooxmlPackage(
          "application/vnd.ms-word.document.macroEnabled.main+xml",
        ),
      "word-ooxml",
    ],
    [
      "a Word document embedding a workbook",
      async () =>
        await ooxmlPackage(WORD_MAIN, {
          "_rels/main.xml.rels":
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/package" Target="embeddings/sheet.xlsx"/></Relationships>',
          "embeddings/sheet.xlsx": await ooxmlPackage(SHEET_MAIN),
        }),
      "word-ooxml",
    ],
    [
      "a Word document whose content types mention another main part",
      async () =>
        await ooxmlPackage(WORD_MAIN, {
          "[Content_Types].xml": `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><!-- ${SHEET_MAIN} --><Override PartName="/MAIN.xml" ContentType="${WORD_MAIN}"/><Override PartName="/other.xml" ContentType="${PRESENTATION_MAIN}"/></Types>`,
        }),
      "word-ooxml",
    ],
    [
      "a main part typed by its extension's default",
      async () =>
        await ooxmlPackage(WORD_MAIN, {
          "[Content_Types].xml": `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="${SHEET_MAIN}"/></Types>`,
        }),
      "spreadsheet-ooxml",
    ],
    [
      "an OOXML package without package relationships",
      async () =>
        await packageOf({
          "[Content_Types].xml": `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/main.xml" ContentType="${WORD_MAIN}"/></Types>`,
        }),
      "unrecognised",
    ],
    [
      "an OPC package with no document part",
      async () =>
        await ooxmlPackage(
          "application/vnd.ms-package.xps-fixeddocumentsequence+xml",
        ),
      "unrecognised",
    ],
    [
      "an OpenDocument template",
      async () =>
        await odfPackage("application/vnd.oasis.opendocument.text-template"),
      "text-odf",
    ],
    [
      "an OpenDocument package without its mimetype",
      async () => await packageOf({ "META-INF/manifest.xml": "<manifest/>" }),
      "unrecognised",
    ],
    [
      "an e-book",
      async () => await odfPackage("application/epub+zip"),
      "unrecognised",
    ],
    ["a Pages or Numbers file", async () => await iworkPackage(), "iwork"],
    [
      "an iWork '09 file",
      async () => await packageOf({ "index.xml": "<sl:document/>" }),
      "iwork",
    ],
    [
      "an iWork index inside an OOXML package",
      async () => await ooxmlPackage(SHEET_MAIN, { "Index/Document.iwa": "" }),
      "unrecognised",
    ],
    [
      "an OOXML package inside an OpenDocument one",
      async () =>
        await odfPackage("application/vnd.oasis.opendocument.text", {
          "[Content_Types].xml": `<Types><Override ContentType="${SHEET_MAIN}"/></Types>`,
        }),
      "unrecognised",
    ],
    [
      "a plain archive",
      async () => await packageOf({ "notes.txt": "x" }),
      "unrecognised",
    ],
  ] as const)(
    "reads %s from its package entries",
    async (_name, build, expected: ConversionContent) => {
      expect(await conversionContent(await build())).toBe(expected);
    },
  );

  test.each([
    [
      "an HTML document",
      "<!DOCTYPE html>\n<html><body>x</body></html>",
      "markup",
    ],
    [
      "HTML after a comment",
      "<!-- saved --><HTML><BODY>x</BODY></HTML>",
      "markup",
    ],
    ["an HTML fragment", "  <p>One paragraph</p>", "markup"],
    [
      "HTML 4 under its public doctype",
      '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN">\n<html>x</html>',
      "markup",
    ],
    [
      "HTML under another document type",
      '<!DOCTYPE article PUBLIC "-//OASIS//DTD DocBook XML V4.5//EN">\n<html>x</html>',
      "unrecognised",
    ],
    ["an HTML5 section first", "<article>x</article>", "unrecognised"],
    [
      "XHTML after its declaration",
      '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"/>',
      "markup",
    ],
    ["text with no markup", "Plain words", "text"],
    ["text before markup", "Hello <b>there</b>", "text"],
    [
      "an SVG drawing",
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
      "unrecognised",
    ],
    [
      "a flat OpenDocument file",
      '<?xml version="1.0"?><office:document/>',
      "unrecognised",
    ],
    ["a SYLK spreadsheet", "ID;PSYNTHETIC\nC;X1;Y1;K1\nE\n", "unrecognised"],
    ["a DIF spreadsheet", 'TABLE\r\n0,1\r\n""\r\n', "unrecognised"],
    ["PostScript", "%!PS-Adobe-3.0\n", "unrecognised"],
    ["an RTF document", "{\\rtf1 x}", "rtf"],
    ["a PDF", "%PDF-1.7\n", "unrecognised"],
  ] as const)(
    "reads %s as text",
    async (_name, source, expected: ConversionContent) => {
      expect(await conversionContent(encode(source))).toBe(expected);
    },
  );

  test("reads UTF-16 HTML through its byte order mark, and binary text as unrecognised", async () => {
    const utf16 = new Uint8Array(
      Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from("<html><body>x</body></html>", "utf16le"),
      ]),
    );
    expect(await conversionContent(utf16)).toBe("markup");
    expect(await conversionContent(encode("<html>\u0000</html>"))).toBe(
      "unrecognised",
    );
  });

  test.each([
    ["UTF-16LE with a byte order mark", "utf16le", true],
    ["UTF-16LE without one", "utf16le", false],
    ["UTF-16BE with a byte order mark", "utf16be", true],
  ] as const)(
    "reads OOXML content types stored as %s",
    async (_name, encoding, bom) => {
      const xml = `<?xml version="1.0" encoding="UTF-16"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="${WORD_MAIN}"/></Types>`;
      const little = Buffer.from(`${bom ? "﻿" : ""}${xml}`, "utf16le");
      const archive = new ZipArchive();
      archive.set(
        "[Content_Types].xml",
        new Uint8Array(encoding === "utf16le" ? little : little.swap16()),
      );
      archive.set(
        "_rels/.rels",
        new TextEncoder().encode(ooxmlRelationships("word/document.xml")),
      );
      const bytes = await archive.generate({ compression: "store" });
      expect(await conversionContent(bytes)).toBe("word-ooxml");
    },
  );

  test("reads WordPerfect by its signature", async () => {
    expect(await conversionContent(wordPerfectFile(["x"]))).toBe("wordperfect");
  });
});
