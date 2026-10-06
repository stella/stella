import type { CallToolResult } from "@modelcontextprotocol/server";
import { panic, Result, TaggedError } from "better-result";
import * as v from "valibot";

import type {
  AgentInputNormalizationAnnotation,
  CountrySpelling,
} from "@stll/agent-input";
import {
  AGENT_INPUT_NORMALIZATION_KIND,
  askForFix,
  askSentence,
  COUNTRY_INPUT_MAX_CHARS,
} from "@stll/agent-input";
import {
  createCaseLawDecisionPath,
  createCaseLawDecisionRouteParams,
} from "@stll/api-contract/case-law-decision-route";
import type { CaseLawDecisionRouteInput } from "@stll/api-contract/case-law-decision-route";
import { resolveLegalCitationLinks } from "@stll/api-contract/legal-citation-links";
import {
  createStatutePath,
  createStatuteRouteParams,
} from "@stll/api-contract/statute-route";
import type { StatuteRouteInput } from "@stll/api-contract/statute-route";
import { declareFailureClass } from "@stll/errors";

import { captureError } from "@/api/lib/analytics/capture";
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
import type { AccessibleWorkspace } from "@/api/lib/auth";
import type { SafeId } from "@/api/lib/branded-types";
import {
  parseStrippingUndeclaredKeys,
  reportToolOutputDegrade,
} from "@/api/lib/chat/tool-output-degrade";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  isSearchIndexUnavailable,
  SEARCH_INDEX_UNAVAILABLE_CODE,
  SEARCH_INDEX_UNAVAILABLE_HINT,
  SEARCH_INDEX_UNAVAILABLE_MESSAGE,
} from "@/api/lib/legal-search/search-index-unavailable";
import { LIMITS } from "@/api/lib/limits";
import { getAppBaseUrl } from "@/api/lib/mcp-connectors/app-urls";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { getCurrentRequestId } from "@/api/lib/observability/request-context";
import {
  decodePaginationCursor,
  encodePaginationCursor,
  isIssuablePaginationCursor,
} from "@/api/lib/pagination";
import { stripSearchHighlightMarkup } from "@/api/lib/search/highlight";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";
import type { McpRequestContext } from "@/api/mcp/context";
import { getAccessibleWorkspaceId } from "@/api/mcp/context";
import type { McpErrorCode, McpValidationIssue } from "@/api/mcp/error-codes";
import {
  projectMcpRefusal,
  statusCodeToErrorCode,
} from "@/api/mcp/error-codes";
import type { CheckedOutput } from "@/api/mcp/output-excess-keys";
import { MCP_INTERNAL_TOOL_FAILURE } from "@/api/mcp/tool-call-outcome";
import { TOOL_CONFIRMATION } from "@/api/mcp/tool-confirmation";
import type { ToolConfirmation } from "@/api/mcp/tool-confirmation";
import type {
  InternalToolErrorResult,
  InternalToolResult,
  InternalToolSuccess,
  McpEgressPlan,
  RuntimeMcpToolOutputContract,
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

/**
 * Characters of long document text one tool response may carry. Every
 * corpus read that windows its text (decisions, statutes) uses this one
 * budget, so an agent paging one surface learns the page size of all of them.
 */
export const MCP_CONTENT_MAX_CHARS = 8000;

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

/**
 * A country input, in any spelling that carries one meaning.
 *
 * The leniency itself is not here: it is the `country` agent-input kind, which
 * the tool binds to this property with `countryNormalization` so one reader
 * canonicalizes every surface. This schema is the declaration that says a
 * country is what the property holds, and its bounds are what make the
 * advertised contract match that: a schema capped at three characters tells a
 * model the names are refused when the reader in fact reads them.
 */
export const countryInputSchema = (description: string) =>
  v.pipe(
    v.string(),
    v.maxLength(COUNTRY_INPUT_MAX_CHARS),
    v.description(description),
  );

/**
 * Binds a country property to the shared reader.
 *
 * `spelling` is required rather than defaulted: alpha-3 is what the corpus
 * keys on and alpha-2 is what a practice-jurisdiction row holds, and guessing
 * would write one into the other's column.
 */
export const countryNormalization = ({
  spelling,
  admitted,
  tool,
}: {
  spelling: CountrySpelling;
  admitted?: readonly string[];
  tool?: string;
}): AgentInputNormalizationAnnotation => ({
  kind: AGENT_INPUT_NORMALIZATION_KIND.country,
  country: {
    spelling,
    ...(admitted === undefined ? {} : { admitted }),
    ...(tool === undefined ? {} : { tool }),
  },
});

/**
 * An optional search filter whose values live in the corpus rather than in the
 * schema (a court, a decision type, a language). The shared reader drops the
 * placeholder a caller writes for "not filtering" (`" "`, `"all"`, `"-"`);
 * matching the value against the data is the handler's.
 */
export const FILTER_NORMALIZATION: AgentInputNormalizationAnnotation = {
  kind: AGENT_INPUT_NORMALIZATION_KIND.filter,
};

/** A statute's ELI, read back from the short and reordered spellings. */
export const ELI_NORMALIZATION: AgentInputNormalizationAnnotation = {
  kind: AGENT_INPUT_NORMALIZATION_KIND.eli,
};

/**
 * An MCP tool's declared input: `v.strictObject(...)`, or a pipe over one.
 * `entries` names every property the surface declares.
 */
type ToolObjectInputSchema = v.GenericSchema & {
  readonly entries: v.ObjectEntries;
};

/**
 * What a handler parses: the declared object with a strict client's nulls
 * already dropped. The declared object stays reachable as `advertisedSchema`
 * because JSON Schema projection reads a pipe's first schema, which here is
 * the `unknown` root the transform needs.
 */
export type NullAsAbsentInputSchema = v.GenericSchema & {
  readonly advertisedSchema: ToolObjectInputSchema;
};

/**
 * The wrapper's type for one declared object. Written out rather than inferred
 * from the `v.pipe(...)` expression: every tool input schema in this directory
 * goes through {@link nullAsAbsent}, so an inferred `SchemaWithPipe` over a
 * three-item tuple would be instantiated at each of them and carried into every
 * handler that reads `parsed.output`. This says the same thing in two nodes.
 */
type NullAsAbsentSchema<TSchema extends ToolObjectInputSchema> =
  v.GenericSchema<unknown, v.InferOutput<TSchema>> & {
    readonly advertisedSchema: TSchema;
  };

/**
 * The values a client sends for a property it is not setting. `null` is the
 * convention this surface documents; a client that must fill every declared
 * property instead sends the empty value of the declared type. `0` and `false`
 * are absent from this list on purpose: they are values a number or boolean
 * property means.
 */
const ABSENT_PLACEHOLDERS = [
  "null",
  "empty-string",
  "empty-array",
  "empty-object",
] as const;

type AbsentPlaceholder = (typeof ABSENT_PLACEHOLDERS)[number];

/** The value each placeholder stands for, for probing a property's schema. */
const PLACEHOLDER_VALUES = {
  null: null,
  "empty-string": "",
  "empty-array": [],
  "empty-object": {},
} as const satisfies Record<AbsentPlaceholder, unknown>;

const isPlaceholder = (value: unknown, placeholder: AbsentPlaceholder) => {
  switch (placeholder) {
    case "null":
      return value === null;
    case "empty-string":
      return value === "";
    case "empty-array":
      return isUnknownArray(value) && value.length === 0;
    case "empty-object":
      return (
        isRecord(value) &&
        !isUnknownArray(value) &&
        Object.keys(value).length === 0
      );
    default:
      return panic(`Unhandled absent placeholder: ${String(placeholder)}`);
  }
};

/** One object or array level of a declared input, as far as placeholder
 * dropping cares: which placeholders each property carries as absence, and
 * where to recurse. */
type NullAsAbsentPlan =
  | {
      readonly kind: "object";
      readonly absentWhen: ReadonlyMap<string, readonly AbsentPlaceholder[]>;
      readonly properties: ReadonlyMap<string, NullAsAbsentPlan>;
    }
  | { readonly kind: "array"; readonly item: NullAsAbsentPlan };

const isObjectSchema = (
  schema: unknown,
): schema is { entries: Record<string, v.GenericSchema> } =>
  isRecord(schema) && isRecord(schema["entries"]);

const isArraySchema = (schema: unknown): schema is { item: v.GenericSchema } =>
  isRecord(schema) && isRecord(schema["item"]);

/** Strip `optional`/`nullable`/... wrappers and pipes down to the schema that
 * declares the shape. */
const declaredShapeOf = (schema: unknown): unknown => {
  if (!isRecord(schema)) {
    return schema;
  }
  const pipe = schema["pipe"];
  if (isUnknownArray(pipe) && pipe.length > 0) {
    return declaredShapeOf(pipe[0]);
  }
  const wrapped = schema["wrapped"];
  return wrapped === undefined ? schema : declaredShapeOf(wrapped);
};

/**
 * The placeholders one property carries as absence: those it REJECTS, on a
 * property that accepts being omitted. A required property still fails on the
 * placeholder, and a property that accepts it keeps it — an empty string on a
 * plain text property is an empty label, not an omission.
 */
const absentPlaceholdersOf = (schema: v.GenericSchema): AbsentPlaceholder[] => {
  if (!v.safeParse(schema, undefined).success) {
    return [];
  }
  return ABSENT_PLACEHOLDERS.filter(
    (placeholder) =>
      !v.safeParse(schema, PLACEHOLDER_VALUES[placeholder]).success,
  );
};

const nullAsAbsentPlan = (schema: unknown): NullAsAbsentPlan | undefined => {
  const declared = declaredShapeOf(schema);
  if (isObjectSchema(declared)) {
    const absentWhen = new Map<string, readonly AbsentPlaceholder[]>();
    const properties = new Map<string, NullAsAbsentPlan>();
    for (const [key, property] of Object.entries(declared.entries)) {
      const placeholders = absentPlaceholdersOf(property);
      if (placeholders.length > 0) {
        absentWhen.set(key, placeholders);
      }
      const nested = nullAsAbsentPlan(property);
      if (nested !== undefined) {
        properties.set(key, nested);
      }
    }
    return { kind: "object", absentWhen, properties };
  }
  if (!isArraySchema(declared)) {
    return undefined;
  }
  const item = nullAsAbsentPlan(declared.item);
  return item === undefined ? undefined : { kind: "array", item };
};

const applyNullAsAbsent = (value: unknown, plan: NullAsAbsentPlan): unknown => {
  switch (plan.kind) {
    case "array":
      return isUnknownArray(value)
        ? value.map((entry) => applyNullAsAbsent(entry, plan.item))
        : value;
    case "object": {
      if (!isRecord(value)) {
        return value;
      }
      return Object.fromEntries(
        Object.entries(value).flatMap(([key, entry]) => {
          const placeholders = plan.absentWhen.get(key);
          if (
            placeholders?.some((placeholder) =>
              isPlaceholder(entry, placeholder),
            )
          ) {
            return [];
          }
          const nested = plan.properties.get(key);
          return [
            [
              key,
              nested === undefined ? entry : applyNullAsAbsent(entry, nested),
            ] as const,
          ];
        }),
      );
    }
    default:
      return panic(`Unhandled null-as-absent plan: ${JSON.stringify(plan)}`);
  }
};

/**
 * Read a tool's input with a placeholder meaning absence, at every object level
 * the schema declares.
 *
 * A strict tool-schema client must send every declared property, so it sends
 * something for the ones it is not setting: `null`, or — the shape models
 * actually produce — the empty value of the declared type, `""` for a string,
 * `[]` for an array, `{}` for an object. None of those is a value on this
 * surface: `input_type: null` reads as a field with no input control,
 * `options_from: ""` as a dependent select sourced from a field with no path.
 * Normalizing inside one handler leaves every other consumer of the schema
 * (evals, tests, the capability catalog) with the raw contract, so the schema
 * owns it instead.
 *
 * Only a placeholder the property ITSELF rejects is dropped, and only on a
 * property that accepts being omitted. A required property set to a
 * placeholder, a placeholder under a misspelled key, and an empty string on a
 * property that accepts one all still read exactly as sent. `0` and `false`
 * are never placeholders.
 */
export const nullAsAbsent = <TSchema extends ToolObjectInputSchema>(
  advertisedSchema: TSchema,
): NullAsAbsentSchema<TSchema> => {
  const plan =
    nullAsAbsentPlan(advertisedSchema) ??
    panic("A tool input schema must declare object properties");
  return Object.assign(
    v.pipe(
      v.unknown(),
      v.transform((value: unknown) => applyNullAsAbsent(value, plan)),
      advertisedSchema,
    ),
    { advertisedSchema },
  );
};

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

/**
 * A tool's successful output. `TData` is read from the return context (the
 * handler's declared output), and `data` may carry no property that type
 * lacks: a strict output schema would reject it after the handler succeeded.
 */
export const toolDataResult = <TData, TActual extends TData>(
  data: CheckedOutput<TActual, TData>,
): InternalToolSuccess<TData> => ({
  status: "success",
  data,
});

/**
 * Output for a surface without a declared output type (gateway families,
 * capability passthrough), which nothing validates against a Stella schema.
 */
export const untypedToolDataResult = (data: unknown): InternalToolSuccess => ({
  status: "success",
  data,
});

type StructuredEgressPlan<TPayload> = Extract<
  McpEgressPlan<TPayload>,
  { egress: "structured" }
>;

type StructuredEgressPlanOptions<TPayload, TActual> = Omit<
  StructuredEgressPlan<TPayload>,
  "egress" | "payload"
> & { payload: CheckedOutput<TActual, TPayload> };

/** `toolDataResult` for a payload the egress pipeline finalizes. */
export const structuredEgressPlan = <TPayload, TActual extends TPayload>({
  payload,
  ...plan
}: StructuredEgressPlanOptions<
  TPayload,
  TActual
>): StructuredEgressPlan<TPayload> => ({
  egress: "structured",
  payload,
  ...plan,
});

/** `untypedToolDataResult` for a payload the egress pipeline finalizes. */
export const untypedStructuredEgressPlan = (
  plan: Omit<StructuredEgressPlan<unknown>, "egress">,
): StructuredEgressPlan<unknown> => ({ egress: "structured", ...plan });

// TypeScript's JSON.stringify overload for `unknown` claims it always returns
// a string, but the runtime returns undefined for unsupported root values.
const stringifyJson = (value: unknown): unknown => JSON.stringify(value);

/**
 * A tool succeeded but its output failed the output schema it advertises on a
 * declared field (missing or invalid; undeclared extra keys alone are
 * stripped and reported instead). The cause of the panic
 * `serializeToolResult` raises; observed as a defect: the handler and its
 * contract disagree, so every call on that path fails until the code changes.
 */
export class McpOutputContractError extends TaggedError(
  "McpOutputContractError",
)<{
  message: string;
}> {
  static {
    declareFailureClass(this, "response_invalid");
  }
}

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * `structuredContent` for a success. A Stella-owned tool (static, or a dynamic
 * family such as skills) projects and validates through the same executable
 * contract that generated its advertised `outputSchema`; a success without a
 * Stella contract retains the legacy object mirror.
 *
 * An error result never carries it: `structuredContent` is the tool's output,
 * and the `{ error: … }` envelope is the absence of one. A client validating
 * it against an output schema must not be handed a failure envelope in that
 * slot.
 *
 * Output whose only violation is undeclared extra keys is stripped of them
 * (the degrade shared with the chat projection) and reported as a defect; the
 * caller still gets exactly the advertised shape.
 */
const successStructuredContent = (
  result: InternalToolSuccess,
  outputContract: RuntimeMcpToolOutputContract | undefined,
  toolName: string | undefined,
): Record<string, unknown> | undefined => {
  if (outputContract === undefined) {
    return isJsonObject(result.data) ? result.data : undefined;
  }
  const projected = outputContract.project(result.data);
  const parsed = parseStrippingUndeclaredKeys(
    outputContract.outputSchemaSource,
    projected,
  );
  if (Result.isError(parsed)) {
    // Paths only: an issue's `input` is the tool's output, which carries
    // matter content.
    const paths = parsed.error.issues.map(
      (issue) => v.getDotPath(issue) ?? "(root)",
    );
    return panic(
      "MCP tool output violated its advertised contract",
      new McpOutputContractError({
        message: `MCP tool output violated its advertised contract at ${paths.join(", ")}`,
      }),
    );
  }
  const { output, undeclaredPaths } = parsed.value;
  if (undeclaredPaths.length > 0) {
    reportToolOutputDegrade({
      defect: "undeclared_fields",
      paths: undeclaredPaths,
      source: "mcp",
      toolName: toolName ?? "(unknown)",
    });
  }
  if (!isJsonObject(output)) {
    return panic("MCP tool output contract produced a non-object root");
  }
  return output;
};

/** Serialize a canonical Stella tool result at the external MCP boundary. */
export const serializeToolResult = (
  result: InternalToolResult,
  outputContract?: RuntimeMcpToolOutputContract,
  /** Telemetry only: names the tool in a degraded-output defect report. */
  toolName?: string,
): CallToolResult => {
  if (result.status === "success") {
    const serializedData = stringifyJson(result.data);
    if (typeof serializedData !== "string") {
      panic("Internal tool success data must be JSON-serializable");
    }
    // A host shows the model either the text or `structuredContent`, so the
    // one text block is the JSON of the same validated object.
    const structuredContent = successStructuredContent(
      result,
      outputContract,
      toolName,
    );
    return {
      content: [
        {
          type: "text",
          text:
            structuredContent === undefined
              ? serializedData
              : JSON.stringify(structuredContent),
        },
      ],
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
    ...(result.error.code === "internal_error"
      ? { [MCP_INTERNAL_TOOL_FAILURE]: result.error[MCP_INTERNAL_TOOL_FAILURE] }
      : {}),
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
    untypedToolDataResult(data),
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
 * Hint for an unexpected server-side failure. Kept as a shared constant so the
 * internal-error envelope reads the same wherever it is produced. The report
 * step names both calls: a hint that stops at the draft leaves the report
 * sitting in the model's context, unsent.
 *
 * One step per sentence: the dispatch boundary drops each sentence naming a
 * tool the serving surface does not list (`scopeToolResultToSurface`), so a
 * surface without the feedback tools keeps the first two: what failed, and
 * the step every caller can still take.
 */
export const MCP_INTERNAL_ERROR_HINT =
  "This is a server-side failure; changing the arguments will not fix it. Tell the human this step failed on the server, then continue without it. If this looks like a stella bug, draft a report with prepare_feedback, then send it with submit_feedback once the human approves.";

/**
 * Hint for a backing service that is temporarily unreachable. Same
 * sentence-per-step shape as {@link MCP_INTERNAL_ERROR_HINT}: the retry step
 * survives on every surface, the report step only where it can be filed.
 */
export const MCP_UPSTREAM_UNAVAILABLE_HINT =
  "Retry the same request. If the service remains unavailable, draft a report with prepare_feedback (put the request ID in context.request_id) and send it with submit_feedback once the human approves.";

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
  contactUrl,
}: {
  code: McpErrorCode;
  hint?: string | undefined;
  issues?: readonly McpValidationIssue[] | undefined;
  message: string;
  retryable?: boolean | undefined;
  contactUrl?: string | undefined;
}): InternalToolErrorResult => {
  const requestId = getCurrentRequestId();
  const fields = {
    type: "structured",
    message,
    ...(hint === undefined ? {} : { hint }),
    ...(issues === undefined || issues.length === 0 ? {} : { issues }),
    ...(retryable === undefined ? {} : { retryable }),
    ...(contactUrl === undefined ? {} : { contactUrl }),
    ...(requestId === undefined ? {} : { requestId }),
  } as const;
  return {
    status: "error",
    error:
      code === "internal_error"
        ? { code, ...fields, [MCP_INTERNAL_TOOL_FAILURE]: true }
        : { code, ...fields },
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

/**
 * The status a reused backing handler answered with, when it answered with
 * one rather than a payload. Elysia's `status(code, body)` returns
 * `{ code, response }`; a bare `{ message }` is accepted too because some
 * handlers return that shape directly. One reader for both, so a tool that
 * branches on a handler's refusal cannot read it differently from its
 * neighbour.
 */
export type HandlerStatus = { code: number | null; message: string | null };

export const handlerStatusOf = (value: unknown): HandlerStatus | null => {
  if (!isRecord(value)) {
    return null;
  }

  if (typeof value["message"] === "string") {
    return { code: null, message: value["message"] };
  }

  const response = value["response"];
  if (!isRecord(response) || typeof response["message"] !== "string") {
    return null;
  }

  return {
    code: typeof value["code"] === "number" ? value["code"] : null,
    message: response["message"],
  };
};

/** Just the message of {@link handlerStatusOf}, for a caller that only reports it. */
export const handlerResultMessage = (value: unknown): string | null =>
  handlerStatusOf(value)?.message ?? null;

/** `not_found` envelope for a resource that does not exist or is inaccessible. */
export const notFoundResult = (
  message: string,
  hint?: string,
): InternalToolErrorResult =>
  structuredErrorResult({ code: "not_found", hint, message });

const SEARCH_INDEX_UNAVAILABLE_SINK = failureSink({
  event: "mcp.search_index_unavailable",
  expected: [],
});

/**
 * Envelope for a search whose index could not be reached. Every tool backed
 * by the public-law search index answers it the same way, whichever path the
 * refusal took to the boundary (a thrown handler error, a failed `Result`, a
 * safe handler's 503 body): the stable code to branch on, the cause in the
 * message, and a retry, because the arguments did not cause it. The cause
 * is still observed, so an index that stays away is seen.
 */
export const searchIndexUnavailableResult = (
  error: unknown,
): InternalToolErrorResult => {
  observeFailure(error, {
    sink: SEARCH_INDEX_UNAVAILABLE_SINK,
    ctx: { source: "mcp" },
  });
  return structuredErrorResult({
    code: SEARCH_INDEX_UNAVAILABLE_CODE,
    message: SEARCH_INDEX_UNAVAILABLE_MESSAGE,
    hint: SEARCH_INDEX_UNAVAILABLE_HINT,
    retryable: true,
  });
};

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
  if (isSearchIndexUnavailable(error)) {
    return searchIndexUnavailableResult(error);
  }
  if (HandlerError.is(error)) {
    if (error.code === "upstream_unavailable") {
      captureError(error, { source: "mcp" });
      return structuredErrorResult({
        code: "upstream_unavailable",
        message: error.message,
        hint: MCP_UPSTREAM_UNAVAILABLE_HINT,
        retryable: true,
      });
    }
    const code = statusCodeToErrorCode(error.status);
    if (code !== "internal_error") {
      return structuredErrorResult(projectMcpRefusal(error));
    }
  }
  captureError(error, { source: "mcp" });
  return structuredErrorResult({
    code: "internal_error",
    message: "Tool execution failed",
    hint: MCP_INTERNAL_ERROR_HINT,
  });
};

// A name's words in sorted order, so `widgets.delete-part` and
// `widgets.parts.delete` compare as `delete part widgets` / `delete parts widgets`.
const sortedWords = (name: string): string =>
  name.split(/[._-]/u).toSorted().join(" ");

/**
 * A tool name as an agent may have meant it: lowercased, without separators
 * and without a leading `external` (the prefix chat scripts put on read
 * functions). `listMatters`, `LIST_MATTERS`, `list-matters` and
 * `external_list_matters` all share the key of `list_matters`.
 */
export const toolNameKey = (name: string): string =>
  name
    .toLowerCase()
    .replaceAll(/[-_.]/gu, "")
    .replace(/^external/u, "");

/**
 * How far `target` is from the tool name `name`: the smallest of the plain
 * edit distance, the word-order-insensitive one (`widgets.delete-part` against
 * `widgets.parts.delete`) and the distance between their keys (case,
 * separators and an `external_` prefix ignored).
 */
export const toolNameDistance = (target: string, name: string): number =>
  Math.min(
    levenshtein(target, name),
    levenshtein(sortedWords(target), sortedWords(name)),
    levenshtein(toolNameKey(target), toolNameKey(name)),
  );

/**
 * Up to `limit` known tool names closest to `target` by
 * {@link toolNameDistance}, used to hint an agent that fat-fingered a tool
 * name. Only candidates within a lenient edit budget (roughly half the longer
 * name) are kept, so an unrelated miss returns nothing rather than a confusing
 * suggestion. No dependency: a tiny DP implementation is enough for the short,
 * small candidate set.
 */
export const closestToolNames = (
  target: string,
  candidates: readonly string[],
  limit = 3,
): string[] => {
  const scored: { name: string; distance: number }[] = [];
  for (const name of candidates) {
    const distance = toolNameDistance(target, name);
    if (distance <= Math.ceil(name.length / 2)) {
      scored.push({ name, distance });
    }
  }

  return scored
    .toSorted(
      // oxlint-disable-next-line require-cached-collator/require-cached-collator -- tool names are machine identifiers (agent-facing "did you mean"), not display text
      (a, b) => a.distance - b.distance || a.name.localeCompare(b.name),
    )
    .slice(0, limit)
    .map(({ name }) => name);
};

/** A tool name as agent-facing text quotes it. */
export const quoteToolName = (name: string): string => `\`${name}\``;

/**
 * The one "did you mean" sentence every unknown-name answer uses (MCP
 * `unknown_tool` hints, capability ids, chat script functions), over labels
 * the caller already quoted. Empty when there is nothing to suggest.
 */
export const didYouMean = (labels: readonly string[]): string => {
  const [only, ...rest] = labels;
  if (only === undefined) {
    return "";
  }
  return rest.length === 0
    ? `Did you mean ${only}?`
    : `Did you mean one of ${labels.join(", ")}?`;
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

export const isToolErrorResult = (
  value: unknown,
): value is InternalToolErrorResult =>
  typeof value === "object" &&
  value !== null &&
  "status" in value &&
  value.status === "error";

/** Wire cap on an opaque pagination cursor, shared with the tool schemas. */
const MAX_CURSOR_LENGTH = 512;

type CursorInputOptions = {
  description: string;
  maxLength?: number;
  /**
   * Which strings the encoder behind this property can have issued. Defaults
   * to the shared codecs' class. A surface paginated by something else (an
   * upstream decimal offset) passes its own, because reading its cursors
   * against the shared class would call every one of them made up.
   */
  issuedBy?: (value: string) => boolean;
};

/**
 * A pagination cursor property, with a made-up value read as absence.
 *
 * A client that fills every declared property has to put something in
 * `cursor` on its first call, and what it puts there is a placeholder: `" "`,
 * `"0"`, `"start"`, `"__start__"`. Handing those to a decoder answers
 * `Invalid cursor` to a caller holding no cursor, so it invents another one
 * and the call never reaches a first page. A value outside the issued class
 * therefore means "no cursor", exactly as `null` and `""` do through
 * {@link nullAsAbsent}.
 *
 * A value inside the class still goes to the tool's own decoder and still
 * fails there when it does not decode: a truncated real cursor decodes to a
 * readable prefix, and silently restarting that caller at page one would
 * repeat a page it had already read.
 */
export const cursorInput = ({
  description,
  issuedBy = isIssuablePaginationCursor,
  maxLength = MAX_CURSOR_LENGTH,
}: CursorInputOptions) =>
  v.optional(
    v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(maxLength),
      v.description(description),
      v.transform((value: string) => (issuedBy(value) ? value : undefined)),
    ),
  );

/**
 * The one refusal for a cursor inside the issued class that does not decode:
 * one the caller invented on a later call, or a real one that arrived cut
 * short.
 *
 * It asks rather than restarting at page one. Both readings mean the
 * position is lost, and a silent restart would hand a paging caller its
 * first page again as if it were the next one: results repeat, and a caller
 * that stops at a page it has seen concludes it has read everything. Asking
 * costs one round trip and keeps every page a caller is given the one it
 * asked for, so the hint names the restart explicitly instead.
 */
export const invalidCursorResult = ({
  cursor,
  tool,
}: {
  cursor: string;
  /** The tool that issues this cursor, named in the hint; omit when shared. */
  tool?: string | undefined;
}): InternalToolErrorResult => {
  const ask = askForFix({
    input: cursor,
    expected: `a cursor ${tool ?? "this tool"} issued`,
    hint:
      `This cursor does not decode, so the position it held is lost. Call ` +
      `${tool ?? "the tool"} again without cursor to start from the first ` +
      "page, or pass nextCursor exactly as the previous response returned it.",
  });
  return structuredErrorResult({
    code: "validation_error",
    message: "Invalid cursor",
    issues: [{ path: "cursor", message: askSentence(ask) }],
    hint: ask.hint,
  });
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
 * end. Use resolveTextWindowBounds for Unicode text windows.
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

const MAX_BMP_CODE_POINT = 0xff_ff;

type TextWindowBoundsOptions = {
  text: string;
  offset: number;
  size: number;
};

/**
 * UTF-16 cursor offsets, with windows ending on complete Unicode code points.
 * A one-unit budget includes a whole surrogate pair to guarantee progress.
 */
export const resolveTextWindowBounds = ({
  text,
  offset,
  size,
}: TextWindowBoundsOptions): WindowBounds => {
  const bounds = resolveWindowBounds(text.length, offset, size);
  const splitsCodePoint = (at: number) => {
    const previous = text.codePointAt(at - 1);
    return previous !== undefined && previous > MAX_BMP_CODE_POINT;
  };
  const start = splitsCodePoint(bounds.start) ? bounds.start - 1 : bounds.start;
  let end = bounds.end;
  if (splitsCodePoint(end)) {
    end = end - 1 > start ? end - 1 : end + 1;
  }
  return { start, end, nextOffset: end < text.length ? end : null };
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
    return invalidCursorResult({ cursor });
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

  const { start, end, nextOffset } = resolveTextWindowBounds({
    text,
    offset,
    size: maxChars,
  });

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

export { buildDocumentUrl } from "@/api/lib/mcp-connectors/app-urls";

/** Keep the legacy app URL beside the shared primary/source link contract. */
export const legalCitationLinkFields = ({
  appUrl,
  sourceUrl,
}: {
  appUrl: string | null;
  sourceUrl: string | null;
}) => {
  const links = resolveLegalCitationLinks({
    appUrl,
    sourceUrl,
    appOrigins: new Set([new URL(getAppBaseUrl()).origin]),
  });
  return {
    appUrl,
    url: links.url,
    ...(links.type === "external" || links.source_url === undefined
      ? {}
      : { source_url: links.source_url }),
  };
};

export const buildCaseLawDecisionAppUrl = (
  input: CaseLawDecisionRouteInput,
): string | null =>
  isDeploymentFeatureEnabled("FEATURE_PUBLIC_LAW")
    ? buildCaseLawDecisionUrl(input)
    : null;

/**
 * The route shape is owned by `@stll/api-contract/case-law-decision-route`, so
 * an agent-facing URL and the web route cannot address different pages: a
 * decision without a stored slug links by id, not by case number.
 */
export const buildCaseLawDecisionUrl = (input: CaseLawDecisionRouteInput) =>
  `${getAppBaseUrl()}${createCaseLawDecisionPath(createCaseLawDecisionRouteParams(input))}`;

/**
 * The plain text of one corpus document: its stored plain-text consolidation
 * when the corpus holds one, else the text its parsed blocks carry.
 *
 * Callers pass the blocks their own read already produced (a decision parses
 * them out of `documentAst`, a statute read hands over an AST it has parsed),
 * so nothing is parsed twice; what lives here is the projection both corpora
 * must agree on. A block with no text of its own (an unlabelled figure)
 * contributes nothing rather than a blank paragraph.
 */
export const toPlainCorpusText = ({
  blocks,
  fulltext,
}: {
  blocks: readonly { plainText: string }[] | null;
  fulltext: string | null;
}): string | null => {
  if (typeof fulltext === "string" && fulltext.length > 0) {
    return fulltext;
  }
  if (blocks === null) {
    return null;
  }

  return blocks
    .flatMap((block) => (block.plainText === "" ? [] : [block.plainText]))
    .join("\n\n");
};

/**
 * A statute's canonical public address: its stored slug, or the id form when
 * the corpus holds none. A version and provision anchor preserve a dated read. The
 * route shape is owned by `@stll/api-contract/statute-route`, so the address
 * a tool reports and the page the web serves cannot diverge. Null only when
 * the public-law surface is off.
 */
export const buildLegislationDocumentAppUrl = ({
  country,
  documentId,
  eli,
  slug,
  version = null,
  anchor,
}: Omit<StatuteRouteInput, "version"> & {
  version?: string | null;
  anchor?: string;
}): string | null =>
  isDeploymentFeatureEnabled("FEATURE_PUBLIC_LAW")
    ? `${getAppBaseUrl()}${createStatutePath(
        createStatuteRouteParams({
          country,
          documentId,
          eli,
          slug,
          version,
        }),
      )}${anchor === undefined ? "" : `#${encodeURIComponent(anchor)}`}`
    : null;

/**
 * Plain text for a search snippet built for the web UI. A snippet is
 * HTML-escaped and wraps its matches in `<mark>`; an MCP client is an agent or
 * a terminal, never a browser, so the markup is noise there. The format's
 * owner (`lib/search/highlight.ts`) reads it back; what this adds is the
 * absent-snippet contract every tool here wants.
 */
export const toPlainTextSnippet = (snippet: string | null): string | null =>
  snippet === null ? null : stripSearchHighlightMarkup(snippet);

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

/**
 * The refusal for a confirmation-gated call from a session that cannot
 * confirm, or null when the session may proceed to the usual `confirm` check.
 */
export const confirmationUnavailableResult = ({
  toolConfirmation = TOOL_CONFIRMATION.caller,
  subject,
}: {
  toolConfirmation?: ToolConfirmation | undefined;
  subject: string;
}): InternalToolErrorResult | null =>
  toolConfirmation === TOOL_CONFIRMATION.unavailable
    ? structuredErrorResult({
        code: "permission_denied",
        message: `${subject} needs a person's confirmation and is not available in agent runs`,
        hint: "Describe the change in your reply so the user can make it in stella; do not retry it from this run.",
      })
    : null;
