import { describe, expect, test } from "bun:test";

import { findMigrationOrderViolation } from "./check-migration-order";

describe("migration ordering", () => {
  test("accepts strictly newer migration timestamps", () => {
    expect(
      findMigrationOrderViolation({
        baseDirectories: ["20260801120000_existing", "20260801130000_latest"],
        newDirectories: [
          "apps/api/drizzle/20260801140000_first",
          "apps/api/drizzle/20260801150000_second",
        ],
      }),
    ).toBeNull();
  });

  test("rejects a migration older than the latest base migration", () => {
    expect(
      findMigrationOrderViolation({
        baseDirectories: ["20260801130000_latest"],
        newDirectories: ["apps/api/drizzle/20260801110000_late_arrival"],
      }),
    ).toEqual({
      type: "not-after-base",
      directory: "apps/api/drizzle/20260801110000_late_arrival",
      timestamp: "20260801110000",
      previousTimestamp: "20260801130000",
    });
  });

  test("rejects duplicate timestamps among new migrations", () => {
    expect(
      findMigrationOrderViolation({
        baseDirectories: ["20260801130000_latest"],
        newDirectories: [
          "apps/api/drizzle/20260801140000_first",
          "apps/api/drizzle/20260801140000_second",
        ],
      }),
    ).toMatchObject({
      type: "not-after-base",
      timestamp: "20260801140000",
      previousTimestamp: "20260801140000",
    });
  });

  test("rejects migration directories without canonical timestamps", () => {
    expect(
      findMigrationOrderViolation({
        baseDirectories: [],
        newDirectories: ["apps/api/drizzle/report_export_result_field"],
      }),
    ).toEqual({
      type: "invalid-name",
      directory: "apps/api/drizzle/report_export_result_field",
    });
  });
});
