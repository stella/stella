import { panic } from "better-result";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import type { SQL as SqlFragment } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";

import { databaseRelations } from "@/api/db/database-relations";
import { rootDb } from "@/api/db/root";
import type { Transaction } from "@/api/db/root";
import { envBase } from "@/api/env-base";
import {
  PUBLIC_CASE_LAW_RELATIONS,
  PUBLIC_CASE_LAW_SOURCE_COLUMNS,
  PUBLIC_CASE_LAW_SOURCE_TABLE,
  PUBLIC_CASE_LAW_TABLES,
} from "@/api/lib/case-law/public-relations";
import { queryCountLogger } from "@/api/lib/db-query-counter";

const CASE_LAW_PUBLIC_READ_DB = Symbol("caseLawPublicReadDb");
const EXTERNAL_CASE_LAW_CONNECTION_TIMEOUT_SECONDS = 10;

// The grant set of the reader role is these same lists; see
// `apps/api/src/lib/case-law/public-relations.ts`.
export { PUBLIC_CASE_LAW_RELATIONS };

type CaseLawQueryKey = Extract<keyof Transaction["query"], "caseLawDecisions">;

export type CaseLawPublicReadTransaction = Pick<
  Transaction,
  "execute" | "select"
> & {
  query: Pick<Transaction["query"], CaseLawQueryKey>;
};

/**
 * How much of one state a transaction sees.
 *
 * `repeatable-read` pins every statement to the snapshot the first one took,
 * so a decision gated at the start cannot have its content read out of a
 * later, different state; the redistribution gate depends on it. Reads that
 * answer from a single statement do not need it and do not pay for it.
 */
export type CaseLawReadIsolation = "read-committed" | "repeatable-read";

export type CaseLawReadOptions = { isolation?: CaseLawReadIsolation };

export type CaseLawPublicReadDb = (<T>(
  fn: (tx: CaseLawPublicReadTransaction) => Promise<T>,
  options?: CaseLawReadOptions,
) => Promise<T>) & {
  [CASE_LAW_PUBLIC_READ_DB]: true;
};

type CaseLawDatabaseRolePermissions = {
  canReadCaseLaw: boolean;
  canReadOtherData: boolean;
  canWriteCaseLaw: boolean;
};

export const assertCaseLawDatabaseRolePermissions = ({
  canReadCaseLaw,
  canReadOtherData,
  canWriteCaseLaw,
}: CaseLawDatabaseRolePermissions): void => {
  if (!canReadCaseLaw || canWriteCaseLaw || canReadOtherData) {
    panic(
      "CASE_LAW_DATABASE_URL must use a role that can only read the public case-law corpus",
    );
  }
};

type ExternalCaseLawDatabase = {
  database: typeof rootDb;
  roleValidation:
    | { status: "idle" }
    | { status: "pending"; promise: Promise<void> }
    | { status: "validated" };
};

let externalCaseLawDatabase: ExternalCaseLawDatabase | null = null;

/**
 * What `current_user` may do, in the three terms the validator judges.
 * Exported so the role a migration defines can be held to the same query.
 */
export const caseLawDatabaseRolePermissionsSql = (): SqlFragment => {
  const publicTables = sql.join(
    PUBLIC_CASE_LAW_TABLES.map((name) => sql`${name}`),
    sql.raw(","),
  );
  const sourceColumns = sql.join(
    PUBLIC_CASE_LAW_SOURCE_COLUMNS.map((name) => sql`${name}`),
    sql.raw(","),
  );
  return sql`
      SELECT
        (
          SELECT count(*) = ${PUBLIC_CASE_LAW_TABLES.length}
            AND bool_and(
              has_table_privilege(current_user, tables.oid, 'SELECT')
            )
          FROM pg_class AS tables
          INNER JOIN pg_namespace AS schemas
            ON schemas.oid = tables.relnamespace
          WHERE schemas.nspname = 'public'
            AND tables.relkind IN ('r', 'p', 'v', 'm', 'f')
            AND tables.relname IN (${publicTables})
        ) AND (
          -- The source table is read column by column; every listed column
          -- must be readable, and nothing else on it (checked below).
          SELECT count(*) = ${PUBLIC_CASE_LAW_SOURCE_COLUMNS.length}
            AND bool_and(
              has_column_privilege(
                current_user,
                columns.attrelid,
                columns.attnum,
                'SELECT'
              )
            )
          FROM pg_attribute AS columns
          INNER JOIN pg_class AS tables ON tables.oid = columns.attrelid
          INNER JOIN pg_namespace AS schemas
            ON schemas.oid = tables.relnamespace
          WHERE schemas.nspname = 'public'
            AND tables.relname = ${PUBLIC_CASE_LAW_SOURCE_TABLE}
            AND columns.attnum > 0
            AND NOT columns.attisdropped
            AND columns.attname IN (${sourceColumns})
        ) AS "canReadCaseLaw",
        EXISTS (
          -- Any column readable outside the public set: a whole table
          -- elsewhere, or a column of the source table beyond its list.
          SELECT 1
          FROM pg_attribute AS columns
          INNER JOIN pg_class AS tables ON tables.oid = columns.attrelid
          INNER JOIN pg_namespace AS schemas
            ON schemas.oid = tables.relnamespace
          WHERE schemas.nspname = 'public'
            AND tables.relkind IN ('r', 'p', 'v', 'm', 'f')
            AND tables.relname NOT IN (${publicTables})
            AND columns.attnum > 0
            AND NOT columns.attisdropped
            AND NOT (
              tables.relname = ${PUBLIC_CASE_LAW_SOURCE_TABLE}
              AND columns.attname IN (${sourceColumns})
            )
            AND has_column_privilege(
              current_user,
              columns.attrelid,
              columns.attnum,
              'SELECT'
            )
        ) AS "canReadOtherData",
        EXISTS (
          SELECT 1
          FROM pg_class AS tables
          INNER JOIN pg_namespace AS schemas
            ON schemas.oid = tables.relnamespace
          WHERE schemas.nspname = 'public'
            AND tables.relkind IN ('r', 'p', 'v', 'm', 'f')
            AND has_table_privilege(
              current_user,
              tables.oid,
              'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
            )
        ) AS "canWriteCaseLaw"
    `;
};

const validateExternalCaseLawDatabase = async (
  database: Pick<Transaction, "execute">,
): Promise<void> => {
  const [permissions] = await database.execute<CaseLawDatabaseRolePermissions>(
    caseLawDatabaseRolePermissionsSql(),
  );

  if (permissions === undefined) {
    panic("CASE_LAW_DATABASE_URL role validation returned no result");
  }
  assertCaseLawDatabaseRolePermissions(permissions);
};

/**
 * The isolation statement, first in the transaction so it binds the snapshot
 * before any read takes one.
 */
const beginReadTransaction = async (
  tx: Pick<Transaction, "execute">,
  isolation: CaseLawReadIsolation,
): Promise<void> => {
  await tx.execute(
    isolation === "repeatable-read"
      ? sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`
      : sql`SET TRANSACTION READ ONLY`,
  );
};

const configureExternalReadTransaction = async (
  tx: Transaction,
  isolation: CaseLawReadIsolation = "read-committed",
): Promise<void> => {
  await beginReadTransaction(tx, isolation);
  await tx.execute(sql`SET LOCAL statement_timeout = '30s'`);
  await tx.execute(sql`SET LOCAL lock_timeout = '1s'`);
  await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout = '30s'`);
};

const startRoleValidation = async (
  external: ExternalCaseLawDatabase,
): Promise<void> => {
  const promise = external.database
    .transaction(async (tx) => {
      await configureExternalReadTransaction(tx);
      await validateExternalCaseLawDatabase(tx);
    })
    .then(
      () => {
        external.roleValidation = { status: "validated" };
        return undefined;
      },
      (error: unknown) => {
        external.roleValidation = { status: "idle" };
        throw error;
      },
    );
  external.roleValidation = { status: "pending", promise };
  await promise;
};

const ensureRoleValidated = async (
  external: ExternalCaseLawDatabase,
): Promise<void> => {
  switch (external.roleValidation.status) {
    case "idle":
      await startRoleValidation(external);
      return;
    case "pending":
      await external.roleValidation.promise;
      return;
    case "validated":
      return;
    default: {
      const unreachable: never = external.roleValidation;
      panic("Unexpected case-law role validation state", unreachable);
    }
  }
};

const getCaseLawDatabase = async (): Promise<typeof rootDb> => {
  const url = envBase.CASE_LAW_DATABASE_URL;
  if (url === undefined) {
    return rootDb;
  }

  if (externalCaseLawDatabase === null) {
    const client = new SQL({
      url,
      connectionTimeout: EXTERNAL_CASE_LAW_CONNECTION_TIMEOUT_SECONDS,
      max: envBase.CASE_LAW_DATABASE_POOL_MAX,
      maxLifetime: envBase.DATABASE_POOL_MAX_LIFETIME_S,
      idleTimeout: envBase.DATABASE_POOL_IDLE_TIMEOUT_S,
    });
    const database = drizzle({
      client,
      relations: databaseRelations,
      logger: envBase.isDev ? queryCountLogger : undefined,
    });
    externalCaseLawDatabase = {
      database,
      roleValidation: { status: "idle" },
    };
  }

  await ensureRoleValidated(externalCaseLawDatabase);
  return externalCaseLawDatabase.database;
};

/**
 * Read-only access boundary for public case-law data.
 *
 * Public handlers intentionally do not receive `scopedDb`, `session`, or
 * workspace context. Requiring this branded wrapper keeps public reads from
 * accidentally depending on authenticated route macros.
 */
export const caseLawPublicReadDb: CaseLawPublicReadDb = Object.assign(
  async <T>(
    fn: (tx: CaseLawPublicReadTransaction) => Promise<T>,
    options?: CaseLawReadOptions,
  ): Promise<T> => {
    const isolation = options?.isolation ?? "read-committed";
    const database = await getCaseLawDatabase();
    return await database.transaction(async (tx) => {
      if (envBase.CASE_LAW_DATABASE_URL !== undefined) {
        await configureExternalReadTransaction(tx, isolation);
      } else {
        await beginReadTransaction(tx, isolation);
      }

      return await fn(tx);
    });
  },
  { [CASE_LAW_PUBLIC_READ_DB]: true as const },
);
