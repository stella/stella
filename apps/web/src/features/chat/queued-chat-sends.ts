import { getChatThreadKey } from "@/lib/chat-thread-ref";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";

/**
 * Messages a surface asked to send in a chat tab it is about to open. The tab
 * claims its message once, when it mounts, and sends it through its own send
 * path: the surface never sends past the chat's AI check or its session.
 *
 * Module state rather than a store: nothing renders from it, and a queued
 * send that outlived a reload would send a question the reader no longer
 * sees being asked.
 */
const queued = new Map<string, { threadRef: ChatThreadRef; html: string }>();

/** Queue `html` for the chat thread `threadRef`. */
export const queueChatSend = (threadRef: ChatThreadRef, html: string): void => {
  queued.set(getChatThreadKey(threadRef), { threadRef, html });
};

/**
 * The thread already holding this exact message, unclaimed. A second press
 * before the tab has mounted joins that thread instead of asking twice.
 */
export const findQueuedChatSend = (html: string): ChatThreadRef | undefined =>
  [...queued.values()].find((entry) => entry.html === html)?.threadRef;

/** Take the thread's queued message, once; null when there is none. */
export const claimQueuedChatSend = (
  threadRef: ChatThreadRef,
): string | null => {
  const key = getChatThreadKey(threadRef);
  const entry = queued.get(key);
  if (entry === undefined) {
    return null;
  }
  queued.delete(key);
  return entry.html;
};
