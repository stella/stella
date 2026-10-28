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
import { unregisterDomEnvironment } from "@/test-dom-environment";

import {
  COVERAGE,
  CZECHIA,
  IN_PREPARATION,
  NEARLY_COMPLETE,
  NEVER_MEASURED,
} from "./coverage-page.fixture";

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
      createRoute({ getParentRoute: () => rootRoute, path: "/law/coverage" }),
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

describe("the coverage page states what it counts", () => {
  test("the hero labels searchable decisions, the server week and current sources", () => {
    const markup = render(
      <CaseLawCoveragePage
        coverage={{
          ...COVERAGE,
          totals: { ...COVERAGE.totals, addedLastWeek: 567 },
        }}
      />,
    );

    expect(markup).toContain("4,200,000");
    expect(markup).toContain("decisions across 1 jurisdiction");
    expect(markup).toContain("+567");
    expect(markup).toContain("2 of 3");
    expect(markup).toContain("Sources up to date");
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

  test("the legend orders jurisdictions by volume with unique proportional bars", () => {
    const markup = render(
      <CaseLawCoveragePage
        coverage={{
          ...COVERAGE,
          countries: [{ ...CZECHIA, country: "GBR", searchable: 950 }, CZECHIA],
        }}
      />,
    );
    const legend = markup.slice(markup.indexOf("<ul"), markup.indexOf("</ul>"));
    expect(legend.indexOf("--chart-2")).toBeLessThan(
      legend.indexOf("--chart-4"),
    );
    expect(legend.match(/background-color:var\(--chart-\d\)/gu)).toHaveLength(
      2,
    );
    expect(legend).toContain("width:50%");
    expect(legend).toContain("width:100%");
  });

  test("the card header summarizes freshness and rows flag only exceptions", () => {
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

  test("current sources are summarized once in the card header", () => {
    const markup = render(
      <CaseLawCoveragePage
        coverage={{
          ...COVERAGE,
          countries: [{ ...CZECHIA, sources: [NEARLY_COMPLETE] }],
        }}
      />,
    );
    expect(markup.match(/All sources up to date/gu)).toHaveLength(1);
    expect(markup).not.toContain(
      `>${messages.caseLaw.coverage.healthCurrent}<`,
    );
  });

  test("a corpus 99.6 % of the way there prints 99, never 100", () => {
    const markup = render(<CaseLawCoveragePage coverage={COVERAGE} />);

    expect(markup).toContain('aria-valuetext="99%"');
    expect(markup).not.toContain(">99%<");
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
    expect(markup).toContain('aria-valuetext="99%"');
    expect(markup).not.toContain(">99%<");
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
    expect(markup).not.toContain(
      `>${messages.caseLaw.coverage.healthCurrent}<`,
    );
    expect(markup).toContain("1 source needs attention");
  });

  test("each country is a section a link from elsewhere can land on", () => {
    const markup = render(<CaseLawCoveragePage coverage={COVERAGE} />);

    // The badge beside the search box links here by this fragment.
    for (const { country } of COVERAGE.countries) {
      expect(markup).toContain(`id="${caseLawCoverageAnchor(country)}"`);
    }
  });

  test("completeness has a keyboard reachable column-header explanation", () => {
    const markup = render(<CaseLawCoveragePage coverage={COVERAGE} />);

    expect(markup).toContain('data-slot="tooltip-trigger"');
    expect(markup).toContain('type="button"');
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
    expect(markup).not.toContain('aria-valuenow="0"');
    expect(markup).toContain(messages.caseLaw.coverage.notMeasuredYet);
    // No index to break down by court.
    expect(markup).not.toContain(messages.caseLaw.coverage.courtsHeading);
  });

  test("a week the endpoint could not read prints as none, never as zero", () => {
    const markup = render(
      <CaseLawCoveragePage
        coverage={{
          ...COVERAGE,
          totals: { ...COVERAGE.totals, addedLastWeek: null },
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
    expect(markup).not.toContain(">+0<");
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
