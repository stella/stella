import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { readFileSync } from "node:fs";

import { compareCodeUnit } from "@stll/collation";

import { organization } from "@/api/db/auth-schema";
import { contacts } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { createTestPglite } from "@/api/tests/pglite-test-db";

import { IMPORT_PROVENANCE_TABLES } from "./import-provenance-columns";
import {
  ONLINE_CONSTRAINT_VALIDATIONS,
  ONLINE_MIGRATION_INDEXES,
} from "./online-migrations";

/**
 * Migration `20261014130000_import_provenance`: `external_source`,
 * `external_id` and `imported_at` on every importable table, one row per
 * external identity within an organization, and a ref that is whole and
 * stamped. The test database is built from the Drizzle schema; the parity
 * tests hold the migration's statements and the online index registry equal
 * to it.
 */

const MIGRATION_SQL = readFileSync(
  new URL(
    "../../drizzle/20261014130000_import_provenance/migration.sql",
    import.meta.url,
  ),
  "utf-8",
);

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const rejection = async (write: Promise<unknown>): Promise<string> =>
  await write.then(
    () => panic("expected the database to refuse the write"),
    (error: unknown) => {
      const cause: unknown =
        error instanceof Error && error.cause !== undefined
          ? error.cause
          : error;
      return cause instanceof Error ? cause.message : String(cause);
    },
  );

const migrationStatements = (pattern: RegExp): string[] =>
  MIGRATION_SQL.split("--> statement-breakpoint")
    .map((statement) =>
      statement
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter((statement) => pattern.test(statement));

const createOrganization = async () => {
  const id = mintAuthProviderId<"organization">();
  await db.insert(organization).values({
    id,
    name: "Import provenance",
    slug: id,
    createdAt: new Date(),
  });
  return id;
};

const contact = (
  organizationId: SafeId<"organization">,
  external: { source: string; id: string } | null,
) =>
  db.insert(contacts).values({
    organizationId,
    type: "person",
    displayName: "Imported person",
    ...(external === null
      ? {}
      : {
          externalSource: external.source,
          externalId: external.id,
          importedAt: new Date(),
        }),
  });

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
});

afterAll(async () => {
  await client.close();
});

describe("import provenance schema", () => {
  test.each(IMPORT_PROVENANCE_TABLES)(
    "%s carries the columns, unique index and registered online index",
    async (table) => {
      const columns = await db.execute<{ name: string; type: string }>(sql`
        SELECT column_name AS name, data_type AS type
        FROM information_schema.columns
        WHERE table_name = ${table}
          AND column_name IN ('external_source', 'external_id', 'imported_at')
        ORDER BY column_name
      `);
      expect(columns.rows).toEqual([
        { name: "external_id", type: "character varying" },
        { name: "external_source", type: "character varying" },
        { name: "imported_at", type: "timestamp with time zone" },
      ]);

      const indexName = `${table}_org_external_uidx`;
      const definition = (
        await db.execute<{ definition: string }>(sql`
          SELECT indexdef AS definition FROM pg_indexes
          WHERE schemaname = 'public' AND indexname = ${indexName}
        `)
      ).rows.at(0)?.definition;
      const registered =
        ONLINE_MIGRATION_INDEXES.find(({ name }) => name === indexName) ??
        panic(`${indexName} is not registered for online validation`);
      expect(registered).toMatchObject({ isUnique: true, tableName: table });
      expect(definition).toBe(
        `CREATE UNIQUE INDEX ${indexName} ${registered.definitionBody}`,
      );
    },
  );

  test("pre-deploy adds CHECKs and leaves scans to the online registry", async () => {
    const indexStatements = migrationStatements(
      /^CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "\w+_org_external_uidx"/u,
    );
    expect(indexStatements).toHaveLength(0);

    const checkNames = IMPORT_PROVENANCE_TABLES.map(
      (table) => `${table}_external_ref_check`,
    );
    expect(
      ONLINE_CONSTRAINT_VALIDATIONS.filter(({ constraintName }) =>
        checkNames.some((name) => name === constraintName),
      ).map(({ constraintName }) => constraintName),
    ).toEqual(checkNames);
    const checkDefinitions = async () =>
      Object.fromEntries(
        (
          await db.execute<{ name: string; definition: string }>(sql`
            SELECT conname AS name, pg_get_constraintdef(oid) AS definition
            FROM pg_constraint
            WHERE conname IN (${sql.join(
              checkNames.map((name) => sql`${name}`),
              sql`, `,
            )})
          `)
        ).rows.map(({ name, definition }) => [name, definition]),
      );
    const fromSchema = await checkDefinitions();
    expect(Object.keys(fromSchema).toSorted(compareCodeUnit)).toEqual(
      checkNames.toSorted(compareCodeUnit),
    );

    const checkStatements = migrationStatements(
      /^ALTER TABLE "\w+" ADD CONSTRAINT "\w+_external_ref_check"/u,
    );
    expect(checkStatements).toHaveLength(IMPORT_PROVENANCE_TABLES.length);
    for (const table of IMPORT_PROVENANCE_TABLES) {
      await db.execute(
        sql.raw(
          `ALTER TABLE "${table}" DROP CONSTRAINT "${table}_external_ref_check"`,
        ),
      );
    }
    for (const statement of checkStatements) {
      await db.execute(sql.raw(statement));
    }
    for (const table of IMPORT_PROVENANCE_TABLES) {
      await db.execute(
        sql.raw(
          `ALTER TABLE "${table}" VALIDATE CONSTRAINT "${table}_external_ref_check"`,
        ),
      );
    }
    expect(await checkDefinitions()).toEqual(fromSchema);
  });

  test("one row per external identity within an organization", async () => {
    const first = await createOrganization();
    const second = await createOrganization();
    const ref = { source: "address-book", id: "42" };

    await contact(first, ref);
    expect(await rejection(contact(first, ref))).toContain(
      "contacts_org_external_uidx",
    );
    // The same ref in another organization, another source, or another id
    // is a different identity.
    await contact(second, ref);
    await contact(first, { source: "spreadsheet", id: "42" });
    await contact(first, { source: "address-book", id: "43" });
    // Rows created in stella carry no ref and never collide.
    await contact(first, null);
    await contact(first, null);
  });

  test("a ref is whole and stamped with its import time", async () => {
    const organizationId = await createOrganization();
    const refused = [
      { externalSource: "address-book", importedAt: new Date() },
      { externalId: "7", importedAt: new Date() },
      { externalSource: "address-book", externalId: "7" },
    ];
    for (const provenance of refused) {
      expect(
        await rejection(
          db.insert(contacts).values({
            organizationId,
            type: "person",
            displayName: "Half a ref",
            ...provenance,
          }),
        ),
      ).toContain("contacts_external_ref_check");
    }
  });
});
