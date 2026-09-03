import type {
  ChatMiddleware,
  ChatMiddlewareContext,
  TokenUsage,
} from "@tanstack/ai";
import { Result } from "better-result";

import type { ModelRole } from "@stll/ai-catalog";

import type { SafeDb } from "@/api/db/safe-db";
import type {
  UsageActionType,
  UsageEventLane,
  UsageServiceTier,
} from "@/api/db/schema";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import {
  classifyAIError,
  isAnticipatedAIFailure,
  providerStatusFields,
} from "@/api/lib/ai-error";
import { captureError as captureTelemetryError } from "@/api/lib/analytics/capture";
import type { ErrorTelemetryContext } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { errorTag } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
import {
  getTanStackTextModelInfoById,
  getTanStackTextModelInfoForRole,
  resolveEffectiveServiceTierForProvider,
  type ResolvedTanStackTextModelInfo,
} from "@/api/lib/tanstack-ai-models";
import { incrementLaneCounter } from "@/api/lib/usage/lane-budget";
import {
  normalizeProviderPromptTokens,
  usageUnitsFromTokens,
} from "@/api/lib/usage/unit-model";
import { recordUsageEvent } from "@/api/lib/usage/usage-ledger";

import { getAnalytics } from "./client";
import {
  SERVER_ANALYTICS_EVENTS,
  type Analytics,
  type AnalyticsPrimitive,
  type CountBucket,
  type LatencyBucket,
  type SafeAIAnalyticsMetadata,
  type TokenBucket,
} from "./types";

type AnalyticsMetadata = Record<string, AnalyticsPrimitive>;

/** What one run accumulates across its middleware hooks. */
type RunAnalyticsState = {
  /** Start of the current agent-loop iteration (one model call). */
  iterationStartedAt: number;
  toolCount: number;
  /** Sum of every iteration's reported usage. */
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  usageReported: boolean;
};

export type TanStackAIUsageMetering = {
  actionType: UsageActionType;
  /**
   * Budget this turn settles against, decided at routing time.
   * Omitted = the org pool (every caller before lane routing landed).
   */
  lane?: UsageEventLane;
  organizationId: SafeId<"organization">;
  safeDb: SafeDb;
  serviceTier: UsageServiceTier;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace"> | null;
};

export type AIUsageMetering = TanStackAIUsageMetering;

type TanStackAIAnalyticsProps = {
  feature: string;
  traceId: string;
  sessionId?: string;
  distinctId?: string;
  properties?: AnalyticsMetadata;
  /**
   * Correlation ids for the exception this run reports, whichever path
   * reports it. Separate from `properties`, which reaches the product
   * analytics events through a fixed allowlist. A caller cannot attach
   * these with a `captureError` of its own beside this one: the sink
   * throttles by structural fingerprint alone, so the second call is
   * dropped as a repeat and its context never ships.
   */
  errorContext?: ErrorTelemetryContext;
  analytics?: Analytics;
  modelRole?: ModelRole;
  /**
   * Explicit per-turn model selection (dev override or validated
   * thread model). When set, metering rates this model instead of the
   * role default.
   */
  selectedModelId?: string | undefined;
  orgAIConfig?: OrgAIConfig | null;
  /**
   * Analytics-only organization identity for org-scoped calls that do not
   * meter usage (fixed-cost or internal features). Metered calls derive the
   * organization from `usageMetering` and may omit this.
   */
  organizationId?: SafeId<"organization"> | null;
  usageMetering?: TanStackAIUsageMetering;
};

export type TanStackAIAnalyticsCallbacks = {
  middleware: ChatMiddleware;
  captureError: (error: unknown) => void;
};

const SERVER_DISTINCT_ID = "server";
const ONE_SECOND_MS = 1000;

const bucketTokenCount = (count: number | undefined): TokenBucket => {
  if (count === undefined || count < 1000) {
    return "0_1k";
  }
  if (count < 5000) {
    return "1k_5k";
  }
  if (count < 20_000) {
    return "5k_20k";
  }
  return "20k_plus";
};

const bucketLatency = (seconds: number): LatencyBucket => {
  if (seconds < 2) {
    return "0_2s";
  }
  if (seconds < 10) {
    return "2_10s";
  }
  if (seconds < 30) {
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
      case "jurisdiction":
        safeProperties.jurisdiction = value;
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

const resolveTanStackEffectiveServiceTier = ({
  modelInfo,
  serviceTier,
}: {
  modelInfo: ResolvedTanStackTextModelInfo;
  serviceTier: UsageServiceTier;
}): UsageServiceTier =>
  resolveEffectiveServiceTierForProvider({
    provider: modelInfo.provider,
    region: modelInfo.region,
    serviceTier,
  });

const usageServiceTierFromModelOptions = ({
  fallback,
  modelOptions,
}: {
  fallback: UsageServiceTier;
  modelOptions: ChatMiddlewareContext["modelOptions"];
}): UsageServiceTier => {
  if (!isRecord(modelOptions)) {
    return fallback;
  }

  const openAIServiceTier = modelOptions["service_tier"];
  if (openAIServiceTier === "default") {
    return "standard";
  }

  const serviceTier = modelOptions["serviceTier"];
  if (serviceTier === "standard") {
    return "standard";
  }

  return fallback;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const recordTanStackConsumption = async ({
  cacheReadTokens,
  completionTokens,
  config,
  iteration,
  modelInfo,
  runId,
  serviceTier,
  uncachedInputTokens,
}: {
  cacheReadTokens: number;
  completionTokens: number;
  config: TanStackAIAnalyticsProps;
  iteration: number;
  modelInfo: ResolvedTanStackTextModelInfo;
  runId: string;
  serviceTier: UsageServiceTier;
  uncachedInputTokens: number;
}): Promise<void> => {
  const metering = config.usageMetering;
  if (!metering) {
    return;
  }

  const effectiveServiceTier = resolveTanStackEffectiveServiceTier({
    modelInfo,
    serviceTier,
  });
  const { unitsConsumed, rawUsageMicroUnits } = usageUnitsFromTokens({
    actionType: metering.actionType,
    cacheReadTokens,
    isByok: modelInfo.keySource === "byok",
    modelId: modelInfo.modelId,
    outputTokens: completionTokens,
    serviceTier: effectiveServiceTier,
    uncachedInputTokens,
  });

  const lane = metering.lane ?? "pool";
  const result = await metering.safeDb(async (tx) => {
    const recorded = await recordUsageEvent({
      tx,
      actionType: metering.actionType,
      unitsConsumed: lane === "pool" ? unitsConsumed : 0,
      isByok: modelInfo.keySource === "byok",
      lane,
      modelRole: config.modelRole ?? "chat",
      organizationId: metering.organizationId,
      rawUsageMicroUnits,
      serviceTier: effectiveServiceTier,
      idempotencyKey: `${config.traceId}:${runId}:${iteration}`,
      traceId: config.traceId,
      userId: metering.userId,
      workspaceId: metering.workspaceId,
    });
    // Allowance/fallback consumption settles against the user's lane
    // counter in the SAME transaction as the event, so a crash between
    // the two cannot leave settled work uncounted. Duplicate callbacks
    // dedupe on the event and must not double-increment the counter.
    if (recorded.status === "recorded" && lane !== "pool") {
      await incrementLaneCounter({
        tx,
        organizationId: metering.organizationId,
        userId: metering.userId,
        kind: lane === "fallback" ? "fallback_weekly" : "daily",
        microUnits: rawUsageMicroUnits,
      });
    }
    return recorded;
  });

  if (Result.isError(result)) {
    captureTelemetryError(result.error, {
      organization_id: metering.organizationId,
      source: "usage.tanstack_ai",
      trace_id: config.traceId,
    });
  }
};

export const createTanStackAIAnalyticsCallbacks = ({
  analytics = getAnalytics(),
  ...config
}: TanStackAIAnalyticsProps): TanStackAIAnalyticsCallbacks => {
  const distinctId = config.distinctId ?? SERVER_DISTINCT_ID;
  const modelRole = config.modelRole ?? "chat";
  // Group attachment is derived centrally so call sites cannot forget it:
  // from the metering context when present, else from the analytics-only
  // organization identity. Events with neither stay ungrouped.
  const analyticsOrganizationId =
    config.usageMetering?.organizationId ?? config.organizationId ?? null;
  const groups =
    analyticsOrganizationId === null
      ? {}
      : { groups: { organization: analyticsOrganizationId } };
  const selectedModelId = config.selectedModelId;
  let modelInfo: ResolvedTanStackTextModelInfo | null | undefined;
  const startedAt = performance.now();
  // Per-run state, keyed by `ctx.runId`: one callbacks instance may serve
  // several `chat()` requests (template filling shares one across up to
  // four concurrent field resolutions), so nothing a hook accumulates may
  // live on the closure. Entries are dropped by the terminal hooks; a run
  // that parks at an interrupt keeps its entry for the instance's lifetime.
  const runs = new Map<string, RunAnalyticsState>();
  const runState = (ctx: ChatMiddlewareContext): RunAnalyticsState => {
    const existing = runs.get(ctx.runId);
    if (existing) {
      return existing;
    }
    const now = performance.now();
    const created: RunAnalyticsState = {
      iterationStartedAt: now,
      toolCount: 0,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      usageReported: false,
    };
    runs.set(ctx.runId, created);
    return created;
  };
  let hasCapturedGenerationError = false;

  const resolveAnalyticsModelInfo =
    (): ResolvedTanStackTextModelInfo | null => {
      if (modelInfo !== undefined) {
        return modelInfo;
      }

      try {
        // An explicit per-turn selection outranks the role default:
        // metering must rate the model that actually served the turn.
        modelInfo =
          selectedModelId !== undefined
            ? getTanStackTextModelInfoById(
                selectedModelId,
                config.orgAIConfig,
                modelRole,
              )
            : getTanStackTextModelInfoForRole(modelRole, config.orgAIConfig, {
                organizationId: analyticsOrganizationId,
              });
      } catch (error) {
        modelInfo = null;
        logger.warn("tanstack_ai.analytics.model_info_unavailable", {
          "ai.feature": config.feature,
          "ai.role": modelRole,
          "error.type": errorTag(error),
        });
      }

      return modelInfo;
    };

  const captureGenerationError = (error: unknown, durationMs?: number) => {
    if (hasCapturedGenerationError) {
      return;
    }
    hasCapturedGenerationError = true;
    const resolvedModelInfo = resolveAnalyticsModelInfo();

    // Classified kinds (quota, billing, retired model, provider outage) are
    // expected operational states of an upstream account, and a sub-500
    // `HandlerError` is a configuration state this service raised itself, so
    // both log at WARN; an unanticipated shape is the only one logged at
    // ERROR. Same split as `reportStreamFailure` in the chat stream handler.
    // The status is what names an anticipated failure once `ai.error_kind`
    // cannot, and a number carries no request content. `providerStatusFields`
    // carries the provider's own status for the same reason, and separates a
    // status this code does not map from a failure that carried none at all;
    // without it an `unknown` kind is indistinguishable between the two.
    const kind = classifyAIError(error);
    const attributes = {
      "error.type": errorTag(error),
      "ai.error_kind": kind,
      "ai.feature": config.feature,
      ...(HandlerError.is(error) ? { "error.status_code": error.status } : {}),
      ...(resolvedModelInfo
        ? {
            "ai.provider": resolvedModelInfo.provider,
            "ai.model": resolvedModelInfo.modelId,
          }
        : {}),
      ...providerStatusFields(error),
    };
    if (isAnticipatedAIFailure(error, kind)) {
      logger.warn("tanstack_ai.generation.failed", attributes);
    } else {
      logger.error("tanstack_ai.generation.failed", attributes);
    }
    captureTelemetryError(error, {
      ...config.errorContext,
      feature: config.feature,
      organization_id: analyticsOrganizationId ?? "",
      trace_id: config.traceId,
    });

    // Standard-schema failure record for LLM observability: the error class
    // name only, never the message. See the completion-side capture for the
    // privacy contract.
    analytics.capture({
      distinctId,
      ...groups,
      event: SERVER_ANALYTICS_EVENTS.aiGeneration,
      properties: {
        $ai_error: errorTag(error),
        $ai_is_error: true,
        // The middleware's measured duration covers only the provider call;
        // the construction-time clock is the catch-path fallback and can
        // include setup work.
        $ai_latency:
          (durationMs ?? performance.now() - startedAt) / ONE_SECOND_MS,
        $ai_trace_id: config.traceId,
        feature: config.feature,
        ...(resolvedModelInfo
          ? {
              $ai_model: resolvedModelInfo.modelId,
              $ai_provider: resolvedModelInfo.provider,
            }
          : {}),
      },
    });

    analytics.capture({
      distinctId,
      ...groups,
      event: SERVER_ANALYTICS_EVENTS.aiGenerationFailed,
      properties: {
        ...pickSafeMetadata(config.properties),
        error_message_kind: "non_standard",
        error_type: errorTag(error),
        failure_reason: "provider",
        feature: config.feature,
        latency_bucket: bucketLatency(
          (performance.now() - startedAt) / ONE_SECOND_MS,
        ),
        ...(resolvedModelInfo
          ? {
              model: resolvedModelInfo.modelId,
              model_key_source: resolvedModelInfo.keySource,
              provider: resolvedModelInfo.provider,
              ...(resolvedModelInfo.region
                ? { region: resolvedModelInfo.region }
                : {}),
            }
          : {}),
      },
    });
  };

  // The standard $ai_* schema feeds the analytics platform's LLM
  // observability product: one `$ai_generation` per model call, correlated
  // by `$ai_trace_id`. Captured from `onUsage` (once per iteration that
  // reports usage) rather than from `onFinish`: a run that pauses at an
  // interrupt (client tool, approval) reaches no terminal hook at all, and
  // `onFinish` only carries the last iteration's usage. Privacy mode by
  // construction: model, token counts, latency, and trace correlation only —
  // prompt and completion content never leave the service.
  const captureGeneration = ({
    ctx,
    iterationStartedAt,
    modelInfo: resolvedModelInfo,
    usage,
  }: {
    ctx: ChatMiddlewareContext;
    iterationStartedAt: number;
    modelInfo: ResolvedTanStackTextModelInfo;
    usage: TokenUsage;
  }) => {
    analytics.capture({
      distinctId,
      ...groups,
      event: SERVER_ANALYTICS_EVENTS.aiGeneration,
      properties: {
        $ai_input_tokens: usage.promptTokens,
        $ai_latency: (performance.now() - iterationStartedAt) / ONE_SECOND_MS,
        $ai_model: resolvedModelInfo.modelId,
        $ai_output_tokens: usage.completionTokens,
        $ai_provider: resolvedModelInfo.provider,
        $ai_span_id: `${ctx.runId}:${ctx.iteration}`,
        $ai_trace_id: config.traceId,
        feature: config.feature,
      },
    });
  };

  return {
    captureError: captureGenerationError,
    middleware: {
      name: "stella-tanstack-analytics",
      // Each agent-loop iteration is one model call: `onIteration` marks its
      // start and `onUsage` closes it, so per-generation latency covers only
      // that call (the run-level `duration` spans every iteration and tool).
      onIteration: (ctx) => {
        runState(ctx).iterationStartedAt = performance.now();
      },
      onAfterToolCall: (ctx) => {
        runState(ctx).toolCount += 1;
      },
      onAbort: (ctx) => {
        runs.delete(ctx.runId);
      },
      onError: (ctx, { duration, error }) => {
        runs.delete(ctx.runId);
        captureGenerationError(error, duration);
      },
      onFinish: (ctx, { duration, usage }) => {
        const run = runs.get(ctx.runId);
        runs.delete(ctx.runId);
        // Sum of every iteration's reported usage. TanStack's `onFinish`
        // usage is the LAST iteration's only (`finishedEvent` resets per
        // iteration); it is the fallback for a run whose provider never
        // reached `onUsage`.
        const totals = run?.usageReported ? run.usage : usage;
        if (!totals) {
          return;
        }
        const resolvedModelInfo = resolveAnalyticsModelInfo();
        if (!resolvedModelInfo) {
          return;
        }

        analytics.capture({
          distinctId,
          ...groups,
          event: SERVER_ANALYTICS_EVENTS.aiGenerationCompleted,
          properties: {
            ...pickSafeMetadata(config.properties),
            feature: config.feature,
            input_tokens_bucket: bucketTokenCount(totals.promptTokens),
            latency_bucket: bucketLatency(duration / ONE_SECOND_MS),
            model: resolvedModelInfo.modelId,
            model_key_source: resolvedModelInfo.keySource,
            output_tokens_bucket: bucketTokenCount(totals.completionTokens),
            provider: resolvedModelInfo.provider,
            ...(resolvedModelInfo.region
              ? { region: resolvedModelInfo.region }
              : {}),
            tool_count_bucket: bucketCount(run?.toolCount ?? 0),
            total_tokens_bucket: bucketTokenCount(totals.totalTokens),
          },
        });
      },
      // Framework-hook boundaries (the one place try-catch is allowed): a
      // fault here must never propagate into the provider stream and take
      // the process down with it, and metering and observability are
      // isolated from each other so an analytics fault cannot drop a
      // billable usage event. A bug loses that one event and reports it; it
      // never loses the server.
      onUsage: (ctx, usage) => {
        const resolvedModelInfo = resolveAnalyticsModelInfo();
        if (!resolvedModelInfo) {
          return;
        }
        const run = runState(ctx);
        try {
          run.usage.promptTokens += usage.promptTokens;
          run.usage.completionTokens += usage.completionTokens;
          run.usage.totalTokens += usage.totalTokens;
          run.usageReported = true;
        } catch (error) {
          // The payload itself is unreadable: neither side effect can use it.
          captureTelemetryError(error, {
            source: "usage.tanstack_ai",
            trace_id: config.traceId,
          });
          return;
        }

        const metering = config.usageMetering;
        if (metering) {
          try {
            const { uncachedInputTokens, cacheReadTokens } =
              normalizeProviderPromptTokens({
                provider: resolvedModelInfo.provider,
                modelId: resolvedModelInfo.modelId,
                promptTokens: usage.promptTokens,
                cacheReadTokens: usage.promptTokensDetails?.cachedTokens ?? 0,
                cacheWriteTokens:
                  usage.promptTokensDetails?.cacheWriteTokens ?? 0,
              });
            const consumption = recordTanStackConsumption({
              cacheReadTokens,
              completionTokens: usage.completionTokens,
              config,
              iteration: ctx.iteration,
              modelInfo: resolvedModelInfo,
              runId: ctx.runId,
              serviceTier: usageServiceTierFromModelOptions({
                fallback: metering.serviceTier,
                modelOptions: ctx.modelOptions,
              }),
              uncachedInputTokens,
            }).catch((error: unknown) => {
              // A rejected deferred settles inside the stream lifecycle;
              // capture it here so it cannot surface as an unhandled
              // rejection there.
              captureTelemetryError(error, {
                organization_id: metering.organizationId,
                source: "usage.tanstack_ai",
                trace_id: config.traceId,
              });
            });
            ctx.defer(consumption);
          } catch (error) {
            captureTelemetryError(error, {
              source: "usage.tanstack_ai",
              trace_id: config.traceId,
            });
          }
        }

        try {
          captureGeneration({
            ctx,
            iterationStartedAt: run.iterationStartedAt,
            modelInfo: resolvedModelInfo,
            usage,
          });
        } catch (error) {
          captureTelemetryError(error, {
            source: "analytics.tanstack_ai",
            trace_id: config.traceId,
          });
        }
      },
    },
  };
};
