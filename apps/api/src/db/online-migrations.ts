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
  SELECT index_state.indisvalid AS "isValid"
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

type OnlineIndex = RequiredMigrationIndex & {
  createSql?: string;
};

const ONLINE_INDEXES: readonly OnlineIndex[] = [
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "report_exports_workspace_requester_created_idx" ON public."report_exports" USING btree ("workspace_id", "requested_by", "created_at", "id")',
    name: "report_exports_workspace_requester_created_idx",
    tableName: "report_exports",
  },
  ...REWRITTEN_MIGRATION_INDEXES,
];

export const ONLINE_VALIDATED_INDEX_NAMES: ReadonlySet<string> = new Set(
  ONLINE_INDEXES.map(({ name }) => name),
);

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

    for (const index of ONLINE_INDEXES) {
      await ensureIndexValid(connection, index);
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
  { name, tableName }: RequiredMigrationIndex,
): Promise<OnlineIndexState> => {
  const row = (
    await connection.query(READ_INDEX_STATE_SQL, ["public", name, tableName])
  ).at(0);
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

const ensureIndexValid = async (
  connection: OnlineMigrationConnection,
  index: OnlineIndex,
): Promise<void> => {
  const initialState = await readIndexState(connection, index);
  if (initialState.type === "valid") {
    return;
  }

  if (initialState.type === "invalid") {
    await connection.execute(
      `REINDEX INDEX CONCURRENTLY public.${quoteIdentifier(index.name)}`,
    );
  } else if (index.createSql) {
    await connection.execute(index.createSql);
  } else {
    panic(`Required migration index ${index.name} is missing`);
  }

  const completedState = await readIndexState(connection, index);
  if (completedState.type !== "valid") {
    panic(`Required migration index ${index.name} is not valid after repair`);
  }
};

const POSTGRES_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

const quoteIdentifier = (identifier: string): string => {
  if (!POSTGRES_IDENTIFIER.test(identifier)) {
    panic(`Invalid internal PostgreSQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
};
