import { panic } from "better-result";
import { and, eq, inArray, lte, or, sql } from "drizzle-orm";

import type { rootDb } from "@/api/db/root";
import { extractionRuns } from "@/api/db/schema";
import type { ExtractionRunScope } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { brandPersistedWorkspaceId } from "@/api/lib/safe-id-boundaries";

const ACTIVE_EXTRACTION_RUN_STATUSES = [
  "planning",
  "running",
  "finalizing",
] as const;

export type ExtractionRunDb = typeof rootDb;

type ExtractionRunKey = {
  id: SafeId<"extractionRun">;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
};

type CreateExtractionRunOptions = ExtractionRunKey & {
  requestedBy: SafeId<"user">;
  scope: ExtractionRunScope;
};

type StartExtractionRunOptions = ExtractionRunKey & {
  total: number;
};

type SyncExtractionRunProgressOptions = ExtractionRunKey & {
  completed: number;
  total: number;
};

type FinishExtractionRunOptions = ExtractionRunKey & {
  errorCode?: string;
};

type FailActiveExtractionRunsOptions = {
  errorCode: string;
  workspaceId: SafeId<"workspace">;
};

type ListStaleActiveWorkspaceIdsOptions = {
  before: Date;
  limit: number;
};

const runKeyPredicate = ({
  id,
  organizationId,
  workspaceId,
}: ExtractionRunKey) =>
  and(
    eq(extractionRuns.id, id),
    eq(extractionRuns.organizationId, organizationId),
    eq(extractionRuns.workspaceId, workspaceId),
  );

const requireNonnegativeInteger = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    return panic(`${label} must be a nonnegative safe integer`);
  }
  return value;
};

const normalizeErrorCode = (errorCode: string | undefined): string =>
  (errorCode ?? "ExtractionRunFailed").slice(0, 128);

/**
 * Postgres lifecycle store for extraction orchestration. Every mutation is
 * tenant-keyed and terminal states are immutable. Progress accepts absolute
 * Redis SCARD snapshots and advances monotonically, so repeated or out-of-order
 * delivery cannot double-count or move a run backwards.
 */
export const createExtractionRunStore = (db: ExtractionRunDb) => ({
  create: async ({
    id,
    organizationId,
    requestedBy,
    scope,
    workspaceId,
  }: CreateExtractionRunOptions): Promise<void> => {
    await db.insert(extractionRuns).values({
      id,
      organizationId,
      requestedBy,
      scope,
      workspaceId,
    });
  },

  start: async ({
    id,
    organizationId,
    total,
    workspaceId,
  }: StartExtractionRunOptions): Promise<void> => {
    const validatedTotal = requireNonnegativeInteger(total, "total");
    await db
      .update(extractionRuns)
      .set({ startedAt: new Date(), status: "running", total: validatedTotal })
      .where(
        and(
          runKeyPredicate({ id, organizationId, workspaceId }),
          eq(extractionRuns.status, "planning"),
        ),
      );
  },

  syncProgress: async ({
    completed,
    id,
    organizationId,
    total,
    workspaceId,
  }: SyncExtractionRunProgressOptions): Promise<void> => {
    const validatedTotal = requireNonnegativeInteger(total, "total");
    const validatedCompleted = requireNonnegativeInteger(
      completed,
      "completed",
    );
    const boundedCompleted = Math.min(validatedCompleted, validatedTotal);
    await db
      .update(extractionRuns)
      .set({
        completed: sql`GREATEST(${extractionRuns.completed}, ${boundedCompleted})`,
        startedAt: sql`COALESCE(${extractionRuns.startedAt}, NOW())`,
        status: sql`CASE
          WHEN GREATEST(${extractionRuns.completed}, ${boundedCompleted}) >= ${validatedTotal}
          THEN 'finalizing'
          ELSE 'running'
        END`,
        total: validatedTotal,
      })
      .where(
        and(
          runKeyPredicate({ id, organizationId, workspaceId }),
          or(
            eq(extractionRuns.status, "planning"),
            and(
              eq(extractionRuns.total, validatedTotal),
              inArray(extractionRuns.status, ["running", "finalizing"]),
            ),
          ),
        ),
      );
  },

  complete: async ({
    id,
    organizationId,
    workspaceId,
  }: ExtractionRunKey): Promise<void> => {
    await db
      .update(extractionRuns)
      .set({
        completed: sql`${extractionRuns.total}`,
        errorCode: null,
        finishedAt: new Date(),
        status: "completed",
      })
      .where(
        and(
          runKeyPredicate({ id, organizationId, workspaceId }),
          inArray(extractionRuns.status, ["running", "finalizing"]),
        ),
      );
  },

  skip: async ({
    id,
    organizationId,
    workspaceId,
  }: ExtractionRunKey): Promise<void> => {
    await db
      .update(extractionRuns)
      .set({ finishedAt: new Date(), status: "skipped" })
      .where(
        and(
          runKeyPredicate({ id, organizationId, workspaceId }),
          eq(extractionRuns.status, "planning"),
        ),
      );
  },

  fail: async ({
    errorCode,
    id,
    organizationId,
    workspaceId,
  }: FinishExtractionRunOptions): Promise<void> => {
    await db
      .update(extractionRuns)
      .set({
        errorCode: normalizeErrorCode(errorCode),
        finishedAt: new Date(),
        status: "failed",
      })
      .where(
        and(
          runKeyPredicate({ id, organizationId, workspaceId }),
          inArray(extractionRuns.status, ACTIVE_EXTRACTION_RUN_STATUSES),
        ),
      );
  },

  failActiveForWorkspace: async ({
    errorCode,
    workspaceId,
  }: FailActiveExtractionRunsOptions): Promise<void> => {
    await db
      .update(extractionRuns)
      .set({
        errorCode: normalizeErrorCode(errorCode),
        finishedAt: new Date(),
        status: "failed",
      })
      .where(
        and(
          eq(extractionRuns.workspaceId, workspaceId),
          inArray(extractionRuns.status, ACTIVE_EXTRACTION_RUN_STATUSES),
        ),
      );
  },

  listStaleActiveWorkspaceIds: async ({
    before,
    limit,
  }: ListStaleActiveWorkspaceIdsOptions): Promise<SafeId<"workspace">[]> => {
    const validatedLimit = requireNonnegativeInteger(limit, "limit");
    if (validatedLimit === 0) {
      return [];
    }
    const rows = await db
      .selectDistinct({ workspaceId: extractionRuns.workspaceId })
      .from(extractionRuns)
      .where(
        and(
          inArray(extractionRuns.status, ACTIVE_EXTRACTION_RUN_STATUSES),
          lte(extractionRuns.updatedAt, before),
        ),
      )
      .limit(validatedLimit);
    return rows.map((row) => brandPersistedWorkspaceId(row.workspaceId));
  },
});
