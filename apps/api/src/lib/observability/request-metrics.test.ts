import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { AI_PROVIDERS } from "@stll/ai-catalog";

import { CHAT_TURN_FAILURE_CODES } from "@/api/handlers/chat/chat-turn-state";
import type { ChatTurnOutcome } from "@/api/handlers/chat/types";
import {
  ANONYMIZATION_REFUSAL_REASONS,
  ANONYMIZATION_REFUSAL_SITES,
  buildAnonymizationRefusalRecord,
  buildChatTurnSettlementRecord,
  buildRequestDurationRecord,
  emitActionCostDropMetric,
  emitChatRunLogMetric,
  emitPromptCacheMetric,
  REQUEST_CLASSES,
  resetMetricLineSinkForTesting,
  setMetricLineSinkForTesting,
} from "@/api/lib/observability/request-metrics";
import type { RequestClass } from "@/api/lib/observability/request-metrics";

describe("buildRequestDurationRecord", () => {
  const base = {
    durationMs: 1234.7,
    requestClass: "ai" as const,
    statusCode: 200,
    route: "/v1/templates/suggest-fields",
    timestamp: 1_700_000_000_000,
  };

  const extracted = (requestClass: RequestClass) => {
    const built = buildRequestDurationRecord({ ...base, requestClass });
    if (built.type !== "extracted") {
      return panic(`Expected an extracted metric for ${requestClass}`);
    }
    return built.record;
  };

  test("emits a valid EMF directive CloudWatch can extract", () => {
    const record = extracted("ai");
    const directive = record._aws.CloudWatchMetrics[0];

    // EMF contract: every metric/dimension name referenced in the
    // directive must exist as a root member, or CloudWatch silently
    // drops the metric.
    expect(directive.Namespace).toBe("Stella/Api");
    expect(directive.Dimensions).toEqual([["class"]]);
    expect(directive.Metrics).toEqual([
      { Name: "RequestDuration", Unit: "Milliseconds" },
    ]);
    for (const dimension of directive.Dimensions.flat()) {
      expect(record).toHaveProperty(dimension);
    }
    for (const metric of directive.Metrics) {
      expect(record).toHaveProperty(metric.Name);
    }
    expect(record._aws.Timestamp).toBe(base.timestamp);
    expect(record["http.route"]).toBe(base.route);
    expect(record["http.status_code"]).toBe(base.statusCode);
  });

  test("rounds duration to an integer millisecond value", () => {
    expect(buildRequestDurationRecord(base).record.RequestDuration).toBe(1235);
  });

  test("every request class is logged; only alarmed classes extract a metric", () => {
    const dispositions = REQUEST_CLASSES.map((requestClass) => {
      const built = buildRequestDurationRecord({ ...base, requestClass });
      expect(built.record.class).toBe(requestClass);
      expect(built.record.RequestDuration).toBe(1235);
      expect("_aws" in built.record).toBe(built.type === "extracted");
      return [requestClass, built.type];
    });
    expect(Object.fromEntries(dispositions)).toEqual({
      ai: "extracted",
      crud: "extracted",
      search: "extracted",
      batch: "log_only",
    });
  });
});

test("chat run log metrics emit append latency and per-turn write volume without identifier dimensions", () => {
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
    // A call that reported no input has no rate to report.
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

test("cost drop metrics count observations rather than failed batches", () => {
  const lines: string[] = [];
  setMetricLineSinkForTesting((line) => {
    lines.push(line);
  });
  try {
    emitActionCostDropMetric(7);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines.at(0) ?? "null")).toMatchObject({
      ActionCostObservationsDropped: 7,
      _aws: {
        CloudWatchMetrics: [
          {
            Dimensions: [[]],
            Metrics: [{ Name: "ActionCostObservationsDropped", Unit: "Count" }],
          },
        ],
      },
    });
  } finally {
    resetMetricLineSinkForTesting();
  }
});

/**
 * EMF contract: every dimension and metric a directive names must be a root
 * member of the record, or CloudWatch silently drops the metric.
 */
const expectExtractable = (record: {
  _aws: {
    CloudWatchMetrics: {
      Dimensions: string[][];
      Metrics: { Name: string }[];
      Namespace: string;
    }[];
  };
}) => {
  for (const directive of record._aws.CloudWatchMetrics) {
    expect(directive.Namespace).toBe("Stella/Api");
    for (const dimension of directive.Dimensions.flat()) {
      expect(record).toHaveProperty(dimension);
    }
    for (const metric of directive.Metrics) {
      expect(record).toHaveProperty(metric.Name);
    }
  }
};

/** Every outcome a turn settles with; a new one fails typecheck here. */
const SETTLED_OUTCOMES = {
  "awaiting-user": "awaiting-user",
  cancelled: "cancelled",
  completed: "completed",
  failed: "failed",
  interrupted: "interrupted",
} as const satisfies { [TOutcome in ChatTurnOutcome["type"]]: TOutcome };

describe("buildChatTurnSettlementRecord", () => {
  test("every outcome, mode and provider builds one extractable count", () => {
    for (const outcome of Object.values(SETTLED_OUTCOMES)) {
      for (const mode of ["anonymized", "raw"] as const) {
        for (const provider of [...AI_PROVIDERS, "none" as const]) {
          const record = buildChatTurnSettlementRecord({
            failureCode: outcome === "failed" ? "internal" : null,
            mode,
            outcome,
            provider,
            timestamp: 1_700_000_000_000,
          });
          expectExtractable(record);
          expect(record).toMatchObject({
            ChatTurnSettlements: 1,
            mode,
            outcome,
            provider,
          });
        }
      }
    }
  });

  test("divides by outcome and mode, and by provider beneath them, never by an id", () => {
    const record = buildChatTurnSettlementRecord({
      failureCode: "boundary-refusal",
      mode: "anonymized",
      outcome: "failed",
      provider: "anthropic",
      timestamp: 1_700_000_000_000,
    });
    expect(record._aws.CloudWatchMetrics).toEqual([
      {
        Namespace: "Stella/Api",
        Dimensions: [
          ["outcome", "mode"],
          ["outcome", "mode", "provider"],
        ],
        Metrics: [{ Name: "ChatTurnSettlements", Unit: "Count" }],
      },
    ]);
    // The failure code is a property to query, not a dimension.
    expect(record.failure_code).toBe("boundary-refusal");
  });

  test("a settlement without a failure code reads as none", () => {
    for (const code of [...CHAT_TURN_FAILURE_CODES, null]) {
      expect(
        buildChatTurnSettlementRecord({
          failureCode: code,
          mode: "raw",
          outcome: "failed",
          provider: "openai",
          timestamp: 0,
        }).failure_code,
      ).toBe(code ?? "none");
    }
  });
});

describe("buildAnonymizationRefusalRecord", () => {
  test("every site and reason builds a count by site and reason, plus a total", () => {
    for (const site of ANONYMIZATION_REFUSAL_SITES) {
      for (const reason of ANONYMIZATION_REFUSAL_REASONS) {
        const record = buildAnonymizationRefusalRecord({
          reason,
          site,
          timestamp: 1_700_000_000_000,
        });
        expectExtractable(record);
        expect(record._aws.CloudWatchMetrics.at(0)?.Dimensions).toEqual([
          ["site", "reason"],
          [],
        ]);
        expect(record).toMatchObject({
          AnonymizationRefusals: 1,
          reason,
          site,
        });
      }
    }
  });
});
