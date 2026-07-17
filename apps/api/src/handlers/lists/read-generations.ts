import { Result } from "better-result";
import { and, desc, eq, lt } from "drizzle-orm";
import { t } from "elysia";

import { legalListGenerationRuns } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import { brandPersistedLegalListGenerationRunId } from "@/api/lib/safe-id-boundaries";

const paramsSchema = t.Object({ listId: tSafeId("legalList") });
const querySchema = t.Object({
  limit: t.Optional(
    t.Integer({
      minimum: 1,
      maximum: LIMITS.legalListGenerationRunsPageSizeMax,
    }),
  ),
  cursor: t.Optional(t.String({ maxLength: 512 })),
});
const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "capability", reason: "workflow_orchestration" },
  params: paramsSchema,
  query: querySchema,
} satisfies HandlerConfig;

const readGenerations = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, params, query }) {
    const limit = query.limit ?? LIMITS.legalListGenerationRunsPageSizeDefault;
    const parts = query.cursor ? decodePaginationCursor(query.cursor) : null;
    const cursor = parts?.at(0);
    if (query.cursor && !isUuidPaginationCursorPart(cursor)) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid cursor" }),
      );
    }
    const conditions = [
      eq(legalListGenerationRuns.workspaceId, workspaceId),
      eq(legalListGenerationRuns.listId, params.listId),
    ];
    if (cursor && isUuidPaginationCursorPart(cursor)) {
      conditions.push(
        lt(
          legalListGenerationRuns.id,
          brandPersistedLegalListGenerationRunId(cursor),
        ),
      );
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
          })
          .from(legalListGenerationRuns)
          .where(and(...conditions))
          .orderBy(desc(legalListGenerationRuns.id))
          .limit(limit + 1),
      ),
    );
    return Result.ok(
      createCursorPage({
        rows,
        limit,
        cursorForItem: (run) => encodePaginationCursor([run.id]),
      }),
    );
  },
);

export default readGenerations;
