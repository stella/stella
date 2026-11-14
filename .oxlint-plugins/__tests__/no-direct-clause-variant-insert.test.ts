import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const RULE_NAME = "no-direct-clause-variant-insert";
const SOURCE = [
  'import { clauseVariants as variants } from "@/api/db/schema";',
  'import * as schema from "@/api/db/schema/clauses";',
  "const tx = { insert: (table: unknown) => table };",
  "tx.insert(variants);",
  "const alias = schema.clauseVariants;",
  "tx.insert(alias);",
].join("\n");

const lint = async (sourcePath: string) =>
  await lintSingleRule(RULE_NAME, SOURCE, { sourcePath });

describe.serial("clause variant insertion ownership", () => {
  test("blocks aliases in handlers, background jobs and native tools", async () => {
    const results = await Promise.all(
      [
        "apps/api/src/handlers/clauses/import.ts",
        "apps/api/src/lib/jobs/import-clauses.ts",
        "apps/api/src/mcp/import-clauses.ts",
      ].map(async (lintCase, index) => {
        const sourcePath = lintCase;

        return {
          label: `case ${index + 1}: ${JSON.stringify(lintCase)}`,
          result: await lint(sourcePath),
          expected: [4, 6],
        };
      }),
    );
    expect(results.map(({ label, result }) => ({ label, result }))).toEqual(
      results.map(({ label, expected }) => ({ label, result: expected })),
    );
  });

  test("allows the transaction owner and direct fixture seeding", async () => {
    const results = await Promise.all(
      [
        "apps/api/src/handlers/clauses/variant-insert.ts",
        "apps/api/src/handlers/clauses/variants.postgres.test.ts",
        "apps/api/src/tests/security/rls-helpers.ts",
      ].map(async (lintCase, index) => {
        const sourcePath = lintCase;

        return {
          label: `case ${index + 1}: ${JSON.stringify(lintCase)}`,
          result: await lint(sourcePath),
          expected: [],
        };
      }),
    );
    expect(results.map(({ label, result }) => ({ label, result }))).toEqual(
      results.map(({ label, expected }) => ({ label, result: expected })),
    );
  });
});
