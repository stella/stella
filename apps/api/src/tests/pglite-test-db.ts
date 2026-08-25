import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { getTableName, sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import * as agentAuthSchema from "@/api/db/agent-auth-schema";
import * as authSchema from "@/api/db/auth-schema";
import * as rlsExports from "@/api/db/rls";
import * as schema from "@/api/db/schema";
import type { AnyDrizzle } from "@/api/db/scoped";
import {
  PUBLIC_LAW_COLUMNS_BY_RELATION,
  ROLLOUT_CASE_LAW_SOURCE_COLUMNS,
  ROLLOUT_CASE_LAW_SOURCE_RELATION,
  ROLLOUT_CASE_LAW_WHOLE_RELATIONS,
} from "@/api/lib/public-law-relations";
import {
  createSchemaPglite,
  installPgliteSchemaPrerequisites,
  installPgliteWorkspaceAccessObjects,
} from "@/api/tests/pglite-schema";

// Test processes boot from a prebuilt data-dir snapshot when the batching
// runner provides one (scripts/run-tests.ts). Building the schema in-process
// costs a ~2.2 GB peak (drizzle-kit's push diffing plus PGlite WASM churn);
// loading a snapshot skips drizzle-kit entirely and keeps the process near
// PGlite's runtime floor.
export const PGLITE_TEST_SNAPSHOT_ENV = "PGLITE_TEST_SNAPSHOT";

const allSchema = {
  ...schema,
  ...authSchema,
  ...agentAuthSchema,
  ...rlsExports,
};

const quoteSqlIdentifier = (identifier: string) =>
  `"${identifier.replaceAll('"', '""')}"`;

/**
 * Execute a read callback under the same role used by the external public-law
 * database. Writes in the surrounding test setup stay on the owner handle;
 * this role change is local to the callback's transaction.
 */
type PublicLawRoleTransaction = {
  execute: (query: SQLWrapper | string) => PromiseLike<unknown>;
};

export const withPublicLawReaderRole = async <
  TTransaction extends PublicLawRoleTransaction,
  TResult,
>(
  database: AnyDrizzle<TTransaction>,
  fn: (tx: TTransaction) => Promise<TResult>,
): Promise<TResult> =>
  await database.transaction(async (tx) => {
    await tx.execute(
      sql.raw(
        `SET LOCAL ROLE ${quoteSqlIdentifier(rlsExports.stellaPublicLawReader.name)}`,
      ),
    );
    return await fn(tx);
  });

const AUTH_TABLES_SQL = [
  ...Object.values(authSchema.authSchema).map((table) => getTableName(table)),
  "agent_registration",
  "agent_trusted_issuer",
  "agent_delegation",
  "agent_assertion_replay",
]
  .map(quoteSqlIdentifier)
  .join(", ");

const AUTH_USER_STELLA_SELECT_COLUMNS_SQL =
  authSchema.AUTH_USER_STELLA_SELECT_COLUMN_NAMES.map(quoteSqlIdentifier).join(
    ", ",
  );

const CORPUS_DELETE_WATERMARK_TABLES_SQL = [
  schema.caseLawCorpusIndexDeleteWatermarks,
  schema.legislationCorpusIndexDeleteWatermarks,
]
  .map(getTableName)
  .map(quoteSqlIdentifier)
  .join(", ");

const CORPUS_PENDING_DELETE_TABLES_SQL = [
  schema.caseLawCorpusIndexPendingDeletes,
  schema.legislationCorpusIndexPendingDeletes,
]
  .map(getTableName)
  .map(quoteSqlIdentifier)
  .join(", ");

const CORPUS_PROJECTION_HISTORY_TABLES_SQL = [
  schema.corpusIndexProjectionIntents,
  schema.corpusIndexProjectionStates,
]
  .map(getTableName)
  .map(quoteSqlIdentifier)
  .join(", ");

// The snapshot bakes in the superset every suite needs: RLS roles, schema,
// workspace-access objects, and the role grants. Suites that never SET ROLE
// simply ignore the grants.
const ROLE_GRANT_STATEMENTS = [
  `
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON ALL TABLES IN SCHEMA public TO stella
  `,
  `
    REVOKE ALL PRIVILEGES ON TABLE ${AUTH_TABLES_SQL} FROM stella
  `,
  `
    GRANT SELECT (${AUTH_USER_STELLA_SELECT_COLUMNS_SQL})
      ON TABLE "user" TO stella
  `,
  `
    GRANT SELECT ON TABLE "organization" TO stella
  `,
  `
    GRANT SELECT ON TABLE "member" TO stella
  `,
  `
    GRANT UPDATE (last_active_workspace_id) ON TABLE "member" TO stella
  `,
  `
    REVOKE INSERT, UPDATE, DELETE ON TABLE
      "case_law_sources",
      "case_law_decisions",
      "case_law_decision_identifiers",
      "case_law_decision_identifier_backfills",
      "case_law_citations",
      "case_law_provision_citations",
      "case_law_polarity_rules",
      "case_law_court_weights",
      "case_law_fts_configs",
      "case_law_search_documents",
      "case_law_ingestion_events",
      "case_law_ingestion_failures",
      "case_law_index_jobs"
    FROM stella
  `,
  `
    GRANT SELECT ON TABLE
      "case_law_sources",
      "case_law_decisions",
      "case_law_decision_identifiers",
      "case_law_decision_identifier_backfills",
      "case_law_citations",
      "case_law_provision_citations",
      "case_law_polarity_rules",
      "case_law_court_weights",
      "case_law_fts_configs",
      "case_law_search_documents",
      "case_law_ingestion_events",
      "case_law_ingestion_failures",
      "case_law_index_jobs"
    TO stella_ingestion
  `,
  `
    GRANT INSERT, UPDATE, DELETE ON TABLE
      "case_law_decisions",
      "case_law_decision_identifiers",
      "case_law_decision_identifier_backfills",
      "case_law_citations",
      "case_law_provision_citations",
      "case_law_polarity_rules",
      "case_law_court_weights",
      "case_law_fts_configs",
      "case_law_search_documents",
      "case_law_ingestion_events",
      "case_law_ingestion_failures"
    TO stella_ingestion
  `,
  `
    GRANT UPDATE (
      sync_cursor,
      last_sync_at,
      updated_at,
      observation_order,
      checkpoint_observation_order
    )
      ON TABLE "case_law_sources"
      TO stella_ingestion
  `,
  // case_law_index_jobs is append-only: ingestion appends audit rows
  // but never updates or deletes them.
  `
    GRANT INSERT ON TABLE "case_law_index_jobs" TO stella_ingestion
  `,
  // Legislation corpus — same global model as case law.
  `
    REVOKE INSERT, UPDATE, DELETE ON TABLE
      "legislation_sources",
      "legislation_documents",
      "legislation_search_documents",
      "legislation_index_jobs"
    FROM stella
  `,
  `
    GRANT SELECT ON TABLE
      "legislation_sources",
      "legislation_documents",
      "legislation_search_documents",
      "legislation_index_jobs"
    TO stella_ingestion
  `,
  `
    GRANT INSERT, UPDATE, DELETE ON TABLE
      "legislation_documents",
      "legislation_search_documents"
    TO stella_ingestion
  `,
  `
    GRANT UPDATE (sync_cursor, last_sync_at, updated_at)
      ON TABLE "legislation_sources"
      TO stella_ingestion
  `,
  `
    GRANT INSERT ON TABLE "legislation_index_jobs" TO stella_ingestion
  `,
  // Corpus delete settlement mirrors the migration's least-privilege split:
  // request handlers may inspect watermarks, while only ingestion owns the
  // pending ledger and advances settlement.
  `
    REVOKE INSERT, UPDATE, DELETE ON TABLE
      ${CORPUS_DELETE_WATERMARK_TABLES_SQL}
    FROM stella
  `,
  `
    REVOKE ALL PRIVILEGES ON TABLE
      ${CORPUS_PENDING_DELETE_TABLES_SQL}
    FROM stella
  `,
  `
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
      ${CORPUS_DELETE_WATERMARK_TABLES_SQL}
    TO stella_ingestion
  `,
  `
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
      ${CORPUS_PENDING_DELETE_TABLES_SQL}
    TO stella_ingestion
  `,
  // Final-generation state is observable by request code but mutated only by
  // ingestion. A narrowly scoped database function owns retirement deletes.
  `
    REVOKE INSERT, UPDATE, DELETE ON TABLE
      "corpus_index_generations",
      ${CORPUS_PROJECTION_HISTORY_TABLES_SQL}
    FROM stella
  `,
  `
    GRANT SELECT ON TABLE
      "corpus_index_generations",
      ${CORPUS_PROJECTION_HISTORY_TABLES_SQL}
    TO stella_ingestion
  `,
  `
    GRANT INSERT, DELETE ON TABLE "corpus_index_generations"
    TO stella_ingestion
  `,
  `
    GRANT UPDATE (status, updated_at)
      ON TABLE "corpus_index_generations" TO stella_ingestion
  `,
  `
    GRANT INSERT, UPDATE ON TABLE
      ${CORPUS_PROJECTION_HISTORY_TABLES_SQL}
    TO stella_ingestion
  `,
  // Preserve the v0.7.22 reader contract until its rollback window closes.
  `
    GRANT USAGE ON SCHEMA public TO stella_caselaw_reader
  `,
  `
    GRANT SELECT ON TABLE ${ROLLOUT_CASE_LAW_WHOLE_RELATIONS.map(quoteSqlIdentifier).join(", ")}
    TO stella_caselaw_reader
  `,
  `
    GRANT SELECT (${ROLLOUT_CASE_LAW_SOURCE_COLUMNS.map(quoteSqlIdentifier).join(", ")})
      ON TABLE ${quoteSqlIdentifier(ROLLOUT_CASE_LAW_SOURCE_RELATION)}
      TO stella_caselaw_reader
  `,
  // Derived from the allowlist the connection validator reads, so the role
  // in tests can only ever match the role the migration defines.
  `
    GRANT USAGE ON SCHEMA public TO stella_public_law_reader
  `,
  ...Object.entries(PUBLIC_LAW_COLUMNS_BY_RELATION).map(
    ([relation, columns]) => `
      GRANT SELECT (${columns.map(quoteSqlIdentifier).join(", ")})
        ON TABLE ${quoteSqlIdentifier(relation)}
        TO stella_public_law_reader
    `,
  ),
] as const;

/**
 * Build a fully provisioned test PGlite from scratch: RLS roles, schema
 * prerequisites, the drizzle schema push, workspace-access objects, and
 * role grants. This is the expensive path (drizzle-kit peaks ~2.2 GB);
 * batched runs pay it once in the snapshot builder, solo `bun test` runs
 * pay it per process.
 */
export const buildFullTestPglite = async (): Promise<PGlite> => {
  const client = await createSchemaPglite();
  const db = drizzle({ client });
  const pushSchemaDb = drizzle({ client });

  await db.execute(sql.raw("CREATE ROLE stella NOLOGIN"));
  await db.execute(sql.raw("CREATE ROLE stella_ingestion NOLOGIN"));
  await db.execute(sql.raw("CREATE ROLE stella_caselaw_reader NOLOGIN"));
  await db.execute(sql.raw("CREATE ROLE stella_public_law_reader NOLOGIN"));
  await installPgliteSchemaPrerequisites(db);

  // drizzle-kit is a heavyweight dev dependency; import it only on this
  // build path so snapshot-booted test processes never load it.
  const { pushSchema } = await import("drizzle-kit/api-postgres");
  const { sqlStatements } = await pushSchema(allSchema, pushSchemaDb);
  for (const statement of sqlStatements) {
    // oxlint-disable-next-line no-await-in-loop -- ordered DDL statements run sequentially on one test DB connection
    await db.execute(sql.raw(statement));
  }
  await installPgliteWorkspaceAccessObjects(db);

  for (const statement of ROLE_GRANT_STATEMENTS) {
    // oxlint-disable-next-line no-await-in-loop -- grants run sequentially on one test DB connection
    await db.execute(sql.raw(statement));
  }

  return client;
};

/**
 * Create a test PGlite: from the batching runner's snapshot when
 * PGLITE_TEST_SNAPSHOT is set, otherwise via the full in-process build so
 * solo `bun test <file>` runs keep working without the runner.
 */
export const createTestPglite = async (): Promise<PGlite> => {
  const snapshotPath = process.env[PGLITE_TEST_SNAPSHOT_ENV];
  if (snapshotPath === undefined || snapshotPath.length === 0) {
    return await buildFullTestPglite();
  }
  const snapshotBytes = await Bun.file(snapshotPath).arrayBuffer();
  return await PGlite.create({
    extensions: { pg_trgm },
    loadDataDir: new Blob([snapshotBytes]),
  });
};
