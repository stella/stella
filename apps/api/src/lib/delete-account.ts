import { Result } from "better-result";
import { and, eq, inArray, ne } from "drizzle-orm";

import { account, invitation, member, oauthAccessToken, oauthClient, oauthConsent, oauthRefreshToken, organization, session, user, verification } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import {
  agentSkills,
  chatThreads,
  desktopEditHandoffs,
  desktopEditSessions,
  entities,
  fileChatThreads,
  folioCollabSessions,
  mcpOAuthState,
  mcpUserConnections,
  pendingUploads,
  promptShortcuts,
  rateEntries,
  taskAssignees,
  userFiles,
  workspaceMembers,
  workspaceViewTemplates,
  workspaces,
} from "@/api/db/schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { SafeId } from "@/api/lib/branded-types";
import { createUserFileKey, deleteS3Keys } from "@/api/handlers/files/utils";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";

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

      for (const org of ownedOrgs) {
        const otherOwners = await rootDb
          .select({ id: member.id })
          .from(member)
          .where(
            and(
              eq(member.organizationId, org.orgId),
              eq(member.role, "owner"),
              ne(member.userId, currentUserId),
            ),
          )
          .limit(1);

        if (otherOwners.length === 0) {
          return { isSoleOwner: true, orgName: org.orgName };
        }
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

export interface PendingTask {
  assigneeId: string;
  entityId: string;
  role: "assignee" | "reviewer";
  taskName: string;
  workspaceId: string;
  workspaceName: string;
}

export interface WorkspaceMemberInfo {
  workspaceId: string;
  userId: string;
  userName: string;
}

/**
 * Fetches all pending tasks assigned to the user along with other workspace members for reassignment.
 */
export const getPendingTasksAndMembers = async (
  currentUserId: string,
): Promise<Result<{ tasks: PendingTask[]; members: WorkspaceMemberInfo[] }, HandlerError>> =>
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
        .where(eq(taskAssignees.userId, currentUserId));

      const workspaceIds = [...new Set(userAssignments.map((a) => a.workspaceId))];

      const otherMembers =
        workspaceIds.length > 0
          ? await rootDb
              .select({
                workspaceId: workspaceMembers.workspaceId,
                userId: user.id,
                userName: user.name,
              })
              .from(workspaceMembers)
              .innerJoin(user, eq(user.id, workspaceMembers.userId))
              .where(
                and(
                  inArray(workspaceMembers.workspaceId, workspaceIds),
                  ne(workspaceMembers.userId, currentUserId),
                ),
              )
          : [];

      return {
        tasks: userAssignments as PendingTask[],
        members: otherMembers,
      };
    },
    catch: (err) =>
      new HandlerError({
        status: 500,
        message: "Database query failed",
        cause: err,
      }),
  });


/**
 * Verifies the OTP and deletes the user from the database.
 */
export const verifyAndDeleteUser = async (
  currentUserId: string,
  email: string,
  code: string,
  reassignments?: readonly { entityId: string; reassignedUserId: string }[],
): Promise<Result<void, HandlerError>> =>
  await Result.tryPromise({
    try: async () => {
      const identifier = `delete-account:${email}`;

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
            status: 400,
            message: "Invalid verification code",
          });
        }

        if (verificationRow.expiresAt.getTime() < Date.now()) {
          await tx
            .delete(verification)
            .where(eq(verification.identifier, identifier));

          throw new HandlerError({
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
          .where(and(eq(member.userId, currentUserId), eq(member.role, "owner")))
          .for("update");

        for (const org of ownedOrgs) {
          const otherOwners = await tx
            .select({ id: member.id })
            .from(member)
            .where(
              and(
                eq(member.organizationId, org.orgId),
                eq(member.role, "owner"),
                ne(member.userId, currentUserId),
              ),
            )
            .limit(1)
            .for("update");

          if (otherOwners.length === 0) {
            throw new HandlerError({
              status: 400,
              message: `Cannot delete account because you are the sole owner of organization "${org.orgName}". Please transfer ownership or delete the organization first.`,
            });
          }
        }

        // audit: skip — ephemeral verification code deletion
        await tx
          .delete(verification)
          .where(eq(verification.id, verificationRow.id));

        // The user row is anonymized (UPDATE) rather than deleted to preserve
        // rows in tables with onDelete:restrict (templates.createdBy, clauses.createdBy,
        // usageEvents.userId, etc.) which form the audit trail. Because no DELETE
        // fires on the user row, none of the onDelete:cascade / onDelete:set null
        // constraints trigger automatically — we must clean up every linked table
        // explicitly below.

        // 1. Auth credentials, sessions, and invitations (auth-schema tables)
        await tx.delete(account).where(eq(account.userId, currentUserId));
        // eslint-disable-next-line auth-lifecycle/no-direct-auth-artifact-delete
        await tx.delete(session).where(eq(session.userId, currentUserId));
        await tx.delete(member).where(eq(member.userId, currentUserId));
        // Delete invitations sent by the user, and also invitations sent to the user's email
        await tx.delete(invitation).where(eq(invitation.inviterId, currentUserId));
        await tx.delete(invitation).where(eq(invitation.email, email));

        // 2. OAuth / Better-Auth token tables (auth-schema)
        // eslint-disable-next-line auth-lifecycle/no-direct-auth-artifact-delete
        await tx.delete(oauthAccessToken).where(eq(oauthAccessToken.userId, currentUserId));
        // eslint-disable-next-line auth-lifecycle/no-direct-auth-artifact-delete
        await tx.delete(oauthRefreshToken).where(eq(oauthRefreshToken.userId, currentUserId));
        await tx.delete(oauthConsent).where(eq(oauthConsent.userId, currentUserId));
        await tx.delete(oauthClient).where(eq(oauthClient.userId, currentUserId));

        // 3. MCP credentials and in-flight OAuth state (schema.ts, cascade on user.id)
        await tx.delete(mcpUserConnections).where(eq(mcpUserConnections.userId, currentUserId));
        await tx.delete(mcpOAuthState).where(eq(mcpOAuthState.userId, currentUserId));

        // 4. Workspace memberships — clear lead role then delete member rows
        await tx
          .update(workspaces)
          .set({ leadUserId: null })
          .where(eq(workspaces.leadUserId, currentUserId));
        await tx
          .delete(workspaceMembers)
          .where(eq(workspaceMembers.userId, currentUserId));

        // 5. Task assignee records (reassign where requested, otherwise cascade)
        if (reassignments && reassignments.length > 0) {
          for (const item of reassignments) {
            // SAFETY: item.entityId is validated as a valid UUID string at the API boundary
            const entityId = item.entityId as SafeId<"entity">;

            const assignment = await tx
              .select({
                workspaceId: taskAssignees.workspaceId,
              })
              .from(taskAssignees)
              .where(
                and(
                  eq(taskAssignees.entityId, entityId),
                  eq(taskAssignees.userId, currentUserId),
                ),
              )
              .limit(1)
              .then((rows) => rows[0]);

            if (!assignment) {
              continue;
            }

            const isMember = await tx
              .select({ id: workspaceMembers.id })
              .from(workspaceMembers)
              .where(
                and(
                  eq(workspaceMembers.workspaceId, assignment.workspaceId),
                  eq(workspaceMembers.userId, item.reassignedUserId),
                ),
              )
              .limit(1)
              .then((rows) => rows[0]);

            if (!isMember) {
              await tx
                .delete(taskAssignees)
                .where(
                  and(
                    eq(taskAssignees.entityId, entityId),
                    eq(taskAssignees.userId, currentUserId),
                  ),
                );
              continue;
            }

            const existing = await tx
              .select({ id: taskAssignees.id })
              .from(taskAssignees)
              .where(
                and(
                  eq(taskAssignees.entityId, entityId),
                  eq(taskAssignees.userId, item.reassignedUserId),
                ),
              )
              .limit(1)
              .then((rows) => rows[0]);

            if (existing) {
              await tx
                .delete(taskAssignees)
                .where(
                  and(
                    eq(taskAssignees.entityId, entityId),
                    eq(taskAssignees.userId, currentUserId),
                  ),
                );
            } else {
              await tx
                .update(taskAssignees)
                .set({ userId: item.reassignedUserId })
                .where(
                  and(
                    eq(taskAssignees.entityId, entityId),
                    eq(taskAssignees.userId, currentUserId),
                  ),
                );
            }
          }
        }
        await tx.delete(taskAssignees).where(eq(taskAssignees.userId, currentUserId));

        // 6. Desktop edit sessions and handoffs (cascade on createdBy → user.id)
        await tx
          .delete(desktopEditHandoffs)
          .where(eq(desktopEditHandoffs.createdBy, currentUserId));
        await tx
          .delete(desktopEditSessions)
          .where(eq(desktopEditSessions.createdBy, currentUserId));

        // 7. Folio collab sessions — tokens cascade when session is deleted
        await tx
          .delete(folioCollabSessions)
          .where(eq(folioCollabSessions.createdBy, currentUserId));

        // 8. Pending (in-flight) S3 uploads
        await tx.delete(pendingUploads).where(eq(pendingUploads.userId, currentUserId));

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
          const s3Keys = files.flatMap((file) =>
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
          );
          const deleteResult = await deleteS3Keys(s3Keys);
          if (Result.isError(deleteResult)) {
            throw new HandlerError({
              status: 500,
              message: "Failed to delete user files from storage",
              cause: deleteResult.error,
            });
          }
        }
        await tx.delete(userFiles).where(eq(userFiles.userId, currentUserId));

        // 10. AI chat threads — messages and fileChatThreads cascade on thread deletion
        await tx.delete(fileChatThreads).where(eq(fileChatThreads.userId, currentUserId));
        await tx.delete(chatThreads).where(eq(chatThreads.userId, currentUserId));

        // 11. Personal workspace view templates, prompt shortcuts, agent skills
        await tx
          .delete(workspaceViewTemplates)
          .where(eq(workspaceViewTemplates.userId, currentUserId));
        await tx.delete(promptShortcuts).where(eq(promptShortcuts.userId, currentUserId));
        await tx.delete(agentSkills).where(eq(agentSkills.userId, currentUserId));

        // 12. Personal billing rates
        await tx.delete(rateEntries).where(eq(rateEntries.userId, currentUserId));

        // 3. Clear personal data in the user table and release the original email address
        await tx
          .update(user)
          .set({
            name: "Deleted User",
            email: `deleted-${currentUserId}@stella.placeholder`,
            emailVerified: false,
            image: null,
            preferredName: null,
            wordEditShortcut: null,
          })
          .where(eq(user.id, currentUserId));
      });
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
