import { type SQL, sql } from "drizzle-orm";

import {
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
  legislationDocuments,
} from "@/api/db/schema";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";
import { requireCorpusIndexManifest } from "@/api/lib/legal-search/corpus-index-manifest";
import { corpusIndexIdSqlFromManifest } from "@/api/lib/legal-search/corpus-index-route-sql";

const LEGISLATION_FAMILY = "legislation" satisfies CorpusFamily;

/** A Work can recur through another passage or another stored version. */
export const legislationCorpusWorkCanRecur = (generation: string) =>
  sql<boolean>`CASE WHEN coalesce((
    SELECT ${corpusIndexProjectionIntents.expectedDocumentCount}
    FROM ${corpusIndexProjectionStates}
    INNER JOIN ${corpusIndexProjectionIntents}
      ON ${corpusIndexProjectionIntents.id} = ${corpusIndexProjectionStates.appliedRevision}
    WHERE ${corpusIndexProjectionStates.family} = ${LEGISLATION_FAMILY}
      AND ${corpusIndexProjectionStates.generation} = ${generation}
      AND ${corpusIndexProjectionStates.entityId} = ${legislationDocuments.id}
  ), 0) <> 1 THEN true ELSE EXISTS (
    SELECT 1 FROM ${legislationDocuments} sibling
    WHERE sibling.source_id = ${legislationDocuments.sourceId}
      AND sibling.eli = ${legislationDocuments.eli}
      AND sibling.language = ${legislationDocuments.language}
      AND sibling.id <> ${legislationDocuments.id}
  ) END`;

/**
 * Accept a physical hit only when this generation holds the current document
 * and has no queued mutation.
 *
 * Applied equals desired on every field that can change what is served, and
 * the applied revision sits in the index this generation routes the
 * document's current jurisdiction to. A queued mutation moves desired ahead
 * of applied, and a queued erasure leaves `desired_fingerprint` null, so
 * neither is accepted. No row at all means the generation does not hold the
 * document.
 *
 * The index the applied revision has to sit in is the manifest's own route
 * rendered as SQL, the expression the projection writer derives
 * `desired_index_id` from.
 *
 * The lookup is the states table's primary key, `(family, generation,
 * entity_id)`, once per candidate row.
 */
export const currentLegislationCorpusProjection = (generation: string): SQL => {
  const routedIndexId = corpusIndexIdSqlFromManifest(
    requireCorpusIndexManifest(LEGISLATION_FAMILY, generation),
    legislationDocuments.country,
  );
  return sql`EXISTS (
      SELECT 1
      FROM ${corpusIndexProjectionStates}
      WHERE ${corpusIndexProjectionStates.family} = ${LEGISLATION_FAMILY}
        AND ${corpusIndexProjectionStates.generation} = ${generation}
        AND ${corpusIndexProjectionStates.entityId} = ${legislationDocuments.id}
        AND ${corpusIndexProjectionStates.desiredAction} = 'upsert'
        AND ${corpusIndexProjectionStates.appliedAction} = 'upsert'
        AND ${corpusIndexProjectionStates.appliedEpoch} = ${corpusIndexProjectionStates.desiredEpoch}
        AND ${corpusIndexProjectionStates.appliedFingerprint} = ${corpusIndexProjectionStates.desiredFingerprint}
        AND ${corpusIndexProjectionStates.appliedIndexId} = ${corpusIndexProjectionStates.desiredIndexId}
        AND ${corpusIndexProjectionStates.appliedIndexId} = (${routedIndexId})
    )`;
};
