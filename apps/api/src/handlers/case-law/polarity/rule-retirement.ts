import { inArray, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { caseLawCitations } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

/** Rows reset per statement; bounded so the lock never spans the table. */
const RESET_BATCH = 5000;

type TransactionRunner = {
  transaction: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T>;
};

/**
 * Return every citation the retired rules labelled to the unclassified pool,
 * one bounded batch per transaction, and answer the ids reset.
 *
 * A reviewed citation is never selected: every writer that applies a review
 * clears the rule id, so no retired rule can be attributed to it.
 */
export const resetRetiredRuleVerdicts = async (
  db: TransactionRunner,
  retiredIds: readonly SafeId<"caseLawPolarityRule">[],
): Promise<SafeId<"caseLawCitation">[]> => {
  if (retiredIds.length === 0) {
    return [];
  }
  const reset = await db.transaction(async (tx) => {
    // audit: skip — operator rule retirement; derived labels only
    const rows = await tx
      .update(caseLawCitations)
      .set({ polarity: null, polarityRuleId: null })
      .where(
        sql`${caseLawCitations.id} IN (
          SELECT ${caseLawCitations.id} FROM ${caseLawCitations}
          WHERE ${inArray(caseLawCitations.polarityRuleId, [...retiredIds])}
          LIMIT ${RESET_BATCH}
        )`,
      )
      .returning({ id: caseLawCitations.id });
    return rows;
  });
  const ids = reset.map((row) => row.id);
  return reset.length < RESET_BATCH
    ? ids
    : [...ids, ...(await resetRetiredRuleVerdicts(db, retiredIds))];
};
