import { describe, expect, test } from "bun:test";

import {
  CASE_LAW_WORK_EXPRESSIONS_METADATA_KEY,
  caseLawSourceLanguagesOf,
  type CaseLawWorkExpression,
} from "./case-law-source-languages";

const expression = (
  authorityCode: string,
  language: string | null,
): CaseLawWorkExpression => ({ authorityCode, language, formats: ["html"] });

describe("the languages a decision's publisher lists", () => {
  test("are the row tags of the stored manifest, sorted and distinct", () => {
    expect(
      caseLawSourceLanguagesOf({
        [CASE_LAW_WORK_EXPRESSIONS_METADATA_KEY]: [
          expression("RON", "ro"),
          expression("CES", "cs"),
          expression("CES", "cs"),
          // A code naming no language the corpus stores lists no row.
          expression("LAT", null),
        ],
      }),
    ).toEqual(["cs", "ro"]);
  });

  test("are unknown, not empty, when the row states no manifest", () => {
    expect(caseLawSourceLanguagesOf(null)).toBeNull();
    expect(caseLawSourceLanguagesOf({})).toBeNull();
    expect(
      caseLawSourceLanguagesOf({
        [CASE_LAW_WORK_EXPRESSIONS_METADATA_KEY]: [{ language: "CES" }],
      }),
    ).toBeNull();
  });
});
