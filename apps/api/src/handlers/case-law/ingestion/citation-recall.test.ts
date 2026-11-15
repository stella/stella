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

  test("an EU case-law CELEX number is compared as its docket", () => {
    expect(
      publisherCitationGap({
        extracted: ["C‑181/97", "T-181/97"],
        publisherCited: ["61997TO0181", "62002TJ0190", "61997CJ0181"],
      }),
    ).toEqual({ publisherCitedCount: 3, missed: ["T-190/02"] });
  });

  test("one EU case cited through several of its documents counts once", () => {
    expect(
      publisherCitationGap({
        extracted: [],
        publisherCited: ["62019CJ0311", "62019CC0311", "62019CO0311"],
      }),
    ).toEqual({ publisherCitedCount: 1, missed: ["C-311/19"] });
  });

  test("EU legislation and pre-1989 dockets are not counted", () => {
    expect(
      publisherCitationGap({
        extracted: [],
        publisherCited: [
          "12008E263",
          "12008E/PRO/03",
          "32017R1001",
          "32012Q0929(01)",
          "61981CJ0060",
        ],
      }),
    ).toEqual({ publisherCitedCount: 0, missed: [] });
  });
});
