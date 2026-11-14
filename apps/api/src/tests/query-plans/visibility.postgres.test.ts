import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { rejectionOf } from "@stll/property-testing/rejection";

import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { vacuumUntilAllVisible } from "@/api/tests/query-plans/visibility";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled)("vacuumUntilAllVisible (postgres)", () => {
  // timeout: a held snapshot, a 1 s refusal and the retry after its release.
  test("an open snapshot defers all-visible pages until it ends", async () => {
    const databaseUrl =
      process.env["DATABASE_URL"] ?? panic("DATABASE_URL is required");
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient({ max: 1 });
      const holder = openClient({ max: 1 });
      const schemaName = `visibility_${Bun.randomUUIDv7().replaceAll("-", "")}`;
      const schema = sql.identifier(schemaName);
      await db.execute(sql`CREATE SCHEMA ${schema}`);
      try {
        await db.execute(
          sql`CREATE TABLE ${schema}.visibility_rows (n int PRIMARY KEY)`,
        );
        await db.execute(sql`SET search_path TO ${schema}, public`);
        const held = Promise.withResolvers<undefined>();
        const release = Promise.withResolvers<undefined>();
        const holding = holder.sql.begin(
          "isolation level repeatable read",
          async (tx) => {
            await tx`SELECT 1`;
            held.resolve(undefined);
            await release.promise;
          },
        );
        try {
          await held.promise;
          await db.execute(
            sql`INSERT INTO visibility_rows SELECT generate_series(1, 10000)`,
          );
          const refusal = await rejectionOf(
            vacuumUntilAllVisible({
              db,
              table: "visibility_rows",
              timeoutMs: 1000, // timeout under test
            }),
          );
          expect(refusal).toBeInstanceOf(Error);
          expect(refusal instanceof Error ? refusal.message : "").toMatch(
            /^Visibility precondition: visibility_rows has 0 of [1-9]\d* pages all-visible/u,
          );
        } finally {
          release.resolve(undefined);
          await holding;
        }
        await vacuumUntilAllVisible({ db, table: "visibility_rows" });
      } finally {
        await db.execute(sql`SET search_path TO public`);
        await db.execute(sql`DROP SCHEMA ${schema} CASCADE`);
      }
    });
  }, 60_000);
});
