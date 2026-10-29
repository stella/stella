import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import type {
  Decision,
  DecisionRenderContext,
} from "@/features/case-law/components/decision-cells";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/law/eu/cases" });

const { cleanup, render, waitFor } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { createTranslator } = await import("use-intl/core");
const { NO_QUERY_MARK_TOKENS } =
  await import("@stll/decision-reader/query-marks");
const { DECISION_IDENTIFIER_TYPES } =
  await import("@stll/legal-ast/decision-identifier");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { renderDecisionCell } = await import("./decision-columns");
const { DECISION_COLUMN_IDS } = await import("./decision-columns.logic");
const messages = (await import("@/i18n/langs/en.json")).default;

afterEach(() => {
  cleanup();
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

const version = (language: string) => ({
  caseNumber: "C-244/24",
  country: "EU",
  court: "Court of Justice",
  decisionDate: "2024-06-20",
  id: `00000000-0000-4000-8000-0000000000${language === "bg" ? "01" : "02"}`,
  language,
  slug: `c-244-24-${language}`,
});

/**
 * A row standing for its Bulgarian version while the reader reads English:
 * the shape a listing produced before it ranked versions, and the shape a
 * search produces when the Bulgarian text is what matched.
 */
const ROW: Decision = {
  id: version("bg").id,
  caseNumber: "C-244/24",
  caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
  slug: "c-244-24-bg",
  ecli: null,
  court: "Court of Justice",
  country: "EU",
  language: "bg",
  languageAlternates: [version("bg"), version("en")],
  decisionDate: "2024-06-20",
  decisionType: "judgment",
  headnote: { type: "absent", reason: "not_published" },
  citationCount: 3,
};

const contextFor = (
  searchQuery: string | undefined,
): DecisionRenderContext => ({
  identityLineFields: [],
  queryTokens: NO_QUERY_MARK_TOKENS,
  searchQuery,
  contentMode: "tight",
  expandedHeadnoteIds: new Set(),
  onToggleHeadnote: () => undefined,
});

/** Every column of the shared model, drawn for one row, as one table row. */
const renderRow = async (searchQuery: string | undefined) => {
  const context = contextFor(searchQuery);
  const rootRoute = router.createRootRoute({
    component: () => (
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <div data-testid="row">
            {DECISION_COLUMN_IDS.map((column) => (
              <div key={column}>
                {renderDecisionCell({ column, decision: ROW, context })}
              </div>
            ))}
          </div>
        </FormattingProvider>
      </IntlProvider>
    ),
  });
  const appRouter = router.createRouter({
    history: router.createMemoryHistory({ initialEntries: ["/law/eu/cases"] }),
    isServer: false,
    routeTree: rootRoute,
  });
  await appRouter.load();
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <router.RouterProvider router={appRouter} />
    </QueryClientProvider>,
  );
  return await waitFor(() => view.getByTestId("row").textContent ?? "");
};

const MATCHED_IN_BULGARIAN = createTranslator({ locale: "en", messages })(
  "caseLaw.languages.matchedIn",
  { language: "Bulgarian" },
);

describe("the matched-language line across every decision column", () => {
  // The control: the fixture reaches the line when a text query matched.
  test("a text query that matched another version names it", async () => {
    expect(await renderRow("planet-49")).toContain(MATCHED_IN_BULGARIAN);
  });

  test.each([undefined, "", "   "])(
    "a listing with no text query (%j) names no matched language",
    async (searchQuery) => {
      const text = await renderRow(searchQuery);
      expect(text).toContain("C-244/24");
      expect(text).not.toContain(MATCHED_IN_BULGARIAN);
    },
  );
});
