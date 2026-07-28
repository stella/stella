import type { MultimodalContent } from "@tanstack/ai-client";

import type { ChatInputDraft } from "@/components/chat-editor-provider";
import type {
  ChatAttachmentPart,
  ChatPart,
} from "@/components/chat/chat-ui-tools";
import { toSafeId } from "@/lib/safe-id";
import type { SafeId } from "@/lib/safe-id";

type ChatRequestMessage = MultimodalContent & {
  id: SafeId<"chatMessage">;
};

const IMAGE_MIME_PREFIX = "image/";

const createChatMessageId = (): SafeId<"chatMessage"> =>
  toSafeId<"chatMessage">(crypto.randomUUID());

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

export const buildChatRequestMessage = async ({
  files,
  html,
}: ChatInputDraft): Promise<ChatRequestMessage> => {
  const id = createChatMessageId();

  if (files.length === 0) {
    return { id, content: html };
  }

  const fileParts: ChatAttachmentPart[] = await Promise.all(
    files.map(async (file): Promise<ChatAttachmentPart> => {
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
    }),
  );

  if (!html) {
    return { id, content: fileParts };
  }

  return {
    id,
    content: [{ type: "text", content: html } satisfies ChatPart, ...fileParts],
  };
};
