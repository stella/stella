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
   *  of the attempt stands. */
  record: (notice: ChatContextNotice) => void;
  /**
   * Start a model attempt. Only the attempt that produces the answer speaks
   * for its context, so a notice an earlier attempt recorded is dropped; one
   * known before the turn (the send path's compaction) stays.
   */
  beginAttempt: () => void;
  /** The answer's stored metadata for the notice, if there is one. */
  metadata: () => { contextNotice?: ChatContextNotice };
  /**
   * `chunk`, carrying the notice when it is the first event since the notice
   * was recorded that the browser's stream processor merges into the
   * answer's metadata (answer text or reasoning), so the notice reads the
   * same live as it does from the stored answer. A tool call carries its
   * metadata on its own part, so a step that opens with one is preceded by
   * an empty text start for the same answer that carries the notice.
   */
  stamp: (chunk: StreamChunk) => readonly StreamChunk[];
};

const MESSAGE_METADATA_EVENTS: ReadonlySet<StreamChunk["type"]> = new Set([
  EventType.TEXT_MESSAGE_START,
  EventType.TEXT_MESSAGE_CONTENT,
  EventType.TEXT_MESSAGE_END,
  EventType.REASONING_MESSAGE_CONTENT,
]);

export const createContextNoticeStamp = (
  initial: ChatContextNotice | null,
): ContextNoticeStamp => {
  let notice = initial;
  let stamped = false;
  return {
    record: (next) => {
      notice ??= next;
    },
    beginAttempt: () => {
      notice = initial;
      stamped = false;
    },
    metadata: () =>
      notice === null ? {} : { [CONTEXT_NOTICE_METADATA_KEY]: notice },
    stamp: (chunk) => {
      if (notice === null || stamped) {
        return [chunk];
      }
      const metadata = { [CONTEXT_NOTICE_METADATA_KEY]: notice };
      if (MESSAGE_METADATA_EVENTS.has(chunk.type)) {
        stamped = true;
        return [{ ...chunk, metadata: { ...chunk.metadata, ...metadata } }];
      }
      if (
        chunk.type === EventType.TOOL_CALL_START &&
        chunk.parentMessageId !== undefined &&
        chunk.parentMessageId !== ""
      ) {
        stamped = true;
        return [
          {
            type: EventType.TEXT_MESSAGE_START,
            messageId: chunk.parentMessageId,
            role: "assistant",
            ...(chunk.timestamp === undefined
              ? {}
              : { timestamp: chunk.timestamp }),
            metadata,
          },
          chunk,
        ];
      }
      return [chunk];
    },
  };
};
