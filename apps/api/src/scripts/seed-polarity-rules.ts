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
  // oxlint-disable-next-line no-await-in-loop -- sequential seeding preserves upsert order across rules
  await rootDb
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
      // `source` is part of the state being seeded, not incidental metadata:
      // the rule loader reads `manual` and `llm-promoted` only, so a seed that
      // collided with an `llm-proposed` rule of the same pattern and language
      // used to leave it excluded — a successful run that changed nothing a
      // classifier would ever see. The insert and the update have to establish
      // the same row.
      set: { polarity: rule.polarity, confidence: 1, source: "manual" },
    });
}

/** Rows reset per statement; bounded so the lock never spans the table. */
const RESET_BATCH = 5000;

let resetTotal = 0;
if (RETIRED_SEED_RULES.length > 0) {
  const retired = await rootDb
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
    .returning({ id: caseLawPolarityRules.id });

  // A retired rule's verdicts go with it: the citations it labelled return
  // to the unclassified pool, and `scripts/classify-citations.ts` reads them
  // again under the rules that remain. Left in place, a withdrawn rule would
  // keep speaking through every row it ever touched.
  const retiredIds = retired.map((rule) => rule.id);
  if (retiredIds.length > 0) {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- bounded batches, each its own short statement
      const reset = await rootDb
        .update(caseLawCitations)
        .set({ polarity: null, polarityRuleId: null })
        .where(
          sql`${caseLawCitations.id} IN (
            SELECT ${caseLawCitations.id} FROM ${caseLawCitations}
            WHERE ${inArray(caseLawCitations.polarityRuleId, retiredIds)}
            LIMIT ${RESET_BATCH}
          )`,
        )
        .returning({ id: caseLawCitations.id });
      resetTotal += reset.length;
      if (reset.length < RESET_BATCH) {
        break;
      }
    }
  }
}

console.log(
  `Done. ${SEED_RULES.length} rules upserted, ${RETIRED_SEED_RULES.length} retired, ${resetTotal} citations returned to the unclassified pool.`,
);
if (resetTotal > 0) {
  console.log(
    "Next: bun apps/api/scripts/classify-citations.ts, then bun apps/api/src/scripts/backfill-citation-authority.ts.",
  );
}

process.exit(0);
