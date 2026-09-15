/**
 * One conversation per legal document.
 *
 * A decision's chat, and a statute consolidation's, is reachable from two
 * places at once: the composer a reader floats over the text, and the
 * inspector's chat tab. Both resolve their thread here rather than minting one
 * of their own, so a question typed over the text and a question typed in the
 * tab land in the same conversation instead of two that never meet.
 *
 * Session-scoped on purpose. What survives a reload is the document's chat
 * TAB, which the inspector persists with both its document key and its thread
 * id; a reader mounting into a fresh session hands that thread back here as
 * `adoptThreadId`, and the restored tab set itself hands back whatever the
 * reader painted too early to see.
 */

import { create } from "zustand";

import type { LegalDocumentChatKey } from "@/features/chat/legal-document-chat-key";
import { createChatThreadId } from "@/lib/chat-thread-ref";
import type { ChatThreadId } from "@/lib/chat-thread-ref";

/** What the owner knows about a document. At most one thread, ever. */
export type LegalDocumentChatThreadLookup =
  | { status: "none" }
  | { status: "thread"; threadId: ChatThreadId };

type LegalDocumentChatThreadsState = {
  /** Document key → the thread its conversation lives in. */
  threadIdByDocumentKey: Record<LegalDocumentChatKey, ChatThreadId>;
};

export const useLegalDocumentChatThreads =
  create<LegalDocumentChatThreadsState>()(() => ({
    threadIdByDocumentKey: {},
  }));

export const lookupLegalDocumentChatThread = (
  documentKey: LegalDocumentChatKey,
): LegalDocumentChatThreadLookup => {
  const threadId =
    useLegalDocumentChatThreads.getState().threadIdByDocumentKey[documentKey];
  return threadId === undefined
    ? { status: "none" }
    : { status: "thread", threadId };
};

type EnsureLegalDocumentChatThreadArgs = {
  /**
   * A thread a surface already owns for this document — the id of a chat tab
   * restored from a previous session. Used only when the owner knows none: a
   * conversation that already exists always beats a fresh one.
   */
  adoptThreadId?: ChatThreadId | undefined;
  documentKey: LegalDocumentChatKey;
};

/**
 * The document's thread, minting one the first time it is asked for. First
 * writer wins, so two readers mounted on the same document in one commit join
 * one conversation instead of racing to name it.
 */
export const ensureLegalDocumentChatThread = ({
  adoptThreadId,
  documentKey,
}: EnsureLegalDocumentChatThreadArgs): ChatThreadId => {
  const lookup = lookupLegalDocumentChatThread(documentKey);
  if (lookup.status === "thread") {
    return lookup.threadId;
  }
  const threadId = adoptThreadId ?? createChatThreadId();
  useLegalDocumentChatThreads.setState((state) => ({
    threadIdByDocumentKey: {
      ...state.threadIdByDocumentKey,
      [documentKey]: threadId,
    },
  }));
  return threadId;
};

/** A document's conversation as a restored tab set carries it. */
export type RestoredLegalDocumentChatThread = {
  documentKey: LegalDocumentChatKey;
  threadId: ChatThreadId;
};

/**
 * Hand a restored tab set's conversations back to the owner.
 *
 * The chat TAB is what survives a reload, but it is restored after the page
 * has painted: by then a reader mounted on the same document has already
 * minted an id of its own, and nothing would ever ask it to give that up. The
 * tab is the persisted truth, so it wins, and both surfaces continue the
 * conversation the reader left instead of splitting into two.
 *
 * Later entries win, matching the tab set's own rule that a document's newest
 * chat tab is its current conversation.
 */
export const adoptRestoredLegalDocumentChatThreads = (
  restored: readonly RestoredLegalDocumentChatThread[],
): void => {
  if (restored.length === 0) {
    return;
  }
  useLegalDocumentChatThreads.setState((state) => {
    const next = { ...state.threadIdByDocumentKey };
    let changed = false;
    for (const { documentKey, threadId } of restored) {
      if (next[documentKey] === threadId) {
        continue;
      }
      next[documentKey] = threadId;
      changed = true;
    }
    return changed ? { threadIdByDocumentKey: next } : state;
  });
};

type AdoptLegalDocumentChatThreadArgs = {
  documentKey: LegalDocumentChatKey;
  threadId: ChatThreadId;
};

/**
 * Move the document's conversation to a named thread: a new chat started from
 * its tab, or from the reader's composer. Overwrites, because the caller is
 * the user saying "this one" — and both surfaces follow.
 */
export const adoptLegalDocumentChatThread = ({
  documentKey,
  threadId,
}: AdoptLegalDocumentChatThreadArgs): void => {
  useLegalDocumentChatThreads.setState((state) =>
    state.threadIdByDocumentKey[documentKey] === threadId
      ? state
      : {
          threadIdByDocumentKey: {
            ...state.threadIdByDocumentKey,
            [documentKey]: threadId,
          },
        },
  );
};
