import { panic } from "better-result";
import type { ReservedSQL } from "bun";
import { describe, expect, test } from "bun:test";
import { getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { fileURLToPath } from "node:url";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  type GatedTestClientScope,
  withGatedTestClients,
} from "../tests/gated-test-database";
import type { OnlineMigrationConnection } from "./online-migration-connection";
import { onlineMigrationParams } from "./online-migration-connection";
import { caseLawDecisions, legislationWorkNames } from "./schema";
import {
  acquireJobTableLeases,
  acquireMigrationTableLeases,
  ensureTableLeaseQueue,
  MigrationTableLeaseTimeoutError,
  releaseJobTableLeases,
  renewJobTableLeases,
  type TableLeaseEvent,
} from "./table-lease-queue";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const migrationsFolder = fileURLToPath(
  new URL("../../drizzle", import.meta.url),
);
const requestedTable = getTableName(caseLawDecisions);
const otherTable = getTableName(legislationWorkNames);

const adapt = (connection: ReservedSQL): OnlineMigrationConnection => ({
  execute: async (query, params = []) => {
    await connection.unsafe(query, [...params]);
  },
  query: async (query, params = []) =>
    await connection.unsafe<unknown[]>(query, [...params]),
  release: async () => {
    await connection.release();
  },
});

const fixture = async (
  work: (scope: GatedTestClientScope) => Promise<void>,
) => {
  if (!databaseUrl) {
    throw new TypeError("DATABASE_URL required");
  }
  await withGatedTestClients(databaseUrl, work);
};

const executor = (connection: ReservedSQL) => ({
  execute: async (statement: Parameters<PgDialect["sqlToQuery"]>[0]) => {
    const query = new PgDialect().sqlToQuery(statement);
    return await connection.unsafe(
      query.sql,
      onlineMigrationParams(query.params),
    );
  },
});

const claim = async (
  connection: ReservedSQL,
  holderId: string,
  tables: readonly string[] = [requestedTable],
) => {
  await connection.unsafe("BEGIN");
  try {
    const acquired = await acquireJobTableLeases({
      tx: executor(connection),
      holderId,
      tables,
      leaseMs: 60_000,
    });
    await connection.unsafe("COMMIT");
    return acquired;
  } catch (error) {
    await connection.unsafe("ROLLBACK");
    throw error;
  }
};

const noLeaseLost = async (cause: unknown) => {
  throw cause;
};

describe.skipIf(!enabled)("Postgres table lease queue", () => {
  test("FIFO drains older jobs, defers conflicting jobs, and admits unrelated tables", async () => {
    await fixture(async ({ openClient }) => {
      const job = await openClient().sql.reserve();
      const migration = await openClient().sql.reserve();
      const holderId = `job:${Bun.randomUUIDv7()}`;
      const migrationId = `migration:${Bun.randomUUIDv7()}`;
      const otherId = `other:${Bun.randomUUIDv7()}`;
      const events: TableLeaseEvent[] = [];
      const requested = Promise.withResolvers<undefined>();
      try {
        await ensureTableLeaseQueue({
          connection: adapt(job),
          migrationsFolder,
        });
        expect(await claim(job, holderId)).toBe(true);
        const waiting = acquireMigrationTableLeases({
          connection: adapt(migration),
          tables: [requestedTable],
          holderId: migrationId,
          onLeaseLost: noLeaseLost,
          checkEveryMs: 10,
          waitMs: 2000,
          emit: (event) => {
            events.push(event);
            if (event.event === "migrate.table_lease_requested") {
              requested.resolve(undefined);
            }
          },
        });
        await requested.promise;
        expect(await claim(job, `blocked:${Bun.randomUUIDv7()}`)).toBe(false);
        expect(await claim(job, otherId, [otherTable])).toBe(true);
        const rows = await job.unsafe<{ granted_at: Date | null }[]>(
          "SELECT granted_at FROM scheduler_table_leases WHERE holder_id = $1",
          [migrationId],
        );
        expect(rows).toHaveLength(1);
        expect(rows.at(0)?.granted_at).toBeNull();
        await releaseJobTableLeases(executor(job), holderId);
        const held = await waiting;
        await held.assertHeld();
        expect(await claim(job, `blocked:${Bun.randomUUIDv7()}`)).toBe(false);
        await held.release();
        expect(events.map(({ event }) => event)).toEqual([
          "migrate.table_lease_requested",
          "migrate.table_lease_granted",
          "migrate.table_lease_released",
        ]);
        expect(await claim(job, holderId)).toBe(true);
      } finally {
        await job.unsafe(
          "DELETE FROM scheduler_table_leases WHERE holder_id IN ($1, $2, $3)",
          [holderId, migrationId, otherId],
        );
        await job.release();
        await migration.release();
      }
    });
  });

  test("expired job leases cannot renew or block the migration", async () => {
    await fixture(async ({ openClient }) => {
      const connection = await openClient().sql.reserve();
      const jobId = `dead:${Bun.randomUUIDv7()}`;
      const migrationId = `migration:${Bun.randomUUIDv7()}`;
      try {
        expect(await claim(connection, jobId)).toBe(true);
        await connection.unsafe(
          "UPDATE scheduler_table_leases SET expires_at = clock_timestamp() - interval '1 second' WHERE holder_id = $1",
          [jobId],
        );
        await renewJobTableLeases(executor(connection), jobId, 60_000);
        const expiredRows = await connection.unsafe<{ expired: boolean }[]>(
          "SELECT expires_at <= clock_timestamp() AS expired FROM scheduler_table_leases WHERE holder_id = $1",
          [jobId],
        );
        expect(expiredRows).toHaveLength(1);
        const expiredRow =
          expiredRows.at(0) ?? panic("Missing expired job lease");
        expect(expiredRow.expired).toBe(true);
        const held = await acquireMigrationTableLeases({
          connection: adapt(connection),
          tables: [requestedTable],
          holderId: migrationId,
          onLeaseLost: noLeaseLost,
          waitMs: 0,
        });
        await held.assertHeld();
        await held.release();
      } finally {
        await connection.unsafe(
          "DELETE FROM scheduler_table_leases WHERE holder_id IN ($1, $2)",
          [jobId, migrationId],
        );
        await connection.release();
      }
    });
  });

  test("timeout names the holder, executes no schema work, and releases every request", async () => {
    await fixture(async ({ openClient }) => {
      const job = await openClient().sql.reserve();
      const migration = await openClient().sql.reserve();
      const jobId = `holding-job:${Bun.randomUUIDv7()}`;
      const migrationId = `migration:${Bun.randomUUIDv7()}`;
      const events: TableLeaseEvent[] = [];
      let schemaStatements = 0;
      try {
        expect(await claim(job, jobId)).toBe(true);
        const schema = async () => {
          const hold = await acquireMigrationTableLeases({
            connection: adapt(migration),
            tables: [requestedTable, otherTable],
            holderId: migrationId,
            onLeaseLost: noLeaseLost,
            waitMs: 0,
            emit: (event) => {
              events.push(event);
            },
          });
          try {
            schemaStatements += 1;
          } finally {
            await hold.release();
          }
        };
        const error = await rejectionOf(schema());
        expect(error).toBeInstanceOf(MigrationTableLeaseTimeoutError);
        expect(error).toMatchObject({
          message: expect.stringContaining(jobId),
          holders: [{ holderId: jobId, ageMs: expect.any(Number) }],
        });
        expect(schemaStatements).toBe(0);
        expect(events.map(({ event }) => event)).toEqual([
          "migrate.table_lease_requested",
          "migrate.table_lease_timed_out",
          "migrate.table_lease_released",
        ]);
        expect(
          events.find(({ event }) => event === "migrate.table_lease_timed_out")
            ?.holderCount,
        ).toBe(1);
        const rows = await migration.unsafe(
          "SELECT holder_id FROM scheduler_table_leases WHERE holder_id = $1",
          [migrationId],
        );
        expect(rows).toHaveLength(0);
        const secondError = await rejectionOf(
          acquireMigrationTableLeases({
            connection: adapt(migration),
            tables: [requestedTable],
            holderId: migrationId,
            onLeaseLost: noLeaseLost,
            waitMs: 0,
          }),
        );
        expect(secondError).toMatchObject({
          message: expect.stringContaining(jobId),
        });
      } finally {
        await job.unsafe(
          "DELETE FROM scheduler_table_leases WHERE holder_id IN ($1, $2)",
          [jobId, migrationId],
        );
        await job.release();
        await migration.release();
      }
    });
  });

  test("nothing to lock requests nothing and leaves jobs claimable", async () => {
    await fixture(async ({ openClient }) => {
      const connection = await openClient().sql.reserve();
      const holderId = `job:${Bun.randomUUIDv7()}`;
      const migrationId = `empty:${Bun.randomUUIDv7()}`;
      const events: TableLeaseEvent[] = [];
      try {
        const hold = await acquireMigrationTableLeases({
          connection: adapt(connection),
          tables: [],
          holderId: migrationId,
          onLeaseLost: noLeaseLost,
          emit: (event) => {
            events.push(event);
          },
        });
        expect(await claim(connection, holderId)).toBe(true);
        await hold.assertHeld();
        await hold.release();
        expect(events).toEqual([]);
        expect(
          await connection.unsafe(
            "SELECT holder_id FROM scheduler_table_leases WHERE holder_id = $1",
            [migrationId],
          ),
        ).toHaveLength(0);
      } finally {
        await releaseJobTableLeases(executor(connection), holderId);
        await connection.release();
      }
    });
  });

  test("unresolved migration relations fence every job table", async () => {
    await fixture(async ({ openClient }) => {
      const connection = await openClient().sql.reserve();
      const migrationId = `wildcard:${Bun.randomUUIDv7()}`;
      try {
        const hold = await acquireMigrationTableLeases({
          connection: adapt(connection),
          tables: ["*"],
          holderId: migrationId,
          onLeaseLost: noLeaseLost,
        });
        try {
          expect(
            await claim(connection, `blocked:${Bun.randomUUIDv7()}`, [
              requestedTable,
            ]),
          ).toBe(false);
          expect(
            await claim(connection, `blocked:${Bun.randomUUIDv7()}`, [
              otherTable,
            ]),
          ).toBe(false);
        } finally {
          await hold.release();
        }
      } finally {
        await connection.release();
      }
    });
  });

  test("a pending request renews until older holders finish", async () => {
    await fixture(async ({ openClient }) => {
      const job = await openClient().sql.reserve();
      const migration = await openClient().sql.reserve();
      const jobId = `older:${Bun.randomUUIDv7()}`;
      const migrationId = `renewing:${Bun.randomUUIDv7()}`;
      const requested = Promise.withResolvers<undefined>();
      try {
        expect(await claim(job, jobId)).toBe(true);
        const waiting = acquireMigrationTableLeases({
          connection: adapt(migration),
          tables: [requestedTable],
          holderId: migrationId,
          onLeaseLost: noLeaseLost,
          leaseMs: 1000,
          checkEveryMs: 25,
          waitMs: 4000,
          emit: ({ event }) => {
            if (event === "migrate.table_lease_requested") {
              requested.resolve(undefined);
            }
          },
        });
        await requested.promise;
        await job.unsafe("SELECT pg_sleep(1.2)");
        expect(await claim(job, `blocked:${Bun.randomUUIDv7()}`)).toBe(false);
        await releaseJobTableLeases(executor(job), jobId);
        const hold = await waiting;
        await hold.assertHeld();
        await hold.release();
      } finally {
        await job.unsafe(
          "DELETE FROM scheduler_table_leases WHERE holder_id IN ($1, $2)",
          [jobId, migrationId],
        );
        await job.release();
        await migration.release();
      }
    });
  });

  test("an empty database bootstraps from the committed queue migration", async () => {
    await fixture(async ({ openClient }) => {
      if (!databaseUrl) {
        throw new TypeError("DATABASE_URL required");
      }
      const admin = openClient().sql;
      const name = `table_lease_${Bun.randomUUIDv7().replaceAll("-", "")}`;
      await admin.unsafe(`CREATE DATABASE "${name}"`);
      try {
        const url = new URL(databaseUrl);
        url.pathname = `/${name}`;
        await withGatedTestClients(
          url.toString(),
          async ({ openClient: openScratchClient }) => {
            const connection = await openScratchClient().sql.reserve();
            const holderId = `bootstrap:${Bun.randomUUIDv7()}`;
            try {
              await ensureTableLeaseQueue({
                connection: adapt(connection),
                migrationsFolder,
              });
              await ensureTableLeaseQueue({
                connection: adapt(connection),
                migrationsFolder,
              });
              expect(await claim(connection, holderId)).toBe(true);
              expect(
                await connection.unsafe(
                  "SELECT holder_id FROM scheduler_table_leases WHERE holder_id = $1",
                  [holderId],
                ),
              ).toHaveLength(1);
            } finally {
              await connection.release();
            }
          },
        );
      } finally {
        await admin.unsafe(`DROP DATABASE "${name}"`);
      }
    });
  });

  test("release retries cleanup after a database write rejects", async () => {
    await fixture(async ({ openClient }) => {
      const connection = await openClient().sql.reserve();
      const migrationId = `release:${Bun.randomUUIDv7()}`;
      let cleanupStatus: "reject-next" | "execute" = "reject-next";
      const live = adapt(connection);
      const faultConnection = {
        ...live,
        execute: async (statement, params) => {
          if (
            statement.startsWith(
              "DELETE FROM scheduler_table_leases WHERE holder_kind = 'migration'",
            ) &&
            cleanupStatus === "reject-next"
          ) {
            cleanupStatus = "execute";
            throw new TypeError("Injected lease cleanup rejection");
          }
          await live.execute(statement, params);
        },
      } satisfies OnlineMigrationConnection;
      try {
        const hold = await acquireMigrationTableLeases({
          connection: faultConnection,
          tables: [requestedTable],
          holderId: migrationId,
          onLeaseLost: noLeaseLost,
        });
        const error = await rejectionOf(hold.release());
        expect(error).toMatchObject({
          message: "Injected lease cleanup rejection",
        });
        expect(
          await connection.unsafe(
            "SELECT holder_id FROM scheduler_table_leases WHERE holder_id = $1",
            [migrationId],
          ),
        ).toHaveLength(1);
        await hold.release();
        await hold.release();
        expect(
          await connection.unsafe(
            "SELECT holder_id FROM scheduler_table_leases WHERE holder_id = $1",
            [migrationId],
          ),
        ).toHaveLength(0);
      } finally {
        await connection.unsafe(
          "DELETE FROM scheduler_table_leases WHERE holder_id = $1",
          [migrationId],
        );
        await connection.release();
      }
    });
  });

  test("coordination bootstrap is idempotent and preserves active leases", async () => {
    await fixture(async ({ openClient }) => {
      const connection = await openClient().sql.reserve();
      const holderId = `bootstrap:${Bun.randomUUIDv7()}`;
      try {
        await ensureTableLeaseQueue({
          connection: adapt(connection),
          migrationsFolder,
        });
        expect(await claim(connection, holderId)).toBe(true);
        await ensureTableLeaseQueue({
          connection: adapt(connection),
          migrationsFolder,
        });
        expect(
          await connection.unsafe(
            "SELECT holder_id FROM scheduler_table_leases WHERE holder_id = $1",
            [holderId],
          ),
        ).toHaveLength(1);
      } finally {
        await releaseJobTableLeases(executor(connection), holderId);
        await connection.release();
      }
    });
  });
});
