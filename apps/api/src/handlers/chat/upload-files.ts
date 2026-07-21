import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";

import {
  CHAT_SEND_MODE,
  CHAT_TRANSPORT_ERROR_CODE,
} from "@stll/anonymize-chat";
import type { ChatSendMode } from "@stll/anonymize-chat";
import { docxToMarkdown } from "@stll/folio-core/server";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { userFiles } from "@/api/db/schema";
import {
  CHAT_MAX_FILE_BYTES,
  TEXT_CSV_MIME_TYPE,
  TEXT_MARKDOWN_MIME_TYPE,
  TEXT_PLAIN_MIME_TYPE,
  USER_FILE_ALLOWED_MIME_TYPES,
} from "@/api/handlers/chat/attachment-validation";
import {
  createChatAttachmentPart,
  createChatTextPart,
  getChatAttachmentFilename,
  getChatAttachmentMimeType,
  getChatAttachmentUrl,
  isChatAttachmentPart,
} from "@/api/handlers/chat/chat-message-parts";
import { ChatError } from "@/api/handlers/chat/errors";
import {
  generateImageThumbnail,
  shouldGenerateImageThumbnail,
  THUMBNAIL_MIME_TYPE,
} from "@/api/handlers/files/image-derivative";
import { createUserFileKey, deleteS3Keys } from "@/api/handlers/files/utils";
import { isUserFileUrl, toUserFileUrl } from "@/api/handlers/user-files/types";
import { captureError } from "@/api/lib/analytics/capture";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
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
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

import type {
  ChatAttachmentPart,
  ChatMessage,
  ChatPart,
  PersistableChatMessage,
} from "./types";

export type UserFileThreadAccess = {
  threadId: SafeId<"chatThread">;
  userId: SafeId<"user">;
};

type UploadMessageFilesProps = {
  message: PersistableChatMessage;
  recordAuditEvent: AuditRecorder;
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace"> | null;
};

type UploadMessageFilesReturn = Result<
  UploadedChatMessage,
  HandlerError<400 | 422 | 500> | SafeDbError
>;

export type UploadedChatFile = {
  id: SafeId<"userFile">;
  s3Key: string;
  thumbnailS3Key: string | null;
};

type UploadedChatMessage = {
  message: PersistableChatMessage;
  uploadedFiles: UploadedChatFile[];
};

export const uploadMessageFiles = async ({
  message,
  recordAuditEvent,
  safeDb,
  threadId,
  userId,
  workspaceId,
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
      recordAuditEvent,
      safeDb,
      threadId,
      userId,
      workspaceId,
    });

    if (Result.isOk(rollbackResult)) {
      return Result.err(error);
    }

    captureError(error, { threadId });
    return Result.err(rollbackResult.error);
  };

  for (const part of message.parts) {
    if (
      !isChatAttachmentPart(part) ||
      isUserFileUrl(getChatAttachmentUrl(part))
    ) {
      parts.push(part);
      continue;
    }

    const parsedPart = parseMessageFileDataUrl({ part });
    if (Result.isError(parsedPart)) {
      // oxlint-disable-next-line no-await-in-loop -- early-exit on first parse failure; awaits rollback of already-uploaded files
      return await fail(parsedPart.error);
    }

    // oxlint-disable-next-line no-await-in-loop -- sequential per-file upload + DB write preserving parts order, with rollback on error
    const uploadedFile = await uploadUserFile({
      file: parsedPart.value,
      recordAuditEvent,
      safeDb,
      threadId,
      userId,
      workspaceId,
    });
    if (Result.isError(uploadedFile)) {
      // oxlint-disable-next-line no-await-in-loop -- early-exit on first upload failure; awaits rollback of already-uploaded files
      return await fail(uploadedFile.error);
    }

    uploadedFiles.push({
      id: uploadedFile.value.id,
      s3Key: uploadedFile.value.s3Key,
      thumbnailS3Key: uploadedFile.value.thumbnailS3Key,
    });
    parts.push({
      ...createChatAttachmentPart({
        filename: uploadedFile.value.fileName,
        mimeType: uploadedFile.value.mimeType,
        url: toUserFileUrl(uploadedFile.value.id),
      }),
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
  recordAuditEvent,
  safeDb,
  threadId,
  userId,
  workspaceId,
}: {
  files: readonly UploadedChatFile[];
  recordAuditEvent: AuditRecorder;
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace"> | null;
}): Promise<Result<void, HandlerError<500> | SafeDbError>> => {
  if (files.length === 0) {
    return Result.ok();
  }

  const deleteS3Result = await deleteS3Keys(
    files.flatMap((file) =>
      file.thumbnailS3Key ? [file.s3Key, file.thumbnailS3Key] : [file.s3Key],
    ),
  );
  if (Result.isError(deleteS3Result)) {
    return Result.err(
      new HandlerError({
        status: 500,
        message: "Failed to delete uploaded chat attachments from storage",
        cause: deleteS3Result.error,
      }),
    );
  }

  const deleteDbResult = await safeDb(async (tx) => {
    await tx.delete(userFiles).where(
      and(
        eq(userFiles.threadId, threadId),
        eq(userFiles.userId, userId),
        inArray(
          userFiles.id,
          files.map((file) => file.id),
        ),
      ),
    );

    await recordAuditEvent(
      tx,
      files.map((file) => ({
        action: AUDIT_ACTION.DELETE,
        resourceType: AUDIT_RESOURCE_TYPE.CHAT_FILE,
        resourceId: file.id,
        workspaceId,
        metadata: { threadId, s3Key: file.s3Key },
      })),
    );
  });

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
      // A text-extractable attachment (docx/txt/csv/md) hydrated to a `text`
      // content part, or any part that carries anonymizable text. Text is
      // universal across provider adapters, so this is never modality-gated.
      part: ChatPart;
      type: "anonymizable";
    }
  | {
      error: HandlerError<422>;
      type: "blocked";
    }
  | {
      part: ChatAttachmentPart;
      type: "rawOverride";
    };

const DIRECT_TEXT_MIME_TYPES: ReadonlySet<string> = new Set([
  TEXT_CSV_MIME_TYPE,
  TEXT_MARKDOWN_MIME_TYPE,
  TEXT_PLAIN_MIME_TYPE,
]);
const THIRD_PARTY_BOUNDARY_REFUSAL_MESSAGE =
  "Cannot send this attachment to the AI in anonymized mode because stella cannot extract and anonymize it safely.";

export const canHydrateFilePartAsPlainText = (mimeType: string): boolean =>
  DIRECT_TEXT_MIME_TYPES.has(mimeType) || mimeType === DOCX_MIME_TYPE;

const createBlockedHydratedFilePart = (): HydratedFilePart => ({
  error: new HandlerError({
    code: CHAT_TRANSPORT_ERROR_CODE.thirdPartyBoundaryRefusal,
    status: 422,
    message: THIRD_PARTY_BOUNDARY_REFUSAL_MESSAGE,
  }),
  type: "blocked",
});

export const createRawChatFilePart = ({
  bytes,
  fileName,
  mimeType,
}: {
  bytes: Uint8Array;
  fileName: string;
  mimeType: string;
}): ChatAttachmentPart =>
  createChatAttachmentPart({
    filename: fileName,
    mimeType,
    url: toDataUrl(bytes, mimeType),
  });

/**
 * Wraps extracted attachment text with a filename header so the model has the
 * same context a `document` part's filename metadata used to carry. The header
 * is provider-bound context, not user-facing UI; the user still sees the
 * attachment chip from the persisted reference part.
 */
const attachmentText = ({
  fileName,
  content,
}: {
  fileName: string;
  content: string;
}): string => `Attached file "${fileName}":\n\n${content}`;

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

    // Text-extractable formats are ALWAYS reduced to a `text` content part
    // before dispatch. Text is universal across provider adapters, so it is
    // never modality-gated and never crashes a stream (unlike a `document`
    // part, which the Mistral adapter rejects unless it is a PDF). rawOverride
    // ("anonymization off") means "skip anonymization", NOT "ship raw bytes":
    // no adapter ingests raw docx/csv/md. Only genuine binary formats (image,
    // PDF) are sent raw, in the fallthrough below. Ordering is load-bearing —
    // a rawOverride short-circuit placed before these branches (the previous
    // shape) made the extraction dead code whenever anonymization was off (the
    // default), shipping raw docx that every adapter rejects. The persisted
    // `userfile://` reference part (see `uploadMessageFiles`) still renders the
    // attachment chip; only the provider-bound copy becomes text.
    if (DIRECT_TEXT_MIME_TYPES.has(mimeType)) {
      return Result.ok<HydratedFilePart>({
        part: createChatTextPart(
          attachmentText({
            fileName,
            // Cap like the DOCX branch: a text/csv/md attachment can be up to
            // the full upload size, and the model context budget is bounded.
            content: new TextDecoder()
              .decode(bytes)
              .slice(0, LIMITS.chatContextFileMaxChars),
          }),
        ),
        type: "anonymizable",
      });
    }

    if (mimeType === DOCX_MIME_TYPE) {
      // Use folio's structure-preserving Markdown extraction (headings,
      // tables, lists, content controls) rather than a flat paragraph join:
      // document structure is high-signal context for the model reading a
      // legal document.
      const markdown = yield* Result.await(
        Result.tryPromise({
          try: async () =>
            (await docxToMarkdown(bytes)).slice(
              0,
              LIMITS.chatContextFileMaxChars,
            ),
          catch: (cause) =>
            new ChatError({
              message: "Failed to extract text from chat DOCX attachment",
              cause,
            }),
        }),
      );

      const text = markdown.trim();
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

      return Result.ok<HydratedFilePart>({
        part: createChatTextPart(attachmentText({ fileName, content: text })),
        type: "anonymizable",
      });
    }

    // Remaining formats are genuine binary (image, PDF). Anonymized mode
    // blocked them above (they cannot be reduced to plain text), so only
    // rawOverride reaches here; send them raw for the model to ingest natively.
    if (sendMode === CHAT_SEND_MODE.rawOverride) {
      return Result.ok<HydratedFilePart>({
        part: createRawChatFilePart({ bytes, fileName, mimeType }),
        type: "rawOverride",
      });
    }

    return Result.ok<HydratedFilePart>(createBlockedHydratedFilePart());
  });

type UploadUserFileInput = {
  file: {
    bytes: Uint8Array;
    fileName: string;
    mimeType: string;
  };
  recordAuditEvent: AuditRecorder;
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace"> | null;
};

export const uploadUserFile = async ({
  file,
  recordAuditEvent,
  safeDb,
  threadId,
  userId,
  workspaceId,
}: UploadUserFileInput) =>
  await Result.gen(async function* () {
    // Enforce the MIME allowlist at the storage boundary, not only in
    // validateChatFileParts at message-send: user files are later served
    // inline (Content-Disposition without a filename), so a stored
    // text/html or image/svg+xml would render in the bucket origin. Any
    // caller reaching this function must be held to the same allowlist.
    if (!USER_FILE_ALLOWED_MIME_TYPES.has(file.mimeType)) {
      return Result.err(
        new HandlerError({
          status: 422,
          message: "Unsupported file type",
        }),
      );
    }

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

    // Best-effort image thumbnail + blur placeholder. A failure here never
    // blocks the upload: the original still serves; the row just carries no
    // derivative.
    let thumbnailFileId: string | null = null;
    let placeholder: string | null = null;
    let thumbnailKey: string | null = null;
    if (shouldGenerateImageThumbnail({ mimeType: file.mimeType })) {
      const thumbnailResult = await generateImageThumbnail(file.bytes);
      if (Result.isError(thumbnailResult)) {
        captureError(thumbnailResult.error, {
          stage: "chat-thumbnail-generate",
          userFileId: id,
        });
      } else {
        const generatedThumbnailId = Bun.randomUUIDv7();
        const key = createUserFileKey({
          fileId: generatedThumbnailId,
          mimeType: THUMBNAIL_MIME_TYPE,
          userId,
        });
        const writeThumbnailResult = await Result.tryPromise({
          try: async () => await getS3().write(key, thumbnailResult.value.webp),
          catch: (cause) => cause,
        });
        if (Result.isError(writeThumbnailResult)) {
          captureError(writeThumbnailResult.error, {
            stage: "chat-thumbnail-write",
            userFileId: id,
          });
        } else {
          thumbnailFileId = generatedThumbnailId;
          placeholder = thumbnailResult.value.placeholder;
          thumbnailKey = key;
        }
      }
    }

    const saveResult = await safeDb(async (tx) => {
      await tx.insert(userFiles).values({
        id,
        userId,
        fileName: sanitizedFileName,
        mimeType: file.mimeType,
        scanWarnings,
        s3Key,
        sha256Hex,
        sizeBytes: file.bytes.byteLength,
        threadId,
        thumbnailFileId,
        placeholder,
      });

      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.CREATE,
        resourceType: AUDIT_RESOURCE_TYPE.CHAT_FILE,
        resourceId: id,
        workspaceId,
        metadata: {
          threadId,
          fileName: sanitizedFileName,
          mimeType: file.mimeType,
          sizeBytes: file.bytes.byteLength,
          s3Key,
        },
      });
    });

    if (Result.isOk(saveResult)) {
      return Result.ok({
        id,
        mimeType: file.mimeType,
        fileName: sanitizedFileName,
        s3Key,
        thumbnailS3Key: thumbnailKey,
      });
    }

    const cleanupResult = await Result.tryPromise({
      try: async () => {
        await getS3().delete(s3Key);
        if (thumbnailKey) {
          await getS3().delete(thumbnailKey);
        }
      },
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
  part: ChatAttachmentPart;
};

export const normalizeUserFilePart = ({
  fileId,
  fileName,
  mimeType,
  part: _part,
}: NormalizeUserFilePartProps) => ({
  ...createChatAttachmentPart({
    filename: fileName,
    mimeType,
    url: toUserFileUrl(fileId),
  }),
});

type ParseMessageFileDataUrlProps = {
  part: ChatAttachmentPart;
};

const parseMessageFileDataUrl = ({ part }: ParseMessageFileDataUrlProps) => {
  const mimeType = getChatAttachmentMimeType(part);
  const parseResult = parseDataUrl({
    expectedMimeType: mimeType,
    maxBytes: CHAT_MAX_FILE_BYTES,
    url: getChatAttachmentUrl(part),
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
    fileName: sanitizeFilename(getChatAttachmentFilename(part) ?? "attachment"),
    mimeType: parseResult.value.mimeType,
  });
};
