import type { FileUIPart } from "ai";
import { isFileUIPart } from "ai";
import { Result } from "better-result";

import type { SafeDb, SafeDbError } from "@/api/db";
import { userFiles } from "@/api/db/schema";
import {
  CHAT_MAX_FILE_BYTES,
  TEXT_PLAIN_MIME_TYPE,
} from "@/api/handlers/chat/attachment-validation";
import { ChatError } from "@/api/handlers/chat/errors";
import { createUserFileKey } from "@/api/handlers/files/utils";
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
  ChatMessage,
  HandlerError<400 | 422 | 500> | SafeDbError
>;

export const uploadMessageFiles = async ({
  message,
  safeDb,
  threadId,
  userId,
}: UploadMessageFilesProps): Promise<UploadMessageFilesReturn> => {
  if (message.role !== "user") {
    return Result.ok(message);
  }

  return await Result.gen(async function* () {
    const parts: ChatMessage["parts"] = [];

    for (const part of message.parts) {
      if (!isFileUIPart(part) || isUserFileUrl(part.url)) {
        parts.push(part);
        continue;
      }

      const parsedPart = yield* parseMessageFileDataUrl({ part });
      const uploadedFile = yield* Result.await(
        uploadUserFile({
          file: parsedPart,
          safeDb,
          threadId,
          userId,
        }),
      );

      parts.push({
        ...part,
        filename: uploadedFile.fileName,
        mediaType: uploadedFile.mimeType,
        url: toUserFileUrl(uploadedFile.id),
      });
    }

    return Result.ok({
      ...message,
      parts,
    });
  });
};

type HydrateFilePartProps = {
  fileName: string;
  mimeType: string;
  s3Key: string;
};

export const hydrateFilePart = async ({
  fileName,
  mimeType,
  s3Key,
}: HydrateFilePartProps) =>
  await Result.gen(async function* () {
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

    if (mimeType !== DOCX_MIME_TYPE) {
      return Result.ok<FileUIPart>({
        type: "file",
        filename: fileName,
        mediaType: mimeType,
        url: toDataUrl(bytes, mimeType),
      });
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
      return Result.err(
        new HandlerError({
          status: 422,
          message: "Chat DOCX attachment did not contain extractable text",
        }),
      );
    }

    return Result.ok<FileUIPart>({
      type: "file",
      filename: toDocxTextFilename({ filename: fileName }),
      mediaType: TEXT_PLAIN_MIME_TYPE,
      url: toDataUrl(Buffer.from(text, "utf-8"), TEXT_PLAIN_MIME_TYPE),
    });
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
