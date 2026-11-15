import { inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Transaction } from "@/api/db/root";
import { caseLawDecisions, publishedCaseLawDecisions } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  type CaseLawRankingSignals,
  citationAuthorityBucket,
} from "@/api/lib/legal-search/case-law-ranking-signals";

/**
 * The one loader of the ranking signals a case-law projection input carries.
 * The canonical lock read, the batched material read, the bootstrap walk and
 * every caller deriving a descriptor outside this repository call it, so they
 * derive the same signals from the same rows, and a batch of decisions costs
 * one statement, not one per decision.
 *
 * The shared-group bit asks the question the per-search read asked: does
 * another published decision carry this language group key. It is answered
 * here once per projection rather than once per search, by the language group
 * index, and a decision without a key shares no group.
 *
 * A decision the read does not find has no entry: a caller holding the row
 * locked can treat that as a broken invariant, and one that read the row
 * without a lock as a row that disappeared since.
 */
export const readCaseLawRankingSignals = async (
  tx: Transaction,
  decisionIds: readonly SafeId<"caseLawDecision">[],
): Promise<ReadonlyMap<string, CaseLawRankingSignals>> => {
  if (decisionIds.length === 0) {
    return new Map();
  }
  // Drizzle renders the columns of a one-table select unqualified, and an
  // unqualified column inside the sibling subquery is the sibling's own. The
  // subject is therefore aliased and named in full there.
  const subject = alias(caseLawDecisions, "subject");
  const rows = await tx
    .select({
      id: subject.id,
      citationAuthority: subject.citationAuthority,
      languageGroupKey: subject.languageGroupKey,
      languageGroupShared:
        sql<boolean>`(subject.language_group_key IS NOT NULL AND EXISTS (
        SELECT 1
        FROM ${publishedCaseLawDecisions} sibling
        WHERE sibling.language_group_key = subject.language_group_key
          AND sibling.id <> subject.id
      ))`.as("language_group_shared"),
    })
    .from(subject)
    .where(inArray(subject.id, [...decisionIds]))
    .limit(decisionIds.length);
  const signals = new Map<string, CaseLawRankingSignals>();
  for (const row of rows) {
    signals.set(String(row.id), {
      citationAuthorityBucket: citationAuthorityBucket(row.citationAuthority),
      languageGroupKey: row.languageGroupKey,
      languageGroupShared: row.languageGroupShared,
    });
  }
  return signals;
};
