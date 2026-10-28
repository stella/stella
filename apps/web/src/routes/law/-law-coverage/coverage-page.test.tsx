import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { getByRole } from "@testing-library/dom";
import { describe, expect, setSystemTime, test } from "bun:test";
import { IntlProvider } from "use-intl";

import { caseLawCoverageAnchor } from "@/features/case-law/case-law-jurisdiction";
import { FormattingProvider } from "@/i18n/formatting-context";
import messages from "@/i18n/langs/en.json";
import { CaseLawCoveragePage } from "@/routes/law/-law-coverage/coverage-page";
import type {
  CaseLawCoverage,
  CaseLawCoverageCountry,
  CaseLawCoverageSource,
} from "@/routes/law/-law-coverage/coverage.logic";
import { unregisterDomEnvironment } from "@/test-dom-environment";

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
  decisionYearFrom: 1993,
  decisionYearTo: 2026,
  pendingTextCount: 0,
  storedDecisions: 996,
  publishedDecisions: 990,
  courts: [{ court: "Nejvyšší soud", decisions: 990 }],
  knownGaps: { type: "not_reconciled", reason: "No date slices" },
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
  decisionYearFrom: 1993,
  decisionYearTo: 2026,
  pendingTextCount: 0,
  storedDecisions: 4321,
  publishedDecisions: 4200,
  courts: [{ court: "Ústavní soud", decisions: 4200 }],
  knownGaps: { type: "not_reconciled", reason: "No date slices" },
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
  decisionYearFrom: 1993,
  decisionYearTo: 2026,
  pendingTextCount: 0,
  storedDecisions: null,
  publishedDecisions: 600,
  courts: [{ court: "Nejvyšší správní soud", decisions: 600 }],
  knownGaps: { type: "not_reconciled", reason: "No date slices" },
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
  provisionProcessing: [],
  generatedAt: "2026-09-19T08:00:00.000Z",
  totals: {
    addedLastWeek: 12,
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
    // Stored completeness counts stay separate from the searchable total.
    expect(markup).not.toContain("4,500,000");
    expect(markup).not.toContain("8,700,000");
  });

  test("a source counts its published court rows separately from stored completeness", () => {
    const markup = render(<CaseLawCoveragePage coverage={COVERAGE} />);

    expect(markup).toContain(">990<");
    expect(markup).toContain(">4,200<");
    expect(markup).toContain(">600<");
    expect(markup).toContain(messages.caseLaw.coverage.notCountedYet);
    // The sweep's date is the page's own, stated once at the top, not per row.
    expect(markup).not.toContain("Sep 17, 2026");
  });

  test("the legend names each country's count without a share", () => {
    const markup = render(
      <CaseLawCoveragePage
        coverage={{
          ...COVERAGE,
          totals: { ...COVERAGE.totals, searchable: 3800 },
        }}
      />,
    );

    expect(markup).toContain("1,900");
    expect(markup).not.toContain("50%");
  });

  test("a country's rim states its totals, and freshness stays with each source", () => {
    const markup = render(
      <CaseLawCoveragePage
        coverage={{
          ...COVERAGE,
          countries: [{ ...CZECHIA, health: "stalled" }],
        }}
      />,
    );

    expect(markup).toContain(messages.caseLaw.corpusStatus.newLast7Days);
    expect(markup).not.toContain(messages.caseLaw.coverage.healthStalled);
  });

  test("a corpus 99.6 % of the way there prints 99, never 100", () => {
    const markup = render(<CaseLawCoveragePage coverage={COVERAGE} />);

    expect(markup).toContain("99%");
    expect(markup).not.toMatch(/>100%</u);
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

  test("source rows omit decision years, pending texts and gap details", () => {
    const markup = render(
      <CaseLawCoveragePage
        coverage={{
          ...COVERAGE,
          countries: [
            {
              ...CZECHIA,
              sources: [
                {
                  ...NEARLY_COMPLETE,
                  decisionYearFrom: 1958,
                  decisionYearTo: 2011,
                  pendingTextCount: 1234,
                  knownGaps: {
                    type: "reconciled",
                    summary: { missing: 11, shortSlices: 1, unlistedSlices: 0 },
                    years: [
                      { year: 1969, type: "gaps", missing: 11, shortSlices: 1 },
                    ],
                  },
                },
              ],
            },
          ],
        }}
      />,
    );

    expect(markup).not.toContain("1958–2011");
    expect(markup).not.toContain("1,234");
    expect(markup).not.toContain("Decision years:");
    expect(markup).not.toContain("Pending texts:");
    expect(markup).not.toContain("Known gaps:");
  });

  test("freshness is a word, with the dot only beside it", () => {
    const markup = render(<CaseLawCoveragePage coverage={COVERAGE} />);

    expect(markup).toContain(messages.caseLaw.coverage.healthDelayed);
    expect(markup).toContain(messages.caseLaw.coverage.healthCurrent);
  });

  test("each country is a section a link from elsewhere can land on", () => {
    const markup = render(<CaseLawCoveragePage coverage={COVERAGE} />);

    // The badge beside the search box links here by this fragment.
    for (const { country } of COVERAGE.countries) {
      expect(markup).toContain(`id="${caseLawCoverageAnchor(country)}"`);
    }
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

    expect(markup).not.toContain("+12");
    expect(markup).not.toContain(">0<");
  });

  test("each country has one source table with collapsed court rows that include every court", () => {
    const source = {
      ...NEARLY_COMPLETE,
      publishedDecisions: 1000,
      courts: [
        { court: "Nejvyšší soud", decisions: 500 },
        { court: "Okresní soud v Benešově", decisions: 20 },
        { court: null, decisions: 480 },
      ],
    };
    const markup = render(
      <CaseLawCoveragePage
        coverage={{
          ...COVERAGE,
          countries: [{ ...CZECHIA, sources: [source] }],
        }}
      />,
    );

    expect(markup.match(/<table[ >]/gu)).toHaveLength(1);
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("aria-controls=");
    expect(markup).toMatch(/<tbody[^>]*hidden=""/u);
    expect(markup).toContain("Okresní soud v Benešově");
    expect(markup).toContain("Other courts");
    expect(markup).toContain(">480<");
    expect(markup).not.toContain(messages.caseLaw.coverage.courtsHeading);
  });

  test("court toggles have distinct accessible names containing their source names", async () => {
    GlobalRegistrator.register();
    const { document: testDocument } = globalThis;
    try {
      // safe-html: React renderToStaticMarkup escapes the coverage fixture values.
      testDocument.body.innerHTML = render(
        <CaseLawCoveragePage coverage={COVERAGE} />,
      );

      const first = getByRole(testDocument.body, "button", {
        name: `${messages.common.court} ${NEARLY_COMPLETE.name}`,
      });
      const second = getByRole(testDocument.body, "button", {
        name: `${messages.common.court} ${NEVER_MEASURED.name}`,
      });
      expect(first).not.toBe(second);
    } finally {
      await unregisterDomEnvironment();
    }
  });

  test("an unavailable country court breakdown leaves no separate section", () => {
    const markup = render(
      <CaseLawCoveragePage
        coverage={{ ...COVERAGE, countries: [{ ...CZECHIA, courts: null }] }}
      />,
    );
    expect(markup).not.toContain(messages.caseLaw.coverage.courtsHeading);
    expect(markup).not.toContain("court=");
  });

  test("relative times follow the formatting locale, not the message language", () => {
    // Pinned to when the figures were generated, so the sync instant stays
    // weeks old rather than drifting into "last month".
    setSystemTime(new Date(COVERAGE.generatedAt));
    try {
      const english = render(<CaseLawCoveragePage coverage={COVERAGE} />);
      const czech = render(<CaseLawCoveragePage coverage={COVERAGE} />, "cs");

      // The same sync instant, formatted twice: once per locale. Were the
      // string read from the store instead of the context, both renders
      // would agree.
      expect(english).toContain("ago");
      expect(czech).not.toContain("ago");
    } finally {
      setSystemTime();
    }
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
