import type { SchemaInput } from "@tanstack/ai";

import {
  applyChatToolPolicies,
  CHAT_TOOL_POLICY_KIND,
} from "@/api/handlers/chat/tools/tool-policy";
import type { ChatTool, ChatToolMap } from "@/api/lib/chat/chat-tool-types";
import { namespaceMcpToolName } from "@/api/lib/mcp-upstream/namespace";
import { logger } from "@/api/lib/observability/logger";
import type { NullUnionStrategy } from "@/api/lib/provider-safe-json-schema";
import { projectToProviderSafeJsonSchema } from "@/api/lib/provider-safe-json-schema";
import type { ToolSchemaInput } from "@/api/lib/tanstack-ai-schema";
import { isStandardSchemaInput } from "@/api/lib/tanstack-ai-schema";

// External MCP tools arrive with a raw JSON Schema `inputSchema` straight from
// the upstream server (see `toServerTools` in @tanstack/ai-mcp). Providers such
// as Gemini reject schemas that carry keywords outside their OpenAPI-3.0
// subset, so project each one into the portable subset before it backs schema
// validation and the live `mcp` source. Actual Standard Schema wrappers are
// first-party tools already projected at their own seam and are left untouched.
const isPlainJsonSchema = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toChatToolSchema = (
  schema: Record<string, unknown> | undefined,
  nullUnionStrategy: NullUnionStrategy,
): ToolSchemaInput | undefined => {
  if (schema === undefined || isStandardSchemaInput(schema)) {
    return schema;
  }

  const { schema: projected, droppedKeywords } =
    projectToProviderSafeJsonSchema(schema, { nullUnionStrategy });
  if (droppedKeywords.length > 0) {
    // Telemetry only: never throw. External MCP metadata is user-configured, so
    // log only aggregate projection data.
    logger.warn("Projected external MCP tool schema to provider-safe subset", {
      "schema.dropped_keyword_count": droppedKeywords.length,
    });
  }
  return projected;
};

/**
 * A tool as an upstream MCP server or the `@tanstack/ai-mcp` client hands it
 * over: schemas typed as the library's broad `SchemaInput`, before the chat
 * boundary narrows them.
 */
type ExternalMcpTool = Omit<ChatTool, "inputSchema" | "outputSchema"> & {
  inputSchema?: SchemaInput | undefined;
  outputSchema?: SchemaInput | undefined;
};

const isExternalSchema = (
  value: unknown,
): value is Record<string, unknown> | undefined =>
  value === undefined || isPlainJsonSchema(value);

/**
 * The chat-side tool, or `null` when a schema is neither an object nor absent:
 * the chat loop cannot carry such a schema, so the tool is not offered.
 */
const projectExternalMcpTool = (
  tool: ExternalMcpTool,
  exposedToolName: string,
  nullUnionStrategy: NullUnionStrategy,
): ChatTool | null => {
  const { inputSchema, outputSchema } = tool;
  if (!isExternalSchema(inputSchema) || !isExternalSchema(outputSchema)) {
    // Telemetry only, and no tool name: external MCP metadata is user-configured.
    logger.warn("Skipped external MCP tool with a non-object schema");
    return null;
  }

  return {
    ...tool,
    name: exposedToolName,
    lazy: true,
    inputSchema: toChatToolSchema(inputSchema, nullUnionStrategy),
    outputSchema: toChatToolSchema(outputSchema, nullUnionStrategy),
  };
};

type NormalizeExternalMcpToolsForChatInput = {
  allowedTools: readonly string[] | null;
  connectorSlug: string;
  nullUnionStrategy: NullUnionStrategy;
  tools: readonly ExternalMcpTool[];
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

    const exposedToolName = namespaceMcpToolName({
      connectorSlug,
      toolName: rawToolName,
    });
    const chatTool = projectExternalMcpTool(
      toolDefinition,
      exposedToolName,
      nullUnionStrategy,
    );
    if (chatTool === null) {
      continue;
    }
    toolNames.push(rawToolName);
    loadedTools[exposedToolName] = chatTool;
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
