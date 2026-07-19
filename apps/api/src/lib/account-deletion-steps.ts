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
import type { PgTable } from "drizzle-orm/pg-core";

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
  twoFactor,
  user,
} from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
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
  ACTIVE_TASK_REASSIGNMENT_STATUSES,
  buildAccountDeletionTaskReassignmentTargets,
  validateAccountDeletionTaskReassignmentTargets,
} from "@/api/lib/account-deletion-reassignment";
import { arrayOrEmpty } from "@/api/lib/array";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE } from "@/api/lib/folio-collab-sessions";
import { LIMITS } from "@/api/lib/limits";
import {
  brandPersistedOrganizationId,
  brandPersistedUserId,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

// ── Extracted steps for verifyAndDeleteUser ─────────────────────────────
//
// Each function below is one step of the account-deletion transaction in
// `delete-account.ts`, extracted verbatim (same queries, same order, same
// comments) for readability. They are all called from `verifyAndDeleteUser`
// inside the same `rootDb.transaction(...)` block, in the same order as
// before this extraction.
//
// Steps that delete or clear a user-owned table's reference to `user` also
// export a `*_TABLES` constant listing the Drizzle tables they cover. These
// constants are combined into `ACCOUNT_DELETION_MANUAL_TABLES` at the
// bottom of this file, which the account-deletion coverage guard
// (`account-deletion-coverage.test.ts`) uses to verify that every table
// with a foreign key to `user` is either DB-cascaded or explicitly handled
// here — see that test for the full explanation.

export const DELETED_ACCOUNT_DISPLAY_NAME = "Deleted account";

export const ACCOUNT_DELETION_ERROR_CODE = {
  otpExpired: "account_deletion_otp_expired",
  otpInvalid: "account_deletion_otp_invalid",
  soleOwner: "account_deletion_sole_owner",
} as const;

/**
 * Locks the user row to serialize deletion of this account.
 */
export const lockUserRowForDeletion = async (
  tx: Transaction,
  currentUserId: string,
): Promise<void> => {
  await tx
    .select({ id: user.id })
    .from(user)
    .where(eq(user.id, currentUserId))
    .for("update");
};

/**
 * 2. Perform ownership check with SELECT FOR UPDATE locks inside transaction.
 * Fetch all organizations where the user is an owner, locking the member
 * rows to prevent concurrent modifications.
 */
export const assertUserIsNotSoleOrgOwner = async (
  tx: Transaction,
  currentUserId: string,
): Promise<void> => {
  const ownedOrgs = await tx
    .select({ orgId: member.organizationId, orgName: organization.name })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(and(eq(member.userId, currentUserId), eq(member.role, "owner")))
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
};

/**
 * Snapshots the organizations and workspaces this user belongs to, for the
 * account-deletion request record.
 */
export const collectUserOrganizationAndWorkspaceIds = async (
  tx: Transaction,
  currentUserId: string,
) => {
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

  return { organizationIds, workspaceIds };
};

export type RevokeAuthCredentialsParams = {
  tx: Transaction;
  currentUserId: string;
  email: string;
};

export const REVOKE_AUTH_CREDENTIALS_TABLES = [
  account,
  session,
  twoFactor,
  invitation,
] as const satisfies readonly PgTable[];

/**
 * 1. Auth credentials, sessions, two-factor secrets, and invitations
 * (auth-schema tables).
 *
 * The `two_factor` FK to `user` is `onDelete: "cascade"`, but account
 * deletion soft-deletes the user row (see `finalizeDeletedUserRecord`) and
 * never hard-deletes it, so that cascade never fires. The encrypted TOTP
 * secret and backup codes must therefore be purged explicitly here, the same
 * way `session` and `account` are.
 */
export const revokeAuthCredentialsAndInvitations = async ({
  tx,
  currentUserId,
  email,
}: RevokeAuthCredentialsParams): Promise<void> => {
  await tx.delete(account).where(eq(account.userId, currentUserId));
  // eslint-disable-next-line auth-lifecycle/no-direct-auth-artifact-delete -- Account deletion must revoke Better Auth session artifacts.
  await tx.delete(session).where(eq(session.userId, currentUserId));
  await tx.delete(twoFactor).where(eq(twoFactor.userId, currentUserId));
  // Delete invitations sent by the user, and also invitations sent to the user's email
  await tx.delete(invitation).where(eq(invitation.inviterId, currentUserId));
  await tx.delete(invitation).where(eq(invitation.email, email));
};

export const REVOKE_OAUTH_TOKENS_TABLES = [
  oauthAccessToken,
  oauthRefreshToken,
  oauthConsent,
  oauthClient,
] as const satisfies readonly PgTable[];

/**
 * 2. OAuth / Better-Auth token tables (auth-schema).
 */
export const revokeOAuthTokensAndGrants = async (
  tx: Transaction,
  currentUserId: string,
): Promise<void> => {
  // eslint-disable-next-line auth-lifecycle/no-direct-auth-artifact-delete -- Account deletion must revoke Better Auth OAuth access tokens.
  await tx
    .delete(oauthAccessToken)
    .where(eq(oauthAccessToken.userId, currentUserId));
  // eslint-disable-next-line auth-lifecycle/no-direct-auth-artifact-delete -- Account deletion must revoke Better Auth OAuth refresh tokens.
  await tx
    .delete(oauthRefreshToken)
    .where(eq(oauthRefreshToken.userId, currentUserId));
  await tx.delete(oauthConsent).where(eq(oauthConsent.userId, currentUserId));
  await tx.delete(oauthClient).where(eq(oauthClient.userId, currentUserId));
};

export const DELETE_MCP_CREDENTIALS_TABLES = [
  mcpUserConnections,
  mcpOAuthState,
] as const satisfies readonly PgTable[];

/**
 * 3. MCP credentials and in-flight OAuth state (schema.ts, cascade on user.id).
 */
export const deleteMcpCredentialsAndOAuthState = async (
  tx: Transaction,
  currentUserId: string,
): Promise<void> => {
  await tx
    .delete(mcpUserConnections)
    .where(eq(mcpUserConnections.userId, currentUserId));
  await tx.delete(mcpOAuthState).where(eq(mcpOAuthState.userId, currentUserId));
};

export const CLEAR_WORKSPACE_LEAD_ROLE_TABLES = [
  workspaces,
] as const satisfies readonly PgTable[];

/**
 * 4. Workspace lead role — membership deletion happens after task handoff.
 */
export const clearWorkspaceLeadRole = async (
  tx: Transaction,
  currentUserId: string,
): Promise<void> => {
  await tx
    .update(workspaces)
    .set({ leadUserId: null })
    .where(eq(workspaces.leadUserId, currentUserId));
};

export type ReassignActiveTaskAssignmentsParams = {
  tx: Transaction;
  currentUserId: string;
  deletionRequestId: SafeId<"accountDeletionRequest">;
  reassignments:
    | readonly {
        entityId: SafeId<"entity">;
        reassignedUserId: string;
      }[]
    | undefined;
};

export const REASSIGN_ACTIVE_TASKS_TABLES = [
  taskAssignees,
  member,
  workspaceMembers,
] as const satisfies readonly PgTable[];

/**
 * 5. Active task assignee records require handoff. Completed/cancelled
 * assignments remain as historical activity on the deleted user row.
 *
 * Also drops the user's `member` and `workspaceMembers` rows — membership
 * deletion happens after task handoff (see step 4's comment).
 *
 * Returns the number of task assignments that were reassigned, for the
 * account-deletion request record.
 */
export const reassignActiveTaskAssignmentsAndDropMemberships = async ({
  tx,
  currentUserId,
  deletionRequestId,
  reassignments,
}: ReassignActiveTaskAssignmentsParams): Promise<number> => {
  let taskReassignmentCount = 0;

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
    currentTaskAssignments.length > LIMITS.accountDeletionTaskAssignmentsMax
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
                inArray(entities.status, ACTIVE_TASK_REASSIGNMENT_STATUSES),
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
    const reassignmentTargets = buildAccountDeletionTaskReassignmentTargets({
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
                currentTaskAssignments.map((assignment) => assignment.entityId),
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

  return taskReassignmentCount;
};

export type DeleteDesktopEditSessionsParams = {
  tx: Transaction;
  currentUserId: string;
  s3KeysToDelete: string[];
};

export const DELETE_DESKTOP_EDIT_SESSIONS_TABLES = [
  desktopEditSessions,
  desktopEditHandoffs,
] as const satisfies readonly PgTable[];

/**
 * 6. Desktop edit sessions and handoffs (cascade on createdBy → user.id).
 */
export const deleteDesktopEditSessionsAndHandoffs = async ({
  tx,
  currentUserId,
  s3KeysToDelete,
}: DeleteDesktopEditSessionsParams): Promise<void> => {
  const desktopCheckpointRows = await tx
    .select({
      checkpointFileId: desktopEditSessions.checkpointFileId,
      organizationId: workspaces.organizationId,
      workspaceId: desktopEditSessions.workspaceId,
    })
    .from(desktopEditSessions)
    .innerJoin(workspaces, eq(workspaces.id, desktopEditSessions.workspaceId))
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
};

export type DeleteFolioCollabSessionsParams = {
  tx: Transaction;
  currentUserId: string;
  s3KeysToDelete: string[];
};

export const DELETE_FOLIO_COLLAB_SESSIONS_TABLES = [
  folioCollabSessions,
] as const satisfies readonly PgTable[];

/**
 * 7. Folio collab sessions — tokens cascade when session is deleted.
 */
export const deleteFolioCollabSessions = async ({
  tx,
  currentUserId,
  s3KeysToDelete,
}: DeleteFolioCollabSessionsParams): Promise<void> => {
  const folioCheckpointRows = await tx
    .select({
      docxCheckpointFileId: folioCollabSessions.docxCheckpointFileId,
      docxCheckpointUpdatedAt: folioCollabSessions.docxCheckpointUpdatedAt,
      organizationId: workspaces.organizationId,
      workspaceId: folioCollabSessions.workspaceId,
      yjsSnapshotFileId: folioCollabSessions.yjsSnapshotFileId,
      yjsSnapshotUpdatedAt: folioCollabSessions.yjsSnapshotUpdatedAt,
    })
    .from(folioCollabSessions)
    .innerJoin(workspaces, eq(workspaces.id, folioCollabSessions.workspaceId))
    .where(eq(folioCollabSessions.createdBy, currentUserId));
  for (const row of folioCheckpointRows) {
    if (row.yjsSnapshotUpdatedAt !== null) {
      s3KeysToDelete.push(
        createFileKey({
          fileId: row.yjsSnapshotFileId,
          mimeType: FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE,
          organizationId: brandPersistedOrganizationId(row.organizationId),
          workspaceId: brandPersistedWorkspaceId(row.workspaceId),
        }),
      );
    }

    if (row.docxCheckpointUpdatedAt !== null) {
      s3KeysToDelete.push(
        createFileKey({
          fileId: row.docxCheckpointFileId,
          mimeType: DOCX_MIME_TYPE,
          organizationId: brandPersistedOrganizationId(row.organizationId),
          workspaceId: brandPersistedWorkspaceId(row.workspaceId),
        }),
      );
    }
  }

  await tx
    .delete(folioCollabSessions)
    .where(eq(folioCollabSessions.createdBy, currentUserId));
};

export type DeletePendingUploadsParams = {
  tx: Transaction;
  currentUserId: string;
  s3KeysToDelete: string[];
};

export const DELETE_PENDING_UPLOADS_TABLES = [
  pendingUploads,
] as const satisfies readonly PgTable[];

/**
 * 8. Pending (in-flight) S3 uploads.
 */
export const deletePendingUploads = async ({
  tx,
  currentUserId,
  s3KeysToDelete,
}: DeletePendingUploadsParams): Promise<void> => {
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
};

export type DeleteUserFilesParams = {
  tx: Transaction;
  currentUserId: string;
  s3KeysToDelete: string[];
};

export const DELETE_USER_FILES_TABLES = [
  userFiles,
] as const satisfies readonly PgTable[];

/**
 * 9. Personal user files (private S3 uploads) — must delete userFiles
 * before chatThreads because userFiles.threadId has onDelete: "restrict"
 * reference to chatThreads.id.
 */
export const deleteUserFiles = async ({
  tx,
  currentUserId,
  s3KeysToDelete,
}: DeleteUserFilesParams): Promise<void> => {
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
};

export const DELETE_CHAT_THREADS_TABLES = [
  fileChatThreads,
  chatThreads,
] as const satisfies readonly PgTable[];

/**
 * 10. AI chat threads — messages and fileChatThreads cascade on thread
 * deletion.
 */
export const deleteChatThreadsAndFileLinks = async (
  tx: Transaction,
  currentUserId: string,
): Promise<void> => {
  await tx
    .delete(fileChatThreads)
    .where(eq(fileChatThreads.userId, currentUserId));
  await tx.delete(chatThreads).where(eq(chatThreads.userId, currentUserId));
};

export const DELETE_WORKSPACE_VIEW_TEMPLATES_TABLES = [
  workspaceViewTemplates,
  agentSkills,
] as const satisfies readonly PgTable[];

/**
 * 11. Personal workspace view templates and agent skills.
 */
export const deletePersonalWorkspaceViewTemplatesAndAgentSkills = async (
  tx: Transaction,
  currentUserId: string,
): Promise<void> => {
  await tx
    .delete(workspaceViewTemplates)
    .where(eq(workspaceViewTemplates.userId, currentUserId));
  await tx.delete(agentSkills).where(eq(agentSkills.userId, currentUserId));
};

export const DELETE_BILLING_RATES_TABLES = [
  rateEntries,
] as const satisfies readonly PgTable[];

/**
 * 12. Personal billing rates.
 */
export const deletePersonalBillingRates = async (
  tx: Transaction,
  currentUserId: string,
): Promise<void> => {
  await tx.delete(rateEntries).where(eq(rateEntries.userId, currentUserId));
};

export type RecordAccountDeletionRequestParams = {
  tx: Transaction;
  deletionRequestId: SafeId<"accountDeletionRequest">;
  currentUserId: string;
  organizationIds: SafeId<"organization">[];
  workspaceIds: SafeId<"workspace">[];
  taskReassignmentCount: number;
  s3KeysToDelete: string[];
};

/**
 * Records the account-deletion request — used both as an audit trail and,
 * when there are S3 keys to reclaim, as the work item the storage-cleanup
 * queue processes after the transaction commits.
 */
export const recordAccountDeletionRequest = async ({
  tx,
  deletionRequestId,
  currentUserId,
  organizationIds,
  workspaceIds,
  taskReassignmentCount,
  s3KeysToDelete,
}: RecordAccountDeletionRequestParams): Promise<void> => {
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
};

/**
 * 13. Mark the account deleted and release private contact/login fields.
 */
export const finalizeDeletedUserRecord = async (
  tx: Transaction,
  currentUserId: string,
): Promise<void> => {
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
};

/**
 * Every table with a direct foreign key to the auth `user` table that is
 * explicitly deleted, cleared, or reassigned by a step in
 * `verifyAndDeleteUser`. Derived from the `*_TABLES` constants declared
 * next to each step above, rather than maintained as a free-floating list,
 * so it cannot silently drift from the actual deletion code.
 *
 * See `account-deletion-coverage.test.ts` for how this is checked against
 * the schema.
 */
export const ACCOUNT_DELETION_MANUAL_TABLES = [
  ...REVOKE_AUTH_CREDENTIALS_TABLES,
  ...REVOKE_OAUTH_TOKENS_TABLES,
  ...DELETE_MCP_CREDENTIALS_TABLES,
  ...CLEAR_WORKSPACE_LEAD_ROLE_TABLES,
  ...REASSIGN_ACTIVE_TASKS_TABLES,
  ...DELETE_DESKTOP_EDIT_SESSIONS_TABLES,
  ...DELETE_FOLIO_COLLAB_SESSIONS_TABLES,
  ...DELETE_PENDING_UPLOADS_TABLES,
  ...DELETE_USER_FILES_TABLES,
  ...DELETE_CHAT_THREADS_TABLES,
  ...DELETE_WORKSPACE_VIEW_TEMPLATES_TABLES,
  ...DELETE_BILLING_RATES_TABLES,
] as const satisfies readonly PgTable[];
