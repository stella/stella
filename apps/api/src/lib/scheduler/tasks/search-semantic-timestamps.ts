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
const MISSING_INDEX_CONCURRENCY = 4;
const REPAIR_PASS = {
  repair: "repair",
  verify: "verify",
} as const;

type RepairPass = (typeof REPAIR_PASS)[keyof typeof REPAIR_PASS];

type RepairPageRow = {
  entityId: SafeId<"entity">;
  repairedEntityId: SafeId<"entity"> | null;
  searchDocumentMissing: boolean;
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
  return {
    cursor: typeof cursor === "string" ? cursor : null,
    pass:
      payload?.["pass"] === REPAIR_PASS.verify
        ? REPAIR_PASS.verify
        : REPAIR_PASS.repair,
  };
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
  const pageRows = await rootDb.execute<RepairPageRow>(sql`
    WITH page AS MATERIALIZED (
      SELECT
        e.id AS entity_id,
        COALESCE(e.updated_at, e.created_at) AS semantic_updated_at,
        sd.entity_id IS NULL AS search_document_missing
      FROM entities e
      LEFT JOIN search_documents sd ON sd.entity_id = e.id
      WHERE (${state.cursor}::uuid IS NULL OR e.id > ${state.cursor}::uuid)
        AND e.current_version_id IS NOT NULL
      ORDER BY e.id
      LIMIT ${REPAIR_BATCH_SIZE}
    ),
    repaired AS (
      UPDATE search_documents sd
      SET updated_at = page.semantic_updated_at
      FROM page
      WHERE sd.entity_id = page.entity_id
        AND sd.updated_at IS DISTINCT FROM page.semantic_updated_at
      RETURNING sd.entity_id
    )
    SELECT
      page.entity_id AS "entityId",
      repaired.entity_id AS "repairedEntityId",
      page.search_document_missing AS "searchDocumentMissing"
    FROM page
    LEFT JOIN repaired ON repaired.entity_id = page.entity_id
    ORDER BY page.entity_id
  `);
  const last = pageRows.at(-1);

  if (!last) {
    if (state.pass === REPAIR_PASS.repair) {
      // The database write guard rejects legacy indexers that still send
      // reindex time during a rolling deployment. A clean second pass can
      // therefore prove this fixed point before the one-shot job disables.
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

  const missingEntityIds = pageRows.flatMap((row) =>
    row.searchDocumentMissing ? [row.entityId] : [],
  );
  for (
    let start = 0;
    start < missingEntityIds.length;
    start += MISSING_INDEX_CONCURRENCY
  ) {
    if (signal.aborted) {
      return { status: "aborted" };
    }
    // oxlint-disable-next-line no-await-in-loop, no-db-await-in-loop/no-db-await-in-loop -- bounded repair: each four-entity chunk drains before the next so decrypt and projection work cannot overwhelm Postgres
    await Promise.all(
      missingEntityIds
        .slice(start, start + MISSING_INDEX_CONCURRENCY)
        .map(upsertSearchDocument),
    );
  }

  // Checkpoint last: a replay after the projection update but before this
  // write safely finds no mismatch and advances again.
  await rootDb.execute(sql`
    UPDATE scheduler_jobs
    SET payload = jsonb_build_object(
      'cursor', ${last.entityId}::text,
      'pass', ${state.pass}
    )
    WHERE id = ${jobId}
      AND locked_by = ${leaseToken}
  `);

  return {
    status: "progress",
    cursor: last.entityId,
    repaired:
      pageRows.filter((row) => row.repairedEntityId !== null).length +
      missingEntityIds.length,
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
