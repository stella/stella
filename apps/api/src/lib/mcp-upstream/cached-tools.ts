import type { ListToolsResult } from "@ai-sdk/mcp";

import type { CachedMcpToolDefinition } from "@/api/db/schema";
import { LIMITS } from "@/api/lib/limits";

import { namespaceMcpToolName, shortToolNameHash } from "./namespace";

type ToolAnnotationInput = {
  readOnlyHint?: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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

type DiscoveredMcpTool = ListToolsResult["tools"][number];

type CachedToolCandidate = {
  baseName: string;
  tool: DiscoveredMcpTool;
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
  tools: ListToolsResult["tools"];
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
    const exposedName = uniqueExposedToolName({
      baseName,
      hasSanitizedCollision: (baseNameCounts.get(baseName) ?? 0) > 1,
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

const isCacheableTool = (tool: DiscoveredMcpTool): boolean =>
  tool.name.length > 0 &&
  tool.name.length <= LIMITS.mcpGatewayToolNameMaxChars &&
  isValidInputSchema(tool.inputSchema);

const uniqueExposedToolName = ({
  baseName,
  hasSanitizedCollision,
  rawName,
  seen,
}: {
  baseName: string;
  hasSanitizedCollision: boolean;
  rawName: string;
  seen: Set<string>;
}): string => {
  const preferredName = hasSanitizedCollision
    ? `${baseName}_${shortToolNameHash(rawName)}`
    : baseName;
  if (!seen.has(preferredName)) {
    seen.add(preferredName);
    return preferredName;
  }

  for (let attempt = 2; attempt < 100; attempt += 1) {
    const candidate = `${preferredName}_${attempt}`;
    if (!seen.has(candidate)) {
      seen.add(candidate);
      return candidate;
    }
  }

  return `${preferredName}_${Bun.randomUUIDv7().slice(0, 8)}`;
};

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

  if (
    typeof exposedName !== "string" ||
    exposedName.length === 0 ||
    exposedName.length > LIMITS.mcpGatewayToolNameMaxChars * 3
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
