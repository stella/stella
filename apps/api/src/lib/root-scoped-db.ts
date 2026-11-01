import { WORKSPACE_ACCESS_MODE } from "@/api/db/rls";
import { rlsDb } from "@/api/db/root";
import type { Transaction } from "@/api/db/root";
import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  createMembershipSafeDb,
  createSafeDb,
  createScopedDb,
  createTenantlessDb,
} from "@/api/db/scoped";
import type { CurrentMembershipScope, RlsDatabase } from "@/api/db/scoped";
import type { SafeId, SafeIdType } from "@/api/lib/branded-types";
import {
  brandPersistedOrganizationId,
  brandPersistedUserId,
  brandValidatedWorkflowActorKey,
} from "@/api/lib/safe-id-boundaries";

/** Module-private, so the handle types below are constructible only here. */
const MEMBERSHIP_SCOPE: unique symbol = Symbol("stella.membershipScope");
const EXPLICIT_PIN: unique symbol = Symbol("stella.explicitPin");

/** A handle whose workspace reach is the user's membership as it stands when
 *  each transaction runs, with no stored workspace ids added. */
export type MembershipScopedDb = ScopedDb & {
  readonly [MEMBERSHIP_SCOPE]: true;
};
/** The `Result` form of `MembershipScopedDb`. */
export type MembershipSafeDb = SafeDb & { readonly [MEMBERSHIP_SCOPE]: true };

/** A run's handle pinned to the workspace proved when it was queued; the
 *  workspace stays reachable through it without a current membership. */
type PinnedScopedDb = ScopedDb & { readonly [EXPLICIT_PIN]: true };
/** The `Result` form of `PinnedScopedDb`. */
type PinnedSafeDb = SafeDb & { readonly [EXPLICIT_PIN]: true };

/**
 * What a reader of documents, files, or fields takes: any handle except a
 * run's pinned one. A request passes its own membership scope; a queued run
 * passes its `inputSafeDb`, never its `writeSafeDb`.
 */
export type ContentReadDb = SafeDb & { readonly [EXPLICIT_PIN]?: never };

type RootScopedDbOptions = {
  organizationId: SafeId<"organization">;
} & (
  | { workspaceIds: SafeId<"workspace">[]; userId: SafeId<"user"> | null }
  | { workspaceScope: CurrentMembershipScope; userId: SafeId<"user"> }
);

type OrganizationBackgroundScopeOptions = {
  organizationId: SafeId<"organization">;
  userId: null;
  workspaceScope: typeof NO_STORED_WORKSPACES;
};

export const createRootScopedDb = (
  options: RootScopedDbOptions | OrganizationBackgroundScopeOptions,
  database: RlsDatabase<Transaction> = rlsDb,
) => {
  // This helper exists only because some modules are not allowed
  // to import the RLS database handle directly.
  if ("workspaceScope" in options) {
    return createScopedDb(
      database,
      options.workspaceScope,
      options.organizationId,
      options.userId,
    );
  }
  return createScopedDb(
    database,
    options.workspaceIds,
    options.organizationId,
    options.userId,
  );
};

type PinnedOptions = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user"> | null;
  workspaceIds: SafeId<"workspace">[];
};

type MembershipOptions = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

const NO_STORED_WORKSPACES = {
  type: WORKSPACE_ACCESS_MODE.membership,
  serverValidatedWorkspaceIds: [],
} as const satisfies CurrentMembershipScope;

/** Background organization work has no user or matter authority. */
export const createRootOrganizationBackgroundDb = (
  organizationId: SafeId<"organization">,
  database?: RlsDatabase<Transaction>,
) =>
  createRootScopedDb(
    {
      organizationId: brandPersistedOrganizationId(organizationId),
      userId: null,
      workspaceScope: NO_STORED_WORKSPACES,
    },
    database,
  );

export const createRootSafeDb = (
  options: RootScopedDbOptions,
  database: RlsDatabase<Transaction> = rlsDb,
) => {
  // This helper exists only because some modules are not allowed
  // to import the RLS database handle directly.
  if ("workspaceScope" in options) {
    return createMembershipSafeDb(database, {
      organizationId: options.organizationId,
      userId: options.userId,
      serverValidatedWorkspaceIds:
        options.workspaceScope.serverValidatedWorkspaceIds,
    });
  }
  return createSafeDb(
    database,
    options.workspaceIds,
    options.organizationId,
    options.userId,
  );
};

/** A deferred read uses current membership without adding stored matter IDs. */
export const createRootMembershipScopedDb = (
  { organizationId, userId }: MembershipOptions,
  database?: RlsDatabase<Transaction>,
): MembershipScopedDb =>
  Object.assign(
    createRootScopedDb(
      { organizationId, userId, workspaceScope: NO_STORED_WORKSPACES },
      database,
    ),
    { [MEMBERSHIP_SCOPE]: true as const },
  );

/** The `Result` form of `createRootMembershipScopedDb`. */
export const createRootMembershipSafeDb = (
  { organizationId, userId }: MembershipOptions,
  database?: RlsDatabase<Transaction>,
): MembershipSafeDb =>
  Object.assign(
    createRootSafeDb(
      { organizationId, userId, workspaceScope: NO_STORED_WORKSPACES },
      database,
    ),
    { [MEMBERSHIP_SCOPE]: true as const },
  );

const createPinnedScopedDb = (
  options: PinnedOptions,
  database: RlsDatabase<Transaction> | undefined,
): PinnedScopedDb =>
  Object.assign(createRootScopedDb(options, database), {
    [EXPLICIT_PIN]: true as const,
  });

const createPinnedSafeDb = (
  options: PinnedOptions,
  database: RlsDatabase<Transaction> | undefined,
): PinnedSafeDb =>
  Object.assign(createRootSafeDb(options, database), {
    [EXPLICIT_PIN]: true as const,
  });

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

/**
 * A queued run a member requested, and the handles it acts through.
 *
 * The member proved access to the run's workspace when they queued it.
 * `writeDb` keeps that workspace pinned, for the run's own bookkeeping and
 * the output the member asked for. `inputDb` reads what the run works on
 * under the requester's membership as it stands now, so a run whose
 * requester has since lost the matter or the organization reads nothing.
 * Readers of documents, files and fields take `ContentReadDb`, which a
 * pinned handle is not. A run with no workspace (`workspaceId: null`) pins
 * nothing: its `writeDb` reaches only the member's own organization rows.
 */
export type RootRunActor<
  TRun extends SafeIdType,
  TWorkspace extends SafeId<"workspace"> | null = SafeId<"workspace">,
> = {
  writeDb: PinnedScopedDb;
  writeSafeDb: PinnedSafeDb;
  inputDb: MembershipScopedDb;
  inputSafeDb: MembershipSafeDb;
  organizationId: SafeId<"organization">;
  workspaceId: TWorkspace;
  userId: SafeId<"user">;
  runId: SafeId<TRun>;
};

type RootRunActorData<TWorkspace extends string | null> = {
  organizationId: string;
  workspaceId: TWorkspace;
  userId: string;
  runId: string;
};

export function createRootRunActor<TRun extends SafeIdType>(
  data: RootRunActorData<string>,
  brandRunId: (runId: string) => SafeId<TRun>,
  database?: RlsDatabase<Transaction>,
): RootRunActor<TRun>;
export function createRootRunActor<TRun extends SafeIdType>(
  data: RootRunActorData<string | null>,
  brandRunId: (runId: string) => SafeId<TRun>,
  database?: RlsDatabase<Transaction>,
): RootRunActor<TRun, SafeId<"workspace"> | null>;
export function createRootRunActor<TRun extends SafeIdType>(
  data: RootRunActorData<string | null>,
  brandRunId: (runId: string) => SafeId<TRun>,
  database?: RlsDatabase<Transaction>,
): RootRunActor<TRun, SafeId<"workspace"> | null> {
  const organizationId = brandPersistedOrganizationId(data.organizationId);
  const workspaceId =
    data.workspaceId === null
      ? null
      : brandValidatedWorkflowActorKey({
          organizationId: data.organizationId,
          workspaceId: data.workspaceId,
        }).workspaceId;
  const userId = brandPersistedUserId(data.userId);
  const tenant = {
    organizationId,
    userId,
    workspaceIds: workspaceId === null ? [] : [workspaceId],
  };
  const member = { organizationId, userId };
  return {
    organizationId,
    workspaceId,
    userId,
    runId: brandRunId(data.runId),
    writeDb: createPinnedScopedDb(tenant, database),
    writeSafeDb: createPinnedSafeDb(tenant, database),
    inputDb: createRootMembershipScopedDb(member, database),
    inputSafeDb: createRootMembershipSafeDb(member, database),
  };
}
