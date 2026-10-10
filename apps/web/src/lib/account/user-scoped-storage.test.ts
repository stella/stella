import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, test } from "bun:test";
import fc from "fast-check";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { sleep } from "@stll/concurrency/sleep";
import { assertProperty } from "@stll/property-testing";

import { installUserScopedStorage } from "@/lib/account/install-user-scoped-storage";
import {
  assignUserStorage,
  followStorageOwner,
  forgetUserStorage,
  pruneUserStorage,
  releaseUserStorage,
  storageOwner,
  userScopedStateStorage,
  userStorageKey,
} from "@/lib/account/user-scoped-storage";
import {
  lawRecentKey,
  readLawRecent,
} from "@/lib/law-search-history/law-search-history.logic";

/** A `Storage` held in memory, as a browser tab would hold it. */
class MemoryStorage implements Storage {
  readonly #entries = new Map<string, string>();
  get length() {
    return this.#entries.size;
  }
  clear() {
    this.#entries.clear();
  }
  getItem(key: string) {
    return this.#entries.get(key) ?? null;
  }
  key(index: number) {
    return [...this.#entries.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.#entries.delete(key);
  }
  setItem(key: string, value: string) {
    this.#entries.set(key, value);
  }
}

const HISTORY_A = JSON.stringify([
  { kind: "search", query: "náhrada škody", at: "2026-10-01T10:00:00.000Z" },
]);

const USER_A = { kind: "user", userId: "user-a" } as const;
const USER_B = { kind: "user", userId: "user-b" } as const;
const VISITOR = { kind: "visitor" } as const;

let local = new MemoryStorage();
let session = new MemoryStorage();
const areas = () => ({ local, session });

const keys = (storage: Storage) =>
  Array.from({ length: storage.length }, (_, index) => storage.key(index))
    .filter((key): key is string => key !== null)
    .toSorted();

beforeEach(() => {
  local = new MemoryStorage();
  session = new MemoryStorage();
  releaseUserStorage(areas());
});

describe("per-user storage keys", () => {
  test("an entry is keyed by its owner", () => {
    expect(userStorageKey("law_search_history", USER_A)).toBe(
      "law_search_history:u:user-a",
    );
    expect(userStorageKey("law_search_history", VISITOR)).toBe(
      "law_search_history:visitor",
    );
  });
});

describe("pruneUserStorage", () => {
  test("another user's own history and choices wait for them, and their cached data goes", () => {
    local.setItem(userStorageKey("law_search_history", USER_A), "[]");
    local.setItem(userStorageKey("law_search_history", USER_B), "[]");
    local.setItem("stella-search-recent-searches:org-1::u:user-a", "[]");
    local.setItem("stella-search-recent-searches:org-1::u:user-b", "[]");
    local.setItem("stella-search-recent-files:org-1::u:user-b", "[]");
    local.setItem("stella.chat.alwaysApprovedTools:u:user-b", "[]");
    local.setItem("sidebar_pinned:u:user-b", "[]");
    local.setItem("stella-ui-theme", "dark");

    pruneUserStorage(areas(), USER_B, USER_A);

    expect(keys(local)).toEqual([
      "law_search_history:u:user-a",
      "law_search_history:u:user-b",
      "sidebar_pinned:u:user-b",
      "stella-search-recent-searches:org-1::u:user-a",
      "stella-search-recent-searches:org-1::u:user-b",
      "stella-ui-theme",
    ]);
  });

  test("a visitor's entries go once someone signs in", () => {
    local.setItem(userStorageKey("law_search_history", VISITOR), "[]");

    pruneUserStorage(areas(), VISITOR, USER_A);

    expect(keys(local)).toEqual([]);
  });

  test("entries written before they were keyed go, but the first user takes over the chosen default", () => {
    local.setItem("law_search_history", "not json");
    local.setItem("stella.chat.alwaysApprovedTools", "[]");
    local.setItem(
      "stella.chat.anonymized",
      JSON.stringify({
        state: {
          defaultSendMode: "anonymized",
          sendModes: { "global:thread-1": "rawOverride" },
        },
        version: 2,
      }),
    );

    // No one signed in yet: the chosen default waits for them.
    pruneUserStorage(areas(), VISITOR, VISITOR);
    expect(keys(local)).toEqual([
      "law_search_history",
      "stella.chat.anonymized",
    ]);

    pruneUserStorage(areas(), VISITOR, USER_A);

    expect(keys(local)).toEqual(["stella.chat.anonymized:u:user-a"]);
    expect(
      JSON.parse(local.getItem("stella.chat.anonymized:u:user-a") ?? "null"),
    ).toEqual({ state: { defaultSendMode: "anonymized" }, version: 2 });
  });

  test("a tab's drafts go on from a visitor into their account, and never past a signed-in user", () => {
    session.setItem("stella.provision-question:doc:anchor", "Why?");
    session.setItem(
      userStorageKey("stella.chat.browserApprovalMode", USER_A),
      "ask",
    );

    pruneUserStorage(areas(), VISITOR, USER_A);
    expect(keys(session)).toEqual([
      "stella.chat.browserApprovalMode:u:user-a",
      "stella.provision-question:doc:anchor",
      "stella.storage-owner",
    ]);

    pruneUserStorage(areas(), USER_A, USER_B);
    expect(keys(session)).toEqual(["stella.storage-owner"]);
  });

  test("a reloaded tab still knows who it belonged to", () => {
    // A tab signed in as user A left a draft; its next document starts as a
    // visitor until the session is read.
    session.setItem("stella.storage-owner", "u:user-a");
    session.setItem("stella.provision-question:doc:anchor", "Why?");
    const queryClient = new QueryClient();
    installUserScopedStorage(queryClient, areas);

    queryClient.setQueryData(["session"], null);

    expect(keys(session)).toEqual(["stella.storage-owner"]);
    expect(session.getItem("stella.storage-owner")).toBe("visitor");
  });
});

describe("signing out", () => {
  test("keeps the user's own history and choices for them, clears their cached data, and leaves the visitor as owner", () => {
    const queryClient = new QueryClient();
    installUserScopedStorage(queryClient, areas);
    queryClient.setQueryData(["session"], { user: { id: "user-a" } });
    local.setItem(userStorageKey("law_search_history"), HISTORY_A);
    local.setItem(userStorageKey("stella:inspector-state:v1:org-1:"), "{}");
    local.setItem(userStorageKey("stella.report-exports.active"), "{}");
    local.setItem(userStorageKey("stella-search-recent-files:org-1:"), "[]");
    session.setItem(userStorageKey("stella.chat.browserApprovalMode"), "ask");
    local.setItem("stella-ui-theme", "dark");

    releaseUserStorage(areas());

    expect(storageOwner()).toEqual(VISITOR);
    expect(keys(local)).toEqual([
      "law_search_history:u:user-a",
      "stella-ui-theme",
    ]);
    expect(keys(session)).toEqual(["stella.storage-owner"]);
    // The visitor reads only the visitor's entry.
    expect(local.getItem(userStorageKey("law_search_history"))).toBeNull();

    queryClient.setQueryData(["session"], { user: { id: "user-a" } });
    expect(local.getItem(userStorageKey("law_search_history"))).toBe(HISTORY_A);
  });

  test("a deleted account leaves nothing of the user behind", () => {
    const queryClient = new QueryClient();
    installUserScopedStorage(queryClient, areas);
    queryClient.setQueryData(["session"], { user: { id: "user-a" } });
    local.setItem(userStorageKey("law_search_history"), HISTORY_A);
    local.setItem(userStorageKey("law_search_history", USER_B), HISTORY_A);
    local.setItem("sidebar_pinneduser-a", '["matter-a"]');
    local.setItem("stella-ui-theme", "dark");

    forgetUserStorage("user-a", areas());

    expect(storageOwner()).toEqual(VISITOR);
    expect(keys(local)).toEqual([
      "law_search_history:u:user-b",
      "stella-ui-theme",
    ]);
  });

  test("a deleted account leaves nothing behind after the tab already passed to the visitor", () => {
    const queryClient = new QueryClient();
    installUserScopedStorage(queryClient, areas);
    queryClient.setQueryData(["session"], { user: { id: "user-a" } });
    local.setItem(userStorageKey("law_search_history"), HISTORY_A);
    local.setItem(userStorageKey("law_search_history", USER_B), HISTORY_A);
    local.setItem("sidebar_pinneduser-a", '["matter-a"]');
    local.setItem("sidebar_pinneduser-b", '["matter-b"]');
    // The session ends before the deletion is handled.
    queryClient.setQueryData(["session"], null);
    expect(storageOwner()).toEqual(VISITOR);

    forgetUserStorage("user-a", areas());

    expect(storageOwner()).toEqual(VISITOR);
    expect(keys(local)).toEqual([
      "law_search_history:u:user-b",
      "sidebar_pinneduser-b",
    ]);
  });
});

describe("installUserScopedStorage", () => {
  test("each session read hands the browser to the user it names", () => {
    const queryClient = new QueryClient();
    installUserScopedStorage(queryClient, areas);

    queryClient.setQueryData(["session"], { user: { id: "user-a" } });
    expect(storageOwner()).toEqual(USER_A);
    local.setItem(userStorageKey("law_search_history"), "[]");

    local.setItem(userStorageKey("stella.report-exports.active"), "{}");

    // A different user's session, as after a reload in the same browser:
    // user A's history waits for them, unread; their exports go.
    queryClient.setQueryData(["session"], { user: { id: "user-b" } });
    expect(storageOwner()).toEqual(USER_B);
    expect(keys(local)).toEqual(["law_search_history:u:user-a"]);
    expect(local.getItem(userStorageKey("law_search_history"))).toBeNull();

    // No session: the visitor's own entries go once a user signs in.
    queryClient.setQueryData(["session"], null);
    local.setItem(userStorageKey("law_search_history"), "[]");
    queryClient.setQueryData(["session"], { user: { id: "user-b" } });
    expect(keys(local)).toEqual(["law_search_history:u:user-a"]);
  });

  test("the same user reading their session again keeps their entries", () => {
    const queryClient = new QueryClient();
    installUserScopedStorage(queryClient, areas);
    queryClient.setQueryData(["session"], { user: { id: "user-a" } });
    local.setItem(userStorageKey("law_search_history"), "[]");

    queryClient.setQueryData(["session"], { user: { id: "user-a" } });

    expect(keys(local)).toEqual(["law_search_history:u:user-a"]);
  });
});

describe("a persisted store across owners", () => {
  type Counter = { count: number; bump: () => void };

  const createCounterStore = (storage: Storage) => {
    const store = create<Counter>()(
      persist(
        (set) => ({
          count: 0,
          bump: () => {
            set((state) => ({ count: state.count + 1 }));
          },
        }),
        {
          name: "stella.report-exports.active",
          storage: createJSONStorage(() => userScopedStateStorage(storage)),
          partialize: ({ count }) => ({ count }),
        },
      ),
    );
    followStorageOwner(store);
    return store;
  };

  const storedCount = (key: string): unknown => {
    const stored: unknown = JSON.parse(local.getItem(key) ?? "null");
    return typeof stored === "object" &&
      stored !== null &&
      "state" in stored &&
      typeof stored.state === "object" &&
      stored.state !== null &&
      "count" in stored.state
      ? stored.state.count
      : null;
  };

  const settle = async () => {
    await sleep(0);
  };

  test("a visitor's state gives way to the signed-in user's saved one, untouched", async () => {
    const queryClient = new QueryClient();
    installUserScopedStorage(queryClient, areas);
    const store = createCounterStore(local);
    store.getState().bump();
    local.setItem(
      "stella.report-exports.active:u:user-a",
      JSON.stringify({ state: { count: 5 }, version: 0 }),
    );

    queryClient.setQueryData(["session"], { user: { id: "user-a" } });
    await settle();

    expect(store.getState().count).toBe(5);
    expect(storedCount("stella.report-exports.active:u:user-a")).toBe(5);
  });

  test("the next user's saved state is never written over", async () => {
    const queryClient = new QueryClient();
    installUserScopedStorage(queryClient, areas);
    queryClient.setQueryData(["session"], { user: { id: "user-a" } });
    const store = createCounterStore(local);
    store.getState().bump();
    local.setItem(
      "stella.report-exports.active:u:user-b",
      JSON.stringify({ state: { count: 7 }, version: 0 }),
    );

    queryClient.setQueryData(["session"], { user: { id: "user-b" } });
    await settle();

    expect(store.getState().count).toBe(7);
    expect(storedCount("stella.report-exports.active:u:user-b")).toBe(7);
    expect(local.getItem("stella.report-exports.active:u:user-a")).toBeNull();
  });
});

describe("unavailable browser areas", () => {
  test("account transitions continue and prune reachable areas when tab reads are blocked", () => {
    const blocked = new MemoryStorage();
    blocked.getItem = () => {
      throw new DOMException("Site data is blocked", "SecurityError");
    };
    const queryClient = new QueryClient();
    const blockedAreas = () => ({ local, session: blocked });
    const unsubscribe = installUserScopedStorage(queryClient, blockedAreas);
    queryClient.setQueryData(["session"], { user: { id: "user-a" } });
    local.setItem(userStorageKey("sidebar_pinned"), '["matter-a"]');
    local.setItem(userStorageKey("stella.report-exports.active"), "{}");
    releaseUserStorage(blockedAreas());
    expect(storageOwner()).toEqual(VISITOR);
    expect(keys(local)).toEqual(["sidebar_pinned:u:user-a"]);
    queryClient.setQueryData(["session"], { user: { id: "user-b" } });
    expect(storageOwner()).toEqual(USER_B);
    unsubscribe();
  });
});

describe("entries written before they were keyed by owner", () => {
  const search = (query: string, at: string) => ({
    kind: "search",
    query,
    at,
  });

  test("the first user to sign in takes over the old search history, merged with their own", () => {
    local.setItem(
      "law_search_history",
      JSON.stringify([
        search("vydržení", "2026-09-20T08:00:00.000Z"),
        // Saved by the old format, without a kind.
        { query: "promlčení", at: "2026-09-21T08:00:00.000Z" },
      ]),
    );
    local.setItem(
      userStorageKey("law_search_history", USER_A),
      JSON.stringify([
        search("promlčení", "2026-10-02T08:00:00.000Z"),
        search("náhrada škody", "2026-10-01T08:00:00.000Z"),
      ]),
    );

    // Until someone signs in, the old history waits.
    pruneUserStorage(areas(), VISITOR, VISITOR);
    expect(local.getItem("law_search_history")).not.toBeNull();

    pruneUserStorage(areas(), VISITOR, USER_A);

    expect(keys(local)).toEqual(["law_search_history:u:user-a"]);
    expect(
      JSON.parse(local.getItem("law_search_history:u:user-a") ?? "null"),
    ).toEqual([
      search("promlčení", "2026-10-02T08:00:00.000Z"),
      search("náhrada škody", "2026-10-01T08:00:00.000Z"),
      search("vydržení", "2026-09-20T08:00:00.000Z"),
    ]);
  });

  test("merging preserves all history for server import, newest first", () => {
    const searches = (label: string, hour: string) =>
      Array.from({ length: 28 }, (_, index) =>
        search(
          `${label} ${index}`,
          `2026-09-${String(index + 1).padStart(2, "0")}T${hour}:00:00.000Z`,
        ),
      );
    local.setItem("law_search_history", JSON.stringify(searches("old", "08")));
    local.setItem(
      userStorageKey("law_search_history", USER_A),
      JSON.stringify(searches("own", "20")),
    );

    pruneUserStorage(areas(), VISITOR, USER_A);

    const raw = local.getItem("law_search_history:u:user-a");
    const stored: unknown = JSON.parse(raw ?? "null");
    expect(Array.isArray(stored) ? stored.length : null).toBe(56);
    // Stored as it reads back: newest first, without repeats.
    expect(raw).toBe(JSON.stringify(readLawRecent(raw)));
    expect(readLawRecent(raw).map(lawRecentKey).at(0)).toBe("search:own 27");
  });

  test("an entry written for one user waits for that user, then joins their own", () => {
    local.setItem("sidebar_pinneduser-a", '["matter-1","matter-2"]');
    local.setItem(userStorageKey("sidebar_pinned", USER_A), '["matter-2"]');
    local.setItem(
      "stella-search-recent-searches:org-1:user-a",
      '[{"query":"lease","searchedAt":"2026-09-20T08:00:00.000Z"}]',
    );

    pruneUserStorage(areas(), VISITOR, USER_B);
    expect(keys(local)).toEqual([
      "sidebar_pinned:u:user-a",
      "sidebar_pinneduser-a",
      "stella-search-recent-searches:org-1:user-a",
    ]);

    pruneUserStorage(areas(), USER_B, USER_A);
    expect(keys(local)).toEqual([
      "sidebar_pinned:u:user-a",
      "stella-search-recent-searches:org-1::u:user-a",
    ]);
    expect(local.getItem("sidebar_pinned:u:user-a")).toBe(
      '["matter-2","matter-1"]',
    );
  });
});

describe("signing in and out over time", () => {
  const step = fc.oneof(
    fc.record({
      type: fc.constant("sign-in" as const),
      userId: fc.constantFrom("a", "b", "c"),
    }),
    fc.constant({ type: "sign-out" as const }),
    fc.constant({ type: "write" as const }),
    // The account is deleted, whoever the tab holds by then.
    fc.record({
      type: fc.constant("forget" as const),
      userId: fc.constantFrom("a", "b", "c"),
    }),
    // An entry from before entries were keyed by owner, naming its user.
    fc.record({
      type: fc.constant("legacy-write" as const),
      userId: fc.constantFrom("a", "b", "c"),
    }),
  );
  const PINNED = "sidebar_pinned";
  // A kept family (search history) and a cleared one (running exports).
  const KEPT = "law_search_history";
  const CLEARED = "stella.report-exports.active";
  const ownerName = (owner: ReturnType<typeof storageOwner>) =>
    owner.kind === "user" ? owner.userId : "visitor";

  test("nobody reads another owner's entries, and nobody loses their own history", () => {
    assertProperty(
      "nobody reads another owner's entries, and nobody loses their own history",
      fc.property(fc.array(step), (steps) => {
        local = new MemoryStorage();
        session = new MemoryStorage();
        releaseUserStorage(areas());
        // What each owner last wrote and may read back.
        const kept = new Map<string, string>();
        const cleared = new Map<string, string>();
        // Users with a pre-keying pinned entry waiting, and with one adopted.
        const legacyPinned = new Set<string>();
        const pinned = new Set<string>();
        // Every user a step has named so far.
        const known = new Set<string>();
        const leave = (previous: string, next: string) => {
          if (previous === next) {
            return;
          }
          cleared.delete(previous);
          if (previous === "visitor") {
            kept.delete("visitor");
          }
        };
        for (const [index, current] of steps.entries()) {
          const before = ownerName(storageOwner());
          if (current.type !== "sign-out" && current.type !== "write") {
            known.add(current.userId);
          }
          switch (current.type) {
            case "sign-in":
              assignUserStorage(current.userId, areas());
              leave(before, current.userId);
              if (legacyPinned.delete(current.userId)) {
                pinned.add(current.userId);
              }
              break;
            case "sign-out":
              releaseUserStorage(areas());
              leave(before, "visitor");
              break;
            case "write": {
              // Unique per owner and step, so a read names its writer.
              const value = `${before}#${index}`;
              local.setItem(userStorageKey(KEPT), value);
              local.setItem(userStorageKey(CLEARED), value);
              kept.set(before, value);
              cleared.set(before, value);
              break;
            }
            case "forget":
              forgetUserStorage(current.userId, areas());
              leave(before, "visitor");
              kept.delete(current.userId);
              legacyPinned.delete(current.userId);
              pinned.delete(current.userId);
              break;
            case "legacy-write":
              local.setItem(`${PINNED}${current.userId}`, '["matter"]');
              legacyPinned.add(current.userId);
              break;
            default:
              current satisfies never;
          }
          const owner = ownerName(storageOwner());
          expect(local.getItem(userStorageKey(KEPT))).toBe(
            kept.get(owner) ?? null,
          );
          expect(local.getItem(userStorageKey(CLEARED))).toBe(
            cleared.get(owner) ?? null,
          );
          // Every user's history is still in the browser, under their key.
          for (const [userId, value] of kept) {
            if (userId !== "visitor") {
              expect(
                local.getItem(userStorageKey(KEPT, { kind: "user", userId })),
              ).toBe(value);
            }
          }
          // A deleted user's entries go; everyone else's stay as they were.
          for (const userId of known) {
            const user = { kind: "user", userId } as const;
            expect(local.getItem(userStorageKey(KEPT, user))).toBe(
              kept.get(userId) ?? null,
            );
            expect(local.getItem(`${PINNED}${userId}`) !== null).toBe(
              legacyPinned.has(userId),
            );
            expect(local.getItem(userStorageKey(PINNED, user)) !== null).toBe(
              pinned.has(userId),
            );
          }
        }
      }),
    );
  });
});
