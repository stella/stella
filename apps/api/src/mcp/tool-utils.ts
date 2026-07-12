import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { panic, TaggedError } from "better-result";
import * as v from "valibot";

import { env } from "@/api/env";
import { createOrgTools } from "@/api/handlers/chat/tools/org-tools";
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
import type { AccessibleWorkspace } from "@/api/lib/auth";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import { getCurrentRequestId } from "@/api/lib/observability/request-context";
import {
  decodePaginationCursor,
  encodePaginationCursor,
} from "@/api/lib/pagination";
import type { McpRequestContext } from "@/api/mcp/context";
import { getAccessibleWorkspaceId } from "@/api/mcp/context";
import type { McpErrorCode, McpValidationIssue } from "@/api/mcp/error-codes";

/**
 * Wrap the request-scoped recorder so audit rows written by the reused backing
 * handlers carry the resolved workspace. The MCP recorder binds workspaceId to
 * null (org-scoped); the shared handlers build events without a workspaceId, so
 * inject it here per event (an event that sets its own workspaceId wins).
 */
export const bindWorkspaceRecorder =
  (
    context: McpRequestContext,
    workspaceId: SafeId<"workspace">,
  ): AuditRecorder =>
  async (tx, event) => {
    const events: AuditEvent[] = Array.isArray(event) ? event : [event];
    // Events are freshly built by the backing handler and single-use, so stamp
    // the resolved workspace in place rather than cloning.
    for (const e of events) {
      if (e.workspaceId === undefined) {
        e.workspaceId = workspaceId;
      }
    }
    await context.recordAuditEvent(tx, events);
  };

export const DEFAULT_LIST_LIMIT = LIMITS.mcpListPageSizeDefault;
export const DEFAULT_SEARCH_LIMIT = LIMITS.mcpSearchPageSizeDefault;
export const MAX_LIST_LIMIT = LIMITS.mcpListPageSizeMax;
export const MAX_SEARCH_LIMIT = LIMITS.mcpSearchPageSizeMax;
export const DEFAULT_COMPAT_SEARCH_LIMIT =
  LIMITS.mcpCompatSearchPageSizeDefault;

type LocalToolExecutionOptions = {
  messages: [];
  toolCallId: string;
};

export const MCP_TOOL_EXECUTION_OPTIONS: LocalToolExecutionOptions = {
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

/**
 * A nullable string parameter. Advertises `type: ["string", "null"]` so the MCP
 * JSON schema matches a Valibot field that accepts null (the "pass null to
 * clear" convention); a plain string type would mislead callers into believing
 * null is rejected.
 */
export const nullableStringProp = (
  description: string,
  opts?: { maxLength?: number },
) =>
  ({
    type: ["string", "null"],
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

/**
 * Boolean `confirm` gate for a destructive tool. The guardrail in
 * `handleMcpToolCall` rejects a `destructiveHint` call unless `confirm === true`,
 * so every destructive tool advertises this property with the same contract:
 * set it only after a human has approved the irreversible operation. Pass a
 * custom `description` for a tool whose gate is action-scoped (e.g.
 * `manage_organization`, where only the `remove_member` action requires it).
 */
export const confirmProp = (
  description = "Must be true to run this irreversible operation. Set it only after a " +
    "human user has explicitly approved the deletion.",
) =>
  ({
    type: "boolean",
    description,
  }) as const;

export const textResult = (data: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
});

/**
 * Legacy plain-text tool error. Kept for the handful of bespoke messages that
 * have no sensible machine-readable code (e.g. cross-field validation hints
 * surfaced verbatim). New code paths should prefer `structuredErrorResult`,
 * `notFoundResult`, or the `validation_error`-tagged arg parsers below so agents
 * and the CLI can branch on a stable `error.code`.
 */
export const errorResult = (message: string): CallToolResult => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

/**
 * Hint pointing an agent at the feedback tool after an unexpected server-side
 * failure. Kept as a shared constant so the internal-error envelope reads the
 * same wherever it is produced. `send_feedback` lands in a follow-up commit on
 * this branch; the hint is stable regardless.
 */
export const MCP_INTERNAL_ERROR_HINT =
  "If this looks like a stella bug, report it with the send_feedback tool.";

/**
 * Structured tool-error envelope. The single text content is
 * `{"error":{"code","message","hint?","issues?","retryable?","requestId?"}}`;
 * `isError` is set so MCP clients still treat it as a failure. Undefined
 * `hint`/`issues`/`retryable` are omitted so the serialized shape stays minimal
 * (an empty `issues` array is treated as absent). Agents branch on `code`;
 * `hint` tells them the next step; `issues` pinpoints the failing fields on a
 * `validation_error`. `requestId` is the receipt of the active request (when one
 * is scoped) so a caller can quote the failing server-side action back to an
 * operator. The companion CLI keys its exit codes off `error.code` and renders
 * the receipt dimly.
 */
export const structuredErrorResult = ({
  code,
  hint,
  issues,
  message,
  retryable,
}: {
  code: McpErrorCode;
  hint?: string | undefined;
  issues?: readonly McpValidationIssue[] | undefined;
  message: string;
  retryable?: boolean | undefined;
}): CallToolResult => {
  const error: {
    code: McpErrorCode;
    message: string;
    hint?: string;
    issues?: readonly McpValidationIssue[];
    retryable?: boolean;
    requestId?: string;
  } = { code, message };
  if (hint !== undefined) {
    error.hint = hint;
  }
  if (issues !== undefined && issues.length > 0) {
    error.issues = issues;
  }
  if (retryable !== undefined) {
    error.retryable = retryable;
  }
  const requestId = getCurrentRequestId();
  if (requestId !== undefined) {
    error.requestId = requestId;
  }

  return {
    content: [{ type: "text", text: JSON.stringify({ error }) }],
    isError: true,
  };
};

/**
 * Map Valibot issues to the envelope's `{ path, message }` shape. `path` is the
 * issue's dot-path (`v.getDotPath`), falling back to "" for a root/whole-object
 * issue with no path (e.g. a `strictObject` unknown-key or cross-field
 * `partialCheck` forwarded to the root).
 */
export const mapValibotIssues = (
  issues: readonly v.BaseIssue<unknown>[],
): McpValidationIssue[] =>
  issues.map((issue) => ({
    path: v.getDotPath(issue) ?? "",
    message: issue.message,
  }));

/**
 * `validation_error` envelope for a failed tool argument parse. `message` is the
 * caller-facing summary (today's collapsed single line); `issues` is the raw
 * Valibot issue list, mapped to the structured `{ path, message }[]` the CLI and
 * agents branch on. This is the single sink every `safeParse` failure path in
 * the tool modules routes through, replacing the legacy code-less `errorResult`.
 */
export const validationErrorResult = ({
  hint,
  issues,
  message,
}: {
  hint?: string | undefined;
  issues: readonly v.BaseIssue<unknown>[];
  message: string;
}): CallToolResult =>
  structuredErrorResult({
    code: "validation_error",
    hint,
    issues: mapValibotIssues(issues),
    message,
  });

/** `not_found` envelope for a resource that does not exist or is inaccessible. */
export const notFoundResult = (
  message: string,
  hint?: string,
): CallToolResult =>
  structuredErrorResult({ code: "not_found", hint, message });

/**
 * Up to `limit` known tool names closest to `target` by Levenshtein distance,
 * used to hint an agent that fat-fingered a tool name. Only candidates within a
 * lenient edit budget (roughly half the longer name) are kept, so an unrelated
 * miss returns nothing rather than a confusing suggestion. No dependency: a tiny
 * DP implementation is enough for the short, small candidate set.
 */
export const closestToolNames = (
  target: string,
  candidates: readonly string[],
  limit = 3,
): string[] =>
  candidates
    .map((name) => ({ name, distance: levenshtein(target, name) }))
    .filter(({ distance, name }) => distance <= Math.ceil(name.length / 2))
    // oxlint-disable-next-line require-cached-collator/require-cached-collator -- tool names are machine identifiers (agent-facing "did you mean"), not display text
    .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map(({ name }) => name);

const levenshtein = (a: string, b: string): number => {
  // Rolling single-row DP. `previous` always holds `b.length + 1` entries and
  // every read below is in range by construction; `panic` documents that as a
  // hard invariant instead of masking an out-of-range read with a default.
  const cell = (row: readonly number[], index: number): number =>
    row[index] ?? panic("levenshtein: DP cell index out of range");

  const previous = Array.from({ length: b.length + 1 }, (_unused, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = cell(previous, 0);
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const candidate = Math.min(
        cell(previous, j) + 1,
        cell(previous, j - 1) + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = cell(previous, j);
      previous[j] = candidate;
    }
  }
  return cell(previous, b.length);
};

export const hasErrorMessage = (value: unknown): value is { error: string } => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  if (!("error" in value)) {
    return false;
  }

  return typeof value.error === "string" && value.error.length > 0;
};

/**
 * Map errors thrown from chat tool `execute` into MCP tool results. Only the
 * dynamic-gateway `invokeAiTool` path funnels through here today, and no tagged
 * error it can raise carries a not-found semantic, so every tagged error maps
 * conservatively to `internal_error`. Tagged errors are curated, surfaceable
 * messages (not raw internals), so the message is preserved; a not-found branch
 * can be added here if a not-found-tagged error is ever routed through this path.
 */
export const toolThrownErrorToMcpResult = (
  err: unknown,
): CallToolResult | null => {
  if (TaggedError.is(err)) {
    return structuredErrorResult({
      code: "internal_error",
      message: err.message,
      hint: MCP_INTERNAL_ERROR_HINT,
    });
  }
  return null;
};

/**
 * `validation_error` envelope for a bad argument, hinting at the fix. `path` is
 * the offending property name, surfaced as the single structured issue so this
 * hand-rolled parser produces the same `error.issues` shape as the Valibot
 * `safeParse` paths.
 */
const argValidationError = (
  message: string,
  hint: string,
  path: string,
): CallToolResult =>
  structuredErrorResult({
    code: "validation_error",
    hint,
    issues: [{ path, message }],
    message,
  });

export const parseRequiredString = (
  args: Record<string, unknown>,
  key: string,
  opts?: { maxLength?: number },
): string | CallToolResult => {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    return argValidationError(
      `Missing required parameter: ${key}`,
      `Provide '${key}' as a non-empty string.`,
      key,
    );
  }
  if (opts?.maxLength !== undefined && value.length > opts.maxLength) {
    return argValidationError(
      `Parameter ${key} exceeds maximum length of ${opts.maxLength}`,
      `Shorten '${key}' to at most ${opts.maxLength} characters.`,
      key,
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
    return argValidationError(
      `Invalid parameter: ${key}. Expected one of ${values.join(", ")}`,
      `Set '${key}' to one of: ${values.join(", ")}.`,
      key,
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
    return argValidationError(
      `Invalid parameter: ${key}. Expected an integer between 1 and ${max}`,
      `Set '${key}' to an integer between 1 and ${max}.`,
      key,
    );
  }
  return value;
};

export const isToolErrorResult = (value: unknown): value is CallToolResult =>
  typeof value === "object" &&
  value !== null &&
  "isError" in value &&
  value.isError === true;

const MAX_CURSOR_LENGTH = 512;

export const parseOptionalCursor = ({
  args,
  key,
}: {
  args: Record<string, unknown>;
  key: string;
}): string | undefined | CallToolResult => {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    return argValidationError(
      `Invalid parameter: ${key}. Expected an opaque cursor string`,
      `Pass the '${key}' as the opaque cursor returned by a previous call, or omit it for the first page.`,
      key,
    );
  }
  if (value.length > MAX_CURSOR_LENGTH) {
    return argValidationError(
      `Parameter ${key} exceeds maximum length of ${MAX_CURSOR_LENGTH}`,
      `Pass the '${key}' verbatim as returned; a valid cursor never exceeds ${MAX_CURSOR_LENGTH} characters.`,
      key,
    );
  }
  return value;
};

export type TextWindowResult = {
  text: string;
  charCount: number;
  nextCursor: string | null;
  truncated: boolean;
};

export type WindowBounds = {
  start: number;
  end: number;
  /** Offset to resume at for the next window, or null when fully consumed. */
  nextOffset: number | null;
};

/**
 * Resolve a half-open `[start, end)` window of `size` items into a stream of
 * `length` items, starting at `offset` (clamped into range). `nextOffset` is
 * the resume point for the next window, or null when the window reaches the
 * end. Works for any positional stream (string chars, array items).
 */
export const resolveWindowBounds = (
  length: number,
  offset: number,
  size: number,
): WindowBounds => {
  const start = Math.min(Math.max(offset, 0), length);
  const end = Math.min(start + size, length);

  return { start, end, nextOffset: end < length ? end : null };
};

const decodeTextWindowOffset = (
  cursor: string | undefined,
): number | CallToolResult => {
  if (cursor === undefined) {
    return 0;
  }
  const candidate = decodePaginationCursor(cursor)?.[0];
  if (
    typeof candidate !== "number" ||
    !Number.isInteger(candidate) ||
    candidate < 0
  ) {
    return argValidationError(
      "Invalid cursor",
      "Pass the 'cursor' verbatim as returned by a previous call, or omit it to read from the start.",
      "cursor",
    );
  }
  return candidate;
};

/**
 * Return a `maxChars` window of `text` starting at the offset encoded in
 * `cursor` (absent cursor = start). `nextCursor` is the opaque cursor for the
 * next window, or null when the window reaches the end. Callers paginate long
 * content by passing the returned `nextCursor` back as `cursor`.
 */
export const windowTextByCursor = ({
  cursor,
  maxChars,
  text,
}: {
  cursor: string | undefined;
  maxChars: number;
  text: string;
}): TextWindowResult | CallToolResult => {
  const offset = decodeTextWindowOffset(cursor);
  if (typeof offset !== "number") {
    return offset;
  }

  const { start, end, nextOffset } = resolveWindowBounds(
    text.length,
    offset,
    maxChars,
  );

  return {
    text: text.slice(start, end),
    charCount: text.length,
    nextCursor:
      nextOffset === null ? null : encodePaginationCursor([nextOffset]),
    truncated: nextOffset !== null,
  };
};

export const ensureWorkspaceAccess = ({
  context,
  workspaceId,
}: {
  context: McpRequestContext;
  workspaceId: string;
}) => {
  const resolved = getAccessibleWorkspaceId({
    accessibleWorkspaceIdSet: context.accessibleWorkspaceIdSet,
    workspaceId,
  });
  if (resolved && context.pinServerValidatedWorkspaceId?.(resolved) === false) {
    return null;
  }
  return resolved;
};

/** Status of an accessible workspace, or undefined when it is not accessible. */
export const getWorkspaceStatus = ({
  context,
  workspaceId,
}: {
  context: McpRequestContext;
  workspaceId: string;
}): AccessibleWorkspace["status"] | undefined =>
  context.accessibleWorkspaceStatusById.get(workspaceId);

/**
 * Resolve an accessible workspace that is also writable. Mirrors the HTTP
 * `validateWorkspaceAccess` macro, which rejects any workspace whose status is
 * not "active": archived matters stay readable but are read-only through MCP
 * write tools. Returns the branded id when active, or an error result naming
 * the reason (not accessible vs archived). Callers that need to allow an
 * unarchive (`save_matter` with status:"active") should use
 * `ensureWorkspaceAccess` plus `getWorkspaceStatus` instead.
 */
export const ensureActiveWorkspace = ({
  context,
  workspaceId,
}: {
  context: McpRequestContext;
  workspaceId: string;
}): SafeId<"workspace"> | CallToolResult => {
  const resolved = getAccessibleWorkspaceId({
    accessibleWorkspaceIdSet: context.accessibleWorkspaceIdSet,
    workspaceId,
  });
  if (!resolved) {
    return notFoundResult("Matter not found or not accessible");
  }
  if (getWorkspaceStatus({ context, workspaceId }) !== "active") {
    return errorResult("Matter is archived; unarchive it first");
  }
  if (context.pinServerValidatedWorkspaceId?.(resolved) === false) {
    return notFoundResult("Matter not found or not accessible");
  }
  return resolved;
};

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

export const slugifyCaseLawPathSegment = (value: string): string => {
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

type CaseLawDecisionUrlInput = {
  caseNumber: string;
  country: string;
  court: string;
  language?: string | null | undefined;
  languageAlternateCount?: number | null | undefined;
  languageAlternates?: readonly unknown[] | null | undefined;
  slug?: string | null | undefined;
};

export const isPublicLawAppUrlEnabled = (): boolean =>
  env.isDev || env.FEATURE_PUBLIC_LAW;

export const buildCaseLawDecisionAppUrl = (
  input: CaseLawDecisionUrlInput,
): string | null =>
  isPublicLawAppUrlEnabled() ? buildCaseLawDecisionUrl(input) : null;

export const buildCaseLawDecisionUrl = ({
  caseNumber,
  country,
  court,
  language,
  languageAlternateCount,
  languageAlternates,
  slug,
}: CaseLawDecisionUrlInput) => {
  const languageSegment = normalizeCaseLawLanguageSegment(language);
  const courtSegment =
    court.trim().length > 0
      ? slugifyCaseLawPathSegment(court)
      : UNKNOWN_COURT_SEGMENT;
  const basePath = `${getAppBaseUrl()}/law/${country.toLowerCase()}/cases/${courtSegment}`;
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
    execute?: (args: TArgs, options: LocalToolExecutionOptions) => unknown;
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
