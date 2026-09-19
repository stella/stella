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

/** When the publisher's own total was read. */
const OBSERVED_AT = "2026-09-01T00:00:00.000Z";

/** When the corpus was counted, which is a separate sweep and a separate date. */
const COUNTED_AT = "2026-09-17T00:00:00.000Z";

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
    stored: 996,
    storedAsOf: COUNTED_AT,
    reported: 1000,
    reportedAsOf: OBSERVED_AT,
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

/** A publisher total exists; nobody has counted what the corpus holds of it. */
const NEVER_COUNTED: CaseLawCoverageSource = {
  adapterKey: "cz-nss",
  name: "Nejvyšší správní soud",
  publicHomeUrl: "https://vyhledavac.nssoud.cz/",
  health: "current",
  lastSyncAt: OBSERVED_AT,
  addedLastWeek: 0,
  completeness: { state: "not-counted-yet" },
};

const COVERAGE: CaseLawCoverage = {
  generatedAt: "2026-09-19T08:00:00.000Z",
  totals: {
    searchable: 4_200_000,
    stored: { decisions: 4_500_000, asOf: COUNTED_AT },
  },
  countries: [
    {
      availability: "searchable",
      country: "CZE",
      health: "delayed",
      stored: { decisions: 1996, asOf: COUNTED_AT },
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
        storedAsOf: COUNTED_AT,
        staleSources: 0,
        notMeasuredSources: 1,
        notCountedSources: 1,
      },
      sources: [NEARLY_COMPLETE, NEVER_MEASURED, NEVER_COUNTED],
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

  test("a stored figure states when it was counted", () => {
    const markup = render(<CaseLawCoveragePage coverage={COVERAGE} />);

    // The count is taken on the ingestion side, so the figure is only as
    // current as its last sweep, and the page says which day that was.
    expect(markup).toContain("Counted Sep 17, 2026");
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

  test("a source nobody has counted is stated, and adds no zero to the ratio", () => {
    const markup = render(<CaseLawCoveragePage coverage={COVERAGE} />);

    expect(markup).toContain(messages.caseLaw.coverage.notCountedYet);
    expect(markup).toContain("1 source not counted");
    // The ratio is still the one measured source's 996/1000; a source with no
    // count of its own would drag it to 50 % if it were folded in as a zero.
    expect(markup).toContain("99%");
    expect(markup).not.toContain("50%");
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
              stored: { decisions: 40, asOf: null },
              addedLastWeek: 0,
              completeness: {
                measuredSources: 0,
                stored: 0,
                reported: 0,
                storedAsOf: null,
                staleSources: 0,
                notMeasuredSources: 1,
                notCountedSources: 0,
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
