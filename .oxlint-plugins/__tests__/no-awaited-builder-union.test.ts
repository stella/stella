import { expect, test } from "bun:test";

import { lintSingleRule, runSingleRule } from "./lint-single-rule.ts";

test("rejects prefix chain unions for identifiers instance roots and nested branches", async () => {
  expect(
    await lintSingleRule(
      "no-awaited-builder-union",
      'async function read() {\nconst a = await (lock ? query.for("update") : query);\nconst b = await (paged ? query.limit(10) : query.limit(10).offset(20));\nconst c = await (lock ? (paged ? query.limit(10) : query) : query);\nconst d = await (lock ? this.query.for("update") : this.query);\nconst e = await (lock ? buildQuery().for("update") : buildQuery());\n}',
    ),
  ).toEqual([2, 3, 4, 5, 6]);
});

test("accepts branchwise awaits distinct roots identical chains and sibling methods", async () => {
  expect(
    await lintSingleRule(
      "no-awaited-builder-union",
      'async function read() {\nconst a = lock ? await query.for("update") : await query;\nconst b = await (lock ? queryA.limit(10) : queryB.limit(10));\nconst c = await (paged ? loadRows(1) : loadRows(2));\nconst d = await (json ? response.json() : response.text());\nconst e = lock ? query.for("update") : query;\n}',
    ),
  ).toEqual([]);
});

test("retains diagnostics for assertions that cannot safely move through await", async () => {
  expect(
    await lintSingleRule(
      "no-awaited-builder-union",
      'async function read() {\nconst a = await ((lock ? query.for("update") : query) as Builder);\nconst b = await (lock ? (query.for("update") as Builder) : query);\n}',
    ),
  ).toEqual([2, 3]);
});

test("recognizes static computed keys as chain steps", async () => {
  expect(
    await lintSingleRule(
      "no-awaited-builder-union",
      'async function read() {\nconst a = await (lock ? query["for"]("update") : query);\nconst b = await (lock ? query[`for`]("update") : query);\n}',
    ),
  ).toEqual([2, 3]);
});

test("fixes simple and nested unions by awaiting each leaf branch", async () => {
  const cases = [
    {
      source: 'const rows = await (lock ? query.for("update") : query);',
      fixed: 'const rows = (lock ? await query.for("update") : await query);',
    },
    {
      source: "const rows = await (a ? (b ? query.limit(1) : query) : query);",
      fixed:
        "const rows = (a ? (b ? await query.limit(1) : await query) : await query);",
    },
  ];
  for (const { source, fixed } of cases) {
    expect(
      await runSingleRule(
        "no-awaited-builder-union",
        `async function read() {\n${source}\n}`,
        { fix: true },
      ),
    ).toEqual({
      lines: [],
      source: `async function read() {\n${fixed}\n}`,
    });
  }
});

test("keeps unsafe assertion and intervening-comment rewrites unchanged", async () => {
  for (const statement of [
    'const rows = await ((lock ? query.for("update") : query) as Builder);',
    'const rows = await (lock ? (query.for("update") as Builder) : query);',
    'const rows = await /* keep assertion context */ (lock ? query.for("update") : query);',
  ]) {
    const source = `async function read() {\n${statement}\n}`;
    expect(
      await runSingleRule("no-awaited-builder-union", source, { fix: true }),
    ).toEqual({ lines: [2], source });
  }
});
