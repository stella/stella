import { describe, expect, test } from "bun:test";

import { toAuditLogDateRange } from "./audit-log-date-range";

describe("toAuditLogDateRange", () => {
  test("uses local midnight for the first selected day", () => {
    expect(toAuditLogDateRange({ from: "2026-07-16", to: null })).toEqual({
      from: new Date(2026, 6, 16).toISOString(),
    });
  });

  test("uses the next local midnight as an exclusive upper bound", () => {
    expect(toAuditLogDateRange({ from: null, to: "2026-07-16" })).toEqual({
      toExclusive: new Date(2026, 6, 17).toISOString(),
    });
  });

  test("omits absent or invalid dates", () => {
    expect(toAuditLogDateRange({ from: null, to: "invalid" })).toEqual({});
  });
});
