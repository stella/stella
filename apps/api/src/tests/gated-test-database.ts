/**
 * Database connections for the Postgres-gated suites.
 *
 * The gated runner (`scripts/run-gated-tests.ts`) runs every gated file in one
 * process, so a client a suite leaves open holds its connections for the rest
 * of the run, and enough of them exhaust the server's `max_connections` in a
 * later, unrelated suite. Each client here is closed by the helper that opened
 * it, after the suite's own cleanup and even when that cleanup throws.
 * `bun-test-hygiene/no-unmanaged-database-client` keeps test files from
 * constructing a client anywhere else.
 */
import { panic } from "better-result";
import { SQL } from "bun";
import { afterAll } from "bun:test";
import { sql } from "drizzle-orm";
import type { Logger } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";

import { databaseRelations } from "@/api/db/database-relations";

const openDatabase = (client: SQL, logger?: Logger) =>
  drizzle({ client, relations: databaseRelations, logger });

export type GatedTestDb = ReturnType<typeof openDatabase>;

type CleanupStep = () => Promise<void>;

export type GatedTestDatabase = {
  readonly sql: SQL;
  readonly db: GatedTestDb;
  /**
   * Registers suite cleanup (deleting the rows the suite wrote). Steps run
   * after the suite's tests, in registration order, and the client closes
   * once they have run or one of them has thrown.
   */
  readonly cleanUp: (step: CleanupStep) => void;
};

/**
 * A database for the whole suite, on a pool of the driver's default size.
 * Call it where the suite's hooks are registered (a `describe` body or the
 * file's top level): it registers the `afterAll` that runs the cleanup steps
 * and then closes the client.
 */
export const openGatedTestDatabase = (
  databaseUrl: string,
  { max, cleanupTimeoutMs }: { max?: number; cleanupTimeoutMs?: number } = {},
): GatedTestDatabase => {
  const client = new SQL({ url: databaseUrl, max });
  const cleanupSteps: CleanupStep[] = [];

  afterAll(async () => {
    try {
      for (const step of cleanupSteps) {
        await step();
      }
    } finally {
      await client.close();
    }
  }, cleanupTimeoutMs);

  return {
    sql: client,
    db: openDatabase(client),
    cleanUp: (step) => {
      cleanupSteps.push(step);
    },
  };
};

type GatedTestClient = {
  /** The raw client, for tagged-template queries and `begin`. */
  readonly sql: SQL;
  readonly db: GatedTestDb;
};

type OpenClientOptions = {
  readonly logger?: Logger;
  /** Connections in this client's pool. */
  readonly max?: number;
  /** Seconds of inactivity before Bun closes a connection. */
  readonly idleTimeout?: number;
  /** PostgreSQL settings sent when each connection opens. */
  readonly connection?: {
    readonly statement_timeout?: number;
    readonly lock_timeout?: number;
  };
};

type GatedTestClientScope = {
  /** Opens a client with a pool of its own, closed when the scope ends. */
  readonly openClient: (options?: OpenClientOptions) => GatedTestClient;
};

type GatedTestClientsOptions = {
  /**
   * Seconds each close waits for in-flight queries before it terminates
   * them; the driver waits for them by default. `0` closes at once.
   */
  readonly closeTimeout?: number;
};

/**
 * Separate clients for one test, for a test that needs several sessions at
 * once (lock waits, lease handoffs, concurrent writers). Every client opened
 * through the scope is closed when `fn` settles, after `fn`'s own `finally`
 * blocks have run and whether or not they threw.
 */
export const withGatedTestClients = async <T>(
  databaseUrl: string,
  fn: (scope: GatedTestClientScope) => Promise<T>,
  { closeTimeout }: GatedTestClientsOptions = {},
): Promise<T> => {
  const opened: SQL[] = [];
  const openClient = ({
    max = 1,
    idleTimeout,
    connection,
    logger,
  }: OpenClientOptions = {}) => {
    const client = new SQL({ url: databaseUrl, max, idleTimeout, connection });
    opened.push(client);
    return { sql: client, db: openDatabase(client, logger) };
  };

  try {
    return await fn({ openClient });
  } finally {
    await Promise.all(
      opened.map(
        async (client) =>
          await client.close(
            closeTimeout === undefined ? undefined : { timeout: closeTimeout },
          ),
      ),
    );
  }
};

type CopyIngestionTablePrivilegesOptions = {
  sourceDb: GatedTestDb;
  targetDb: GatedTestDb;
  targetSchema: string;
  tableNames: readonly string[];
};

/** Preserve migrated ingestion grants when canonical tables are recreated for a fixture. */
export const copyIngestionTablePrivileges = async ({
  sourceDb,
  targetDb,
  targetSchema,
  tableNames,
}: CopyIngestionTablePrivilegesOptions) => {
  const tables = sql.join(
    tableNames.map((name) => sql`${name}`),
    sql`, `,
  );
  const tableGrants = await sourceDb.execute(sql`
    SELECT table_name, privilege_type FROM information_schema.table_privileges
    WHERE table_schema = 'public' AND grantee = 'stella_ingestion'
      AND table_name IN (${tables}) ORDER BY table_name, privilege_type`);
  const columnGrants = await sourceDb.execute(sql`
    SELECT table_name, column_name, privilege_type FROM information_schema.column_privileges
    WHERE table_schema = 'public' AND grantee = 'stella_ingestion'
      AND table_name IN (${tables}) ORDER BY table_name, privilege_type, column_name`);
  await targetDb.execute(
    sql`GRANT USAGE ON SCHEMA ${sql.identifier(targetSchema)} TO stella_ingestion`,
  );
  const tablePrivileges = new Set<string>();
  for (const grant of tableGrants) {
    const table = grant["table_name"];
    const privilege = grant["privilege_type"];
    if (
      typeof table !== "string" ||
      !tableNames.includes(table) ||
      typeof privilege !== "string" ||
      ![
        "SELECT",
        "INSERT",
        "UPDATE",
        "DELETE",
        "TRUNCATE",
        "REFERENCES",
        "TRIGGER",
        "MAINTAIN",
      ].includes(privilege)
    ) {
      panic("Unexpected migrated ingestion table privilege");
    }
    tablePrivileges.add(`${table}.${privilege}`);
    // db-await-in-loop: reproduce the finite migrated privilege catalog in the isolated fixture.
    await targetDb.execute(
      sql`GRANT ${sql.raw(privilege)} ON ${sql.identifier(targetSchema)}.${sql.identifier(table)} TO stella_ingestion`,
    );
  }
  const groups = new Map<
    string,
    { table: string; privilege: string; columns: string[] }
  >();
  for (const grant of columnGrants) {
    const table = grant["table_name"];
    const column = grant["column_name"];
    const privilege = grant["privilege_type"];
    if (
      typeof table !== "string" ||
      !tableNames.includes(table) ||
      typeof column !== "string" ||
      typeof privilege !== "string" ||
      !["SELECT", "INSERT", "UPDATE", "REFERENCES"].includes(privilege)
    ) {
      panic("Unexpected migrated ingestion column privilege");
    }
    const key = `${table}.${privilege}`;
    // information_schema also emits column rows for whole-table privileges.
    if (tablePrivileges.has(key)) {
      continue;
    }
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { table, privilege, columns: [column] });
    } else {
      group.columns.push(column);
    }
  }
  for (const { table, privilege, columns } of groups.values()) {
    // db-await-in-loop: reproduce each fixed column-level grant from the migrated catalog.
    await targetDb.execute(
      sql`GRANT ${sql.raw(privilege)} (${sql.join(
        columns.map((column) => sql.identifier(column)),
        sql`, `,
      )}) ON ${sql.identifier(targetSchema)}.${sql.identifier(table)} TO stella_ingestion`,
    );
  }
};
