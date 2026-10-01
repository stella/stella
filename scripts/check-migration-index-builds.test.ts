import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { HIGH_VOLUME_TABLES } from "../apps/api/src/db/high-volume-tables";
import { checkMigrationIndexBuilds } from "./check-migration-safety";
import findingsSnapshot from "./migration-index-findings.json" with { type: "json" };

const RULE_ID = "high-volume-index-build";
const FIXTURES = "scripts/fixtures/migration-index-builds";

type Source = { file: string; source: string };

const check = (...sources: Source[]) =>
  checkMigrationIndexBuilds(sources).map(({ file, line, ruleId }) => ({
    file,
    line,
    ruleId,
  }));

const source = (sql: string, file = "migration.sql"): Source => ({
  file,
  source: sql,
});

const readSqlFixture = (name: string) =>
  readFileSync(path.join(FIXTURES, name), "utf-8");

const listSqlFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return listSqlFiles(entryPath);
    }
    return entry.isFile() && entry.name.endsWith(".sql") ? [entryPath] : [];
  });

describe("high-volume index-build migration rule", () => {
  it("flags every registered high-volume table", () => {
    const findings = check(
      ...HIGH_VOLUME_TABLES.map((table) =>
        source(
          `CREATE INDEX idx_${table} ON public.${table} (id);`,
          `${table}.sql`,
        ),
      ),
    );

    expect(findings).toEqual(
      HIGH_VOLUME_TABLES.map((table) => ({
        file: `${table}.sql`,
        line: 1,
        ruleId: RULE_ID,
      })),
    );
  });

  const blockedShapes = [
    [
      "quoted relation and index names",
      'CREATE INDEX "idx" ON "case_law_decisions" ("id");',
    ],
    [
      "unquoted schema-qualified relation",
      "CREATE INDEX idx ON public.case_law_decisions (id);",
    ],
    [
      "quoted relation with a schema qualifier",
      'CREATE INDEX idx ON public."case_law_decisions" (id);',
    ],
    [
      "quoted schema and relation",
      'CREATE INDEX idx ON "public"."case_law_decisions" (id);',
    ],
    [
      "mixed-case unquoted high-volume relation",
      "CREATE INDEX idx ON public.CaSe_LaW_DeCiSiOnS (id);",
    ],
    [
      "whitespace around a schema separator",
      'CREATE INDEX idx ON public . "case_law_decisions" (id);',
    ],
    [
      "UNIQUE index with IF NOT EXISTS and ONLY",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx ON ONLY case_law_decisions (id);",
    ],
    [
      "partial index",
      "CREATE INDEX idx ON case_law_decisions (id) WHERE id > 0;",
    ],
    [
      "expression index",
      "CREATE INDEX idx ON case_law_decisions ((lower(title)));",
    ],
    [
      "case-insensitive keywords",
      "cReAtE iNdEx idx oN case_law_decisions (id);",
    ],
    [
      "comments between keywords",
      "CREATE /* comment */ UNIQUE\nINDEX idx ON case_law_decisions (id);",
    ],
    [
      "multiline statement after another statement",
      "SELECT 1;\nCREATE\n UNIQUE INDEX IF NOT EXISTS idx\nON ONLY public.case_law_decisions\n ((lower(title))) WHERE title IS NOT NULL;",
    ],
  ] as const;

  it.each(blockedShapes)("flags %s", (_name, sql) => {
    expect(check(source(sql))).toEqual([
      {
        file: "migration.sql",
        line: sql.startsWith("SELECT") ? 2 : 1,
        ruleId: RULE_ID,
      },
    ]);
  });

  it("preserves block and allow decisions across optional CREATE INDEX clauses", () => {
    for (const unique of ["", "UNIQUE "]) {
      for (const concurrent of ["", "CONCURRENTLY "]) {
        for (const conditional of ["", "IF NOT EXISTS "]) {
          for (const only of ["", "ONLY "]) {
            for (const relation of [
              "case_law_decisions",
              '"case_law_decisions"',
              'public . "case_law_decisions"',
            ]) {
              const header = `CREATE ${unique}INDEX ${concurrent}${conditional}idx ON ${only}`;
              expect(
                check(
                  source(
                    `${header}${relation} ((lower(title))) WHERE title IS NOT NULL;`,
                  ),
                ),
              ).toEqual([{ file: "migration.sql", line: 1, ruleId: RULE_ID }]);
              expect(
                check(
                  source(
                    `${header}${relation.replaceAll("case_law_decisions", "documents")} ((lower(title))) WHERE title IS NOT NULL;`,
                  ),
                ),
              ).toEqual([]);
            }
          }
        }
      }
    }
    expect(check(source("CREATE INDEX ON case_law_decisions (id);"))).toEqual([
      { file: "migration.sql", line: 1, ruleId: RULE_ID },
    ]);
    expect(check(source("CREATE INDEX ON documents (id);"))).toEqual([]);
  });

  const allowedShapes = [
    ["an ordinary table", "CREATE INDEX idx ON public.documents (id);"],
    ["UNIQUE index", "CREATE UNIQUE INDEX idx ON documents (id);"],
    [
      "CONCURRENTLY with IF NOT EXISTS",
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx ON documents (id);",
    ],
    ["ONLY", "CREATE INDEX idx ON ONLY public.documents (id);"],
    [
      "partial expression index",
      "CREATE INDEX idx ON documents ((lower(title))) WHERE title IS NOT NULL;",
    ],
    [
      "quoted schema and relation with whitespace",
      'CREATE INDEX idx ON "public" . "documents" (id);',
    ],
    [
      "case-sensitive quoted relation",
      'CREATE INDEX idx ON public."Case_Law_Decisions" (id);',
    ],
    ["case-insensitive keywords", "cReAtE iNdEx idx oN documents (id);"],
    [
      "comments between keywords",
      "CREATE /* comment */ UNIQUE\nINDEX idx ON documents (id);",
    ],
    [
      "names mentioned only in a comment",
      "-- CREATE INDEX idx ON case_law_decisions (id);\nSELECT 1;",
    ],
    [
      "names mentioned only in a string",
      "SELECT 'CREATE INDEX idx ON case_law_decisions (id)';",
    ],
    [
      "names mentioned only in a dollar-quoted string",
      "SELECT $$CREATE INDEX idx ON case_law_decisions (id)$$;",
    ],
    [
      "nested comments containing index syntax",
      "/* outer /* CREATE INDEX idx ON case_law_decisions (id); */ still comment */ SELECT 1;",
    ],
    [
      "a high-volume table created earlier in this migration",
      "CREATE TABLE case_law_decisions (id int); CREATE INDEX idx ON case_law_decisions (id);",
    ],
  ] as const;

  it.each(allowedShapes)("allows %s", (_name, sql) => {
    expect(check(source(sql))).toEqual([]);
  });

  it("allows only an index whose high-volume table is created earlier", () => {
    expect(
      check(
        source(
          "CREATE INDEX idx ON case_law_decisions (id); CREATE TABLE case_law_decisions (id int);",
        ),
      ),
    ).toEqual([{ file: "migration.sql", line: 1, ruleId: RULE_ID }]);
    expect(
      check(
        source(
          "CREATE TABLE IF NOT EXISTS case_law_decisions (id int); CREATE INDEX idx ON case_law_decisions (id);",
        ),
      ),
    ).toEqual([{ file: "migration.sql", line: 1, ruleId: RULE_ID }]);
  });

  it("does not exempt a table created only in a conditional DO branch", () => {
    expect(
      check(
        source(
          "DO $$ BEGIN IF false THEN CREATE TABLE case_law_decisions (id int); END IF; CREATE INDEX idx ON case_law_decisions (id); END $$;",
        ),
      ),
    ).toEqual([{ file: "migration.sql", line: 1, ruleId: RULE_ID }]);
  });

  it("flags executable DO bodies and ignores deferred routine bodies", () => {
    expect(
      check(
        source(
          "DO $$ BEGIN CREATE INDEX idx ON case_law_decisions (id); END $$;",
        ),
      ),
    ).toEqual([{ file: "migration.sql", line: 1, ruleId: RULE_ID }]);
    expect(
      check(
        source(
          "CREATE FUNCTION later() RETURNS void LANGUAGE plpgsql AS $$ BEGIN CREATE INDEX idx ON case_law_decisions (id); END $$;",
        ),
      ),
    ).toEqual([]);
    expect(
      check(
        source(
          "DO $$ BEGIN EXECUTE 'CREATE INDEX idx ON case_law_decisions (id)'; END $$;",
        ),
      ),
    ).toEqual([]);
  });

  it("resolves REINDEX INDEX from an earlier CREATE INDEX definition", () => {
    expect(
      check(
        source("CREATE INDEX idx ON case_law_decisions (id);", "001.sql"),
        source("REINDEX INDEX idx;", "002.sql"),
      ),
    ).toEqual([
      { file: "001.sql", line: 1, ruleId: RULE_ID },
      { file: "002.sql", line: 1, ruleId: RULE_ID },
    ]);
    expect(
      check(
        source("CREATE INDEX idx ON documents (id);", "001.sql"),
        source("REINDEX INDEX idx;", "002.sql"),
      ),
    ).toEqual([]);
    expect(
      check(
        source(
          'CREATE INDEX "idx" ON public.case_law_decisions (id);',
          "001.sql",
        ),
        source('REINDEX INDEX CONCURRENTLY public."idx";', "002.sql"),
      ),
    ).toEqual([
      { file: "001.sql", line: 1, ruleId: RULE_ID },
      { file: "002.sql", line: 1, ruleId: RULE_ID },
    ]);
  });

  it.each([
    ["REINDEX TABLE", "REINDEX TABLE public.case_law_decisions;"],
    [
      "REINDEX TABLE CONCURRENTLY",
      "REINDEX TABLE CONCURRENTLY case_law_decisions;",
    ],
    ["REINDEX INDEX", "REINDEX INDEX missing_index;"],
    ["REINDEX SCHEMA", "REINDEX SCHEMA public;"],
    ["REINDEX DATABASE", "REINDEX DATABASE stella;"],
    ["REINDEX SYSTEM", "REINDEX SYSTEM stella;"],
    [
      "REINDEX with concurrent and verbose options",
      "REINDEX (CONCURRENTLY TRUE, VERBOSE) TABLE case_law_decisions;",
    ],
  ])("refuses unsafe or unresolved %s", (_name, sql) => {
    expect(check(source(sql))).toEqual([
      { file: "migration.sql", line: 1, ruleId: RULE_ID },
    ]);
  });

  it("fails closed when an index definition is ambiguous, later, or masked", () => {
    const cases = [
      [
        "ambiguous prior definitions",
        [
          source("CREATE INDEX idx ON case_law_decisions (id);", "001.sql"),
          source("CREATE INDEX idx ON documents (id);", "002.sql"),
          source("REINDEX INDEX idx;", "003.sql"),
        ],
        [
          { file: "001.sql", line: 1, ruleId: RULE_ID },
          { file: "003.sql", line: 1, ruleId: RULE_ID },
        ],
      ],
      [
        "a later definition",
        [
          source("REINDEX INDEX idx;", "001.sql"),
          source("CREATE INDEX idx ON documents (id);", "002.sql"),
        ],
        [{ file: "001.sql", line: 1, ruleId: RULE_ID }],
      ],
      [
        "a definition in a comment or string",
        [
          source(
            "-- CREATE INDEX idx ON documents (id);\nSELECT 'CREATE INDEX idx ON documents (id)';",
            "001.sql",
          ),
          source("REINDEX INDEX idx;", "002.sql"),
        ],
        [{ file: "002.sql", line: 1, ruleId: RULE_ID }],
      ],
      [
        "a deferred function definition",
        [
          source(
            "CREATE FUNCTION later() RETURNS void LANGUAGE plpgsql AS $$ BEGIN CREATE INDEX idx ON documents (id); END $$;",
            "001.sql",
          ),
          source("REINDEX INDEX idx;", "002.sql"),
        ],
        [{ file: "002.sql", line: 1, ruleId: RULE_ID }],
      ],
    ] as const;

    for (const [_name, sources, expected] of cases) {
      expect(check(...sources)).toEqual(expected);
    }
  });

  it("recognizes the rule's minimal bad and good fixtures", () => {
    expect(check(source(readSqlFixture("create-index/bad.sql")))).toEqual([
      { file: "migration.sql", line: 1, ruleId: RULE_ID },
    ]);
    expect(check(source(readSqlFixture("create-index/good.sql")))).toEqual([]);

    expect(
      check(
        source(readSqlFixture("reindex/definition.sql"), "001.sql"),
        source(readSqlFixture("reindex/bad.sql"), "002.sql"),
      ),
    ).toEqual([
      { file: "001.sql", line: 1, ruleId: RULE_ID },
      { file: "002.sql", line: 1, ruleId: RULE_ID },
    ]);
    expect(
      check(
        source(readSqlFixture("reindex/good-definition.sql"), "001.sql"),
        source(readSqlFixture("reindex/good.sql"), "002.sql"),
      ),
    ).toEqual([]);
  });

  it("cannot be cleared by an acknowledgement", () => {
    const result = Bun.spawnSync([
      "bun",
      "scripts/check-migration-safety.ts",
      "scripts/fixtures/migration-index-builds/create-index/acknowledged.sql",
    ]);
    const stderr = new TextDecoder().decode(result.stderr);

    expect(result.exitCode).toBe(1);
    expect(stderr).toContain(`[${RULE_ID}]`);
  });

  it("refuses unknown CLI REINDEX targets and allows a known small table", () => {
    const unknown = Bun.spawnSync([
      "bun",
      "scripts/check-migration-safety.ts",
      "scripts/fixtures/migration-index-builds/reindex/unknown.sql",
    ]);
    const ordinary = Bun.spawnSync([
      "bun",
      "scripts/check-migration-safety.ts",
      "scripts/fixtures/migration-index-builds/reindex/ordinary-table.sql",
    ]);

    expect(unknown.exitCode).toBe(1);
    expect(new TextDecoder().decode(unknown.stderr)).toContain(`[${RULE_ID}]`);
    expect(ordinary.exitCode).toBe(0);
    expect(new TextDecoder().decode(ordinary.stderr)).toBe("");
  });

  it("matches the pinned findings across the migration corpus", () => {
    const sources = listSqlFiles("apps/api/drizzle")
      .toSorted()
      .map((file) => ({
        file: file.replaceAll(path.sep, "/"),
        source: readFileSync(file, "utf-8"),
      }));

    const corpusFindings = checkMigrationIndexBuilds(sources).map(
      ({ file, line, ruleId, statementHash }) => ({
        file,
        line,
        ruleId,
        statementHash,
      }),
    );
    expect(corpusFindings).toEqual(findingsSnapshot);

    const previous = Bun.spawnSync([
      "git",
      "show",
      "origin/main:scripts/migration-index-findings.json",
    ]);
    if (previous.exitCode !== 0) {
      // The first snapshot has no predecessor. Other Git failures must not
      // silently disable the shrink-only check.
      expect(previous.exitCode).toBe(128);
      expect(new TextDecoder().decode(previous.stderr)).toContain(
        "not in 'origin/main'",
      );
      return;
    }
    const previousSnapshot: unknown = JSON.parse(
      new TextDecoder().decode(previous.stdout),
    );
    expect(Array.isArray(previousSnapshot)).toBe(true);
    if (!Array.isArray(previousSnapshot)) {
      return;
    }

    const previousKeys = new Set(
      previousSnapshot.map((finding) => JSON.stringify(finding)),
    );
    expect(
      corpusFindings.every((finding) =>
        previousKeys.has(JSON.stringify(finding)),
      ),
    ).toBe(true);
  }, 60_000);

  it("still identifies the historical citation-resolution index migration", () => {
    const file =
      "apps/api/drizzle/20261003122700_case_law_textless_detail_recheck/migration.sql";
    const findings = check(source(readFileSync(file, "utf-8"), file));

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file, line: 12, ruleId: RULE_ID }),
      ]),
    );
  });
});
