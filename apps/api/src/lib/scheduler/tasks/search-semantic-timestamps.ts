import { panic } from "better-result";
import { sql } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import type { SchedulerPayload } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const REPAIR_SEARCH_SEMANTIC_TIMESTAMPS_TASK =
  "search.repairSemanticTimestamps" as const;

/** Keep every repair transaction small while the versioned job drains. */
const REPAIR_BATCH_SIZE = 500;
const REPAIR_PASS = {
  repair: "repair",
  verify: "verify",
} as const;

type RepairPass = (typeof REPAIR_PASS)[keyof typeof REPAIR_PASS];

type RepairedSearchDocument = {
  entityId: SafeId<"entity">;
};

type RepairSearchSemanticTimestampsOptions = {
  jobId: string;
  leaseToken: string;
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
  cursor: string | null;
  pass: RepairPass;
};

const repairState = (payload: SchedulerPayload | null): RepairState => {
  const cursor = payload?.["cursor"];
  if (typeof cursor === "string") {
    return { cursor, pass: REPAIR_PASS.repair };
  }
  return { cursor: null, pass: REPAIR_PASS.verify };
};

export const repairSearchSemanticTimestamps = async ({
  jobId,
  leaseToken,
  payload,
  signal,
}: RepairSearchSemanticTimestampsOptions): Promise<RepairSearchSemanticTimestampsOutcome> => {
  if (signal.aborted) {
    return { status: "aborted" };
  }

  const state = repairState(payload);
  // audit: skip — this changes only a derived search projection; the
  // scheduler run and versioned job cursor are the durable operator trail.
  const repaired = await rootDb.execute<RepairedSearchDocument>(sql`
    WITH candidates AS (
      SELECT
        sd.entity_id,
        COALESCE(e.updated_at, e.created_at) AS semantic_updated_at
      FROM search_documents sd
      INNER JOIN entities e ON e.id = sd.entity_id
      WHERE (${state.cursor}::uuid IS NULL OR sd.entity_id > ${state.cursor}::uuid)
        AND sd.updated_at IS DISTINCT FROM COALESCE(e.updated_at, e.created_at)
      ORDER BY sd.entity_id
      LIMIT ${REPAIR_BATCH_SIZE}
      FOR UPDATE OF sd
    )
    UPDATE search_documents sd
    SET updated_at = candidates.semantic_updated_at
    FROM candidates
    WHERE sd.entity_id = candidates.entity_id
    RETURNING sd.entity_id AS "entityId"
  `);

  const last = repaired.at(-1);
  if (!last) {
    if (state.pass === REPAIR_PASS.repair) {
      // A rolling deployment can still contain an older indexer that writes
      // reindex time after this cursor has passed an entity. Start a clean
      // verification pass before disabling so every repaired range is
      // revisited after old writers have had a chance to drain.
      await rootDb.execute(sql`
        UPDATE scheduler_jobs
        SET payload = jsonb_build_object('pass', ${REPAIR_PASS.verify})
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

  return {
    status: "progress",
    cursor: last.entityId,
    repaired: repaired.length,
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
