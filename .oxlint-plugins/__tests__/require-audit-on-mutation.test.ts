import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

const RULE = "require-audit-on-mutation";
const SOURCE_PATH = "apps/api/src/lib/sample-store.ts";

// Two owners: `saveRow` writes twice inside an anonymous transaction
// callback, `clearRows` writes once.
const source = `
type Writer = { insert: (value: unknown) => void; delete: (value: unknown) => void };
declare const db: { transaction: (run: (tx: Writer) => void) => void };

export const saveRow = () => {
  db.transaction((tx) => {
    tx.insert({ id: "one" });
    tx.insert({ id: "two" });
  });
};

export function clearRows(tx: Writer) {
  tx.delete({});
}
`;

const lint = async (budgets: Record<string, number> | null) =>
  await lintSingleRule(RULE, source, {
    sourcePath: SOURCE_PATH,
    ...(budgets === null
      ? {}
      : {
          ruleOptionsForRoot: (root: string) => ({
            budgets: Object.fromEntries(
              Object.entries(budgets).map(([owner, writes]) => [
                `${SOURCE_PATH}::${owner}`,
                writes,
              ]),
            ),
            root,
          }),
        }),
  });

describe("require-audit-on-mutation ledger budgets", () => {
  test("a file without ledger rows is held to the full rule", async () => {
    expect(await lint(null)).toEqual([7, 8, 13]);
  });

  test("owners at their budget pass, keyed by the nearest named function", async () => {
    expect(await lint({ saveRow: 2, clearRows: 1 })).toEqual([]);
  });

  test("an owner over its budget reports every write it holds", async () => {
    expect(await lint({ saveRow: 1, clearRows: 1 })).toEqual([7, 8]);
  });

  test("an owner the ledger does not name has no budget", async () => {
    expect(await lint({ saveRow: 2 })).toEqual([13]);
  });

  test("a budget above the current count is reported as stale", async () => {
    expect(await lint({ saveRow: 3, clearRows: 1 })).toHaveLength(1);
  });
});
