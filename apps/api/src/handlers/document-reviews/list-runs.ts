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
 *
 * The pinned basis is projected down to the four values a history row reads —
 * what the run was measured against and for whom — rather than sent whole: the
 * snapshot embeds every confirmed position, which a list of ten runs has no
 * use for.
 *
 * `includeLatest` answers with the newest run in full as well. Opening the
 * review facet needs both this history and the run it restores; asking for the
 * run by id afterwards is a second sequential round the reader waits through,
 * and the id only becomes known from this very answer.
 */

import { Result } from "better-result";
import { and, desc, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { t } from "elysia";

import { documentReviewFindings, documentReviewRuns } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import {
  tPaginationCursor,
  tSafeId,
  workspaceParams,
} from "@/api/lib/custom-schema";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import {
  DECISION_COUNT_COLUMNS,
  toDecisionCounts,
} from "@/api/lib/document-review/decision-counts";
import { readDocumentReviewRunDetail } from "@/api/lib/document-review/read-run-detail";
import type { PlaybookPinProvenance } from "@/api/lib/document-review/run-contract";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { createCursorPage } from "@/api/lib/pagination";
import { brandPersistedDocumentReviewRunId } from "@/api/lib/safe-id-boundaries";

const RUNS_PAGE_SIZE_DEFAULT = 20;
const RUNS_PAGE_SIZE_MAX = 50;

/**
 * What a history row says the run was measured against, read out of the pinned
 * basis in the same statement. Each accessor chain is parenthesized so a cast
 * applies to the whole of it rather than to its last operand.
 */
const BASIS_SUMMARY_COLUMNS = {
  playbookName: sql<
    string | null
  >`(${documentReviewRuns.basis} -> 'playbook' -> 'definitionSnapshot' ->> 'name')`,
  playbookProvenance: sql<PlaybookPinProvenance>`(${documentReviewRuns.basis} -> 'playbook' ->> 'provenance')`,
  referenceCount: sql<number>`coalesce(jsonb_array_length(${documentReviewRuns.basis} -> 'references'), 0)::int`,
  /** The party the run was judged for; null when it was judged for no side. */
  perspectiveRole: sql<
    string | null
  >`(${documentReviewRuns.basis} -> 'perspective' ->> 'role')`,
} as const;

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
    cursor: t.Optional(tPaginationCursor()),
    limit: t.Optional(t.Integer({ minimum: 1, maximum: RUNS_PAGE_SIZE_MAX })),
    // Send the newest run's findings with the page. Only the first page has a
    // newest run to send, so a cursored request answers with `latest: null`
    // even when it asks.
    includeLatest: t.Optional(t.Boolean()),
  }),
} satisfies HandlerConfig;

const listDocumentReviewRuns = createSafeHandler(
  config,
  async function* ({ query, safeDb, session, workspaceId }) {
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
            basisPlaybookName: BASIS_SUMMARY_COLUMNS.playbookName,
            basisPlaybookProvenance: BASIS_SUMMARY_COLUMNS.playbookProvenance,
            basisReferenceCount: BASIS_SUMMARY_COLUMNS.referenceCount,
            basisPerspectiveRole: BASIS_SUMMARY_COLUMNS.perspectiveRole,
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

    // The newest run, in full, for a caller that will read it next anyway.
    // Deliberately the newest run rather than "the one the facet will restore":
    // which run a reader is shown is a client decision, and restating it here
    // would be a second copy of that rule free to drift from the first. A page
    // reached by cursor has no newest run to speak for.
    const latestRunId =
      query.includeLatest === true && query.cursor === undefined
        ? (page.items.at(0)?.id ?? null)
        : null;
    const latest =
      latestRunId === null
        ? null
        : yield* readDocumentReviewRunDetail({
            safeDb,
            workspaceId,
            organizationId: session.activeOrganizationId,
            runId: latestRunId,
          });

    // The cursor projection is a pagination mechanism, not part of the run, so
    // the response object is listed out rather than spread from the row.
    return Result.ok({
      ...page,
      latest,
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
        basis: {
          playbookName: run.basisPlaybookName,
          playbookProvenance: run.basisPlaybookProvenance,
          referenceCount: run.basisReferenceCount,
          perspectiveRole: run.basisPerspectiveRole,
        },
      })),
    });
  },
);

export default listDocumentReviewRuns;
