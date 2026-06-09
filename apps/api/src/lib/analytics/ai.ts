import type {
  OnStepFinishEvent,
  OnStepStartEvent,
  OnToolCallFinishEvent,
  StreamTextOnErrorCallback,
} from "ai";
import { Result } from "better-result";

import type { SafeDb } from "@/api/db";
import type { UsageActionType, UsageServiceTier } from "@/api/db/schema";
import { env } from "@/api/env";
import type { ModelRole, OrgAIConfig } from "@/api/lib/ai-models";
import {
  SERVICE_TIER_PROVIDER_METADATA_KEY,
  STELLA_PROVIDER_METADATA_KEY,
  getModelInfoForRole,
  resolveEffectiveServiceTierForProvider,
} from "@/api/lib/ai-models";
import { captureError as captureTelemetryError } from "@/api/lib/analytics";
import type { SafeId } from "@/api/lib/branded-types";
import { errorTag } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
import { recordUsageEvent } from "@/api/lib/usage";
import { usageUnitsFromTokens } from "@/api/lib/usage/unit-model";

import { getAnalytics } from "./client";
import { SERVER_ANALYTICS_EVENTS } from "./types";
import type {
  AIFailureReason,
  Analytics,
  AnalyticsPrimitive,
  CountBucket,
  LatencyBucket,
  ModelKeySource,
  SafeAIAnalyticsMetadata,
  TokenBucket,
} from "./types";

type AnalyticsMetadata = Record<string, AnalyticsPrimitive>;

type AnalyticsStepState = {
  input: unknown[] | undefined;
  modelId: string;
  provider: string;
  spanId: string;
  startedAt: number;
};

export type AIUsageMetering = {
  actionType: UsageActionType;
  organizationId: SafeId<"organization">;
  safeDb: SafeDb;
  serviceTier: UsageServiceTier;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace"> | null;
};

type AIAnalyticsProps = {
  feature: string;
  traceId: string;
  sessionId?: string;
  distinctId?: string;
  properties?: AnalyticsMetadata;
  analytics?: Analytics;
  captureContent?: boolean;
  forceEnabled?: boolean;
  modelRole?: ModelRole;
  orgAIConfig?: OrgAIConfig | null;
  usageMetering?: AIUsageMetering;
};

const MAX_STRING_LENGTH = 2000;
const TRUNCATION_MARKER = " [truncated]";
const ONE_SECOND_MS = 1000;
const SERVER_DISTINCT_ID = "server";
const ERROR_CAUSE_MAX_DEPTH = 3;
const RESOURCE_EXHAUSTED_CODE = "RESOURCE_EXHAUSTED";
const GEMINI_QUOTA_PATTERN = /quota/iu;
const isLocalPostHogDebugEnabled = (): boolean =>
  env.isDev && env.POSTHOG_LOCAL_DEBUG;

const pickSafeMetadata = (
  properties: AnalyticsMetadata | undefined,
): SafeAIAnalyticsMetadata => {
  if (!properties) {
    return {};
  }

  const safeProperties: SafeAIAnalyticsMetadata = {};
  for (const [key, value] of Object.entries(properties)) {
    switch (key) {
      case "content_type":
        safeProperties.content_type = value;
        break;
      case "feature_area":
        safeProperties.feature_area = value;
        break;
      case "file_count":
        safeProperties.file_count = value;
        break;
      case "language":
        safeProperties.language = value;
        break;
      case "organization_id":
        safeProperties.organization_id = value;
        break;
      case "page_number":
        safeProperties.page_number = value;
        break;
      case "property_count":
        safeProperties.property_count = value;
        break;
      case "result_count":
        safeProperties.result_count = value;
        break;
      case "workspace_id":
        safeProperties.workspace_id = value;
        break;
      default:
        break;
    }
  }
  return safeProperties;
};

const bucketTokenCount = (tokens: number | undefined): TokenBucket => {
  if (tokens === undefined || tokens < 1000) {
    return "0_1k";
  }
  if (tokens < 5000) {
    return "1k_5k";
  }
  if (tokens < 20_000) {
    return "5k_20k";
  }
  return "20k_plus";
};

const bucketLatency = (latencySeconds: number): LatencyBucket => {
  if (latencySeconds < 2) {
    return "0_2s";
  }
  if (latencySeconds < 10) {
    return "2_10s";
  }
  if (latencySeconds < 30) {
    return "10_30s";
  }
  return "30s_plus";
};

const bucketCount = (count: number): CountBucket => {
  if (count === 0) {
    return "0";
  }
  if (count === 1) {
    return "1";
  }
  if (count <= 3) {
    return "2_3";
  }
  return "4_plus";
};

const getUsageInputTokens = (usage: OnStepFinishEvent["usage"]): number => {
  if (usage.inputTokens !== undefined) {
    return usage.inputTokens;
  }

  // oxlint-disable-next-line typescript/no-unnecessary-condition -- AI SDK providers may omit this at runtime despite the type.
  const noCacheTokens = usage.inputTokenDetails?.noCacheTokens ?? 0;
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- AI SDK providers may omit this at runtime despite the type.
  const cacheReadTokens = usage.inputTokenDetails?.cacheReadTokens ?? 0;
  return noCacheTokens + cacheReadTokens;
};

const getUsageCacheReadTokens = (
  usage: OnStepFinishEvent["usage"],
  inputTokens: number,
): number => {
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- AI SDK providers may omit this at runtime despite the type.
  const cacheReadTokens = usage.inputTokenDetails?.cacheReadTokens ?? 0;
  return Math.min(cacheReadTokens, inputTokens);
};

const getErrorStatusCode = (error: unknown): number | undefined => {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  if ("statusCode" in error && typeof error.statusCode === "number") {
    return error.statusCode;
  }

  if ("status" in error && typeof error.status === "number") {
    return error.status;
  }

  return undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const getErrorCause = (error: unknown): unknown => {
  if (!isRecord(error)) {
    return undefined;
  }

  return error["cause"];
};

const findInErrorCauseChain = <T>(
  error: unknown,
  match: (candidate: unknown) => T | undefined,
): T | undefined => {
  let candidate = error;
  let remainingCauseDepth = ERROR_CAUSE_MAX_DEPTH;
  const seen = new WeakSet<object>();

  while (candidate !== undefined) {
    if (isRecord(candidate)) {
      if (seen.has(candidate)) {
        return undefined;
      }
      seen.add(candidate);
    }

    const result = match(candidate);
    if (result !== undefined) {
      return result;
    }

    if (remainingCauseDepth === 0) {
      return undefined;
    }

    candidate = getErrorCause(candidate);
    remainingCauseDepth -= 1;
  }

  return undefined;
};

const getResponseBodyText = (error: unknown): string | undefined => {
  if (!isRecord(error) || !("responseBody" in error)) {
    return undefined;
  }

  const responseBody = error["responseBody"];
  if (typeof responseBody === "string") {
    return responseBody;
  }

  if (responseBody === undefined) {
    return undefined;
  }

  try {
    return JSON.stringify(responseBody);
  } catch {
    return undefined;
  }
};

const hasGeminiQuotaSignal = (text: string | undefined): boolean =>
  text !== undefined &&
  text.includes(RESOURCE_EXHAUSTED_CODE) &&
  GEMINI_QUOTA_PATTERN.test(text);

const isGeminiQuotaError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : "";
  if (hasGeminiQuotaSignal(message)) {
    return true;
  }

  return (
    getErrorStatusCode(error) === 429 &&
    hasGeminiQuotaSignal(getResponseBodyText(error))
  );
};

const isBYOKGeminiQuotaError = (
  error: unknown,
  modelKeySource: ModelKeySource | undefined,
): boolean =>
  modelKeySource === "byok" &&
  findInErrorCauseChain(error, (candidate) =>
    isGeminiQuotaError(candidate) ? true : undefined,
  ) === true;

// Provider error codes we accept as safe to surface as-is. Google
// Generative AI / Vertex AI return errors prefixed with one of these
// canonical gRPC codes (e.g. `INVALID_ARGUMENT: ...`); we keep just
// the prefix and drop the trailing text, which can include request
// bodies, prompt fragments, file names, or other user-controlled
// content that we do not want in telemetry.
const SAFE_PROVIDER_CODES: ReadonlySet<string> = new Set([
  "ABORTED",
  "ALREADY_EXISTS",
  "CANCELLED",
  "DATA_LOSS",
  "DEADLINE_EXCEEDED",
  "FAILED_PRECONDITION",
  "INTERNAL",
  "INVALID_ARGUMENT",
  "NOT_FOUND",
  "OUT_OF_RANGE",
  "PERMISSION_DENIED",
  "RESOURCE_EXHAUSTED",
  "UNAUTHENTICATED",
  "UNAVAILABLE",
  "UNIMPLEMENTED",
  "UNKNOWN",
]);

const SAFE_PROVIDER_CODE_PREFIX = /^([A-Z][A-Z_]+)(?::|\s|$)/u;

const extractSafeProviderCode = (message: string): string | undefined => {
  const match = SAFE_PROVIDER_CODE_PREFIX.exec(message);
  if (!match) {
    return undefined;
  }
  const code = match[1];
  if (code === undefined || !SAFE_PROVIDER_CODES.has(code)) {
    return undefined;
  }
  return code;
};

type ClassifiedErrorMessage =
  | { kind: "safe"; message: string }
  | { kind: "non_standard" };

const classifyErrorMessage = (
  error: unknown,
): ClassifiedErrorMessage | undefined => {
  if (!(error instanceof Error)) {
    return undefined;
  }

  const directCode = extractSafeProviderCode(error.message.trim());
  if (directCode !== undefined) {
    return { kind: "safe", message: directCode };
  }

  let safeCauseCode: string | undefined;
  let candidate = getErrorCause(error);
  let remainingCauseDepth = ERROR_CAUSE_MAX_DEPTH;
  const seen = new WeakSet<object>();
  seen.add(error);

  while (candidate !== undefined && remainingCauseDepth > 0) {
    if (isRecord(candidate)) {
      if (seen.has(candidate)) {
        break;
      }
      seen.add(candidate);
    }

    if (candidate instanceof Error) {
      const causeCode = extractSafeProviderCode(candidate.message.trim());
      if (causeCode !== undefined) {
        safeCauseCode = causeCode;
      }
    }

    candidate = getErrorCause(candidate);
    remainingCauseDepth -= 1;
  }

  if (safeCauseCode !== undefined) {
    return { kind: "safe", message: safeCauseCode };
  }

  return { kind: "non_standard" };
};

const getErrorStatusCodeFromChain = (error: unknown): number | undefined =>
  findInErrorCauseChain(error, getErrorStatusCode);

const classifyFailureReason = (
  error: unknown,
  modelKeySource?: ModelKeySource,
): AIFailureReason => {
  if (isBYOKGeminiQuotaError(error, modelKeySource)) {
    return "byok_quota";
  }

  const tag = errorTag(error);
  if (tag.includes("Validation")) {
    return "validation";
  }
  if (tag.includes("Configuration")) {
    return "configuration";
  }
  if (tag.includes("Timeout") || tag.includes("Abort")) {
    return "timeout";
  }

  const statusCode = getErrorStatusCodeFromChain(error);
  if (statusCode === 401 || statusCode === 403) {
    return "auth";
  }
  if (statusCode === 408 || statusCode === 504) {
    return "timeout";
  }
  if (statusCode === 429) {
    return "rate_limit";
  }
  if (statusCode !== undefined && statusCode >= 500) {
    return "provider";
  }

  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("rate limit") || message.includes("429")) {
    return "rate_limit";
  }
  if (message.includes("timeout") || message.includes("aborted")) {
    return "timeout";
  }
  if (message.includes("api key") || message.includes("unauthorized")) {
    return "auth";
  }

  return "unknown";
};

const truncateString = (value: string): string => {
  if (value.length <= MAX_STRING_LENGTH) {
    return value;
  }

  return (
    value.slice(0, MAX_STRING_LENGTH - TRUNCATION_MARKER.length) +
    TRUNCATION_MARKER
  );
};

export const sanitizeForAIAnalytics = (value: unknown): unknown => {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }

  if (typeof value === "string") {
    return truncateString(value);
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof ArrayBuffer) {
    return `[binary:${value.byteLength} bytes]`;
  }

  if (ArrayBuffer.isView(value)) {
    return `[binary:${value.byteLength} bytes]`;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForAIAnalytics(item));
  }

  if (typeof value === "object") {
    const entries = Object.entries(value);
    return Object.fromEntries(
      entries.map(([key, entryValue]) => [
        key,
        key === "data" &&
        (entryValue instanceof ArrayBuffer || ArrayBuffer.isView(entryValue))
          ? "[binary]"
          : sanitizeForAIAnalytics(entryValue),
      ]),
    );
  }

  const serialized = stringifyJSONValue(value);
  return serialized ?? Object.prototype.toString.call(value);
};

const stringifyJSONValue = (value: unknown): string | undefined =>
  JSON.stringify(value);

const normalizeProvider = (provider: string): string => {
  if (provider.startsWith("google")) {
    return "gemini";
  }

  return provider;
};

const normalizeMessageRole = (
  role: string,
): "assistant" | "system" | "user" | null => {
  if (role === "assistant" || role === "system" || role === "user") {
    return role;
  }

  return null;
};

const serializeMessages = (
  messages: readonly { content: unknown; role: string }[],
): unknown[] =>
  messages
    .map((message) => {
      const role = normalizeMessageRole(message.role);
      if (!role) {
        return null;
      }

      return {
        role,
        content: sanitizeForAIAnalytics(message.content),
      };
    })
    .filter((message) => message !== null);

const serializeToolNames = (
  toolCalls: readonly { toolName: string }[],
): string[] => [...new Set(toolCalls.map((toolCall) => toolCall.toolName))];

const getErrorPayload = ({
  error,
  captureContent,
}: {
  error: unknown;
  captureContent: boolean;
}): string | { message: unknown; type: string } =>
  captureContent && error instanceof Error
    ? {
        message: sanitizeForAIAnalytics(error.message),
        type: error.constructor.name,
      }
    : errorTag(error);

const buildBaseProperties = ({
  config,
  captureContent,
  spanId,
}: {
  config: AIAnalyticsProps;
  captureContent: boolean;
  spanId: string;
}) => ({
  $ai_trace_id: config.traceId,
  ...(config.sessionId ? { $ai_session_id: config.sessionId } : {}),
  $ai_span_id: spanId,
  $ai_span_name: config.feature,
  ...(captureContent ? { debug_mode: true } : {}),
  ...config.properties,
});

type RecordStepConsumptionInput = {
  cacheReadTokens: number;
  config: AIAnalyticsProps;
  inputTokens: number;
  modelId: string;
  outputTokens: number;
  providerMetadata: OnStepFinishEvent["providerMetadata"];
};

const isUsageServiceTier = (value: unknown): value is UsageServiceTier =>
  value === "standard" || value === "flex" || value === "batch";

const resolveMeteredServiceTier = ({
  providerMetadata,
  requestedServiceTier,
}: {
  providerMetadata: OnStepFinishEvent["providerMetadata"];
  requestedServiceTier: UsageServiceTier;
}): UsageServiceTier => {
  const metadataServiceTier =
    providerMetadata?.[STELLA_PROVIDER_METADATA_KEY]?.[
      SERVICE_TIER_PROVIDER_METADATA_KEY
    ];

  return isUsageServiceTier(metadataServiceTier)
    ? metadataServiceTier
    : requestedServiceTier;
};

const recordStepConsumption = ({
  cacheReadTokens,
  config,
  inputTokens,
  modelId,
  outputTokens,
  providerMetadata,
}: RecordStepConsumptionInput): void => {
  const metering = config.usageMetering;
  if (!metering) {
    return;
  }

  const modelRole = config.modelRole ?? "chat";
  const modelInfo = getModelInfoForRole(modelRole, config.orgAIConfig);
  const isByok = modelInfo.keySource === "byok";
  const meteredServiceTier = resolveMeteredServiceTier({
    providerMetadata,
    requestedServiceTier: metering.serviceTier,
  });
  const effectiveServiceTier = resolveEffectiveServiceTierForProvider({
    provider: modelInfo.provider,
    region: modelInfo.region,
    serviceTier: meteredServiceTier,
  });
  const { unitsConsumed, rawUsageMicroUnits } = usageUnitsFromTokens({
    actionType: metering.actionType,
    cacheReadTokens,
    inputTokens,
    isByok,
    modelId,
    outputTokens,
    serviceTier: effectiveServiceTier,
  });

  const consumption = metering.safeDb(
    async (tx) =>
      await recordUsageEvent({
        tx,
        actionType: metering.actionType,
        unitsConsumed,
        isByok,
        modelRole,
        organizationId: metering.organizationId,
        rawUsageMicroUnits,
        serviceTier: effectiveServiceTier,
        traceId: config.traceId,
        userId: metering.userId,
        workspaceId: metering.workspaceId,
      }),
  );

  void consumption
    .then((result) => {
      if (Result.isError(result)) {
        captureTelemetryError(result.error, {
          organization_id: metering.organizationId,
          source: "usage.ai_step_event",
          trace_id: config.traceId,
        });
      }
      return undefined;
    })
    .catch((error: unknown) => {
      captureTelemetryError(error, {
        organization_id: metering.organizationId,
        source: "usage.ai_step_event.unhandled",
        trace_id: config.traceId,
      });
    });
};

type AIAnalyticsStepCallbacks = {
  experimental_onStepStart?: (event: OnStepStartEvent) => void;
  onStepFinish?: (event: OnStepFinishEvent) => void;
  experimental_onToolCallFinish?: (event: OnToolCallFinishEvent) => void;
};

type AIAnalyticsCallbacks = {
  stepCallbacks: AIAnalyticsStepCallbacks;
  onStreamError?: StreamTextOnErrorCallback;
  captureError: (error: unknown) => void;
};

export const createAIAnalyticsCallbacks = ({
  analytics = getAnalytics(),
  captureContent = env.POSTHOG_LOCAL_DEBUG_AI_CONTENT,
  forceEnabled = false,
  ...config
}: AIAnalyticsProps): AIAnalyticsCallbacks => {
  const debugEnabled = forceEnabled || isLocalPostHogDebugEnabled();
  const captureDebugContent = debugEnabled && captureContent;

  const stepState = new Map<number, AnalyticsStepState>();
  const distinctId = debugEnabled
    ? (config.distinctId ?? `local-debug:${config.feature}`)
    : SERVER_DISTINCT_ID;
  const resolvedModelInfo = config.modelRole
    ? getModelInfoForRole(config.modelRole, config.orgAIConfig)
    : null;
  let hasCapturedGenerationError = false;

  const onStepStart: NonNullable<
    AIAnalyticsStepCallbacks["experimental_onStepStart"]
  > = ({ messages, model, stepNumber }) => {
    stepState.set(stepNumber, {
      input: captureDebugContent ? serializeMessages(messages) : undefined,
      modelId: model.modelId,
      provider: normalizeProvider(model.provider),
      spanId: Bun.randomUUIDv7(),
      startedAt: performance.now(),
    });
  };

  const onStepFinish: NonNullable<AIAnalyticsStepCallbacks["onStepFinish"]> = ({
    model,
    providerMetadata,
    response,
    stepNumber,
    toolCalls,
    usage,
  }) => {
    const currentStep =
      stepState.get(stepNumber) ??
      ({
        input: undefined,
        modelId: model.modelId,
        provider: normalizeProvider(model.provider),
        spanId: Bun.randomUUIDv7(),
        startedAt: performance.now(),
      } satisfies AnalyticsStepState);

    const latencySeconds =
      (performance.now() - currentStep.startedAt) / ONE_SECOND_MS;
    // The provider type marks `inputTokenDetails` non-optional, but
    // SDK test fixtures and some providers leave it undefined at
    // runtime. Read defensively to avoid a TypeError in analytics.
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- runtime undefined diverges from type
    const cacheReadTokens = usage.inputTokenDetails?.cacheReadTokens;
    const inputTokens = getUsageInputTokens(usage);
    const outputTokens = usage.outputTokens ?? 0;
    const meteredCacheReadTokens = getUsageCacheReadTokens(usage, inputTokens);

    recordStepConsumption({
      cacheReadTokens: meteredCacheReadTokens,
      config,
      inputTokens,
      modelId: response.modelId || currentStep.modelId,
      outputTokens,
      providerMetadata,
    });

    if (!debugEnabled) {
      analytics.capture({
        distinctId,
        event: SERVER_ANALYTICS_EVENTS.aiGenerationCompleted,
        properties: {
          ...pickSafeMetadata(config.properties),
          feature: config.feature,
          input_tokens_bucket: bucketTokenCount(usage.inputTokens),
          latency_bucket: bucketLatency(latencySeconds),
          model: resolvedModelInfo?.modelId ?? currentStep.modelId,
          model_key_source: resolvedModelInfo?.keySource ?? "unknown",
          output_tokens_bucket: bucketTokenCount(usage.outputTokens),
          provider: resolvedModelInfo?.provider ?? currentStep.provider,
          ...(resolvedModelInfo?.region
            ? { region: resolvedModelInfo.region }
            : {}),
          tool_count_bucket: bucketCount(toolCalls.length),
          total_tokens_bucket: bucketTokenCount(usage.totalTokens),
          ...(cacheReadTokens !== undefined
            ? {
                cached_input_tokens_bucket: bucketTokenCount(cacheReadTokens),
              }
            : {}),
        },
      });

      stepState.delete(stepNumber);
      return;
    }

    analytics.capture({
      distinctId,
      event: SERVER_ANALYTICS_EVENTS.aiGeneration,
      properties: {
        ...buildBaseProperties({
          config,
          captureContent: captureDebugContent,
          spanId: currentStep.spanId,
        }),
        $ai_input_tokens: usage.inputTokens,
        $ai_output_tokens: usage.outputTokens,
        ...(cacheReadTokens !== undefined
          ? { $ai_cached_input_tokens: cacheReadTokens }
          : {}),
        $ai_latency: latencySeconds,
        $ai_model: currentStep.modelId,
        $ai_provider: currentStep.provider,
        ...(toolCalls.length > 0
          ? { $ai_tools: serializeToolNames(toolCalls) }
          : {}),
        ...(captureDebugContent && currentStep.input
          ? { $ai_input: currentStep.input }
          : {}),
        ...(captureDebugContent
          ? { $ai_output_choices: serializeMessages(response.messages) }
          : {}),
      },
    });

    stepState.delete(stepNumber);
  };

  const onToolCallFinish: NonNullable<
    AIAnalyticsStepCallbacks["experimental_onToolCallFinish"]
  > = (event) => {
    if (!debugEnabled) {
      return;
    }

    const parentStep =
      event.stepNumber === undefined
        ? undefined
        : stepState.get(event.stepNumber);

    analytics.capture({
      distinctId,
      event: SERVER_ANALYTICS_EVENTS.aiSpan,
      properties: {
        $ai_trace_id: config.traceId,
        ...(config.sessionId ? { $ai_session_id: config.sessionId } : {}),
        $ai_span_id: Bun.randomUUIDv7(),
        $ai_span_name: event.toolCall.toolName,
        ...(parentStep ? { $ai_parent_id: parentStep.spanId } : {}),
        $ai_latency: event.durationMs / ONE_SECOND_MS,
        ...(captureDebugContent
          ? {
              $ai_input_state: sanitizeForAIAnalytics({
                tool: event.toolCall.toolName,
                input: event.toolCall.input,
              }),
              ...(event.success
                ? {
                    $ai_output_state: sanitizeForAIAnalytics(event.output),
                  }
                : {}),
            }
          : {}),
        ...(event.success
          ? {}
          : {
              $ai_is_error: true,
              $ai_error: getErrorPayload({
                error: event.error,
                captureContent: captureDebugContent,
              }),
            }),
        ...config.properties,
      },
    });
  };

  const stepCallbacks: AIAnalyticsStepCallbacks = {
    experimental_onStepStart: onStepStart,
    onStepFinish,
    experimental_onToolCallFinish: onToolCallFinish,
  };

  const captureGenerationError = (error: unknown) => {
    if (hasCapturedGenerationError) {
      return;
    }

    hasCapturedGenerationError = true;
    const activeStep = [...stepState.values()].at(-1);
    const modelKeySource = resolvedModelInfo?.keySource;
    const failureReason = classifyFailureReason(error, modelKeySource);

    const cwMessage = classifyErrorMessage(error);
    logger.error("ai.generation.failed", {
      "error.type": errorTag(error),
      "ai.feature": config.feature,
      "ai.failure_reason": failureReason,
      ...(resolvedModelInfo?.provider
        ? { "ai.provider": resolvedModelInfo.provider }
        : {}),
      ...(resolvedModelInfo?.modelId
        ? { "ai.model": resolvedModelInfo.modelId }
        : {}),
      ...(cwMessage?.kind === "safe"
        ? { "ai.error_code": cwMessage.message }
        : { "ai.error_code_kind": "non_standard" }),
    });

    if (!debugEnabled) {
      const phMessage = classifyErrorMessage(error);
      analytics.capture({
        distinctId,
        event: SERVER_ANALYTICS_EVENTS.aiGenerationFailed,
        properties: {
          ...pickSafeMetadata(config.properties),
          error_type: errorTag(error),
          ...(phMessage?.kind === "safe"
            ? { error_message: phMessage.message }
            : { error_message_kind: "non_standard" }),
          failure_reason: failureReason,
          feature: config.feature,
          ...(activeStep
            ? {
                latency_bucket: bucketLatency(
                  (performance.now() - activeStep.startedAt) / ONE_SECOND_MS,
                ),
                model: resolvedModelInfo?.modelId ?? activeStep.modelId,
                model_key_source: resolvedModelInfo?.keySource ?? "unknown",
                provider: resolvedModelInfo?.provider ?? activeStep.provider,
                ...(resolvedModelInfo?.region
                  ? { region: resolvedModelInfo.region }
                  : {}),
              }
            : {}),
        },
      });
      return;
    }

    analytics.capture({
      distinctId,
      event: SERVER_ANALYTICS_EVENTS.aiGeneration,
      properties: {
        ...buildBaseProperties({
          config,
          captureContent: captureDebugContent,
          spanId: activeStep?.spanId ?? Bun.randomUUIDv7(),
        }),
        $ai_is_error: true,
        $ai_error: getErrorPayload({
          error,
          captureContent: captureDebugContent,
        }),
        ...(activeStep
          ? {
              ...(captureDebugContent && activeStep.input
                ? { $ai_input: activeStep.input }
                : {}),
              $ai_latency:
                (performance.now() - activeStep.startedAt) / ONE_SECOND_MS,
              $ai_model: activeStep.modelId,
              $ai_provider: activeStep.provider,
            }
          : {}),
      },
    });
  };

  return {
    stepCallbacks,
    onStreamError: ({ error }: { error: unknown }) => {
      captureGenerationError(error);
    },
    captureError: captureGenerationError,
  };
};
