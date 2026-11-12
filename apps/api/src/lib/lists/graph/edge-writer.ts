// The only writers of `legal_graph_edges`. Each derives its edges in SQL from
// the rows that already hold the link (a claim's grade refs, a re-check's
// grade, a fact's Spot), so the live writers and the online backfill run the
// same statements and cannot disagree on what an edge is. Every statement
// inserts with `ON CONFLICT DO NOTHING` on the edge identity: a replay
// converges on the rows already written and never changes one.

import { panic } from "better-result";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { LIST_ITEM_TYPE } from "@stll/api-contract/entity-options";

import {
  entities,
  legalGraphEdges,
  legalListClaimReviewEvents,
  legalListClaims,
  legalListGenerationCandidates,
  legalListGenerationCandidateSources,
  legalListItemSources,
} from "@/api/db/schema";
import type { LegalListGenerationCandidateStatus } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import type {
  GraphEdgeKind,
  GraphEdgeProducerKind,
  GraphNodeKind,
  GraphProvenanceReason,
} from "@/api/lib/lists/graph/contract";
import type { ClaimReviewEventKind } from "@/api/lib/lists/verification/contract";

const CITES = "cites" satisfies GraphEdgeKind;
const SOURCED_FROM = "sourced-from" satisfies GraphEdgeKind;
const CLAIM = "claim" satisfies GraphNodeKind;
const FACT = "fact" satisfies GraphNodeKind;
const DOCUMENT = "document" satisfies GraphNodeKind;
const CLAIM_ANCHOR = "claim-anchor" satisfies GraphProvenanceReason;
const RUN = "run" satisfies GraphEdgeProducerKind;
const RECHECK = "recheck" satisfies GraphEdgeProducerKind;
const EXTRACTION = "extraction" satisfies GraphEdgeProducerKind;
const REVIEWER = "reviewer" satisfies GraphEdgeProducerKind;
const RECHECK_EVENT = "recheck" satisfies ClaimReviewEventKind;
const ACCEPTED_CANDIDATE =
  "accepted" satisfies LegalListGenerationCandidateStatus;

const INSERT_EDGE = sql`INSERT INTO ${legalGraphEdges} (
    workspace_id, kind, from_kind, from_claim_id, from_claim_run_id,
    from_entity_id, to_kind, to_entity_id, stance, source_id,
    provenance_reason, producer_kind, producer_id
  )`;

/** A ref's fact id as a uuid, or null for anything else, so a malformed ref
 *  matches no fact instead of failing the cast. */
const refFactId = sql`CASE WHEN ref.value->>'factEntityId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN (ref.value->>'factEntityId')::uuid END`;

const refsOf = (refs: SQL) =>
  sql`jsonb_array_elements(CASE WHEN jsonb_typeof(${refs}) = 'array' THEN ${refs} ELSE '[]'::jsonb END)`;

/**
 * A claim cites each fact its run's grade rests on, with the relation the
 * grade gave it. A ref to a fact the workspace no longer holds, or that is
 * no longer a fact, has no fact node to reach, so it writes no edge. `scope`
 * filters `claim`.
 */
export const runCitesSql = (scope: SQL) => sql`${INSERT_EDGE}
  SELECT claim.workspace_id, ${CITES}, ${CLAIM}, claim.id, claim.run_id,
    NULL, ${FACT}, fact.id, ref.value->>'rel', NULL,
    ${CLAIM_ANCHOR}, ${RUN}, claim.run_id
  FROM ${legalListClaims} claim
  CROSS JOIN LATERAL ${refsOf(sql`claim.refs`)} ref
  JOIN ${entities} fact
    ON fact.id = ${refFactId} AND fact.workspace_id = claim.workspace_id
    AND fact.list_item_type = ${LIST_ITEM_TYPE.FACT}
  WHERE ${scope}
  ON CONFLICT DO NOTHING
  RETURNING id`;

/**
 * A re-check cites each fact its grade rests on, as its own producer: the
 * run's edges stay as they were. `scope` filters `event`.
 */
export const recheckCitesSql = (scope: SQL) => sql`${INSERT_EDGE}
  SELECT event.workspace_id, ${CITES}, ${CLAIM}, event.claim_id, event.run_id,
    NULL, ${FACT}, fact.id, ref.value->>'rel', NULL,
    ${CLAIM_ANCHOR}, ${RECHECK}, event.id
  FROM ${legalListClaimReviewEvents} event
  CROSS JOIN LATERAL ${refsOf(sql`event.payload->'grade'->'refs'`)} ref
  JOIN ${entities} fact
    ON fact.id = ${refFactId} AND fact.workspace_id = event.workspace_id
    AND fact.list_item_type = ${LIST_ITEM_TYPE.FACT}
  WHERE event.kind = ${RECHECK_EVENT} AND ${scope}
  ON CONFLICT DO NOTHING
  RETURNING id`;

/**
 * Who asserted a fact's Spot. The live writers know it: the reviewer who
 * added the Spot, or the extraction run whose proposal was accepted. A
 * Spot whose origin was not recorded (the backfill's rows, a task turned
 * into a fact) is credited to the extraction run whose accepted proposal
 * carried the very same passage and quote, else to the reviewer.
 */
export type SpotProducer =
  | { type: "reviewer" }
  | { type: "extraction"; runId: SafeId<"legalListGenerationRun"> }
  | { type: "inferred" };

const spotProducerSql = (producer: SpotProducer) => {
  switch (producer.type) {
    case "reviewer": {
      return { kind: sql`${REVIEWER}`, id: sql`source.id` };
    }
    case "extraction": {
      return { kind: sql`${EXTRACTION}`, id: sql`${producer.runId}::uuid` };
    }
    case "inferred": {
      return {
        kind: sql`CASE WHEN origin.run_id IS NULL THEN ${REVIEWER} ELSE ${EXTRACTION} END`,
        id: sql`COALESCE(origin.run_id, source.id)`,
      };
    }
    default: {
      producer satisfies never;
      return panic(`Unhandled Spot producer: ${String(producer)}`);
    }
  }
};

/**
 * A fact is sourced from the document each of its Spots sits in, as
 * `producer` asserted it. Only fact items are facts; a source on any other
 * item writes nothing. `scope` filters `source`.
 */
export const factSourcesSql = (scope: SQL, producer: SpotProducer) => {
  const asserted = spotProducerSql(producer);
  return sql`${INSERT_EDGE}
  SELECT source.workspace_id, ${SOURCED_FROM}, ${FACT}, NULL, NULL,
    source.item_entity_id, ${DOCUMENT}, source.source_entity_id, NULL,
    source.id, NULL, ${asserted.kind}, ${asserted.id}
  FROM ${legalListItemSources} source
  JOIN ${entities} item
    ON item.id = source.item_entity_id
    AND item.workspace_id = source.workspace_id
    AND item.list_item_type = ${LIST_ITEM_TYPE.FACT}
  LEFT JOIN LATERAL (
    SELECT candidate.run_id
    FROM ${legalListGenerationCandidates} candidate
    JOIN ${legalListGenerationCandidateSources} proposed
      ON proposed.candidate_id = candidate.id
      AND proposed.run_id = candidate.run_id
      AND proposed.workspace_id = candidate.workspace_id
    WHERE candidate.accepted_entity_id = source.item_entity_id
      AND candidate.workspace_id = source.workspace_id
      AND candidate.status = ${ACCEPTED_CANDIDATE}
      AND proposed.source_entity_version_id = source.source_entity_version_id
      AND proposed.locator = source.locator
      AND proposed.quote IS NOT DISTINCT FROM source.quote
    ORDER BY candidate.run_id
    LIMIT 1
  ) origin ON ${producer.type === "inferred" ? sql`true` : sql`false`}
  WHERE ${scope}
  ON CONFLICT DO NOTHING
  RETURNING id`;
};

export type GraphEdgeWrite =
  /** The grades a run wrote and the re-checks carried to its claims,
   *  when it completes. */
  | { type: "run"; runId: SafeId<"legalListVerificationRun"> }
  /** One re-check's grade, when it is recorded. */
  | { type: "recheck"; eventId: SafeId<"legalListClaimReviewEvent"> }
  /** A fact's Spots, when they are added or the fact is accepted. */
  | {
      type: "fact-sources";
      sourceIds: readonly SafeId<"legalListItemSource">[];
      producer: Exclude<SpotProducer, { type: "inferred" }>;
    }
  /** Every Spot of an item that has just become a fact. */
  | { type: "item-became-fact"; itemEntityId: SafeId<"entity"> };

const writeSql = (
  workspaceId: SafeId<"workspace">,
  write: GraphEdgeWrite,
): SQL => {
  switch (write.type) {
    case "run": {
      // One statement: the run's citations, and those of the re-checks on
      // its claims (a re-check carried from the previous run is the grade
      // its claim is read with, so it cites as any re-check does).
      return sql`WITH run_edges AS (${runCitesSql(
        sql`claim.workspace_id = ${workspaceId} AND claim.run_id = ${write.runId}`,
      )}), recheck_edges AS (${recheckCitesSql(
        sql`event.workspace_id = ${workspaceId} AND event.run_id = ${write.runId}`,
      )})
        SELECT id FROM run_edges UNION ALL SELECT id FROM recheck_edges`;
    }
    case "recheck": {
      return recheckCitesSql(
        sql`event.workspace_id = ${workspaceId} AND event.id = ${write.eventId}`,
      );
    }
    case "fact-sources": {
      return factSourcesSql(
        sql`source.workspace_id = ${workspaceId} AND source.id IN (${sql.join(
          write.sourceIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
        write.producer,
      );
    }
    case "item-became-fact": {
      return factSourcesSql(
        sql`source.workspace_id = ${workspaceId} AND source.item_entity_id = ${write.itemEntityId}`,
        { type: "inferred" },
      );
    }
    default: {
      write satisfies never;
      return panic(`Unhandled graph edge write: ${String(write)}`);
    }
  }
};

/**
 * Write the edges one producing act asserts, in the caller's transaction so
 * they commit with the act. Returns how many were new: zero on a replay.
 */
export const writeGraphEdges = async (
  tx: Pick<PgAsyncDatabase<PgQueryResultHKT>, "execute">,
  workspaceId: SafeId<"workspace">,
  write: GraphEdgeWrite,
): Promise<number> => {
  if (write.type === "fact-sources" && write.sourceIds.length === 0) {
    return 0;
  }
  // audit: skip — edges are derived from the act the caller audits in this transaction.
  return executedRows(await tx.execute(writeSql(workspaceId, write))).length;
};
