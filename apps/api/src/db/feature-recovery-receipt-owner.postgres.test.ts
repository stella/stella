import { describe, expect, test } from "bun:test";
import { getTableName } from "drizzle-orm";

import { withGatedTestClients } from "../tests/gated-test-database";
import { pendingScoutEmissions, flowUploadTriggerIntents } from "./schema";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

// Exercise the same owner predicate on every retained recovery receipt.
const tables = [pendingScoutEmissions, flowUploadTriggerIntents];

describe.skipIf(!enabled)("feature recovery receipt row security", () => {
  test("non-superuser owners repair receipts while tenantless request roles remain denied", async () => {
    if (databaseUrl === undefined) {
      throw new TypeError("DATABASE_URL required");
    }
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const client = openClient().sql;
      const suffix = Bun.randomUUIDv7().replaceAll("-", "");
      const schema = `recovery_receipts_${suffix}`;
      const owner = `recovery_owner_${suffix}`;
      const migration = await Bun.file(
        new URL(
          "../../drizzle/20261012030000_feature_recovery_receipt_owner_access/migration.sql",
          import.meta.url,
        ),
      ).text();
      await client.unsafe("BEGIN");
      try {
        await client.unsafe(`CREATE SCHEMA ${schema}`);
        await client.unsafe(
          `CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOBYPASSRLS`,
        );
        await client.unsafe(
          `GRANT ${owner} TO CURRENT_USER WITH INHERIT TRUE, SET TRUE`,
        );
        await client.unsafe(
          `GRANT USAGE, CREATE ON SCHEMA ${schema} TO ${owner}; GRANT USAGE ON SCHEMA ${schema} TO stella`,
        );
        await client.unsafe(`SET LOCAL search_path TO ${schema}, public`);
        for (const table of tables) {
          const name = getTableName(table);
          // Only the columns irrelevant to the role boundary are omitted.
          await client.unsafe(
            `CREATE TABLE ${schema}.${name} (id integer PRIMARY KEY, status text NOT NULL); ALTER TABLE ${schema}.${name} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${schema}.${name} FORCE ROW LEVEL SECURITY; ALTER TABLE ${schema}.${name} OWNER TO ${owner}; GRANT SELECT, INSERT, UPDATE, DELETE ON ${schema}.${name} TO stella`,
          );
        }
        const rewrittenMigration = migration.replaceAll(
          "public.",
          () => `${schema}.`,
        );
        for (const statement of rewrittenMigration.split(
          "--> statement-breakpoint",
        )) {
          if (statement.trim().length > 0) {
            await client.unsafe(statement);
          }
        }
        for (const table of tables) {
          const name = getTableName(table);
          await client.unsafe(`SET LOCAL ROLE ${owner}`);
          await client.unsafe(
            `INSERT INTO ${schema}.${name} (id, status) VALUES (1, 'pending')`,
          );
          expect(
            await client.unsafe(`SELECT status FROM ${schema}.${name}`),
          ).toEqual([{ status: "pending" }]);
          expect(
            await client.unsafe(
              `UPDATE ${schema}.${name} SET status = 'awaiting_grant' RETURNING status`,
            ),
          ).toEqual([{ status: "awaiting_grant" }]);
          await client.unsafe("SET LOCAL ROLE stella");
          expect(
            await client.unsafe(`SELECT * FROM ${schema}.${name}`),
          ).toHaveLength(0);
          expect(
            await client.unsafe(
              `UPDATE ${schema}.${name} SET status = 'pending' RETURNING id`,
            ),
          ).toHaveLength(0);
          expect(
            await client.unsafe(`DELETE FROM ${schema}.${name} RETURNING id`),
          ).toHaveLength(0);
          await client.unsafe("SAVEPOINT denied_insert");
          const rejection: unknown = await client
            .unsafe(
              `INSERT INTO ${schema}.${name} (id, status) VALUES (2, 'pending')`,
            )
            .then(
              () => null,
              (error: unknown) => error,
            );
          expect(rejection).toBeInstanceOf(Error);
          expect(
            rejection instanceof Error ? rejection.message : String(rejection),
          ).toMatch(/row-level security/u);
          await client.unsafe("ROLLBACK TO SAVEPOINT denied_insert");
          await client.unsafe(`SET LOCAL ROLE ${owner}`);
          expect(
            await client.unsafe(`DELETE FROM ${schema}.${name} RETURNING id`),
          ).toEqual([{ id: 1 }]);
        }
      } finally {
        await client.unsafe("ROLLBACK");
      }
    });
  });
});
