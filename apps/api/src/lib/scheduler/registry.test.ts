import { panic } from "better-result";
import { expect, test } from "bun:test";

import {
  currentQueryCount,
  queryCountLogger,
} from "@/api/lib/db-query-counter";
import {
  createSchedulerTaskRegistry,
  REGISTERED_SCHEDULER_TASK_NAMES,
} from "@/api/lib/scheduler/registry";
import { REFRESH_CASE_LAW_COVERAGE_TASK } from "@/api/lib/scheduler/tasks/case-law-coverage-refresh";
import { REAP_OWNERLESS_CHAT_TURNS_TASK } from "@/api/lib/scheduler/tasks/chat-turn-reaper";
import type { SchedulerTaskContext } from "@/api/lib/scheduler/types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

test("the complete scheduler registry counts each task invocation independently", async () => {
  const countedTask = async () => {
    expect(currentQueryCount()).toBe(0);
    queryCountLogger.logQuery("select 1", []);
    await Promise.resolve();
    queryCountLogger.logQuery("select 2", []);
    expect(currentQueryCount()).toBe(2);
  };
  const registry = createSchedulerTaskRegistry(countedTask, countedTask);
  expect(new Set(registry.keys())).toEqual(
    new Set(REGISTERED_SCHEDULER_TASK_NAMES),
  );
  const task = registry.get(REAP_OWNERLESS_CHAT_TURNS_TASK);
  if (task === undefined) {
    panic("The registered reaper task must be executable");
  }
  // The injected task deliberately needs no database or scheduler services.
  const context = asTestRaw<SchedulerTaskContext>({});
  await task(context);
  await task(context);
  const refresh = registry.get(REFRESH_CASE_LAW_COVERAGE_TASK);
  if (refresh === undefined) {
    panic("The injected coverage task must be executable");
  }
  await refresh(context);
  expect(currentQueryCount()).toBeUndefined();
});
