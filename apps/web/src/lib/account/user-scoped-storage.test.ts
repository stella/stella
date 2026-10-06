import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, test } from "bun:test";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import {
  followStorageOwner,
  installUserScopedStorage,
  pruneUserStorage,
  releaseUserStorage,
  storageOwner,
  userScopedStateStorage,
  userStorageKey,
} from "@/lib/account/user-scoped-storage";

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
  test("a signed-in user keeps only their own entries", () => {
    local.setItem(userStorageKey("law_search_history", USER_A), "[]");
    local.setItem(userStorageKey("law_search_history", USER_B), "[]");
    local.setItem("stella-search-recent-searches:org-1::u:user-a", "[]");
    local.setItem("stella-search-recent-searches:org-1::u:user-b", "[]");
    local.setItem("sidebar_pinned:u:user-b", "[]");
    local.setItem("stella-ui-theme", "dark");

    pruneUserStorage(areas(), USER_A, USER_A);

    expect(keys(local)).toEqual([
      "law_search_history:u:user-a",
      "stella-search-recent-searches:org-1::u:user-a",
      "stella-ui-theme",
    ]);
  });

  test("a visitor's entries go once someone signs in", () => {
    local.setItem(userStorageKey("law_search_history", VISITOR), "[]");

    pruneUserStorage(areas(), VISITOR, USER_A);

    expect(keys(local)).toEqual([]);
  });

  test("entries written before they were keyed go, but the first user takes over the chosen default", () => {
    local.setItem("law_search_history", "[]");
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
    expect(keys(local)).toEqual(["stella.chat.anonymized"]);

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
  test("clears the user's entries and leaves the visitor as owner", () => {
    const queryClient = new QueryClient();
    installUserScopedStorage(queryClient, areas);
    queryClient.setQueryData(["session"], { user: { id: "user-a" } });
    local.setItem(userStorageKey("law_search_history"), "[]");
    local.setItem("stella:inspector-state:v1:org-1:user-a", "{}");
    local.setItem("stella-ui-theme", "dark");

    releaseUserStorage(areas());

    expect(storageOwner()).toEqual(VISITOR);
    expect(keys(local)).toEqual(["stella-ui-theme"]);
  });
});

describe("installUserScopedStorage", () => {
  test("each session read hands the browser to the user it names", () => {
    const queryClient = new QueryClient();
    installUserScopedStorage(queryClient, areas);

    queryClient.setQueryData(["session"], { user: { id: "user-a" } });
    expect(storageOwner()).toEqual(USER_A);
    local.setItem(userStorageKey("law_search_history"), "[]");

    // A different user's session, as after a reload in the same browser.
    queryClient.setQueryData(["session"], { user: { id: "user-b" } });
    expect(storageOwner()).toEqual(USER_B);
    expect(keys(local)).toEqual([]);

    // No session: only a visitor's entries may stay.
    local.setItem(userStorageKey("law_search_history"), "[]");
    queryClient.setQueryData(["session"], null);
    expect(storageOwner()).toEqual(VISITOR);
    expect(keys(local)).toEqual([]);
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
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
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
    releaseUserStorage(blockedAreas());
    expect(storageOwner()).toEqual(VISITOR);
    expect(keys(local)).toEqual([]);
    queryClient.setQueryData(["session"], { user: { id: "user-b" } });
    expect(storageOwner()).toEqual(USER_B);
    unsubscribe();
  });
});
