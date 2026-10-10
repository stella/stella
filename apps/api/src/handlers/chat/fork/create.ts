import { panic, Result, TaggedError } from "better-result";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { t } from "elysia";

import { chunk as chunkItems } from "@stll/concurrency/chunk";

import type { Transaction } from "@/api/db/root";
import { defaultDatabaseRetry } from "@/api/db/safe-db";
import { chatMessages, chatThreads, userFiles } from "@/api/db/schema";
import {
  attachTerminalTurnOutcome,
  cancelPendingChatToolCalls,
  createChatAttachmentPart,
  getAwaitingUserInteractions,
  getChatAttachmentFilename,
  getChatAttachmentMimeType,
  getChatAttachmentPlaceholder,
  getChatAttachmentUrl,
  isChatAttachmentPart,
  chatMessageFromPersisted,
  toPersistableChatMessage,
  toPersistedChatMessageContentV3,
} from "@/api/handlers/chat/chat-message-parts";
import { resolveChatScope } from "@/api/handlers/chat/chat-scope";
import { settleOpenToolCallsForOutcome } from "@/api/handlers/chat/chat-turn-settlement";
import type { ChatMessagePrefixRow } from "@/api/handlers/chat/history-window";
import { loadChatMessagePrefixOnTx } from "@/api/handlers/chat/history-window";
import type {
  ChatPart,
  PersistableChatMessage,
} from "@/api/handlers/chat/types";
import { captureError } from "@/api/lib/analytics/capture";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { consumeInBatches } from "@/api/lib/destructive-effect-chunks";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { FileKey } from "@/api/lib/file-key";
import { copyOrganizationFiles } from "@/api/lib/files/copy-organization-files";
import { deleteOrganizationFilesWithSignal } from "@/api/lib/files/delete-organization-file";
import { THUMBNAIL_MIME_TYPE } from "@/api/lib/files/image-derivative";
import { OrganizationFileUsageError } from "@/api/lib/files/organization-file-usage";
import { createUserFileKey } from "@/api/lib/files/utils";
import { isMissingS3ObjectError } from "@/api/lib/s3";
import type { S3PresignError } from "@/api/lib/s3-presign";
import { copyObject, headObject } from "@/api/lib/s3-presign";
import { upsertChatThreadSearchDocument } from "@/api/lib/search/index-chat";
import { parseUserFileId, toUserFileUrl } from "@/api/lib/user-files/types";

const config = {
  contentDelivery: {
    type: "none",
    reason:
      "Copies thread attachments and returns thread metadata rather than stored-file bytes.",
  },
  description:
    "Fork one of your own chat threads into a new thread that keeps the " +
    "history up to a chosen answer, so another direction or model can be " +
    "explored without touching the original. The boundary must be an " +
    "assistant message: a fork branches off an answer, not off an ask. " +
    "The new thread id is minted by " +
    "the caller, which makes a retried fork return the existing copy instead " +
    "of duplicating it. Attachments are duplicated, never shared: deleting " +
    "either thread leaves the other's files intact. The fork records where " +
    "it came from and starts with no compaction state of its own.",
  permissions: { chat: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "write",
  mcp: {
    type: "capability",
    reason: "assistant_chat",
    consumesServices: false,
  },
  params: t.Object({ threadId: tSafeId("chatThread") }),
  query: t.Object({
    workspaceId: t.Optional(tSafeId("workspace")),
  }),
  body: t.Object({
    newThreadId: tSafeId("chatThread"),
    upToMessageId: tSafeId("chatMessage"),
  }),
} satisfies HandlerConfig;

/**
 * Settings a fork inherits verbatim from its source thread.
 */
const FORKED_THREAD_COLUMNS = {
  chatModel: chatThreads.chatModel,
  chatReasoningEffort: chatThreads.chatReasoningEffort,
  contextMatterIds: chatThreads.contextMatterIds,
  dataWorkspaceIds: chatThreads.dataWorkspaceIds,
  title: chatThreads.title,
  titleSource: chatThreads.titleSource,
  usedAnonymization: chatThreads.usedAnonymization,
  webSearchEnabled: chatThreads.webSearchEnabled,
  workspaceId: chatThreads.workspaceId,
} as const;

/**
 * Rows per INSERT for the copied history and attachments. A prefix has no
 * upper bound (nothing caps a thread's length), and one statement cannot
 * carry more than 65,535 bind parameters.
 */
const FORK_INSERT_BATCH_SIZE = 200;

/**
 * Attachment copies in flight at once. A prefix has no upper bound and each
 * attachment costs up to two CopyObject calls (object plus thumbnail), so an
 * unbounded fan-out on a long thread is one burst against storage that a
 * single throttled request can fail after every other copy was paid for.
 */
const FORK_COPY_CONCURRENCY = 16;

/** The columns a fork's copy of one attachment is rebuilt from. */
type SourceUserFileRow = {
  extractedText: string | null;
  fileName: string;
  id: SafeId<"userFile">;
  mimeType: string;
  placeholder: string | null;
  s3Key: FileKey;
  scanWarnings: string[] | null;
  sha256Hex: string;
  sizeBytes: number;
  thumbnailFileId: string | null;
};

type UserFileCopy = {
  copiedS3Key: FileKey;
  copiedThumbnailFileId: string | null;
  newFileId: SafeId<"userFile">;
  source: SourceUserFileRow;
};

/** A prefix row beside its decoded message, so each row is decoded once. */
type PrefixMessage = {
  message: PersistableChatMessage;
  row: ChatMessagePrefixRow;
};

/**
 * Every `stella://file::<id>` a copied prefix points at, in insertion order.
 * A message may repeat an attachment and several messages may share one, so
 * the set is what drives the copy, not the parts.
 */
const collectPrefixUserFileIds = (
  prefix: readonly PrefixMessage[],
): SafeId<"userFile">[] => {
  const fileIds = new Set<SafeId<"userFile">>();
  for (const { message } of prefix) {
    for (const part of message.parts) {
      if (!isChatAttachmentPart(part)) {
        continue;
      }
      const fileId = parseUserFileId(getChatAttachmentUrl(part));
      if (fileId !== null) {
        fileIds.add(fileId);
      }
    }
  }
  return [...fileIds];
};

/**
 * Point one attachment part at the fork's own copy of its file.
 *
 * A part whose file was not copied is left untouched: either its id resolved
 * to no `user_files` row, so the source's own URL already dangles, or the row
 * exists but its storage object is gone, so there are no bytes to share. In
 * both cases the fork inherits a dead reference rather than a live shared
 * object. Each miss is reported as telemetry by the caller.
 */
const remapChatAttachmentPart = (
  part: ChatPart,
  copiedFileIds: ReadonlyMap<SafeId<"userFile">, SafeId<"userFile">>,
): ChatPart => {
  if (!isChatAttachmentPart(part)) {
    return part;
  }
  const sourceFileId = parseUserFileId(getChatAttachmentUrl(part));
  const copiedFileId =
    sourceFileId === null ? undefined : copiedFileIds.get(sourceFileId);
  if (copiedFileId === undefined) {
    return part;
  }
  const filename = getChatAttachmentFilename(part);
  const placeholder = getChatAttachmentPlaceholder(part);
  return createChatAttachmentPart({
    mimeType: getChatAttachmentMimeType(part),
    url: toUserFileUrl(copiedFileId),
    ...(filename === undefined ? {} : { filename }),
    ...(placeholder === undefined ? {} : { placeholder }),
  });
};

/**
 * Settle every interaction the copied message still awaits. A fork copies
 * history, not turn ownership: the source's `awaiting-user` chat turn stays
 * with the source, so an approval or client-tool call copied verbatim would
 * render as answerable on a thread with no turn able to own its answer. The
 * copy takes the same terminal shape a superseded pending turn gets
 * (`cancelPendingChatToolCalls` plus a `superseded` outcome), so it reads as
 * history and the continuation check rejects it like any settled call.
 */
const settleForkedPendingInteractions = (
  message: PersistableChatMessage,
): PersistableChatMessage => {
  // An approved call without its result may already have run in the source
  // thread; the fork gets its outcome as unknown, never the approval.
  const settled = toPersistableChatMessage({
    ...message,
    parts: settleOpenToolCallsForOutcome({
      outcome: "cancelled",
      parts: message.parts,
    }),
  });
  // A pre-outcome message carries no `turnOutcome` and can still hold an
  // unanswered call, so the parts decide too. A message that awaited the user
  // is superseded on the fork even when settling left nothing to answer.
  const pending = getAwaitingUserInteractions({
    parts: settled.parts,
    role: settled.role,
  });
  if (
    pending.length === 0 &&
    settled.metadata?.turnOutcome?.type !== "awaiting-user"
  ) {
    return settled;
  }
  return attachTerminalTurnOutcome({
    message: cancelPendingChatToolCalls(settled),
    turnOutcome: { reason: "superseded", type: "cancelled" },
  });
};

/**
 * What copying one attachment's storage produced. A source object the store
 * confirms is gone is not a failure of the fork: the source thread already
 * lacks those bytes, so the fork skips the file (or, for a thumbnail alone,
 * copies the file without one) and the caller reports the gap. Every other
 * storage error is fatal, because it says nothing about the object.
 */
type UserFileCopyOutcome =
  | { kind: "copied"; copy: UserFileCopy; missingThumbnail: boolean }
  | { kind: "source-object-missing"; fileId: SafeId<"userFile"> };

const stageUserFileCopies = (
  files: SourceUserFileRow[],
  userId: SafeId<"user">,
) =>
  files.map((file) => {
    const newFileId = createSafeId<"userFile">();
    const copiedThumbnailFileId =
      file.thumbnailFileId === null ? null : Bun.randomUUIDv7();
    return {
      source: file,
      newFileId,
      copiedS3Key: createUserFileKey({
        fileId: newFileId,
        mimeType: file.mimeType,
        userId,
      }),
      copiedThumbnailFileId,
      thumbnailKey:
        copiedThumbnailFileId === null
          ? null
          : createUserFileKey({
              fileId: copiedThumbnailFileId,
              mimeType: THUMBNAIL_MIME_TYPE,
              userId,
            }),
    };
  });

const prepareUserFileCopy = async (
  copy: ReturnType<typeof stageUserFileCopies>[number],
) => {
  const mainHead = isDeploymentFeatureEnabled("FEATURE_FILE_USAGE_LIMITS")
    ? await headObject(copy.source.s3Key)
    : undefined;
  if (mainHead !== undefined && Result.isError(mainHead)) {
    if (isMissingS3ObjectError(mainHead.error.cause)) {
      return Result.ok({
        status: "source-missing" as const,
        fileId: copy.source.id,
      });
    }
    return Result.err(
      new HandlerError({
        status: 500,
        message: "Failed to inspect chat attachment storage object",
        cause: mainHead.error,
      }),
    );
  }
  return Result.ok({ status: "ready" as const, ...copy });
};

const prepareUserFileThumbnail = async (
  copy: ReturnType<typeof stageUserFileCopies>[number],
  userId: SafeId<"user">,
) => {
  const thumbnailSource =
    copy.source.thumbnailFileId === null
      ? null
      : createUserFileKey({
          fileId: copy.source.thumbnailFileId,
          mimeType: THUMBNAIL_MIME_TYPE,
          userId,
        });
  const thumbnailHead =
    thumbnailSource !== null &&
    isDeploymentFeatureEnabled("FEATURE_FILE_USAGE_LIMITS")
      ? await headObject(thumbnailSource)
      : undefined;
  return { ...copy, thumbnailSource, thumbnailHead };
};

const copyUserFiles = async ({
  copiedS3Keys,
  files,
  fileUsageDb,
  organizationId,
  userId,
}: {
  copiedS3Keys: string[];
  files: SourceUserFileRow[];
  fileUsageDb?: Parameters<typeof copyOrganizationFiles>[0]["db"];
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
}): Promise<Result<UserFileCopyOutcome[], HandlerError<409 | 500 | 503>>> => {
  const staged = stageUserFileCopies(files, userId);
  const prepared: Awaited<ReturnType<typeof prepareUserFileCopy>>[] = [];
  for (const itemBatch of chunkItems(staged, FORK_COPY_CONCURRENCY)) {
    prepared.push(
      ...(await Promise.all(
        itemBatch.map(async (copy) => await prepareUserFileCopy(copy)),
      )),
    );
  }
  const ready = Result.all(prepared);
  if (Result.isError(ready)) {
    return Result.err(ready.error);
  }
  const available = ready.value.filter((copy) => copy.status === "ready");
  const mainObjects = available.map((copy) => ({
    sourceKey: copy.source.s3Key,
    destinationKey: copy.copiedS3Key,
    sizeBytes: copy.source.sizeBytes,
  }));
  const copyObjects = async (objects: typeof mainObjects) => {
    const inputs = objects.map(({ sourceKey, destinationKey, sizeBytes }) => {
      copiedS3Keys.push(destinationKey);
      return {
        organizationId,
        objectKey: destinationKey,
        sizeBytes,
        copy: async () => {
          const copied = await copyObject(sourceKey, destinationKey);
          return Result.isError(copied)
            ? Result.err(copied.error)
            : Result.ok(destinationKey);
        },
        confirmedDestinationAbsentOnCopyError: (error: S3PresignError) =>
          isMissingS3ObjectError(error.cause),
      };
    });
    const copied = await copyOrganizationFiles({
      inputs,
      concurrency: FORK_COPY_CONCURRENCY,
      db: fileUsageDb,
    });
    return copied.map(
      (results) =>
        new Map(
          inputs.map((input, index) => {
            const result = results.at(index);
            if (!result) {
              panic("Chat attachment copy must have a storage result");
            }
            return [input.objectKey, result] as const;
          }),
        ),
    );
  };
  const copyFailure = (error: S3PresignError | OrganizationFileUsageError) =>
    error instanceof OrganizationFileUsageError
      ? error
      : new HandlerError({
          status: 500,
          message: "Failed to copy chat attachment storage object",
          cause: error.cause,
        });
  // A confirmed-missing main is a skipped attachment. Its thumbnail must not
  // open a reservation or stop later rounds with an otherwise ignored error.
  const mains = await copyObjects(mainObjects);
  if (Result.isError(mains)) {
    return Result.err(mains.error);
  }
  const outcomes: UserFileCopyOutcome[] = ready.value.flatMap((copy) =>
    copy.status === "source-missing"
      ? [{ kind: "source-object-missing" as const, fileId: copy.fileId }]
      : [],
  );
  const successful: ReturnType<typeof stageUserFileCopies> = [];
  for (const copy of available) {
    const main = mains.value.get(copy.copiedS3Key);
    if (!main) {
      panic("Chat attachment copy must have a main storage result");
    }
    if (Result.isError(main)) {
      if (
        !(main.error instanceof OrganizationFileUsageError) &&
        isMissingS3ObjectError(main.error.cause)
      ) {
        outcomes.push({
          kind: "source-object-missing",
          fileId: copy.source.id,
        });
        continue;
      }
      return Result.err(copyFailure(main.error));
    }
    successful.push(copy);
  }
  const inspected: Awaited<ReturnType<typeof prepareUserFileThumbnail>>[] = [];
  for (const itemBatch of chunkItems(successful, FORK_COPY_CONCURRENCY)) {
    inspected.push(
      ...(await Promise.all(
        itemBatch.map(
          async (copy) => await prepareUserFileThumbnail(copy, userId),
        ),
      )),
    );
  }
  const thumbnailObjects: typeof mainObjects = [];
  const missingThumbnails = new Set<string>();
  for (const copy of inspected) {
    if (copy.thumbnailSource === null || copy.thumbnailKey === null) {
      continue;
    }
    const head = copy.thumbnailHead;
    if (head !== undefined && Result.isError(head)) {
      if (!isMissingS3ObjectError(head.error.cause)) {
        return Result.err(copyFailure(head.error));
      }
      missingThumbnails.add(copy.thumbnailKey);
      continue;
    }
    thumbnailObjects.push({
      sourceKey: copy.thumbnailSource,
      destinationKey: copy.thumbnailKey,
      sizeBytes:
        head === undefined ? copy.source.sizeBytes : head.value.contentLength,
    });
  }
  const thumbnails = await copyObjects(thumbnailObjects);
  if (Result.isError(thumbnails)) {
    return Result.err(thumbnails.error);
  }
  for (const copy of inspected) {
    const thumbnail =
      copy.thumbnailKey === null
        ? undefined
        : thumbnails.value.get(copy.thumbnailKey);
    if (thumbnail !== undefined && Result.isError(thumbnail)) {
      if (
        thumbnail.error instanceof OrganizationFileUsageError ||
        !isMissingS3ObjectError(thumbnail.error.cause)
      ) {
        return Result.err(copyFailure(thumbnail.error));
      }
      if (copy.thumbnailKey !== null) {
        missingThumbnails.add(copy.thumbnailKey);
      }
    }
    const missingThumbnail =
      copy.thumbnailKey !== null && missingThumbnails.has(copy.thumbnailKey);
    outcomes.push({
      kind: "copied",
      copy: {
        copiedS3Key: copy.copiedS3Key,
        copiedThumbnailFileId: missingThumbnail
          ? null
          : copy.copiedThumbnailFileId,
        newFileId: copy.newFileId,
        source: copy.source,
      },
      missingThumbnail,
    });
  }
  return Result.ok(outcomes);
};

/**
 * A copied message references a `stella://file::<id>` with no `user_files` row.
 * Not fatal: the reference already dangles in the source thread, so the fork is
 * no worse. Reported because the alternative cause — an attachment row that is
 * not owned by the thread that references it — breaks the storage-ownership
 * model the fork's duplication relies on.
 */
class ChatForkAttachmentRowMissingError extends TaggedError(
  "ChatForkAttachmentRowMissingError",
)<{ message: string }> {}

/**
 * A `user_files` row of the copied prefix points at a storage object (or a
 * thumbnail) the store no longer holds. Not fatal for the same reason as a
 * missing row, but reported: a live row without its object means a delete
 * removed the bytes and never reached the row.
 */
class ChatForkAttachmentObjectMissingError extends TaggedError(
  "ChatForkAttachmentObjectMissingError",
)<{ message: string }> {}

/**
 * Delete storage objects a failed fork already created. Rollback failures are
 * captured, never thrown: they must not mask the error that triggered them,
 * and the worst outcome they leave is an unreferenced object.
 */
const rollbackCopiedS3Keys = async (
  copiedS3Keys: string[],
  fileUsageDb: Parameters<typeof copyOrganizationFiles>[0]["db"],
): Promise<void> => {
  if (copiedS3Keys.length === 0) {
    return;
  }
  const deleted = await Result.tryPromise({
    try: async () =>
      await deleteOrganizationFilesWithSignal(
        copiedS3Keys,
        AbortSignal.timeout(10_000),
        fileUsageDb === undefined ? {} : { fileUsageDb },
      ),
    catch: (cause) =>
      new HandlerError({
        status: 500,
        message: "Failed to roll back chat attachment copies",
        cause,
      }),
  });
  const completed = Result.flatten(deleted);
  if (Result.isError(completed)) {
    captureError(completed.error, { source: "chat-fork-rollback" });
  }
};

// Forks a chat thread at one of its assistant messages. The prefix, its
// attachments and the thread's settings are copied; turns, compaction state
// and the file / template thread mappings are not, so interactions the prefix
// still awaits are settled in the copy. The fork's id comes from
// the caller, so a retry converges on one copy instead of duplicating it.
export const createForkThread = ({
  fileUsageDb,
  indexChatThread = upsertChatThreadSearchDocument,
}: {
  fileUsageDb?: Parameters<typeof copyOrganizationFiles>[0]["db"];
  /** Search-index write, which runs on the root database; supplied by the
   *  focused integration test, whose fixture only stands up a scoped one. */
  indexChatThread?: typeof upsertChatThreadSearchDocument | undefined;
} = {}) =>
  createSafeRootHandler(
    config,
    async function* ({
      getWorkspaceAccess,
      body: { newThreadId, upToMessageId },
      query: { workspaceId },
      params,
      recordAuditEvent,
      safeDb,
      session,
      user,
    }) {
      if (newThreadId === params.threadId) {
        yield* Result.err(
          new HandlerError({
            status: 400,
            message: "A chat thread cannot be forked onto itself",
          }),
        );
      }

      const scope = yield* resolveChatScope({
        getWorkspaceAccess,
        workspaceId,
      });

      /**
       * A `newThreadId` that already exists is either this same request retried
       * (return it, the copy is already durable) or a collision with an
       * unrelated thread (409). Checked before any storage copy so an ordinary
       * retry costs nothing.
       */
      const readExistingFork = async (tx: Transaction) =>
        await tx
          .select({
            forkedFromMessageId: chatThreads.forkedFromMessageId,
            id: chatThreads.id,
            parentThreadId: chatThreads.parentThreadId,
            title: chatThreads.title,
          })
          .from(chatThreads)
          .where(
            and(
              eq(chatThreads.id, newThreadId),
              eq(chatThreads.organizationId, session.activeOrganizationId),
              eq(chatThreads.userId, user.id),
            ),
          )
          .limit(1);

      /**
       * A retried request and the durable fork it created agree on (owner, id,
       * boundary message, source-while-linked). `parentThreadId` goes null when
       * the source thread is deleted, so a null parent still matches — the
       * boundary message alone then carries the identity — while a live parent
       * must be the thread this request names, so a request naming the wrong
       * source cannot adopt an unrelated fork as its own.
       */
      const matchesForkIdentity = (fork: {
        forkedFromMessageId: SafeId<"chatMessage"> | null;
        parentThreadId: SafeId<"chatThread"> | null;
      }): boolean =>
        fork.forkedFromMessageId === upToMessageId &&
        (fork.parentThreadId === null ||
          fork.parentThreadId === params.threadId);

      const reads = yield* Result.await(
        safeDb(async (tx) => {
          // Resolved before the source lookup so a retry still converges after
          // the source thread was deleted in the meantime: its fork survives
          // with a null parent, and a 404 here would break the retry contract.
          const existingFork = (await readExistingFork(tx)).at(0);
          if (existingFork) {
            return { kind: "existing" as const, existingFork };
          }

          // The request's scope is part of the lookup, so a thread that exists
          // in another scope reads as absent rather than as a scope mismatch,
          // the same way rename, update and delete resolve their thread.
          const source = (
            await tx
              .select(FORKED_THREAD_COLUMNS)
              .from(chatThreads)
              .where(
                and(
                  eq(chatThreads.id, params.threadId),
                  eq(chatThreads.organizationId, session.activeOrganizationId),
                  eq(chatThreads.userId, user.id),
                  scope.scope === "workspace"
                    ? eq(chatThreads.workspaceId, scope.workspaceId)
                    : isNull(chatThreads.workspaceId),
                ),
              )
              .limit(1)
          ).at(0);

          if (!source) {
            return { kind: "source-missing" as const };
          }

          const prefixRows = await loadChatMessagePrefixOnTx({
            targetMessageId: upToMessageId,
            threadId: params.threadId,
            tx,
          });
          if (prefixRows === null) {
            return { kind: "boundary-missing" as const };
          }
          // A fork branches off an answer: the boundary is the last row of the
          // copied prefix, and ending on an ask would hand the fork a thread
          // whose final turn is an unanswered question.
          if (prefixRows.at(-1)?.role !== "assistant") {
            return { kind: "boundary-not-assistant" as const };
          }
          const prefix: PrefixMessage[] = prefixRows.map((row) => ({
            message: settleForkedPendingInteractions(
              chatMessageFromPersisted(row),
            ),
            row,
          }));

          const sourceFileIds = collectPrefixUserFileIds(prefix);
          const sourceFiles =
            sourceFileIds.length === 0
              ? []
              : await tx
                  .select({
                    extractedText: userFiles.extractedText,
                    fileName: userFiles.fileName,
                    id: userFiles.id,
                    mimeType: userFiles.mimeType,
                    placeholder: userFiles.placeholder,
                    s3Key: userFiles.s3Key,
                    scanWarnings: userFiles.scanWarnings,
                    sha256Hex: userFiles.sha256Hex,
                    sizeBytes: userFiles.sizeBytes,
                    thumbnailFileId: userFiles.thumbnailFileId,
                  })
                  .from(userFiles)
                  .where(
                    and(
                      eq(userFiles.threadId, params.threadId),
                      eq(userFiles.userId, user.id),
                      inArray(userFiles.id, sourceFileIds),
                    ),
                  )
                  // Bounded by the distinct attachment ids the copied prefix
                  // references, which the prefix read above already bounded.
                  .limit(sourceFileIds.length);

          const resolvedFileIds = new Set(sourceFiles.map((file) => file.id));
          return {
            kind: "ok" as const,
            prefix,
            source,
            sourceFiles,
            unresolvedFileIds: sourceFileIds.filter(
              (fileId) => !resolvedFileIds.has(fileId),
            ),
          };
        }),
      );

      if (reads.kind === "boundary-not-assistant") {
        return Result.err(
          new HandlerError({
            status: 400,
            message:
              "A chat thread can only be forked from an assistant message",
          }),
        );
      }

      if (
        reads.kind === "source-missing" ||
        reads.kind === "boundary-missing"
      ) {
        return Result.err(
          new HandlerError({
            status: 404,
            message:
              reads.kind === "source-missing"
                ? "Chat thread not found"
                : "Chat message not found in this thread",
          }),
        );
      }

      if (reads.kind === "existing") {
        const { existingFork } = reads;
        if (!matchesForkIdentity(existingFork)) {
          return Result.err(
            new HandlerError({
              status: 409,
              message: "A different chat thread already uses this id",
            }),
          );
        }
        return Result.ok({
          threadId: existingFork.id,
          title: existingFork.title,
        });
      }

      const { prefix, source, sourceFiles, unresolvedFileIds } = reads;
      if (unresolvedFileIds.length > 0) {
        captureError(
          new ChatForkAttachmentRowMissingError({
            message:
              "Chat fork prefix references attachments with no user_files row",
          }),
          {
            fileIds: unresolvedFileIds.join(","),
            threadId: params.threadId,
          },
        );
      }
      const forkWorkspaceId = source.workspaceId;
      const copiedS3Keys: string[] = [];
      const copiedFiles = await copyUserFiles({
        copiedS3Keys,
        files: sourceFiles,
        fileUsageDb,
        organizationId: session.activeOrganizationId,
        userId: user.id,
      });
      if (Result.isError(copiedFiles)) {
        await rollbackCopiedS3Keys(copiedS3Keys, fileUsageDb);
        return Result.err(copiedFiles.error);
      }
      const copies: UserFileCopy[] = [];
      const missingObjectFileIds: SafeId<"userFile">[] = [];
      const missingThumbnailFileIds: SafeId<"userFile">[] = [];
      for (const copied of copiedFiles.value) {
        switch (copied.kind) {
          case "copied": {
            copies.push(copied.copy);
            if (copied.missingThumbnail) {
              missingThumbnailFileIds.push(copied.copy.source.id);
            }
            break;
          }
          case "source-object-missing": {
            missingObjectFileIds.push(copied.fileId);
            break;
          }
          default: {
            copied satisfies never;
            panic(`Unhandled value: ${String(copied)}`);
          }
        }
      }
      if (
        missingObjectFileIds.length > 0 ||
        missingThumbnailFileIds.length > 0
      ) {
        captureError(
          new ChatForkAttachmentObjectMissingError({
            message:
              "Chat fork prefix references attachments whose storage objects are gone",
          }),
          {
            fileIds: missingObjectFileIds.join(","),
            threadId: params.threadId,
            thumbnailFileIds: missingThumbnailFileIds.join(","),
          },
        );
      }
      const copiedFileIds = new Map(
        copies.map((copy) => [copy.source.id, copy.newFileId]),
      );

      const written = await safeDb(async (tx) => {
        await tx.insert(chatThreads).values({
          chatModel: source.chatModel,
          chatReasoningEffort: source.chatReasoningEffort,
          contextMatterIds: source.contextMatterIds,
          dataWorkspaceIds: source.dataWorkspaceIds,
          forkedFromMessageId: upToMessageId,
          id: newThreadId,
          organizationId: session.activeOrganizationId,
          parentThreadId: params.threadId,
          title: source.title,
          titleSource: source.titleSource,
          usedAnonymization: source.usedAnonymization,
          userId: user.id,
          webSearchEnabled: source.webSearchEnabled,
          workspaceId: forkWorkspaceId,
        });

        await consumeInBatches({
          batchSize: FORK_INSERT_BATCH_SIZE,
          consume: async (batch) => {
            // audit: skip — the attachment copies belong to the CHAT_THREAD
            // create event recorded below, which names the fork they were
            // made for.
            await tx.insert(userFiles).values(
              batch.map((copy) => ({
                extractedText: copy.source.extractedText,
                fileName: copy.source.fileName,
                id: copy.newFileId,
                mimeType: copy.source.mimeType,
                placeholder: copy.source.placeholder,
                s3Key: copy.copiedS3Key,
                scanWarnings: copy.source.scanWarnings,
                sha256Hex: copy.source.sha256Hex,
                sizeBytes: copy.source.sizeBytes,
                threadId: newThreadId,
                thumbnailFileId: copy.copiedThumbnailFileId,
                userId: user.id,
              })),
            );
          },
          items: copies,
        });

        await consumeInBatches({
          batchSize: FORK_INSERT_BATCH_SIZE,
          consume: async (batch) => {
            // audit: skip — copied history belongs to the CHAT_THREAD create
            // event recorded below.
            await tx.insert(chatMessages).values(
              batch.map(({ message, row }) => ({
                // Timestamps are preserved: keyset ordering, recap and
                // compaction all read (createdAt, id), so a re-stamped copy
                // would reorder the fork against its own history.
                createdAt: row.createdAt,
                content: toPersistedChatMessageContentV3({
                  data: message.parts.map((part) =>
                    remapChatAttachmentPart(part, copiedFileIds),
                  ),
                  ...(message.metadata === undefined
                    ? {}
                    : { metadata: message.metadata }),
                }),
                id: createSafeId<"chatMessage">(),
                memoryExtractionEligible: row.memoryExtractionEligible,
                role: row.role,
                threadId: newThreadId,
                userId: user.id,
                workspaceId: row.workspaceId,
              })),
            );
          },
          items: prefix,
        });

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.CHAT_THREAD,
          resourceId: newThreadId,
          workspaceId: forkWorkspaceId,
          metadata: {
            forkedFromMessageId: upToMessageId,
            messageCount: prefix.length,
            parentThreadId: params.threadId,
          },
        });
      }, defaultDatabaseRetry);

      if (Result.isError(written)) {
        // Re-read BEFORE unwinding storage: the fork may be durable despite
        // the error, either because a concurrent duplicate of this request won
        // the primary key, or because this request's own COMMIT succeeded and
        // the retryable error surfaced afterwards. In the second case the
        // copied objects are exactly the ones the committed rows reference,
        // and deleting them first would hand back a "created" fork whose
        // attachments are already gone. If this re-read itself fails, storage
        // is left alone: an orphaned object is recoverable, a deleted
        // referenced one is not.
        const raced = yield* Result.await(
          safeDb(async (tx) => {
            const existingFork = (await readExistingFork(tx)).at(0);
            if (!existingFork || !matchesForkIdentity(existingFork)) {
              return { kind: "no-durable-fork" as const };
            }
            // The write is atomic, so the durable fork references either all
            // of this request's copied files (its own commit) or none of them
            // (a concurrent winner's); one membership probe tells them apart.
            const ownRows =
              copies.length === 0
                ? []
                : await tx
                    .select({ id: userFiles.id })
                    .from(userFiles)
                    .where(
                      and(
                        eq(userFiles.threadId, newThreadId),
                        inArray(
                          userFiles.id,
                          copies.map((copy) => copy.newFileId),
                        ),
                      ),
                    )
                    .limit(1);
            return {
              kind: "durable" as const,
              existingFork,
              ownObjectsReferenced: copies.length === 0 || ownRows.length > 0,
            };
          }),
        );
        if (raced.kind === "durable") {
          if (!raced.ownObjectsReferenced) {
            await rollbackCopiedS3Keys(copiedS3Keys, fileUsageDb);
          }
          return Result.ok({
            threadId: raced.existingFork.id,
            title: raced.existingFork.title,
          });
        }
        await rollbackCopiedS3Keys(copiedS3Keys, fileUsageDb);
        return Result.err(written.error);
      }

      // Fire-and-forget after the fork commits: indexing must never block or
      // fail it. Rebuilds both the thread and message search documents for the
      // new thread. Mirrors rename-thread.ts and send-message.ts.
      indexChatThread(newThreadId).catch(captureError);

      return Result.ok({ threadId: newThreadId, title: source.title });
    },
  );

export default createForkThread();
