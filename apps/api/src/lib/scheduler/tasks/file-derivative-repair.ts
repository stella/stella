import { Result, panic } from "better-result";
import { and, asc, eq, gt, isNull, lt, sql } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import {
  entities,
  entityVersions,
  fields,
  schedulerJobs,
  workspaces,
} from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import { DERIVATIVE_FAILURE_REASON } from "@/api/db/schema-validators";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { isUuid } from "@/api/lib/custom-schema";
import {
  FILE_DERIVATIVE_KIND,
  FILE_DERIVATIVE_REQUEUE_OUTCOME,
  requeueFileDerivative,
} from "@/api/lib/file-derivative-queue";
import type { FileDerivativeKind } from "@/api/lib/file-derivative-queue";
import { shouldGenerateImageThumbnail } from "@/api/lib/files/image-derivative";
import { shouldGeneratePdfDerivative } from "@/api/lib/files/pdf-derivative-policy";
import {
  brandPersistedFieldId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const REPAIR_FILE_DERIVATIVES_TASK = "files.repairDerivatives" as const;

/** Fields read per tick. The cursor below carries the scan across ticks. */
const SCAN_PAGE_SIZE = 200;

/** Jobs re-added per tick, so a large backlog drains without a queue storm. */
const REQUEUE_LIMIT = 50;

/**
 * How long a derivative may stay `pending` before it counts as stuck. It has
 * to outlast the queue's own retries (3 attempts, exponential backoff from
 * 30s) plus one conversion, or the sweep would race a job that is still
 * working.
 */
const SETTLE_MS = 15 * 60 * 1000;

type FileFieldContent = Extract<FieldContent, { type: "file" }>;
type DerivativeState = FileFieldContent["pdfDerivative"];

/**
 * Whether this derivative state can still be retried. Absent means `pending`:
 * that is the default every file field is written with. A `failed` state is
 * retryable only when the job never entered the queue; once the worker has
 * run and exhausted its attempts the verdict is terminal, and re-adding the
 * job would replay a conversion that has already been proven to fail.
 */
const isRetryableDerivativeState = (state: DerivativeState): boolean => {
  if (state === undefined) {
    return true;
  }
  switch (state.status) {
    case "pending": {
      return true;
    }
    case "failed": {
      return state.reason === DERIVATIVE_FAILURE_REASON.ENQUEUE;
    }
    case "ready":
    case "not-required": {
      return false;
    }
    default: {
      const unhandled: never = state;
      return panic(`Unhandled derivative state: ${JSON.stringify(unhandled)}`);
    }
  }
};

/**
 * Which derivatives of one file field nothing is driving anymore. This is the
 * authority; the SQL below only narrows the scan, and deliberately selects a
 * superset of what this returns.
 */
export const stuckFileDerivatives = (
  content: FileFieldContent,
): FileDerivativeKind[] => {
  const stuck: FileDerivativeKind[] = [];
  if (
    content.pdfFileId === null &&
    isRetryableDerivativeState(content.pdfDerivative) &&
    shouldGeneratePdfDerivative({
      encrypted: content.encrypted,
      mimeType: content.mimeType,
    })
  ) {
    stuck.push(FILE_DERIVATIVE_KIND.PDF);
  }
  if (
    (content.thumbnailFileId ?? null) === null &&
    isRetryableDerivativeState(content.thumbnailDerivative) &&
    shouldGenerateImageThumbnail({
      encrypted: content.encrypted,
      mimeType: content.mimeType,
    })
  ) {
    stuck.push(FILE_DERIVATIVE_KIND.THUMBNAIL);
  }
  return stuck;
};

const repairCursor = (
  payload: Record<string, unknown> | null,
): SafeId<"field"> | null => {
  const cursor = payload?.["cursor"];
  if (cursor === undefined || cursor === null) {
    return null;
  }
  if (typeof cursor !== "string" || !isUuid(cursor)) {
    return panic("File-derivative repair cursor must be a UUID");
  }
  return brandPersistedFieldId(cursor);
};

/**
 * A derivative that reached `ready` or `not-required` is done; everything
 * else is a candidate the JS predicate then judges. Written as an exclusion
 * so a new retryable state cannot be filtered out here by omission.
 *
 * `fields_derivative_repair_candidate_idx` is this expression: change one and
 * the other stops matching, and the sweep quietly falls back to scanning the
 * table.
 */
const DERIVATIVE_UNSETTLED = sql`(
  coalesce(${fields.content}->'pdfDerivative'->>'status', 'pending')
    not in ('ready', 'not-required')
  or coalesce(${fields.content}->'thumbnailDerivative'->>'status', 'pending')
    not in ('ready', 'not-required')
)`;

const selectRepairPage = async (cursor: SafeId<"field"> | null) =>
  await rootDb
    .select({
      content: fields.content,
      createdBy: entities.createdBy,
      entityId: entities.id,
      fieldId: fields.id,
      organizationId: workspaces.organizationId,
      workspaceId: fields.workspaceId,
    })
    .from(fields)
    .innerJoin(
      entityVersions,
      and(
        eq(entityVersions.id, fields.entityVersionId),
        eq(entityVersions.workspaceId, fields.workspaceId),
        isNull(entityVersions.deletedAt),
      ),
    )
    .innerJoin(
      entities,
      and(
        eq(entities.currentVersionId, entityVersions.id),
        eq(entities.id, entityVersions.entityId),
        eq(entities.workspaceId, fields.workspaceId),
      ),
    )
    .innerJoin(workspaces, eq(workspaces.id, fields.workspaceId))
    .where(
      and(
        cursor === null ? undefined : gt(fields.id, cursor),
        lt(entityVersions.createdAt, new Date(Date.now() - SETTLE_MS)),
        eq(workspaces.status, "active"),
        sql`${fields.content}->>'type' = 'file'`,
        DERIVATIVE_UNSETTLED,
      ),
    )
    .orderBy(asc(fields.id))
    .limit(SCAN_PAGE_SIZE);

type RepairPageRow = Awaited<ReturnType<typeof selectRepairPage>>[number];

type RowRepairResult = {
  requeued: number;
  /**
   * `entities.createdBy` is nulled when the uploader's account is deleted,
   * and a derivative job carries an actor. Such a field is counted rather
   * than dropped quietly, so an unrepairable population stays visible.
   */
  unattributed: boolean;
};

const requeueRow = async (row: RepairPageRow): Promise<RowRepairResult> => {
  if (row.content.type !== "file") {
    return { requeued: 0, unattributed: false };
  }
  if (row.createdBy === null) {
    return { requeued: 0, unattributed: true };
  }
  const userId = brandPersistedUserId(row.createdBy);
  const kinds = stuckFileDerivatives(row.content);
  let requeued = 0;

  // Sequential by recursion: a field has at most two derivatives, and one
  // queue write at a time keeps a tick's Redis traffic proportional to the
  // bound rather than to the page.
  const requeueFrom = async (index: number): Promise<void> => {
    const kind = kinds.at(index);
    if (kind === undefined) {
      return;
    }
    const outcome = await requeueFileDerivative({
      entityId: row.entityId,
      fieldId: row.fieldId,
      kind,
      organizationId: row.organizationId,
      userId,
      workspaceId: row.workspaceId,
    });
    if (outcome === FILE_DERIVATIVE_REQUEUE_OUTCOME.REQUEUED) {
      requeued += 1;
    }
    await requeueFrom(index + 1);
  };

  await requeueFrom(0);
  return { requeued, unattributed: false };
};

const persistCursor = async ({
  jobId,
  leaseToken,
  nextCursor,
}: {
  jobId: string;
  leaseToken: string;
  nextCursor: SafeId<"field"> | null;
}): Promise<void> => {
  await rootDb
    .update(schedulerJobs)
    .set({ payload: { cursor: nextCursor } })
    .where(
      and(eq(schedulerJobs.id, jobId), eq(schedulerJobs.lockedBy, leaseToken)),
    );
};

/**
 * Re-drive file derivatives nothing owns anymore.
 *
 * A derivative whose enqueue threw, or whose `failed` write threw after it,
 * leaves the field with no queued job and no way back: the preview is lost
 * for the life of the row and only a new upload produces another one. This
 * sweep walks the current-version file fields on a durable cursor, and hands
 * every derivative still stuck past the settle window back to the queue.
 * Resetting the cursor after a full pass is what makes it a standing
 * reconciler rather than a one-time backfill.
 */
export const repairFileDerivatives: SchedulerTask = async ({
  job,
  logger,
  signal,
}) => {
  signal.throwIfAborted();
  const leaseToken =
    job.lockedBy ?? panic("File-derivative repair requires a scheduler lease");
  const cursor = repairCursor(job.payload);
  const page = await selectRepairPage(cursor);

  if (page.length === 0) {
    if (cursor !== null) {
      await persistCursor({ jobId: job.id, leaseToken, nextCursor: null });
    }
    return;
  }

  let requeued = 0;
  let scanned = 0;
  let unattributed = 0;

  const repairFrom = async (index: number): Promise<void> => {
    const row = page.at(index);
    if (row === undefined || signal.aborted || requeued >= REQUEUE_LIMIT) {
      return;
    }
    const outcome = await Result.tryPromise(async () => await requeueRow(row));
    if (Result.isError(outcome)) {
      // The queue is unreachable (or refused the write). Stop the tick and
      // leave the cursor on the last repaired row: the rest of the page is
      // still stuck, and the next tick starts exactly where this one gave up.
      captureError(outcome.error, {
        fieldId: row.fieldId,
        workspaceId: row.workspaceId,
      });
      return;
    }
    requeued += outcome.value.requeued;
    unattributed += outcome.value.unattributed ? 1 : 0;
    scanned += 1;
    await repairFrom(index + 1);
  };

  await repairFrom(0);

  // Advance only over rows this tick actually finished, so a page cut short
  // by the requeue bound or an unreachable queue is resumed, not skipped.
  const lastScanned = scanned === 0 ? undefined : page.at(scanned - 1);
  await persistCursor({
    jobId: job.id,
    leaseToken,
    nextCursor: lastScanned?.fieldId ?? cursor,
  });

  logger.info("scheduler.file_derivatives_repaired", {
    "fileDerivatives.requeued": requeued,
    "fileDerivatives.scanned": scanned,
    "fileDerivatives.unattributed": unattributed,
  });
};
