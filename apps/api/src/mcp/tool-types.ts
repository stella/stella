import type {
  CallToolResult,
  Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js";

import type { MCP_ALL_RESOURCE_SCOPES } from "@/api/mcp/constants";
import type { McpRequestContext } from "@/api/mcp/context";

export type JsonSchema = McpTool["inputSchema"];

export type ToolScope = (typeof MCP_ALL_RESOURCE_SCOPES)[number];

/**
 * Closed set of reasons a tool is kept off the anonymized surface. No
 * freetext: adding a tool forces one of these, and the projection in
 * `static-tool-definitions.ts` can only reason about known reasons.
 */
export const MCP_ANONYMIZED_EXCLUSION_REASONS = [
  /** Mutating tool. The anonymized surface is egress-only, so writes never appear. */
  "write",
  /**
   * Read tool that surfaces tenant/personal text and is not yet wired into the
   * central egress pipeline. Plan 046 grows the anonymized surface to the full
   * read set; until a tool is projected it carries this reason.
   */
  "pending_projection",
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
 * A handler either returns a finished `CallToolResult`, or an egress plan the
 * dispatch layer finalizes (anonymize declared text fields, then window, then
 * serialize). Egress plans keep the full, pre-window, un-anonymized payload so
 * the central pipeline can anonymize before it windows, without the handler
 * ever seeing the request mode.
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
