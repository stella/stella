import { expect, test } from "bun:test";

import { plCommonCourtRulingKeys } from "@/api/handlers/case-law/ingestion/adapters/pl-common-court-ruling-keys";

test("a key needs the date and the type: a signature alone names no judgment", () => {
  expect(
    plCommonCourtRulingKeys({
      caseNumber: "II Ca 236/18",
      court: "Sąd Okręgowy w Świdnicy",
      decisionDate: undefined,
      decisionType: "postanowienie",
    }),
  ).toEqual([]);
});
