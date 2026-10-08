/**
 * The per-run summary both verification listings answer with: status, why it
 * failed, the list it checked against, and claim counts per verdict state.
 */

import { Result } from "better-result";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import {
  fields,
  legalListClaims,
  legalListVerificationRuns,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { CLAIM_STATE } from "@/api/lib/lists/verification/contract";
import type { ClaimState } from "@/api/lib/lists/verification/contract";
import { createCursorPage } from "@/api/lib/pagination";
import type { Page } from "@/api/lib/pagination";
import { brandPersistedListVerificationRunId } from "@/api/lib/safe-id-boundaries";

const stateFilterCount = (state: ClaimState): SQL<number> =>
  sql<number>`count(${legalListClaims.id}) filter (where ${legalListClaims.state} = ${state})::int`;

/** Total over the claim states, so a new state cannot go uncounted. */
export const CLAIM_COUNT_COLUMNS = {
  supported: stateFilterCount(CLAIM_STATE.SUPPORTED),
  tension: stateFilterCount(CLAIM_STATE.TENSION),
  contradicted: stateFilterCount(CLAIM_STATE.CONTRADICTED),
  nocover: stateFilterCount(CLAIM_STATE.NOCOVER),
  notverifiable: stateFilterCount(CLAIM_STATE.NOTVERIFIABLE),
  recordconflict: stateFilterCount(CLAIM_STATE.RECORDCONFLICT),
} as const satisfies Record<ClaimState, SQL<number>>;

/** The run columns a summary reads, beside the claim counts. */
export const RUN_SUMMARY_COLUMNS = {
  id: legalListVerificationRuns.id,
  entityId: legalListVerificationRuns.entityId,
  fileFieldId: legalListVerificationRuns.fileFieldId,
  status: legalListVerificationRuns.status,
  errorCode: legalListVerificationRuns.errorCode,
  entityVersionId: legalListVerificationRuns.entityVersionId,
  listId: sql<
    SafeId<"legalList">
  >`(${legalListVerificationRuns.evidence} ->> 'listId')`,
  createdAt: legalListVerificationRuns.createdAt,
  finishedAt: legalListVerificationRuns.finishedAt,
} as const;

type RunSummaryRow = {
  id: SafeId<"legalListVerificationRun">;
  entityId: SafeId<"entity">;
  fileFieldId: SafeId<"field">;
  status: (typeof legalListVerificationRuns.$inferSelect)["status"];
  errorCode: (typeof legalListVerificationRuns.$inferSelect)["errorCode"];
  entityVersionId: SafeId<"entityVersion">;
  listId: SafeId<"legalList">;
  createdAt: Date;
  finishedAt: Date | null;
} & Record<ClaimState, number>;

export const serializeRunSummary = (run: RunSummaryRow) => ({
  id: run.id,
  entityId: run.entityId,
  fileFieldId: run.fileFieldId,
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
});

/** The run columns a summary sends as they are; `listId` and `claimCounts`
 *  are derived and sit outside the column check. */
export type RunSummaryColumnProjection = Omit<
  ReturnType<typeof serializeRunSummary>,
  "listId" | "claimCounts"
>;

export type RunRow = typeof legalListVerificationRuns.$inferSelect;

export const UNPROJECTED_RUN_SUMMARY_COLUMNS = [
  // Scope keys the caller already holds.
  "organizationId",
  "workspaceId",
  // Pin and provenance, read in full with lists.verifications.get.
  "contentSha256",
  "evidence",
  "requestedBy",
  "pipelineVersion",
  "modelRef",
  "startedAt",
] as const satisfies readonly (keyof RunRow)[];

const runCursor = createTimestampIdCursorCodec({
  column: legalListVerificationRuns.createdAt,
  brandId: brandPersistedListVerificationRunId,
});

type ListRunSummariesArgs = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  entityId: SafeId<"entity">;
  fileFieldId: SafeId<"field">;
  cursor: string | undefined;
  limit: number;
};

export const listRunSummaries = async ({
  safeDb,
  workspaceId,
  entityId,
  fileFieldId,
  cursor: cursorToken,
  limit,
}: ListRunSummariesArgs): Promise<
  Result<
    Page<ReturnType<typeof serializeRunSummary>>,
    HandlerError<400> | SafeDbError
  >
> => {
  const cursor =
    cursorToken === undefined ? null : runCursor.decode(cursorToken);
  if (cursorToken !== undefined && cursor === null) {
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

  const result = await safeDb((tx) =>
    tx
      .select({
        ...RUN_SUMMARY_COLUMNS,
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
          eq(legalListVerificationRuns.entityId, entityId),
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
                          eq(fields.id, fileFieldId),
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
  );

  return result.map((rows) => {
    const page = createCursorPage({
      rows,
      limit,
      cursorForItem: (run) => runCursor.encode(run.createdAtCursor, run.id),
    });
    return { ...page, items: page.items.map(serializeRunSummary) };
  });
};

type ListLatestRunSummariesArgs = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  documents: readonly {
    entityId: SafeId<"entity">;
    fileFieldId: SafeId<"field">;
  }[];
};

export const listLatestRunSummaries = async ({
  safeDb,
  workspaceId,
  documents,
}: ListLatestRunSummariesArgs) => {
  // A run belongs to one file of a document, so two files of one document
  // each have their own latest run.
  const entityIds = [...new Set(documents.map((doc) => doc.entityId))];
  const namedFiles = or(
    ...documents.map((doc) =>
      and(
        eq(legalListVerificationRuns.entityId, doc.entityId),
        eq(legalListVerificationRuns.fileFieldId, doc.fileFieldId),
      ),
    ),
  );
  return safeDb(async (tx) => {
    // Newest run per file: DISTINCT ON walks the document index
    // `(workspace_id, entity_id, file_field_id, created_at DESC)` once
    // per named file.
    const latest = await tx
      .selectDistinctOn(
        [
          legalListVerificationRuns.entityId,
          legalListVerificationRuns.fileFieldId,
        ],
        { ...RUN_SUMMARY_COLUMNS },
      )
      .from(legalListVerificationRuns)
      .where(
        and(
          eq(legalListVerificationRuns.workspaceId, workspaceId),
          inArray(legalListVerificationRuns.entityId, entityIds),
          namedFiles,
        ),
      )
      .orderBy(
        asc(legalListVerificationRuns.entityId),
        asc(legalListVerificationRuns.fileFieldId),
        desc(legalListVerificationRuns.createdAt),
        desc(legalListVerificationRuns.id),
      )
      .limit(documents.length);
    if (latest.length === 0) {
      return [];
    }
    const counts = await tx
      .select({ runId: legalListClaims.runId, ...CLAIM_COUNT_COLUMNS })
      .from(legalListClaims)
      .where(
        and(
          eq(legalListClaims.workspaceId, workspaceId),
          inArray(
            legalListClaims.runId,
            latest.map((run) => run.id),
          ),
        ),
      )
      .groupBy(legalListClaims.runId)
      .limit(latest.length);
    const countsByRun = new Map(counts.map((row) => [row.runId, row]));
    return latest.map((run) => {
      const count = countsByRun.get(run.id);
      return serializeRunSummary({
        ...run,
        supported: count?.supported ?? 0,
        tension: count?.tension ?? 0,
        contradicted: count?.contradicted ?? 0,
        nocover: count?.nocover ?? 0,
        notverifiable: count?.notverifiable ?? 0,
        recordconflict: count?.recordconflict ?? 0,
      });
    });
  });
};
