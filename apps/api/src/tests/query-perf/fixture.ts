import { panic } from "better-result";
import { sql } from "drizzle-orm";

import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";

import { queryPerfDatabaseName, type QueryPerfProfileId } from "./profiles";

type QueryPerfFixtureOptions<T> = {
  databaseUrl: string;
  profileId: QueryPerfProfileId;
  run: (database: GatedTestDb) => Promise<T>;
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
          async (fixture) => await run(fixture.openClient().db),
        );
      } finally {
        await admin.execute(
          sql`DROP DATABASE ${sql.identifier(fixtureName)} WITH (FORCE)`,
        );
      }
    },
  );
};
