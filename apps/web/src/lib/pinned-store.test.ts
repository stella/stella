import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, test } from "bun:test";

import {
  installUserScopedStorage,
  releaseUserStorage,
  userStorageKey,
} from "@/lib/account/user-scoped-storage";

const stored = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  writable: true,
  value: {
    clear: () => stored.clear(),
    getItem: (key) => stored.get(key) ?? null,
    key: (index) => [...stored.keys()][index] ?? null,
    get length() {
      return stored.size;
    },
    removeItem: (key) => {
      stored.delete(key);
    },
    setItem: (key, value) => {
      stored.set(key, value);
    },
  },
});

const { usePinnedStore } = await import("@/lib/pinned-store");

describe("pin attention", () => {
  beforeEach(() => {
    stored.clear();
    usePinnedStore.setState({
      pinnedIds: new Set(),
      pinnedOrder: [],
      pinAttention: { type: "idle", sequence: 0 },
    });
  });

  test("requests sidebar attention when a matter is pinned", () => {
    usePinnedStore.getState().togglePin("matter-1");

    expect(usePinnedStore.getState().pinAttention).toEqual({
      type: "pending",
      matterId: "matter-1",
      sequence: 1,
    });
  });

  test("keeps the sequence monotonic after the flash is acknowledged", () => {
    usePinnedStore.getState().togglePin("matter-1");
    usePinnedStore.getState().acknowledgePinAttention(1);
    usePinnedStore.getState().togglePin("matter-1");
    usePinnedStore.getState().togglePin("matter-1");

    expect(usePinnedStore.getState().pinAttention).toEqual({
      type: "pending",
      matterId: "matter-1",
      sequence: 2,
    });
  });

  test("does not clear a newer attention request", () => {
    usePinnedStore.getState().togglePin("matter-1");
    usePinnedStore.getState().togglePin("matter-2");
    usePinnedStore.getState().acknowledgePinAttention(1);

    expect(usePinnedStore.getState().pinAttention).toEqual({
      type: "pending",
      matterId: "matter-2",
      sequence: 2,
    });
  });
});

describe("account-owned pins", () => {
  const emptySession = {
    clear() {},
    getItem: () => null,
    key: () => null,
    length: 0,
    removeItem() {},
    setItem() {},
  } satisfies Storage;
  const areas = () => ({ local: null, session: emptySession });
  beforeEach(() => {
    stored.clear();
    releaseUserStorage(areas());
    usePinnedStore.setState({
      pinnedIds: new Set(),
      pinnedOrder: [],
      pinAttention: { type: "idle", sequence: 0 },
    });
  });

  test("pins follow each account across visitor and account transitions", () => {
    const queryClient = new QueryClient();
    const unsubscribe = installUserScopedStorage(queryClient, areas);
    queryClient.setQueryData(["session"], { user: { id: "user-a" } });
    usePinnedStore.getState().togglePin("matter-a");
    expect(stored.get(userStorageKey("sidebar_pinned"))).toBe('["matter-a"]');
    releaseUserStorage(areas());
    expect(usePinnedStore.getState().pinnedOrder).toEqual([]);
    expect(usePinnedStore.getState().pinnedIds.has("matter-a")).toBe(false);
    expect(usePinnedStore.getState().pinAttention.type).toBe("idle");
    stored.set(
      userStorageKey("sidebar_pinned", { kind: "user", userId: "user-b" }),
      '["matter-b"]',
    );
    queryClient.setQueryData(["session"], { user: { id: "user-b" } });
    expect(usePinnedStore.getState().pinnedOrder).toEqual(["matter-b"]);
    expect(usePinnedStore.getState().pinnedIds.has("matter-a")).toBe(false);
    unsubscribe();
  });

  test.each(["{bad", "{}", "[1]", "null"])(
    "invalid pin entries read as empty: %s",
    (raw) => {
      const queryClient = new QueryClient();
      const unsubscribe = installUserScopedStorage(queryClient, areas);
      const accountKey = userStorageKey("sidebar_pinned", {
        kind: "user",
        userId: "user-a",
      });
      stored.set(accountKey, '["matter-a"]');
      queryClient.setQueryData(["session"], { user: { id: "user-a" } });
      expect(usePinnedStore.getState().pinnedOrder).toEqual(["matter-a"]);
      releaseUserStorage(areas());
      stored.set(accountKey, raw);
      queryClient.setQueryData(["session"], { user: { id: "user-a" } });
      expect(usePinnedStore.getState().pinnedOrder).toEqual([]);
      expect(usePinnedStore.getState().pinnedIds.size).toBe(0);
      unsubscribe();
    },
  );

  test("blocked storage keeps pin interactions in memory across owners", () => {
    const previous = Object.getOwnPropertyDescriptor(
      globalThis,
      "localStorage",
    );
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("Site data is blocked", "SecurityError");
      },
    });
    const queryClient = new QueryClient();
    const unsubscribe = installUserScopedStorage(queryClient, areas);
    try {
      queryClient.setQueryData(["session"], { user: { id: "user-a" } });
      usePinnedStore.getState().togglePin("matter-a");
      expect(usePinnedStore.getState().pinnedOrder).toEqual(["matter-a"]);
      releaseUserStorage(areas());
      expect(usePinnedStore.getState().pinnedOrder).toEqual([]);
      queryClient.setQueryData(["session"], { user: { id: "user-b" } });
      expect(usePinnedStore.getState().pinnedOrder).toEqual([]);
      usePinnedStore.getState().togglePin("matter-b");
      expect(usePinnedStore.getState().pinnedOrder).toEqual(["matter-b"]);
    } finally {
      unsubscribe();
      if (previous) {
        Object.defineProperty(globalThis, "localStorage", previous);
      }
    }
  });
});
