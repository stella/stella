import { panic, Result } from "better-result";
import { getColumns } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { member, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { SafeDb, SafeDbRetryConfig, ScopedDb } from "@/api/db/safe-db";
import {
  entities,
  entityVersions,
  featureEnrolments,
  fields,
  flowRunSteps,
  type workspaces,
} from "@/api/db/schema";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

export const toSafeDbMock =
  (scopedDb: ScopedDb): SafeDb =>
  async <T>(
    callback: (transaction: Transaction) => Promise<T>,
    _retry?: SafeDbRetryConfig,
  ) => {
    const result = await Result.tryPromise(
      async () => await scopedDb(callback),
    );
    return result;
  };

type FeatureAccessMockOptions = {
  /** With `userId`, only that member's enrolments join the identity row. */
  identity:
    | (Pick<typeof user.$inferSelect, "email" | "emailVerified"> & {
        userId?: string;
      })
    | null;
  enrolments?: Pick<
    typeof featureEnrolments.$inferSelect,
    "featureId" | "organizationId" | "userId"
  >[];
};

type ScopedDbMockOptions = {
  entityTransferEligibility?: {
    entityId: typeof entities.$inferSelect.id;
    eligible: boolean;
  }[];
  siblingRows?: { name: string; parentId: string | null }[];
  featureAccess?: FeatureAccessMockOptions;
  flowTaskGates?: {
    runId: typeof flowRunSteps.$inferSelect.runId;
    status: typeof flowRunSteps.$inferSelect.status;
    organizationId: typeof workspaces.$inferSelect.organizationId;
  }[];
  visibleResources?: {
    entity?: readonly string[];
    entityVersion?: readonly string[];
    field?: readonly string[];
  };
};

// Query fixtures provide the rows matching their select boundary. Keep the
// awaitable builder shape intact for locking and bounded reads.
export const createSelectQueryMock = <TRow>(rows: TRow[]) => {
  let rowOffset = 0;
  // oxlint-disable-next-line typescript/promise-function-async -- async would wrap the query promise and discard its for method
  const limit = (count: number) => {
    const selected = rows.slice(rowOffset, rowOffset + count);
    return Object.assign(Promise.resolve(selected), {
      for: () => selected,
    });
  };
  const offset = (count: number) => {
    rowOffset = count;
    return { limit };
  };
  // oxlint-disable-next-line typescript/promise-function-async -- async would wrap the query promise and discard its query methods
  const where = () =>
    Object.assign(Promise.resolve(rows), {
      limit,
      offset,
      for: () => rows,
      orderBy: () => ({ limit, offset }),
    });
  return {
    from: () => ({
      where,
      innerJoin: () => ({ where }),
    }),
  };
};

// Every aggregate advisory statement (exclusive, shared, try, or the
// key-only alias lookup) selects the physical key pair it resolves.
const isAdvisoryLockStatement = (statement: string) =>
  statement.includes(" AS key1, ") && statement.includes(" AS key2");

const fixtureSelect =
  (tx: unknown, options?: ScopedDbMockOptions) => (selection: unknown) => {
    const columns =
      typeof selection === "object" && selection !== null
        ? Object.values(selection)
        : [];
    // Linked ownership is an explicit fixture boundary; ordinary resource
    // selects must never accidentally stand in for persisted flow pointers.
    if (columns.includes(flowRunSteps.runId)) {
      const query = createSelectQueryMock(options?.flowTaskGates ?? []);
      return {
        from: (table: unknown) => {
          if (table !== flowRunSteps) {
            return panic("Flow ownership fixture must read flow run steps");
          }
          return query.from();
        },
      };
    }
    // Feature admission is infrastructure shared by every handler fixture.
    // Use schema columns, so a resource select with similar keys still delegates.
    if (
      columns.some((column) =>
        Object.values(getColumns(featureEnrolments)).some(
          (enrolmentColumn) => column === enrolmentColumn,
        ),
      )
    ) {
      const query = createSelectQueryMock(
        options?.featureAccess?.enrolments ?? [],
      );
      return {
        from: (table: unknown) => {
          if (table !== featureEnrolments) {
            return panic("Enrolment fixture must read feature enrolments");
          }
          return query.from();
        },
      };
    }
    if (
      options?.featureAccess !== undefined &&
      columns.some(
        (column) => column === user.email || column === user.emailVerified,
      )
    ) {
      const { identity, enrolments = [] } = options.featureAccess;
      const query = createSelectQueryMock(
        identity === null
          ? []
          : [
              {
                email: identity.email,
                emailVerified: identity.emailVerified,
                enrolledFeatureIds: enrolments
                  .filter(
                    (enrolment) =>
                      identity.userId === undefined ||
                      enrolment.userId === identity.userId,
                  )
                  .map(({ featureId }) => featureId),
              },
            ],
      );
      return {
        from: (table: unknown) => {
          if (table !== member) {
            return panic("Identity fixture must read membership");
          }
          return query.from();
        },
      };
    }
    if (
      typeof selection === "object" &&
      selection !== null &&
      "id" in selection &&
      Object.keys(selection).length === 1
    ) {
      for (const { table, ids } of [
        { table: entities, ids: options?.visibleResources?.entity },
        {
          table: entityVersions,
          ids: options?.visibleResources?.entityVersion,
        },
        { table: fields, ids: options?.visibleResources?.field },
      ]) {
        if (selection.id === table.id && ids !== undefined) {
          return createSelectQueryMock(ids.map((id) => ({ id })));
        }
      }
    }
    if (
      options?.siblingRows !== undefined &&
      typeof selection === "object" &&
      selection !== null &&
      "name" in selection &&
      selection.name === entities.name &&
      "parentId" in selection &&
      selection.parentId === entities.parentId
    ) {
      const query = createSelectQueryMock(options.siblingRows);
      return {
        from: (table: unknown) => {
          if (table !== entities) {
            return panic("Sibling fixture must read entities");
          }
          return query.from();
        },
      };
    }
    if (
      typeof tx !== "object" ||
      tx === null ||
      !("select" in tx) ||
      typeof tx.select !== "function"
    ) {
      return panic("Missing fixture select");
    }
    const result: unknown = Reflect.apply(tx.select, tx, [selection]);
    return result;
  };

export const createScopedDbMock = (
  tx: unknown,
  options?: ScopedDbMockOptions,
) => {
  let callCount = 0;
  const transferEligibility = options?.entityTransferEligibility;

  const scopedDb: ScopedDb = async <T>(
    callback: (transaction: Transaction) => Promise<T>,
  ) => {
    callCount += 1;
    // Tests provide only the transaction members touched by the handler.
    const advisoryKeys = new Map<string, number>();
    const advisoryExecute = (query: SQL) => {
      const rendered = new PgDialect().sqlToQuery(query);
      if (!isAdvisoryLockStatement(rendered.sql)) {
        return [];
      }
      const identity = JSON.stringify(rendered.params);
      const key = advisoryKeys.get(identity) ?? advisoryKeys.size + 1;
      advisoryKeys.set(identity, key);
      return [{ key1: 1, key2: key, acquired: true }];
    };
    const transaction = {
      execute: advisoryExecute,
      ...(typeof tx === "object" && tx !== null ? tx : {}),
      ...(transferEligibility === undefined
        ? {}
        : {
            execute: (query: SQL) => {
              const rendered = new PgDialect().sqlToQuery(query);
              if (rendered.sql.includes('root_id AS "entityId"')) {
                return Promise.resolve(
                  transferEligibility.filter((row) =>
                    rendered.params.includes(row.entityId),
                  ),
                );
              }
              if (isAdvisoryLockStatement(rendered.sql)) {
                return Promise.resolve(advisoryExecute(query));
              }
              if (
                typeof tx !== "object" ||
                tx === null ||
                !("execute" in tx) ||
                typeof tx.execute !== "function"
              ) {
                return panic("Missing fixture execute");
              }
              const result: unknown = Reflect.apply(tx.execute, tx, [query]);
              return result;
            },
          }),
      select: fixtureSelect(tx, options),
    };
    return await callback(asTestRaw<Transaction>(transaction));
  };

  return {
    getCallCount: () => callCount,
    safeDb: toSafeDbMock(scopedDb),
    scopedDb,
  };
};
