import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { sleep } from "@stll/concurrency/sleep";

import {
  readProvisionCitingSearch,
  publicStatuteSearchSchema,
  updateProvisionCitingSearch,
} from "@/features/statutes/statute-page-search";
import type { api } from "@/lib/api";
import type { PublicLawData } from "@/lib/public-law-api";

GlobalRegistrator.register({ url: "http://localhost:3000/law" });
const originalFetch = globalThis.fetch;
const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { buildFormattingLocale } = await import("@/i18n/i18n-store");
const { ProvisionCitingDecisions } =
  await import("./provision-citing-decisions");
const messages = (await import("@/i18n/langs/en.json")).default;
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
  await act(async () => {
    await sleep(0);
  });
  await GlobalRegistrator.unregister();
});

const responsePage = {
  items: [],
  limit: 10,
  nextCursor: null,
  snapshot: null,
} satisfies PublicLawData<
  (typeof api.case.provisions)["citing-decisions"]["get"]
>;

test("citing filters update route search and the next API request, then clear both", async () => {
  const requests: URL[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      requests.push(
        new URL(input instanceof Request ? input.url : String(input)),
      );
      return Response.json(responsePage);
    },
    { preconnect: originalFetch.preconnect },
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);

  const rootRoute = router.createRootRoute();
  const StatuteRoute = router.createRoute({
    getParentRoute: () => rootRoute,
    path: "statutes",
    validateSearch: publicStatuteSearchSchema,
  });
  const StatutePage = () => {
    const search = StatuteRoute.useSearch({
      select: ({ q, citingCourt, citingYear, citingSort }) => ({
        q,
        citingCourt,
        citingYear,
        citingSort,
      }),
    });
    const filters = readProvisionCitingSearch(search);
    return (
      <ProvisionCitingDecisions
        anchorId="s13"
        eli="/eli/cz/sb/1993/1"
        jurisdiction="CZE"
        currentVersionValidFrom="2022-01-01"
        filters={filters}
        onFiltersChange={(nextFilters) => {
          const nextSearch = updateProvisionCitingSearch(search, nextFilters);
          appRouter.history.push(
            `${StatuteRoute.fullPath}${router.defaultStringifySearch(nextSearch)}`,
          );
        }}
      />
    );
  };
  StatuteRoute.update({ component: StatutePage });
  const appRouter = router.createRouter({
    routeTree: rootRoute.addChildren([StatuteRoute]),
    history: router.createMemoryHistory({
      initialEntries: [
        "/statutes?q=constitution&citingCourt=Old%20Court&citingYear=2019",
      ],
    }),
    isServer: false,
  });
  await appRouter.load();
  const ui = render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider
          locale={buildFormattingLocale({
            lang: "en",
            region: "",
            regionalFormat: "auto",
            calendar: "auto",
            numberingSystem: "auto",
            weekStart: "auto",
          })}
          timeZone="UTC"
        >
          <router.RouterProvider router={appRouter} />
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );

  await waitFor(() => expect(requests).toHaveLength(1));
  fireEvent.change(ui.getByRole("searchbox", { name: messages.common.court }), {
    target: { value: " Supreme Court " },
  });
  fireEvent.change(
    ui.getByRole("spinbutton", {
      name: messages.statutes.citingDecisionsYear,
    }),
    { target: { value: "2020" } },
  );
  fireEvent.click(ui.getByRole("button", { name: messages.common.filter }));

  await waitFor(() => expect(requests).toHaveLength(2));
  expect(appRouter.state.location.search).toMatchObject({
    q: "constitution",
    citingCourt: "Supreme Court",
    citingYear: 2020,
  });
  const appliedUrlSearch = new URLSearchParams(
    appRouter.state.location.searchStr,
  );
  expect(appliedUrlSearch.get("citingCourt")).toBe("Supreme Court");
  expect(appliedUrlSearch.get("citingYear")).toBe("2020");
  expect(requests.at(1)?.searchParams.get("court")).toBe("Supreme Court");
  expect(requests.at(1)?.searchParams.get("year")).toBe("2020");

  fireEvent.change(ui.getByRole("searchbox", { name: messages.common.court }), {
    target: { value: "" },
  });
  fireEvent.change(
    ui.getByRole("spinbutton", {
      name: messages.statutes.citingDecisionsYear,
    }),
    { target: { value: "" } },
  );
  fireEvent.click(ui.getByRole("button", { name: messages.common.filter }));

  await waitFor(() => expect(requests).toHaveLength(3));
  expect(appRouter.state.location.search).toMatchObject({ q: "constitution" });
  expect(appRouter.state.location.search).not.toHaveProperty("citingCourt");
  expect(appRouter.state.location.search).not.toHaveProperty("citingYear");
  const clearedUrlSearch = new URLSearchParams(
    appRouter.state.location.searchStr,
  );
  expect(clearedUrlSearch.has("citingCourt")).toBe(false);
  expect(clearedUrlSearch.has("citingYear")).toBe(false);
  expect(requests.at(2)?.searchParams.has("court")).toBe(false);
  expect(requests.at(2)?.searchParams.has("year")).toBe(false);
});
