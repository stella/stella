import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { panic } from "better-result";
import { ElysiaCustomStatusResponse } from "elysia";

import type { PermissionInput } from "@stll/permissions";

import { captureError } from "@/api/lib/analytics";
import type { SafeId } from "@/api/lib/branded-types";
import {
  decodePaginationCursor,
  encodePaginationCursor,
} from "@/api/lib/pagination";
import { hasMemberPermission } from "@/api/lib/permission-authorization";
import { brandPersistedWorkspaceId } from "@/api/lib/safe-id-boundaries";
import { synthesizeCapabilityContext } from "@/api/mcp/capability-context";
import type { SynthesizedCapabilityContext } from "@/api/mcp/capability-context";
import { isCapabilityFeatureEnabled } from "@/api/mcp/capability-feature";
import { consumeInvokeCapabilityRateLimit } from "@/api/mcp/capability-rate-limit";
import { CONTEXT_FIDELITY_WAIVERS } from "@/api/mcp/capability-waivers";
import type { McpRequestContext } from "@/api/mcp/context";
import type { McpErrorCode, McpValidationIssue } from "@/api/mcp/error-codes";
import capabilityCatalogRaw from "@/api/mcp/generated/capability-catalog.json";
import { CAPABILITY_DISPATCH } from "@/api/mcp/generated/capability-dispatch";
import type { CapabilityDispatchEntry } from "@/api/mcp/generated/capability-dispatch";
import { defineMcpToolSet } from "@/api/mcp/tool-types";
import type {
  McpEgressPlan,
  McpToolDefinition,
  McpToolHandler,
  McpToolResponse,
} from "@/api/mcp/tool-types";
import {
  closestToolNames,
  DEFAULT_LIST_LIMIT,
  enumProp,
  getWorkspaceStatus,
  intProp,
  MAX_LIST_LIMIT,
  MCP_INTERNAL_ERROR_HINT,
  notFoundResult,
  parseOptionalCursor,
  parseOptionalEnum,
  parseOptionalLimit,
  parseRequiredString,
  stringProp,
  structuredErrorResult,
} from "@/api/mcp/tool-utils";

// --- Catalog + dispatch runtime views ---------------------------------------

type CapabilityMcpDisposition =
  | { type: "tool"; name: string }
  | { type: "covered"; by: string }
  | { type: "capability"; reason: string };

const HANDLER_KINDS = [
  "workspace",
  "root",
  "session",
  "token",
  "public",
] as const;

type HandlerKind = (typeof HANDLER_KINDS)[number];

type CatalogEntry = {
  id: string;
  handlerKind: HandlerKind;
  access: "read" | "write";
  destructive: boolean;
  scope: string;
  /**
   * When true, this capability's REST route resolves workspace access through
   * `validateWorkspaceAccessIncludingArchived` (e.g. `workspaces.unarchive`), so
   * the generic write gate must let it run against an archived workspace.
   */
  allowsArchivedWorkspace?: boolean;
  /**
   * When true, this capability's handler returns a file on success (a web
   * `Response` or raw binary bytes). The generic invoke path cannot serialize
   * either, so it refuses these pre-execution; the REST route remains the way
   * to fetch them.
   */
  returnsFileResponse?: boolean;
  /**
   * When true, this capability's config schema contains a `t.File()`/`t.Files()`
   * field (`format: "binary"`). JSON input cannot carry a `File` — a plain
   * string would pass schema validation and reach the handler where it expects
   * a `File` — so the invoke gate refuses these pre-execution and points at the
   * presigned-upload flow. Derived mechanically by the export script.
   */
  requiresFileInput?: boolean;
  /**
   * Deployment feature flag (`FEATURE_*` env key) gating this capability,
   * mirroring the `feature` field on static tools: inherited from the covering
   * tool for tool/covered dispositions, or from the export script's reviewed
   * domain table. While the flag is off, `list_capabilities` hides the entry
   * and describe/invoke refuse it with `feature_disabled` (see
   * `isCapabilityFeatureEnabled`).
   */
  feature?: string;
  permissions?: unknown;
  inputSchema?: { body?: unknown; params?: unknown; query?: unknown };
  inputSchemaTruncated?: true;
  mcp: CapabilityMcpDisposition;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const HANDLER_KIND_SET = new Set<string>(HANDLER_KINDS);

const isHandlerKind = (value: unknown): value is HandlerKind =>
  typeof value === "string" && HANDLER_KIND_SET.has(value);

const isMcpDisposition = (
  value: unknown,
): value is CapabilityMcpDisposition => {
  if (!isRecord(value)) {
    return false;
  }
  if (value["type"] === "tool") {
    return typeof value["name"] === "string";
  }
  if (value["type"] === "covered") {
    return typeof value["by"] === "string";
  }
  if (value["type"] === "capability") {
    return typeof value["reason"] === "string";
  }
  return false;
};

const isCatalogEntry = (value: unknown): value is CatalogEntry =>
  isRecord(value) &&
  typeof value["id"] === "string" &&
  isHandlerKind(value["handlerKind"]) &&
  (value["access"] === "read" || value["access"] === "write") &&
  typeof value["destructive"] === "boolean" &&
  typeof value["scope"] === "string" &&
  (value["feature"] === undefined || typeof value["feature"] === "string") &&
  isMcpDisposition(value["mcp"]);

/**
 * Parse the generated catalog artifact into typed entries at the module
 * boundary. The export script + drift guard keep the JSON in the CatalogEntry
 * shape, so a mismatch here is a corrupt build artifact: fail fast rather than
 * casting the raw import and letting a malformed entry flow downstream.
 */
const parseCatalog = (raw: unknown): readonly CatalogEntry[] => {
  if (!Array.isArray(raw)) {
    return panic("capability catalog artifact is not a JSON array");
  }
  return raw.map((entry, index) =>
    isCatalogEntry(entry)
      ? entry
      : panic(`capability catalog entry ${index} has an unexpected shape`),
  );
};

const CATALOG = parseCatalog(capabilityCatalogRaw);

const CATALOG_BY_ID = new Map(CATALOG.map((entry) => [entry.id, entry]));
const CATALOG_IDS = CATALOG.map((entry) => entry.id);
const DISPATCH_BY_ID = new Map<string, CapabilityDispatchEntry>(
  Object.entries(CAPABILITY_DISPATCH),
);

const capabilityDomain = (id: string): string => id.split(".").at(0) ?? id;
const capabilityLeaf = (id: string): string => id.split(".").at(-1) ?? id;

// --- Live handler resolution -------------------------------------------------

/**
 * The endpoint config fields the generic path reads. `body`/`params`/`query`
 * are Elysia `t.*` schemas (TypeBox `TSchema`) at runtime, and `permissions` is
 * the handler's `PermissionInput` literal; both are built by the handler graph.
 * The guard below narrows to this shape at the module boundary.
 */
type EndpointConfig = {
  body?: TSchema;
  params?: TSchema;
  query?: TSchema;
  permissions?: PermissionInput;
};

type EndpointDefinition = {
  config: EndpointConfig;
  handler: (ctx: SynthesizedCapabilityContext) => Promise<unknown>;
};

const isEndpointDefinition = (value: unknown): value is EndpointDefinition =>
  isRecord(value) &&
  isRecord(value["config"]) &&
  typeof value["handler"] === "function";

/**
 * Load the live `{ config, handler }` endpoint definition backing a capability
 * via its generated dispatch thunk. `null` means the module loaded but did not
 * expose the expected endpoint shape (a generated-artifact drift the registry
 * test would also catch); the caller maps that to `internal_error`.
 */
const loadEndpoint = async (id: string): Promise<EndpointDefinition | null> => {
  const dispatch = DISPATCH_BY_ID.get(id);
  if (!dispatch) {
    return null;
  }
  const mod = await dispatch.load();
  const raw =
    dispatch.exportName === undefined
      ? mod["default"]
      : mod[dispatch.exportName];
  return isEndpointDefinition(raw) ? raw : null;
};

// --- TypeBox input validation ------------------------------------------------

/** TypeBox `Value.Errors` path (`/a/b`) -> the envelope's dot-path (`a.b`). */
const typeboxPathToDot = (path: string): string =>
  path.startsWith("/") ? path.slice(1).split("/").join(".") : path;

type PartValidation =
  | { ok: true; value: unknown }
  | { ok: false; issues: McpValidationIssue[] };

/**
 * Validate one input part (`body`/`params`/`query`) against the live handler
 * config's TypeBox schema, mirroring what the Elysia route boundary hands the
 * handler: Default -> Convert -> Clean -> Check. The Clean step matches
 * Elysia's default input normalization, verified empirically on this repo's
 * Elysia (1.4.29): unknown keys on a schema'd part are STRIPPED before
 * validation — for closed (`additionalProperties: false`) schemas too, which
 * are cleaned-then-accepted at REST, never rejected. Without Clean this path
 * would both leak undeclared keys through to handlers (mass-assignment shape)
 * and reject closed-schema payloads REST accepts. A missing schema means the
 * part is not normalized at REST either (Elysia only normalizes schema'd
 * parts), so the raw value passes through. Issue paths are prefixed with the
 * part name so an agent sees `body.matterId`, not a bare `matterId` it cannot
 * place.
 */
const validatePart = (
  part: "body" | "params" | "query",
  schema: TSchema | undefined,
  value: unknown,
): PartValidation => {
  if (schema === undefined) {
    return { ok: true, value };
  }
  // Object schemas are the norm; default an absent value to `{}` so required
  // fields surface as issues rather than a whole-object "expected object" error.
  const base = value === undefined ? {} : structuredClone(value);
  const withDefaults = Value.Default(schema, base);
  const coerced = Value.Convert(schema, withDefaults);
  const cleaned = Value.Clean(schema, coerced);
  if (Value.Check(schema, cleaned)) {
    return { ok: true, value: cleaned };
  }
  const issues = [...Value.Errors(schema, cleaned)].map((error) => {
    const dot = typeboxPathToDot(error.path);
    return {
      path: dot.length > 0 ? `${part}.${dot}` : part,
      message: error.message,
    };
  });
  return { ok: false, issues };
};

// --- Result mapping ----------------------------------------------------------

/**
 * Deliberate map from every 4xx a safe handler actually returns (sweep of
 * `HandlerError`/`status(...)` statuses in apps/api/src/handlers) onto the
 * error envelope, preserving the handler's message:
 *  - 400 validation, 422 semantic validation, 413 payload too large ->
 *    `validation_error`;
 *  - 401 (unauthenticated) and 403 (role/permission) -> `permission_denied`
 *    (the generic path is always authenticated, so a 401 here is an
 *    authorization gap, not a login prompt);
 *  - 404 -> `not_found`; 402 -> `usage_limited`; 429 -> `rate_limited`;
 *  - 409 -> `conflict` (duplicate link/name, concurrent edit; the message
 *    names the conflicting resource).
 * Unlisted statuses fall through to `internal_error` deliberately: 5xx are
 * genuine server failures (500/502 in handlers), 2xx/3xx status responses do
 * not occur on catalog handlers (302 lives in oauth-callback/verify, which are
 * `internal`-disposition; `redirect()` also trips the context-fidelity scan),
 * and 410 is unused across the handler tree.
 */
const STATUS_CODE_TO_ENVELOPE: {
  min: number;
  max: number;
  code: McpErrorCode;
}[] = [
  { min: 400, max: 400, code: "validation_error" },
  { min: 401, max: 401, code: "permission_denied" },
  { min: 402, max: 402, code: "usage_limited" },
  { min: 403, max: 403, code: "permission_denied" },
  { min: 404, max: 404, code: "not_found" },
  { min: 409, max: 409, code: "conflict" },
  { min: 413, max: 413, code: "validation_error" },
  { min: 422, max: 422, code: "validation_error" },
  { min: 429, max: 429, code: "rate_limited" },
];

const statusCodeToErrorCode = (code: number): McpErrorCode => {
  for (const range of STATUS_CODE_TO_ENVELOPE) {
    if (code >= range.min && code <= range.max) {
      return range.code;
    }
  }
  return "internal_error";
};

const statusResponseMessage = (response: unknown): string => {
  if (isRecord(response) && typeof response["message"] === "string") {
    return response["message"];
  }
  // Some status paths carry a bare string body (e.g. `status(403, "Forbidden")`).
  if (typeof response === "string" && response.length > 0) {
    return response;
  }
  return "The capability handler rejected the request";
};

/** Map a safe-handler `status(code, body)` response onto the error envelope. */
const mapStatusResponse = (
  statusCode: number,
  responseBody: unknown,
): CallToolResult => {
  const code = statusCodeToErrorCode(statusCode);
  const message = statusResponseMessage(responseBody);
  if (code === "internal_error") {
    return structuredErrorResult({
      code,
      message: "The capability handler failed",
      hint: MCP_INTERNAL_ERROR_HINT,
    });
  }
  return structuredErrorResult({ code, message });
};

/** Serialize a successful capability payload through the standard egress path. */
const successEgress = (payload: unknown): McpEgressPlan => ({
  egress: "structured",
  payload,
  textFields: [],
});

// --- list_capabilities -------------------------------------------------------

const CAPABILITY_LIST_CURSOR = "cursor";

// eslint-disable-next-line require-await -- the McpToolHandler contract is Promise-returning, but listing the static catalog does no async work
const listCapabilitiesHandler = async ({
  args,
}: {
  args: Record<string, unknown>;
  context: McpRequestContext;
}): Promise<McpToolResponse> => {
  const domain = args["domain"];
  if (domain !== undefined && typeof domain !== "string") {
    return structuredErrorResult({
      code: "validation_error",
      message: "Parameter domain must be a string",
      issues: [{ path: "domain", message: "Expected a string" }],
    });
  }
  const access = parseOptionalEnum({
    args,
    defaultValue: "all",
    key: "access",
    values: ["all", "read", "write"] as const,
  });
  if (typeof access !== "string") {
    return access;
  }
  const cursor = parseOptionalCursor({ args, key: CAPABILITY_LIST_CURSOR });
  if (typeof cursor === "object") {
    return cursor;
  }
  const limit = parseOptionalLimit({
    args,
    defaultValue: DEFAULT_LIST_LIMIT,
    key: "limit",
    max: MAX_LIST_LIMIT,
  });
  if (typeof limit !== "number") {
    return limit;
  }

  const afterId =
    cursor === undefined ? undefined : decodeCapabilityCursor(cursor);
  if (afterId === null) {
    return structuredErrorResult({
      code: "validation_error",
      message: "Invalid cursor",
      issues: [{ path: CAPABILITY_LIST_CURSOR, message: "Malformed cursor" }],
      hint: "Pass the cursor verbatim as returned by a previous call, or omit it for the first page.",
    });
  }

  // Feature-gated entries whose flag is off are not advertised, matching how
  // the static tools/list hides gated-off tools (describe/invoke also refuse
  // them, closing the guess-the-id bypass).
  const filtered = CATALOG.filter(
    (entry) =>
      isCapabilityFeatureEnabled(entry.feature) &&
      (domain === undefined || capabilityDomain(entry.id) === domain) &&
      (access === "all" || entry.access === access) &&
      (afterId === undefined || entry.id > afterId),
  );
  const page = filtered.slice(0, limit);
  const last = page.at(-1);
  const nextCursor =
    last !== undefined && filtered.length > page.length
      ? encodePaginationCursor([last.id])
      : null;

  return {
    egress: "structured",
    payload: {
      items: page.map((entry) => ({
        id: entry.id,
        summary: summarizeEntry(entry),
        scope: entry.scope,
      })),
      nextCursor,
      limit,
    },
    textFields: [],
  };
};

const accessLabel = (entry: CatalogEntry): string =>
  entry.destructive ? "write, destructive" : entry.access;

const summarizeEntry = (entry: CatalogEntry): string =>
  `${capabilityDomain(entry.id)} / ${capabilityLeaf(entry.id)} (${accessLabel(entry)})`;

const decodeCapabilityCursor = (cursor: string): string | undefined | null => {
  const decoded = decodePaginationCursor(cursor)?.at(0);
  if (decoded === undefined) {
    return null;
  }
  return typeof decoded === "string" ? decoded : null;
};

// --- describe_capability -----------------------------------------------------

const notFoundWithHint = (id: string): CallToolResult =>
  notFoundResult(`No capability with id "${id}"`, hintForUnknownId(id));

/**
 * Refusal for a capability whose deployment feature flag is off. Same message
 * as the static-tool dispatch guard (tools.ts) so agents see one behavior for
 * gated-off surface, tool or capability.
 */
const featureDisabledResult = (): CallToolResult =>
  structuredErrorResult({
    code: "feature_disabled",
    message: "This feature is not enabled on this deployment",
    hint: "This deployment or organization has this feature turned off; it cannot be enabled from the client.",
  });

const hintForUnknownId = (id: string): string => {
  const suggestions = closestToolNames(id, CATALOG_IDS);
  return suggestions.length > 0
    ? `Did you mean: ${suggestions.join(", ")}? Call list_capabilities to browse the full set.`
    : "Call list_capabilities to browse available capability ids.";
};

type GuardedEndpoint =
  | { ok: true; endpoint: EndpointDefinition }
  | { ok: false; result: CallToolResult };

/**
 * Load a capability's endpoint with failures contained: a rejecting dynamic
 * import (or a module without the `{ config, handler }` shape) is captured and
 * mapped to a structured `internal_error` envelope instead of escaping as an
 * unhandled rejection. Shared by `describe_capability` and `invoke_capability`.
 */
const loadEndpointGuarded = async (
  id: string,
  toolName: "describe_capability" | "invoke_capability",
): Promise<GuardedEndpoint> => {
  let endpoint: EndpointDefinition | null;
  try {
    endpoint = await loadEndpoint(id);
  } catch (error) {
    captureError(error, { source: "mcp", toolName });
    endpoint = null;
  }
  if (!endpoint) {
    captureError(new Error(`capability dispatch missing endpoint: ${id}`), {
      source: "mcp",
      toolName,
    });
    return {
      ok: false,
      result: structuredErrorResult({
        code: "internal_error",
        message: "Could not load the capability definition",
        hint: MCP_INTERNAL_ERROR_HINT,
      }),
    };
  }
  return { ok: true, endpoint };
};

const describeCapabilityHandler = async ({
  args,
}: {
  args: Record<string, unknown>;
  context: McpRequestContext;
}): Promise<McpToolResponse> => {
  const id = parseRequiredString(args, "capability");
  if (typeof id !== "string") {
    return id;
  }
  const entry = CATALOG_BY_ID.get(id);
  if (!entry) {
    return notFoundWithHint(id);
  }

  // Match the static-tool surface: a gated-off tool is hidden from the list
  // AND rejected on direct dispatch, so describing a gated-off capability is
  // refused too (never leak a disabled feature's schema by direct id).
  if (!isCapabilityFeatureEnabled(entry.feature)) {
    return featureDisabledResult();
  }

  const loaded = await loadEndpointGuarded(id, "describe_capability");
  if (!loaded.ok) {
    return loaded.result;
  }
  const endpoint = loaded.endpoint;

  // The live TypeBox schemas are plain objects plus symbol metadata; the final
  // JSON serialization (textResult in the egress pipeline) drops the symbols, so
  // they can go on the payload as-is. Uses the live config, never the snapshot,
  // so a snapshot-truncated capability still describes fully.
  const inputSchema = {
    body: endpoint.config.body,
    params: endpoint.config.params,
    query: endpoint.config.query,
  };

  return {
    egress: "structured",
    payload: {
      id: entry.id,
      domain: capabilityDomain(entry.id),
      access: entry.access,
      destructive: entry.destructive,
      handlerKind: entry.handlerKind,
      scope: entry.scope,
      // Surfacing these lets an agent learn, before invoking, that the
      // capability returns a file (invoke refuses it), takes a file upload
      // (invoke refuses it; use the presigned flow), or tolerates an archived
      // workspace (e.g. unarchive).
      returnsFileResponse: entry.returnsFileResponse === true,
      requiresFileInput: entry.requiresFileInput === true,
      allowsArchivedWorkspace: entry.allowsArchivedWorkspace === true,
      feature: entry.feature ?? null,
      permissions: entry.permissions ?? null,
      disposition: entry.mcp,
      inputSchema,
    },
    textFields: [],
  };
};

// --- invoke_capability -------------------------------------------------------

type InvokeInput = { body: unknown; params: unknown; query: unknown };

const readInvokeInput = (
  raw: unknown,
): { ok: true; value: InvokeInput } | { ok: false; result: CallToolResult } => {
  if (raw === undefined) {
    return {
      ok: true,
      value: { body: undefined, params: undefined, query: undefined },
    };
  }
  if (!isRecord(raw)) {
    return {
      ok: false,
      result: structuredErrorResult({
        code: "validation_error",
        message: "Parameter input must be an object",
        issues: [{ path: "input", message: "Expected an object" }],
      }),
    };
  }
  return {
    ok: true,
    value: {
      body: raw["body"],
      params: raw["params"],
      query: raw["query"],
    },
  };
};

/** Resolve the workspace id for a workspace-kind capability from `input.params.workspaceId`. */
const resolveCapabilityWorkspace = ({
  context,
  entry,
  params,
}: {
  context: McpRequestContext;
  entry: CatalogEntry;
  params: unknown;
}):
  | { ok: true; workspaceId: SafeId<"workspace"> }
  | { ok: false; result: CallToolResult } => {
  const rawId = isRecord(params) ? params["workspaceId"] : undefined;
  if (typeof rawId !== "string" || rawId.length === 0) {
    return {
      ok: false,
      result: structuredErrorResult({
        code: "validation_error",
        message:
          "This capability is workspace-scoped and requires input.params.workspaceId",
        issues: [
          {
            path: "params.workspaceId",
            message: "Provide the target workspace id as a non-empty string",
          },
        ],
      }),
    };
  }
  const branded = context.accessibleWorkspaceIdSet.has(rawId)
    ? brandPersistedWorkspaceId(rawId)
    : null;
  if (!branded) {
    return {
      ok: false,
      result: notFoundResult("Workspace not found or not accessible"),
    };
  }
  // Mirror `validateWorkspaceAccess` exactly (lib/auth.ts): the REST macro
  // 404s ANY non-active workspace — reads included — so the generic path must
  // be no weaker. Only capabilities flagged `allowsArchivedWorkspace` (their
  // REST route uses `validateWorkspaceAccessIncludingArchived`, e.g.
  // unarchive) run against an archived — but not deleting — workspace.
  // Deleting workspaces never enter `accessibleWorkspaceStatusById`, so this
  // branch only ever sees active/archived.
  if (
    entry.allowsArchivedWorkspace !== true &&
    getWorkspaceStatus({ context, workspaceId: rawId }) !== "active"
  ) {
    return {
      ok: false,
      result: notFoundResult(
        "Workspace is archived; unarchive it before invoking capabilities against it",
      ),
    };
  }
  return { ok: true, workspaceId: branded };
};

const invokeCapabilityHandler = async ({
  args,
  context,
}: {
  args: Record<string, unknown>;
  context: McpRequestContext;
}): Promise<McpToolResponse> => {
  const id = parseRequiredString(args, "capability");
  if (typeof id !== "string") {
    return id;
  }
  const entry = CATALOG_BY_ID.get(id);

  // 1. Unknown id -> not_found with a closest-id hint.
  if (!entry) {
    return notFoundWithHint(id);
  }

  // 2. Deployment feature gate. Mirrors the static-tool dispatch guard
  // (tools.ts): the list surface hides a gated-off entry, and this closes the
  // guess-the-id bypass. Runs before every other gate (validateOnly included)
  // so a disabled feature leaks nothing about its capabilities.
  if (!isCapabilityFeatureEnabled(entry.feature)) {
    return featureDisabledResult();
  }

  // 3. Disposition / fidelity. token/public capabilities self-authorize from a
  // body/param token and are not reachable through the generic path; a waived
  // capability's handler needs response plumbing the synthesized context drops.
  if (entry.handlerKind === "token" || entry.handlerKind === "public") {
    return notFoundResult(
      `Capability "${id}" is not invokable through invoke_capability`,
      "This operation authorizes itself differently; use its dedicated surface.",
    );
  }
  const waiver = CONTEXT_FIDELITY_WAIVERS.get(id);
  if (waiver !== undefined) {
    return structuredErrorResult({
      code: "feature_disabled",
      message: `Capability "${id}" cannot run through invoke_capability: ${waiver}`,
      hint: "Perform this operation in the stella app, which has the required request context.",
    });
  }
  // File/stream capabilities return a web Response or raw binary bytes the
  // generic path cannot serialize; refuse them before execution (a runtime
  // backstop in mapHandlerResult also catches any that slip past this flag).
  if (entry.returnsFileResponse === true) {
    return structuredErrorResult({
      code: "feature_disabled",
      message: `Capability "${id}" returns a file or stream and is not available through invoke_capability`,
      hint: "Fetch the file through its REST route or the stella app; invoke_capability only returns structured JSON.",
    });
  }
  // File-input capabilities take a `t.File()` body field; JSON input cannot
  // carry a File (a plain string would pass validation and reach the handler
  // where it expects a File), so refuse pre-execution — before validateOnly
  // too, which would otherwise report `valid: true` for an un-runnable input.
  if (entry.requiresFileInput === true) {
    return structuredErrorResult({
      code: "feature_disabled",
      message: `Capability "${id}" takes a file upload and is not available through invoke_capability`,
      hint: "Upload the file via the presigned-upload flow (request an upload URL, PUT the bytes to S3, then create the record), or use the stella app.",
    });
  }

  // 4. Scope: the session must hold the capability's catalog scope.
  if (!context.grantedScopes.includes(entry.scope)) {
    return structuredErrorResult({
      code: "missing_scope",
      message: `Insufficient permissions. Capability "${id}" requires scope: ${entry.scope}`,
      hint: `Grant the '${entry.scope}' scope by re-running OAuth consent (CLI: 'stella auth login --scopes ${entry.scope}'), then retry.`,
    });
  }

  // 5. Destructive confirm gate.
  if (entry.destructive && args["confirm"] !== true) {
    return structuredErrorResult({
      code: "confirmation_required",
      message: `Capability "${id}" is an irreversible operation and was called without confirmation`,
      hint: "This operation is irreversible. Confirm with the human user, then retry with confirm: true.",
    });
  }

  const parsedInput = readInvokeInput(args["input"]);
  if (!parsedInput.ok) {
    return parsedInput.result;
  }
  const validateOnly = args["validateOnly"] === true;

  try {
    return await executeInvoke({
      context,
      entry,
      id,
      input: parsedInput.value,
      validateOnly,
    });
  } catch (error) {
    captureError(error, { source: "mcp", toolName: "invoke_capability" });
    return structuredErrorResult({
      code: "internal_error",
      message: "Capability execution failed",
      hint: MCP_INTERNAL_ERROR_HINT,
    });
  }
};

/**
 * Gate parity with the static-tool path (tools.ts / gateway/list-tools.ts /
 * server-core.ts). Every gate a static tool call passes through has a stated
 * equivalent here (numbered gates live in `invokeCapabilityHandler` and this
 * function); absences are deliberate and explained:
 *
 * - Advertised-list filtering (list-tools): list_capabilities hides
 *   feature-disabled entries; the three meta-tools are `excluded` from the
 *   anonymized surface entirely, so no anonymized projection exists to filter.
 *   Deliberate difference: entries whose SCOPE the session lacks are still
 *   listed (scope is consent, not secrecy; the item names its scope and the
 *   missing_scope error tells the agent how to re-consent), whereas tools/list
 *   filters by granted scope.
 * - unknown_tool for unregistered names: gate 1 returns not_found with a
 *   closest-id hint (capability ids are data, not tools).
 * - Feature gate (tools.ts dispatch guard): gate 2, same feature_disabled
 *   envelope, also applied to describe and the list filter.
 * - Scope recheck (server-core missing_scope): the transport already gates the
 *   invoke_capability tool itself; gate 4 rechecks the per-capability catalog
 *   scope against the session's grants.
 * - Destructive confirm (tools.ts destructiveHint): gate 5, from the catalog's
 *   per-capability `destructive` flag.
 * - Workspace access (per-tool `ensureActiveWorkspace` bridging): gate 7
 *   mirrors `validateWorkspaceAccess`(-IncludingArchived per fix-4 flag).
 * - Member permissions + usage preflight: run inside the safe-handler wrapper
 *   (`endpoint.handler`), the same code path REST uses; validateOnly
 *   additionally mirrors the permission gate explicitly (the wrapper is not
 *   called on that path).
 * - Egress finalization + anonymization (finalizeMcpEgress): applied by
 *   handleMcpToolCall to this handler's returned egress plan exactly as for
 *   any static tool; anonymized mode never reaches here (tools excluded).
 * - internal_error capture (tools.ts try/catch): invokeCapabilityHandler wraps
 *   this function in its own try/catch with captureError.
 * - Invoke-only gates with no static equivalent: context-fidelity waivers,
 *   file-response/file-input refusals, token/public-kind refusal, and the
 *   per-(org, capability) rate limit (static tools hand-write their bridging
 *   and REST routes carry their own limits).
 */
const executeInvoke = async ({
  context,
  entry,
  id,
  input,
  validateOnly,
}: {
  context: McpRequestContext;
  entry: CatalogEntry;
  id: string;
  input: InvokeInput;
  validateOnly: boolean;
}): Promise<McpToolResponse> => {
  const loaded = await loadEndpointGuarded(id, "invoke_capability");
  if (!loaded.ok) {
    return loaded.result;
  }
  const endpoint = loaded.endpoint;

  const isWorkspace = entry.handlerKind === "workspace";
  // 6. Input validation against the live TypeBox schemas (Default -> Convert ->
  // Clean -> Check, mirroring the Elysia boundary; see validatePart). A
  // workspace-scoped capability takes its workspace as
  // `input.params.workspaceId`; at REST that param belongs to the route macro's
  // schema, not the handler config's, so it is resolved from the RAW params
  // below (Clean would strip it from configs that do not declare it) and
  // re-merged into the params the handler receives, exactly like the macro's
  // merged schema.
  const validations = [
    validatePart("body", endpoint.config.body, input.body),
    validatePart("params", endpoint.config.params, input.params),
    validatePart("query", endpoint.config.query, input.query),
  ] as const;

  const issues = validations.flatMap((result) =>
    result.ok ? [] : result.issues,
  );
  if (issues.length > 0) {
    return structuredErrorResult({
      code: "validation_error",
      message: "Capability input failed validation",
      issues,
      hint: "Fix the fields named in issues[] and retry.",
    });
  }

  const [bodyResult, paramsResult, queryResult] = validations;
  const validatedBody = bodyResult.ok ? bodyResult.value : undefined;
  const validatedParams = paramsResult.ok ? paramsResult.value : undefined;
  const validatedQuery = queryResult.ok ? queryResult.value : undefined;

  // 7. Workspace resolution (workspace kind only), from the RAW input params
  // (route-macro parity: REST validates the path param independently of the
  // handler config schema). Runs BEFORE the validateOnly return so
  // `validateOnly: true` mirrors a real invoke: a missing/inaccessible/archived
  // workspace fails here with the same envelope it would at execution, rather
  // than validateOnly reporting a spurious `{ valid: true }`.
  let workspaceId: SafeId<"workspace"> | undefined;
  let handlerParams = validatedParams;
  if (isWorkspace) {
    const resolved = resolveCapabilityWorkspace({
      context,
      entry,
      params: input.params,
    });
    if (!resolved.ok) {
      return resolved.result;
    }
    workspaceId = resolved.workspaceId;
    // The handler's params mirror REST's merged macro+config schema: the
    // config-declared (cleaned) fields plus workspaceId. Without a config
    // params schema the macro's schema is all there is, so params is exactly
    // { workspaceId }.
    handlerParams = {
      ...(isRecord(validatedParams) && endpoint.config.params !== undefined
        ? validatedParams
        : {}),
      workspaceId: resolved.workspaceId,
    };
  }

  if (validateOnly) {
    // Honest preflight: mirror the safe wrapper's member-permission gate (the
    // wrapper is not called on this path), so a role that would be refused at
    // execution is refused here too instead of getting a spurious
    // `{ valid: true }`. Configs without permissions (session-kind) skip the
    // check, exactly as their wrapper does.
    const permissions = endpoint.config.permissions;
    if (
      permissions !== undefined &&
      !hasMemberPermission({ role: context.memberRole }, permissions)
    ) {
      return structuredErrorResult({
        code: "permission_denied",
        message: `Your member role does not permit capability "${id}"`,
      });
    }
    return {
      egress: "structured",
      payload: { valid: true, capability: id },
      textFields: [],
    };
  }

  const request = context.request;
  if (request === undefined) {
    return structuredErrorResult({
      code: "internal_error",
      message: "Capability execution is unavailable on this surface",
      hint: MCP_INTERNAL_ERROR_HINT,
    });
  }

  // 8. Gateway rate limit, per (organization, capability). Mirrors the explicit
  // per-route limits some REST routes carry (e.g. entities.translate); capped
  // before execution so a runaway agent cannot drive backend cost through the
  // generic path. validateOnly (above) is exempt: it never executes.
  const rate = await consumeInvokeCapabilityRateLimit({
    capabilityId: id,
    organizationId: context.organizationId,
  });
  if (!rate.ok) {
    return structuredErrorResult({
      code: "rate_limited",
      message: `Rate limit exceeded for capability "${id}"`,
      hint: `Too many invocations of this capability for your organization; retry in about ${rate.retryAfterSeconds} seconds.`,
    });
  }

  const ctx = await synthesizeCapabilityContext({
    capabilityId: id,
    context,
    input: {
      body: validatedBody,
      params: handlerParams,
      query: validatedQuery,
    },
    request,
    workspaceId,
  });

  const result = await endpoint.handler(ctx);
  return mapHandlerResult({ id, result });
};

/**
 * A file/stream/binary success value the structured egress must never
 * serialize: a web `Response`, raw bytes (`ArrayBuffer` or any of its views,
 * `Uint8Array` included), a `ReadableStream`, or a `Blob`. Stringifying any of
 * these would emit garbage ("[object Response]", `{"0":37,"1":80,...}` for
 * byte arrays) or drain a stream.
 */
const isBinaryPayload = (value: unknown): boolean =>
  value instanceof Response ||
  value instanceof ArrayBuffer ||
  ArrayBuffer.isView(value) ||
  value instanceof ReadableStream ||
  value instanceof Blob;

/**
 * Map a capability handler's raw return onto an MCP response:
 *  - a safe-handler `status(code, body)` -> the error envelope;
 *  - a `Response`/binary payload (see `isBinaryPayload`) -> `feature_disabled`
 *    (runtime backstop for fix-6: the catalog flag refuses file capabilities
 *    pre-execution, and this catches any that slip past);
 *  - anything else -> the structured success payload.
 */
export const mapHandlerResult = ({
  id,
  result,
}: {
  id: string;
  result: unknown;
}): McpToolResponse => {
  if (result instanceof ElysiaCustomStatusResponse) {
    const statusCode = typeof result.code === "number" ? result.code : 500;
    return mapStatusResponse(statusCode, result.response);
  }
  if (isBinaryPayload(result)) {
    return structuredErrorResult({
      code: "feature_disabled",
      message: `Capability "${id}" returned a file or stream, which invoke_capability cannot deliver`,
      hint: "Fetch the file through its REST route or the stella app; invoke_capability only returns structured JSON.",
    });
  }
  return successEgress(result);
};

// --- tool set ----------------------------------------------------------------

const CAPABILITY_TOOL_DEFINITIONS = [
  {
    name: "list_capabilities",
    access: "read",
    anonymized: { exposure: "excluded", reason: "dynamic_tenant_payload" },
    scope: "stella:read",
    description:
      "List the automatable capabilities beyond the curated tools: every safe " +
      "backend operation (CRUD, exports, processing triggers) reachable through " +
      "invoke_capability. Paginated; filter by domain (the id prefix, e.g. " +
      '"time-entries") or access (read/write). Each item gives the capability ' +
      "id, a one-line summary, and the OAuth scope it needs. Use " +
      "describe_capability for the full input schema.",
    inputSchema: {
      type: "object",
      properties: {
        domain: stringProp(
          'Filter to one capability domain: the id prefix before the first dot (e.g. "time-entries", "invoices").',
        ),
        access: enumProp("Filter by access level.", ["all", "read", "write"]),
        cursor: stringProp(
          "Opaque pagination cursor from a previous page; omit for the first page.",
        ),
        limit: intProp("Maximum capabilities to return.", {
          min: 1,
          max: MAX_LIST_LIMIT,
        }),
      },
      additionalProperties: false,
    },
  },
  {
    name: "describe_capability",
    access: "read",
    anonymized: { exposure: "excluded", reason: "dynamic_tenant_payload" },
    scope: "stella:read",
    description:
      "Describe one capability in full: its live input JSON Schema " +
      "(body/params/query), required OAuth scope, member permissions, whether it " +
      "is destructive, its handler kind (workspace/root), and its disposition. " +
      "Call this before invoke_capability to learn exactly what input to pass.",
    inputSchema: {
      type: "object",
      properties: {
        capability: stringProp(
          'Capability id to describe, as returned by list_capabilities (e.g. "time-entries.create").',
        ),
      },
      required: ["capability"],
      additionalProperties: false,
    },
  },
  {
    name: "invoke_capability",
    access: "write",
    anonymized: { exposure: "excluded", reason: "write" },
    scope: "stella:read",
    // Destructiveness is per-capability (from the catalog), not a property of
    // this tool, so no `destructiveHint` annotation: the confirm gate is applied
    // inside the handler from the target capability's `destructive` flag.
    description:
      "Invoke one capability by id (from list_capabilities/describe_capability). " +
      "Pass its input under { body, params, query }; workspace-scoped " +
      "capabilities take the target workspace as input.params.workspaceId. Real " +
      "authority is enforced per capability: the session must hold the " +
      "capability's scope and your member role its permissions. Set " +
      "validateOnly: true to check input without running it; destructive " +
      "capabilities require confirm: true after human approval.",
    inputSchema: {
      type: "object",
      properties: {
        capability: stringProp(
          "Capability id to invoke, as returned by list_capabilities.",
        ),
        input: {
          type: "object",
          description:
            "The capability's input, split into the parts its schema declares.",
          properties: {
            body: {
              type: "object",
              description:
                "Request body fields, per the capability's body schema.",
              additionalProperties: true,
            },
            params: {
              type: "object",
              description:
                "Path parameters; workspace-scoped capabilities require workspaceId here.",
              additionalProperties: true,
            },
            query: {
              type: "object",
              description:
                "Query parameters, per the capability's query schema.",
              additionalProperties: true,
            },
          },
          additionalProperties: false,
        },
        validateOnly: {
          type: "boolean",
          description:
            "When true, validate the input against the capability schema and return without executing.",
        },
        confirm: {
          type: "boolean",
          description:
            "Must be true to run a destructive capability. Set it only after a human user approved the irreversible action.",
        },
      },
      required: ["capability"],
      additionalProperties: false,
    },
  },
] as const satisfies readonly McpToolDefinition[];

export const CAPABILITY_TOOL_HANDLERS = {
  list_capabilities: listCapabilitiesHandler,
  describe_capability: describeCapabilityHandler,
  invoke_capability: invokeCapabilityHandler,
} satisfies Record<
  "list_capabilities" | "describe_capability" | "invoke_capability",
  McpToolHandler
>;

export const CAPABILITY_TOOL_SET = defineMcpToolSet(
  CAPABILITY_TOOL_DEFINITIONS,
  CAPABILITY_TOOL_HANDLERS,
);
