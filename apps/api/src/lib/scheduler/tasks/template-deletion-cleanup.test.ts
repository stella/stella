import { describe, expect, test } from "bun:test";

import { getTemplateDeletionCleanupRetryAt } from "@/api/lib/scheduler/tasks/template-deletion-cleanup";

describe("template deletion cleanup retry schedule", () => {
  test("backs off exponentially and caps retries at one day", () => {
    const now = new Date("2026-08-12T00:00:00.000Z");

    expect(
      getTemplateDeletionCleanupRetryAt({ attemptCount: 1, now }).getTime() -
        now.getTime(),
    ).toBe(60_000);
    expect(
      getTemplateDeletionCleanupRetryAt({ attemptCount: 4, now }).getTime() -
        now.getTime(),
    ).toBe(8 * 60_000);
    expect(
      getTemplateDeletionCleanupRetryAt({ attemptCount: 100, now }).getTime() -
        now.getTime(),
    ).toBe(24 * 60 * 60_000);
  });
});
