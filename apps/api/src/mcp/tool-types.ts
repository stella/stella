import type {
  CallToolResult,
  Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js";

import type { env } from "@/api/env";
import type { MCP_ALL_RESOURCE_SCOPES } from "@/api/mcp/constants";
import type { McpRequestContext } from "@/api/mcp/context";
import type { TextWindowResult } from "@/api/mcp/tool-utils";

export type JsonSchema = McpTool["inputSchema"];

export type ToolScope = (typeof MCP_ALL_RESOURCE_SCOPES)[number];

/**
 * Deployment feature flag that gates a tool's backing surface. Derived
 * structurally from the `FEATURE_*` keys of the API env schema, so a tool can
 * only name a flag that actually exists: a typo or a removed flag fails
 * typecheck. A tool tagged with a flag is advertised and dispatchable only when
 * that flag is on (or the deployment is running in dev); see
 * `isMcpToolFeatureEnabled` in `gateway/list-tools.ts`.
 */
export type McpToolFeatureFlag = Extract<keyof typeof env, `FEATURE_${string}`>;

/**
 * Closed set of reasons a tool is kept off the anonymized surface. No
 * freetext: adding a tool forces one of these, and the projection in
 * `static-tool-definitions.ts` can only reason about known reasons.
 */
export const MCP_ANONYMIZED_EXCLUSION_REASONS = [
  /** Mutating tool. The anonymized surface is egress-only, so writes never appear. */
  "write",
  /**
   * User-managed skill or external MCP connector tool. These are resolved by the
   * dynamic gateway (default mode only) and are never part of the anonymized
   * surface.
   */
  "dynamic_gateway",
] as const;

export type McpAnonymizedExclusionReason =
  (typeof MCP_ANONYMIZED_EXCLUSION_REASONS)[number];

/**
 * Every tool declares how it behaves on the anonymized MCP surface. The
 * anonymized tool list and its `stella:*_anonymized` scopes are a pure
 * projection of this policy (see `static-tool-definitions.ts`), so a tool
 * cannot appear in anonymized mode without an explicit decision here.
 */
export type McpAnonymizedPolicy =
  | {
      exposure: "anonymize";
      /**
       * Output text fields the central egress pipeline redacts before
       * windowing, in the order they are fed to the redactor. Documents the
       * egress contract; the registry test asserts it is non-empty.
       */
      textFields: readonly string[];
      /**
       * Description shown on the anonymized surface when it must differ from the
       * default description (e.g. "Search anonymized knowledge ..."). Omitted
       * when the default description already fits.
       */
      description?: string;
    }
  | { exposure: "passthrough" }
  | { exposure: "excluded"; reason: McpAnonymizedExclusionReason };

export type McpToolDefinition = {
  annotations?: McpTool["annotations"];
  anonymized: McpAnonymizedPolicy;
  description: string;
  /**
   * Deployment feature flag gating this tool. When set, the tool is dropped
   * from the advertised list and its dispatch is rejected unless the flag is on
   * (or the deployment runs in dev). Omitted for always-available tools.
   */
  feature?: McpToolFeatureFlag;
  inputSchema: JsonSchema;
  name: string;
  scope: ToolScope;
};

/**
 * Compat search hit before egress. Carries `workspaceId` so the egress pipeline
 * can group per-workspace anonymization; the field is stripped before the
 * result reaches the client.
 */
export type McpCompatSearchResult = {
  id: string;
  title: string;
  url: string;
  workspaceId: string;
};

/**
 * One anonymizable text field inside a generic `structured` egress payload.
 * `workspaceId` is the anonymization scope: a real workspace id for
 * matter/document payloads, or the organization id for org-scoped payloads
 * (contacts, templates). Fields sharing a scope are batched into a single
 * `anonymizeTextFields` call so placeholders stay consistent across them.
 * `apply` writes the anonymized value back into the payload the plan carries
 * (in default mode the field is left exactly as the handler produced it).
 */
export type McpStructuredTextField = {
  apply: (value: string) => void;
  value: string;
  workspaceId: string;
};

/**
 * Optional post-anonymization windowing of one text field on a `structured`
 * plan. `read` returns the full text to window (already anonymized in
 * anonymized mode, because the text field ran through `textFields` first);
 * `apply` writes the windowed slice plus its cursor/charCount/truncated
 * metadata back into the payload. Windowing runs after anonymization so an
 * entity name can never be split across a window edge.
 */
export type McpStructuredWindow = {
  apply: (window: TextWindowResult) => void;
  cursor: string | undefined;
  maxChars: number;
  read: () => string;
};

/**
 * A handler either returns a finished `CallToolResult`, or an egress plan the
 * dispatch layer finalizes (anonymize declared text fields, then window, then
 * serialize). Egress plans keep the full, pre-window, un-anonymized payload so
 * the central pipeline can anonymize before it windows, without the handler
 * ever seeing the request mode.
 *
 * The `structured` variant is the generic shape: the handler builds the whole
 * response object and declares which text fields to anonymize (with per-field
 * workspace attribution, so multi-tenant payloads like search hits and matter
 * lists group correctly) plus an optional field to window afterwards. The
 * `compatSearch`/`compatFetch` variants predate it and stay as-is: they carry
 * OpenAI-compatible-specific shaping (workspaceId stripping, anonymization
 * metadata) that does not generalize.
 */
export type McpEgressPlan =
  | {
      egress: "compatSearch";
      nextCursor: string | null | undefined;
      results: readonly McpCompatSearchResult[];
    }
  | {
      egress: "compatFetch";
      cursor: string | undefined;
      id: string;
      maxChars: number;
      text: string;
      title: string;
      url: string;
      workspaceId: string;
    }
  | {
      egress: "structured";
      payload: unknown;
      textFields: readonly McpStructuredTextField[];
      window?: McpStructuredWindow;
    };

export type McpToolResponse = CallToolResult | McpEgressPlan;

export const isMcpEgressPlan = (
  response: McpToolResponse,
): response is McpEgressPlan =>
  // SAFETY: `CallToolResult` has no `egress` key, so its presence discriminates
  // the egress-plan variants from a finished result. `CallToolResult` is an
  // external SDK type we cannot brand with a shared discriminator.
  "egress" in response;

export type McpToolHandler = ({
  args,
  context,
}: {
  args: Record<string, unknown>;
  context: McpRequestContext;
}) => Promise<McpToolResponse>;
