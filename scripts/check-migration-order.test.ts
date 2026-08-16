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

  // The motivating race: the branch is generated against an older tip, and a
  // higher-timestamped migration lands on the base branch before it merges.
  // Already-migrated databases record the higher timestamp and never apply the
  // lower one, so the DDL silently never runs.
  test("rejects a migration that the base branch overtook after it was generated", () => {
    expect(
      findMigrationOrderViolation({
        baseDirectories: [
          "20260816140000_branch_point",
          "20260816200000_landed_meanwhile",
        ],
        newDirectories: ["apps/api/drizzle/20260816150000_generated_earlier"],
      }),
    ).toMatchObject({
      type: "not-after-base",
      timestamp: "20260816150000",
      previousTimestamp: "20260816200000",
    });
  });

  test("a pull request that adds no migrations has nothing to violate", () => {
    expect(
      findMigrationOrderViolation({
        baseDirectories: ["20260816200000_landed_meanwhile"],
        newDirectories: [],
      }),
    ).toBeNull();
  });

  test("the first migration in an empty tree is accepted", () => {
    expect(
      findMigrationOrderViolation({
        baseDirectories: [],
        newDirectories: ["apps/api/drizzle/20260801120000_initial"],
      }),
    ).toBeNull();
  });

  test("base directories without timestamps do not raise the floor", () => {
    expect(
      findMigrationOrderViolation({
        baseDirectories: ["meta", "20260801120000_existing"],
        newDirectories: ["apps/api/drizzle/20260801130000_next"],
      }),
    ).toBeNull();
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
