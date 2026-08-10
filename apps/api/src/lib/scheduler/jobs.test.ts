import { describe, expect, test } from "bun:test";

import { DECLARED_SCHEDULER_JOBS } from "@/api/lib/scheduler/jobs";

/**
 * A scheduled job that never runs emits nothing: no error, no log, no metric.
 * "Nobody is running the loop" and "there was no work to do" produce identical
 * output, so the only way to notice is to compare the declaration against
 * something independent. Task implementation coverage is enforced by the
 * `RegisteredSchedulerTaskName` type; the boot-time assertion in
 * `ensureDefaultSchedulerJobs` checks recurring rows against the database.
 */
describe("declared scheduler jobs", () => {
  test("the declaration is not empty", () => {
    // Without this the checks below pass vacuously on an empty list — the
    // same shape as the defect they exist to catch, where nothing is
    // registered and nothing complains.
    expect(DECLARED_SCHEDULER_JOBS.length).toBeGreaterThan(0);
  });

  test("job ids are unique", () => {
    const ids = DECLARED_SCHEDULER_JOBS.map(({ id }) => id);

    // Ids are the primary key: a duplicate silently overwrites its twin's
    // schedule, and only one of the two ever runs.
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every declared job has a positive cadence", () => {
    const stalled = DECLARED_SCHEDULER_JOBS.filter(
      ({ schedule }) => schedule.type === "interval" && schedule.everyMs <= 0,
    ).map(({ id }) => id);

    // A zero or negative interval is either a hot loop or a job that never
    // becomes due; both are silent.
    expect(stalled).toEqual([]);
  });
});
