import { renderToStaticMarkup } from "react-dom/server";

import { expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import type { DecisionReviews } from "@stll/api-contract/case-law-reviews";

import { FormattingProvider } from "@/i18n/formatting-context";
import en from "@/i18n/langs/en.json";

import { DecisionAppealReviews } from "./decision-appeal-reviews";

const reviews = {
  status: "unknown",
  basis: "available_corpus",
  reviewedBy: [],
  reviewedByTruncated: false,
  reviewsTruncated: false,
  reviews: [
    {
      reviewingDecisionId: "00000000-0000-4000-8000-000000000701",
      reviewingCaseNumber: "SYN 2/2026",
      reviewingCourt: "Synthetic reviewing court",
      reviewedDecisionId: null,
      reviewedCaseNumber: "SYN 1/2026",
      reviewedCourt: "Synthetic regional court",
      reviewedDecisionDate: "2026-01-16",
      outcome: "unknown",
      source: "metadata",
      evidenceStatus: "conflict",
    },
  ],
} as const satisfies DecisionReviews;

const renderReviews = (country: string, evidence: DecisionReviews = reviews) =>
  renderToStaticMarkup(
    <IntlProvider locale="en" messages={en} timeZone="UTC">
      <FormattingProvider locale="en" timeZone="UTC">
        <DecisionAppealReviews country={country} reviews={evidence} />
      </FormattingProvider>
    </IntlProvider>,
  );

test("unresolved review targets retain court and calendar date", () => {
  const html = renderReviews("CZE");
  expect(html).toContain("Synthetic regional court");
  expect(html).toContain("SYN 1/2026");
  expect(html).toContain('dateTime="2026-01-16"');
  expect(html).toContain("Jan 16, 2026");
  expect(html).not.toContain("href=");
});

test("incomplete review evidence does not assert a publisher-opening disagreement", () => {
  const html = renderReviews("CZE");
  expect(html).toContain("The review evidence is incomplete or conflicting.");
  expect(html).not.toContain(
    "publisher metadata and opening paragraph disagree",
  );
  expect(renderReviews("SVK")).toBe("");
});

test("outgoing review targets do not imply this decision has been reviewed", () => {
  const html = renderReviews("CZE", {
    status: "none_found",
    reason: "no_link_in_corpus",
    basis: "available_corpus",
    reviewedBy: [],
    reviewedByTruncated: false,
    reviews: reviews.reviews,
    reviewsTruncated: false,
  });
  expect(html).toContain("No reviewing decision found");
  expect(html).toContain(
    "No decision reviewing this decision was found in the available corpus.",
  );
  expect(html).toContain("SYN 1/2026");
});
