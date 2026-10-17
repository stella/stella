import { describe, expect, test } from "bun:test";

import { readMigrationLockSources } from "./check-migration-locks";
import { MIGRATION_LOCK_BASELINE } from "./migration-lock-baseline";
import {
  censusSql,
  checkMigrationLocks,
  migrationLockPairs,
} from "./migration-lock-census";

const source = (sql: string) => [
  {
    file: "apps/api/drizzle/20990101000000_example/migration.sql",
    source: sql,
  },
];

describe("migration lock census", () => {
  test("every committed migration form is classified and strong locks are reviewed", () => {
    const result = checkMigrationLocks({
      sources: readMigrationLockSources(),
      baseline: MIGRATION_LOCK_BASELINE.entries,
    });
    expect(result.errors).toEqual([]);
    expect(
      [...result.counts.values()].reduce((sum, count) => sum + count, 0),
    ).toBeGreaterThan(4000);
  });

  test("the generated baseline has no missing or extra historical pairs", () => {
    const folders = new Set(
      MIGRATION_LOCK_BASELINE.entries.map(({ migration }) => migration),
    );
    const historical = readMigrationLockSources().filter(({ file }) =>
      folders.has(file.split("/").at(3) ?? ""),
    );
    expect(migrationLockPairs(historical)).toEqual(
      MIGRATION_LOCK_BASELINE.entries,
    );
  });

  test("unknown DDL fails even in a migration with historical forms", () => {
    const sources = source(
      "CREATE TABLE probe(id int); CREATE MATERIALIZED VIEW probe_view AS SELECT 1;",
    );
    const baseline = migrationLockPairs(source("CREATE TABLE probe(id int);"));
    expect(
      checkMigrationLocks({ sources, baseline }).errors.join("\n"),
    ).toContain("Unknown DDL form: CREATE MATERIALIZED VIEW");
  });

  test("new strong locks require a reason and cannot consume another folder's baseline", () => {
    const sql = "ALTER TABLE probe ADD COLUMN title text;";
    const baseline = migrationLockPairs(source(sql));
    const sources = [
      {
        file: "apps/api/drizzle/20990102000000_other/migration.sql",
        source: sql,
      },
    ];
    expect(
      checkMigrationLocks({ sources, baseline }).errors.join("\n"),
    ).toContain("ACCESS EXCLUSIVE add-column needs");
    expect(
      checkMigrationLocks({
        sources: source(`${sql}${sql}`),
        baseline,
      }).errors.join("\n"),
    ).toContain("ACCESS EXCLUSIVE add-column needs");
  });

  test("typed allowances name the migration and form and carry a reason", () => {
    const sources = source("ALTER TABLE probe ADD COLUMN title text;");
    expect(
      checkMigrationLocks({
        sources,
        baseline: [],
        allowances: [
          {
            migration: "20990101000000_example",
            form: "add-column",
            reason: "Additive expansion before application reads this column",
          },
        ],
      }).errors,
    ).toEqual([]);
    expect(
      checkMigrationLocks({
        sources,
        baseline: [],
        allowances: [
          {
            migration: "20990101000000_example",
            form: "add-column",
            reason: "short",
          },
        ],
      }).errors.join("\n"),
    ).toContain("needs a reviewed");
  });

  test("only a valid matching statement acknowledgement clears a strong lock", () => {
    const sql =
      "-- stella-migration-safety: reviewed drop-object - Remove the retired table after the contract step\nDROP TABLE probe;";
    expect(
      checkMigrationLocks({ sources: source(sql), baseline: [] }).errors,
    ).toEqual([]);
    expect(
      checkMigrationLocks({
        sources: source(sql.replace("drop-object", "change-owner")),
        baseline: [],
      }).errors.join("\n"),
    ).toContain("ACCESS EXCLUSIVE drop-table needs");
    expect(
      checkMigrationLocks({
        sources: source(`${sql}\nALTER TABLE other ADD COLUMN title text;`),
        baseline: [],
      }).errors.join("\n"),
    ).toContain("ACCESS EXCLUSIVE add-column needs");
  });

  test("mixed ALTER TABLE actions retain their individual lock classifications", () => {
    const result = censusSql(
      'ALTER TABLE "probe" VALIDATE CONSTRAINT "check", ADD COLUMN "title" text;',
    );
    expect(result.errors).toEqual([]);
    expect(result.forms.map(({ form, lockMode }) => [form, lockMode])).toEqual([
      ["validate-constraint", "SHARE UPDATE EXCLUSIVE"],
      ["add-column", "ACCESS EXCLUSIVE"],
    ]);
  });

  test("comments and quoted data do not become DDL while executable bodies do", () => {
    const result = censusSql(`
      -- CREATE MATERIALIZED VIEW misleading;
      SELECT 'DROP TABLE probe;';
      DO $$ BEGIN ALTER /* nested /* comment */ */ TABLE "probe" ADD COLUMN "title" text; END $$;
      CREATE FUNCTION probe() RETURNS void LANGUAGE plpgsql AS $body$ BEGIN
        EXECUTE format('DROP POLICY %I ON %I', 'p', 'probe');
      END $body$;
    `);
    expect(result.errors).toEqual([]);
    expect(result.forms.map(({ form }) => form)).toEqual([
      "add-column",
      "drop-policy",
      "create-function",
    ]);
  });

  test("new ALTER TABLE and ALTER INDEX variants fail closed", () => {
    for (const sql of [
      "ALTER TABLE probe SET LOGGED;",
      "ALTER INDEX probe SET TABLESPACE other;",
      "CREATE TABLE probe PARTITION OF other DEFAULT;",
      "CREATE TABLE probe AS SELECT * FROM other;",
      "CREATE EXTENSION other;",
      "SECURITY LABEL ON TABLE probe IS 'label';",
    ]) {
      expect(censusSql(sql).errors.join("\n")).toContain("Unknown DDL form");
    }
  });
});
