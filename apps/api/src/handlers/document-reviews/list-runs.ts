/**
 * Review history for one document, newest first.
 *
 * Keyset-paginated on `(created_at, id)` descending, matching the
 * `(workspace_id, entity_id, file_field_id, created_at DESC, id DESC)` index,
 * so a document with a long review history pages at constant cost.
 *
 * Each summary carries how its findings were decided, aggregated in the same
 * statement: the counts are a fact about the finding rows, and one grouped
 * join keeps them from becoming either a stored duplicate or a second query.
 */

import { Result } from "better-result";
import { and, desc, eq } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { t } from "elysia";

import { documentReviewFindings, documentReviewRuns } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import {
  DECISION_COUNT_COLUMNS,
  toDecisionCounts,
} from "@/api/lib/document-review/decision-counts";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { createCursorPage } from "@/api/lib/pagination";
import { brandPersistedDocumentReviewRunId } from "@/api/lib/safe-id-boundaries";

const RUNS_PAGE_SIZE_DEFAULT = 20;
const RUNS_PAGE_SIZE_MAX = 50;

const runHistoryCursor = createTimestampIdCursorCodec({
  column: documentReviewRuns.createdAt,
  brandId: brandPersistedDocumentReviewRunId,
});

/** Decode the opaque cursor into its keyset predicate. A malformed cursor is a
 *  client error, not an empty page, so it fails the request. */
const runHistoryCursorCondition = (
  cursor: string | undefined,
): Result<SQL | undefined, HandlerError> => {
  if (cursor === undefined) {
    return Result.ok(undefined);
  }
  const decoded = runHistoryCursor.decode(cursor);
  if (decoded === null) {
    return Result.err(
      new HandlerError({ status: 400, message: "Invalid cursor" }),
    );
  }
  return Result.ok(
    runHistoryCursor.keysetAfter({
      cursor: decoded,
      direction: "descending",
      idColumn: documentReviewRuns.id,
    }),
  );
};

const config = {
  description:
    "List review runs for one document in a matter, newest first with cursor pagination.",
  permissions: { workspace: ["read"] },
  access: "read",
  mcp: { type: "internal", reason: "document_processing" },
  params: workspaceParams({}),
  query: t.Object({
    entityId: tSafeId("entity"),
    fileFieldId: tSafeId("field"),
    cursor: t.Optional(t.String({ maxLength: 512 })),
    limit: t.Optional(t.Integer({ minimum: 1, maximum: RUNS_PAGE_SIZE_MAX })),
  }),
} satisfies HandlerConfig;

const listDocumentReviewRuns = createSafeHandler(
  config,
  async function* ({ query, safeDb, workspaceId }) {
    const limit = query.limit ?? RUNS_PAGE_SIZE_DEFAULT;
    const cursorCondition = yield* runHistoryCursorCondition(query.cursor);

    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: documentReviewRuns.id,
            status: documentReviewRuns.status,
            errorCode: documentReviewRuns.errorCode,
            entityVersionId: documentReviewRuns.entityVersionId,
            total: documentReviewRuns.total,
            completed: documentReviewRuns.completed,
            createdAt: documentReviewRuns.createdAt,
            finishedAt: documentReviewRuns.finishedAt,
            createdAtCursor:
              runHistoryCursor.cursorValue.as("created_at_cursor"),
            decisionsOpen: DECISION_COUNT_COLUMNS.open,
            decisionsAccepted: DECISION_COUNT_COLUMNS.accepted,
            decisionsDismissed: DECISION_COUNT_COLUMNS.dismissed,
          })
          .from(documentReviewRuns)
          // Decision counts come back with the page rather than in a second
          // round-trip. Grouping on the run's primary key keeps the keyset
          // page intact: LIMIT applies to groups, so a run with many findings
          // still occupies exactly one row of the page.
          .leftJoin(
            documentReviewFindings,
            and(
              eq(documentReviewFindings.runId, documentReviewRuns.id),
              eq(documentReviewFindings.workspaceId, workspaceId),
            ),
          )
          .where(
            and(
              eq(documentReviewRuns.workspaceId, workspaceId),
              eq(documentReviewRuns.entityId, query.entityId),
              eq(documentReviewRuns.fileFieldId, query.fileFieldId),
              cursorCondition,
            ),
          )
          .groupBy(documentReviewRuns.id)
          .orderBy(
            desc(documentReviewRuns.createdAt),
            desc(documentReviewRuns.id),
          )
          .limit(limit + 1),
      ),
    );

    const page = createCursorPage({
      rows,
      limit,
      cursorForItem: (item) =>
        runHistoryCursor.encode(item.createdAtCursor, item.id),
    });

    // The cursor projection is a pagination mechanism, not part of the run, so
    // the response object is listed out rather than spread from the row.
    return Result.ok({
      ...page,
      items: page.items.map((run) => ({
        id: run.id,
        status: run.status,
        errorCode: run.errorCode,
        entityVersionId: run.entityVersionId,
        total: run.total,
        completed: run.completed,
        createdAt: run.createdAt.toISOString(),
        finishedAt: run.finishedAt?.toISOString() ?? null,
        decisionCounts: toDecisionCounts(run),
      })),
    });
  },
);

export default listDocumentReviewRuns;
