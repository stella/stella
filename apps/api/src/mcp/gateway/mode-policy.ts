import type { McpMode } from "@/api/mcp/constants";

export const GATEWAY_TOOL_KIND = {
  externalMcp: "external_mcp",
  skill: "skill",
} as const;

export type GatewayToolKind =
  (typeof GATEWAY_TOOL_KIND)[keyof typeof GATEWAY_TOOL_KIND];

/** The single visibility and dispatch policy for dynamic gateway tools. */
export const modeAllowsGatewayTools = (
  mode: McpMode,
  kind: GatewayToolKind,
): boolean =>
  kind === GATEWAY_TOOL_KIND.externalMcp
    ? mode === "advanced"
    : mode === "default" || mode === "advanced";
