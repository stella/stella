import { panic } from "better-result";

import { NOTIFICATION_KIND } from "@stll/api-contract/notifications";

import type { rootDb } from "@/api/db/root";
import { flowRuns } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  withAggregateRowQuery,
  withAggregateTransaction,
} from "@/api/lib/db/aggregate-lock";
import { recordDeferredNoticeState } from "@/api/lib/db/recovery-bookkeeping/notices";
import { isBackgroundFeatureEnabled } from "@/api/lib/feature-access/background";
import { lockFeatureRecoveryAdmission } from "@/api/lib/feature-access/recovery-admission-lock";
import type { FlowTriggerSource } from "@/api/lib/flows/flow-types";
import {
  createNotificationsInTransaction,
  pingNotificationRecipients,
} from "@/api/lib/notifications";
import type {
  NewNotification,
  NotificationFanOutDb,
} from "@/api/lib/notifications";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";

type FlowRunActorSource = {
  definitionId: SafeId<"flowDefinition"> | null;
  triggerSource: FlowTriggerSource;
};

/**
 * The user credited as the run's actor (document `createdBy`, audit rows). A
 * manual run carries the launcher's id; an automated run falls back to the
 * definition author. Returns `null` for an automated run whose author was
 * deleted mid-flight — the trigger already refuses to start such a run, so this
 * only happens if the author is removed after the run begins; callers retain
 * the run without admitting another feature effect.
 */
export const resolveActorUserId = async (
  run: FlowRunActorSource,
  database: Pick<typeof rootDb, "query">,
): Promise<SafeId<"user"> | null> => {
  if (run.triggerSource.type === "manual") {
    return brandPersistedUserId(run.triggerSource.userId);
  }
  if (run.definitionId) {
    const definition = await database.query.flowDefinitions.findFirst({
      where: { id: { eq: run.definitionId } },
      columns: { createdByUserId: true },
    });
    if (definition?.createdByUserId) {
      return brandPersistedUserId(definition.createdByUserId);
    }
  }
  return null;
};

/** An unavailable actor is distinct from a live actor without a feature grant. */
export const flowRunActorExists = async (
  actorUserId: SafeId<"user"> | null,
  database: Pick<typeof rootDb, "query">,
): Promise<boolean> => {
  if (actorUserId === null) {
    return false;
  }
  const actor = await database.query.user.findFirst({
    where: { id: { eq: actorUserId }, deletedAt: { isNull: true } },
    columns: { id: true },
  });
  return actor !== undefined;
};

type FlowRunCompletedNotificationArgs = {
  actorUserId: SafeId<"user">;
  flowName: string;
  organizationId: SafeId<"organization">;
  runId: SafeId<"flowRun">;
  workspaceId: SafeId<"workspace">;
};

/**
 * The "your run finished" pointer, shared by both paths that can make a run
 * terminal: the last step completing on the worker, and a reviewer approving a
 * final review gate. One definition so the two cannot drift, and one
 * run-derived idempotency key so whichever path gets there first wins and the
 * other is a no-op.
 */
export const flowRunCompletedNotification = ({
  actorUserId,
  flowName,
  organizationId,
  runId,
  workspaceId,
}: FlowRunCompletedNotificationArgs): NewNotification => ({
  kind: NOTIFICATION_KIND.FLOW_RUN_COMPLETED,
  metadata: { flowName },
  entityType: "flow_run",
  entityId: runId,
  workspaceId,
  organizationId,
  userId: actorUserId,
  idempotencyKey: `flow-run-completed:${runId}`,
});

export type FlowRunCompletionNotice = Omit<
  FlowRunCompletedNotificationArgs,
  "actorUserId"
> & {
  run: FlowRunActorSource;
};

/**
 * Resolve the live actor and file their pointer under the grant writer's lock.
 * Refused notices remain recoverable from the completed run. Filing for somebody
 * else is a cross-user write, so the caller chooses the connection deliberately
 * (see `flow-run-completion-notice.ts`).
 */
export const fileFlowRunCompletionNotice = async (
  { run: _run, ...notice }: FlowRunCompletionNotice,
  database: NotificationFanOutDb,
): Promise<void> => {
  const pings = await withAggregateTransaction(database, async (tx) => {
    await lockFeatureRecoveryAdmission({
      tx,
      organizationId: notice.organizationId,
      featureId: "flows",
    });
    const locked = await withAggregateRowQuery({
      aggregate: "run",
      id: { runId: notice.runId, workspaceId: notice.workspaceId },
      mode: "update",
      tx,
      select: (queryTx) =>
        queryTx
          .select({
            id: flowRuns.id,
            workspaceId: flowRuns.workspaceId,
            status: flowRuns.status,
            definitionId: flowRuns.definitionId,
            triggerSource: flowRuns.triggerSource,
          })
          .from(flowRuns),
    });
    if (locked.status === "busy") {
      return panic("Blocking aggregate acquisition returned busy");
    }
    const current = locked.rows.at(0);
    if (current?.status !== "completed") {
      return [];
    }
    const actorUserId = await resolveActorUserId(current, tx);
    if (!(await flowRunActorExists(actorUserId, tx))) {
      await recordDeferredNoticeState(tx, {
        type: "actor-removed",
        table: flowRuns,
        runId: notice.runId,
        workspaceId: notice.workspaceId,
      });
      return [];
    }
    if (
      actorUserId === null ||
      !(await isBackgroundFeatureEnabled({
        tx,
        organizationId: notice.organizationId,
        userId: actorUserId,
        featureId: "flows",
      }))
    ) {
      // The completed source records only notices whose filing was deferred.
      await recordDeferredNoticeState(tx, {
        type: "completion-notice-pending",
        table: flowRuns,
        runId: notice.runId,
        workspaceId: notice.workspaceId,
      });
      return [];
    }
    const notificationPings = await createNotificationsInTransaction(
      [flowRunCompletedNotification({ ...notice, actorUserId })],
      tx,
    );
    await recordDeferredNoticeState(tx, {
      type: "clear",
      table: flowRuns,
      runId: notice.runId,
      workspaceId: notice.workspaceId,
    });
    return notificationPings;
  });
  pingNotificationRecipients(pings);
};
