import type { JSONContent } from "@tiptap/react";

import { isChatPastedTextPart } from "@stll/api-contract/chat";
import type { ChatPastedTextPart } from "@stll/api-contract/chat";

import { userMessageComposerContent } from "@/components/chat-editor-markdown.logic";
import type {
  ChatAttachmentPart,
  ChatPart,
  PersistedChatMessage,
} from "@/components/chat/chat-ui-tools";
import type { ChatUserMessageInput } from "@/features/chat/chat-runtime";
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
