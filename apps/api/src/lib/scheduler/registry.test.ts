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
import { REAP_OWNERLESS_CHAT_TURNS_TASK } from "@/api/lib/scheduler/tasks/chat-turn-reaper";
import type { SchedulerTaskContext } from "@/api/lib/scheduler/types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

test("the complete scheduler registry counts each task invocation independently", async () => {
  const registry = createSchedulerTaskRegistry(async () => {
    expect(currentQueryCount()).toBe(0);
    queryCountLogger.logQuery("select 1", []);
    await Promise.resolve();
    queryCountLogger.logQuery("select 2", []);
    expect(currentQueryCount()).toBe(2);
  });
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
  expect(currentQueryCount()).toBeUndefined();
});
