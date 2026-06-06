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

export const getAppBaseUrl = () => env.FRONTEND_URL.replace(/\/$/u, "");

export const stringProp = (
  description: string,
  opts?: { maxLength?: number },
) =>
  ({
    type: "string",
    description,
    ...(opts?.maxLength === undefined ? {} : { maxLength: opts.maxLength }),
  }) as const;

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
  opts?: { maxLength?: number },
): string | CallToolResult => {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    return errorResult(`Missing required parameter: ${key}`);
  }
  if (opts?.maxLength !== undefined && value.length > opts.maxLength) {
    return errorResult(
      `Parameter ${key} exceeds maximum length of ${opts.maxLength}`,
    );
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

const slugifyCaseNumber = (caseNumber: string) =>
  slugifyCaseLawPathSegment(caseNumber);

const UNKNOWN_DATE_SEGMENT = "unknown-date";
const UNKNOWN_COURT_SEGMENT = "unknown-court";
const LANGUAGE_SEGMENT_REGEX = /^(?=.{2,8}$)[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/u;

const trimSlugHyphens = (value: string): string => {
  let start = 0;
  while (value.at(start) === "-") {
    start += 1;
  }

  let end = value.length;
  while (end > start && value.at(end - 1) === "-") {
    end -= 1;
  }

  return value.slice(start, end);
};

const slugifyCaseLawPathSegment = (value: string): string => {
  const slug = trimSlugHyphens(
    value
      .normalize("NFKD")
      .toLowerCase()
      .replace(/\p{Diacritic}/gu, "")
      .replace(/[^a-z0-9]+/gu, "-"),
  );

  return slug.length > 0 ? slug : "unknown";
};

const normalizeCaseLawStoredSlug = (
  slug: string | null | undefined,
): string | null => {
  if (!slug?.trim()) {
    return null;
  }

  return slugifyCaseLawPathSegment(slug);
};

const normalizeCaseLawLanguageSegment = (
  language: string | null | undefined,
): string | null => {
  const normalized = language?.trim().toLowerCase().replace(/_/gu, "-");
  if (!normalized || !LANGUAGE_SEGMENT_REGEX.test(normalized)) {
    return null;
  }

  return normalized;
};

const formatDecisionDateSegment = (value: Date | string | null): string => {
  if (value === null) {
    return UNKNOWN_DATE_SEGMENT;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? UNKNOWN_DATE_SEGMENT
      : value.toISOString().slice(0, 10);
  }

  const rawDate = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/u.test(rawDate)) {
    return rawDate;
  }

  const date = new Date(rawDate);
  return Number.isNaN(date.getTime())
    ? UNKNOWN_DATE_SEGMENT
    : date.toISOString().slice(0, 10);
};

const isCaseLawLanguageAlternate = (
  alternate: unknown,
): alternate is { language: string } =>
  typeof alternate === "object" &&
  alternate !== null &&
  "language" in alternate &&
  typeof alternate.language === "string";

const getCaseLawLanguageAlternateCount = ({
  languageAlternateCount,
  languageAlternates,
}: {
  languageAlternateCount?: number | null | undefined;
  languageAlternates?: readonly unknown[] | null | undefined;
}): number => {
  if (languageAlternateCount !== null && languageAlternateCount !== undefined) {
    return languageAlternateCount;
  }

  if (!languageAlternates) {
    return 0;
  }

  const languages = new Set<string>();
  for (const alternate of languageAlternates) {
    if (!isCaseLawLanguageAlternate(alternate)) {
      continue;
    }

    const normalized = normalizeCaseLawLanguageSegment(alternate.language);
    if (normalized !== null) {
      languages.add(normalized);
    }
  }

  return languages.size;
};

export const buildCaseLawDecisionUrl = ({
  caseNumber,
  country,
  court,
  decisionDate,
  language,
  languageAlternateCount,
  languageAlternates,
  slug,
}: {
  caseNumber: string;
  country: string;
  court: string;
  decisionDate: Date | string | null;
  language?: string | null | undefined;
  languageAlternateCount?: number | null | undefined;
  languageAlternates?: readonly unknown[] | null | undefined;
  slug?: string | null | undefined;
}) => {
  const languageSegment = normalizeCaseLawLanguageSegment(language);
  const courtSegment =
    court.trim().length > 0
      ? slugifyCaseLawPathSegment(court)
      : UNKNOWN_COURT_SEGMENT;
  const basePath = `${getAppBaseUrl()}/law/${country.toLowerCase()}/cases/${courtSegment}/${formatDecisionDateSegment(decisionDate)}`;
  const decisionSlug =
    normalizeCaseLawStoredSlug(slug) ?? slugifyCaseNumber(caseNumber);

  if (
    languageSegment !== null &&
    getCaseLawLanguageAlternateCount({
      languageAlternateCount,
      languageAlternates,
    }) > 1
  ) {
    return `${basePath}/${languageSegment}/${decisionSlug}`;
  }

  return `${basePath}/${decisionSlug}`;
};

export const getOrgTools = (context: McpRequestContext) =>
  createOrgTools({
    accessibleWorkspaceIds: context.accessibleWorkspaceIds,
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
