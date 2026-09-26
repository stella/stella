import { rlsDb } from "@/api/db/root";
import type { Transaction } from "@/api/db/root";
import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  createSafeDb,
  createScopedDb,
  createTenantlessDb,
} from "@/api/db/scoped";
import type { SafeId, SafeIdType } from "@/api/lib/branded-types";
import {
  brandPersistedUserId,
  brandValidatedWorkflowActorKey,
} from "@/api/lib/safe-id-boundaries";

export const createRootScopedDb = ({
  organizationId,
  userId,
  workspaceIds,
}: {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceIds: SafeId<"workspace">[];
}) =>
  // This helper exists only because some modules are not allowed
  // to import the RLS database handle directly.
  createScopedDb(rlsDb, workspaceIds, organizationId, userId);

export const createRootSafeDb = ({
  organizationId,
  userId,
  workspaceIds,
}: {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceIds: SafeId<"workspace">[];
}) =>
  // This helper exists only because some modules are not allowed
  // to import the RLS database handle directly.
  createSafeDb(rlsDb, workspaceIds, organizationId, userId);

/**
 * The connections a token-authenticated call runs on: the application role
 * with no tenant settings for the SECURITY DEFINER token lookup, then scoped
 * to the tenant that lookup names.
 */
export type TokenScopedDatabase = {
  scoped: (scope: {
    organizationId: SafeId<"organization">;
    userId: SafeId<"user">;
    workspaceIds: SafeId<"workspace">[];
  }) => ScopedDb;
  tenantless: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T>;
};

export const tokenScopedDatabase: TokenScopedDatabase = {
  scoped: createRootScopedDb,
  tenantless: async (fn) => await createTenantlessDb(rlsDb)(fn),
};

/** A queued run's tenant, branded from its job data, and the handles that act
 *  for it inside the worker. */
export type RootRunActor<TRun extends SafeIdType> = {
  scopedDb: ScopedDb;
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  runId: SafeId<TRun>;
};

export const createRootRunActor = <TRun extends SafeIdType>(
  data: {
    organizationId: string;
    workspaceId: string;
    userId: string;
    runId: string;
  },
  brandRunId: (runId: string) => SafeId<TRun>,
): RootRunActor<TRun> => {
  const branded = brandValidatedWorkflowActorKey({
    organizationId: data.organizationId,
    workspaceId: data.workspaceId,
  });
  const userId = brandPersistedUserId(data.userId);
  const tenant = {
    organizationId: branded.organizationId,
    userId,
    workspaceIds: [branded.workspaceId],
  };
  return {
    organizationId: branded.organizationId,
    workspaceId: branded.workspaceId,
    userId,
    runId: brandRunId(data.runId),
    scopedDb: createRootScopedDb(tenant),
    safeDb: createRootSafeDb(tenant),
  };
};
