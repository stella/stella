import { describe, expect, test } from "bun:test";

import {
  buildRequestDurationRecord,
  emitChatRunLogMetric,
  emitPromptCacheMetric,
  resetMetricLineSinkForTesting,
  setMetricLineSinkForTesting,
} from "@/api/lib/observability/request-metrics";

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
    expect(record._aws.Timestamp).toBe(base.timestamp);
    expect(record["http.route"]).toBe(base.route);
    expect(record["http.status_code"]).toBe(base.statusCode);
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

test("chat shadow metrics emit append latency and per-turn write volume without identifier dimensions", () => {
  const lines: string[] = [];
  setMetricLineSinkForTesting((line) => {
    lines.push(line);
  });
  try {
    emitChatRunLogMetric({ type: "append", durationMs: 12.5 });
    emitChatRunLogMetric({ type: "turn", rows: 3, bytes: 512 });
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(JSON.parse(line)).toMatchObject({
        _aws: {
          CloudWatchMetrics: [{ Namespace: "Stella/Api", Dimensions: [[]] }],
        },
      });
    }
    expect(JSON.parse(lines.at(0) ?? "null")).toMatchObject({
      ChatRunLogAppendDuration: 12.5,
    });
    expect(JSON.parse(lines.at(1) ?? "null")).toMatchObject({
      ChatRunLogRows: 3,
      ChatRunLogBytes: 512,
    });
  } finally {
    resetMetricLineSinkForTesting();
  }
});

test("prompt-cache metrics emit a run's input, cached input and hit rate by surface and provider", () => {
  const lines: string[] = [];
  setMetricLineSinkForTesting((line) => {
    lines.push(line);
  });
  try {
    emitPromptCacheMetric({
      cachedInputTokens: 750,
      inputTokens: 1000,
      provider: "anthropic",
      surface: "chat",
    });
    // A run that reported no input has no rate to report.
    emitPromptCacheMetric({
      cachedInputTokens: 0,
      inputTokens: 0,
      provider: "openai",
      surface: "chat",
    });
    expect(lines).toHaveLength(1);
    const record: unknown = JSON.parse(lines.at(0) ?? "null");
    expect(record).toMatchObject({
      _aws: {
        CloudWatchMetrics: [
          {
            Dimensions: [["surface", "provider"]],
            Metrics: [
              { Name: "PromptInputTokens", Unit: "Count" },
              { Name: "PromptCachedInputTokens", Unit: "Count" },
              { Name: "PromptCacheHitRate", Unit: "Percent" },
            ],
            Namespace: "Stella/Api",
          },
        ],
      },
      PromptCacheHitRate: 75,
      PromptCachedInputTokens: 750,
      PromptInputTokens: 1000,
      provider: "anthropic",
      surface: "chat",
    });
  } finally {
    resetMetricLineSinkForTesting();
  }
});
