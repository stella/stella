import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import { FormattingProvider } from "@/i18n/formatting-context";
import messages from "@/i18n/langs/en.json";
import { CaseLawCoveragePage } from "@/routes/law/-law-coverage/coverage-page";
import type {
  CaseLawCoverage,
  CaseLawCoverageCountry,
  CaseLawCoverageSource,
} from "@/routes/law/-law-coverage/coverage.logic";

const rootRoute = createRootRoute();

/**
 * A router for a static render: the page links every country and court to
 * the case list, so a `Link` needs a route to resolve its href against.
 * Nothing here matches or loads, which keeps the render synchronous.
 */
const testRouter = () =>
  createRouter({
    history: createMemoryHistory({ initialEntries: ["/law/coverage"] }),
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: "/law/cases" }),
    ]),
  });

const render = (node: ReactNode, locale = "en"): string =>
  renderToStaticMarkup(
    <RouterContextProvider router={testRouter()}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider locale={locale} timeZone="UTC">
          {node}
        </FormattingProvider>
      </IntlProvider>
    </RouterContextProvider>,
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

const CZECHIA: CaseLawCoverageCountry = {
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
};

const COVERAGE: CaseLawCoverage = {
  generatedAt: "2026-09-19T08:00:00.000Z",
  totals: {
    searchable: 4_200_000,
    stored: { decisions: 4_500_000, asOf: COUNTED_AT },
  },
  countries: [CZECHIA],
};

/** A country the public search cannot reach yet, with nothing counted. */
const IN_PREPARATION: CaseLawCoverageCountry = {
  availability: "in-preparation",
  country: "SVK",
  health: "current",
  stored: { decisions: 0, asOf: null },
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
  sources: [{ ...NEVER_MEASURED, adapterKey: "sk-us", health: "current" }],
};

describe("the coverage page states what it counts", () => {
  test("the page leads with what a search can find, and only that", () => {
    const markup = render(<CaseLawCoveragePage coverage={COVERAGE} />);

    expect(markup).toContain("4,200,000");
    // What is held but not searchable is a source's own figure, in its
    // completeness column; neither it nor a sum of the two heads the page.
    expect(markup).not.toContain("4,500,000");
    expect(markup).not.toContain("8,700,000");
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
  });

  test("a source nobody has counted is stated, and adds no zero to the ratio", () => {
    const markup = render(<CaseLawCoveragePage coverage={COVERAGE} />);

    expect(markup).toContain(messages.caseLaw.coverage.notCountedYet);
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
        coverage={{ ...COVERAGE, countries: [IN_PREPARATION] }}
      />,
    );

    expect(markup).toContain(messages.caseLaw.coverage.inPreparation);
    // No measurable ratio, and no zero standing in for one: the source says
    // it was never measured. Matched as a figure, not a substring: a column
    // width like "40%" is not a ratio.
    expect(markup).not.toMatch(/[^\d]0%/u);
    expect(markup).toContain(messages.caseLaw.coverage.notMeasuredYet);
    // No index to break down by court.
    expect(markup).not.toContain(messages.caseLaw.coverage.courtsHeading);
  });

  test("a week the endpoint could not read prints as none, never as zero", () => {
    const markup = render(
      <CaseLawCoveragePage
        coverage={{
          ...COVERAGE,
          countries: [
            {
              ...CZECHIA,
              addedLastWeek: null,
              sources: [{ ...NEARLY_COMPLETE, addedLastWeek: null }],
            },
          ],
        }}
      />,
    );

    // The court row still states its own week; only the source's is unknown.
    expect(markup).toContain("+12");
    expect(markup).not.toContain(">0<");
  });

  test("the courts beyond the listed ones close the breakdown as one row", () => {
    const markup = render(
      <CaseLawCoveragePage
        coverage={{
          ...COVERAGE,
          countries: [
            {
              ...CZECHIA,
              courts: [
                ...(CZECHIA.courts ?? []),
                { type: "unlisted", tier: "other", listed: 2, decisions: 480 },
              ],
            },
          ],
        }}
      />,
    );

    // The row names how many courts were listed, carries the rest of the
    // count, and states no activity, because none was read for it.
    expect(markup).toContain("Courts beyond the 2 largest");
    expect(markup).toContain("480");
  });

  test("a court breakdown the endpoint could not read says so", () => {
    const markup = render(
      <CaseLawCoveragePage
        coverage={{ ...COVERAGE, countries: [{ ...CZECHIA, courts: null }] }}
      />,
    );

    expect(markup).toContain(messages.caseLaw.coverage.courtsUnavailable);
    expect(markup).not.toContain(messages.caseLaw.courtTiers.supreme);
  });

  test("relative times follow the formatting locale, not the message language", () => {
    const english = render(<CaseLawCoveragePage coverage={COVERAGE} />);
    const czech = render(<CaseLawCoveragePage coverage={COVERAGE} />, "cs");

    // The same sync instant, formatted twice: once per locale. Were the string
    // read from the store instead of the context, both renders would agree.
    expect(english).toContain("ago");
    expect(czech).not.toContain("ago");
  });

  test("figures the endpoint cannot state read as an empty page, not as zeros", () => {
    const markup = render(
      <CaseLawCoveragePage coverage={{ message: "Coverage is unavailable" }} />,
    );

    expect(markup).toContain(messages.caseLaw.coverage.unavailable);
    // Degrading to zeros would publish a corpus nobody measured.
    expect(markup).not.toContain("4,200,000");
    expect(markup).not.toContain("<table");
  });
});
