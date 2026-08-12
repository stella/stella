import { describe, expect, test } from "bun:test";

import { buildRequestDurationRecord } from "@/api/lib/observability/request-metrics";

describe("buildRequestDurationRecord", () => {
  const base = {
    durationMs: 1234.7,
    requestClass: "ai" as const,
    statusCode: 200,
    route: "/v1/templates/suggest-fields",
    timestamp: 1_700_000_000_000,
  };

  test("emits a valid EMF directive CloudWatch can extract", () => {
    const record = buildRequestDurationRecord(base);
    const directive = record._aws.CloudWatchMetrics[0];

    // EMF contract: every metric/dimension name referenced in the
    // directive must exist as a root member, or CloudWatch silently
    // drops the metric.
    expect(directive?.Namespace).toBe("Stella/Api");
    expect(directive?.Dimensions).toEqual([["class"]]);
    expect(directive?.Metrics).toEqual([
      { Name: "RequestDuration", Unit: "Milliseconds" },
    ]);
    for (const dimension of directive?.Dimensions.flat() ?? []) {
      expect(record).toHaveProperty(dimension);
    }
    for (const metric of directive?.Metrics ?? []) {
      expect(record).toHaveProperty(metric.Name);
    }
  });

  test("rounds duration to an integer millisecond value", () => {
    expect(buildRequestDurationRecord(base).RequestDuration).toBe(1235);
  });

  test("class dimension distinguishes ai from crud", () => {
    expect(buildRequestDurationRecord(base).class).toBe("ai");
    expect(
      buildRequestDurationRecord({ ...base, requestClass: "crud" }).class,
    ).toBe("crud");
  });
});
