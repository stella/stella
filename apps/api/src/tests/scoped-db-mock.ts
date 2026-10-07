import { panic, Result } from "better-result";
import { getColumns } from "drizzle-orm";

import { member, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { SafeDb, SafeDbRetryConfig, ScopedDb } from "@/api/db/safe-db";
import { entities, featureEnrolments } from "@/api/db/schema";
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
  identity: Pick<typeof user.$inferSelect, "email" | "emailVerified"> | null;
  enrolments?: Pick<
    typeof featureEnrolments.$inferSelect,
    "featureId" | "organizationId" | "userId"
  >[];
};

type ScopedDbMockOptions = {
  siblingRows?: { name: string; parentId: string | null }[];
  featureAccess?: FeatureAccessMockOptions;
};

// Query fixtures provide the rows matching their select boundary. Keep the
// awaitable builder shape intact for locking and bounded reads.
export const createSelectQueryMock = <TRow>(rows: TRow[]) => {
  // oxlint-disable-next-line typescript/promise-function-async -- async would wrap the query promise and discard its for method
  const limit = (count: number) => {
    const selected = rows.slice(0, count);
    return Object.assign(Promise.resolve(selected), {
      for: async () => await Promise.resolve(selected),
    });
  };
  // oxlint-disable-next-line typescript/promise-function-async -- async would wrap the query promise and discard its query methods
  const where = () =>
    Object.assign(Promise.resolve(rows), {
      limit,
      for: async () => await Promise.resolve(rows),
      orderBy: () => ({ limit }),
    });
  return {
    from: () => ({
      where,
      innerJoin: () => ({ where }),
    }),
  };
};

const fixtureSelect =
  (tx: unknown, options?: ScopedDbMockOptions) => (selection: unknown) => {
    const columns =
      typeof selection === "object" && selection !== null
        ? Object.values(selection)
        : [];
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
      const { identity } = options.featureAccess;
      const query = createSelectQueryMock(identity === null ? [] : [identity]);
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

  const scopedDb: ScopedDb = async <T>(
    callback: (transaction: Transaction) => Promise<T>,
  ) => {
    callCount += 1;
    // Tests provide only the transaction members touched by the handler.
    const transaction = {
      execute: async () => {
        await Promise.resolve();
      },
      ...(typeof tx === "object" && tx !== null ? tx : {}),
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
