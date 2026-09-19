import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import { FormattingProvider } from "@/i18n/formatting-context";
import messages from "@/i18n/langs/en.json";
import { CaseLawCoveragePage } from "@/routes/law/-law-coverage/coverage-page";
import type {
  CaseLawCoverage,
  CaseLawCoverageSource,
} from "@/routes/law/-law-coverage/coverage.logic";

const render = (node: ReactNode): string =>
  renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <FormattingProvider locale="en" timeZone="UTC">
        {node}
      </FormattingProvider>
    </IntlProvider>,
  );

const OBSERVED_AT = "2026-09-01T00:00:00.000Z";

/**
 * A source four decisions in a thousand short of the publisher's total: the
 * boundary the displayed percentage must never round up through.
 */
const NEARLY_COMPLETE: CaseLawCoverageSource = {
  adapterKey: "cz-ns",
  name: "Nejvyšší soud",
  publicHomeUrl: "https://rozhodnuti.nsoud.cz/",
  health: "current",
  lastSyncAt: OBSERVED_AT,
  addedLastWeek: 12,
  completeness: {
    state: "measured",
    stored: { precision: "exact", decisions: 996 },
    reported: 1000,
    asOf: OBSERVED_AT,
    reportedBy: "publisher",
  },
};

const NEVER_MEASURED: CaseLawCoverageSource = {
  adapterKey: "cz-us",
  name: "Ústavní soud",
  publicHomeUrl: "https://nalus.usoud.cz/",
  health: "delayed",
  lastSyncAt: OBSERVED_AT,
  addedLastWeek: 0,
  completeness: { state: "not-measured-yet" },
};

const COVERAGE: CaseLawCoverage = {
  generatedAt: "2026-09-19T08:00:00.000Z",
  totals: {
    searchable: 4_200_000,
    stored: { precision: "at-least", decisions: 4_500_000 },
  },
  countries: [
    {
      availability: "searchable",
      country: "CZE",
      health: "delayed",
      stored: { precision: "exact", decisions: 1996 },
      addedLastWeek: 12,
      searchable: 1900,
      decisionYearFrom: 1993,
      decisionYearTo: 2026,
      courts: [
        {
          type: "court",
          court: "Nejvyšší soud",
          courtAbbreviation: "NS",
          tier: "supreme",
          decisions: 1900,
          addedLastDay: 2,
          addedLastWeek: 12,
          updatedAt: OBSERVED_AT,
        },
      ],
      completeness: {
        measuredSources: 1,
        stored: 996,
        reported: 1000,
        storedPrecision: "exact",
        staleSources: 0,
        unmeasuredSources: 1,
        uncountedSources: 0,
      },
      sources: [NEARLY_COMPLETE, NEVER_MEASURED],
    },
  ],
};

describe("the coverage page states what it counts", () => {
  test("searchable and stored are two figures, never one sum", () => {
    const markup = render(<CaseLawCoveragePage coverage={COVERAGE} />);

    expect(markup).toContain("4,200,000");
    expect(markup).toContain("4,500,000");
    // 8,700,000 would be the sum of two populations that overlap.
    expect(markup).not.toContain("8,700,000");
    expect(markup).toContain(messages.caseLaw.coverage.searchableHint);
    expect(markup).toContain(messages.caseLaw.coverage.storedHint);
  });

  test("a count that is only a floor says so rather than printing as exact", () => {
    const markup = render(<CaseLawCoveragePage coverage={COVERAGE} />);

    expect(markup).toContain("at least 4,500,000");
  });

  test("a corpus 99.6 % of the way there prints 99, never 100", () => {
    const markup = render(<CaseLawCoveragePage coverage={COVERAGE} />);

    expect(markup).toContain("99%");
    expect(markup).not.toContain("100%");
  });

  test("a source nobody has measured is stated, not folded into the ratio", () => {
    const markup = render(<CaseLawCoveragePage coverage={COVERAGE} />);

    expect(markup).toContain(messages.caseLaw.coverage.notMeasuredYet);
    expect(markup).toContain("1 source not measured");
  });

  test("freshness is a word, with the dot only beside it", () => {
    const markup = render(<CaseLawCoveragePage coverage={COVERAGE} />);

    expect(markup).toContain(messages.caseLaw.coverage.healthDelayed);
    expect(markup).toContain(messages.caseLaw.coverage.healthCurrent);
  });

  test("a publisher's own count is named as such", () => {
    const markup = render(<CaseLawCoveragePage coverage={COVERAGE} />);

    // The apostrophe arrives HTML-escaped, so the assertion takes the rest.
    expect(markup).toContain("own count");
  });

  test("a country still in preparation is reported, not hidden", () => {
    const markup = render(
      <CaseLawCoveragePage
        coverage={{
          ...COVERAGE,
          countries: [
            {
              availability: "in-preparation",
              country: "HUN",
              health: "unknown",
              stored: { precision: "exact", decisions: 40 },
              addedLastWeek: 0,
              completeness: {
                measuredSources: 0,
                stored: 0,
                reported: 0,
                storedPrecision: "exact",
                staleSources: 0,
                unmeasuredSources: 1,
                uncountedSources: 0,
              },
              sources: [NEVER_MEASURED],
            },
          ],
        }}
      />,
    );

    expect(markup).toContain(messages.caseLaw.coverage.inPreparation);
    // No measurable ratio, and no zero standing in for one.
    expect(markup).not.toContain("0%");
  });

  test("figures the endpoint cannot state read as an empty page, not as zeros", () => {
    const markup = render(
      <CaseLawCoveragePage coverage={{ message: "Coverage is unavailable" }} />,
    );

    expect(markup).toContain(messages.caseLaw.coverage.unavailable);
    // Degrading to zeros would publish a corpus nobody measured.
    expect(markup).not.toContain(messages.caseLaw.coverage.searchableHint);
    expect(markup).not.toContain("<table");
  });
});
