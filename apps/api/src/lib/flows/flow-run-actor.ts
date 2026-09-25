import { NOTIFICATION_KIND } from "@stll/api-contract/notifications";

import type { rootDb } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";
import type { FlowTriggerSource } from "@/api/lib/flows/flow-types";
import { fanOutNotifications } from "@/api/lib/notifications";
import type {
  NewNotification,
  NotificationFanOutDb,
} from "@/api/lib/notifications";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";

export type FlowRunActorSource = {
  definitionId: SafeId<"flowDefinition"> | null;
  triggerSource: FlowTriggerSource;
};

/**
 * The user credited as the run's actor (document `createdBy`, audit rows). A
 * manual run carries the launcher's id; an automated run falls back to the
 * definition author. Returns `null` for an automated run whose author was
 * deleted mid-flight — the trigger already refuses to start such a run, so this
 * only happens if the author is removed after the run begins; callers fail the
 * run cleanly rather than panicking.
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

export type FlowRunCompletedNotificationArgs = {
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
 * Resolve the run's actor and file their completion pointer, both on
 * `database`. Filing for somebody else is a cross-user write, so the caller
 * chooses the connection deliberately (see `flow-run-completion-notice.ts`).
 */
export const fileFlowRunCompletionNotice = async (
  { run, ...notice }: FlowRunCompletionNotice,
  database: Pick<typeof rootDb, "query"> & NotificationFanOutDb,
): Promise<void> => {
  const actorUserId = await resolveActorUserId(run, database);
  if (actorUserId === null) {
    return;
  }
  await fanOutNotifications(
    [flowRunCompletedNotification({ ...notice, actorUserId })],
    database,
  );
};
