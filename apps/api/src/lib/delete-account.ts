import { Result } from "better-result";
import { and, eq, inArray, isNull, ne, or } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import {
  entities,
  taskAssignees,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import {
  enqueueAccountDeletionCleanup,
  processAccountDeletionCleanupRequest,
} from "@/api/lib/account-deletion-cleanup-queue";
import { ACTIVE_TASK_REASSIGNMENT_STATUSES } from "@/api/lib/account-deletion-reassignment";
import {
  assertUserIsNotSoleOrgOwner,
  clearWorkspaceLeadRole,
  collectUserOrganizationAndWorkspaceIds,
  deleteChatThreadsAndFileLinks,
  deleteDesktopEditSessionsAndHandoffs,
  deleteFolioCollabSessions,
  deleteMcpCredentialsAndOAuthState,
  deletePendingUploads,
  deletePersonalBillingRates,
  deletePersonalWorkspaceViewTemplatesAndAgentSkills,
  deleteUserFiles,
  finalizeDeletedUserRecord,
  lockUserRowForDeletion,
  reassignActiveTaskAssignmentsAndDropMemberships,
  recordAccountDeletionRequest,
  revokeAuthCredentialsAndInvitations,
  revokeOAuthTokensAndGrants,
} from "@/api/lib/account-deletion-steps";
import { captureError } from "@/api/lib/analytics/capture";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { verifyConfirmationOtp } from "@/api/lib/confirmation-otp";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { errorTag } from "@/api/lib/errors/utils";
import { LIMITS } from "@/api/lib/limits";
import { logger } from "@/api/lib/observability/logger";

export { ACCOUNT_DELETION_ERROR_CODE } from "@/api/lib/account-deletion-steps";

/**
 * Fetches the user email by ID.
 */
export const getUserEmail = async (
  currentUserId: string,
): Promise<Result<string, HandlerError>> =>
  await Result.tryPromise({
    try: async () => {
      const rows = await rootDb
        .select({ email: user.email })
        .from(user)
        .where(eq(user.id, currentUserId))
        .limit(1);
      const row = rows[0];
      if (!row) {
        throw new HandlerError({
          status: 404,
          message: "User not found",
        });
      }
      return row.email;
    },
    catch: (err) =>
      err instanceof HandlerError
        ? err
        : new HandlerError({
            status: 500,
            message: "Database query failed",
            cause: err,
          }),
  });

/**
 * Checks if the user is the sole owner of any organization they belong to.
 */
export const checkUserOrganizationOwnership = async (
  currentUserId: string,
): Promise<Result<{ isSoleOwner: boolean; orgName?: string }, HandlerError>> =>
  await Result.tryPromise({
    try: async () => {
      const ownedOrgs = await rootDb
        .select({
          orgId: member.organizationId,
          orgName: organization.name,
        })
        .from(member)
        .innerJoin(organization, eq(organization.id, member.organizationId))
        .where(and(eq(member.userId, currentUserId), eq(member.role, "owner")));

      const ownedOrgIds = ownedOrgs.map((org) => org.orgId);
      if (ownedOrgIds.length === 0) {
        return { isSoleOwner: false };
      }

      const orgIdsWithOtherOwners = new Set(
        (
          await rootDb
            .select({ orgId: member.organizationId })
            .from(member)
            .where(
              and(
                inArray(member.organizationId, ownedOrgIds),
                eq(member.role, "owner"),
                ne(member.userId, currentUserId),
              ),
            )
        ).map((row) => row.orgId),
      );

      const soleOwnedOrg = ownedOrgs.find(
        (org) => !orgIdsWithOtherOwners.has(org.orgId),
      );
      if (soleOwnedOrg) {
        return { isSoleOwner: true, orgName: soleOwnedOrg.orgName };
      }

      return { isSoleOwner: false };
    },
    catch: (err) =>
      new HandlerError({
        status: 500,
        message: "Database query failed",
        cause: err,
      }),
  });

export type ActiveTaskAssignment = {
  assigneeId: string;
  entityId: string;
  role: "assignee" | "reviewer";
  taskName: string;
  workspaceId: string;
  workspaceName: string;
};

export type WorkspaceMemberInfo = {
  workspaceId: string;
  userId: string;
  userName: string;
};

/**
 * Fetches active tasks assigned to the user along with other workspace members for reassignment.
 */
export const getPendingTasksAndMembers = async (
  currentUserId: string,
): Promise<
  Result<
    { tasks: ActiveTaskAssignment[]; members: WorkspaceMemberInfo[] },
    HandlerError
  >
> =>
  await Result.tryPromise({
    try: async () => {
      const userAssignments = await rootDb
        .select({
          assigneeId: taskAssignees.id,
          entityId: taskAssignees.entityId,
          role: taskAssignees.role,
          taskName: entities.displayName,
          workspaceId: taskAssignees.workspaceId,
          workspaceName: workspaces.name,
        })
        .from(taskAssignees)
        .innerJoin(entities, eq(entities.id, taskAssignees.entityId))
        .innerJoin(workspaces, eq(workspaces.id, taskAssignees.workspaceId))
        .innerJoin(
          workspaceMembers,
          and(
            eq(workspaceMembers.workspaceId, taskAssignees.workspaceId),
            eq(workspaceMembers.userId, currentUserId),
          ),
        )
        .innerJoin(
          member,
          and(
            eq(member.organizationId, workspaces.organizationId),
            eq(member.userId, currentUserId),
          ),
        )
        .where(
          and(
            eq(taskAssignees.userId, currentUserId),
            eq(entities.kind, "task"),
            or(
              isNull(entities.status),
              inArray(entities.status, ACTIVE_TASK_REASSIGNMENT_STATUSES),
            ),
          ),
        )
        .limit(LIMITS.accountDeletionTaskAssignmentsMax + 1);

      if (userAssignments.length > LIMITS.accountDeletionTaskAssignmentsMax) {
        throw new HandlerError({
          status: 400,
          message:
            "Too many active task assignments to reassign during account deletion.",
        });
      }

      const tasks = userAssignments.map((assignment) => ({
        ...assignment,
        role: assignment.role,
      }));

      const workspaceIds = [
        ...new Set(userAssignments.map((a) => a.workspaceId)),
      ];

      const otherMembers =
        workspaceIds.length > 0
          ? await rootDb
              .select({
                workspaceId: workspaceMembers.workspaceId,
                userId: user.id,
                userName: user.name,
              })
              .from(workspaceMembers)
              .innerJoin(
                workspaces,
                eq(workspaces.id, workspaceMembers.workspaceId),
              )
              .innerJoin(
                member,
                and(
                  eq(member.organizationId, workspaces.organizationId),
                  eq(member.userId, workspaceMembers.userId),
                ),
              )
              .innerJoin(user, eq(user.id, workspaceMembers.userId))
              .where(
                and(
                  inArray(workspaceMembers.workspaceId, workspaceIds),
                  ne(workspaceMembers.userId, currentUserId),
                ),
              )
              .limit(LIMITS.accountDeletionTaskReassignmentCandidatesMax + 1)
          : [];

      if (
        otherMembers.length >
        LIMITS.accountDeletionTaskReassignmentCandidatesMax
      ) {
        throw new HandlerError({
          status: 400,
          message:
            "Too many workspace members to load for account deletion task reassignment.",
        });
      }

      return {
        tasks,
        members: otherMembers,
      };
    },
    catch: (err) =>
      err instanceof HandlerError
        ? err
        : new HandlerError({
            status: 500,
            message: "Database query failed",
            cause: err,
          }),
  });

/**
 * Verifies the OTP and deletes the user from the database.
 *
 * Each deletion/update step lives in `account-deletion-steps.ts`, called
 * here in the same order the transaction has always run them (see that
 * file for the FK-ordering comments preserved on each step). The
 * `account-deletion-coverage.test.ts` guard checks that every table with a
 * foreign key to the auth user table is either DB-cascaded or explicitly
 * handled by one of these steps.
 */
export const verifyAndDeleteUser = async (
  currentUserId: string,
  email: string,
  code: string,
  reassignments?: readonly {
    entityId: SafeId<"entity">;
    reassignedUserId: string;
  }[],
): Promise<Result<void, HandlerError>> =>
  await Result.tryPromise({
    try: async () => {
      const deletionRequestId = createSafeId<"accountDeletionRequest">();
      const s3KeysToDelete: string[] = [];

      await rootDb.transaction(async (tx) => {
        await lockUserRowForDeletion(tx, currentUserId);

        // Verified inside this same transaction (and after the row lock
        // above) so the OTP check and the deletion it gates stay atomic.
        const otpResult = await verifyConfirmationOtp({
          purpose: "delete-account",
          email,
          code,
          db: tx,
        });
        if (Result.isError(otpResult)) {
          throw otpResult.error;
        }

        // 2. Perform ownership check with SELECT FOR UPDATE locks inside transaction
        await assertUserIsNotSoleOrgOwner(tx, currentUserId);

        const { organizationIds, workspaceIds } =
          await collectUserOrganizationAndWorkspaceIds(tx, currentUserId);

        // The user row is retained for historical attribution in collaborative
        // records. Account deletion revokes access and clears private profile
        // fields, but completed/cancelled task history can still show who did
        // the work with a deleted-account marker.

        await revokeAuthCredentialsAndInvitations({
          tx,
          currentUserId,
          email,
        });
        await revokeOAuthTokensAndGrants(tx, currentUserId);
        await deleteMcpCredentialsAndOAuthState(tx, currentUserId);
        await clearWorkspaceLeadRole(tx, currentUserId);

        const taskReassignmentCount =
          await reassignActiveTaskAssignmentsAndDropMemberships({
            tx,
            currentUserId,
            deletionRequestId,
            reassignments,
          });

        await deleteDesktopEditSessionsAndHandoffs({
          tx,
          currentUserId,
          s3KeysToDelete,
        });
        await deleteFolioCollabSessions({ tx, currentUserId, s3KeysToDelete });
        await deletePendingUploads({ tx, currentUserId, s3KeysToDelete });
        await deleteUserFiles({ tx, currentUserId, s3KeysToDelete });
        await deleteChatThreadsAndFileLinks(tx, currentUserId);
        await deletePersonalWorkspaceViewTemplatesAndAgentSkills(
          tx,
          currentUserId,
        );
        await deletePersonalBillingRates(tx, currentUserId);

        await recordAccountDeletionRequest({
          tx,
          deletionRequestId,
          currentUserId,
          organizationIds,
          workspaceIds,
          taskReassignmentCount,
          s3KeysToDelete,
        });

        await finalizeDeletedUserRecord(tx, currentUserId);
      });

      if (s3KeysToDelete.length > 0) {
        await enqueueStorageCleanupOrLog(deletionRequestId);
      }
    },
    catch: (err) =>
      err instanceof HandlerError
        ? err
        : new HandlerError({
            status: 500,
            message: "Database operation failed",
            cause: err,
          }),
  });

const enqueueStorageCleanupOrLog = async (
  deletionRequestId: SafeId<"accountDeletionRequest">,
): Promise<void> => {
  try {
    await enqueueAccountDeletionCleanup(deletionRequestId);
  } catch (error) {
    captureError(error, { deletionRequestId });
    logger.error("account_deletion_cleanup.enqueue_failed", {
      "error.type": errorTag(error),
      deletionRequestId,
    });

    void processAccountDeletionCleanupRequest(deletionRequestId).catch(
      (cleanupError: unknown) => {
        captureError(cleanupError, { deletionRequestId });
        logger.error("account_deletion_cleanup.inline_failed", {
          "error.type": errorTag(cleanupError),
          deletionRequestId,
        });
      },
    );
  }
};
