import { create } from "zustand";

import { getChatThreadKey } from "@/lib/chat-thread-ref";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";

const QUEUED_CHAT_SEND_STATUS = {
  QUEUED: "queued",
  SENDING: "sending",
} as const;
type QueuedChatSendStatus =
  (typeof QUEUED_CHAT_SEND_STATUS)[keyof typeof QUEUED_CHAT_SEND_STATUS];

type QueuedChatSend = {
  threadRef: ChatThreadRef;
  html: string;
  status: QueuedChatSendStatus;
};

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

const setEntry = (key: string, entry: QueuedChatSend): void => {
  useQueuedChatSendStore.setState((state) => ({
    byThreadKey: { ...state.byThreadKey, [key]: entry },
  }));
};

/**
 * Queue `html` for the chat thread `threadRef`. A message already being sent
 * for that thread stays the one in flight: pressing again while it sends must
 * not send it twice.
 */
export const queueChatSend = (threadRef: ChatThreadRef, html: string): void => {
  const key = getChatThreadKey(threadRef);
  const current = useQueuedChatSendStore.getState().byThreadKey[key];
  if (
    current?.status === QUEUED_CHAT_SEND_STATUS.SENDING &&
    current.html === html
  ) {
    return;
  }
  setEntry(key, { threadRef, html, status: QUEUED_CHAT_SEND_STATUS.QUEUED });
};

/**
 * The thread already holding this exact message, waiting or being sent. A
 * second press joins that thread instead of asking twice.
 */
export const findQueuedChatSend = (html: string): ChatThreadRef | undefined =>
  Object.values(useQueuedChatSendStore.getState().byThreadKey).find(
    (entry) => entry.html === html,
  )?.threadRef;

/**
 * Call `listener` whenever the thread's message is queued again, so a tab that
 * is already open can retry a send its AI check held back. Returns the
 * unsubscribe.
 */
export const subscribeQueuedChatSend = (
  threadRef: ChatThreadRef,
  listener: () => void,
): (() => void) => {
  const key = getChatThreadKey(threadRef);
  return useQueuedChatSendStore.subscribe((state, previous) => {
    const entry = state.byThreadKey[key];
    if (
      entry?.status === QUEUED_CHAT_SEND_STATUS.QUEUED &&
      entry !== previous.byThreadKey[key]
    ) {
      listener();
    }
  });
};

/** Whether the thread has a message waiting to be claimed. */
export const hasQueuedChatSend = (threadRef: ChatThreadRef): boolean =>
  useQueuedChatSendStore.getState().byThreadKey[getChatThreadKey(threadRef)]
    ?.status === QUEUED_CHAT_SEND_STATUS.QUEUED;

/**
 * Take the thread's waiting message for sending; null when none waits. The
 * message stays discoverable until `settleQueuedChatSend` reports the send.
 */
export const claimQueuedChatSend = (
  threadRef: ChatThreadRef,
): string | null => {
  const key = getChatThreadKey(threadRef);
  const entry = useQueuedChatSendStore.getState().byThreadKey[key];
  if (entry?.status !== QUEUED_CHAT_SEND_STATUS.QUEUED) {
    return null;
  }
  setEntry(key, { ...entry, status: QUEUED_CHAT_SEND_STATUS.SENDING });
  return entry.html;
};

/**
 * Finish a claimed send: a sent message leaves the queue, one that did not go
 * through waits again for the next attempt.
 */
export const settleQueuedChatSend = (
  threadRef: ChatThreadRef,
  sent: "sent" | "not-sent",
): void => {
  const key = getChatThreadKey(threadRef);
  const entry = useQueuedChatSendStore.getState().byThreadKey[key];
  if (entry?.status !== QUEUED_CHAT_SEND_STATUS.SENDING) {
    return;
  }
  if (sent === "sent") {
    useQueuedChatSendStore.setState((state) => {
      const { [key]: _sent, ...byThreadKey } = state.byThreadKey;
      return { byThreadKey };
    });
    return;
  }
  setEntry(key, { ...entry, status: QUEUED_CHAT_SEND_STATUS.QUEUED });
};
