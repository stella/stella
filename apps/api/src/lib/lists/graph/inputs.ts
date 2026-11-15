// The agent tools' shared inputs: which node, and which of its edges. Closed
// enums only, one value per filter, so a model filling every property still
// sends one coherent request.

import * as v from "valibot";

import { numberFromString } from "@stll/api-contract/http-input";

import { uuidSchema } from "@/api/lib/custom-schema";
import {
  GRAPH_EDGE_DECISIONS,
  GRAPH_EDGE_KINDS,
  GRAPH_EDGE_STANCES,
} from "@/api/lib/lists/graph/contract";
import type { GraphEdgeFilter } from "@/api/lib/lists/graph/read";
import {
  GRAPH_LOOKUP_NODE_KINDS,
  GRAPH_READ_LIMITS,
} from "@/api/lib/lists/graph/read";

const NODE_KIND_DESCRIPTION =
  "What the node is: `fact` (a list fact), `claim` (a claim found in a verified document) or `document`. Take it from a `lists.graph.nodes.list` result.";

/** One node, as `lists.graph.nodes.list` and every edge name it. */
export const graphNodeQueryEntries = {
  nodeKind: v.pipe(
    v.picklist(GRAPH_LOOKUP_NODE_KINDS),
    v.description(NODE_KIND_DESCRIPTION),
  ),
  nodeId: v.pipe(
    uuidSchema,
    v.description(
      "The node's id, from a `lists.graph.nodes.list` result or an edge's `from`/`to`.",
    ),
  ),
};

/** Which edges count: each filter narrows to one value, or is left out. */
export const graphEdgeFilterQueryEntries = {
  edgeKind: v.optional(
    v.pipe(
      v.picklist(GRAPH_EDGE_KINDS),
      v.description(
        "Only edges of this kind: `cites` (a claim rests on a fact), `sourced-from` (a fact comes from a document passage), `mentions`, `about`.",
      ),
    ),
  ),
  stance: v.optional(
    v.pipe(
      v.picklist(GRAPH_EDGE_STANCES),
      v.description(
        "Only citations with this stance: `supports`, `conflicts`, or `record` (context the verdict rests on).",
      ),
    ),
  ),
  decision: v.optional(
    v.pipe(
      v.picklist(GRAPH_EDGE_DECISIONS),
      v.description(
        "Only edges a reviewer has `accepted` or `rejected`, or that are still `proposed`.",
      ),
    ),
  ),
};

export const graphEdgeFilterOf = (query: {
  edgeKind?: GraphEdgeFilter["kinds"][number] | undefined;
  stance?: GraphEdgeFilter["stances"][number] | undefined;
  decision?: GraphEdgeFilter["decisions"][number] | undefined;
}): GraphEdgeFilter => ({
  kinds: query.edgeKind === undefined ? [] : [query.edgeKind],
  stances: query.stance === undefined ? [] : [query.stance],
  decisions: query.decision === undefined ? [] : [query.decision],
});

export const graphWalkDepthSchema = v.optional(
  v.pipe(
    numberFromString(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
        v.maxValue(GRAPH_READ_LIMITS.WALK_DEPTH_MAX),
      ),
    ),
    v.description(
      `Hops to walk from the node, 1 to ${String(GRAPH_READ_LIMITS.WALK_DEPTH_MAX)}; 2 when left out.`,
    ),
  ),
);
