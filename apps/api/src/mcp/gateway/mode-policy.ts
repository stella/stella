import type { McpMode } from "@/api/mcp/constants";

/** Both dynamic gateway kinds require the advanced surface. */
export const modeAllowsGatewayTools = (mode: McpMode): boolean =>
  mode === "advanced";
