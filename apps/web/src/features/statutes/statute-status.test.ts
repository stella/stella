import { describe, expect, test } from "bun:test";

import {
  resolveStatuteDisplayStatus,
  STATUTE_STATUS_LABEL_KEYS,
} from "@/features/statutes/statute-status";

describe("statute display status", () => {
  test("an unstated lifecycle remains visible as unclear when dates are absent", () => {
    const status = resolveStatuteDisplayStatus({
      status: "unknown",
      today: "2026-10-16",
      validFrom: null,
    });

    expect(status).toBe("unknown");
    expect(status === null ? null : STATUTE_STATUS_LABEL_KEYS[status]).toBe(
      "statutes.status.unknown",
    );
  });

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
