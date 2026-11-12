/**
 * Find nodes of a matter's graph by their words: the start of every graph
 * question an agent asks. Read-only.
 */

import { Result } from "better-result";
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
  GRAPH_LOOKUP_NODE_KINDS,
  GRAPH_READ_LIMITS,
  lookupGraphNodes,
} from "@/api/lib/lists/graph/read";
import type { GraphLookupCursor } from "@/api/lib/lists/graph/read";
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
    "Find nodes of the matter's graph whose words contain `text` " +
    "(case-insensitive): list facts and documents by name, claims found in " +
    "verified documents by their words. Each node has `kind`, `id` and " +
    "`label`; a claim also names its `documentId` and `runId`. Pass a " +
    "node's `kind` and `id` to `lists.graph.neighbours.list` to read what " +
    "it is linked to, or to `lists.graph.paths.list` to follow links " +
    "further. Ordered by kind (facts, claims, documents), then id; " +
    "paginated with a cursor.",
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
    text: v.pipe(
      v.string(),
      v.trim(),
      v.minLength(1),
      v.maxLength(GRAPH_READ_LIMITS.LOOKUP_TEXT_MAX),
      v.description("Words the node's name or text contains."),
    ),
    kind: v.optional(
      v.pipe(
        v.picklist(GRAPH_LOOKUP_NODE_KINDS),
        v.description("Only nodes of this kind; every kind when left out."),
      ),
    ),
    cursor: v.optional(paginationCursorSchema()),
    limit: v.optional(
      numberFromString(
        paginationLimitSchema(GRAPH_READ_LIMITS.LOOKUP_PAGE_MAX),
      ),
    ),
  }),
} satisfies WorkspaceHandlerConfig;

const decodeCursor = (cursor: string): GraphLookupCursor | null => {
  const parts = decodePaginationCursor(cursor);
  const [kind, id] = parts ?? [];
  const lookupKind = GRAPH_LOOKUP_NODE_KINDS.find((value) => value === kind);
  return parts?.length === 2 &&
    lookupKind !== undefined &&
    isUuidPaginationCursorPart(id)
    ? { kind: lookupKind, id }
    : null;
};

const listGraphNodes = createSafeHandler(
  config,
  async function* ({
    query: { text, kind, cursor, limit },
    safeDb,
    session,
    user,
    workspaceId,
    recordAuditEvent,
  }) {
    const after =
      cursor === undefined || cursor === "" ? null : decodeCursor(cursor);
    if (after === null && cursor !== undefined && cursor !== "") {
      return Result.err(
        new HandlerError({
          status: 400,
          code: "invalid_cursor",
          message: "Invalid cursor",
          hint: "Repeat the first call without `cursor`, then pass back the `nextCursor` it returns.",
        }),
      );
    }
    const page = yield* Result.await(
      safeDb(async (tx) => {
        const found = await lookupGraphNodes({
          tx,
          workspaceId,
          text,
          kinds: kind === undefined ? GRAPH_LOOKUP_NODE_KINDS : [kind],
          after,
          limit: normalizeTenantPageLimit(
            limit ?? GRAPH_READ_LIMITS.LOOKUP_PAGE_MAX,
          ),
        });
        await recordGraphReads({
          tx,
          nodes: found.nodes,
          organizationId: session.activeOrganizationId,
          workspaceId,
          userId: user.id,
          recordAuditEvent,
        });
        return found;
      }),
    );
    return Result.ok({
      nodes: page.nodes,
      nextCursor:
        page.after === null
          ? null
          : encodePaginationCursor([page.after.kind, page.after.id]),
    });
  },
);

export default listGraphNodes;
