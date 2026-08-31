import { Result, TaggedError } from "better-result";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { t } from "elysia";

import type { Transaction } from "@/api/db/root";
import { defaultDatabaseRetry } from "@/api/db/safe-db";
import { chatMessages, chatThreads, userFiles } from "@/api/db/schema";
import {
  createChatAttachmentPart,
  getChatAttachmentFilename,
  getChatAttachmentMimeType,
  getChatAttachmentPlaceholder,
  getChatAttachmentUrl,
  isChatAttachmentPart,
  chatMessageFromPersisted,
  toPersistedChatMessageContentV3,
} from "@/api/handlers/chat/chat-message-parts";
import {
  assertChatThreadScopeMatches,
  resolveChatScope,
} from "@/api/handlers/chat/chat-scope";
import type { ChatMessagePrefixRow } from "@/api/handlers/chat/history-window";
import { loadChatMessagePrefixOnTx } from "@/api/handlers/chat/history-window";
import type { ChatPart } from "@/api/handlers/chat/types";
import { captureError } from "@/api/lib/analytics/capture";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { THUMBNAIL_MIME_TYPE } from "@/api/lib/files/image-derivative";
import { createUserFileKey, deleteS3Keys } from "@/api/lib/files/utils";
import { copyObject } from "@/api/lib/s3-presign";
import { upsertChatThreadSearchDocument } from "@/api/lib/search/index-chat";
import { parseUserFileId, toUserFileUrl } from "@/api/lib/user-files/types";

const config = {
  description:
    "Fork one of your own chat threads into a new thread that keeps the " +
    "history up to a chosen message, so another direction or model can be " +
    "explored without touching the original. The new thread id is minted by " +
    "the caller, which makes a retried fork return the existing copy instead " +
    "of duplicating it. Attachments are duplicated, never shared: deleting " +
    "either thread leaves the other's files intact. The fork records where " +
    "it came from and starts with no compaction state of its own.",
  permissions: { chat: ["create"] },
  access: "write",
  mcp: { type: "capability", reason: "assistant_chat" },
  params: t.Object({ threadId: tSafeId("chatThread") }),
  query: t.Object({
    workspaceId: t.Optional(tSafeId("workspace")),
  }),
  body: t.Object({
    newThreadId: tSafeId("chatThread"),
    upToMessageId: tSafeId("chatMessage"),
  }),
} satisfies HandlerConfig;

/** Settings a fork inherits verbatim from the thread it was cut from. */
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

/** The columns a fork's copy of one attachment is rebuilt from. */
type SourceUserFileRow = {
  extractedText: string | null;
  fileName: string;
  id: SafeId<"userFile">;
  mimeType: string;
  placeholder: string | null;
  s3Key: string;
  scanWarnings: string[] | null;
  sha256Hex: string;
  sizeBytes: number;
  thumbnailFileId: string | null;
};

type UserFileCopy = {
  copiedS3Key: string;
  copiedThumbnailFileId: string | null;
  newFileId: SafeId<"userFile">;
  source: SourceUserFileRow;
};

/**
 * Every `stella://file::<id>` a copied prefix points at, in insertion order.
 * A message may repeat an attachment and several messages may share one, so
 * the set is what drives the copy, not the parts.
 */
const collectPrefixUserFileIds = (
  rows: readonly ChatMessagePrefixRow[],
): SafeId<"userFile">[] => {
  const fileIds = new Set<SafeId<"userFile">>();
  for (const row of rows) {
    for (const part of chatMessageFromPersisted(row).parts) {
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
 * A part whose file id resolved to no `user_files` row is left untouched: the
 * source's own URL already dangles, so the fork inherits a dead reference
 * rather than a shared object. That miss is reported as telemetry by the
 * caller, because the other way to reach it — a row that escaped this thread's
 * ownership — would be a real defect.
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
 * Copy one attachment's storage objects to keys minted for a fresh file id.
 * Destination keys are pushed onto `copiedS3Keys` before the copy starts: a
 * request that times out may still have completed in S3, so rollback must be
 * able to delete a key whose success the caller never observed.
 */
const copyUserFileObjects = async ({
  copiedS3Keys,
  file,
  userId,
}: {
  copiedS3Keys: string[];
  file: SourceUserFileRow;
  userId: SafeId<"user">;
}): Promise<Result<UserFileCopy, HandlerError<500>>> =>
  await Result.gen(async function* () {
    const newFileId = createSafeId<"userFile">();
    const copiedS3Key = createUserFileKey({
      fileId: newFileId,
      mimeType: file.mimeType,
      userId,
    });
    copiedS3Keys.push(copiedS3Key);
    yield* Result.mapError(
      await copyObject(file.s3Key, copiedS3Key),
      (cause) =>
        new HandlerError({
          status: 500,
          message: "Failed to copy chat attachment storage object",
          cause,
        }),
    );

    if (file.thumbnailFileId === null) {
      return Result.ok({
        copiedS3Key,
        copiedThumbnailFileId: null,
        newFileId,
        source: file,
      });
    }

    const copiedThumbnailFileId = Bun.randomUUIDv7();
    const copiedThumbnailKey = createUserFileKey({
      fileId: copiedThumbnailFileId,
      mimeType: THUMBNAIL_MIME_TYPE,
      userId,
    });
    copiedS3Keys.push(copiedThumbnailKey);
    yield* Result.mapError(
      await copyObject(
        createUserFileKey({
          fileId: file.thumbnailFileId,
          mimeType: THUMBNAIL_MIME_TYPE,
          userId,
        }),
        copiedThumbnailKey,
      ),
      (cause) =>
        new HandlerError({
          status: 500,
          message: "Failed to copy chat attachment thumbnail",
          cause,
        }),
    );

    return Result.ok({
      copiedS3Key,
      copiedThumbnailFileId,
      newFileId,
      source: file,
    });
  });

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
 * Delete storage objects a failed fork already created. Rollback failures are
 * captured, never thrown: they must not mask the error that triggered them,
 * and the worst outcome they leave is an unreferenced object.
 */
const rollbackCopiedS3Keys = async (copiedS3Keys: string[]): Promise<void> => {
  if (copiedS3Keys.length === 0) {
    return;
  }
  const deleted = await deleteS3Keys(copiedS3Keys);
  if (Result.isError(deleted)) {
    captureError(deleted.error, { source: "chat-fork-rollback" });
  }
};

// Forks a chat thread at one of its messages. The prefix, its attachments and
// the thread's settings are copied; turns, compaction state and the file /
// template thread mappings are not. The fork's id comes from the caller, so a
// retry converges on one copy instead of duplicating it.
export const createForkThread = ({
  indexChatThread = upsertChatThreadSearchDocument,
}: {
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

          const [source] = await tx
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
            .limit(1);

          if (!source) {
            return { kind: "source-missing" as const };
          }

          if (
            Result.isError(
              assertChatThreadScopeMatches({
                persistedWorkspaceId: source.workspaceId,
                scope,
              }),
            )
          ) {
            return { kind: "scope-mismatch" as const };
          }

          const prefix = await loadChatMessagePrefixOnTx({
            targetMessageId: upToMessageId,
            threadId: params.threadId,
            tx,
          });
          if (prefix === null) {
            return { kind: "boundary-missing" as const };
          }

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

      if (reads.kind === "scope-mismatch") {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Chat thread scope does not match request",
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
      const copyResults = await Promise.all(
        sourceFiles.map(
          async (file) =>
            await copyUserFileObjects({ copiedS3Keys, file, userId: user.id }),
        ),
      );
      const copies: UserFileCopy[] = [];
      let copyError: HandlerError<500> | undefined;
      for (const copied of copyResults) {
        if (Result.isError(copied)) {
          copyError ??= copied.error;
          continue;
        }
        copies.push(copied.value);
      }
      if (copyError !== undefined) {
        // Nothing has been written yet, so unwinding storage is the whole
        // rollback: no partial fork is reachable from here.
        await rollbackCopiedS3Keys(copiedS3Keys);
        return Result.err(copyError);
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

        if (copies.length > 0) {
          // audit: skip — the attachment copies belong to the CHAT_THREAD create
          // event recorded below, which names the fork they were made for.
          await tx.insert(userFiles).values(
            copies.map((copy) => ({
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
        }

        if (prefix.length > 0) {
          // audit: skip — copied history belongs to the CHAT_THREAD create event
          // recorded below.
          await tx.insert(chatMessages).values(
            prefix.map((row) => {
              const message = chatMessageFromPersisted(row);
              return {
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
              };
            }),
          );
        }

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
            await rollbackCopiedS3Keys(copiedS3Keys);
          }
          return Result.ok({
            threadId: raced.existingFork.id,
            title: raced.existingFork.title,
          });
        }
        await rollbackCopiedS3Keys(copiedS3Keys);
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
