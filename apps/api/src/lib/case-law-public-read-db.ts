import { panic } from "better-result";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";

import { databaseRelations } from "@/api/db/database-relations";
import { rootDb } from "@/api/db/root";
import type { Transaction } from "@/api/db/root";
import { envBase } from "@/api/env-base";
import { queryCountLogger } from "@/api/lib/db-query-counter";

const CASE_LAW_PUBLIC_READ_DB = Symbol("caseLawPublicReadDb");
const EXTERNAL_CASE_LAW_CONNECTION_TIMEOUT_SECONDS = 10;

export const PUBLIC_CASE_LAW_RELATIONS = [
  "case_law_citations",
  "case_law_corpus_index_projections",
  "case_law_decisions",
  "case_law_provision_citations",
  "case_law_sources",
] as const;

type CaseLawQueryKey = Extract<keyof Transaction["query"], "caseLawDecisions">;

export type CaseLawPublicReadTransaction = Pick<
  Transaction,
  "execute" | "select"
> & {
  query: Pick<Transaction["query"], CaseLawQueryKey>;
};

export type CaseLawPublicReadDb = (<T>(
  fn: (tx: CaseLawPublicReadTransaction) => Promise<T>,
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

const validateExternalCaseLawDatabase = async (
  database: Pick<Transaction, "execute">,
): Promise<void> => {
  const publicRelations = sql.join(
    PUBLIC_CASE_LAW_RELATIONS.map((name) => sql`${name}`),
    sql.raw(","),
  );
  const [permissions] = await database.execute<CaseLawDatabaseRolePermissions>(
    sql`
      SELECT
        (
          SELECT count(*) = ${PUBLIC_CASE_LAW_RELATIONS.length}
            AND bool_and(
              has_table_privilege(current_user, tables.oid, 'SELECT')
            )
          FROM pg_class AS tables
          INNER JOIN pg_namespace AS schemas
            ON schemas.oid = tables.relnamespace
          WHERE schemas.nspname = 'public'
            AND tables.relkind IN ('r', 'p', 'v', 'm', 'f')
            AND tables.relname IN (${publicRelations})
        ) AS "canReadCaseLaw",
        EXISTS (
          SELECT 1
          FROM pg_class AS tables
          INNER JOIN pg_namespace AS schemas
            ON schemas.oid = tables.relnamespace
          WHERE schemas.nspname = 'public'
            AND tables.relkind IN ('r', 'p', 'v', 'm', 'f')
            AND tables.relname NOT IN (${publicRelations})
            AND has_table_privilege(current_user, tables.oid, 'SELECT')
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
    `,
  );

  if (permissions === undefined) {
    panic("CASE_LAW_DATABASE_URL role validation returned no result");
  }
  assertCaseLawDatabaseRolePermissions(permissions);
};

const configureExternalReadTransaction = async (
  tx: Transaction,
): Promise<void> => {
  await tx.execute(sql`SET TRANSACTION READ ONLY`);
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
  ): Promise<T> => {
    const database = await getCaseLawDatabase();
    return await database.transaction(async (tx) => {
      if (envBase.CASE_LAW_DATABASE_URL !== undefined) {
        await configureExternalReadTransaction(tx);
      } else {
        await tx.execute(sql`SET TRANSACTION READ ONLY`);
      }

      return await fn(tx);
    });
  },
  { [CASE_LAW_PUBLIC_READ_DB]: true as const },
);
