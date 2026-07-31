import { sql } from "drizzle-orm";

import {
  caseLawCorpusIndexProjections,
  caseLawDecisions,
} from "@/api/db/schema";

/** Join one decision to its durable state for the selected generation. */
export const caseLawCorpusProjectionJoin = (generation: string) =>
  sql`${caseLawCorpusIndexProjections.decisionId} = ${caseLawDecisions.id}
    AND ${caseLawCorpusIndexProjections.generation} = ${generation}`;

/**
 * Accept a physical hit only when this generation recorded the current
 * decision in its current jurisdiction and has no queued mutation. Older
 * serving generations without a rebuild checkpoint retain the legacy marker.
 */
export const currentCaseLawCorpusProjection = (generation: string) =>
  sql`(
    (
      ${caseLawCorpusIndexProjections.indexedHash} = ${caseLawDecisions.contentHash}
      AND ${caseLawCorpusIndexProjections.indexId} = (${generation} || '_' || lower(${caseLawDecisions.country}))
      AND ${caseLawCorpusIndexProjections.pendingAction} IS NULL
    )
    OR (
      ${caseLawCorpusIndexProjections.generation} IS NULL
      AND ${caseLawDecisions.indexedHash} = ${caseLawDecisions.contentHash}
    )
  )`;
