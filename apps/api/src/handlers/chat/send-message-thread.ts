import { Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { chatThreads } from "@/api/db/schema";
import { loadWindowedThreadMessages } from "@/api/handlers/chat/history-window";
import { shouldRefreshEmptyThreadTitle } from "@/api/handlers/chat/thread-title";
import type {
  ChatMessage,
  PersistedChatMessageContent,
} from "@/api/handlers/chat/types";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { PG_ERROR, pgErrorFields } from "@/api/lib/pg-error";

type ReadThreadValidationStateProps = {
  organizationId: SafeId<"organization">;
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace"> | null;
};

type ThreadValidationState = {
  webSearchEnabled: boolean;
};

export const readThreadValidationState = async ({
  organizationId,
  safeDb,
  threadId,
  userId,
  workspaceId,
}: ReadThreadValidationStateProps): Promise<
  Result<ThreadValidationState, HandlerError<400> | SafeDbError>
> =>
  await Result.gen(async function* () {
    const thread = yield* Result.await(
      safeDb((tx) =>
        tx.query.chatThreads.findFirst({
          where: {
            id: { eq: threadId },
            organizationId: { eq: organizationId },
            userId: { eq: userId },
          },
          columns: {
            workspaceId: true,
            webSearchEnabled: true,
          },
        }),
      ),
    );

    if (!thread) {
      return Result.ok({ webSearchEnabled: false });
    }

    const persistedWorkspaceId = thread.workspaceId ?? null;
    if (persistedWorkspaceId !== workspaceId) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Chat thread scope does not match request",
        }),
      );
    }

    return Result.ok({ webSearchEnabled: thread.webSearchEnabled });
  });

type ChatThreadRecord = {
  id: SafeId<"chatThread">;
  workspaceId: SafeId<"workspace"> | null;
  contextMatterIds: SafeId<"workspace">[];
  dataWorkspaceIds: SafeId<"workspace">[];
  webSearchEnabled: boolean;
  chatModel: string | null;
  messages: {
    id: SafeId<"chatMessage">;
    role: ChatMessage["role"];
    content: PersistedChatMessageContent;
  }[];
};

type LoadThreadProps = {
  initialContextMatterIds: SafeId<"workspace">[];
  isAnonymized: boolean;
  organizationId: SafeId<"organization">;
  recordAuditEvent: AuditRecorder;
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
  title: string;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace"> | null;
};

export type ChatThreadState =
  | {
      type: "existing";
      data: ChatThreadRecord;
    }
  | {
      type: "created";
      data: ChatThreadRecord;
      rollbackToken: string;
    };

type LoadThreadError = HandlerError<400 | 404 | 409> | SafeDbError;

const MAX_THREAD_CLAIM_ATTEMPTS = 3;
const CHAT_THREADS_PRIMARY_KEY_CONSTRAINT = "chat_threads_pkey";

export const loadThread = async (
  props: LoadThreadProps,
): Promise<Result<ChatThreadState, LoadThreadError>> =>
  await loadThreadAttempt({ ...props, claimAttempt: 0 });

type LoadThreadAttemptProps = LoadThreadProps & {
  claimAttempt: number;
};

const loadThreadAttempt = async ({
  claimAttempt,
  initialContextMatterIds,
  isAnonymized,
  organizationId,
  recordAuditEvent,
  safeDb,
  threadId,
  title,
  userId,
  workspaceId,
}: LoadThreadAttemptProps): Promise<Result<ChatThreadState, LoadThreadError>> =>
  await Result.gen(async function* () {
    // Look the thread up by id+organization+user only. Filtering by workspaceId
    // here would mask a scope mismatch — a thread persisted with
    // workspaceId=X but requested as global would look "missing"
    // and the insert below would then collide on the PK. We want a
    // clear 400 instead of a constraint violation 500.
    type ExistingThreadRow = {
      id: SafeId<"chatThread">;
      title: string;
      workspaceId: SafeId<"workspace"> | null;
      contextMatterIds: SafeId<"workspace">[];
      dataWorkspaceIds: SafeId<"workspace">[];
      webSearchEnabled: boolean;
      chatModel: string | null;
      rollbackToken: string | null;
    };

    const lookup = async () =>
      await safeDb((tx) =>
        tx.query.chatThreads.findFirst({
          where: {
            id: { eq: threadId },
            organizationId: { eq: organizationId },
            userId: { eq: userId },
          },
          columns: {
            id: true,
            title: true,
            workspaceId: true,
            contextMatterIds: true,
            dataWorkspaceIds: true,
            webSearchEnabled: true,
            chatModel: true,
            rollbackToken: true,
          },
        }),
      );

    // Load only the per-send window: when an active compaction checkpoint
    // exists, the already-summarized [0..firstKept) prefix is dropped, so a
    // normal send no longer re-reads the whole thread into memory. The
    // truncation/edit path resolves an older target directly against the DB
    // (resolveTruncationTarget), so a window miss never makes a target
    // unfindable.
    const buildExisting = (
      existing: ExistingThreadRow,
    ): Result<ChatThreadState, HandlerError<400>> => {
      const persistedWorkspaceId = existing.workspaceId ?? null;
      if (persistedWorkspaceId !== workspaceId) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Chat thread scope does not match request",
          }),
        );
      }
      return Result.ok<ChatThreadState>({
        type: "existing",
        data: {
          id: existing.id,
          workspaceId: existing.workspaceId,
          contextMatterIds: existing.contextMatterIds,
          dataWorkspaceIds: existing.dataWorkspaceIds,
          webSearchEnabled: existing.webSearchEnabled,
          chatModel: existing.chatModel,
          messages: [],
        },
      });
    };

    // A created row remains rollback-owned only while its token is unchanged.
    // Every adopter CAS-clears that token before using the row.
    // If rollback deletes first, the failed CAS retries and creates/claims the
    // replacement; if adoption wins, the creator's guarded delete is a no-op.
    const claimExisting = async (
      existing: ExistingThreadRow,
    ): Promise<Result<boolean, SafeDbError>> => {
      const rollbackToken = existing.rollbackToken;
      if (rollbackToken === null) {
        return Result.ok(true);
      }

      const claimResult = await safeDb(async (tx) => {
        // audit: skip — clears an ephemeral rollback-ownership token; the
        // thread's user-facing state is unchanged
        const claimQuery = tx
          .update(chatThreads)
          .set({
            rollbackToken: null,
            updatedAt: sql`${chatThreads.updatedAt}`,
          })
          .where(
            and(
              eq(chatThreads.id, threadId),
              eq(chatThreads.organizationId, organizationId),
              eq(chatThreads.userId, userId),
              eq(chatThreads.rollbackToken, rollbackToken),
            ),
          )
          .returning({ id: chatThreads.id });
        return await claimQuery;
      });
      if (Result.isError(claimResult)) {
        return Result.err(claimResult.error);
      }
      return Result.ok(claimResult.value.length > 0);
    };

    const retryAfterClaimRace = async (): Promise<
      Result<ChatThreadState, LoadThreadError>
    > => {
      if (claimAttempt >= MAX_THREAD_CLAIM_ATTEMPTS) {
        return Result.err(
          new HandlerError({
            status: 409,
            message: "Chat thread changed concurrently; retry request",
          }),
        );
      }
      return await loadThreadAttempt({
        claimAttempt: claimAttempt + 1,
        initialContextMatterIds,
        isAnonymized,
        organizationId,
        recordAuditEvent,
        safeDb,
        threadId,
        title,
        userId,
        workspaceId,
      });
    };

    const thread = yield* Result.await(lookup());
    if (thread) {
      const existingResult = buildExisting(thread);
      if (Result.isError(existingResult)) {
        return Result.err(existingResult.error);
      }
      const claimed = yield* Result.await(claimExisting(thread));
      if (!claimed) {
        const retried = yield* Result.await(retryAfterClaimRace());
        return Result.ok(retried);
      }
      const windowedMessages = yield* Result.await(
        loadWindowedThreadMessages({ safeDb, threadId, isAnonymized }),
      );
      existingResult.value.data.messages = windowedMessages;
      if (
        shouldRefreshEmptyThreadTitle({
          // A non-empty thread always includes at least its first-kept
          // message in the window, so window length === 0 iff the thread is
          // empty — the only thing this check needs to know.
          messageCount: windowedMessages.length,
          title: thread.title,
        })
      ) {
        yield* Result.await(
          safeDb(async (tx) => {
            await tx
              .update(chatThreads)
              .set({ title })
              .where(
                and(
                  eq(chatThreads.id, threadId),
                  eq(chatThreads.organizationId, organizationId),
                  eq(chatThreads.userId, userId),
                ),
              );

            await recordAuditEvent(tx, {
              action: AUDIT_ACTION.UPDATE,
              resourceType: AUDIT_RESOURCE_TYPE.CHAT_THREAD,
              resourceId: threadId,
              workspaceId,
              changes: {
                title: { old: thread.title, new: title },
              },
            });
          }),
        );
      }
      return Result.ok(existingResult.value);
    }

    const initialDataWorkspaceIds: SafeId<"workspace">[] = workspaceId
      ? [workspaceId]
      : [];
    const rollbackToken = Bun.randomUUIDv7();

    const insertResult = await safeDb(async (tx) => {
      await tx.insert(chatThreads).values({
        id: threadId,
        organizationId,
        title,
        userId,
        workspaceId,
        contextMatterIds: initialContextMatterIds,
        rollbackToken,
        // Workspace-scoped chats embed at minimum their own
        // workspace's content. Global chats start with no
        // embedded workspace data; subsequent messages widen
        // this set via expandThreadDataScope when they reference
        // workspace assets (mentions, source-document parts).
        dataWorkspaceIds: initialDataWorkspaceIds,
      });

      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.CREATE,
        resourceType: AUDIT_RESOURCE_TYPE.CHAT_THREAD,
        resourceId: threadId,
        workspaceId,
        metadata: { title },
      });
    });
    if (Result.isError(insertResult)) {
      if (
        !DatabaseError.is(insertResult.error) ||
        insertResult.error.code !== PG_ERROR.UNIQUE_VIOLATION ||
        pgErrorFields(insertResult.error)["error.cause.pg_constraint"] !==
          CHAT_THREADS_PRIMARY_KEY_CONSTRAINT
      ) {
        return Result.err(insertResult.error);
      }
      // Two interleaved cases collide on the primary key here:
      //
      //   (a) Race: two concurrent send-message calls with the
      //       same new threadId — one insert wins, the other
      //       sees the winner's row and should treat it as
      //       existing.
      //   (b) Hidden thread: the row exists but is invisible
      //       under the new RLS predicate (data_workspace_ids ⊄
      //       session), so the initial findFirst returned null.
      //       Returning 404 matches what get-messages already
      //       returns for the same shape and avoids leaking
      //       thread existence to a revoked user.
      //
      // Re-run the lookup under current RLS to disambiguate.
      const recovered = yield* Result.await(lookup());
      if (recovered) {
        const recoveredResult = buildExisting(recovered);
        if (Result.isError(recoveredResult)) {
          return Result.err(recoveredResult.error);
        }
        const claimed = yield* Result.await(claimExisting(recovered));
        if (!claimed) {
          const retried = yield* Result.await(retryAfterClaimRace());
          return Result.ok(retried);
        }
        const recoveredMessages = yield* Result.await(
          loadWindowedThreadMessages({ safeDb, threadId, isAnonymized }),
        );
        recoveredResult.value.data.messages = recoveredMessages;
        return Result.ok(recoveredResult.value);
      }
      return Result.err(
        new HandlerError({
          status: 404,
          message: "Chat thread not found",
        }),
      );
    }

    return Result.ok<ChatThreadState>({
      type: "created",
      rollbackToken,
      data: {
        id: threadId,
        workspaceId,
        contextMatterIds: initialContextMatterIds,
        dataWorkspaceIds: initialDataWorkspaceIds,
        webSearchEnabled: false,
        chatModel: null,
        messages: [],
      },
    });
  });
