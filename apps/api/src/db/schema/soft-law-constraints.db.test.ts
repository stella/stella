import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";

import { withGatedTestClients } from "@/api/tests/gated-test-database";

import * as softLawSchema from "./soft-law";

const configurations = Object.values(softLawSchema).map((table) =>
  getTableConfig(table),
);

test("soft-law foreign keys have explicit names", () => {
  for (const configuration of configurations) {
    expect(configuration.foreignKeys.every((key) => key.isNameExplicit())).toBe(
      true,
    );
  }
});

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !enabled) {
  describe.skip("soft-law migrated constraint parity", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS and DATABASE_URL", () => {
      expect(Boolean(databaseUrl) && enabled).toBe(false);
    });
  });
} else {
  test("migrated soft-law CHECK and foreign key names match the live schema", async () =>
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient();
      const expected = configurations.flatMap((configuration) => [
        ...configuration.checks.map((check) => ({
          relation: configuration.name,
          name: check.name,
          type: "c",
        })),
        ...configuration.foreignKeys.map((key) => ({
          relation: configuration.name,
          name: key.getName(),
          type: "f",
        })),
      ]);
      const actual = await db.execute<{
        relation: string;
        name: string;
        type: string;
      }>(sql`
        SELECT relation.relname AS relation,
          constraint_record.conname AS name,
          constraint_record.contype::text AS type
        FROM pg_catalog.pg_constraint constraint_record
        JOIN pg_catalog.pg_class relation
          ON relation.oid = constraint_record.conrelid
        JOIN pg_catalog.pg_namespace namespace
          ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relname IN (${sql.join(
            configurations.map(({ name }) => sql`${name}`),
            sql`, `,
          )})
          AND constraint_record.contype IN ('c', 'f')
      `);
      const constraintKeys = (
        constraints: readonly {
          relation: string;
          name: string;
          type: string;
        }[],
      ) =>
        constraints
          .map(({ relation, name, type }) => `${relation}/${type}/${name}`)
          .toSorted();
      expect(constraintKeys(actual)).toEqual(constraintKeys(expected));
    }));
}
