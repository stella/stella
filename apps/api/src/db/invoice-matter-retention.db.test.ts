import { PGlite } from "@electric-sql/pglite";
import { Result } from "better-result";
import { expect, test } from "bun:test";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { organization } from "@/api/db/auth-schema";
import { invoiceLines, invoices, workspaces } from "@/api/db/schema";
import * as schema from "@/api/db/schema";
import { getPgErrorCode, PG_ERROR } from "@/api/lib/pg-error";

import { CLIENT_INVOICE_CONSTRAINTS } from "./client-invoice-backfill";
import {
  createUngatedTableGateForTests,
  validateOnlineConstraints,
} from "./online-ddl";
import type { OnlineMigrationConnection } from "./online-migration-connection";

const invoiceTables = Object.values(schema).flatMap((value) =>
  is(value, PgTable) &&
  /^invoices?$|^invoice_/u.test(getTableConfig(value).name)
    ? [value]
    : [],
);

// Derive the deletion graph from the shipped schema; copied foreign keys
// would keep passing if a future schema change reintroduced a cascade.
const invoiceForeignKeys = () =>
  [workspaces, invoices, invoiceLines].flatMap((table) =>
    getTableConfig(table).foreignKeys.flatMap((key) => {
      const reference = key.reference();
      if (
        reference.foreignTable !== organization &&
        reference.foreignTable !== workspaces &&
        (table !== invoiceLines || reference.foreignTable !== invoices)
      ) {
        return [];
      }
      return [
        {
          table: getTableConfig(table).name,
          name: key.getName(),
          columns: reference.columns.map((column) => column.name).join(", "),
          parent: getTableConfig(reference.foreignTable).name,
          parentColumns: reference.foreignColumns
            .map((column) => column.name)
            .join(", "),
          onDelete: key.onDelete ?? "no action",
        },
      ];
    }),
  );

const seedDatabase = async (database: PGlite, legacyCascades = false) => {
  await database.exec(`
    CREATE TABLE organization (id text PRIMARY KEY);
    CREATE TABLE workspaces (id text PRIMARY KEY, organization_id text NOT NULL,
      name text NOT NULL, UNIQUE (id, organization_id));
    CREATE TABLE invoices (id text PRIMARY KEY, organization_id text NOT NULL,
      workspace_id text, total_amount integer NOT NULL, status text NOT NULL,
      UNIQUE (id, workspace_id));
    CREATE TABLE invoice_lines (id text PRIMARY KEY, organization_id text NOT NULL,
      workspace_id text NOT NULL, invoice_id text NOT NULL, description text NOT NULL,
      net_amount integer NOT NULL, vat_amount integer NOT NULL, gross_amount integer NOT NULL);
  `);
  for (const key of invoiceForeignKeys()) {
    const action =
      legacyCascades && key.parent === "workspaces" ? "cascade" : key.onDelete;
    await database.exec(`ALTER TABLE ${key.table} ADD CONSTRAINT ${key.name}
      FOREIGN KEY (${key.columns}) REFERENCES ${key.parent} (${key.parentColumns}) ON DELETE ${action}`);
  }
  await database.exec(`
    INSERT INTO organization VALUES ('org');
    INSERT INTO workspaces VALUES ('first', 'org', 'First matter'), ('second', 'org', 'Second matter');
    INSERT INTO invoices VALUES ('client-invoice', 'org', NULL, 363, 'draft');
    INSERT INTO invoice_lines VALUES
      ('first-line', 'org', 'first', 'client-invoice', 'First matter services', 100, 21, 121),
      ('second-line', 'org', 'second', 'client-invoice', 'Second matter services', 200, 42, 242);
  `);
};

const readInvoiceState = async (database: PGlite) => ({
  invoices: (await database.query("SELECT * FROM invoices ORDER BY id")).rows,
  lines: (await database.query("SELECT * FROM invoice_lines ORDER BY id")).rows,
});

test("no invoicing foreign key cascades matter deletion", () => {
  expect(invoiceTables.length).toBeGreaterThan(0);
  const cascading = invoiceTables.flatMap((table) =>
    getTableConfig(table)
      .foreignKeys.filter(
        (key) =>
          key.reference().foreignTable === workspaces &&
          key.onDelete === "cascade",
      )
      .map((key) => key.getName()),
  );
  expect(cascading).toEqual([]);
});

const expectDeletionRefused = async (database: PGlite) => {
  const before = await readInvoiceState(database);
  const deletion = await Result.tryPromise(
    async () =>
      await database.exec("DELETE FROM workspaces WHERE id = 'first'"),
  );
  expect(await readInvoiceState(database)).toEqual(before);
  expect(deletion.isErr()).toBe(true);
  if (deletion.isErr()) {
    expect(getPgErrorCode(deletion.error)).toBe(PG_ERROR.FOREIGN_KEY_VIOLATION);
  }
  expect(
    (await database.query("SELECT id FROM workspaces WHERE id = 'first'")).rows,
  ).toEqual([{ id: "first" }]);
  return before;
};

const retainedInvoiceCases = [
  { scope: "client", status: "draft" },
  { scope: "client", status: "finalized" },
  { scope: "matter", status: "draft" },
  { scope: "matter", status: "finalized" },
];

test.each(retainedInvoiceCases)(
  "refusing deletion preserves persisted $scope invoice lines and totals in $status after reload",
  async ({ scope, status }) => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "invoice-matter-retention-"),
    );
    try {
      const before = await (async () => {
        await using database = new PGlite(directory);
        await seedDatabase(database);
        await database.query("UPDATE invoices SET status = $1", [status]);
        if (scope === "matter") {
          await database.exec(
            "UPDATE invoices SET workspace_id = 'first'; UPDATE invoice_lines SET workspace_id = 'first'",
          );
        }
        return await expectDeletionRefused(database);
      })();
      await using reloaded = new PGlite(directory);
      expect(await readInvoiceState(reloaded)).toEqual(before);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);

const retentionMigration = async (name: string) =>
  await Bun.file(
    new URL(`../../drizzle/${name}/migration.sql`, import.meta.url),
  ).text();

test("the retention migration changes only foreign keys and keeps existing invoice rows and totals", async () => {
  await using database = new PGlite();
  await seedDatabase(database, true);
  const before = await readInvoiceState(database);
  for (const name of [
    "20261021165000_invoice_matter_retention",
    "20261021165001_invoice_matter_retention_validate",
  ]) {
    // These additive/catalog migrations release their locks before online validation.
    await database.exec(`BEGIN; ${await retentionMigration(name)} COMMIT;`);
    expect(await readInvoiceState(database)).toEqual(before);
  }
  const connection = {
    execute: async (query, params = []) => {
      await database.query(query, [...params]);
    },
    query: async (query, params = []) =>
      (await database.query(query, [...params])).rows,
    release: () => {},
  } satisfies OnlineMigrationConnection;
  const retainedNames = new Set(
    invoiceForeignKeys()
      .filter((key) => key.parent === "workspaces")
      .map((key) => key.name),
  );
  const validations = CLIENT_INVOICE_CONSTRAINTS.filter(({ constraintName }) =>
    retainedNames.has(constraintName),
  );
  expect([...retainedNames].toSorted()).toEqual(
    validations.map(({ constraintName }) => constraintName).toSorted(),
  );
  expect(
    (
      await database.query<{ validated: boolean }>(
        "SELECT convalidated AS validated FROM pg_constraint WHERE contype='f' AND confrelid='workspaces'::regclass",
      )
    ).rows.every(({ validated }) => !validated),
  ).toBe(true);
  expect(
    await validateOnlineConstraints({
      connection,
      tables: createUngatedTableGateForTests(connection),
      constraints: validations,
    }),
  ).toEqual({ type: "complete" });
  await expectDeletionRefused(database);
  const constraints = await database.query<{
    name: string;
    action: string;
    validated: boolean;
  }>(`
    SELECT conname AS name, confdeltype AS action, convalidated AS validated
    FROM pg_constraint WHERE contype = 'f' AND confrelid = 'workspaces'::regclass
    ORDER BY conname
  `);
  expect(constraints.rows).toEqual(
    invoiceForeignKeys()
      .filter((key) => key.parent === "workspaces")
      .map((key) => key.name)
      .toSorted()
      .map((name) => ({ name, action: "a", validated: true })),
  );
}, 30_000);

test("explicit organization deletion still removes its whole billing history", async () => {
  await using database = new PGlite();
  await seedDatabase(database);
  await database.exec("DELETE FROM organization WHERE id = 'org'");
  expect(await readInvoiceState(database)).toEqual({ invoices: [], lines: [] });
  expect((await database.query("SELECT id FROM workspaces")).rows).toEqual([]);
}, 30_000);
