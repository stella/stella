import { describe, expect, test } from "bun:test";

import { publisherCitationGap } from "@/api/handlers/case-law/ingestion/citation-recall";

describe("publisherCitationGap", () => {
  test("prefix and dash spellings of the same number are not gaps", () => {
    expect(
      publisherCitationGap({
        extracted: ["sygn. akt II CSK 123/20", "C‑283/81"],
        publisherCited: ["II CSK 123/20", "C-283/81"],
      }),
    ).toEqual({ publisherCitedCount: 2, missed: [] });
  });

  test("a publisher citation the extractor missed is reported verbatim", () => {
    expect(
      publisherCitationGap({
        extracted: ["sp. zn. 21 Cdo 1234/2020"],
        publisherCited: ["II CSK 999/20", "21 Cdo 1234/2020"],
      }),
    ).toEqual({ publisherCitedCount: 2, missed: ["II CSK 999/20"] });
  });

  test("blank publisher entries are ignored", () => {
    expect(
      publisherCitationGap({ extracted: [], publisherCited: ["  ", ""] }),
    ).toEqual({ publisherCitedCount: 0, missed: [] });
  });

  test("spelling variants of one publisher citation count once", () => {
    expect(
      publisherCitationGap({
        extracted: [],
        publisherCited: ["U 1/86", "U 1 /86"],
      }),
    ).toEqual({ publisherCitedCount: 1, missed: ["U 1/86"] });
  });
});
