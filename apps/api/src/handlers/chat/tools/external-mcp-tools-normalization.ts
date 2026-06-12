import type {
  ChatTool,
  ChatToolMap,
} from "@/api/handlers/chat/tools/chat-tool-types";
import { namespaceMcpToolName } from "@/api/lib/mcp-upstream/namespace";

type NormalizeExternalMcpToolsForChatInput = {
  allowedTools: readonly string[] | null;
  connectorSlug: string;
  tools: readonly ChatTool[];
};

type NormalizedExternalMcpToolsForChat = {
  toolNames: string[];
  tools: ChatToolMap;
};

export const normalizeExternalMcpToolsForChat = ({
  allowedTools,
  connectorSlug,
  tools,
}: NormalizeExternalMcpToolsForChatInput): NormalizedExternalMcpToolsForChat => {
  const allowedToolNames = allowedTools ? new Set(allowedTools) : null;
  const loadedTools: ChatToolMap = {};
  const toolNames: string[] = [];

  for (const toolDefinition of tools) {
    const rawToolName = toolDefinition.name;
    if (allowedToolNames && !allowedToolNames.has(rawToolName)) {
      continue;
    }

    toolNames.push(rawToolName);
    const exposedToolName = namespaceMcpToolName({
      connectorSlug,
      toolName: rawToolName,
    });
    loadedTools[exposedToolName] = {
      ...toolDefinition,
      name: exposedToolName,
      lazy: true,
    };
  }

  return { toolNames, tools: loadedTools };
};
