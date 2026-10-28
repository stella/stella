import type { MultimodalContent } from "@tanstack/ai-client";

import { createChatPastedTextPart } from "@stll/api-contract/chat";
import type { ChatPastedTextPart } from "@stll/api-contract/chat";
import { hasChatModelContent } from "@stll/api-contract/chat-message-content";

import type { ChatInputDraft } from "@/components/chat-editor-provider";
import type {
  ChatAttachmentPart,
  ChatPart,
} from "@/components/chat/chat-ui-tools";
import {
  chatDraftHasModelContent,
  emptyChatMessageError,
} from "@/features/chat/lib/chat-message-model-content";
import { toSafeId } from "@/lib/safe-id";
import type { SafeId } from "@/lib/safe-id";
import { createUuid } from "@/lib/uuid";

type ChatRequestMessage = MultimodalContent & {
  id: SafeId<"chatMessage">;
};

const IMAGE_MIME_PREFIX = "image/";

const createChatMessageId = (): SafeId<"chatMessage"> =>
  toSafeId<"chatMessage">(createUuid());

const toDataUrl = async (file: File) =>
  await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("Failed to read attachment"));
    });
    reader.addEventListener("load", () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Attachment reader returned a non-string result"));
        return;
      }

      resolve(reader.result);
    });
    reader.readAsDataURL(file);
  });

/**
 * A message of plain text, such as a preset prompt, refused like a draft
 * when it has nothing for the model to read.
 */
export const buildChatTextMessage = (text: string): ChatRequestMessage => {
  if (!hasChatModelContent([{ type: "text", content: text }])) {
    throw emptyChatMessageError();
  }
  return { content: text, id: createChatMessageId() };
};

/**
 * The one way a composer draft becomes a chat request message. A draft with
 * nothing for the model to read is refused with `EmptyChatMessageError`
 * before any attachment is read, so nothing is sent and the composer keeps
 * the draft.
 */
export const buildChatRequestMessage = async (
  draft: ChatInputDraft,
): Promise<ChatRequestMessage> => {
  if (!chatDraftHasModelContent(draft)) {
    throw emptyChatMessageError();
  }
  const { files, html } = draft;
  const id = createChatMessageId();

  if (files.length === 0) {
    return { id, content: html };
  }

  const attachmentParts = await Promise.all(
    files.map(
      async (file): Promise<ChatAttachmentPart | ChatPastedTextPart> => {
        if (file.type === "pasted_text") {
          return createChatPastedTextPart(file.text);
        }
        const source = {
          type: "url" as const,
          value: await toDataUrl(file.file),
          mimeType: file.mimeType,
        };
        const metadata = { filename: file.filename };

        if (file.mimeType.startsWith(IMAGE_MIME_PREFIX)) {
          return { type: "image", source, metadata };
        }

        return { type: "document", source, metadata };
      },
    ),
  );

  if (!html) {
    return { id, content: attachmentParts };
  }

  return {
    id,
    content: [
      { type: "text", content: html } satisfies ChatPart,
      ...attachmentParts,
    ],
  };
};
