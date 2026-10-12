import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { citationEvidenceFieldsFrom } from "../citation-evidence-text-fence.ts";
import { lintSingleRule } from "./lint-single-rule.ts";

test("citation evidence writers require an invoked owner fence", async () => {
  const fixture = readFileSync(
    new URL(
      "../__fixtures__/citation-evidence-text-fence.fixture.ts",
      import.meta.url,
    ),
    "utf-8",
  );
  const expected = fixture
    .split("\n")
    .flatMap((line, index) =>
      line.includes("oxlint-disable-next-line citation-evidence-text-fence/")
        ? [index + 2]
        : [],
    );
  const source = fixture.replaceAll(/^.*oxlint-disable-next-line.*$/gmu, "");
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

test("citation evidence accepts fenced writes and clearing derived fields", async () => {
  const source = [
    'import { caseLawCitations } from "@/api/db/schema";',
    'import { runCitationGraphTransaction } from "@/api/handlers/case-law/citation-graph-transaction";',
    'import { citationTextRevisionFence } from "@/api/lib/case-law/text-revision";',
    "export const persist = (transaction, evidence) => runCitationGraphTransaction(transaction, (tx) => tx.update(caseLawCitations).set({ polarityEvidenceWindows: evidence.windows }).where(citationTextRevisionFence(evidence.revision)));",
    "export const clear = (tx) => tx.update(caseLawCitations).set({ polarityEvidenceWindows: null, polarityConfidence: null, citedPart: 'not-stated' });",
  ].join("\n");
  expect(
    await lintSingleRule("citation-evidence-text-fence", source, {
      sourcePath: "apps/api/src/handlers/case-law/polarity/example.ts",
    }),
  ).toEqual([]);
});

test("citation evidence field discovery follows the schema-owned group", () => {
  const source = (physicalName: string) => `
    import { jsonb, pgTable, text } from "drizzle-orm/pg-core";
    const citationTextEvidenceColumns = {
      polarityEvidenceWindows: jsonb("${physicalName}"),
      polarityConfidence: jsonb("polarity_confidence"),
    };
    export const caseLawCitations = pgTable("case_law_citations", {
      citationText: text("citation_text"),
      ...citationTextEvidenceColumns,
    });
  `;
  expect(
    citationEvidenceFieldsFrom(source("polarity_evidence_windows")),
  ).toEqual({
    drizzle: new Set(["polarityEvidenceWindows", "polarityConfidence"]),
    sql: new Set(["polarity_evidence_windows", "polarity_confidence"]),
  });
  expect(citationEvidenceFieldsFrom(source("evidence_windows_v2"))).toEqual({
    drizzle: new Set(["polarityEvidenceWindows", "polarityConfidence"]),
    sql: new Set(["evidence_windows_v2", "polarity_confidence"]),
  });
});

test("citation evidence field discovery rejects a disconnected schema group", () => {
  const source = `
    import { jsonb, pgTable } from "drizzle-orm/pg-core";
    const citationTextEvidenceColumns = {
      polarityEvidenceWindows: jsonb("polarity_evidence_windows"),
    };
    export const caseLawCitations = pgTable("case_law_citations", {});
  `;
  expect(() => citationEvidenceFieldsFrom(source)).toThrow(
    "citationTextEvidenceColumns is not spread into caseLawCitations",
  );
});

test("synthetic citation fixtures stay outside the production writer guard", async () => {
  const source = [
    'import { sql } from "drizzle-orm";',
    'import { caseLawCitations } from "@/api/db/schema";',
    "export const seed = (tx, rows) => tx.insert(caseLawCitations).values(rows);",
    "export const rawSeed = (tx) => tx.execute(sql`INSERT INTO case_law_citations (citation_text) VALUES ('fixture')`);",
  ].join("\n");
  for (const sourcePath of [
    "apps/api/src/tests/security/public-law-search-census.ts",
    "apps/api/src/tests/query-plans/seed.ts",
  ]) {
    expect(
      await lintSingleRule("citation-evidence-text-fence", source, {
        sourcePath,
      }),
    ).toEqual([]);
  }
});
