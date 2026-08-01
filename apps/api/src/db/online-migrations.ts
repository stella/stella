import { panic } from "better-result";

import {
  REWRITTEN_MIGRATION_INDEXES,
  type RequiredMigrationIndex,
} from "../lib/db/migration-history";

const ONLINE_MIGRATIONS_LOCK_SQL =
  "SELECT pg_advisory_lock(hashtext('stella-online-migrations'))";
const ONLINE_MIGRATIONS_UNLOCK_SQL =
  "SELECT pg_advisory_unlock(hashtext('stella-online-migrations'))";
const READ_INDEX_STATE_SQL = `
  SELECT
    index_state.indisready AS "isReady",
    index_state.indisunique AS "isUnique",
    index_state.indisvalid AS "isValid",
    pg_get_indexdef(index_relation.oid) AS "definition",
    index_relation.relname AS "name"
  FROM pg_catalog.pg_class index_relation
  JOIN pg_catalog.pg_namespace index_namespace
    ON index_namespace.oid = index_relation.relnamespace
  JOIN pg_catalog.pg_index index_state
    ON index_state.indexrelid = index_relation.oid
  JOIN pg_catalog.pg_class table_relation
    ON table_relation.oid = index_state.indrelid
  WHERE index_namespace.nspname = $1
    AND index_relation.relname = $2
    AND table_relation.relname = $3
`;
const READ_REINDEX_ARTIFACTS_SQL = `
  SELECT
    index_state.indisready AS "isReady",
    index_state.indisunique AS "isUnique",
    index_state.indisvalid AS "isValid",
    pg_get_indexdef(index_relation.oid) AS "definition",
    index_relation.relname AS "name"
  FROM pg_catalog.pg_class index_relation
  JOIN pg_catalog.pg_namespace index_namespace
    ON index_namespace.oid = index_relation.relnamespace
  JOIN pg_catalog.pg_index index_state
    ON index_state.indexrelid = index_relation.oid
  JOIN pg_catalog.pg_class table_relation
    ON table_relation.oid = index_state.indrelid
  WHERE index_namespace.nspname = $1
    AND table_relation.relname = $2
    AND (
      starts_with(index_relation.relname, $3)
      OR starts_with(index_relation.relname, $4)
    )
`;

type OnlineIndex = RequiredMigrationIndex & {
  createSql?: string;
};

export const ONLINE_MIGRATION_INDEXES: readonly OnlineIndex[] = [
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "report_exports_workspace_requester_created_idx" ON public."report_exports" USING btree ("workspace_id", "requested_by", "created_at", "id")',
    definitionBody:
      "ON public.report_exports USING btree (workspace_id, requested_by, created_at, id)",
    isUnique: false,
    name: "report_exports_workspace_requester_created_idx",
    tableName: "report_exports",
  },
  ...REWRITTEN_MIGRATION_INDEXES,
];

export const ONLINE_VALIDATED_INDEX_NAMES: ReadonlySet<string> = new Set(
  ONLINE_MIGRATION_INDEXES.map(({ name }) => name),
);

type OnlineMigrationConnection = {
  execute: (query: string, params?: readonly unknown[]) => Promise<void>;
  query: (
    query: string,
    params?: readonly unknown[],
  ) => Promise<readonly unknown[]>;
  release: () => void;
};

export type OnlineMigrationPool = {
  reserve: () => Promise<OnlineMigrationConnection>;
};

type PresentIndexState = {
  definition: string;
  isReady: boolean;
  isUnique: boolean;
  isValid: boolean;
  name: string;
  type: "present";
};

type OnlineIndexState = { type: "missing" } | PresentIndexState;

type OnlineMigrationOperation = "repair" | "validate";

export const runOnlineMigrations = async (
  pool: OnlineMigrationPool,
): Promise<void> => await processOnlineMigrations(pool, "repair");

export const assertOnlineMigrationsApplied = async (
  pool: OnlineMigrationPool,
): Promise<void> => await processOnlineMigrations(pool, "validate");

const processOnlineMigrations = async (
  pool: OnlineMigrationPool,
  operation: OnlineMigrationOperation,
): Promise<void> => {
  const connection = await pool.reserve();
  let lockAcquired = false;

  try {
    await connection.execute(ONLINE_MIGRATIONS_LOCK_SQL);
    lockAcquired = true;

    if (operation === "repair") {
      await connection.execute("SET lock_timeout = '1s'");
      await connection.execute("SET statement_timeout = '0'");
    }

    for (const index of ONLINE_MIGRATION_INDEXES) {
      if (operation === "repair") {
        // oxlint-disable-next-line no-await-in-loop -- PostgreSQL permits only one concurrent index build per table; preserve deterministic order.
        await ensureIndexValid(connection, index);
      } else {
        // oxlint-disable-next-line no-await-in-loop -- Startup must validate the complete catalog before serving.
        await assertIndexReady(connection, index);
      }
    }
  } finally {
    try {
      if (lockAcquired) {
        await connection.execute(ONLINE_MIGRATIONS_UNLOCK_SQL);
      }
    } finally {
      connection.release();
    }
  }
};

const parsePresentIndexState = (row: unknown): PresentIndexState => {
  if (
    typeof row !== "object" ||
    row === null ||
    !("definition" in row) ||
    typeof row.definition !== "string" ||
    !("isReady" in row) ||
    typeof row.isReady !== "boolean" ||
    !("isUnique" in row) ||
    typeof row.isUnique !== "boolean" ||
    !("isValid" in row) ||
    typeof row.isValid !== "boolean" ||
    !("name" in row) ||
    typeof row.name !== "string"
  ) {
    panic("Online migration index state has an invalid shape");
  }

  return {
    definition: row.definition,
    isReady: row.isReady,
    isUnique: row.isUnique,
    isValid: row.isValid,
    name: row.name,
    type: "present",
  };
};

const readIndexState = async (
  connection: OnlineMigrationConnection,
  { name, tableName }: RequiredMigrationIndex,
): Promise<OnlineIndexState> => {
  const row = (
    await connection.query(READ_INDEX_STATE_SQL, ["public", name, tableName])
  ).at(0);
  return row === undefined ? { type: "missing" } : parsePresentIndexState(row);
};

const POSTGRES_IDENTIFIER_MAX_LENGTH = 63;

const reindexArtifactPrefix = (name: string, suffix: "_ccnew" | "_ccold") =>
  `${name.slice(0, POSTGRES_IDENTIFIER_MAX_LENGTH - suffix.length)}${suffix}`;

const readReindexArtifacts = async (
  connection: OnlineMigrationConnection,
  { name, tableName }: RequiredMigrationIndex,
): Promise<PresentIndexState[]> =>
  (
    await connection.query(READ_REINDEX_ARTIFACTS_SQL, [
      "public",
      tableName,
      reindexArtifactPrefix(name, "_ccnew"),
      reindexArtifactPrefix(name, "_ccold"),
    ])
  ).map(parsePresentIndexState);

const definitionBody = (definition: string): string => {
  const bodyStart = definition.indexOf(" ON ");
  if (bodyStart === -1) {
    panic("Online migration index definition has an invalid shape");
  }
  return definition.slice(bodyStart + 1);
};

const assertIndexDefinition = (
  index: RequiredMigrationIndex,
  state: PresentIndexState,
): void => {
  if (
    state.isUnique !== index.isUnique ||
    definitionBody(state.definition) !== index.definitionBody
  ) {
    panic(
      `Required migration index ${index.name} has an unexpected definition`,
    );
  }
};

const assertNoReindexArtifacts = async (
  connection: OnlineMigrationConnection,
  index: RequiredMigrationIndex,
): Promise<void> => {
  const artifacts = await readReindexArtifacts(connection, index);
  if (artifacts.length > 0) {
    panic(`Required migration index ${index.name} has reindex artifacts`);
  }
};

const cleanupFailedReindexArtifacts = async (
  connection: OnlineMigrationConnection,
  index: RequiredMigrationIndex,
): Promise<void> => {
  const artifacts = await readReindexArtifacts(connection, index);
  for (const artifact of artifacts) {
    assertIndexDefinition(index, artifact);
    if (artifact.isValid) {
      panic(
        `Required migration index ${index.name} has a valid reindex artifact`,
      );
    }
    // oxlint-disable-next-line no-await-in-loop -- Each concurrent drop must finish before the next repair step.
    await connection.execute(
      `DROP INDEX CONCURRENTLY public.${quoteIdentifier(artifact.name)}`,
    );
  }
};

const assertIndexReady = async (
  connection: OnlineMigrationConnection,
  index: RequiredMigrationIndex,
): Promise<void> => {
  const state = await readIndexState(connection, index);
  if (state.type === "missing") {
    panic(`Required migration index ${index.name} is missing`);
  }
  assertIndexDefinition(index, state);
  if (!state.isValid || !state.isReady) {
    panic(`Required migration index ${index.name} is not ready`);
  }
  await assertNoReindexArtifacts(connection, index);
};

const ensureIndexValid = async (
  connection: OnlineMigrationConnection,
  index: OnlineIndex,
): Promise<void> => {
  await cleanupFailedReindexArtifacts(connection, index);
  const initialState = await readIndexState(connection, index);
  if (initialState.type === "present") {
    assertIndexDefinition(index, initialState);
    if (initialState.isValid && initialState.isReady) {
      return;
    }

    await connection.execute(
      `REINDEX INDEX CONCURRENTLY public.${quoteIdentifier(index.name)}`,
    );
  } else if (index.createSql) {
    await connection.execute(index.createSql);
  } else {
    panic(`Required migration index ${index.name} is missing`);
  }

  await assertIndexReady(connection, index);
};

const POSTGRES_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;

const quoteIdentifier = (identifier: string): string => {
  if (!POSTGRES_IDENTIFIER.test(identifier)) {
    panic(`Invalid internal PostgreSQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
};
