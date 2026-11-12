// The writer of `cites` edges, and with `fact-source-edges.ts` the only
// writers of `legal_graph_edges`. Each derives its edges in SQL from the rows
// that already hold the link (a claim's grade refs, a re-check's grade), so
// the live writers and the online backfill run the same statements and
// cannot disagree on what an edge is. Every statement inserts with
// `ON CONFLICT DO NOTHING` on the edge identity: a replay converges on the
// rows already written and never changes one.

import { panic } from "better-result";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { LIST_ITEM_TYPE } from "@stll/api-contract/entity-options";

import {
  entities,
  legalListClaimReviewEvents,
  legalListClaims,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  GraphEdgeKind,
  GraphEdgeProducerKind,
  GraphNodeKind,
  GraphProvenanceReason,
} from "@/api/lib/lists/graph/contract";
import {
  executeEdgeInsert,
  INSERT_EDGE,
} from "@/api/lib/lists/graph/edge-insert";
import type { EdgeWriteTransaction } from "@/api/lib/lists/graph/edge-insert";
import type { ClaimReviewEventKind } from "@/api/lib/lists/verification/contract";

const CITES = "cites" satisfies GraphEdgeKind;
const CLAIM = "claim" satisfies GraphNodeKind;
const FACT = "fact" satisfies GraphNodeKind;
const CLAIM_ANCHOR = "claim-anchor" satisfies GraphProvenanceReason;
const RUN = "run" satisfies GraphEdgeProducerKind;
const RECHECK = "recheck" satisfies GraphEdgeProducerKind;
const RECHECK_EVENT = "recheck" satisfies ClaimReviewEventKind;

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

export type GraphEdgeWrite =
  /** The grades a run wrote and the re-checks carried to its claims,
   *  when it completes. */
  | { type: "run"; runId: SafeId<"legalListVerificationRun"> }
  /** The grades of the re-checks one request recorded, when they are
   *  recorded (one statement however many). */
  | {
      type: "recheck";
      eventIds: readonly SafeId<"legalListClaimReviewEvent">[];
    };

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
        sql`event.workspace_id = ${workspaceId} AND event.id IN ${
          write.eventIds.length === 0
            ? sql`(NULL)`
            : sql`(${sql.join(
                write.eventIds.map((eventId) => sql`${eventId}`),
                sql`, `,
              )})`
        }`,
      );
    }
    default: {
      write satisfies never;
      return panic(`Unhandled graph edge write: ${String(write)}`);
    }
  }
};

/** Write the `cites` edges one verification act asserts, in its transaction. */
export const writeGraphEdges = async (
  tx: EdgeWriteTransaction,
  workspaceId: SafeId<"workspace">,
  write: GraphEdgeWrite,
): Promise<number> => await executeEdgeInsert(tx, writeSql(workspaceId, write));
