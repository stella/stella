import type { Result } from "better-result";
import { panic } from "better-result";
import { and, desc, eq, inArray, isNull, lte } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { chatMessages, chatTurns } from "@/api/db/schema";
import type { ChatTurnFailureCode } from "@/api/handlers/chat/chat-turn-state";
import type {
  ChatTurnOutcome,
  ChatMessageRole,
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
  loop_detected: false,
  model_unavailable: false,
  provider_billing: false,
  provider_unavailable: true,
  quota_exhausted: true,
  unknown: true,
} as const satisfies Record<AIErrorKind, boolean>;

export type ChatTurnAcceptance = {
  id: SafeId<"chatTurn">;
  leaseExpiresAt: Date;
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

const nextChatTurnLeaseExpiry = (): Date =>
  new Date(Date.now() + CHAT_TURN_LEASE_MS);

export const createChatTurnAcceptance = ({
  organizationId,
  threadId,
  userId,
  userMessageId,
  workspaceId,
}: Omit<ChatTurnAcceptance, "id" | "leaseExpiresAt">): ChatTurnAcceptance => ({
  id: createSafeId<"chatTurn">(),
  leaseExpiresAt: nextChatTurnLeaseExpiry(),
  organizationId,
  threadId,
  userId,
  userMessageId,
  workspaceId,
});

/**
 * Store acceptance in the caller's message transaction. Superseding an old
 * active turn and accepting its replacement are one write boundary, so the
 * per-thread active-turn uniqueness constraint never observes two owners.
 */
export const insertChatTurnAcceptanceOnTx = async ({
  acceptance,
  tx,
}: {
  acceptance: ChatTurnAcceptance;
  tx: Transaction;
}): Promise<void> => {
  const now = new Date();
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
        inArray(chatTurns.status, ["accepted", "running", "awaiting-user"]),
      ),
    );

  // audit: skip — internal turn coordination; the user message mutation is audited in this transaction
  await tx.insert(chatTurns).values({
    id: acceptance.id,
    leaseExpiresAt: acceptance.leaseExpiresAt,
    organizationId: acceptance.organizationId,
    status: "accepted",
    threadId: acceptance.threadId,
    userId: acceptance.userId,
    userMessageId: acceptance.userMessageId,
    workspaceId: acceptance.workspaceId,
  });
};

export type ChatTurnExecutionClaim = {
  acceptedTurnId: SafeId<"chatTurn"> | null;
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
  incomingMessageId,
  incomingMessageRole,
  organizationId,
  threadId,
  tx,
  userId,
  workspaceId,
}: ClaimChatTurnForExecutionOnTxProps): Promise<ChatTurnExecution | null> => {
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
    const awaiting = await tx.query.chatTurns.findFirst({
      where: {
        assistantMessageId: { eq: incomingMessageId },
        status: { eq: "awaiting-user" },
        threadId: { eq: threadId },
      },
      columns: { id: true },
    });
    source = awaiting
      ? { executionId: null, id: awaiting.id, status: "awaiting-user" }
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
            lte(chatTurns.leaseExpiresAt, new Date()),
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
}): Promise<Result<boolean, SafeDbError>> =>
  await safeDb(async (tx) => {
    // audit: skip — ephemeral execution ownership; terminal state is audited at settlement
    const renewed = await tx
      .update(chatTurns)
      .set({ leaseExpiresAt: nextChatTurnLeaseExpiry() })
      .where(
        and(
          eq(chatTurns.id, execution.id),
          eq(chatTurns.executionId, execution.executionId),
          eq(chatTurns.status, "running"),
        ),
      )
      .returning({ id: chatTurns.id });
    return renewed.length === 1;
  });

type SettleChatTurnProps = {
  assistantMessageId: SafeId<"chatMessage"> | null;
  execution: ChatTurnExecution;
  outcome: ChatTurnOutcome;
  tx: Transaction;
};

/**
 * Compare-and-set one running execution to exactly one durable outcome.
 * Returns false for a stale/double settlement; callers must fail the enclosing
 * transaction instead of acknowledging an unowned result.
 */
export const settleChatTurnOnTx = async ({
  assistantMessageId,
  execution,
  outcome,
  tx,
}: SettleChatTurnProps): Promise<boolean> => {
  const settledAt = new Date();
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
        return {
          ...base,
          assistantMessageId: null,
          failureCode: "provider-error" as const,
          failureRetryable: AI_ERROR_RETRYABLE[outcome.error],
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
        return outcome satisfies never;
    }
  })();

  if (values === null) {
    return false;
  }

  // audit: skip — internal lifecycle settlement; the assistant message mutation is audited in this transaction
  const updated = await tx
    .update(chatTurns)
    .set(values)
    .where(
      and(
        eq(chatTurns.id, execution.id),
        eq(chatTurns.executionId, execution.executionId),
        eq(chatTurns.status, "running"),
      ),
    )
    .returning({ id: chatTurns.id });
  return updated.length === 1;
};

export const failChatTurnExecution = async ({
  code,
  execution,
  retryable,
  safeDb,
}: {
  code: ChatTurnFailureCode;
  execution: ChatTurnExecution;
  retryable: boolean;
  safeDb: SafeDb;
}): Promise<Result<boolean, SafeDbError>> =>
  await safeDb(async (tx) => {
    // audit: skip — failure settlement is the durable record for a turn with no assistant message
    const updated = await tx
      .update(chatTurns)
      .set({
        assistantMessageId: null,
        cancellationReason: null,
        executionId: null,
        failureCode: code,
        failureRetryable: retryable,
        interactionToolCallId: null,
        interactionType: null,
        interruptionReason: null,
        leaseExpiresAt: null,
        settledAt: new Date(),
        status: "failed",
      })
      .where(
        and(
          eq(chatTurns.id, execution.id),
          eq(chatTurns.executionId, execution.executionId),
          eq(chatTurns.status, "running"),
        ),
      )
      .returning({ id: chatTurns.id });
    return updated.length === 1;
  });
