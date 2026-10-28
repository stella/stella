/**
 * Scoped database utilities — extracted from db/index.ts so
 * test files can import createScopedDb without triggering
 * the prod `rootDb = drizzle(DATABASE_URL, ...)` initialization.
 */

import { panic, Result, UnhandledException } from "better-result";
import { DrizzleQueryError, sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";

import {
  SETTING_ORGANIZATION_ID,
  SETTING_USER_ID,
  SETTING_WORKSPACE_ACCESS_MODE,
  SETTING_WORKSPACE_IDS,
  stella,
  stellaIngestion,
  WORKSPACE_ACCESS_MODE,
} from "@/api/db/rls";
import type { Transaction } from "@/api/db/root";
import { workspaces } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { withAggregateSavepoint } from "@/api/lib/db/aggregate-lock";
import { executedRows } from "@/api/lib/db/executed-rows";
import {
  DatabaseError,
  DatabaseRlsError,
} from "@/api/lib/errors/tagged-errors";
import type { FeatureAccessSnapshot } from "@/api/lib/feature-access/policy";
import {
  getPgDriverErrorCode,
  getPgErrorCode,
  PG_ERROR,
} from "@/api/lib/pg-error";
import { isRecord } from "@/api/lib/type-guards";

import { runUnderCorpusSchemaLane } from "./corpus-schema-lane";
import { resolveScopedFeatureIds } from "./scoped-feature-access";

// Generic constraint accepts any drizzle instance (prod or
// test PGlite) without importing test-only types.
type ScopedTransactionBase = {
  execute: (query: SQLWrapper | string) => PromiseLike<unknown>;
};

export type AnyDrizzle<
  TTransaction extends ScopedTransactionBase = ScopedTransactionBase,
> = {
  transaction: <TResult>(
    fn: (tx: TTransaction) => Promise<TResult>,
  ) => Promise<TResult>;
};

export type TransactionOf<TDatabase extends AnyDrizzle> =
  TDatabase extends AnyDrizzle<infer TTransaction> ? TTransaction : never;

const RLS_DATABASE_MARKER: unique symbol = Symbol("stella.rlsDatabase");

export type RlsDatabaseMarker = {
  readonly [RLS_DATABASE_MARKER]: true;
};

export type RlsDatabase<
  TTransaction extends ScopedTransactionBase = ScopedTransactionBase,
> = AnyDrizzle<TTransaction> & RlsDatabaseMarker;

export const markRlsDatabase = <TDatabase extends AnyDrizzle>(
  database: TDatabase,
): TDatabase & RlsDatabaseMarker =>
  Object.assign(database, { [RLS_DATABASE_MARKER]: true as const });

export type SafeDbRetryConfig<E = unknown> = {
  retry?: {
    times: number;
    delayMs: number;
    backoff: "linear" | "constant" | "exponential";
    shouldRetry?: (error: E) => boolean;
  };
};

type SafeDbError = DatabaseError | DatabaseRlsError | UnhandledException;

export type WorkspaceScope =
  | {
      type: typeof WORKSPACE_ACCESS_MODE.explicit;
      workspaceIds: SafeId<"workspace">[];
    }
  | {
      type: typeof WORKSPACE_ACCESS_MODE.membership;
      serverValidatedWorkspaceIds: readonly SafeId<"workspace">[];
    };

type RunScopedTransactionOptions<
  TTransaction extends ScopedTransactionBase,
  T,
> = {
  database: RlsDatabase<TTransaction>;
  fn: (tx: TTransaction) => Promise<T>;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user"> | null;
  workspaceScope: WorkspaceScope;
  featureAccessSnapshot?: FeatureAccessSnapshot | undefined;
};

type SetScopedTransactionSettingsOptions = {
  tx: ScopedTransactionBase;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user"> | null;
  workspaceScope: WorkspaceScope;
  featureIds: readonly string[];
};

const workspaceIdsSetting = (workspaceScope: WorkspaceScope): string => {
  const workspaceIds =
    workspaceScope.type === WORKSPACE_ACCESS_MODE.explicit
      ? workspaceScope.workspaceIds
      : workspaceScope.serverValidatedWorkspaceIds;
  return `{${workspaceIds.join(",")}}`;
};

/** Install the application role and its tenant scope on an open transaction. */
export const setScopedTransactionSettings = async ({
  tx,
  organizationId,
  userId,
  workspaceScope,
  featureIds,
}: SetScopedTransactionSettingsOptions): Promise<void> => {
  const wsIds = workspaceIdsSetting(workspaceScope);
  if (userId === null) {
    // A service actor has no membership-derived authority. Resolve its
    // explicit workspace IDs against the tenant before changing the role.
    await tx.execute(sql`SELECT set_config(
      '${sql.raw(SETTING_WORKSPACE_IDS)}',
      coalesce((
        SELECT pg_catalog.array_agg(${workspaces.id})::text
        FROM ${workspaces}
        WHERE ${workspaces.id} = ANY(${wsIds}::uuid[])
          AND ${workspaces.organizationId} = ${organizationId}
      ), '{}'),
      true
    )`);
  }

  await tx.execute(
    sql`SELECT
      set_config('role', '${sql.raw(stella.name)}', true),
      set_config('${sql.raw(SETTING_WORKSPACE_IDS)}', ${userId === null ? sql`pg_catalog.current_setting('${sql.raw(SETTING_WORKSPACE_IDS)}', true)` : sql`${wsIds}`}, true),
      set_config('${sql.raw(SETTING_WORKSPACE_ACCESS_MODE)}', ${workspaceScope.type}, true),
      set_config('${sql.raw(SETTING_ORGANIZATION_ID)}', ${organizationId}, true),
      set_config('${sql.raw(SETTING_USER_ID)}', ${userId ?? ""}, true),
      set_config('app.enabled_features', ${JSON.stringify(featureIds)}, true)`,
  );
};

type ScopedWorkInTransactionOptions<T> = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceScope: WorkspaceScope;
  fn: (tx: Transaction) => Promise<T>;
};

/** Keep aggregate cleanup atomic while lending it the application role. */
export const runScopedWorkInTransaction = async <T>({
  tx,
  organizationId,
  userId,
  workspaceScope,
  fn,
}: ScopedWorkInTransactionOptions<T>): Promise<T> => {
  const [previous] = await tx
    .select({
      role: sql<string>`current_user`,
      organizationId: sql<string>`coalesce(current_setting('app.organization_id', true), '')`,
      userId: sql<string>`coalesce(current_setting('app.user_id', true), '')`,
      workspaceIds: sql<string>`coalesce(current_setting('app.workspace_ids', true), '')`,
      workspaceAccessMode: sql<string>`coalesce(current_setting('app.workspace_access_mode', true), '')`,
      featureIds: sql<string>`coalesce(current_setting('app.enabled_features', true), '')`,
    })
    .from(sql`(SELECT 1) AS aggregate_context`);
  if (previous === undefined) {
    return panic("Aggregate transaction has no role context");
  }
  // A failed statement rolls back the savepoint and its settings together;
  // restoring on an aborted connection would hide the original error.
  const value = await withAggregateSavepoint(tx, async (scopedTx) => {
    const featureIds = await resolveScopedFeatureIds({
      tx: scopedTx,
      organizationId,
      userId,
    });
    await setScopedTransactionSettings({
      tx: scopedTx,
      organizationId,
      userId,
      workspaceScope,
      featureIds,
    });
    return await fn(scopedTx);
  });
  await tx.execute(sql`SELECT
    set_config('role', ${previous.role}, true),
    set_config('app.organization_id', ${previous.organizationId}, true),
    set_config('app.user_id', ${previous.userId}, true),
    set_config('app.workspace_ids', ${previous.workspaceIds}, true),
    set_config('app.workspace_access_mode', ${previous.workspaceAccessMode}, true),
    set_config('app.enabled_features', ${previous.featureIds}, true)
  `);
  return value;
};

export type CurrentMembershipScope = {
  type: typeof WORKSPACE_ACCESS_MODE.membership;
  serverValidatedWorkspaceIds: readonly [];
};

type ScopedDbArgs =
  | [
      workspaceIds: SafeId<"workspace">[],
      organizationId: SafeId<"organization">,
      userId: SafeId<"user"> | null,
    ]
  | [
      workspaceScope: CurrentMembershipScope,
      organizationId: SafeId<"organization">,
      userId: SafeId<"user"> | null,
    ];

const runScopedTransaction = async <
  TTransaction extends ScopedTransactionBase,
  T,
>({
  database,
  fn,
  organizationId,
  userId,
  workspaceScope,
  featureAccessSnapshot,
}: RunScopedTransactionOptions<TTransaction, T>): Promise<T> =>
  await database.transaction(async (tx: TTransaction) => {
    if (
      featureAccessSnapshot !== undefined &&
      (featureAccessSnapshot.organizationId !== organizationId ||
        featureAccessSnapshot.userId !== userId)
    ) {
      panic("Feature snapshot must belong to the database scope");
    }
    const featureIds =
      featureAccessSnapshot === undefined
        ? await resolveScopedFeatureIds({ tx, organizationId, userId })
        : [...featureAccessSnapshot.decisions]
            .filter(([, decision]) => decision.status === "enabled")
            .map(([featureId]) => featureId);
    await setScopedTransactionSettings({
      tx,
      organizationId,
      userId,
      workspaceScope,
      featureIds,
    });

    return await fn(tx);
  });

/**
 * Create a database scope from an explicit workspace set or a declared mode.
 * Request auth uses the membership factory below.
 */
export const createScopedDb =
  <TTransaction extends ScopedTransactionBase>(
    database: RlsDatabase<TTransaction>,
    ...[workspaceScope, organizationId, userId]: ScopedDbArgs
  ) =>
  async <T>(fn: (tx: TTransaction) => Promise<T>): Promise<T> =>
    await runScopedTransaction({
      database,
      workspaceScope: Array.isArray(workspaceScope)
        ? { type: WORKSPACE_ACCESS_MODE.explicit, workspaceIds: workspaceScope }
        : workspaceScope,
      organizationId,
      userId,
      fn,
    });

/**
 * A transaction on the application role with no tenant settings, for a call
 * that carries only a token. Every row policy is closed in it, so it reaches
 * nothing but what a SECURITY DEFINER lookup hands back for that token.
 */
export const createTenantlessDb =
  <TTransaction extends ScopedTransactionBase>(
    database: RlsDatabase<TTransaction>,
  ) =>
  async <T>(fn: (tx: TTransaction) => Promise<T>): Promise<T> =>
    await database.transaction(async (tx: TTransaction) => {
      await tx.execute(
        sql`SELECT set_config('role', '${sql.raw(stella.name)}', true)`,
      );
      return await fn(tx);
    });

type MembershipScopedDbOptions = {
  /** Authenticated request decisions reused for that request only. */
  featureAccessSnapshot?: FeatureAccessSnapshot | undefined;
  organizationId: SafeId<"organization">;
  /**
   * Small, operation-bounded set whose access was already proved by trusted
   * server code. These IDs remain authorized for the lifetime of each scoped
   * transaction, even if that transaction removes the actor's membership.
   * Never populate this from raw input or with a user's full workspace set.
   */
  serverValidatedWorkspaceIds: readonly SafeId<"workspace">[];
  userId: SafeId<"user">;
};

/**
 * Create an RLS scope derived from organization/user membership plus an
 * explicit bounded authorization snapshot (an empty list means no pins).
 */
export const createMembershipScopedDb =
  <TTransaction extends ScopedTransactionBase>(
    database: RlsDatabase<TTransaction>,
    {
      organizationId,
      serverValidatedWorkspaceIds,
      userId,
      featureAccessSnapshot,
    }: MembershipScopedDbOptions,
  ) =>
  async <T>(fn: (tx: TTransaction) => Promise<T>): Promise<T> =>
    await runScopedTransaction({
      database,
      workspaceScope: {
        type: WORKSPACE_ACCESS_MODE.membership,
        serverValidatedWorkspaceIds,
      },
      organizationId,
      userId,
      featureAccessSnapshot,
      fn,
    });

export type CreateIngestionDbOptions<
  TTransaction extends ScopedTransactionBase = ScopedTransactionBase,
> = {
  /** Owner-only maintenance receipts surround canonical role-scoped writes in the same transaction. */
  maintenance?: {
    before: (tx: TTransaction) => Promise<void>;
    after: (tx: TTransaction) => Promise<void>;
  };
  /**
   * How long a batch keeps trying to enter the corpus schema lane. Pass the
   * caller's own transaction budget: a batch that has outlived it must fail
   * here rather than enter the lane late and run its work after the caller
   * gave up on it.
   */
  laneWaitMs?: number;
  signal?: AbortSignal;
};

// SET LOCAL ROLE stella_ingestion per transaction. Used by the
// case-law ingestion daemon — narrowed to writes on case_law_*
// (see 20260516000000_case_law_ingestion_role). No app.* settings
// because the corpus is global; there is no tenant to scope.
//
// Every transaction holds the corpus schema lane shared for its duration:
// this is the write boundary every corpus batch goes through, so an upgrade
// that takes the lane exclusive knows no batch is in flight (see
// corpus-schema-lane.ts). A batch that meets an upgrade backs off at its own
// boundary, rather than mid-write, until the lane is free again or its
// budget is spent.
export const createIngestionDb =
  <TTransaction extends ScopedTransactionBase>(
    database: RlsDatabase<TTransaction>,
    {
      laneWaitMs,
      signal,
      maintenance,
    }: CreateIngestionDbOptions<TTransaction> = {},
  ) =>
  async <T>(
    fn: (tx: TTransaction) => Promise<T>,
    options: Pick<
      CreateIngestionDbOptions<TTransaction>,
      "laneWaitMs" | "signal"
    > = {},
  ): Promise<T> =>
    await runUnderCorpusSchemaLane({
      database,
      work: async (tx) => {
        const ownerRow =
          maintenance === undefined
            ? null
            : executedRows(
                await tx.execute(sql`SELECT current_user AS role`),
              ).at(0);
        const owner = isRecord(ownerRow) ? ownerRow["role"] : null;
        if (maintenance !== undefined && typeof owner !== "string") {
          panic("Maintenance transaction has no owner role");
        }
        await maintenance?.before(tx);
        await tx.execute(
          sql`SELECT set_config('role', '${sql.raw(stellaIngestion.name)}', true)`,
        );
        const value = await fn(tx);
        if (maintenance !== undefined && typeof owner === "string") {
          await tx.execute(sql`SELECT set_config('role', ${owner}, true)`);
          await maintenance.after(tx);
        }
        return value;
      },
      ...(laneWaitMs === undefined ? {} : { laneWaitMs }),
      ...(signal === undefined ? {} : { signal }),
      ...options,
    });

const toSafeDbError = (cause: unknown): SafeDbError => {
  const code = getPgErrorCode(cause);
  const driverCode = getPgDriverErrorCode(cause);

  if (code === PG_ERROR.INSUFFICIENT_PRIVILEGE) {
    return new DatabaseRlsError({
      code,
      message: "Database row-level security rejected the request",
      cause,
    });
  }

  // A SQLSTATE is proof the database rejected the work, whether or not the
  // driver error reached here inside a `DrizzleQueryError`: only failures
  // raised during prepared-query execution are wrapped, while the transaction
  // lifecycle rejects with the bare driver error. Classifying on the wrapper
  // alone files a `COMMIT`-time serialization failure or deadlock as an
  // unhandled exception, which then never matches the retry predicate in
  // `safe-db.ts` that exists for exactly those codes. The wrapper still
  // classifies a query failure that carries no SQLSTATE.
  if (
    code !== undefined ||
    driverCode !== undefined ||
    cause instanceof DrizzleQueryError
  ) {
    return new DatabaseError({
      message: "Database query failed",
      cause,
      code,
    });
  }

  return new UnhandledException({ cause });
};

/** Result-wrapped form of createScopedDb for an explicit workspace scope. */
export const createSafeDb =
  <TTransaction extends ScopedTransactionBase>(
    database: RlsDatabase<TTransaction>,
    workspaceIds: SafeId<"workspace">[],
    organizationId: SafeId<"organization">,
    userId: SafeId<"user"> | null,
  ) =>
  async <T>(
    fn: (tx: TTransaction) => Promise<T>,
    retry?: SafeDbRetryConfig<SafeDbError>,
  ) =>
    await Result.tryPromise(
      {
        try: async () =>
          await runScopedTransaction({
            database,
            workspaceScope: {
              type: WORKSPACE_ACCESS_MODE.explicit,
              workspaceIds,
            },
            organizationId,
            userId,
            fn,
          }),
        catch: toSafeDbError,
      },
      retry,
    );

/** Result-wrapped membership scope used by authenticated request contexts. */
export const createMembershipSafeDb =
  <TTransaction extends ScopedTransactionBase>(
    database: RlsDatabase<TTransaction>,
    {
      organizationId,
      serverValidatedWorkspaceIds,
      userId,
      featureAccessSnapshot,
    }: MembershipScopedDbOptions,
  ) =>
  async <T>(
    fn: (tx: TTransaction) => Promise<T>,
    retry?: SafeDbRetryConfig<SafeDbError>,
  ) =>
    await Result.tryPromise(
      {
        try: async () =>
          await runScopedTransaction({
            database,
            workspaceScope: {
              type: WORKSPACE_ACCESS_MODE.membership,
              serverValidatedWorkspaceIds,
            },
            organizationId,
            userId,
            featureAccessSnapshot,
            fn,
          }),
        catch: toSafeDbError,
      },
      retry,
    );
