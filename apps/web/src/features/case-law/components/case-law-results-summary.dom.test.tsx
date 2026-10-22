import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { SEARCH_TOTAL_TYPE } from "@stll/api-contract/search";

import messages from "@/i18n/langs/en.json";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/law/cases" });
const { cleanup, render } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { CaseLawResultsSummaryText } =
  await import("@/features/case-law/components/case-law-results-summary");

afterEach(cleanup);
afterAll(async () => await unregisterDomEnvironment());

const renderHeading = (
  relaxedHitCount: number,
  total?:
    | { type: typeof SEARCH_TOTAL_TYPE.EXACT; count: number }
    | { type: typeof SEARCH_TOTAL_TYPE.ESTIMATE; count: number },
) => {
  const resultTotal = total ?? {
    type: SEARCH_TOTAL_TYPE.EXACT,
    count: 0,
  };
  return render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <FormattingProvider locale="en" timeZone="UTC">
        <CaseLawResultsSummaryText
          exactCount={0}
          intent={{ type: "text", text: "employment dismissal" }}
          page={1}
          relaxedHitCount={relaxedHitCount}
          total={resultTotal}
        />
      </FormattingProvider>
    </IntlProvider>,
  );
};

test("reports exact and appended partial matches separately", () => {
  const view = renderHeading(3);
  expect(
    view.getByText("Page 1 · 0 exact matches · 3 partial matches"),
  ).toBeTruthy();
});

test("keeps an estimated exact-match total approximate beside partial matches", () => {
  const view = renderHeading(3, {
    type: SEARCH_TOTAL_TYPE.ESTIMATE,
    count: 120,
  });
  expect(
    view.getByText("Page 1 · about 120 exact matches · 3 partial matches"),
  ).toBeTruthy();
});

test("keeps the ordinary result total when no partial matches were appended", () => {
  const view = renderHeading(0);
  expect(view.getByText("Page 1 · 0 results")).toBeTruthy();
});
