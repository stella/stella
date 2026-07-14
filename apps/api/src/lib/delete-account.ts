import { Result } from "better-result";
import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";

import {
  account,
  invitation,
  member,
  oauthAccessToken,
  oauthClient,
  oauthConsent,
  oauthRefreshToken,
  organization,
  session,
  user,
  verification,
} from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import {
  accountDeletionRequests,
  agentSkills,
  auditLogs,
  chatThreads,
  desktopEditHandoffs,
  desktopEditSessions,
  entities,
  fileChatThreads,
  folioCollabSessions,
  mcpOAuthState,
  mcpUserConnections,
  pendingUploads,
  rateEntries,
  taskAssignees,
  userFiles,
  workspaceMembers,
  workspaceViewTemplates,
  workspaces,
} from "@/api/db/schema";
import { createFileKey, createUserFileKey } from "@/api/handlers/files/utils";
import { tmpUploadKeys } from "@/api/handlers/uploads/lib";
import {
  enqueueAccountDeletionCleanup,
  processAccountDeletionCleanupRequest,
} from "@/api/lib/account-deletion-cleanup-queue";
import {
  ACTIVE_TASK_REASSIGNMENT_STATUSES,
  buildAccountDeletionTaskReassignmentTargets,
  validateAccountDeletionTaskReassignmentTargets,
} from "@/api/lib/account-deletion-reassignment";
import { captureError } from "@/api/lib/analytics/capture";
import { arrayOrEmpty } from "@/api/lib/array";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { errorTag } from "@/api/lib/errors/utils";
import { FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE } from "@/api/lib/folio-collab-sessions";
import { LIMITS } from "@/api/lib/limits";
import { logger } from "@/api/lib/observability/logger";
import {
  brandPersistedOrganizationId,
  brandPersistedUserId,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

const DELETED_ACCOUNT_DISPLAY_NAME = "Deleted account";

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

/**
 * Generates and stores a delete account OTP.
 */
export const createDeleteAccountOtp = async (
  email: string,
  otp: string,
): Promise<Result<void, HandlerError>> =>
  await Result.tryPromise({
    try: async () => {
      const identifier = `delete-account:${email}`;

      await rootDb.transaction(async (tx) => {
        // Lock the user row by email first to serialize OTP requests for this email
        await tx
          .select({ id: user.id })
          .from(user)
          .where(eq(user.email, email))
          .for("update");

        // Now we delete any existing OTP records for this identifier safely
        await tx
          .delete(verification)
          .where(eq(verification.identifier, identifier));

        const id = Bun.randomUUIDv7();
        await tx.insert(verification).values({
          id,
          identifier,
          value: otp,
          expiresAt: new Date(Date.now() + 5 * 60 * 1000), // 5 minutes
        });
      });
    },
    catch: (err) =>
      new HandlerError({
        status: 500,
        message: "Database operation failed",
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
 */
export const ACCOUNT_DELETION_ERROR_CODE = {
  otpExpired: "account_deletion_otp_expired",
  otpInvalid: "account_deletion_otp_invalid",
  soleOwner: "account_deletion_sole_owner",
} as const;

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
      const identifier = `delete-account:${email}`;
      const deletionRequestId = createSafeId<"accountDeletionRequest">();
      const s3KeysToDelete: string[] = [];
      let taskReassignmentCount = 0;

      await rootDb.transaction(async (tx) => {
        // Lock the user row to serialize deletion of this account
        await tx
          .select({ id: user.id })
          .from(user)
          .where(eq(user.id, currentUserId))
          .for("update");

        const verificationRow = await tx
          .select()
          .from(verification)
          .where(eq(verification.identifier, identifier))
          .limit(1)
          .then((rows) => rows[0]);

        if (!verificationRow) {
          throw new HandlerError({
            code: ACCOUNT_DELETION_ERROR_CODE.otpInvalid,
            status: 400,
            message: "Invalid verification code",
          });
        }

        if (verificationRow.value !== code) {
          // Prevent brute force by deleting the OTP on the first incorrect attempt
          await tx
            .delete(verification)
            .where(eq(verification.identifier, identifier));

          throw new HandlerError({
            code: ACCOUNT_DELETION_ERROR_CODE.otpInvalid,
            status: 400,
            message: "Invalid verification code",
          });
        }

        if (verificationRow.expiresAt.getTime() < Date.now()) {
          await tx
            .delete(verification)
            .where(eq(verification.identifier, identifier));

          throw new HandlerError({
            code: ACCOUNT_DELETION_ERROR_CODE.otpExpired,
            status: 400,
            message: "Verification code has expired",
          });
        }

        // 2. Perform ownership check with SELECT FOR UPDATE locks inside transaction
        // Fetch all organizations where the user is an owner, locking the member rows to prevent concurrent modifications
        const ownedOrgs = await tx
          .select({ orgId: member.organizationId, orgName: organization.name })
          .from(member)
          .innerJoin(organization, eq(organization.id, member.organizationId))
          .where(
            and(eq(member.userId, currentUserId), eq(member.role, "owner")),
          )
          .for("update");

        const ownedOrgIds = ownedOrgs.map((org) => org.orgId);
        const orgIdsWithOtherOwners = new Set(
          ownedOrgIds.length > 0
            ? (
                await tx
                  .select({ orgId: member.organizationId })
                  .from(member)
                  .where(
                    and(
                      inArray(member.organizationId, ownedOrgIds),
                      eq(member.role, "owner"),
                      ne(member.userId, currentUserId),
                    ),
                  )
                  .for("update")
              ).map((row) => row.orgId)
            : [],
        );

        const soleOwnedOrg = ownedOrgs.find(
          (org) => !orgIdsWithOtherOwners.has(org.orgId),
        );
        if (soleOwnedOrg) {
          throw new HandlerError({
            code: ACCOUNT_DELETION_ERROR_CODE.soleOwner,
            status: 400,
            message: `Cannot delete account because you are the sole owner of organization "${soleOwnedOrg.orgName}". Please transfer ownership or delete the organization first.`,
          });
        }

        const organizationIds = (
          await tx
            .select({ organizationId: member.organizationId })
            .from(member)
            .where(eq(member.userId, currentUserId))
        ).map((row) => brandPersistedOrganizationId(row.organizationId));

        const workspaceIds = (
          await tx
            .select({ workspaceId: workspaceMembers.workspaceId })
            .from(workspaceMembers)
            .where(eq(workspaceMembers.userId, currentUserId))
        ).map((row) => row.workspaceId);

        // audit: skip — ephemeral verification code deletion

        await tx
          .delete(verification)
          .where(eq(verification.id, verificationRow.id));

        // The user row is retained for historical attribution in collaborative
        // records. Account deletion revokes access and clears private profile
        // fields, but completed/cancelled task history can still show who did
        // the work with a deleted-account marker.

        // 1. Auth credentials, sessions, and invitations (auth-schema tables)
        await tx.delete(account).where(eq(account.userId, currentUserId));
        // eslint-disable-next-line auth-lifecycle/no-direct-auth-artifact-delete -- Account deletion must revoke Better Auth session artifacts.
        await tx.delete(session).where(eq(session.userId, currentUserId));
        // Delete invitations sent by the user, and also invitations sent to the user's email
        await tx
          .delete(invitation)
          .where(eq(invitation.inviterId, currentUserId));
        await tx.delete(invitation).where(eq(invitation.email, email));

        // 2. OAuth / Better-Auth token tables (auth-schema)
        // eslint-disable-next-line auth-lifecycle/no-direct-auth-artifact-delete -- Account deletion must revoke Better Auth OAuth access tokens.
        await tx
          .delete(oauthAccessToken)
          .where(eq(oauthAccessToken.userId, currentUserId));
        // eslint-disable-next-line auth-lifecycle/no-direct-auth-artifact-delete -- Account deletion must revoke Better Auth OAuth refresh tokens.
        await tx
          .delete(oauthRefreshToken)
          .where(eq(oauthRefreshToken.userId, currentUserId));
        await tx
          .delete(oauthConsent)
          .where(eq(oauthConsent.userId, currentUserId));
        await tx
          .delete(oauthClient)
          .where(eq(oauthClient.userId, currentUserId));

        // 3. MCP credentials and in-flight OAuth state (schema.ts, cascade on user.id)
        await tx
          .delete(mcpUserConnections)
          .where(eq(mcpUserConnections.userId, currentUserId));
        await tx
          .delete(mcpOAuthState)
          .where(eq(mcpOAuthState.userId, currentUserId));

        // 4. Workspace lead role — membership deletion happens after task handoff
        await tx
          .update(workspaces)
          .set({ leadUserId: null })
          .where(eq(workspaces.leadUserId, currentUserId));

        // 5. Active task assignee records require handoff. Completed/cancelled
        // assignments remain as historical activity on the deleted user row.
        const reassignmentItems = [...arrayOrEmpty(reassignments)];
        const currentTaskAssignments = await tx
          .select({
            entityId: taskAssignees.entityId,
            organizationId: workspaces.organizationId,
            workspaceId: taskAssignees.workspaceId,
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

        if (
          currentTaskAssignments.length >
          LIMITS.accountDeletionTaskAssignmentsMax
        ) {
          throw new HandlerError({
            code: "account_deletion_task_reassignment_limit_exceeded",
            status: 400,
            message:
              "Too many active task assignments to reassign during account deletion.",
          });
        }

        await tx.delete(taskAssignees).where(
          and(
            eq(taskAssignees.userId, currentUserId),
            inArray(
              taskAssignees.entityId,
              tx
                .select({ entityId: entities.id })
                .from(entities)
                .where(
                  and(
                    eq(entities.kind, "task"),
                    or(
                      isNull(entities.status),
                      inArray(
                        entities.status,
                        ACTIVE_TASK_REASSIGNMENT_STATUSES,
                      ),
                    ),
                  ),
                ),
            ),
            notExists(
              tx
                .select({ one: sql`1` })
                .from(workspaceMembers)
                .innerJoin(
                  workspaces,
                  eq(workspaces.id, workspaceMembers.workspaceId),
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
                    eq(workspaceMembers.workspaceId, taskAssignees.workspaceId),
                    eq(workspaceMembers.userId, currentUserId),
                  ),
                ),
            ),
          ),
        );

        if (currentTaskAssignments.length > 0) {
          const reassignmentTargets =
            buildAccountDeletionTaskReassignmentTargets({
              currentTaskAssignments,
              currentUserId,
              reassignments: reassignmentItems,
            });
          const reassignmentUserIds = reassignmentTargets.map(
            (target) => target.reassignedUserId,
          );

          const taskWorkspaceIds = currentTaskAssignments.map(
            (assignment) => assignment.workspaceId,
          );
          const validMembershipKeys = new Set(
            (
              await tx
                .select({
                  userId: workspaceMembers.userId,
                  workspaceId: workspaceMembers.workspaceId,
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
                .where(
                  and(
                    inArray(workspaceMembers.workspaceId, taskWorkspaceIds),
                    inArray(workspaceMembers.userId, reassignmentUserIds),
                  ),
                )
            ).map((row) => `${row.workspaceId}:${row.userId}`),
          );
          const existingReassignmentKeys = new Set(
            (
              await tx
                .select({
                  entityId: taskAssignees.entityId,
                  userId: taskAssignees.userId,
                })
                .from(taskAssignees)
                .where(
                  and(
                    inArray(
                      taskAssignees.entityId,
                      currentTaskAssignments.map(
                        (assignment) => assignment.entityId,
                      ),
                    ),
                    inArray(taskAssignees.userId, reassignmentUserIds),
                  ),
                )
            ).map((row) => `${row.entityId}:${row.userId}`),
          );

          const updates = validateAccountDeletionTaskReassignmentTargets({
            existingReassignmentKeys,
            targets: reassignmentTargets,
            validMembershipKeys,
          });
          const assignmentByEntityId = new Map(
            currentTaskAssignments.map((assignment) => [
              assignment.entityId,
              assignment,
            ]),
          );

          // SAFETY: one deleted user's active task reassignments, bounded by
          // the enforced LIMITS.accountDeletionTaskAssignmentsMax check above
          // (throws before reaching here if exceeded), not unbounded tenant
          // data.
          // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop
          await Promise.all(
            updates.map((item) =>
              tx
                .update(taskAssignees)
                .set({
                  userId: item.reassignedUserId,
                })
                .where(
                  and(
                    eq(taskAssignees.entityId, item.entityId),
                    eq(taskAssignees.userId, currentUserId),
                  ),
                ),
            ),
          );
          await tx.insert(auditLogs).values(
            updates.map((item) => {
              const assignment = assignmentByEntityId.get(item.entityId);
              if (!assignment) {
                throw new HandlerError({
                  status: 500,
                  message: "Task reassignment source not found.",
                });
              }

              return {
                action: AUDIT_ACTION.UPDATE,
                changes: {
                  assigneeUserId: {
                    new: item.reassignedUserId,
                    old: currentUserId,
                  },
                },
                metadata: {
                  accountDeletionRequestId: deletionRequestId,
                  change: "assignee-reassigned",
                  fromUserId: currentUserId,
                  reason: "account-deletion",
                  toUserId: item.reassignedUserId,
                },
                organizationId: assignment.organizationId,
                resourceId: item.entityId,
                resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
                userId: currentUserId,
                workspaceId: assignment.workspaceId,
              };
            }),
          );
          taskReassignmentCount = updates.length;
        }

        await tx.delete(member).where(eq(member.userId, currentUserId));
        await tx
          .delete(workspaceMembers)
          .where(eq(workspaceMembers.userId, currentUserId));

        // 6. Desktop edit sessions and handoffs (cascade on createdBy → user.id)
        const desktopCheckpointRows = await tx
          .select({
            checkpointFileId: desktopEditSessions.checkpointFileId,
            organizationId: workspaces.organizationId,
            workspaceId: desktopEditSessions.workspaceId,
          })
          .from(desktopEditSessions)
          .innerJoin(
            workspaces,
            eq(workspaces.id, desktopEditSessions.workspaceId),
          )
          .where(
            and(
              eq(desktopEditSessions.createdBy, currentUserId),
              isNotNull(desktopEditSessions.checkpointUpdatedAt),
            ),
          );
        s3KeysToDelete.push(
          ...desktopCheckpointRows.map((row) =>
            createFileKey({
              fileId: row.checkpointFileId,
              mimeType: DOCX_MIME_TYPE,
              organizationId: brandPersistedOrganizationId(row.organizationId),
              workspaceId: brandPersistedWorkspaceId(row.workspaceId),
            }),
          ),
        );

        await tx
          .delete(desktopEditHandoffs)
          .where(eq(desktopEditHandoffs.createdBy, currentUserId));
        await tx
          .delete(desktopEditSessions)
          .where(eq(desktopEditSessions.createdBy, currentUserId));

        // 7. Folio collab sessions — tokens cascade when session is deleted
        const folioCheckpointRows = await tx
          .select({
            docxCheckpointFileId: folioCollabSessions.docxCheckpointFileId,
            docxCheckpointUpdatedAt:
              folioCollabSessions.docxCheckpointUpdatedAt,
            organizationId: workspaces.organizationId,
            workspaceId: folioCollabSessions.workspaceId,
            yjsSnapshotFileId: folioCollabSessions.yjsSnapshotFileId,
            yjsSnapshotUpdatedAt: folioCollabSessions.yjsSnapshotUpdatedAt,
          })
          .from(folioCollabSessions)
          .innerJoin(
            workspaces,
            eq(workspaces.id, folioCollabSessions.workspaceId),
          )
          .where(eq(folioCollabSessions.createdBy, currentUserId));
        for (const row of folioCheckpointRows) {
          if (row.yjsSnapshotUpdatedAt !== null) {
            s3KeysToDelete.push(
              createFileKey({
                fileId: row.yjsSnapshotFileId,
                mimeType: FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE,
                organizationId: brandPersistedOrganizationId(
                  row.organizationId,
                ),
                workspaceId: brandPersistedWorkspaceId(row.workspaceId),
              }),
            );
          }

          if (row.docxCheckpointUpdatedAt !== null) {
            s3KeysToDelete.push(
              createFileKey({
                fileId: row.docxCheckpointFileId,
                mimeType: DOCX_MIME_TYPE,
                organizationId: brandPersistedOrganizationId(
                  row.organizationId,
                ),
                workspaceId: brandPersistedWorkspaceId(row.workspaceId),
              }),
            );
          }
        }

        await tx
          .delete(folioCollabSessions)
          .where(eq(folioCollabSessions.createdBy, currentUserId));

        // 8. Pending (in-flight) S3 uploads
        const stagedUploadRows = await tx
          .select({
            id: pendingUploads.id,
            organizationId: pendingUploads.organizationId,
            workspaceId: pendingUploads.workspaceId,
          })
          .from(pendingUploads)
          .where(
            and(
              eq(pendingUploads.userId, currentUserId),
              ne(pendingUploads.status, "finalized"),
            ),
          );
        s3KeysToDelete.push(
          ...stagedUploadRows.flatMap((row) =>
            tmpUploadKeys({
              organizationId: row.organizationId,
              uploadId: row.id,
              workspaceId: row.workspaceId,
            }),
          ),
        );

        await tx
          .delete(pendingUploads)
          .where(eq(pendingUploads.userId, currentUserId));

        // 9. Personal user files (private S3 uploads) — must delete userFiles before chatThreads
        // because userFiles.threadId has onDelete: "restrict" reference to chatThreads.id
        const files = await tx
          .select({
            id: userFiles.id,
            s3Key: userFiles.s3Key,
            thumbnailFileId: userFiles.thumbnailFileId,
            userId: userFiles.userId,
          })
          .from(userFiles)
          .where(eq(userFiles.userId, currentUserId));

        if (files.length > 0) {
          s3KeysToDelete.push(
            ...files.flatMap((file) =>
              file.thumbnailFileId
                ? [
                    file.s3Key,
                    createUserFileKey({
                      fileId: file.thumbnailFileId,
                      mimeType: "image/webp",
                      userId: brandPersistedUserId(file.userId),
                    }),
                  ]
                : [file.s3Key],
            ),
          );
        }

        await tx.delete(userFiles).where(eq(userFiles.userId, currentUserId));

        // 10. AI chat threads — messages and fileChatThreads cascade on thread deletion
        await tx
          .delete(fileChatThreads)
          .where(eq(fileChatThreads.userId, currentUserId));
        await tx
          .delete(chatThreads)
          .where(eq(chatThreads.userId, currentUserId));

        // 11. Personal workspace view templates and agent skills
        await tx
          .delete(workspaceViewTemplates)
          .where(eq(workspaceViewTemplates.userId, currentUserId));
        await tx
          .delete(agentSkills)
          .where(eq(agentSkills.userId, currentUserId));

        // 12. Personal billing rates
        await tx
          .delete(rateEntries)
          .where(eq(rateEntries.userId, currentUserId));

        await tx.insert(accountDeletionRequests).values({
          id: deletionRequestId,
          userId: currentUserId,
          organizationIds,
          workspaceIds,
          taskReassignmentCount,
          status: s3KeysToDelete.length > 0 ? "pending" : "completed",
          storageCleanup: { s3Keys: s3KeysToDelete },
          completedAt: s3KeysToDelete.length > 0 ? null : new Date(),
        });

        // 13. Mark the account deleted and release private contact/login fields.
        await tx
          .update(user)
          .set({
            email: `deleted-${currentUserId}@stella.placeholder`,
            emailVerified: false,
            image: null,
            name: DELETED_ACCOUNT_DISPLAY_NAME,
            preferredName: null,
            wordEditShortcut: null,
            deletedAt: new Date(),
          })
          .where(eq(user.id, currentUserId));
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
