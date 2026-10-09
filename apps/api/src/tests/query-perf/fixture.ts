import { panic } from "better-result";
import { sql } from "drizzle-orm";
import path from "node:path";

import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";

import {
  restoreQueryPerfSnapshot,
  saveQueryPerfSnapshot,
} from "../../../scripts/query-perf-snapshot";
import { queryPerfDatabaseName, type QueryPerfProfileId } from "./profiles";
import { seedQueryPerf } from "./seed";
import { runSnapshotFixture } from "./snapshot-fixture";

type QueryPerfFixtureOptions<T> = {
  databaseUrl: string;
  profileId: QueryPerfProfileId;
  run: (
    database: GatedTestDb,
    seed: Awaited<ReturnType<typeof seedQueryPerf>>,
  ) => Promise<T>;
};

/** Each profile owns a fresh migrated database, keeping ANALYZE statistics independent. */
export const withQueryPerfFixture = async <T>({
  databaseUrl,
  profileId,
  run,
}: QueryPerfFixtureOptions<T>) => {
  const source = new URL(databaseUrl);
  const template = decodeURIComponent(source.pathname.slice(1));
  if (template.length === 0) {
    return panic("Query perf requires a named migrated template database");
  }
  const fixtureName = queryPerfDatabaseName(profileId);
  const adminUrl = new URL(source);
  adminUrl.pathname = "/postgres";
  return await withGatedTestClients(
    adminUrl.toString(),
    async ({ openClient }) => {
      const { db: admin } = openClient();
      await admin.execute(
        sql`CREATE DATABASE ${sql.identifier(fixtureName)} TEMPLATE ${sql.identifier(template)}`,
      );
      const fixtureUrl = new URL(source);
      fixtureUrl.pathname = `/${fixtureName}`;
      try {
        return await withGatedTestClients(
          fixtureUrl.toString(),
          async (fixture) => {
            const database = fixture.openClient().db;
            const cacheRoot = process.env["QUERY_PERF_SNAPSHOT_DIRECTORY"];
            const archive =
              cacheRoot === undefined
                ? undefined
                : path.join(cacheRoot, profileId, "fixture.dump");
            const snapshotOptions = () => {
              if (archive === undefined) {
                return panic("Snapshot operation requires an archive path");
              }
              return {
                databaseUrl: fixtureUrl.toString(),
                archive,
                profileId,
                pgMajor: 18,
              };
            };
            return await runSnapshotFixture({
              profileId,
              archive,
              source:
                process.env[
                  `QUERY_PERF_CACHE_${profileId.toUpperCase()}_HIT`
                ] === "true"
                  ? "snapshot"
                  : "fresh",
              downloadMilliseconds: Number(
                process.env[
                  `QUERY_PERF_DOWNLOAD_${profileId.toUpperCase()}_MS`
                ] ?? "0",
              ),
              seed: async () =>
                await seedQueryPerf({ database, profileId, source: "fresh" }),
              restore: async () =>
                await restoreQueryPerfSnapshot(snapshotOptions()),
              read: async () =>
                await seedQueryPerf({
                  database,
                  profileId,
                  source: "snapshot",
                }),
              save: async () => await saveQueryPerfSnapshot(snapshotOptions()),
              run: async (seed) => await run(database, seed),
              report: (event) => {
                process.stdout.write(`${JSON.stringify(event)}\n`);
              },
            });
          },
        );
      } finally {
        await admin.execute(
          sql`DROP DATABASE ${sql.identifier(fixtureName)} WITH (FORCE)`,
        );
      }
    },
  );
};
