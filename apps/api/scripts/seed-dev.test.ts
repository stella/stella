import { describe, expect, test } from "bun:test";

import {
  buildExportReviewCitationSeeds,
  buildExportReviewDocumentText,
  buildExportReviewMetadata,
  createMockDocx,
} from "./seed-dev";

// Reproduces the non-empty-block walk folio's DOCX extractor performs (see
// the `blockIndex` doc comment on `ExportReviewCitationSeed` in
// seed-dev.ts): the leading title paragraph is block 1, then one block per
// non-blank line of the body text, blank lines uncounted.
const nonEmptyBlockTexts = (title: string, bodyText: string): string[] =>
  [title, ...bodyText.split("\n")].filter((line) => line.trim().length > 0);

// Parses the actual bytes `createMockDocx` produces back into its paragraph
// text list, so the guard exercises the real generator instead of only
// re-deriving the same layout by hand.
const paragraphTextsFromDocx = async (docx: Buffer): Promise<string[]> => {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(docx);
  const documentXml = await zip.file("word/document.xml")?.async("string");
  if (documentXml === undefined) {
    throw new Error("seeded docx is missing word/document.xml");
  }

  const paragraphs = documentXml.match(/<w:p>.*?<\/w:p>/gu) ?? [];
  return paragraphs.map((paragraph) => {
    const textRuns = paragraph.match(/<w:t[^>]*>.*?<\/w:t>/gu) ?? [];
    return textRuns
      .map((run) => run.replace(/<w:t[^>]*>|<\/w:t>/gu, ""))
      .join("")
      .replaceAll("&quot;", '"')
      .replaceAll("&apos;", "'")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&amp;", "&");
  });
};

describe("Export Review citation seeds", () => {
  test("every docx-folio citation's blockIndex points at the paragraph containing its quote", async () => {
    const index = 0;
    const metadata = buildExportReviewMetadata(index);
    const fileName = "Sample_Export_Review_Contract.docx";
    const title = fileName.replace(/\.\w+$/u, "").replaceAll("_", " ");
    const bodyText = buildExportReviewDocumentText(fileName, index);

    const docx = await createMockDocx(title, bodyText);
    const paragraphs = await paragraphTextsFromDocx(docx);
    const nonEmptyParagraphs = paragraphs.filter(
      (text) => text.trim().length > 0,
    );

    // Sanity-check the DOCX parsing itself against a plain-text
    // reconstruction of the same title + body before trusting it below.
    expect(nonEmptyParagraphs).toEqual(nonEmptyBlockTexts(title, bodyText));

    const citationSeeds = buildExportReviewCitationSeeds(metadata);
    expect(citationSeeds.length).toBeGreaterThan(0);

    for (const seed of citationSeeds) {
      const paragraphText = nonEmptyParagraphs.at(seed.blockIndex - 1);
      expect(paragraphText).toContain(seed.quote);
    }
  });
});
