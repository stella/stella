/**
 * Follow the matter's graph from a node for up to three hops, returning each
 * path with the exact text every link rests on. Read-only.
 */

import { panic, Result } from "better-result";
import * as v from "valibot";

import { numberFromString } from "@stll/api-contract/http-input";

import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import {
  paginationLimitSchema,
  workspaceParams,
} from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIST_VERIFICATION_FEATURE_ID } from "@/api/lib/feature-access/registry";
import {
  graphEdgeFilterOf,
  graphEdgeFilterQueryEntries,
  graphNodeQueryEntries,
  graphWalkDepthSchema,
} from "@/api/lib/lists/graph/inputs";
import {
  GRAPH_READ_LIMITS,
  readGraphNode,
  walkGraph,
} from "@/api/lib/lists/graph/read";
import { recordGraphReads } from "@/api/lib/lists/graph/read-audit";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";

const DEFAULT_DEPTH = 2;

const config = {
  contract: "patch",
  featureAccess: { featureId: LIST_VERIFICATION_FEATURE_ID, type: "required" },
  description:
    "Follow the matter's graph from one node, either way along its links, " +
    `for \`depth\` hops (1 to ${String(GRAPH_READ_LIMITS.WALK_DEPTH_MAX)}, ` +
    `default ${String(DEFAULT_DEPTH)}): for a claim, the facts it rests on ` +
    "and the documents they come from; for a fact, the claims citing it. " +
    "Each path lists its `nodes` from the start and the `edges` between " +
    "them, each edge with its `kind`, `stance`, `decision`, `producer` and " +
    "`quote` (the exact text it rests on). No node repeats within a path. " +
    "Filter every hop by `edgeKind`, `stance` or `decision`. At most " +
    "`limit` paths come back; `truncated` is true when more exist (read " +
    "fewer hops or filter, or page one hop with " +
    "`lists.graph.neighbours.list`).",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "document_processing",
    consumesServices: false,
  },
  params: workspaceParams({}),
  query: v.object({
    ...graphNodeQueryEntries,
    ...graphEdgeFilterQueryEntries,
    depth: graphWalkDepthSchema,
    limit: v.optional(
      numberFromString(paginationLimitSchema(GRAPH_READ_LIMITS.WALK_PATHS_MAX)),
    ),
  }),
} satisfies WorkspaceHandlerConfig;

const listGraphPaths = createSafeHandler(
  config,
  async function* ({
    query,
    safeDb,
    session,
    user,
    workspaceId,
    recordAuditEvent,
  }) {
    const outcome = yield* Result.await(
      safeDb(async (tx) => {
        const start = await readGraphNode(tx, workspaceId, {
          kind: query.nodeKind,
          id: query.nodeId,
        });
        if (start === null) {
          return { type: "not-found" } as const;
        }
        const walk = await walkGraph({
          tx,
          workspaceId,
          start,
          depth: query.depth ?? DEFAULT_DEPTH,
          filter: graphEdgeFilterOf(query),
          maxPaths: normalizeTenantPageLimit(
            query.limit ?? GRAPH_READ_LIMITS.WALK_PATHS_MAX,
          ),
        });
        await recordGraphReads({
          tx,
          nodes: [start, ...walk.paths.flatMap((path) => path.nodes)],
          organizationId: session.activeOrganizationId,
          workspaceId,
          userId: user.id,
          recordAuditEvent,
        });
        return { type: "read", walk } as const;
      }),
    );
    switch (outcome.type) {
      case "not-found": {
        return Result.err(
          new HandlerError({
            status: 404,
            code: "not_found",
            message: "Graph node not found",
            hint: "Find the node with `lists.graph.nodes.list` and pass its `kind` and `id` as `nodeKind` and `nodeId`.",
          }),
        );
      }
      case "read": {
        return Result.ok(outcome.walk);
      }
      default: {
        outcome satisfies never;
        return panic(`Unhandled outcome: ${String(outcome)}`);
      }
    }
  },
);

export default listGraphPaths;
