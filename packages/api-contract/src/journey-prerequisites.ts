import * as v from "valibot";

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
  dueAt: v.pipe(v.string(), v.isoTimestamp()),
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
  prerequisites: v.array(journeyPrerequisiteReportSchema),
});

export type JourneyPrerequisitesReport = v.InferOutput<
  typeof journeyPrerequisitesReportSchema
>;
