import { Result } from "better-result";
import { and, desc, eq, lt, or } from "drizzle-orm";
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
  parseDateTimePaginationCursorPart,
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
  access: "read",
  mcp: { type: "capability", reason: "workflow_orchestration" },
  params: paramsSchema,
  query: querySchema,
} satisfies HandlerConfig;

const readGenerations = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, params, query }) {
    const limit = query.limit ?? LIMITS.legalListGenerationRunsPageSizeDefault;
    const parts = query.cursor ? decodePaginationCursor(query.cursor) : null;
    const cursorDate = parts
      ? parseDateTimePaginationCursorPart(parts.at(0))
      : null;
    const rawCursorId = parts?.at(1);
    if (
      query.cursor &&
      (!cursorDate || !isUuidPaginationCursorPart(rawCursorId))
    ) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid cursor" }),
      );
    }
    const cursorId = isUuidPaginationCursorPart(rawCursorId)
      ? brandPersistedLegalListGenerationRunId(rawCursorId)
      : null;
    const conditions = [
      eq(legalListGenerationRuns.workspaceId, workspaceId),
      eq(legalListGenerationRuns.listId, params.listId),
    ];
    const cursorCondition =
      cursorDate && cursorId
        ? or(
            lt(legalListGenerationRuns.createdAt, cursorDate),
            and(
              eq(legalListGenerationRuns.createdAt, cursorDate),
              lt(legalListGenerationRuns.id, cursorId),
            ),
          )
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
    return Result.ok(
      createCursorPage({
        rows,
        limit,
        cursorForItem: (run) =>
          encodePaginationCursor([run.createdAt.toISOString(), run.id]),
      }),
    );
  },
);

export default readGenerations;
