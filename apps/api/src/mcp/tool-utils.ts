import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolExecutionOptions } from "ai";
import { TaggedError } from "better-result";

import { env } from "@/api/env";
import { createOrgTools } from "@/api/handlers/chat/tools/org-tools";
import type { McpRequestContext } from "@/api/mcp/context";
import { getAccessibleWorkspaceId } from "@/api/mcp/context";

export const DEFAULT_LIST_LIMIT = 25;
export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_LIST_LIMIT = 100;
export const MAX_SEARCH_LIMIT = 20;
export const DEFAULT_COMPAT_SEARCH_LIMIT = 8;

export const MCP_TOOL_EXECUTION_OPTIONS: ToolExecutionOptions = {
  messages: [],
  toolCallId: "mcp",
};

const getAppBaseUrl = () => env.FRONTEND_URL.replace(/\/$/, "");

export const stringProp = (description: string) =>
  ({ type: "string", description }) as const;

export const intProp = (
  description: string,
  opts?: { max?: number; min?: number },
) =>
  ({
    type: "integer",
    description,
    ...(opts?.min === undefined ? {} : { minimum: opts.min }),
    ...(opts?.max === undefined ? {} : { maximum: opts.max }),
  }) as const;

export const enumProp = (description: string, values: readonly string[]) =>
  ({ type: "string", enum: values, description }) as const;

export const textResult = (data: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
});

export const errorResult = (message: string): CallToolResult => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

export const hasErrorMessage = (value: unknown): value is { error: string } => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  if (!("error" in value)) {
    return false;
  }

  return typeof value.error === "string" && value.error.length > 0;
};

/** Map errors thrown from chat tool `execute` into MCP tool results. */
export const toolThrownErrorToMcpResult = (
  err: unknown,
): CallToolResult | null => {
  if (TaggedError.is(err)) {
    return errorResult(err.message);
  }
  return null;
};

export const parseRequiredString = (
  args: Record<string, unknown>,
  key: string,
): string | CallToolResult => {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    return errorResult(`Missing required parameter: ${key}`);
  }
  return value;
};

export const parseOptionalEnum = <TValues extends readonly string[]>({
  args,
  defaultValue,
  key,
  values,
}: {
  args: Record<string, unknown>;
  defaultValue: TValues[number];
  key: string;
  values: TValues;
}): TValues[number] | CallToolResult => {
  const value = args[key];
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== "string" || !values.includes(value)) {
    return errorResult(
      `Invalid parameter: ${key}. Expected one of ${values.join(", ")}`,
    );
  }
  return value;
};

export const parseOptionalLimit = ({
  args,
  defaultValue,
  key,
  max,
}: {
  args: Record<string, unknown>;
  defaultValue: number;
  key: string;
  max: number;
}): number | CallToolResult => {
  const value = args[key];
  if (value === undefined) {
    return defaultValue;
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > max
  ) {
    return errorResult(
      `Invalid parameter: ${key}. Expected an integer between 1 and ${max}`,
    );
  }
  return value;
};

export const ensureWorkspaceAccess = ({
  context,
  workspaceId,
}: {
  context: McpRequestContext;
  workspaceId: string;
}) =>
  getAccessibleWorkspaceId({
    accessibleWorkspaceIdSet: context.accessibleWorkspaceIdSet,
    workspaceId,
  });

export const buildMatterUrl = (workspaceId: string) =>
  `${getAppBaseUrl()}/workspaces/${workspaceId}`;

export const buildDocumentUrl = ({
  entityId,
  fieldId,
  workspaceId,
}: {
  entityId: string;
  fieldId: string;
  workspaceId: string;
}) =>
  `${getAppBaseUrl()}/workspaces/${workspaceId}/all/pdf?entity=${encodeURIComponent(entityId)}&field=${encodeURIComponent(fieldId)}`;

export const getOrgTools = (context: McpRequestContext) =>
  createOrgTools({
    organizationId: context.organizationId,
    scopedDb: context.scopedDb,
  });

export const invokeAiTool = async <TArgs extends Record<string, unknown>>({
  args,
  tool,
}: {
  args: TArgs;
  tool: {
    execute?: (args: TArgs, options: ToolExecutionOptions) => unknown;
  };
}): Promise<CallToolResult> => {
  if (!tool.execute) {
    return errorResult("Tool is not executable");
  }

  try {
    const result = await tool.execute(args, MCP_TOOL_EXECUTION_OPTIONS);
    if (hasErrorMessage(result)) {
      return errorResult(result.error);
    }
    return textResult(result);
  } catch (error) {
    const mapped = toolThrownErrorToMcpResult(error);
    if (mapped) {
      return mapped;
    }
    throw error;
  }
};

export const normalizeTextField = ({
  allowEmptyFallback = true,
  fallback,
  missingFallback,
  value,
}: {
  allowEmptyFallback?: boolean;
  fallback: string;
  missingFallback?: string;
  value: string | undefined;
}) => {
  if (value === undefined) {
    return missingFallback ?? fallback;
  }

  if (!allowEmptyFallback) {
    return value;
  }

  return value.length > 0 ? value : fallback;
};
