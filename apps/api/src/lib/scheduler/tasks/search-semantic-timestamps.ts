import { panic, Result } from "better-result";
import { sql } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import type { SchedulerPayload } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import type { SchedulerTask } from "@/api/lib/scheduler/types";
import { upsertSearchDocument } from "@/api/lib/search/index-entity";

export const REPAIR_SEARCH_SEMANTIC_TIMESTAMPS_TASK =
  "search.repairSemanticTimestamps" as const;

/** Keep every repair transaction small while the versioned job drains. */
const REPAIR_BATCH_SIZE = 500;
const REINDEX_CONCURRENCY = 4;
const REQUIRED_CLEAN_VERIFICATION_PASSES = 2;
const VERIFICATION_QUIET_PERIOD_MS = 15 * 60 * 1000;
const REPAIR_PASS = {
  repair: "repair",
  verify: "verify",
} as const;

type RepairPass = (typeof REPAIR_PASS)[keyof typeof REPAIR_PASS];

type RepairPageRow = {
  entityId: SafeId<"entity">;
  needsReindex: boolean;
};

type RepairSearchSemanticTimestampsOptions = {
  db?: Pick<typeof rootDb, "execute">;
  indexEntity?: typeof upsertSearchDocument;
  jobId: string;
  leaseToken: string;
  now?: Date;
  payload: SchedulerPayload | null;
  signal: AbortSignal;
};

type RepairSearchSemanticTimestampsOutcome =
  | { status: "aborted" }
  | { status: "complete" }
  | { status: "restart" }
  | {
      status: "progress";
      cursor: SafeId<"entity">;
      failed: number;
      repaired: number;
    };

type RepairState = {
  cleanPasses: number;
  cursor: string | null;
  dirty: boolean;
  pass: RepairPass;
  passStartedAt: string | null;
  quietSince: string | null;
};

const validTimestampString = (value: unknown): value is string =>
  typeof value === "string" && !Number.isNaN(new Date(value).getTime());

const repairState = (payload: SchedulerPayload | null): RepairState => {
  const cursor = payload?.["cursor"];
  const pass =
    payload?.["pass"] === REPAIR_PASS.verify
      ? REPAIR_PASS.verify
      : REPAIR_PASS.repair;
  const cleanPasses = payload?.["cleanPasses"];
  const passStartedAt = payload?.["passStartedAt"];
  const quietSince = payload?.["quietSince"];
  return {
    cleanPasses:
      pass === REPAIR_PASS.verify &&
      typeof cleanPasses === "number" &&
      Number.isInteger(cleanPasses) &&
      cleanPasses >= 0
        ? Math.min(cleanPasses, REQUIRED_CLEAN_VERIFICATION_PASSES)
        : 0,
    cursor: typeof cursor === "string" ? cursor : null,
    dirty: pass === REPAIR_PASS.verify && payload?.["dirty"] === true,
    pass,
    passStartedAt:
      pass === REPAIR_PASS.verify && validTimestampString(passStartedAt)
        ? passStartedAt
        : null,
    quietSince:
      pass === REPAIR_PASS.verify && validTimestampString(quietSince)
        ? quietSince
        : null,
  };
};

export const repairSearchSemanticTimestamps = async ({
  jobId,
  leaseToken,
  now = new Date(),
  payload,
  signal,
  db = rootDb,
  indexEntity = upsertSearchDocument,
}: RepairSearchSemanticTimestampsOptions): Promise<RepairSearchSemanticTimestampsOutcome> => {
  const isAborted = () => signal.aborted;
  if (isAborted()) {
    return { status: "aborted" };
  }

  const state = repairState(payload);
  // audit: skip — this changes only a derived search projection; the
  // scheduler run and versioned job cursor are the durable operator trail.
  const pageRows = await db.execute<RepairPageRow>(sql`
    WITH source_page AS MATERIALIZED (
      SELECT
        e.id AS entity_id,
        COALESCE(e.updated_at, e.created_at) AS semantic_updated_at,
        sd.updated_at AS indexed_updated_at,
        sd.preview_generation,
        EXISTS (
          SELECT 1
          FROM search_document_preview_passages passage
          WHERE passage.entity_id = sd.entity_id
            AND passage.generation = sd.preview_generation
        ) AS has_preview_passage
      FROM entities e
      LEFT JOIN search_documents sd ON sd.entity_id = e.id
      WHERE (${state.cursor}::uuid IS NULL OR e.id > ${state.cursor}::uuid)
        AND e.current_version_id IS NOT NULL
        -- A parked repair (next_attempt_at = infinity) is a permanently
        -- failing projection; retrying it inline every pass would loop
        -- forever and keep verification dirty. The queue owns its fate: a
        -- real edit re-marks the row and un-parks it.
        AND NOT EXISTS (
          SELECT 1
          FROM search_projection_repair_queue parked
          WHERE parked.kind = 'entity'
            AND parked.source_id = e.id
            AND parked.next_attempt_at = 'infinity'::timestamptz
        )
      ORDER BY e.id
      LIMIT ${REPAIR_BATCH_SIZE}
    )
    SELECT
      source_page.entity_id AS "entityId",
      (
        source_page.indexed_updated_at IS NULL
        OR source_page.preview_generation IS NULL
        OR NOT source_page.has_preview_passage
        OR source_page.indexed_updated_at
          IS DISTINCT FROM source_page.semantic_updated_at
      ) AS "needsReindex"
    FROM source_page
    ORDER BY source_page.entity_id
  `);
  const last = pageRows.at(-1);
  const nowIso = now.toISOString();

  if (isAborted()) {
    return { status: "aborted" };
  }

  if (!last) {
    if (state.pass === REPAIR_PASS.repair) {
      // Old application instances can still write reindex time during a
      // rolling deployment. Persist a quiet-window start, then require two
      // complete clean passes before disabling this one-shot repair.
      await db.execute(sql`
        UPDATE scheduler_jobs
        SET payload = jsonb_build_object(
          'pass', ${REPAIR_PASS.verify}::text,
          'dirty', false,
          'cleanPasses', 0,
          'passStartedAt', ${nowIso}::text,
          'quietSince', ${nowIso}::text
        )
        WHERE id = ${jobId}
          AND locked_by = ${leaseToken}
      `);
      return { status: "restart" };
    }

    const quietSince = state.quietSince ?? nowIso;
    const passStartedAfterQuiet =
      state.passStartedAt !== null &&
      new Date(state.passStartedAt).getTime() >=
        new Date(quietSince).getTime() + VERIFICATION_QUIET_PERIOD_MS;
    const cleanPasses =
      state.dirty || !passStartedAfterQuiet
        ? 0
        : Math.min(state.cleanPasses + 1, REQUIRED_CLEAN_VERIFICATION_PASSES);
    if (
      state.dirty ||
      cleanPasses < REQUIRED_CLEAN_VERIFICATION_PASSES ||
      !passStartedAfterQuiet
    ) {
      await db.execute(sql`
        UPDATE scheduler_jobs
        SET payload = jsonb_build_object(
          'pass', ${REPAIR_PASS.verify}::text,
          'dirty', false,
          'cleanPasses', ${cleanPasses}::int,
          'passStartedAt', ${nowIso}::text,
          'quietSince', ${quietSince}::text
        )
        WHERE id = ${jobId}
          AND locked_by = ${leaseToken}
      `);
      return { status: "restart" };
    }

    // audit: skip — this only disables a versioned repair of a derived search
    // projection; scheduler_job_runs is the durable operator trail.
    await db.execute(sql`
      UPDATE scheduler_jobs
      SET enabled = false
      WHERE id = ${jobId}
        AND locked_by = ${leaseToken}
    `);
    return { status: "complete" };
  }

  const reindexEntityIds = pageRows.flatMap((row) =>
    row.needsReindex ? [row.entityId] : [],
  );
  const verificationDirty =
    state.pass === REPAIR_PASS.verify &&
    (state.dirty || reindexEntityIds.length > 0);
  const quietSince =
    state.pass === REPAIR_PASS.verify && reindexEntityIds.length === 0
      ? (state.quietSince ?? nowIso)
      : nowIso;

  if (state.pass === REPAIR_PASS.verify && reindexEntityIds.length > 0) {
    if (isAborted()) {
      return { status: "aborted" };
    }

    // Mark the pass dirty before external projection work. A crash can replay
    // the page, but cannot lose the quiet-window reset.
    await db.execute(sql`
      UPDATE scheduler_jobs
      SET payload = jsonb_build_object(
        'cursor', ${state.cursor}::text,
        'pass', ${REPAIR_PASS.verify}::text,
        'dirty', true,
        'cleanPasses', 0,
        'passStartedAt', ${state.passStartedAt}::text,
        'quietSince', ${nowIso}::text
      )
      WHERE id = ${jobId}
        AND locked_by = ${leaseToken}
    `);
  }

  let nextReindexIndex = 0;
  let failed = 0;
  let repaired = 0;
  const reindexNext = async (): Promise<void> => {
    if (isAborted()) {
      return;
    }
    const entityId = reindexEntityIds.at(nextReindexIndex);
    nextReindexIndex += 1;
    if (!entityId) {
      return;
    }
    const reindexResult = await Result.tryPromise({
      try: async () => await indexEntity(entityId),
      catch: (error: unknown) => error,
    });
    if (isAborted()) {
      return;
    }
    if (Result.isError(reindexResult)) {
      failed += 1;
      captureError(reindexResult.error, {
        entityId,
        schedulerTask: REPAIR_SEARCH_SEMANTIC_TIMESTAMPS_TASK,
      });
    } else {
      repaired += 1;
    }
    await reindexNext();
  };
  await Promise.all(
    Array.from(
      {
        length: Math.min(REINDEX_CONCURRENCY, reindexEntityIds.length),
      },
      reindexNext,
    ),
  );

  if (isAborted()) {
    return { status: "aborted" };
  }

  if (state.pass === REPAIR_PASS.verify) {
    await db.execute(sql`
      UPDATE scheduler_jobs
      SET payload = jsonb_build_object(
        'cursor', ${last.entityId}::text,
        'pass', ${REPAIR_PASS.verify}::text,
        'dirty', ${verificationDirty}::boolean,
        'cleanPasses', ${verificationDirty ? 0 : state.cleanPasses}::int,
        'passStartedAt', ${state.passStartedAt}::text,
        'quietSince', ${quietSince}::text
      )
      WHERE id = ${jobId}
        AND locked_by = ${leaseToken}
    `);
  } else {
    // Checkpoint last: a replay after the projection update but before this
    // write safely finds no mismatch and advances again.
    await db.execute(sql`
      UPDATE scheduler_jobs
      SET payload = jsonb_build_object(
        'cursor', ${last.entityId}::text,
        'pass', ${REPAIR_PASS.repair}::text
      )
      WHERE id = ${jobId}
        AND locked_by = ${leaseToken}
    `);
  }

  return {
    status: "progress",
    cursor: last.entityId,
    failed,
    repaired,
  };
};

export const repairSearchSemanticTimestampsTask: SchedulerTask = async ({
  job,
  logger,
  signal,
}) => {
  const outcome = await repairSearchSemanticTimestamps({
    jobId: job.id,
    leaseToken:
      job.lockedBy ??
      panic("Search timestamp repair task requires an active scheduler lease"),
    payload: job.payload,
    signal,
  });

  switch (outcome.status) {
    case "aborted":
      logger.debug("search.semantic_timestamp_repair.aborted");
      return;
    case "complete":
      logger.info("search.semantic_timestamp_repair.complete");
      return;
    case "restart":
      logger.info("search.semantic_timestamp_repair.verification_started");
      return;
    case "progress": {
      const progress = {
        cursor: outcome.cursor,
        failed: outcome.failed,
        repaired: outcome.repaired,
      };
      // A failed reindex repeats on every pass until the entity repairs or
      // parks, so it must reach the ERROR sink operators watch, not only
      // exception telemetry.
      if (outcome.failed > 0) {
        logger.error("search.semantic_timestamp_repair.progress", progress);
      } else {
        logger.info("search.semantic_timestamp_repair.progress", progress);
      }
      return;
    }
    default: {
      const _exhaustive: never = outcome;
      panic(
        `Unhandled search timestamp repair outcome: ${String(_exhaustive)}`,
      );
    }
  }
};
