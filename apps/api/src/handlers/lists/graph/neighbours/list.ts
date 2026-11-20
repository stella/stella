/**
 * One hop of the matter's graph from a node: a summary of its links and a
 * page of them, each with its exact text. Read-only.
 */

import { panic, Result } from "better-result";
import * as v from "valibot";

import { numberFromString } from "@stll/api-contract/http-input";

import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import {
  paginationCursorSchema,
  paginationLimitSchema,
  workspaceParams,
} from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIST_VERIFICATION_FEATURE_ID } from "@/api/lib/feature-access/registry";
import {
  graphEdgeFilterOf,
  graphEdgeFilterQueryEntries,
  graphNodeQueryEntries,
} from "@/api/lib/lists/graph/inputs";
import {
  GRAPH_READ_LIMITS,
  readGraphNeighbourhood,
  readGraphNode,
} from "@/api/lib/lists/graph/read";
import { recordGraphReads } from "@/api/lib/lists/graph/read-audit";
import {
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";

const config = {
  contract: "patch",
  featureAccess: { featureId: LIST_VERIFICATION_FEATURE_ID, type: "required" },
  description:
    "Read what one node of the matter's graph is linked to, one hop either " +
    "way. `summary` counts all the node's links by `kind`, `stance` and " +
    "`decision`; `edges` is a page of them. Each edge names `from`, `to` and the " +
    "`neighbour` at its far end, its `kind` (`cites`: a claim rests on a " +
    "fact, with `stance` `supports`, `conflicts` or `record`; " +
    "`sourced-from`: a fact comes from a document), who produced it " +
    "(`producer`), its `decision` (`proposed`, `accepted`, `rejected`) and " +
    "`quote`: the exact text it rests on, with the document and locator. " +
    "A claim's citations are those of the grade it is read with now (a " +
    "re-check replaces the run's). Filter by `edgeKind`, `stance` or " +
    "`decision`; paginated with a cursor.",
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
    cursor: v.optional(paginationCursorSchema()),
    limit: v.optional(
      numberFromString(
        paginationLimitSchema(GRAPH_READ_LIMITS.NEIGHBOURS_PAGE_MAX),
      ),
    ),
  }),
} satisfies WorkspaceHandlerConfig;

const listGraphNeighbours = createSafeHandler(
  config,
  async function* ({
    query,
    safeDb,
    session,
    user,
    workspaceId,
    recordAuditEvent,
  }) {
    const { cursor } = query;
    const parts =
      cursor === undefined || cursor === ""
        ? null
        : decodePaginationCursor(cursor);
    const after = parts?.length === 1 ? parts[0] : null;
    if (
      cursor !== undefined &&
      cursor !== "" &&
      !isUuidPaginationCursorPart(after)
    ) {
      return Result.err(
        new HandlerError({
          status: 400,
          code: "invalid_cursor",
          message: "Invalid cursor",
          hint: "Repeat the first call without `cursor`, then pass back the `nextCursor` it returns.",
        }),
      );
    }
    const outcome = yield* Result.await(
      safeDb(async (tx) => {
        const node = await readGraphNode(tx, workspaceId, {
          kind: query.nodeKind,
          id: query.nodeId,
        });
        if (node === null) {
          return { type: "not-found" } as const;
        }
        const neighbourhood = await readGraphNeighbourhood({
          tx,
          workspaceId,
          node,
          filter: graphEdgeFilterOf(query),
          after: isUuidPaginationCursorPart(after) ? after : null,
          limit: normalizeTenantPageLimit(
            query.limit ?? GRAPH_READ_LIMITS.NEIGHBOURS_PAGE_MAX,
          ),
        });
        await recordGraphReads({
          tx,
          nodes: [node, ...neighbourhood.edges.map((edge) => edge.neighbour)],
          organizationId: session.activeOrganizationId,
          workspaceId,
          userId: user.id,
          recordAuditEvent,
        });
        return { type: "read", neighbourhood } as const;
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
        const { after: next, ...neighbourhood } = outcome.neighbourhood;
        return Result.ok({
          ...neighbourhood,
          nextCursor: next === null ? null : encodePaginationCursor([next]),
        });
      }
      default: {
        outcome satisfies never;
        return panic(`Unhandled outcome: ${String(outcome)}`);
      }
    }
  },
);

export default listGraphNeighbours;
