import { FACT_CONFIDENCES } from "@/api/lib/lists/fact-details";
import {
  GRAPH_EDGE_KINDS,
  GRAPH_EDGE_PRODUCER_KINDS,
  GRAPH_EDGE_RULES,
  GRAPH_EDGE_STANCES,
  GRAPH_NODE_KINDS,
  GRAPH_PROVENANCE_REASONS,
  RECORDED_GRAPH_EDGE_PRODUCER_KINDS,
} from "@/api/lib/lists/graph/contract";
import type { GraphEdgeKind } from "@/api/lib/lists/graph/contract";

import {
  entityFeatureGateChecks,
  entityFeatureGateColumns,
  entityFeatureOrganizationGateColumns,
  entityFeatureWorkspaceGateColumns,
} from "../entity-feature-gate-columns";
import { entityFeaturePolicies } from "../entity-feature-policies";
import {
  p,
  safeUuid,
  safeWorkspaceId,
  sql,
  stella,
  timestamptz,
  workspaceCheck,
} from "./common";
import type { SafeId } from "./common";
import { entities } from "./entities";
import { legalListItemSources } from "./lists";
import { legalListClaims } from "./lists-verification";

const quoted = (values: readonly string[]) =>
  sql.join(
    values.map((value) => sql.raw(`'${value}'`)),
    sql`, `,
  );

const KIND_SQL_VALUES = quoted(GRAPH_EDGE_KINDS);
const NODE_KIND_SQL_VALUES = quoted(GRAPH_NODE_KINDS);
const STANCE_SQL_VALUES = quoted(GRAPH_EDGE_STANCES);
const PROVENANCE_REASON_SQL_VALUES = quoted(GRAPH_PROVENANCE_REASONS);
const PRODUCER_KIND_SQL_VALUES = quoted(GRAPH_EDGE_PRODUCER_KINDS);
const RECORDED_PRODUCER_KIND_SQL_VALUES = quoted(
  RECORDED_GRAPH_EDGE_PRODUCER_KINDS,
);
const CONFIDENCE_SQL_VALUES = quoted(FACT_CONFIDENCES);
const kindsWhere = (
  predicate: (rule: (typeof GRAPH_EDGE_RULES)[GraphEdgeKind]) => boolean,
) =>
  quoted(GRAPH_EDGE_KINDS.filter((kind) => predicate(GRAPH_EDGE_RULES[kind])));
/** Every (kind, from, to) triple the rules allow, as SQL row literals. */
const ENDPOINT_SQL_VALUES = sql.join(
  GRAPH_EDGE_KINDS.flatMap((kind) =>
    GRAPH_EDGE_RULES[kind].ends.map(([from, to]) =>
      sql.raw(`('${kind}', '${from}', '${to}')`),
    ),
  ),
  sql`, `,
);
const STANCE_KIND_SQL_VALUES = kindsWhere((rule) => rule.stance === "required");
const SPOT_KIND_SQL_VALUES = kindsWhere(
  (rule) => rule.provenance.type === "spot",
);
const CLAIM_ANCHOR_KIND_SQL_VALUES = kindsWhere(
  (rule) =>
    rule.provenance.type === "reason" &&
    rule.provenance.reason === "claim-anchor",
);

/**
 * One typed link of the matter graph, between blocks that already exist: a
 * claim and a fact it cites, a fact and the document it is sourced from (at a
 * Spot). Written once by the producer that asserts it and never changed: a
 * replayed write converges on the same row (one per identity), a re-grade is
 * a new producer with its own edges, and a reviewer's decision lives in its
 * kind's append-only decision events (`GRAPH_EDGE_RULES[kind].decisions`).
 * Deleting either end, the claim's run or the Spot cascades the edge.
 */
export const legalGraphEdges = p.pgTable(
  "legal_graph_edges",
  {
    ...entityFeatureGateColumns(),
    ...entityFeatureWorkspaceGateColumns(),
    ...entityFeatureOrganizationGateColumns(),
    id: p
      .uuid()
      .primaryKey()
      .default(sql`gen_random_uuid()`)
      .$type<SafeId<"legalGraphEdge">>(),
    workspaceId: safeWorkspaceId("workspace_id").notNull(),
    kind: p.text("kind", { enum: GRAPH_EDGE_KINDS }).notNull(),
    fromKind: p.text("from_kind", { enum: GRAPH_NODE_KINDS }).notNull(),
    // A claim end names the claim and its run; any other end, the entity.
    fromClaimId: safeUuid<"legalListClaim">("from_claim_id"),
    fromClaimRunId: safeUuid<"legalListVerificationRun">("from_claim_run_id"),
    fromEntityId: safeUuid<"entity">("from_entity_id"),
    toKind: p.text("to_kind", { enum: GRAPH_NODE_KINDS }).notNull(),
    toEntityId: safeUuid<"entity">("to_entity_id").notNull(),
    // How a cited fact bears on the claim; null for every other kind.
    stance: p.text("stance", { enum: GRAPH_EDGE_STANCES }),
    // The Spot (a fact's source passage) the edge rests on; null when the
    // edge carries no Spot of its own, with the reason why.
    sourceId: safeUuid<"legalListItemSource">("source_id"),
    provenanceReason: p.text("provenance_reason", {
      enum: GRAPH_PROVENANCE_REASONS,
    }),
    producerKind: p
      .text("producer_kind", { enum: GRAPH_EDGE_PRODUCER_KINDS })
      .notNull(),
    // The record that holds the producing act (`GRAPH_EDGE_PRODUCER_KINDS`);
    // null only for an import.
    producerId: p.uuid("producer_id"),
    // How far the edge can be relied on, on the facts' scale; null when the
    // producer did not say.
    confidence: p.text("confidence", { enum: FACT_CONFIDENCES }),
    createdAt: timestamptz("created_at")
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    ...entityFeatureGateChecks(table),
    p
      .foreignKey({
        name: "legal_graph_edges_from_claim_fk",
        columns: [table.fromClaimId, table.fromClaimRunId, table.workspaceId],
        foreignColumns: [
          legalListClaims.id,
          legalListClaims.runId,
          legalListClaims.workspaceId,
        ],
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        name: "legal_graph_edges_from_entity_fk",
        columns: [table.fromEntityId, table.workspaceId],
        foreignColumns: [entities.id, entities.workspaceId],
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        name: "legal_graph_edges_to_entity_fk",
        columns: [table.toEntityId, table.workspaceId],
        foreignColumns: [entities.id, entities.workspaceId],
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        name: "legal_graph_edges_source_fk",
        columns: [table.sourceId],
        foreignColumns: [legalListItemSources.id],
      })
      .onDelete("cascade"),
    // One edge per identity: replaying a producer writes nothing new. The
    // Spot is part of it, so two passages of one document stay two edges.
    p
      .unique("legal_graph_edges_identity_unq")
      .on(
        table.workspaceId,
        table.kind,
        table.fromClaimId,
        table.fromEntityId,
        table.toEntityId,
        table.sourceId,
        table.producerKind,
        table.producerId,
      )
      .nullsNotDistinct(),
    // A node's neighbours, either way along its edges.
    p
      .index("legal_graph_edges_from_claim_idx")
      .on(table.workspaceId, table.fromClaimId, table.fromClaimRunId)
      .where(sql`${table.fromClaimId} IS NOT NULL`),
    p
      .index("legal_graph_edges_from_entity_idx")
      .on(table.workspaceId, table.fromEntityId)
      .where(sql`${table.fromEntityId} IS NOT NULL`),
    p
      .index("legal_graph_edges_to_entity_idx")
      .on(table.workspaceId, table.toEntityId),
    p
      .index("legal_graph_edges_source_idx")
      .on(table.sourceId)
      .where(sql`${table.sourceId} IS NOT NULL`),
    p.check(
      "legal_graph_edges_kind_check",
      sql`${table.kind} IN (${KIND_SQL_VALUES})`,
    ),
    p.check(
      "legal_graph_edges_node_kinds_check",
      sql`${table.fromKind} IN (${NODE_KIND_SQL_VALUES}) AND ${table.toKind} IN (${NODE_KIND_SQL_VALUES})`,
    ),
    // The ends each kind may join (`GRAPH_EDGE_RULES`).
    p.check(
      "legal_graph_edges_endpoints_check",
      sql`(${table.kind}, ${table.fromKind}, ${table.toKind}) IN (${ENDPOINT_SQL_VALUES})`,
    ),
    // A claim end names its claim and run and no entity; any other end, its
    // entity alone.
    p.check(
      "legal_graph_edges_from_node_check",
      sql`CASE WHEN ${table.fromKind} = 'claim'
        THEN ${table.fromClaimId} IS NOT NULL AND ${table.fromClaimRunId} IS NOT NULL AND ${table.fromEntityId} IS NULL
        ELSE ${table.fromClaimId} IS NULL AND ${table.fromClaimRunId} IS NULL AND ${table.fromEntityId} IS NOT NULL
        END`,
    ),
    p.check(
      "legal_graph_edges_stance_check",
      sql`(${table.kind} IN (${STANCE_KIND_SQL_VALUES})) = (${table.stance} IS NOT NULL)
        AND (${table.stance} IS NULL OR ${table.stance} IN (${STANCE_SQL_VALUES}))`,
    ),
    // Exactly one of a Spot or the reason there is none, as the kind says.
    p.check(
      "legal_graph_edges_provenance_check",
      sql`(${table.sourceId} IS NULL) <> (${table.provenanceReason} IS NULL)
        AND (${table.kind} IN (${SPOT_KIND_SQL_VALUES})) = (${table.sourceId} IS NOT NULL)
        AND (${table.kind} IN (${CLAIM_ANCHOR_KIND_SQL_VALUES})) = (${table.provenanceReason} IS NOT DISTINCT FROM 'claim-anchor')
        AND (${table.provenanceReason} IS NULL OR ${table.provenanceReason} IN (${PROVENANCE_REASON_SQL_VALUES}))`,
    ),
    p.check(
      "legal_graph_edges_producer_check",
      sql`${table.producerKind} IN (${PRODUCER_KIND_SQL_VALUES})
        AND (${table.producerKind} IN (${RECORDED_PRODUCER_KIND_SQL_VALUES})) = (${table.producerId} IS NOT NULL)`,
    ),
    p.check(
      "legal_graph_edges_confidence_check",
      sql`${table.confidence} IS NULL OR ${table.confidence} IN (${CONFIDENCE_SQL_VALUES})`,
    ),
    ...entityFeaturePolicies(
      table,
      new Map([
        [
          table.fromClaimId,
          { kind: "owned-by-parent", parent: legalListClaims },
        ],
        [table.fromEntityId, { target: "entities", kind: "owned-content" }],
        [table.toEntityId, { target: "entities", kind: "owned-content" }],
        [
          table.sourceId,
          { kind: "owned-by-parent", parent: legalListItemSources },
        ],
      ]),
    ),
    p.pgPolicy("workspace_select", {
      for: "select",
      to: stella,
      using: workspaceCheck,
    }),
    p.pgPolicy("workspace_insert", {
      for: "insert",
      to: stella,
      withCheck: workspaceCheck,
    }),
    // Edges are never rewritten or removed by the application; they go only
    // with an end, the claim's run or the Spot, by cascade.
    p.pgPolicy("legal_graph_edges_no_update", {
      as: "restrictive",
      for: "update",
      to: stella,
      using: sql`false`,
    }),
    p.pgPolicy("legal_graph_edges_no_delete", {
      as: "restrictive",
      for: "delete",
      to: stella,
      using: sql`false`,
    }),
  ],
);
