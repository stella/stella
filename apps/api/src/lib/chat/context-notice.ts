import { EventType } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";

/**
 * What the server tells the reader about the context an answer was given.
 *
 * `history-trimmed`: the thread's earlier history could not be summarized
 * for this answer, so the model saw only the newest messages that fit its
 * window. The answer carries the notice live and after reload, so the reader
 * knows why it may not account for earlier messages.
 */
export type ChatContextNotice = { type: "history-trimmed" };

export const HISTORY_TRIMMED_NOTICE = {
  type: "history-trimmed",
} as const satisfies ChatContextNotice;

/** The metadata key an answer carries its context notice under. */
export const CONTEXT_NOTICE_METADATA_KEY = "contextNotice";

/** An answer's context notice: recorded once known, carried by the answer. */
export type ContextNoticeStamp = {
  /** Record that the answer's context left history out. The first notice
   *  stands. */
  record: (notice: ChatContextNotice) => void;
  /** The answer's stored metadata for the notice, if there is one. */
  metadata: () => { contextNotice?: ChatContextNotice };
  /**
   * `chunk`, carrying the notice when it is the first answer-text event since
   * the notice was recorded. The browser's stream processor merges an
   * answer-text event's metadata into the answer's own, so the notice reads
   * the same live as it does from the stored answer.
   */
  stamp: <TChunk extends StreamChunk>(chunk: TChunk) => TChunk;
};

export const createContextNoticeStamp = (
  initial: ChatContextNotice | null,
): ContextNoticeStamp => {
  let notice = initial;
  let stamped = false;
  return {
    record: (next) => {
      notice ??= next;
    },
    metadata: () =>
      notice === null ? {} : { [CONTEXT_NOTICE_METADATA_KEY]: notice },
    stamp: (chunk) => {
      if (
        notice === null ||
        stamped ||
        !(
          chunk.type === EventType.TEXT_MESSAGE_START ||
          chunk.type === EventType.TEXT_MESSAGE_CONTENT ||
          chunk.type === EventType.TEXT_MESSAGE_END
        )
      ) {
        return chunk;
      }
      stamped = true;
      return {
        ...chunk,
        metadata: { ...chunk.metadata, [CONTEXT_NOTICE_METADATA_KEY]: notice },
      };
    },
  };
};
