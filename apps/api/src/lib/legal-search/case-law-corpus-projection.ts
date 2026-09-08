import { panic } from "better-result";
import { type SQL, sql } from "drizzle-orm";

import {
  caseLawCorpusIndexProjections,
  caseLawDecisions,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { caseLawIndexIdSql } from "@/api/lib/legal-search/case-law-index-groups";
import {
  type CorpusFamily,
  corpusIndexProjectionStore,
} from "@/api/lib/legal-search/corpus-generation-contract";

const CASE_LAW_FAMILY = "case_law" satisfies CorpusFamily;

/** Where this case-law generation records that it holds a decision. */
const caseLawProjectionStore = (generation: string) =>
  corpusIndexProjectionStore(CASE_LAW_FAMILY, generation);

/**
 * Join one decision to its durable state for the selected generation.
 *
 * Only a generation the per-decision projection queue builds has such a row.
 * A final-projection generation records desired and applied state in
 * `corpus_index_projection_states`, which the predicate below reads on its
 * own key, so the legacy relation is joined to nothing rather than probed for
 * an answer it never holds.
 */
export const caseLawCorpusProjectionJoin = (generation: string): SQL => {
  const store = caseLawProjectionStore(generation);
  switch (store) {
    case "legacy_projection_row":
      return sql`${caseLawCorpusIndexProjections.decisionId} = ${caseLawDecisions.id}
    AND ${caseLawCorpusIndexProjections.generation} = ${generation}`;
    case "projection_state":
      return sql`false`;
    default:
      store satisfies never;
      return panic(`Unhandled case-law projection store: ${String(store)}`);
  }
};

/** The physical index this generation projects a decision's current country into. */
export const caseLawDecisionCorpusIndexIdSql = (generation: string) =>
  caseLawIndexIdSql(sql`${generation}`, caseLawDecisions.country);

/**
 * The state row a final-projection generation keeps for the decision, in the
 * one shape that means "the engine holds this content now".
 *
 * Applied equals desired on every field that can change what is served, and
 * the applied revision sits in the index this generation routes the decision's
 * current country to. A queued mutation moves desired ahead of applied, and a
 * queued erasure leaves `desired_fingerprint` null, so neither is accepted. No
 * row at all means the generation does not hold the decision: unlike the
 * legacy shape, there is no marker on the decision to fall back to, and one
 * would answer for a pipeline that never wrote it.
 *
 * The lookup is the states table's primary key, `(family, generation,
 * entity_id)`, once per candidate row.
 */
const currentCaseLawProjectionState = (generation: string): SQL =>
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

/**
 * Accept a physical hit only when this generation recorded the current
 * decision in its current jurisdiction and has no queued mutation.
 *
 * Which state that is read from follows the generation's store: a
 * final-projection generation answers from `corpus_index_projection_states`,
 * a legacy generation from its projection row, with the serving marker on the
 * decision for the generations that predate the projection table.
 */
export const currentCaseLawCorpusProjection = (generation: string): SQL => {
  const store = caseLawProjectionStore(generation);
  switch (store) {
    case "legacy_projection_row":
      return sql`(
    (
      ${caseLawCorpusIndexProjections.indexedHash} = ${caseLawDecisions.contentHash}
      AND ${caseLawCorpusIndexProjections.indexId} = (${caseLawDecisionCorpusIndexIdSql(generation)})
      AND ${caseLawCorpusIndexProjections.pendingAction} IS NULL
    )
    OR (
      ${caseLawCorpusIndexProjections.generation} IS NULL
      AND ${caseLawDecisions.indexedHash} = ${caseLawDecisions.contentHash}
    )
  )`;
    case "projection_state":
      return currentCaseLawProjectionState(generation);
    default:
      store satisfies never;
      return panic(`Unhandled case-law projection store: ${String(store)}`);
  }
};
