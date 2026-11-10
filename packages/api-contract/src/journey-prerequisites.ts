import * as v from "valibot";

import { apiDateTimeSchema } from "./api-date";

/**
 * Deployed user journeys whose outcome depends on a scheduled job having run
 * recently. A staging deployment that was powered off for longer than a
 * job's freshness window serves stale data until that job runs again, so the
 * journey brings the job forward and waits for its run before it judges the
 * product. The API owns which jobs each journey needs
 * (`lib/smoke-session/journey-prerequisites.ts`); a journey only names itself.
 */
export const JOURNEY_PREREQUISITE = {
  sanctionsScreening: "sanctions-screening",
} as const;

export const JOURNEY_PREREQUISITE_IDS = [
  JOURNEY_PREREQUISITE.sanctionsScreening,
] as const;

export type JourneyPrerequisiteId = (typeof JOURNEY_PREREQUISITE_IDS)[number];

/**
 * The longest one scheduled job run may take. The API scheduler leases each
 * run for this long, and a journey waits this long for the run it brought
 * forward: a job still inside its budget has not failed.
 */
export const SCHEDULED_JOB_MAX_RUNTIME_MS = 30 * 60_000;

/** Staging-only, secret-gated: `POST` brings the jobs forward, `GET` reports their runs. */
export const JOURNEY_PREREQUISITES_PATH =
  "/smoke/scheduled-jobs/journey-prerequisites";

export const JOURNEY_PREREQUISITE_STATE = {
  /** The job has not finished a run since it was brought forward. */
  pending: "pending",
  /** The job ran and established what the journey reads. */
  ready: "ready",
  /** The job cannot establish it: its run failed, or it is disabled or paused. */
  failed: "failed",
} as const;

export const journeyPrerequisitesForwardSchema = v.object({
  /** Runs that finish at or after this instant count; pass it back as `since`. */
  dueAt: apiDateTimeSchema,
  jobIds: v.array(v.string()),
});

export type JourneyPrerequisitesForward = v.InferOutput<
  typeof journeyPrerequisitesForwardSchema
>;

const journeyPrerequisiteReportSchema = v.variant("state", [
  v.object({
    jobId: v.string(),
    state: v.literal(JOURNEY_PREREQUISITE_STATE.ready),
  }),
  v.object({
    jobId: v.string(),
    state: v.picklist([
      JOURNEY_PREREQUISITE_STATE.pending,
      JOURNEY_PREREQUISITE_STATE.failed,
    ]),
    /** What the job is waiting on, or the run's own error and failure codes. */
    detail: v.string(),
  }),
]);

export type JourneyPrerequisiteReport = v.InferOutput<
  typeof journeyPrerequisiteReportSchema
>;

export const journeyPrerequisitesReportSchema = v.object({
  /** Every journey declares at least one job; an empty report proves nothing. */
  prerequisites: v.pipe(
    v.array(journeyPrerequisiteReportSchema),
    v.minLength(1),
  ),
});

export type JourneyPrerequisitesReport = v.InferOutput<
  typeof journeyPrerequisitesReportSchema
>;
