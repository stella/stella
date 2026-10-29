/**
 * The results table says "no results" only for a search that answered with
 * none. A table still waiting for its search, or holding the previous
 * search's empty page while the next one is in flight, stands in skeleton:
 * "no results" there would be an answer the search never gave.
 */

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import type { PublicLawTableLayout } from "@/components/public-law-table/public-law-table-layout.logic";
import type { StatuteRowData } from "@/components/workspaces/table/types";
import messages from "@/i18n/langs/en.json";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/law/cases" });
const { cleanup, render } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { PublicLawTable } = await import("./public-law-table");
const { publicLawRowsPhase } = await import("./public-law-results-state.logic");

afterEach(cleanup);
afterAll(async () => await unregisterDomEnvironment());

const LAYOUT: PublicLawTableLayout = {
  hidden: [],
  order: [],
  pinned: [],
  sizing: {},
  contentMode: "tight",
};

const NO_ROWS: StatuteRowData[] = [];
const NO_RESULTS = messages.common.noResults;

type TableState = { isLoading: boolean; isRefreshing: boolean };

const renderTable = ({ isLoading, isRefreshing }: TableState) =>
  render(
    <IntlProvider locale="en" messages={messages}>
      <FormattingProvider locale="en">
        <PublicLawTable<StatuteRowData, PublicLawTableLayout>
          columns={[]}
          firstRowNumber={1}
          getRowId={(row) => row.statute.id}
          isLoading={isLoading}
          isRefreshing={isRefreshing}
          layout={LAYOUT}
          onLayoutChange={() => undefined}
          rowHost={{ renderRow: () => null }}
          rows={NO_ROWS}
          sorting={null}
        />
      </FormattingProvider>
    </IntlProvider>,
  );

/** The table the results page draws for one state of its row query. */
const tableFor = (query: {
  isLoading: boolean;
  isPlaceholderData: boolean;
}): TableState => {
  const phase = publicLawRowsPhase({
    ...query,
    keptRowCount: NO_ROWS.length,
    routeState: "loaded",
  });
  return { isLoading: phase === "skeleton", isRefreshing: phase === "stale" };
};

describe("the empty results card", () => {
  test("stands for a settled search that found nothing", () => {
    const view = renderTable(
      tableFor({ isLoading: false, isPlaceholderData: false }),
    );
    expect(view.queryByText(NO_RESULTS)).not.toBeNull();
  });

  test("never stands for a search that has not answered yet", () => {
    const view = renderTable(
      tableFor({ isLoading: true, isPlaceholderData: false }),
    );
    expect(view.queryByText(NO_RESULTS)).toBeNull();
  });

  test("never stands for the previous search's empty page while the next one is in flight", () => {
    const view = renderTable(
      tableFor({ isLoading: false, isPlaceholderData: true }),
    );
    expect(view.queryByText(NO_RESULTS)).toBeNull();
  });

  test("never stands over held rows a find hid while a new search is in flight", () => {
    const view = renderTable({ isLoading: false, isRefreshing: true });
    expect(view.queryByText(NO_RESULTS)).toBeNull();
  });
});
