import { panic } from "better-result";

import { CHAT_SEND_MODE, type ChatSendMode } from "@stll/anonymize-chat";
import { isChatPastedTextPart } from "@stll/api-contract/chat";
import {
  CHAT_SEND_QUEUES_INSTEAD_CODE,
  type ChatQueueHoldReason,
} from "@stll/api-contract/chat-queue";
import type { ChatLocalRunSteerRefusal } from "@stll/api-contract/chat-run-target";
import {
  CHAT_TURN_STEERING,
  type ChatThreadSendState,
} from "@stll/api-contract/chat-send-intent";
import { DESKTOP_RUNNER_MAX_INPUT_TEXT_LENGTH } from "@stll/api-contract/desktop-runner";

import type { ChatMessageDraftHandoff } from "@/components/chat-editor-provider";
import type { ChatQueue, ChatQueueItem } from "@/features/chat/chat-queue";
import {
  type ChatSendMessageOptions,
  type ChatUserMessageInput,
  hasChatErrorCode,
} from "@/features/chat/chat-runtime";
import type { TranslationKey } from "@/i18n/types";
import type {
  ChatEditApplyMode,
  DocxEditRepresentation,
} from "@/lib/chat-edit-mode";

/**
 * The request options a message is queued with: its send mode and DOCX edit
 * preferences as they are now, so toggling a mode between queueing and
 * sending never changes the queued message.
 */
export const snapshotChatRequestOptions = ({
  docxEditRepresentation,
  editApplyMode,
  options,
  sendMode,
}: {
  docxEditRepresentation: DocxEditRepresentation | undefined;
  editApplyMode: ChatEditApplyMode | undefined;
  options: ChatSendMessageOptions | undefined;
  sendMode: ChatSendMode | undefined;
}): ChatSendMessageOptions | undefined => {
  if (sendMode === undefined && editApplyMode === undefined) {
    return options;
  }

  return {
    ...options,
    body: {
      ...(sendMode === undefined ? {} : { sendMode }),
      ...(editApplyMode === undefined ? {} : { editApplyMode }),
      ...(docxEditRepresentation === undefined
        ? {}
        : { docxEditRepresentation }),
      ...options?.body,
    },
  };
};

/** A message's parts as the page would show it once sent. */
export const messagePartsOf = (
  message: ChatUserMessageInput,
): readonly unknown[] =>
  typeof message.content === "string"
    ? [{ type: "text", content: message.content }]
    : message.content;

/**
 * What of a message the composer can hold again: its markup and its pasted
 * texts. Files are not part of it; a message with files never reaches here.
 */
export const composerDraftOfParts = (
  parts: readonly unknown[],
): ChatMessageDraftHandoff => {
  const html: string[] = [];
  const pastedTexts: string[] = [];
  for (const part of parts) {
    if (isChatPastedTextPart(part)) {
      pastedTexts.push(part.content);
    } else if (
      typeof part === "object" &&
      part !== null &&
      "type" in part &&
      part.type === "text" &&
      "content" in part &&
      typeof part.content === "string"
    ) {
      html.push(part.content);
    }
  }
  return { html: html.join(""), pastedTexts };
};

/**
 * The text a running turn can be handed for a message of `parts`: text alone,
 * sent raw (a steer hands the text to the computer's harness as is), and no
 * longer than the steer takes. `null` for any other message, which only goes
 * as a message of its own.
 */
const steerableTextOfParts = ({
  parts,
  sendMode,
}: {
  parts: readonly unknown[];
  sendMode: ChatSendMode | undefined;
}): string | null => {
  if (sendMode === CHAT_SEND_MODE.anonymized || parts.length === 0) {
    return null;
  }
  const draft = composerDraftOfParts(parts);
  const text = draft.html.trim();
  return draft.pastedTexts.length === 0 &&
    parts.every(isTextPart) &&
    text !== "" &&
    text.length <= DESKTOP_RUNNER_MAX_INPUT_TEXT_LENGTH
    ? text
    : null;
};

const isTextPart = (part: unknown): boolean =>
  typeof part === "object" &&
  part !== null &&
  "type" in part &&
  (part.type === "text" || isChatPastedTextPart(part));

/** `steerableTextOfParts` of a message the member sends now. */
export const steerableMessageText = (
  message: ChatUserMessageInput,
  options: ChatSendMessageOptions | undefined,
): string | null =>
  steerableTextOfParts({
    parts: messagePartsOf(message),
    sendMode: options?.body?.sendMode,
  });

/** `steerableTextOfParts` of a queued message, read whole from the queue. */
export const steerableQueuedText = ({
  item,
  parts,
}: {
  item: Pick<ChatQueueItem, "sendMode">;
  parts: readonly unknown[];
}): string | null => steerableTextOfParts({ parts, sendMode: item.sendMode });

/**
 * Why a steer left the message queued: what the turn or the API said
 * (`ChatLocalRunSteerRefusal`), or `message_not_plain` for a message with
 * files or one sent anonymized, which only goes as a message of its own.
 */
export type ChatSteerRefusal = ChatLocalRunSteerRefusal | "message_not_plain";

/** What the member is told about a steer that left the message queued. */
export const CHAT_STEER_REFUSAL_MESSAGES = {
  turn_not_running: "chat.steerRefused.turnNotRunning",
  no_run: "chat.steerRefused.noRun",
  harness_cannot_steer: "chat.steerRefused.cannotSteer",
  run_full: "chat.steerRefused.runFull",
  queued_message_changed: "chat.steerRefused.queuedMessageChanged",
  not_taken: "chat.steerRefused.notTaken",
  message_not_plain: "chat.steerRefused.notPlain",
} as const satisfies Record<ChatSteerRefusal, TranslationKey>;

/** What the queue line says while something holds the queue. */
export const CHAT_QUEUE_HOLD_NOTICE_KEYS = {
  "turn-failed": "chat.queue.heldTurnFailed",
  "turn-interrupted": "chat.queue.heldTurnInterrupted",
  member: "chat.queue.heldByMember",
  "send-refused": "chat.queue.heldSendRefused",
  "usage-limit": "chat.queue.heldUsageLimit",
  "computer-away": "chat.queue.heldComputerAway",
} as const satisfies Record<ChatQueueHoldReason, TranslationKey>;

/**
 * Whether the server refused a sent message so that it is queued instead: a
 * turn runs, a turn waits on the member, or messages wait ahead of it.
 */
export const isQueueInsteadRefusal = (error: unknown): boolean =>
  Object.values(CHAT_SEND_QUEUES_INSTEAD_CODE).some((code) =>
    hasChatErrorCode(error, code),
  );

/**
 * Whether a message can wait in the queue: the queue keeps text, and files
 * only once they are stored, which a message from the composer's own files
 * is not yet. Pasted text travels as text.
 */
export const canQueueMessage = (message: ChatUserMessageInput): boolean =>
  typeof message.content === "string" ||
  message.content.every(
    (part) => part.type === "text" || isChatPastedTextPart(part),
  );

/**
 * Whether a running turn may be handed a queued message in its place, as far
 * as the queue's read tells: text alone, queued to be sent raw. Its text is
 * read whole before the turn is handed it (`steerableQueuedText`).
 */
const mayHandQueuedToTurn = (item: ChatQueueItem): boolean =>
  item.attachmentCount === 0 &&
  item.preview.trim() !== "" &&
  item.sendMode === CHAT_SEND_MODE.rawOverride;

/**
 * What Send now does with a queued message, by what the thread does:
 * - `steer`: a turn on the member's computer that takes a message mid-turn
 *   runs; it is handed the message's text, read whole, and goes on with it.
 * - `replace`: a turn waits on the member; Send now ends what it waits on,
 *   which the member confirms first.
 * - `send`: the server sends it next, now, stopping a turn that runs.
 */
export type QueuedSendNow =
  { type: "steer" } | { type: "replace" } | { type: "send" };

export const queuedSendNow = (
  state: ChatThreadSendState,
  item: ChatQueueItem,
): QueuedSendNow => {
  switch (state.type) {
    case "idle":
      return { type: "send" };
    case "waiting_on_member":
      return { type: "replace" };
    case "working":
      return state.steering === CHAT_TURN_STEERING.steerable &&
        mayHandQueuedToTurn(item)
        ? { type: "steer" }
        : { type: "send" };
    default:
      state satisfies never;
      return panic("Unhandled thread send state");
  }
};

/**
 * Where moving the message `id` one place up or down puts it: before the
 * message `beforeId`, or at the end with `null`. `undefined` when it cannot
 * move that way.
 */
export const queueMoveTarget = ({
  direction,
  id,
  items,
}: {
  direction: "down" | "up";
  id: string;
  items: readonly Pick<ChatQueueItem, "id">[];
}): { beforeId: string | null } | undefined => {
  const index = items.findIndex((item) => item.id === id);
  if (index === -1) {
    return undefined;
  }
  if (direction === "up") {
    const previous = items.at(index - 1);
    return index === 0 || previous === undefined
      ? undefined
      : { beforeId: previous.id };
  }
  if (index === items.length - 1) {
    return undefined;
  }
  return { beforeId: items.at(index + 2)?.id ?? null };
};

/** The queue with the message `id` moved before `beforeId` (or last). */
export const withQueuedMessageMoved = ({
  beforeId,
  id,
  queue,
}: {
  beforeId: string | null;
  id: string;
  queue: ChatQueue;
}): ChatQueue => {
  const moved = queue.items.find((item) => item.id === id);
  if (moved === undefined) {
    return queue;
  }
  const rest = queue.items.filter((item) => item.id !== id);
  const at =
    beforeId === null
      ? rest.length
      : rest.findIndex((item) => item.id === beforeId);
  const items = [
    ...rest.slice(0, at === -1 ? rest.length : at),
    moved,
    ...rest.slice(at === -1 ? rest.length : at),
  ].map((item, index) => ({ ...item, position: index + 1 }));
  return { hold: queue.hold, items };
};

/** The queue without the message `id`; the hold goes with the last one. */
export const withQueuedMessageRemoved = ({
  id,
  queue,
}: {
  id: string;
  queue: ChatQueue;
}): ChatQueue => {
  const items = queue.items
    .filter((item) => item.id !== id)
    .map((item, index) => ({ ...item, position: index + 1 }));
  return { hold: items.length === 0 ? null : queue.hold, items };
};
