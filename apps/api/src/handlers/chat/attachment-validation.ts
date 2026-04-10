import type { FileUIPart } from "ai";
import { isFileUIPart } from "ai";
import { Result } from "better-result";

import type { ChatMessage, ChatPart } from "@/api/handlers/chat/types";
import {
  isUserFileUrl,
  parseUserFileId,
} from "@/api/handlers/user-files/types";
import { validateDataUrl } from "@/api/lib/data-url";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { DOCX_MIME_TYPE, PDF_MIME_TYPE } from "@/api/mime-types";

export const TEXT_PLAIN_MIME_TYPE = "text/plain" as const;
export const TEXT_CSV_MIME_TYPE = "text/csv" as const;
export const TEXT_MARKDOWN_MIME_TYPE = "text/markdown" as const;

const IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

export const USER_FILE_ALLOWED_MIME_TYPES = new Set([
  ...IMAGE_MIME_TYPES,
  PDF_MIME_TYPE,
  DOCX_MIME_TYPE,
  TEXT_PLAIN_MIME_TYPE,
  TEXT_CSV_MIME_TYPE,
  TEXT_MARKDOWN_MIME_TYPE,
]);

export type StoredFileRef = {
  id: string;
  mediaType: string;
};

export type StoredChatFile = {
  id: string;
  threadId: string;
  mimeType: string;
};

export const validateChatFileParts = ({
  parts,
}: {
  parts: ChatMessage["parts"];
}): Result<StoredFileRef[], HandlerError<400>> => {
  const storedFileRefs: StoredFileRef[] = [];
  let filePartCount = 0;

  for (const part of parts) {
    if (!isFileUIPart(part)) {
      continue;
    }

    filePartCount += 1;

    if (filePartCount > LIMITS.chatContextFilesPerMessage) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Too many chat attachments in a single message",
        }),
      );
    }

    if (part.url.startsWith("data:")) {
      const dataUrlResult = validateDataUrl({
        expectedMimeType: part.mediaType,
        url: part.url,
      });

      if (Result.isError(dataUrlResult)) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Invalid chat attachment data URL",
            cause: dataUrlResult.error,
          }),
        );
      }

      if (!USER_FILE_ALLOWED_MIME_TYPES.has(part.mediaType)) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Unsupported chat attachment type",
          }),
        );
      }

      continue;
    }

    if (isChatFilePart(part)) {
      const fileIdResult = getUserFileIdFromPart(part);

      if (Result.isError(fileIdResult)) {
        return Result.err(fileIdResult.error);
      }

      if (!USER_FILE_ALLOWED_MIME_TYPES.has(part.mediaType)) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Unsupported chat attachment type",
          }),
        );
      }

      storedFileRefs.push({
        id: fileIdResult.value,
        mediaType: part.mediaType,
      });
      continue;
    }

    return Result.err(
      new HandlerError({
        status: 400,
        message:
          "Chat attachments must use base64 data URLs or stella user-file URLs",
      }),
    );
  }

  return Result.ok(storedFileRefs);
};

export const validateStoredFileRefs = ({
  files,
  refs,
  threadId,
}: {
  files: StoredChatFile[];
  refs: StoredFileRef[];
  threadId: string;
}): Result<void, HandlerError<400 | 403 | 404>> => {
  const userFilesById = new Map(files.map((file) => [file.id, file]));

  for (const { id, mediaType } of refs) {
    const file = userFilesById.get(id);

    if (!file) {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "Chat attachment file not found",
        }),
      );
    }

    if (file.mimeType !== mediaType) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Chat attachment MIME type does not match stored file",
        }),
      );
    }

    if (file.threadId !== threadId) {
      return Result.err(
        new HandlerError({
          status: 403,
          message: "Chat attachment does not belong to this thread",
        }),
      );
    }
  }

  return Result.ok();
};

export const getUserFileIdFromPart = (
  part: FileUIPart,
): Result<string, HandlerError<400>> => {
  if (!isUserFileUrl(part.url)) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Invalid user-file URL",
      }),
    );
  }

  const id = parseUserFileId(part.url);

  if (id === null) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Invalid user-file URL",
      }),
    );
  }

  return Result.ok(id);
};

const isChatFilePart = (part: ChatPart): part is FileUIPart =>
  isFileUIPart(part) && isUserFileUrl(part.url);
