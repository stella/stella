import type { JSONContent } from "@tiptap/react";

import { CHAT_MESSAGE_EDIT_ERROR_CODE } from "@stll/api-contract";
import type { ChatMessageEditErrorCode } from "@stll/api-contract";
import { isChatPastedTextPart } from "@stll/api-contract/chat";
import type { ChatPastedTextPart } from "@stll/api-contract/chat";

import { userMessageComposerContent } from "@/components/chat-editor-markdown.logic";
import type {
  ChatAttachmentPart,
  ChatPart,
  PersistedChatMessage,
} from "@/components/chat/chat-ui-tools";
import { CHAT_REQUEST_ERROR_TRANSLATION_KEYS } from "@/features/chat/chat-request-error";
import type { ChatRequestError } from "@/features/chat/chat-request-error";
import type { ChatUserMessageInput } from "@/features/chat/chat-runtime";
import type { TranslationKey } from "@/i18n/types";
import { STATUS_ERROR_KEYS, STATUS_TO_KEY } from "@/lib/errors/localization";
import type { StatusErrorKey } from "@/lib/errors/localization";
import { toSafeId } from "@/lib/safe-id";

export type UserMessageEditAttachmentPart =
  ChatAttachmentPart | ChatPastedTextPart;

/** An attachment of the edited message, under an id for this edit session. */
export type UserMessageEditAttachment = {
  id: string;
  part: UserMessageEditAttachmentPart;
};

/** What the edit form opens with: the message's text as composer content,
 *  and its attachments. */
export type UserMessageEditDraft = {
  attachments: readonly UserMessageEditAttachment[];
  content: JSONContent | string;
};

/** What sending an edit carries: the composer's markup, as a new message
 *  carries it, and the attachments the user kept. */
export type UserMessageEdit = {
  attachments: readonly UserMessageEditAttachmentPart[];
  html: string;
};

/**
 * How sending an edit ended. Only `accepted` closes the form: every other
 * outcome leaves it open on the user's draft, over the thread as the server
 * stores it.
 * - `accepted`: the server took the edit's turn, which now answers it.
 * - `edit-refused`: the server refused the edit itself (`code`); a message
 *   the page no longer holds reads as `targetMissing`.
 * - `request-refused`: the server refused the request for another reason,
 *   such as a lapsed session, a missing permission or invalid input.
 * - `ai-unavailable`: no AI model is available, so nothing was sent.
 * - `request-failed`: the request did not reach the server or was not
 *   started (`kind`), such as a lost connection.
 * - `failed`: the request failed in a way none of the above names.
 */
export type UserMessageEditOutcome =
  | { type: "accepted" }
  | { type: "edit-refused"; code: ChatMessageEditErrorCode }
  | { type: "request-refused"; status: number }
  | { type: "ai-unavailable" }
  | { type: "request-failed"; kind: ChatRequestError["kind"] }
  | { type: "failed" };

export type UserMessageEditFailure = Exclude<
  UserMessageEditOutcome,
  { type: "accepted" }
>;

/**
 * What sending an edit came to, as the session hands it to the page. The
 * session keeps the edit it was sent until the server answers: when the
 * thread it then shows no longer holds the edited message (the server
 * dropped it), the edit comes back as `orphanedEdit`, so the page puts it
 * into the composer instead of losing it with the message's form.
 */
export type UserMessageEditResult =
  | { orphanedEdit: null; outcome: UserMessageEditOutcome }
  | { orphanedEdit: UserMessageEdit; outcome: UserMessageEditFailure };

/** An orphaned edit as the composer takes it: its markup, and the texts of
 *  its pasted-text attachments. */
export const userMessageEditHandoff = (
  edit: UserMessageEdit,
): { html: string; pastedTexts: string[] } => ({
  html: edit.html,
  pastedTexts: edit.attachments
    .filter(isChatPastedTextPart)
    .map(({ content }) => content),
});

/** The notice for each code the server refuses an edit with. */
const EDIT_REFUSAL_NOTICE_KEYS = {
  [CHAT_MESSAGE_EDIT_ERROR_CODE.historyChanged]:
    "chat.editMessageRefusedHistoryChanged",
  [CHAT_MESSAGE_EDIT_ERROR_CODE.targetMissing]:
    "chat.editMessageRefusedTargetMissing",
  [CHAT_MESSAGE_EDIT_ERROR_CODE.targetNotUserMessage]:
    "chat.editMessageRefusedTargetMissing",
  [CHAT_MESSAGE_EDIT_ERROR_CODE.turnRunning]: "chat.editMessageRefused",
} as const satisfies Record<ChatMessageEditErrorCode, TranslationKey>;

type UserMessageEditNoticeKey =
  | (typeof EDIT_REFUSAL_NOTICE_KEYS)[ChatMessageEditErrorCode]
  | StatusErrorKey
  | (typeof CHAT_REQUEST_ERROR_TRANSLATION_KEYS)[ChatRequestError["kind"]]
  | "chat.editMessageAiUnavailable"
  | "chat.sendError";

/** What the open edit form tells the user about an edit that was not
 *  accepted: one notice for every outcome, decided by an exhaustive
 *  switch. */
export const userMessageEditNoticeKey = (
  failure: UserMessageEditFailure,
): UserMessageEditNoticeKey => {
  let key: UserMessageEditNoticeKey;
  switch (failure.type) {
    case "edit-refused":
      key = EDIT_REFUSAL_NOTICE_KEYS[failure.code];
      break;
    case "request-refused":
      key = STATUS_TO_KEY[failure.status] ?? STATUS_ERROR_KEYS.unknown;
      break;
    case "ai-unavailable":
      key = "chat.editMessageAiUnavailable";
      break;
    case "request-failed":
      key = CHAT_REQUEST_ERROR_TRANSLATION_KEYS[failure.kind];
      break;
    case "failed":
      key = "chat.sendError";
      break;
  }
  return key;
};

const isEditAttachmentPart = (
  part: ChatPart,
): part is UserMessageEditAttachmentPart =>
  part.type === "image" ||
  part.type === "document" ||
  isChatPastedTextPart(part);

/** The edit form's starting state for a sent user message. */
export const createUserMessageEditDraft = (
  message: Pick<PersistedChatMessage, "parts">,
  createId: () => string,
): UserMessageEditDraft => {
  const texts: string[] = [];
  const attachments: UserMessageEditAttachment[] = [];
  for (const part of message.parts) {
    if (isEditAttachmentPart(part)) {
      attachments.push({ id: createId(), part });
    } else if (part.type === "text") {
      texts.push(part.content);
    }
  }
  return {
    attachments,
    // The composer sends one text part; its parts read as one document.
    content: userMessageComposerContent(texts.join("\n\n")),
  };
};

/** Whether the edit would send anything: text or a kept attachment. */
export const hasUserMessageEditContent = (edit: UserMessageEdit): boolean =>
  edit.html.length > 0 || edit.attachments.length > 0;

/**
 * The message the edit sends: the same id as the message it replaces, and
 * the content a new message from the composer would carry.
 */
export const buildEditedUserMessage = ({
  edit,
  messageId,
}: {
  edit: UserMessageEdit;
  messageId: string;
}): ChatUserMessageInput => {
  const id = toSafeId<"chatMessage">(messageId);
  const attachments = [...edit.attachments];
  if (attachments.length === 0) {
    return { id, content: edit.html };
  }
  if (edit.html.length === 0) {
    return { id, content: attachments };
  }
  return {
    id,
    content: [
      { type: "text", content: edit.html } satisfies ChatPart,
      ...attachments,
    ],
  };
};
