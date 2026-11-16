import { panic, TaggedError } from "better-result";
import { sql } from "drizzle-orm";

import { withTimeout } from "@stll/concurrency/with-timeout";

import { forceClosePool } from "@/api/db/sql-close";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type {
  GatedTestClientScope,
  GatedTestDb,
} from "@/api/tests/gated-test-database";

import { createQueryPerfDeadline, type QueryPerfDeadline } from "./deadline";
import { queryPerfDatabaseName, type QueryPerfProfileId } from "./profiles";
import {
  QUERY_PERF_CONNECTION_SETTINGS,
  QUERY_PERF_DIAGNOSTIC_CONNECTION_SETTINGS,
} from "./settings";

type QueryPerfFixtureOptions<T> = {
  databaseUrl: string;
  profileId: QueryPerfProfileId;
  /** The profile's whole budget for clone, seed and measurements. */
  timeoutMs?: number;
  /** A deadline the caller already started, so one budget spans several fixtures. */
  deadline?: QueryPerfDeadline;
  /** A seeded database to clone instead of the migrated template `databaseUrl` names. */
  template?: string;
  /** Keep the fixture under this name after a successful run, for later clones. */
  retainAs?: string;
  run: (
    database: GatedTestDb,
    deadline: QueryPerfDeadline,
    /** Further clients on the fixture database, closed with it. */
    openClient: GatedTestClientScope["openClient"],
  ) => Promise<T>;
};

type QueryPerfDiagnosticsOptions = {
  adminUrl: string;
  fixtureName: string;
  profileId: QueryPerfProfileId;
};

/** A separate connection can observe the session whose statement is still waiting. */
const dumpQueryPerfDiagnostics = async ({
  adminUrl,
  fixtureName,
  profileId,
}: QueryPerfDiagnosticsOptions) => {
  const result = await withGatedTestClients(
    adminUrl,
    async ({ openClient }) => {
      const { db } = openClient({
        connection: QUERY_PERF_DIAGNOSTIC_CONNECTION_SETTINGS,
      });
      await withTimeout(
        async () => {
          const activity =
            await db.execute(sql`SELECT pid, state, wait_event_type, wait_event,
      left(query, 300) AS query, pg_blocking_pids(pid) AS blocking_pids
      FROM pg_stat_activity WHERE datname = ${fixtureName} OR position(${fixtureName} in query) > 0
      ORDER BY pid LIMIT 40`);
          const locks =
            await db.execute(sql`SELECT l.pid, l.locktype, l.mode, l.granted,
      l.relation, l.transactionid
      FROM pg_locks l LEFT JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE a.datname = ${fixtureName} OR position(${fixtureName} in a.query) > 0 OR l.database = (SELECT oid FROM pg_database WHERE datname = ${fixtureName})
      ORDER BY l.granted, l.pid LIMIT 80`);
          process.stdout.write(
            `${JSON.stringify({
              event: "query_perf_diagnostics",
              profileId,
              fixtureName,
              activity,
              locks,
            })}\n`,
          );
        },
        { label: "query-perf-diagnostics", timeoutMs: 5000 },
      );
    },
    { closeMode: "force" },
  ).then(
    () => ({ status: "done" }) as const,
    (error: unknown) => ({ status: "failed", error }) as const,
  );
  if (result.status === "failed") {
    process.stdout.write(
      `${JSON.stringify({
        event: "query_perf_diagnostics_failed",
        profileId,
        error: String(result.error),
      })}\n`,
    );
  }
};

class QueryPerfFixtureError extends TaggedError("QueryPerfFixtureError")<{
  message: string;
  cause: unknown;
  cleanupError: unknown;
}> {}

const queryPerfAdminUrl = (databaseUrl: string) => {
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";
  return adminUrl;
};

type DropQueryPerfDatabaseOptions = {
  adminUrl: URL;
  fixtureName: string;
  profileId: QueryPerfProfileId;
};

/** Cleanup uses a fresh connection after an overdue admin statement is cancelled. */
const dropQueryPerfDatabase = async ({
  adminUrl,
  fixtureName,
  profileId,
}: DropQueryPerfDatabaseOptions) => {
  await withGatedTestClients(
    adminUrl.toString(),
    async (cleanup) => {
      const { db } = cleanup.openClient({
        connection: QUERY_PERF_CONNECTION_SETTINGS,
      });
      process.stdout.write(
        `${JSON.stringify({
          event: "query_perf_phase",
          profileId,
          phase: "DROP DATABASE teardown",
          status: "start",
        })}\n`,
      );
      try {
        await withTimeout(
          async () =>
            await db.execute(
              sql`DROP DATABASE IF EXISTS ${sql.identifier(fixtureName)}`,
            ),
          {
            label: "query-perf-database-teardown",
            timeoutMs: 35_000,
          },
        );
        process.stdout.write(
          `${JSON.stringify({
            event: "query_perf_phase",
            profileId,
            phase: "DROP DATABASE teardown",
            status: "done",
          })}\n`,
        );
      } catch (error) {
        await dumpQueryPerfDiagnostics({
          adminUrl: adminUrl.toString(),
          fixtureName,
          profileId,
        });
        throw error;
      }
    },
    { closeMode: "force" },
  );
};

/** Drops a fixture kept with `retainAs`; a missing one is already gone. */
export const dropRetainedQueryPerfFixture = async ({
  databaseUrl,
  name,
  profileId,
}: {
  databaseUrl: string;
  name: string;
  profileId: QueryPerfProfileId;
}) => {
  await dropQueryPerfDatabase({
    adminUrl: queryPerfAdminUrl(databaseUrl),
    fixtureName: name,
    profileId,
  });
};

/** Each profile owns a fresh migrated database, keeping ANALYZE statistics independent. */
export const withQueryPerfFixture = async <T>({
  databaseUrl,
  profileId,
  timeoutMs,
  deadline = createQueryPerfDeadline({ profileId, timeoutMs }),
  template: seededTemplate,
  retainAs,
  run,
}: QueryPerfFixtureOptions<T>) => {
  const source = new URL(databaseUrl);
  const migratedTemplate = decodeURIComponent(source.pathname.slice(1));
  if (migratedTemplate.length === 0) {
    return panic("Query perf requires a named migrated template database");
  }
  const fixtureName = retainAs ?? queryPerfDatabaseName(profileId);
  const adminUrl = queryPerfAdminUrl(databaseUrl);
  const diagnostics = async () =>
    await dumpQueryPerfDiagnostics({
      adminUrl: adminUrl.toString(),
      fixtureName,
      profileId,
    });
  return await withGatedTestClients(
    adminUrl.toString(),
    async ({ openClient }) => {
      const { db: admin, sql: adminClient } = openClient({
        connection: QUERY_PERF_CONNECTION_SETTINGS,
      });
      const outcome = await (async () => {
        try {
          // An interrupted run can leave the fixed-name clone behind. Live sessions
          // must close themselves before another invocation can reuse its name.
          await deadline.run(
            "DROP DATABASE stale fixture",
            async () =>
              await admin.execute(
                sql`DROP DATABASE IF EXISTS ${sql.identifier(fixtureName)}`,
              ),
          );
          await deadline.run(
            "CREATE DATABASE from template",
            async () =>
              await admin.execute(
                seededTemplate === undefined
                  ? sql`CREATE DATABASE ${sql.identifier(fixtureName)} TEMPLATE ${sql.identifier(migratedTemplate)}`
                  : // A seeded template is large: copying its files beats
                    // writing every page of it to the WAL.
                    sql`CREATE DATABASE ${sql.identifier(fixtureName)} TEMPLATE ${sql.identifier(seededTemplate)} STRATEGY = FILE_COPY`,
              ),
          );
        } catch (error) {
          await diagnostics();
          throw error;
        }
        const fixtureUrl = new URL(source);
        fixtureUrl.pathname = `/${fixtureName}`;
        return await withGatedTestClients(
          fixtureUrl.toString(),
          async (fixture) => {
            const { db, sql: client } = fixture.openClient({
              connection: QUERY_PERF_CONNECTION_SETTINGS,
            });
            try {
              return await deadline.run(
                "profile",
                async () => await run(db, deadline, fixture.openClient),
              );
            } catch (error) {
              await diagnostics();
              throw error;
            } finally {
              // Do not wait for a stalled driver promise after the deadline rejects.
              await forceClosePool(client);
            }
          },
          { closeMode: "force" },
        );
      })().then(
        (value) => ({ status: "fulfilled", value }) as const,
        (error: unknown) => ({ status: "rejected", error }) as const,
      );
      const cleanupOutcome = await (async () => {
        await forceClosePool(adminClient);
        if (retainAs !== undefined && outcome.status === "fulfilled") {
          return;
        }
        await dropQueryPerfDatabase({ adminUrl, fixtureName, profileId });
      })().then(
        () => ({ status: "fulfilled" }) as const,
        (error: unknown) => ({ status: "rejected", error }) as const,
      );
      if (outcome.status === "rejected") {
        if (cleanupOutcome.status === "rejected") {
          throw new QueryPerfFixtureError({
            message: `query perf ${profileId}: profile failed (${String(outcome.error)}) and teardown failed (${String(cleanupOutcome.error)})`,
            cause: outcome.error,
            cleanupError: cleanupOutcome.error,
          });
        }
        throw outcome.error;
      }
      if (cleanupOutcome.status === "rejected") {
        throw cleanupOutcome.error;
      }
      return outcome.value;
    },
    { closeMode: "force" },
  );
};
