import { describe, expect, test } from "bun:test";

import {
  buildAccountDeletionTaskReassignmentTargets,
  isAccountDeletionActiveTaskStatus,
  validateAccountDeletionTaskReassignmentTargets,
} from "@/api/lib/account-deletion-reassignment";
import type {
  AccountDeletionTaskAssignment,
  AccountDeletionTaskReassignment,
} from "@/api/lib/account-deletion-reassignment";
import { toSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const currentUserId = "user_deleted";
const replacementUserId = "user_replacement";
const otherReplacementUserId = "user_other";
const taskOneId = toSafeId<"entity">("task_one");
const taskTwoId = toSafeId<"entity">("task_two");
const unrelatedTaskId = toSafeId<"entity">("task_extra");
const workspaceOneId = toSafeId<"workspace">("workspace_one");
const workspaceTwoId = toSafeId<"workspace">("workspace_two");

const assignments: AccountDeletionTaskAssignment[] = [
  { entityId: taskOneId, workspaceId: workspaceOneId },
  { entityId: taskTwoId, workspaceId: workspaceTwoId },
];

const getHandlerError = (run: () => unknown): HandlerError => {
  try {
    run();
  } catch (error) {
    if (error instanceof HandlerError) {
      return error;
    }
    throw error;
  }

  throw new Error("Expected account deletion handoff rule to throw");
};

describe("account deletion task handoff rules", () => {
  test("treats only open workflow states as requiring reassignment", () => {
    expect(isAccountDeletionActiveTaskStatus(null)).toBe(true);
    expect(isAccountDeletionActiveTaskStatus("open")).toBe(true);
    expect(isAccountDeletionActiveTaskStatus("in_progress")).toBe(true);
    expect(isAccountDeletionActiveTaskStatus("in_review")).toBe(true);
    expect(isAccountDeletionActiveTaskStatus("done")).toBe(false);
    expect(isAccountDeletionActiveTaskStatus("cancelled")).toBe(false);
  });

  test("builds one update per active task and ignores unrelated reassignment rows", () => {
    const targets = buildAccountDeletionTaskReassignmentTargets({
      currentTaskAssignments: assignments,
      currentUserId,
      reassignments: [
        { entityId: taskOneId, reassignedUserId: replacementUserId },
        { entityId: taskTwoId, reassignedUserId: otherReplacementUserId },
        { entityId: unrelatedTaskId, reassignedUserId: replacementUserId },
      ],
    });

    const updates = validateAccountDeletionTaskReassignmentTargets({
      existingReassignmentKeys: new Set(),
      targets,
      validMembershipKeys: new Set([
        `${workspaceOneId}:${replacementUserId}`,
        `${workspaceTwoId}:${otherReplacementUserId}`,
      ]),
    });

    expect(updates).toEqual([
      { entityId: taskOneId, reassignedUserId: replacementUserId },
      { entityId: taskTwoId, reassignedUserId: otherReplacementUserId },
    ] satisfies AccountDeletionTaskReassignment[]);
  });

  test("rejects deletion when an active task has no handoff target", () => {
    const error = getHandlerError(() =>
      buildAccountDeletionTaskReassignmentTargets({
        currentTaskAssignments: assignments,
        currentUserId,
        reassignments: [
          { entityId: taskOneId, reassignedUserId: replacementUserId },
        ],
      }),
    );

    expect(error.status).toBe(400);
    expect(error.message).toBe(
      "All active task assignments must be reassigned before deleting your account.",
    );
  });

  test("rejects handoff back to the deleted user", () => {
    const error = getHandlerError(() =>
      buildAccountDeletionTaskReassignmentTargets({
        currentTaskAssignments: [
          { entityId: taskOneId, workspaceId: workspaceOneId },
        ],
        currentUserId,
        reassignments: [
          { entityId: taskOneId, reassignedUserId: currentUserId },
        ],
      }),
    );

    expect(error.status).toBe(400);
    expect(error.message).toBe(
      "Task reassignment target must be another workspace member.",
    );
  });

  test("rejects handoff to a user outside the task workspace", () => {
    const targets = buildAccountDeletionTaskReassignmentTargets({
      currentTaskAssignments: [
        { entityId: taskOneId, workspaceId: workspaceOneId },
      ],
      currentUserId,
      reassignments: [
        { entityId: taskOneId, reassignedUserId: replacementUserId },
      ],
    });

    const error = getHandlerError(() =>
      validateAccountDeletionTaskReassignmentTargets({
        existingReassignmentKeys: new Set(),
        targets,
        validMembershipKeys: new Set([
          `${workspaceTwoId}:${replacementUserId}`,
        ]),
      }),
    );

    expect(error.status).toBe(400);
    expect(error.message).toBe(
      "Task reassignment target must be a member of the task workspace.",
    );
  });

  test("rejects handoff to a user already assigned to the task", () => {
    const targets = buildAccountDeletionTaskReassignmentTargets({
      currentTaskAssignments: [
        { entityId: taskOneId, workspaceId: workspaceOneId },
      ],
      currentUserId,
      reassignments: [
        { entityId: taskOneId, reassignedUserId: replacementUserId },
      ],
    });

    const error = getHandlerError(() =>
      validateAccountDeletionTaskReassignmentTargets({
        existingReassignmentKeys: new Set([
          `${taskOneId}:${replacementUserId}`,
        ]),
        targets,
        validMembershipKeys: new Set([
          `${workspaceOneId}:${replacementUserId}`,
        ]),
      }),
    );

    expect(error.status).toBe(400);
    expect(error.message).toBe(
      "Selected task reassignment target is already assigned to one of the tasks.",
    );
  });
});
