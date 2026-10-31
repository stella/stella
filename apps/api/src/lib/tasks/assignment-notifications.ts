import { panic } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import { NOTIFICATION_KIND } from "@stll/api-contract/notifications";

import { member as organizationMember, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { workspaces } from "@/api/db/schema";
import { detached } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { TASK_ASSIGNEE_ROLE } from "@/api/lib/entity-constants";
import { fanOutCrossUserNotifications } from "@/api/lib/notifications";
import type { NewNotification } from "@/api/lib/notifications";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import type { WrittenTaskAssignment } from "@/api/lib/tasks/assignment-membership";

/**
 * Files "you were assigned a task" rows addressed to other people. Injected so
 * a handler can be exercised without a database behind the cross-user write.
 */
export type FileTaskAssignedNotifications = (
  rows: readonly NewNotification[],
) => void;

/**
 * Build the "you were assigned a task" rows for the assignments one write
 * changed, inside that write's transaction.
 *
 * Only the `assignee` role is announced, and never to the actor: assigning
 * yourself is not news. Every recipient was locked and checked as a member of
 * this matter and its organization by `writeTaskAssignments` in the same
 * transaction, so the row cannot reach somebody who cannot open the task.
 *
 * The idempotency key names the assignment row and this write's transaction.
 * A repeat of the same assignment changes no row, so `written` holds nothing
 * and nothing is filed; each move into the assignee role is its own write, so
 * assignee, then reviewer, then assignee again is announced twice, as is
 * removing someone and assigning them again.
 */
export const taskAssignedNotifications = async (
  tx: Transaction,
  {
    actorUserId,
    workspaceId,
    written,
  }: {
    actorUserId: SafeId<"user">;
    workspaceId: SafeId<"workspace">;
    written: readonly WrittenTaskAssignment[];
  },
): Promise<NewNotification[]> => {
  const recipients = written.filter(
    (assignment) =>
      assignment.role === TASK_ASSIGNEE_ROLE.ASSIGNEE &&
      assignment.userId !== actorUserId,
  );
  if (recipients.length === 0) {
    return [];
  }

  // The organization comes from the matter row, not the request, and the
  // actor's name through their membership of that same organization. The
  // actor just wrote to this matter, so a miss is a broken invariant. The
  // 64-bit transaction id never repeats, so it tells one write from another.
  const actorRows = await tx
    .select({
      actorName: user.name,
      organizationId: workspaces.organizationId,
      transactionId: sql<string>`pg_current_xact_id()::text`,
    })
    .from(workspaces)
    .innerJoin(
      organizationMember,
      and(
        eq(organizationMember.organizationId, workspaces.organizationId),
        eq(organizationMember.userId, actorUserId),
      ),
    )
    .innerJoin(user, eq(user.id, organizationMember.userId))
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  const actor =
    actorRows.at(0) ?? panic("the assigning user's membership row is missing");

  return recipients.map((assignment): NewNotification => ({
    kind: NOTIFICATION_KIND.TASK_ASSIGNED,
    metadata: { actorName: actor.actorName },
    entityType: "task",
    entityId: assignment.entityId,
    workspaceId,
    organizationId: actor.organizationId,
    userId: brandPersistedUserId(assignment.userId),
    idempotencyKey: `task_assigned:${assignment.entityId}:${assignment.userId}:${assignment.id}:${actor.transactionId}`,
  }));
};

/**
 * Fan the rows out once the assignment has committed. Detached rather than
 * awaited: the assignment is already durable, and the person assigning must
 * not see it fail over a colleague's badge. A rejection still reaches error
 * capture rather than being swallowed.
 */
export const fileTaskAssignedNotifications: FileTaskAssignedNotifications = (
  rows,
) => {
  if (rows.length === 0) {
    return;
  }
  detached(fanOutCrossUserNotifications(rows), "notifications.task-assigned");
};
