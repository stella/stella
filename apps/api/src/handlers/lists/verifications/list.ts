/**
 * Verification history for one document, newest first.
 *
 * Keyset-paginated on `(created_at, id)` descending, matching the
 * `(workspace_id, entity_id, file_field_id, created_at DESC, id DESC)` index.
 * Claim counts per verdict state are aggregated in the same statement, and
 * the pinned evidence is projected down to the list it came from rather than
 * sent whole.
 */

import { Result } from "better-result";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { t } from "elysia";

import {
  fields,
  legalListClaims,
  legalListVerificationRuns,
} from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import {
  tPaginationCursor,
  tSafeId,
  workspaceParams,
} from "@/api/lib/custom-schema";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { CLAIM_STATE } from "@/api/lib/lists/verification/contract";
import type { ClaimState } from "@/api/lib/lists/verification/contract";
import { createCursorPage } from "@/api/lib/pagination";
import { brandPersistedListVerificationRunId } from "@/api/lib/safe-id-boundaries";

const runCursor = createTimestampIdCursorCodec({
  column: legalListVerificationRuns.createdAt,
  brandId: brandPersistedListVerificationRunId,
});

const stateFilterCount = (state: ClaimState): SQL<number> =>
  sql<number>`count(${legalListClaims.id}) filter (where ${legalListClaims.state} = ${state})::int`;

/** Total over the claim states, so a new state cannot go uncounted. */
const CLAIM_COUNT_COLUMNS = {
  supported: stateFilterCount(CLAIM_STATE.SUPPORTED),
  tension: stateFilterCount(CLAIM_STATE.TENSION),
  contradicted: stateFilterCount(CLAIM_STATE.CONTRADICTED),
  nocover: stateFilterCount(CLAIM_STATE.NOCOVER),
  notverifiable: stateFilterCount(CLAIM_STATE.NOTVERIFIABLE),
  recordconflict: stateFilterCount(CLAIM_STATE.RECORDCONFLICT),
} as const satisfies Record<ClaimState, SQL<number>>;

const config = {
  description:
    "List the list verifications of one document, newest first with cursor " +
    "pagination: each run's status, failure code, the list it checked " +
    "against, when it was started and finished, and how many claims landed " +
    "in each verdict state. Read one run in full with lists.verifications.get.",
  permissions: { workspace: ["read"] },
  access: "read",
  mcp: { type: "capability", reason: "document_processing" },
  params: workspaceParams({}),
  query: t.Object({
    entityId: tSafeId("entity"),
    fileFieldId: tSafeId("field"),
    cursor: t.Optional(tPaginationCursor()),
    limit: t.Optional(
      t.Integer({
        minimum: 1,
        maximum: LIMITS.legalListVerificationRunsPageSizeMax,
      }),
    ),
  }),
} satisfies WorkspaceHandlerConfig;

const readVerifications = createSafeHandler(
  config,
  async function* ({ query, safeDb, workspaceId }) {
    const limit =
      query.limit ?? LIMITS.legalListVerificationRunsPageSizeDefault;
    const cursor =
      query.cursor === undefined ? null : runCursor.decode(query.cursor);
    if (query.cursor !== undefined && cursor === null) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid cursor" }),
      );
    }
    const cursorCondition =
      cursor === null
        ? undefined
        : runCursor.keysetAfter({
            cursor,
            idColumn: legalListVerificationRuns.id,
            direction: "descending",
          });

    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: legalListVerificationRuns.id,
            status: legalListVerificationRuns.status,
            errorCode: legalListVerificationRuns.errorCode,
            entityVersionId: legalListVerificationRuns.entityVersionId,
            listId: sql<
              SafeId<"legalList">
            >`(${legalListVerificationRuns.evidence} ->> 'listId')`,
            createdAt: legalListVerificationRuns.createdAt,
            finishedAt: legalListVerificationRuns.finishedAt,
            createdAtCursor: runCursor.cursorValue.as("created_at_cursor"),
            ...CLAIM_COUNT_COLUMNS,
          })
          .from(legalListVerificationRuns)
          // Grouping on the run's primary key keeps the keyset page intact:
          // LIMIT applies to groups, so a run with many claims is one row.
          .leftJoin(
            legalListClaims,
            and(
              eq(legalListClaims.runId, legalListVerificationRuns.id),
              eq(legalListClaims.workspaceId, workspaceId),
            ),
          )
          // A file field is a row of one entity version. A run belongs to
          // the document, so every run whose field sits on the same property
          // of this entity is part of its history.
          .where(
            and(
              eq(legalListVerificationRuns.workspaceId, workspaceId),
              eq(legalListVerificationRuns.entityId, query.entityId),
              inArray(
                legalListVerificationRuns.fileFieldId,
                tx
                  .select({ id: fields.id })
                  .from(fields)
                  .where(
                    and(
                      eq(fields.workspaceId, workspaceId),
                      eq(
                        fields.propertyId,
                        tx
                          .select({ propertyId: fields.propertyId })
                          .from(fields)
                          .where(
                            and(
                              eq(fields.workspaceId, workspaceId),
                              eq(fields.id, query.fileFieldId),
                            ),
                          ),
                      ),
                    ),
                  ),
              ),
              cursorCondition,
            ),
          )
          .groupBy(legalListVerificationRuns.id)
          .orderBy(
            desc(legalListVerificationRuns.createdAt),
            desc(legalListVerificationRuns.id),
          )
          .limit(limit + 1),
      ),
    );

    const page = createCursorPage({
      rows,
      limit,
      cursorForItem: (run) => runCursor.encode(run.createdAtCursor, run.id),
    });
    return Result.ok({
      ...page,
      items: page.items.map((run) => ({
        id: run.id,
        status: run.status,
        errorCode: run.errorCode,
        entityVersionId: run.entityVersionId,
        listId: run.listId,
        createdAt: run.createdAt.toISOString(),
        finishedAt: run.finishedAt?.toISOString() ?? null,
        claimCounts: {
          supported: run.supported,
          tension: run.tension,
          contradicted: run.contradicted,
          nocover: run.nocover,
          notverifiable: run.notverifiable,
          recordconflict: run.recordconflict,
        } satisfies Record<ClaimState, number>,
      })),
    });
  },
);

export default readVerifications;
