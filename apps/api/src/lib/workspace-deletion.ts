import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { CLIENT_MATTER_ADMIN_ROLES } from "@stll/permissions";

import { rootDb } from "@/api/db/root";
import type { Transaction } from "@/api/db/root";
import { documentProcessingRuns, workspaces } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import {
  lockMatterAccessAssignments,
  lockMatterAccessWorkspaceRows,
  lockMemberAccessRow,
  lockWorkspaceLifecycle,
  withAggregateTransaction,
} from "@/api/lib/db/aggregate-lock";
import { handoffCommittedEntityDeletionCleanupBatch } from "@/api/lib/entity-deletion-cleanup-handoff";
import { enqueueEntityDeletionCleanup } from "@/api/lib/entity-deletion-cleanup-queue";
import { isMemberRole } from "@/api/lib/member-roles";
import type { MemberRole } from "@/api/lib/member-roles";
import { completeWorkspaceDeletion } from "@/api/lib/organization-storage-teardown";
import { hasCurrentMemberPermission } from "@/api/lib/permission-authorization";
import { getPgErrorCode, PG_ERROR } from "@/api/lib/pg-error";
import { memberReachesMatterSql } from "@/api/lib/workspaces/authorized-workspace-ids";

const WORKSPACE_DELETION_DEADLOCK_RETRIES = 2;

export type WorkspaceDeletionDatabase = {
  transaction: <TResult>(
    callback: (tx: Transaction) => Promise<TResult>,
  ) => Promise<TResult>;
};

export type WorkspaceDeletionDependencies = {
  captureDeliveryError?: typeof captureError;
  database?: WorkspaceDeletionDatabase;
  enqueueCleanup?: typeof enqueueEntityDeletionCleanup;
};

type ExecuteAuthorizedWorkspaceDeletionOptions = {
  actorUserId: SafeId<"user">;
  organizationId: SafeId<"organization">;
  recordAuditEvent: AuditRecorder;
  workspaceId: SafeId<"workspace">;
};

export type WorkspaceDeletionOutcome =
  | { status: "deleted" }
  | { status: "document-processing-running" }
  | { status: "not-authorized" }
  | { status: "not-found" }
  | { status: "workspace-unavailable" };

type TransactionWorkspaceDeletionOutcome =
  | Exclude<WorkspaceDeletionOutcome, { status: "deleted" }>
  | {
      cleanupRequestIds: SafeId<"entityDeletionCleanupRequest">[];
      status: "deleted";
    };

const lockAuthorizedActorRole = async ({
  actorUserId,
  organizationId,
  tx,
}: {
  actorUserId: SafeId<"user">;
  organizationId: SafeId<"organization">;
  tx: Transaction;
}): Promise<MemberRole | null> => {
  // NO KEY UPDATE still waits for member-first access holds (FOR SHARE), role
  // changes and member removal, but stays compatible with the FOR KEY SHARE a
  // matter-first path (adding this user to the matter) takes after locking
  // the matter row; FOR UPDATE would deadlock against such a path.
  const actor = await lockMemberAccessRow({
    tx,
    organizationId,
    userId: actorUserId,
    mode: "no key update",
  });
  if (
    !actor ||
    !isMemberRole(actor.role) ||
    // Re-checks the actor's live role under the row lock; the request already
    // spent its credential's `workspace:delete` at the handler boundary.
    !hasCurrentMemberPermission(actor.role, {
      workspace: ["delete"],
    })
  ) {
    return null;
  }
  return actor.role;
};

const actorCanAccessWorkspace = async ({
  actorRole,
  actorUserId,
  organizationId,
  tx,
  workspace,
}: {
  actorRole: MemberRole;
  actorUserId: SafeId<"user">;
  organizationId: SafeId<"organization">;
  tx: Transaction;
  workspace: { clientId: string | null; id: SafeId<"workspace"> };
}): Promise<boolean> => {
  // This condition only preserves the assignment-lock scope. The database
  // rule in the later statement alone decides matter reach.
  if (!(
    workspace.clientId !== null &&
    CLIENT_MATTER_ADMIN_ROLES.some((role) => role === actorRole)
  )) {
    await lockMatterAccessAssignments({
      tx,
      organizationId,
      userId: actorUserId,
      workspaceIds: [workspace.id],
      mode: "update",
    });
  }
  const rows = await tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      and(
        eq(workspaces.id, workspace.id),
        eq(workspaces.organizationId, organizationId),
        memberReachesMatterSql(
          { organizationId, userId: actorUserId },
          workspaces.id,
        ),
      ),
    )
    .limit(1);
  return rows.length === 1;
};

/**
 * Reauthorize and complete one matter deletion in the owner transaction. Root
 * access stays contained in this command, which proves the actor and exact
 * tenant target again before performing lifecycle-wide cleanup.
 */
export const executeAuthorizedWorkspaceDeletion = async (
  {
    actorUserId,
    organizationId,
    recordAuditEvent,
    workspaceId,
  }: ExecuteAuthorizedWorkspaceDeletionOptions,
  dependencies: WorkspaceDeletionDependencies = {},
): Promise<Result<WorkspaceDeletionOutcome, unknown>> => {
  const database = dependencies.database ?? {
    transaction: async <TResult>(
      callback: (tx: Transaction) => Promise<TResult>,
    ) => await rootDb.transaction(callback),
  };
  const runTransaction = async (
    attempt = 0,
  ): Promise<TransactionWorkspaceDeletionOutcome> => {
    try {
      return await withAggregateTransaction(database, async (tx) => {
        const actorRole = await lockAuthorizedActorRole({
          actorUserId,
          organizationId,
          tx,
        });
        if (actorRole === null) {
          return { status: "not-authorized" } as const;
        }

        await lockWorkspaceLifecycle(tx, workspaceId);
        await lockMatterAccessWorkspaceRows({
          tx,
          organizationId,
          workspaceIds: [workspaceId],
          mode: "update",
        });

        const workspaceRows = await tx
          .select({
            billingReference: workspaces.billingReference,
            clientId: workspaces.clientId,
            color: workspaces.color,
            id: workspaces.id,
            name: workspaces.name,
            reference: workspaces.reference,
            status: workspaces.status,
          })
          .from(workspaces)
          .where(
            and(
              eq(workspaces.id, workspaceId),
              eq(workspaces.organizationId, organizationId),
            ),
          )
          .limit(1);
        const workspace = workspaceRows.at(0);
        if (!workspace) {
          return { status: "not-found" } as const;
        }

        const authorized = await actorCanAccessWorkspace({
          actorRole,
          actorUserId,
          organizationId,
          tx,
          workspace,
        });
        if (!authorized) {
          return { status: "not-authorized" } as const;
        }
        if (workspace.status !== "active") {
          return { status: "workspace-unavailable" } as const;
        }

        const runningOcrRuns = await tx
          .select({ id: documentProcessingRuns.id })
          .from(documentProcessingRuns)
          .where(
            and(
              eq(documentProcessingRuns.workspaceId, workspaceId),
              eq(documentProcessingRuns.status, "running"),
            ),
          )
          .limit(1);
        if (runningOcrRuns.length > 0) {
          return { status: "document-processing-running" } as const;
        }

        // audit: skip; internal write fence for the DELETE event below.
        await tx
          .update(workspaces)
          .set({ status: "deleting" })
          .where(eq(workspaces.id, workspaceId));

        const teardown = await completeWorkspaceDeletion({
          organizationId,
          tx,
          workspaceId,
        });
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.DELETE,
          resourceType: AUDIT_RESOURCE_TYPE.WORKSPACE,
          resourceId: workspaceId,
          changes: { deleted: { old: workspace, new: null } },
        });

        return {
          cleanupRequestIds: teardown.requestIds,
          status: "deleted",
        } as const;
      });
    } catch (error) {
      if (
        getPgErrorCode(error) === PG_ERROR.DEADLOCK_DETECTED &&
        attempt < WORKSPACE_DELETION_DEADLOCK_RETRIES
      ) {
        return await runTransaction(attempt + 1);
      }
      throw error;
    }
  };
  const transactionResult = await Result.tryPromise({
    try: async () => await runTransaction(),
    catch: (cause: unknown): unknown => cause,
  });
  if (Result.isError(transactionResult)) {
    return Result.err(transactionResult.error);
  }

  if (transactionResult.value.status !== "deleted") {
    return Result.ok(transactionResult.value);
  }
  await handoffCommittedEntityDeletionCleanupBatch({
    captureDeliveryError: dependencies.captureDeliveryError ?? captureError,
    enqueueCleanup: dependencies.enqueueCleanup ?? enqueueEntityDeletionCleanup,
    requestIds: transactionResult.value.cleanupRequestIds,
  });
  return Result.ok({ status: "deleted" });
};
