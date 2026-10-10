import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { DAY_IN_MS } from "@stll/time";

import {
  DECLARED_SCHEDULER_JOBS,
  initialNextRunAt,
} from "@/api/lib/scheduler/jobs";
import { REGISTERED_SCHEDULER_TASK_NAMES } from "@/api/lib/scheduler/registry";
import { REFRESH_CASE_LAW_SOURCE_ARRIVALS_TASK } from "@/api/lib/scheduler/tasks/case-law-source-arrivals-refresh";
import { FLOW_RUN_TASK } from "@/api/lib/scheduler/tasks/flow-run";
import { REFRESH_LEGISLATION_FACETS_TASK } from "@/api/lib/scheduler/tasks/legislation-facet-refresh";
import { PURGE_SYSTEM_AUDIT_RUNS_TASK } from "@/api/lib/scheduler/tasks/system-audit-retention";

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

  test("dynamically scheduled tasks stay drivable", () => {
    // Registration disables persisted rows whose task the registry cannot
    // run. Flow schedules register their rows at runtime, outside the
    // declared list, so the moment their task left the registry the sweep
    // would disable every scheduled flow on the next boot.
    expect(REGISTERED_SCHEDULER_TASK_NAMES.has(FLOW_RUN_TASK)).toBe(true);
  });

  test("every declared job has a positive cadence", () => {
    const stalled = DECLARED_SCHEDULER_JOBS.filter(
      ({ schedule }) => schedule.type === "interval" && schedule.everyMs <= 0,
    ).map(({ id }) => id);

    // A zero or negative interval is either a hot loop or a job that never
    // becomes due; both are silent.
    expect(stalled).toEqual([]);
  });

  test("system audit runs are purged daily", () => {
    expect(
      DECLARED_SCHEDULER_JOBS.find(
        ({ task }) => task === PURGE_SYSTEM_AUDIT_RUNS_TASK,
      ),
    ).toMatchObject({
      id: "audit.purgeSystemRuns.day",
      mode: "recurring",
      schedule: { type: "interval", everyMs: DAY_IN_MS },
    });
  });

  test("snapshot refreshes are due as soon as their job is registered", () => {
    // Their readers serve the snapshot: a first run one interval after a
    // deploy would leave a fresh database on the slow fallback (facets) or
    // without figures (arrivals) for that whole interval.
    for (const task of [
      REFRESH_LEGISLATION_FACETS_TASK,
      REFRESH_CASE_LAW_SOURCE_ARRIVALS_TASK,
    ]) {
      const definition =
        DECLARED_SCHEDULER_JOBS.find((job) => job.task === task) ??
        panic(`${task} is not declared`);
      const now = new Date("2026-10-08T12:00:00.000Z");
      expect(initialNextRunAt(definition, now)).toEqual(now);
    }
  });

  test("other interval jobs still wait one interval before their first run", () => {
    const now = new Date("2026-10-08T12:00:00.000Z");
    const definition =
      DECLARED_SCHEDULER_JOBS.find(
        ({ task }) => task === PURGE_SYSTEM_AUDIT_RUNS_TASK,
      ) ?? panic("The audit purge is not declared");
    expect(initialNextRunAt(definition, now).getTime()).toBe(
      now.getTime() + DAY_IN_MS,
    );
  });
});
