import { panic, Result } from "better-result";

import { member, type user } from "@/api/db/auth-schema";
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

type ScopedDbMockOptions = {
  siblingRows: { name: string; parentId: string | null }[];
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
    const transaction =
      typeof tx === "object" && tx !== null
        ? {
            execute: async () => {
              await Promise.resolve();
            },
            ...tx,
            ...(options === undefined
              ? {}
              : {
                  select: (selection: unknown) => {
                    if (
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
                    if (!("select" in tx) || typeof tx.select !== "function") {
                      return panic("Missing fixture select");
                    }
                    const result: unknown = Reflect.apply(tx.select, tx, [
                      selection,
                    ]);
                    return result;
                  },
                }),
          }
        : {
            execute: async () => {
              await Promise.resolve();
            },
          };
    return await callback(asTestRaw<Transaction>(transaction));
  };

  return {
    getCallCount: () => callCount,
    safeDb: toSafeDbMock(scopedDb),
    scopedDb,
  };
};

// Query fixtures provide the rows matching their select boundary. Keep the
// awaitable builder shape intact for locking and bounded reads.
export const createSelectQueryMock = <TRow>(rows: TRow[]) => {
  // oxlint-disable-next-line typescript-eslint/promise-function-async -- async would wrap the query promise and discard its for method
  const limit = (count: number) => {
    const selected = rows.slice(0, count);
    return Object.assign(Promise.resolve(selected), {
      for: async () => await Promise.resolve(selected),
    });
  };
  // oxlint-disable-next-line typescript-eslint/promise-function-async -- async would wrap the query promise and discard its query methods
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

type FeatureAccessSelectMockOptions = {
  identity: Pick<typeof user.$inferSelect, "email" | "emailVerified"> | null;
  enrolments?: Pick<
    typeof featureEnrolments.$inferSelect,
    "featureId" | "organizationId" | "userId"
  >[];
};

// Resolve identity and enrolments by table so every feature uses the same fixture.
export const createFeatureAccessSelectMock =
  ({ identity, enrolments = [] }: FeatureAccessSelectMockOptions) =>
  () => ({
    from: (table: unknown) => {
      if (table === member) {
        return createSelectQueryMock(
          identity === null ? [] : [identity],
        ).from();
      }
      if (table === featureEnrolments) {
        return createSelectQueryMock(enrolments).from();
      }
      return panic("Feature access fixture must read membership or enrolments");
    },
  });
