import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import * as v from "valibot";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";
import { Temporal } from "@stll/time";
import { stellaToast } from "@stll/ui/toast";

import messages from "@/i18n/langs/en.json";
import { MEMBER_SESSION } from "@/lib/account/auth-session.test-fixtures";
import { browserStateStorage } from "@/lib/account/browser-storage";
import { userStorageKey } from "@/lib/account/user-scoped-storage";
import { sessionOptions } from "@/lib/auth-query-options";
import { LAW_HISTORY_STORAGE_KEY } from "@/lib/law-search-history/law-search-history.logic";
import { toSafeId } from "@/lib/safe-id";
import { readStoredJson } from "@/lib/stored-json";

GlobalRegistrator.register({ url: "http://localhost:3000/law" });
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { act, cleanup, fireEvent, render, renderHook, waitFor, within } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { lawHistoryKeys, useLawHistory } =
  await import("./law-search-history-query");

afterEach(async () => {
  await act(async () => cleanup());
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

test("server history stays visible while a local import recovers", async () => {
  const storage = browserStateStorage("local");
  const scopedKey = userStorageKey(LAW_HISTORY_STORAGE_KEY, {
    kind: "user",
    userId: MEMBER_SESSION.user.id,
  });
  const local = JSON.stringify([
    { query: "Local query", at: "2026-01-01T12:00:00Z" },
  ]);
  const legacy = JSON.stringify([
    { query: "Earlier query", at: "2026-01-01T12:00:00Z" },
  ]);
  storage.setItem(scopedKey, local);
  storage.setItem(LAW_HISTORY_STORAGE_KEY, legacy);
  const recovery = Promise.withResolvers<undefined>();
  const importBodies: unknown[] = [];
  let imported = false;
  const listReads: { country: string | null; imported: boolean }[] = [];
  let clockRequests = 0;
  const clockSource = spyOn(Temporal.Now, "instant").mockImplementation(() =>
    Temporal.Instant.from("2026-01-01T12:00:00Z").add({
      seconds: clockRequests,
    }),
  );
  const transport = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        if (url.pathname.endsWith("/import-clock")) {
          clockRequests += 1;
          return Response.json({
            issuedAt: "2026-01-01T12:00:00.000Z",
            signature: "a".repeat(64),
          });
        }
        if (url.pathname.endsWith("/import")) {
          importBodies.push(
            typeof init?.body === "string" ? JSON.parse(init.body) : null,
          );
          if (importBodies.length === 1) {
            return Response.json(
              { message: "Temporarily unavailable" },
              { status: 503 },
            );
          }
          await recovery.promise;
          imported = true;
          return Response.json({ entries: 2, skipped: 0, rejected: 0 });
        }
        // Browser history predates jurisdictions, so its import is stored
        // without one and, as the API does, a country filter leaves it out.
        const country = url.searchParams.get("country");
        listReads.push({ country, imported });
        return Response.json({
          items: [
            { query: "Saved query", country: "CZE" },
            ...(imported
              ? [
                  { query: "Local query", country: null },
                  { query: "Earlier query", country: null },
                ]
              : []),
          ]
            .filter((item) => country === null || item.country === country)
            .map((item, index) => ({
              id: `history-${index}`,
              kind: "search",
              ...item,
              firstUsedAt: "2026-01-01T12:00:00Z",
              lastUsedAt: "2026-01-01T12:00:00Z",
              useCount: 1,
            })),
          nextCursor: null,
          scope: {
            userId: MEMBER_SESSION.user.id,
            organizationId: MEMBER_SESSION.session.activeOrganizationId,
          },
        });
      },
      { preconnect: () => undefined },
    ),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retryDelay: 0 } },
  });
  client.setQueryData(sessionOptions.queryKey, MEMBER_SESSION);
  try {
    const { result } = renderHook(
      () => useLawHistory({ filter: "all", country: "CZE" }),
      {
        wrapper: ({ children }) => (
          <QueryClientProvider client={client}>
            <IntlProvider locale="en" messages={messages} timeZone="UTC">
              {children}
            </IntlProvider>
          </QueryClientProvider>
        ),
      },
    );
    await waitFor(() => {
      expect(result.current.list).toMatchObject({
        status: "ready",
        entries: [{ query: "Saved query" }],
      });
    });
    await waitFor(() => expect(importBodies).toHaveLength(2));
    expect(storage.getItem(scopedKey)).toBe(local);
    expect(storage.getItem(LAW_HISTORY_STORAGE_KEY)).toBe(legacy);
    expect(importBodies.at(-1)).toMatchObject({
      clock: {
        issuedAt: "2026-01-01T12:00:00.000Z",
        signature: "a".repeat(64),
      },
      clientNow: "2026-01-01T12:00:02.000Z",
      entries: [
        { entry: { query: "Local query" } },
        { entry: { query: "Earlier query" } },
      ],
    });
    await act(async () => recovery.resolve(undefined));
    await waitFor(() => {
      expect(storage.getItem(scopedKey)).toBeNull();
      expect(storage.getItem(LAW_HISTORY_STORAGE_KEY)).toBeNull();
      expect(listReads.some((read) => read.imported)).toBe(true);
    });
    // The list reread after the import asks for the selected country only.
    expect(listReads.every(({ country }) => country === "CZE")).toBe(true);
    expect(result.current.list).toMatchObject({
      status: "ready",
      entries: [{ query: "Saved query" }],
    });
  } finally {
    recovery.resolve(undefined);
    await act(async () => cleanup());
    client.clear();
    transport.mockRestore();
    clockSource.mockRestore();
    storage.removeItem(scopedKey);
    storage.removeItem(LAW_HISTORY_STORAGE_KEY);
  }
});

test("leaving the page during a local import does not report its cancellation", async () => {
  const storage = browserStateStorage("local");
  const scopedKey = userStorageKey(LAW_HISTORY_STORAGE_KEY, {
    kind: "user",
    userId: MEMBER_SESSION.user.id,
  });
  storage.setItem(
    scopedKey,
    JSON.stringify([{ query: "Local query", at: "2026-01-01T12:00:00Z" }]),
  );
  let clockRequested = false;
  const writes: string[] = [];
  const toasts = spyOn(stellaToast, "add");
  const transport = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        const request = input instanceof Request ? input : undefined;
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        const method = init?.method ?? request?.method ?? "GET";
        if (url.pathname.endsWith("/import-clock")) {
          clockRequested = true;
          const signal = init?.signal ?? request?.signal;
          const pending = Promise.withResolvers<Response>();
          signal?.addEventListener("abort", () =>
            pending.reject(signal.reason),
          );
          return pending.promise;
        }
        if (method === "POST") {
          writes.push(url.pathname);
          return Response.json({ ok: true });
        }
        return Response.json({
          items: [],
          nextCursor: null,
          scope: {
            userId: MEMBER_SESSION.user.id,
            organizationId: MEMBER_SESSION.session.activeOrganizationId,
          },
        });
      },
      { preconnect: () => undefined },
    ),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retryDelay: 0 } },
  });
  client.setQueryData(sessionOptions.queryKey, MEMBER_SESSION);
  try {
    const { result } = renderHook(
      () => useLawHistory({ filter: "all", country: "CZE" }),
      {
        wrapper: ({ children }) => (
          <QueryClientProvider client={client}>
            <IntlProvider locale="en" messages={messages} timeZone="UTC">
              {children}
            </IntlProvider>
          </QueryClientProvider>
        ),
      },
    );
    await waitFor(() => expect(clockRequested).toBe(true));
    act(() =>
      result.current.record.mutate({
        kind: "search",
        query: "Next",
        country: "CZE",
      }),
    );
    await act(async () => client.cancelQueries());
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(toasts).not.toHaveBeenCalled();
  } finally {
    await act(async () => cleanup());
    client.clear();
    toasts.mockRestore();
    transport.mockRestore();
    storage.removeItem(scopedKey);
  }
});

const queryImportBatchSchema = v.object({
  entries: v.array(
    v.object({
      entry: v.object({ kind: v.literal("search"), query: v.string() }),
      usedAt: v.string(),
    }),
  ),
});

test("a delayed second-client import cannot restore history cleared by the first client", async () => {
  const key = userStorageKey(LAW_HISTORY_STORAGE_KEY, {
    kind: "user",
    userId: MEMBER_SESSION.user.id,
  });
  const storage = browserStateStorage("local");
  const raw = JSON.stringify([
    { query: "Saved query", at: "2026-01-01T12:00:00Z" },
  ]);
  storage.removeItem(key);
  storage.removeItem(LAW_HISTORY_STORAGE_KEY);
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
  firstClient.setQueryData(sessionOptions.queryKey, MEMBER_SESSION);
  secondClient.setQueryData(sessionOptions.queryKey, MEMBER_SESSION);
  const importStarted = Promise.withResolvers<undefined>();
  const finishImport = Promise.withResolvers<undefined>();
  const savedEntry = {
    kind: "search",
    country: "CZE",
    firstUsedAt: "2026-01-01T12:00:00Z",
    lastUsedAt: "2026-01-02T12:00:00Z",
    useCount: 1,
    id: toSafeId<"searchHistoryEntry">("history-saved"),
    query: "Saved query",
  } satisfies Extract<
    ReturnType<typeof useLawHistory>["list"],
    { status: "ready" }
  >["entries"][number];
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
        if (url.pathname.endsWith("/import-clock")) {
          return Response.json({
            issuedAt: "2026-01-01T12:00:00.000Z",
            signature: "a".repeat(64),
          });
        }
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
          return Response.json({ entries: accepted, skipped, rejected: 0 });
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
            userId: MEMBER_SESSION.user.id,
            organizationId: MEMBER_SESSION.session.activeOrganizationId,
          },
        });
      },
      { preconnect: () => undefined },
    ),
  );
  let clearCompleted = false;
  const HistoryClient = () => {
    const history = useLawHistory({ filter: "all", country: "CZE" });
    return (
      <>
        <output>{JSON.stringify(history.list)}</output>
        <button
          type="button"
          onClick={() => {
            if (history.scope === null) {
              throw new TypeError("Expected signed-in history scope");
            }
            history.clear.mutate(history.scope, {
              onSuccess: () => {
                clearCompleted = true;
              },
            });
          }}
        >
          {messages.lawHome.clearRecent}
        </button>
      </>
    );
  };
  const renderClient = (client: typeof firstClient) =>
    render(
      <QueryClientProvider client={client}>
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <HistoryClient />
        </IntlProvider>
      </QueryClientProvider>,
    );
  try {
    const first = await act(async () => renderClient(firstClient));
    await waitFor(() =>
      expect(within(first.container).getByRole("status").textContent).toBe(
        JSON.stringify({ status: "ready", entries: [savedEntry] }),
      ),
    );
    await waitFor(() =>
      expect(
        firstClient.getQueryCache().find({
          queryKey: lawHistoryKeys.import({
            userId: MEMBER_SESSION.user.id,
            organizationId: MEMBER_SESSION.session.activeOrganizationId,
          }),
          exact: true,
        })?.state.status,
      ).toBe("success"),
    );
    storage.setItem(key, raw);
    const second = await act(async () => renderClient(secondClient));
    await importStarted.promise;
    await waitFor(() =>
      expect(within(second.container).getByRole("status").textContent).toBe(
        JSON.stringify({ status: "ready", entries: [savedEntry] }),
      ),
    );
    expect(storage.getItem(key)).toBe(raw);
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
    await waitFor(() => {
      expect(clearCompleted).toBe(true);
      expect(clearedAt).not.toBeNull();
      expect(serverEntries).toEqual([]);
      expect(storage.getItem(key)).toBeNull();
    });
    await act(async () => finishImport.resolve(undefined));
    await waitFor(() => {
      expect(serverEntries).toEqual([]);
      expect(skippedByClearWatermark).toBe(1);
      expect(storage.getItem(key)).toBeNull();
      expect(within(first.container).getByRole("status").textContent).toBe(
        JSON.stringify({ status: "ready", entries: [] }),
      );
      expect(within(second.container).getByRole("status").textContent).toBe(
        JSON.stringify({ status: "ready", entries: [] }),
      );
    });
  } finally {
    finishImport.resolve(undefined);
    await act(async () => cleanup());
    firstClient.clear();
    secondClient.clear();
    transport.mockRestore();
    storage.removeItem(key);
    storage.removeItem(LAW_HISTORY_STORAGE_KEY);
  }
});
