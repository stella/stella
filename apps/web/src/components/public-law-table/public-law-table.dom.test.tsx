import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import messages from "@/i18n/langs/en.json";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/law/cases" });
const { cleanup, render } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { PublicLawTable } = await import("./public-law-table");

afterEach(cleanup);
afterAll(async () => await unregisterDomEnvironment());

const LAYOUT = {
  hidden: [],
  order: [],
  pinned: [],
  sizing: {},
  contentMode: "fit-content" as const,
};

const renderEmptyResults = (emptyState?: string) =>
  render(
    <IntlProvider locale="en" messages={messages}>
      <PublicLawTable
        columns={[]}
        emptyState={emptyState === undefined ? undefined : <p>{emptyState}</p>}
        firstRowNumber={1}
        getRowId={(row) => row.id}
        isLoading={false}
        layout={LAYOUT}
        onLayoutChange={() => undefined}
        rowHost={{ renderRow: () => null }}
        rows={[]}
      />
    </IntlProvider>,
  );

describe("public-law results with no rows", () => {
  test("draw the screen's reason alone, with no column headers or grid", () => {
    const view = renderEmptyResults("Nothing matched the words.");

    expect(view.getByText("Nothing matched the words.")).toBeDefined();
    expect(view.queryAllByRole("columnheader")).toHaveLength(0);
    expect(view.queryByRole("grid")).toBeNull();
    expect(view.queryByRole("table")).toBeNull();
  });

  test("fall back to the plain no-results line", () => {
    const view = renderEmptyResults();

    expect(view.getByText(messages.common.noResults)).toBeDefined();
    expect(view.queryAllByRole("columnheader")).toHaveLength(0);
  });
});
