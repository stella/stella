/**
 * Messages a member queued in a chat thread, kept by the server. A queued
 * message is not part of the conversation until it is sent: the server sends
 * the first one as the member once the thread's turn has ended and nothing
 * holds the queue.
 */

/** At most this many messages wait in one thread. */
export const CHAT_QUEUE_LIMIT = 20;

/**
 * Why a thread's queue waits although its turn has ended. Each is shown with
 * the queue; the member resumes it, or sends a message, which releases it.
 */
export const CHAT_QUEUE_HOLD_REASONS = [
  "turn-failed",
  "turn-interrupted",
  "member",
  "send-refused",
  "usage-limit",
  "computer-away",
] as const;

export type ChatQueueHoldReason = (typeof CHAT_QUEUE_HOLD_REASONS)[number];

export const CHAT_QUEUE_HOLD_REASON = {
  /** The turn before failed; what it was asked may need to change first. */
  turnFailed: "turn-failed",
  /** The turn before was cut off (a restart of the server, a lost run). */
  turnInterrupted: "turn-interrupted",
  /** The member paused the queue. */
  member: "member",
  /** Sending the first message was refused; `refusalCode` says why. */
  sendRefused: "send-refused",
  /** The member's usage limit stops the next turn. */
  usageLimit: "usage-limit",
  /** The first message runs on a computer of the member that is not connected. */
  computerAway: "computer-away",
} as const satisfies Record<string, ChatQueueHoldReason>;

/**
 * What removing a queued message does with the chat files its enqueue stored
 * for it: `delete` them (Remove), or `keep` them for the composer the message
 * goes back to (Edit), which sends them again by reference.
 */
export const QUEUED_MESSAGE_FILES_ON_REMOVE = {
  delete: "delete",
  keep: "keep",
} as const;

export type QueuedMessageFilesOnRemove =
  (typeof QUEUED_MESSAGE_FILES_ON_REMOVE)[keyof typeof QUEUED_MESSAGE_FILES_ON_REMOVE];

/** Error codes the queue's routes answer with. */
export const CHAT_QUEUE_ERROR_CODE = {
  /** The thread already holds `CHAT_QUEUE_LIMIT` queued messages. */
  full: "chat_queue_full",
  /** The message was sent from the queue; it can no longer change. */
  sent: "queued_message_sent",
  /** The message changed since the revision the request names. */
  changed: "queued_message_changed",
  /** An edit's attachment must already be a stored file of the member. */
  inlineFile: "queued_message_inline_file",
  /** The message has a part a chat message cannot store. */
  invalid: "queued_message_invalid",
  /** The message is not the next one the queue may send now. */
  notDue: "queued_message_not_due",
  /** No such message is queued in the thread. */
  notFound: "queued_message_not_found",
  /** A replacement names a different message id than the one it replaces. */
  idChanged: "queued_message_id_changed",
} as const;

export type ChatQueueErrorCode =
  (typeof CHAT_QUEUE_ERROR_CODE)[keyof typeof CHAT_QUEUE_ERROR_CODE];

/**
 * Why the server refused a member's new message without storing anything of
 * it. A plain send never replaces a turn and never jumps the queue: the
 * client queues the message instead (`POST .../queue`, same message id), so
 * it goes once what is ahead of it is done. Replacing a turn that waits on
 * the member stays an explicit action: Send now on a queued message.
 */
export const CHAT_SEND_QUEUES_INSTEAD_CODE = {
  /** A turn of the thread still runs. */
  turnRunning: "chat_turn_running",
  /** A turn of the thread waits on the member: a question, an approval. */
  turnAwaitingMember: "chat_turn_awaiting_member",
  /** Messages are queued in the thread and nothing holds them: they go first. */
  queuedAhead: "chat_queued_ahead",
} as const;

export type ChatSendQueuesInsteadCode =
  (typeof CHAT_SEND_QUEUES_INSTEAD_CODE)[keyof typeof CHAT_SEND_QUEUES_INSTEAD_CODE];

/**
 * Why sending a queued message as the member was refused before anything of
 * it was stored, when the refusal is not one of the send's own codes.
 */
export const CHAT_QUEUE_SEND_REFUSAL = {
  /** The member no longer belongs to the organization, or may not chat. */
  memberUnavailable: "member_unavailable",
  /** The send was refused without a code of its own. */
  refused: "send_refused",
} as const;

/** Text of a queued message shown in the queue, at most this long. */
export const CHAT_QUEUE_PREVIEW_MAX_CHARS = 280;
