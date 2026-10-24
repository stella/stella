import { describe, expect, test } from "bun:test";

import { readScalingViolations } from "./measurement";

describe("fixed-page read scaling", () => {
  const small = {
    statements: 5,
    transactionRoundTrips: 2,
    responseBytes: 1000,
    rows: 10,
  };

  test("budgets statements, transaction round trips, and bytes independently", () => {
    expect(readScalingViolations({ small, large: small })).toEqual([]);
    for (const [metric, value] of [
      ["statements", 6],
      ["transactionRoundTrips", 4],
      ["responseBytes", 1201],
    ] as const) {
      expect(
        readScalingViolations({ small, large: { ...small, [metric]: value } }),
      ).toHaveLength(1);
    }
    expect(
      readScalingViolations({
        small,
        large: { ...small, responseBytes: 1200 },
      }),
    ).toEqual([]);
  });

  test("normalizes response bytes by returned rows and rejects empty fixture reads", () => {
    const measurementWithRows = { ...small, entities: ["row"] };
    expect(
      readScalingViolations({
        small: measurementWithRows,
        large: measurementWithRows,
      }),
    ).toEqual([]);
    expect(
      readScalingViolations({
        small,
        large: { ...small, rows: 5, responseBytes: 600 },
      }),
    ).toEqual([]);
    expect(() =>
      readScalingViolations({ small, large: { ...small, rows: 0 } }),
    ).toThrow("nonempty pages");
  });
});
