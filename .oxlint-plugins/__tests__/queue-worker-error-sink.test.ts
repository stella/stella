import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

describe("queue-worker-error-sink", () => {
  test("reports direct logging from an error callback", async () => {
    expect(
      await lintSingleRule(
        "queue-worker-error-sink",
        'worker.on("error", (error) => { logger.error("poll failed", { error }); });',
      ),
    ).toEqual([1]);
  });
  test("reports worker error events held in constants", async () => {
    expect(
      await lintSingleRule(
        "queue-worker-error-sink",
        'const EVENT = "jobs.worker_error";\nlogger.error(EVENT, { queue: "jobs" });',
      ),
    ).toEqual([2]);
  });
  test("accepts the throttled handler", async () => {
    expect(
      await lintSingleRule(
        "queue-worker-error-sink",
        'worker.on("error", createQueueWorkerErrorLogger("jobs.worker_error", { queue: "jobs" }));',
      ),
    ).toEqual([]);
  });
  test("accepts unrelated event logging", async () => {
    expect(
      await lintSingleRule(
        "queue-worker-error-sink",
        'worker.on("completed", () => logger.error("unexpected completion"));',
      ),
    ).toEqual([]);
  });
});
