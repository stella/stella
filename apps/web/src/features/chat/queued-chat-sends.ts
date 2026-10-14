import { create } from "zustand";

import { getChatThreadKey } from "@/lib/chat-thread-ref";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";

type QueuedChatSend = { threadRef: ChatThreadRef; html: string };

/**
 * Messages a surface asked to send in a chat tab it is about to open. The tab
 * claims its message once, when it mounts, and sends it through its own send
 * path: the surface never sends past the chat's AI check or its session.
 *
 * In memory only: a queued send that outlived a reload would send a question
 * the reader no longer sees being asked.
 */
const useQueuedChatSendStore = create<{
  byThreadKey: Readonly<Record<string, QueuedChatSend>>;
}>(() => ({ byThreadKey: {} }));

/** Queue `html` for the chat thread `threadRef`. */
export const queueChatSend = (threadRef: ChatThreadRef, html: string): void => {
  useQueuedChatSendStore.setState((state) => ({
    byThreadKey: {
      ...state.byThreadKey,
      [getChatThreadKey(threadRef)]: { threadRef, html },
    },
  }));
};

/**
 * The thread already holding this exact message, unclaimed. A second press
 * before the tab has mounted joins that thread instead of asking twice.
 */
export const findQueuedChatSend = (html: string): ChatThreadRef | undefined =>
  Object.values(useQueuedChatSendStore.getState().byThreadKey).find(
    (entry) => entry.html === html,
  )?.threadRef;

/** Take the thread's queued message, once; null when there is none. */
export const claimQueuedChatSend = (
  threadRef: ChatThreadRef,
): string | null => {
  const key = getChatThreadKey(threadRef);
  const entry = useQueuedChatSendStore.getState().byThreadKey[key];
  if (entry === undefined) {
    return null;
  }
  useQueuedChatSendStore.setState((state) => {
    const { [key]: _claimed, ...byThreadKey } = state.byThreadKey;
    return { byThreadKey };
  });
  return entry.html;
};
