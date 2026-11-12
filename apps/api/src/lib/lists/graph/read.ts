/**
 * Query reads of the matter graph for agents: find a node, read one node's
 * neighbourhood, and walk bounded paths. Every edge comes back with its
 * exact text (the Spot's quote, or the claim's anchored words), its producer
 * and its decision.
 *
 * Walls are applied in SQL. The reads run on the caller's scoped transaction,
 * so row security hides the edges and nodes of matters, documents and
 * features the caller cannot see, and an edge whose far end, claim or Spot is
 * hidden is left out by the join, never filtered afterwards.
 *
 * Bounded by construction: a lookup reads at most `limit` + 1 nodes per kind,
 * a neighbourhood page at most `limit` + 1 edges and one grouped count, and a
 * walk at most `GRAPH_READ_LIMITS.WALK_EDGES_PER_HOP` + 1 edges per hop for
 * at most `GRAPH_READ_LIMITS.WALK_DEPTH_MAX` hops.
 */

import { panic } from "better-result";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { LIST_ITEM_TYPE } from "@stll/api-contract/entity-options";

import type { Transaction } from "@/api/db/root";
import {
  entities,
  legalGraphEdges,
  legalListClaimReviewEvents,
  legalListClaims,
  legalListItemSourceDecisions,
  legalListItemSources,
  legalListVerificationRuns,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { escapeLike } from "@/api/lib/escape-like";
import type { FactConfidence } from "@/api/lib/lists/fact-details";
import {
  GRAPH_EDGE_DECISIONS,
  GRAPH_EDGE_KINDS,
  GRAPH_EDGE_RULES,
  GRAPH_EDGE_STANCES,
} from "@/api/lib/lists/graph/contract";
import type {
  GraphEdgeDecision,
  GraphEdgeKind,
  GraphEdgeProducerKind,
  GraphEdgeStance,
  GraphNodeKind,
  GraphProvenanceReason,
} from "@/api/lib/lists/graph/contract";
import type { LegalListSourceLocator } from "@/api/lib/lists/types";
import type {
  ClaimAnchor,
  ClaimReviewEventKind,
} from "@/api/lib/lists/verification/contract";

export const GRAPH_READ_LIMITS = {
  /** Nodes one lookup returns per page. */
  LOOKUP_PAGE_MAX: 50,
  /** Edges one neighbourhood page returns. */
  NEIGHBOURS_PAGE_MAX: 50,
  /** Hops one walk may take. */
  WALK_DEPTH_MAX: 3,
  /** Paths one walk returns. */
  WALK_PATHS_MAX: 50,
  /** Edges one hop of a walk reads; a hop with more is reported truncated. */
  WALK_EDGES_PER_HOP: 200,
  /** Edges one neighbourhood summary counts; past it the summary says it
   *  is partial. */
  SUMMARY_EDGES_MAX: 5000,
  /** Characters of a lookup's text. */
  LOOKUP_TEXT_MAX: 200,
  /** Characters of a node label: a fact's or document's name, a claim's
   *  words. The quote on an edge is never shortened. */
  LABEL_MAX: 300,
} as const;

/** The node kinds a lookup can find today: those an edge has a producer for. */
export const GRAPH_LOOKUP_NODE_KINDS = [
  "fact",
  "claim",
  "document",
] as const satisfies readonly GraphNodeKind[];
export type GraphLookupNodeKind = (typeof GRAPH_LOOKUP_NODE_KINDS)[number];

export type GraphNodeRef = { kind: GraphNodeKind; id: string };

export type GraphNode = GraphNodeRef & {
  label: string;
  /** For a claim: the verified document it was read from, and the run
   *  that read it. */
  documentId: SafeId<"entity"> | null;
  runId: SafeId<"legalListVerificationRun"> | null;
};

/** The exact text an edge rests on. */
export type GraphEdgeQuote = {
  text: string | null;
  documentId: SafeId<"entity">;
  documentName: string;
  locator: LegalListSourceLocator | ClaimAnchor;
};

export type GraphEdgeView = {
  id: SafeId<"legalGraphEdge">;
  kind: GraphEdgeKind;
  from: GraphNode;
  to: GraphNode;
  stance: GraphEdgeStance | null;
  decision: GraphEdgeDecision;
  confidence: FactConfidence | null;
  producer: { kind: GraphEdgeProducerKind; id: string | null };
  provenance:
    | { type: "spot"; sourceId: SafeId<"legalListItemSource"> }
    | { type: "reason"; reason: GraphProvenanceReason };
  quote: GraphEdgeQuote | null;
};

export type GraphEdgeFilter = {
  kinds: readonly GraphEdgeKind[];
  stances: readonly GraphEdgeStance[];
  decisions: readonly GraphEdgeDecision[];
};

const fromEntity = alias(entities, "graph_from_entity");
const toEntity = alias(entities, "graph_to_entity");
const claimDocument = alias(entities, "graph_claim_document");
const spotDocument = alias(entities, "graph_spot_document");

const SPOT_DECIDED_KINDS = GRAPH_EDGE_KINDS.filter(
  (kind) => GRAPH_EDGE_RULES[kind].decisions === "spot",
);
const RECHECK_EVENT = "recheck" satisfies ClaimReviewEventKind;
const CITES = "cites" satisfies GraphEdgeKind;
const PROPOSED = "proposed" satisfies GraphEdgeDecision;

/**
 * An edge's decision, folded in SQL as `graphEdgeDecisionOf` folds it: the
 * latest event of the record its kind keeps decisions in, `proposed` when
 * there is none or the latest withdrew one. Used to filter and to read, so a
 * filtered page and its rows agree.
 */
const decisionSql: SQL<string> = sql<string>`CASE
  WHEN ${inArray(legalGraphEdges.kind, SPOT_DECIDED_KINDS)} THEN COALESCE((
    SELECT ${legalListItemSourceDecisions.decision}
    FROM ${legalListItemSourceDecisions}
    WHERE ${legalListItemSourceDecisions.sourceId} = ${legalGraphEdges.sourceId}
    ORDER BY ${legalListItemSourceDecisions.createdAt} DESC, ${legalListItemSourceDecisions.id} DESC
    LIMIT 1
  ), ${PROPOSED})
  ELSE ${PROPOSED}
END`;

/**
 * A claim's citations are read from the grade it is read with
 * (`gradeOf`): its latest re-check's, else its run's. Citations of a grade
 * it replaced stay stored and are not current.
 */
// sql-perf-allow: bounded by the edge page or count cap; each probe reads one claim's review events through legal_list_claim_review_events_ef_claim_id_idx.
const currentCitation = or(
  sql`${legalGraphEdges.kind} <> ${CITES}`,
  sql`${legalGraphEdges.producerId} = COALESCE((
    SELECT ${legalListClaimReviewEvents.id}
    FROM ${legalListClaimReviewEvents}
    WHERE ${legalListClaimReviewEvents.workspaceId} = ${legalGraphEdges.workspaceId}
      AND ${legalListClaimReviewEvents.claimId} = ${legalGraphEdges.fromClaimId}
      AND ${legalListClaimReviewEvents.kind} = ${RECHECK_EVENT}
    ORDER BY ${legalListClaimReviewEvents.createdAt} DESC, ${legalListClaimReviewEvents.id} DESC
    LIMIT 1
  ), ${legalGraphEdges.fromClaimRunId})`,
);

const filterSql = (filter: GraphEdgeFilter): SQL[] => [
  ...(filter.kinds.length === 0
    ? []
    : [inArray(legalGraphEdges.kind, [...filter.kinds])]),
  ...(filter.stances.length === 0
    ? []
    : [inArray(legalGraphEdges.stance, [...filter.stances])]),
  ...(filter.decisions.length === 0
    ? []
    : [
        sql`(${decisionSql}) IN (${sql.join(
          filter.decisions.map((decision) => sql`${decision}`),
          sql`, `,
        )})`,
      ]),
];

/** Edges whose every end, claim and Spot the caller can see. */
const visibleEnds = and(
  or(
    isNull(legalGraphEdges.fromClaimId),
    sql`${legalListClaims.id} IS NOT NULL`,
  ),
  or(isNull(legalGraphEdges.fromEntityId), sql`${fromEntity.id} IS NOT NULL`),
  or(
    isNull(legalGraphEdges.sourceId),
    sql`${legalListItemSources.id} IS NOT NULL`,
  ),
);

const truncate = (text: string) =>
  text.length <= GRAPH_READ_LIMITS.LABEL_MAX
    ? text
    : `${text.slice(0, GRAPH_READ_LIMITS.LABEL_MAX - 1)}…`;

const isDecision = (value: string): value is GraphEdgeDecision =>
  GRAPH_EDGE_DECISIONS.some((decision) => decision === value);

const selectEdges = (tx: Transaction) =>
  tx
    .select({
      id: legalGraphEdges.id,
      kind: legalGraphEdges.kind,
      fromKind: legalGraphEdges.fromKind,
      fromClaimId: legalGraphEdges.fromClaimId,
      fromClaimRunId: legalGraphEdges.fromClaimRunId,
      fromEntityId: legalGraphEdges.fromEntityId,
      toKind: legalGraphEdges.toKind,
      toEntityId: legalGraphEdges.toEntityId,
      stance: legalGraphEdges.stance,
      sourceId: legalGraphEdges.sourceId,
      provenanceReason: legalGraphEdges.provenanceReason,
      producerKind: legalGraphEdges.producerKind,
      producerId: legalGraphEdges.producerId,
      confidence: legalGraphEdges.confidence,
      decision: decisionSql,
      claimText: legalListClaims.text,
      claimAnchor: legalListClaims.anchor,
      claimDocumentId: claimDocument.id,
      claimDocumentName: claimDocument.name,
      fromName: fromEntity.name,
      toName: toEntity.name,
      spotQuote: legalListItemSources.quote,
      spotLocator: legalListItemSources.locator,
      spotDocumentId: spotDocument.id,
      spotDocumentName: spotDocument.name,
    })
    .from(legalGraphEdges)
    .leftJoin(
      legalListClaims,
      and(
        eq(legalListClaims.id, legalGraphEdges.fromClaimId),
        eq(legalListClaims.runId, legalGraphEdges.fromClaimRunId),
        eq(legalListClaims.workspaceId, legalGraphEdges.workspaceId),
      ),
    )
    .leftJoin(
      legalListVerificationRuns,
      and(
        eq(legalListVerificationRuns.id, legalListClaims.runId),
        eq(legalListVerificationRuns.workspaceId, legalListClaims.workspaceId),
      ),
    )
    .leftJoin(
      claimDocument,
      and(
        eq(claimDocument.id, legalListVerificationRuns.entityId),
        eq(claimDocument.workspaceId, legalListVerificationRuns.workspaceId),
      ),
    )
    .leftJoin(
      fromEntity,
      and(
        eq(fromEntity.id, legalGraphEdges.fromEntityId),
        eq(fromEntity.workspaceId, legalGraphEdges.workspaceId),
      ),
    )
    .innerJoin(
      toEntity,
      and(
        eq(toEntity.id, legalGraphEdges.toEntityId),
        eq(toEntity.workspaceId, legalGraphEdges.workspaceId),
      ),
    )
    .leftJoin(
      legalListItemSources,
      and(
        eq(legalListItemSources.id, legalGraphEdges.sourceId),
        eq(legalListItemSources.workspaceId, legalGraphEdges.workspaceId),
      ),
    )
    .leftJoin(
      spotDocument,
      and(
        eq(spotDocument.id, legalListItemSources.sourceEntityId),
        eq(spotDocument.workspaceId, legalListItemSources.workspaceId),
      ),
    );

type EdgeRow = Awaited<
  ReturnType<ReturnType<typeof selectEdges>["where"]>
>[number];

/** The exact text an edge rests on: its Spot's quote, else the words of
 *  the claim it starts from. Null only when that row is out of sight. */
const quoteOf = (row: EdgeRow): GraphEdgeQuote | null => {
  if (row.sourceId !== null) {
    if (row.spotDocumentId === null || row.spotLocator === null) {
      return null;
    }
    return {
      text: row.spotQuote,
      documentId: row.spotDocumentId,
      documentName: row.spotDocumentName ?? "",
      locator: row.spotLocator,
    };
  }
  if (row.claimDocumentId === null || row.claimAnchor === null) {
    return null;
  }
  return {
    text: row.claimText,
    documentId: row.claimDocumentId,
    documentName: row.claimDocumentName ?? "",
    locator: row.claimAnchor,
  };
};

const viewOf = (row: EdgeRow): GraphEdgeView => {
  const decision = isDecision(row.decision)
    ? row.decision
    : panic(`Unknown graph edge decision: ${row.decision}`);
  const from: GraphNode =
    row.fromClaimId === null
      ? {
          kind: row.fromKind,
          id: row.fromEntityId ?? panic("An entity end names no entity"),
          label: truncate(row.fromName ?? ""),
          documentId: null,
          runId: null,
        }
      : {
          kind: row.fromKind,
          id: row.fromClaimId,
          label: truncate(row.claimText ?? ""),
          documentId: row.claimDocumentId,
          runId: row.fromClaimRunId,
        };
  const to: GraphNode = {
    kind: row.toKind,
    id: row.toEntityId,
    label: truncate(row.toName),
    documentId: null,
    runId: null,
  };
  const quote = quoteOf(row);
  return {
    id: row.id,
    kind: row.kind,
    from,
    to,
    stance: row.stance,
    decision,
    confidence: row.confidence,
    producer: { kind: row.producerKind, id: row.producerId },
    provenance:
      row.sourceId === null
        ? {
            type: "reason",
            reason:
              row.provenanceReason ?? panic("An edge carries no provenance"),
          }
        : { type: "spot", sourceId: row.sourceId },
    quote,
  };
};

/** Ids a caller named, as bound parameters of an `IN` list. */
const idParams = (ids: readonly string[]): SQL =>
  sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );

/** The edges touching any of `nodes`, either way along them. */
const touching = (nodes: readonly GraphNodeRef[]): SQL => {
  const claimIds = nodes
    .filter((node) => node.kind === "claim")
    .map((n) => n.id);
  const entityIds = nodes
    .filter((node) => node.kind !== "claim")
    .map((n) => n.id);
  const sides: SQL[] = [
    ...(claimIds.length === 0
      ? []
      : [sql`${legalGraphEdges.fromClaimId} IN (${idParams(claimIds)})`]),
    ...(entityIds.length === 0
      ? []
      : [
          sql`${legalGraphEdges.fromEntityId} IN (${idParams(entityIds)})`,
          sql`${legalGraphEdges.toEntityId} IN (${idParams(entityIds)})`,
        ]),
  ];
  return sides.length === 0 ? sql`false` : (or(...sides) ?? sql`false`);
};

const readEdgePage = async ({
  tx,
  workspaceId,
  nodes,
  filter,
  after,
  limit,
}: {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  nodes: readonly GraphNodeRef[];
  filter: GraphEdgeFilter;
  after: string | null;
  limit: number;
}): Promise<GraphEdgeView[]> =>
  (
    await selectEdges(tx)
      .where(
        and(
          eq(legalGraphEdges.workspaceId, workspaceId),
          touching(nodes),
          visibleEnds,
          currentCitation,
          ...filterSql(filter),
          ...(after === null ? [] : [sql`${legalGraphEdges.id} > ${after}`]),
        ),
      )
      .orderBy(asc(legalGraphEdges.id))
      .limit(limit)
  ).map(viewOf);

const nodeKey = (node: GraphNodeRef) => `${node.kind}:${node.id}`;

const otherEnd = (edge: GraphEdgeView, node: GraphNodeRef): GraphNode =>
  nodeKey(edge.from) === nodeKey(node) ? edge.to : edge.from;

/** One node as the caller can see it, or null. */
export const readGraphNode = async (
  tx: Transaction,
  workspaceId: SafeId<"workspace">,
  node: GraphNodeRef,
): Promise<GraphNode | null> => {
  if (node.kind === "claim") {
    const claim = (
      await tx
        .select({
          id: legalListClaims.id,
          text: legalListClaims.text,
          documentId: legalListVerificationRuns.entityId,
          runId: legalListClaims.runId,
        })
        .from(legalListClaims)
        .innerJoin(
          legalListVerificationRuns,
          and(
            eq(legalListVerificationRuns.id, legalListClaims.runId),
            eq(
              legalListVerificationRuns.workspaceId,
              legalListClaims.workspaceId,
            ),
          ),
        )
        .where(
          and(
            eq(legalListClaims.workspaceId, workspaceId),
            sql`${legalListClaims.id} = ${node.id}`,
          ),
        )
        .limit(1)
    ).at(0);
    return claim === undefined
      ? null
      : {
          kind: "claim",
          id: claim.id,
          label: truncate(claim.text),
          documentId: claim.documentId,
          runId: claim.runId,
        };
  }
  const entity = (
    await tx
      .select({ id: entities.id, name: entities.name })
      .from(entities)
      .where(
        and(
          eq(entities.workspaceId, workspaceId),
          sql`${entities.id} = ${node.id}`,
        ),
      )
      .limit(1)
  ).at(0);
  return entity === undefined
    ? null
    : {
        kind: node.kind,
        id: entity.id,
        label: truncate(entity.name),
        documentId: null,
        runId: null,
      };
};

export type GraphNeighbourhood = {
  node: GraphNode;
  /** Every current edge of the node matching the filter, counted by kind,
   *  stance and decision; the page lists some of them. */
  summary: {
    kind: GraphEdgeKind;
    stance: GraphEdgeStance | null;
    decision: GraphEdgeDecision;
    count: number;
  }[];
  /** False when the node has more matching edges than the summary counts. */
  summaryComplete: boolean;
  edges: (GraphEdgeView & { neighbour: GraphNode })[];
  /** Where the next page starts, or null on the last. */
  after: SafeId<"legalGraphEdge"> | null;
};

/** One hop from a node: a summary of its edges and a page of them. */
export const readGraphNeighbourhood = async ({
  tx,
  workspaceId,
  node,
  filter,
  after,
  limit,
}: {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  node: GraphNode;
  filter: GraphEdgeFilter;
  after: string | null;
  limit: number;
}): Promise<GraphNeighbourhood> => {
  const where = and(
    eq(legalGraphEdges.workspaceId, workspaceId),
    touching([node]),
    visibleEnds,
    currentCitation,
    ...filterSql(filter),
  );
  // Counted over at most SUMMARY_EDGES_MAX of the node's edges.
  const counted = tx
    .select({
      kind: legalGraphEdges.kind,
      stance: legalGraphEdges.stance,
      decision: decisionSql.as("decision"),
    })
    .from(legalGraphEdges)
    .leftJoin(
      legalListClaims,
      and(
        eq(legalListClaims.id, legalGraphEdges.fromClaimId),
        eq(legalListClaims.runId, legalGraphEdges.fromClaimRunId),
        eq(legalListClaims.workspaceId, legalGraphEdges.workspaceId),
      ),
    )
    .leftJoin(
      fromEntity,
      and(
        eq(fromEntity.id, legalGraphEdges.fromEntityId),
        eq(fromEntity.workspaceId, legalGraphEdges.workspaceId),
      ),
    )
    .innerJoin(
      toEntity,
      and(
        eq(toEntity.id, legalGraphEdges.toEntityId),
        eq(toEntity.workspaceId, legalGraphEdges.workspaceId),
      ),
    )
    .leftJoin(
      legalListItemSources,
      and(
        eq(legalListItemSources.id, legalGraphEdges.sourceId),
        eq(legalListItemSources.workspaceId, legalGraphEdges.workspaceId),
      ),
    )
    .where(where)
    .limit(GRAPH_READ_LIMITS.SUMMARY_EDGES_MAX + 1)
    .as("graph_neighbourhood_edges");
  const grouped = await tx
    .select({
      kind: counted.kind,
      stance: counted.stance,
      decision: counted.decision,
      count: sql<number>`count(*)::int`,
    })
    .from(counted)
    .groupBy(counted.kind, counted.stance, counted.decision)
    .orderBy(counted.kind, counted.stance, counted.decision)
    // One row per kind, stance and decision at most.
    .limit(
      GRAPH_EDGE_KINDS.length *
        (GRAPH_EDGE_STANCES.length + 1) *
        GRAPH_EDGE_DECISIONS.length,
    );
  const total = grouped.reduce((sum, row) => sum + row.count, 0);
  const summary = grouped.map((row) => ({
    kind: row.kind,
    stance: row.stance,
    decision: isDecision(row.decision)
      ? row.decision
      : panic(`Unknown graph edge decision: ${row.decision}`),
    count: row.count,
  }));
  const page = await readEdgePage({
    tx,
    workspaceId,
    nodes: [node],
    filter,
    after,
    limit: limit + 1,
  });
  const edges = page.slice(0, limit);
  return {
    node,
    summary,
    summaryComplete: total <= GRAPH_READ_LIMITS.SUMMARY_EDGES_MAX,
    edges: edges.map((edge) => ({ ...edge, neighbour: otherEnd(edge, node) })),
    after: page.length > limit ? (edges.at(-1)?.id ?? null) : null,
  };
};

export type GraphPath = {
  /** The nodes along the path, the start first. */
  nodes: GraphNode[];
  /** The edge between each node and the next. */
  edges: GraphEdgeView[];
};

export type GraphWalk = {
  start: GraphNode;
  paths: GraphPath[];
  /** Whether a hop read its edge cap or the walk its path cap: more paths
   *  exist than the walk returns. */
  truncated: boolean;
};

/**
 * Every simple path from `start` of up to `depth` hops along edges matching
 * the filter, in either direction. Each hop reads the edges of the previous
 * hop's ends in one bounded query.
 */
export const walkGraph = async ({
  tx,
  workspaceId,
  start,
  depth,
  filter,
  maxPaths,
}: {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  start: GraphNode;
  depth: number;
  filter: GraphEdgeFilter;
  maxPaths: number;
}): Promise<GraphWalk> => {
  let frontier: GraphPath[] = [{ nodes: [start], edges: [] }];
  const paths: GraphPath[] = [];
  let truncated = false;
  for (let hop = 0; hop < depth && frontier.length > 0; hop += 1) {
    const ends = [
      ...new Map(
        frontier.map((path) => {
          const end = path.nodes.at(-1) ?? panic("A path has no end");
          return [nodeKey(end), end] as const;
        }),
      ).values(),
    ];
    const edges = await readEdgePage({
      tx,
      workspaceId,
      nodes: ends,
      filter,
      after: null,
      limit: GRAPH_READ_LIMITS.WALK_EDGES_PER_HOP + 1,
    });
    if (edges.length > GRAPH_READ_LIMITS.WALK_EDGES_PER_HOP) {
      truncated = true;
    }
    const hopEdges = edges.slice(0, GRAPH_READ_LIMITS.WALK_EDGES_PER_HOP);
    const next: GraphPath[] = [];
    for (const path of frontier) {
      const end = path.nodes.at(-1) ?? panic("A path has no end");
      const visited = new Set(path.nodes.map(nodeKey));
      for (const edge of hopEdges) {
        const touchesEnd =
          nodeKey(edge.from) === nodeKey(end) ||
          nodeKey(edge.to) === nodeKey(end);
        const neighbour = otherEnd(edge, end);
        if (!touchesEnd || visited.has(nodeKey(neighbour))) {
          continue;
        }
        next.push({
          nodes: [...path.nodes, neighbour],
          edges: [...path.edges, edge],
        });
      }
    }
    paths.push(...next);
    frontier = next;
    if (paths.length >= maxPaths) {
      break;
    }
  }
  if (paths.length > maxPaths) {
    truncated = true;
  }
  return { start, paths: paths.slice(0, maxPaths), truncated };
};

export type GraphLookupHit = GraphNode & { kind: GraphLookupNodeKind };

/** Where a lookup page ends: the kind it reached and the last id in it. */
export type GraphLookupCursor = { kind: GraphLookupNodeKind; id: string };

/**
 * Nodes of the given kinds whose name (a fact, a document) or words (a
 * claim) contain `text`, case-insensitively, in kind order and then id
 * order, after `after`.
 */
export const lookupGraphNodes = async ({
  tx,
  workspaceId,
  text,
  kinds,
  after,
  limit,
}: {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  text: string;
  kinds: readonly GraphLookupNodeKind[];
  after: GraphLookupCursor | null;
  limit: number;
}): Promise<{ nodes: GraphLookupHit[]; after: GraphLookupCursor | null }> => {
  const pattern = `%${escapeLike(text)}%`;
  const ordered = GRAPH_LOOKUP_NODE_KINDS.filter(
    (kind) =>
      kinds.includes(kind) &&
      (after === null ||
        GRAPH_LOOKUP_NODE_KINDS.indexOf(kind) >=
          GRAPH_LOOKUP_NODE_KINDS.indexOf(after.kind)),
  );
  const hits: GraphLookupHit[] = [];
  for (const kind of ordered) {
    const remaining = limit + 1 - hits.length;
    if (remaining <= 0) {
      break;
    }
    const afterId = after !== null && after.kind === kind ? after.id : null;
    hits.push(
      ...(await lookupKind({
        tx,
        workspaceId,
        kind,
        pattern,
        afterId,
        limit: remaining,
      })),
    );
  }
  const page = hits.slice(0, limit);
  const last = page.at(-1);
  return {
    nodes: page,
    after:
      hits.length > limit && last !== undefined
        ? { kind: last.kind, id: last.id }
        : null,
  };
};

const lookupKind = async ({
  tx,
  workspaceId,
  kind,
  pattern,
  afterId,
  limit,
}: {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  kind: GraphLookupNodeKind;
  pattern: string;
  afterId: string | null;
  limit: number;
}): Promise<GraphLookupHit[]> => {
  switch (kind) {
    case "claim": {
      return (
        await tx
          .select({
            id: legalListClaims.id,
            text: legalListClaims.text,
            documentId: legalListVerificationRuns.entityId,
            runId: legalListClaims.runId,
          })
          .from(legalListClaims)
          .innerJoin(
            legalListVerificationRuns,
            and(
              eq(legalListVerificationRuns.id, legalListClaims.runId),
              eq(
                legalListVerificationRuns.workspaceId,
                legalListClaims.workspaceId,
              ),
            ),
          )
          .where(
            and(
              eq(legalListClaims.workspaceId, workspaceId),
              sql`${legalListClaims.text} ILIKE ${pattern}`,
              ...(afterId === null
                ? []
                : [sql`${legalListClaims.id} > ${afterId}`]),
            ),
          )
          .orderBy(asc(legalListClaims.id))
          .limit(limit)
      ).map((row) => ({
        kind: "claim" as const,
        id: row.id,
        label: truncate(row.text),
        documentId: row.documentId,
        runId: row.runId,
      }));
    }
    case "fact":
    case "document": {
      return (
        await tx
          .select({ id: entities.id, name: entities.name })
          .from(entities)
          .where(
            and(
              eq(entities.workspaceId, workspaceId),
              kind === "fact"
                ? eq(entities.listItemType, LIST_ITEM_TYPE.FACT)
                : eq(entities.kind, "document"),
              sql`${entities.name} ILIKE ${pattern}`,
              ...(afterId === null ? [] : [sql`${entities.id} > ${afterId}`]),
            ),
          )
          .orderBy(asc(entities.id))
          .limit(limit)
      ).map((row) => ({
        kind,
        id: row.id,
        label: truncate(row.name),
        documentId: null,
        runId: null,
      }));
    }
    default: {
      kind satisfies never;
      return panic(`Unhandled lookup kind: ${String(kind)}`);
    }
  }
};

/**
 * The verification runs whose claims' words a read delivered: their
 * delivery is audited as the run's own read is.
 */
export const deliveredRunIds = (
  nodes: readonly GraphNode[],
): SafeId<"legalListVerificationRun">[] => [
  ...new Set(
    nodes.flatMap((node) => (node.runId === null ? [] : [node.runId])),
  ),
];
