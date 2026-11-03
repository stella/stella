import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { SEARCH_TOTAL_TYPE } from "@stll/api-contract/search";

import messages from "@/i18n/langs/en.json";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/law/cases" });
const { cleanup, render } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { CaseLawResultsSummary } =
  await import("@/features/case-law/components/case-law-results-summary");

afterEach(cleanup);
afterAll(async () => await unregisterDomEnvironment());

const renderHeading = (
  props: Partial<Parameters<typeof CaseLawResultsSummary>[0]>,
) =>
  render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <FormattingProvider locale="en" timeZone="UTC">
        <CaseLawResultsSummary
          exactCount={0}
          order={{ type: "search", sort: "relevance" }}
          isRefreshing={false}
          page={1}
          relaxedHitCount={0}
          total={{ type: SEARCH_TOTAL_TYPE.EXACT, count: 0 }}
          {...props}
        />
      </FormattingProvider>
    </IntlProvider>,
  );

test("reports exact and appended partial matches separately", () => {
  const view = renderHeading({ relaxedHitCount: 3 });
  expect(
    view.getByText("Page 1 · 0 exact matches · 3 partial matches on this page"),
  ).toBeTruthy();
});

test("keeps an estimated exact-match total approximate beside partial matches", () => {
  const view = renderHeading({
    relaxedHitCount: 3,
    total: { type: SEARCH_TOTAL_TYPE.ESTIMATE, count: 120 },
  });
  expect(
    view.getByText(
      "Page 1 · about 120 exact matches · 3 partial matches on this page",
    ),
  ).toBeTruthy();
});

test("keeps the ordinary result total when no partial matches were appended", () => {
  const view = renderHeading({});
  expect(view.getByText("Page 1 · 0 results")).toBeTruthy();
});

test.each([
  [1, "Page 1 · 1 partial match on this page"],
  [3, "Page 1 · 3 partial matches on this page"],
] as const)(
  "reports %i partial matches when the exact total is uncounted",
  (count, text) => {
    const view = renderHeading({
      relaxedHitCount: count,
      total: { type: SEARCH_TOTAL_TYPE.NOT_COUNTED },
    });
    expect(view.getByText(text)).toBeTruthy();
  },
);

test("keeps the page without inventing a total when no partial matches were appended", () => {
  const view = renderHeading({
    total: { type: SEARCH_TOTAL_TYPE.NOT_COUNTED },
  });
  expect(view.getByText("Page 1")).toBeTruthy();
});

test("keeps the page while its partial-match count is unavailable", () => {
  const view = renderHeading({
    relaxedHitCount: undefined,
    total: { type: SEARCH_TOTAL_TYPE.NOT_COUNTED },
  });
  expect(view.getByText("Page 1")).toBeTruthy();
});

test("keeps the displayed count busy while replacement results are pending", () => {
  const view = renderHeading({ isRefreshing: true, relaxedHitCount: 3 });
  const text = view.getByText(
    "Page 1 · 0 exact matches · 3 partial matches on this page",
  );
  expect(text.parentElement?.getAttribute("aria-busy")).toBe("true");
});

test.each([
  ["newest", messages.caseLaw.newestDecisions],
  ["oldest", messages.caseLaw.oldestDecisions],
] as const)(
  "heads the %s-first listing with the order it is read in",
  (sort, heading) => {
    const view = renderHeading({ order: { type: "browse", sort } });
    expect(view.getByRole("heading").textContent).toBe(heading);
  },
);

test("keeps the court choice for an identifier shared by several decisions", () => {
  const view = renderHeading({
    exactCount: 2,
    order: { type: "identity" },
  });
  expect(
    view.getByText("2 decisions share this case number. Pick the court."),
  ).toBeTruthy();
});
