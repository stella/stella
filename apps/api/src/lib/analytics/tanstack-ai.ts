import type { ChatMiddleware } from "@tanstack/ai";
import { Result } from "better-result";

import type { ModelRole } from "@stll/ai-catalog";

import type { SafeDb } from "@/api/db";
import type { UsageActionType, UsageServiceTier } from "@/api/db/schema";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { captureError as captureTelemetryError } from "@/api/lib/analytics";
import type { SafeId } from "@/api/lib/branded-types";
import { errorTag } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
import {
  getTanStackTextModelInfoForRole,
  resolveEffectiveServiceTierForProvider,
  type ResolvedTanStackTextModelInfo,
} from "@/api/lib/tanstack-ai-models";
import { recordUsageEvent } from "@/api/lib/usage";
import { usageUnitsFromTokens } from "@/api/lib/usage/unit-model";

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

export type TanStackAIUsageMetering = {
  actionType: UsageActionType;
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
  analytics?: Analytics;
  modelRole?: ModelRole;
  orgAIConfig?: OrgAIConfig | null;
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

const getUsageCacheReadTokens = (usage: {
  promptTokensDetails?: { cachedTokens?: number | undefined } | undefined;
}): number => usage.promptTokensDetails?.cachedTokens ?? 0;

const recordTanStackConsumption = async ({
  cacheReadTokens,
  completionTokens,
  config,
  modelInfo,
  promptTokens,
}: {
  cacheReadTokens: number;
  completionTokens: number;
  config: TanStackAIAnalyticsProps;
  modelInfo: ResolvedTanStackTextModelInfo;
  promptTokens: number;
}): Promise<void> => {
  const metering = config.usageMetering;
  if (!metering) {
    return;
  }

  const serviceTier = resolveTanStackEffectiveServiceTier({
    modelInfo,
    serviceTier: metering.serviceTier,
  });
  const { unitsConsumed, rawUsageMicroUnits } = usageUnitsFromTokens({
    actionType: metering.actionType,
    cacheReadTokens,
    inputTokens: promptTokens,
    isByok: modelInfo.keySource === "byok",
    modelId: modelInfo.modelId,
    outputTokens: completionTokens,
    serviceTier,
  });

  const result = await metering.safeDb(
    async (tx) =>
      await recordUsageEvent({
        tx,
        actionType: metering.actionType,
        unitsConsumed,
        isByok: modelInfo.keySource === "byok",
        modelRole: config.modelRole ?? "chat",
        organizationId: metering.organizationId,
        rawUsageMicroUnits,
        serviceTier,
        traceId: config.traceId,
        userId: metering.userId,
        workspaceId: metering.workspaceId,
      }),
  );

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
  const modelInfo = getTanStackTextModelInfoForRole(
    modelRole,
    config.orgAIConfig,
    {
      organizationId: config.usageMetering?.organizationId ?? null,
    },
  );
  const startedAt = performance.now();
  let hasCapturedGenerationError = false;
  let toolCount = 0;

  const captureGenerationError = (error: unknown) => {
    if (hasCapturedGenerationError) {
      return;
    }
    hasCapturedGenerationError = true;

    logger.error("tanstack_ai.generation.failed", {
      "error.type": errorTag(error),
      "ai.feature": config.feature,
      "ai.provider": modelInfo.provider,
      "ai.model": modelInfo.modelId,
    });
    captureTelemetryError(error, {
      feature: config.feature,
      organization_id: config.usageMetering?.organizationId ?? "",
      trace_id: config.traceId,
    });

    analytics.capture({
      distinctId,
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
        model: modelInfo.modelId,
        model_key_source: modelInfo.keySource,
        provider: modelInfo.provider,
        ...(modelInfo.region ? { region: modelInfo.region } : {}),
      },
    });
  };

  return {
    captureError: captureGenerationError,
    middleware: {
      name: "stella-tanstack-analytics",
      onAfterToolCall: () => {
        toolCount += 1;
      },
      onError: (_ctx, { error }) => {
        captureGenerationError(error);
      },
      onFinish: (_ctx, { duration, usage }) => {
        if (!usage) {
          return;
        }

        analytics.capture({
          distinctId,
          event: SERVER_ANALYTICS_EVENTS.aiGenerationCompleted,
          properties: {
            ...pickSafeMetadata(config.properties),
            feature: config.feature,
            input_tokens_bucket: bucketTokenCount(usage.promptTokens),
            latency_bucket: bucketLatency(duration / ONE_SECOND_MS),
            model: modelInfo.modelId,
            model_key_source: modelInfo.keySource,
            output_tokens_bucket: bucketTokenCount(usage.completionTokens),
            provider: modelInfo.provider,
            ...(modelInfo.region ? { region: modelInfo.region } : {}),
            tool_count_bucket: bucketCount(toolCount),
            total_tokens_bucket: bucketTokenCount(usage.totalTokens),
          },
        });
      },
      onUsage: (ctx, usage) => {
        const consumption = recordTanStackConsumption({
          cacheReadTokens: getUsageCacheReadTokens(usage),
          completionTokens: usage.completionTokens,
          config,
          modelInfo,
          promptTokens: usage.promptTokens,
        });
        ctx.defer(consumption);
      },
    },
  };
};
