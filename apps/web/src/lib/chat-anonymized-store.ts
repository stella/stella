import { create } from "zustand";

import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { getChatThreadKey } from "@/lib/chat-thread-ref";

type ChatAnonymizedStore = {
  byThreadKey: Record<string, boolean>;
  setAnonymized: (threadKey: string, anonymized: boolean) => void;
};

export const useChatAnonymizedStore = create<ChatAnonymizedStore>((set) => ({
  byThreadKey: {},
  setAnonymized: (threadKey, anonymized) =>
    set((state) => ({
      byThreadKey: { ...state.byThreadKey, [threadKey]: anonymized },
    })),
}));

export const useChatAnonymized = (threadRef: ChatThreadRef): boolean => {
  const key = getChatThreadKey(threadRef);
  return useChatAnonymizedStore((s) => s.byThreadKey[key] ?? false);
};

export const useSetChatAnonymized = (threadRef: ChatThreadRef) => {
  const key = getChatThreadKey(threadRef);
  const setAnonymized = useChatAnonymizedStore((s) => s.setAnonymized);
  return (anonymized: boolean) => setAnonymized(key, anonymized);
};

export const getChatAnonymized = (threadRef: ChatThreadRef): boolean =>
  useChatAnonymizedStore.getState().byThreadKey[getChatThreadKey(threadRef)] ??
  false;
