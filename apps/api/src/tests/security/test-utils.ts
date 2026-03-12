import { PGlite } from "@electric-sql/pglite";
import { pushSchema } from "drizzle-kit/api-postgres";
import { sql, TransactionRollbackError } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { createScopedDb } from "@/api/db";
import type { TransactionOf } from "@/api/db";
import * as authSchema from "@/api/db/auth-schema";
import * as rlsExports from "@/api/db/rls";
import * as schema from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

const allSchema = {
  ...schema,
  ...authSchema,
  ...rlsExports,
};

export type TestDatabase = ReturnType<typeof drizzle<typeof allSchema>>;
export type TestDatabaseTransaction = TransactionOf<TestDatabase>;

export const createTestDb = async (): Promise<TestDatabase> => {
  const client = await PGlite.create();
  const testDb = drizzle({ client, schema: allSchema });

  await testDb.execute(sql.raw("CREATE ROLE stella NOLOGIN"));

  // SAFETY: pushSchema's second parameter type is overly
  // narrow in drizzle-kit beta — it rejects databases
  // created with a schema generic. The runtime value is
  // compatible; only the branded type wrapper differs.
  const { sqlStatements } = await pushSchema(
    allSchema,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    testDb as unknown as Parameters<typeof pushSchema>[1],
  );
  for (const statement of sqlStatements) {
    await testDb.execute(sql.raw(statement));
  }

  await testDb.execute(
    sql.raw(`
      GRANT SELECT, INSERT, UPDATE, DELETE
        ON ALL TABLES IN SCHEMA public TO stella
    `),
  );

  return testDb;
};

export const createScopedQuery = (testDb: TestDatabase) => {
  const scopedQuery = async <T>(
    wsIds: string[],
    orgId: SafeId<"organization">,
    fn: (tx: TestDatabaseTransaction) => Promise<T>,
  ) => await createScopedDb(testDb, wsIds, orgId)(fn);

  return scopedQuery;
};

/**
 * Like createScopedQuery, but always rolls back the
 * transaction — nothing is persisted to the database.
 */
export const createDryScopedQuery = (testDb: TestDatabase) => {
  const scopedQuery = createScopedQuery(testDb);

  const dryScopedQuery = async (
    wsIds: string[],
    orgId: SafeId<"organization">,
    fn: (tx: TestDatabaseTransaction) => Promise<void>,
  ): Promise<void> => {
    try {
      await scopedQuery(wsIds, orgId, async (tx) => {
        await fn(tx);
        tx.rollback();
      });
    } catch (error) {
      if (error instanceof TransactionRollbackError) {
        return;
      }
      throw error;
    }
  };

  return dryScopedQuery;
};
