import * as v from "valibot";
import { create } from "zustand";

import { readStoredJson, writeStoredJson } from "@/lib/stored-json";

const PINNED_LS_PREFIX = "sidebar_pinned_";

const PinnedIdsSchema = v.array(v.string());

type PinAttention =
  | { type: "idle"; sequence: number }
  | { type: "pending"; matterId: string; sequence: number };

const readFromStorage = (userId: string): string[] => {
  try {
    const raw = localStorage.getItem(PINNED_LS_PREFIX + userId);
    const stored = readStoredJson(raw, PinnedIdsSchema);
    if (stored === null) {
      return [];
    }
    return stored;
  } catch {
    return [];
  }
};

const writeToStorage = (userId: string, ids: readonly string[]) => {
  writeStoredJson(localStorage, PINNED_LS_PREFIX + userId, ids);
};

type PinnedStore = {
  userId: string;
  pinnedIds: Set<string>;
  pinnedOrder: string[];
  pinAttention: PinAttention;
  init: (userId: string) => void;
  togglePin: (id: string) => void;
  acknowledgePinAttention: (sequence: number) => void;
  isPinned: (id: string) => boolean;
  reorder: (draggedId: string, targetId: string) => void;
};

export const usePinnedStore = create<PinnedStore>((set, get) => ({
  userId: "",
  pinnedIds: new Set(),
  pinnedOrder: [],
  pinAttention: { type: "idle", sequence: 0 },
  init: (userId) => {
    if (get().userId === userId) {
      return;
    }
    const order = readFromStorage(userId);
    set({
      userId,
      pinnedOrder: order,
      pinnedIds: new Set(order),
      pinAttention: { type: "idle", sequence: 0 },
    });
  },
  togglePin: (id) => {
    const { userId, pinnedOrder, pinAttention } = get();
    if (pinnedOrder.includes(id)) {
      const next = pinnedOrder.filter((pinnedId) => pinnedId !== id);
      writeToStorage(userId, next);
      set({
        pinnedOrder: next,
        pinnedIds: new Set(next),
        pinAttention:
          pinAttention.type === "pending" && pinAttention.matterId === id
            ? { type: "idle", sequence: pinAttention.sequence }
            : pinAttention,
      });
      return;
    }

    const next = [...pinnedOrder, id];
    writeToStorage(userId, next);
    set({
      pinnedOrder: next,
      pinnedIds: new Set(next),
      pinAttention: {
        type: "pending",
        matterId: id,
        sequence: pinAttention.sequence + 1,
      },
    });
  },
  acknowledgePinAttention: (sequence) => {
    const { pinAttention } = get();
    if (pinAttention.type !== "pending" || pinAttention.sequence !== sequence) {
      return;
    }
    set({ pinAttention: { type: "idle", sequence } });
  },
  isPinned: (id) => get().pinnedIds.has(id),
  reorder: (draggedId, targetId) => {
    const { userId, pinnedOrder } = get();
    const fromIdx = pinnedOrder.indexOf(draggedId);
    const toIdx = pinnedOrder.indexOf(targetId);
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) {
      return;
    }
    const next = pinnedOrder.toSpliced(fromIdx, 1);
    const adjustedIdx = fromIdx < toIdx ? toIdx - 1 : toIdx;
    next.splice(adjustedIdx, 0, draggedId);
    writeToStorage(userId, next);
    set({ pinnedOrder: next, pinnedIds: new Set(next) });
  },
}));
