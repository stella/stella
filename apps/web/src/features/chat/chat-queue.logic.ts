import { panic } from "better-result";

import { CHAT_SEND_MODE, type ChatSendMode } from "@stll/anonymize-chat";
import { isChatPastedTextPart } from "@stll/api-contract/chat";
import {
  CHAT_QUEUE_PREVIEW_MAX_CHARS,
  CHAT_SEND_QUEUES_INSTEAD_CODE,
  type ChatQueueHoldReason,
} from "@stll/api-contract/chat-queue";
import {
  CHAT_TURN_STEERING,
  type ChatThreadSendState,
} from "@stll/api-contract/chat-send-intent";

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
 * The text a running turn can be handed for a message the member sends: text
 * alone, sent raw (a steer hands the text to the computer's harness as is).
 * `null` for any other message, which only goes as a message of its own.
 */
export const steerableMessageText = (
  message: ChatUserMessageInput,
  options: ChatSendMessageOptions | undefined,
): string | null => {
  if (options?.body?.sendMode === CHAT_SEND_MODE.anonymized) {
    return null;
  }
  const parts = messagePartsOf(message);
  const draft = composerDraftOfParts(parts);
  const text = draft.html.trim();
  return draft.pastedTexts.length === 0 &&
    parts.length > 0 &&
    canQueueMessage(message) &&
    text !== ""
    ? text
    : null;
};

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
 * The text a running turn can be handed in place of a queued message: a
 * message of text alone, whole in its preview, queued to be sent raw (a
 * steer hands the text to the computer's harness as is). `null` for any
 * other, which only goes as a message of its own.
 */
export const queuedSteerText = (item: ChatQueueItem): string | null => {
  const text = item.preview.trim();
  return item.attachmentCount === 0 &&
    text !== "" &&
    item.preview.length < CHAT_QUEUE_PREVIEW_MAX_CHARS &&
    item.sendMode === CHAT_SEND_MODE.rawOverride
    ? text
    : null;
};

/**
 * What Send now does with a queued message, by what the thread does:
 * - `steer`: a turn on the member's computer that takes a message mid-turn
 *   runs; it is handed the message (`text`) and goes on with it.
 * - `replace`: a turn waits on the member; Send now ends what it waits on,
 *   which the member confirms first.
 * - `send`: the server sends it next, now, stopping a turn that runs.
 */
export type QueuedSendNow =
  { type: "steer"; text: string } | { type: "replace" } | { type: "send" };

export const queuedSendNow = (
  state: ChatThreadSendState,
  item: ChatQueueItem,
): QueuedSendNow => {
  switch (state.type) {
    case "idle":
      return { type: "send" };
    case "waiting_on_member":
      return { type: "replace" };
    case "working": {
      const text =
        state.steering === CHAT_TURN_STEERING.steerable
          ? queuedSteerText(item)
          : null;
      return text === null ? { type: "send" } : { type: "steer", text };
    }
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
