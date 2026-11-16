// The writer of `sourced-from` edges: a list fact is sourced from the
// document each of its Spots sits in. Reads list rows only, so the list
// handlers that add Spots, accept facts or retype items write through it.

import { panic } from "better-result";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { LIST_ITEM_TYPE } from "@stll/api-contract/entity-options";

import {
  entities,
  legalListGenerationCandidates,
  legalListGenerationCandidateSources,
  legalListItemSources,
} from "@/api/db/schema";
import type { LegalListGenerationCandidateStatus } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  GraphEdgeKind,
  GraphEdgeProducerKind,
  GraphNodeKind,
} from "@/api/lib/lists/graph/contract";
import {
  executeEdgeInsert,
  INSERT_EDGE,
} from "@/api/lib/lists/graph/edge-insert";
import type { EdgeWriteTransaction } from "@/api/lib/lists/graph/edge-insert";

const SOURCED_FROM = "sourced-from" satisfies GraphEdgeKind;
const FACT = "fact" satisfies GraphNodeKind;
const DOCUMENT = "document" satisfies GraphNodeKind;
const EXTRACTION = "extraction" satisfies GraphEdgeProducerKind;
const REVIEWER = "reviewer" satisfies GraphEdgeProducerKind;
const ACCEPTED_CANDIDATE =
  "accepted" satisfies LegalListGenerationCandidateStatus;

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

export type FactSourceEdgeWrite =
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
  write: FactSourceEdgeWrite,
): SQL => {
  switch (write.type) {
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
      return panic(`Unhandled fact source edge write: ${String(write)}`);
    }
  }
};

/** Write the `sourced-from` edges one list act asserts, in its transaction. */
export const writeFactSourceEdges = async (
  tx: EdgeWriteTransaction,
  workspaceId: SafeId<"workspace">,
  write: FactSourceEdgeWrite,
): Promise<number> =>
  write.type === "fact-sources" && write.sourceIds.length === 0
    ? 0
    : await executeEdgeInsert(tx, writeSql(workspaceId, write));
