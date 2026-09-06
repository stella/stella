import { panic, Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";

import {
  CHAT_SEND_MODE,
  CHAT_TRANSPORT_ERROR_CODE,
} from "@stll/anonymize-chat";
import type { ChatSendMode } from "@stll/anonymize-chat";
import { isChatFileMimeType } from "@stll/api-contract/chat-file-types";
import { docxToMarkdown } from "@stll/folio-core/server";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { chatThreads, userFiles } from "@/api/db/schema";
import {
  CHAT_MAX_FILE_BYTES,
  TEXT_CSV_MIME_TYPE,
  TEXT_MARKDOWN_MIME_TYPE,
  TEXT_PLAIN_MIME_TYPE,
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
import { captureError } from "@/api/lib/analytics/capture";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  BUFFER_INTENT_WRITE_TIMEOUT_MS,
  lockObjectCleanupIntentsForWriter,
  OBJECT_INTENT_WORKSPACE_AVAILABILITY,
  reserveObjectCleanupIntents,
  retirePublishedObjectCleanupIntentsInTransaction,
  settleObjectCleanupIntentsAfterWriter,
} from "@/api/lib/buffer-intent-reconciliation";
import {
  isDataUrlSizeLimitError,
  parseDataUrl,
  toDataUrl,
} from "@/api/lib/data-url";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { getScanWarnings, scanFile } from "@/api/lib/file-scan/scan";
import {
  generateImageThumbnail,
  shouldGenerateImageThumbnail,
  THUMBNAIL_MIME_TYPE,
} from "@/api/lib/files/image-derivative";
import { createUserFileKey, deleteS3Keys } from "@/api/lib/files/utils";
import { FILE_SIZE_LIMITS, LIMITS } from "@/api/lib/limits";
import {
  deleteS3ObjectWithSignal,
  putS3ObjectWithSignal,
  readS3ArrayBuffer,
} from "@/api/lib/s3";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { extractFileTextResult } from "@/api/lib/search/extract-content";
import { isUserFileUrl, toUserFileUrl } from "@/api/lib/user-files/types";
import { withTimeout } from "@/api/lib/with-timeout";
import { DOCX_MIME_TYPE, XLSX_MIME_TYPE } from "@/api/mime-types";

import type {
  ChatAttachmentPart,
  ChatMessage,
  ChatPart,
  PersistableChatMessage,
} from "./types";

const CHAT_ATTACHMENT_DELETE_TIMEOUT_MS = 10_000;

export type UserFileThreadAccess = {
  threadId: SafeId<"chatThread">;
  userId: SafeId<"user">;
};

type UploadMessageFilesProps = {
  dependencies?: UploadUserFileDependencies;
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
  dependencies,
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
      return await fail(parsedPart.error);
    }

    // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- an upload must land before the next; a failure rolls the earlier ones back
    const uploadedFile = await uploadUserFile({
      ...(dependencies === undefined ? {} : { dependencies }),
      file: parsedPart.value,
      recordAuditEvent,
      safeDb,
      threadId,
      userId,
      workspaceId,
    });
    if (Result.isError(uploadedFile)) {
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
  extractedText: string | null;
  fileName: string;
  mimeType: string;
  sendMode: ChatSendMode;
  s3Key: string;
};

export type HydratedFilePart =
  | {
      // A text-extractable attachment (docx/xlsx/txt/csv/md) hydrated to a `text`
      // content part, or any part that carries anonymizable text. Text is
      // universal across provider adapters, so this is never modality-gated.
      cache: { status: "unchanged" } | { status: "write"; text: string };
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

const DIRECT_TEXT_MIME_TYPES = [
  TEXT_CSV_MIME_TYPE,
  TEXT_MARKDOWN_MIME_TYPE,
  TEXT_PLAIN_MIME_TYPE,
] as const;

type DirectTextMimeType = (typeof DIRECT_TEXT_MIME_TYPES)[number];
type PlainTextHydratableMimeType =
  | DirectTextMimeType
  | typeof DOCX_MIME_TYPE
  | typeof XLSX_MIME_TYPE;

const isDirectTextMimeType = (
  mimeType: string,
): mimeType is DirectTextMimeType =>
  DIRECT_TEXT_MIME_TYPES.some(
    (directTextMimeType) => directTextMimeType === mimeType,
  );

const THIRD_PARTY_BOUNDARY_REFUSAL_MESSAGE =
  "Cannot send this attachment to the AI in anonymized mode because stella cannot extract and anonymize it safely.";

export const canHydrateFilePartAsPlainText = (
  mimeType: string,
): mimeType is PlainTextHydratableMimeType =>
  isDirectTextMimeType(mimeType) ||
  mimeType === DOCX_MIME_TYPE ||
  mimeType === XLSX_MIME_TYPE;

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
}): ChatAttachmentPart => {
  const metadata = { filename: fileName };

  if (mimeType.startsWith("image/")) {
    return {
      type: "image",
      source: {
        type: "url",
        value: toDataUrl(bytes, mimeType),
        mimeType,
      },
      metadata,
    };
  }
  return {
    type: "document",
    source: {
      type: "data",
      value: Buffer.from(bytes).toString("base64"),
      mimeType,
    },
    metadata,
  };
};

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

const extractXlsxAttachmentText = async (buffer: ArrayBuffer) =>
  (await extractFileTextResult(buffer, XLSX_MIME_TYPE)).map((extracted) => {
    const text = extracted?.trim();
    return text ? text.slice(0, LIMITS.chatContextFileMaxChars) : null;
  });

export const hydrateFilePart = async ({
  extractedText,
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

    if (mimeType !== XLSX_MIME_TYPE && extractedText !== null) {
      return panic(
        "Only XLSX chat attachments may carry cached extracted text",
      );
    }

    if (mimeType === XLSX_MIME_TYPE && extractedText !== null) {
      const text = extractedText.trim();
      if (!text) {
        return panic("Cached XLSX chat attachment text must not be empty");
      }

      return Result.ok<HydratedFilePart>({
        cache: { status: "unchanged" },
        part: createChatTextPart(attachmentText({ fileName, content: text })),
        type: "anonymizable",
      });
    }

    const buffer = yield* Result.await(
      Result.tryPromise({
        try: async () => await readS3ArrayBuffer(s3Key),
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
    // no adapter ingests raw docx/xlsx/csv/md. Only genuine binary formats (image,
    // PDF) are sent raw, in the fallthrough below. Ordering is load-bearing —
    // a rawOverride short-circuit placed before these branches (the previous
    // shape) made the extraction dead code whenever anonymization was off (the
    // default), shipping raw docx that every adapter rejects. The persisted
    // `userfile://` reference part (see `uploadMessageFiles`) still renders the
    // attachment chip; only the provider-bound copy becomes text.
    if (isDirectTextMimeType(mimeType)) {
      return Result.ok<HydratedFilePart>({
        cache: { status: "unchanged" },
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
        cache: { status: "unchanged" },
        part: createChatTextPart(attachmentText({ fileName, content: text })),
        type: "anonymizable",
      });
    }

    if (mimeType === XLSX_MIME_TYPE) {
      const extracted = yield* Result.await(
        extractXlsxAttachmentText(buffer).then((result) =>
          Result.mapError(
            result,
            (cause) =>
              new ChatError({
                message: "Failed to extract text from chat XLSX attachment",
                cause,
              }),
          ),
        ),
      );
      const text = extracted?.trim();
      if (!text) {
        if (requiresPlainText) {
          return Result.ok<HydratedFilePart>(createBlockedHydratedFilePart());
        }
        return Result.err(
          new HandlerError({
            status: 422,
            message: "Chat XLSX attachment did not contain extractable text",
          }),
        );
      }

      return Result.ok<HydratedFilePart>({
        cache: { status: "write", text },
        part: createChatTextPart(
          attachmentText({
            fileName,
            content: text,
          }),
        ),
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

type ReserveChatObjectCleanupIntent = (options: {
  objectKey: string;
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
}) => Promise<
  Result<SafeId<"pendingUpload">[], SafeDbError | HandlerError<400>>
>;

type UploadUserFileDependencies = {
  generateImageThumbnail?: typeof generateImageThumbnail;
  putS3ObjectWithSignal?: typeof putS3ObjectWithSignal;
  reserveChatObjectCleanupIntent?: ReserveChatObjectCleanupIntent;
  settleObjectCleanupIntentsAfterWriter?: typeof settleObjectCleanupIntentsAfterWriter;
};

export const chatObjectCleanupWorkspaceIds = ({
  dataWorkspaceIds,
  workspaceId,
}: {
  dataWorkspaceIds: SafeId<"workspace">[];
  workspaceId: SafeId<"workspace"> | null;
}): SafeId<"workspace">[] =>
  [
    ...new Set(
      [workspaceId, ...dataWorkspaceIds].filter(
        (candidate): candidate is SafeId<"workspace"> => candidate !== null,
      ),
    ),
  ].sort();

const reserveChatObjectCleanupIntent: ReserveChatObjectCleanupIntent = async (
  options,
) => {
  const { objectKey, safeDb, threadId } = options;
  const threadScopeResult = await safeDb(
    async (tx) =>
      await tx
        .select({
          dataWorkspaceIds: chatThreads.dataWorkspaceIds,
          organizationId: chatThreads.organizationId,
          workspaceId: chatThreads.workspaceId,
        })
        .from(chatThreads)
        .where(eq(chatThreads.id, threadId))
        .limit(1)
        .then((rows) => rows.at(0) ?? null),
  );
  if (Result.isError(threadScopeResult)) {
    return Result.err(threadScopeResult.error);
  }
  if (threadScopeResult.value === null) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Chat thread no longer exists",
      }),
    );
  }
  const cleanupWorkspaceIds = chatObjectCleanupWorkspaceIds(
    threadScopeResult.value,
  );
  return await reserveObjectCleanupIntents({
    chatThreadId: threadId,
    objectKey,
    organizationId: threadScopeResult.value.organizationId,
    safeDb,
    workspaceAvailability: OBJECT_INTENT_WORKSPACE_AVAILABILITY.NOT_DELETING,
    workspaceIds: cleanupWorkspaceIds,
  });
};

type UploadUserFileInput = {
  dependencies?: UploadUserFileDependencies;
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
  dependencies,
  file,
  recordAuditEvent,
  safeDb,
  threadId,
  userId,
  workspaceId,
}: UploadUserFileInput) =>
  await Result.gen(async function* () {
    const reserveCleanupIntent =
      dependencies?.reserveChatObjectCleanupIntent ??
      reserveChatObjectCleanupIntent;
    const settleCleanupIntents =
      dependencies?.settleObjectCleanupIntentsAfterWriter ??
      settleObjectCleanupIntentsAfterWriter;
    const generateThumbnail =
      dependencies?.generateImageThumbnail ?? generateImageThumbnail;
    const putS3Object =
      dependencies?.putS3ObjectWithSignal ?? putS3ObjectWithSignal;
    // Enforce the MIME allowlist at the storage boundary, not only in
    // validateChatFileParts at message-send: user files are later served
    // inline (Content-Disposition without a filename), so a stored
    // text/html or image/svg+xml would render in the bucket origin. Any
    // caller reaching this function must be held to the same allowlist.
    if (!isChatFileMimeType(file.mimeType)) {
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

    const extractedText =
      file.mimeType === XLSX_MIME_TYPE
        ? yield* Result.await(
            extractXlsxAttachmentText(new Uint8Array(file.bytes).buffer).then(
              (result) =>
                Result.mapError(
                  result,
                  (cause) =>
                    new HandlerError({
                      status: 500,
                      message:
                        "Failed to extract text from chat XLSX attachment",
                      cause,
                    }),
                ),
            ),
          )
        : null;
    if (file.mimeType === XLSX_MIME_TYPE && extractedText === null) {
      return Result.err(
        new HandlerError({
          status: 422,
          message: "Chat XLSX attachment did not contain extractable text",
        }),
      );
    }

    // Best-effort image thumbnail + blur placeholder. A failure here never
    // blocks the upload: the original still serves; the row just carries no
    // derivative.
    let preparedThumbnail: {
      bytes: Uint8Array;
      fileId: string;
      key: string;
      placeholder: string;
    } | null = null;
    if (shouldGenerateImageThumbnail({ mimeType: file.mimeType })) {
      const thumbnailResult = await generateThumbnail(file.bytes);
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
        preparedThumbnail = {
          bytes: thumbnailResult.value.webp,
          fileId: generatedThumbnailId,
          key,
          placeholder: thumbnailResult.value.placeholder,
        };
      }
    }

    const cleanupIntentIds: SafeId<"pendingUpload">[] = [];
    const cleanupIntent = await reserveCleanupIntent({
      objectKey: s3Key,
      safeDb,
      threadId,
    });
    if (Result.isError(cleanupIntent)) {
      return Result.err(cleanupIntent.error);
    }
    const sourceCleanupIntentIds = cleanupIntent.value;
    cleanupIntentIds.push(...sourceCleanupIntentIds);

    let thumbnailCleanupIntentIds: SafeId<"pendingUpload">[] = [];
    if (preparedThumbnail !== null) {
      const thumbnailCleanupIntent = await reserveCleanupIntent({
        objectKey: preparedThumbnail.key,
        safeDb,
        threadId,
      });
      if (Result.isError(thumbnailCleanupIntent)) {
        captureError(thumbnailCleanupIntent.error, {
          stage: "chat-thumbnail-cleanup-reserve",
          userFileId: id,
        });
        preparedThumbnail = null;
      } else {
        thumbnailCleanupIntentIds = thumbnailCleanupIntent.value;
        cleanupIntentIds.push(...thumbnailCleanupIntent.value);
      }
    }

    let thumbnailFileId: string | null = null;
    let placeholder: string | null = null;
    let thumbnailKey: string | null = null;
    const writeSourceResult = await Result.tryPromise({
      try: async () =>
        await withTimeout(
          async (signal) =>
            await putS3Object(s3Key, file.bytes, file.mimeType, signal),
          {
            label: "chat-attachment-put",
            timeoutMs: BUFFER_INTENT_WRITE_TIMEOUT_MS,
          },
        ),
      catch: (cause) => cause,
    });
    if (Result.isError(writeSourceResult)) {
      const cleanupResult = await Result.tryPromise({
        try: async () =>
          await deleteS3ObjectWithSignal(
            s3Key,
            AbortSignal.timeout(CHAT_ATTACHMENT_DELETE_TIMEOUT_MS),
          ),
        catch: (cause) => cause,
      });
      if (Result.isError(cleanupResult)) {
        captureError(cleanupResult.error, {
          s3Key,
          stage: "chat-attachment-write-cleanup",
          userFileId: id,
        });
      }
      const sourceSettlement = await settleCleanupIntents({
        intentIds: sourceCleanupIntentIds,
        objectState: "write-uncertain",
        safeDb,
      });
      if (Result.isError(sourceSettlement)) {
        captureError(sourceSettlement.error, {
          s3Key,
          stage: "chat-attachment-write-settle",
          userFileId: id,
        });
      }
      const thumbnailSettlement = await settleCleanupIntents({
        intentIds: thumbnailCleanupIntentIds,
        objectState: "object-deleted",
        safeDb,
      });
      if (Result.isError(thumbnailSettlement)) {
        captureError(thumbnailSettlement.error, {
          stage: "chat-thumbnail-unwritten-settle",
          userFileId: id,
        });
      }
      return Result.err(
        new HandlerError({
          status: 500,
          message: "Failed to store chat attachment",
          cause: writeSourceResult.error,
        }),
      );
    }

    if (preparedThumbnail !== null) {
      const writeThumbnailResult = await Result.tryPromise({
        try: async () =>
          await withTimeout(
            async (signal) =>
              await putS3Object(
                preparedThumbnail.key,
                preparedThumbnail.bytes,
                THUMBNAIL_MIME_TYPE,
                signal,
              ),
            {
              label: "chat-thumbnail-put",
              timeoutMs: BUFFER_INTENT_WRITE_TIMEOUT_MS,
            },
          ),
        catch: (cause) => cause,
      });
      if (Result.isError(writeThumbnailResult)) {
        captureError(writeThumbnailResult.error, {
          stage: "chat-thumbnail-write",
          userFileId: id,
        });
        const cleanupResult = await Result.tryPromise({
          try: async () =>
            await deleteS3ObjectWithSignal(
              preparedThumbnail.key,
              AbortSignal.timeout(CHAT_ATTACHMENT_DELETE_TIMEOUT_MS),
            ),
          catch: (cause) => cause,
        });
        if (Result.isError(cleanupResult)) {
          captureError(cleanupResult.error, {
            stage: "chat-thumbnail-write-cleanup",
            userFileId: id,
          });
        }
        const settlement = await settleCleanupIntents({
          intentIds: thumbnailCleanupIntentIds,
          objectState: "write-uncertain",
          safeDb,
        });
        if (Result.isError(settlement)) {
          const sourceCleanup = await Result.tryPromise({
            try: async () =>
              await deleteS3ObjectWithSignal(
                s3Key,
                AbortSignal.timeout(CHAT_ATTACHMENT_DELETE_TIMEOUT_MS),
              ),
            catch: (cause) => cause,
          });
          const sourceSettlement = await settleCleanupIntents({
            intentIds: sourceCleanupIntentIds,
            objectState: Result.isOk(sourceCleanup)
              ? "object-deleted"
              : "cleanup-required",
            safeDb,
          });
          if (Result.isError(sourceCleanup)) {
            captureError(sourceCleanup.error, {
              s3Key,
              stage: "chat-attachment-thumbnail-settle-cleanup",
              userFileId: id,
            });
          }
          if (Result.isError(sourceSettlement)) {
            captureError(sourceSettlement.error, {
              s3Key,
              stage: "chat-attachment-thumbnail-settle",
              userFileId: id,
            });
          }
          return Result.err(settlement.error);
        }
        const settledThumbnailIds = new Set(thumbnailCleanupIntentIds);
        cleanupIntentIds.splice(
          0,
          cleanupIntentIds.length,
          ...cleanupIntentIds.filter(
            (intentId) => !settledThumbnailIds.has(intentId),
          ),
        );
        thumbnailCleanupIntentIds = [];
      } else {
        thumbnailFileId = preparedThumbnail.fileId;
        placeholder = preparedThumbnail.placeholder;
        thumbnailKey = preparedThumbnail.key;
      }
    }

    const saveResult = await safeDb(async (tx) => {
      await lockObjectCleanupIntentsForWriter(tx, cleanupIntentIds);

      await tx.insert(userFiles).values({
        id,
        userId,
        extractedText,
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

      const publishedIntentIds = cleanupIntentIds.filter(
        (intentId) =>
          !thumbnailCleanupIntentIds.includes(intentId) ||
          thumbnailKey !== null,
      );
      if (publishedIntentIds.length > 0) {
        // The row now owns the objects. Retire crash-recovery ownership in the
        // same transaction so a save rollback leaves the tombstones durable.
        // audit: skip; storage recovery bookkeeping for the CREATE below.
        await retirePublishedObjectCleanupIntentsInTransaction({
          intentIds: publishedIntentIds,
          tx,
        });
      }

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

    const sourceCleanupResult = await Result.tryPromise({
      try: async () =>
        await deleteS3ObjectWithSignal(
          s3Key,
          AbortSignal.timeout(CHAT_ATTACHMENT_DELETE_TIMEOUT_MS),
        ),
      catch: (cause) => cause,
    });
    const sourceSettlement = await settleCleanupIntents({
      intentIds: sourceCleanupIntentIds,
      objectState: Result.isOk(sourceCleanupResult)
        ? "object-deleted"
        : "cleanup-required",
      safeDb,
    });
    const thumbnailCleanupResult =
      thumbnailKey === null
        ? Result.ok(undefined)
        : await Result.tryPromise({
            try: async () =>
              await deleteS3ObjectWithSignal(
                thumbnailKey,
                AbortSignal.timeout(CHAT_ATTACHMENT_DELETE_TIMEOUT_MS),
              ),
            catch: (cause) => cause,
          });
    const thumbnailSettlement = await settleCleanupIntents({
      intentIds: thumbnailCleanupIntentIds,
      objectState: Result.isOk(thumbnailCleanupResult)
        ? "object-deleted"
        : "cleanup-required",
      safeDb,
    });

    if (
      Result.isOk(sourceCleanupResult) &&
      Result.isOk(thumbnailCleanupResult) &&
      Result.isOk(sourceSettlement) &&
      Result.isOk(thumbnailSettlement)
    ) {
      return Result.err(saveResult.error);
    }

    captureError(saveResult.error, { s3Key, threadId, userFileId: id });
    let cleanupError: unknown = saveResult.error;
    if (Result.isError(sourceCleanupResult)) {
      cleanupError = sourceCleanupResult.error;
    } else if (Result.isError(thumbnailCleanupResult)) {
      cleanupError = thumbnailCleanupResult.error;
    } else if (Result.isError(sourceSettlement)) {
      cleanupError = sourceSettlement.error;
    } else if (Result.isError(thumbnailSettlement)) {
      cleanupError = thumbnailSettlement.error;
    }
    return Result.err(
      new HandlerError({
        status: 500,
        message: "Failed to clean up chat attachment after a save failure",
        cause: cleanupError,
      }),
    );
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
