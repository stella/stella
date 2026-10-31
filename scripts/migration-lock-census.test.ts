import { describe, expect, test } from "bun:test";

import {
  readMigrationLockAllowances,
  readMigrationLockSources,
} from "./check-migration-locks";
import { MIGRATION_LOCK_BASELINE } from "./migration-lock-baseline";
import {
  censusSql,
  checkMigrationLocks,
  migrationLockPairs,
  parseMigrationLockAllowances,
} from "./migration-lock-census";

const source = (sql: string) => [
  {
    file: "apps/api/drizzle/20990101000000_example/migration.sql",
    source: sql,
  },
];

describe("migration lock census", () => {
  test("every committed migration form is classified and strong locks are reviewed", () => {
    const allowances = readMigrationLockAllowances();
    expect(allowances.errors).toEqual([]);
    const result = checkMigrationLocks({
      sources: readMigrationLockSources(),
      baseline: MIGRATION_LOCK_BASELINE.entries,
      allowances: allowances.allowances,
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
    for (const { migration, form } of readMigrationLockAllowances()
      .allowances) {
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

  test("a nonconcurrent index on an existing relation requires review", () => {
    expect(
      checkMigrationLocks({
        sources: source("CREATE INDEX probe_idx ON existing_probe (id);"),
        baseline: [],
        allowances: [],
      }).errors.join("\n"),
    ).toContain("SHARE create-index needs");
  });

  test("a nonconcurrent index on a newly created relation has no existing writer to block", () => {
    expect(
      checkMigrationLocks({
        sources: source(
          "CREATE TABLE probe(id int); CREATE INDEX probe_idx ON probe (id);",
        ),
        baseline: [],
        allowances: [],
      }).errors,
    ).toEqual([]);
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
      checkMigrationLocks({ sources, baseline }).errors.join("\n"),
    ).toContain(
      'add "add-column": "<reason>" to scripts/migration-lock-allowances/20990102000000_other.json',
    );
    expect(
      checkMigrationLocks({
        sources: source(`${sql}${sql}`),
        baseline,
      }).errors.join("\n"),
    ).toContain("ACCESS EXCLUSIVE add-column needs");
  });

  test.each([
    'CREATE INDEX probe_id_idx ON "probe" (id);',
    'CREATE UNIQUE INDEX probe_id_idx ON "probe" (id);',
    'ALTER TABLE "probe" ADD COLUMN title text;',
    'ALTER TABLE "probe" ADD COLUMN active boolean DEFAULT false;',
    'ALTER TABLE "probe" ADD CONSTRAINT probe_check CHECK (id IS NOT NULL);',
    'ALTER TABLE "probe" ADD CONSTRAINT probe_unique UNIQUE (id);',
    'ALTER TABLE "probe" ADD CONSTRAINT probe_pk PRIMARY KEY (id);',
    'ALTER TABLE "probe" ADD CONSTRAINT probe_nn NOT NULL id;',
    'ALTER TABLE "probe" ALTER COLUMN id SET DEFAULT gen_random_uuid();',
    'ALTER TABLE "probe" ALTER COLUMN id DROP DEFAULT;',
    'ALTER TABLE "probe" ALTER COLUMN id SET NOT NULL;',
    'ALTER TABLE "probe" ALTER COLUMN id DROP NOT NULL;',
    "COMMENT ON TABLE \"probe\" IS 'temporary';",
    'GRANT SELECT ON TABLE "probe" TO app;',
    'ALTER TABLE "probe" OWNER TO app;',
  ])("self-contained new-relation operation stays exempt: %s", (operation) => {
    expect(
      checkMigrationLocks({
        sources: source(`CREATE TABLE "probe" (id uuid);\n${operation}`),
        baseline: [],
      }).errors,
    ).toEqual([]);
  });

  test("non-allowlisted work on a new relation still requires review", () => {
    const errors = checkMigrationLocks({
      sources: source(`CREATE TABLE probe(id uuid);
ALTER TABLE probe ENABLE ROW LEVEL SECURITY;
CREATE POLICY probe_select ON probe FOR SELECT USING (true);`),
      baseline: [],
    }).errors.join("\n");
    expect(errors).toContain("ACCESS EXCLUSIVE row-level-security needs");
    expect(errors).toContain("ACCESS EXCLUSIVE create-policy needs");
  });

  test("DROP COLUMN CASCADE on a new relation requires review", () => {
    const errors = checkMigrationLocks({
      sources: source(`CREATE TABLE scratch(id int);
ALTER TABLE scratch DROP COLUMN id CASCADE;`),
      baseline: [],
    }).errors.join("\n");
    expect(errors).toContain("ACCESS EXCLUSIVE drop-column needs");
  });

  test("a foreign key from a new relation to an existing relation requires review", () => {
    const errors = checkMigrationLocks({
      sources: source(`CREATE TABLE scratch(existing_id uuid);
ALTER TABLE scratch ADD CONSTRAINT scratch_existing_fk FOREIGN KEY (existing_id) REFERENCES existing(id);`),
      baseline: [],
    }).errors.join("\n");
    expect(errors).toContain("SHARE ROW EXCLUSIVE add-foreign-key needs");
  });

  test("an inline foreign key to an existing relation requires review", () => {
    const errors = checkMigrationLocks({
      sources: source(
        "CREATE TABLE scratch(existing_id uuid REFERENCES existing(id));",
      ),
      baseline: [],
    }).errors.join("\n");
    expect(errors).toContain(
      "SHARE ROW EXCLUSIVE create-table-references needs",
    );
  });

  test("an inline foreign key to a relation created earlier stays exempt", () => {
    expect(
      checkMigrationLocks({
        sources: source(`CREATE TABLE existing(id uuid);
CREATE TABLE scratch(existing_id uuid REFERENCES existing(id));`),
        baseline: [],
      }).errors,
    ).toEqual([]);
  });

  test("foreign-key review follows relation lock targets rather than forms", () => {
    const result =
      censusSql(`CREATE TABLE scratch(existing_id uuid REFERENCES existing(id));
ALTER TABLE scratch ADD CONSTRAINT scratch_existing_fk FOREIGN KEY (existing_id) REFERENCES existing(id);`);
    const foreignKeys = result.forms.filter(
      ({ form }) =>
        form === "create-table-references" || form === "add-foreign-key",
    );
    expect(result.errors).toEqual([]);
    expect(
      foreignKeys.map(({ locksExistingRelation }) => locksExistingRelation),
    ).toEqual([true, true]);
    expect(
      foreignKeys.reduce((sum, { lockTargets }) => sum + lockTargets.length, 0),
    ).toBe(4);
  });

  test("conditional table creation does not make a later lock uncontended", () => {
    const sql = `DO $$ BEGIN IF false THEN CREATE TABLE probe(id int); END IF; END $$;
ALTER TABLE probe ADD COLUMN title text;`;
    expect(
      checkMigrationLocks({ sources: source(sql), baseline: [] }).errors,
    ).toEqual([expect.stringContaining("ACCESS EXCLUSIVE add-column needs")]);
  });

  test("an unconditional top-level table creation makes a later lock uncontended", () => {
    const sql = `CREATE TABLE probe(id int);
ALTER TABLE probe ADD COLUMN title text;`;
    expect(
      checkMigrationLocks({ sources: source(sql), baseline: [] }).errors,
    ).toEqual([]);
  });

  test("reusing a created relation name ends its lock exemption", () => {
    const sql = `CREATE TABLE scratch(id int);
-- stella-migration-safety: reviewed rename-table-or-column - Move the temporary table out of the way before reusing its name
ALTER TABLE scratch RENAME TO scratch_old;
-- stella-migration-safety: reviewed rename-table-or-column - Move the existing table to the newly available relation name
ALTER TABLE existing RENAME TO scratch;
ALTER TABLE scratch ADD COLUMN title text;`;
    expect(
      checkMigrationLocks({ sources: source(sql), baseline: [] }).errors,
    ).toEqual([expect.stringContaining("ACCESS EXCLUSIVE add-column needs")]);
  });

  test("dropping any relation disables the exemption for the whole migration", () => {
    const sql = `CREATE TABLE scratch(id int);
ALTER TABLE scratch ADD COLUMN title text;
-- stella-migration-safety: reviewed drop-object - Remove the unrelated retired table after its contract step
DROP TABLE retired;`;
    expect(
      checkMigrationLocks({ sources: source(sql), baseline: [] }).errors,
    ).toEqual([expect.stringContaining("ACCESS EXCLUSIVE add-column needs")]);
  });

  test.each(["probe", "probe_old"])(
    "renaming a created relation ends the exemption for %s",
    (target) => {
      const sql = `CREATE TABLE probe(id int);
-- stella-migration-safety: reviewed rename-table-or-column - Rename the new relation before subsequent migration work
ALTER TABLE probe RENAME TO probe_old;
ALTER TABLE ${target} ADD COLUMN title text;`;
      expect(
        checkMigrationLocks({ sources: source(sql), baseline: [] }).errors,
      ).toEqual([expect.stringContaining("ACCESS EXCLUSIVE add-column needs")]);
    },
  );

  test("unresolved dynamic SQL fails closed", () => {
    const sql = `DO $$ BEGIN
      EXECUTE format('%s TABLE probe ADD COLUMN title text', 'ALTER');
    END $$;`;
    expect(
      checkMigrationLocks({ sources: source(sql), baseline: [] }).errors,
    ).toEqual([
      expect.stringContaining("ACCESS EXCLUSIVE unresolved-execute needs"),
    ]);
  });

  test("a fully literal EXECUTE retains its DDL classification", () => {
    const result = censusSql("DO $$ BEGIN EXECUTE 'DROP TABLE probe'; END $$;");
    expect(result.errors).toEqual([]);
    expect(result.forms.map(({ form, lockMode }) => [form, lockMode])).toEqual([
      ["drop-table", "ACCESS EXCLUSIVE"],
    ]);
  });

  test("a trigger execution clause is not dynamic SQL", () => {
    const result = censusSql(
      "CREATE TRIGGER probe AFTER INSERT ON target EXECUTE FUNCTION probe_fn();",
    );
    expect(result.errors).toEqual([]);
    expect(result.forms.map(({ form }) => form)).toEqual(["create-trigger"]);
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

  test("an allowance file names its migration and maps each census form to a reason", () => {
    const file =
      "scripts/migration-lock-allowances/20990101000000_example.json";
    expect(
      parseMigrationLockAllowances(file, {
        "add-column": "Additive expansion before application reads this column",
        "add-constraint": "Added NOT VALID and validated after the schema lock",
      }),
    ).toEqual({
      allowances: [
        {
          migration: "20990101000000_example",
          form: "add-column",
          reason: "Additive expansion before application reads this column",
        },
        {
          migration: "20990101000000_example",
          form: "add-constraint",
          reason: "Added NOT VALID and validated after the schema lock",
        },
      ],
      errors: [],
    });
    const refusals = (name: string, content: unknown) =>
      parseMigrationLockAllowances(
        `scripts/migration-lock-allowances/${name}`,
        content,
      );
    expect(
      refusals("example.json", { "add-column": "A reason long enough" }).errors,
    ).toEqual([
      "scripts/migration-lock-allowances/example.json: name the file after its migration folder, <YYYYMMDDHHMMSS>_<name>.json",
    ]);
    expect(
      refusals("20990101000000_example.yaml", {}).errors.join("\n"),
    ).toContain("name the file after its migration folder");
    for (const content of [[], {}, null, "add-column"]) {
      expect(
        refusals("20990101000000_example.json", content).errors.join("\n"),
      ).toContain("expected a non-empty object");
    }
    expect(
      refusals("20990101000000_example.json", {
        "add-colum": "A reason long enough",
      }).errors,
    ).toEqual([
      "scripts/migration-lock-allowances/20990101000000_example.json: add-colum is not a census DDL form",
    ]);
    for (const reason of ["short", "           ", 42]) {
      expect(
        refusals("20990101000000_example.json", { "add-column": reason }),
      ).toEqual({
        allowances: [],
        errors: [
          "scripts/migration-lock-allowances/20990101000000_example.json: add-column needs a reason of at least 12 characters",
        ],
      });
    }
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

  test.each([" ", "\n"])(
    "function header reviews preserve lock review boundaries (%j)",
    (separator) => {
      const sql = `-- stella-migration-safety: reviewed security-definer - Reviewed fixed read-only helper privileges
CREATE FUNCTION probe() RETURNS integer LANGUAGE sql SECURITY DEFINER AS $$${separator}SELECT 1;${separator}$$;`;
      expect(
        checkMigrationLocks({ sources: source(sql), baseline: [] }).errors,
      ).toEqual([]);
      expect(
        checkMigrationLocks({
          sources: source(`${sql}\nDROP TABLE retired;`),
          baseline: [],
        }).errors,
      ).toEqual([expect.stringContaining("ACCESS EXCLUSIVE drop-table needs")]);
    },
  );

  test("an enclosing review cannot approve a different nested lock form", () => {
    const sql = `-- stella-migration-safety: reviewed unbounded-update - Reviewed small bounded maintenance operation
DO $$ BEGIN UPDATE probe SET title = 'updated'; DROP TABLE retired; END $$;`;
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
      "unresolved-execute",
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
