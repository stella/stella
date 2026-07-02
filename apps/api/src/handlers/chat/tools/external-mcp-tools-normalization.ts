import type {
  ChatTool,
  ChatToolMap,
} from "@/api/handlers/chat/tools/chat-tool-types";
import {
  applyChatToolPolicies,
  CHAT_TOOL_POLICY_KIND,
} from "@/api/handlers/chat/tools/tool-policy";
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

  // External MCP tools must always require approval here, regardless of the
  // upstream server's own (possibly absent) `needsApproval` flag. These
  // normalized tools back both schema validation and the live `mcp` source
  // handed to `chat()`, so the policy is stamped on the exact objects the
  // model can invoke, rather than relying on a `getChatTools` caller.
  return {
    toolNames,
    tools: applyChatToolPolicies({
      defaultPolicyKind: CHAT_TOOL_POLICY_KIND.external,
      tools: loadedTools,
    }),
  };
};
