import * as v from "valibot";
import { create } from "zustand";

import { browserStateStorage } from "@/lib/account/browser-storage";
import {
  onStorageOwnerChange,
  userStorageKey,
} from "@/lib/account/user-scoped-storage";
import { readStoredJson, writeStoredJson } from "@/lib/stored-json";

const PINNED_LS_PREFIX = "sidebar_pinned";

const PinnedIdsSchema = v.array(v.string());

type PinAttention =
  | { type: "idle"; sequence: number }
  | { type: "pending"; matterId: string; sequence: number };

const readFromStorage = (): string[] => {
  const stored = readStoredJson(
    browserStateStorage("local").getItem(userStorageKey(PINNED_LS_PREFIX)),
    PinnedIdsSchema,
  );
  if (stored === null) {
    return [];
  }
  return stored;
};

const writeToStorage = (ids: readonly string[]) => {
  writeStoredJson(
    browserStateStorage("local"),
    userStorageKey(PINNED_LS_PREFIX),
    ids,
  );
};

type PinnedStore = {
  pinnedIds: Set<string>;
  pinnedOrder: string[];
  pinAttention: PinAttention;
  togglePin: (id: string) => void;
  acknowledgePinAttention: (sequence: number) => void;
  isPinned: (id: string) => boolean;
  reorder: (draggedId: string, targetId: string) => void;
};

export const usePinnedStore = create<PinnedStore>((set, get) => ({
  pinnedIds: new Set(),
  pinnedOrder: [],
  pinAttention: { type: "idle", sequence: 0 },
  togglePin: (id) => {
    const { pinnedOrder, pinAttention } = get();
    if (pinnedOrder.includes(id)) {
      const next = pinnedOrder.filter((pinnedId) => pinnedId !== id);
      writeToStorage(next);
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
    writeToStorage(next);
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
    const { pinnedOrder } = get();
    const fromIdx = pinnedOrder.indexOf(draggedId);
    const toIdx = pinnedOrder.indexOf(targetId);
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) {
      return;
    }
    const next = pinnedOrder.toSpliced(fromIdx, 1);
    const adjustedIdx = fromIdx < toIdx ? toIdx - 1 : toIdx;
    next.splice(adjustedIdx, 0, draggedId);
    writeToStorage(next);
    set({ pinnedOrder: next, pinnedIds: new Set(next) });
  },
}));

const hydratePins = () => {
  const order = readFromStorage();
  usePinnedStore.setState({
    pinnedOrder: order,
    pinnedIds: new Set(order),
    pinAttention: { type: "idle", sequence: 0 },
  });
};
onStorageOwnerChange(hydratePins);
hydratePins();
