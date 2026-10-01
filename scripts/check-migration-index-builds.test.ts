import { describe, expect, it } from "bun:test";
import {
  readFileSync,
  readdirSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
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
    expect(check(source("DO $$ BEGIN EXECUTE 'SELECT 1'; END $$;"))).toEqual(
      [],
    );
  });

  it.each([
    ["literal SQL", "EXECUTE 'CREATE INDEX idx ON case_law_decisions (id)'"],
    [
      "escape literal SQL",
      "EXECUTE E'CREATE INDEX idx ON case_law_decisions (id)'",
    ],
    [
      "dollar literal SQL",
      "EXECUTE $sql$CREATE INDEX idx ON case_law_decisions (id)$sql$",
    ],
    [
      "format identifiers",
      "EXECUTE format('CREATE INDEX %I ON %I (id)', 'idx', 'case_law_decisions')",
    ],
    [
      "format variable",
      "EXECUTE format('CREATE INDEX idx ON %I (id)', target)",
    ],
    [
      "concatenated variable",
      "EXECUTE 'CREATE INDEX idx ON ' || target || ' (id)'",
    ],
    [
      "concatenated constants",
      "EXECUTE 'CREATE INDEX idx ON ' || 'case_law_decisions' || ' (id)'",
    ],
    ["REINDEX variable", "EXECUTE 'REINDEX INDEX ' || target"],
    [
      "REINDEX table format variable",
      "EXECUTE format('REINDEX TABLE %I', target)",
    ],
    [
      "format followed by concatenation",
      "EXECUTE format('CREATE INDEX %I ON documents (id)', index_name) || format('; CREATE INDEX idx ON %I (id)', target)",
    ],
  ])("flags dynamic %s in executable bodies", (_name, sql) => {
    expect(check(source(`DO $$ BEGIN ${sql}; END $$;`))).toHaveLength(1);
    expect(
      check(
        source(
          `CREATE FUNCTION later() RETURNS void LANGUAGE plpgsql AS $$ BEGIN ${sql}; END $$;`,
        ),
      ),
    ).toEqual([]);
  });

  it.each([
    "EXECUTE 'CREATE INDEX idx ON documents (id)'",
    "EXECUTE format('CREATE INDEX %I ON %I (id)', 'idx', 'documents')",
    "EXECUTE 'CREATE INDEX idx ON ' || 'documents' || ' (id)'",
    "EXECUTE 'SELECT 1'",
    "EXECUTE format('CREATE INDEX %I ON documents (id)', index_name)",
  ])("allows resolved small-table or non-index dynamic SQL: %s", (sql) => {
    expect(check(source(`DO $$ BEGIN ${sql}; END $$;`))).toEqual([]);
  });

  it.each(["'", "E'", "$$", "$body$"])(
    "scans executable DO string form %s",
    (quote) => {
      const close = quote === "E'" ? "'" : quote;
      expect(
        check(
          source(
            `DO ${quote}BEGIN CREATE INDEX idx ON case_law_decisions (id); END${close};`,
          ),
        ),
      ).toHaveLength(1);
      expect(
        check(
          source(
            `DO ${quote}BEGIN CREATE INDEX idx ON documents (id); END${close};`,
          ),
        ),
      ).toEqual([]);
    },
  );

  it("decodes numeric and character escapes in executable E strings", () => {
    expect(
      check(
        source(
          String.raw`DO E'BEGIN \x43REATE INDEX idx ON case_law_decisions (id); END';`,
        ),
      ),
    ).toHaveLength(1);
    expect(
      check(
        source(
          String.raw`DO E'BEGIN \103REATE INDEX idx ON case_law_decisions (id); END';`,
        ),
      ),
    ).toHaveLength(1);
    expect(
      check(
        source(
          String.raw`DO E'BEGIN \u0043REATE INDEX idx ON documents (id); END';`,
        ),
      ),
    ).toEqual([]);
  });

  it("fails closed for variable EXECUTE with index SQL fragments in the body", () => {
    expect(
      check(
        source(
          "DO $$ DECLARE sql text := 'CREATE INDEX idx ON case_law_decisions (id)'; BEGIN EXECUTE sql; END $$;",
        ),
      ),
    ).toHaveLength(1);
    expect(
      check(
        source(
          "DO $$ DECLARE sql text := 'CREATE INDEX idx ON case_law_decisions (id)'; BEGIN EXECUTE sql USING 'value'; END $$;",
        ),
      ),
    ).toHaveLength(1);
    expect(
      check(
        source(
          "DO $$ DECLARE sql text := 'SELECT 1'; BEGIN EXECUTE sql; END $$;",
        ),
      ),
    ).toEqual([]);
  });

  it("retains table identities through rename chains and vacated fresh names", () => {
    expect(
      check(
        source(
          "ALTER TABLE case_law_decisions RENAME TO archive; ALTER TABLE archive RENAME TO archive_again; CREATE INDEX idx ON archive_again (id);",
        ),
      ),
    ).toHaveLength(1);
    expect(
      check(
        source(
          "CREATE TABLE case_law_decisions (id int); ALTER TABLE case_law_decisions RENAME TO fresh; ALTER TABLE case_law_citations RENAME TO case_law_decisions; CREATE INDEX idx ON case_law_decisions (id);",
        ),
      ),
    ).toHaveLength(1);
    expect(
      check(
        source(
          "CREATE TABLE case_law_decisions (id int); ALTER TABLE case_law_decisions RENAME TO fresh; CREATE INDEX idx ON fresh (id);",
        ),
      ),
    ).toEqual([]);
    expect(
      check(
        source(
          "ALTER TABLE documents RENAME TO archive; CREATE INDEX idx ON archive (id);",
        ),
      ),
    ).toEqual([]);
  });

  it("refuses cross-schema ambiguity and resolves qualified index names exactly", () => {
    const history = source(
      "CREATE INDEX idx ON documents (id); CREATE INDEX idx ON other.case_law_decisions (id);",
      "001.sql",
    );
    expect(
      check(
        history,
        source(
          "SET search_path TO other, public; REINDEX INDEX idx;",
          "002.sql",
        ),
      ),
    ).toHaveLength(2);
    expect(
      check(history, source("REINDEX INDEX public.idx;", "002.sql")),
    ).toHaveLength(1);
    expect(
      check(history, source("REINDEX INDEX other.idx;", "002.sql")),
    ).toHaveLength(2);
  });

  it.each(["documents", "case_law_decisions"])(
    "transfers renamed index ownership for %s",
    (table) => {
      const findings = check(
        source(
          `CREATE INDEX old_idx ON ${table} (id); ALTER INDEX old_idx RENAME TO new_idx; REINDEX INDEX new_idx;`,
        ),
      );
      expect(findings).toHaveLength(table === "documents" ? 0 : 2);
      expect(
        check(
          source(
            `CREATE INDEX old_idx ON ${table} (id); ALTER INDEX old_idx RENAME TO new_idx; REINDEX INDEX old_idx;`,
          ),
        ),
      ).toHaveLength(table === "documents" ? 1 : 2);
    },
  );

  it.each(["documents", "case_law_decisions"])(
    "rebinds dropped index ownership to %s",
    (table) => {
      expect(
        check(
          source(
            `CREATE INDEX idx ON case_law_decisions (id); DROP INDEX idx; CREATE INDEX idx ON ${table} (id); REINDEX INDEX idx;`,
          ),
        ),
      ).toHaveLength(table === "documents" ? 1 : 3);
      expect(
        check(
          source(
            "CREATE INDEX idx ON documents (id); DROP INDEX idx; REINDEX INDEX idx;",
          ),
        ),
      ).toHaveLength(1);
    },
  );

  it("blocks the full index clause sequence", () => {
    expect(
      check(
        source(
          "CREATE INDEX idx ON case_law_decisions USING btree (id) INCLUDE (title) WITH (fillfactor = 90) TABLESPACE pg_default WHERE id > 0;",
        ),
      ),
    ).toHaveLength(1);
  });

  it("normalizes absolute and relative paths before CLI corpus ordering", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "stella-index-parity-"));
    const file = "scripts/reindex.sql";
    mkdirSync(path.join(directory, "scripts"), { recursive: true });
    mkdirSync(path.join(directory, "apps/api/drizzle/001"), {
      recursive: true,
    });
    writeFileSync(path.join(directory, "scripts/migration-baseline.txt"), "");
    writeFileSync(
      path.join(directory, "apps/api/drizzle/001/migration.sql"),
      "CREATE INDEX idx ON documents (id);",
    );
    writeFileSync(
      path.join(directory, file),
      "SET lock_timeout = '1s'; SET statement_timeout = '30s'; REINDEX INDEX idx;",
    );
    try {
      const relative = Bun.spawnSync(
        ["bun", path.resolve("scripts/check-migration-safety.ts"), file],
        { cwd: directory },
      );
      const absolute = Bun.spawnSync(
        [
          "bun",
          path.resolve("scripts/check-migration-safety.ts"),
          path.join(directory, file),
        ],
        { cwd: directory },
      );
      expect(relative.exitCode).toBe(0);
      expect(absolute.exitCode).toBe(relative.exitCode);
      expect(new TextDecoder().decode(absolute.stderr)).toBe(
        new TextDecoder().decode(relative.stderr),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("grandfathers only unchanged statements at the pinned path and line through the CLI", () => {
    const file =
      "apps/api/drizzle/20261003122700_case_law_textless_detail_recheck/migration.sql";
    const original = readFileSync(file, "utf-8");
    const directory = mkdtempSync(
      path.join(tmpdir(), "stella-index-grandfather-"),
    );
    mkdirSync(path.join(directory, "scripts"), { recursive: true });
    mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    writeFileSync(path.join(directory, "scripts/migration-baseline.txt"), "");
    const run = (target: string, sql: string) => {
      const fixture = path.join(directory, target);
      mkdirSync(path.dirname(fixture), { recursive: true });
      writeFileSync(fixture, sql);
      return Bun.spawnSync(
        ["bun", path.resolve("scripts/check-migration-safety.ts"), target],
        { cwd: directory },
      );
    };
    try {
      const unchanged = run(file, original);
      expect(new TextDecoder().decode(unchanged.stderr)).toBe("");
      expect(unchanged.exitCode).toBe(0);
      for (const [target, sql] of [
        [
          file,
          original.replace(
            "CREATE INDEX CONCURRENTLY",
            "CREATE UNIQUE INDEX CONCURRENTLY",
          ),
        ],
        [file, `\n${original}`],
        ["apps/api/drizzle/20991001000000_copied/migration.sql", original],
      ]) {
        const result = run(target ?? "", sql ?? "");
        expect(result.exitCode).toBe(1);
        expect(new TextDecoder().decode(result.stderr)).toContain(
          `[${RULE_ID}]`,
        );
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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
      expect(check(...sources)).toEqual([...expected]);
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

describe("indexes built by ALTER TABLE ADD constraints", () => {
  it("keeps a minimal blocked build and allowed attachment fixture", () => {
    expect(check(source(readSqlFixture("add-constraint/bad.sql")))).toEqual([
      { file: "migration.sql", line: 1, ruleId: RULE_ID },
    ]);
    expect(check(source(readSqlFixture("add-constraint/good.sql")))).toEqual(
      [],
    );
  });

  it("recognizes mixed-case keywords and an unquoted relation", () => {
    expect(
      check(
        source("aLtEr TaBlE IF EXISTS CaSe_LaW_DeCiSiOnS aDd UNIQUE (id);"),
      ),
    ).toHaveLength(1);
  });

  const additions = [
    "ADD PRIMARY KEY (id)",
    "ADD UNIQUE (id)",
    "ADD UNIQUE NULLS NOT DISTINCT (id)",
    "ADD EXCLUDE USING gist (id WITH =)",
    'ADD CONSTRAINT "key" PRIMARY KEY (id)',
    'ADD CONSTRAINT "key" UNIQUE (id)',
    'ADD CONSTRAINT "key" EXCLUDE USING gist (id WITH =)',
    "ADD COLUMN external_id integer UNIQUE",
    "ADD COLUMN IF NOT EXISTS external_id integer PRIMARY KEY",
    'ADD COLUMN "external_id" integer CONSTRAINT "key" UNIQUE',
    "ADD COLUMN external_id integer DEFAULT (coalesce(1, 2)) UNIQUE",
    "ADD COLUMN title text, ADD CONSTRAINT key UNIQUE (id)",
    "ADD CHECK (id IN (1, 2)), ADD UNIQUE (id)",
    "ADD CONSTRAINT attached UNIQUE USING INDEX ready, ADD UNIQUE (id)",
    "ADD UNIQUE (id), ADD CONSTRAINT attached UNIQUE USING INDEX ready",
  ];
  it("blocks builds across constraint forms, table headers and size classes", () => {
    for (const addition of additions) {
      for (const header of ["", "ONLY ", "IF EXISTS ONLY "]) {
        for (const table of HIGH_VOLUME_TABLES) {
          const sql = `ALTER TABLE ${header}public."${table}" ${addition};`;
          expect(check(source(sql))).toHaveLength(1);
          expect(check(source(sql.replace(table, "documents")))).toEqual([]);
          expect(
            check(source(`CREATE TABLE public."${table}" (id int); ${sql}`)),
          ).toEqual([]);
        }
      }
    }
  });

  it.each([
    "ADD PRIMARY KEY USING INDEX ready",
    "ADD CONSTRAINT key UNIQUE USING INDEX ready",
    "ADD CONSTRAINT key PRIMARY KEY USING INDEX ready",
    'ADD CONSTRAINT "key" UNIQUE USING INDEX "ready"',
    "ADD COLUMN title text DEFAULT 'UNIQUE PRIMARY KEY EXCLUDE'",
    'ADD COLUMN "unique" text',
    "ADD CHECK (id > 0)",
    "ADD CONSTRAINT fk FOREIGN KEY (id) REFERENCES documents (id)",
    "ALTER COLUMN title SET DEFAULT 'ADD UNIQUE'",
    "DROP CONSTRAINT key",
  ])("permits an ALTER action that builds no index: %s", (addition) => {
    expect(
      check(source(`ALTER TABLE case_law_decisions ${addition};`)),
    ).toEqual([]);
  });

  it("preserves named constraint ownership for later reindexing", () => {
    for (const constraint of [
      "UNIQUE (id)",
      "PRIMARY KEY (id)",
      "EXCLUDE USING gist (id WITH =)",
    ]) {
      expect(
        check(
          source(
            `ALTER TABLE documents ADD CONSTRAINT key ${constraint}; REINDEX INDEX key;`,
          ),
        ),
      ).toEqual([]);
      expect(
        check(
          source(
            `ALTER TABLE case_law_decisions ADD CONSTRAINT key ${constraint}; REINDEX INDEX key;`,
          ),
        ),
      ).toHaveLength(2);
    }
  });

  it("ignores deferred and masked ADDs while scanning executable bodies", () => {
    const sql = "ALTER TABLE case_law_decisions ADD UNIQUE (id);";
    expect(
      check(
        source(
          `-- ${sql}\nSELECT '${sql}'; CREATE FUNCTION later() RETURNS void LANGUAGE plpgsql AS $$ BEGIN ${sql} END $$;`,
        ),
      ),
    ).toEqual([]);
    expect(check(source(`DO $$ BEGIN ${sql} END $$;`))).toHaveLength(1);
    expect(check(source(`DO $$ BEGIN EXECUTE '${sql}'; END $$;`))).toHaveLength(
      1,
    );
    expect(
      check(
        source(
          "DO $$ BEGIN EXECUTE format('ALTER TABLE %I ADD UNIQUE (id)', target); END $$;",
        ),
      ),
    ).toHaveLength(1);
  });

  it("keeps renamed high-volume tables subject to ADD checks", () => {
    expect(
      check(
        source(
          "ALTER TABLE case_law_decisions RENAME TO renamed; ALTER TABLE renamed ADD UNIQUE (id);",
        ),
      ),
    ).toHaveLength(1);
  });
});

describe("uppercase hexadecimal digits in executable E strings", () => {
  it.each(["N", String.raw`\x4E`, String.raw`\u004E`, String.raw`\U0000004E`])(
    "decodes %s before checking index builds",
    (escapedN) => {
      expect(
        check(
          source(
            `DO E'BEGIN CREATE I${escapedN}DEX idx ON case_law_decisions (id); END';`,
          ),
        ),
      ).toHaveLength(1);
      expect(
        check(
          source(
            `DO E'BEGIN CREATE I${escapedN}DEX idx ON documents (id); END';`,
          ),
        ),
      ).toEqual([]);
    },
  );
});
