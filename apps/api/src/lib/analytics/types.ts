import type { SafeId } from "@/api/lib/branded-types";
import type { ResolvedTanStackTextModelInfo } from "@/api/lib/tanstack-ai-models";
import type { McpCredentialType } from "@/api/mcp/auth";
import type { McpMode } from "@/api/mcp/constants";

export const SERVER_ANALYTICS_EVENTS = {
  aiGeneration: "$ai_generation",
  aiGenerationCompleted: "ai_generation_completed",
  aiGenerationFailed: "ai_generation_failed",
  exception: "$exception",
  mcpSessionInitialized: "mcp_session_initialized",
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

/**
 * Which client opened an MCP session, from the `initialize` handshake. The
 * name and version are caller-reported, so they are capped and type-checked
 * before they reach telemetry (see `mcp/client-identity.ts`). Every event
 * carries a name, falling back to `unspecified`, so the count of events is the
 * count of handshakes; an unreported version is left out rather than invented.
 */
export type McpSessionInitializedProperties = {
  client_name: string;
  client_version?: string;
  credential_type: McpCredentialType | "unspecified";
  mode: McpMode;
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
        event: typeof SERVER_ANALYTICS_EVENTS.mcpSessionInitialized;
        properties: McpSessionInitializedProperties;
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
