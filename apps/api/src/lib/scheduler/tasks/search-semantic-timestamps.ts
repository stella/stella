import { panic } from "better-result";
import { sql } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import type { SchedulerPayload } from "@/api/db/schema";
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
      repaired: number;
    };

type RepairState = {
  cleanPasses: number;
  cursor: string | null;
  dirty: boolean;
  pass: RepairPass;
  quietSince: string | null;
};

const repairState = (payload: SchedulerPayload | null): RepairState => {
  const cursor = payload?.["cursor"];
  const pass =
    payload?.["pass"] === REPAIR_PASS.verify
      ? REPAIR_PASS.verify
      : REPAIR_PASS.repair;
  const cleanPasses = payload?.["cleanPasses"];
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
    quietSince:
      pass === REPAIR_PASS.verify &&
      typeof quietSince === "string" &&
      !Number.isNaN(new Date(quietSince).getTime())
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
}: RepairSearchSemanticTimestampsOptions): Promise<RepairSearchSemanticTimestampsOutcome> => {
  if (signal.aborted) {
    return { status: "aborted" };
  }

  const state = repairState(payload);
  // audit: skip — this changes only a derived search projection; the
  // scheduler run and versioned job cursor are the durable operator trail.
  const pageRows = await rootDb.execute<RepairPageRow>(sql`
    WITH source_page AS MATERIALIZED (
      SELECT
        e.id AS entity_id,
        COALESCE(e.updated_at, e.created_at) AS semantic_updated_at,
        sd.updated_at AS indexed_updated_at
      FROM entities e
      LEFT JOIN search_documents sd ON sd.entity_id = e.id
      WHERE (${state.cursor}::uuid IS NULL OR e.id > ${state.cursor}::uuid)
        AND e.current_version_id IS NOT NULL
      ORDER BY e.id
      LIMIT ${REPAIR_BATCH_SIZE}
    )
    SELECT
      source_page.entity_id AS "entityId",
      (
        source_page.indexed_updated_at IS NULL
        OR source_page.indexed_updated_at
          IS DISTINCT FROM source_page.semantic_updated_at
      ) AS "needsReindex"
    FROM source_page
    ORDER BY source_page.entity_id
  `);
  const last = pageRows.at(-1);
  const nowIso = now.toISOString();

  if (!last) {
    if (state.pass === REPAIR_PASS.repair) {
      // Old application instances can still write reindex time during a
      // rolling deployment. Persist a quiet-window start, then require two
      // complete clean passes before disabling this one-shot repair.
      await rootDb.execute(sql`
        UPDATE scheduler_jobs
        SET payload = jsonb_build_object(
          'pass', ${REPAIR_PASS.verify},
          'dirty', false,
          'cleanPasses', 0,
          'quietSince', ${nowIso}
        )
        WHERE id = ${jobId}
          AND locked_by = ${leaseToken}
      `);
      return { status: "restart" };
    }

    const cleanPasses = state.dirty
      ? 0
      : Math.min(state.cleanPasses + 1, REQUIRED_CLEAN_VERIFICATION_PASSES);
    const quietSince = state.quietSince ?? nowIso;
    const quietPeriodElapsed =
      now.getTime() - new Date(quietSince).getTime() >=
      VERIFICATION_QUIET_PERIOD_MS;
    if (
      state.dirty ||
      cleanPasses < REQUIRED_CLEAN_VERIFICATION_PASSES ||
      !quietPeriodElapsed
    ) {
      await rootDb.execute(sql`
        UPDATE scheduler_jobs
        SET payload = jsonb_build_object(
          'pass', ${REPAIR_PASS.verify},
          'dirty', false,
          'cleanPasses', ${cleanPasses},
          'quietSince', ${quietSince}
        )
        WHERE id = ${jobId}
          AND locked_by = ${leaseToken}
      `);
      return { status: "restart" };
    }

    // audit: skip — this only disables a versioned repair of a derived search
    // projection; scheduler_job_runs is the durable operator trail.
    await rootDb.execute(sql`
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
    // Mark the pass dirty before external projection work. A crash can replay
    // the page, but cannot lose the quiet-window reset.
    await rootDb.execute(sql`
      UPDATE scheduler_jobs
      SET payload = jsonb_build_object(
        'cursor', ${state.cursor}::text,
        'pass', ${REPAIR_PASS.verify},
        'dirty', true,
        'cleanPasses', 0,
        'quietSince', ${nowIso}
      )
      WHERE id = ${jobId}
        AND locked_by = ${leaseToken}
    `);
  }

  let nextReindexIndex = 0;
  const reindexNext = async (): Promise<void> => {
    const entityId = reindexEntityIds.at(nextReindexIndex);
    nextReindexIndex += 1;
    if (!entityId) {
      return;
    }
    await upsertSearchDocument(entityId);
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

  if (state.pass === REPAIR_PASS.verify) {
    await rootDb.execute(sql`
      UPDATE scheduler_jobs
      SET payload = jsonb_build_object(
        'cursor', ${last.entityId}::text,
        'pass', ${REPAIR_PASS.verify},
        'dirty', ${verificationDirty},
        'cleanPasses', ${verificationDirty ? 0 : state.cleanPasses},
        'quietSince', ${quietSince}
      )
      WHERE id = ${jobId}
        AND locked_by = ${leaseToken}
    `);
  } else {
    // Checkpoint last: a replay after the projection update but before this
    // write safely finds no mismatch and advances again.
    await rootDb.execute(sql`
      UPDATE scheduler_jobs
      SET payload = jsonb_build_object(
        'cursor', ${last.entityId}::text,
        'pass', ${REPAIR_PASS.repair}
      )
      WHERE id = ${jobId}
        AND locked_by = ${leaseToken}
    `);
  }

  return {
    status: "progress",
    cursor: last.entityId,
    repaired: reindexEntityIds.length,
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
    case "progress":
      logger.info("search.semantic_timestamp_repair.progress", {
        cursor: outcome.cursor,
        repaired: outcome.repaired,
      });
      return;
    default: {
      const _exhaustive: never = outcome;
      panic(
        `Unhandled search timestamp repair outcome: ${String(_exhaustive)}`,
      );
    }
  }
};
