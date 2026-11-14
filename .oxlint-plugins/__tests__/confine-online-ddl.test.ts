import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { lintSingleRule } from "./lint-single-rule.ts";

const RULE = "confine-online-ddl";
/** A template interpolation in the linted source, spelled without one here. */
const slot = (expression: string) => ["$", "{", expression, "}"].join("");
const lint = async (
  source: string,
  sourcePath = "apps/api/src/db/example-repair.ts",
) => await lintSingleRule(RULE, source, { sourcePath, cwd: "scratch" });

describe(RULE, () => {
  test("rejects every table-locking statement spelled in a database module", async () => {
    expect(
      await lint(
        [
          'await connection.execute(`ALTER TABLE public."t" VALIDATE CONSTRAINT "c"`);',
          'await connection.execute("DROP INDEX CONCURRENTLY IF EXISTS public.x");',
          "await connection.execute(`CREATE UNIQUE INDEX CONCURRENTLY x ON t (id)`);",
          'await connection.execute("REINDEX INDEX CONCURRENTLY public.x");',
          "await connection.execute(`ALTER INDEX public.x RENAME TO y`);",
          'await connection.execute("LOCK TABLE public.t IN SHARE MODE");',
          `await connection.execute(\`ANALYZE ${slot("table")}\`);`,
          `await tx.execute(sql\`alter table ${slot("table")} validate constraint ${slot("name")}\`);`,
          `const statement = \`ALTER TABLE ${slot("table")}\n  VALIDATE CONSTRAINT ${slot("name")}\`;`,
        ].join("\n"),
      ),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test("rejects policy and row-level security DDL, and calls to declared DDL functions", async () => {
    expect(
      await lint(
        [
          'await connection.execute(`DROP POLICY IF EXISTS "p" ON public."t"`);',
          `await connection.execute(\`CREATE POLICY p ON ${slot("table")} USING (true)\`);`,
          "await connection.execute('alter policy p on t using (false)');",
          'await connection.execute(`ALTER TABLE "t" ENABLE ROW LEVEL SECURITY`);',
          `const force = \`${slot("prefix")} FORCE ROW LEVEL SECURITY\`;`,
          'await connection.execute("SELECT public.entity_feature_gate_finish()");',
          "const call = `SELECT entity_feature_gate_finish ()`;",
        ].join("\n"),
      ),
    ).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  test("names a declared DDL function without calling it, and policy prose, freely", async () => {
    expect(
      await lint(
        [
          "await connection.query(\"SELECT to_regproc('public.entity_feature_gate_finish') IS NOT NULL\");",
          'const reason = "the policy replacement waits for its table";',
          "await connection.query(\"SELECT qual FROM pg_policies WHERE policyname = 'p'\");",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("a keyword split by an interpolation or a comment still reads whole", async () => {
    expect(
      await lint(
        [
          `const a = \`ALTER ${slot("'TABLE'")} public.t VALIDATE CONSTRAINT c\`;`,
          'const b = "DROP /* inline */ INDEX x";',
          // Only the interpolated keyword makes this one table-locking.
          `const c = \`ALTER ${slot("'TABLE'")} public.t ADD COLUMN x integer\`;`,
        ].join("\n"),
      ),
    ).toEqual([1, 2, 3]);
  });

  test("accepts reads, row writes, session settings and prose", async () => {
    expect(
      await lint(
        [
          'await connection.query("SELECT convalidated FROM pg_constraint WHERE conname = $1", [name]);',
          'await connection.execute("UPDATE public.t SET a = 1 WHERE id = $1", [id]);',
          "await connection.execute(\"SET lock_timeout = '1s'\");",
          'panic("Required migration index x has reindex artifacts");',
          'const reason = "analyze the table before the cutover";',
          'await connection.execute("SELECT pg_advisory_lock(1)");',
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("lowercase maintenance statements and escaped newlines read as SQL", async () => {
    expect(
      await lint(
        [
          'await connection.execute("reindex index concurrently public.x");',
          'await connection.execute("analyze public.t");',
          'await connection.execute("vacuum verbose \\"t\\"");',
          "await connection.execute(`DROP\\nINDEX CONCURRENTLY public.x`);",
          `await connection.execute(\`analyze ${slot("table")}\`);`,
          'const reason = "reindex artifacts are dropped first";',
          'const reason2 = "analyze the table before the cutover";',
        ].join("\n"),
      ),
    ).toEqual([1, 2, 3, 4, 5]);
  });

  test("an index declaration's createSql is exempt, and reading it is the violation", async () => {
    expect(
      await lint(
        [
          "export const INDEXES = [",
          "  {",
          '    createSql: \'CREATE INDEX CONCURRENTLY "x" ON public."t" USING btree (id)\',',
          "    name: 'x',",
          "  },",
          `  { createSql: \`CREATE INDEX CONCURRENTLY "y" ON public."${slot("table")}" (id)\` },`,
          "];",
          "await connection.execute(index.createSql);",
          "const { createSql } = index;",
          'await connection.execute(index["createSql"]);',
          "const other = { sql: 'CREATE INDEX CONCURRENTLY z ON t (id)' };",
        ].join("\n"),
      ),
    ).toEqual([8, 9, 10, 11]);
  });

  test("only the owner opens the gate, and only tests run work ungated", async () => {
    const source = [
      'import { createOnlineIndexGate } from "./online-index-gate";',
      'import { createUngatedTableGateForTests as ungated } from "./online-ddl";',
      'import { runGatedTableWork, validateOnlineConstraints } from "./online-ddl";',
    ].join("\n");
    expect(await lint(source)).toEqual([1, 2]);
    expect(await lint(source, "apps/api/src/scripts/backfill.ts")).toEqual([
      1, 2,
    ]);
  });

  test("a namespace import does not open the gate either", async () => {
    expect(
      await lint(
        [
          'import * as gate from "./online-index-gate";',
          "const runtime = gate.createOnlineIndexGate(options);",
          'const ungated = gate["createUngatedTableGateForTests"];',
          "const { createOnlineIndexGate: open } = gate;",
          'const { createUngatedTableGateForTests } = await import("./online-ddl");',
        ].join("\n"),
      ),
    ).toEqual([2, 3, 4, 5]);
  });

  test("a re-export cannot hand out a gate opener", async () => {
    expect(
      await lint(
        'export { createOnlineIndexGate } from "./online-index-gate";',
      ),
    ).toEqual([1]);
  });

  test("the owner, tests, fixtures and the schema phase are out of scope", async () => {
    const source = [
      'import { createOnlineIndexGate } from "./online-index-gate";',
      'await connection.execute("DROP INDEX CONCURRENTLY public.x");',
      "await connection.execute(index.createSql);",
    ].join("\n");
    const results = await Promise.all(
      [
        "apps/api/src/db/online-ddl.ts",
        "apps/api/src/db/online-migrations.test.ts",
        "apps/api/src/db/__fixtures__/example.ts",
        "apps/api/src/tests/helpers/example.ts",
      ].map(async (lintCase, index) => {
        const sourcePath = lintCase;

        return {
          label: `case ${index + 1}: ${JSON.stringify(lintCase)}`,
          result: await lint(source, sourcePath),
          expected: [],
        };
      }),
    );
    expect(results.map(({ label, result }) => ({ label, result }))).toEqual(
      results.map(({ label, expected }) => ({ label, result: expected })),
    );
    // The schema phase keeps its ledger DDL; the gate stays confined there too.
    expect(await lint(source, "apps/api/src/db/migration-runner.ts")).toEqual([
      1, 3,
    ]);
  });

  test("SQL text outside the database modules is another owner's concern", async () => {
    expect(
      await lint(
        'await tx.execute(`ALTER TABLE public."t" VALIDATE CONSTRAINT "c"`);',
        "apps/api/src/lib/scheduler/tasks/example.ts",
      ),
    ).toEqual([]);
  });

  test("the planted fixture reports each suppressed case and nothing else", async () => {
    const source = readFileSync(
      new URL("../__fixtures__/confine-online-ddl.fixture.ts", import.meta.url),
      "utf-8",
    ).replaceAll(/^\/\/ oxlint-disable-next-line .*\n/gmu, "");
    expect(await lint(source)).toHaveLength(3);
  });
});
