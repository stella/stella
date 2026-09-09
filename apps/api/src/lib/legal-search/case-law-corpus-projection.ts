import { type SQL, sql } from "drizzle-orm";

import { caseLawDecisions, corpusIndexProjectionStates } from "@/api/db/schema";
import { caseLawIndexIdSql } from "@/api/lib/legal-search/case-law-index-groups";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";

const CASE_LAW_FAMILY = "case_law" satisfies CorpusFamily;

/** The physical index this generation projects a decision's current country into. */
export const caseLawDecisionCorpusIndexIdSql = (generation: string) =>
  caseLawIndexIdSql(sql`${generation}`, caseLawDecisions.country);

/**
 * Accept a physical hit only when this generation recorded the current
 * decision in its current jurisdiction and has no queued mutation.
 *
 * Applied equals desired on every field that can change what is served, and
 * the applied revision sits in the index this generation routes the decision's
 * current country to. A queued mutation moves desired ahead of applied, and a
 * queued erasure leaves `desired_fingerprint` null, so neither is accepted. No
 * row at all means the generation does not hold the decision.
 *
 * The lookup is the states table's primary key, `(family, generation,
 * entity_id)`, once per candidate row.
 */
export const currentCaseLawCorpusProjection = (generation: string): SQL =>
  sql`EXISTS (
      SELECT 1
      FROM ${corpusIndexProjectionStates}
      WHERE ${corpusIndexProjectionStates.family} = ${CASE_LAW_FAMILY}
        AND ${corpusIndexProjectionStates.generation} = ${generation}
        AND ${corpusIndexProjectionStates.entityId} = ${caseLawDecisions.id}
        AND ${corpusIndexProjectionStates.desiredAction} = 'upsert'
        AND ${corpusIndexProjectionStates.appliedAction} = 'upsert'
        AND ${corpusIndexProjectionStates.appliedEpoch} = ${corpusIndexProjectionStates.desiredEpoch}
        AND ${corpusIndexProjectionStates.appliedFingerprint} = ${corpusIndexProjectionStates.desiredFingerprint}
        AND ${corpusIndexProjectionStates.appliedIndexId} = ${corpusIndexProjectionStates.desiredIndexId}
        AND ${corpusIndexProjectionStates.appliedIndexId} = (${caseLawDecisionCorpusIndexIdSql(generation)})
    )`;
