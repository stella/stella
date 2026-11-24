/**
 * Converts each converted format through a running Gotenberg, the deployed
 * converter image: the unit tests fake the converter, these prove it imports
 * the files. Run with a converter listening and
 * `STELLA_RUN_CONVERTER_TESTS=true GOTENBERG_URL=http://127.0.0.1:<port>`.
 */
import { PDF } from "@libpdf/core";
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { convertToPdf } from "@/api/lib/files/gotenberg";
import {
  ebookFile,
  multiPageTiff,
  numbers09File,
  pages09File,
  webArchiveFile,
  wordPerfectFile,
} from "@/api/tests/helpers/converted-document-fixtures";
import { splitPng } from "@/api/tests/helpers/image-fixtures";
import { testScannedFile } from "@/api/tests/helpers/scanned-file";

const enabled = process.env["STELLA_RUN_CONVERTER_TESTS"] === "true";
// Above the converter request's 30 s budget: the first conversion can start
// the converter's office suite.
const CONVERSION_TIMEOUT_MS = 60_000;

const convertedText = async (
  bytes: Uint8Array,
  mimeType: string,
  path: string,
): Promise<{ images: number; pages: number; text: string }> => {
  const converted = await convertToPdf(
    testScannedFile({ bytes: bytes.slice().buffer, mimeType, path }),
    { retry: "caller" },
  );
  if (Result.isError(converted)) {
    throw converted.error;
  }
  const pdf = await PDF.load(new Uint8Array(converted.value.buffer));
  const pages = pdf.getPages();
  return {
    // Image objects in the PDF; the converter writes each one uncompressed
    // in its dictionary, so the count is readable without decoding streams.
    images:
      Buffer.from(converted.value.buffer)
        .toString("latin1")
        .split(/\/Subtype\s*\/Image\b/u).length - 1,
    pages: pages.length,
    text: pages
      .map((page) => page.extractText().text)
      .join(" ")
      .replace(/\s+/gu, " "),
  };
};

describe.skipIf(!enabled)("formats converted by a running converter", () => {
  test(
    "a WordPerfect 5.1 document, under an extension the converter does not take",
    async () => {
      const { text } = await convertedText(
        wordPerfectFile([
          "Synthetic WordPerfect lease summary.",
          "Rent is due monthly.",
        ]),
        "application/vnd.wordperfect",
        "lease.wp5",
      );
      expect(text).toContain("Synthetic WordPerfect lease summary.");
      expect(text).toContain("Rent is due monthly.");
    },
    CONVERSION_TIMEOUT_MS, // timeout: a live converter call has a 30 s budget
  );

  test(
    "a Pages document declared by its Mac type",
    async () => {
      const { text } = await convertedText(
        await pages09File(["Synthetic Pages offer.", "Valid for thirty days."]),
        "application/x-iwork-pages-sffpages",
        "offer.pages",
      );
      expect(text).toContain("Synthetic Pages offer.");
      expect(text).toContain("Valid for thirty days.");
    },
    CONVERSION_TIMEOUT_MS, // timeout: a live converter call has a 30 s budget
  );

  test(
    "a Numbers spreadsheet",
    async () => {
      const { text } = await convertedText(
        await numbers09File([
          ["Synthetic fee", 1250],
          ["Synthetic deposit", 300],
        ]),
        "application/vnd.apple.numbers",
        "budget.numbers",
      );
      expect(text).toContain("Synthetic fee");
      expect(text).toContain("1250");
      expect(text).toContain("Synthetic deposit");
    },
    CONVERSION_TIMEOUT_MS, // timeout: a live converter call has a 30 s budget
  );

  test(
    "a multi-page TIFF scan keeps every page",
    async () => {
      const { pages } = await convertedText(
        multiPageTiff([
          [200, 40, 20],
          [20, 40, 200],
          [20, 160, 40],
        ]),
        "image/tiff",
        "scan.tif",
      );
      expect(pages).toBe(3);
    },
    CONVERSION_TIMEOUT_MS, // timeout: a live converter call has a 30 s budget
  );

  test(
    "a web archive's page with its embedded image",
    async () => {
      const { images, text } = await convertedText(
        webArchiveFile({
          body: '<h1>Synthetic archived notice</h1><p>Filed on the first day.</p><img src="seal.png">',
          images: [
            {
              location: "https://example.test/notice/seal.png",
              type: "image/png",
              bytes: splitPng(32, 16),
            },
          ],
        }),
        "multipart/related",
        "notice.mht",
      );
      expect(text).toContain("Synthetic archived notice");
      expect(text).toContain("Filed on the first day.");
      expect(images).toBe(1);
    },
    CONVERSION_TIMEOUT_MS, // timeout: a live converter call has a 30 s budget
  );

  test(
    "an e-book's chapters in reading order",
    async () => {
      const { images, text } = await convertedText(
        await ebookFile({
          chapters: [
            { file: "two.xhtml", body: "<h1>Synthetic chapter two</h1>" },
            {
              file: "one.xhtml",
              body: '<h1>Synthetic chapter one</h1><p>Opening text.</p><img src="plate.png">',
            },
          ],
          images: { "plate.png": splitPng(32, 16) },
          spineOrder: ["one.xhtml", "two.xhtml"],
        }),
        "application/epub+zip",
        "book.epub",
      );
      expect(images).toBe(1);
      expect(text.indexOf("Synthetic chapter one")).toBeGreaterThan(-1);
      expect(text.indexOf("Synthetic chapter one")).toBeLessThan(
        text.indexOf("Synthetic chapter two"),
      );
    },
    CONVERSION_TIMEOUT_MS, // timeout: a live converter call has a 30 s budget
  );
});
