import type {
  OutlookIngestionHost,
  OutlookIngestionPlatform,
} from "@stll/api-contract";

import type { SafeId } from "@/api/lib/branded-types";
import type { ResolvedTanStackTextModelInfo } from "@/api/lib/tanstack-ai-models";

export const SERVER_ANALYTICS_EVENTS = {
  aiGeneration: "$ai_generation",
  aiGenerationCompleted: "ai_generation_completed",
  aiGenerationFailed: "ai_generation_failed",
  exception: "$exception",
  outlookEmailIngestion: "outlook_email_ingestion",
} as const;

export type AnalyticsPrimitive = boolean | number | string;

export type TokenBucket = "0_1k" | "1k_5k" | "5k_20k" | "20k_plus";
export type LatencyBucket = "0_2s" | "2_10s" | "10_30s" | "30s_plus";
export type CountBucket = "0" | "1" | "2_3" | "4_plus";
export type ModelKeySource =
  | ResolvedTanStackTextModelInfo["keySource"]
  | "unknown";
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
  // Corpus jurisdiction of the underlying legal content (`CZE`, `EU`, ...);
  // an event property rather than a group because it is a closed enum, not
  // an entity with a profile.
  jurisdiction?: AnalyticsPrimitive;
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

export type OutlookEmailIngestionProperties = {
  aggregate_attachment_bytes?: number;
  attachment_count: number;
  durable_state: string;
  host?: OutlookIngestionHost;
  host_version?: string;
  mailbox_requirement_set_supported?: boolean;
  operation: "abort" | "finalize" | "reconcile" | "reserve";
  organization_id: string;
  outcome:
    | "complete"
    | "in_progress"
    | "retryable_failure"
    | "terminal_failure";
  platform?: OutlookIngestionPlatform;
  retry_stage:
    | "abort"
    | "finalize"
    | "none"
    | "reconcile"
    | "reserve"
    | "upload";
  trace_id: string;
  workspace_id: string;
};

type DebugAIProperties = Record<string, unknown>;

// PostHog group attachment. `organization` is the only group type; it must
// match the browser adapter's `posthog.group` call so client and server
// events aggregate under the same group.
export type ServerAnalyticsGroups = {
  organization: string;
};

type ServerAnalyticsCaptureBase = {
  distinctId: string;
  groups?: ServerAnalyticsGroups;
};

export type ServerAnalyticsCaptureParams = ServerAnalyticsCaptureBase &
  (
    | {
        event: typeof SERVER_ANALYTICS_EVENTS.aiGeneration;
        properties: DebugAIProperties;
      }
    | {
        event: typeof SERVER_ANALYTICS_EVENTS.aiGenerationCompleted;
        properties: AIGenerationCompletedProperties;
      }
    | {
        event: typeof SERVER_ANALYTICS_EVENTS.aiGenerationFailed;
        properties: AIGenerationFailedProperties;
      }
    | {
        event: typeof SERVER_ANALYTICS_EVENTS.exception;
        properties: ExceptionProperties;
      }
    | {
        event: typeof SERVER_ANALYTICS_EVENTS.outlookEmailIngestion;
        properties: OutlookEmailIngestionProperties;
      }
  );

// Group-profile properties for an organization; each is upserted by the
// code path that owns the state it mirrors (creation/rename for `name`,
// settings for jurisdictions). `groupIdentify` merges properties into the
// existing profile, so a caller sends only the keys it owns.
export type OrganizationGroupProperties = {
  name: string;
  practice_jurisdictions: string[];
  primary_jurisdiction: string | null;
};

export type OrganizationGroupIdentifyParams = {
  organizationId: SafeId<"organization">;
  properties: Partial<OrganizationGroupProperties>;
};

export type Analytics = {
  capture: (params: ServerAnalyticsCaptureParams) => void;
  /** Upsert the organization group profile in PostHog. */
  identifyOrganizationGroup: (params: OrganizationGroupIdentifyParams) => void;
  /** Flush queued events. No-op for providers without a queue. */
  flush: () => Promise<void>;
};
