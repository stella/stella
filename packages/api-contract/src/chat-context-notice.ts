import * as v from "valibot";

// A leaf: the server writes the notice, and the web and the phone read it.

/**
 * What the server tells the reader about the context an answer was given.
 *
 * `history-trimmed`: the thread's earlier history could not be summarized
 * for this answer, so the model saw only the newest messages that fit its
 * window. The answer carries the notice live and after reload, so the reader
 * knows why it may not account for earlier messages.
 *
 * `session-not-resumed`: the coding agent on the member's computer could not
 * resume its own session of the chat (the session was gone or the agent
 * refused it), so it started over from the chat's messages, without the tool
 * results and files of its earlier turns.
 */
export const chatContextNoticeSchema = v.variant("type", [
  v.object({ type: v.literal("history-trimmed") }),
  v.object({ type: v.literal("session-not-resumed") }),
]);
export type ChatContextNotice = v.InferOutput<typeof chatContextNoticeSchema>;

/**
 * The metadata key an answer carries its context notice under: the stored
 * message's metadata, and the metadata of the stream event that first
 * carries it, where `null` withdraws a notice an earlier attempt streamed.
 */
export const CHAT_CONTEXT_NOTICE_METADATA_KEY = "contextNotice";

/**
 * The stream events that carry the notice in their `metadata`: the ones a
 * reader merges into the answer's metadata. The server stamps the notice on
 * the first of them after it changes, so a reader takes it from any of them.
 */
export const CHAT_CONTEXT_NOTICE_EVENTS = [
  "TEXT_MESSAGE_START",
  "TEXT_MESSAGE_CONTENT",
  "TEXT_MESSAGE_END",
  "REASONING_MESSAGE_CONTENT",
] as const;
