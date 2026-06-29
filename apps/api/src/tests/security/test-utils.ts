import { pushSchema } from "drizzle-kit/api-postgres";
import { sql, TransactionRollbackError } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import * as authSchema from "@/api/db/auth-schema";
import * as rlsExports from "@/api/db/rls";
import * as schema from "@/api/db/schema";
import { createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import type { RlsDatabaseMarker, TransactionOf } from "@/api/db/scoped";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  createSchemaPglite,
  installPgliteSchemaPrerequisites,
} from "@/api/tests/pglite-schema";

const allSchema = {
  ...schema,
  ...authSchema,
  ...rlsExports,
};

const allRelations = {
  ...schema.relations,
  ...authSchema.authRelationsPart,
};

const quoteSqlIdentifier = (identifier: string) =>
  `"${identifier.replaceAll('"', '""')}"`;

const AUTH_TABLES_SQL = [
  "user",
  "organization",
  "member",
  "session",
  "account",
  "verification",
  "invitation",
  "jwks",
  "oauth_client",
  "oauth_refresh_token",
  "oauth_access_token",
  "oauth_consent",
]
  .map(quoteSqlIdentifier)
  .join(", ");

const AUTH_USER_STELLA_SELECT_COLUMNS_SQL =
  authSchema.AUTH_USER_STELLA_SELECT_COLUMN_NAMES.map(quoteSqlIdentifier).join(
    ", ",
  );

type RawTestDatabase = ReturnType<typeof drizzle<typeof allRelations>>;
export type TestDatabase = RawTestDatabase & RlsDatabaseMarker;
export type TestDatabaseTransaction = TransactionOf<TestDatabase>;

const createTestDb = async (): Promise<TestDatabase> => {
  const client = await createSchemaPglite();
  const testDb = markRlsDatabase(
    drizzle({
      client,
      relations: allRelations,
    }),
  );
  const pushSchemaDb = drizzle({ client });

  await testDb.execute(sql.raw("CREATE ROLE stella NOLOGIN"));
  await testDb.execute(sql.raw("CREATE ROLE stella_ingestion NOLOGIN"));
  await installPgliteSchemaPrerequisites(testDb);

  const { sqlStatements } = await pushSchema(allSchema, pushSchemaDb);
  for (const statement of sqlStatements) {
    // oxlint-disable-next-line no-await-in-loop -- ordered DDL statements run sequentially on one test DB connection
    await testDb.execute(sql.raw(statement));
  }

  // Search-index write paths call arabic_normalize(); pushSchema only
  // creates tables, so apply the function migration the way runtime does.
  const arabicNormalizeMigration = readFileSync(
    nodePath.resolve(
      import.meta.dir,
      "../../../drizzle/20260629123000_arabic_normalize_function/migration.sql",
    ),
    "utf-8",
  );
  for (const statement of arabicNormalizeMigration.split(
    "--> statement-breakpoint",
  )) {
    const trimmed = statement.trim();
    if (trimmed.length === 0) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- ordered DDL statements run sequentially on one test DB connection
    await testDb.execute(sql.raw(trimmed));
  }

  await testDb.execute(
    sql.raw(`
      GRANT SELECT, INSERT, UPDATE, DELETE
        ON ALL TABLES IN SCHEMA public TO stella
    `),
  );
  await testDb.execute(
    sql.raw(`
      REVOKE ALL PRIVILEGES ON TABLE ${AUTH_TABLES_SQL} FROM stella
    `),
  );
  await testDb.execute(
    sql.raw(`
      GRANT SELECT (${AUTH_USER_STELLA_SELECT_COLUMNS_SQL})
        ON TABLE "user" TO stella
    `),
  );
  await testDb.execute(
    sql.raw(`
      GRANT SELECT ON TABLE "organization" TO stella
    `),
  );
  await testDb.execute(
    sql.raw(`
      GRANT SELECT ON TABLE "member" TO stella
    `),
  );
  await testDb.execute(
    sql.raw(`
      GRANT UPDATE (last_active_workspace_id) ON TABLE "member" TO stella
    `),
  );
  await testDb.execute(
    sql.raw(`
      REVOKE INSERT, UPDATE, DELETE ON TABLE
        "case_law_sources",
        "case_law_decisions",
        "case_law_citations",
        "case_law_polarity_rules",
        "case_law_court_weights",
        "case_law_fts_configs",
        "case_law_search_documents",
        "case_law_ingestion_events",
        "case_law_ingestion_failures",
        "case_law_index_jobs"
      FROM stella
    `),
  );
  await testDb.execute(
    sql.raw(`
      GRANT SELECT ON TABLE
        "case_law_sources",
        "case_law_decisions",
        "case_law_citations",
        "case_law_polarity_rules",
        "case_law_court_weights",
        "case_law_fts_configs",
        "case_law_search_documents",
        "case_law_ingestion_events",
        "case_law_ingestion_failures",
        "case_law_index_jobs"
      TO stella_ingestion
    `),
  );
  await testDb.execute(
    sql.raw(`
      GRANT INSERT, UPDATE, DELETE ON TABLE
        "case_law_decisions",
        "case_law_citations",
        "case_law_polarity_rules",
        "case_law_court_weights",
        "case_law_fts_configs",
        "case_law_search_documents",
        "case_law_ingestion_events",
        "case_law_ingestion_failures"
      TO stella_ingestion
    `),
  );
  await testDb.execute(
    sql.raw(`
      GRANT UPDATE (sync_cursor, last_sync_at, updated_at)
        ON TABLE "case_law_sources"
        TO stella_ingestion
    `),
  );
  // case_law_index_jobs is append-only: ingestion appends audit rows
  // but never updates or deletes them.
  await testDb.execute(
    sql.raw(`
      GRANT INSERT ON TABLE "case_law_index_jobs" TO stella_ingestion
    `),
  );
  // Legislation corpus — same global model as case law.
  await testDb.execute(
    sql.raw(`
      REVOKE INSERT, UPDATE, DELETE ON TABLE
        "legislation_sources",
        "legislation_documents",
        "legislation_search_documents",
        "legislation_index_jobs"
      FROM stella
    `),
  );
  await testDb.execute(
    sql.raw(`
      GRANT SELECT ON TABLE
        "legislation_sources",
        "legislation_documents",
        "legislation_search_documents",
        "legislation_index_jobs"
      TO stella_ingestion
    `),
  );
  await testDb.execute(
    sql.raw(`
      GRANT INSERT, UPDATE, DELETE ON TABLE
        "legislation_documents",
        "legislation_search_documents"
      TO stella_ingestion
    `),
  );
  await testDb.execute(
    sql.raw(`
      GRANT UPDATE (sync_cursor, last_sync_at, updated_at)
        ON TABLE "legislation_sources"
        TO stella_ingestion
    `),
  );
  await testDb.execute(
    sql.raw(`
      GRANT INSERT ON TABLE "legislation_index_jobs" TO stella_ingestion
    `),
  );

  return testDb;
};

const DEFAULT_TEST_USER_ID = toSafeId<"user">("user_test");

// ── Shared PGlite singleton ─────────────────────────────
//
// PGlite 0.3.x uses a single-threaded WASM module. Bun's
// test runner runs files in parallel, so concurrent
// PGlite.create() calls corrupt WASM state (platform-
// independent; reproduced on both macOS and Linux CI).
// createTestDb() defaults to in-memory mode (no dataDir
// arg); the storage backend doesn't matter, it's the
// WASM init itself that races. These helpers provide a
// single lazily-initialized PGlite instance shared
// across all test files that need one.

let dbPromise: Promise<TestDatabase> | null = null;
let dbRefCount = 0;

/**
 * Acquire the shared test database. The PGlite instance
 * is created on first call; subsequent calls await the
 * same promise.
 */
export const getTestDb = async (): Promise<TestDatabase> => {
  dbRefCount++;

  dbPromise ??= createTestDb();

  return await dbPromise;
};

/**
 * Release the shared test database. When the last consumer
 * releases, the PGlite instance is closed.
 */
export const releaseTestDb = async (): Promise<void> => {
  dbRefCount--;
  if (dbRefCount <= 0 && dbPromise) {
    const testDb = await dbPromise;
    await testDb.$client.close();
    dbPromise = null;
    dbRefCount = 0;
  }
};

export const createScopedQuery = (testDb: TestDatabase) => {
  const scopedQuery = async <T>(
    wsIds: SafeId<"workspace">[],
    orgId: SafeId<"organization">,
    fn: (tx: TestDatabaseTransaction) => Promise<T>,
    userId: SafeId<"user"> = DEFAULT_TEST_USER_ID,
  ) => await createScopedDb(testDb, wsIds, orgId, userId)(fn);

  return scopedQuery;
};

/**
 * Like createScopedQuery, but always rolls back the
 * transaction — nothing is persisted to the database.
 */
export const createDryScopedQuery = (testDb: TestDatabase) => {
  const scopedQuery = createScopedQuery(testDb);

  const dryScopedQuery = async (
    wsIds: SafeId<"workspace">[],
    orgId: SafeId<"organization">,
    fn: (tx: TestDatabaseTransaction) => Promise<void>,
    userId: SafeId<"user"> = DEFAULT_TEST_USER_ID,
  ): Promise<void> => {
    try {
      await scopedQuery(
        wsIds,
        orgId,
        async (tx) => {
          await fn(tx);
          tx.rollback();
        },
        userId,
      );
    } catch (error) {
      if (error instanceof TransactionRollbackError) {
        return;
      }
      throw error;
    }
  };

  return dryScopedQuery;
};
