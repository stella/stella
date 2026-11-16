import { describe, expect, test } from "bun:test";

import { courtCitationGrammarOf } from "@stll/api-contract/court-citation-directory";

import { PL_NCOURT_COURT_NAMES } from "@/api/handlers/case-law/ingestion/adapters/pl-ncourt-courts";

/** The common-court tiers the publisher's court ids encode. */
const COMMON_COURT_RE = /^Sąd (Apelacyjny|Okręgowy|Rejonowy) /u;

describe("the publisher's common courts are the citation directory's", () => {
  test("every court the adapter stores decisions under is a Polish directory court, and every directory common court is one the adapter names", () => {
    const stored = [...new Set(Object.values(PL_NCOURT_COURT_NAMES))];
    const directory = (courtCitationGrammarOf("POL")?.courts ?? [])
      .map(({ name }) => name)
      .filter((name) => COMMON_COURT_RE.test(name));

    expect(stored.length).toBeGreaterThan(300);
    expect(directory.toSorted()).toEqual(stored.toSorted());
  });
});
