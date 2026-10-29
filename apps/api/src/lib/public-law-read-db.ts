import { panic, Result } from "better-result";
import { sql } from "drizzle-orm";
import type { SQL as SqlFragment } from "drizzle-orm";

import { databaseRelations } from "@/api/db/database-relations";
import { openCancellableReservedSession } from "@/api/db/long-running-connection";
import { stellaPublicLawReader } from "@/api/db/rls";
import { rootDb } from "@/api/db/root";
import type { Transaction } from "@/api/db/root";
import { sharedPoolConnectionSettings } from "@/api/db/shared-pool-connection-settings";
import { parsePostgresTimeoutMs } from "@/api/db/shared-pool-timeout-policy";
import { setSharedReadTransactionGuards } from "@/api/db/shared-pool-timeouts";
import { createDatabase, createSqlClient } from "@/api/db/sql-client";
import { envBase } from "@/api/env-base";
import {
  instrumentDedicatedSqlCounts,
  instrumentSqlTransactionCounts,
  queryCountLogger,
} from "@/api/lib/db-query-counter";
import { runTransactionsInCallerContext } from "@/api/lib/db/caller-async-context";
import { abortTransaction } from "@/api/lib/db/transaction-abort";
import { DatabaseError } from "@/api/lib/errors/tagged-errors";
import { PublicLawStatementError } from "@/api/lib/legal-search/public-law-statement-error";
import {
  getPublicReadSignal,
  getPublicReadStatementTimeoutMs,
  withPublicReadIo,
} from "@/api/lib/legal-search/public-read-timeout-context";
import {
  remainingRequestBudgetMs,
  requestBoundedTimeoutMs,
  requestBudgetExpiry,
} from "@/api/lib/load/request-latency-budget";
import { logger } from "@/api/lib/observability/logger";
import {
  getPgDriverErrorCode,
  getPgErrorCode,
  PG_DRIVER_ERROR,
  PG_ERROR,
} from "@/api/lib/pg-error";
import {
  PUBLIC_LAW_COLUMN_GRANTS_BY_RELATION,
  publicLawColumnPairs,
} from "@/api/lib/public-law-relations";
import type {
  PublicLawColumnGrantsByRelation,
  PublicLawColumnPair,
} from "@/api/lib/public-law-relations";
import { isLocalDevOpen } from "@/api/runtime-mode";

const EXTERNAL_PUBLIC_LAW_CONNECTION_TIMEOUT_SECONDS = 10;
const SLOW_PUBLIC_LAW_STATEMENT_MS = 1000;
// Frame 2 is the callsite: helper, transaction proxy, caller. Logger service.version
// scopes these repository-relative source or bundled-output locations to a build.
const PUBLIC_LAW_SQL_CALLSITE_FRAME = 2;

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

type PublicLawSharedReadTransaction = Pick<Transaction, "execute" | "select">;

/** The callsite names a query without exposing its SQL or bound values. */
const publicLawStatementName = (): string => {
  const trace = { stack: "" };
  Error.captureStackTrace(trace);
  const frames = trace.stack
    .split("\n")
    .filter((line) => line.includes(" at "));
  const frame = frames.at(PUBLIC_LAW_SQL_CALLSITE_FRAME);
  if (frame === undefined) {
    logger.warn("public_law.statement_callsite_unavailable");
    return "callsite-unavailable";
  }
  const trimmed = frame.trim();
  const location = trimmed.endsWith(")")
    ? trimmed.slice(trimmed.lastIndexOf("(") + 1, -1)
    : trimmed.slice(trimmed.lastIndexOf(" ") + 1);
  const columnSeparator = location.lastIndexOf(":");
  const lineSeparator = location.lastIndexOf(":", columnSeparator - 1);
  if (lineSeparator === -1 || columnSeparator <= lineSeparator) {
    logger.warn("public_law.statement_callsite_unavailable");
    return "callsite-unavailable";
  }
  const sourcePath = location.slice(0, lineSeparator);
  const line = location.slice(lineSeparator + 1, columnSeparator);
  const column = location.slice(columnSeparator + 1);
  const relativePath = sourcePath.startsWith(`${process.cwd()}/`)
    ? sourcePath.slice(process.cwd().length + 1)
    : (sourcePath.split("/").at(-1) ?? "unknown-source");
  return `${relativePath}:${line}:${column}`;
};

const observePublicLawStatement = async <T>(
  statementName: string,
  operation: () => Promise<T>,
): Promise<Result<T, PublicLawStatementError>> => {
  const startedAt = performance.now();
  const outcome = await Result.tryPromise({
    try: async () => {
      getPublicReadSignal()?.throwIfAborted();
      return await operation();
    },
    catch: (cause: unknown) =>
      new PublicLawStatementError({
        message: "Public-law statement failed",
        cause,
      }),
  });
  const durationMs = Math.round(performance.now() - startedAt);
  if (Result.isError(outcome)) {
    if (getPgErrorCode(outcome.error) === "57014") {
      logger.warn("public_law.read_statement_cancelled", {
        "statement.callsite": statementName,
        durationMs,
      });
    } else if (durationMs >= SLOW_PUBLIC_LAW_STATEMENT_MS) {
      logger.warn("public_law.read_statement_slow", {
        "statement.callsite": statementName,
        durationMs,
      });
    }
    return outcome;
  }
  if (durationMs >= SLOW_PUBLIC_LAW_STATEMENT_MS) {
    logger.warn("public_law.read_statement_slow", {
      "statement.callsite": statementName,
      durationMs,
    });
  }
  return outcome;
};

// Wrap only executable query builders; subqueries and SQL fragments must keep
// their original non-thenable behavior and every other builder method intact.
const observedQueryBuilder = <T extends object>(
  builder: T,
  statementName: string,
): T =>
  new Proxy(builder, {
    get: (target, property) => {
      const method = Reflect.get(target, property, target);
      if (
        property === "then" ||
        property === "catch" ||
        property === "finally"
      ) {
        if (typeof method !== "function") {
          return method;
        }
        return (...args: unknown[]) => {
          const outcome = observePublicLawStatement(
            statementName,
            async () => await Promise.resolve(target),
          ).then((result) => {
            if (Result.isError(result)) {
              return abortTransaction(result.error);
            }
            return result.value;
          });
          const continuation: unknown = Reflect.get(outcome, property, outcome);
          if (typeof continuation !== "function") {
            panic("Observed promise continuation must be callable", property);
          }
          const result: unknown = Reflect.apply(continuation, outcome, args);
          return result;
        };
      }
      if (typeof method !== "function") {
        return method;
      }
      if (property === "execute") {
        return async (...args: unknown[]) => {
          const outcome = await observePublicLawStatement(
            statementName,
            async () => {
              const result: unknown = Reflect.apply(method, target, args);
              return await result;
            },
          );
          if (Result.isError(outcome)) {
            return abortTransaction(outcome.error);
          }
          return outcome.value;
        };
      }
      return (...args: unknown[]) => {
        const result: unknown = Reflect.apply(method, target, args);
        if (typeof result !== "object" || result === null) {
          return result;
        }
        const execute: unknown = Reflect.get(result, "execute", result);
        return typeof execute === "function"
          ? observedQueryBuilder(result, statementName)
          : result;
      };
    },
  });

export const observePublicLawReadTransaction = (
  transaction: PublicLawSharedReadTransaction,
): PublicLawSharedReadTransaction =>
  new Proxy(transaction, {
    get: (target, property) => {
      if (property === "execute") {
        return (...args: Parameters<typeof target.execute>) => {
          const statementName = publicLawStatementName();
          return observedQueryBuilder(target.execute(...args), statementName);
        };
      }
      if (property === "select") {
        return (...args: Parameters<typeof target.select>) => {
          const statementName = publicLawStatementName();
          return observedQueryBuilder(target.select(...args), statementName);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return value;
    },
  });

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

// Cancellation has its own bounded pool: a full read pool cannot service it.
let cancellationClient: ReturnType<typeof createSqlClient> | undefined;
const cancelPublicLawBackend = async (pid: number) => {
  cancellationClient ??= instrumentDedicatedSqlCounts(
    createSqlClient({
      url: envBase.PUBLIC_LAW_DATABASE_URL ?? envBase.DATABASE_URL,
      max: 1,
      connectionTimeout: EXTERNAL_PUBLIC_LAW_CONNECTION_TIMEOUT_SECONDS,
      idleTimeout: envBase.DATABASE_POOL_IDLE_TIMEOUT_S,
      connection: { statement_timeout: 5000 },
    }),
    "cleanup",
  );
  await cancellationClient.unsafe("SELECT pg_cancel_backend($1)", [pid]);
};

/**
 * The column tuples of one bound, as a relation a CTE can name. An empty bound
 * still has to type-check as `(text, text)`, so it degenerates to no rows
 * rather than to invalid `VALUES ()`.
 */
const columnTupleSource = (
  columns: readonly PublicLawColumnPair[],
): SqlFragment =>
  columns.length === 0
    ? sql`SELECT NULL::text, NULL::text WHERE false`
    : sql`VALUES ${sql.join(
        columns.map(
          ({ relation, column }) => sql`(${relation}::text, ${column}::text)`,
        ),
        sql.raw(","),
      )}`;

/**
 * What `current_user` may do, in the terms the validator judges.
 * Exported so the role a migration defines can be held to the same query, and
 * parameterized so the security suite can judge the same role against a
 * deliberately staged grant map.
 */
export const publicLawDatabaseRolePermissionsSql = (
  columnGrants: PublicLawColumnGrantsByRelation = PUBLIC_LAW_COLUMN_GRANTS_BY_RELATION,
): SqlFragment => {
  const grantedColumns = publicLawColumnPairs(columnGrants);
  const requiredColumns = grantedColumns.filter(
    ({ grant }) => grant === "required",
  );
  // sql-perf-allow: small table pg_catalog and information_schema role metadata
  return sql`
      WITH required(relation, column_name) AS (
        ${columnTupleSource(requiredColumns)}
      ),
      granted(relation, column_name) AS (
        ${columnTupleSource(grantedColumns)}
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
          -- The lower bound: every column this release reads. A grant staged
          -- ahead of its read is not required here, so the release before it
          -- still serves.
          SELECT count(*) = ${requiredColumns.length}
            AND coalesce(
              bool_and(
                has_column_privilege(
                  current_user,
                  columns.attrelid,
                  columns.attnum,
                  'SELECT'
                )
              ),
              true
            )
          FROM required
          INNER JOIN pg_class AS tables ON tables.relname = required.relation
          INNER JOIN pg_namespace AS schemas
            ON schemas.oid = tables.relnamespace
          INNER JOIN pg_attribute AS columns
            ON columns.attrelid = tables.oid
            AND columns.attname = required.column_name
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
          -- The upper bound: required plus permitted. Any readable column
          -- outside it is excess, including a grant no release has declared.
          SELECT 1
          FROM pg_attribute AS columns
          INNER JOIN pg_class AS tables ON tables.oid = columns.attrelid
          INNER JOIN pg_namespace AS schemas
            ON schemas.oid = tables.relnamespace
          LEFT JOIN granted
            ON schemas.nspname = 'public'
            AND granted.relation = tables.relname
            AND granted.column_name = columns.attname
          WHERE schemas.nspname <> 'information_schema'
            AND schemas.nspname !~ '^pg_'
            AND tables.relkind IN ('r', 'p', 'v', 'm', 'f')
            AND columns.attnum > 0
            AND NOT columns.attisdropped
            AND granted.relation IS NULL
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

type PublicLawReadGuard = readonly [setting: string, value: string];

/**
 * Which of a read's installed guards the request's budget set, recorded
 * when `configureReadTransaction` installs them, so a timeout is reported as
 * the budget's only when the budget is what shortened it.
 */
export type ReadGuardProvenance = {
  statementTimeoutClamped: boolean;
  transactionDeadline: boolean;
};

/** Any handle that can run the setup statements, including a test's own. */
type ConfigurableReadTransaction = {
  execute: (query: SqlFragment) => Promise<unknown>;
};

/**
 * What every public read runs under.
 *
 * Read-only is set here rather than with `SET TRANSACTION` so the whole guard
 * set fits in one statement. Role and isolation setup may precede it; no
 * consumer query runs before these guards.
 */
const PUBLIC_LAW_READ_GUARDS = [
  ["transaction_read_only", "on"],
  ["statement_timeout", "30s"],
] as const satisfies readonly PublicLawReadGuard[];

/** What a read against the separate public-law database adds. */
export const EXTERNAL_PUBLIC_LAW_READ_GUARDS = [
  ...PUBLIC_LAW_READ_GUARDS,
  ["lock_timeout", "1s"],
  ["idle_in_transaction_session_timeout", "30s"],
] as const satisfies readonly PublicLawReadGuard[];

/**
 * The guards a read runs under. Repeatable read needs a statement of its own
 * and must come first: the isolation level binds the snapshot, and Postgres
 * refuses to change it once a query has taken one.
 */
export const configureReadTransaction = async (
  tx: ConfigurableReadTransaction,
  isolation: PublicLawReadIsolation,
  guards: readonly PublicLawReadGuard[],
  /** Filled in with which of the installed guards the request's budget set. */
  provenance?: ReadGuardProvenance,
): Promise<void> => {
  if (isolation === "repeatable-read") {
    await tx.execute(
      sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`,
    );
  }
  let statementTimeoutMs: number | undefined;
  let lockTimeoutMs: number | undefined;
  let idleInTransactionTimeoutMs: number | undefined;
  let readOnly = false;
  for (const [setting, value] of guards) {
    switch (setting) {
      case "transaction_read_only":
        readOnly = value === "on";
        break;
      case "statement_timeout":
        statementTimeoutMs = parsePostgresTimeoutMs(value);
        break;
      case "lock_timeout":
        lockTimeoutMs = parsePostgresTimeoutMs(value);
        break;
      case "idle_in_transaction_session_timeout":
        idleInTransactionTimeoutMs = parsePostgresTimeoutMs(value);
        break;
      default:
        panic("Unexpected public-law read guard", setting);
    }
  }
  if (!readOnly || statementTimeoutMs === undefined) {
    panic("Public-law read guards require read-only and a statement timeout");
  }
  const requestTimeoutMs = getPublicReadStatementTimeoutMs();
  // Inside a request latency scope the whole transaction ends at the
  // request's deadline. `statement_timeout` alone restarts with every
  // statement, so a run of statements could still outlast the request;
  // `transaction_timeout` counts them together and ends the session even
  // between statements. Zero outside a scope: no deadline of the request's.
  const requestDeadlineMs = requestBoundedTimeoutMs(0);
  const statementCapMs =
    requestTimeoutMs === undefined
      ? statementTimeoutMs
      : Math.min(statementTimeoutMs, requestTimeoutMs);
  const requestStatementTimeoutMs = requestBoundedTimeoutMs(statementCapMs);
  // Which installed timeouts are the request's: only those may later be
  // reported as its budget running out.
  if (provenance !== undefined) {
    provenance.statementTimeoutClamped =
      requestStatementTimeoutMs < statementCapMs;
    provenance.transactionDeadline = requestDeadlineMs > 0;
  }
  await setSharedReadTransactionGuards(tx, {
    statementTimeoutMs: requestStatementTimeoutMs,
    ...(lockTimeoutMs === undefined ? {} : { lockTimeoutMs }),
    ...(idleInTransactionTimeoutMs === undefined
      ? {}
      : { idleInTransactionTimeoutMs }),
    ...(requestDeadlineMs > 0
      ? { transactionTimeoutMs: requestDeadlineMs }
      : {}),
  });
};

/** Shared-pool reads downgrade their role before any query binds a snapshot. */
export const setSharedPublicLawReaderRole = async (
  tx: ConfigurableReadTransaction,
): Promise<void> => {
  await tx.execute(
    sql`SET LOCAL ROLE ${sql.identifier(stellaPublicLawReader.name)}`,
  );
};

/** A separate database is reached over a network the shared one is not. */
const publicLawReadGuards = (): readonly PublicLawReadGuard[] =>
  envBase.PUBLIC_LAW_DATABASE_URL === undefined
    ? PUBLIC_LAW_READ_GUARDS
    : EXTERNAL_PUBLIC_LAW_READ_GUARDS;

const startRoleValidation = async (
  external: ExternalPublicLawDatabase,
): Promise<void> => {
  const validation = withPublicReadIo("database", async (io) => {
    const resource = await openPublicReadDatabase(external.database, io.signal);
    try {
      await io.readTransaction(resource.database, async (tx) => {
        const observedTransaction = observePublicLawReadTransaction(tx);
        await configureReadTransaction(
          observedTransaction,
          "read-committed",
          EXTERNAL_PUBLIC_LAW_READ_GUARDS,
        );
        await validateExternalPublicLawDatabase(observedTransaction);
      });
    } finally {
      await resource.close();
    }
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
    const client = runTransactionsInCallerContext(
      instrumentSqlTransactionCounts(
        createSqlClient({
          url,
          connectionTimeout: EXTERNAL_PUBLIC_LAW_CONNECTION_TIMEOUT_SECONDS,
          max: envBase.PUBLIC_LAW_DATABASE_POOL_MAX,
          maxLifetime: envBase.DATABASE_POOL_MAX_LIFETIME_S,
          idleTimeout: envBase.DATABASE_POOL_IDLE_TIMEOUT_S,
          ...sharedPoolConnectionSettings("public_law"),
        }),
      ),
    );
    const database = createDatabase({
      client,
      relations: databaseRelations,
      logger: isLocalDevOpen() ? queryCountLogger : undefined,
    });
    externalPublicLawDatabase = {
      database,
      roleValidation: { status: "idle" },
    };
  }

  await ensureRoleValidated(externalPublicLawDatabase);
  return externalPublicLawDatabase.database;
};

const openPublicReadDatabase = async (
  pool: typeof rootDb,
  signal: AbortSignal | undefined,
) => {
  if (signal === undefined) {
    return { database: pool, close: async () => await Promise.resolve() };
  }
  const reservation = await openCancellableReservedSession({
    reserve: async () =>
      instrumentDedicatedSqlCounts(await pool.$client.reserve({ signal })),
    cancelBackend: cancelPublicLawBackend,
    signal,
  });
  return {
    database: createDatabase({
      client: runTransactionsInCallerContext(reservation.session),
      relations: databaseRelations,
    }),
    close: reservation.close,
  };
};

/**
 * Shared read-only transaction boundary for public legal data.
 *
 * Public handlers intentionally do not receive `scopedDb`, `session`, or
 * workspace context. Requiring this branded wrapper keeps public reads from
 * accidentally depending on authenticated route macros.
 *
 * Inside a request latency scope the guards end the transaction at the
 * request's deadline. A statement or transaction timeout is reported as the
 * budget's `timeout_budgeted` TimeoutError (the database error its cause)
 * only when the guard that fired is one the request's budget shortened, as
 * recorded when it was installed; a timeout of the read's own, or an explicit
 * cancel, keeps its own error and grade.
 */
export const publicLawReadDb = async <T>(
  fn: (tx: PublicLawSharedReadTransaction) => Promise<T>,
  options?: PublicLawReadOptions,
): Promise<T> =>
  await withPublicReadIo("database", async (io) => {
    const signal = io.signal;
    signal?.throwIfAborted();
    const isolation = options?.isolation ?? "read-committed";
    const pool = await getPublicLawDatabase();
    const resource = await openPublicReadDatabase(pool, signal);
    const provenance: ReadGuardProvenance = {
      statementTimeoutClamped: false,
      transactionDeadline: false,
    };
    let outcome: Result<T, unknown>;
    try {
      const read = io.readTransaction(
        resource.database,
        async (transaction) => {
          const tx = observePublicLawReadTransaction(transaction);
          if (envBase.PUBLIC_LAW_DATABASE_URL === undefined) {
            await setSharedPublicLawReaderRole(tx);
          }
          await configureReadTransaction(
            tx,
            isolation,
            publicLawReadGuards(),
            provenance,
          );

          return await fn(tx);
        },
      );
      outcome = await read.then(
        (value) => Result.ok(value),
        (error: unknown) => Result.err(error),
      );
    } finally {
      await resource.close();
    }
    // Cancellation and the transaction have both settled before admission releases.
    // A driver cancellation is the caller's abort, not a statement timeout.
    signal?.throwIfAborted();
    if (Result.isError(outcome)) {
      return abortTransaction(publicLawReadFailure(outcome.error, provenance));
    }
    return outcome.value;
  });
/**
 * What a failed read rejects with: the budget's `timeout_budgeted`
 * TimeoutError when a guard the request clamped ended it, else the failure
 * itself (a non-Error rejection wrapped, so the rejection is always an Error).
 */
const publicLawReadFailure = (
  error: unknown,
  provenance: ReadGuardProvenance,
): Error => {
  const expiry = requestBudgetExpiry(error, {
    clampedTimeout: endedByRequestClampedGuard(error, provenance),
  });
  if (expiry !== undefined) {
    return expiry;
  }
  return error instanceof Error
    ? error
    : new DatabaseError({
        message: "Public-law read transaction rejected with a non-Error value",
        cause: error,
      });
};

/**
 * Whether the guard that ended the read is one the request's budget set: the
 * statement timeout when the budget shortened it, or the transaction deadline,
 * which only the budget sets. The server ending the session for that deadline
 * between two statements reaches the client as a closed connection with no
 * SQLSTATE, so a closed connection counts only once the budget is spent.
 */
const endedByRequestClampedGuard = (
  error: unknown,
  { statementTimeoutClamped, transactionDeadline }: ReadGuardProvenance,
): boolean => {
  switch (getPgErrorCode(error)) {
    case PG_ERROR.QUERY_CANCELED:
      return statementTimeoutClamped;
    case PG_ERROR.TRANSACTION_TIMEOUT:
      return transactionDeadline;
    case undefined:
      return (
        transactionDeadline &&
        getPgDriverErrorCode(error) === PG_DRIVER_ERROR.CONNECTION_CLOSED &&
        remainingRequestBudgetMs() === 0
      );
    default:
      return false;
  }
};
