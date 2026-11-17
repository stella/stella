import { describe, expect, test } from "bun:test";

import { JOURNEY_PREREQUISITE_IDS } from "@stll/api-contract/journey-prerequisites";

import type { SanctionsSourceFreshness } from "@/api/lib/lists/sanctions/freshness";
import { DECLARED_SCHEDULER_JOBS } from "@/api/lib/scheduler/jobs";
import {
  JOURNEY_PREREQUISITES,
  judgePrerequisiteRun,
  parseJourneyPrerequisiteId,
  unavailableSanctionsSources,
} from "@/api/lib/smoke-session/journey-prerequisites";
import type {
  PrerequisiteJobState,
  PrerequisiteRun,
} from "@/api/lib/smoke-session/journey-prerequisites";

const JOB_ID = "sanctions.refreshSources.twoHourly";
const NOW = new Date("2026-11-08T20:30:00.000Z");
const STARTED = new Date("2026-11-08T20:28:00.000Z");

const dueJob = (
  overrides: Partial<PrerequisiteJobState> = {},
): PrerequisiteJobState => ({
  enabled: true,
  lockedAt: null,
  nextRunAt: new Date("2026-11-06T07:00:00.000Z"),
  pausedUntil: null,
  ...overrides,
});

const run = (overrides: Partial<PrerequisiteRun>): PrerequisiteRun => ({
  error: null,
  finishedAt: null,
  startedAt: STARTED,
  status: "running",
  ...overrides,
});

const judge = (
  job: PrerequisiteJobState | null,
  latest: PrerequisiteRun | null,
) => judgePrerequisiteRun({ jobId: JOB_ID, job, run: latest, now: NOW });

describe("journey prerequisite declarations", () => {
  test("every journey's jobs are declared recurring scheduler jobs", () => {
    for (const journey of JOURNEY_PREREQUISITE_IDS) {
      for (const { jobId } of JOURNEY_PREREQUISITES[journey]) {
        const declared = DECLARED_SCHEDULER_JOBS.find(({ id }) => id === jobId);
        expect(declared?.mode, `${journey}: ${jobId}`).toBe("recurring");
      }
    }
  });

  test("parses only the contract's journey ids", () => {
    expect(parseJourneyPrerequisiteId("sanctions-screening")).toBe(
      "sanctions-screening",
    );
    expect(parseJourneyPrerequisiteId("Sanctions-Screening")).toBeNull();
    expect(parseJourneyPrerequisiteId("")).toBeNull();
    expect(parseJourneyPrerequisiteId(null)).toBeNull();
  });
});

describe("judgePrerequisiteRun", () => {
  test("a successful run hands over to the journey's check", () => {
    expect(
      judge(
        dueJob(),
        run({
          status: "success",
          finishedAt: new Date("2026-11-08T20:29:00Z"),
        }),
      ),
    ).toEqual({ state: "check" });
  });

  test("a failed run is final and carries the run's own error", () => {
    expect(
      judge(
        dueJob({ nextRunAt: new Date("2026-11-08T22:29:00.000Z") }),
        run({
          status: "failed",
          finishedAt: new Date("2026-11-08T20:29:00Z"),
          error: "SchedulerJobTimeout",
        }),
      ),
    ).toEqual({
      jobId: JOB_ID,
      state: "failed",
      detail: `${JOB_ID} run started 2026-11-08T20:28:00.000Z failed: SchedulerJobTimeout`,
    });
  });

  test("a failed run without a recorded error still fails", () => {
    expect(judge(dueJob(), run({ status: "failed" }))).toMatchObject({
      state: "failed",
      detail: expect.stringContaining("no error recorded"),
    });
  });

  test("a disabled or paused job cannot run, so it fails instead of waiting", () => {
    expect(judge(dueJob({ enabled: false }), null)).toEqual({
      jobId: JOB_ID,
      state: "failed",
      detail: `${JOB_ID} is disabled`,
    });
    expect(
      judge(
        dueJob({ pausedUntil: new Date("2026-11-09T00:00:00.000Z") }),
        run({ status: "skipped", error: "SchedulerOperatorPaused" }),
      ),
    ).toEqual({
      jobId: JOB_ID,
      state: "failed",
      detail: `${JOB_ID} is paused until 2026-11-09T00:00:00.000Z`,
    });
  });

  test("a pause that has already ended does not hold the job", () => {
    expect(
      judge(
        dueJob({ pausedUntil: new Date("2026-11-08T20:00:00.000Z") }),
        null,
      ),
    ).toMatchObject({ state: "pending" });
  });

  test("waits on a job that is due, claimed, running or skipped", () => {
    expect(judge(dueJob(), null)).toEqual({
      jobId: JOB_ID,
      state: "pending",
      detail: `${JOB_ID} is due at 2026-11-06T07:00:00.000Z and not yet claimed`,
    });
    expect(judge(dueJob({ lockedAt: STARTED }), null)).toEqual({
      jobId: JOB_ID,
      state: "pending",
      detail: `${JOB_ID} was claimed at 2026-11-08T20:28:00.000Z and has not started its run`,
    });
    expect(judge(dueJob(), run({ status: "running" }))).toEqual({
      jobId: JOB_ID,
      state: "pending",
      detail: `${JOB_ID} has been running since 2026-11-08T20:28:00.000Z`,
    });
    expect(
      judge(dueJob(), run({ status: "skipped", error: "SchedulerLeaseLost" })),
    ).toEqual({
      jobId: JOB_ID,
      state: "pending",
      detail: `${JOB_ID} run started 2026-11-08T20:28:00.000Z was skipped (SchedulerLeaseLost); due again at 2026-11-06T07:00:00.000Z`,
    });
  });

  test("a job missing from the deployment fails", () => {
    expect(judge(null, null)).toEqual({
      jobId: JOB_ID,
      state: "failed",
      detail: `${JOB_ID} is not registered on this deployment`,
    });
  });
});

const freshness = (
  overrides: Partial<SanctionsSourceFreshness> &
    Pick<SanctionsSourceFreshness, "source">,
): SanctionsSourceFreshness => ({
  issuer: "European Union",
  licence: null,
  status: "fresh",
  reason: null,
  edition: null,
  lastCheckedAt: null,
  lastSuccessfulVerifiedAt: new Date("2026-11-08T20:29:00.000Z"),
  heldUpdate: null,
  annotation: null,
  ...overrides,
});

describe("unavailableSanctionsSources", () => {
  test("is empty when every required list is fresh, whatever the others", () => {
    expect(
      unavailableSanctionsSources(
        [
          freshness({ source: "eu" }),
          freshness({ source: "uk", status: "unavailable", reason: "stale" }),
        ],
        ["eu"],
      ),
    ).toEqual([]);
  });

  test("names the transport failure code behind a stale list", () => {
    expect(
      unavailableSanctionsSources(
        [
          freshness({
            source: "eu",
            status: "unavailable",
            reason: "stale",
            lastSuccessfulVerifiedAt: new Date("2026-11-06T05:00:00.000Z"),
            annotation: {
              type: "transport-failure",
              code: "fetch-failed",
              at: new Date("2026-11-08T20:29:00.000Z"),
            },
          }),
        ],
        ["eu"],
      ),
    ).toEqual([
      "eu stale (last verified 2026-11-06T05:00:00.000Z; last fetch failed 2026-11-08T20:29:00.000Z: fetch-failed)",
    ]);
  });

  test("names a held update and a list never loaded", () => {
    expect(
      unavailableSanctionsSources(
        [
          freshness({
            source: "eu",
            status: "unavailable",
            reason: "stale",
            lastSuccessfulVerifiedAt: new Date("2026-11-06T05:00:00.000Z"),
            annotation: { type: "held-for-review", code: "contracted" },
          }),
          freshness({
            source: "un",
            status: "unavailable",
            reason: "not-loaded",
            lastSuccessfulVerifiedAt: null,
          }),
        ],
        ["eu", "un", "cz"],
      ),
    ).toEqual([
      "eu stale (last verified 2026-11-06T05:00:00.000Z; update held for review: contracted)",
      "un not-loaded (never verified)",
      "cz is not configured",
    ]);
  });
});
