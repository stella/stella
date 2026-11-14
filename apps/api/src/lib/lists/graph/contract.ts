// The matter graph's vocabulary: one typed edge table over the blocks that
// already exist (list facts and issues, documents, verification claims and
// the Spots facts are sourced from), never a store beside them. Every edge
// says what it links, who produced it and which exact text it rests on.
//
// Dependency-light on purpose: the database schema derives its CHECKs from
// the consts here, and the writers, the backfill and the readers share one
// definition of an edge.

import { foldReviewDecisions } from "@stll/api-contract/review-decision";
import type { ReviewDecisionEvent } from "@stll/api-contract/review-decision";

import { CLAIM_FACT_RELATIONS } from "@/api/lib/lists/verification/contract";

/**
 * What an edge end is. A claim is a verification claim row; every other node
 * is an entity the workspace owns: a fact or an issue is a list item, a
 * document is a document entity, a person is the entity that names them.
 */
export const GRAPH_NODE_KINDS = [
  "fact",
  "claim",
  "document",
  "person",
  "issue",
] as const;
export type GraphNodeKind = (typeof GRAPH_NODE_KINDS)[number];

export const GRAPH_EDGE_KINDS = [
  "cites",
  "sourced-from",
  "mentions",
  "about",
] as const;
export type GraphEdgeKind = (typeof GRAPH_EDGE_KINDS)[number];

/**
 * How a claim relates to a fact it cites: the relation the grader gave it.
 * `record` is a fact the verdict rests on as context, neither supporting nor
 * conflicting; it is kept so no citation a grade made is lost.
 */
export const GRAPH_EDGE_STANCES = CLAIM_FACT_RELATIONS;
export type GraphEdgeStance = (typeof GRAPH_EDGE_STANCES)[number];

/**
 * Why an edge carries no Spot of its own. `claim-anchor`: the edge is a
 * grader's reading of a claim against a fact, and its exact text is the
 * claim's own anchored words in the verified document.
 */
export const GRAPH_PROVENANCE_REASONS = ["claim-anchor"] as const;
export type GraphProvenanceReason = (typeof GRAPH_PROVENANCE_REASONS)[number];

/**
 * Who asserted an edge, each naming the record that holds the act:
 * - `run`: a verification run's grade (the run);
 * - `recheck`: a re-check's grade (its review event), kept apart from the
 *   run's so a re-grade never merges into the grade it replaced;
 * - `extraction`: a list generation run whose proposal a reviewer accepted
 *   (the generation run);
 * - `reviewer`: a reviewer's own act (the row that records it, which names
 *   them, so their identity is never copied here);
 * - `import`: an import with no producing record.
 */
export const GRAPH_EDGE_PRODUCER_KINDS = [
  "run",
  "recheck",
  "extraction",
  "reviewer",
  "import",
] as const;
export type GraphEdgeProducerKind = (typeof GRAPH_EDGE_PRODUCER_KINDS)[number];

/** Producers that name a producing record; `import` names none. */
export const RECORDED_GRAPH_EDGE_PRODUCER_KINDS = [
  "run",
  "recheck",
  "extraction",
  "reviewer",
] as const satisfies readonly GraphEdgeProducerKind[];

export const GRAPH_EDGE_DECISIONS = [
  "proposed",
  "accepted",
  "rejected",
] as const;
export type GraphEdgeDecision = (typeof GRAPH_EDGE_DECISIONS)[number];

type GraphEdgeProvenanceRule =
  { type: "spot" } | { type: "reason"; reason: GraphProvenanceReason };

type GraphEdgeRule = {
  /** The (from, to) node kinds the edge may join. */
  ends: readonly (readonly [GraphNodeKind, GraphNodeKind])[];
  stance: "required" | "none";
  provenance: GraphEdgeProvenanceRule;
  /** Where a reviewer's decisions on the edge are recorded: the Spot's own
   *  decision history, or nowhere yet (every edge of the kind is proposed). */
  decisions: "spot" | "none";
};

/**
 * Every edge kind's shape. The table's CHECKs, the writers and the readers
 * all derive from this map, so a kind cannot be stored one way and read
 * another.
 *
 * `mentions` and `about` have no producer yet: extraction will propose them,
 * grounded in a Spot, for a reviewer to accept.
 */
export const GRAPH_EDGE_RULES = {
  cites: {
    ends: [["claim", "fact"]],
    stance: "required",
    provenance: { type: "reason", reason: "claim-anchor" },
    decisions: "none",
  },
  "sourced-from": {
    ends: [["fact", "document"]],
    stance: "none",
    provenance: { type: "spot" },
    decisions: "spot",
  },
  mentions: {
    ends: [["fact", "person"]],
    stance: "none",
    provenance: { type: "spot" },
    decisions: "none",
  },
  about: {
    ends: [
      ["fact", "issue"],
      ["claim", "issue"],
    ],
    stance: "none",
    provenance: { type: "spot" },
    decisions: "none",
  },
} as const satisfies Record<GraphEdgeKind, GraphEdgeRule>;

/**
 * An edge's decision: the fold of the append-only decision events its kind
 * records them in (`GRAPH_EDGE_RULES[kind].decisions`), `proposed` until a
 * reviewer decides and again after one withdraws their decision. Events are
 * never rewritten and the edge row never holds a decision, so replaying a
 * writer cannot overwrite one.
 */
export const graphEdgeDecisionOf = (
  events: readonly ReviewDecisionEvent[],
): GraphEdgeDecision => foldReviewDecisions(events).decision ?? "proposed";
