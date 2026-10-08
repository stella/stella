import { useState } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";

import arabicMessages from "@/i18n/langs/ar.json";
import messages from "@/i18n/langs/en.json";
import { browserStateStorage } from "@/lib/account/browser-storage";
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
    courtAbbreviation: "NS",
    courtTier: "supreme",
  },
  {
    ...usage,
    kind: "decision",
    id: toSafeId<"searchHistoryEntry">("history-unknown"),
    documentId: "decision-2",
    title: "47 C 57/2023",
    path: "/law/cz/cases/unknown/decision-2",
    courtId: null,
    courtAbbreviation: null,
    courtTier: null,
  },
  {
    ...usage,
    kind: "decision",
    id: toSafeId<"searchHistoryEntry">("history-untiered"),
    documentId: "decision-3",
    title: "23 Cdo 1002/2021 · Nejvyšší soud",
    path: "/law/cz/cases/supreme/decision-3",
    courtId: null,
    courtAbbreviation: "NS",
    courtTier: null,
  },
  {
    ...usage,
    kind: "statute",
    id: toSafeId<"searchHistoryEntry">("history-statute"),
    documentId: "statute-1",
    title: "Act",
    path: "/law/cz/statutes/statute-1",
    statuteNumber: "172",
    statuteYear: "2026",
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

const mount = async (locale = "en") => {
  const calls = {
    searches: [] as string[],
    deletes: [] as string[],
    clears: 0,
  };
  const Fixture = () => {
    const [entries, setEntries] = useState([...seed]);
    return (
      <LawRecentList
        onSearch={(query) => calls.searches.push(query)}
        history={{
          entries,
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
  let serverQuery = seed[0].query.toString();
  let nextRead: Promise<void> | undefined;
  const transport = spyOn(globalThis, "fetch").mockImplementation(
    async (input, init) => {
      const path = new URL(String(input)).pathname;
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
      if (nextRead !== undefined) {
        await nextRead;
      }
      return Response.json({
        items: [{ ...seed[0], query }],
        nextCursor: null,
        limit: 20,
      });
    },
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const signedAt = new Date("2026-01-01T00:00:00Z");
  const signedSession = {
    session: {
      activeOrganizationId: "history-org",
      createdAt: signedAt,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      id: "session_1",
      token: "token",
      updatedAt: signedAt,
      userId: "history-reader",
    },
    user: {
      createdAt: signedAt,
      email: "reader@example.test",
      emailVerified: true,
      id: "history-reader",
      name: "Reader",
      timezoneId: "UTC",
      twoFactorEnabled: false,
      updatedAt: signedAt,
      userShortcuts: null,
    },
  };
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
    await act(async () => {
      client.setQueryData(sessionOptions.queryKey, {
        ...signedSession,
        session: {
          ...signedSession.session,
          activeOrganizationId: "history-org-two",
        },
      });
    });
    expect(screen.queryByRole("button", { name: /náhrada škody/u })).toBeNull();
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
    await act(async () => {
      client.setQueryData(sessionOptions.queryKey, {
        ...signedSession,
        session: { ...signedSession.session, userId: "history-other-reader" },
        user: { ...signedSession.user, id: "history-other-reader" },
      });
    });
    expect(
      screen.queryByRole("button", { name: /other organization query/u }),
    ).toBeNull();
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
