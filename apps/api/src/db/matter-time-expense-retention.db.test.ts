import { PGlite } from "@electric-sql/pglite";
import { panic, Result } from "better-result";
import { expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import type { PgTable } from "drizzle-orm/pg-core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { organization } from "@/api/db/auth-schema";
import { expenses, timeEntries, workspaces } from "@/api/db/schema";
import { WORKSPACE_DELETION_RETAINED_TABLES } from "@/api/lib/organization-storage-teardown";
import { getPgErrorCode, PG_ERROR } from "@/api/lib/pg-error";

import { MATTER_TIME_EXPENSE_RETENTION_CONSTRAINTS } from "./matter-time-expense-retention-validation";
import {
  createUngatedTableGateForTests,
  validateOnlineConstraints,
} from "./online-ddl";
import type { OnlineMigrationConnection } from "./online-migration-connection";

const retainedTables: readonly PgTable[] = WORKSPACE_DELETION_RETAINED_TABLES;

// The billing columns these tests read; foreign keys come from the schema.
const TEST_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  invoices: [
    "id text PRIMARY KEY",
    "organization_id text NOT NULL",
    "workspace_id text",
    "total_amount integer NOT NULL",
  ],
  invoice_lines: [
    "id text PRIMARY KEY",
    "organization_id text NOT NULL",
    "workspace_id text NOT NULL",
    "invoice_id text NOT NULL",
    "time_entry_id text",
    "expense_id text",
    "net_amount integer NOT NULL",
  ],
  time_entries: [
    "id text PRIMARY KEY",
    "organization_id text NOT NULL",
    "workspace_id text",
    "invoice_id text",
    "status text NOT NULL",
    "billed_minutes integer NOT NULL",
    "rate_at_entry integer NOT NULL",
    "narrative text NOT NULL",
  ],
  expenses: [
    "id text PRIMARY KEY",
    "organization_id text NOT NULL",
    "workspace_id text NOT NULL",
    "invoice_id text",
    "status text NOT NULL",
    "amount integer NOT NULL",
    "description text NOT NULL",
  ],
};

const testColumns = (table: PgTable): readonly string[] => {
  const columns = TEST_COLUMNS[getTableConfig(table).name];
  if (columns === undefined) {
    return panic(`No test table for ${getTableConfig(table).name}`);
  }
  return columns;
};

const carries = (table: PgTable, column: string) =>
  table === workspaces ||
  testColumns(table).some((definition) => definition.startsWith(`${column} `));

// Derive the deletion graph from the shipped schema; copied foreign keys
// would keep passing if a future schema change reintroduced a cascade.
const billingForeignKeys = (tables: readonly PgTable[]) => {
  const seeded = new Set<PgTable>([organization, workspaces, ...tables]);
  return [workspaces, ...tables].flatMap((table) =>
    getTableConfig(table).foreignKeys.flatMap((key) => {
      const reference = key.reference();
      const columns = reference.columns.map((column) => column.name);
      // Self references and columns these minimal tables do not carry are
      // outside the matter deletion graph under test.
      if (
        reference.foreignTable === table ||
        !seeded.has(reference.foreignTable) ||
        !columns.every((column) => carries(table, column))
      ) {
        return [];
      }
      return [
        {
          table: getTableConfig(table).name,
          name: key.getName(),
          columns: columns.join(", "),
          parent: getTableConfig(reference.foreignTable).name,
          parentColumns: reference.foreignColumns
            .map((column) => column.name)
            .join(", "),
          onDelete: key.onDelete ?? "no action",
        },
      ];
    }),
  );
};

const seedDatabase = async (
  database: PGlite,
  tables: readonly PgTable[],
  legacyCascades = false,
) => {
  await database.exec(`
    CREATE TABLE organization (id text PRIMARY KEY);
    CREATE TABLE workspaces (id text PRIMARY KEY, organization_id text NOT NULL,
      name text NOT NULL, UNIQUE (id, organization_id));
  `);
  for (const table of tables) {
    await database.exec(
      `CREATE TABLE ${getTableConfig(table).name} (${testColumns(table).join(", ")})`,
    );
  }
  for (const key of billingForeignKeys(tables)) {
    const action =
      legacyCascades && key.parent === "workspaces" ? "cascade" : key.onDelete;
    await database.exec(`ALTER TABLE ${key.table} ADD CONSTRAINT ${key.name}
      FOREIGN KEY (${key.columns}) REFERENCES ${key.parent} (${key.parentColumns}) ON DELETE ${action}`);
  }
  await database.exec(`
    INSERT INTO organization VALUES ('org');
    INSERT INTO workspaces VALUES ('first', 'org', 'First matter'), ('second', 'org', 'Second matter');
    INSERT INTO time_entries VALUES
      ('draft-entry', 'org', 'first', NULL, 'draft', 30, 1500, 'Draft work'),
      ('approved-entry', 'org', 'first', NULL, 'approved', 90, 2000, 'Approved work'),
      ('other-entry', 'org', 'second', NULL, 'draft', 15, 1500, 'Other matter work');
    INSERT INTO expenses VALUES
      ('filing-fee', 'org', 'first', NULL, 'draft', 2500, 'Filing fee'),
      ('other-expense', 'org', 'second', NULL, 'approved', 700, 'Courier');
  `);
};

const readWorkState = async (database: PGlite) => ({
  timeEntries: (await database.query("SELECT * FROM time_entries ORDER BY id"))
    .rows,
  expenses: (await database.query("SELECT * FROM expenses ORDER BY id")).rows,
  totals: (
    await database.query(`SELECT
      (SELECT sum(billed_minutes * rate_at_entry) FROM time_entries)::int AS time_value,
      (SELECT sum(amount) FROM expenses)::int AS expense_value`)
  ).rows,
});

const workTables = [timeEntries, expenses] as const;

test("time entries and expenses are retained matter billing records", () => {
  expect(retainedTables).toContain(timeEntries);
  expect(retainedTables).toContain(expenses);
  const cascading = workTables.flatMap((table) =>
    getTableConfig(table)
      .foreignKeys.filter(
        (key) =>
          key.reference().foreignTable === workspaces &&
          key.onDelete !== "no action",
      )
      .map((key) => key.getName()),
  );
  expect(cascading).toEqual([]);
});

const expectDeletionRefused = async (database: PGlite, workspaceId: string) => {
  const before = await readWorkState(database);
  const deletion = await Result.tryPromise(
    async () =>
      await database.query("DELETE FROM workspaces WHERE id = $1", [
        workspaceId,
      ]),
  );
  expect(await readWorkState(database)).toEqual(before);
  expect(deletion.isErr()).toBe(true);
  if (deletion.isErr()) {
    expect(getPgErrorCode(deletion.error)).toBe(PG_ERROR.FOREIGN_KEY_VIOLATION);
  }
  expect(
    (
      await database.query("SELECT id FROM workspaces WHERE id = $1", [
        workspaceId,
      ])
    ).rows,
  ).toEqual([{ id: workspaceId }]);
  return before;
};

test.each(["time_entries", "expenses"])(
  "refusing deletion preserves the matter's unbilled %s after reload",
  async (kept) => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "matter-time-expense-retention-"),
    );
    try {
      const before = await (async () => {
        await using database = new PGlite(directory);
        await seedDatabase(database, workTables);
        // Leave the first matter with only the record kind under test.
        const cleared = kept === "time_entries" ? "expenses" : "time_entries";
        await database.exec(
          `DELETE FROM ${cleared} WHERE workspace_id = 'first'`,
        );
        return await expectDeletionRefused(database, "first");
      })();
      await using reloaded = new PGlite(directory);
      expect(await readWorkState(reloaded)).toEqual(before);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

const retentionMigration = async (name: string) =>
  await Bun.file(
    new URL(`../../drizzle/${name}/migration.sql`, import.meta.url),
  ).text();

test("the retention migration changes only foreign keys and keeps every time entry, expense and total", async () => {
  await using database = new PGlite();
  await seedDatabase(database, workTables, true);
  const before = await readWorkState(database);
  for (const name of [
    "20261027120000_matter_time_expense_retention",
    "20261027120001_matter_time_expense_retention_validate",
  ]) {
    // These catalog migrations release their locks before online validation.
    await database.exec(`BEGIN; ${await retentionMigration(name)} COMMIT;`);
    expect(await readWorkState(database)).toEqual(before);
  }
  const connection = {
    execute: async (query, params = []) => {
      await database.query(query, [...params]);
    },
    query: async (query, params = []) =>
      (await database.query(query, [...params])).rows,
    release: () => {},
  } satisfies OnlineMigrationConnection;
  const retainedNames = billingForeignKeys(workTables)
    .filter((key) => key.parent === "workspaces")
    .map((key) => key.name)
    .toSorted();
  expect(
    MATTER_TIME_EXPENSE_RETENTION_CONSTRAINTS.map(
      ({ constraintName }) => constraintName,
    ).toSorted(),
  ).toEqual(retainedNames);
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
      constraints: MATTER_TIME_EXPENSE_RETENTION_CONSTRAINTS,
    }),
  ).toEqual({ type: "complete" });
  await expectDeletionRefused(database, "first");
  await expectDeletionRefused(database, "second");
  expect(
    (
      await database.query<{
        name: string;
        action: string;
        validated: boolean;
      }>(`
        SELECT conname AS name, confdeltype AS action, convalidated AS validated
        FROM pg_constraint WHERE contype = 'f' AND confrelid = 'workspaces'::regclass
        ORDER BY conname
      `)
    ).rows,
  ).toEqual(
    retainedNames.map((name) => ({ name, action: "a", validated: true })),
  );
});

test("explicit organization deletion still removes its whole billing history", async () => {
  await using database = new PGlite();
  await seedDatabase(database, retainedTables);
  await database.exec(`
    INSERT INTO invoices VALUES ('invoice', 'org', 'first', 1500);
    UPDATE time_entries SET invoice_id = 'invoice' WHERE id = 'approved-entry';
    INSERT INTO invoice_lines VALUES
      ('time-line', 'org', 'first', 'invoice', 'approved-entry', NULL, 1500);
  `);
  await database.exec("DELETE FROM organization WHERE id = 'org'");
  for (const table of retainedTables) {
    expect(
      (
        await database.query(
          `SELECT count(*)::int AS n FROM ${getTableConfig(table).name}`,
        )
      ).rows,
    ).toEqual([{ n: 0 }]);
  }
  expect((await database.query("SELECT id FROM workspaces")).rows).toEqual([]);
});
