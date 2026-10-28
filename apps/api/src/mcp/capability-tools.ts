import { panic, Result } from "better-result";
import * as v from "valibot";

import {
  ACTION_ADMISSION_REFUSALS,
  isActionAdmissionCode,
} from "@stll/api-contract/action-admission";
import { toWireInput } from "@stll/api-contract/http-input";
import {
  MCP_CAPABILITY_EXECUTORS,
  type McpCapabilityExecutor,
} from "@stll/api-contract/mcp-capability-executors";
import type { PermissionInput } from "@stll/permissions";

import type { RouteAccess, RouteDefinition } from "@/api/http/route";
import { HttpStatusResponse } from "@/api/http/status";
import { captureError } from "@/api/lib/analytics/capture";
import type { AccountAccess } from "@/api/lib/api-handlers";
import type { WorkspaceStatusAccess } from "@/api/lib/auth";
import type { FeatureAccessRequirement } from "@/api/lib/auth/feature-access/requirements";
import type { SafeId } from "@/api/lib/branded-types";
import type { CapabilityTransport } from "@/api/lib/capability-transport";
import {
  describeTransportAlternative,
  filelessOnlyField,
  isTransportInvocable,
  transportAlternative,
  transportFileInput,
  transportFileResponse,
} from "@/api/lib/capability-transport";
import { resourcesAreVisible } from "@/api/lib/entities/resource-access";
import {
  isValibotSchema,
  type JsonSchema,
} from "@/api/lib/json-schema/valibot-to-json-schema";
import { SEARCH_INDEX_UNAVAILABLE_CODE } from "@/api/lib/legal-search/search-index-unavailable";
import { handlerErrorContext } from "@/api/lib/observability/exception-context";
import { withExceptionScope } from "@/api/lib/observability/exception-scope";
import {
  decodePaginationCursor,
  encodePaginationCursor,
} from "@/api/lib/pagination";
import { projectionPayload } from "@/api/lib/projection-totality";
import {
  type CatalogServiceClassification,
  isServiceClassification,
  VALIDATED_INPUT_SERVICE_CLASSIFICATION,
} from "@/api/lib/rate-limit/service-classification";
import {
  HANDLER_KINDS,
  type HandlerKind,
} from "@/api/lib/safe-handler-factories";
import { brandPersistedWorkspaceId } from "@/api/lib/safe-id-boundaries";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";
import { advertisedSchemas } from "@/api/mcp/advertised-schema";
import { capabilityHandlerContext } from "@/api/mcp/capability-context";
import type { CapabilityHandlerContext } from "@/api/mcp/capability-context";
import { isCapabilityFeatureEnabled } from "@/api/mcp/capability-feature";
import { consumeInvokeCapabilityRateLimit } from "@/api/mcp/capability-rate-limit";
import { CONTEXT_FIDELITY_WAIVERS } from "@/api/mcp/capability-waivers";
import { bindApprovedMcpAuditContext } from "@/api/mcp/context";
import type { McpRequestContext } from "@/api/mcp/context";
import { hasEffectiveAuthority } from "@/api/mcp/effective-authority";
import {
  projectMcpRefusal,
  statusCodeToErrorCode,
} from "@/api/mcp/error-codes";
import type { McpValidationIssue } from "@/api/mcp/error-codes";
import {
  isMcpDescriptorFeatureEnabled,
  resolveMcpDescriptorFeatureId,
} from "@/api/mcp/feature-access";
import {
  hiddenMcpDescriptorIds,
  scopeMcpDescriptorProse,
  scopeSchemaAnnotations,
} from "@/api/mcp/feature-access-prose";
import type { CapabilityDispatchEntry } from "@/api/mcp/generated/capability-dispatch";
import {
  findRemovedInputIssues,
  normalizeInputAtBoundary,
} from "@/api/mcp/input-normalization";
import { plainRecord } from "@/api/mcp/input-schemas";
import {
  declaresInternalField,
  INTERNAL_FIELD_NAME,
  PUBLIC_FIELD_NAME,
  withPublicFieldNames,
} from "@/api/mcp/public-field-names";
import { TOOL_CONFIRMATION } from "@/api/mcp/tool-confirmation";
import { defineMcpToolSet } from "@/api/mcp/tool-types";
import type {
  InternalToolErrorResult,
  McpReadClass,
  McpToolDefinition,
  McpToolHandler,
  McpToolResponse,
} from "@/api/mcp/tool-types";
import {
  closestToolNames,
  confirmationUnavailableResult,
  cursorInput,
  DEFAULT_LIST_LIMIT,
  didYouMean,
  FEATURE_DISABLED_MESSAGE,
  featureDisabledHint,
  getWorkspaceStatus,
  invalidCursorResult,
  MAX_LIST_LIMIT,
  MAX_TOOL_NAME_CHARS,
  MCP_INTERNAL_ERROR_HINT,
  notFoundResult,
  nullAsAbsent,
  oauthScopeRecoveryHint,
  quoteToolName,
  searchIndexUnavailableResult,
  structuredEgressPlan,
  structuredErrorResult,
  untypedStructuredEgressPlan,
  validationErrorResult,
} from "@/api/mcp/tool-utils";
import { resolveUploadPurposeRequirement } from "@/api/mcp/upload-purpose-gate";
import {
  defineMcpToolOutput,
  defineProjectedMcpToolOutput,
  defineValibotMcpTool,
} from "@/api/mcp/valibot-tool-definition";
import type { AuthorizedMcpRequestContext } from "@/api/mcp/write-tool-authority";
import { openMcpRead } from "@/api/mcp/write-tool-authority";

// --- Catalog + dispatch runtime views ---------------------------------------

type CapabilityMcpDisposition =
  | { type: "tool"; name: string }
  | { type: "covered"; by: string }
  | { type: "capability"; reason: string };

type CatalogEntry = {
  id: string;
  consumesServices: CatalogServiceClassification;
  /**
   * Authored prose describing what the capability does, sourced from the
   * handler config and carried here by the export script. Surfaced in
   * `list_capabilities` and `describe_capability` so an agent can choose a
   * capability without a round trip through the REST docs. Absent only for a
   * capability that has not been given one yet.
   */
  description?: string;
  handlerKind: HandlerKind;
  access: "read" | "write";
  readClass?: McpReadClass;
  destructive: boolean;
  confirmation?: "required";
  scope: string;
  additionalScopes?: readonly string[];
  /**
   * When true, this capability's REST route admits archived matters
   * (`workspaceStatus: "active-or-archived"`, e.g. `matters.unarchive`), so
   * the generic write gate must let it run against an archived workspace.
   */
  allowsArchivedWorkspace?: boolean;
  /**
   * How this capability's payload crosses the generic JSON transport: `json`, or
   * a file leg naming the field carrying the bytes, whether that field is
   * optional, and where the same work can be done instead. The invoke gate
   * refuses a capability the transport says JSON cannot run, and refuses the
   * file field on one that has a fileless mode; both refusals quote the
   * alternative rather than stopping at "not available".
   */
  transport: CapabilityTransport;
  /**
   * Deployment feature flag (`FEATURE_*` env key) gating this capability,
   * mirroring the `feature` field on static tools: inherited from the covering
   * tool for tool/covered dispositions, or from the export script's reviewed
   * domain table. While the flag is off, `list_capabilities` hides the entry
   * and describe/invoke refuse it with `feature_disabled` (see
   * `isCapabilityFeatureEnabled`).
   */
  featureId?: string;
  featureAccess?: "required" | "conditional";
  feature?: string;
  permissions?: unknown;
  inputSchema?: { body?: unknown; params?: unknown; query?: unknown };
  mcp: CapabilityMcpDisposition;
};

const requiresCapabilityConfirmation = (
  entry: Pick<CatalogEntry, "destructive" | "confirmation">,
) => entry.destructive || entry.confirmation === "required";

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

const isFileInputShape = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value["field"] === "string" &&
  typeof value["required"] === "boolean";

const isFileResponseShape = (value: unknown): boolean =>
  isRecord(value) && Array.isArray(value["mediaTypes"]);

const isAlternativeShape = (value: unknown): boolean => {
  if (!isRecord(value)) {
    return false;
  }
  if (value["type"] === "mcp-tool") {
    return (
      typeof value["name"] === "string" && typeof value["note"] === "string"
    );
  }
  if (value["type"] === "none") {
    return typeof value["reason"] === "string";
  }
  if (value["type"] === "complete") {
    return Array.isArray(value["via"]) && typeof value["note"] === "string";
  }
  if (value["type"] === "partial") {
    return (
      Array.isArray(value["via"]) && typeof value["limitation"] === "string"
    );
  }
  return false;
};

/**
 * Shape check for the generated `transport`. Total by construction: an unknown
 * discriminant fails, so a catalog built by a newer exporter cannot be read as
 * "JSON, apparently" and quietly open a file capability to the generic path.
 */
const isCapabilityTransport = (
  value: unknown,
): value is CapabilityTransport => {
  if (!isRecord(value)) {
    return false;
  }
  if (value["type"] === "json") {
    return true;
  }
  if (!isAlternativeShape(value["alternative"])) {
    return false;
  }
  if (value["type"] === "file-input") {
    return isFileInputShape(value["input"]);
  }
  if (value["type"] === "file-response") {
    return isFileResponseShape(value["response"]);
  }
  if (value["type"] === "file-both") {
    return (
      isFileInputShape(value["input"]) && isFileResponseShape(value["response"])
    );
  }
  return false;
};

const isCatalogEntry = (value: unknown): value is CatalogEntry =>
  isRecord(value) &&
  typeof value["id"] === "string" &&
  (typeof value["consumesServices"] === "boolean" ||
    value["consumesServices"] === VALIDATED_INPUT_SERVICE_CLASSIFICATION) &&
  (value["description"] === undefined ||
    typeof value["description"] === "string") &&
  isHandlerKind(value["handlerKind"]) &&
  (value["access"] === "write" ||
    (value["access"] === "read" &&
      (value["readClass"] === "tenant" ||
        value["readClass"] === "public" ||
        value["readClass"] === "both"))) &&
  typeof value["destructive"] === "boolean" &&
  (value["confirmation"] === undefined ||
    value["confirmation"] === "required") &&
  typeof value["scope"] === "string" &&
  (value["additionalScopes"] === undefined ||
    (Array.isArray(value["additionalScopes"]) &&
      value["additionalScopes"].every(
        (scope): scope is string => typeof scope === "string",
      ))) &&
  (value["featureId"] === undefined ||
    typeof value["featureId"] === "string") &&
  (value["featureAccess"] === undefined ||
    value["featureAccess"] === "required" ||
    value["featureAccess"] === "conditional") &&
  (value["feature"] === undefined || typeof value["feature"] === "string") &&
  isCapabilityTransport(value["transport"]) &&
  isMcpDisposition(value["mcp"]);

/**
 * Parse the generated catalog artifact into typed entries at the module
 * boundary. The export script + drift guard keep the JSON in the CatalogEntry
 * shape, so a mismatch here is a corrupt build artifact: fail fast rather than
 * casting the raw import and letting a malformed entry flow downstream.
 */
export const parseCatalog = (raw: unknown): readonly CatalogEntry[] => {
  if (!Array.isArray(raw)) {
    return panic("capability catalog artifact is not a JSON array");
  }
  return raw.map((entry, index) =>
    isCatalogEntry(entry)
      ? entry
      : panic(`capability catalog entry ${index} has an unexpected shape`),
  );
};

let catalog: readonly CatalogEntry[] | undefined;
let catalogById: Map<string, CatalogEntry> | undefined;
// Tool definitions are also imported by the exporter before shards exist.
// Defer the generated runtime data until a capability is actually used.
const getCatalog = async () => {
  if (catalog !== undefined) {
    return catalog;
  }
  const generated = await import("./generated/capability-catalog");
  catalog = parseCatalog(generated.default);
  return catalog;
};
/** The parsed capability catalog, for checks over every capability. */
export const loadCapabilityCatalog = async (): Promise<
  readonly CatalogEntry[]
> => await getCatalog();
const getCatalogById = async () =>
  (catalogById ??= new Map(
    (await getCatalog()).map((entry) => [entry.id, entry]),
  ));
let dispatchById: Map<string, CapabilityDispatchEntry> | undefined;
const getDispatchById = async () => {
  if (dispatchById !== undefined) {
    return dispatchById;
  }
  const generated = await import("./generated/capability-dispatch");
  dispatchById = new Map(Object.entries(generated.CAPABILITY_DISPATCH));
  return dispatchById;
};

const capabilityDomain = (id: string): string => id.split(".").at(0) ?? id;
const capabilityLeaf = (id: string): string => id.split(".").at(-1) ?? id;
const additionalScopesOf = (entry: CatalogEntry): string[] => {
  if (entry.additionalScopes === undefined) {
    return [];
  }
  return [...entry.additionalScopes];
};
const requiredScopesOf = (entry: CatalogEntry): readonly string[] => [
  entry.scope,
  ...additionalScopesOf(entry),
];

type RenderedTransport = {
  type: CapabilityTransport["type"];
  /** Whether capability executors can run this at all. */
  invocable: boolean;
  /** Body field carrying bytes, and whether it is required. */
  fileField: string | null;
  fileFieldRequired: boolean | null;
  fileMediaTypes: string[];
  /** Media types the success payload would be, for a file-returning capability. */
  responseMediaTypes: string[];
  /** Where the work can be done instead, as one sentence. */
  alternative: string | null;
};

/**
 * The transport an agent sees on `list_capabilities` and
 * `describe_capability`. Says which field carries bytes and whether the
 * capability has a fileless mode, so an agent can tell "cannot be called" from
 * "can be called without the file" before spending a round trip.
 */
const renderTransport = (transport: CapabilityTransport): RenderedTransport => {
  const input = transportFileInput(transport);
  const response = transportFileResponse(transport);
  const alternative = transportAlternative(transport);
  return {
    type: transport.type,
    invocable: isTransportInvocable(transport),
    fileField: input === undefined ? null : input.field,
    fileFieldRequired: input === undefined ? null : input.required,
    fileMediaTypes: input === undefined ? [] : [...input.mediaTypes],
    responseMediaTypes: response === undefined ? [] : [...response.mediaTypes],
    alternative:
      alternative === undefined
        ? null
        : describeTransportAlternative(alternative),
  };
};

// --- Live handler resolution -------------------------------------------------

/**
 * The slice of a capability endpoint's live config the capability executors
 * read. Its input schemas are the route's own valibot schemas, and
 * `permissions` is the handler's `PermissionInput` literal; both are built by
 * the handler graph. The guard below narrows to this shape at the module
 * boundary.
 */
type EndpointConfig = {
  featureAccess?: FeatureAccessRequirement;
  mcp?: unknown;
  body?: v.GenericSchema;
  params?: v.GenericSchema;
  query?: v.GenericSchema;
  permissions?: PermissionInput;
  accountAccess?: AccountAccess;
  workspaceStatus?: WorkspaceStatusAccess;
};

/** A capability's route definition, with the handler core the executors call. */
type EndpointDefinition = Omit<RouteDefinition, "config"> & {
  readonly config: RouteDefinition["config"] & EndpointConfig;
  readonly handler: (ctx: CapabilityHandlerContext) => Promise<unknown>;
};

const ROUTE_ACCESS: ReadonlySet<unknown> = new Set<RouteAccess>([
  "public",
  "token",
  "session",
  "member",
  "workspace",
]);

const isInputSlot = (value: unknown): boolean =>
  value === undefined || isValibotSchema(value);

const isEndpointDefinition = (value: unknown): value is EndpointDefinition =>
  isRecord(value) &&
  isRecord(value["config"]) &&
  isInputSlot(value["config"]["body"]) &&
  isInputSlot(value["config"]["params"]) &&
  isInputSlot(value["config"]["query"]) &&
  ROUTE_ACCESS.has(value["access"]) &&
  typeof value["run"] === "function" &&
  typeof value["handler"] === "function";

/**
 * Load the live `{ config, handler }` endpoint definition backing a capability
 * via its generated dispatch thunk. `null` means the module loaded but did not
 * expose the expected endpoint shape (a generated-artifact drift the registry
 * test would also catch); the caller maps that to `internal_error`.
 */
export const loadCapabilityEndpoint = async (
  id: string,
): Promise<EndpointDefinition | null> => {
  const dispatch = (await getDispatchById()).get(id);
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

// --- Input validation: the route's own schemas ------------------------------

/** Join two dot-paths, skipping empty segments (`""` + `x` -> `x`). */
const joinDot = (head: string, tail: string): string => {
  if (head.length === 0) {
    return tail;
  }
  return tail.length === 0 ? head : `${head}.${tail}`;
};

/**
 * Translate a dot-path back to the names the agent was actually shown.
 *
 * Validation runs against the handler's own schema, so its issue paths name
 * internal fields (`params.workspaceId`). The agent read `params.matterId` off
 * `describe_capability` and typed `--matter-id`, so an issue that names the
 * internal field points at a field it cannot see. Segments are exact keys, and
 * an array index is a numeric segment that no field name collides with.
 */
const toPublicIssuePath = (dot: string): string =>
  dot
    .split(".")
    .map((segment) => PUBLIC_FIELD_NAME[segment] ?? segment)
    .join(".");

/** An issue re-pointed at the public spelling of its field. */
const toPublicIssue = (issue: McpValidationIssue): McpValidationIssue => ({
  ...issue,
  path: toPublicIssuePath(issue.path),
});

type InputPart = "body" | "params" | "query";

/**
 * Prefix a validated part name onto a dot-path so an agent sees `body.purpose`,
 * never a bare `purpose` it cannot place. An empty dot-path (the whole part
 * failed) renders as the bare part name.
 */
const prefixPartPath = (part: InputPart, dot: string): string =>
  joinDot(part, dot);

/** A schema node with its optional/nullable/default wrappers peeled off. */
const unwrappedSchema = (schema: unknown): unknown => {
  let node = schema;
  while (isRecord(node) && isRecord(node["wrapped"])) {
    node = node["wrapped"];
  }
  return node;
};

const OBJECT_SCHEMA_TYPES: ReadonlySet<unknown> = new Set([
  "object",
  "loose_object",
  "strict_object",
  "object_with_rest",
]);

/** An object schema's declared entries, when the (unwrapped) node is one. */
const objectSchemaEntries = (
  schema: unknown,
): Record<string, unknown> | undefined => {
  const node = unwrappedSchema(schema);
  return isRecord(node) &&
    OBJECT_SCHEMA_TYPES.has(node["type"]) &&
    isRecord(node["entries"])
    ? node["entries"]
    : undefined;
};

/**
 * The schema node an issue was raised by, found from `schema` (the node the
 * issue's path is relative to) through object entries and array items. A path
 * through any other node is not followed.
 */
const schemaAtIssuePath = (
  schema: unknown,
  issue: v.BaseIssue<unknown>,
): unknown => {
  let node = unwrappedSchema(schema);
  for (const item of issue.path ?? []) {
    const entries = objectSchemaEntries(node);
    if (entries !== undefined && typeof item.key === "string") {
      node = unwrappedSchema(entries[item.key]);
    } else if (isRecord(node) && node["type"] === "array") {
      node = unwrappedSchema(node["item"]);
    } else {
      return undefined;
    }
  }
  return node;
};

/** A tagged union: the key every option fixes to a literal, and those options. */
type UnionDiscriminator = {
  key: string;
  options: readonly { literal: unknown; schema: v.GenericSchema }[];
};

/**
 * The discriminator of a `v.union` whose options are all objects fixing one
 * shared key to a literal (uploads.create's `purpose`); none for any other
 * union (`string | number`).
 */
const unionDiscriminator = (union: unknown): UnionDiscriminator | undefined => {
  if (
    !isRecord(union) ||
    union["type"] !== "union" ||
    !isUnknownArray(union["options"])
  ) {
    return undefined;
  }
  const options = union["options"].flatMap((option) => {
    const entries = objectSchemaEntries(option);
    return isValibotSchema(option) && entries !== undefined
      ? [{ entries, schema: option }]
      : [];
  });
  const first = options.at(0);
  if (first === undefined || options.length !== union["options"].length) {
    return undefined;
  }
  for (const key of Object.keys(first.entries)) {
    const literals = options.map(({ entries, schema }) => {
      const entry = entries[key];
      return isRecord(entry) && entry["type"] === "literal"
        ? { literal: entry["literal"], schema }
        : undefined;
    });
    if (literals.every((option) => option !== undefined)) {
      return { key, options: literals };
    }
  }
  return undefined;
};

// The values JSON has no text for are named by their type.
const receivedValue = (value: unknown): string =>
  value === undefined ||
  typeof value === "function" ||
  typeof value === "symbol"
    ? typeof value
    : JSON.stringify(value);

/**
 * A strict object's refusal of an undeclared key, which an agent reads as a
 * typo: the same `Unknown parameter` a key the route schema drops is reported
 * with.
 */
const isUnknownKeyIssue = (issue: v.BaseIssue<unknown>): boolean =>
  issue.type === "strict_object" &&
  issue.expected === "never" &&
  issue.path?.at(-1)?.origin === "key";

/**
 * Field-level issues for a refused part, where `schema` is the node the issues'
 * paths are relative to. A failed tagged union reports the way `v.variant`
 * would: a missing or unknown tag names the tag field and its allowed literals;
 * a known tag drills into that option's own failures. Any other union names
 * each option's own failures, under the union's path, instead of one opaque
 * "invalid type" for the whole node.
 */
const issuesAt = async (
  path: string,
  issues: readonly v.BaseIssue<unknown>[],
  schema: unknown,
): Promise<McpValidationIssue[]> => {
  const mapped = await Promise.all(
    issues.map(async (issue): Promise<McpValidationIssue[]> => {
      const issuePath = joinDot(path, v.getDotPath(issue) ?? "");
      if (isUnknownKeyIssue(issue)) {
        return [
          {
            path: issuePath,
            message: `Unknown parameter: ${String(issue.input)}`,
          },
        ];
      }
      if (issue.type !== "union" || issue.issues === undefined) {
        return [{ path: issuePath, message: issue.message }];
      }
      const union = schemaAtIssuePath(schema, issue);
      const discriminator = unionDiscriminator(union);
      if (discriminator === undefined) {
        return await issuesAt(issuePath, issue.issues, union);
      }
      const provided = isRecord(issue.input)
        ? issue.input[discriminator.key]
        : undefined;
      const matched = discriminator.options.find(
        ({ literal }) => literal === provided,
      );
      if (matched === undefined) {
        const allowed = discriminator.options
          .map(({ literal }) => receivedValue(literal))
          .join(" | ");
        return [
          {
            path: joinDot(issuePath, discriminator.key),
            message: `Invalid type: Expected one of ${allowed} but received ${receivedValue(provided)}`,
          },
        ];
      }
      const decoded = await v.safeParseAsync(matched.schema, issue.input);
      return decoded.success
        ? [{ path: issuePath, message: issue.message }]
        : await issuesAt(issuePath, decoded.issues, matched.schema);
    }),
  );
  return mapped.flat();
};

const partIssues = async (
  part: InputPart,
  issues: readonly v.BaseIssue<unknown>[],
  schema: v.GenericSchema,
): Promise<McpValidationIssue[]> => {
  const seen = new Set<string>();
  return (await issuesAt(part, issues, schema)).filter((issue) => {
    const key = JSON.stringify([issue.path, issue.message]);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};

type PartValidation =
  | { ok: true; value: unknown }
  | { ok: false; issues: McpValidationIssue[]; hint?: string };

/**
 * Validate one input part (`body`/`params`/`query`) with the route's own
 * schema, the way a request is decoded. The agent boundary first repairs the
 * value against the part's advertised rendering (nulls, declared spellings);
 * path and query values then travel as the strings a browser would send, so
 * the route reads them exactly as it reads a request. Undeclared keys the
 * schema drops are reported as typos: the agent surface is deliberately
 * stricter than REST. A missing schema passes the value through. Issue paths
 * are part-prefixed so an agent sees `body.matterId`, not a bare `matterId`.
 */
const validatePart = async ({
  advertised,
  allowedRemovedPaths = [],
  part,
  schema,
  value,
}: {
  advertised: JsonSchema | undefined;
  allowedRemovedPaths?: readonly string[];
  part: InputPart;
  schema: v.GenericSchema | undefined;
  value: unknown;
}): Promise<PartValidation> => {
  if (schema === undefined) {
    return { ok: true, value };
  }
  // Object schemas are the norm; default an absent value to `{}` so required
  // fields surface as issues rather than a whole-object "expected object" error.
  const base = value === undefined ? {} : structuredClone(value);
  const normalized = normalizeInputAtBoundary({
    // A capability can write, and its catalog entry is not the tool's access,
    // so a placeholder is asked about rather than read as "not set".
    access: "write",
    path: part,
    schema: advertised,
    value: base,
  });
  if (!normalized.ok) {
    return {
      ok: false,
      issues: [...normalized.issues],
      hint: normalized.hint,
    };
  }
  const decoded = await v.safeParseAsync(
    schema,
    part === "body" ? normalized.value : toWireInput(normalized.value),
  );
  if (!decoded.success) {
    return {
      ok: false,
      issues: await partIssues(part, decoded.issues, schema),
    };
  }
  const removedIssues = findRemovedInputIssues({
    allowedRemovedPaths,
    before: normalized.value,
    after: decoded.output,
    path: part,
  });
  if (removedIssues.length > 0) {
    return { ok: false, issues: removedIssues };
  }
  return { ok: true, value: decoded.output };
};

// --- Result mapping ----------------------------------------------------------

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
): InternalToolErrorResult => {
  if (isRecord(responseBody) && isActionAdmissionCode(responseBody["code"])) {
    const code = responseBody["code"];
    const refusal = ACTION_ADMISSION_REFUSALS[code];
    return structuredErrorResult({
      code,
      message: refusal.message,
      hint:
        typeof responseBody["hint"] === "string"
          ? responseBody["hint"]
          : refusal.hint,
      retryable: refusal.retryable,
      contactUrl:
        typeof responseBody["contactUrl"] === "string"
          ? responseBody["contactUrl"]
          : undefined,
    });
  }
  // A search capability whose index could not be reached answers a 503 with
  // the typed body; it reads as the tools' retryable envelope, not a failure
  // of the capability.
  if (
    isRecord(responseBody) &&
    responseBody["code"] === SEARCH_INDEX_UNAVAILABLE_CODE
  ) {
    return searchIndexUnavailableResult(responseBody);
  }
  const code = statusCodeToErrorCode(statusCode);
  const message = statusResponseMessage(responseBody);
  if (code === "internal_error") {
    return structuredErrorResult({
      code,
      message: "The capability handler failed",
      hint: MCP_INTERNAL_ERROR_HINT,
    });
  }
  return structuredErrorResult(
    projectMcpRefusal({
      status: statusCode,
      code:
        isRecord(responseBody) && typeof responseBody["code"] === "string"
          ? responseBody["code"]
          : undefined,
      message,
      issues: isRecord(responseBody) ? responseBody["issues"] : undefined,
      hint:
        isRecord(responseBody) && typeof responseBody["hint"] === "string"
          ? responseBody["hint"]
          : undefined,
      retryable:
        isRecord(responseBody) && typeof responseBody["retryable"] === "boolean"
          ? responseBody["retryable"]
          : undefined,
    }),
  );
};

const CAPABILITY_TRANSPORT_OUTPUT_SCHEMA = v.strictObject({
  type: v.picklist(["json", "file-input", "file-response", "file-both"]),
  invocable: v.boolean(),
  fileField: v.nullable(v.string()),
  fileFieldRequired: v.nullable(v.boolean()),
  fileMediaTypes: v.array(v.string()),
  responseMediaTypes: v.array(v.string()),
  alternative: v.nullable(v.string()),
});

const CAPABILITY_DISPOSITION_OUTPUT_SCHEMA = v.variant("type", [
  v.strictObject({ type: v.literal("tool"), name: v.string() }),
  v.strictObject({ type: v.literal("covered"), by: v.string() }),
  v.strictObject({ type: v.literal("capability"), reason: v.string() }),
]);

const LIST_CAPABILITIES_OUTPUT_SCHEMA = v.strictObject({
  items: v.array(
    v.strictObject({
      id: v.string(),
      summary: v.string(),
      description: v.nullable(v.string()),
      access: v.picklist(["read", "write"]),
      destructive: v.boolean(),
      confirmation: v.picklist(["required", "not-required"]),
      handlerKind: v.picklist(HANDLER_KINDS),
      transport: CAPABILITY_TRANSPORT_OUTPUT_SCHEMA,
      scope: v.string(),
      additionalScopes: v.array(v.string()),
    }),
  ),
  nextCursor: v.nullable(v.string()),
  limit: v.pipe(v.number(), v.integer()),
});

const DESCRIBE_CAPABILITY_OUTPUT_SCHEMA = v.strictObject({
  id: v.string(),
  description: v.nullable(v.string()),
  domain: v.string(),
  access: v.picklist(["read", "write"]),
  destructive: v.boolean(),
  confirmation: v.picklist(["required", "not-required"]),
  handlerKind: v.picklist(HANDLER_KINDS),
  scope: v.string(),
  additionalScopes: v.array(v.string()),
  transport: CAPABILITY_TRANSPORT_OUTPUT_SCHEMA,
  allowsArchivedWorkspace: v.boolean(),
  feature: v.nullable(v.string()),
  permissions: v.nullable(v.unknown()),
  disposition: CAPABILITY_DISPOSITION_OUTPUT_SCHEMA,
  inputSchema: v.unknown(),
});

const INVOKE_CAPABILITY_OUTPUT_SCHEMA = v.strictObject({ result: v.unknown() });

// --- list_capabilities -------------------------------------------------------

const CAPABILITY_ACCESS_FILTERS = ["all", "read", "write"] as const;

const listCapabilitiesArgsSchema = nullAsAbsent(
  v.strictObject({
    domain: v.optional(
      v.pipe(
        v.string(),
        v.description(
          'Filter to one capability domain: the id prefix before the first dot (e.g. "time-entries", "invoices").',
        ),
      ),
    ),
    query: v.optional(
      v.pipe(
        v.string(),
        v.description(
          "Search capability ids, generated titles, and descriptions. Results are ranked by relevance.",
        ),
      ),
    ),
    access: v.optional(
      v.pipe(
        v.picklist(CAPABILITY_ACCESS_FILTERS),
        v.description("Filter by access level."),
      ),
      "all",
    ),
    cursor: cursorInput({
      description:
        "Opaque pagination cursor from a previous page; omit for the first page.",
    }),
    limit: v.optional(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
        v.maxValue(MAX_LIST_LIMIT),
        v.description("Maximum capabilities to return."),
      ),
      DEFAULT_LIST_LIMIT,
    ),
  }),
);

const contextFeatureEnabled = (
  feature: string | undefined,
  context: McpRequestContext | undefined,
): boolean =>
  (
    context?.testDependencies?.isCapabilityFeatureEnabled ??
    isCapabilityFeatureEnabled
  )(feature);

const capabilityFeatureEnabled = (
  entry: CatalogEntry,
  context: McpRequestContext,
) =>
  entry.featureAccess === "conditional" ||
  isMcpDescriptorFeatureEnabled({
    context,
    kind: "capabilities",
    id: entry.id,
    featureId: entry.featureId,
  });

export const accessibleFeatureCapabilityIds = async (
  context: McpRequestContext,
): Promise<string[]> =>
  (await getCatalog())
    .filter(
      (entry) =>
        resolveMcpDescriptorFeatureId({
          context,
          kind: "capabilities",
          id: entry.id,
          featureId: entry.featureId,
        }) !== undefined &&
        isMcpDescriptorFeatureEnabled({
          context,
          kind: "capabilities",
          id: entry.id,
          featureId: entry.featureId,
        }) &&
        contextFeatureEnabled(entry.feature, context),
    )
    .map((entry) => entry.id);

/**
 * Catalog capability ids gated off in this deployment, sorted: the ids
 * `list_capabilities` hides and describe/invoke refuse with `feature_disabled`.
 * The MCP transport attests them on every authenticated response so a client
 * with a baked-in catalog can mark those commands instead of offering them.
 */
export const featureOmittedCapabilityIds = async (
  isFeatureEnabled: (
    feature: string | undefined,
  ) => boolean = isCapabilityFeatureEnabled,
  context?: AuthorizedMcpRequestContext,
): Promise<readonly string[]> =>
  (await getCatalog())
    .filter(
      (entry) =>
        !isFeatureEnabled(entry.feature) &&
        isMcpDescriptorFeatureEnabled({
          context,
          kind: "capabilities",
          id: entry.id,
          featureId: entry.featureId,
        }),
    )
    .map((entry) => entry.id)
    .toSorted();

const listCapabilitiesHandler: McpToolHandler<
  v.InferInput<typeof LIST_CAPABILITIES_OUTPUT_SCHEMA>
> = async ({
  args,
  context,
}: {
  args: Record<string, unknown>;
  context: AuthorizedMcpRequestContext;
}) => {
  const parsed = v.safeParse(listCapabilitiesArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }
  const { domain, access, cursor, limit } = parsed.output;
  const query = parsed.output.query?.trim() || undefined;

  const decodedCursor =
    cursor === undefined ? undefined : decodeCapabilityCursor(cursor);
  // A cursor resumes only the listing that issued it: an id-order cursor
  // carries no query, a relevance cursor carries its query.
  if (
    decodedCursor === null ||
    (decodedCursor !== undefined && decodedCursor.query !== query)
  ) {
    return invalidCursorResult({
      cursor: cursor ?? "",
      tool: "list_capabilities",
    });
  }
  const afterId = decodedCursor?.afterId;

  // Feature-gated entries whose flag is off are not advertised, matching how
  // the static tools/list hides gated-off tools (describe/invoke also refuse
  // them, closing the guess-the-id bypass).
  // A session that cannot confirm is not offered destructive capabilities;
  // invoke refuses them for it as well.
  const confirmable =
    context.toolConfirmation !== TOOL_CONFIRMATION.unavailable;
  const matching = (await getCatalog()).filter(
    (entry) =>
      contextFeatureEnabled(entry.feature, context) &&
      capabilityFeatureEnabled(entry, context) &&
      (confirmable || !requiresCapabilityConfirmation(entry)) &&
      (domain === undefined || capabilityDomain(entry.id) === domain) &&
      (access === "all" || entry.access === access),
  );
  let filtered: CatalogEntry[];
  if (query === undefined) {
    // Id order: a cursor whose entry has since been hidden still resumes after it.
    filtered = matching.filter(
      (entry) => afterId === undefined || entry.id > afterId,
    );
  } else {
    // Relevance order: the cursor must name an entry of this same ranking.
    const ranked = matching
      .map((entry) => ({ entry, rank: capabilityQueryRank(entry, query) }))
      .filter(({ rank }) => rank > 0)
      .toSorted(
        (left, right) =>
          right.rank - left.rank || byCapabilityId(left.entry, right.entry),
      )
      .map(({ entry }) => entry);
    const cursorIndex =
      afterId === undefined ? -1 : ranked.findIndex(({ id }) => id === afterId);
    if (afterId !== undefined && cursorIndex < 0) {
      return invalidCursorResult({
        cursor: cursor ?? "",
        tool: "list_capabilities",
      });
    }
    filtered = ranked.slice(cursorIndex + 1);
  }
  const { DEFAULT_MCP_TOOL_DEFINITIONS } =
    await import("@/api/mcp/static-tool-definitions");
  const hiddenIds = hiddenMcpDescriptorIds(
    context,
    DEFAULT_MCP_TOOL_DEFINITIONS,
  );
  const page = filtered.slice(0, limit);
  const last = page.at(-1);
  const nextCursor =
    last !== undefined && filtered.length > page.length
      ? encodePaginationCursor(
          query === undefined ? [last.id] : [last.id, query],
        )
      : null;

  return structuredEgressPlan({
    payload: projectionPayload(LIST_CAPABILITIES_OUTPUT_SCHEMA, {
      items: page.map((entry) => ({
        id: entry.id,
        summary: scopeMcpDescriptorProse(summarizeEntry(entry), hiddenIds),
        description:
          entry.description === undefined
            ? null
            : scopeMcpDescriptorProse(entry.description, hiddenIds),
        access: entry.access,
        destructive: entry.destructive,
        confirmation: requiresCapabilityConfirmation(entry)
          ? "required"
          : "not-required",
        handlerKind: entry.handlerKind,
        transport: renderTransport(entry.transport),
        scope: entry.scope,
        additionalScopes: additionalScopesOf(entry),
      })),
      nextCursor,
      limit,
    }),
    textFields: [],
  });
};

const accessLabel = (entry: CatalogEntry): string =>
  entry.destructive ? "write, destructive" : entry.access;

const summarizeEntry = (entry: CatalogEntry): string =>
  `${capabilityDomain(entry.id)} / ${capabilityLeaf(entry.id)} (${accessLabel(entry)})`;

const capabilityTitle = (id: string): string => id.replaceAll(/[.-]/gu, " ");

const queryWords = (value: string): string[] =>
  Array.from(
    value.toLocaleLowerCase("en-US").matchAll(/[\p{L}\p{N}]+/gu),
    ([word]) => word,
  );

const wordMatches = (candidate: string, query: string): boolean =>
  candidate === query ||
  candidate.startsWith(query) ||
  query.startsWith(candidate);

const capabilityQueryRank = (entry: CatalogEntry, query: string): number => {
  const normalizedQuery = query.toLocaleLowerCase("en-US");
  const id = entry.id.toLocaleLowerCase("en-US");
  const title = capabilityTitle(entry.id).toLocaleLowerCase("en-US");
  const description = entry.description?.toLocaleLowerCase("en-US") ?? "";
  const words = queryWords(normalizedQuery);
  const idWords = queryWords(id);
  const titleWords = queryWords(title);

  let rank = 0;
  if (description.includes(normalizedQuery)) {
    rank = 100;
  }
  if (title.includes(normalizedQuery)) {
    rank = 800;
  }
  if (id.includes(normalizedQuery)) {
    rank = 1000;
  }
  for (const word of words) {
    if (idWords.some((candidate) => wordMatches(candidate, word))) {
      rank += 100;
    } else if (titleWords.some((candidate) => wordMatches(candidate, word))) {
      rank += 80;
    } else if (description.includes(word)) {
      rank += 10;
    } else {
      return 0;
    }
  }
  return rank;
};

const byCapabilityId = (left: CatalogEntry, right: CatalogEntry): number => {
  if (left.id === right.id) {
    return 0;
  }
  return left.id < right.id ? -1 : 1;
};

const decodeCapabilityCursor = (
  cursor: string,
): { afterId: string; query: string | undefined } | null => {
  const decoded = decodePaginationCursor(cursor);
  if (decoded === null) {
    return null;
  }
  const [afterId, query, ...rest] = decoded;
  if (
    typeof afterId !== "string" ||
    (query !== undefined && typeof query !== "string") ||
    rest.length > 0
  ) {
    return null;
  }
  return { afterId, query };
};

// --- describe_capability -----------------------------------------------------

const notFoundWithHint = async (
  id: string,
  context: AuthorizedMcpRequestContext,
): Promise<InternalToolErrorResult> =>
  notFoundResult(
    `No capability with id "${id}"`,
    await hintForUnknownId(id, context),
  );

/**
 * Refusal for a capability whose deployment feature flag is off. Same message
 * as the static-tool dispatch guard (tools.ts) so agents see one behavior for
 * gated-off surface, tool or capability.
 */
const featureDisabledResult = (
  feature: string | undefined,
): InternalToolErrorResult =>
  structuredErrorResult({
    code: "feature_disabled",
    message: FEATURE_DISABLED_MESSAGE,
    hint: featureDisabledHint(feature),
  });

const hintForUnknownId = async (
  id: string,
  context: AuthorizedMcpRequestContext,
): Promise<string> => {
  const suggestions = closestToolNames(
    id,
    (await getCatalog())
      .filter(
        (entry) =>
          capabilityFeatureEnabled(entry, context) &&
          contextFeatureEnabled(entry.feature, context),
      )
      .map((entry) => entry.id),
  );
  return suggestions.length > 0
    ? `${didYouMean(suggestions.map(quoteToolName))} Call list_capabilities to browse the full set.`
    : "Call list_capabilities to browse available capability ids.";
};

const describeCapabilityArgsSchema = nullAsAbsent(
  v.strictObject({
    capability: v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(MAX_TOOL_NAME_CHARS),
      v.description(
        'Capability id to describe, as returned by list_capabilities (e.g. "time-entries.create").',
      ),
    ),
  }),
);

type GuardedEndpoint =
  | { ok: true; endpoint: EndpointDefinition }
  | { ok: false; result: InternalToolErrorResult };

/**
 * Load a capability's endpoint with failures contained: a rejecting dynamic
 * import (or a module without the `{ config, handler }` shape) is captured and
 * mapped to a structured `internal_error` envelope instead of escaping as an
 * unhandled rejection. Shared by `describe_capability` and the capability executors.
 */
type LoadEndpointGuardedOptions = {
  id: string;
  toolName: "describe_capability" | McpCapabilityExecutor;
  loadEndpoint?: typeof loadCapabilityEndpoint | undefined;
};

const loadEndpointGuarded = async ({
  id,
  toolName,
  loadEndpoint = loadCapabilityEndpoint,
}: LoadEndpointGuardedOptions): Promise<GuardedEndpoint> => {
  let endpoint: EndpointDefinition | null;
  try {
    endpoint = await loadEndpoint(id);
  } catch (error) {
    captureError(
      error,
      handlerErrorContext("mcp.loadEndpoint", { source: "mcp", toolName }),
    );
    endpoint = null;
  }
  if (!endpoint) {
    captureError(
      new Error(`capability dispatch missing endpoint: ${id}`),
      handlerErrorContext("mcp.missingEndpoint", {
        source: "mcp",
        toolName,
      }),
    );
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

const describeCapabilityHandler: McpToolHandler<
  v.InferInput<typeof DESCRIBE_CAPABILITY_OUTPUT_SCHEMA>
> = async ({
  args,
  context,
}: {
  args: Record<string, unknown>;
  context: AuthorizedMcpRequestContext;
}) => {
  const parsed = v.safeParse(describeCapabilityArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }
  const id = parsed.output.capability;
  const entry = (await getCatalogById()).get(id);
  if (!entry) {
    return notFoundWithHint(id, context);
  }

  // Caller-hidden entries share the unknown-id contract, including hints.
  if (!capabilityFeatureEnabled(entry, context)) {
    return notFoundWithHint(id, context);
  }
  if (!contextFeatureEnabled(entry.feature, context)) {
    return featureDisabledResult(entry.feature);
  }

  const loaded = await loadEndpointGuarded({
    id,
    toolName: "describe_capability",
    loadEndpoint: context.testDependencies?.loadCapabilityEndpoint,
  });
  if (!loaded.ok) {
    return loaded.result;
  }
  const endpoint = loaded.endpoint;

  // The advertised schemas are plain JSON Schema rendered from the route's
  // valibot schemas, so they can go on the payload as-is. Uses the live
  // config, never the snapshot,
  // so a snapshot-truncated capability still describes fully, and the same
  // `advertisedSchemas` projection the capability executors validate against, so an
  // advertised bound is always an enforced bound.
  const { DEFAULT_MCP_TOOL_DEFINITIONS } =
    await import("@/api/mcp/static-tool-definitions");
  const hiddenIds = hiddenMcpDescriptorIds(
    context,
    DEFAULT_MCP_TOOL_DEFINITIONS,
  );
  const schema = advertisedSchemas(endpoint.config);
  const requirement = endpoint.config.featureAccess;
  const callerSchema =
    requirement?.type === "conditional" &&
    !isMcpDescriptorFeatureEnabled({
      context,
      kind: "capabilities",
      id,
      featureId: requirement.featureId,
    })
      ? requirement.projectInputSchema(schema)
      : schema;
  // The executors read `matterId` and refuse the internal spelling, so the
  // description names the field the same way the catalog does.
  const inputSchema = {
    body: withPublicFieldNames(callerSchema.body),
    params: withPublicFieldNames(callerSchema.params),
    query: withPublicFieldNames(callerSchema.query),
  };

  return structuredEgressPlan({
    payload: projectionPayload(DESCRIBE_CAPABILITY_OUTPUT_SCHEMA, {
      id: entry.id,
      description:
        entry.description === undefined
          ? null
          : scopeMcpDescriptorProse(entry.description, hiddenIds),
      domain: capabilityDomain(entry.id),
      access: entry.access,
      destructive: entry.destructive,
      confirmation: requiresCapabilityConfirmation(entry)
        ? "required"
        : "not-required",
      handlerKind: entry.handlerKind,
      scope: entry.scope,
      additionalScopes: additionalScopesOf(entry),
      // Surfacing these lets an agent learn, before invoking, whether the
      // generic path can run the capability at all, which field (if any) it
      // must omit, where the work can be done instead, and whether the
      // capability tolerates an archived workspace (e.g. unarchive).
      transport: renderTransport(entry.transport),
      allowsArchivedWorkspace:
        endpoint.config.workspaceStatus === "active-or-archived",
      feature: entry.feature ?? null,
      permissions: entry.permissions ?? null,
      disposition: entry.mcp,
      inputSchema:
        hiddenIds.size === 0
          ? inputSchema
          : scopeSchemaAnnotations(inputSchema, hiddenIds),
    }),
    textFields: [],
  });
};

// --- capability executors -------------------------------------------------------

type InvokeInput = { body: unknown; params: unknown; query: unknown };

/** What a file transport prevents, phrased for the agent that just called it. */
const transportBlockReason = (transport: CapabilityTransport): string => {
  switch (transport.type) {
    case "json":
      return "";
    case "file-input":
      return `requires a file in \`${transport.input.field}\`, which JSON cannot carry`;
    case "file-response":
      return "returns a file or stream, which capability executors cannot serialize";
    case "file-both":
      return `requires a file in \`${transport.input.field}\` and returns a file or stream`;
    default: {
      transport satisfies never;
      return panic(`Unhandled transport: ${String(transport)}`);
    }
  }
};

/**
 * Refusal for a capability the generic transport cannot run, or `null` when it
 * can. The hint carries the alternative transport verbatim from the catalog, so
 * an agent gets a next call rather than a dead end.
 */
const transportRefusal = (
  id: string,
  transport: CapabilityTransport,
): InternalToolErrorResult | null => {
  if (isTransportInvocable(transport)) {
    return null;
  }
  const alternative = transportAlternative(transport);
  return structuredErrorResult({
    code: "feature_disabled",
    message: `Capability "${id}" ${transportBlockReason(transport)}, so it is not available through capability executors`,
    hint:
      alternative === undefined
        ? "Use its REST route or the stella app."
        : `${describeTransportAlternative(alternative)} Otherwise use its REST route or the stella app.`,
  });
};

/**
 * Refusal for a JSON call that carries the one field a fileless-mode capability
 * cannot accept, or `null` when it does not. Refusing beats ignoring: the field
 * would otherwise pass `format: "binary"` validation as a plain string and reach
 * a handler that expects a `File`.
 */
const filelessFieldRefusal = (
  id: string,
  transport: CapabilityTransport,
  input: InvokeInput,
): InternalToolErrorResult | null => {
  const field = filelessOnlyField(transport);
  if (field === undefined || !isRecord(input.body) || !(field in input.body)) {
    return null;
  }
  return structuredErrorResult({
    code: "validation_error",
    message: `Capability "${id}" cannot take \`${field}\` through capability executors: that field carries file bytes, which JSON cannot express`,
    hint: `Omit \`${field}\` and call again using this capability's other input modes; the file mode is only available through its REST route or the stella app.`,
  });
};

const invokeInputPartSchema = (description: string) =>
  v.optional(v.pipe(plainRecord(v.unknown()), v.description(description)));

const INVOKE_INPUT_PARTS = {
  body: invokeInputPartSchema(
    "Request body fields, per the capability's body schema.",
  ),
  params: invokeInputPartSchema(
    "Path parameters; matter-scoped capabilities require matterId here.",
  ),
  query: invokeInputPartSchema(
    "Query parameters, per the capability's query schema.",
  ),
};

const invokeFlagSchema = (description: string) =>
  v.optional(
    v.pipe(
      v.boolean(
        (issue) => `Expected a JSON boolean, got ${typeof issue.input}`,
      ),
      v.description(description),
    ),
  );

/**
 * The executors' own arguments, read strictly. A mistyped flag or a
 * misplaced input, read leniently, fails open: `validate_only: "true"`
 * silently read as `false` would EXECUTE a capability the caller intended as
 * a dry run, and a misspelt input part neither rejected nor read would run the
 * capability without the filter the agent asked for. Booleans must be JSON
 * booleans, and `input` and its body/params/query parts must be objects.
 * Never coerce, never ignore.
 */
const CAPABILITY_ARGUMENTS = {
  capability: v.pipe(
    v.string(),
    v.nonEmpty(),
    v.maxLength(MAX_TOOL_NAME_CHARS),
    v.description(
      "Capability id to invoke. Use an id list_capabilities returned.",
    ),
  ),
  input: v.optional(
    v.pipe(
      v.strictObject(INVOKE_INPUT_PARTS, (issue) =>
        // valibot reports a key outside the entries as expecting `never`.
        issue.expected === "never"
          ? `Unknown input part. Expected one of: ${Object.keys(INVOKE_INPUT_PARTS).join(", ")}`
          : "Expected an object",
      ),
      v.description(
        "The capability's input, split into the parts its schema declares.",
      ),
    ),
  ),
  validate_only: invokeFlagSchema(
    "When true, validate the input against the capability schema and return without executing.",
  ),
};

const readCapabilityArgsSchema = nullAsAbsent(
  v.strictObject(CAPABILITY_ARGUMENTS),
);
const writeCapabilityArgsSchema = nullAsAbsent(
  v.strictObject({
    ...CAPABILITY_ARGUMENTS,
    confirm: invokeFlagSchema(
      "Must be true to run a capability that requires confirmation. Set it only after a human user approved this operation.",
    ),
  }),
);

const CAPABILITY_ARGUMENT_SCHEMAS = {
  read: readCapabilityArgsSchema,
  write: writeCapabilityArgsSchema,
} as const satisfies Record<keyof typeof MCP_CAPABILITY_EXECUTORS, unknown>;

/**
 * Rename the public input field names back to the internal ones a handler
 * declares, walking the value alongside the schema that describes it.
 *
 * The container is a `matterId` to every agent and a `workspaceId` in the DB,
 * the handler config and the REST route. This is the inbound half of that
 * split, and the only place it happens: after it the raw input, the
 * config-schema validation and the workspace resolution all speak the internal
 * name, exactly as a REST call does. The outbound half is `withPublicFieldNames`
 * (apps/api/scripts/export-capability-catalog.ts), which advertises `matterId`.
 *
 * Two rules, both evaluated per NODE rather than per part, because the
 * container can sit inside a union branch, an array item or a sub-object
 * (`flows.create` body.trigger, `signals.acceptances.create` body.result):
 *
 *  - a node whose schema declares an internal name is projected: its public
 *    keys are renamed onto the internal ones;
 *  - on such a node the internal spelling is REFUSED rather than passed
 *    through. The rename is a clean cutover with no alias, so `workspaceId`
 *    is not a second accepted name for `matterId`; accepting it would also
 *    make the result depend on JSON key order when a caller sends both.
 *
 * A node that already owns the public name (`expenses.create` body declares
 * its own `matterId`) declares no internal name, so it is left alone. Any
 * unrecognized sibling is later reported by the agent-boundary Clean guard.
 *
 * Both directions come from `INTERNAL_FIELD_NAME`'s one table.
 */
type FieldProjection =
  { ok: true; value: unknown } | { ok: false; issues: McpValidationIssue[] };

const internalNameRefusal = (
  path: string,
  internal: string,
  publicName: string,
): McpValidationIssue => ({
  path: joinDot(path, publicName),
  message: `${internal} is the internal name for ${publicName}; send ${publicName}`,
});

/** The schema node describing one property of `schemaNode`, if it names one. */
const propertySchema = (schemaNode: unknown, name: string): unknown => {
  const properties = isRecord(schemaNode)
    ? schemaNode["properties"]
    : undefined;
  return isRecord(properties) ? properties[name] : undefined;
};

/** The schema node describing an array's items, if it names one. */
const itemsSchema = (schemaNode: unknown): unknown =>
  isRecord(schemaNode) ? schemaNode["items"] : undefined;

/**
 * The union branch that describes `value`, when the node is a union: the first
 * branch that declares an internal name AND fits the value's own keys. Picking
 * a branch matters only for deciding whether to project, so a wrong guess costs
 * nothing the validator will not catch.
 */
const unionBranchFor = (schemaNode: unknown, value: unknown): unknown => {
  if (!isRecord(schemaNode) || !isRecord(value)) {
    return undefined;
  }
  for (const keyword of ["anyOf", "oneOf", "allOf"]) {
    const branches = schemaNode[keyword];
    if (!isUnknownArray(branches)) {
      continue;
    }
    const match = branches.find(
      (branch) =>
        declaresInternalField(branch) &&
        Object.keys(value).some(
          (key) =>
            propertySchema(branch, INTERNAL_FIELD_NAME[key] ?? key) !==
            undefined,
        ),
    );
    if (match !== undefined) {
      return match;
    }
  }
  return undefined;
};

const withInternalFieldNames = ({
  alwaysProject = false,
  path,
  schema,
  value,
}: {
  /** Path params carry the container even when no config schema declares it. */
  alwaysProject?: boolean;
  path: string;
  schema: unknown;
  value: unknown;
}): FieldProjection => {
  if (isUnknownArray(value)) {
    const items = itemsSchema(schema);
    const issues: McpValidationIssue[] = [];
    const projected = value.map((entry, index) => {
      const result = withInternalFieldNames({
        path: joinDot(path, String(index)),
        schema: items,
        value: entry,
      });
      if (!result.ok) {
        issues.push(...result.issues);
        return entry;
      }
      return result.value;
    });
    return issues.length > 0
      ? { ok: false, issues }
      : { ok: true, value: projected };
  }
  if (!isRecord(value)) {
    return { ok: true, value };
  }

  const node = declaresInternalField(schema)
    ? schema
    : (unionBranchFor(schema, value) ?? schema);
  const project = alwaysProject || declaresInternalField(node);
  const issues: McpValidationIssue[] = [];
  const projected: Record<string, unknown> = {};

  for (const [name, entry] of Object.entries(value)) {
    const publicName = project ? PUBLIC_FIELD_NAME[name] : undefined;
    if (publicName !== undefined) {
      issues.push(internalNameRefusal(path, name, publicName));
      continue;
    }
    const internalName = project ? (INTERNAL_FIELD_NAME[name] ?? name) : name;
    const child = withInternalFieldNames({
      path: joinDot(path, name),
      schema: propertySchema(node, internalName),
      value: entry,
    });
    if (!child.ok) {
      issues.push(...child.issues);
      continue;
    }
    projected[internalName] = child.value;
  }

  return issues.length > 0
    ? { ok: false, issues }
    : { ok: true, value: projected };
};

/** Resolve the workspace id for a workspace-kind capability from `input.params.matterId`. */
const resolveCapabilityWorkspace = ({
  context,
  params,
  workspaceStatus,
}: {
  context: AuthorizedMcpRequestContext;
  params: unknown;
  workspaceStatus: WorkspaceStatusAccess;
}):
  | { ok: true; workspaceId: SafeId<"workspace"> }
  | { ok: false; result: InternalToolErrorResult } => {
  const rawId = isRecord(params) ? params["workspaceId"] : undefined;
  if (typeof rawId !== "string" || rawId.length === 0) {
    return {
      ok: false,
      result: structuredErrorResult({
        code: "validation_error",
        message:
          "This capability is matter-scoped and requires input.params.matterId",
        issues: [
          {
            path: "params.matterId",
            message: "Provide the target matter id as a non-empty string",
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
      result: notFoundResult("Matter not found or not accessible"),
    };
  }
  // The route's own admission (`authorizeWorkspace` in lib/auth.ts): a
  // workspace route refuses ANY non-active matter, reads included, unless it
  // admits archived ones (`workspaceStatus: "active-or-archived"`, e.g.
  // unarchive). Deleting workspaces never enter
  // `accessibleWorkspaceStatusById`, so this branch only ever sees
  // active/archived.
  if (
    workspaceStatus !== "active-or-archived" &&
    getWorkspaceStatus({ context, workspaceId: rawId }) !== "active"
  ) {
    return {
      ok: false,
      result: notFoundResult(
        "Matter is archived; unarchive it before invoking capabilities against it",
      ),
    };
  }
  if (context.pinServerValidatedWorkspaceId?.(branded) === false) {
    return {
      ok: false,
      result: notFoundResult("Matter not found or not accessible"),
    };
  }
  return { ok: true, workspaceId: branded };
};

type CapabilityTarget =
  | {
      ok: true;
      workspaceId: SafeId<"workspace"> | undefined;
      params: unknown;
    }
  | { ok: false; result: InternalToolErrorResult };

/**
 * The matter a workspace-kind capability runs against, from the RAW input
 * params (route parity: REST reads the path segment independently of the
 * handler config schema), and the params its handler sees. A missing,
 * inaccessible or archived matter fails here with the same envelope it would
 * at execution, so `validateOnly` never reports a spurious `{ valid: true }`.
 */
const resolveCapabilityTarget = ({
  config,
  context,
  isWorkspace,
  rawParams,
  validatedParams,
}: {
  config: EndpointConfig;
  context: AuthorizedMcpRequestContext;
  isWorkspace: boolean;
  rawParams: unknown;
  validatedParams: unknown;
}): CapabilityTarget => {
  if (!isWorkspace) {
    return { ok: true, workspaceId: undefined, params: validatedParams };
  }
  const resolved = resolveCapabilityWorkspace({
    context,
    params: rawParams,
    workspaceStatus: config.workspaceStatus ?? "active",
  });
  if (!resolved.ok) {
    return resolved;
  }
  // The handler's params are the config-declared fields plus workspaceId, as
  // a REST workspace route's are. Without a config params schema, params is
  // exactly { workspaceId }.
  return {
    ok: true,
    workspaceId: resolved.workspaceId,
    params: {
      ...(isRecord(validatedParams) && config.params !== undefined
        ? validatedParams
        : {}),
      workspaceId: resolved.workspaceId,
    },
  };
};

type CapabilityServiceClassificationOptions = {
  args: unknown;
  context: McpRequestContext;
  access: keyof typeof MCP_CAPABILITY_EXECUTORS;
};

export const invokedCapabilityConsumesServices = async ({
  args,
  context,
  access,
}: CapabilityServiceClassificationOptions) => {
  const parsed = v.safeParse(CAPABILITY_ARGUMENT_SCHEMAS[access], args);
  if (!parsed.success || parsed.output.validate_only === true) {
    // Invalid calls reach canonical validation without executing work.
    return Result.ok(false);
  }
  const entry = (await getCatalogById()).get(parsed.output.capability);
  if (
    entry === undefined ||
    entry.access !== access ||
    !capabilityFeatureEnabled(entry, context)
  ) {
    return Result.ok(false);
  }
  if (typeof entry.consumesServices === "boolean") {
    return Result.ok(entry.consumesServices);
  }
  const loaded = await loadEndpointGuarded({
    id: entry.id,
    toolName: MCP_CAPABILITY_EXECUTORS[entry.access],
    loadEndpoint: context.testDependencies?.loadCapabilityEndpoint,
  });
  if (!loaded.ok) {
    return Result.err(loaded.result);
  }
  return classifyValidatedCapabilityServiceInput({
    config: loaded.endpoint.config,
    entry,
    publicInput: {
      body: parsed.output.input?.body,
      params: parsed.output.input?.params,
      query: parsed.output.input?.query,
    },
  });
};

type InvokeCapabilityOptions = {
  args: Record<string, unknown>;
  context: AuthorizedMcpRequestContext;
  access: keyof typeof MCP_CAPABILITY_EXECUTORS;
};

const invokeCapabilityHandler = async ({
  args,
  context,
  access,
}: InvokeCapabilityOptions): Promise<McpToolResponse> => {
  // 0. The meta-tool's own argument shapes, before ANY gate: neither a
  // mistyped flag nor a misplaced input may be read leniently
  // (`validate_only: "true"` would fail open into executing a request that
  // intended a dry run; a top-level `query` would run the capability with no
  // input at all).
  const parsed = v.safeParse(CAPABILITY_ARGUMENT_SCHEMAS[access], args);
  if (!parsed.success) {
    return validationErrorResult(
      parsed.issues,
      "Fix the arguments named in issues[]: the capability's own input goes under input: { body, params, query }, boolean flags must be JSON booleans (not strings), and input and its parts must be objects.",
    );
  }
  const {
    capability: id,
    input: rawInput,
    validate_only: validateOnlyFlag,
  } = parsed.output;
  const confirm = "confirm" in parsed.output && parsed.output.confirm === true;

  const entry = (await getCatalogById()).get(id);

  // 1. Unknown id -> not_found with a closest-id hint.
  if (!entry) {
    return notFoundWithHint(id, context);
  }

  // 2. Caller admission precedes deployment availability for discovery parity.
  if (!capabilityFeatureEnabled(entry, context)) {
    return notFoundWithHint(id, context);
  }
  if (!contextFeatureEnabled(entry.feature, context)) {
    return featureDisabledResult(entry.feature);
  }

  if (entry.access !== access) {
    return structuredErrorResult({
      code: "validation_error",
      message: `Capability "${id}" requires the ${entry.access} executor`,
      hint: `Call ${MCP_CAPABILITY_EXECUTORS[entry.access]} with the same capability and input.`,
    });
  }

  // 3. Disposition / fidelity. token/public capabilities self-authorize from a
  // body/param token and are not reachable through the generic path; a waived
  // capability's handler needs response plumbing the synthesized context drops.
  if (entry.handlerKind === "token" || entry.handlerKind === "public") {
    return notFoundResult(
      `Capability "${id}" is not invokable through capability executors`,
      "This operation authorizes itself differently; use its dedicated surface.",
    );
  }
  const waiver = (
    context.testDependencies?.contextFidelityWaivers ?? CONTEXT_FIDELITY_WAIVERS
  ).get(id);
  if (waiver !== undefined) {
    return structuredErrorResult({
      code: "feature_disabled",
      message: `Capability "${id}" cannot run through capability executors: ${waiver}`,
      hint: "Perform this operation in the stella app, which has the required request context.",
    });
  }
  // File transport. A file response cannot be serialized, and a REQUIRED file
  // input cannot be supplied (a plain string passes `format: "binary"`
  // validation and reaches a handler expecting a `File`), so refuse
  // pre-execution — before validateOnly too, which would otherwise report
  // `valid: true` for an un-runnable input. A runtime backstop in
  // mapHandlerResult still catches any file value that slips past. The refusal
  // names the alternative transport instead of stopping at "not available".
  const transportBlock = transportRefusal(id, entry.transport);
  if (transportBlock !== null) {
    return transportBlock;
  }

  // 4. Scopes: the session must hold every scope in the capability catalog. Read
  // capabilities now resolve to a read scope (see the exporter's access-keyed
  // resolution), so a `stella:read` grant reaches them directly.
  const requiredScopes = requiredScopesOf(entry);
  const missingScope = requiredScopes.find(
    (scope) => !context.grantedScopes.includes(scope),
  );
  if (missingScope !== undefined) {
    return structuredErrorResult({
      code: "missing_scope",
      message: `Insufficient permissions. Capability "${id}" requires scope: ${missingScope}`,
      hint: oauthScopeRecoveryHint({
        grantedScopes: context.grantedScopes,
        missingScope,
        requiredScopes,
      }),
    });
  }

  const unconfirmable = requiresCapabilityConfirmation(entry)
    ? confirmationUnavailableResult({
        toolConfirmation: context.toolConfirmation,
        subject: `Capability "${id}"`,
      })
    : null;
  if (unconfirmable !== null) {
    return unconfirmable;
  }
  const input: InvokeInput = {
    body: rawInput?.body,
    params: rawInput?.params,
    query: rawInput?.query,
  };
  const validateOnly = validateOnlyFlag === true;

  // 6. Fileless mode. This capability reached here because its file field is
  // OPTIONAL, so the JSON modes run; the field itself still cannot cross. It is
  // refused rather than dropped, because a caller who sent bytes-as-a-string
  // must not get a silent success computed from the other sources.
  const filelessBlock = filelessFieldRefusal(id, entry.transport, input);
  if (filelessBlock !== null) {
    return filelessBlock;
  }

  try {
    return await withExceptionScope(
      { type: "handler", handlerId: `mcp.capability.${entry.id}` },
      async () =>
        await executeInvoke({
          context: requiresCapabilityConfirmation(entry)
            ? bindApprovedMcpAuditContext(context)
            : context,
          entry,
          id,
          input,
          validateOnly,
          confirm,
        }),
    );
  } catch (error) {
    captureError(error, {
      fingerprintKey: "mcp.invokeCapabilityHandler",
      scope: { type: "handler", handlerId: `mcp.capability.${entry.id}` },
      context: {
        source: "mcp",
        toolName: MCP_CAPABILITY_EXECUTORS[access],
      },
    });
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
 *   executor tool itself; gate 4 rechecks the per-capability catalog
 *   scope against the session's grants.
 * - Destructive confirm (tools.ts destructiveHint): gate 5, from the catalog's
 *   per-capability `destructive` flag.
 * - Workspace access (per-tool `ensureActiveWorkspace` bridging): gate 7
 *   mirrors the route's `workspaceStatus` (archived admitted per that flag).
 * - Member permissions + usage preflight: run inside the safe-handler wrapper
 *   (`endpoint.handler`), the same code path REST uses; validateOnly
 *   additionally mirrors the permission gate explicitly (the wrapper is not
 *   called on that path).
 * - Egress finalization + anonymization (finalizeToolEgress): applied by
 *   handleMcpToolCall to this handler's returned egress plan exactly as for
 *   any static tool; anonymized mode never reaches here (tools excluded).
 * - internal_error capture (tools.ts try/catch): invokeCapabilityHandler wraps
 *   this function in its own try/catch with captureError.
 * - Invoke-only gates with no static equivalent: context-fidelity waivers,
 *   file-response/file-input refusals, token/public-kind refusal, and the
 *   per-(org, capability) rate limit (static tools hand-write their bridging
 *   and REST routes carry their own limits).
 */
type ValidateInvokeInputOptions = {
  config: EndpointConfig;
  entry: Pick<CatalogEntry, "handlerKind" | "transport">;
  publicInput: InvokeInput;
};

const validateInvokeInput = async ({
  config,
  entry,
  publicInput,
}: ValidateInvokeInputOptions) => {
  const isWorkspace = entry.handlerKind === "workspace";
  const advertised = advertisedSchemas(config);
  // The public field names go back to the internal ones here, before anything
  // reads the input, so the rest of this function is the REST boundary verbatim.
  // A refusal (the caller sent an internal spelling) is reported before
  // validation, against the public name the schema actually advertises.
  const projections = [
    withInternalFieldNames({
      path: "body",
      schema: advertised.body,
      value: publicInput.body,
    }),
    withInternalFieldNames({
      alwaysProject: true,
      path: "params",
      schema: advertised.params,
      value: publicInput.params,
    }),
    withInternalFieldNames({
      path: "query",
      schema: advertised.query,
      value: publicInput.query,
    }),
  ] as const;
  const projectionIssues = projections.flatMap((projection) =>
    projection.ok ? [] : projection.issues,
  );
  if (projectionIssues.length > 0) {
    return {
      status: "invalid" as const,
      result: structuredErrorResult({
        code: "validation_error",
        message: "Capability input failed validation",
        issues: projectionIssues,
        hint: "Fix the fields named in issues[] and retry.",
      }),
    };
  }
  const [projectedBody, projectedParams, projectedQuery] = projections;
  const input: InvokeInput = {
    body: projectedBody.ok ? projectedBody.value : publicInput.body,
    params: projectedParams.ok ? projectedParams.value : publicInput.params,
    query: projectedQuery.ok ? projectedQuery.value : publicInput.query,
  };
  // A fileless call omits the file field; the field is optional, so the
  // route still accepts the body without it, and sending it is a typo.
  const filelessField = filelessOnlyField(entry.transport);
  const filelessIssues =
    filelessField !== undefined &&
    isRecord(input.body) &&
    input.body[filelessField] !== undefined
      ? [
          {
            path: prefixPartPath("body", filelessField),
            message: `Unknown parameter: ${filelessField}`,
          },
        ]
      : [];
  const validations: readonly [PartValidation, PartValidation, PartValidation] =
    [
      filelessIssues.length > 0
        ? { ok: false, issues: filelessIssues }
        : await validatePart({
            advertised: advertised.body,
            part: "body",
            schema: config.body,
            value: input.body,
          }),
      await validatePart({
        advertised: advertised.params,
        allowedRemovedPaths: isWorkspace ? ["params.workspaceId"] : [],
        part: "params",
        schema: config.params,
        value: input.params,
      }),
      await validatePart({
        advertised: advertised.query,
        part: "query",
        schema: config.query,
        value: input.query,
      }),
    ];

  const issues = validations.flatMap((result) =>
    result.ok ? [] : result.issues.map(toPublicIssue),
  );
  if (issues.length > 0) {
    const clarificationHints = validations.flatMap((result) =>
      !result.ok && result.hint !== undefined ? [result.hint] : [],
    );
    return {
      status: "invalid" as const,
      result: structuredErrorResult({
        code: "validation_error",
        message: "Capability input failed validation",
        issues,
        hint:
          clarificationHints.length > 0
            ? clarificationHints.join(" ")
            : "Fix the fields named in issues[] and retry.",
      }),
    };
  }

  const [bodyResult, paramsResult, queryResult] = validations;
  return {
    status: "valid" as const,
    input,
    body: bodyResult.ok ? bodyResult.value : undefined,
    params: paramsResult.ok ? paramsResult.value : undefined,
    query: queryResult.ok ? queryResult.value : undefined,
  };
};

export const classifyValidatedCapabilityServiceInput = async ({
  config,
  entry,
  publicInput,
}: ValidateInvokeInputOptions) => {
  const validated = await validateInvokeInput({ config, entry, publicInput });
  if (validated.status === "invalid") {
    return Result.err(validated.result);
  }
  const exposure = config.mcp;
  if (
    !isRecord(exposure) ||
    exposure["type"] !== "capability" ||
    !isServiceClassification(exposure["consumesServices"])
  ) {
    return panic("Capability has no service classification");
  }
  const classifier = exposure["consumesServices"];
  if (typeof classifier !== "function") {
    return panic("Capability classification differs from its catalog");
  }
  const consumesServices = classifier(validated);
  if (typeof consumesServices !== "boolean") {
    return panic("Capability service classification must return a boolean");
  }
  return Result.ok(consumesServices);
};

const capabilityReferenceRefusal = async ({
  context,
  config,
  body,
  params,
  query,
  entry,
  confirm,
}: {
  context: AuthorizedMcpRequestContext;
  config: EndpointConfig;
  body: unknown;
  params: unknown;
  query: unknown;
  entry: Pick<CatalogEntry, "id" | "destructive" | "confirmation">;
  confirm: boolean | undefined;
}) => {
  if (
    !(await resourcesAreVisible({
      inputs: [
        { schema: config.body, value: body },
        { schema: config.params, value: params },
        { schema: config.query, value: query },
      ],
      scopedDb: context.scopedDb,
    }))
  ) {
    return notFoundResult("Not found");
  }

  // 5. Per-capability confirmation gate.
  if (requiresCapabilityConfirmation(entry) && confirm !== true) {
    return structuredErrorResult({
      code: "confirmation_required",
      message: `Capability "${entry.id}" requires confirmation and was called without it`,
      hint: "Confirm this operation with the human user, then retry with confirm: true.",
    });
  }

  return null;
};

const executeInvoke = async ({
  context,
  entry,
  id,
  input: publicInput,
  validateOnly,
  confirm,
}: {
  context: AuthorizedMcpRequestContext;
  entry: CatalogEntry;
  id: string;
  input: InvokeInput;
  validateOnly: boolean;
  confirm: boolean | undefined;
}): Promise<McpToolResponse> => {
  const loaded = await loadEndpointGuarded({
    id,
    toolName: MCP_CAPABILITY_EXECUTORS[entry.access],
    loadEndpoint: context.testDependencies?.loadCapabilityEndpoint,
  });
  if (!loaded.ok) {
    return loaded.result;
  }
  const endpoint = loaded.endpoint;

  const isWorkspace = entry.handlerKind === "workspace";
  const validated = await validateInvokeInput({
    config: endpoint.config,
    entry,
    publicInput,
  });
  if (validated.status === "invalid") {
    return validated.result;
  }
  const {
    input,
    body: validatedBody,
    params: validatedParams,
    query: validatedQuery,
  } = validated;

  const referenceRefusal = await capabilityReferenceRefusal({
    context,
    config: endpoint.config,
    body: validatedBody,
    params: validatedParams,
    query: validatedQuery,
    entry,
    confirm,
  });
  if (referenceRefusal !== null) {
    return referenceRefusal;
  }

  // 7. Workspace resolution (workspace kind only). Runs BEFORE the
  // validateOnly return so `validateOnly: true` mirrors a real invoke.
  const target = resolveCapabilityTarget({
    config: endpoint.config,
    context,
    isWorkspace,
    rawParams: input.params,
    validatedParams,
  });
  if (!target.ok) {
    return target.result;
  }
  const { workspaceId, params: handlerParams } = target;

  const requirement = endpoint.config.featureAccess;
  if (
    requirement?.type === "conditional" &&
    !isMcpDescriptorFeatureEnabled({
      context,
      kind: "capabilities",
      id,
      featureId: requirement.featureId,
    })
  ) {
    const scope = context.createOperationDatabaseScope?.();
    if (
      !scope ||
      (workspaceId !== undefined &&
        !scope.pinServerValidatedWorkspaceId(workspaceId))
    ) {
      return notFoundResult("Not found");
    }
    const usesFeature = await requirement.usesFeature({
      body: validatedBody,
      params: handlerParams,
      query: validatedQuery,
      organizationId: context.organizationId,
      userId: context.userId,
      safeDb: scope.safeDb,
      scopedDb: scope.scopedDb,
      ...(workspaceId === undefined ? {} : { workspaceId }),
    });
    if (usesFeature) {
      return notFoundResult("Not found");
    }
  }

  // 8. Purpose-dependent requirements. One `uploads.*` domain scope and one
  // `workspace:read` config permission cover three purposes that finalize into
  // different resources, so neither static value alone says what the call
  // spends: the catalog scope would let a workspace-write consent install a
  // skill, and the config permission is the baseline every member holds. The
  // purpose is read from the validated request on create and re-derived from
  // the stored row on finalize/abort, so relabelling the second call cannot
  // widen the first.
  const purposeRequirement = await resolveUploadPurposeRequirement({
    body: validatedBody,
    capabilityId: id,
    context,
    params: handlerParams,
  });
  const purposeScope = purposeRequirement?.scope ?? null;
  if (purposeScope !== null && !context.grantedScopes.includes(purposeScope)) {
    const requiredScopes = [...requiredScopesOf(entry), purposeScope];
    return structuredErrorResult({
      code: "missing_scope",
      message: `Insufficient permissions. Capability "${id}" requires scope: ${purposeScope}`,
      hint: oauthScopeRecoveryHint({
        grantedScopes: context.grantedScopes,
        missingScope: purposeScope,
        requiredScopes,
      }),
    });
  }

  // 9. Authority. The safe wrapper checks the member role on its own, but only
  // the role: a machine API key's permission set lives on the MCP session, so
  // this is the one place the two can be ANDed. Every grant this call spends is
  // checked here, the config's and the purpose's alike, because a handler that
  // decides a grant from the request reads the role by itself. It runs on both
  // paths and before the limiter below, so a caller who may not perform the
  // capability is refused without consuming anyone else's budget. Configs
  // without permissions (session-kind) skip the check, exactly as their wrapper
  // does.
  const permissions = endpoint.config.permissions;
  const requiredPermissions = [
    ...(permissions === undefined ? [] : [permissions]),
    ...(purposeRequirement === null ? [] : [purposeRequirement.permission]),
  ];
  if (
    requiredPermissions.some(
      (required) => !hasEffectiveAuthority(context, required),
    )
  ) {
    return structuredErrorResult({
      code: "permission_denied",
      message: `Your member role does not permit capability "${id}"`,
    });
  }

  if (validateOnly) {
    return untypedStructuredEgressPlan({
      payload: { valid: true, capability: id },
      textFields: [],
    });
  }

  const request = context.request;
  if (request === undefined) {
    return structuredErrorResult({
      code: "internal_error",
      message: "Capability execution is unavailable on this surface",
      hint: MCP_INTERNAL_ERROR_HINT,
    });
  }

  // 10. Gateway rate limit. Most capabilities are scoped per user, organization
  // and capability; skill-source calls share the REST client-IP budget. Capping
  // before execution prevents a runaway agent from driving backend cost through
  // the generic path. validateOnly (above) is exempt: it never executes.
  const rate = await (
    context.testDependencies?.consumeInvokeCapabilityRateLimit ??
    consumeInvokeCapabilityRateLimit
  )({
    capabilityId: id,
    clientIp: context.clientIp ?? null,
    organizationId: context.organizationId,
    userId: context.userId,
  });
  if (!rate.ok) {
    return structuredErrorResult({
      code: "rate_limited",
      message: `Rate limit exceeded for capability "${id}"`,
      hint: `Too many invocations of this capability; retry in about ${rate.retryAfterSeconds} seconds.`,
    });
  }

  const ctx = await capabilityHandlerContext({
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
  if (result instanceof HttpStatusResponse) {
    const statusCode = typeof result.code === "number" ? result.code : 500;
    return mapStatusResponse(statusCode, result.response);
  }
  if (isBinaryPayload(result)) {
    return structuredErrorResult({
      code: "feature_disabled",
      message: `Capability "${id}" returned a file or stream, which capability executors cannot deliver`,
      hint: "Fetch the file through its REST route or the stella app; capability executors only return structured JSON.",
    });
  }
  return untypedStructuredEgressPlan({ payload: result, textFields: [] });
};

export const resolveCapabilityReadClass = async (args: unknown) => {
  if (!isRecord(args) || typeof args["capability"] !== "string") {
    return undefined;
  }
  const entry = (await getCatalogById()).get(args["capability"]);
  if (entry === undefined || entry.access === "write") {
    return undefined;
  }
  return (
    entry.readClass ??
    panic(`Missing read classification for capability ${entry.id}`)
  );
};

// --- tool set ----------------------------------------------------------------

const CAPABILITY_TOOL_DEFINITIONS = [
  defineValibotMcpTool({
    consumesServices: false,
    annotations: {
      title: "List capabilities",
      destructiveHint: false,
      readOnlyHint: true,
      openWorldHint: false,
    },
    name: "list_capabilities",
    access: "read",
    permissions: openMcpRead("reads the static capability catalog metadata"),
    readClass: "tenant",
    anonymized: { exposure: "excluded", reason: "dynamic_tenant_payload" },
    scope: "stella:read",
    description:
      "List the automatable capabilities beyond the curated tools: every safe " +
      "backend operation (CRUD, exports, processing triggers) reachable through " +
      "read_capability or write_capability. Paginated; filter by domain (the id prefix, e.g. " +
      '"time-entries") or access (read/write), or search ids, titles, and descriptions with query. ' +
      "Each item gives the capability " +
      "id, description, access/destructive, its transport (whether this path " +
      "can run it, which field takes a file, and what to use instead), " +
      "handlerKind (workspace or root), and every OAuth scope it needs. Use " +
      "describe_capability for the full input schema.",
    inputSchema: listCapabilitiesArgsSchema,
  }),
  defineValibotMcpTool({
    consumesServices: false,
    annotations: {
      title: "Describe capability",
      destructiveHint: false,
      readOnlyHint: true,
      openWorldHint: false,
    },
    name: "describe_capability",
    access: "read",
    permissions: openMcpRead("reads the static capability catalog metadata"),
    readClass: "tenant",
    anonymized: { exposure: "excluded", reason: "dynamic_tenant_payload" },
    scope: "stella:read",
    description:
      "Describe one capability in full: its live input JSON Schema " +
      "(body/params/query), required OAuth scopes, member permissions, whether it " +
      "is destructive, its handler kind (workspace/root), its disposition, and " +
      "its transport (whether this path can run it, which field takes a file, " +
      "and what to use instead). Call this before read_capability or write_capability to learn " +
      "exactly what input to pass.",
    inputSchema: describeCapabilityArgsSchema,
  }),
  defineValibotMcpTool({
    consumesServices: false,
    annotations: {
      title: "Read capability",
      destructiveHint: false,
      openWorldHint: true,
      readOnlyHint: true,
    },
    name: MCP_CAPABILITY_EXECUTORS.read,
    access: "read",
    permissions: {
      type: "delegated",
      reason: "The resolved capability enforces its own declared authority",
    },
    readClass: resolveCapabilityReadClass,
    anonymized: { exposure: "excluded", reason: "dynamic_tenant_payload" },
    scope: "stella:read",
    description:
      "Read one capability by id. Take a read id from list_capabilities or " +
      "describe_capability. Pass input under input: { body, params, query }; " +
      "matter-scoped capabilities take input.params.matterId. " +
      "Required scopes and member permissions are checked per capability. " +
      "Set validate_only: true to check input without running it. " +
      "Write capabilities must use write_capability.",
    inputSchema: readCapabilityArgsSchema,
  }),
  defineValibotMcpTool({
    consumesServices: false,
    annotations: {
      title: "Write capability",
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
      readOnlyHint: false,
    },
    name: MCP_CAPABILITY_EXECUTORS.write,
    access: "write",
    accountAccess: "sandbox",
    permissions: {
      type: "delegated",
      reason:
        "The selected capability's endpoint permissions and purpose requirements are checked before its dispatch.",
    },
    anonymized: { exposure: "excluded", reason: "write" },
    destructiveBehavior: { type: "capability-catalog" },
    scope: "stella:read",
    description:
      "Write one capability by id. Take a write id from list_capabilities or " +
      "describe_capability. Pass input under input: { body, params, query }; " +
      "matter-scoped capabilities take input.params.matterId. " +
      "Required scopes and member permissions are checked per capability. " +
      "Set validate_only: true to check input without running it; " +
      "Capabilities declaring confirmation require confirm: true after human approval. " +
      "Read capabilities must use read_capability.",
    inputSchema: writeCapabilityArgsSchema,
  }),
] as const satisfies readonly McpToolDefinition[];

export const CAPABILITY_TOOL_HANDLERS = {
  list_capabilities: listCapabilitiesHandler,
  describe_capability: describeCapabilityHandler,
  [MCP_CAPABILITY_EXECUTORS.read]: async ({ args, context }) =>
    await invokeCapabilityHandler({ args, context, access: "read" }),
  [MCP_CAPABILITY_EXECUTORS.write]: async ({ args, context }) =>
    await invokeCapabilityHandler({ args, context, access: "write" }),
} satisfies Record<
  "list_capabilities" | "describe_capability" | McpCapabilityExecutor,
  McpToolHandler
>;

export const CAPABILITY_TOOL_SET = defineMcpToolSet(
  CAPABILITY_TOOL_DEFINITIONS,
  CAPABILITY_TOOL_HANDLERS,
  {
    describe_capability: defineMcpToolOutput(DESCRIBE_CAPABILITY_OUTPUT_SCHEMA),
    [MCP_CAPABILITY_EXECUTORS.read]: defineProjectedMcpToolOutput(
      INVOKE_CAPABILITY_OUTPUT_SCHEMA,
      (result) => ({ result }),
    ),
    [MCP_CAPABILITY_EXECUTORS.write]: defineProjectedMcpToolOutput(
      INVOKE_CAPABILITY_OUTPUT_SCHEMA,
      (result) => ({ result }),
    ),
    list_capabilities: defineMcpToolOutput(LIST_CAPABILITIES_OUTPUT_SCHEMA),
  },
);
