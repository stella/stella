import { describe, expect, test } from "bun:test";

import { memorySchedulerAuditColumns } from "@/api/lib/memory/memory-scheduler-audit";

describe("memorySchedulerAuditColumns", () => {
  test("identifies scheduler writes as service-triggered system activity", () => {
    expect(
      memorySchedulerAuditColumns({
        id: "memory-extractor",
        name: "Memory extractor",
        source: "memory.extractor",
      }),
    ).toEqual({
      activityCategory: "other",
      approvalStatus: "not_required",
      performerId: "memory-extractor",
      performerName: "Memory extractor",
      performerType: "service",
      triggerSource: "memory.extractor",
      triggerType: "system",
    });
  });
});
