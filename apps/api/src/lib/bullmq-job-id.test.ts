import { describe, expect, test } from "bun:test";

import { createBullMqJobId } from "@/api/lib/bullmq-job-id";

describe("createBullMqJobId", () => {
  test("encodes parts so BullMQ job IDs do not contain colon separators", () => {
    const jobId = createBullMqJobId("scheduler", "job:1", "run:1");

    expect(jobId).toBe("scheduler-job%3A1-run%3A1");
    expect(jobId).not.toContain(":");
  });

  test("encodes separator characters in parts", () => {
    expect(createBullMqJobId("a-b", "c")).not.toBe(
      createBullMqJobId("a", "b-c"),
    );
  });
});
