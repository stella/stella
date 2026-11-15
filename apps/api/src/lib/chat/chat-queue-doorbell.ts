import type { SafeId } from "@/api/lib/branded-types";

type ChatQueueDoorbellAnswer = (threadId: SafeId<"chatThread">) => void;

let answer: ChatQueueDoorbellAnswer | null = null;

/**
 * Tell this process that a thread's queue may be due: its turn's status
 * changed, or the queue itself did. The ring is a hint, never the only way a
 * queue drains: it is lost when nothing answers (a process that does not
 * drain, a test) or the process exits, and the queue sweep finds the thread
 * then. Only a thread id travels, so a ring for a thread with nothing due
 * costs one indexed read.
 */
export const ringChatQueue = (threadId: SafeId<"chatThread">): void => {
  answer?.(threadId);
};

/** Drain rung threads with `drain`; the server calls this once at boot. */
export const answerChatQueueDoorbell = (
  drain: ChatQueueDoorbellAnswer,
): (() => void) => {
  answer = drain;
  return () => {
    if (answer === drain) {
      answer = null;
    }
  };
};
