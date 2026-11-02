import { panic } from "better-result";

import type { AIProvider, TanStackAIProvider } from "@stll/ai-catalog";
import type { TranscriptionModelId } from "@stll/ai-catalog/transcription";
import type { SanctionsSource } from "@stll/sanctions";

import type { RAW_SOURCE_FAMILY } from "@/api/lib/legal-search/raw-source-family";
import type { VerificationRunErrorCode } from "@/api/lib/lists/verification/contract";
import type { RootPoolReport } from "@/api/lib/observability/root-pool-window";
import type { BudgetName } from "@/api/lib/rate-limit/budget-observability";
import { APP_VERSION, SERVICE_VERSION_KEY } from "@/api/lib/version";
import type { PublicCorpusClass } from "@/api/public-corpus-policy";
import { isLocalDevOpen } from "@/api/runtime-mode";

const METRIC_NAME = "RequestDuration";
const FAILURE_METRIC_NAME = "RequestTransientFailures";

type RawSourceStoredMetricInput = {
  family: (typeof RAW_SOURCE_FAMILY)[keyof typeof RAW_SOURCE_FAMILY];
  sourceId: string;
  kind: "document" | "payload";
  bytes: number;
};

/** Successful raw write volume; conditional duplicates contribute no sample. */
export const emitRawSourceStoredMetric = ({
  family,
  sourceId,
  kind,
  bytes,
}: RawSourceStoredMetricInput): void => {
  writeMetricLine({
    family,
    source: sourceId,
    kind,
    RawSourceStoredBytes: bytes,
    RawSourceStoredObjects: 1,
  });
};

const REQUEST_STAGE_FAMILIES = {
  legislation_search: [
    "index_scan",
    "candidate_hydration",
    "work_collapse_ranking",
    "response_serialization",
  ],
  chat_turn: ["request_setup", "provider_first_token", "stream_finish"],
} as const;

export type RequestStage =
  (typeof REQUEST_STAGE_FAMILIES)[keyof typeof REQUEST_STAGE_FAMILIES][number];

const REQUEST_STAGE_FAMILY = {
  index_scan: "legislation_search",
  candidate_hydration: "legislation_search",
  work_collapse_ranking: "legislation_search",
  response_serialization: "legislation_search",
  request_setup: "chat_turn",
  provider_first_token: "chat_turn",
  stream_finish: "chat_turn",
} as const satisfies Record<RequestStage, keyof typeof REQUEST_STAGE_FAMILIES>;

export type RequestStageOutcome =
  "completed" | "failed" | "refused" | "cancelled";

type RequestStageRecordInput = {
  route: string;
  tool?: string;
  stage: RequestStage;
  durationMs: number;
  rounds?: number;
  candidateCount?: number;
  resultCount?: number;
  outcome: RequestStageOutcome;
};

/** Stage detail for per-route and per-tool log queries. */
export const buildRequestStageRecord = ({
  route,
  tool,
  stage,
  durationMs,
  rounds,
  candidateCount,
  resultCount,
  outcome,
}: RequestStageRecordInput) => ({
  event: "request.stage",
  class: REQUEST_STAGE_FAMILY[stage],
  "http.route": route,
  ...(tool === undefined ? {} : { tool }),
  stage,
  durationMs: Math.max(0, Math.round(durationMs)),
  ...(rounds === undefined ? {} : { rounds }),
  ...(candidateCount === undefined ? {} : { candidateCount }),
  ...(resultCount === undefined ? {} : { resultCount }),
  outcome,
});

export const emitRequestStage = (input: RequestStageRecordInput): void => {
  writeMetricLine(buildRequestStageRecord(input));
};

type McpRequestMetricInput = {
  method: string;
  mode: string;
  overlap: boolean;
  path: string;
  toolName?: string;
  phases: Record<
    "auth" | "context" | "server_build" | "tool_projection" | "dispatch",
    number
  >;
  queryCount: number;
  totalMs: number;
  /**
   * The called tool's latency budget (`mcp/tool-latency-budgets.ts`), on a
   * `tools/call` record only. `overBudget` is what the slow-tool log metric
   * filter counts, so the alarm and the canary judge by the same table.
   */
  latencyBudgetMs?: number;
};

export const buildMcpRequestMetricRecord = ({
  phases,
  totalMs,
  latencyBudgetMs,
  ...fields
}: McpRequestMetricInput) => {
  const total = Math.ceil(totalMs);
  return {
    event: "mcp.request.phases",
    ...fields,
    auth: Math.floor(phases.auth),
    context: Math.floor(phases.context),
    server_build: Math.floor(phases.server_build),
    tool_projection: Math.floor(phases.tool_projection),
    dispatch: Math.floor(phases.dispatch),
    total,
    ...(latencyBudgetMs === undefined
      ? {}
      : { budget: latencyBudgetMs, overBudget: total > latencyBudgetMs }),
  };
};

export const emitMcpRequestMetric = (input: McpRequestMetricInput): void => {
  writeMetricLine(buildMcpRequestMetricRecord(input));
};

/** One rejection per budget name; caller identifiers are never dimensions. */
export const emitRateLimitRejectedMetric = (budgetName: BudgetName): void => {
  writeMetricLine({
    budgetName,
    RateLimitRejected: 1,
  });
};

/** Reasoning items dropped per turn; the adapter ledger excludes SDK rereads. */
export const emitReasoningReplayDroppedMetric = ({
  count,
  ...dimensions
}: {
  fromProvider: TanStackAIProvider | "unknown";
  toProvider: TanStackAIProvider;
  reason:
    | "missing-provenance"
    | "incompatible-provenance"
    | "unpaired-reasoning"
    | "continuation-thinking-disabled";
  count: number;
}): void => {
  const name = "chat.reasoning_replay_dropped";
  writeMetricLine({
    ...dimensions,
    [name]: count,
  });
};

/** Counts observed failure transitions; a later transaction rollback does not
 * retract telemetry. */
export const emitVerificationRunFailureMetric = (
  errorCode: VerificationRunErrorCode,
): void => {
  switch (errorCode) {
    case "extraction_failed":
    case "grading_failed":
    case "no_text":
    case "access_revoked":
      writeMetricLine({
        event: `list_verification_run.${errorCode}`,
        errorCode,
        VerificationRunFailures: 1,
      });
      return;
    case "pin_unresolved":
    case "pin_content_changed":
    case "unsupported_format":
    case "ai_unavailable":
    case "enqueue_failed":
    case "run_limit_reached":
    case "internal":
      return;
    default:
      errorCode satisfies never;
      panic("Unknown verification failure code");
  }
};

export const emitAdmissionStorePolicyMetric = (refused: boolean): void => {
  const name = "AdmissionStoreEvictionPolicyRefused";
  writeMetricLine({
    [name]: refused ? 1 : 0,
  });
};

const SANCTIONS_SCREENING_WORK_METRIC = "SanctionsScreeningWorkUsage";

/**
 * Share of its deterministic work budget one completed sanctions screening
 * spent. Grouped by list so a growing list shows before it starts
 * refusing common names.
 */
export const emitSanctionsScreeningWorkMetric = ({
  source,
  percent,
}: {
  source: string;
  percent: number;
}): void => {
  writeMetricLine({
    source,
    [SANCTIONS_SCREENING_WORK_METRIC]: percent,
  });
};

const SANCTIONS_SCREENING_COMPLETION_METRIC =
  "SanctionsScreeningListCompletion";

/** One complete or incomplete result per source; no subject data is logged. */
export const emitSanctionsScreeningCompletionMetric = ({
  source,
  outcome,
}: {
  source: SanctionsSource;
  outcome: "complete" | "incomplete";
}): void => {
  writeMetricLine({
    source,
    outcome,
    [SANCTIONS_SCREENING_COMPLETION_METRIC]: 1,
  });
};

const DATA_INVARIANT_METRIC = "DataInvariantUnhealthy";

type DataInvariantMetricInput = {
  /** A stable id from `DATA_INVARIANT_ID`. */
  invariant: string;
  owner: string;
  severity: string;
  status: "held" | "violated" | "errored";
  checked: number;
  findings: number;
};

/**
 * One evaluated data invariant: 0 when it held, 1 when it was violated or
 * could not be checked. Emitted on every run for log queries.
 */
export const emitDataInvariantMetric = ({
  invariant,
  owner,
  severity,
  status,
  checked,
  findings,
}: DataInvariantMetricInput): void => {
  writeMetricLine({
    event: "data_invariant.evaluated",
    invariant,
    severity,
    owner,
    status,
    checked,
    findings,
    [DATA_INVARIANT_METRIC]: status === "held" ? 0 : 1,
  });
};

const EVENT_LOOP_DELAY_METRIC = {
  max: "EventLoopDelayMax",
  p99: "EventLoopDelayP99",
} as const;

/**
 * The process's memory at the end of a reporting window. File work holds its
 * bytes in array buffers outside the JS heap, so those are reported apart
 * from the heap, beside the bytes upload finalization has admitted.
 */
export type ProcessMemoryReport = {
  rssBytes: number;
  heapUsedBytes: number;
  arrayBuffersBytes: number;
  workPools: Record<
    string,
    {
      inFlight: number;
      queued: number;
      bytesInFlight: number;
      refusedBusy: number;
      refusedMemory: number;
      deadlineCancelled: number;
    }
  >;
};

/** Log-only: memory diagnostics must not create billable custom metrics. */
export const emitProcessMemoryLog = (memory: ProcessMemoryReport): void => {
  const poolFields = Object.fromEntries(
    Object.entries(memory.workPools).flatMap(([pool, metrics]) =>
      Object.entries(metrics).map(([field, value]) => [
        `work_pool.${pool}.${field}`,
        value,
      ]),
    ),
  );
  writeMetricLine({
    severity: "INFO",
    message: "runtime.process_memory",
    rssBytes: memory.rssBytes,
    heapUsedBytes: memory.heapUsedBytes,
    arrayBuffersBytes: memory.arrayBuffersBytes,
    ...poolFields,
  });
};

/**
 * One reporting window of the process's event-loop delay.
 */
export const emitEventLoopDelayMetric = ({
  maxMs,
  p99Ms,
  rootPool,
}: {
  maxMs: number;
  p99Ms: number;
  rootPool?: RootPoolReport;
}): void => {
  writeMetricLine({
    ...(rootPool === undefined ? {} : { rootPool }),
    [EVENT_LOOP_DELAY_METRIC.max]: maxMs,
    [EVENT_LOOP_DELAY_METRIC.p99]: p99Ms,
  });
};

// Capture the same structured line normally written to stdout.
let metricLineSink: ((line: string) => void) | null = null;

export const setMetricLineSinkForTesting = (
  sink: (line: string) => void,
): void => {
  metricLineSink = sink;
};

export const resetMetricLineSinkForTesting = (): void => {
  metricLineSink = null;
};

export const writeMetricLine = (record: object): void => {
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

export const CASE_LAW_FRESHNESS_METRIC = {
  projectionBacklogItems: "CaseLawProjectionBacklogItems",
  oldestUnpublishedAgeSeconds: "CaseLawOldestUnpublishedAgeSeconds",
  sourceSyncAgeSeconds: "CaseLawSourceSyncAgeSeconds",
  projectionConvergence: "CaseLawProjectionConvergence",
  decisionIdentifierRepairs: "CaseLawDecisionIdentifierRepairs",
  decisionIdentifierPassAgeSeconds: "CaseLawDecisionIdentifierPassAgeSeconds",
} as const satisfies Record<string, string>;

const buildCaseLawMetricRecord = ({
  name,
  value,
}: {
  name: (typeof CASE_LAW_FRESHNESS_METRIC)[keyof typeof CASE_LAW_FRESHNESS_METRIC];
  value: number;
}) => ({
  [name]: value,
});

export const buildCaseLawProjectionBacklogMetric = (value: number) =>
  buildCaseLawMetricRecord({
    name: CASE_LAW_FRESHNESS_METRIC.projectionBacklogItems,
    value,
  });

export const buildCaseLawOldestUnpublishedAgeMetric = (value: number) =>
  buildCaseLawMetricRecord({
    name: CASE_LAW_FRESHNESS_METRIC.oldestUnpublishedAgeSeconds,
    value,
  });

export const buildCaseLawSourceSyncAgeMetric = (
  source: string,
  value: number,
) => ({
  ...buildCaseLawMetricRecord({
    name: CASE_LAW_FRESHNESS_METRIC.sourceSyncAgeSeconds,
    value,
  }),
  source,
});

export const buildCaseLawDecisionIdentifierRepairMetric = (value: number) =>
  buildCaseLawMetricRecord({
    name: CASE_LAW_FRESHNESS_METRIC.decisionIdentifierRepairs,
    value,
  });

export const buildCaseLawDecisionIdentifierPassAgeMetric = (value: number) =>
  buildCaseLawMetricRecord({
    name: CASE_LAW_FRESHNESS_METRIC.decisionIdentifierPassAgeSeconds,
    value,
  });

export const buildCaseLawProjectionConvergenceMetric = (status: string) => ({
  ...buildCaseLawMetricRecord({
    name: CASE_LAW_FRESHNESS_METRIC.projectionConvergence,
    value: 1,
  }),
  status,
});

export const REQUEST_CLASSES = [
  "ai",
  "crud",
  "search",
  "batch",
  "stream",
] as const;
export type RequestClass = (typeof REQUEST_CLASSES)[number];

type EmitRequestDurationMetricInput = {
  durationMs: number;
  requestClass: RequestClass;
  statusCode: number;
  route: string;
};

/** Log fields consumed by request-class metric filters and log queries. */
export const buildRequestDurationRecord = ({
  durationMs,
  requestClass,
  statusCode,
  route,
}: EmitRequestDurationMetricInput) => ({
  class: requestClass,
  [METRIC_NAME]: Math.round(durationMs),
  "http.route": route,
  "http.status_code": statusCode,
});

export const emitRequestDurationMetric = (
  input: EmitRequestDurationMetricInput,
): void => {
  writeMetricLine(buildRequestDurationRecord(input));
};

export type OpenRouterTokenExchangeOutcome =
  | "ok"
  | "sts_error"
  | "exchange_4xx"
  | "exchange_429"
  | "exchange_5xx"
  | "timeout";

export const emitOpenRouterTokenExchange = (
  outcome: OpenRouterTokenExchangeOutcome,
  policyId: string,
): void => {
  writeMetricLine({
    outcome,
    federation_policy_id: policyId,
    OpenRouterTokenExchange: 1,
  });
};

export const emitManagedCredentialUnavailable = (): void => {
  writeMetricLine({
    ManagedCredentialUnavailable: 1,
  });
};

type FailureMetricInput = {
  /** A sink handle's label: a closed set, never a frame or an id. */
  sink: string;
  reason: string;
};

/** One transient failure per observation, before log or capture suppression. */
const buildFailureMetricRecord = ({ sink, reason }: FailureMetricInput) => ({
  sink,
  reason,
  [SERVICE_VERSION_KEY]: APP_VERSION,
  [FAILURE_METRIC_NAME]: 1,
});

export const emitFailureMetric = (input: FailureMetricInput): void => {
  writeMetricLine(buildFailureMetricRecord(input));
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
  switch (metric.type) {
    case "append":
      writeMetricLine({
        [CHAT_RUN_LOG_METRIC.appendDuration]: metric.durationMs,
      });
      return;
    case "turn":
      writeMetricLine({
        [CHAT_RUN_LOG_METRIC.rows]: metric.rows,
        [CHAT_RUN_LOG_METRIC.bytes]: metric.bytes,
      });
      return;
    default:
      metric satisfies never;
      panic("Unhandled chat run log metric");
  }
};

const PROMPT_CACHE_METRIC = {
  cachedInputTokens: "PromptCachedInputTokens",
  hitRate: "PromptCacheHitRate",
  inputTokens: "PromptInputTokens",
} as const;

/** The AI surfaces whose prompt caching is measured. */
export type PromptCacheMetricSurface = "chat";

type PromptCacheMetricInput = {
  /** Input tokens the provider read from its prompt cache. */
  cachedInputTokens: number;
  /** Every input token of the call: uncached, cache reads and cache writes. */
  inputTokens: number;
  provider: TanStackAIProvider;
  surface: PromptCacheMetricSurface;
};

/** One model call's input tokens, cached tokens, and cache percentage. */
const buildPromptCacheRecord = ({
  cachedInputTokens,
  inputTokens,
  provider,
  surface,
}: PromptCacheMetricInput) => ({
  provider,
  surface,
  [PROMPT_CACHE_METRIC.inputTokens]: inputTokens,
  [PROMPT_CACHE_METRIC.cachedInputTokens]: cachedInputTokens,
  [PROMPT_CACHE_METRIC.hitRate]:
    inputTokens > 0
      ? Math.round((cachedInputTokens / inputTokens) * 10_000) / 100
      : 0,
});

/** A call that reported no input tokens emits nothing: it has no rate. */
export const emitPromptCacheMetric = (input: PromptCacheMetricInput): void => {
  if (input.inputTokens <= 0) {
    return;
  }
  writeMetricLine(buildPromptCacheRecord(input));
};

export const emitActionCostDropMetric = (dropped: number): void => {
  writeMetricLine({
    ActionCostObservationsDropped: dropped,
  });
};

const CHAT_TURN_SETTLEMENT_METRIC_NAME = "ChatTurnSettlements";

/**
 * The outcome and failure code are the chat slice's closed sets; they are type
 * parameters so this shared module does not import the slice, and the caller's
 * types keep them closed.
 */
type ChatTurnSettlementMetricInput<
  TOutcome extends string,
  TFailureCode extends string,
> = {
  /** The status the turn settled with. */
  outcome: TOutcome;
  /** The third-party boundary the turn's provider input crossed. */
  mode: "anonymized" | "raw";
  /** The turn's provider; `none` when it ended before a model was resolved. */
  provider: AIProvider | "none";
  failureCode: TFailureCode | null;
};

/** One settled chat turn, grouped by outcome, boundary mode, and provider. */
export const buildChatTurnSettlementRecord = <
  TOutcome extends string,
  TFailureCode extends string,
>({
  failureCode,
  mode,
  outcome,
  provider,
}: ChatTurnSettlementMetricInput<TOutcome, TFailureCode>) => ({
  outcome,
  mode,
  provider,
  failure_code: failureCode ?? "none",
  [CHAT_TURN_SETTLEMENT_METRIC_NAME]: 1,
});

export const emitChatTurnSettlementMetric = <
  TOutcome extends string,
  TFailureCode extends string,
>(
  input: ChatTurnSettlementMetricInput<TOutcome, TFailureCode>,
): void => {
  writeMetricLine(buildChatTurnSettlementRecord(input));
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
 * One refusal to send content across the anonymized boundary, with site and reason.
 */
export const buildAnonymizationRefusalRecord = ({
  reason,
  site,
}: AnonymizationRefusalMetricInput) => ({
  site,
  reason,
  [ANONYMIZATION_REFUSAL_METRIC_NAME]: 1,
});

export const emitAnonymizationRefusalMetric = (
  input: AnonymizationRefusalMetricInput,
): void => {
  writeMetricLine(buildAnonymizationRefusalRecord(input));
};

const ACTION_RESPONSE_OVERSIZE_METRIC = "ActionResponseOversize";
const TRANSCRIPTION_DURATION_MISMATCH_METRIC = "TranscriptionDurationMismatch";

export const emitTranscriptionDurationMismatchMetric = (
  modelId: TranscriptionModelId,
): void => {
  writeMetricLine({
    event: "transcription.duration_mismatch",
    modelId,
    [TRANSCRIPTION_DURATION_MISMATCH_METRIC]: 1,
  });
};

type PublicCorpusAdmissionMetric = {
  class: Exclude<PublicCorpusClass, "browse">;
  outcome: "refused";
};

export const emitPublicCorpusAdmissionMetric = (
  input: PublicCorpusAdmissionMetric,
): void => {
  writeMetricLine({
    ...input,
    PublicCorpusAdmissions: 1,
  });
};

export const emitActionResponseOversizeMetric = (
  transport: "http" | "mcp",
): void => {
  writeMetricLine({
    transport,
    [ACTION_RESPONSE_OVERSIZE_METRIC]: 1,
  });
};
