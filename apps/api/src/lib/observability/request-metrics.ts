import { panic } from "better-result";

import type { AIProvider } from "@stll/ai-catalog";
import { Temporal } from "@stll/time";

import type { ChatTurnFailureCode } from "@/api/handlers/chat/chat-turn-state";
import type { ChatTurnOutcome } from "@/api/handlers/chat/types";
import { isLocalDevOpen } from "@/api/runtime-mode";

/**
 * Per-request latency, split by request class, emitted as a CloudWatch
 * Embedded Metric Format (EMF) line on stdout.
 *
 * Why EMF on stdout rather than the structured `logger`: the OTel logs
 * pipeline has no exporter wired (see `otel.ts`), so `logger.info`
 * records never leave the process. EMF instead rides the container's
 * stdout into the awslogs driver, where CloudWatch auto-extracts the
 * embedded metric — no agent, no metric filter, no log exporter needed.
 *
 * The `class` dimension is the whole point: it lets the p95 latency
 * alarm watch `class=crud` in isolation, so an inherently multi-second
 * synchronous AI endpoint (template field suggestions, chat, summaries)
 * cannot trip an SLO meant for CRUD. A separate, looser alarm watches
 * `class=ai`. Keeping `class` the only dimension caps this at two
 * extracted metrics regardless of route cardinality; `http.route` and
 * `http.status_code` ride along as queryable properties, not dimensions.
 */

const METRIC_NAMESPACE = "Stella/Api";
const METRIC_NAME = "RequestDuration";
const FAILURE_METRIC_NAME = "RequestTransientFailures";

// Test seam, like the logger's: when set, every EMF line goes here instead of
// stdout, whatever the environment, so a test reads the line CloudWatch would
// have parsed.
let metricLineSink: ((line: string) => void) | null = null;

export const setMetricLineSinkForTesting = (
  sink: (line: string) => void,
): void => {
  metricLineSink = sink;
};

export const resetMetricLineSinkForTesting = (): void => {
  metricLineSink = null;
};

const writeMetricLine = (record: object): void => {
  const line = JSON.stringify(record);
  if (metricLineSink !== null) {
    metricLineSink(line);
    return;
  }
  // Local development would only add noise to the dev server's stdout.
  // Read from the runtime mode alone: capture reaches this module, and a
  // worker that captures must not validate the whole API environment.
  if (isLocalDevOpen()) {
    return;
  }
  process.stdout.write(`${line}\n`);
};

export type RequestClass = "ai" | "crud";

type EmitRequestDurationMetricInput = {
  durationMs: number;
  requestClass: RequestClass;
  statusCode: number;
  route: string;
};

/**
 * Build the EMF record. Pure (caller supplies the timestamp) so the
 * structure that CloudWatch silently depends on — and silently drops
 * when malformed — is testable without env or stdout.
 */
export const buildRequestDurationRecord = ({
  durationMs,
  requestClass,
  statusCode,
  route,
  timestamp,
}: EmitRequestDurationMetricInput & { timestamp: number }) => ({
  _aws: {
    Timestamp: timestamp,
    CloudWatchMetrics: [
      {
        Namespace: METRIC_NAMESPACE,
        Dimensions: [["class"]],
        Metrics: [{ Name: METRIC_NAME, Unit: "Milliseconds" }],
      },
    ],
  },
  class: requestClass,
  [METRIC_NAME]: Math.round(durationMs),
  "http.route": route,
  "http.status_code": statusCode,
});

export const emitRequestDurationMetric = (
  input: EmitRequestDurationMetricInput,
): void => {
  writeMetricLine(
    buildRequestDurationRecord({
      ...input,
      timestamp: Temporal.Now.instant().epochMilliseconds,
    }),
  );
};

type FailureMetricInput = {
  /** A sink handle's label: a closed set, never a frame or an id. */
  sink: string;
  reason: string;
};

/**
 * One transient failure a request observed, as an EMF count dimensioned by
 * sink and reason, plus an undimensioned total an alarm can watch for a
 * sustained rate. Emitted per observation, before any log or capture
 * suppression, so the count is the failure rate rather than the admitted
 * rate. Cardinality is bounded by the closed handle and reason sets; a frame,
 * request id or tenant id never becomes a dimension.
 */
const buildFailureMetricRecord = ({
  sink,
  reason,
  timestamp,
}: FailureMetricInput & { timestamp: number }) => ({
  _aws: {
    Timestamp: timestamp,
    CloudWatchMetrics: [
      {
        Namespace: METRIC_NAMESPACE,
        Dimensions: [["sink", "reason"], []],
        Metrics: [{ Name: FAILURE_METRIC_NAME, Unit: "Count" }],
      },
    ],
  },
  sink,
  reason,
  [FAILURE_METRIC_NAME]: 1,
});

export const emitFailureMetric = (input: FailureMetricInput): void => {
  writeMetricLine(
    buildFailureMetricRecord({
      ...input,
      timestamp: Temporal.Now.instant().epochMilliseconds,
    }),
  );
};

const CHAT_RUN_LOG_METRIC = {
  appendDuration: "ChatRunLogAppendDuration",
  rows: "ChatRunLogRows",
  bytes: "ChatRunLogBytes",
} as const;

type ChatRunLogMetric =
  | { type: "append"; durationMs: number }
  | { type: "turn"; rows: number; bytes: number };

export const emitChatRunLogMetric = (metric: ChatRunLogMetric): void => {
  const payload = (() => {
    switch (metric.type) {
      case "append":
        return {
          values: { [CHAT_RUN_LOG_METRIC.appendDuration]: metric.durationMs },
          metrics: [
            { Name: CHAT_RUN_LOG_METRIC.appendDuration, Unit: "Milliseconds" },
          ],
        };
      case "turn":
        return {
          values: {
            [CHAT_RUN_LOG_METRIC.rows]: metric.rows,
            [CHAT_RUN_LOG_METRIC.bytes]: metric.bytes,
          },
          metrics: [
            { Name: CHAT_RUN_LOG_METRIC.rows, Unit: "Count" },
            { Name: CHAT_RUN_LOG_METRIC.bytes, Unit: "Bytes" },
          ],
        };
      default:
        metric satisfies never;
        return panic("Unhandled chat run log metric");
    }
  })();
  writeMetricLine({
    _aws: {
      Timestamp: Temporal.Now.instant().epochMilliseconds,
      CloudWatchMetrics: [
        {
          Namespace: METRIC_NAMESPACE,
          Dimensions: [[]],
          Metrics: payload.metrics,
        },
      ],
    },
    ...payload.values,
  });
};

export const emitActionCostDropMetric = (dropped: number): void => {
  writeMetricLine({
    _aws: {
      Timestamp: Temporal.Now.instant().epochMilliseconds,
      CloudWatchMetrics: [
        {
          Namespace: METRIC_NAMESPACE,
          Dimensions: [[]],
          Metrics: [{ Name: "ActionCostObservationsDropped", Unit: "Count" }],
        },
      ],
    },
    ActionCostObservationsDropped: dropped,
  });
};

const CHAT_TURN_SETTLEMENT_METRIC_NAME = "ChatTurnSettlements";

type ChatTurnSettlementMetricInput = {
  /** The status the turn settled with. */
  outcome: ChatTurnOutcome["type"];
  /** The third-party boundary the turn's provider input crossed. */
  mode: "anonymized" | "raw";
  /** The turn's provider; `none` when it ended before a model was resolved. */
  provider: AIProvider | "none";
  failureCode: ChatTurnFailureCode | null;
};

/**
 * One settled chat turn, counted by outcome and boundary mode, and again by
 * provider, so an alarm can divide failed by settled turns per mode (and per
 * provider) instead of watching a raw failure count that moves with traffic.
 * Every dimension is a closed set; the failure code rides along as a
 * queryable property, never a thread, turn or tenant id.
 */
export const buildChatTurnSettlementRecord = ({
  failureCode,
  mode,
  outcome,
  provider,
  timestamp,
}: ChatTurnSettlementMetricInput & { timestamp: number }) => ({
  _aws: {
    Timestamp: timestamp,
    CloudWatchMetrics: [
      {
        Namespace: METRIC_NAMESPACE,
        Dimensions: [
          ["outcome", "mode"],
          ["outcome", "mode", "provider"],
        ],
        Metrics: [{ Name: CHAT_TURN_SETTLEMENT_METRIC_NAME, Unit: "Count" }],
      },
    ],
  },
  outcome,
  mode,
  provider,
  failure_code: failureCode ?? "none",
  [CHAT_TURN_SETTLEMENT_METRIC_NAME]: 1,
});

export const emitChatTurnSettlementMetric = (
  input: ChatTurnSettlementMetricInput,
): void => {
  writeMetricLine(
    buildChatTurnSettlementRecord({
      ...input,
      timestamp: Temporal.Now.instant().epochMilliseconds,
    }),
  );
};

/**
 * Where provider-bound content was refused for anonymization. Each refusal is
 * built at exactly one of these, so every role that crosses the boundary
 * (chat, subagents, compaction, template tools) is counted where it refuses.
 */
export const ANONYMIZATION_REFUSAL_SITES = [
  // Any text batch the anonymizer prepares: prompts, history, tool output,
  // connector metadata.
  "text_batch",
  "attachment",
  "stored_part",
  "rich_media",
  "external_tool",
  "agent_run",
  "file_hydration",
  "mcp_egress",
] as const;
export type AnonymizationRefusalSite =
  (typeof ANONYMIZATION_REFUSAL_SITES)[number];

export const ANONYMIZATION_REFUSAL_REASONS = [
  // The anonymizer itself failed.
  "pipeline_error",
  // Anonymizing would change a value that must cross unchanged (a name, an
  // id, a URL), or the field structure it was given did not survive it.
  "field_boundary",
  // Content the anonymizer cannot read or prepare.
  "unsupported_content",
  // The mode does not allow the capability at all.
  "mode_policy",
] as const;
export type AnonymizationRefusalReason =
  (typeof ANONYMIZATION_REFUSAL_REASONS)[number];

const ANONYMIZATION_REFUSAL_METRIC_NAME = "AnonymizationRefusals";

type AnonymizationRefusalMetricInput = {
  reason: AnonymizationRefusalReason;
  site: AnonymizationRefusalSite;
};

/**
 * One refusal to send content across the anonymized boundary, dimensioned by
 * site and reason, plus an undimensioned total an alarm can watch.
 */
export const buildAnonymizationRefusalRecord = ({
  reason,
  site,
  timestamp,
}: AnonymizationRefusalMetricInput & { timestamp: number }) => ({
  _aws: {
    Timestamp: timestamp,
    CloudWatchMetrics: [
      {
        Namespace: METRIC_NAMESPACE,
        Dimensions: [["site", "reason"], []],
        Metrics: [{ Name: ANONYMIZATION_REFUSAL_METRIC_NAME, Unit: "Count" }],
      },
    ],
  },
  site,
  reason,
  [ANONYMIZATION_REFUSAL_METRIC_NAME]: 1,
});

export const emitAnonymizationRefusalMetric = (
  input: AnonymizationRefusalMetricInput,
): void => {
  writeMetricLine(
    buildAnonymizationRefusalRecord({
      ...input,
      timestamp: Temporal.Now.instant().epochMilliseconds,
    }),
  );
};
