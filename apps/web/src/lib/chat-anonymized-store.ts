import { create } from "zustand";
import { persist } from "zustand/middleware";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";
import type { ChatSendModeOverride } from "@stll/anonymize-chat";

import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { getChatThreadKey } from "@/lib/chat-thread-ref";

type ChatAnonymizedStore = {
  /** Single org-wide preference: once toggled on, every chat (new or reopened)
   *  inherits the setting until the user turns it back off. */
  anonymized: boolean;
  setAnonymized: (anonymized: boolean) => void;
};

export const useChatAnonymizedStore = create<ChatAnonymizedStore>()(
  persist(
    (set) => ({
      anonymized: false,
      setAnonymized: (anonymized) => {
        set({ anonymized });
      },
    }),
    { name: "stella.chat.anonymized" },
  ),
);

// `threadRef` is kept on the public API so call sites don't have to change
// when we eventually re-introduce per-thread overrides.
export const useChatAnonymized = (_threadRef: ChatThreadRef): boolean =>
  useChatAnonymizedStore((s) => s.anonymized);

export const useSetChatAnonymized = (_threadRef: ChatThreadRef) =>
  useChatAnonymizedStore((s) => s.setAnonymized);

export const getChatAnonymized = (_threadRef: ChatThreadRef): boolean =>
  useChatAnonymizedStore.getState().anonymized;

const sendModeOverrides = new Map<string, ChatSendModeOverride>();

export const sendNextChatRequestWithoutAnonymization = (
  threadRef: ChatThreadRef,
): void => {
  sendModeOverrides.set(
    getChatThreadKey(threadRef),
    CHAT_SEND_MODE.rawOverride,
  );
};

export const consumeChatSendModeOverride = (
  threadRef: ChatThreadRef,
): ChatSendModeOverride | null => {
  const key = getChatThreadKey(threadRef);
  const override = sendModeOverrides.get(key) ?? null;
  sendModeOverrides.delete(key);
  return override;
};
