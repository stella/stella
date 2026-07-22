import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { ChatEditModeOptionId } from "@/lib/chat-edit-mode";
import {
  chatEditModeSelectionForOptionId,
  DEFAULT_CHAT_EDIT_MODE_OPTION_ID,
  isChatEditModeOptionId,
} from "@/lib/chat-edit-mode";

/**
 * Org-wide preference for the composer's edit-mode dropdown (auto ·
 * tracked changes / auto · rewrite / manual review), mirroring
 * `chat-anonymized-store.ts`'s shape: one persisted choice that every
 * DOCX-capable chat surface inherits until the user changes it, not a
 * per-thread override (Template Studio pins its own `manual` value
 * regardless of this store -- see `template-studio-chat.tsx`).
 */
type ChatEditModeStore = {
  optionId: ChatEditModeOptionId;
  setOptionId: (optionId: ChatEditModeOptionId) => void;
};

const DEFAULT_OPTION_ID = DEFAULT_CHAT_EDIT_MODE_OPTION_ID;

const readPersistedOptionId = (
  persisted: unknown,
): ChatEditModeOptionId | null => {
  if (typeof persisted !== "object" || persisted === null) {
    return null;
  }

  if ("optionId" in persisted && isChatEditModeOptionId(persisted.optionId)) {
    return persisted.optionId;
  }

  return null;
};

export const useChatEditModeStore = create<ChatEditModeStore>()(
  persist(
    (set) => ({
      optionId: DEFAULT_OPTION_ID,
      setOptionId: (optionId) => {
        set({ optionId });
      },
    }),
    {
      name: "stella.chat.editApplyMode",
      version: 1,
      partialize: ({ optionId }) => ({ optionId }),
      migrate: (persisted) => ({
        optionId: readPersistedOptionId(persisted) ?? DEFAULT_OPTION_ID,
      }),
    },
  ),
);

/** Non-hook read for transport getters (`getEditApplyMode` /
 *  `getDocxEditRepresentation` in `file-chat-overlay.tsx`), mirroring
 *  `getChatSendMode` in `chat-anonymized-store.ts`. */
export const getChatEditModeSelection = () =>
  chatEditModeSelectionForOptionId(useChatEditModeStore.getState().optionId);
