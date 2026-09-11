import { describe, expect, test } from "bun:test";

import { resolveStatuteDisplayStatus } from "@/features/statutes/statute-status";

describe("statute display status", () => {
  test("a consolidation that has not started is future, not superseded", () => {
    expect(
      resolveStatuteDisplayStatus({
        status: "historical",
        today: "2026-09-10",
        validFrom: "2027-01-01",
      }),
    ).toBe("future");
  });

  test("lifecycle statuses remain unchanged once their window has started", () => {
    expect(
      resolveStatuteDisplayStatus({
        status: "current",
        today: "2026-09-10",
        validFrom: "2026-01-01",
      }),
    ).toBe("current");
    expect(
      resolveStatuteDisplayStatus({
        status: "historical",
        today: "2026-09-10",
        validFrom: "2024-01-01",
      }),
    ).toBe("historical");
  });
});
