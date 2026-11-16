import { panic, Result } from "better-result";
import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import * as v from "valibot";

import type { Transaction } from "@/api/db/root";
import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { chatQueuedMessages } from "@/api/db/schema";
import { lockOwnQueueThreadOnTx } from "@/api/handlers/chat/queue/chat-queue-store";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { replayWrite } from "@/api/lib/case-law/replay-write";
import { announceChatQueueChange } from "@/api/lib/chat/chat-queue-announcement";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { removeQueuedChatMessageOnTx } from "@/api/lib/db/chat-queue-gate";

/**
 * A queued message handed to a running turn as a steer. The steer marks the
 * revision it handed over; the run's report on that steer decides the rest
 * under the thread lock: taken, the message leaves the queue at that
 * revision (an edit since keeps it queued); refused, the mark is cleared and
 * the message waits for the turn's end like any other. The turn's producer
 * reads the run's reports before the run's end, and the queue sends nothing
 * before the turn ended, so a taken message is gone before the queue could
 * send it.
 */

/**
 * A steer's `inputId` as the id of the queued message it may name. Every
 * steer input id is validated as a UUID where it enters (the steer request,
 * the run's report), so one that is not is a defect.
 */
export const steeredMessageIdOf = (inputId: string): SafeId<"chatMessage"> => {
  const parsed = v.safeParse(resourceIdSchema("chatMessage"), inputId);
  return parsed.success
    ? parsed.output
    : panic("A steer input id is not a message id");
};

type SteeredMessageOnTx = {
  id: SafeId<"chatMessage">;
  threadId: SafeId<"chatThread">;
  tx: Transaction;
};

/** Writes only the mark: the message's `updatedAt` tells of edits alone. */
const steerMark = (revision: number | null) =>
  replayWrite(chatQueuedMessages, {
    steeredRevision: revision,
    updatedAt: sql`${chatQueuedMessages.updatedAt}`,
  });

/**
 * Mark queued message `id` as handed to a turn at `revision`; `changed`
 * when it is no longer queued at that revision (edited, sent or removed
 * since), or a steer of another revision is still open: the runner takes one
 * input per id, so a second revision would be removed for the first one's
 * report. The caller holds the thread lock.
 */
export const markSteeredQueuedMessageOnTx = async ({
  id,
  revision,
  threadId,
  tx,
}: SteeredMessageOnTx & { revision: number }): Promise<
  "marked" | "changed"
> => {
  const mark = steerMark(revision);
  // A repeat of the same steer marks the same revision again.
  // audit: skip — the mark is bookkeeping of a steer; the message leaves the queue audited once the run took it
  const marked = await tx
    .update(chatQueuedMessages)
    .set(mark.set)
    .where(
      and(
        eq(chatQueuedMessages.id, id),
        eq(chatQueuedMessages.threadId, threadId),
        eq(chatQueuedMessages.revision, revision),
        or(
          isNull(chatQueuedMessages.steeredRevision),
          eq(chatQueuedMessages.steeredRevision, revision),
        ),
      ),
    )
    .returning({ id: chatQueuedMessages.id });
  return marked.length > 0 ? "marked" : "changed";
};

/** Clear the steer mark of `id`: the steer was refused. The caller holds the thread lock. */
export const clearSteeredQueuedMessageOnTx = async ({
  id,
  threadId,
  tx,
}: SteeredMessageOnTx): Promise<void> => {
  const clear = steerMark(null);
  // audit: skip — clearing a steer mark changes no stored content
  await tx
    .update(chatQueuedMessages)
    .set(clear.set)
    .where(
      and(
        eq(chatQueuedMessages.id, id),
        eq(chatQueuedMessages.threadId, threadId),
        clear.setWhere,
      ),
    );
};

/**
 * Remove queued message `id` because the run took it as a steer, at the
 * revision the steer handed over; `kept` when no steer of it is open or it
 * was edited since (the edit is the member's newer word, sent at the turn's
 * end). The caller holds the thread lock and audits a removal.
 */
const takeSteeredQueuedMessageOnTx = async ({
  id,
  threadId,
  tx,
}: SteeredMessageOnTx): Promise<"taken" | "kept"> => {
  const steered = (
    await tx
      .select({ revision: chatQueuedMessages.steeredRevision })
      .from(chatQueuedMessages)
      .where(
        and(
          eq(chatQueuedMessages.id, id),
          eq(chatQueuedMessages.threadId, threadId),
          isNotNull(chatQueuedMessages.steeredRevision),
        ),
      )
      .limit(1)
  ).at(0);
  const revision = steered?.revision ?? null;
  if (revision === null) {
    return "kept";
  }
  const removed = await removeQueuedChatMessageOnTx({
    id,
    revision,
    threadId,
    tx,
  });
  if (removed.type === "removed") {
    return "taken";
  }
  await clearSteeredQueuedMessageOnTx({ id, threadId, tx });
  return "kept";
};

/** What a run said of a steer: the harness took it, or it did not. */
export type QueuedSteerReport = "taken" | "refused";

type SteeredQueueOwner = {
  organizationId: SafeId<"organization">;
  recordAuditEvent: AuditRecorder;
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
  userId: SafeId<"user">;
};

/**
 * What a turn's producer does with a run's report on steer `inputId`. A
 * steer that named no queued message (one written in the composer) finds no
 * mark and changes nothing.
 */
export const createSteeredQueue = ({
  organizationId,
  recordAuditEvent,
  safeDb,
  threadId,
  userId,
}: SteeredQueueOwner) => ({
  settle: async (
    inputId: string,
    report: QueuedSteerReport,
  ): Promise<Result<void, SafeDbError>> => {
    const id = steeredMessageIdOf(inputId);
    const settled = await safeDb(async (tx) => {
      const thread = await lockOwnQueueThreadOnTx({
        organizationId,
        threadId,
        tx,
        userId,
      });
      if (thread === undefined) {
        return "kept";
      }
      if (report === "refused") {
        await clearSteeredQueuedMessageOnTx({ id, threadId, tx });
        return "kept";
      }
      const taken = await takeSteeredQueuedMessageOnTx({ id, threadId, tx });
      if (taken === "taken") {
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.DELETE,
          resourceType: AUDIT_RESOURCE_TYPE.CHAT_MESSAGE,
          resourceId: id,
          workspaceId: thread.workspaceId,
          metadata: { threadId, queued: true, steered: true },
        });
      }
      return taken;
    });
    if (Result.isError(settled)) {
      return Result.err(settled.error);
    }
    if (settled.value === "taken") {
      announceChatQueueChange({ organizationId, userId });
    }
    return Result.ok(undefined);
  },
});
