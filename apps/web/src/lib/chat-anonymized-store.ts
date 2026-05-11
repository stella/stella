import { create } from "zustand";
import { persist } from "zustand/middleware";

import {
  CHAT_SEND_MODE,
  getPreferredChatSendMode,
  isChatSendMode,
} from "@stll/anonymize-chat";
import type { ChatSendMode } from "@stll/anonymize-chat";

import type { ChatThreadRef } from "@/lib/chat-thread-ref";

type ChatAnonymizedStore = {
  /**
   * Single org-wide preference: once toggled on, every chat (new
   * or reopened) inherits the setting until the user turns it back
   * off. The off state is explicit `rawOverride`, not an absent
   * boolean, so every transport request has the same shared mode
   * shape.
   */
  sendMode: ChatSendMode;
  setAnonymized: (anonymized: boolean) => void;
};

const DEFAULT_SEND_MODE = CHAT_SEND_MODE.rawOverride;

export const useChatAnonymizedStore = create<ChatAnonymizedStore>()(
  persist(
    (set) => ({
      sendMode: DEFAULT_SEND_MODE,
      setAnonymized: (anonymized) => {
        set({ sendMode: getPreferredChatSendMode(anonymized) });
      },
    }),
    {
      name: "stella.chat.anonymized",
      partialize: ({ sendMode }) => ({ sendMode }),
      version: 1,
      migrate: (persisted) => ({
        sendMode: readPersistedSendMode(persisted) ?? DEFAULT_SEND_MODE,
      }),
    },
  ),
);

// `threadRef` is kept on the public API so call sites don't have to change
// when we eventually re-introduce per-thread overrides.
export const useChatAnonymized = (_threadRef: ChatThreadRef): boolean =>
  useChatAnonymizedStore((s) => s.sendMode === CHAT_SEND_MODE.anonymized);

export const useSetChatAnonymized = (_threadRef: ChatThreadRef) =>
  useChatAnonymizedStore((s) => s.setAnonymized);

export const getChatSendMode = (_threadRef: ChatThreadRef): ChatSendMode =>
  useChatAnonymizedStore.getState().sendMode;

const readPersistedSendMode = (persisted: unknown): ChatSendMode | null => {
  if (typeof persisted !== "object" || persisted === null) {
    return null;
  }

  if ("sendMode" in persisted && isChatSendMode(persisted.sendMode)) {
    return persisted.sendMode;
  }

  if ("anonymized" in persisted && typeof persisted.anonymized === "boolean") {
    return getPreferredChatSendMode(persisted.anonymized);
  }

  return null;
};
