import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import type { ApiRoutePath } from "@/api/http/api-route-types";

import "@/api/tests/setup-env";

import { AI_PROVIDERS } from "@stll/ai-catalog";
import { compareCodeUnit } from "@stll/collation";

import { CHAT_TURN_FAILURE_CODES } from "@/api/handlers/chat/chat-turn-state";
import type { ChatTurnOutcome } from "@/api/handlers/chat/types";
import { RAW_SOURCE_FAMILY } from "@/api/lib/legal-search/raw-source-family";
import { VERIFICATION_RUN_ERROR_CODES } from "@/api/lib/lists/verification/contract";
import { SENSITIVE_LOG_ATTRIBUTE_KEY_PATTERN } from "@/api/lib/observability/log-attribute-policy";
import {
  ANONYMIZATION_REFUSAL_REASONS,
  ANONYMIZATION_REFUSAL_SITES,
  buildAnonymizationRefusalRecord,
  buildChatTurnSettlementRecord,
  buildMcpRequestMetricRecord,
  buildRequestDurationRecord,
  buildRequestStageRecord,
  emitActionCostDropMetric,
  emitChatRunLogMetric,
  emitPromptCacheMetric,
  emitRawSourceStoredMetric,
  emitReasoningReplayDroppedMetric,
  emitVerificationRunFailureMetric,
  REQUEST_CLASSES,
  resetMetricLineSinkForTesting,
  setMetricLineSinkForTesting,
} from "@/api/lib/observability/request-metrics";
import type { RequestClass } from "@/api/lib/observability/request-metrics";
import {
  measureMcpPhase,
  normalizeMcpMetricMethod,
  observeMcpRequest,
} from "@/api/mcp/request-metrics";

test("new raw object metrics count stored bytes and objects by source without document identifiers", () => {
  const lines: string[] = [];
  setMetricLineSinkForTesting((line) => {
    lines.push(line);
  });
  try {
    for (const family of Object.values(RAW_SOURCE_FAMILY)) {
      for (const kind of ["document", "payload"] as const) {
        emitRawSourceStoredMetric({
          family,
          sourceId: "fixture-source",
          kind,
          bytes: 12_345,
        });
      }
    }
    expect(lines).toHaveLength(Object.values(RAW_SOURCE_FAMILY).length * 2);
    expect(lines.map((line) => JSON.parse(line))).toEqual(
      Object.values(RAW_SOURCE_FAMILY).flatMap((family) =>
        ["document", "payload"].map((kind) => ({
          family,
          source: "fixture-source",
          kind,
          RawSourceStoredBytes: 12_345,
          RawSourceStoredObjects: 1,
        })),
      ),
    );
  } finally {
    resetMetricLineSinkForTesting();
  }
});

test("request stages are integral log fields without metric dimensions", () => {
  expect(
    buildRequestStageRecord({
      route: "/v1/law/statutes/search" satisfies ApiRoutePath,
      tool: "search_legislation",
      stage: "candidate_hydration",
      durationMs: 12.6,
      rounds: 2,
      candidateCount: 18,
      resultCount: 10,
      outcome: "completed",
    }),
  ).toEqual({
    event: "request.stage",
    class: "legislation_search",
    "http.route": "/v1/law/statutes/search",
    tool: "search_legislation",
    stage: "candidate_hydration",
    durationMs: 13,
    rounds: 2,
    candidateCount: 18,
    resultCount: 10,
    outcome: "completed",
  });
});

test("stage log fields pass the content-key policy", () => {
  for (const key of [
    "http.route",
    "tool",
    "stage",
    "durationMs",
    "rounds",
    "candidateCount",
    "resultCount",
    "outcome",
  ]) {
    expect(SENSITIVE_LOG_ATTRIBUTE_KEY_PATTERN.test(key), key).toBe(false);
  }
  for (const key of ["content", "decisionContent", "statuteTitle"]) {
    expect(SENSITIVE_LOG_ATTRIBUTE_KEY_PATTERN.test(key), key).toBe(true);
  }
});

test("a tools/call phase record says whether the call ran over its budget", () => {
  const record = (totalMs: number) =>
    buildMcpRequestMetricRecord({
      method: "tools/call",
      mode: "default",
      overlap: false,
      path: "modern",
      toolName: "search_legislation",
      phases: {
        auth: 0,
        context: 0,
        server_build: 0,
        tool_projection: 0,
        dispatch: totalMs,
      },
      queryCount: 0,
      totalMs,
      latencyBudgetMs: 8000,
    });
  expect(record(10_499.2)).toMatchObject({
    total: 10_500,
    budget: 8000,
    overBudget: true,
  });
  expect(record(7999.5)).toMatchObject({
    total: 8000,
    budget: 8000,
    overBudget: false,
  });
});

test("MCP phase records are integral, non-overlapping, and bounded", () => {
  const freeText = "private caller supplied text";
  const record = buildMcpRequestMetricRecord({
    method: normalizeMcpMetricMethod(freeText),
    mode: "default",
    overlap: false,
    path: "modern",
    phases: {
      auth: 1.9,
      context: 2.9,
      server_build: 3.9,
      tool_projection: 4.9,
      dispatch: 5.9,
    },
    queryCount: 7,
    totalMs: 30.1,
  });
  expect(record).toEqual({
    event: "mcp.request.phases",
    method: "unknown",
    mode: "default",
    overlap: false,
    path: "modern",
    queryCount: 7,
    auth: 1,
    context: 2,
    server_build: 3,
    tool_projection: 4,
    dispatch: 5,
    total: 31,
  });
  const phaseTotal =
    record.auth +
    record.context +
    record.server_build +
    record.tool_projection +
    record.dispatch;
  expect(phaseTotal).toBeLessThanOrEqual(record.total);
  expect(JSON.stringify(record)).not.toContain(freeText);
  expect(normalizeMcpMetricMethod("tools/call")).toBe("tools/call");
});

test("MCP phase overlap never changes the result and is flagged", async () => {
  const lines: string[] = [];
  setMetricLineSinkForTesting((line) => {
    lines.push(line);
  });
  const result = await observeMcpRequest({
    method: "tools/list",
    mode: "default",
    run: async () =>
      await measureMcpPhase(
        "auth",
        async () => await measureMcpPhase("context", async () => "served"),
      ),
  });
  expect(result).toBe("served");
  expect(JSON.parse(lines.at(0) ?? "{}")).toMatchObject({
    event: "mcp.request.phases",
    overlap: true,
    context: 0,
  });
  resetMetricLineSinkForTesting();
});

test("reasoning replay drops emit only bounded provider and reason dimensions", () => {
  const lines: string[] = [];
  setMetricLineSinkForTesting((line) => {
    lines.push(line);
  });
  try {
    emitReasoningReplayDroppedMetric({
      fromProvider: "anthropic",
      toProvider: "openai",
      reason: "incompatible-provenance",
      count: 3,
    });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines.at(0) ?? "{}")).toEqual({
      fromProvider: "anthropic",
      toProvider: "openai",
      reason: "incompatible-provenance",
      "chat.reasoning_replay_dropped": 3,
    });
  } finally {
    resetMetricLineSinkForTesting();
  }
});

test("verification failures emit bounded class metrics and structured events", () => {
  const lines: string[] = [];
  setMetricLineSinkForTesting((line) => {
    lines.push(line);
  });
  try {
    for (const errorCode of VERIFICATION_RUN_ERROR_CODES) {
      emitVerificationRunFailureMetric(errorCode);
    }
    const records = lines.map((line) =>
      v.parse(
        v.looseObject({ errorCode: v.picklist(VERIFICATION_RUN_ERROR_CODES) }),
        JSON.parse(line),
      ),
    );
    expect(records).toHaveLength(4);
    expect(
      records.map((record) => record.errorCode).toSorted(compareCodeUnit),
    ).toEqual([
      "access_revoked",
      "extraction_failed",
      "grading_failed",
      "no_text",
    ]);
    for (const record of records) {
      expect(record).toEqual({
        event: `list_verification_run.${record.errorCode}`,
        errorCode: record.errorCode,
        VerificationRunFailures: 1,
      });
    }
  } finally {
    resetMetricLineSinkForTesting();
  }
});

describe("buildRequestDurationRecord", () => {
  const base = {
    durationMs: 1234.7,
    requestClass: "ai" as const,
    statusCode: 200,
    route: "/v1/templates/suggest-fields" satisfies ApiRoutePath,
  };

  const recordFor = (requestClass: RequestClass) =>
    buildRequestDurationRecord({ ...base, requestClass });

  test("keeps request fields and the numeric duration in the record", () => {
    const record = recordFor("ai");
    expect(record.RequestDuration).toBe(1235);
    expect("_aws" in record).toBe(false);
    expect(record["http.route"]).toBe(base.route);
    expect(record["http.status_code"]).toBe(base.statusCode);
  });

  test("rounds duration to an integer millisecond value", () => {
    expect(buildRequestDurationRecord(base).RequestDuration).toBe(1235);
  });

  test("every request class has the same metric record shape", () => {
    for (const requestClass of REQUEST_CLASSES) {
      const record = buildRequestDurationRecord({ ...base, requestClass });
      expect(record).toMatchObject({
        class: requestClass,
        RequestDuration: 1235,
        "http.route": base.route,
        "http.status_code": base.statusCode,
      });
      expect("_aws" in record).toBe(false);
    }
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
    });
  } finally {
    resetMetricLineSinkForTesting();
  }
});

/** Every outcome a turn settles with; a new one fails typecheck here. */
const SETTLED_OUTCOMES = {
  "awaiting-user": "awaiting-user",
  cancelled: "cancelled",
  completed: "completed",
  failed: "failed",
  interrupted: "interrupted",
} as const satisfies { [TOutcome in ChatTurnOutcome["type"]]: TOutcome };

describe("buildChatTurnSettlementRecord", () => {
  test("every outcome, mode and provider builds a count record", () => {
    for (const outcome of Object.values(SETTLED_OUTCOMES)) {
      for (const mode of ["anonymized", "raw"] as const) {
        for (const provider of [...AI_PROVIDERS, "none" as const]) {
          const record = buildChatTurnSettlementRecord({
            failureCode: outcome === "failed" ? "internal" : null,
            mode,
            outcome,
            provider,
          });
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
    });
    expect("_aws" in record).toBe(false);
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
        });
        expect("_aws" in record).toBe(false);
        expect(record).toMatchObject({
          AnonymizationRefusals: 1,
          reason,
          site,
        });
      }
    }
  });
});
