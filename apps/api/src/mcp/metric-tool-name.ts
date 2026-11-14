import {
  isExternalMcpToolName,
  isSkillToolName,
} from "@/api/lib/mcp-upstream/namespace";
import type { McpMode } from "@/api/mcp/constants";
import { getStaticMcpToolDefinition } from "@/api/mcp/static-tool-definitions";

/** Keeps tenant-defined names out of telemetry while preserving static names. */
export const classifyMcpMetricToolName = (
  toolName: string,
  mode: McpMode,
): string => {
  const definition = getStaticMcpToolDefinition(toolName, mode);
  if (definition !== undefined) {
    return definition.name;
  }
  if (isExternalMcpToolName(toolName)) {
    return "external_mcp";
  }
  if (isSkillToolName(toolName)) {
    return "skill";
  }
  return "unknown";
};
