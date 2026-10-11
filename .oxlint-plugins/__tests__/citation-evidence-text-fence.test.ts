import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { lintSingleRule } from "./lint-single-rule.ts";

test("citation evidence writers require an invoked owner fence", async () => {
  const source = readFileSync(
    new URL(
      "../__fixtures__/citation-evidence-text-fence.fixture.ts",
      import.meta.url,
    ),
    "utf-8",
  ).replaceAll(/^.*oxlint-disable-next-line.*$/gmu, "");
  const lines = source.split("\n");
  const expected = lines.flatMap((line, index) =>
    line.includes(
      "tx.update(caseLawCitations).set({ polarityWindowStart: evidence.start });",
    ) ||
    line.includes(
      "tx.update(caseLawCitations).set({ polarityConfidence: evidence.start });",
    ) ||
    line.includes("UPDATE case_law_citations")
      ? [index + 1]
      : [],
  );
  expect(
    await lintSingleRule("citation-evidence-text-fence", source, {
      sourcePath: "apps/api/src/handlers/case-law/polarity/example.ts",
    }),
  ).toEqual(expected);
});

test("atomic citation publication requires its graph transaction type", async () => {
  const source = [
    'import { caseLawCitations } from "@/api/db/schema";',
    'import type { CitationGraphTransaction } from "@/api/handlers/case-law/citation-graph-transaction";',
    "export const writeDecisionCitations = (tx: CitationGraphTransaction<Transaction>, rows: unknown) => tx.insert(caseLawCitations).values(rows);",
    "export const otherWriter = (tx: CitationGraphTransaction<Transaction>, rows: unknown) => tx.insert(caseLawCitations).values(rows);",
  ].join("\n");
  expect(
    await lintSingleRule("citation-evidence-text-fence", source, {
      sourcePath:
        "apps/api/src/handlers/case-law/ingestion/pipeline/citations.ts",
    }),
  ).toEqual([4]);
});
