import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";

import messages from "@/i18n/langs/en.json";
import { browserStateStorage } from "@/lib/account/browser-storage";
import { userStorageKey } from "@/lib/account/user-scoped-storage";
import { sessionOptions } from "@/lib/auth-query-options";
import { MEMBER_SESSION } from "@/lib/auth-session.test-fixtures";
import { LAW_HISTORY_STORAGE_KEY } from "@/lib/law-search-history/law-search-history.logic";

GlobalRegistrator.register({ url: "http://localhost:3000/law" });
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { act, cleanup, renderHook, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { useLawHistory } = await import("./law-search-history-query");

afterEach(async () => {
  await act(async () => cleanup());
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
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
  const transport = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
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
          return Response.json({ entries: 2, skipped: 0 });
        }
        return Response.json({
          items: (imported
            ? ["Saved query", "Local query", "Earlier query"]
            : ["Saved query"]
          ).map((query, index) => ({
            id: `history-${index}`,
            kind: "search",
            query,
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
    const { result } = renderHook(() => useLawHistory(), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>
          <IntlProvider locale="en" messages={messages} timeZone="UTC">
            {children}
          </IntlProvider>
        </QueryClientProvider>
      ),
    });
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
      entries: [
        { entry: { query: "Local query" } },
        { entry: { query: "Earlier query" } },
      ],
    });
    await act(async () => recovery.resolve(undefined));
    await waitFor(() => {
      expect(result.current.list).toMatchObject({
        status: "ready",
        entries: [
          { query: "Saved query" },
          { query: "Local query" },
          { query: "Earlier query" },
        ],
      });
      expect(storage.getItem(scopedKey)).toBeNull();
      expect(storage.getItem(LAW_HISTORY_STORAGE_KEY)).toBeNull();
    });
  } finally {
    recovery.resolve(undefined);
    await act(async () => cleanup());
    client.clear();
    transport.mockRestore();
    storage.removeItem(scopedKey);
    storage.removeItem(LAW_HISTORY_STORAGE_KEY);
  }
});
