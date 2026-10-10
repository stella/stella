import { useState } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import * as v from "valibot";

import { Temporal } from "@stll/time";

import arabicMessages from "@/i18n/langs/ar.json";
import messages from "@/i18n/langs/en.json";
import { MEMBER_SESSION } from "@/lib/account/auth-session.test-fixtures";
import { browserStateStorage } from "@/lib/account/browser-storage";
import type { LawRecentFilter } from "@/lib/law-search-history/law-search-history.logic";
import { toSafeId } from "@/lib/safe-id";
import { readStoredJson } from "@/lib/stored-json";

GlobalRegistrator.register({ url: "http://localhost:3000/law" });
const { act, cleanup, fireEvent, render, screen, within, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { LawRecent, LawRecentList } = await import("./law-recent");

const queryImportBatchSchema = v.object({
  entries: v.array(
    v.object({
      entry: v.object({ kind: v.literal("search"), query: v.string() }),
      usedAt: v.string(),
    }),
  ),
});

const usage = {
  firstUsedAt: "2026-01-01T12:00:00Z",
  lastUsedAt: "2026-01-02T12:00:00Z",
  useCount: 1,
};
type RecentEntry = Extract<
  Parameters<typeof LawRecentList>[0]["history"]["list"],
  { status: "ready" }
>["entries"][number];
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
] as const satisfies readonly RecentEntry[];

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
          list: {
            status: "ready",
            entries:
              filter === "all"
                ? entries
                : entries.filter((entry) => entry.kind === filter),
          },
          importStatus: { type: "empty" },
          scope: { userId: "history-reader", organizationId: "history-org" },
          remove: {
            isPending: false,
            mutate: ({ id }) => {
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
    defaultOptions: {
      queries: { retry: false, retryDelay: 0 },
      mutations: { retry: false },
    },
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
          method:
            init?.method ?? (input instanceof Request ? input.method : "GET"),
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
    let serverScope = originalScope;
    const fixture = await mountServerHistory(async ({ url, method }) => {
      if (!url.pathname.endsWith("/import")) {
        return Response.json({
          items: [],
          nextCursor: null,
          scope: serverScope,
        });
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
      serverScope = activeScope;
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
      expect(fixture.requests.some(({ method }) => method === "GET")).toBe(
        true,
      );
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

test("saved recents remain visible with a local import notice", async () => {
  const { userStorageKey } = await import("@/lib/account/user-scoped-storage");
  const key = userStorageKey("law_search_history", {
    kind: "user",
    userId: "scoped-history-reader",
  });
  const storage = browserStateStorage("local");
  const local = JSON.stringify([
    { query: "Local query", at: "2026-01-01T12:00:00Z" },
  ]);
  storage.setItem(key, local);
  const fixture = await mountServerHistory(({ url }) =>
    url.pathname.endsWith("/import")
      ? Response.json({ message: "Temporarily unavailable" }, { status: 503 })
      : Response.json({
          items: [{ ...seed[0], query: "Saved query" }],
          nextCursor: null,
          scope: {
            userId: "scoped-history-reader",
            organizationId: "scoped-history-org-a",
          },
        }),
  );
  try {
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Saved query/u })).toBeTruthy();
      expect(screen.getByText(messages.lawHome.importFailed)).toBeTruthy();
    });
    expect(storage.getItem(key)).toBe(local);
  } finally {
    await fixture.dispose();
    storage.removeItem(key);
  }
});

test("clearing visible recents waits for a delayed import and leaves server and local history empty", async () => {
  const { userStorageKey } = await import("@/lib/account/user-scoped-storage");
  const key = userStorageKey("law_search_history", {
    kind: "user",
    userId: "scoped-history-reader",
  });
  const storage = browserStateStorage("local");
  storage.setItem(
    key,
    JSON.stringify([{ query: "Local query", at: "2026-01-01T12:00:00Z" }]),
  );
  storage.setItem(
    "law_search_history",
    JSON.stringify([{ query: "Earlier query", at: "2026-01-01T12:00:00Z" }]),
  );
  const importStarted = Promise.withResolvers<undefined>();
  const finishImport = Promise.withResolvers<undefined>();
  let serverQueries = ["Saved query"];
  const fixture = await mountServerHistory(async ({ url, method }) => {
    if (url.pathname.endsWith("/import")) {
      importStarted.resolve(undefined);
      await finishImport.promise;
      serverQueries.push("Local query", "Earlier query");
      return Response.json({ entries: 2, skipped: 0 });
    }
    if (method === "DELETE") {
      const deleted = serverQueries.length;
      serverQueries = [];
      return Response.json({ deleted });
    }
    return Response.json({
      items: serverQueries.map((query, index) => ({
        ...seed[0],
        id: `history-${index}`,
        query,
      })),
      nextCursor: null,
      scope: {
        userId: "scoped-history-reader",
        organizationId: "scoped-history-org-a",
      },
    });
  });
  try {
    await importStarted.promise;
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Saved query/u })).toBeTruthy(),
    );
    await click(messages.lawHome.clearRecent);
    await click(messages.common.delete);
    // Resolve after the clear action has been submitted, exercising both completions.
    await act(async () => finishImport.resolve(undefined));
    await waitFor(() => {
      expect(screen.getByText(messages.lawHome.noRecent)).toBeTruthy();
      expect(serverQueries).toEqual([]);
      expect(storage.getItem(key)).toBeNull();
      expect(storage.getItem("law_search_history")).toBeNull();
    });
    await fixture.client.invalidateQueries({
      queryKey: ["law-search-history"],
    });
    await waitFor(() => {
      expect(serverQueries).toEqual([]);
      expect(
        screen.queryByRole("button", { name: /Local query|Earlier query/u }),
      ).toBeNull();
    });
  } finally {
    finishImport.resolve(undefined);
    await fixture.dispose();
    storage.removeItem(key);
    storage.removeItem("law_search_history");
  }
});

test("removing a saved query waits for a delayed import and leaves it absent", async () => {
  const { userStorageKey } = await import("@/lib/account/user-scoped-storage");
  const key = userStorageKey("law_search_history", {
    kind: "user",
    userId: "scoped-history-reader",
  });
  const storage = browserStateStorage("local");
  storage.setItem(
    key,
    JSON.stringify([{ query: "Saved query", at: "2026-01-01T12:00:00Z" }]),
  );
  const importStarted = Promise.withResolvers<undefined>();
  const finishImport = Promise.withResolvers<undefined>();
  const savedEntry = { ...seed[0], id: "history-saved", query: "Saved query" };
  let serverEntries = [savedEntry];
  let imported = false;
  let deleted = false;
  const fixture = await mountServerHistory(async ({ url, method }) => {
    if (url.pathname.endsWith("/import")) {
      importStarted.resolve(undefined);
      await finishImport.promise;
      imported = true;
      serverEntries = [
        ...serverEntries.filter(({ id }) => id !== savedEntry.id),
        savedEntry,
      ];
      return Response.json({ entries: 1, skipped: 0 });
    }
    if (method === "DELETE") {
      expect(url.pathname.endsWith(`/${savedEntry.id}`)).toBe(true);
      deleted = true;
      serverEntries = serverEntries.filter(({ id }) => id !== savedEntry.id);
      return Response.json({ deleted: 1 });
    }
    return Response.json({
      items: serverEntries,
      nextCursor: null,
      scope: {
        userId: "scoped-history-reader",
        organizationId: "scoped-history-org-a",
      },
    });
  });
  try {
    await importStarted.promise;
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Saved query/u })).toBeTruthy(),
    );
    const row = screen.getByRole("button", {
      name: /Saved query/u,
    }).parentElement;
    if (row === null) {
      throw new TypeError("Saved query row is absent");
    }
    await act(async () => {
      fireEvent.click(
        within(row).getByRole("button", { name: messages.common.remove }),
      );
    });
    await act(async () => finishImport.resolve(undefined));
    await waitFor(() => {
      expect(imported).toBe(true);
      expect(deleted).toBe(true);
      expect(serverEntries).toEqual([]);
      expect(storage.getItem(key)).toBeNull();
    });
    await fixture.client.invalidateQueries({
      queryKey: ["law-search-history"],
    });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /Saved query/u })).toBeNull();
      expect(serverEntries).toEqual([]);
      expect(storage.getItem(key)).toBeNull();
    });
  } finally {
    finishImport.resolve(undefined);
    await fixture.dispose();
    storage.removeItem(key);
  }
});

test("removing a saved query after import failure keeps unrelated local history", async () => {
  const { userStorageKey } = await import("@/lib/account/user-scoped-storage");
  const { readLawRecent } =
    await import("@/lib/law-search-history/law-search-history.logic");
  const key = userStorageKey("law_search_history", {
    kind: "user",
    userId: "scoped-history-reader",
  });
  const storage = browserStateStorage("local");
  storage.setItem(
    key,
    JSON.stringify([
      { query: "  SAVED   query ", at: "2026-01-01T12:00:00Z" },
      { query: "Retained query", at: "2026-01-01T12:00:00Z" },
    ]),
  );
  const savedEntry = { ...seed[0], id: "history-saved", query: "Saved query" };
  let imports = 0;
  let serverEntries = [savedEntry];
  const fixture = await mountServerHistory(async ({ url, method }) => {
    if (url.pathname.endsWith("/import")) {
      imports += 1;
      return Response.json(
        { message: "Temporarily unavailable" },
        { status: 400 },
      );
    }
    if (method === "DELETE") {
      expect(url.pathname.endsWith(`/${savedEntry.id}`)).toBe(true);
      serverEntries = [];
      return Response.json({ deleted: 1 });
    }
    return Response.json({
      items: serverEntries,
      nextCursor: null,
      scope: {
        userId: "scoped-history-reader",
        organizationId: "scoped-history-org-a",
      },
    });
  });
  try {
    await waitFor(() => {
      expect(imports).toBe(1);
      expect(screen.getByRole("button", { name: /Saved query/u })).toBeTruthy();
      expect(screen.getByText(messages.lawHome.importFailed)).toBeTruthy();
    });
    const row = screen.getByRole("button", {
      name: /Saved query/u,
    }).parentElement;
    if (row === null) {
      throw new TypeError("Saved query row is absent");
    }
    await act(async () => {
      fireEvent.click(
        within(row).getByRole("button", { name: messages.common.remove }),
      );
    });
    await waitFor(() => {
      expect(serverEntries).toEqual([]);
      expect(
        readLawRecent(storage.getItem(key))
          .filter((entry) => entry.kind === "search")
          .map(({ query }) => query),
      ).toEqual(["Retained query"]);
      expect(screen.getByText(messages.lawHome.importFailed)).toBeTruthy();
      expect(imports).toBe(1);
    });
  } finally {
    await fixture.dispose();
    storage.removeItem(key);
  }
});

for (const operation of ["clear", "remove"]) {
  test(`${operation} can be retried after a failed server write without losing local history`, async () => {
    const { userStorageKey } =
      await import("@/lib/account/user-scoped-storage");
    const key = userStorageKey("law_search_history", {
      kind: "user",
      userId: "scoped-history-reader",
    });
    const storage = browserStateStorage("local");
    const raw = JSON.stringify([
      { query: "Saved query", at: "2026-01-01T12:00:00Z" },
    ]);
    storage.setItem(key, raw);
    const savedEntry = {
      ...seed[0],
      id: "history-saved",
      query: "Saved query",
    };
    const finishFailedWrite = Promise.withResolvers<undefined>();
    let imports = 0;
    let deleteAttempts = 0;
    let serverEntries = [savedEntry];
    const fixture = await mountServerHistory(async ({ url, method }) => {
      if (url.pathname.endsWith("/import")) {
        imports += 1;
        return Response.json(
          { message: "Temporarily unavailable" },
          { status: 400 },
        );
      }
      if (method === "DELETE") {
        deleteAttempts += 1;
        if (operation === "remove") {
          expect(url.pathname.endsWith(`/${savedEntry.id}`)).toBe(true);
        }
        if (deleteAttempts === 1) {
          await finishFailedWrite.promise;
          return Response.json(
            { message: "Temporarily unavailable" },
            { status: 400 },
          );
        }
        serverEntries = [];
        return Response.json({ deleted: 1 });
      }
      return Response.json({
        items: serverEntries,
        nextCursor: null,
        scope: {
          userId: "scoped-history-reader",
          organizationId: "scoped-history-org-a",
        },
      });
    });
    try {
      await waitFor(() => {
        expect(imports).toBe(1);
        expect(
          screen.getByRole("button", { name: /Saved query/u }),
        ).toBeTruthy();
        expect(screen.getByText(messages.lawHome.importFailed)).toBeTruthy();
        expect(
          screen.getByRole("button", { name: messages.common.retry }),
        ).toBeTruthy();
      });
      if (operation === "clear") {
        await click(messages.lawHome.clearRecent);
        await click(messages.common.delete);
      } else {
        const row = screen.getByRole("button", {
          name: /Saved query/u,
        }).parentElement;
        if (row === null) {
          throw new TypeError("Saved query row is absent");
        }
        await act(async () => {
          fireEvent.click(
            within(row).getByRole("button", { name: messages.common.remove }),
          );
        });
      }
      await waitFor(() => {
        const button = screen.getByRole("button", {
          name:
            operation === "clear"
              ? messages.common.delete
              : messages.common.remove,
        });
        expect(deleteAttempts).toBe(1);
        expect(
          button.hasAttribute("disabled") ||
            button.getAttribute("aria-disabled") === "true",
        ).toBe(true);
      });
      await act(async () => finishFailedWrite.resolve(undefined));
      await waitFor(() => {
        expect(deleteAttempts).toBe(1);
        expect(storage.getItem(key)).toBe(raw);
        expect(screen.getByText(messages.lawHome.importFailed)).toBeTruthy();
        expect(
          screen.getByRole("button", {
            name: messages.common.retry,
            hidden: operation === "clear",
          }),
        ).toBeTruthy();
        if (operation === "clear") {
          expect(screen.getByRole("alertdialog")).toBeTruthy();
          expect(
            screen
              .getByRole("button", { name: messages.common.delete })
              .hasAttribute("disabled"),
          ).toBe(false);
        } else {
          expect(
            screen.getByRole("button", { name: /Saved query/u }),
          ).toBeTruthy();
          expect(
            screen
              .getByRole("button", { name: messages.common.remove })
              .getAttribute("aria-disabled"),
          ).not.toBe("true");
        }
      });

      if (operation === "clear") {
        await click(messages.common.delete);
      } else {
        const row = screen.getByRole("button", {
          name: /Saved query/u,
        }).parentElement;
        if (row === null) {
          throw new TypeError("Saved query row is absent");
        }
        await act(async () => {
          fireEvent.click(
            within(row).getByRole("button", { name: messages.common.remove }),
          );
        });
      }
      await waitFor(() => {
        expect(deleteAttempts).toBe(2);
        expect(serverEntries).toEqual([]);
        expect(storage.getItem(key)).toBeNull();
        expect(screen.queryByText(messages.lawHome.importFailed)).toBeNull();
        expect(screen.getByText(messages.lawHome.noRecent)).toBeTruthy();
        expect(screen.queryByRole("alertdialog")).toBeNull();
        expect(imports).toBe(1);
      });
    } finally {
      finishFailedWrite.resolve(undefined);
      await fixture.dispose();
      storage.removeItem(key);
    }
  });
}

test("a delayed second-client import cannot restore history cleared by the first client", async () => {
  const { QueryClient, QueryClientProvider } =
    await import("@tanstack/react-query");
  const { sessionOptions } = await import("@/lib/auth-query-options");
  const { userStorageKey } = await import("@/lib/account/user-scoped-storage");
  const key = userStorageKey("law_search_history", {
    kind: "user",
    userId: "scoped-history-reader",
  });
  const storage = browserStateStorage("local");
  const raw = JSON.stringify([
    { query: "Saved query", at: "2026-01-01T12:00:00Z" },
  ]);
  storage.removeItem(key);
  storage.removeItem("law_search_history");
  const firstClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, retryDelay: 0 },
      mutations: { retry: false },
    },
  });
  const secondClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, retryDelay: 0 },
      mutations: { retry: false },
    },
  });
  const signedSession = createSignedSession({
    userId: "scoped-history-reader",
    organizationId: "scoped-history-org-a",
  });
  firstClient.setQueryData(sessionOptions.queryKey, signedSession);
  secondClient.setQueryData(sessionOptions.queryKey, signedSession);
  const importStarted = Promise.withResolvers<undefined>();
  const finishImport = Promise.withResolvers<undefined>();
  const savedEntry = { ...seed[0], id: "history-saved", query: "Saved query" };
  let serverEntries = [savedEntry];
  let clearedAt: number | null = null;
  let capturedBatch: unknown;
  let skippedByClearWatermark = 0;
  const transport = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        const method =
          init?.method ?? (input instanceof Request ? input.method : "GET");
        if (url.pathname.endsWith("/import")) {
          const body = readStoredJson(
            typeof init?.body === "string" ? init.body : null,
            queryImportBatchSchema,
          );
          if (body === null) {
            throw new TypeError("Expected an import batch");
          }
          capturedBatch = body;
          importStarted.resolve(undefined);
          await finishImport.promise;
          let accepted = 0;
          let skipped = 0;
          for (const {
            entry: { query },
            usedAt,
          } of body.entries) {
            if (
              clearedAt !== null &&
              Temporal.Instant.from(usedAt).epochMilliseconds <= clearedAt
            ) {
              skipped += 1;
              continue;
            }
            serverEntries = [
              ...serverEntries.filter(
                ({ query: existing }) => existing !== query,
              ),
              { ...savedEntry, query },
            ];
            accepted += 1;
          }
          skippedByClearWatermark += skipped;
          return Response.json({ entries: accepted, skipped });
        }
        if (method === "DELETE") {
          serverEntries = [];
          clearedAt = Temporal.Instant.from(
            "2026-01-02T00:00:00Z",
          ).epochMilliseconds;
          return Response.json({ deleted: 1 });
        }
        return Response.json({
          items: serverEntries,
          nextCursor: null,
          scope: {
            userId: "scoped-history-reader",
            organizationId: "scoped-history-org-a",
          },
        });
      },
      { preconnect: () => undefined },
    ),
  );
  const renderClient = (client: typeof firstClient) =>
    render(
      <QueryClientProvider client={client}>
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <FormattingProvider locale="en" timeZone="UTC">
            <LawRecent onSearch={() => undefined} />
          </FormattingProvider>
        </IntlProvider>
      </QueryClientProvider>,
    );
  try {
    const first = renderClient(firstClient);
    await waitFor(() =>
      expect(
        within(first.container).getByRole("button", { name: /Saved query/u }),
      ).toBeTruthy(),
    );
    await waitFor(() =>
      expect(
        firstClient.getQueryCache().find({
          queryKey: [
            "law-search-history",
            {
              userId: "scoped-history-reader",
              organizationId: "scoped-history-org-a",
            },
            "import",
          ],
          exact: true,
        })?.state.status,
      ).toBe("success"),
    );
    storage.setItem(key, raw);
    const second = renderClient(secondClient);
    await importStarted.promise;
    expect(capturedBatch).toMatchObject({
      entries: [
        {
          entry: { query: "Saved query" },
          usedAt: "2026-01-01T12:00:00Z",
        },
      ],
    });

    await act(async () => {
      fireEvent.click(
        within(first.container).getByRole("button", {
          name: messages.lawHome.clearRecent,
        }),
      );
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: messages.common.delete }),
      );
    });
    await waitFor(() => {
      expect(clearedAt).not.toBeNull();
      expect(serverEntries).toEqual([]);
      expect(storage.getItem(key)).toBeNull();
    });
    await act(async () => finishImport.resolve(undefined));
    await waitFor(() => {
      expect(serverEntries).toEqual([]);
      expect(skippedByClearWatermark).toBe(1);
      expect(storage.getItem(key)).toBeNull();
      expect(
        within(first.container).getByText(messages.lawHome.noRecent),
      ).toBeTruthy();
      expect(
        within(second.container).getByText(messages.lawHome.noRecent),
      ).toBeTruthy();
    });
  } finally {
    finishImport.resolve(undefined);
    await act(async () => cleanup());
    firstClient.clear();
    secondClient.clear();
    transport.mockRestore();
    storage.removeItem(key);
    storage.removeItem("law_search_history");
  }
});
