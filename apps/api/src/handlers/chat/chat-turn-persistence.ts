import type { Result } from "better-result";
import { panic, TaggedError } from "better-result";
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  sql,
} from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { chatMessages, chatThreads, chatTurns } from "@/api/db/schema";
import {
  attachTerminalTurnOutcome,
  cancelPendingChatToolCalls,
  chatMessageContentFromMessage,
  chatMessageFromPersisted,
  getAwaitingUserInteractions,
} from "@/api/handlers/chat/chat-message-parts";
import { settleOpenToolCallsForOutcome } from "@/api/handlers/chat/chat-turn-settlement";
import {
  chatTurnViewOf,
  planChatTurnTransition,
} from "@/api/handlers/chat/chat-turn-state";
import type {
  ChatTurnCancellationReason,
  ChatTurnFailureCode,
  ChatTurnInteractionType,
  ChatTurnState,
  ChatTurnView,
} from "@/api/handlers/chat/chat-turn-state";
import type {
  ChatTurnOutcome,
  ChatMessageRole,
  PersistableChatMessage,
  PersistableTerminalAssistantMessage,
} from "@/api/handlers/chat/types";
import type { AIErrorKind } from "@/api/lib/ai-error";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";

/** Maximum time a metered provider call may run before the server aborts it. */
export const CHAT_METERED_PROVIDER_TIMEOUT_MS = 10 * 60 * 1000;

// The provider timeout begins after preflight and connector setup. Retain an
// additional hand-off window so a still-live provider call cannot lose its
// execution owner at the same instant its timeout fires.
const CHAT_TURN_PROVIDER_LEASE_GRACE_MS = 2 * 60 * 1000;
const CHAT_TURN_LEASE_MS =
  CHAT_METERED_PROVIDER_TIMEOUT_MS + CHAT_TURN_PROVIDER_LEASE_GRACE_MS;

const AI_ERROR_RETRYABLE = {
  empty_completion: true,
  loop_detected: false,
  model_unavailable: false,
  provider_billing: false,
  provider_credentials_rejected: false,
  provider_stream_incomplete: true,
  provider_unavailable: true,
  quota_exhausted: true,
  unknown: true,
} as const satisfies Record<AIErrorKind, boolean>;

export type ChatTurnAcceptance = {
  id: SafeId<"chatTurn">;
  organizationId: SafeId<"organization">;
  threadId: SafeId<"chatThread">;
  userId: SafeId<"user">;
  userMessageId: SafeId<"chatMessage">;
  workspaceId: SafeId<"workspace"> | null;
};

export type ChatTurnExecution = {
  executionId: string;
  id: SafeId<"chatTurn">;
};

/** How a turn the user stopped ends. */
export const USER_STOP_OUTCOME = {
  reason: "user-stop",
  type: "cancelled",
} as const satisfies ChatTurnOutcome;

/**
 * Thrown inside a settlement transaction when a stop request committed
 * before the owner's own outcome: the transaction rolls back and the owner
 * settles again as the user's stop.
 */
export class ChatTurnStopRequestedError extends TaggedError(
  "ChatTurnStopRequestedError",
)<{
  message: string;
}> {}

/**
 * Turn timestamps participate in database check constraints with `created_at`.
 * Generate them on the database too: API worker clocks are not an authority for
 * a row whose creation and settlement are both enforced by PostgreSQL.
 */
const databaseNow = () => sql<Date>`now()`;

const nextChatTurnLeaseExpiry = () =>
  sql<Date>`now() + ${CHAT_TURN_LEASE_MS} * interval '1 millisecond'`;

export const createChatTurnAcceptance = ({
  organizationId,
  threadId,
  userId,
  userMessageId,
  workspaceId,
}: Omit<ChatTurnAcceptance, "id">): ChatTurnAcceptance => ({
  id: createSafeId<"chatTurn">(),
  organizationId,
  threadId,
  userId,
  userMessageId,
  workspaceId,
});

const lockChatThreadForTurnOnTx = async ({
  threadId,
  tx,
}: {
  threadId: SafeId<"chatThread">;
  tx: Transaction;
}): Promise<boolean> => {
  const locked = await tx
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .for("update");
  return locked.length === 1;
};

/**
 * Store the terminal form of an assistant message whose turn the server ended
 * (superseded, or its owner gone), in the transaction that ends the turn.
 */
const storeServerEndedMessageOnTx = async ({
  message,
  threadId,
  tx,
}: {
  message: PersistableTerminalAssistantMessage;
  threadId: SafeId<"chatThread">;
  tx: Transaction;
}): Promise<void> => {
  // audit: skip — this is the server-owned counterpart of the turn transition written in the same transaction
  await tx
    .update(chatMessages)
    .set({ content: chatMessageContentFromMessage(message) })
    .where(
      and(eq(chatMessages.id, message.id), eq(chatMessages.threadId, threadId)),
    );
};

/**
 * A running turn owns no assistant row, so the message it resumed is the
 * thread's latest assistant message, stored when the continuation was
 * claimed. Its approved calls end with the run, as unfinished calls whose
 * outcome is unknown. A latest message with nothing to settle belongs to an
 * earlier turn and is left untouched.
 */
const settleInterruptedContinuationOnTx = async ({
  outcome,
  threadId,
  tx,
}: {
  outcome: Extract<ChatTurnOutcome, { type: "cancelled" | "interrupted" }>;
  threadId: SafeId<"chatThread">;
  tx: Transaction;
}): Promise<void> => {
  const latest = (
    await tx
      .select({
        content: chatMessages.content,
        id: chatMessages.id,
        role: chatMessages.role,
      })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.threadId, threadId),
          eq(chatMessages.role, "assistant"),
        ),
      )
      .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
      .limit(1)
  ).at(0);
  if (latest === undefined) {
    return;
  }
  const message = chatMessageFromPersisted(latest);
  const parts = settleOpenToolCallsForOutcome({
    outcome: outcome.type,
    parts: message.parts,
  });
  // Settling adds a result part per closed call; no new part, nothing to do.
  if (parts.length === message.parts.length) {
    return;
  }
  const settled = attachTerminalTurnOutcome({
    message: { ...message, parts },
    turnOutcome: outcome,
  });
  await storeServerEndedMessageOnTx({ message: settled, threadId, tx });
};

/**
 * Under the thread lock, turn an abandoned provider owner into its durable
 * terminal outcome. A live owner renews its lease conditionally, so it either
 * wins that renewal before this write (and remains running), or loses it after
 * this write (and can no longer settle effects it no longer owns).
 */
const interruptExpiredRunningChatTurnOnTx = async ({
  threadId,
  tx,
}: {
  threadId: SafeId<"chatThread">;
  tx: Transaction;
}): Promise<void> => {
  const now = databaseNow();
  const expired = and(
    eq(chatTurns.threadId, threadId),
    eq(chatTurns.status, "running"),
    // oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison -- cutoff read from the caller's clock, never round-tripped through the database
    lte(chatTurns.leaseExpiresAt, now),
  );
  const ended = {
    assistantMessageId: null,
    executionId: null,
    failureCode: null,
    failureRetryable: null,
    interactionToolCallId: null,
    interactionType: null,
    leaseExpiresAt: null,
    settledAt: now,
  } as const;
  // A stop the user requested before the owner vanished is how the turn
  // ended; the lease running out only reports it.
  // audit: skip — timeout terminalization records that an execution lease ended; no user-authored content changes
  const stopped = await tx
    .update(chatTurns)
    .set({
      ...ended,
      cancellationReason: USER_STOP_OUTCOME.reason,
      interruptionReason: null,
      status: "cancelled",
    })
    .where(and(expired, isNotNull(chatTurns.cancelRequestedAt)))
    .returning({ id: chatTurns.id });
  if (stopped.length > 0) {
    await settleInterruptedContinuationOnTx({
      outcome: USER_STOP_OUTCOME,
      threadId,
      tx,
    });
    return;
  }
  // audit: skip — timeout terminalization records that an execution lease ended; no user-authored content changes
  const interrupted = await tx
    .update(chatTurns)
    .set({
      ...ended,
      cancellationReason: null,
      interruptionReason: "timeout",
      status: "interrupted",
    })
    .where(and(expired, isNull(chatTurns.cancelRequestedAt)))
    .returning({ id: chatTurns.id });
  if (interrupted.length > 0) {
    await settleInterruptedContinuationOnTx({
      outcome: { reason: "timeout", type: "interrupted" },
      threadId,
      tx,
    });
  }
};

/**
 * Lock the thread before a caller writes its new user message. A running turn
 * cannot be superseded while its lease is live. Once its lease expires, end it
 * atomically under the same lock so it cannot block every future message.
 */
export const canAcceptChatTurnOnTx = async ({
  threadId,
  tx,
}: {
  threadId: SafeId<"chatThread">;
  tx: Transaction;
}): Promise<boolean> => {
  if (!(await lockChatThreadForTurnOnTx({ threadId, tx }))) {
    return false;
  }
  await interruptExpiredRunningChatTurnOnTx({ threadId, tx });
  const running = await tx.query.chatTurns.findFirst({
    where: {
      status: { eq: "running" },
      threadId: { eq: threadId },
    },
    columns: { id: true },
  });
  return running === undefined;
};

/**
 * A pending human interaction is represented twice: its owning turn protects
 * execution ownership, while the assistant message is what reload hydration
 * renders. Superseding only the turn leaves that canonical message inviting an
 * action the server can no longer accept. Terminalize both in this transaction
 * so a reload cannot resurrect a stale approval or question.
 */
export const cancelAwaitingAssistantMessage = ({
  message,
  reason,
}: {
  message: PersistableChatMessage;
  reason: ChatTurnCancellationReason;
}): PersistableTerminalAssistantMessage => {
  const cancelled = cancelPendingChatToolCalls(message);
  return attachTerminalTurnOutcome({
    message: {
      ...cancelled,
      parts: settleOpenToolCallsForOutcome({
        outcome: "cancelled",
        parts: cancelled.parts,
      }),
    },
    turnOutcome: { reason, type: "cancelled" },
  });
};

/** Store `cancelAwaitingAssistantMessage` for the awaiting turn `turnId`. */
const cancelAwaitingAssistantMessageOnTx = async ({
  reason,
  threadId,
  turnId,
  tx,
}: {
  reason: ChatTurnCancellationReason;
  threadId: SafeId<"chatThread">;
  turnId: SafeId<"chatTurn">;
  tx: Transaction;
}): Promise<PersistableTerminalAssistantMessage | undefined> => {
  const awaitingMessage = (
    await tx
      .select({
        content: chatMessages.content,
        id: chatMessages.id,
        role: chatMessages.role,
      })
      .from(chatTurns)
      .innerJoin(
        chatMessages,
        and(
          eq(chatMessages.id, chatTurns.assistantMessageId),
          eq(chatMessages.threadId, chatTurns.threadId),
        ),
      )
      .where(
        and(
          eq(chatTurns.id, turnId),
          eq(chatTurns.threadId, threadId),
          eq(chatTurns.status, "awaiting-user"),
        ),
      )
      .limit(1)
  ).at(0);

  if (awaitingMessage === undefined) {
    return undefined;
  }
  if (awaitingMessage.role !== "assistant") {
    panic("Awaiting chat turn does not own an assistant message");
  }
  const cancelledMessage = cancelAwaitingAssistantMessage({
    message: chatMessageFromPersisted(awaitingMessage),
    reason,
  });
  await storeServerEndedMessageOnTx({
    message: cancelledMessage,
    threadId,
    tx,
  });
  return cancelledMessage;
};

/**
 * Whether a turn was accepted and, when accepting it superseded an awaiting
 * assistant message, that message as it is now stored.
 */
export type ChatTurnAcceptanceResult =
  | { type: "refused" }
  | {
      superseded: PersistableTerminalAssistantMessage | undefined;
      type: "accepted";
    };

/**
 * Store acceptance in the caller's message transaction. A pending interaction
 * may be replaced, but a running turn is never superseded: its provider and
 * tool side effects still belong to a live execution. A refusal leaves the
 * entire caller transaction to roll back before the new message is saved.
 */
export const insertChatTurnAcceptanceOnTx = async ({
  acceptance,
  tx,
}: {
  acceptance: ChatTurnAcceptance;
  tx: Transaction;
}): Promise<ChatTurnAcceptanceResult> => {
  const now = databaseNow();
  // The caller normally reserved this lock before persisting the user
  // message. Keep the check here too so direct callers retain the invariant.
  if (!(await canAcceptChatTurnOnTx({ threadId: acceptance.threadId, tx }))) {
    return { type: "refused" };
  }
  const awaiting = await tx.query.chatTurns.findFirst({
    where: {
      status: { eq: "awaiting-user" },
      threadId: { eq: acceptance.threadId },
    },
    columns: { id: true },
  });
  const superseded =
    awaiting === undefined
      ? undefined
      : await cancelAwaitingAssistantMessageOnTx({
          reason: "superseded",
          threadId: acceptance.threadId,
          turnId: awaiting.id,
          tx,
        });
  // audit: skip — internal turn coordination; the user message mutation is audited in this transaction
  await tx
    .update(chatTurns)
    .set({
      assistantMessageId: null,
      cancellationReason: "superseded",
      executionId: null,
      failureCode: null,
      failureRetryable: null,
      interactionToolCallId: null,
      interactionType: null,
      interruptionReason: null,
      leaseExpiresAt: null,
      settledAt: now,
      status: "cancelled",
    })
    .where(
      and(
        eq(chatTurns.threadId, acceptance.threadId),
        inArray(chatTurns.status, ["accepted", "awaiting-user"]),
      ),
    );

  // audit: skip — internal turn coordination; the user message mutation is audited in this transaction
  const inserted = await tx
    .insert(chatTurns)
    .values({
      id: acceptance.id,
      leaseExpiresAt: nextChatTurnLeaseExpiry(),
      organizationId: acceptance.organizationId,
      status: "accepted",
      threadId: acceptance.threadId,
      userId: acceptance.userId,
      userMessageId: acceptance.userMessageId,
      workspaceId: acceptance.workspaceId,
    })
    .onConflictDoNothing()
    .returning({ id: chatTurns.id });
  return inserted.length === 1
    ? { superseded, type: "accepted" }
    : { type: "refused" };
};

const readChatTurnOnTx = async ({
  threadId,
  turnId,
  tx,
}: {
  threadId: SafeId<"chatThread">;
  turnId: SafeId<"chatTurn">;
  tx: Transaction;
}) =>
  (
    await tx
      .select({
        assistantMessageId: chatTurns.assistantMessageId,
        cancellationReason: chatTurns.cancellationReason,
        executionId: chatTurns.executionId,
        failureCode: chatTurns.failureCode,
        failureRetryable: chatTurns.failureRetryable,
        id: chatTurns.id,
        interactionToolCallId: chatTurns.interactionToolCallId,
        interactionType: chatTurns.interactionType,
        interruptionReason: chatTurns.interruptionReason,
        leaseExpiresAt: chatTurns.leaseExpiresAt,
        settledAt: chatTurns.settledAt,
        status: chatTurns.status,
        threadId: chatTurns.threadId,
        userMessageId: chatTurns.userMessageId,
      })
      .from(chatTurns)
      .where(and(eq(chatTurns.id, turnId), eq(chatTurns.threadId, threadId)))
      .limit(1)
  ).at(0);

type ChatTurnRow = NonNullable<Awaited<ReturnType<typeof readChatTurnOnTx>>>;

/**
 * The state a row holds. `chat_turns_state_payload_check` guarantees each
 * status its columns, so a missing one is a broken invariant.
 */
const chatTurnStateFromRow = (row: ChatTurnRow): ChatTurnState => {
  const present = <T>(value: T | null, column: string): T =>
    value ?? panic(`A ${row.status} chat turn has no ${column}`);
  switch (row.status) {
    case "accepted":
      return {
        id: row.id,
        leaseExpiresAt: present(row.leaseExpiresAt, "lease"),
        status: row.status,
        threadId: row.threadId,
        userMessageId: row.userMessageId,
      };
    case "running":
      return {
        executionId: present(row.executionId, "execution"),
        id: row.id,
        leaseExpiresAt: present(row.leaseExpiresAt, "lease"),
        status: row.status,
        threadId: row.threadId,
        userMessageId: row.userMessageId,
      };
    case "awaiting-user":
      return {
        assistantMessageId: present(row.assistantMessageId, "message"),
        id: row.id,
        interaction: {
          toolCallId: present(row.interactionToolCallId, "interaction"),
          type: present(row.interactionType, "interaction type"),
        },
        status: row.status,
        threadId: row.threadId,
        userMessageId: row.userMessageId,
      };
    case "completed":
      return {
        assistantMessageId: present(row.assistantMessageId, "message"),
        completedAt: present(row.settledAt, "settlement time"),
        id: row.id,
        status: row.status,
        threadId: row.threadId,
        userMessageId: row.userMessageId,
      };
    case "failed":
      return {
        assistantMessageId: present(row.assistantMessageId, "message"),
        failedAt: present(row.settledAt, "settlement time"),
        failure: {
          code: present(row.failureCode, "failure code"),
          retryable: present(row.failureRetryable, "retry flag"),
        },
        id: row.id,
        status: row.status,
        threadId: row.threadId,
        userMessageId: row.userMessageId,
      };
    case "cancelled":
      return {
        cancelledAt: present(row.settledAt, "settlement time"),
        id: row.id,
        reason: present(row.cancellationReason, "cancellation reason"),
        status: row.status,
        threadId: row.threadId,
        userMessageId: row.userMessageId,
      };
    case "interrupted":
      return {
        id: row.id,
        interruptedAt: present(row.settledAt, "settlement time"),
        reason: present(row.interruptionReason, "interruption reason"),
        status: row.status,
        threadId: row.threadId,
        userMessageId: row.userMessageId,
      };
    default:
      row.status satisfies never;
      return panic(`Unhandled status: ${String(row.status)}`);
  }
};

/** What a stop request found and did, as the turn now stands. */
type ChatTurnStop =
  | { type: "not-found" }
  /** The turn is settled: by this request, or already before it. */
  | { turn: ChatTurnView; type: "settled" }
  /** The turn is running; its owner settles it on the recorded request. */
  | { executionId: string; turn: ChatTurnView; type: "requested" };

/**
 * End a turn no execution owns (accepted, or awaiting the user) as the
 * user's stop, message and turn together. Both statuses change only under
 * the thread lock the caller holds, so the compare-and-set cannot lose.
 */
const stopUnownedChatTurnOnTx = async ({
  state,
  tx,
}: {
  state: Extract<ChatTurnState, { status: "accepted" | "awaiting-user" }>;
  tx: Transaction;
}): Promise<ChatTurnView> => {
  const planned = planChatTurnTransition(state, {
    // The stored time is the database's; the plan decides legality and the
    // state reported back.
    cancelledAt: new Date(),
    reason: USER_STOP_OUTCOME.reason,
    type: "cancel",
  });
  if (planned.type === "rejected" || planned.state.status !== "cancelled") {
    return panic(`A stop cannot end a ${state.status} chat turn`);
  }
  if (state.status === "awaiting-user") {
    await cancelAwaitingAssistantMessageOnTx({
      reason: planned.state.reason,
      threadId: state.threadId,
      turnId: state.id,
      tx,
    });
  }
  const now = databaseNow();
  // audit: skip — internal turn coordination, as when a new message supersedes the turn
  const stopped = await tx
    .update(chatTurns)
    .set({
      assistantMessageId: null,
      cancellationReason: planned.state.reason,
      cancelRequestedAt: now,
      executionId: null,
      failureCode: null,
      failureRetryable: null,
      interactionToolCallId: null,
      interactionType: null,
      interruptionReason: null,
      leaseExpiresAt: null,
      settledAt: now,
      status: planned.state.status,
    })
    .where(and(eq(chatTurns.id, state.id), eq(chatTurns.status, state.status)))
    .returning({ id: chatTurns.id });
  if (stopped.length !== 1) {
    return panic("A chat turn changed status under its thread lock");
  }
  // The thread's revision tells a page its transcript changed in place, so it
  // rebuilds from the stored thread instead of keeping its own copy.
  // audit: skip — revision bump for the turn transition above
  await tx
    .update(chatThreads)
    .set({ updatedAt: new Date() })
    .where(eq(chatThreads.id, state.threadId));
  return chatTurnViewOf(planned.state);
};

const requestedStop = (
  state: Extract<ChatTurnState, { status: "running" }>,
): ChatTurnStop => ({
  executionId: state.executionId,
  turn: chatTurnViewOf(state),
  type: "requested",
});

/**
 * Record the first stop request on a running turn. Its owner settles it (see
 * `settleChatTurnOnTx`), so this never writes a status. A repeated request
 * keeps the first time.
 */
const requestRunningChatTurnStopOnTx = async ({
  state,
  tx,
}: {
  state: Extract<ChatTurnState, { status: "running" }>;
  tx: Transaction;
}): Promise<ChatTurnStop> => {
  // audit: skip — records the stop request; the owner's settlement audits the message it stores
  const recorded = await tx
    .update(chatTurns)
    .set({ cancelRequestedAt: databaseNow() })
    .where(
      and(
        eq(chatTurns.id, state.id),
        eq(chatTurns.status, "running"),
        isNull(chatTurns.cancelRequestedAt),
      ),
    )
    .returning({ id: chatTurns.id });
  if (recorded.length === 1) {
    return requestedStop(state);
  }
  // Either an earlier request is recorded, or the owner settled first: its
  // settlement does not take the thread lock. Stop what stands now.
  const current = chatTurnStateFromRow(
    (await readChatTurnOnTx({
      threadId: state.threadId,
      turnId: state.id,
      tx,
    })) ?? panic("A chat turn vanished under its thread lock"),
  );
  return current.status === "running"
    ? requestedStop(current)
    : await stopChatTurnStateOnTx({ state: current, tx });
};

const stopChatTurnStateOnTx = async ({
  state,
  tx,
}: {
  state: ChatTurnState;
  tx: Transaction;
}): Promise<ChatTurnStop> => {
  switch (state.status) {
    case "accepted":
    case "awaiting-user":
      return {
        turn: await stopUnownedChatTurnOnTx({ state, tx }),
        type: "settled",
      };
    case "running":
      return await requestRunningChatTurnStopOnTx({ state, tx });
    case "cancelled":
    case "completed":
    case "failed":
    case "interrupted":
      return { turn: chatTurnViewOf(state), type: "settled" };
    default:
      state satisfies never;
      return panic(`Unhandled state: ${String(state)}`);
  }
};

/**
 * The user's stop. Takes the thread lock first, as acceptance and
 * continuation claims do, so it serializes with every transition that is not
 * an owner's settlement. A turn outside `threadId`, or one RLS hides, is not
 * found. Idempotent: a settled turn is reported as it stands.
 */
export const stopChatTurnOnTx = async ({
  threadId,
  turnId,
  tx,
}: {
  threadId: SafeId<"chatThread">;
  turnId: SafeId<"chatTurn">;
  tx: Transaction;
}): Promise<ChatTurnStop> => {
  if (!(await lockChatThreadForTurnOnTx({ threadId, tx }))) {
    return { type: "not-found" };
  }
  const row = await readChatTurnOnTx({ threadId, turnId, tx });
  return row === undefined
    ? { type: "not-found" }
    : await stopChatTurnStateOnTx({ state: chatTurnStateFromRow(row), tx });
};

/** The turn as it stands, for a stop request reporting after its owner. */
export const readChatTurnView = async ({
  safeDb,
  threadId,
  turnId,
}: {
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
  turnId: SafeId<"chatTurn">;
}): Promise<Result<ChatTurnView | null, SafeDbError>> =>
  await safeDb(async (tx) => {
    const row = await readChatTurnOnTx({ threadId, turnId, tx });
    return row === undefined ? null : chatTurnViewOf(chatTurnStateFromRow(row));
  });

export type ChatTurnExecutionClaim = {
  acceptedTurnId: SafeId<"chatTurn"> | null;
  continuationInteraction?:
    | { toolCallId: string; type: ChatTurnInteractionType }
    | undefined;
  incomingMessageId: SafeId<"chatMessage">;
  incomingMessageRole: ChatMessageRole;
  organizationId: SafeId<"organization">;
  threadId: SafeId<"chatThread">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace"> | null;
};

type ClaimChatTurnForExecutionProps = ChatTurnExecutionClaim & {
  safeDb: SafeDb;
};

type ClaimChatTurnForExecutionOnTxProps = ChatTurnExecutionClaim & {
  tx: Transaction;
};

type ClaimSource = {
  executionId: string | null;
  id: SafeId<"chatTurn">;
  status: "accepted" | "awaiting-user" | "running";
};

/** Claim on the caller's transaction before any owned history mutation. */
export const claimChatTurnForExecutionOnTx = async ({
  acceptedTurnId,
  continuationInteraction,
  incomingMessageId,
  incomingMessageRole,
  organizationId,
  threadId,
  tx,
  userId,
  workspaceId,
}: ClaimChatTurnForExecutionOnTxProps): Promise<ChatTurnExecution | null> => {
  // Acceptance and replay claims serialize on the exact same thread row.
  // This prevents a new user turn from cancelling an awaiting interaction
  // between its validation and ownership claim.
  if (!(await lockChatThreadForTurnOnTx({ threadId, tx }))) {
    return null;
  }
  const executionId = Bun.randomUUIDv7();
  const leaseExpiresAt = nextChatTurnLeaseExpiry();

  let source: ClaimSource | null = null;
  if (acceptedTurnId !== null) {
    const accepted = await tx.query.chatTurns.findFirst({
      where: {
        id: { eq: acceptedTurnId },
        status: { eq: "accepted" },
        threadId: { eq: threadId },
      },
      columns: { id: true },
    });
    source = accepted
      ? { executionId: null, id: accepted.id, status: "accepted" }
      : null;
  } else if (incomingMessageRole === "assistant") {
    if (continuationInteraction === undefined) {
      return null;
    }
    const awaiting = await tx
      .select({ content: chatMessages.content, id: chatTurns.id })
      .from(chatTurns)
      .innerJoin(
        chatMessages,
        and(
          eq(chatMessages.id, chatTurns.assistantMessageId),
          eq(chatMessages.threadId, chatTurns.threadId),
        ),
      )
      .where(
        and(
          eq(chatTurns.assistantMessageId, incomingMessageId),
          eq(chatTurns.status, "awaiting-user"),
          eq(chatTurns.threadId, threadId),
        ),
      )
      .limit(1);
    const awaitingTurn = awaiting.at(0);
    const ownsContinuation =
      awaitingTurn !== undefined &&
      getAwaitingUserInteractions(
        chatMessageFromPersisted({
          content: awaitingTurn.content,
          id: incomingMessageId,
          role: "assistant",
        }),
      ).some(
        (interaction) =>
          interaction.toolCallId === continuationInteraction.toolCallId &&
          interaction.type === continuationInteraction.type,
      );
    source = ownsContinuation
      ? { executionId: null, id: awaitingTurn.id, status: "awaiting-user" }
      : null;
  } else {
    const accepted = await tx.query.chatTurns.findFirst({
      where: {
        status: { eq: "accepted" },
        threadId: { eq: threadId },
        userMessageId: { eq: incomingMessageId },
      },
      columns: { id: true },
    });
    if (accepted) {
      source = { executionId: null, id: accepted.id, status: "accepted" };
    } else {
      const expired = await tx
        .select({
          executionId: chatTurns.executionId,
          id: chatTurns.id,
        })
        .from(chatTurns)
        .where(
          and(
            eq(chatTurns.threadId, threadId),
            eq(chatTurns.userMessageId, incomingMessageId),
            eq(chatTurns.status, "running"),
            lte(chatTurns.leaseExpiresAt, databaseNow()),
          ),
        )
        .limit(1);
      const expiredTurn = expired.at(0);
      if (expiredTurn) {
        if (expiredTurn.executionId === null) {
          panic("Running chat turn has no execution owner");
        }
        source = {
          executionId: expiredTurn.executionId,
          id: expiredTurn.id,
          status: "running",
        };
      }
    }
  }

  if (!source) {
    const active = await tx.query.chatTurns.findFirst({
      where: {
        status: { in: ["accepted", "running", "awaiting-user"] },
        threadId: { eq: threadId },
      },
      columns: { id: true },
    });
    if (active) {
      return null;
    }

    const userMessageId =
      incomingMessageRole === "user"
        ? incomingMessageId
        : (
            await tx
              .select({ id: chatMessages.id })
              .from(chatMessages)
              .where(
                and(
                  eq(chatMessages.threadId, threadId),
                  eq(chatMessages.role, "user"),
                ),
              )
              .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
              .limit(1)
          ).at(0)?.id;
    if (userMessageId === undefined) {
      return null;
    }

    // Legacy adoption is only for messages that predate durable turns. A
    // retry of any already-owned message is a fixed point, including a
    // completed turn whose streamed response was lost by the client.
    const existingTurn = await tx.query.chatTurns.findFirst({
      where: {
        threadId: { eq: threadId },
        userMessageId: { eq: userMessageId },
      },
      columns: { id: true },
    });
    if (existingTurn) {
      return null;
    }

    const legacyTurnId = createSafeId<"chatTurn">();
    // audit: skip — deploy compatibility for a persisted pre-chat_turns message; later message settlement is audited
    await tx.insert(chatTurns).values({
      executionId,
      id: legacyTurnId,
      leaseExpiresAt,
      organizationId,
      status: "running",
      threadId,
      userId,
      userMessageId,
      workspaceId,
    });
    return { executionId, id: legacyTurnId };
  }

  const executionOwnershipPredicate =
    source.executionId === null
      ? isNull(chatTurns.executionId)
      : eq(chatTurns.executionId, source.executionId);
  // audit: skip — ephemeral execution ownership; durable message changes are audited at settlement
  const claimed = await tx
    .update(chatTurns)
    .set({
      assistantMessageId: null,
      executionId,
      interactionToolCallId: null,
      interactionType: null,
      leaseExpiresAt,
      status: "running",
    })
    .where(
      and(
        eq(chatTurns.id, source.id),
        eq(chatTurns.status, source.status),
        executionOwnershipPredicate,
      ),
    )
    .returning({ id: chatTurns.id });

  const row = claimed.at(0);
  return row ? { executionId, id: row.id } : null;
};

/** Claim an accepted turn, or resume the awaiting turn owning an assistant. */
export const claimChatTurnForExecution = async ({
  safeDb,
  ...claim
}: ClaimChatTurnForExecutionProps): Promise<
  Result<ChatTurnExecution | null, SafeDbError>
> =>
  await safeDb(
    async (tx) => await claimChatTurnForExecutionOnTx({ ...claim, tx }),
  );

type WithClaimedChatTurnExecutionProps<T> = {
  claim: ChatTurnExecutionClaim;
  mutate: (args: {
    execution: ChatTurnExecution;
    tx: Transaction;
  }) => Promise<T>;
  safeDb: SafeDb;
};

/**
 * Run a turn-owned mutation only after winning its claim, on the exact same
 * transaction. A rejected/duplicate claim never invokes `mutate`; a mutation
 * failure rolls the claim back with the rest of the transaction.
 */
export const withClaimedChatTurnExecution = async <T>({
  claim,
  mutate,
  safeDb,
}: WithClaimedChatTurnExecutionProps<T>): Promise<
  Result<{ execution: ChatTurnExecution; value: T } | null, SafeDbError>
> =>
  await safeDb(async (tx) => {
    const execution = await claimChatTurnForExecutionOnTx({ ...claim, tx });
    if (execution === null) {
      return null;
    }
    return { execution, value: await mutate({ execution, tx }) };
  });

/**
 * Extend a claimed execution immediately before dispatching provider work.
 * This conditional write makes the renewed lease a proof that the caller still
 * owns the turn, rather than trusting a lease calculated before connector
 * discovery and other preflight work.
 */
export const renewChatTurnExecutionLease = async ({
  execution,
  safeDb,
}: {
  execution: ChatTurnExecution;
  safeDb: SafeDb;
}): Promise<Result<ChatTurnExecutionStanding, SafeDbError>> =>
  await safeDb(async (tx) => {
    // audit: skip — ephemeral execution ownership; terminal state is audited at settlement
    const renewed = await tx
      .update(chatTurns)
      .set({ leaseExpiresAt: nextChatTurnLeaseExpiry() })
      .where(ownedByExecution(execution))
      .returning({ cancelRequestedAt: chatTurns.cancelRequestedAt });
    return standingOf(renewed.at(0));
  });

/**
 * Where an execution stands with its turn: still owning it, owning it with a
 * stop requested (it must end the turn), or no longer owning it.
 */
type ChatTurnExecutionStanding = "lost" | "owned" | "stop-requested";

const ownedByExecution = (execution: ChatTurnExecution) =>
  and(
    eq(chatTurns.id, execution.id),
    eq(chatTurns.executionId, execution.executionId),
    eq(chatTurns.status, "running"),
  );

const standingOf = (
  row: { cancelRequestedAt: Date | null } | undefined,
): ChatTurnExecutionStanding => {
  if (row === undefined) {
    return "lost";
  }
  return row.cancelRequestedAt === null ? "owned" : "stop-requested";
};

/**
 * Read an execution's standing without renewing its lease: how an owner on
 * one instance learns of a stop requested on another.
 */
export const readChatTurnExecutionStanding = async ({
  execution,
  safeDb,
}: {
  execution: ChatTurnExecution;
  safeDb: SafeDb;
}): Promise<Result<ChatTurnExecutionStanding, SafeDbError>> =>
  await safeDb(async (tx) => {
    const rows = await tx
      .select({ cancelRequestedAt: chatTurns.cancelRequestedAt })
      .from(chatTurns)
      .where(ownedByExecution(execution))
      .limit(1);
    return standingOf(rows.at(0));
  });

type SettleChatTurnProps = {
  assistantMessageId: SafeId<"chatMessage"> | null;
  execution: ChatTurnExecution;
  failureCode?: ChatTurnFailureCode | undefined;
  failureRetryable?: boolean | undefined;
  outcome: ChatTurnOutcome;
  tx: Transaction;
};

/**
 * How a settlement went: stored, refused because the user's stop committed
 * first (the owner must settle as that stop instead), or refused because the
 * execution no longer owns the turn.
 */
type ChatTurnSettlementResult = "not-owned" | "settled" | "stop-requested";

/**
 * Compare-and-set one running execution to exactly one durable outcome.
 * Anything but "settled" is a stale or overtaken settlement; callers must fail
 * the enclosing transaction instead of acknowledging it. The stop request and
 * this write both lock the turn row, so exactly one of them lands first.
 */
export const settleChatTurnOnTx = async ({
  assistantMessageId,
  execution,
  failureCode,
  failureRetryable,
  outcome,
  tx,
}: SettleChatTurnProps): Promise<ChatTurnSettlementResult> => {
  const settledAt = databaseNow();
  const base = {
    cancellationReason: null,
    executionId: null,
    leaseExpiresAt: null,
  } as const;

  const values = (() => {
    switch (outcome.type) {
      case "awaiting-user":
        if (assistantMessageId === null) {
          return null;
        }
        return {
          ...base,
          assistantMessageId,
          failureCode: null,
          failureRetryable: null,
          interactionToolCallId: outcome.interaction.toolCallId,
          interactionType: outcome.interaction.type,
          interruptionReason: null,
          settledAt: null,
          status: "awaiting-user" as const,
        };
      case "completed":
        if (assistantMessageId === null) {
          return null;
        }
        return {
          ...base,
          assistantMessageId,
          failureCode: null,
          failureRetryable: null,
          interactionToolCallId: null,
          interactionType: null,
          interruptionReason: null,
          settledAt,
          status: "completed" as const,
        };
      case "cancelled":
        return {
          ...base,
          assistantMessageId: null,
          cancellationReason: outcome.reason,
          failureCode: null,
          failureRetryable: null,
          interactionToolCallId: null,
          interactionType: null,
          interruptionReason: null,
          settledAt,
          status: "cancelled" as const,
        };
      case "failed":
        if (assistantMessageId === null) {
          return null;
        }
        return {
          ...base,
          assistantMessageId,
          failureCode: failureCode ?? "provider-error",
          failureRetryable:
            failureRetryable ?? AI_ERROR_RETRYABLE[outcome.error],
          interactionToolCallId: null,
          interactionType: null,
          interruptionReason: null,
          settledAt,
          status: "failed" as const,
        };
      case "interrupted":
        return {
          ...base,
          assistantMessageId: null,
          failureCode: null,
          failureRetryable: null,
          interactionToolCallId: null,
          interactionType: null,
          interruptionReason: outcome.reason,
          settledAt,
          status: "interrupted" as const,
        };
      default:
        outcome satisfies never;
        return panic(`Unhandled outcome: ${String(outcome)}`);
    }
  })();

  if (values === null) {
    return "not-owned";
  }

  const owned = ownedByExecution(execution);
  const isUserStop =
    outcome.type === "cancelled" && outcome.reason === USER_STOP_OUTCOME.reason;
  // audit: skip — internal lifecycle settlement; the assistant message mutation is audited in this transaction
  const updated = await tx
    .update(chatTurns)
    .set(values)
    .where(isUserStop ? owned : and(owned, isNull(chatTurns.cancelRequestedAt)))
    .returning({ id: chatTurns.id });
  if (updated.length === 1) {
    return "settled";
  }
  const stillOwned = await tx
    .select({ id: chatTurns.id })
    .from(chatTurns)
    .where(owned)
    .limit(1);
  return stillOwned.length === 1 ? "stop-requested" : "not-owned";
};
