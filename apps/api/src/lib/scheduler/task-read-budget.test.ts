import { describe, expect, test } from "bun:test";

import "@/api/tests/setup-env";
import { SCHEDULER_TASK_READ_BUDGET } from "@/api/lib/scheduler/task-read-budget";
import { QUERY_PLAN_REGISTRY } from "@/api/tests/query-plans/registry";

/**
 * Tasks the census has not classified yet. Shrink only: classify a task
 * (register its guarded reads in the query-plan registry, or state that it
 * has none) and lower this number with it. A new task cannot raise it.
 */
const UNREVIEWED_BASELINE = 52;

const budgets = Object.entries(SCHEDULER_TASK_READ_BUDGET);

describe("scheduler task read budgets", () => {
  test("every plan a task names is pinned by the query-plan registry", () => {
    const registered = new Map(
      QUERY_PLAN_REGISTRY.map((entry) => [entry.id, entry] as const),
    );
    const missing = budgets.flatMap(([task, budget]) =>
      budget.type === "plan-registered"
        ? budget.queryPlanIds
            .filter((id) => !registered.has(id))
            .map((id) => `${task}: ${id}`)
        : [],
    );
    expect(missing).toEqual([]);
  });

  test("a task's sequential-scan exemption is named where the task is", () => {
    const mismatched = budgets.flatMap(([task, budget]) => {
      if (budget.type !== "plan-registered") {
        return [];
      }
      const exempt = budget.queryPlanIds.filter((id) => {
        const entry = QUERY_PLAN_REGISTRY.find(
          (candidate) => candidate.id === id,
        );
        return (
          entry !== undefined &&
          "allowSeqScan" in entry.contract &&
          entry.contract.allowSeqScan.length > 0
        );
      });
      const accepted = new Set(budget.acceptedSequentialScans);
      return [
        ...exempt
          .filter((id) => !accepted.has(id))
          .map((id) => `${task}: ${id} scans a guarded table, unaccepted`),
        ...budget.acceptedSequentialScans
          .filter((id) => !exempt.includes(id))
          .map((id) => `${task}: ${id} no longer needs its acceptance`),
      ];
    });
    expect(mismatched).toEqual([]);
  });

  test("the unreviewed baseline only shrinks", () => {
    const unreviewed = budgets.filter(
      ([, budget]) => budget.type === "unreviewed",
    ).length;
    expect(unreviewed).toBeLessThanOrEqual(UNREVIEWED_BASELINE);
    // Lower the baseline in the change that classifies a task.
    expect(unreviewed).toBe(UNREVIEWED_BASELINE);
  });
});
