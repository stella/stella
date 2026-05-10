import type { ResolvedModelInfo } from "@/api/lib/ai-models";

export const SERVER_ANALYTICS_EVENTS = {
  aiGeneration: "$ai_generation",
  aiGenerationCompleted: "ai_generation_completed",
  aiGenerationFailed: "ai_generation_failed",
  aiSpan: "$ai_span",
  exception: "$exception",
} as const;

export type AnalyticsPrimitive = boolean | number | string;

export type TokenBucket = "0_1k" | "1k_5k" | "5k_20k" | "20k_plus";
export type LatencyBucket = "0_2s" | "2_10s" | "10_30s" | "30s_plus";
export type CountBucket = "0" | "1" | "2_3" | "4_plus";
export type ModelKeySource = ResolvedModelInfo["keySource"] | "unknown";
export type AIFailureReason =
  | "auth"
  | "byok_quota"
  | "configuration"
  | "provider"
  | "rate_limit"
  | "timeout"
  | "unknown"
  | "validation";

export type SafeAIAnalyticsMetadata = {
  content_type?: AnalyticsPrimitive;
  feature_area?: AnalyticsPrimitive;
  file_count?: AnalyticsPrimitive;
  language?: AnalyticsPrimitive;
  organization_id?: AnalyticsPrimitive;
  page_number?: AnalyticsPrimitive;
  property_count?: AnalyticsPrimitive;
  result_count?: AnalyticsPrimitive;
  workspace_id?: AnalyticsPrimitive;
};

type AIModelTelemetryProperties = {
  feature: string;
  model: string;
  model_key_source: ModelKeySource;
  provider: string;
  region?: string;
};

export type AIGenerationCompletedProperties = AIModelTelemetryProperties &
  SafeAIAnalyticsMetadata & {
    input_tokens_bucket: TokenBucket;
    latency_bucket: LatencyBucket;
    output_tokens_bucket: TokenBucket;
    tool_count_bucket: CountBucket;
    total_tokens_bucket: TokenBucket;
  };

export type AIGenerationFailedProperties = SafeAIAnalyticsMetadata & {
  error_message?: string;
  error_message_kind?: "non_standard";
  error_type: string;
  failure_reason: AIFailureReason;
  feature: string;
  latency_bucket?: LatencyBucket;
  model?: string;
  model_key_source?: ModelKeySource;
  provider?: string;
  region?: string;
};

export type ExceptionListEntry = {
  mechanism: { handled: boolean; synthetic: boolean; type: string };
  type: string;
  value: string;
};

export type ExceptionProperties = {
  [key: string]: ExceptionListEntry[] | string | undefined;
  $exception_level: string;
  $exception_list: ExceptionListEntry[];
  $exception_type: string;
  organization_id?: string;
  session_id?: string;
};

type DebugAIProperties = Record<string, unknown>;

export type ServerAnalyticsCaptureParams =
  | {
      distinctId: string;
      event: typeof SERVER_ANALYTICS_EVENTS.aiGeneration;
      properties: DebugAIProperties;
    }
  | {
      distinctId: string;
      event: typeof SERVER_ANALYTICS_EVENTS.aiGenerationCompleted;
      properties: AIGenerationCompletedProperties;
    }
  | {
      distinctId: string;
      event: typeof SERVER_ANALYTICS_EVENTS.aiGenerationFailed;
      properties: AIGenerationFailedProperties;
    }
  | {
      distinctId: string;
      event: typeof SERVER_ANALYTICS_EVENTS.aiSpan;
      properties: DebugAIProperties;
    }
  | {
      distinctId: string;
      event: typeof SERVER_ANALYTICS_EVENTS.exception;
      properties: ExceptionProperties;
    };

export type Analytics = {
  capture: (params: ServerAnalyticsCaptureParams) => void;
  /** Flush queued events. No-op for providers without a queue. */
  flush: () => Promise<void>;
};
