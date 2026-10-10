import { and, eq, inArray, sql } from "drizzle-orm";

import { member } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { abortTransaction } from "@/api/db/safe-db";
import { taskAssignees, workspaceMembers, workspaces } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

/**
 * Assignment writes lock workspace KEY SHARE before membership and entity.
 * Removal holds workspace UPDATE, then membership, run, step, obligation and assignment.
 * Workflow writes use workspace KEY SHARE -> run -> step -> obligation ->
 * entity; removal uses the same prefix before cancelling runs and clearing grants.
 * Organization removal locks workspace UPDATE -> organization membership -> matter membership.
 * Account erasure retains organization membership first, then tries workspace
 * advisory/UPDATE without waiting (retryable 409 on contention), then
 * matter memberships before obligations and assignments.
 */
type LockTaskAssignmentMembersOptions = {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  userIds: readonly string[];
};

export const lockTaskAssignmentMembers = async ({
  tx,
  workspaceId,
  userIds,
}: LockTaskAssignmentMembersOptions) => {
  const workspacesLocked = await tx
    .select({ organizationId: workspaces.organizationId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .for("key share");
  const workspace = workspacesLocked.at(0);
  if (!workspace) {
    return new Set<string>();
  }
  const uniqueIds = [...new Set(userIds)].toSorted();
  if (uniqueIds.length === 0) {
    return new Set<string>();
  }
  // The workspace lock serializes organization offboarding, which removes
  // matter memberships in the same transaction. Do not invert account
  // erasure's organization-member -> matter-member order by locking org rows.
  const members = await tx
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        inArray(workspaceMembers.userId, uniqueIds),
      ),
    )
    .orderBy(workspaceMembers.userId)
    .limit(uniqueIds.length)
    .for("key share");
  const organizationMembers = await tx
    .select({ userId: member.userId })
    .from(member)
    .where(
      and(
        eq(member.organizationId, workspace.organizationId),
        inArray(member.userId, uniqueIds),
      ),
    );
  const organizationMemberIds = new Set(
    organizationMembers.map((row) => row.userId),
  );
  return new Set(
    members
      .filter((row) => organizationMemberIds.has(row.userId))
      .map((row) => row.userId),
  );
};

type WriteTaskAssignmentsOptions = {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  assignments: readonly {
    entityId: SafeId<"entity">;
    userId: string;
    role: "assignee" | "reviewer";
  }[];
};

export const writeTaskAssignments = async ({
  tx,
  workspaceId,
  assignments,
}: WriteTaskAssignmentsOptions) => {
  // audit: skip - createTaskEntityHandler, addAssigneeHandler and moveAssigneeHandler record task events in the same transaction.
  if (assignments.length === 0) {
    return;
  }
  const members = await lockTaskAssignmentMembers({
    tx,
    workspaceId,
    userIds: assignments.map((row) => row.userId),
  });
  if (assignments.some((row) => !members.has(row.userId))) {
    abortTransaction(
      new HandlerError({
        status: 400,
        message: "User is not a member of this workspace",
      }),
    );
  }
  await tx
    .insert(taskAssignees)
    .values(assignments.map((assignment) => ({ ...assignment, workspaceId })))
    .onConflictDoUpdate({
      target: [taskAssignees.entityId, taskAssignees.userId],
      set: { role: sql`excluded.role` },
    });
};

type RemoveTaskAssignmentOptions = {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  entityId: SafeId<"entity">;
  userId: string;
};

export const removeTaskAssignment = async ({
  tx,
  workspaceId,
  entityId,
  userId,
}: RemoveTaskAssignmentOptions) => {
  // audit: skip - removeAssigneeHandler and moveAssigneeHandler record task events in the same transaction.
  await tx
    .delete(taskAssignees)
    .where(
      and(
        eq(taskAssignees.workspaceId, workspaceId),
        eq(taskAssignees.entityId, entityId),
        eq(taskAssignees.userId, userId),
      ),
    );
};
