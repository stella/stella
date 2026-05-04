import { describe, expect, test } from "bun:test";

import { bucketPageLoadDuration } from "@/lib/analytics/route-telemetry";

describe("route telemetry", () => {
  test("buckets page load durations before capture", () => {
    expect(bucketPageLoadDuration(249)).toBe("0_250");
    expect(bucketPageLoadDuration(250)).toBe("250_500");
    expect(bucketPageLoadDuration(999)).toBe("500_1000");
    expect(bucketPageLoadDuration(1999)).toBe("1000_2000");
    expect(bucketPageLoadDuration(4999)).toBe("2000_5000");
    expect(bucketPageLoadDuration(5000)).toBe("5000_plus");
  });
});
