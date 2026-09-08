import { panic } from "better-result";
import { type SQL, sql } from "drizzle-orm";

import {
  corpusIndexProjectionStates,
  legislationDocuments,
} from "@/api/db/schema";
import {
  type CorpusFamily,
  corpusIndexProjectionStore,
} from "@/api/lib/legal-search/corpus-generation-contract";
import { requireCorpusIndexManifest } from "@/api/lib/legal-search/corpus-index-manifest";
import { corpusIndexIdSqlFromManifest } from "@/api/lib/legal-search/corpus-index-route-sql";

const LEGISLATION_FAMILY = "legislation" satisfies CorpusFamily;

/**
 * The state row a final-projection generation keeps for the document, in the
 * one shape that means "the engine holds this content now".
 *
 * Applied equals desired on every field that can change what is served, and
 * the applied revision sits in the index this generation routes the
 * document's current jurisdiction to. A queued mutation moves desired ahead
 * of applied, and a queued erasure leaves `desired_fingerprint` null, so
 * neither is accepted. No row at all means the generation does not hold the
 * document: there is no marker on the document to fall back to, and one would
 * answer for a pipeline that never wrote it.
 *
 * The index the applied revision has to sit in is the manifest's own route
 * rendered as SQL, the expression the projection writer derives
 * `desired_index_id` from. Only a declared final generation reaches here, so
 * the manifest is always there to read.
 *
 * The lookup is the states table's primary key, `(family, generation,
 * entity_id)`, once per candidate row.
 */
const currentLegislationProjectionState = (generation: string): SQL => {
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

/**
 * Accept a physical hit only when this generation holds the current document
 * and has no queued mutation.
 *
 * Which state that is read from follows the generation's store, the same
 * split case law makes: a final-projection generation answers from
 * `corpus_index_projection_states`, a legacy generation from the serving
 * marker on the document, which its queue is what writes.
 */
export const currentLegislationCorpusProjection = (generation: string): SQL => {
  const store = corpusIndexProjectionStore(LEGISLATION_FAMILY, generation);
  switch (store) {
    case "legacy_projection_row":
      // The equality fails for rows cleared for a write retry (null
      // contentHash) and for rows whose payload changed but are not
      // re-indexed yet (indexedHash cleared by ingestion), so stale index
      // copies cannot serve outdated snippets.
      return sql`${legislationDocuments.indexedHash} = ${legislationDocuments.contentHash}`;
    case "projection_state":
      return currentLegislationProjectionState(generation);
    default:
      store satisfies never;
      return panic(`Unhandled legislation projection store: ${String(store)}`);
  }
};
