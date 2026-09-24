import { panic, Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";

import type { ChatSendMode } from "@stll/anonymize-chat";

import type { Transaction } from "@/api/db/root";
import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { chatMessages, chatThreads } from "@/api/db/schema";
import { env } from "@/api/env";
import {
  attachTerminalTurnOutcome,
  chatMessageContentFromMessage,
  chatMessageFromPersisted,
  mergeAnonRestorations,
  toPersistableChatMessage,
} from "@/api/handlers/chat/chat-message-parts";
import {
  canAcceptChatTurnOnTx,
  claimChatTurnForExecutionOnTx,
  insertChatTurnAcceptanceOnTx,
  settleChatTurnOnTx,
  withClaimedChatTurnExecution,
} from "@/api/handlers/chat/chat-turn-persistence";
import type {
  ChatTurnAcceptance,
  ChatTurnExecution,
  ChatTurnExecutionClaim,
} from "@/api/handlers/chat/chat-turn-persistence";
import {
  ChatTurnUnsettledToolCallError,
  findUnsettledToolCallsForOutcome,
  findUnsettledToolCallsOnResumedMessage,
} from "@/api/handlers/chat/chat-turn-settlement";
import type { UnsettledToolCall } from "@/api/handlers/chat/chat-turn-settlement";
import type { ChatTurnFailureCode } from "@/api/handlers/chat/chat-turn-state";
import { planAssistantFinishPersistence } from "@/api/handlers/chat/persist-message";
import type { MessagePersistencePlan } from "@/api/handlers/chat/persist-message";
import {
  invalidateChatCompactionChain,
  shouldInvalidateChatCompactionCheckpoint,
} from "@/api/handlers/chat/persistent-compaction";
import { shouldMarkThreadUsedAnonymization } from "@/api/handlers/chat/thread-anonymization";
import type {
  ChatMessageMetadata,
  ChatTurnOutcome,
  PersistableChatMessage,
  PersistableTerminalAssistantMessage,
} from "@/api/handlers/chat/types";
import { captureError } from "@/api/lib/analytics/capture";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  expandThreadDataScopeOnTx,
  replaceThreadDataScopeOnTx,
} from "@/api/lib/chat/data-scope";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { upsertChatThreadSearchDocument } from "@/api/lib/search/index-chat";

type InsertMessagesProps = {
  acceptedSendMode: ChatSendMode | null;
  dataScopeExpansion?: ChatDataScopeExpansion | undefined;
  messages: PersistableChatMessage[];
  recordAuditEvent: AuditRecorder;
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
  turnAcceptance?: ChatTurnAcceptance | undefined;
  turnSettlement?: ChatTurnSettlement | undefined;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace"> | null;
};

export type ChatDataScopeExpansion = {
  newWorkspaceIds: readonly SafeId<"workspace">[];
};

export type ChatDataScopeReplacement = {
  newDataWorkspaceIds: readonly SafeId<"workspace">[];
  observedDataWorkspaceIds: readonly SafeId<"workspace">[];
};

type ChatTurnSettlement = {
  assistantMessageId: SafeId<"chatMessage"> | null;
  execution: ChatTurnExecution;
  failureCode?: ChatTurnFailureCode | undefined;
  failureRetryable?: boolean | undefined;
  outcome: ChatTurnOutcome;
};

const applyChatTurnWritesOnTx = async ({
  acceptance,
  settlement,
  tx,
}: {
  acceptance: ChatTurnAcceptance | undefined;
  settlement: ChatTurnSettlement | undefined;
  tx: Transaction;
}): Promise<void> => {
  if (
    acceptance !== undefined &&
    !(await insertChatTurnAcceptanceOnTx({ acceptance, tx }))
  ) {
    panic("Chat turn acceptance lost its reserved thread slot");
  }
  if (
    settlement !== undefined &&
    !(await settleChatTurnOnTx({ ...settlement, tx }))
  ) {
    panic("Chat turn settlement lost execution ownership");
  }
};

const reserveChatTurnAcceptanceOnTx = async ({
  acceptance,
  tx,
}: {
  acceptance: ChatTurnAcceptance | undefined;
  tx: Transaction;
}): Promise<boolean> =>
  acceptance === undefined ||
  (await canAcceptChatTurnOnTx({ threadId: acceptance.threadId, tx }));

const applyChatDataScopeExpansionOnTx = async ({
  expansion,
  recordAuditEvent,
  threadId,
  tx,
  workspaceId,
}: {
  expansion: ChatDataScopeExpansion | undefined;
  recordAuditEvent: AuditRecorder;
  threadId: SafeId<"chatThread">;
  tx: Transaction;
  workspaceId: SafeId<"workspace"> | null;
}): Promise<void> => {
  if (expansion === undefined || expansion.newWorkspaceIds.length === 0) {
    return;
  }
  await expandThreadDataScopeOnTx({
    ...expansion,
    recordAuditEvent,
    threadId,
    threadWorkspaceId: workspaceId,
    tx,
  });
};

const applyChatDataScopeReplacementOnTx = async ({
  recordAuditEvent,
  replacement,
  threadId,
  tx,
  workspaceId,
}: {
  recordAuditEvent: AuditRecorder;
  replacement: ChatDataScopeReplacement | undefined;
  threadId: SafeId<"chatThread">;
  tx: Transaction;
  workspaceId: SafeId<"workspace"> | null;
}): Promise<void> => {
  if (replacement === undefined) {
    return;
  }
  await replaceThreadDataScopeOnTx({
    ...replacement,
    recordAuditEvent,
    threadId,
    threadWorkspaceId: workspaceId,
    tx,
  });
};

const insertMessages = async ({
  acceptedSendMode,
  dataScopeExpansion,
  messages,
  recordAuditEvent,
  safeDb,
  threadId,
  turnAcceptance,
  turnSettlement,
  userId,
  workspaceId,
}: InsertMessagesProps): Promise<
  Result<void, HandlerError<409> | SafeDbError>
> => {
  if (messages.length === 0) {
    return Result.ok();
  }

  const insertResult = await safeDb(async (tx) => {
    if (
      !(await reserveChatTurnAcceptanceOnTx({
        acceptance: turnAcceptance,
        tx,
      }))
    ) {
      return false;
    }
    await applyChatDataScopeExpansionOnTx({
      expansion: dataScopeExpansion,
      recordAuditEvent,
      threadId,
      tx,
      workspaceId,
    });
    await tx.insert(chatMessages).values(
      messages.map((persistedMessage) => ({
        id: persistedMessage.id,
        threadId,
        workspaceId,
        userId,
        role: persistedMessage.role,
        content: chatMessageContentFromMessage(persistedMessage),
        memoryExtractionEligible: env.FEATURE_AI_MEMORY,
      })),
    );
    await tx
      .update(chatThreads)
      .set({
        updatedAt: new Date(),
        ...(shouldMarkThreadUsedAnonymization({
          messages,
          sendMode: acceptedSendMode,
        })
          ? { usedAnonymization: true }
          : {}),
      })
      .where(eq(chatThreads.id, threadId));

    await recordAuditEvent(
      tx,
      messages.map((persistedMessage) => ({
        action: AUDIT_ACTION.CREATE,
        resourceType: AUDIT_RESOURCE_TYPE.CHAT_MESSAGE,
        resourceId: persistedMessage.id,
        workspaceId,
        metadata: { threadId, role: persistedMessage.role },
      })),
    );
    await applyChatTurnWritesOnTx({
      acceptance: turnAcceptance,
      settlement: turnSettlement,
      tx,
    });
    return true;
  });

  return insertResult.andThen((inserted) =>
    inserted
      ? Result.ok()
      : Result.err(
          new HandlerError({
            status: 409,
            message: "A chat turn is already running",
          }),
        ),
  );
};

export type PersistMessageProps = {
  acceptedSendMode?: ChatSendMode | null;
  dataScopeExpansion?: ChatDataScopeExpansion | undefined;
  recordAuditEvent: AuditRecorder;
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
  turnAcceptance?: ChatTurnAcceptance | undefined;
  turnSettlement?: ChatTurnSettlement | undefined;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace"> | null;
  persistencePlan: MessagePersistencePlan;
  deleteMessageIds?: SafeId<"chatMessage">[];
  dataScopeReplacement?: ChatDataScopeReplacement | undefined;
  indexThread?: typeof upsertChatThreadSearchDocument | undefined;
};

export const persistMessage = async (props: PersistMessageProps) => {
  const result = await runPersistMessage(props);
  // Refresh the thread's global-search document whenever its messages
  // actually changed. Fire-and-forget: indexing must never block or
  // fail a chat turn.
  if (Result.isOk(result) && props.persistencePlan.type !== "none") {
    (props.indexThread ?? upsertChatThreadSearchDocument)(props.threadId).catch(
      captureError,
    );
  }
  return result;
};

type TerminalAssistantMessageProps = {
  outcome: ChatTurnOutcome;
  owningAssistantMessage: PersistableChatMessage | undefined;
  /** What the run produced; a failure before its first chunk produced nothing. */
  responseMessage: PersistableChatMessage | undefined;
};

/**
 * The one message a terminal turn writes. A continuation writes it over the
 * owning assistant row, so it keeps what the run did not reproduce: the owning
 * parts when the run produced none, and the owning metadata beneath the run's.
 * Restoration pairs accumulate because the owning text still needs the earlier
 * ones; token usage sums because the row now spans both runs.
 */
const toTerminalAssistantMessage = ({
  outcome,
  owningAssistantMessage,
  responseMessage,
}: TerminalAssistantMessageProps): PersistableTerminalAssistantMessage => {
  if (
    owningAssistantMessage !== undefined &&
    owningAssistantMessage.role !== "assistant"
  ) {
    panic("A terminal continuation owner must be an assistant message");
  }
  if (
    owningAssistantMessage !== undefined &&
    responseMessage !== undefined &&
    responseMessage.id !== owningAssistantMessage.id
  ) {
    panic("A continuation must persist under its owning message id");
  }
  // A run that failed before its first chunk produced no parts; the owning
  // message keeps the ones it already had.
  const runProducedParts =
    responseMessage !== undefined && responseMessage.parts.length > 0;
  const owningParts =
    owningAssistantMessage === undefined ? [] : owningAssistantMessage.parts;
  const message = toPersistableChatMessage({
    id:
      responseMessage?.id ??
      owningAssistantMessage?.id ??
      createSafeId<"chatMessage">(),
    metadata: mergeContinuationMetadata({
      owning: owningAssistantMessage?.metadata,
      run: responseMessage?.metadata,
    }),
    parts: runProducedParts ? responseMessage.parts : owningParts,
    role: responseMessage?.role ?? "assistant",
    ...(owningAssistantMessage?.createdAt === undefined
      ? {}
      : { createdAt: owningAssistantMessage.createdAt }),
  });
  return attachTerminalTurnOutcome({ message, turnOutcome: outcome });
};

const mergeContinuationMetadata = ({
  owning,
  run,
}: {
  owning: ChatMessageMetadata | undefined;
  run: ChatMessageMetadata | undefined;
}): ChatMessageMetadata => {
  const merged: ChatMessageMetadata = { ...owning, ...run };
  if (
    owning?.anonRestorations !== undefined &&
    run?.anonRestorations !== undefined
  ) {
    merged.anonRestorations = mergeAnonRestorations(
      owning.anonRestorations,
      run.anonRestorations,
    );
  }
  if (owning?.usage !== undefined && run?.usage !== undefined) {
    const reasoningTokens =
      (owning.usage.completionTokensDetails?.reasoningTokens ?? 0) +
      (run.usage.completionTokensDetails?.reasoningTokens ?? 0);
    merged.usage = {
      completionTokens:
        owning.usage.completionTokens + run.usage.completionTokens,
      promptTokens: owning.usage.promptTokens + run.usage.promptTokens,
      totalTokens: owning.usage.totalTokens + run.usage.totalTokens,
      ...(owning.usage.completionTokensDetails === undefined &&
      run.usage.completionTokensDetails === undefined
        ? {}
        : { completionTokensDetails: { reasoningTokens } }),
    };
  }
  return merged;
};

/**
 * Persist the assistant message and settle its durable execution owner in the
 * same transaction. The stream boundary resolves refs and computes accessible
 * data scope before calling this function; this boundary owns only durable
 * terminal state.
 */
export const finalizeAssistantTurn = async ({
  acceptedSendMode,
  dataScopeExpansion,
  existingIds,
  execution,
  outcome,
  owningAssistantMessage,
  recordAuditEvent,
  responseMessage,
  resumedMessageId,
  safeDb,
  threadId,
  userId,
  workspaceId,
  indexThread = upsertChatThreadSearchDocument,
}: {
  acceptedSendMode: ChatSendMode | null;
  dataScopeExpansion?: ChatDataScopeExpansion | undefined;
  existingIds: Set<SafeId<"chatMessage">>;
  execution: ChatTurnExecution;
  outcome: ChatTurnOutcome;
  owningAssistantMessage?: PersistableChatMessage | undefined;
  recordAuditEvent: AuditRecorder;
  responseMessage: PersistableChatMessage;
  /** The assistant message a continuation resumed, when there is one. */
  resumedMessageId: SafeId<"chatMessage"> | undefined;
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace"> | null;
  indexThread?: typeof upsertChatThreadSearchDocument;
}) => {
  const assistantMessage = toTerminalAssistantMessage({
    outcome,
    owningAssistantMessage,
    responseMessage,
  });
  const persistencePlan = planAssistantFinishPersistence({
    existingIds,
    finishOutcome: outcome,
    message: assistantMessage,
  });

  // A terminal stream always supplies an assistant message. Silently
  // accepting `none` would acknowledge the stream while leaving its durable
  // turn running forever.
  if (persistencePlan.type === "none") {
    panic("Assistant turn produced no persistence plan");
  }

  const persistResult = await persistMessage({
    acceptedSendMode,
    dataScopeExpansion,
    persistencePlan,
    recordAuditEvent,
    safeDb,
    threadId,
    turnSettlement: {
      assistantMessageId: assistantMessage.id,
      execution,
      outcome,
    },
    userId,
    workspaceId,
    indexThread,
  });
  if (Result.isError(persistResult)) {
    return Result.err(persistResult.error);
  }
  // Reported once the turn is stored: the report says a stored thread holds
  // the open call, which a failed write never made true.
  reportUnsettledToolCalls({
    message: "terminal",
    outcome: outcome.type,
    unsettled: findUnsettledToolCallsForOutcome({
      outcome: outcome.type,
      parts: responseMessage.parts,
    }),
  });
  if (
    resumedMessageId !== undefined &&
    resumedMessageId !== responseMessage.id
  ) {
    await reportUnsettledResumedMessage({
      messageId: resumedMessageId,
      outcome: outcome.type,
      safeDb,
      threadId,
    });
  }
  return Result.ok({ persistencePlan });
};

/**
 * A continuation that answered on a new message leaves the message it resumed
 * as stored before the turn; that stored copy is what reloads.
 */
const reportUnsettledResumedMessage = async ({
  messageId,
  outcome,
  safeDb,
  threadId,
}: {
  messageId: SafeId<"chatMessage">;
  outcome: ChatTurnOutcome["type"];
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
}) => {
  const stored = await safeDb(
    async (tx) =>
      await tx
        .select({
          content: chatMessages.content,
          id: chatMessages.id,
          role: chatMessages.role,
        })
        .from(chatMessages)
        .where(
          and(
            eq(chatMessages.id, messageId),
            eq(chatMessages.threadId, threadId),
          ),
        )
        .limit(1),
  );
  if (Result.isError(stored)) {
    captureError(stored.error, { threadId });
    return;
  }
  const row = stored.value.at(0);
  if (row === undefined) {
    return;
  }
  reportUnsettledToolCalls({
    message: "resumed",
    outcome,
    unsettled: findUnsettledToolCallsOnResumedMessage({
      outcome,
      parts: chatMessageFromPersisted(row).parts,
    }),
  });
};

/** The turn still settles: its answer is already streamed and belongs in the
 *  thread. The report flags a message that reloads with an open call. */
const reportUnsettledToolCalls = ({
  message,
  outcome,
  unsettled,
}: {
  message: "resumed" | "terminal";
  outcome: ChatTurnOutcome["type"];
  unsettled: readonly UnsettledToolCall[];
}) => {
  if (unsettled.length === 0) {
    return;
  }
  captureError(
    new ChatTurnUnsettledToolCallError({
      message: "A settled chat turn stored a tool call without its result",
    }),
    {
      message,
      outcome,
      tool_call_states: unsettled.map(({ state }) => state).join(","),
      unsettled_count: String(unsettled.length),
    },
  );
};

type PersistTerminalAssistantTurnProps = {
  execution: ChatTurnExecution;
  failure?:
    | {
        code: ChatTurnFailureCode;
        retryable: boolean;
      }
    | undefined;
  outcome: ChatTurnOutcome;
  owningAssistantMessage?: PersistableChatMessage | undefined;
  recordAuditEvent: AuditRecorder;
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace"> | null;
};

const persistTerminalAssistantTurn = async ({
  execution,
  failure,
  outcome,
  owningAssistantMessage,
  recordAuditEvent,
  safeDb,
  threadId,
  userId,
  workspaceId,
}: PersistTerminalAssistantTurnProps) => {
  const assistantMessage = toTerminalAssistantMessage({
    outcome,
    owningAssistantMessage,
    responseMessage: undefined,
  });
  return await persistMessage({
    persistencePlan:
      owningAssistantMessage === undefined
        ? { type: "insert", message: assistantMessage }
        : {
            type: "update",
            messageId: assistantMessage.id,
            message: assistantMessage,
          },
    recordAuditEvent,
    safeDb,
    threadId,
    turnSettlement: {
      assistantMessageId: assistantMessage.id,
      execution,
      ...(failure === undefined
        ? {}
        : {
            failureCode: failure.code,
            failureRetryable: failure.retryable,
          }),
      outcome,
    },
    userId,
    workspaceId,
  });
};

/**
 * A failure before the stream exists must still hydrate as the same terminal
 * assistant turn as a streamed RUN_ERROR. Insert an empty assistant for a new
 * user turn or update the continuation's owning assistant, and settle its owner
 * in the same transaction.
 */
export const persistFailedChatTurn = async ({
  code,
  execution,
  recordAuditEvent,
  retryable,
  owningAssistantMessage,
  safeDb,
  threadId,
  userId,
  workspaceId,
}: {
  code: ChatTurnFailureCode;
  execution: ChatTurnExecution;
  recordAuditEvent: AuditRecorder;
  retryable: boolean;
  owningAssistantMessage?: PersistableChatMessage | undefined;
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace"> | null;
}) => {
  const outcome = { type: "failed", error: "unknown" } as const;
  return await persistTerminalAssistantTurn({
    execution,
    failure: { code, retryable },
    outcome,
    owningAssistantMessage,
    recordAuditEvent,
    safeDb,
    threadId,
    userId,
    workspaceId,
  });
};

/** Persist a pre-stream client disconnect as a reloadable terminal turn. */
export const persistInterruptedChatTurn = async ({
  execution,
  owningAssistantMessage,
  recordAuditEvent,
  safeDb,
  threadId,
  userId,
  workspaceId,
}: Omit<PersistTerminalAssistantTurnProps, "failure" | "outcome">) =>
  await persistTerminalAssistantTurn({
    execution,
    outcome: { type: "interrupted", reason: "client-disconnected" },
    owningAssistantMessage,
    recordAuditEvent,
    safeDb,
    threadId,
    userId,
    workspaceId,
  });

const runPersistMessage = async ({
  acceptedSendMode = null,
  dataScopeExpansion,
  recordAuditEvent,
  safeDb,
  threadId,
  turnAcceptance,
  turnSettlement,
  userId,
  workspaceId,
  persistencePlan,
  deleteMessageIds = [],
  dataScopeReplacement,
}: PersistMessageProps) => {
  if (persistencePlan.type === "insert") {
    return await insertMessages({
      acceptedSendMode,
      dataScopeExpansion,
      messages: [persistencePlan.message],
      recordAuditEvent,
      safeDb,
      threadId,
      turnAcceptance,
      turnSettlement,
      userId,
      workspaceId,
    });
  }

  if (persistencePlan.type === "update") {
    const updateResult = await safeDb(async (tx) => {
      if (
        !(await reserveChatTurnAcceptanceOnTx({
          acceptance: turnAcceptance,
          tx,
        }))
      ) {
        return false;
      }
      await applyChatDataScopeExpansionOnTx({
        expansion: dataScopeExpansion,
        recordAuditEvent,
        threadId,
        tx,
        workspaceId,
      });
      await applyChatDataScopeReplacementOnTx({
        recordAuditEvent,
        replacement: dataScopeReplacement,
        threadId,
        tx,
        workspaceId,
      });
      if (deleteMessageIds.length > 0) {
        await tx
          .delete(chatMessages)
          .where(
            and(
              eq(chatMessages.threadId, threadId),
              inArray(chatMessages.id, deleteMessageIds),
            ),
          );

        // One truncation is one audit group: the deletions are recorded
        // together so they share a single groupId.
        await recordAuditEvent(
          tx,
          deleteMessageIds.map((deletedMessageId) => ({
            action: AUDIT_ACTION.DELETE,
            resourceType: AUDIT_RESOURCE_TYPE.CHAT_MESSAGE,
            resourceId: deletedMessageId,
            workspaceId,
            metadata: { threadId, reason: "truncate_for_replay" },
          })),
        );
      }

      if (
        shouldInvalidateChatCompactionCheckpoint({
          deletedMessageCount: deleteMessageIds.length,
          persistencePlan,
        })
      ) {
        await invalidateChatCompactionChain({ threadId, tx });
      }

      const updatedMessageId = persistencePlan.messageId;
      await tx
        .update(chatMessages)
        .set({
          role: persistencePlan.message.role,
          content: chatMessageContentFromMessage(persistencePlan.message),
          ...(!env.FEATURE_AI_MEMORY && { memoryExtractionEligible: false }),
        })
        .where(eq(chatMessages.id, updatedMessageId));
      await tx
        .update(chatThreads)
        .set({
          updatedAt: new Date(),
          ...(shouldMarkThreadUsedAnonymization({
            messages: [persistencePlan.message],
            sendMode: acceptedSendMode,
          })
            ? { usedAnonymization: true }
            : {}),
        })
        .where(eq(chatThreads.id, threadId));

      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.CHAT_MESSAGE,
        resourceId: updatedMessageId,
        workspaceId,
        metadata: { threadId, role: persistencePlan.message.role },
      });
      await applyChatTurnWritesOnTx({
        acceptance: turnAcceptance,
        settlement: turnSettlement,
        tx,
      });
      return true;
    });

    return updateResult.andThen((updated) =>
      updated
        ? Result.ok()
        : Result.err(
            new HandlerError({
              status: 409,
              message: "A chat turn is already running",
            }),
          ),
    );
  }

  if (persistencePlan.type === "none") {
    // A turn accepted in anonymized send mode marks the thread even when it
    // writes no message (a resend of an already-persisted user message):
    // readers gate raw-content reuse on that mark, so it must not depend on
    // which persistence plan the turn happened to take.
    const marksUsedAnonymization = shouldMarkThreadUsedAnonymization({
      messages: [],
      sendMode: acceptedSendMode,
    });
    if (
      turnAcceptance === undefined &&
      turnSettlement === undefined &&
      !marksUsedAnonymization
    ) {
      return Result.ok();
    }
    const turnResult = await safeDb(async (tx) => {
      if (
        !(await reserveChatTurnAcceptanceOnTx({
          acceptance: turnAcceptance,
          tx,
        }))
      ) {
        return false;
      }
      await applyChatDataScopeExpansionOnTx({
        expansion: dataScopeExpansion,
        recordAuditEvent,
        threadId,
        tx,
        workspaceId,
      });
      if (marksUsedAnonymization) {
        // audit: skip — thread-level turn bookkeeping. The sibling plans
        // leave the same chat_threads mark unaudited and audit the message
        // rows they write; this plan writes no message row.
        await tx
          .update(chatThreads)
          .set({ usedAnonymization: true })
          .where(eq(chatThreads.id, threadId));
      }
      await applyChatTurnWritesOnTx({
        acceptance: turnAcceptance,
        settlement: turnSettlement,
        tx,
      });
      return true;
    });
    return turnResult.andThen((written) =>
      written
        ? Result.ok()
        : Result.err(
            new HandlerError({
              status: 409,
              message: "A chat turn is already running",
            }),
          ),
    );
  }

  const replaceResult = await safeDb(async (tx) => {
    if (
      !(await reserveChatTurnAcceptanceOnTx({
        acceptance: turnAcceptance,
        tx,
      }))
    ) {
      return false;
    }
    await applyChatDataScopeExpansionOnTx({
      expansion: dataScopeExpansion,
      recordAuditEvent,
      threadId,
      tx,
      workspaceId,
    });
    const deletedMessageId = persistencePlan.deleteMessageId;
    await tx
      .delete(chatMessages)
      .where(
        and(
          eq(chatMessages.id, deletedMessageId),
          eq(chatMessages.threadId, threadId),
        ),
      );

    if (
      shouldInvalidateChatCompactionCheckpoint({
        deletedMessageCount: 1,
        persistencePlan,
      })
    ) {
      await invalidateChatCompactionChain({ threadId, tx });
    }

    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.DELETE,
      resourceType: AUDIT_RESOURCE_TYPE.CHAT_MESSAGE,
      resourceId: deletedMessageId,
      workspaceId,
      metadata: { threadId, reason: "delete_and_reinsert" },
    });

    const insertedMessage = persistencePlan.insertMessage;
    await tx.insert(chatMessages).values({
      content: chatMessageContentFromMessage(insertedMessage),
      id: insertedMessage.id,
      role: insertedMessage.role,
      threadId,
      userId,
      workspaceId,
      memoryExtractionEligible: env.FEATURE_AI_MEMORY,
    });
    await tx
      .update(chatThreads)
      .set({
        updatedAt: new Date(),
        ...(shouldMarkThreadUsedAnonymization({
          messages: [insertedMessage],
          sendMode: acceptedSendMode,
        })
          ? { usedAnonymization: true }
          : {}),
      })
      .where(eq(chatThreads.id, threadId));
    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.CREATE,
      resourceType: AUDIT_RESOURCE_TYPE.CHAT_MESSAGE,
      resourceId: insertedMessage.id,
      workspaceId,
      metadata: { threadId, role: insertedMessage.role },
    });
    await applyChatTurnWritesOnTx({
      acceptance: turnAcceptance,
      settlement: turnSettlement,
      tx,
    });
    return true;
  });

  return replaceResult.andThen((replaced) =>
    replaced
      ? Result.ok()
      : Result.err(
          new HandlerError({
            status: 409,
            message: "A chat turn is already running",
          }),
        ),
  );
};

type PersistClaimedReplayMessageProps = PersistMessageProps & {
  claim: ChatTurnExecutionClaim;
  persistencePlan: Extract<MessagePersistencePlan, { type: "update" }>;
};

const safeDbOnTransaction = (tx: Transaction): SafeDb =>
  async function transactionSafeDb(operation) {
    return Result.ok(await operation(tx));
  };

type PersistAcceptedMessageWithClaimProps = PersistMessageProps & {
  turnAcceptance: ChatTurnAcceptance;
};

/**
 * Persist a new user message, create its durable turn, and claim execution
 * before releasing the thread lock. No other sender can observe and supersede
 * an accepted-but-unclaimed turn between these operations.
 */
export const persistAcceptedMessageWithClaim = async ({
  safeDb,
  turnAcceptance,
  ...persistenceProps
}: PersistAcceptedMessageWithClaimProps): Promise<
  Result<ChatTurnExecution, HandlerError<409> | SafeDbError>
> => {
  const result = await safeDb(async (tx) => {
    const persistenceResult = await runPersistMessage({
      ...persistenceProps,
      safeDb: safeDbOnTransaction(tx),
      turnAcceptance,
    });
    if (Result.isError(persistenceResult)) {
      return Result.err(persistenceResult.error);
    }

    const execution = await claimChatTurnForExecutionOnTx({
      acceptedTurnId: turnAcceptance.id,
      incomingMessageId: turnAcceptance.userMessageId,
      incomingMessageRole: "user",
      organizationId: turnAcceptance.organizationId,
      threadId: turnAcceptance.threadId,
      tx,
      userId: turnAcceptance.userId,
      workspaceId: turnAcceptance.workspaceId,
    });
    if (execution === null) {
      panic("Newly accepted chat turn lost execution ownership");
    }
    return Result.ok(execution);
  });
  if (Result.isError(result)) {
    return Result.err(result.error);
  }
  if (Result.isError(result.value)) {
    return Result.err(result.value.error);
  }
  (persistenceProps.indexThread ?? upsertChatThreadSearchDocument)(
    persistenceProps.threadId,
  ).catch(captureError);
  return Result.ok(result.value.value);
};

/**
 * Claim an interactive replay and mutate its existing assistant message on one
 * transaction. `withClaimedChatTurnExecution` never invokes the mutation for a
 * stale or duplicate claim, so truncation cannot race turn ownership.
 */
export const persistClaimedReplayMessage = async ({
  claim,
  safeDb,
  ...persistenceProps
}: PersistClaimedReplayMessageProps): Promise<
  Result<ChatTurnExecution | null, SafeDbError>
> => {
  const result = await withClaimedChatTurnExecution({
    claim,
    safeDb,
    mutate: async ({ tx }) => {
      const persistenceResult = await runPersistMessage({
        ...persistenceProps,
        safeDb: safeDbOnTransaction(tx),
      });
      if (Result.isError(persistenceResult)) {
        throw persistenceResult.error;
      }
    },
  });
  if (Result.isError(result)) {
    return Result.err(result.error);
  }
  if (result.value === null) {
    return Result.ok(null);
  }
  (persistenceProps.indexThread ?? upsertChatThreadSearchDocument)(
    persistenceProps.threadId,
  ).catch(captureError);
  return Result.ok(result.value.execution);
};
