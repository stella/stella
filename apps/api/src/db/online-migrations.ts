import { panic } from "better-result";

const ONLINE_MIGRATIONS_LOCK_SQL =
  "SELECT pg_advisory_lock(hashtext('stella-online-migrations'))";
const ONLINE_MIGRATIONS_UNLOCK_SQL =
  "SELECT pg_advisory_unlock(hashtext('stella-online-migrations'))";
const READ_INDEX_STATE_SQL = `
  SELECT index_state.indisvalid AS "isValid"
  FROM pg_catalog.pg_class index_relation
  JOIN pg_catalog.pg_namespace index_namespace
    ON index_namespace.oid = index_relation.relnamespace
  JOIN pg_catalog.pg_index index_state
    ON index_state.indexrelid = index_relation.oid
  JOIN pg_catalog.pg_class table_relation
    ON table_relation.oid = index_state.indrelid
  WHERE index_namespace.nspname = 'public'
    AND index_relation.relname = 'report_exports_workspace_requester_created_idx'
    AND table_relation.relname = 'report_exports'
`;
const DROP_INVALID_INDEX_SQL =
  'DROP INDEX CONCURRENTLY IF EXISTS "report_exports_workspace_requester_created_idx"';
const CREATE_INDEX_SQL =
  'CREATE INDEX CONCURRENTLY "report_exports_workspace_requester_created_idx" ON "report_exports" USING btree ("workspace_id", "requested_by", "created_at", "id")';

type OnlineMigrationConnection = {
  execute: (query: string, params?: readonly unknown[]) => Promise<void>;
  query: (
    query: string,
    params?: readonly unknown[],
  ) => Promise<readonly unknown[]>;
  release: () => void;
};

type OnlineMigrationPool = {
  reserve: () => Promise<OnlineMigrationConnection>;
};

type OnlineIndexState =
  | { type: "invalid" }
  | { type: "missing" }
  | { type: "valid" };

export const runOnlineMigrations = async (
  pool: OnlineMigrationPool,
): Promise<void> => {
  const connection = await pool.reserve();
  let lockAcquired = false;

  try {
    await connection.execute(ONLINE_MIGRATIONS_LOCK_SQL);
    lockAcquired = true;
    await connection.execute("SET lock_timeout = '1s'");
    await connection.execute("SET statement_timeout = '0'");

    const initialState = await readIndexState(connection);
    if (initialState.type === "invalid") {
      await connection.execute(DROP_INVALID_INDEX_SQL);
    }
    if (initialState.type !== "valid") {
      await connection.execute(CREATE_INDEX_SQL);
    }

    const completedState = await readIndexState(connection);
    if (completedState.type !== "valid") {
      panic("Online report export history index is not valid after creation");
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

const readIndexState = async (
  connection: OnlineMigrationConnection,
): Promise<OnlineIndexState> => {
  const row = (await connection.query(READ_INDEX_STATE_SQL)).at(0);
  if (row === undefined) {
    return { type: "missing" };
  }
  if (
    typeof row !== "object" ||
    row === null ||
    !("isValid" in row) ||
    typeof row.isValid !== "boolean"
  ) {
    panic("Online report export history index state has an invalid shape");
  }
  return row.isValid ? { type: "valid" } : { type: "invalid" };
};
