import { describe, expect, test } from "bun:test";
import { readMigrationFiles } from "drizzle-orm/migrator";
import nodePath from "node:path";

import { withMigrationLockTimeout } from "./migration-lock-timeout";

describe("migration queue bounds", () => {
  test("bounds every top-level timeout while retaining concurrent waits and local scope", () => {
    const source = `-- queue policy
SET lock_timeout = '1s';
SELECT 1; SET LOCAL lock_timeout TO '5s';
SET SESSION lock_timeout = 0;
SELECT current_setting('lock_timeout');`;
    expect(withMigrationLockTimeout(source, 250)).toBe(`-- queue policy
SET lock_timeout = '1s';
SET lock_timeout = '250ms';
SELECT 1; SET LOCAL lock_timeout TO '5s';
SET LOCAL lock_timeout = '250ms';
SET SESSION lock_timeout = 0;
SELECT current_setting('lock_timeout');`);
  });

  test("preserves routine bodies, quoted values, identifiers and nested comments", () => {
    const source = `/* outer /* SET lock_timeout = '1s'; */ end */
DO $body$ BEGIN PERFORM set_config('lock_timeout', '1s', true); END $body$;
SELECT 'SET lock_timeout = ''5s'';', "SET lock_timeout = '1s';";
-- SET lock_timeout = '1s';
SET /* bound */ LOCAL lock_timeout = '1s';`;
    expect(withMigrationLockTimeout(source, 100)).toBe(
      `${source}\nSET LOCAL lock_timeout = '100ms';`,
    );
  });

  test("terminates settings without a semicolon even before a trailing comment", () => {
    const source = "SET /* queue */ SESSION lock_timeout = '1s' -- bound";
    expect(withMigrationLockTimeout(source, 500)).toBe(
      `${source}\n;\nSET lock_timeout = '500ms';`,
    );
  });

  test("bounds compact timeout assignments", () => {
    const source = "SET lock_timeout='1s';";
    expect(withMigrationLockTimeout(source, 500)).toBe(
      `${source}\nSET lock_timeout = '500ms';`,
    );
  });

  test("keeps escaped string semicolons outside statement boundaries", () => {
    const source = String.raw`SELECT E'escaped\'; SET lock_timeout = 0;'; SET lock_timeout = '1s';`;
    expect(withMigrationLockTimeout(source, 1000)).toBe(
      `${source}\nSET lock_timeout = '1000ms';`,
    );
  });

  test("preserves all original corpus bytes around the execution bounds", () => {
    const migrations = readMigrationFiles({
      migrationsFolder: nodePath.resolve(import.meta.dir, "../../drizzle"),
    });
    let bounded = 0;
    for (const migration of migrations) {
      for (const statement of migration.sql) {
        const transformed = withMigrationLockTimeout(statement, 250);
        if (transformed !== statement) {
          bounded += 1;
          expect(
            transformed.replace(
              /\nSET(?: LOCAL)? lock_timeout = '250ms';/gu,
              "",
            ),
          ).toBe(statement);
        }
      }
    }
    expect(bounded).toBeGreaterThan(0);
  });
});
