import { type SQL, sql, type SQLWrapper } from "drizzle-orm";

import {
  corpusIndexJurisdictionServing,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
  publishedCaseLawDecisions,
} from "@/api/db/schema";
import { caseLawIndexIdSql } from "@/api/lib/legal-search/case-law-index-groups";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";
import { requireCorpusIndexManifest } from "@/api/lib/legal-search/corpus-index-manifest";
import {
  type CorpusAppliedProjection,
  corpusAppliedProjection,
  type CorpusProjectionRevision,
} from "@/api/lib/legal-search/corpus-index-revision-clause";

const CASE_LAW_FAMILY = "case_law" satisfies CorpusFamily;

/**
 * The generation whose projection state answers for the decision's country:
 * the one the jurisdiction-serving pointer names, else the serving generation
 * the caller passes. The acceptance of an indexed hit follows the pointer and
 * nothing else, so it can never disagree with where the read went.
 */
export const caseLawCorpusServingGeneration = (generation: string) =>
  sql<string>`COALESCE((
    SELECT pointer.${sql.identifier(corpusIndexJurisdictionServing.generation.name)}
    FROM ${corpusIndexJurisdictionServing} pointer
    WHERE pointer.${sql.identifier(corpusIndexJurisdictionServing.family.name)} = ${CASE_LAW_FAMILY}
      AND pointer.${sql.identifier(corpusIndexJurisdictionServing.jurisdiction.name)} = ${publishedCaseLawDecisions.country}
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
        AND projection_state.generation = ${caseLawCorpusServingGeneration(generation)}
        AND projection_state.entity_id = ${publishedCaseLawDecisions}.${sql.identifier(publishedCaseLawDecisions.id.name)}
    )
  ), 0) <> 1`;

/**
 * The revision this generation recorded as applied for the decision, by the
 * states table's primary key. Read beside `servedCaseLawCorpusProjection`,
 * it names the copy of the decision a passage read may return.
 */
export const caseLawCorpusAppliedRevision = (generation: string) =>
  sql<CorpusProjectionRevision | null>`(
    SELECT projection_state.applied_revision
    FROM ${corpusIndexProjectionStates} projection_state
    WHERE projection_state.family = ${CASE_LAW_FAMILY}
      AND projection_state.generation = ${caseLawCorpusServingGeneration(generation)}
      AND projection_state.entity_id = ${publishedCaseLawDecisions}.${sql.identifier(publishedCaseLawDecisions.id.name)}
  )`;

/**
 * The served projection state of the decision at `resolvedGeneration`, the
 * generation the jurisdiction-serving pointer resolved for the decision's
 * country (never a bare generation): an applied upsert whose revision sits in
 * the index that generation routes the decision's current country to, with no
 * erasure queued.
 *
 * A queued upsert keeps the applied copy served until the new one lands:
 * passage reads name `applied_revision`, so a hit always comes from the copy
 * recorded here, and the published view has already decided whether the
 * decision may be shown at all. Index lag can make a snippet one parse old,
 * never hide a decision.
 */
const acceptedCaseLawProjectionStateAt = (
  resolvedGeneration: SQLWrapper,
): SQL => sql`
        ${corpusIndexProjectionStates.family} = ${CASE_LAW_FAMILY}
        AND ${corpusIndexProjectionStates.generation} = ${resolvedGeneration}
        AND ${corpusIndexProjectionStates.entityId} = ${publishedCaseLawDecisions.id}
        AND ${corpusIndexProjectionStates.desiredAction} = 'upsert'
        AND ${corpusIndexProjectionStates.appliedAction} = 'upsert'
        AND ${corpusIndexProjectionStates.appliedRevision} IS NOT NULL
        AND ${corpusIndexProjectionStates.appliedIndexId} = (${caseLawIndexIdSql(resolvedGeneration, publishedCaseLawDecisions.country)})`;

/** The jurisdiction-serving pointer row of the decision's country. */
const caseLawDecisionPointer = sql`
        pointer.${sql.identifier(corpusIndexJurisdictionServing.family.name)} = ${CASE_LAW_FAMILY}
        AND pointer.${sql.identifier(corpusIndexJurisdictionServing.jurisdiction.name)} = ${publishedCaseLawDecisions.country}`;

/**
 * Accept a physical hit only when the generation that serves the decision's
 * country holds an applied copy of the decision in its current jurisdiction
 * and no erasure is queued: the one the jurisdiction-serving pointer names,
 * else the serving generation the caller passes.
 *
 * A queued erasure sets `desired_action` to erase and is not accepted. A
 * queued upsert is: the applied copy answers until the new one replaces it.
 * No row at all, or no applied upsert, means the generation does not hold the
 * decision.
 *
 * The pointer is joined rather than read by a scalar subquery, so the
 * generation is a plain column of the lookup and the states table's primary
 * key, `(family, generation, entity_id)`, answers it once per candidate row.
 */
export const servedCaseLawCorpusProjection = (generation: string): SQL =>
  sql`EXISTS (
      SELECT 1
      FROM (VALUES (1)) serving_anchor (present)
      LEFT JOIN ${corpusIndexJurisdictionServing} pointer
        ON ${caseLawDecisionPointer}
      JOIN ${corpusIndexProjectionStates}
        ON ${acceptedCaseLawProjectionStateAt(sql`COALESCE(pointer.${sql.identifier(corpusIndexJurisdictionServing.generation.name)}, ${generation})`)}
    )`;

/** Derive each accepted decision's retrieval contract from SQL's effective generation. */
export const caseLawAppliedProjections = (
  rows: Iterable<{
    id: string;
    appliedRevision: CorpusProjectionRevision | null;
    appliedGeneration: string;
  }>,
): ReadonlyMap<string, CorpusAppliedProjection> => {
  const applied = new Map<string, CorpusAppliedProjection>();
  for (const { id, appliedRevision, appliedGeneration } of rows) {
    if (appliedRevision === null) {
      continue;
    }
    applied.set(
      id,
      corpusAppliedProjection(
        requireCorpusIndexManifest(CASE_LAW_FAMILY, appliedGeneration),
        appliedRevision,
      ),
    );
  }
  return applied;
};
