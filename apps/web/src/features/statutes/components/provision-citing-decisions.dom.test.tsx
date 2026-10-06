import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { DECISION_DATE_VERSION_BASIS } from "@stll/api-contract/provision-version-basis";

import { readProvisionCitingSearch } from "@/features/statutes/statute-page-search";
import type { ProvisionCitingSearch } from "@/features/statutes/statute-page-search";
import type { api } from "@/lib/api";
import type { PublicLawData } from "@/lib/public-law-api";
import { toSafeId } from "@/lib/safe-id";

import type { CitingDecisionRow } from "./provision-citing-decisions";

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
const { citingDecisionsInfiniteOptions } =
  await import("@/features/statutes/queries/citing-decisions");
const { ProvisionCitingDecisions } =
  await import("./provision-citing-decisions");
const en = (await import("@/i18n/langs/en.json")).default;
const ar = (await import("@/i18n/langs/ar.json")).default;
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
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
  await GlobalRegistrator.unregister();
});

const provision = {
  anchorId: "s13",
  eli: "/eli/cz/sb/1993/1",
  jurisdiction: "CZE",
};
const citingDecisionKey = {
  anchor: provision.anchorId,
  eli: provision.eli,
  jurisdiction: provision.jurisdiction,
};
const initialFilters = readProvisionCitingSearch({});
const currentVersionValidFrom = "2022-01-01";
const makeDecision = (id: string, caseNumber: string) =>
  ({
    decisionId: toSafeId<"caseLawDecision">(id),
    caseNumber,
    slug: caseNumber.replaceAll("/", "-"),
    court: "Supreme Court",
    courtAbbreviation: "SC",
    courtTier: "supreme",
    mentionCount: 1,
    snippetCitation: null,
    country: "CZE",
    language: "cs",
    decisionDate: "2020-01-01",
    versionBasis: DECISION_DATE_VERSION_BASIS,
    versionValidFrom: null,
    inferredVersionCandidate: {
      type: "inferred",
      kind: "decision_date",
      versionValidFrom: null,
    },
    citationAuthority: 1,
    sentenceText: `Decision ${caseNumber} applies § 13.`,
    spanStart: 0,
    spanEnd: 5,
    languageAlternates: [],
  }) satisfies CitingDecisionRow;

const firstDecision = makeDecision(
  "00000000-0000-4000-8000-000000000011",
  "1 C 11/2020",
);
const replacementDecision = makeDecision(
  "00000000-0000-4000-8000-000000000012",
  "1 C 12/2020",
);
type CitingPage = PublicLawData<
  (typeof api.case.provisions)["citing-decisions"]["get"]
>;
const page = (items: CitingDecisionRow[], nextCursor: string | null = null) =>
  ({ items, limit: 10, nextCursor }) satisfies CitingPage;

const createClient = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  return client;
};

const mount = async ({
  client,
  locale = "en",
  messages = en,
  filters = initialFilters,
  onFiltersChange = () => undefined,
}: {
  client: InstanceType<typeof QueryClient>;
  locale?: string;
  messages?: typeof en;
  filters?: ProvisionCitingSearch;
  onFiltersChange?: (filters: ProvisionCitingSearch) => void;
}) => {
  const formattingLocale = buildFormattingLocale({
    lang: locale,
    region: "",
    regionalFormat: "auto",
    calendar: "auto",
    numberingSystem: "auto",
    weekStart: "auto",
  });
  const root = router.createRootRoute({
    component: () => (
      <ProvisionCitingDecisions
        anchorId={provision.anchorId}
        eli={provision.eli}
        jurisdiction={provision.jurisdiction}
        currentVersionValidFrom={currentVersionValidFrom}
        filters={filters}
        onFiltersChange={onFiltersChange}
      />
    ),
  });
  const appRouter = router.createRouter({
    routeTree: root,
    history: router.createMemoryHistory({ initialEntries: ["/"] }),
    isServer: false,
  });
  await appRouter.load();
  return render(
    <QueryClientProvider client={client}>
      <IntlProvider locale={locale} messages={messages} timeZone="UTC">
        <FormattingProvider locale={formattingLocale} timeZone="UTC">
          <router.RouterProvider router={appRouter} />
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
};

const seedPages = (
  client: InstanceType<typeof QueryClient>,
  pages: CitingPage[],
  pageParams: (string | null)[],
) => {
  client.setQueryData(
    citingDecisionsInfiniteOptions(citingDecisionKey, initialFilters).queryKey,
    {
      pageParams,
      pages,
    },
  );
};

const seed = (
  client: InstanceType<typeof QueryClient>,
  items: CitingDecisionRow[],
  nextCursor: string | null = null,
) => seedPages(client, [page(items, nextCursor)], [null]);

for (const [locale, messages] of [
  ["en", en],
  ["ar", ar],
] as const) {
  test(`${locale}: citing decisions move from pending through retry to empty`, async () => {
    const firstRead = Promise.withResolvers<Response>();
    let attempts = 0;
    globalThis.fetch = Object.assign(
      async () => {
        attempts += 1;
        return attempts === 1 ? firstRead.promise : Response.json(page([]));
      },
      { preconnect: originalFetch.preconnect },
    );
    const ui = await mount({ client: createClient(), locale, messages });

    expect(ui.queryByRole("status")).not.toBeNull();
    await act(async () => {
      firstRead.resolve(
        Response.json({ message: "Read unavailable" }, { status: 503 }),
      );
    });
    await waitFor(() => expect(ui.queryByRole("alert")).not.toBeNull());
    fireEvent.click(ui.getByRole("button", { name: messages.common.retry }));
    await waitFor(() =>
      expect(ui.queryByText(messages.common.noResults)).not.toBeNull(),
    );
    expect(attempts).toBe(2);
  });

  test(`${locale}: cached citing decisions render and submit canonical filters`, async () => {
    const client = createClient();
    seedPages(
      client,
      [page([firstDecision]), page([firstDecision])],
      [null, "previous-cursor"],
    );
    const changes: ProvisionCitingSearch[] = [];
    const ui = await mount({
      client,
      locale,
      messages,
      onFiltersChange: (nextFilters) => changes.push(nextFilters),
    });

    expect(ui.getAllByRole("link", { name: /1 C 11\/2020/u })).toHaveLength(1);
    fireEvent.change(
      ui.getByRole("searchbox", { name: messages.caseLaw.court }),
      {
        target: { value: " Supreme Court " },
      },
    );
    fireEvent.change(
      ui.getByRole("spinbutton", {
        name: messages.statutes.citingDecisionsYear,
      }),
      { target: { value: "2020" } },
    );
    fireEvent.click(ui.getByRole("button", { name: messages.common.filter }));
    expect(changes.at(-1)).toEqual({
      citingCourt: "Supreme Court",
      citingYear: 2020,
      citingSort: "newest",
    });
    expect(ui.getByRole("link", { name: /1 C 11\/2020/u })).toBeTruthy();

    fireEvent.click(ui.getByRole("combobox", { name: messages.common.sort }));
    fireEvent.click(
      await ui.findByRole("option", {
        name: messages.statutes.citingDecisionsSortCitations,
      }),
    );
    expect(changes.at(-1)).toEqual({
      citingSort: "citations",
    });
  });

  test(`${locale}: cached empty citing decisions show the empty state`, async () => {
    const client = createClient();
    seed(client, []);
    const ui = await mount({ client, locale, messages });
    expect(ui.getByText(messages.common.noResults)).toBeTruthy();
    expect(ui.queryByRole("status")).toBeNull();
  });
}

test("a stale next-page cursor resets the active query from page one", async () => {
  const requests: URL[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const requestUrl = new URL(
        input instanceof Request ? input.url : String(input),
      );
      requests.push(requestUrl);
      return requestUrl.searchParams.has("cursor")
        ? Response.json({ message: "Generation changed" }, { status: 409 })
        : Response.json(page([replacementDecision]));
    },
    { preconnect: originalFetch.preconnect },
  );
  const client = createClient();
  seed(client, [firstDecision], "stale-cursor");
  const ui = await mount({ client });
  expect(ui.getByRole("link", { name: /1 C 11\/2020/u })).toBeTruthy();

  fireEvent.click(ui.getByRole("button", { name: en.common.loadMore }));
  await waitFor(() =>
    expect(ui.getByRole("link", { name: /1 C 12\/2020/u })).toBeTruthy(),
  );
  expect(requests).toHaveLength(2);
  expect(requests.at(0)?.searchParams.has("cursor")).toBe(true);
  expect(requests.at(1)?.searchParams.has("cursor")).toBe(false);
  expect(ui.queryByRole("link", { name: /1 C 11\/2020/u })).toBeNull();
});
