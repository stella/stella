import { type SQL, sql } from "drizzle-orm";

import {
  caseLawDecisions,
  corpusIndexJurisdictionServing,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { caseLawIndexIdSql } from "@/api/lib/legal-search/case-law-index-groups";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";
import type { CorpusProjectionRevision } from "@/api/lib/legal-search/corpus-index-revision-clause";

const CASE_LAW_FAMILY = "case_law" satisfies CorpusFamily;

/**
 * The generation whose projection state answers for the decision's country:
 * the one the jurisdiction-serving pointer names, else the serving generation
 * the caller passes. The acceptance of an indexed hit follows the pointer and
 * nothing else, so it can never disagree with where the read went.
 */
const servingGenerationOfDecision = (generation: string) =>
  sql`COALESCE((
    SELECT pointer.${sql.identifier(corpusIndexJurisdictionServing.generation.name)}
    FROM ${corpusIndexJurisdictionServing} pointer
    WHERE pointer.${sql.identifier(corpusIndexJurisdictionServing.family.name)} = ${CASE_LAW_FAMILY}
      AND pointer.${sql.identifier(corpusIndexJurisdictionServing.jurisdiction.name)} = upper(${caseLawDecisions.country})
  ), ${generation})`;

/** Only an applied revision with exactly one physical passage proves a singleton. */
export const caseLawCorpusDocumentCanRecur = (generation: string) =>
  sql<boolean>`coalesce((
    SELECT intent.expected_document_count
    FROM ${corpusIndexProjectionIntents} intent
    WHERE intent.id = (
      SELECT projection_state.applied_revision
      FROM ${corpusIndexProjectionStates} projection_state
      WHERE projection_state.family = ${CASE_LAW_FAMILY}
        AND projection_state.generation = ${servingGenerationOfDecision(generation)}
        AND projection_state.entity_id = ${caseLawDecisions}.${sql.identifier(caseLawDecisions.id.name)}
    )
  ), 0) <> 1`;

/**
 * The revision this generation recorded as applied for the decision, by the
 * states table's primary key. Read beside `currentCaseLawCorpusProjection`,
 * it names the copy of the decision a passage read may return.
 */
export const caseLawCorpusAppliedRevision = (generation: string) =>
  sql<CorpusProjectionRevision | null>`(
    SELECT projection_state.applied_revision
    FROM ${corpusIndexProjectionStates} projection_state
    WHERE projection_state.family = ${CASE_LAW_FAMILY}
      AND projection_state.generation = ${servingGenerationOfDecision(generation)}
      AND projection_state.entity_id = ${caseLawDecisions}.${sql.identifier(caseLawDecisions.id.name)}
  )`;

/** The physical index this generation projects a decision's current country into. */
const caseLawDecisionCorpusIndexIdSql = (generation: string) =>
  caseLawIndexIdSql(
    servingGenerationOfDecision(generation),
    caseLawDecisions.country,
  );

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
        AND ${corpusIndexProjectionStates.generation} = ${servingGenerationOfDecision(generation)}
        AND ${corpusIndexProjectionStates.entityId} = ${caseLawDecisions.id}
        AND ${corpusIndexProjectionStates.desiredAction} = 'upsert'
        AND ${corpusIndexProjectionStates.appliedAction} = 'upsert'
        AND ${corpusIndexProjectionStates.appliedEpoch} = ${corpusIndexProjectionStates.desiredEpoch}
        AND ${corpusIndexProjectionStates.appliedFingerprint} = ${corpusIndexProjectionStates.desiredFingerprint}
        AND ${corpusIndexProjectionStates.appliedIndexId} = ${corpusIndexProjectionStates.desiredIndexId}
        AND ${corpusIndexProjectionStates.appliedIndexId} = (${caseLawDecisionCorpusIndexIdSql(generation)})
    )`;
