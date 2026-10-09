import { QueryClient } from "@tanstack/react-query";
import { afterAll, describe, expect, test } from "bun:test";

import { sleep } from "@stll/concurrency/sleep";

// The browser this test signs out of: its storage and the sign-out endpoint.
const local = new Map<string, string>();
const memoryStorage = {
  get length() {
    return local.size;
  },
  clear: () => {
    local.clear();
  },
  getItem: (key: string) => local.get(key) ?? null,
  key: (index: number) => [...local.keys()][index] ?? null,
  removeItem: (key: string) => {
    local.delete(key);
  },
  setItem: (key: string, value: string) => {
    local.set(key, value);
  },
};

const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async () => {
    await Promise.resolve();
    return Response.json({ message: "unavailable" }, { status: 503 });
  },
  { preconnect: () => undefined },
);

const { signOutAndRelease } = await import("@/hooks/use-sign-out");
const { installUserScopedStorage } =
  await import("@/lib/account/install-user-scoped-storage");
const { storageOwner, userStorageKey } =
  await import("@/lib/account/user-scoped-storage");

const HISTORY = JSON.stringify([
  { kind: "search", query: "náhrada škody", at: "2026-10-01T10:00:00.000Z" },
]);

afterAll(() => {
  globalThis.fetch = originalFetch;
});

const areas = () => ({ local: memoryStorage, session: null });

describe("signing out", () => {
  test("keeps only the user's own history for them and tells the other tabs, even when the server refuses", async () => {
    const queryClient = new QueryClient();
    installUserScopedStorage(queryClient, areas);
    queryClient.setQueryData(["session"], { user: { id: "user-a" } });
    local.set("law_search_history:u:user-a", HISTORY);
    local.set("stella.report-exports.active:u:user-a", "{}");
    local.set("stella.chat.alwaysApprovedTools:u:user-a", "[]");
    const received: unknown[] = [];
    const otherTab = new BroadcastChannel("stella.session");
    otherTab.addEventListener("message", (event: MessageEvent<unknown>) => {
      received.push(event.data);
    });

    const result = await signOutAndRelease(areas());
    await sleep(20);

    expect(result.error).not.toBeNull();
    expect(storageOwner()).toEqual({ kind: "visitor" });
    expect([...local.keys()]).toEqual(["law_search_history:u:user-a"]);
    expect(received).toHaveLength(1);
    otherTab.close();

    // Signing back in as the same user finds the history intact; another
    // user signing in on this browser reads none of it.
    queryClient.setQueryData(["session"], { user: { id: "user-b" } });
    expect(local.get(userStorageKey("law_search_history")) ?? null).toBeNull();
    queryClient.setQueryData(["session"], { user: { id: "user-a" } });
    expect(local.get(userStorageKey("law_search_history"))).toBe(HISTORY);
  });
});
