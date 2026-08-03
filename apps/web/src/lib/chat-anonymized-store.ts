import { useCallback } from "react";

import { create } from "zustand";
import { persist } from "zustand/middleware";

import {
  CHAT_SEND_MODE,
  getPreferredChatSendMode,
  isChatSendMode,
} from "@stll/anonymize-chat";
import type { ChatSendMode } from "@stll/anonymize-chat";

import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { getChatThreadKey } from "@/lib/chat-thread-ref";

const DEFAULT_SEND_MODE = CHAT_SEND_MODE.rawOverride;
const MAX_PERSISTED_THREAD_MODES = 100;

type PersistedChatAnonymizedState = {
  defaultSendMode: ChatSendMode;
  sendModes: Record<string, ChatSendMode | undefined>;
};

type ChatAnonymizedStore = PersistedChatAnonymizedState & {
  setThreadAnonymized: (threadKey: string, anonymized: boolean) => void;
};

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

const readPersistedThreadModes = (
  persisted: unknown,
): Record<string, ChatSendMode | undefined> => {
  if (
    typeof persisted !== "object" ||
    persisted === null ||
    !("sendModes" in persisted) ||
    typeof persisted.sendModes !== "object" ||
    persisted.sendModes === null
  ) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(persisted.sendModes)
      .filter(
        ([threadKey, sendMode]) =>
          threadKey.length <= 256 && isChatSendMode(sendMode),
      )
      .slice(-MAX_PERSISTED_THREAD_MODES),
  );
};

const readPersistedState = (
  persisted: unknown,
): PersistedChatAnonymizedState => ({
  defaultSendMode:
    typeof persisted === "object" &&
    persisted !== null &&
    "defaultSendMode" in persisted &&
    isChatSendMode(persisted.defaultSendMode)
      ? persisted.defaultSendMode
      : (readPersistedSendMode(persisted) ?? DEFAULT_SEND_MODE),
  sendModes: readPersistedThreadModes(persisted),
});

export const useChatAnonymizedStore = create<ChatAnonymizedStore>()(
  persist(
    (set) => ({
      defaultSendMode: DEFAULT_SEND_MODE,
      sendModes: {},
      setThreadAnonymized: (threadKey, anonymized) => {
        const sendMode = getPreferredChatSendMode(anonymized);
        set((state) => {
          const retained = Object.entries(state.sendModes).filter(
            ([key]) => key !== threadKey,
          );
          if (sendMode !== state.defaultSendMode) {
            retained.push([threadKey, sendMode]);
          }
          return {
            sendModes: Object.fromEntries(
              retained.slice(-MAX_PERSISTED_THREAD_MODES),
            ),
          };
        });
      },
    }),
    {
      name: "stella.chat.anonymized",
      partialize: ({ defaultSendMode, sendModes }) => ({
        defaultSendMode,
        sendModes,
      }),
      version: 2,
      migrate: (persisted) => readPersistedState(persisted),
      merge: (persisted, current) => ({
        ...current,
        ...readPersistedState(persisted),
      }),
    },
  ),
);

export const getChatSendMode = (threadRef: ChatThreadRef): ChatSendMode => {
  const { defaultSendMode, sendModes } = useChatAnonymizedStore.getState();
  return sendModes[getChatThreadKey(threadRef)] ?? defaultSendMode;
};

export const setChatAnonymized = (
  threadRef: ChatThreadRef,
  anonymized: boolean,
): void => {
  useChatAnonymizedStore
    .getState()
    .setThreadAnonymized(getChatThreadKey(threadRef), anonymized);
};

export const useChatAnonymized = (threadRef: ChatThreadRef): boolean => {
  const threadKey = getChatThreadKey(threadRef);
  return useChatAnonymizedStore(
    (state) =>
      (state.sendModes[threadKey] ?? state.defaultSendMode) ===
      CHAT_SEND_MODE.anonymized,
  );
};

export const useSetChatAnonymized = (threadRef: ChatThreadRef) => {
  const threadKey = getChatThreadKey(threadRef);
  const setThreadAnonymized = useChatAnonymizedStore(
    (state) => state.setThreadAnonymized,
  );
  return useCallback(
    (anonymized: boolean) => {
      setThreadAnonymized(threadKey, anonymized);
    },
    [setThreadAnonymized, threadKey],
  );
};
