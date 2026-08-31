import { describe, expect, test } from "bun:test";

import {
  MATTER_DOCUMENT_LANGUAGE_LIMIT,
  rankMatterDocumentLanguages,
} from "@/api/lib/document-translation/version-language";

describe("matter document language tally", () => {
  test("ranks by count and keeps only the head of the list", () => {
    expect(
      rankMatterDocumentLanguages([
        { language: "CS", count: 3 },
        { language: "DE", count: 9 },
        { language: "EN-GB", count: 7 },
        { language: "FR", count: 2 },
        { language: "SK", count: 1 },
        { language: "PL", count: 1 },
      ]),
    ).toEqual([
      { language: "DE", count: 9 },
      { language: "EN-GB", count: 7 },
      { language: "CS", count: 3 },
      { language: "FR", count: 2 },
      { language: "PL", count: 1 },
    ]);
  });

  test("breaks ties on the code so the proposed default is deterministic", () => {
    const ranked = rankMatterDocumentLanguages([
      { language: "SK", count: 4 },
      { language: "CS", count: 4 },
      { language: "DE", count: 4 },
    ]);
    expect(ranked.map(({ language }) => language)).toEqual(["CS", "DE", "SK"]);
  });

  test("drops rows the catalog does not name", () => {
    expect(
      rankMatterDocumentLanguages([
        { language: null, count: 12 },
        { language: "kl", count: 8 },
        { language: "CS", count: 1 },
      ]),
    ).toEqual([{ language: "CS", count: 1 }]);
  });

  test("never returns more than the offered limit", () => {
    const rows = [
      { language: "CS", count: 6 },
      { language: "DE", count: 5 },
      { language: "EN-GB", count: 4 },
      { language: "FR", count: 3 },
      { language: "IT", count: 2 },
      { language: "PL", count: 1 },
    ];
    expect(rankMatterDocumentLanguages(rows)).toHaveLength(
      MATTER_DOCUMENT_LANGUAGE_LIMIT,
    );
  });
});
