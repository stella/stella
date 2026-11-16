import { describe, expect, test } from "bun:test";

import { preferredLanguageVersionId } from "@/api/lib/case-law/language-alternates";

const version = (id: string, language: string) => ({
  caseNumber: "C-51/17",
  country: "EU",
  court: "Court of Justice",
  decisionDate: "2018-09-20",
  id,
  language,
  slug: id,
});

const alternates = [version("pl-id", "pl"), version("cs-id", "cs")];

describe("preferredLanguageVersionId", () => {
  test("names the version in the preferred language", () => {
    expect(
      preferredLanguageVersionId({
        id: "pl-id",
        language: "pl",
        alternates,
        preferred: "cs",
      }),
    ).toBe("cs-id");
  });

  test("keeps a decision already in that language", () => {
    expect(
      preferredLanguageVersionId({
        id: "other-cs-id",
        language: "cs",
        alternates,
        preferred: "cs",
      }),
    ).toBeUndefined();
  });

  test("names no alternate for a decision outside its public group", () => {
    expect(
      preferredLanguageVersionId({
        id: "restricted-id",
        language: "pl",
        alternates,
        preferred: "cs",
      }),
    ).toBeUndefined();
  });

  test("answers nothing when no version is in that language", () => {
    expect(
      preferredLanguageVersionId({
        id: "pl-id",
        language: "pl",
        alternates,
        preferred: "de",
      }),
    ).toBeUndefined();
  });
});
