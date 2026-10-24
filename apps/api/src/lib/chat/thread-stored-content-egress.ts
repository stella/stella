import { panic } from "better-result";

import { withLongRunningConnection } from "@/api/db/long-running-connection";
import type { Transaction } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";
import {
  withAggregateLock,
  withChatStoredContentEgressSessionLock,
} from "@/api/lib/db/aggregate-lock";

const CHAT_STORED_CONTENT_EGRESS_TIMEOUT_MS = 60_000;

type ThreadStoredContentEgressOptions<T> = {
  organizationId: SafeId<"organization">;
  signal: AbortSignal;
  threadId: SafeId<"chatThread">;
  userId: SafeId<"user">;
  work: () => Promise<T>;
};

export type WithThreadStoredContentEgress = <T>(
  options: ThreadStoredContentEgressOptions<T>,
) => Promise<T>;

/**
 * Run provider-bound stored-content work under a per-thread session fence.
 * A dedicated connection owns the fence while application transactions keep
 * their ordinary short lifetime.
 */
export const withThreadStoredContentEgress: WithThreadStoredContentEgress =
  async <T>({
    organizationId,
    signal,
    threadId,
    userId,
    work,
  }: ThreadStoredContentEgressOptions<T>): Promise<T> =>
    await withLongRunningConnection(
      {
        lockTimeout: CHAT_STORED_CONTENT_EGRESS_TIMEOUT_MS,
        signal,
        statementTimeout: CHAT_STORED_CONTENT_EGRESS_TIMEOUT_MS,
      },
      async ({ connection }) =>
        await withChatStoredContentEgressSessionLock({
          connection,
          organizationId,
          threadId,
          userId,
          work,
        }),
    );

/** Fence every compaction owned by a member before revoking their authority. */
export const lockChatOwnerStoredContentTransitionOnTx = async (
  tx: Transaction,
  id: {
    organizationId: SafeId<"organization">;
    userId: SafeId<"user">;
  },
): Promise<void> => {
  const result = await withAggregateLock({
    aggregate: "chatOwnerStoredContentEgress",
    id,
    tx,
  });
  if (result.status !== "locked") {
    panic("Blocking chat owner stored-content egress lock was not acquired");
  }
};

/** Take the transaction half before any chat-thread row lock or mutation. */
export const lockThreadStoredContentTransitionOnTx = async (
  tx: Transaction,
  threadId: SafeId<"chatThread">,
): Promise<void> => {
  const result = await withAggregateLock({
    aggregate: "chatStoredContentEgress",
    id: threadId,
    tx,
  });
  if (result.status !== "locked") {
    panic("Blocking chat stored-content egress lock was not acquired");
  }
};
