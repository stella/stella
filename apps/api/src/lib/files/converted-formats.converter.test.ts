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
  multiPageTiff,
  numbers09File,
  pages09File,
  wordPerfectFile,
} from "@/api/tests/helpers/converted-document-fixtures";
import { testScannedFile } from "@/api/tests/helpers/scanned-file";

const enabled = process.env["STELLA_RUN_CONVERTER_TESTS"] === "true";

const convertedText = async (
  bytes: Uint8Array,
  mimeType: string,
  path: string,
): Promise<{ pages: number; text: string }> => {
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
    pages: pages.length,
    text: pages
      .map((page) => page.extractText().text)
      .join(" ")
      .replace(/\s+/gu, " "),
  };
};

describe.skipIf(!enabled)("formats converted by a running converter", () => {
  test("a WordPerfect 5.1 document, under an extension the converter does not take", async () => {
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
  });

  test("a Pages document declared by its Mac type", async () => {
    const { text } = await convertedText(
      await pages09File(["Synthetic Pages offer.", "Valid for thirty days."]),
      "application/x-iwork-pages-sffpages",
      "offer.pages",
    );
    expect(text).toContain("Synthetic Pages offer.");
    expect(text).toContain("Valid for thirty days.");
  });

  test("a Numbers spreadsheet", async () => {
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
  });

  test("a multi-page TIFF scan keeps every page", async () => {
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
  });
});
