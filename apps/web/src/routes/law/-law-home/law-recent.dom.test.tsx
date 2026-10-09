import { useState } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";

import arabicMessages from "@/i18n/langs/ar.json";
import messages from "@/i18n/langs/en.json";
import { browserStateStorage } from "@/lib/account/browser-storage";
import { MEMBER_SESSION } from "@/lib/auth-session.test-fixtures";
import type { LawRecentFilter } from "@/lib/law-search-history/law-search-history.logic";
import { toSafeId } from "@/lib/safe-id";

GlobalRegistrator.register({ url: "http://localhost:3000/law" });
const { act, cleanup, fireEvent, render, screen, within, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { LawRecent, LawRecentList } = await import("./law-recent");

const usage = {
  firstUsedAt: "2026-01-01T12:00:00Z",
  lastUsedAt: "2026-01-02T12:00:00Z",
  useCount: 1,
};
const seed = [
  {
    ...usage,
    kind: "search",
    id: toSafeId<"searchHistoryEntry">("history-search"),
    query: "náhrada škody",
  },
  {
    ...usage,
    kind: "decision",
    id: toSafeId<"searchHistoryEntry">("history-court"),
    documentId: "decision-1",
    title: "23 Cdo 1001/2021 · Nejvyšší soud",
    path: "/law/cz/cases/supreme/decision-1",
    courtId: null,
    documentIdentity: {
      kind: "decision",
      courtAbbreviation: "NS",
      courtTier: "supreme",
    },
  },
  {
    ...usage,
    kind: "decision",
    id: toSafeId<"searchHistoryEntry">("history-unknown"),
    documentId: "decision-2",
    title: "47 C 57/2023",
    path: "/law/cz/cases/unknown/decision-2",
    courtId: null,
    documentIdentity: { kind: "unknown" },
  },
  {
    ...usage,
    kind: "decision",
    id: toSafeId<"searchHistoryEntry">("history-untiered"),
    documentId: "decision-3",
    title: "23 Cdo 1002/2021 · Nejvyšší soud",
    path: "/law/cz/cases/supreme/decision-3",
    courtId: null,
    documentIdentity: { kind: "decision", courtAbbreviation: "NS" },
  },
  {
    ...usage,
    kind: "statute",
    id: toSafeId<"searchHistoryEntry">("history-statute"),
    documentId: "statute-1",
    title: "Act",
    path: "/law/cz/statutes/statute-1",
    documentIdentity: { kind: "statute", number: "172", year: "2026" },
  },
] as const satisfies readonly Parameters<
  typeof LawRecentList
>[0]["history"]["entries"][number][];

afterEach(async () => {
  await act(async () => cleanup());
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const createSignedSession = ({
  userId = "history-reader",
  organizationId = "history-org",
} = {}) => ({
  session: {
    ...MEMBER_SESSION.session,
    activeOrganizationId: organizationId,
    userId,
  },
  user: {
    ...MEMBER_SESSION.user,
    id: userId,
    name: "Reader",
    email: "reader@example.test",
  },
});

const mount = async (locale = "en") => {
  const calls = {
    searches: [] as string[],
    deletes: [] as string[],
    clears: 0,
  };
  const Fixture = () => {
    const [entries, setEntries] = useState([...seed]);
    const [filter, setFilter] = useState<LawRecentFilter>("all");
    return (
      <LawRecentList
        onSearch={(query) => {
          calls.searches.push(query);
        }}
        filter={filter}
        onFilterChange={setFilter}
        history={{
          entries:
            filter === "all"
              ? entries
              : entries.filter((entry) => entry.kind === filter),
          scope: { userId: "history-reader", organizationId: "history-org" },
          isPending: false,
          error: null,
          remove: {
            isPending: false,
            mutate: (id) => {
              calls.deletes.push(id);
              setEntries((current) =>
                current.filter((entry) => entry.id !== id),
              );
            },
          },
          clear: {
            isPending: false,
            mutate: (_, options) => {
              calls.clears += 1;
              setEntries([]);
              options.onSuccess();
            },
          },
        }}
      />
    );
  };
  await act(async () => {
    render(
      <IntlProvider
        locale={locale}
        messages={locale === "ar" ? arabicMessages : messages}
        timeZone="UTC"
      >
        <FormattingProvider locale={locale} timeZone="UTC">
          <Fixture />
        </FormattingProvider>
      </IntlProvider>,
    );
  });
  return calls;
};
const click = async (name: string | RegExp) =>
  act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });

test("server recent rows render known court chips, unknown decision icons and statute identity", async () => {
  await mount();
  const known = screen.getByRole("link", { name: /23 Cdo 1001/u });
  expect(known.querySelector('[data-slot="court-badge"]')?.textContent).toBe(
    "NS",
  );
  const untiered = screen.getByRole("link", { name: /23 Cdo 1002/u });
  expect(untiered.querySelector('[data-slot="court-badge"]')?.textContent).toBe(
    "NS",
  );
  const unknown = screen.getByRole("link", { name: /47 C/u });
  expect(unknown.querySelector('[data-slot="court-badge"]')).toBeNull();
  expect(unknown.querySelector("svg")).not.toBeNull();
  expect(
    screen.getByRole("link", { name: /172\/26/u }).querySelector("svg"),
  ).not.toBeNull();
});

test("server recents filter, reopen queries and delete their server entry id", async () => {
  const calls = await mount();
  await click(messages.lawHome.recentSearchFilter);
  expect(screen.queryAllByRole("link")).toHaveLength(0);
  await click(/náhrada škody/u);
  expect(calls.searches).toEqual(["náhrada škody"]);
  await click(messages.lawHome.recentCasesFilter);
  const row = screen.getByRole("link", { name: /23 Cdo 1001/u }).parentElement;
  if (row === null) {
    throw new TypeError("Recent row is absent");
  }
  await act(async () => {
    fireEvent.click(
      within(row).getByRole("button", { name: messages.common.remove }),
    );
  });
  expect(calls.deletes).toEqual(["history-court"]);
  expect(screen.queryByRole("link", { name: /23 Cdo 1001/u })).toBeNull();
});

test("clearing history requires confirmation and cancellation leaves rows", async () => {
  const calls = await mount();
  await click(messages.lawHome.clearRecent);
  expect(calls.clears).toBe(0);
  expect(screen.getByRole("alertdialog")).toBeTruthy();
  await click(messages.common.cancel);
  expect(screen.getAllByRole("link")).toHaveLength(4);
  await click(messages.lawHome.clearRecent);
  await click(messages.common.delete);
  expect(calls.clears).toBe(1);
  expect(screen.getByText(messages.lawHome.noRecent)).toBeTruthy();
});

test("recent controls render in Arabic with the same court identity", async () => {
  await mount("ar");
  expect(
    screen.getByRole("button", { name: arabicMessages.lawHome.clearRecent }),
  ).toBeTruthy();
  expect(
    screen
      .getByRole("link", { name: /23 Cdo 1001/u })
      .querySelector('[data-slot="court-badge"]')?.textContent,
  ).toBe("NS");
});

test("signed-in recents import local data once and always display server data", async () => {
  const { QueryClient, QueryClientProvider } =
    await import("@tanstack/react-query");
  const { sessionOptions } = await import("@/lib/auth-query-options");
  const { userStorageKey } = await import("@/lib/account/user-scoped-storage");
  const scopedKey = userStorageKey("law_search_history", {
    kind: "user",
    userId: "history-reader",
  });
  browserStateStorage("local").setItem(
    scopedKey,
    JSON.stringify([{ query: "local-only query", at: "2026-01-01T12:00:00Z" }]),
  );
  browserStateStorage("local").setItem(
    "law_search_history",
    JSON.stringify([{ query: "legacy query", at: "2026-01-01T12:00:00Z" }]),
  );
  const requests: { path: string; method: string; body: unknown }[] = [];
  let serverQuery: string = seed[0].query;
  let nextRead: Promise<void> | undefined;
  let serverScope = { userId: "history-reader", organizationId: "history-org" };
  const transport = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        const path = new URL(
          input instanceof Request ? input.url : String(input),
        ).pathname;
        const method = init?.method ?? "GET";
        requests.push({
          path,
          method,
          body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        });
        if (path.endsWith("/import")) {
          return Response.json({ entries: 2, skipped: 0 });
        }
        const query = serverQuery;
        const scope = serverScope;
        if (nextRead !== undefined) {
          await nextRead;
        }
        return Response.json({
          scope,
          items: [{ ...seed[0], query }],
          nextCursor: null,
          limit: 20,
        });
      },
      { preconnect: () => undefined },
    ),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const signedSession = createSignedSession();
  client.setQueryData(sessionOptions.queryKey, signedSession);
  const mountServer = async () => {
    await act(async () => {
      render(
        <QueryClientProvider client={client}>
          <IntlProvider locale="en" messages={messages} timeZone="UTC">
            <FormattingProvider locale="en" timeZone="UTC">
              <LawRecent onSearch={() => undefined} />
            </FormattingProvider>
          </IntlProvider>
        </QueryClientProvider>,
      );
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /náhrada škody/u }),
      ).toBeTruthy(),
    );
  };
  try {
    await mountServer();
    expect(screen.queryByText("local-only query")).toBeNull();
    expect(browserStateStorage("local").getItem(scopedKey)).toBeNull();
    expect(
      browserStateStorage("local").getItem("law_search_history"),
    ).toBeNull();
    await act(async () => cleanup());
    await mountServer();
    const imports = requests.filter((request) =>
      request.path.endsWith("/import"),
    );
    expect(imports).toHaveLength(1);
    expect(imports.at(0)?.body).toMatchObject({
      entries: [
        { entry: { query: "local-only query" } },
        { entry: { query: "legacy query" } },
      ],
    });
    const organizationRead = Promise.withResolvers<undefined>();
    nextRead = organizationRead.promise;
    serverQuery = "other organization query";
    serverScope = {
      userId: "history-reader",
      organizationId: "history-org-two",
    };
    await act(async () => {
      client.setQueryData(
        sessionOptions.queryKey,
        createSignedSession({ organizationId: "history-org-two" }),
      );
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /náhrada škody/u }) === null,
      ).toBe(true),
    );
    await act(async () => {
      organizationRead.resolve(undefined);
      nextRead = undefined;
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /other organization query/u }),
      ).toBeTruthy(),
    );
    const accountRead = Promise.withResolvers<undefined>();
    nextRead = accountRead.promise;
    serverQuery = "other account query";
    serverScope = {
      userId: "history-other-reader",
      organizationId: "history-org",
    };
    await act(async () => {
      client.setQueryData(
        sessionOptions.queryKey,
        createSignedSession({ userId: "history-other-reader" }),
      );
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /other organization query/u }) ===
          null,
      ).toBe(true),
    );
    await act(async () => {
      accountRead.resolve(undefined);
      nextRead = undefined;
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /other account query/u }),
      ).toBeTruthy(),
    );
  } finally {
    await act(async () => cleanup());
    client.clear();
    transport.mockRestore();
    browserStateStorage("local").removeItem(scopedKey);
    browserStateStorage("local").removeItem("law_search_history");
  }
});

type HistoryRequest = { url: URL; method: string };
const mountServerHistory = async (
  respond: (request: HistoryRequest) => Response | Promise<Response>,
) => {
  const { QueryClient, QueryClientProvider } =
    await import("@tanstack/react-query");
  const { sessionOptions } = await import("@/lib/auth-query-options");
  const signedSession = createSignedSession({
    userId: "scoped-history-reader",
    organizationId: "scoped-history-org-a",
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(sessionOptions.queryKey, signedSession);
  const requests: HistoryRequest[] = [];
  const transport = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        const request = {
          url: new URL(input instanceof Request ? input.url : String(input)),
          method: init?.method ?? "GET",
        };
        requests.push(request);
        return respond(request);
      },
      { preconnect: () => undefined },
    ),
  );
  try {
    await act(async () => {
      render(
        <QueryClientProvider client={client}>
          <IntlProvider locale="en" messages={messages} timeZone="UTC">
            <FormattingProvider locale="en" timeZone="UTC">
              <LawRecent onSearch={() => undefined} />
            </FormattingProvider>
          </IntlProvider>
        </QueryClientProvider>,
      );
    });
  } catch (error) {
    await act(async () => cleanup());
    client.clear();
    transport.mockRestore();
    throw error;
  }
  return {
    requests,
    client,
    setScope: async ({
      userId,
      organizationId,
    }: {
      userId: string;
      organizationId: string;
    }) => {
      await act(async () => {
        client.setQueryData(
          sessionOptions.queryKey,
          createSignedSession({ userId, organizationId }),
        );
      });
    },
    setOrganization: async (organizationId: string) => {
      await act(async () => {
        client.setQueryData(
          sessionOptions.queryKey,
          createSignedSession({
            userId: signedSession.user.id,
            organizationId,
          }),
        );
      });
    },
    dispose: async () => {
      await act(async () => cleanup());
      client.clear();
      transport.mockRestore();
    },
  };
};

for (const responseScope of [
  { userId: "scoped-history-reader", organizationId: "scoped-history-org-b" },
  { userId: "other-history-reader", organizationId: "scoped-history-org-a" },
]) {
  test(`recents discard a response for ${responseScope.userId}/${responseScope.organizationId} instead of caching it under the requesting scope`, async () => {
    const requestingScope = {
      userId: "scoped-history-reader",
      organizationId: "scoped-history-org-a",
    };
    let listReads = 0;
    const matchingRead = Promise.withResolvers<Response>();
    const fixture = await mountServerHistory(async ({ url, method }) => {
      if (method !== "GET") {
        throw new TypeError("Expected a history recovery read");
      }
      if (url.pathname.endsWith("/get-session")) {
        return Response.json(createSignedSession(requestingScope));
      }
      if (!url.pathname.includes("search-history")) {
        throw new TypeError("Expected a history or authoritative session read");
      }
      listReads += 1;
      if (listReads === 2) {
        return matchingRead.promise;
      }
      return Response.json({
        scope: responseScope,
        items: [{ ...seed[0], query: "Wrong owner private query" }],
        nextCursor: null,
        limit: 20,
      });
    });
    try {
      const ownerLists = () =>
        fixture.client.getQueryCache().findAll({
          queryKey: ["law-search-history", requestingScope, "list"],
        });
      await waitFor(() => {
        expect(ownerLists()).toHaveLength(1);
        expect(listReads).toBe(2);
        expect(ownerLists().at(0)?.state.status).toBe("pending");
      });
      const sessionReads = fixture.requests.filter(({ url }) =>
        url.pathname.endsWith("/get-session"),
      );
      expect(sessionReads).toHaveLength(1);
      expect(
        sessionReads.at(0)?.url.searchParams.get("disableCookieCache"),
      ).toBe("true");
      expect(ownerLists().at(0)?.state.data).toBeUndefined();
      expect(screen.queryByText("Wrong owner private query") === null).toBe(
        true,
      );
      await act(async () => {
        matchingRead.resolve(
          Response.json({
            scope: requestingScope,
            items: [{ ...seed[0], query: "Matching owner query" }],
            nextCursor: null,
            limit: 20,
          }),
        );
      });
      await waitFor(() =>
        expect(screen.getByText("Matching owner query")).toBeTruthy(),
      );
      expect(listReads).toBe(2);
      expect(ownerLists().at(0)?.state.data).toEqual([
        { ...seed[0], query: "Matching owner query" },
      ]);
      expect(screen.queryByText("Wrong owner private query") === null).toBe(
        true,
      );
    } finally {
      matchingRead.resolve(
        Response.json({
          scope: requestingScope,
          items: [],
          nextCursor: null,
          limit: 20,
        }),
      );
      await fixture.dispose();
    }
  });
}

test("recents recover the authoritative owner automatically without retaining the discarded response under the previous owner", async () => {
  const previousScope = {
    userId: "scoped-history-reader",
    organizationId: "scoped-history-org-a",
  };
  const currentScope = {
    userId: "scoped-history-reader",
    organizationId: "scoped-history-org-b",
  };
  let listReads = 0;
  const fixture = await mountServerHistory(async ({ url, method }) => {
    if (method !== "GET") {
      throw new TypeError("Expected a history recovery read");
    }
    if (url.pathname.endsWith("/get-session")) {
      return Response.json(createSignedSession(currentScope));
    }
    if (!url.pathname.includes("search-history")) {
      throw new TypeError("Expected a history or authoritative session read");
    }
    listReads += 1;
    return Response.json({
      scope: currentScope,
      items: [
        {
          ...seed[0],
          query:
            listReads === 1
              ? "Discarded foreign response"
              : "Authoritative owner query",
        },
      ],
      nextCursor: null,
      limit: 20,
    });
  });
  try {
    await waitFor(() =>
      expect(screen.getByText("Authoritative owner query")).toBeTruthy(),
    );
    expect(listReads).toBe(2);
    expect(screen.queryByText("Discarded foreign response") === null).toBe(
      true,
    );
    const previousLists = fixture.client
      .getQueryCache()
      .findAll({ queryKey: ["law-search-history", previousScope, "list"] });
    expect(previousLists).toHaveLength(1);
    expect(previousLists.at(0)?.state.data).toBeUndefined();
    const currentLists = fixture.client
      .getQueryCache()
      .findAll({ queryKey: ["law-search-history", currentScope, "list"] });
    expect(currentLists).toHaveLength(1);
    expect(currentLists.at(0)?.state.data).toEqual([
      { ...seed[0], query: "Authoritative owner query" },
    ]);
    const sessionReads = fixture.requests.filter(({ url }) =>
      url.pathname.endsWith("/get-session"),
    );
    expect(sessionReads).toHaveLength(1);
    expect(sessionReads.at(0)?.url.searchParams.get("disableCookieCache")).toBe(
      "true",
    );
  } finally {
    await fixture.dispose();
  }
});

test("recents tabs fetch each kind beyond the newest twenty mixed entries", async () => {
  const searches = Array.from({ length: 21 }, (_, index) => ({
    ...seed[0],
    id: toSafeId<"searchHistoryEntry">(`paged-search-${index}`),
    query: `Recent query ${index}`,
  }));
  const oldDecision = { ...seed[1], lastUsedAt: "2025-12-01T00:00:00Z" };
  const oldStatute = { ...seed[4], lastUsedAt: "2025-11-01T00:00:00Z" };
  const stored = [...searches, oldDecision, oldStatute];
  expect(stored.slice(0, 20).some(({ kind }) => kind === "decision")).toBe(
    false,
  );
  const fixture = await mountServerHistory(async ({ url, method }) => {
    if (method !== "GET" || !url.pathname.includes("search-history")) {
      throw new TypeError("Expected a history list request");
    }
    const kind = url.searchParams.get("kind");
    const filtered =
      kind === null ? stored : stored.filter((entry) => entry.kind === kind);
    return Response.json({
      scope: {
        userId: "scoped-history-reader",
        organizationId: "scoped-history-org-a",
      },
      items: filtered.slice(0, 20),
      nextCursor: filtered.length > 20 ? "older-entries" : null,
      limit: 20,
    });
  });
  try {
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Recent query 0(?:\s|$)/u }),
      ).toBeTruthy(),
    );
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    await click(messages.lawHome.recentCasesFilter);
    await waitFor(() =>
      expect(screen.getByRole("link", { name: /23 Cdo 1001/u })).toBeTruthy(),
    );
    expect(
      fixture.requests.some(
        ({ url }) =>
          url.searchParams.get("kind") === "decision" &&
          url.searchParams.get("limit") === "20",
      ),
    ).toBe(true);
    await click(messages.statutes.title);
    await waitFor(() =>
      expect(screen.getByRole("link", { name: /172\/26/u })).toBeTruthy(),
    );
    expect(screen.queryByRole("link", { name: /23 Cdo 1001/u })).toBeNull();
    expect(
      fixture.requests.some(
        ({ url }) =>
          url.searchParams.get("kind") === "statute" &&
          url.searchParams.get("limit") === "20",
      ),
    ).toBe(true);
    await click(messages.lawHome.recentSearchFilter);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Recent query 0(?:\s|$)/u }),
      ).toBeTruthy(),
    );
    expect(
      fixture.requests.some(
        ({ url }) => url.searchParams.get("kind") === "search",
      ),
    ).toBe(true);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  } finally {
    await fixture.dispose();
  }
});

test("clear confirmation belongs to its opening organization and cannot survive an organization round trip", async () => {
  const organizationA = "scoped-history-org-a";
  const organizationB = "scoped-history-org-b";
  const userId = "scoped-history-reader";
  let activeOrganization = organizationA;
  const queries = new Map([
    [organizationA, "Organization A query"],
    [organizationB, "Organization B query"],
  ]);
  const fixture = await mountServerHistory(async ({ url, method }) => {
    if (!url.pathname.includes("search-history")) {
      throw new TypeError("Expected a history request");
    }
    if (method === "DELETE") {
      const deleted = queries.delete(activeOrganization) ? 1 : 0;
      return Response.json({ deleted });
    }
    const query = queries.get(activeOrganization);
    return Response.json({
      scope: { userId, organizationId: activeOrganization },
      items: query === undefined ? [] : [{ ...seed[0], query }],
      nextCursor: null,
      limit: 20,
    });
  });
  const switchOrganization = async (organizationId: string) => {
    activeOrganization = organizationId;
    await fixture.setOrganization(organizationId);
    const query = queries.get(organizationId);
    if (query === undefined) {
      throw new TypeError("Expected an organization history query");
    }
    await waitFor(() => expect(screen.getByText(query)).toBeTruthy());
  };
  try {
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Organization A query/u }),
      ).toBeTruthy(),
    );
    await click(messages.lawHome.clearRecent);
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    const staleConfirm = screen.getByRole("button", {
      name: messages.common.delete,
    });
    await switchOrganization(organizationB);
    expect(screen.queryByRole("alertdialog") === null).toBe(true);
    await act(async () => fireEvent.click(staleConfirm));
    expect(
      fixture.requests.filter(({ method }) => method === "DELETE"),
    ).toHaveLength(0);
    expect(queries.get(organizationB)).toBe("Organization B query");
    await switchOrganization(organizationA);
    expect(screen.queryByRole("alertdialog") === null).toBe(true);
    await switchOrganization(organizationB);
    expect(screen.queryByRole("alertdialog") === null).toBe(true);
    await click(messages.lawHome.clearRecent);
    await click(messages.common.delete);
    await waitFor(() =>
      expect(
        fixture.requests.filter(({ method }) => method === "DELETE"),
      ).toHaveLength(1),
    );
    const deletion = fixture.requests.find(({ method }) => method === "DELETE");
    expect(deletion?.url.searchParams.get("expectedOrganizationId")).toBe(
      organizationB,
    );
    expect(deletion?.url.searchParams.get("expectedUserId")).toBe(userId);
    await waitFor(() =>
      expect(screen.getByText(messages.lawHome.noRecent)).toBeTruthy(),
    );
    expect(queries.has(organizationB)).toBe(false);
    expect(queries.get(organizationA)).toBe("Organization A query");
  } finally {
    await fixture.dispose();
  }
});

for (const change of [
  {
    type: "organization",
    userId: "scoped-history-reader",
    organizationId: "scoped-history-org-b",
  },
  {
    type: "account",
    userId: "scoped-history-other-reader",
    organizationId: "scoped-history-org-a",
  },
] as const) {
  test(`a delayed local import retains its snapshots when the ${change.type} changes and the server rejects its originating scope`, async () => {
    const { userStorageKey } =
      await import("@/lib/account/user-scoped-storage");
    const originalScope = {
      userId: "scoped-history-reader",
      organizationId: "scoped-history-org-a",
    };
    const key = userStorageKey("law_search_history", {
      kind: "user",
      userId: originalScope.userId,
    });
    const local = JSON.stringify([
      { query: "Kept local query", at: "2026-01-01T12:00:00Z" },
    ]);
    const legacy = JSON.stringify([
      { query: "Kept legacy query", at: "2026-01-01T12:00:00Z" },
    ]);
    const storage = browserStateStorage("local");
    storage.setItem(key, local);
    storage.setItem("law_search_history", legacy);
    const pending: {
      request: HistoryRequest;
      response: ReturnType<typeof Promise.withResolvers<Response>>;
    }[] = [];
    const settled: { request: HistoryRequest; status: number }[] = [];
    const fixture = await mountServerHistory(async ({ url, method }) => {
      if (!url.pathname.endsWith("/import")) {
        throw new TypeError("History must wait for the local import");
      }
      const response = Promise.withResolvers<Response>();
      const request = { url, method };
      pending.push({ request, response });
      return response.promise.then((result) => {
        settled.push({ request, status: result.status });
        return result;
      });
    });
    try {
      await waitFor(() => expect(pending.length).toBe(1));
      const first = pending.at(0);
      if (!first) {
        throw new TypeError("Expected an originating import request");
      }
      expect(first.request.url.searchParams.get("expectedUserId")).toBe(
        originalScope.userId,
      );
      expect(first.request.url.searchParams.get("expectedOrganizationId")).toBe(
        originalScope.organizationId,
      );
      const activeScope = {
        userId: change.userId,
        organizationId: change.organizationId,
      };
      await fixture.setScope(activeScope);
      await waitFor(() => expect(pending.length).toBe(2));
      const mismatch =
        first.request.url.searchParams.get("expectedUserId") !==
          activeScope.userId ||
        first.request.url.searchParams.get("expectedOrganizationId") !==
          activeScope.organizationId;
      expect(mismatch).toBe(true);
      await act(async () => {
        first.response.resolve(
          Response.json(
            { message: "Signed-in scope changed" },
            { status: 409 },
          ),
        );
      });
      await waitFor(() =>
        expect(
          settled.some(
            ({ request, status }) =>
              request === first.request && status === 409,
          ),
        ).toBe(true),
      );
      expect(storage.getItem(key)).toBe(local);
      expect(storage.getItem("law_search_history")).toBe(legacy);
      expect(
        fixture.requests.every(({ url }) => url.pathname.endsWith("/import")),
      ).toBe(true);
    } finally {
      await act(async () => {
        for (const request of pending) {
          request.response.resolve(
            Response.json(
              { message: "Signed-in scope changed" },
              { status: 409 },
            ),
          );
        }
      });
      await fixture.dispose();
      storage.removeItem(key);
      storage.removeItem("law_search_history");
    }
  });
}
