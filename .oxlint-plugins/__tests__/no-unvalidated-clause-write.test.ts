import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const RULE_NAME = "no-unvalidated-clause-write";
const imports = [
  'import { insertClauseVariants as insertVariants } from "./variant-insert";',
  'import * as variants from "./variant-insert";',
  'import { validateClauseBodyDirectives, inspectLegacyClauseDirectives } from "@/api/lib/clauses/clause-directives";',
].join("\n");

for (const call of [
  "insertVariants(input)",
  "variants.insertClauseVariants(input)",
]) {
  test(`variant insertion requires validation: ${call}`, async () => {
    const sourcePath = "apps/api/src/handlers/clauses/variants.ts";
    expect(
      await lintSingleRule(
        RULE_NAME,
        `${imports}\nconst write = () => ${call};`,
        { sourcePath },
      ),
    ).toEqual([4]);
    expect(
      await lintSingleRule(
        RULE_NAME,
        `${imports}\nconst write = function* () { yield* validateClauseBodyDirectives(body); return ${call}; };`,
        { sourcePath },
      ),
    ).toEqual([]);
    expect(
      await lintSingleRule(
        RULE_NAME,
        `${imports}\nconst write = function* () { yield* validateClauseBodyDirectives(body); return ${call}; };`,
        { sourcePath: "apps/api/src/lib/other-writer.ts" },
      ),
    ).toEqual([4]);
    expect(
      await lintSingleRule(
        RULE_NAME,
        `${imports}\nconst write = () => { inspectLegacyClauseDirectives(body, metadata); return ${call}; };`,
        { sourcePath: "apps/api/src/handlers/clauses/import.ts" },
      ),
    ).toEqual([]);
  });
}

test("the locked insertion owner accepts bodies checked by its callers", async () => {
  const source =
    'import { clauseVariants } from "@/api/db/schema";\nconst write = () => tx.insert(clauseVariants);';
  expect(
    await lintSingleRule(RULE_NAME, source, {
      sourcePath: "apps/api/src/handlers/clauses/variant-insert.ts",
    }),
  ).toEqual([]);
  expect(
    await lintSingleRule(RULE_NAME, source, {
      sourcePath: "apps/api/src/lib/other-writer.ts",
    }),
  ).toEqual([2]);
});
