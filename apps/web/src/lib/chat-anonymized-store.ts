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
const MAX_PERSISTED_NON_PROTECTIVE_THREAD_MODES = 100;

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
    Object.entries(persisted.sendModes).filter(
      ([threadKey, sendMode]) =>
        threadKey.length <= 256 && isChatSendMode(sendMode),
    ),
  );
};

const readPersistedState = (
  persisted: unknown,
): PersistedChatAnonymizedState => {
  const defaultSendMode =
    typeof persisted === "object" &&
    persisted !== null &&
    "defaultSendMode" in persisted &&
    isChatSendMode(persisted.defaultSendMode)
      ? persisted.defaultSendMode
      : (readPersistedSendMode(persisted) ?? DEFAULT_SEND_MODE);
  return {
    defaultSendMode,
    sendModes: retainThreadSendModes({
      defaultSendMode,
      sendModes: Object.entries(readPersistedThreadModes(persisted)).flatMap(
        ([threadKey, sendMode]) =>
          sendMode === undefined ? [] : [[threadKey, sendMode]],
      ),
    }),
  };
};

const isPrivacyIncreasingOverride = ({
  defaultSendMode,
  sendMode,
}: {
  defaultSendMode: ChatSendMode;
  sendMode: ChatSendMode;
}): boolean =>
  defaultSendMode === CHAT_SEND_MODE.rawOverride &&
  sendMode === CHAT_SEND_MODE.anonymized;

const retainThreadSendModes = ({
  defaultSendMode,
  sendModes,
}: {
  defaultSendMode: ChatSendMode;
  sendModes: readonly (readonly [string, ChatSendMode])[];
}): Record<string, ChatSendMode | undefined> => {
  const privacyIncreasing: [string, ChatSendMode][] = [];
  const nonProtective: [string, ChatSendMode][] = [];

  for (const [threadKey, sendMode] of sendModes) {
    if (isPrivacyIncreasingOverride({ defaultSendMode, sendMode })) {
      privacyIncreasing.push([threadKey, sendMode]);
      continue;
    }
    nonProtective.push([threadKey, sendMode]);
  }

  // A persisted anonymized override must never disappear merely because a
  // local cache reached an arbitrary count: doing so changes a later send from
  // private to raw. The bounded partition holds only modes whose eviction
  // cannot weaken the default privacy posture.
  return Object.fromEntries([
    ...privacyIncreasing,
    ...nonProtective.slice(-MAX_PERSISTED_NON_PROTECTIVE_THREAD_MODES),
  ]);
};

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
          const nextModes = retained.flatMap(([retainedThreadKey, mode]) =>
            mode === undefined ? [] : [[retainedThreadKey, mode] as const],
          );
          return {
            sendModes: retainThreadSendModes({
              defaultSendMode: state.defaultSendMode,
              sendModes: nextModes,
            }),
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
