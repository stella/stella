import { describe, expect, test } from "bun:test";

import { readMigrationLockSources } from "./check-migration-locks";
import { MIGRATION_LOCK_BASELINE } from "./migration-lock-baseline";
import {
  censusSql,
  checkMigrationLocks,
  MIGRATION_LOCK_ALLOWANCES,
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

  test("every lock allowance names a committed migration form it still covers", () => {
    const committed = new Set(
      migrationLockPairs(readMigrationLockSources()).map(
        ({ migration, form }) => `${migration}/${form}`,
      ),
    );
    for (const { migration, form } of MIGRATION_LOCK_ALLOWANCES) {
      expect(committed).toContain(`${migration}/${form}`);
    }
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

  test.each([
    {
      setup:
        "CREATE TYPE probe_type AS ENUM ('active'); CREATE TABLE probe(value probe_type);",
      drop: "DROP TYPE probe_type CASCADE;",
    },
    {
      setup:
        "CREATE FUNCTION probe_default() RETURNS int LANGUAGE sql AS 'SELECT 1'; CREATE TABLE probe(value int DEFAULT probe_default());",
      drop: "DROP FUNCTION probe_default() CASCADE;",
    },
  ])(
    "cascading drops require a reason for unknown dependent tables: $drop",
    ({ setup, drop }) => {
      const sources = source(`${setup}\n${drop}`);
      const baseline = migrationLockPairs(
        source(`${setup}\n${drop.replace(" CASCADE", "")}`),
      );
      expect(censusSql(setup).errors).toEqual([]);
      expect(
        checkMigrationLocks({ sources, baseline }).errors.join("\n"),
      ).toContain("ACCESS EXCLUSIVE drop-cascade needs");
      expect(
        checkMigrationLocks({
          sources,
          baseline: [],
          allowances: [
            {
              migration: "20990101000000_example",
              form: "drop-cascade",
              reason: "Dependent columns are retired after the contract step",
            },
          ],
        }).errors,
      ).toEqual([]);
      expect(
        checkMigrationLocks({
          sources: source(
            `${setup}\n-- stella-migration-safety: reviewed drop-object - Dependent columns are retired after the contract step\n${drop}`,
          ),
          baseline: [],
        }).errors,
      ).toEqual([]);
    },
  );

  test("every cascading DROP kind takes precedence over object-only classifications", () => {
    for (const target of [
      "TYPE probe",
      "DOMAIN probe",
      "FUNCTION probe()",
      "SCHEMA probe",
      "EXTENSION probe",
      "SEQUENCE probe",
      "VIEW probe",
      "MATERIALIZED VIEW probe",
      "TABLE probe",
      "INDEX probe",
      "TRIGGER probe ON target",
      "POLICY probe ON target",
      "PROCEDURE probe()",
      "AGGREGATE probe(int)",
      "FOREIGN TABLE probe",
      "SERVER probe",
      "COLLATION probe",
      "TEXT SEARCH CONFIGURATION probe",
    ]) {
      const sql = `DROP ${target} /* dependent objects */ CASCADE;`;
      expect({
        ...censusSql(sql),
        forms: censusSql(sql).forms.map(({ form, lockMode, line }) => ({
          form,
          lockMode,
          line,
        })),
      }).toEqual({
        forms: [
          { form: "drop-cascade", lockMode: "ACCESS EXCLUSIVE", line: 1 },
        ],
        errors: [],
      });
      expect(
        checkMigrationLocks({ sources: source(sql), baseline: [] }).errors,
      ).toEqual([
        expect.stringContaining("ACCESS EXCLUSIVE drop-cascade needs"),
      ]);
      expect(
        checkMigrationLocks({
          sources: source(sql),
          baseline: [],
          allowances: [
            {
              migration: "20990101000000_example",
              form: "drop-cascade",
              reason: "Dependent objects are retired after the contract step",
            },
          ],
        }).errors,
      ).toEqual([]);
    }
  });

  test("executable cascading drops retain their dependency lock classification", () => {
    for (const sql of [
      "DO $$ BEGIN DROP TYPE probe CASCADE; END $$;",
      "DO $$ BEGIN EXECUTE 'DROP TYPE probe CASCADE'; END $$;",
    ]) {
      expect(censusSql(sql).errors).toEqual([]);
      expect(
        censusSql(sql).forms.map(({ form, lockMode }) => ({ form, lockMode })),
      ).toEqual([{ form: "drop-cascade", lockMode: "ACCESS EXCLUSIVE" }]);
    }
  });

  test("plain type drops retain their catalog-only classification", () => {
    for (const sql of [
      "DROP TYPE probe;",
      "DROP TYPE probe RESTRICT;",
      'DROP TYPE "CASCADE";',
      "DROP TYPE probe; -- CASCADE",
    ]) {
      expect({
        ...censusSql(sql),
        forms: censusSql(sql).forms.map(({ form, lockMode, line }) => ({
          form,
          lockMode,
          line,
        })),
      }).toEqual({
        forms: [
          { form: "drop-type", lockMode: "NO EXISTING RELATION", line: 1 },
        ],
        errors: [],
      });
      expect(
        checkMigrationLocks({ sources: source(sql), baseline: [] }).errors,
      ).toEqual([]);
    }
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

  test.each([" ", "\n"])(
    "reviews do not cross statement boundaries (%j)",
    (separator) => {
      const sql = `-- stella-migration-safety: reviewed drop-object - Remove retired objects after the contract step
DROP TABLE a;${separator}ALTER TABLE b ADD COLUMN c int;`;
      expect(
        checkMigrationLocks({ sources: source(sql), baseline: [] }).errors,
      ).toEqual([expect.stringContaining("ACCESS EXCLUSIVE add-column needs")]);
    },
  );

  test.each([
    ["change-owner", "OWNER TO r"],
    ["drop-column", "DROP COLUMN retired"],
    ["alter-column-type", "ALTER COLUMN existing TYPE bigint"],
    ["disable-row-level-security", "DISABLE ROW LEVEL SECURITY"],
  ])("a %s review covers only its ALTER action", (rule, action) => {
    const prefix = `-- stella-migration-safety: reviewed ${rule} - Reviewed after the application contract step\n`;
    expect(
      checkMigrationLocks({
        sources: source(`${prefix}ALTER TABLE t ${action}, ADD COLUMN c int;`),
        baseline: [],
      }).errors,
    ).toEqual([expect.stringContaining("ACCESS EXCLUSIVE add-column needs")]);
    expect(
      checkMigrationLocks({
        sources: source(`${prefix}ALTER TABLE t ${action};`),
        baseline: [],
      }).errors,
    ).toEqual([]);
  });

  test("a type-change review does not cover another alter-column action", () => {
    const sql = `-- stella-migration-safety: reviewed alter-column-type - Reviewed after the application contract step
ALTER TABLE t ALTER COLUMN a TYPE bigint, ALTER COLUMN b SET NOT NULL;`;
    expect(
      checkMigrationLocks({ sources: source(sql), baseline: [] }).errors,
    ).toEqual([expect.stringContaining("ACCESS EXCLUSIVE alter-column needs")]);
  });

  test("one review does not acknowledge two same-rule statements on one line", () => {
    const sql = `-- stella-migration-safety: reviewed drop-object - Remove retired objects after the contract step
DROP TABLE a; DROP TABLE b;`;
    expect(
      checkMigrationLocks({ sources: source(sql), baseline: [] }).errors,
    ).toEqual([expect.stringContaining("ACCESS EXCLUSIVE drop-table needs")]);
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
