import { sql } from "drizzle-orm";

import {
  caseLawCorpusIndexProjections,
  caseLawDecisions,
} from "@/api/db/schema";
import { caseLawIndexIdSql } from "@/api/lib/legal-search/case-law-index-groups";

/** Join one decision to its durable state for the selected generation. */
export const caseLawCorpusProjectionJoin = (generation: string) =>
  sql`${caseLawCorpusIndexProjections.decisionId} = ${caseLawDecisions.id}
    AND ${caseLawCorpusIndexProjections.generation} = ${generation}`;

/** The physical index this generation projects a decision's current country into. */
export const caseLawDecisionCorpusIndexIdSql = (generation: string) =>
  caseLawIndexIdSql(sql`${generation}`, caseLawDecisions.country);

/**
 * Accept a physical hit only when this generation recorded the current
 * decision in its current jurisdiction and has no queued mutation. Older
 * serving generations without a rebuild checkpoint retain the legacy marker.
 */
export const currentCaseLawCorpusProjection = (generation: string) =>
  sql`(
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
