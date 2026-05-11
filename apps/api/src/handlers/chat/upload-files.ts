import type { FileUIPart } from "ai";
import { isFileUIPart } from "ai";
import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";

import {
  CHAT_SEND_MODE,
  CHAT_TRANSPORT_ERROR_CODE,
} from "@stll/anonymize-chat";
import type { ChatSendMode } from "@stll/anonymize-chat";

import type { SafeDb, SafeDbError } from "@/api/db";
import { userFiles } from "@/api/db/schema";
import {
  CHAT_MAX_FILE_BYTES,
  TEXT_CSV_MIME_TYPE,
  TEXT_MARKDOWN_MIME_TYPE,
  TEXT_PLAIN_MIME_TYPE,
} from "@/api/handlers/chat/attachment-validation";
import { ChatError } from "@/api/handlers/chat/errors";
import { createUserFileKey, deleteS3Keys } from "@/api/handlers/files/utils";
import { isUserFileUrl, toUserFileUrl } from "@/api/handlers/user-files/types";
import { captureError } from "@/api/lib/analytics";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  isDataUrlSizeLimitError,
  parseDataUrl,
  toDataUrl,
} from "@/api/lib/data-url";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { getScanWarnings, scanFile } from "@/api/lib/file-scan/scan";
import { FILE_SIZE_LIMITS, LIMITS } from "@/api/lib/limits";
import { getS3 } from "@/api/lib/s3";
import { DOCX_EXT_RE, sanitizeFilename } from "@/api/lib/sanitize-filename";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

import { extractText } from "../docx/extract-text";
import type { ChatMessage } from "./types";

export type UserFileThreadAccess = {
  threadId: SafeId<"chatThread">;
  userId: SafeId<"user">;
};

type UploadMessageFilesProps = {
  message: ChatMessage;
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
  userId: SafeId<"user">;
};

type UploadMessageFilesReturn = Result<
  UploadedChatMessage,
  HandlerError<400 | 422 | 500> | SafeDbError
>;

export type UploadedChatFile = {
  id: SafeId<"userFile">;
  s3Key: string;
};

type UploadedChatMessage = {
  message: ChatMessage;
  uploadedFiles: UploadedChatFile[];
};

export const uploadMessageFiles = async ({
  message,
  safeDb,
  threadId,
  userId,
}: UploadMessageFilesProps): Promise<UploadMessageFilesReturn> => {
  if (message.role !== "user") {
    return Result.ok({ message, uploadedFiles: [] });
  }

  const uploadedFiles: UploadedChatFile[] = [];
  const parts: ChatMessage["parts"] = [];
  const fail = async (
    error: HandlerError<400 | 422 | 500> | SafeDbError,
  ): Promise<UploadMessageFilesReturn> => {
    if (uploadedFiles.length === 0) {
      return Result.err(error);
    }

    const rollbackResult = await deleteUploadedChatFiles({
      files: uploadedFiles,
      safeDb,
      threadId,
      userId,
    });

    if (Result.isOk(rollbackResult)) {
      return Result.err(error);
    }

    captureError(error, { threadId });
    return Result.err(rollbackResult.error);
  };

  for (const part of message.parts) {
    if (!isFileUIPart(part) || isUserFileUrl(part.url)) {
      parts.push(part);
      continue;
    }

    const parsedPart = parseMessageFileDataUrl({ part });
    if (Result.isError(parsedPart)) {
      return await fail(parsedPart.error);
    }

    const uploadedFile = await uploadUserFile({
      file: parsedPart.value,
      safeDb,
      threadId,
      userId,
    });
    if (Result.isError(uploadedFile)) {
      return await fail(uploadedFile.error);
    }

    uploadedFiles.push({
      id: uploadedFile.value.id,
      s3Key: uploadedFile.value.s3Key,
    });
    parts.push({
      ...part,
      filename: uploadedFile.value.fileName,
      mediaType: uploadedFile.value.mimeType,
      url: toUserFileUrl(uploadedFile.value.id),
    });
  }

  return Result.ok({
    message: {
      ...message,
      parts,
    },
    uploadedFiles,
  });
};

export const deleteUploadedChatFiles = async ({
  files,
  safeDb,
  threadId,
  userId,
}: {
  files: readonly UploadedChatFile[];
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
  userId: SafeId<"user">;
}): Promise<Result<void, HandlerError<500> | SafeDbError>> => {
  if (files.length === 0) {
    return Result.ok();
  }

  const deleteS3Result = await deleteS3Keys(files.map((file) => file.s3Key));
  if (Result.isError(deleteS3Result)) {
    return Result.err(
      new HandlerError({
        status: 500,
        message: "Failed to delete uploaded chat attachments from storage",
        cause: deleteS3Result.error,
      }),
    );
  }

  const deleteDbResult = await safeDb((tx) =>
    tx.delete(userFiles).where(
      and(
        eq(userFiles.threadId, threadId),
        eq(userFiles.userId, userId),
        inArray(
          userFiles.id,
          files.map((file) => file.id),
        ),
      ),
    ),
  );

  return deleteDbResult.andThen(() => Result.ok());
};

type HydrateFilePartProps = {
  fileName: string;
  mimeType: string;
  sendMode: ChatSendMode;
  s3Key: string;
};

export type HydratedFilePart =
  | {
      part: FileUIPart;
      type: "anonymizable";
    }
  | {
      error: HandlerError<422>;
      type: "blocked";
    }
  | {
      part: FileUIPart;
      type: "raw";
    }
  | {
      part: FileUIPart;
      type: "rawOverride";
    };

const DIRECT_TEXT_MIME_TYPES: ReadonlySet<string> = new Set([
  TEXT_CSV_MIME_TYPE,
  TEXT_MARKDOWN_MIME_TYPE,
  TEXT_PLAIN_MIME_TYPE,
]);
const THIRD_PARTY_BOUNDARY_REFUSAL_MESSAGE =
  "Cannot send this attachment to the AI in anonymized mode because Stella cannot extract and anonymize it safely.";

export const canHydrateFilePartAsPlainText = (mimeType: string): boolean =>
  DIRECT_TEXT_MIME_TYPES.has(mimeType) || mimeType === DOCX_MIME_TYPE;

const toHydratedFilePart = ({
  part,
  sendMode,
}: {
  part: FileUIPart;
  sendMode: ChatSendMode;
}): HydratedFilePart => {
  if (sendMode === CHAT_SEND_MODE.anonymized) {
    return { part, type: "anonymizable" };
  }
  if (sendMode === CHAT_SEND_MODE.rawOverride) {
    return { part, type: "rawOverride" };
  }
  return { part, type: "raw" };
};

const createBlockedHydratedFilePart = (): HydratedFilePart => ({
  error: new HandlerError({
    code: CHAT_TRANSPORT_ERROR_CODE.thirdPartyBoundaryRefusal,
    status: 422,
    message: THIRD_PARTY_BOUNDARY_REFUSAL_MESSAGE,
  }),
  type: "blocked",
});

const createRawFilePart = ({
  bytes,
  fileName,
  mimeType,
}: {
  bytes: Uint8Array;
  fileName: string;
  mimeType: string;
}): FileUIPart => ({
  type: "file",
  filename: fileName,
  mediaType: mimeType,
  url: toDataUrl(bytes, mimeType),
});

export const hydrateFilePart = async ({
  fileName,
  mimeType,
  sendMode,
  s3Key,
}: HydrateFilePartProps) =>
  await Result.gen(async function* () {
    const requiresPlainText = sendMode === CHAT_SEND_MODE.anonymized;
    if (requiresPlainText && !canHydrateFilePartAsPlainText(mimeType)) {
      return Result.ok<HydratedFilePart>(createBlockedHydratedFilePart());
    }

    const buffer = yield* Result.await(
      Result.tryPromise({
        try: async () => await getS3().file(s3Key).arrayBuffer(),
        catch: (cause) =>
          new ChatError({
            message: "Failed to read chat attachment",
            cause,
          }),
      }),
    );
    const bytes = new Uint8Array(buffer);

    if (sendMode === CHAT_SEND_MODE.rawOverride) {
      return Result.ok<HydratedFilePart>({
        part: createRawFilePart({ bytes, fileName, mimeType }),
        type: "rawOverride",
      });
    }

    if (DIRECT_TEXT_MIME_TYPES.has(mimeType)) {
      const hydratedMimeType = requiresPlainText
        ? TEXT_PLAIN_MIME_TYPE
        : mimeType;
      return Result.ok<HydratedFilePart>(
        toHydratedFilePart({
          part: {
            type: "file",
            filename: fileName,
            mediaType: hydratedMimeType,
            url: toDataUrl(bytes, hydratedMimeType),
          },
          sendMode,
        }),
      );
    }

    if (mimeType !== DOCX_MIME_TYPE) {
      return Result.ok<HydratedFilePart>(
        toHydratedFilePart({
          part: createRawFilePart({ bytes, fileName, mimeType }),
          sendMode,
        }),
      );
    }

    const extractedText = yield* Result.await(
      Result.tryPromise({
        try: async () => {
          const extracted = await extractText(bytes);

          return extracted.paragraphs
            .map((paragraph) => paragraph.text.trim())
            .filter(Boolean)
            .join("\n")
            .slice(0, LIMITS.chatContextFileMaxChars);
        },
        catch: (cause) =>
          new ChatError({
            message: "Failed to extract text from chat DOCX attachment",
            cause,
          }),
      }),
    );

    const text = extractedText.trim();

    if (!text) {
      if (requiresPlainText) {
        return Result.ok<HydratedFilePart>(createBlockedHydratedFilePart());
      }
      return Result.err(
        new HandlerError({
          status: 422,
          message: "Chat DOCX attachment did not contain extractable text",
        }),
      );
    }

    return Result.ok<HydratedFilePart>(
      toHydratedFilePart({
        part: {
          type: "file",
          filename: toDocxTextFilename({ filename: fileName }),
          mediaType: TEXT_PLAIN_MIME_TYPE,
          url: toDataUrl(Buffer.from(text, "utf-8"), TEXT_PLAIN_MIME_TYPE),
        },
        sendMode,
      }),
    );
  });

type UploadUserFileInput = {
  file: {
    bytes: Uint8Array;
    fileName: string;
    mimeType: string;
  };
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
  userId: SafeId<"user">;
};

export const uploadUserFile = async ({
  file,
  safeDb,
  threadId,
  userId,
}: UploadUserFileInput) =>
  await Result.gen(async function* () {
    const sanitizedFileName = sanitizeFilename(file.fileName);
    const sha256Hex = new Bun.CryptoHasher("sha256")
      .update(file.bytes)
      .digest("hex");
    const id = createSafeId<"userFile">();

    const s3Key = createUserFileKey({
      fileId: id,
      mimeType: file.mimeType,
      userId,
    });

    const scanResult = await scanFile({
      buffer: file.bytes,
      declaredMimeType: file.mimeType,
      fileName: sanitizedFileName,
    });

    if (Result.isError(scanResult)) {
      return Result.err(
        new HandlerError({
          status: 500,
          message: "Failed to scan chat attachment",
          cause: scanResult.error,
        }),
      );
    }

    if (scanResult.value.verdict === "reject") {
      return Result.err(
        new HandlerError({
          status: 422,
          message: "Chat attachment was rejected by the security scan",
        }),
      );
    }

    const scanWarnings = getScanWarnings(scanResult.value);

    yield* Result.await(
      Result.tryPromise({
        try: async () => await getS3().write(s3Key, file.bytes),
        catch: (cause) =>
          new HandlerError({
            status: 500,
            message: "Failed to store chat attachment",
            cause,
          }),
      }),
    );

    const saveResult = await safeDb((tx) =>
      tx.insert(userFiles).values({
        id,
        userId,
        fileName: sanitizedFileName,
        mimeType: file.mimeType,
        scanWarnings,
        s3Key,
        sha256Hex,
        sizeBytes: file.bytes.byteLength,
        threadId,
      }),
    );

    if (Result.isOk(saveResult)) {
      return Result.ok({
        id,
        mimeType: file.mimeType,
        fileName: sanitizedFileName,
        s3Key,
      });
    }

    const cleanupResult = await Result.tryPromise({
      try: async () => await getS3().delete(s3Key),
      catch: (cleanupError) =>
        new HandlerError({
          status: 500,
          message: "Failed to clean up chat attachment after a save failure",
          cause: cleanupError,
        }),
    });

    if (Result.isOk(cleanupResult)) {
      return Result.err(saveResult.error);
    }

    captureError(saveResult.error, { s3Key, threadId, userFileId: id });
    return Result.err(cleanupResult.error);
  });

type NormalizeUserFilePartProps = {
  fileId: SafeId<"userFile">;
  fileName: string;
  mimeType: string;
  part: FileUIPart;
};

export const normalizeUserFilePart = ({
  fileId,
  fileName,
  mimeType,
  part,
}: NormalizeUserFilePartProps) => ({
  ...part,
  filename: fileName,
  mediaType: mimeType,
  url: toUserFileUrl(fileId),
});

type ParseMessageFileDataUrlProps = {
  part: FileUIPart;
};

const parseMessageFileDataUrl = ({ part }: ParseMessageFileDataUrlProps) => {
  const parseResult = parseDataUrl({
    expectedMimeType: part.mediaType,
    maxBytes: CHAT_MAX_FILE_BYTES,
    url: part.url,
  });

  if (Result.isError(parseResult)) {
    if (isDataUrlSizeLimitError(parseResult.error)) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: `Chat attachment exceeds the ${FILE_SIZE_LIMITS.chatContextFile} size limit`,
          cause: parseResult.error,
        }),
      );
    }

    return Result.err(
      new HandlerError({
        status: 400,
        message: "Invalid chat attachment data URL",
        cause: parseResult.error,
      }),
    );
  }

  return Result.ok({
    bytes: parseResult.value.bytes,
    fileName: sanitizeFilename(part.filename ?? "attachment"),
    mimeType: parseResult.value.mimeType,
  });
};

type ToDocxTextFilenameProps = {
  filename: string;
};

const toDocxTextFilename = ({ filename }: ToDocxTextFilenameProps) =>
  DOCX_EXT_RE.test(filename)
    ? filename.replace(DOCX_EXT_RE, ".txt")
    : `${filename}.txt`;
