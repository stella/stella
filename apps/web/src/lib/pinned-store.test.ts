import { beforeEach, describe, expect, test } from "bun:test";

const stored = new Map<string, string>();
globalThis.localStorage = {
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
};

const { usePinnedStore } = await import("@/lib/pinned-store");

describe("pin attention", () => {
  beforeEach(() => {
    stored.clear();
    usePinnedStore.setState({
      userId: "user-1",
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
