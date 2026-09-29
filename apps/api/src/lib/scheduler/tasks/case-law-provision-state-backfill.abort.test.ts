import { expect, test } from "bun:test";

import type { withLongRunningConnection } from "@/api/db/long-running-connection";
import { createCaseLawProvisionStateBackfillTask } from "@/api/lib/scheduler/tasks/case-law-provision-state-backfill";
import type { SchedulerTaskContext } from "@/api/lib/scheduler/types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

test("an abort that rejects the connection helper is logged as an abort", async () => {
  const controller = new AbortController();
  // Like the real helper: the work returns, then the signal aborts and the
  // helper rejects with the abort reason instead of returning the result.
  const abortingConnection: typeof withLongRunningConnection = async ({
    signal,
  }) => {
    controller.abort(new Error("scheduler shutdown"));
    signal.throwIfAborted();
    return await Promise.reject(new Error("the signal should have aborted"));
  };
  const events: string[] = [];
  const recordEvent = (event: string) => {
    events.push(event);
  };
  const task = createCaseLawProvisionStateBackfillTask({
    withConnection: abortingConnection,
  });
  const outcome = await Promise.resolve(
    task(
      asTestRaw<SchedulerTaskContext>({
        logger: { info: recordEvent, warn: recordEvent, error: recordEvent },
        signal: controller.signal,
      }),
    ),
  ).then(
    () => "resolved",
    () => "rejected",
  );

  expect(outcome).toBe("resolved");
  expect(events).toEqual([
    "scheduler.case_law_provision_state_backfill_aborted",
  ]);
});
