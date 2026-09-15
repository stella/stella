/**
 * One conversation per decision.
 *
 * A decision's chat is reachable from two places at once: the composer a
 * reader floats over the text, and the inspector's chat tab. Both resolve
 * their thread here rather than minting one of their own, so a question typed
 * over the text and a question typed in the tab land in the same conversation
 * instead of two that never meet.
 *
 * Session-scoped on purpose. What survives a reload is the decision's chat
 * TAB, which the inspector persists with both its decision and its thread id;
 * a reader mounting into a fresh session hands that thread back here as
 * `adoptThreadId`.
 */

import { create } from "zustand";

import { createChatThreadId } from "@/lib/chat-thread-ref";
import type { ChatThreadId } from "@/lib/chat-thread-ref";

/** What the owner knows about a decision. At most one thread, ever. */
export type DecisionChatThreadLookup =
  | { status: "none" }
  | { status: "thread"; threadId: ChatThreadId };

type DecisionChatThreadsState = {
  /** Decision id → the thread its conversation lives in. */
  threadIdByDecisionId: Record<string, ChatThreadId>;
};

export const useDecisionChatThreads = create<DecisionChatThreadsState>()(
  () => ({ threadIdByDecisionId: {} }),
);

export const lookupDecisionChatThread = (
  decisionId: string,
): DecisionChatThreadLookup => {
  const threadId =
    useDecisionChatThreads.getState().threadIdByDecisionId[decisionId];
  return threadId === undefined
    ? { status: "none" }
    : { status: "thread", threadId };
};

type EnsureDecisionChatThreadArgs = {
  /**
   * A thread a surface already owns for this decision — the id of a chat tab
   * restored from a previous session. Used only when the owner knows none: a
   * conversation that already exists always beats a fresh one.
   */
  adoptThreadId?: ChatThreadId | undefined;
  decisionId: string;
};

/**
 * The decision's thread, minting one the first time it is asked for. First
 * writer wins, so two readers mounted on the same decision in one commit join
 * one conversation instead of racing to name it.
 */
export const ensureDecisionChatThread = ({
  adoptThreadId,
  decisionId,
}: EnsureDecisionChatThreadArgs): ChatThreadId => {
  const lookup = lookupDecisionChatThread(decisionId);
  if (lookup.status === "thread") {
    return lookup.threadId;
  }
  const threadId = adoptThreadId ?? createChatThreadId();
  useDecisionChatThreads.setState((state) => ({
    threadIdByDecisionId: {
      ...state.threadIdByDecisionId,
      [decisionId]: threadId,
    },
  }));
  return threadId;
};

type AdoptDecisionChatThreadArgs = {
  decisionId: string;
  threadId: ChatThreadId;
};

/**
 * Move the decision's conversation to a named thread: a new chat started from
 * its tab, or from the reader's composer. Overwrites, because the caller is
 * the user saying "this one" — and both surfaces follow.
 */
export const adoptDecisionChatThread = ({
  decisionId,
  threadId,
}: AdoptDecisionChatThreadArgs): void => {
  useDecisionChatThreads.setState((state) =>
    state.threadIdByDecisionId[decisionId] === threadId
      ? state
      : {
          threadIdByDecisionId: {
            ...state.threadIdByDecisionId,
            [decisionId]: threadId,
          },
        },
  );
};
