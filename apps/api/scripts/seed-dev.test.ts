import { describe, expect, test } from "bun:test";

import { ZipArchive } from "@stll/docx-core/zip";

import {
  createMockDocx,
  createSeedEmail,
  SEED_EMAIL_FILE_NAMES,
  userFileCleanupKeys,
} from "./seed-dev";
import {
  buildExportReviewCitationSeeds,
  buildExportReviewDocumentText,
  buildExportReviewMetadata,
} from "./seed-export-review";

// Reproduces the non-empty-block walk folio's DOCX extractor performs (see
// the `blockIndex` doc comment on `ExportReviewCitationSeed` in
// seed-export-review.ts): the leading title paragraph is block 1, then one block per
// non-blank line of the body text, blank lines uncounted.
const nonEmptyBlockTexts = (title: string, bodyText: string): string[] =>
  [title, ...bodyText.split("\n")].filter((line) => line.trim().length > 0);

// Parses the actual bytes `createMockDocx` produces back into its paragraph
// text list, so the guard exercises the real generator instead of only
// re-deriving the same layout by hand.
const paragraphTextsFromDocx = async (docx: Buffer): Promise<string[]> => {
  const zip = await ZipArchive.read(docx);
  const documentXml = await zip.entry("word/document.xml")?.text();
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

describe("email viewer seeds", () => {
  test("nested MIME boundaries cannot prefix one another", () => {
    for (const fileName of SEED_EMAIL_FILE_NAMES) {
      const source = createSeedEmail(fileName).toString("utf-8");
      const boundaries = Array.from(
        source.matchAll(/boundary="(?<value>[^"]+)"/gu),
        (match) => match.groups?.["value"] ?? "",
      );
      expect(boundaries).toHaveLength(2);
      const outer = boundaries.at(0) ?? "";
      const inner = boundaries.at(1) ?? "";
      expect(outer.startsWith(inner)).toBe(false);
      expect(inner.startsWith(outer)).toBe(false);
    }
  });
});

describe("chat attachment seed cleanup", () => {
  test("deletes sources and thumbnails for both persisted key forms", () => {
    const organizationId = "org_1";
    const userId = "user_1";
    const deleted = [
      {
        organizationId,
        userId,
        s3Key: `${organizationId}/organization-source.png`,
        thumbnailFileId: "organization-thumbnail",
      },
      {
        organizationId,
        userId,
        s3Key: `${userId}/uploader-source.png`,
        thumbnailFileId: "uploader-thumbnail",
      },
    ].flatMap(userFileCleanupKeys);

    expect(deleted).toEqual([
      "org_1/organization-source.png",
      "org_1/organization-thumbnail.webp",
      "user_1/uploader-source.png",
      "user_1/uploader-thumbnail.webp",
    ]);
  });
});
