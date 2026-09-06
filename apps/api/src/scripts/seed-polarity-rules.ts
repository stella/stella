/**
 * Load the hand-written polarity rules into `case_law_polarity_rules`.
 *
 * Idempotent: each rule is keyed on `(pattern, language)`, so re-running
 * updates the polarity a rule asserts rather than accumulating duplicates of
 * it, and rules listed as retired are marked so rather than deleted, with the
 * citations they labelled returned to the unclassified pool. Run after
 * changing `polarity/seed-rules.ts`; nothing else writes rows with
 * `source = 'manual'`.
 *
 *   bun apps/api/src/scripts/seed-polarity-rules.ts
 */

import { and, eq, inArray, or, sql } from "drizzle-orm";
import { tmpdir } from "node:os";
import path from "node:path";

import { caseLawCitations, caseLawPolarityRules } from "@/api/db/schema";
import { RULE_SOURCE } from "@/api/handlers/case-law/polarity/consts";
import {
  RETIRED_SEED_RULES,
  SEED_RULES,
} from "@/api/handlers/case-law/polarity/seed-rules";
import { enterCaseLawMaintenanceLane } from "@/api/lib/case-law/maintenance-lane";

// Hold the maintenance lane before the first statement: operator passes over
// the case-law tables serialize here instead of deadlocking on row locks.
const { rootDb } = await enterCaseLawMaintenanceLane();

console.log(`Seeding ${SEED_RULES.length} polarity rules...`);

for (const rule of SEED_RULES) {
  // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- constant seed list
  await rootDb.transaction(async (tx) => {
    await tx
      .insert(caseLawPolarityRules)
      .values({
        pattern: rule.pattern,
        polarity: rule.polarity,
        language: rule.language,
        source: "manual",
        confidence: 1,
      })
      .onConflictDoUpdate({
        target: [caseLawPolarityRules.pattern, caseLawPolarityRules.language],
        // `source` is part of the state being seeded, not incidental
        // metadata: the rule loader reads `manual` and `llm-promoted` only,
        // so a seed that collided with an `llm-proposed` rule of the same
        // pattern and language used to leave it excluded — a successful run
        // that changed nothing a classifier would ever see. The insert and
        // the update have to establish the same row.
        set: { polarity: rule.polarity, confidence: 1, source: "manual" },
      });
  });
}

/** Rows reset per statement; bounded so the lock never spans the table. */
const RESET_BATCH = 5000;

let resetIds: string[] = [];
if (RETIRED_SEED_RULES.length > 0) {
  const retired = await rootDb.transaction(
    async (tx) =>
      await tx
        .update(caseLawPolarityRules)
        .set({ source: RULE_SOURCE.RETIRED })
        .where(
          or(
            ...RETIRED_SEED_RULES.map((rule) =>
              and(
                eq(caseLawPolarityRules.pattern, rule.pattern),
                eq(caseLawPolarityRules.language, rule.language),
              ),
            ),
          ),
        )
        .returning({ id: caseLawPolarityRules.id }),
  );

  // A retired rule's verdicts go with it: the citations it labelled return
  // to the unclassified pool, and `scripts/classify-citations.ts` reads them
  // again under the rules that remain. Left in place, a withdrawn rule would
  // keep speaking through every row it ever touched.
  const retiredIds = retired.map((rule) => rule.id);
  const resetBatch = async (): Promise<string[]> => {
    const reset = await rootDb.transaction(
      async (tx) =>
        await tx
          .update(caseLawCitations)
          .set({ polarity: null, polarityRuleId: null })
          .where(
            sql`${caseLawCitations.id} IN (
              SELECT ${caseLawCitations.id} FROM ${caseLawCitations}
              WHERE ${inArray(caseLawCitations.polarityRuleId, retiredIds)}
              LIMIT ${RESET_BATCH}
            )`,
          )
          .returning({ id: caseLawCitations.id }),
    );
    const ids = reset.map((row) => row.id);
    return reset.length < RESET_BATCH ? ids : [...ids, ...(await resetBatch())];
  };
  if (retiredIds.length > 0) {
    resetIds = await resetBatch();
  }
}

console.log(
  `Done. ${SEED_RULES.length} rules upserted, ${RETIRED_SEED_RULES.length} retired, ${resetIds.length} citations returned to the unclassified pool.`,
);
if (resetIds.length > 0) {
  // The classifier walks the newest unclassified rows first and stops at a
  // limit; the reset rows are old and would wait behind the backlog. Their
  // ids go to a file the classifier can be pointed at, so the pass that
  // follows consumes exactly this set.
  const resetFile = path.join(tmpdir(), `polarity-reset-${Date.now()}.json`);
  await Bun.write(resetFile, JSON.stringify(resetIds));
  console.log(
    `Next: bun apps/api/scripts/classify-citations.ts --ids ${resetFile}, then bun apps/api/src/scripts/backfill-citation-authority.ts.`,
  );
}

process.exit(0);
