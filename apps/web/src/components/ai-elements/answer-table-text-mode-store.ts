import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { TableCellText } from "@stll/ui/table";

import { browserStateStorage } from "@/lib/account/browser-storage";
import {
  followStorageOwner,
  userScopedStateStorage,
} from "@/lib/account/user-scoped-storage";

/**
 * How an answer table lays out cell text: `wrap` breaks long cells over
 * several lines, `single-line` keeps each cell on one line and scrolls the
 * table sideways instead. The table primitive owns the vocabulary.
 */
export type AnswerTableTextMode = TableCellText;

export const ANSWER_TABLE_TEXT_MODE_STORAGE_KEY = "stella.answerTable.textMode";

type PersistedAnswerTableTextMode = { mode: AnswerTableTextMode };

type AnswerTableTextModeStore = PersistedAnswerTableTextMode & {
  setMode: (mode: AnswerTableTextMode) => void;
};

/** Typed `unknown` on purpose: it reads stored JSON. */
const readPersistedState = (
  persisted: unknown,
): PersistedAnswerTableTextMode => {
  if (
    typeof persisted === "object" &&
    persisted !== null &&
    "mode" in persisted &&
    persisted.mode === "single-line"
  ) {
    return { mode: "single-line" };
  }
  return { mode: "wrap" };
};

/**
 * The viewer's last choice, shared by every answer table on the page. A
 * convenience kept in this browser for this viewer alone: storage that is
 * blocked or full leaves the choice in memory for the session.
 */
export const useAnswerTableTextModeStore = create<AnswerTableTextModeStore>()(
  persist(
    (set) => ({
      mode: "wrap",
      setMode: (mode) => {
        set({ mode });
      },
    }),
    {
      name: ANSWER_TABLE_TEXT_MODE_STORAGE_KEY,
      storage: createJSONStorage(() =>
        userScopedStateStorage(browserStateStorage("local")),
      ),
      partialize: ({ mode }) => ({ mode }),
      version: 1,
      migrate: (persisted) => readPersistedState(persisted),
      merge: (persisted, current) => ({
        ...current,
        ...readPersistedState(persisted),
      }),
    },
  ),
);

followStorageOwner(useAnswerTableTextModeStore);
