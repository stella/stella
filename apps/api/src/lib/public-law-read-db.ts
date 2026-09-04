import { panic } from "better-result";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import type { SQL as SqlFragment } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";

import { databaseRelations } from "@/api/db/database-relations";
import { stellaPublicLawReader } from "@/api/db/rls";
import { rootDb } from "@/api/db/root";
import type { Transaction } from "@/api/db/root";
import { envBase } from "@/api/env-base";
import { queryCountLogger } from "@/api/lib/db-query-counter";
import { PUBLIC_LAW_COLUMNS_BY_RELATION } from "@/api/lib/public-law-relations";

const EXTERNAL_PUBLIC_LAW_CONNECTION_TIMEOUT_SECONDS = 10;

/**
 * How much of one state a transaction sees.
 *
 * `repeatable-read` pins every statement to the snapshot the first one took,
 * so a decision gated at the start cannot have its content read out of a
 * later, different state; the redistribution gate depends on it. Reads that
 * answer from a single statement do not need it and do not pay for it.
 */
export type PublicLawReadIsolation = "read-committed" | "repeatable-read";

export type PublicLawReadOptions = { isolation?: PublicLawReadIsolation };

type PublicLawQueryKey = Extract<
  keyof Transaction["query"],
  "caseLawDecisions"
>;

type PublicLawSharedReadTransaction = Pick<
  Transaction,
  "execute" | "select"
> & {
  query: Pick<Transaction["query"], PublicLawQueryKey>;
};

export type PublicLawDatabaseRolePermissions = {
  canAccessOtherDatabase: boolean;
  canUseOtherRole: boolean;
  canConnect: boolean;
  canDelegatePublicLaw: boolean;
  canReadPublicLaw: boolean;
  canReadOtherData: boolean;
  canUseSequence: boolean;
  canUseSchema: boolean;
  canWritePublicLaw: boolean;
  hasPrivilegedRoleAttributes: boolean;
  hasPublicLawReaderUsage: boolean;
};

export const assertPublicLawDatabaseRolePermissions = ({
  canAccessOtherDatabase,
  canUseOtherRole,
  canConnect,
  canDelegatePublicLaw,
  canReadPublicLaw,
  canReadOtherData,
  canUseSequence,
  canUseSchema,
  canWritePublicLaw,
  hasPrivilegedRoleAttributes,
  hasPublicLawReaderUsage,
}: PublicLawDatabaseRolePermissions): void => {
  if (
    canAccessOtherDatabase ||
    canUseOtherRole ||
    !canConnect ||
    canDelegatePublicLaw ||
    !canReadPublicLaw ||
    canReadOtherData ||
    canUseSequence ||
    !canUseSchema ||
    canWritePublicLaw ||
    hasPrivilegedRoleAttributes ||
    !hasPublicLawReaderUsage
  ) {
    panic(
      "PUBLIC_LAW_DATABASE_URL must use a role that can only read the public-law corpus",
    );
  }
};

type ExternalPublicLawDatabase = {
  database: typeof rootDb;
  roleValidation:
    | { status: "idle" }
    | { status: "pending"; promise: Promise<void> }
    | { status: "validated" };
};

let externalPublicLawDatabase: ExternalPublicLawDatabase | null = null;

/**
 * What `current_user` may do, in the terms the validator judges.
 * Exported so the role a migration defines can be held to the same query.
 */
export const publicLawDatabaseRolePermissionsSql = (): SqlFragment => {
  const expectedColumns = Object.entries(
    PUBLIC_LAW_COLUMNS_BY_RELATION,
  ).flatMap(([relation, columns]) =>
    columns.map((column) => ({ relation, column })),
  );
  const expectedValues = sql.join(
    expectedColumns.map(
      ({ relation, column }) => sql`(${relation}::text, ${column}::text)`,
    ),
    sql.raw(","),
  );
  return sql`
      WITH expected(relation, column_name) AS (
        VALUES ${expectedValues}
      )
      SELECT
        EXISTS (
          SELECT 1
          FROM pg_database AS databases
          WHERE NOT databases.datistemplate
            AND databases.datallowconn
            AND databases.datname <> current_database()
            AND has_database_privilege(
              current_user,
              databases.oid,
              'CONNECT,CREATE'
            )
        ) AS "canAccessOtherDatabase",
        EXISTS (
          SELECT 1
          FROM pg_roles AS roles
          WHERE roles.rolname NOT IN (
              current_user,
              ${stellaPublicLawReader.name}
            )
            AND (
              pg_has_role(current_user, roles.oid, 'SET')
              OR pg_has_role(current_user, roles.oid, 'USAGE')
            )
        ) AS "canUseOtherRole",
        has_database_privilege(
          current_user,
          current_database(),
          'CONNECT'
        ) AS "canConnect",
        (
          SELECT count(*) = ${expectedColumns.length}
            AND bool_and(
              has_column_privilege(
                current_user,
                columns.attrelid,
                columns.attnum,
                'SELECT'
              )
            )
          FROM expected
          INNER JOIN pg_class AS tables ON tables.relname = expected.relation
          INNER JOIN pg_namespace AS schemas
            ON schemas.oid = tables.relnamespace
          INNER JOIN pg_attribute AS columns
            ON columns.attrelid = tables.oid
            AND columns.attname = expected.column_name
          WHERE schemas.nspname = 'public'
            AND columns.attnum > 0
            AND NOT columns.attisdropped
        ) AS "canReadPublicLaw",
        (
          current_user <> ${stellaPublicLawReader.name}
          AND pg_has_role(
            current_user,
            ${stellaPublicLawReader.name},
            'MEMBER WITH ADMIN OPTION'
          )
        ) OR EXISTS (
          SELECT 1
          FROM information_schema.role_table_grants
          WHERE table_schema <> 'information_schema'
            AND table_schema !~ '^pg_'
            AND is_grantable = 'YES'
        ) OR EXISTS (
          SELECT 1
          FROM information_schema.role_column_grants
          WHERE table_schema <> 'information_schema'
            AND table_schema !~ '^pg_'
            AND is_grantable = 'YES'
        ) AS "canDelegatePublicLaw",
        EXISTS (
          SELECT 1
          FROM pg_class AS sequences
          INNER JOIN pg_namespace AS schemas
            ON schemas.oid = sequences.relnamespace
          WHERE schemas.nspname <> 'information_schema'
            AND schemas.nspname !~ '^pg_'
            AND sequences.relkind = 'S'
            AND has_sequence_privilege(
              current_user,
              sequences.oid,
              'USAGE,SELECT,UPDATE'
            )
        ) AS "canUseSequence",
        EXISTS (
          -- Any readable column outside the exact allowlist is excess.
          SELECT 1
          FROM pg_attribute AS columns
          INNER JOIN pg_class AS tables ON tables.oid = columns.attrelid
          INNER JOIN pg_namespace AS schemas
            ON schemas.oid = tables.relnamespace
          LEFT JOIN expected
            ON schemas.nspname = 'public'
            AND expected.relation = tables.relname
            AND expected.column_name = columns.attname
          WHERE schemas.nspname <> 'information_schema'
            AND schemas.nspname !~ '^pg_'
            AND tables.relkind IN ('r', 'p', 'v', 'm', 'f')
            AND columns.attnum > 0
            AND NOT columns.attisdropped
            AND expected.relation IS NULL
            AND has_column_privilege(
              current_user,
              columns.attrelid,
              columns.attnum,
              'SELECT'
            )
        ) AS "canReadOtherData",
        has_schema_privilege(current_user, 'public', 'USAGE')
          AS "canUseSchema",
        (
          SELECT
            roles.rolsuper
            OR roles.rolcreatedb
            OR roles.rolcreaterole
            OR roles.rolreplication
            OR roles.rolbypassrls
          FROM pg_roles AS roles
          WHERE roles.rolname = current_user
        ) AS "hasPrivilegedRoleAttributes",
        pg_has_role(
          current_user,
          ${stellaPublicLawReader.name},
          'USAGE'
        ) AS "hasPublicLawReaderUsage",
        has_database_privilege(
          current_user,
          current_database(),
          'CREATE'
        ) OR EXISTS (
          SELECT 1
          FROM pg_namespace AS schemas
          WHERE schemas.nspname <> 'information_schema'
            AND schemas.nspname !~ '^pg_'
            AND has_schema_privilege(current_user, schemas.oid, 'CREATE')
        ) OR EXISTS (
          SELECT 1
          FROM pg_class AS tables
          INNER JOIN pg_namespace AS schemas
            ON schemas.oid = tables.relnamespace
          WHERE schemas.nspname <> 'information_schema'
            AND schemas.nspname !~ '^pg_'
            AND tables.relkind IN ('r', 'p', 'v', 'm', 'f')
            AND (
              has_table_privilege(
                current_user,
                tables.oid,
                'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
              ) OR EXISTS (
                SELECT 1
                FROM pg_attribute AS columns
                WHERE columns.attrelid = tables.oid
                  AND columns.attnum > 0
                  AND NOT columns.attisdropped
                  AND has_column_privilege(
                    current_user,
                    columns.attrelid,
                    columns.attnum,
                    'INSERT,UPDATE,REFERENCES'
                  )
              )
            )
        ) AS "canWritePublicLaw"
    `;
};

const validateExternalPublicLawDatabase = async (
  database: Pick<Transaction, "execute">,
): Promise<void> => {
  const [permissions] =
    await database.execute<PublicLawDatabaseRolePermissions>(
      publicLawDatabaseRolePermissionsSql(),
    );

  if (permissions === undefined) {
    panic("PUBLIC_LAW_DATABASE_URL role validation returned no result");
  }
  assertPublicLawDatabaseRolePermissions(permissions);
};

/**
 * The isolation statement, first in the transaction so it binds the snapshot
 * before any read takes one.
 */
const configureReadTransaction = async (
  tx: Pick<Transaction, "execute">,
  isolation: PublicLawReadIsolation,
): Promise<void> => {
  await tx.execute(
    isolation === "repeatable-read"
      ? sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`
      : sql`SET TRANSACTION READ ONLY`,
  );
  await tx.execute(sql`SET LOCAL statement_timeout = '30s'`);
};

const configureExternalReadTransaction = async (
  tx: Transaction,
  isolation: PublicLawReadIsolation = "read-committed",
): Promise<void> => {
  await configureReadTransaction(tx, isolation);
  await tx.execute(sql`SET LOCAL lock_timeout = '1s'`);
  await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout = '30s'`);
};

const startRoleValidation = async (
  external: ExternalPublicLawDatabase,
): Promise<void> => {
  const validation = external.database.transaction(async (tx) => {
    await configureExternalReadTransaction(tx);
    await validateExternalPublicLawDatabase(tx);
  });
  const promise = validation.then(
    () => {
      external.roleValidation = { status: "validated" };
      return undefined;
    },
    // Reset the cache so the next caller retries from `idle`, then hand back
    // the rejected attempt itself. Every awaiter of the shared promise sees
    // the original failure, unwrapped and unreclassified.
    async () => {
      external.roleValidation = { status: "idle" };
      return await validation;
    },
  );
  external.roleValidation = { status: "pending", promise };
  await promise;
};

const ensureRoleValidated = async (
  external: ExternalPublicLawDatabase,
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
      external.roleValidation satisfies never;
      panic(
        "Unexpected public-law role validation state",
        external.roleValidation,
      );
    }
  }
};

const getPublicLawDatabase = async (): Promise<typeof rootDb> => {
  const url = envBase.PUBLIC_LAW_DATABASE_URL;
  if (url === undefined) {
    return rootDb;
  }

  if (externalPublicLawDatabase === null) {
    const client = new SQL({
      url,
      connectionTimeout: EXTERNAL_PUBLIC_LAW_CONNECTION_TIMEOUT_SECONDS,
      max: envBase.PUBLIC_LAW_DATABASE_POOL_MAX,
      maxLifetime: envBase.DATABASE_POOL_MAX_LIFETIME_S,
      idleTimeout: envBase.DATABASE_POOL_IDLE_TIMEOUT_S,
    });
    const database = drizzle({
      client,
      relations: databaseRelations,
      logger: envBase.isDev ? queryCountLogger : undefined,
    });
    externalPublicLawDatabase = {
      database,
      roleValidation: { status: "idle" },
    };
  }

  await ensureRoleValidated(externalPublicLawDatabase);
  return externalPublicLawDatabase.database;
};

/**
 * Shared read-only transaction boundary for public legal data.
 *
 * Public handlers intentionally do not receive `scopedDb`, `session`, or
 * workspace context. Requiring this branded wrapper keeps public reads from
 * accidentally depending on authenticated route macros.
 */
export const publicLawReadDb = async <T>(
  fn: (tx: PublicLawSharedReadTransaction) => Promise<T>,
  options?: PublicLawReadOptions,
): Promise<T> => {
  const isolation = options?.isolation ?? "read-committed";
  const database = await getPublicLawDatabase();
  return await database.transaction(async (tx) => {
    if (envBase.PUBLIC_LAW_DATABASE_URL !== undefined) {
      await configureExternalReadTransaction(tx, isolation);
    } else {
      await configureReadTransaction(tx, isolation);
    }

    return await fn(tx);
  });
};
