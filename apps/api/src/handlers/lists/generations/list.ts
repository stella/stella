import { Result } from "better-result";
import { and, desc, eq } from "drizzle-orm";
import { t } from "elysia";

import { legalListGenerationRuns } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import {
  tPaginationCursor,
  tSafeId,
  workspaceParams,
} from "@/api/lib/custom-schema";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LEGAL_LISTS_FEATURE_ID } from "@/api/lib/feature-access/registry";
import { LIMITS } from "@/api/lib/limits";
import { createCursorPage } from "@/api/lib/pagination";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";
import { brandPersistedLegalListGenerationRunId } from "@/api/lib/safe-id-boundaries";

const paramsSchema = workspaceParams({ listId: tSafeId("legalList") });
const querySchema = t.Object({
  limit: t.Optional(
    t.Integer({
      minimum: 1,
      maximum: LIMITS.legalListGenerationRunsPageSizeMax,
    }),
  ),
  cursor: t.Optional(tPaginationCursor()),
});
const config = {
  featureAccess: { type: "required", featureId: LEGAL_LISTS_FEATURE_ID },
  description:
    "List one list's generation runs, newest first, with cursor pagination: " +
    "each run's status, its instruction, and its created, updated, and " +
    "completed timestamps.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "workflow_orchestration",
    consumesServices: false,
  },
  params: paramsSchema,
  query: querySchema,
} satisfies WorkspaceHandlerConfig;

const generationCursor = createTimestampIdCursorCodec({
  column: legalListGenerationRuns.createdAt,
  brandId: brandPersistedLegalListGenerationRunId,
});

const readGenerations = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, params, query }) {
    const limit = normalizeTenantPageLimit(
      query.limit ?? LIMITS.legalListGenerationRunsPageSizeDefault,
    );
    const cursor = query.cursor ? generationCursor.decode(query.cursor) : null;
    if (query.cursor && !cursor) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid cursor" }),
      );
    }
    const conditions = [
      eq(legalListGenerationRuns.workspaceId, workspaceId),
      eq(legalListGenerationRuns.listId, params.listId),
    ];
    const cursorCondition = cursor
      ? generationCursor.keysetAfter({
          cursor,
          idColumn: legalListGenerationRuns.id,
          direction: "descending",
        })
      : undefined;
    if (cursorCondition) {
      conditions.push(cursorCondition);
    }
    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: legalListGenerationRuns.id,
            status: legalListGenerationRuns.status,
            instruction: legalListGenerationRuns.instruction,
            createdAt: legalListGenerationRuns.createdAt,
            updatedAt: legalListGenerationRuns.updatedAt,
            completedAt: legalListGenerationRuns.completedAt,
            createdAtCursor:
              generationCursor.cursorValue.as("created_at_cursor"),
          })
          .from(legalListGenerationRuns)
          .where(and(...conditions))
          .orderBy(
            desc(legalListGenerationRuns.createdAt),
            desc(legalListGenerationRuns.id),
          )
          .limit(limit + 1),
      ),
    );
    const page = createCursorPage({
      rows,
      limit,
      cursorForItem: (run) =>
        generationCursor.encode(run.createdAtCursor, run.id),
    });
    return Result.ok({
      ...page,
      items: page.items.map(({ createdAtCursor: _cursor, ...run }) => run),
    });
  },
);

export default readGenerations;
