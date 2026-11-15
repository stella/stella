/**
 * The scheduled jobs each deployed user journey depends on, and how a job's
 * latest run is judged for that journey.
 *
 * Staging runs only for release proofs, so a list whose freshness window is
 * shorter than the time staging was off is stale when a proof starts, and the
 * job that refreshes it may not have run yet by the time the journey reads
 * it. The journey brings its jobs forward (`POST`), then polls (`GET`) until
 * every job has finished a run since then. A failed run, a disabled or paused
 * job, or a run that left the list unavailable is reported with its own
 * error or failure code, so the proof names the cause instead of "stale".
 */

import { panic } from "better-result";

import {
  JOURNEY_PREREQUISITE,
  JOURNEY_PREREQUISITE_IDS,
  JOURNEY_PREREQUISITE_STATE,
} from "@stll/api-contract/journey-prerequisites";
import type {
  JourneyPrerequisiteId,
  JourneyPrerequisiteReport,
} from "@stll/api-contract/journey-prerequisites";
import type { SanctionsSource } from "@stll/sanctions";

import type { schedulerJobRuns, schedulerJobs } from "@/api/db/schema";
import type { SanctionsSourceFreshness } from "@/api/lib/lists/sanctions/freshness";
import type { DECLARED_SCHEDULER_JOBS } from "@/api/lib/scheduler/jobs";

export type DeclaredSchedulerJobId =
  (typeof DECLARED_SCHEDULER_JOBS)[number]["id"];

/**
 * What a successful run must have left in place for the journey to hold: the
 * sanctions lists it screens against, available for screening. A job that
 * refreshes something else adds its own field here and its read in the store.
 */
export type JourneyPrerequisiteCheck = {
  sanctionsSources: readonly [SanctionsSource, ...SanctionsSource[]];
};

export type JourneyPrerequisite = {
  jobId: DeclaredSchedulerJobId;
  check: JourneyPrerequisiteCheck;
};

/**
 * One entry per journey (the record is total over the contract's ids). The
 * sanctions journey screens a name against the EU list, which is stale 48 h
 * after its last successful verification.
 */
export const JOURNEY_PREREQUISITES = {
  [JOURNEY_PREREQUISITE.sanctionsScreening]: [
    {
      jobId: "sanctions.refreshSources.twoHourly",
      check: { sanctionsSources: ["eu"] },
    },
  ],
} as const satisfies Record<
  JourneyPrerequisiteId,
  readonly [JourneyPrerequisite, ...JourneyPrerequisite[]]
>;

export const parseJourneyPrerequisiteId = (
  value: string | null,
): JourneyPrerequisiteId | null =>
  JOURNEY_PREREQUISITE_IDS.find((id) => id === value) ?? null;

export type PrerequisiteJobState = Pick<
  typeof schedulerJobs.$inferSelect,
  "enabled" | "lockedAt" | "nextRunAt" | "pausedUntil"
>;

export type PrerequisiteRun = Pick<
  typeof schedulerJobRuns.$inferSelect,
  "error" | "finishedAt" | "startedAt" | "status"
>;

/** A judgement before the check: the run decides, or the check must. */
export type PrerequisiteRunVerdict =
  Exclude<JourneyPrerequisiteReport, { state: "ready" }> | { state: "check" };

type JudgeRunOptions = {
  jobId: string;
  /** Null when the deployment has no such job registered. */
  job: PrerequisiteJobState | null;
  /** The latest run still running or finished at or after `since`. */
  run: PrerequisiteRun | null;
  now: Date;
};

/**
 * Judges a prerequisite job from its scheduler row and latest run. A run that
 * finished successfully hands over to the journey's check; a failed run is
 * final, since it moves the job's next run a full interval out. A skipped run
 * leaves the job due, so it is pending unless the job is disabled or paused.
 */
export const judgePrerequisiteRun = ({
  jobId,
  job,
  run,
  now,
}: JudgeRunOptions): PrerequisiteRunVerdict => {
  const failed = (detail: string) => ({
    jobId,
    state: JOURNEY_PREREQUISITE_STATE.failed,
    detail,
  });
  const pending = (detail: string) => ({
    jobId,
    state: JOURNEY_PREREQUISITE_STATE.pending,
    detail,
  });
  if (job === null) {
    return failed(`${jobId} is not registered on this deployment`);
  }
  if (run?.status === "success") {
    return { state: "check" };
  }
  if (run?.status === "failed") {
    return failed(
      `${jobId} run started ${run.startedAt.toISOString()} failed: ${run.error ?? "no error recorded"}`,
    );
  }
  if (!job.enabled) {
    return failed(`${jobId} is disabled`);
  }
  if (job.pausedUntil !== null && job.pausedUntil > now) {
    return failed(`${jobId} is paused until ${job.pausedUntil.toISOString()}`);
  }
  if (run === null) {
    return pending(
      job.lockedAt === null
        ? `${jobId} is due at ${job.nextRunAt.toISOString()} and not yet claimed`
        : `${jobId} was claimed at ${job.lockedAt.toISOString()} and has not started its run`,
    );
  }
  switch (run.status) {
    case "running":
      return pending(
        `${jobId} has been running since ${run.startedAt.toISOString()}`,
      );
    case "skipped":
      return pending(
        `${jobId} run started ${run.startedAt.toISOString()} was skipped (${run.error ?? "no reason recorded"}); due again at ${job.nextRunAt.toISOString()}`,
      );
    default:
      run.status satisfies never;
      return panic("Unhandled scheduler run status");
  }
};

const describeSanctionsSource = ({
  source,
  reason,
  lastSuccessfulVerifiedAt,
  annotation,
}: SanctionsSourceFreshness): string => {
  const verified =
    lastSuccessfulVerifiedAt === null
      ? "never verified"
      : `last verified ${lastSuccessfulVerifiedAt.toISOString()}`;
  if (annotation === null) {
    return `${source} ${reason ?? "unavailable"} (${verified})`;
  }
  switch (annotation.type) {
    case "transport-failure":
      return `${source} ${reason ?? "unavailable"} (${verified}; last fetch failed ${annotation.at.toISOString()}: ${annotation.code})`;
    case "held-for-review":
      return `${source} ${reason ?? "unavailable"} (${verified}; update held for review: ${annotation.code})`;
    default:
      annotation satisfies never;
      return panic("Unhandled sanctions source annotation");
  }
};

/**
 * The required sanctions lists that are not available for screening, each
 * with its own reason and the source's last failure or held-update code.
 * Empty when every required list is fresh.
 */
export const unavailableSanctionsSources = (
  freshness: readonly SanctionsSourceFreshness[],
  required: readonly SanctionsSource[],
): string[] =>
  required.flatMap((source) => {
    const row = freshness.find((entry) => entry.source === source);
    if (row === undefined) {
      return [`${source} is not configured`];
    }
    return row.status === "fresh" ? [] : [describeSanctionsSource(row)];
  });
