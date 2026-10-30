import { expect, spyOn, test } from "bun:test";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  MIGRATION_LOCK_MANIFEST_FILE,
  parseMigrationLockManifest,
  pendingMigrationLockTables,
  readMigrationLockManifest,
  reportWildcardMigrationLocks,
} from "../apps/api/src/db/migration-lock-manifest";
import { SCHEMA_TABLE_NAMES } from "../apps/api/src/db/schema-table-names.gen";
import { readMigrationLockSources } from "./check-migration-locks";
import {
  generateMigrationLockManifest,
  generateSchemaTableNames,
} from "./generate-migration-lock-manifest";

const migrationsFolder = path.resolve(import.meta.dir, "../apps/api/drizzle");
const bundled = readMigrationFiles({ migrationsFolder });

test("the shipped table lock manifest equals the census of every real migration", () => {
  const expected = generateMigrationLockManifest(readMigrationLockSources());
  const committed: unknown = JSON.parse(
    readFileSync(
      path.join(migrationsFolder, MIGRATION_LOCK_MANIFEST_FILE),
      "utf-8",
    ),
  );
  expect(committed).toEqual(expected);
  expect(readMigrationLockManifest(migrationsFolder, bundled)).toEqual(
    expected,
  );
  expect(Object.keys(expected.migrations)).toHaveLength(bundled.length);
  expect(
    pendingMigrationLockTables(
      expected,
      bundled.map(({ name }) => name),
    ),
  ).toContain("scheduler_jobs");
});

test("the runtime refuses unknown, missing, altered, and malformed manifest entries", () => {
  const valid = generateMigrationLockManifest(readMigrationLockSources());
  const first = bundled.at(0);
  expect(first).toBeDefined();
  if (!first) {
    return;
  }
  for (const value of [
    null,
    [],
    { ...valid, version: 2 },
    { ...valid, unknownField: true },
    { ...valid, migrations: {} },
    {
      ...valid,
      migrations: {
        ...valid.migrations,
        unknown: { hash: first.hash, locks: [] },
      },
    },
    {
      ...valid,
      migrations: {
        ...valid.migrations,
        [first.name]: { hash: "0".repeat(64), locks: [] },
      },
    },
    {
      ...valid,
      migrations: {
        ...valid.migrations,
        [first.name]: {
          hash: first.hash,
          locks: [{ relation: "scheduler_jobs", mode: "UNRECOGNIZED" }],
        },
      },
    },
  ]) {
    expect(() =>
      parseMigrationLockManifest({ value, migrations: bundled }),
    ).toThrow("Migration table lock manifest");
  }
  expect(() => pendingMigrationLockTables(valid, ["unknown"])).toThrow(
    "Migration table lock manifest has no entry for unknown",
  );
});

test("a real migration with no relation lock requests no lease", () => {
  const manifest = generateMigrationLockManifest(readMigrationLockSources());
  const noLocks = Object.entries(manifest.migrations).find(
    ([, { locks }]) => locks.length === 0,
  );
  expect(noLocks).toBeDefined();
  if (!noLocks) {
    return;
  }
  expect(pendingMigrationLockTables(manifest, [noLocks[0]])).toEqual([]);
  expect(pendingMigrationLockTables(manifest, [])).toEqual([]);
});

test("unresolved dependency locks remain explicit and conservative in real migrations", () => {
  const manifest = generateMigrationLockManifest(readMigrationLockSources());
  const wildcard = Object.entries(manifest.migrations).find(([, { locks }]) =>
    locks.some(({ relation }) => relation === "*"),
  );
  expect(wildcard).toBeDefined();
  if (!wildcard) {
    return;
  }
  expect(pendingMigrationLockTables(manifest, [wildcard[0]])).toContain("*");
  const output = spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    reportWildcardMigrationLocks(manifest, [wildcard[0]]);
    expect(output).toHaveBeenCalledWith(
      `${JSON.stringify({ event: "migrate.table_lease_wildcard", migration: wildcard[0] })}\n`,
    );
  } finally {
    output.mockRestore();
  }
});

test("the generated public table names equal committed migration history", () => {
  const expected = generateSchemaTableNames(readMigrationLockSources());
  expect(expected.length).toBeGreaterThan(0);
  expect(SCHEMA_TABLE_NAMES).toEqual(expected);
  expect(new Set(SCHEMA_TABLE_NAMES).size).toBe(SCHEMA_TABLE_NAMES.length);
});

test("table-name generation follows relation identity through migration history", () => {
  const names = generateSchemaTableNames([
    {
      file: "apps/api/drizzle/20260101000100_later/migration.sql",
      source: "DROP TABLE IF EXISTS census_retired, census_unlogged;",
    },
    {
      file: "apps/api/drizzle/20260101000000_earlier/migration.sql",
      source: `
        CREATE TABLE census_original (id integer);
        CREATE TABLE IF NOT EXISTS census_retired (id integer);
        CREATE UNLOGGED TABLE census_unlogged (id integer);
        CREATE TABLE public.census_moved (id integer);
        CREATE TABLE public."Quoted Name" (id integer);
        CREATE TEMP TABLE census_temporary (id integer);
        ALTER TABLE census_original RENAME TO census_current;
        ALTER TABLE public.census_moved SET SCHEMA archive;
        CREATE FUNCTION census_deferred() RETURNS void LANGUAGE plpgsql AS $$
        BEGIN CREATE TABLE census_deferred_table (id integer); END $$;
      `,
    },
  ]);
  expect(names).toEqual(["Quoted Name", "census_current"]);
});
