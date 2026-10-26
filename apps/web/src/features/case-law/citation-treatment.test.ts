import { expect, test } from "bun:test";

import { hasIncomingCitations } from "./citation-treatment";
import type { DecisionCitationSummary } from "./citation-treatment";

const counts = {
  negative: 0,
  mixed: 0,
  neutral: 0,
  positive: 0,
  supportive: 0,
  unclassified: 0,
};

const summary = (
  incoming: number,
  precision: DecisionCitationSummary["precision"],
) =>
  ({
    precision,
    incoming: { ...counts, neutral: incoming },
    incomingByYear: [],
    outgoing: { ...counts, positive: 3 },
  }) satisfies DecisionCitationSummary;

test("a decision is cited later once any later decision cites it", () => {
  expect(hasIncomingCitations(summary(0, { status: "exact" }))).toBe(false);
  expect(hasIncomingCitations(summary(1, { status: "exact" }))).toBe(true);
  // Its own citations of earlier decisions are not later treatment.
  expect(
    hasIncomingCitations(
      summary(0, {
        status: "bounded",
        capped: { incoming: false, outgoing: true },
      }),
    ),
  ).toBe(false);
  // A capped count is a lower bound that already passed zero.
  expect(
    hasIncomingCitations(
      summary(0, {
        status: "bounded",
        capped: { incoming: true, outgoing: false },
      }),
    ),
  ).toBe(true);
});
