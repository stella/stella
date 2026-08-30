import { Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import { member } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import type { Transaction } from "@/api/db/root";
import {
  documentProcessingRuns,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { handoffCommittedEntityDeletionCleanupBatch } from "@/api/lib/entity-deletion-cleanup-handoff";
import { enqueueEntityDeletionCleanup } from "@/api/lib/entity-deletion-cleanup-queue";
import { isMemberRole } from "@/api/lib/member-roles";
import type { MemberRole } from "@/api/lib/member-roles";
import { completeWorkspaceDeletion } from "@/api/lib/organization-storage-teardown";
import { hasMemberPermission } from "@/api/lib/permission-authorization";
import { getPgErrorCode, PG_ERROR } from "@/api/lib/pg-error";

const ORGANIZATION_WIDE_WORKSPACE_ROLES = new Set(["owner", "admin"]);
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
  const memberRows = await tx
    .select({ role: member.role })
    .from(member)
    .where(
      and(
        eq(member.organizationId, organizationId),
        eq(member.userId, actorUserId),
      ),
    )
    .limit(1)
    .for("update");
  const actor = memberRows.at(0);
  if (
    !actor ||
    !isMemberRole(actor.role) ||
    !hasMemberPermission({ role: actor.role }, { workspace: ["delete"] })
  ) {
    return null;
  }
  return actor.role;
};

const actorCanAccessWorkspace = async ({
  actorRole,
  actorUserId,
  tx,
  workspace,
}: {
  actorRole: MemberRole;
  actorUserId: SafeId<"user">;
  tx: Transaction;
  workspace: { clientId: string | null; id: SafeId<"workspace"> };
}): Promise<boolean> => {
  if (
    workspace.clientId !== null &&
    ORGANIZATION_WIDE_WORKSPACE_ROLES.has(actorRole)
  ) {
    return true;
  }

  const workspaceMemberRows = await tx
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspace.id),
        eq(workspaceMembers.userId, actorUserId),
      ),
    )
    .limit(1)
    .for("update");
  return workspaceMemberRows.length === 1;
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
      return await database.transaction(async (tx) => {
        const actorRole = await lockAuthorizedActorRole({
          actorUserId,
          organizationId,
          tx,
        });
        if (actorRole === null) {
          return { status: "not-authorized" } as const;
        }

        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}))`,
        );
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
          .limit(1)
          .for("update");
        const workspace = workspaceRows.at(0);
        if (!workspace) {
          return { status: "not-found" } as const;
        }

        const authorized = await actorCanAccessWorkspace({
          actorRole,
          actorUserId,
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
