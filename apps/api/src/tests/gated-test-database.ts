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
import { SQL } from "bun";
import { afterAll } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sql";

import { databaseRelations } from "@/api/db/database-relations";

const openDatabase = (client: SQL) =>
  drizzle({ client, relations: databaseRelations });

export type GatedTestDb = ReturnType<typeof openDatabase>;

type CleanupStep = () => Promise<void>;

export type GatedTestDatabase = {
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
): GatedTestDatabase => {
  const client = new SQL({ url: databaseUrl });
  const cleanupSteps: CleanupStep[] = [];

  afterAll(async () => {
    try {
      for (const step of cleanupSteps) {
        await step();
      }
    } finally {
      await client.close();
    }
  });

  return {
    db: openDatabase(client),
    cleanUp: (step) => {
      cleanupSteps.push(step);
    },
  };
};

export type GatedTestClient = {
  /** The raw client, for tagged-template queries and `begin`. */
  readonly sql: SQL;
  readonly db: GatedTestDb;
};

type OpenClientOptions = {
  /** Connections in this client's pool. */
  readonly max?: number;
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
  const openClient = ({ max = 1 }: OpenClientOptions = {}) => {
    const client = new SQL({ url: databaseUrl, max });
    opened.push(client);
    return { sql: client, db: openDatabase(client) };
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
