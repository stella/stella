import { create } from "zustand";

const PINNED_LS_PREFIX = "sidebar_pinned_";

const readFromStorage = (userId: string): string[] => {
  try {
    const raw = localStorage.getItem(PINNED_LS_PREFIX + userId);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) {
        return parsed as string[];
      }
    }
    return [];
  } catch {
    return [];
  }
};

const writeToStorage = (userId: string, ids: string[]) => {
  localStorage.setItem(PINNED_LS_PREFIX + userId, JSON.stringify(ids));
};

type PinnedStore = {
  userId: string;
  pinnedIds: Set<string>;
  pinnedOrder: string[];
  init: (userId: string) => void;
  togglePin: (id: string) => void;
  isPinned: (id: string) => boolean;
  reorder: (draggedId: string, targetId: string) => void;
};

export const usePinnedStore = create<PinnedStore>((set, get) => ({
  userId: "",
  pinnedIds: new Set(),
  pinnedOrder: [],
  init: (userId) => {
    if (get().userId === userId) {
      return;
    }
    const order = readFromStorage(userId);
    set({ userId, pinnedOrder: order, pinnedIds: new Set(order) });
  },
  togglePin: (id) => {
    const { userId, pinnedOrder } = get();
    let next: string[];
    if (pinnedOrder.includes(id)) {
      next = pinnedOrder.filter((v) => v !== id);
    } else {
      next = [...pinnedOrder, id];
    }
    writeToStorage(userId, next);
    set({ pinnedOrder: next, pinnedIds: new Set(next) });
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
