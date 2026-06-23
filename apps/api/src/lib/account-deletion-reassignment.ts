import type { SafeId } from "@/api/lib/branded-types";
import { TASK_STATUS } from "@/api/lib/entity-constants";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

export const ACTIVE_TASK_REASSIGNMENT_STATUSES = [
  TASK_STATUS.OPEN,
  TASK_STATUS.IN_PROGRESS,
  TASK_STATUS.IN_REVIEW,
] as const;

export type AccountDeletionTaskAssignment = {
  entityId: SafeId<"entity">;
  workspaceId: SafeId<"workspace">;
};

export type AccountDeletionTaskReassignment = {
  entityId: SafeId<"entity">;
  reassignedUserId: string;
};

export type AccountDeletionTaskReassignmentTarget =
  AccountDeletionTaskAssignment & {
    reassignedUserId: string;
  };

export type AccountDeletionTaskAssignmentMembershipPartition = {
  currentMembershipAssignments: AccountDeletionTaskAssignment[];
  staleAssignments: AccountDeletionTaskAssignment[];
};

export const isAccountDeletionActiveTaskStatus = (
  status: string | null,
): boolean =>
  status === null ||
  ACTIVE_TASK_REASSIGNMENT_STATUSES.some(
    (activeStatus) => activeStatus === status,
  );

export const buildAccountDeletionTaskReassignmentTargets = ({
  currentUserId,
  currentTaskAssignments,
  reassignments,
}: {
  currentUserId: string;
  currentTaskAssignments: readonly AccountDeletionTaskAssignment[];
  reassignments: readonly AccountDeletionTaskReassignment[];
}): AccountDeletionTaskReassignmentTarget[] => {
  const targetByEntityId = new Map(
    reassignments.map((item) => [item.entityId, item.reassignedUserId]),
  );
  const targets: AccountDeletionTaskReassignmentTarget[] = [];

  for (const assignment of currentTaskAssignments) {
    const reassignedUserId = targetByEntityId.get(assignment.entityId);
    if (!reassignedUserId) {
      throw new HandlerError({
        status: 400,
        message:
          "All active task assignments must be reassigned before deleting your account.",
      });
    }

    if (reassignedUserId === currentUserId) {
      throw new HandlerError({
        status: 400,
        message: "Task reassignment target must be another workspace member.",
      });
    }

    targets.push({
      entityId: assignment.entityId,
      reassignedUserId,
      workspaceId: assignment.workspaceId,
    });
  }

  return targets;
};

export const partitionAccountDeletionTaskAssignmentsByMembership = ({
  currentWorkspaceIds,
  taskAssignments,
}: {
  currentWorkspaceIds: ReadonlySet<string>;
  taskAssignments: readonly AccountDeletionTaskAssignment[];
}): AccountDeletionTaskAssignmentMembershipPartition => {
  const currentMembershipAssignments: AccountDeletionTaskAssignment[] = [];
  const staleAssignments: AccountDeletionTaskAssignment[] = [];

  for (const assignment of taskAssignments) {
    if (currentWorkspaceIds.has(assignment.workspaceId)) {
      currentMembershipAssignments.push(assignment);
      continue;
    }

    staleAssignments.push(assignment);
  }

  return { currentMembershipAssignments, staleAssignments };
};

export const validateAccountDeletionTaskReassignmentTargets = ({
  existingReassignmentKeys,
  targets,
  validMembershipKeys,
}: {
  existingReassignmentKeys: ReadonlySet<string>;
  targets: readonly AccountDeletionTaskReassignmentTarget[];
  validMembershipKeys: ReadonlySet<string>;
}): AccountDeletionTaskReassignment[] => {
  const updates: AccountDeletionTaskReassignment[] = [];

  for (const target of targets) {
    const membershipKey = `${target.workspaceId}:${target.reassignedUserId}`;
    if (!validMembershipKeys.has(membershipKey)) {
      throw new HandlerError({
        status: 400,
        message:
          "Task reassignment target must be a member of the task workspace.",
      });
    }

    const assignmentKey = `${target.entityId}:${target.reassignedUserId}`;
    if (existingReassignmentKeys.has(assignmentKey)) {
      throw new HandlerError({
        status: 400,
        message:
          "Selected task reassignment target is already assigned to one of the tasks.",
      });
    }

    updates.push({
      entityId: target.entityId,
      reassignedUserId: target.reassignedUserId,
    });
  }

  return updates;
};
