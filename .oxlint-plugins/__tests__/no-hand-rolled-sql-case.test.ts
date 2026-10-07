import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects generated branches in searched and simple cases", async () => {
  expect(
    await lintSingleRule(
      "no-hand-rolled-sql-case",
      `const a = sql\`CASE \${branches.join(" ")} ELSE 1 END\`;\nconst b = sql\`CASE \${table.id} \${sql.join(branches, sql.raw(" "))} ELSE \${col} END\`;`,
      { sourcePath: "apps/api/src/lib/ranking.ts" },
    ),
  ).toEqual([1, 2]);
});

test("rejects plain templates and spread generated lists", async () => {
  expect(
    await lintSingleRule(
      "no-hand-rolled-sql-case",
      `const a = \`CASE \${entries.map(toBranch).join("\\n")} ELSE \${fallback} END\`;\nconst b = sql.raw(\`CASE \${[...branches].join(" ")} ELSE 1 END\`);`,
      { sourcePath: "apps/api/src/lib/ranking.ts" },
    ),
  ).toEqual([1, 2]);
});

test("accepts explicit branches and canonical rendering helpers", async () => {
  expect(
    await lintSingleRule(
      "no-hand-rolled-sql-case",
      `const a = sql\`CASE WHEN \${cond} THEN 1 ELSE 0 END\`;\nconst b = sql\`CASE \${col} WHEN 'a' THEN 1 ELSE 0 END\`;\nsqlCaseFragment({ branches: rows.map(toBranch), fallback: sql\`\${col}\` });`,
      { sourcePath: "apps/api/src/lib/ranking.ts" },
    ),
  ).toEqual([]);
});

test("ignores keywords in SQL strings comments and quoted bodies", async () => {
  expect(
    await lintSingleRule(
      "no-hand-rolled-sql-case",
      `const a = sql\`SELECT 'CASE', \${cols.join(", ")} WHERE m = 'END'\`;\nconst b = sql\`SELECT /* CASE */ \${cols.join(", ")} /* END */\`;\nconst c = sql\`SELECT $tag$CASE END$tag$, \${cols.join(", ")}\`;`,
      { sourcePath: "apps/api/src/lib/ranking.ts" },
    ),
  ).toEqual([]);
});

test("accepts the renderer owner but not a matching basename elsewhere", async () => {
  expect(
    await lintSingleRule(
      "no-hand-rolled-sql-case",
      `const a = sql\`CASE \${branches.join(" ")} ELSE 1 END\`;`,
      { sourcePath: "apps/api/src/lib/sql-case-expression.ts" },
    ),
  ).toEqual([]);
});

test("keeps renderer copies outside the owner confined", async () => {
  expect(
    await lintSingleRule(
      "no-hand-rolled-sql-case",
      `const a = sql\`CASE \${branches.join(" ")} ELSE 1 END\`;`,
      { sourcePath: "apps/api/src/other/sql-case-expression.ts" },
    ),
  ).toEqual([1]);
});

test("rejects direct spread branch arrays independently of join calls", async () => {
  expect(
    await lintSingleRule(
      "no-hand-rolled-sql-case",
      `const expression = sql\`CASE \${[...branches]} ELSE 1 END\`;`,
      { sourcePath: "apps/api/src/lib/ranking.ts" },
    ),
  ).toEqual([1]);
});
