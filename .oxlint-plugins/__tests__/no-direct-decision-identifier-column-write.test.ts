import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const RULE = "no-direct-decision-identifier-column-write";
const IMPORT =
  'import { caseLawDecisions as decisions } from "@/api/db/schema";';
const OTHER_WRITER =
  "apps/api/src/handlers/case-law/ingestion/identifier-reconciliation.ts";

const lint = async (statements: readonly string[], sourcePath = OTHER_WRITER) =>
  await lintSingleRule(RULE, [IMPORT, ...statements, ""].join("\n"), {
    sourcePath,
  });

describe("decision identifier column ownership", () => {
  test("rejects direct and destructured identifier updates outside the owner", async () => {
    expect(
      await lint([
        'db.update(decisions).set({ ecli: "ECLI:CZ:TEST:1" });',
        'db.update(decisions).set({ caseNumber: "1 Test 1" });',
        "const { ecli, caseNumber } = payload;",
        "db.update(decisions).set({ ecli, caseNumber });",
      ]),
    ).toEqual([2, 3, 5]);
  });

  test("allows other columns, the owner, and isolated test fixtures", async () => {
    const identifierWrite =
      'db.update(decisions).set({ ecli: "ECLI:CZ:TEST:1" });';
    expect(
      await lint(['db.update(decisions).set({ court: "Test court" });']),
    ).toEqual([]);
    expect(
      await lint(
        [identifierWrite],
        "apps/api/src/handlers/case-law/ingestion/pipeline/decision-row.ts",
      ),
    ).toEqual([]);
    expect(
      await lint(
        [identifierWrite],
        "apps/api/src/handlers/case-law/ingestion/identifier-reconciliation.test.ts",
      ),
    ).toEqual([]);
  });
});
