import type { CallToolResult } from "@modelcontextprotocol/server";
import { panic, TaggedError } from "better-result";
import * as v from "valibot";

import { env } from "@/api/env";
import { createCaseLawDecisionSlug } from "@/api/handlers/case-law/decisions/slug";
import { captureError } from "@/api/lib/analytics/capture";
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
import type { AccessibleWorkspace } from "@/api/lib/auth";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { getAppBaseUrl } from "@/api/lib/mcp-connectors/app-urls";
import { getCurrentRequestId } from "@/api/lib/observability/request-context";
import {
  decodePaginationCursor,
  encodePaginationCursor,
} from "@/api/lib/pagination";
import type { McpRequestContext } from "@/api/mcp/context";
import { getAccessibleWorkspaceId } from "@/api/mcp/context";
import type { McpErrorCode, McpValidationIssue } from "@/api/mcp/error-codes";
import { statusCodeToErrorCode } from "@/api/mcp/error-codes";
import type {
  InternalToolErrorResult,
  InternalToolMcpPresentation,
  InternalToolResult,
  InternalToolSuccess,
} from "@/api/mcp/tool-types";

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
export const ISO_DATE_SCHEMA = v.pipe(v.string(), v.isoDate());

export const FEATURE_DISABLED_MESSAGE =
  "This feature is not enabled on this deployment";

/**
 * The next step for a `feature_disabled` refusal. Naming the deployment flag
 * tells a self-hosting operator what to set; a client can never flip it.
 */
export const featureDisabledHint = (feature: string | undefined): string =>
  feature === undefined
    ? "This deployment has this feature turned off; it cannot be enabled from the client."
    : `This deployment has ${feature} turned off; a server operator enables it by setting ${feature}=true. It cannot be enabled from the client.`;

/**
 * A UUID-shaped id input. Ids reach SQL as uuid columns, so a malformed one
 * must fail here as a validation error naming the field rather than as a
 * database cast failure reported as an internal error.
 */
export const uuidInputSchema = (description: string) =>
  v.pipe(v.string(), v.uuid(), v.description(description));

type LocalToolExecutionOptions = {
  messages: [];
  toolCallId: string;
};

export const MCP_TOOL_EXECUTION_OPTIONS: LocalToolExecutionOptions = {
  messages: [],
  toolCallId: "mcp",
};

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
 * `uuidInputSchema` as a hand-written JSON Schema property, for the tools whose
 * advertised schema is still maintained alongside their validator rather than
 * projected from it. Both sides must move together until the tool migrates to
 * `defineValibotMcpTool`.
 */
export const uuidProp = (description: string) =>
  ({
    type: "string",
    format: "uuid",
    description,
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

export const toolDataResult = <TData>(
  data: TData,
  mcp?: InternalToolMcpPresentation,
): InternalToolSuccess<TData> => ({
  status: "success",
  data,
  ...(mcp === undefined ? {} : { mcp }),
});

// TypeScript's JSON.stringify overload for `unknown` claims it always returns
// a string, but the runtime returns undefined for unsupported root values.
const stringifyJson = (value: unknown): unknown => JSON.stringify(value);

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * `structuredContent` for a success (MCP 2025-06-18 allows it without an
 * output schema): the payload object itself, so a client reads typed fields
 * instead of re-parsing `content[0].text`. A handler's own
 * `mcp.structuredContent` wins; a non-object payload (array, scalar) has no
 * structured form and is carried by the text content alone.
 *
 * An error result never carries it: `structuredContent` is the tool's output,
 * and the `{ error: … }` envelope is the absence of one. A client validating
 * it against an output schema must not be handed a failure envelope in that
 * slot.
 */
const successStructuredContent = (
  result: InternalToolSuccess,
): Record<string, unknown> | undefined => {
  if (result.mcp?.structuredContent !== undefined) {
    return result.mcp.structuredContent;
  }
  return isJsonObject(result.data) ? result.data : undefined;
};

/** Serialize a canonical Stella tool result at the external MCP boundary. */
export const serializeToolResult = (
  result: InternalToolResult,
): CallToolResult => {
  if (result.status === "success") {
    const serializedData = stringifyJson(result.data);
    if (typeof serializedData !== "string") {
      panic("Internal tool success data must be JSON-serializable");
    }
    const content: CallToolResult["content"] = [
      {
        type: "text",
        text: result.mcp?.primaryText ?? serializedData,
      },
    ];
    const additionalText = result.mcp?.additionalText;
    if (additionalText !== undefined) {
      for (const text of additionalText) {
        content.push({ type: "text", text });
      }
    }
    const structuredContent = successStructuredContent(result);
    return {
      content,
      ...(structuredContent === undefined ? {} : { structuredContent }),
    };
  }

  if (result.error.type === "text") {
    return {
      content: [{ type: "text", text: result.error.message }],
      isError: true,
    };
  }

  const { type: _type, ...error } = result.error;
  return {
    content: [{ type: "text", text: JSON.stringify({ error }) }],
    isError: true,
  };
};

/**
 * Serialize unwrapped upstream data at an external MCP adapter boundary. The
 * payload is foreign application output, not a stella projection, so it is
 * carried as text only: `structuredContent` stays a first-party field a client
 * can validate, never a slot an upstream server's shape lands in.
 */
export const serializeMcpData = (data: unknown): CallToolResult => {
  const { structuredContent: _upstream, ...result } = serializeToolResult(
    toolDataResult(data),
  );
  return result;
};

/**
 * Legacy plain-text tool error. Kept for the handful of bespoke messages that
 * have no sensible machine-readable code (e.g. cross-field validation hints
 * surfaced verbatim). New code paths should prefer `structuredErrorResult`,
 * `notFoundResult`, or the `validation_error`-tagged arg parsers below so agents
 * and the CLI can branch on a stable `error.code`.
 */
export const errorResult = (message: string): InternalToolErrorResult => ({
  status: "error",
  error: { type: "text", message },
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
 * Preserve the caller's current grants while adding every scope required by an
 * operation. Explicit CLI scopes replace the default consent bundle, so a hint
 * containing only the first missing scope can otherwise create another token
 * that still cannot perform a compound-scope operation.
 */
export const oauthScopeRecoveryHint = ({
  grantedScopes,
  missingScope,
  requiredScopes,
}: {
  grantedScopes: readonly string[];
  missingScope: string;
  requiredScopes: readonly string[];
}): string => {
  const requestedScopes = [
    ...new Set([...grantedScopes, ...requiredScopes]),
  ].join(",");

  return `Grant the '${missingScope}' scope by re-running OAuth consent (CLI: 'stella auth login --scopes ${requestedScopes}'), then retry.`;
};

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
}): InternalToolErrorResult => {
  const error: {
    type: "structured";
    code: McpErrorCode;
    message: string;
    hint?: string;
    issues?: readonly McpValidationIssue[];
    retryable?: boolean;
    requestId?: string;
  } = { type: "structured", code, message };
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

  return { status: "error", error };
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
 * Build the shared validation envelope. Prefer an actionable cross-field issue
 * as its summary, then the first structural issue. The structured issue list is
 * the canonical schema-derived error detail; callers must not mirror schemas in
 * handwritten fallback messages that can drift from the contract.
 */
export const validationErrorResult = (
  issues: readonly v.BaseIssue<unknown>[],
  hint?: string,
): InternalToolErrorResult =>
  structuredErrorResult({
    code: "validation_error",
    hint,
    issues: mapValibotIssues(issues),
    message:
      issues.find((issue) => issue.type === "partial_check")?.message ??
      issues.at(0)?.message ??
      "Invalid tool input",
  });

/** `not_found` envelope for a resource that does not exist or is inaccessible. */
export const notFoundResult = (
  message: string,
  hint?: string,
): InternalToolErrorResult =>
  structuredErrorResult({ code: "not_found", hint, message });

/**
 * Envelope for a failed backing-handler `Result`, the single sink for the
 * `errorResult(result.error.message)` class. Every tool site that unwraps a
 * `context.safeDb(...)` / `Result.gen(() => handler(...))` failure routes here
 * instead of surfacing the raw `.message` as plain text. Pass `result.error`
 * (the `Result` error), not its message, so the cause reaches `captureError`
 * intact.
 *
 * The backing safe handlers return two distinct kinds of error, and they must
 * not be conflated:
 *  - An *expected* business failure is a `HandlerError` carrying a curated
 *    message and a 4xx status (e.g. "date is in the future" = 400, "already
 *    archived" = 409). An agent needs that message and a branchable code, so it
 *    is surfaced with the status mapped to an envelope code and the handler's
 *    own message preserved. It is *not* recorded as a telemetry error: it is
 *    normal, caller-driven flow, not a fault.
 *  - A genuine internal failure (a 5xx `HandlerError`, an `UnhandledException`
 *    or `DatabaseError` from a driver/ORM throw, or any non-`HandlerError`) is
 *    captured and returned as the same generic, code-bearing `internal_error`
 *    envelope the central pipeline's catch-all emits (see `handleMcpToolCall`),
 *    so no internal detail leaks to an external agent.
 */
export const internalFailureResult = (
  error: unknown,
): InternalToolErrorResult => {
  if (HandlerError.is(error)) {
    if (error.code === "upstream_unavailable") {
      captureError(error, { source: "mcp" });
      return structuredErrorResult({
        code: "upstream_unavailable",
        message: error.message,
        hint: "Retry the same request. If the service remains unavailable, report the request ID with send_feedback.",
        retryable: true,
      });
    }
    const code = statusCodeToErrorCode(error.status);
    if (code !== "internal_error") {
      return structuredErrorResult({
        code,
        message: error.message,
        // A handler that rejected specific input entries names them here, so
        // the envelope carries the same `issues[].path` detail a schema
        // rejection does instead of collapsing to one line of prose.
        issues: error.issues,
      });
    }
  }
  captureError(error, { source: "mcp" });
  return structuredErrorResult({
    code: "internal_error",
    message: "Tool execution failed",
    hint: MCP_INTERNAL_ERROR_HINT,
  });
};

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
): string[] => {
  const scored: { name: string; distance: number }[] = [];
  for (const name of candidates) {
    const distance = levenshtein(target, name);
    if (distance <= Math.ceil(name.length / 2)) {
      scored.push({ name, distance });
    }
  }

  return (
    scored
      // oxlint-disable-next-line require-cached-collator/require-cached-collator -- tool names are machine identifiers (agent-facing "did you mean"), not display text
      .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name))
      .slice(0, limit)
      .map(({ name }) => name)
  );
};

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
): InternalToolErrorResult | null => {
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
): InternalToolErrorResult =>
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
): string | InternalToolErrorResult => {
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
}): TValues[number] | InternalToolErrorResult => {
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
}): number | InternalToolErrorResult => {
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

export const isToolErrorResult = (
  value: unknown,
): value is InternalToolErrorResult =>
  typeof value === "object" &&
  value !== null &&
  "status" in value &&
  value.status === "error";

/** Wire cap on an opaque pagination cursor, shared with the tool schemas. */
export const MAX_CURSOR_LENGTH = 512;

export const parseOptionalCursor = ({
  args,
  key,
}: {
  args: Record<string, unknown>;
  key: string;
}): string | undefined | InternalToolErrorResult => {
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
): number | InternalToolErrorResult => {
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
}): TextWindowResult | InternalToolErrorResult => {
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
}): SafeId<"workspace"> | InternalToolErrorResult => {
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

/**
 * A case-law URL segment, folded exactly as the persisted slug was.
 *
 * These segments address rows whose slug the API already generated, so the
 * two folds have to agree on every step, length included: `case_number` and
 * `slug` are both `varchar(256)`, and NFKD expansion can push a long case
 * number's slug past the column the persisted one was truncated to. A
 * segment folded without that truncation would address a slug nobody stored.
 * Delegating leaves one implementation rather than two that must be kept
 * equal by hand.
 */
export const slugifyCaseLawPathSegment = (value: string): string =>
  createCaseLawDecisionSlug(value);

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

const getCaseLawLanguageAlternateCount = (
  languageAlternates: readonly unknown[] | null | undefined,
): number => {
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
    getCaseLawLanguageAlternateCount(languageAlternates) > 1
  ) {
    return `${basePath}/${languageSegment}/${decisionSlug}`;
  }

  return `${basePath}/${decisionSlug}`;
};

export const invokeAiTool = async <TArgs extends Record<string, unknown>>({
  args,
  tool,
}: {
  args: TArgs;
  tool: {
    execute?: (args: TArgs, options: LocalToolExecutionOptions) => unknown;
  };
}): Promise<InternalToolResult> => {
  if (!tool.execute) {
    return errorResult("Tool is not executable");
  }

  try {
    const result = await tool.execute(args, MCP_TOOL_EXECUTION_OPTIONS);
    if (hasErrorMessage(result)) {
      return errorResult(result.error);
    }
    return toolDataResult(result);
  } catch (error) {
    const mapped = toolThrownErrorToMcpResult(error);
    if (mapped) {
      return mapped;
    }
    throw error;
  }
};

const HTML_ENTITY_TEXT = new Map([
  ["&amp;", "&"],
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&quot;", '"'],
  ["&#x27;", "'"],
  ["&#39;", "'"],
]);
const HTML_ENTITY_PATTERN = /&(?:amp|lt|gt|quot|#x27|#39);/gu;
const HIGHLIGHT_TAG_PATTERN = /<\/?mark>/gu;

/**
 * Plain text for a search snippet built for the web UI. `escapeAndHighlight`
 * (see `lib/search/highlight.ts`) HTML-escapes the snippet and wraps matches in
 * `<mark>`; an MCP client is an agent or a terminal, never a browser, so the
 * markup is noise there. Tags are dropped before entities are decoded, so an
 * escaped literal `&lt;mark&gt;` in the source text survives as text. Entities
 * are decoded in one pass so `&amp;lt;` decodes to `&lt;`, not `<`.
 */
export const toPlainTextSnippet = (snippet: string | null): string | null => {
  if (snippet === null) {
    return null;
  }

  return snippet
    .replaceAll(HIGHLIGHT_TAG_PATTERN, "")
    .replaceAll(
      HTML_ENTITY_PATTERN,
      (entity) =>
        HTML_ENTITY_TEXT.get(entity) ??
        panic(`Unmapped HTML entity: ${entity}`),
    );
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
