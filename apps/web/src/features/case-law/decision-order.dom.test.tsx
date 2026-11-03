/**
 * Choosing the order from the date header, end to end on the web side: the
 * header's items, the address the choice lands on, the request the results
 * are read with, and the heading over them. The harness composes the same
 * pieces the results page does, with the URL held in state.
 */

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { plugin } from "bun";
import { afterAll, afterEach, expect, test } from "bun:test";

import { SEARCH_TOTAL_NOT_COUNTED } from "@stll/api-contract/search";

import messages from "@/i18n/langs/en.json";
import { unregisterDomEnvironment } from "@/test-dom-environment";

import type { CaseLawIndexSearch } from "./case-law-index-search.logic";

GlobalRegistrator.register({ url: "http://localhost:3000/law/cases" });
// The build turns a `?worker&url` import into the emitted worker's URL; the
// question cells reach the document reader, which imports one.
plugin({
  name: "worker-url",
  setup(build) {
    build.onLoad({ filter: /\?worker&url$/u }, () => ({
      contents: 'export default "/worker.js";',
      loader: "js",
    }));
  },
});
const originalFetch = globalThis.fetch;
const { useState } = await import("react");
const { cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider, useQuery } =
  await import("@tanstack/react-query");
const { flexRender, useTable } = await import("@tanstack/react-table");
const { IntlProvider } = await import("use-intl");
const { workspaceTableFeatures } =
  await import("@/components/workspaces/table/table-features");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { createCaseLawIndexPath } =
  await import("./case-law-index-search.logic");
const { CaseLawResultsSummary } =
  await import("./components/case-law-results-summary");
const { decisionDateOrder, decisionOrder } =
  await import("./decision-order.logic");
const {
  DECISION_DATE_COLUMN,
  DecisionDateDirectionsScope,
  decisionTableSorting,
  useDecisionTableColumns,
} = await import("./decision-table-columns");
const { createDecisionFiltersFromSearch, readDecisionIntent } =
  await import("./open-decision-match");
const { decisionsPageOptions } = await import("./queries/decisions");

const UNAVAILABLE_REASON = messages.caseLaw.sort.oldestUnavailable;

type ListRequest = { sort: string | null };

/** The browse listing, empty, recording the order each read asked for. */
const installListing = () => {
  const requests: ListRequest[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      let address: string;
      if (typeof input === "string") {
        address = input;
      } else if (input instanceof URL) {
        address = input.href;
      } else {
        address = input.url;
      }
      const url = new URL(address, "http://localhost:3000");
      if (!url.pathname.endsWith("/v1/case/decisions")) {
        return Response.json(null, { status: 404 });
      }
      requests.push({ sort: url.searchParams.get("sort") });
      return Response.json({ items: [], nextCursor: null });
    },
    { preconnect: () => undefined },
  );
  return requests;
};

const NO_ROWS: never[] = [];

const Results = ({ initial }: { initial: CaseLawIndexSearch }) => {
  const [search, setSearch] = useState(initial);
  const order = decisionOrder(
    readDecisionIntent(search.q, { jurisdiction: "CZE" }),
    search.sort,
  );
  useQuery(
    decisionsPageOptions({
      filters: createDecisionFiltersFromSearch(search, { excerpt: "short" }),
      page: 1,
    }),
  );
  const dateOrder = decisionDateOrder({
    order,
    onSortChange: (sort) => {
      setSearch((previous) => ({ ...previous, sort }));
    },
    unavailableReason: UNAVAILABLE_REASON,
  });
  const columns = useDecisionTableColumns({
    ordering: dateOrder === null ? "answer" : "header",
    questions: { type: "hidden" },
    referenceKind: "case-number",
  });
  const sorting = decisionTableSorting(dateOrder);
  const table = useTable({
    features: workspaceTableFeatures,
    columns,
    data: NO_ROWS,
    manualSorting: true,
    state: { sorting: sorting?.sorts ?? [] },
    onSortingChange: (updater) => {
      if (sorting !== null) {
        sorting.onChange(
          typeof updater === "function" ? updater(sorting.sorts) : updater,
        );
      }
    },
  });
  const dateHeader = table
    .getHeaderGroups()
    .at(0)
    ?.headers.find((header) => header.column.id === DECISION_DATE_COLUMN);

  return (
    <>
      <CaseLawResultsSummary
        exactCount={0}
        isRefreshing={false}
        order={order}
        page={1}
        relaxedHitCount={0}
        total={SEARCH_TOTAL_NOT_COUNTED}
      />
      <output data-testid="address">{createCaseLawIndexPath(search)}</output>
      <DecisionDateDirectionsScope value={dateOrder?.directions ?? null}>
        {dateHeader === undefined
          ? null
          : flexRender(
              dateHeader.column.columnDef.header,
              dateHeader.getContext(),
            )}
      </DecisionDateDirectionsScope>
    </>
  );
};

const renderResults = (initial: CaseLawIndexSearch) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <Results initial={initial} />
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
};

const clients: InstanceType<typeof QueryClient>[] = [];

afterEach(() => {
  cleanup();
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

const sortItem = (
  view: ReturnType<typeof renderResults>,
  label: string,
): HTMLElement => view.getByRole("button", { name: new RegExp(label, "u") });

test("oldest first from the date header moves the address, the request and the heading", async () => {
  const requests = installListing();
  const view = renderResults({ country: "cze" });

  await waitFor(() => {
    expect(requests).toEqual([{ sort: "newest" }]);
  });
  expect(view.getByRole("heading").textContent).toBe(
    messages.caseLaw.newestDecisions,
  );
  expect(view.getByTestId("address").textContent).toBe(
    "/law/cases?country=cze",
  );

  fireEvent.click(view.getByRole("button", { name: messages.common.date }));
  const newest = sortItem(
    view,
    messages.workspaces.properties.sortDescendingDate,
  );
  const oldest = sortItem(
    view,
    messages.workspaces.properties.sortAscendingDate,
  );
  // The order shown is the one checked, and both are on offer.
  expect(newest.getAttribute("aria-pressed")).toBe("true");
  expect(oldest.getAttribute("aria-pressed")).toBe("false");
  expect(oldest.hasAttribute("disabled")).toBe(false);

  fireEvent.click(oldest);

  await waitFor(() => {
    expect(requests.at(-1)).toEqual({ sort: "oldest" });
  });
  expect(view.getByTestId("address").textContent).toBe(
    "/law/cases?country=cze&sort=oldest",
  );
  expect(view.getByRole("heading").textContent).toBe(
    messages.caseLaw.oldestDecisions,
  );
});

test("a search offers newest first from the date header and says why not oldest", () => {
  installListing();
  const view = renderResults({ country: "cze", q: "náhrada škody" });

  fireEvent.click(view.getByRole("button", { name: messages.common.date }));
  const oldest = sortItem(
    view,
    messages.workspaces.properties.sortAscendingDate,
  );
  const newest = sortItem(
    view,
    messages.workspaces.properties.sortDescendingDate,
  );

  expect(oldest.hasAttribute("disabled")).toBe(true);
  expect(view.getByText(UNAVAILABLE_REASON).id).toBe(
    oldest.getAttribute("aria-describedby") ?? "",
  );
  expect(newest.hasAttribute("disabled")).toBe(false);
  // Relevance orders the search, so no date direction is checked.
  expect(newest.getAttribute("aria-pressed")).toBe("false");
});
