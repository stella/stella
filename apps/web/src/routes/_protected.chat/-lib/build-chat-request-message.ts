import type { FileUIPart } from "ai";

import type { ChatInputDraft } from "@/components/chat-editor-provider";

type ChatRequestMessage =
  | { text: string }
  | { files: FileUIPart[] }
  | { text: string; files: FileUIPart[] };

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
  if (files.length === 0) {
    return { text: html };
  }

  const fileParts: FileUIPart[] = await Promise.all(
    files.map(async (file) => ({
      type: "file",
      filename: file.filename,
      mediaType: file.mimeType,
      url: await toDataUrl(file.file),
    })),
  );

  if (!html) {
    return { files: fileParts };
  }

  return {
    files: fileParts,
    text: html,
  };
};
