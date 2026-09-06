import { KindGuard, type TSchema } from "@sinclair/typebox";
import { ValueErrorType } from "@sinclair/typebox/errors";
import { Value, type ValueError } from "@sinclair/typebox/value";
import { panic } from "better-result";
import { ElysiaCustomStatusResponse } from "elysia";

import capabilityCatalogRaw from "@stll/cli/capability-catalog.json";
import type { PermissionInput } from "@stll/permissions";

import { captureError } from "@/api/lib/analytics/capture";
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
import { getCurrentRequestId } from "@/api/lib/observability/request-context";
import {
  decodePaginationCursor,
  encodePaginationCursor,
} from "@/api/lib/pagination";
import { brandPersistedWorkspaceId } from "@/api/lib/safe-id-boundaries";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";
import { advertisedSchemas } from "@/api/mcp/advertised-schema";
import { synthesizeCapabilityContext } from "@/api/mcp/capability-context";
import type { SynthesizedCapabilityContext } from "@/api/mcp/capability-context";
import { isCapabilityFeatureEnabled } from "@/api/mcp/capability-feature";
import { consumeInvokeCapabilityRateLimit } from "@/api/mcp/capability-rate-limit";
import { CONTEXT_FIDELITY_WAIVERS } from "@/api/mcp/capability-waivers";
import {
  bindApprovedMcpAuditContext,
  type McpRequestContext,
} from "@/api/mcp/context";
import { hasEffectiveAuthority } from "@/api/mcp/effective-authority";
import type { McpErrorCode, McpValidationIssue } from "@/api/mcp/error-codes";
import { CAPABILITY_DISPATCH } from "@/api/mcp/generated/capability-dispatch";
import type { CapabilityDispatchEntry } from "@/api/mcp/generated/capability-dispatch";
import {
  declaresInternalField,
  INTERNAL_FIELD_NAME,
  PUBLIC_FIELD_NAME,
} from "@/api/mcp/public-field-names";
import { defineMcpToolSet } from "@/api/mcp/tool-types";
import type {
  InternalToolErrorResult,
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
  oauthScopeRecoveryHint,
  parseOptionalCursor,
  parseOptionalEnum,
  parseOptionalLimit,
  parseRequiredString,
  stringProp,
  structuredErrorResult,
  FEATURE_DISABLED_MESSAGE,
  featureDisabledHint,
} from "@/api/mcp/tool-utils";
import { resolveUploadPurposeRequirement } from "@/api/mcp/upload-purpose-gate";

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
  destructive: boolean;
  scope: string;
  additionalScopes?: readonly string[];
  /**
   * When true, this capability's REST route resolves workspace access through
   * `validateWorkspaceAccessIncludingArchived` (e.g. `matters.unarchive`), so
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
  feature?: string;
  permissions?: unknown;
  inputSchema?: { body?: unknown; params?: unknown; query?: unknown };
  mcp: CapabilityMcpDisposition;
};

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
  (value["description"] === undefined ||
    typeof value["description"] === "string") &&
  isHandlerKind(value["handlerKind"]) &&
  (value["access"] === "read" || value["access"] === "write") &&
  typeof value["destructive"] === "boolean" &&
  typeof value["scope"] === "string" &&
  (value["additionalScopes"] === undefined ||
    (Array.isArray(value["additionalScopes"]) &&
      value["additionalScopes"].every(
        (scope): scope is string => typeof scope === "string",
      ))) &&
  (value["feature"] === undefined || typeof value["feature"] === "string") &&
  isCapabilityTransport(value["transport"]) &&
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
const additionalScopesOf = (entry: CatalogEntry): readonly string[] => {
  if (entry.additionalScopes === undefined) {
    return [];
  }
  return entry.additionalScopes;
};
const requiredScopesOf = (entry: CatalogEntry): readonly string[] => [
  entry.scope,
  ...additionalScopesOf(entry),
];

type RenderedTransport = {
  type: CapabilityTransport["type"];
  /** Whether invoke_capability can run this at all. */
  invocable: boolean;
  /** Body field carrying bytes, and whether it is required. */
  fileField: string | null;
  fileFieldRequired: boolean | null;
  fileMediaTypes: readonly string[];
  /** Media types the success payload would be, for a file-returning capability. */
  responseMediaTypes: readonly string[];
  /** Where the work can be done instead, as one sentence. */
  alternative: string | null;
};

/**
 * The transport an agent sees on `list_capabilities` and
 * `describe_capability`. Says which field carries bytes and whether the
 * capability has a fileless mode, so an agent can tell "cannot be called" from
 * "can be called without the file" before spending a round trip.
 */
const NO_MEDIA_TYPES: readonly string[] = [];

const renderTransport = (transport: CapabilityTransport): RenderedTransport => {
  const input = transportFileInput(transport);
  const response = transportFileResponse(transport);
  const alternative = transportAlternative(transport);
  return {
    type: transport.type,
    invocable: isTransportInvocable(transport),
    fileField: input === undefined ? null : input.field,
    fileFieldRequired: input === undefined ? null : input.required,
    fileMediaTypes: input === undefined ? NO_MEDIA_TYPES : input.mediaTypes,
    responseMediaTypes:
      response === undefined ? NO_MEDIA_TYPES : response.mediaTypes,
    alternative:
      alternative === undefined
        ? null
        : describeTransportAlternative(alternative),
  };
};

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

/**
 * Prefix a validated part name onto a dot-path so an agent sees `body.purpose`,
 * never a bare `purpose` it cannot place. An empty dot-path (the whole part
 * failed) renders as the bare part name.
 */
const prefixPartPath = (
  part: "body" | "params" | "query",
  dot: string,
): string => joinDot(part, dot);

/** A tagged-union discriminator: the shared key and the literal each variant fixes it to. */
type UnionDiscriminator = { key: string; literals: readonly string[] };

/**
 * If every variant of a union is an object sharing one literal-typed property,
 * return that key plus the literal each variant fixes it to (a tagged /
 * discriminated union, e.g. uploads.create's `purpose`). Returns `null` for a
 * non-discriminated union (e.g. `string | number`), which has no such key.
 */
const unionDiscriminator = (
  variants: readonly TSchema[],
): UnionDiscriminator | null => {
  const objects = variants.filter((variant) => KindGuard.IsObject(variant));
  const first = objects.at(0);
  if (first === undefined || objects.length !== variants.length) {
    return null;
  }
  for (const key of Object.keys(first.properties)) {
    const literals: string[] = [];
    const shared = objects.every((variant) => {
      const prop = variant.properties[key];
      if (prop !== undefined && KindGuard.IsLiteral(prop)) {
        literals.push(JSON.stringify(prop.const));
        return true;
      }
      return false;
    });
    if (shared) {
      return { key, literals: [...new Set(literals)] };
    }
  }
  return null;
};

/** The variant whose discriminator literal matches the value's, if any. */
const matchingVariant = (
  variants: readonly TSchema[],
  discriminator: UnionDiscriminator,
  value: unknown,
): TSchema | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const provided = value[discriminator.key];
  return variants.find((variant) => {
    if (!KindGuard.IsObject(variant)) {
      return false;
    }
    const prop = variant.properties[discriminator.key];
    return KindGuard.IsLiteral(prop) && prop.const === provided;
  });
};

/**
 * Expand one TypeBox union error into field-level issues. TypeBox reports a
 * failed union as a single opaque `Expected union value` naming no field. For a
 * discriminated union we do better: name the discriminator and its allowed
 * literals when it is missing/wrong, or drill into the matched variant so the
 * caller sees that variant's own missing/invalid fields. A non-discriminated
 * union falls back to the node-level message (which still carries a non-empty
 * path). Every returned issue's path is part-prefixed, so none is ever empty.
 */
const expandUnionError = (
  part: "body" | "params" | "query",
  error: ValueError,
): McpValidationIssue[] => {
  const unionDot = typeboxPathToDot(error.path);
  if (!KindGuard.IsUnion(error.schema)) {
    return [{ path: prefixPartPath(part, unionDot), message: error.message }];
  }
  const variants = error.schema.anyOf;
  const discriminator = unionDiscriminator(variants);
  if (discriminator === null) {
    return [{ path: prefixPartPath(part, unionDot), message: error.message }];
  }
  const variant = matchingVariant(variants, discriminator, error.value);
  // No variant matched: the discriminator is missing or not one of the literals.
  // Name it and its allowed values -- the single most useful thing to report.
  if (variant === undefined) {
    return [
      {
        path: prefixPartPath(part, joinDot(unionDot, discriminator.key)),
        message: `expected one of ${discriminator.literals.join(" | ")}`,
      },
    ];
  }
  // A variant matched: report that variant's own field-level errors.
  const nested = [...Value.Errors(variant, error.value)].map((sub) => ({
    path: prefixPartPath(part, joinDot(unionDot, typeboxPathToDot(sub.path))),
    message: sub.message,
  }));
  if (nested.length > 0) {
    return nested;
  }
  // Matched with no field errors -- unreachable in practice (a clean match means
  // the union would have passed). Fall back to the opaque node message rather
  // than blaming the discriminator, which was correct.
  return [{ path: prefixPartPath(part, unionDot), message: error.message }];
};

/** Map one TypeBox validation error to one or more part-prefixed issues. */
const errorToIssues = (
  part: "body" | "params" | "query",
  error: ValueError,
): McpValidationIssue[] => {
  if (error.type === ValueErrorType.Union) {
    return expandUnionError(part, error);
  }
  return [
    {
      path: prefixPartPath(part, typeboxPathToDot(error.path)),
      message: error.message,
    },
  ];
};

type PartValidation =
  | { ok: true; value: unknown }
  | { ok: false; issues: McpValidationIssue[] };

/**
 * Validate one input part (`body`/`params`/`query`) against the live handler
 * config's TypeBox schema, mirroring what the Elysia route boundary hands the
 * handler: Default -> Convert -> Clean -> Check, over a value a strict
 * tool-schema client's nulls have first been read out of (see
 * {@link withNullOptionalsOmitted}). The Clean step matches
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
/**
 * The part's schema with one property removed, for a fileless-mode call. Returns
 * the schema untouched when there is nothing to remove or it is not an object
 * schema. The property is always OPTIONAL (that is what makes the capability
 * invocable), so dropping it leaves a schema the handler still accepts.
 */
const schemaWithoutField = (
  schema: TSchema | undefined,
  field: string | undefined,
): TSchema | undefined => {
  if (
    schema === undefined ||
    field === undefined ||
    !KindGuard.IsObject(schema)
  ) {
    return schema;
  }
  const properties: Record<string, TSchema> = {};
  for (const [key, value] of Object.entries(schema.properties)) {
    if (key !== field) {
      properties[key] = value;
    }
  }
  return { ...schema, properties };
};

/**
 * Keywords that constrain what a schema accepts. A schema carrying none of
 * them (`t.Any()`, `t.Unknown()`) accepts every value, null included.
 */
const CONSTRAINING_KEYWORDS = [
  "type",
  "anyOf",
  "oneOf",
  "allOf",
  "enum",
  "const",
  "$ref",
] as const;

/** True when the schema accepts an explicit null: `t.Null()`, a union with a
 * null branch, a `type` list including "null", or an unconstrained schema. */
const admitsNull = (schema: unknown): boolean => {
  if (!isRecord(schema)) {
    return true;
  }
  const type = schema["type"];
  if (type === "null" || (isUnknownArray(type) && type.includes("null"))) {
    return true;
  }
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const branches = schema[keyword];
    if (isUnknownArray(branches) && branches.some(admitsNull)) {
      return true;
    }
  }
  return CONSTRAINING_KEYWORDS.every((keyword) => !(keyword in schema));
};

/**
 * Read one input part with `null` under a declared optional property meaning
 * absence, the rule `nullAsAbsent` applies to native tool inputs. A strict
 * tool-schema client must send every property a schema declares, so it sends
 * null for the ones it is not setting, and null is not a value here.
 *
 * The rule comes off the schema, never a list: a property qualifies when the
 * schema lets it be omitted (it is not in `required`) and does not itself admit
 * null. A "pass null to clear" nullable therefore keeps its null, a required
 * property set to null still fails Check, and a null under an undeclared key is
 * left for Clean to strip exactly as before. Nested objects and arrays of
 * objects are read the same way; a union branch is not, because which branch a
 * value belongs to is not decided yet.
 *
 * Exported so the registry-wide guard can run it over the committed catalog,
 * whose part schemas are the same `advertisedSchemas` projection this validates
 * against. Reading JSON Schema keywords rather than TypeBox's `Kind` symbols is
 * what lets one function serve both.
 */
export const withNullOptionalsOmitted = (
  schema: unknown,
  value: unknown,
): unknown => {
  if (!isRecord(schema)) {
    return value;
  }
  const items = schema["items"];
  if (items !== undefined && isUnknownArray(value)) {
    return value.map((entry) => withNullOptionalsOmitted(items, entry));
  }
  const properties = schema["properties"];
  if (!isRecord(properties) || !isRecord(value)) {
    return value;
  }
  const required = schema["required"];
  const requiredNames = new Set(isUnknownArray(required) ? required : []);
  const present: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const property = properties[key];
    if (property === undefined) {
      present[key] = entry;
      continue;
    }
    if (entry === null && !requiredNames.has(key) && !admitsNull(property)) {
      continue;
    }
    present[key] = withNullOptionalsOmitted(property, entry);
  }
  return present;
};

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
  // Ahead of the chain, not just ahead of Check: a dropped null must take the
  // property's declared default and must never reach Convert, so the part reads
  // exactly as it would from a client that omitted the property.
  const withDefaults = Value.Default(
    schema,
    withNullOptionalsOmitted(schema, base),
  );
  const coerced = Value.Convert(schema, withDefaults);
  const cleaned = Value.Clean(schema, coerced);
  if (Value.Check(schema, cleaned)) {
    return { ok: true, value: cleaned };
  }
  const issues = [...Value.Errors(schema, cleaned)].flatMap((error) =>
    errorToIssues(part, error),
  );
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
): InternalToolErrorResult => {
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

/**
 * Attach the request receipt to a successful WRITE capability payload. The id
 * lands in a top-level `meta.requestId` sibling of the handler's own fields,
 * never mixed into the handler's data: it cannot collide with a domain field,
 * and the pagination fields (`items`/`nextCursor`) the CLI and `--all` read
 * stay at the top level. Reads deliberately carry NO receipt: a per-request
 * random id would make otherwise deterministic read payloads change on every
 * call, defeating agent-side caching/diffing (the `x-request-id` response
 * header still carries the id for every request; the error envelope carries it
 * unconditionally because errors are not cacheable results). A non-object
 * payload (or no active request) carries no receipt either.
 */
const withRequestReceipt = (
  payload: unknown,
  access: "read" | "write",
): unknown => {
  if (access !== "write") {
    return payload;
  }
  const requestId = getCurrentRequestId();
  if (requestId === undefined || !isRecord(payload)) {
    return payload;
  }
  const existingMeta = isRecord(payload["meta"]) ? payload["meta"] : {};
  return { ...payload, meta: { ...existingMeta, requestId } };
};

/** Serialize a successful capability payload through the standard egress path. */
const successEgress = (
  payload: unknown,
  access: "read" | "write",
): McpEgressPlan => ({
  egress: "structured",
  payload: withRequestReceipt(payload, access),
  textFields: [],
});

// --- list_capabilities -------------------------------------------------------

const CAPABILITY_LIST_CURSOR = "cursor";

const contextFeatureEnabled = (
  feature: string | undefined,
  context: McpRequestContext | undefined,
): boolean =>
  (
    context?.testDependencies?.isCapabilityFeatureEnabled ??
    isCapabilityFeatureEnabled
  )(feature);

const listCapabilitiesHandler = ({
  args,
  context,
}: {
  args: Record<string, unknown>;
  context: McpRequestContext;
}): McpToolResponse => {
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
      contextFeatureEnabled(entry.feature, context) &&
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
        description: entry.description ?? null,
        access: entry.access,
        destructive: entry.destructive,
        handlerKind: entry.handlerKind,
        transport: renderTransport(entry.transport),
        scope: entry.scope,
        additionalScopes: additionalScopesOf(entry),
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

const notFoundWithHint = (id: string): InternalToolErrorResult =>
  notFoundResult(`No capability with id "${id}"`, hintForUnknownId(id));

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

const hintForUnknownId = (id: string): string => {
  const suggestions = closestToolNames(id, CATALOG_IDS);
  return suggestions.length > 0
    ? `Did you mean: ${suggestions.join(", ")}? Call list_capabilities to browse the full set.`
    : "Call list_capabilities to browse available capability ids.";
};

type GuardedEndpoint =
  | { ok: true; endpoint: EndpointDefinition }
  | { ok: false; result: InternalToolErrorResult };

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
  if (!entry) {
    return notFoundWithHint(id);
  }

  // Match the static-tool surface: a gated-off tool is hidden from the list
  // AND rejected on direct dispatch, so describing a gated-off capability is
  // refused too (never leak a disabled feature's schema by direct id).
  if (!contextFeatureEnabled(entry.feature, context)) {
    return featureDisabledResult(entry.feature);
  }

  const loaded = await loadEndpointGuarded(id, "describe_capability");
  if (!loaded.ok) {
    return loaded.result;
  }
  const endpoint = loaded.endpoint;

  // The live TypeBox schemas are plain objects plus symbol metadata; the final
  // JSON serialization (toolDataResult in the egress pipeline) drops the symbols, so
  // they can go on the payload as-is. Uses the live config, never the snapshot,
  // so a snapshot-truncated capability still describes fully, and the same
  // `advertisedSchemas` projection invoke_capability validates against, so an
  // advertised bound is always an enforced bound.
  const inputSchema = advertisedSchemas(endpoint.config);

  return {
    egress: "structured",
    payload: {
      id: entry.id,
      description: entry.description ?? null,
      domain: capabilityDomain(entry.id),
      access: entry.access,
      destructive: entry.destructive,
      handlerKind: entry.handlerKind,
      scope: entry.scope,
      additionalScopes: additionalScopesOf(entry),
      // Surfacing these lets an agent learn, before invoking, whether the
      // generic path can run the capability at all, which field (if any) it
      // must omit, where the work can be done instead, and whether the
      // capability tolerates an archived workspace (e.g. unarchive).
      transport: renderTransport(entry.transport),
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

/** What a file transport prevents, phrased for the agent that just called it. */
const transportBlockReason = (transport: CapabilityTransport): string => {
  switch (transport.type) {
    case "json":
      return "";
    case "file-input":
      return `requires a file in \`${transport.input.field}\`, which JSON cannot carry`;
    case "file-response":
      return "returns a file or stream, which invoke_capability cannot serialize";
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
    message: `Capability "${id}" ${transportBlockReason(transport)}, so it is not available through invoke_capability`,
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
    message: `Capability "${id}" cannot take \`${field}\` through invoke_capability: that field carries file bytes, which JSON cannot express`,
    hint: `Omit \`${field}\` and call again using this capability's other input modes; the file mode is only available through its REST route or the stella app.`,
  });
};

const INVOKE_BOOLEAN_ARGS = ["validate_only", "confirm"] as const;
const INVOKE_INPUT_PARTS = ["body", "params", "query"] as const;
const INVOKE_ARG_KEYS = [
  "capability",
  "input",
  ...INVOKE_BOOLEAN_ARGS,
] as const;
const INVOKE_ARG_KEY_SET = new Set<string>(INVOKE_ARG_KEYS);
const INVOKE_INPUT_PART_SET = new Set<string>(INVOKE_INPUT_PARTS);

/**
 * Strict shape check for invoke_capability's OWN arguments. The MCP transport
 * does not enforce the advertised JSON Schema on tool args, so a hand-built
 * request can mistype a flag or misplace the capability's input — and either
 * one, read leniently, fails open: `validate_only: "true"` silently read as
 * `false` would EXECUTE a capability the caller intended as a dry run, and a
 * top-level `query` neither rejected nor read would run the capability with NO
 * input (an unfiltered, unpaginated call the agent never asked for). Every
 * mistyped argument and every key outside the advertised set is therefore
 * refused with a named issue: booleans must be JSON booleans, `input` and its
 * body/params/query parts must be objects. Never coerce, never ignore.
 */
const invokeArgIssues = (
  args: Record<string, unknown>,
): McpValidationIssue[] => {
  const issues: McpValidationIssue[] = [];
  for (const key of Object.keys(args)) {
    if (INVOKE_ARG_KEY_SET.has(key)) {
      continue;
    }
    issues.push({
      path: key,
      message: INVOKE_INPUT_PART_SET.has(key)
        ? `Unknown argument: the capability's own input goes under \`input\`, as input.${key}`
        : `Unknown argument. Expected one of: ${INVOKE_ARG_KEYS.join(", ")}`,
    });
  }
  for (const key of INVOKE_BOOLEAN_ARGS) {
    const value = args[key];
    if (value !== undefined && typeof value !== "boolean") {
      issues.push({
        path: key,
        message: `Expected a JSON boolean, got ${typeof value}`,
      });
    }
  }
  const input = args["input"];
  if (input !== undefined) {
    if (isRecord(input)) {
      for (const key of Object.keys(input)) {
        if (INVOKE_INPUT_PART_SET.has(key)) {
          continue;
        }
        issues.push({
          path: `input.${key}`,
          message: `Unknown input part. Expected one of: ${INVOKE_INPUT_PARTS.join(", ")}`,
        });
      }
      for (const part of INVOKE_INPUT_PARTS) {
        const value = input[part];
        if (value !== undefined && !isRecord(value)) {
          issues.push({
            path: `input.${part}`,
            message: `Expected an object, got ${typeof value}`,
          });
        }
      }
    } else {
      issues.push({ path: "input", message: "Expected an object" });
    }
  }
  return issues;
};

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
 * its own `matterId`) declares no internal name, so it is left alone and an
 * unrecognized key there is stripped by `Value.Clean`, exactly as at REST.
 *
 * Both directions come from `INTERNAL_FIELD_NAME`'s one table.
 */
type FieldProjection =
  | { ok: true; value: unknown }
  | { ok: false; issues: McpValidationIssue[] };

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

/** Split the (already shape-validated) `input` arg into its three parts. */
const readInvokeInput = (raw: unknown): InvokeInput => {
  if (!isRecord(raw)) {
    return { body: undefined, params: undefined, query: undefined };
  }
  return {
    body: raw["body"],
    params: raw["params"],
    query: raw["query"],
  };
};

/** Resolve the workspace id for a workspace-kind capability from `input.params.matterId`. */
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

  // 0. The meta-tool's own argument shapes, before ANY gate: the transport
  // does not enforce the advertised JSON Schema, and neither a mistyped flag
  // nor a misplaced input may be read leniently (`validate_only: "true"` would
  // fail open into executing a request that intended a dry run; a top-level
  // `query` would run the capability with no input at all).
  const argIssues = invokeArgIssues(args);
  if (argIssues.length > 0) {
    return structuredErrorResult({
      code: "validation_error",
      message: "invoke_capability arguments failed validation",
      issues: argIssues,
      hint: "Fix the arguments named in issues[]: the capability's own input goes under input: { body, params, query }, boolean flags must be JSON booleans (not strings), and input and its parts must be objects.",
    });
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
  if (!contextFeatureEnabled(entry.feature, context)) {
    return featureDisabledResult(entry.feature);
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
  const waiver = (
    context.testDependencies?.contextFidelityWaivers ?? CONTEXT_FIDELITY_WAIVERS
  ).get(id);
  if (waiver !== undefined) {
    return structuredErrorResult({
      code: "feature_disabled",
      message: `Capability "${id}" cannot run through invoke_capability: ${waiver}`,
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

  // 5. Destructive confirm gate.
  if (entry.destructive && args["confirm"] !== true) {
    return structuredErrorResult({
      code: "confirmation_required",
      message: `Capability "${id}" is an irreversible operation and was called without confirmation`,
      hint: "This operation is irreversible. Confirm with the human user, then retry with confirm: true.",
    });
  }

  // Shapes were strictly validated up front (gate 0), so these reads are safe:
  // validate_only/confirm are real booleans (or absent), input parts are
  // objects, and no unknown argument reached here.
  const input = readInvokeInput(args["input"]);
  const validateOnly = args["validate_only"] === true;

  // 6. Fileless mode. This capability reached here because its file field is
  // OPTIONAL, so the JSON modes run; the field itself still cannot cross. It is
  // refused rather than dropped, because a caller who sent bytes-as-a-string
  // must not get a silent success computed from the other sources.
  const filelessBlock = filelessFieldRefusal(id, entry.transport, input);
  if (filelessBlock !== null) {
    return filelessBlock;
  }

  try {
    return await executeInvoke({
      context: entry.destructive
        ? bindApprovedMcpAuditContext(context)
        : context,
      entry,
      id,
      input,
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
const executeInvoke = async ({
  context,
  entry,
  id,
  input: publicInput,
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
  // 6. Input validation against the schemas describe_capability advertises
  // (same `advertisedSchemas` projection of the live endpoint config, so a
  // bound an agent read is a bound this gate enforces), run Default -> Convert
  // -> Clean -> Check to mirror the Elysia boundary; see validatePart. A
  // matter-scoped capability takes its matter as `input.params.matterId`; at
  // REST that param belongs to the route macro's schema, not the handler
  // config's, so it is resolved from the RAW params below (Clean would strip it
  // from configs that do not declare it) and re-merged into the params the
  // handler receives, exactly like the macro's merged schema.
  // In fileless mode the withheld file field does not exist for this call, so
  // it is removed from the schema before validation rather than merely left
  // unset. `t.File()` carries `default: "File"`, and the Default step would
  // otherwise inject that placeholder string into the absent optional field and
  // then fail Check on it — a capability that is reachable in principle,
  // un-callable in practice.
  const advertised = advertisedSchemas(endpoint.config);
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
    return structuredErrorResult({
      code: "validation_error",
      message: "Capability input failed validation",
      issues: projectionIssues,
      hint: "Fix the fields named in issues[] and retry.",
    });
  }
  const [projectedBody, projectedParams, projectedQuery] = projections;
  const input: InvokeInput = {
    body: projectedBody.ok ? projectedBody.value : publicInput.body,
    params: projectedParams.ok ? projectedParams.value : publicInput.params,
    query: projectedQuery.ok ? projectedQuery.value : publicInput.query,
  };
  const bodySchema = schemaWithoutField(
    advertised.body,
    filelessOnlyField(entry.transport),
  );
  const validations = [
    validatePart("body", bodySchema, input.body),
    validatePart("params", advertised.params, input.params),
    validatePart("query", advertised.query, input.query),
  ] as const;

  const issues = validations.flatMap((result) =>
    result.ok ? [] : result.issues.map(toPublicIssue),
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
  return mapHandlerResult({ id, result, access: entry.access });
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
 *  - anything else -> the structured success payload, with the request receipt
 *    attached under `meta.requestId` for a WRITE capability only (see
 *    `withRequestReceipt`).
 */
export const mapHandlerResult = ({
  id,
  result,
  access,
}: {
  id: string;
  result: unknown;
  /** The invoked capability's catalog access; receipts attach to writes only. */
  access: "read" | "write";
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
  return successEgress(result, access);
};

// --- tool set ----------------------------------------------------------------

const CAPABILITY_TOOL_DEFINITIONS = [
  {
    annotations: {
      title: "List capabilities",
      readOnlyHint: true,
      openWorldHint: false,
    },
    name: "list_capabilities",
    access: "read",
    anonymized: { exposure: "excluded", reason: "dynamic_tenant_payload" },
    scope: "stella:read",
    description:
      "List the automatable capabilities beyond the curated tools: every safe " +
      "backend operation (CRUD, exports, processing triggers) reachable through " +
      "invoke_capability. Paginated; filter by domain (the id prefix, e.g. " +
      '"time-entries") or access (read/write). Each item gives the capability ' +
      "id, description, access/destructive, its transport (whether this path " +
      "can run it, which field takes a file, and what to use instead), " +
      "handlerKind (workspace or root), and every OAuth scope it needs. Use " +
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
    annotations: {
      title: "Describe capability",
      readOnlyHint: true,
      openWorldHint: false,
    },
    name: "describe_capability",
    access: "read",
    anonymized: { exposure: "excluded", reason: "dynamic_tenant_payload" },
    scope: "stella:read",
    description:
      "Describe one capability in full: its live input JSON Schema " +
      "(body/params/query), required OAuth scopes, member permissions, whether it " +
      "is destructive, its handler kind (workspace/root), its disposition, and " +
      "its transport (whether this path can run it, which field takes a file, " +
      "and what to use instead). Call this before invoke_capability to learn " +
      "exactly what input to pass.",
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
    // openWorldHint: true because the target capability is selected at
    // runtime by id, and the catalog includes contacts.business-registries-
    // lookup, which reaches the shared business-registry dispatch (ARES,
    // KRS, ORSR, ...) the same external interaction matter-tools.ts's company
    // lookup and template-tools.ts's fill_template declare open-world for;
    // the hint is static per tool, so it must cover that reachable case even
    // though most capabilities never leave the closed Stella domain.
    annotations: {
      title: "Invoke capability",
      idempotentHint: false,
      openWorldHint: true,
    },
    name: "invoke_capability",
    access: "write",
    anonymized: { exposure: "excluded", reason: "write" },
    scope: "stella:read",
    // Destructiveness is per-capability (from the catalog), not a property of
    // this tool, so no `destructiveHint` annotation: the confirm gate is applied
    // inside the handler from the target capability's `destructive` flag.
    description:
      "Invoke one capability by id (from list_capabilities/describe_capability). " +
      "Pass its input under input: { body, params, query } (no other top-level " +
      "argument is accepted); matter-scoped capabilities take the target " +
      "matter as input.params.matterId. Real authority is enforced per " +
      "capability: the session must hold the capability's scope and your member " +
      "role its permissions. Set validate_only: true to check input without " +
      "running it; destructive capabilities require confirm: true after human " +
      "approval.",
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
                "Path parameters; matter-scoped capabilities require matterId here.",
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
        validate_only: {
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
