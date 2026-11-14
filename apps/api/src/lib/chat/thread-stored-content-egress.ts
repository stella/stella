import { panic } from "better-result";
import { eq } from "drizzle-orm";

import { member } from "@/api/db/auth-schema";
import { withLongRunningConnection } from "@/api/db/long-running-connection";
import type { Transaction } from "@/api/db/root";
import { chatThreads, workspaceMembers, workspaces } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  withAggregateLock,
  withChatStoredContentEgressSessionLock,
} from "@/api/lib/db/aggregate-lock";
import { brandPersistedOrganizationId } from "@/api/lib/safe-id-boundaries";

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

/**
 * Try every chat owner fence an account's erasure crosses, without waiting.
 * The erasure deletes the account's memberships and threads in every
 * organization, and the database backstops refuse those deletions while a
 * compaction holds the fence. Taking the fences first, before any membership
 * row lock, keeps fence-then-row order and turns an in-flight compaction into
 * the caller's busy refusal. Organizations are tried in ascending id order.
 */
export const tryLockAccountChatOwnerStoredContentTransitionsOnTx = async (
  tx: Transaction,
  userId: SafeId<"user">,
): Promise<"busy" | "locked"> => {
  const memberships = await tx
    .selectDistinct({ organizationId: member.organizationId })
    .from(member)
    .where(eq(member.userId, userId));
  const threads = await tx
    .selectDistinct({ organizationId: chatThreads.organizationId })
    .from(chatThreads)
    .where(eq(chatThreads.userId, userId));
  const assignments = await tx
    .selectDistinct({ organizationId: workspaces.organizationId })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, userId));
  const organizationIds = [
    ...new Set<SafeId<"organization">>([
      ...memberships.map((row) =>
        brandPersistedOrganizationId(row.organizationId),
      ),
      ...threads.map((row) => row.organizationId),
      ...assignments.map((row) => row.organizationId),
    ]),
  ].toSorted();
  for (const organizationId of organizationIds) {
    // db-await-in-loop: owner fences are tried one at a time in ascending order.
    const result = await withAggregateLock({
      aggregate: "chatOwnerStoredContentEgress",
      id: { organizationId, userId },
      tx,
      wait: "nowait",
    });
    if (result.status !== "locked") {
      return "busy";
    }
  }
  return "locked";
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
