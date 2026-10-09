import { MCP_TOOL_NAME_PATTERN } from "@stll/api-contract/mcp-tool-name";

import type { CachedMcpToolDefinition } from "@/api/db/schema";
import { LIMITS } from "@/api/lib/limits";
import { isRecord } from "@/api/lib/type-guards";

import {
  collisionSafeToolName,
  EMITTED_TOOL_NAME_MAX_LENGTH,
  namespaceMcpToolName,
  sanitizeToolNamePart,
} from "./namespace";

type ToolAnnotationInput = {
  readOnlyHint?: unknown;
};

const stringValue = (value: unknown, maxLength: number): string | undefined =>
  typeof value === "string" ? value.slice(0, maxLength) : undefined;

const readOnlyHint = (annotations: unknown): boolean | undefined => {
  if (!isRecord(annotations)) {
    return undefined;
  }

  const candidate: ToolAnnotationInput = annotations;
  return typeof candidate.readOnlyHint === "boolean"
    ? candidate.readOnlyHint
    : undefined;
};

type DiscoveredMcpTool = {
  annotations?: unknown;
  description?: string | undefined;
  inputSchema?: unknown;
  name: string;
  title?: unknown;
};

type CacheableDiscoveredMcpTool = DiscoveredMcpTool & {
  inputSchema: { type: "object"; [key: string]: unknown };
};

type CachedToolCandidate = {
  baseName: string;
  tool: CacheableDiscoveredMcpTool;
};

const isValidInputSchema = (
  value: unknown,
): value is { type: "object"; [key: string]: unknown } => {
  if (!isRecord(value) || value["type"] !== "object") {
    return false;
  }

  try {
    return JSON.stringify(value).length <= LIMITS.mcpGatewayToolSchemaMaxChars;
  } catch {
    return false;
  }
};

export const normalizeDiscoveredMcpTools = ({
  connectorSlug,
  tools,
}: {
  connectorSlug: string;
  tools: readonly DiscoveredMcpTool[];
}): CachedMcpToolDefinition[] => {
  const candidates: CachedToolCandidate[] = [];
  const baseNameCounts = new Map<string, number>();

  for (const tool of tools) {
    if (candidates.length >= LIMITS.mcpGatewayToolsPerConnectorMax) {
      break;
    }

    if (!isCacheableTool(tool)) {
      continue;
    }

    const baseName = namespaceMcpToolName({
      connectorSlug,
      toolName: tool.name,
    });
    candidates.push({ baseName, tool });
    baseNameCounts.set(baseName, (baseNameCounts.get(baseName) ?? 0) + 1);
  }

  const seen = new Set<string>();
  const cachedTools: CachedMcpToolDefinition[] = [];

  for (const { baseName, tool } of candidates) {
    const exposedName = collisionSafeToolName({
      baseName,
      hashFirst: (baseNameCounts.get(baseName) ?? 0) > 1,
      rawName: tool.name,
      seen,
    });
    const description = stringValue(
      tool.description,
      LIMITS.mcpGatewayToolDescriptionMaxChars,
    );
    const title = stringValue(tool.title, LIMITS.mcpGatewayToolNameMaxChars);
    const toolReadOnlyHint = readOnlyHint(tool.annotations);

    cachedTools.push({
      exposedName,
      inputSchema: tool.inputSchema,
      rawName: tool.name,
      ...(description === undefined ? {} : { description }),
      ...(title === undefined ? {} : { title }),
      ...(toolReadOnlyHint === undefined
        ? {}
        : { readOnlyHint: toolReadOnlyHint }),
    });
  }

  return cachedTools;
};

const isCacheableTool = (
  tool: DiscoveredMcpTool,
): tool is CacheableDiscoveredMcpTool =>
  tool.name.length > 0 &&
  tool.name.length <= LIMITS.mcpGatewayToolNameMaxChars &&
  isValidInputSchema(tool.inputSchema);

const isCachedToolDefinition = (
  value: unknown,
): value is CachedMcpToolDefinition => {
  if (!isRecord(value)) {
    return false;
  }

  const rawName = value["rawName"];
  const exposedName = value["exposedName"];
  const inputSchema = value["inputSchema"];
  const description = value["description"];
  const title = value["title"];
  const cachedReadOnlyHint = value["readOnlyHint"];

  if (
    typeof rawName !== "string" ||
    rawName.length === 0 ||
    rawName.length > LIMITS.mcpGatewayToolNameMaxChars
  ) {
    return false;
  }

  // An entry cached before the name contract tightened is dropped rather than
  // served: one name outside the contract makes clients reject the listing.
  if (
    typeof exposedName !== "string" ||
    exposedName.length > EMITTED_TOOL_NAME_MAX_LENGTH ||
    sanitizeToolNamePart(exposedName) !== exposedName ||
    !MCP_TOOL_NAME_PATTERN.test(exposedName)
  ) {
    return false;
  }

  if (!isValidInputSchema(inputSchema)) {
    return false;
  }

  if (
    description !== undefined &&
    (typeof description !== "string" ||
      description.length > LIMITS.mcpGatewayToolDescriptionMaxChars)
  ) {
    return false;
  }

  if (
    title !== undefined &&
    (typeof title !== "string" ||
      title.length > LIMITS.mcpGatewayToolNameMaxChars)
  ) {
    return false;
  }

  return (
    cachedReadOnlyHint === undefined || typeof cachedReadOnlyHint === "boolean"
  );
};

export const readCachedMcpTools = (
  value: unknown,
): CachedMcpToolDefinition[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const tools: CachedMcpToolDefinition[] = [];
  for (const item of value) {
    if (tools.length >= LIMITS.mcpGatewayToolsPerConnectorMax) {
      break;
    }
    if (isCachedToolDefinition(item)) {
      tools.push(item);
    }
  }

  return tools;
};
