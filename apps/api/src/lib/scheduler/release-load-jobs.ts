import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { schedulerJobs } from "@/api/db/schema";
import type { DECLARED_SCHEDULER_JOBS } from "@/api/lib/scheduler/jobs";
import type { SchedulerDb } from "@/api/lib/scheduler/types";

type DeclaredSchedulerJobId = (typeof DECLARED_SCHEDULER_JOBS)[number]["id"];

/**
 * The recurring jobs that read the public corpus. The staging release proof
 * brings them forward and runs its MCP load while they run, because a heavy
 * job and user traffic only interfere when they overlap.
 */
const RELEASE_LOAD_JOB_IDS = [
  "caseLaw.reportFreshness.fiveMinute",
  "caseLaw.refreshSitemapShards.hourly",
  "caseLaw.refreshBrowseFacets.hourly",
  "caseLaw.refreshSourceArrivals.threeHourly",
  "legislation.refreshSitemapShards.hourly",
  "legislation.refreshFacetCounts.hourly",
] as const satisfies readonly DeclaredSchedulerJobId[];

const jobColumns = {
  id: schedulerJobs.id,
  lastRunAt: schedulerJobs.lastRunAt,
  lockedAt: schedulerJobs.lockedAt,
  nextRunAt: schedulerJobs.nextRunAt,
};

const listed = inArray(schedulerJobs.id, RELEASE_LOAD_JOB_IDS);

/** When each listed job last ran, is running, and runs next. */
export const readReleaseLoadJobs = async (db: SchedulerDb = rootDb) =>
  await db
    .select(jobColumns)
    .from(schedulerJobs)
    .where(listed)
    .orderBy(schedulerJobs.id)
    .limit(RELEASE_LOAD_JOB_IDS.length);

/**
 * Makes every enabled, unpaused listed job due now; the next scheduler sweep
 * on any replica claims them through its usual lease. A job already running
 * keeps its lease, and its finish sets its next slot as usual.
 */
export const bringReleaseLoadJobsForward = async (db: SchedulerDb = rootDb) =>
  // audit: skip — scheduler system state on a non-production deployment; the smoke route logs the ids it moved.
  await db
    .update(schedulerJobs)
    .set({ nextRunAt: sql`now()` })
    .where(
      and(
        listed,
        eq(schedulerJobs.enabled, true),
        or(
          isNull(schedulerJobs.pausedUntil),
          lte(schedulerJobs.pausedUntil, sql`now()`),
        ),
      ),
    )
    .returning(jobColumns);
