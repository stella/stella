import type {
  ChatTool,
  ChatToolMap,
} from "@/api/handlers/chat/tools/chat-tool-types";
import {
  applyChatToolPolicies,
  CHAT_TOOL_POLICY_KIND,
} from "@/api/handlers/chat/tools/tool-policy";
import { namespaceMcpToolName } from "@/api/lib/mcp-upstream/namespace";
import { logger } from "@/api/lib/observability/logger";
import type { NullUnionStrategy } from "@/api/lib/provider-safe-json-schema";
import { projectToProviderSafeJsonSchema } from "@/api/lib/provider-safe-json-schema";

// External MCP tools arrive with a raw JSON Schema `inputSchema` straight from
// the upstream server (see `toServerTools` in @tanstack/ai-mcp). Providers such
// as Gemini reject schemas that carry keywords outside their OpenAPI-3.0
// subset, so project each one into the portable subset before it backs schema
// validation and the live `mcp` source. Actual Standard Schema wrappers are
// first-party tools already projected at their own seam and are left untouched.
const isPlainJsonSchema = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStandardSchemaInput = (value: unknown): boolean => {
  if (!isPlainJsonSchema(value)) {
    return false;
  }
  const standard = value["~standard"];
  return (
    isPlainJsonSchema(standard) && typeof standard["validate"] === "function"
  );
};

const projectExternalMcpToolSchema = (
  tool: ChatTool,
  nullUnionStrategy: NullUnionStrategy,
): ChatTool => {
  const { inputSchema } = tool;
  if (!isPlainJsonSchema(inputSchema) || isStandardSchemaInput(inputSchema)) {
    return tool;
  }

  const { schema, droppedKeywords } = projectToProviderSafeJsonSchema(
    inputSchema,
    {
      nullUnionStrategy,
    },
  );
  if (droppedKeywords.length > 0) {
    // Telemetry only: never throw. External MCP metadata is user-configured, so
    // log only aggregate projection data.
    logger.warn("Projected external MCP tool schema to provider-safe subset", {
      "schema.dropped_keyword_count": droppedKeywords.length,
    });
  }

  return { ...tool, inputSchema: schema };
};

type NormalizeExternalMcpToolsForChatInput = {
  allowedTools: readonly string[] | null;
  connectorSlug: string;
  nullUnionStrategy: NullUnionStrategy;
  tools: readonly ChatTool[];
};

type NormalizedExternalMcpToolsForChat = {
  toolNames: string[];
  tools: ChatToolMap;
};

export const normalizeExternalMcpToolsForChat = ({
  allowedTools,
  connectorSlug,
  nullUnionStrategy,
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
    loadedTools[exposedToolName] = projectExternalMcpToolSchema(
      {
        ...toolDefinition,
        name: exposedToolName,
        lazy: true,
      },
      nullUnionStrategy,
    );
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
