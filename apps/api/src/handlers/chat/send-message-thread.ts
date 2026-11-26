import { Result } from "better-result";
import { and, eq, notExists, sql } from "drizzle-orm";

import type { ReasoningEffort } from "@stll/ai-catalog";
import type { ChatSendRequest } from "@stll/api-contract/chat";
import {
  CHAT_CLOUD_RUN_TARGET,
  type ChatLocalRunTarget,
  type ChatRunTarget,
} from "@stll/api-contract/chat-run-target";
import type { DesktopRunnerApprovalMode } from "@stll/api-contract/desktop-runner";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db-types";
import { chatMessages, chatThreads } from "@/api/db/schema";
import {
  EMPTY_CHAT_HISTORY_SNAPSHOT,
  loadWindowedThreadHistory,
} from "@/api/handlers/chat/history-window";
import type { ChatHistorySnapshot } from "@/api/handlers/chat/history-window";
import {
  resolveSendThreadFields,
  resolveSendThreadSkill,
  type SendThreadFields,
  sendThreadFieldsAuditChanges,
  sendThreadFieldsChanged,
  type SendThreadFieldsRequest,
} from "@/api/handlers/chat/send-thread-fields";
import type {
  ChatMessage,
  PersistedChatMessageContent,
} from "@/api/handlers/chat/types";
import { shouldRefreshEmptyThreadTitle } from "@/api/lib/ai-generation/thread-title";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { chatRunTargetOf } from "@/api/lib/chat/run-target";
import {
  type ChatThreadNamesRead,
  EMPTY_CHAT_THREAD_NAMES_READ,
  readChatThreadNames,
} from "@/api/lib/chat/thread-names";
import { readChatCopyProjection } from "@/api/lib/chat/withdrawn-copies";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { PG_ERROR, pgErrorFields } from "@/api/lib/pg-error";

/** The send-decided fields a stored thread row holds. */
const storedSendThreadFieldsOf = (row: {
  activeSkill: SendThreadFields["activeSkill"];
  contextMatterIds: SafeId<"workspace">[];
  dataWorkspaceIds: SafeId<"workspace">[];
  subjectDecisionId: SafeId<"caseLawDecision"> | null;
}): SendThreadFields => ({
  activeSkill: row.activeSkill,
  contextMatterIds: row.contextMatterIds,
  dataWorkspaceIds: row.dataWorkspaceIds,
  subjectDecisionId: row.subjectDecisionId,
});

type ReadThreadValidationStateProps = {
  caseLawDb?: Parameters<typeof readChatCopyProjection>[0]["caseLawDb"];
  initialActiveSkill?: ChatSendRequest["activeSkill"];
  messageId: SafeId<"chatMessage">;
  organizationId: SafeId<"organization">;
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace"> | null;
};

type ThreadValidationState = {
  /**
   * The skill the send runs with, decided by `resolveSendThreadFields`: a
   * thread that holds a message keeps its stored skill (an ordinary-chat null
   * included); a missing or still empty one takes the send's.
   */
  activeSkill: ChatSendRequest["activeSkill"];
  persistedMessage: {
    content: PersistedChatMessageContent;
    role: ChatMessage["role"];
  } | null;
  /** Where the thread runs its turns; cloud for a thread the send creates. */
  runTarget: ChatRunTarget;
  /** Every name the thread's history holds. */
  threadNames: ChatThreadNamesRead;
  webSearchEnabled: boolean;
};

export const readThreadValidationState = async ({
  initialActiveSkill,
  messageId,
  organizationId,
  safeDb,
  threadId,
  userId,
  workspaceId,
  caseLawDb,
}: ReadThreadValidationStateProps): Promise<
  Result<ThreadValidationState, HandlerError<400> | SafeDbError>
> =>
  await Result.gen(async function* () {
    const read = yield* Result.await(
      safeDb(async (tx) => {
        const thread = await tx.query.chatThreads.findFirst({
          where: {
            id: { eq: threadId },
            organizationId: { eq: organizationId },
            userId: { eq: userId },
          },
          columns: {
            activeSkill: true,
            chatLocalRunTarget: true,
            chatCloudApprovals: true,
            contextMatterIds: true,
            dataWorkspaceIds: true,
            subjectDecisionId: true,
            workspaceId: true,
            webSearchEnabled: true,
          },
          extras: {
            hasMessages: (table) =>
              sql<boolean>`exists (select 1 from ${chatMessages} where ${chatMessages.threadId} = ${table.id})`,
          },
          with: {
            messages: {
              where: { id: { eq: messageId } },
              columns: { content: true, role: true },
            },
          },
        });
        if (thread === undefined) {
          return null;
        }
        // The thread's ownership was read in this transaction.
        const threadNames = await readChatThreadNames({ threadId, tx });
        const { projection, subjectByThread } = await readChatCopyProjection({
          tx,
          threadIds: [threadId],
          values: thread.messages,
          caseLawDb,
        });
        return {
          hasMessages: thread.hasMessages,
          thread: {
            ...thread,
            messages: thread.messages.map((row) =>
              projection.chat(row, subjectByThread.get(threadId)),
            ),
          },
          threadNames,
        };
      }),
    );

    // Validation knows only the send's skill, which the rest of what the send
    // carries never changes.
    if (read === null) {
      return Result.ok({
        activeSkill:
          resolveSendThreadSkill({
            activeSkill: initialActiveSkill,
            stored: null,
          }) ?? undefined,
        persistedMessage: null,
        runTarget: CHAT_CLOUD_RUN_TARGET,
        threadNames: EMPTY_CHAT_THREAD_NAMES_READ,
        webSearchEnabled: false,
      });
    }
    const { hasMessages, thread, threadNames } = read;

    const persistedWorkspaceId = thread.workspaceId ?? null;
    if (persistedWorkspaceId !== workspaceId) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Chat thread scope does not match request",
        }),
      );
    }

    const persistedMessage = thread.messages.at(0);
    const activeSkill = resolveSendThreadSkill({
      activeSkill: initialActiveSkill,
      stored: { fields: storedSendThreadFieldsOf(thread), hasMessages },
    });
    return Result.ok({
      activeSkill: activeSkill ?? undefined,
      persistedMessage:
        persistedMessage === undefined
          ? null
          : {
              content: persistedMessage.content,
              role: persistedMessage.role,
            },
      runTarget: chatRunTargetOf(thread),
      threadNames,
      webSearchEnabled: thread.webSearchEnabled,
    });
  });

type ChatThreadRecord = {
  id: SafeId<"chatThread">;
  /**
   * This send writes the thread's first message: it created the thread, or
   * the thread held no message yet (a setting chosen before the first
   * message stores the row early).
   */
  firstSend: boolean;
  /** The thread's title once this send loaded it. */
  title: string;
  /** The fields this send runs the thread with (`resolveSendThreadFields`). */
  sendFields: SendThreadFields;
  workspaceId: SafeId<"workspace"> | null;
  contextMatterIds: SafeId<"workspace">[];
  dataWorkspaceIds: SafeId<"workspace">[];
  webSearchEnabled: boolean;
  chatModel: string | null;
  chatReasoningEffort: ReasoningEffort | null;
  /** The stored run target's columns (`storedChatRunTarget`). */
  chatLocalRunTarget: ChatLocalRunTarget | null;
  chatCloudApprovals: DesktopRunnerApprovalMode | null;
  messages: {
    id: SafeId<"chatMessage">;
    role: ChatMessage["role"];
    content: PersistedChatMessageContent;
  }[];
  /** The rows `messages` was read from; see `ChatHistorySnapshot`. */
  historySnapshot: ChatHistorySnapshot;
};

type LoadThreadProps = {
  caseLawDb?: Parameters<typeof readChatCopyProjection>[0]["caseLawDb"];
  initialActiveSkill?: ChatSendRequest["activeSkill"];
  /**
   * Server-derived workspace scope inherited by a newly created draft chat.
   * This is deliberately not populated from the request: a draft can place
   * its origin document snapshot in the model context before its first
   * message is durable, so its thread must start with the origin's RLS scope.
   */
  initialDataWorkspaceIds: readonly SafeId<"workspace">[];
  /** The send's pins; undefined when it names none. */
  initialContextMatterIds: readonly SafeId<"workspace">[] | undefined;
  organizationId: SafeId<"organization">;
  recordAuditEvent: AuditRecorder;
  safeDb: SafeDb;
  /**
   * The decision a new thread is about, from the send's active decision.
   * Written when this send writes the thread's first message; a thread that
   * already holds one keeps its decision.
   */
  subjectDecisionId: SafeId<"caseLawDecision"> | null;
  threadId: SafeId<"chatThread">;
  title: string;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace"> | null;
};

/**
 * What a send stores when it adopts a thread stored before its first message
 * (`adoptEmptyThread`): the fields its first message decides and, while the
 * title is still the placeholder, the send's title.
 */
type EmptyThreadAdoption = {
  fields: SendThreadFields;
  stored: SendThreadFields;
  title: string | null;
};

export type ChatThreadState =
  | {
      type: "existing";
      data: ChatThreadRecord;
      /** Null when the thread holds a message or nothing would change. */
      adoption: EmptyThreadAdoption | null;
    }
  | {
      type: "created";
      data: ChatThreadRecord;
      rollbackToken: string;
    };

type ExistingChatThreadState = Extract<ChatThreadState, { type: "existing" }>;

/**
 * Stores what `loadThread` planned for a thread stored before its first
 * message. The send calls it after its last disconnect check before durable
 * changes, so a disconnected send changes nothing. The write is guarded on
 * the thread still holding no message: when a concurrent send's message
 * landed first, the thread keeps what that send stored.
 */
export const adoptEmptyThread = async ({
  organizationId,
  recordAuditEvent,
  safeDb,
  thread,
  userId,
  workspaceId,
}: {
  organizationId: SafeId<"organization">;
  recordAuditEvent: AuditRecorder;
  safeDb: SafeDb;
  thread: ChatThreadState;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace"> | null;
}): Promise<Result<void, SafeDbError>> => {
  if (thread.type === "created" || thread.adoption === null) {
    return Result.ok(undefined);
  }
  const { fields, stored, title } = thread.adoption;
  const threadId = thread.data.id;
  return await safeDb(async (tx) => {
    const adopted = await tx
      .update(chatThreads)
      .set({ ...fields, ...(title === null ? {} : { title }) })
      .where(
        and(
          eq(chatThreads.id, threadId),
          eq(chatThreads.organizationId, organizationId),
          eq(chatThreads.userId, userId),
          notExists(
            tx
              .select({ id: chatMessages.id })
              .from(chatMessages)
              .where(eq(chatMessages.threadId, threadId)),
          ),
        ),
      )
      .returning({ id: chatThreads.id });
    if (adopted.length === 0) {
      return;
    }
    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.CHAT_THREAD,
      resourceId: threadId,
      workspaceId,
      changes: {
        ...(title === null ? {} : { titleChanged: { old: false, new: true } }),
        ...sendThreadFieldsAuditChanges(stored, fields),
      },
    });
  });
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
  caseLawDb,
  initialActiveSkill,
  initialDataWorkspaceIds,
  initialContextMatterIds,
  organizationId,
  recordAuditEvent,
  safeDb,
  subjectDecisionId,
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
      activeSkill: SendThreadFields["activeSkill"];
      contextMatterIds: SafeId<"workspace">[];
      dataWorkspaceIds: SafeId<"workspace">[];
      subjectDecisionId: SafeId<"caseLawDecision"> | null;
      webSearchEnabled: boolean;
      chatModel: string | null;
      chatReasoningEffort: ReasoningEffort | null;
      chatLocalRunTarget: ChatLocalRunTarget | null;
      chatCloudApprovals: DesktopRunnerApprovalMode | null;
      rollbackToken: string | null;
    };

    // Workspace-scoped chats embed at minimum their own workspace's content.
    // Global chats start with no embedded workspace data; subsequent messages
    // widen this set via expandThreadDataScope when they reference workspace
    // assets (mentions, source-document parts).
    const sendDataWorkspaceIds = [...initialDataWorkspaceIds];
    if (workspaceId !== null && !sendDataWorkspaceIds.includes(workspaceId)) {
      sendDataWorkspaceIds.unshift(workspaceId);
    }
    const sendRequest: SendThreadFieldsRequest = {
      activeSkill: initialActiveSkill,
      contextMatterIds: initialContextMatterIds,
      dataWorkspaceIds: sendDataWorkspaceIds,
      subjectDecisionId,
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
            activeSkill: true,
            contextMatterIds: true,
            dataWorkspaceIds: true,
            subjectDecisionId: true,
            webSearchEnabled: true,
            chatModel: true,
            chatReasoningEffort: true,
            chatLocalRunTarget: true,
            chatCloudApprovals: true,
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
    ): Result<ExistingChatThreadState, HandlerError<400>> => {
      const persistedWorkspaceId = existing.workspaceId ?? null;
      if (persistedWorkspaceId !== workspaceId) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Chat thread scope does not match request",
          }),
        );
      }
      return Result.ok<ExistingChatThreadState>({
        type: "existing",
        adoption: null,
        data: {
          id: existing.id,
          firstSend: false,
          title: existing.title,
          sendFields: storedSendThreadFieldsOf(existing),
          workspaceId: existing.workspaceId,
          contextMatterIds: existing.contextMatterIds,
          dataWorkspaceIds: existing.dataWorkspaceIds,
          webSearchEnabled: existing.webSearchEnabled,
          chatModel: existing.chatModel,
          chatReasoningEffort: existing.chatReasoningEffort,
          chatLocalRunTarget: existing.chatLocalRunTarget,
          chatCloudApprovals: existing.chatCloudApprovals,
          messages: [],
          historySnapshot: EMPTY_CHAT_HISTORY_SNAPSHOT,
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

    // A claimed row that holds no message yet was stored before the first
    // send (a setting chosen in a new chat's composer, an empty chat a surface
    // opened). This send writes its first message, so it decides the thread's
    // send fields and its placeholder title exactly as if it had created the
    // row. Nothing is written here: the send stores the adoption with
    // `adoptEmptyThread` once it knows its client is still connected.
    const planEmptyThreadAdoption = (
      existing: ExistingThreadRow,
      state: ExistingChatThreadState,
    ): void => {
      // A non-empty thread always includes at least its first-kept message in
      // the window, so window length === 0 iff the thread is empty.
      if (state.data.messages.length > 0) {
        return;
      }
      const storedFields = storedSendThreadFieldsOf(existing);
      const fields = resolveSendThreadFields({
        request: sendRequest,
        stored: { fields: storedFields, hasMessages: false },
      });
      const refreshTitle = shouldRefreshEmptyThreadTitle({
        messageCount: 0,
        title: existing.title,
      });
      state.data.firstSend = true;
      state.data.sendFields = fields;
      state.data.contextMatterIds = fields.contextMatterIds;
      state.data.dataWorkspaceIds = fields.dataWorkspaceIds;
      if (refreshTitle) {
        state.data.title = title;
      }
      if (refreshTitle || sendThreadFieldsChanged(storedFields, fields)) {
        state.adoption = {
          fields,
          stored: storedFields,
          title: refreshTitle ? title : null,
        };
      }
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
        caseLawDb,
        claimAttempt: claimAttempt + 1,
        initialActiveSkill,
        initialDataWorkspaceIds,
        initialContextMatterIds,
        organizationId,
        recordAuditEvent,
        safeDb,
        subjectDecisionId,
        threadId,
        title,
        userId,
        workspaceId,
      });
    };

    // Claims a stored row, reads its history window and, while it holds no
    // message, plans its adoption by this send. Null means rollback won the
    // claim race and the attempt must be retried.
    const openExisting = async (
      existing: ExistingThreadRow,
    ): Promise<Result<ChatThreadState | null, LoadThreadError>> =>
      await Result.gen(async function* () {
        const existingResult = buildExisting(existing);
        if (Result.isError(existingResult)) {
          return Result.err(existingResult.error);
        }
        const claimed = yield* Result.await(claimExisting(existing));
        if (!claimed) {
          return Result.ok(null);
        }
        const history = yield* Result.await(
          loadWindowedThreadHistory({ safeDb, threadId, caseLawDb }),
        );
        const state = existingResult.value;
        state.data.messages = history.messages;
        state.data.historySnapshot = history.snapshot;
        planEmptyThreadAdoption(existing, state);
        return Result.ok(state);
      });

    const thread = yield* Result.await(lookup());
    if (thread) {
      const opened = yield* Result.await(openExisting(thread));
      if (opened === null) {
        const retried = yield* Result.await(retryAfterClaimRace());
        return Result.ok(retried);
      }
      return Result.ok(opened);
    }

    const fields = resolveSendThreadFields({
      request: sendRequest,
      stored: null,
    });
    const rollbackToken = Bun.randomUUIDv7();

    const insertResult = await safeDb(async (tx) => {
      // The one insert a send makes: the fields its first message decides
      // come from `resolveSendThreadFields`, as when it adopts an empty row.
      await tx.insert(chatThreads).values({
        id: threadId,
        organizationId,
        title,
        userId,
        workspaceId,
        rollbackToken,
        ...fields,
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
        const opened = yield* Result.await(openExisting(recovered));
        if (opened === null) {
          const retried = yield* Result.await(retryAfterClaimRace());
          return Result.ok(retried);
        }
        return Result.ok(opened);
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
        firstSend: true,
        title,
        sendFields: fields,
        workspaceId,
        contextMatterIds: fields.contextMatterIds,
        dataWorkspaceIds: fields.dataWorkspaceIds,
        webSearchEnabled: false,
        chatModel: null,
        chatReasoningEffort: null,
        chatLocalRunTarget: null,
        chatCloudApprovals: null,
        messages: [],
        historySnapshot: EMPTY_CHAT_HISTORY_SNAPSHOT,
      },
    });
  });
