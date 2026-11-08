import { panic, Result } from "better-result";
import * as v from "valibot";

import { MCP_CAPABILITY_EXECUTORS } from "@stll/api-contract/mcp-capability-executors";

import type { TurnAppRead } from "@/api/handlers/chat/tools/show-app-tool";
import { chatMcpAppForTool } from "@/api/lib/chat/mcp-app-catalog";
import { projectForChat } from "@/api/lib/chat/projection-schema";
import type { ChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { containsRawUuid } from "@/api/lib/chat/uuid-mask";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";
import { runAsCorpusSearchCaller } from "@/api/lib/legal-search/corpus-index-admission";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { mcpPublicReadCallerKey } from "@/api/lib/rate-limit/mcp-public-read-admission";
import { isRecord } from "@/api/lib/type-guards";
import { BILLING_TOOL_HANDLERS } from "@/api/mcp/billing-tools";
import { CAPABILITY_TOOL_HANDLERS } from "@/api/mcp/capability-tools";
import { CASE_LAW_COURT_CATALOG_TOOL_SET } from "@/api/mcp/case-law-court-catalog-tool";
import { COMPAT_TOOL_HANDLERS } from "@/api/mcp/compat-tools";
import type { McpRequestResources } from "@/api/mcp/context";
import { DECISION_READER_TOOL_SET } from "@/api/mcp/decision-reader-tools";
import { DOCUMENT_TOOL_HANDLERS } from "@/api/mcp/document-tools";
import { finalizeToolEgress } from "@/api/mcp/egress";
import { isMcpDescriptorFeatureEnabled } from "@/api/mcp/feature-access";
import { FEEDBACK_TOOL_HANDLERS } from "@/api/mcp/feedback-tools";
import { isMcpToolFeatureEnabled } from "@/api/mcp/gateway/list-tools";
import {
  agentInputValidationError,
  normalizeObjectInputAtBoundary,
} from "@/api/mcp/input-normalization";
import { KNOWLEDGE_TOOL_HANDLERS } from "@/api/mcp/knowledge-tools";
import { LEGAL_RESOLVE_TOOL_HANDLERS } from "@/api/mcp/legal-resolve-tools";
import { LEGISLATION_TOOL_HANDLERS } from "@/api/mcp/legislation-tools";
import { MATTER_TOOL_HANDLERS } from "@/api/mcp/matter-tools";
import { READER_ANNOTATION_TOOL_HANDLERS } from "@/api/mcp/reader-annotation-tools";
import { RESEARCH_ADMIN_TOOL_HANDLERS } from "@/api/mcp/research-admin-tools";
import {
  DEFAULT_MCP_TOOL_DEFINITIONS,
  getStaticMcpToolDefinition,
  getStaticMcpToolOutputContract,
} from "@/api/mcp/static-tool-definitions";
import { STELLA_TOOL_HANDLERS } from "@/api/mcp/stella-tools";
import { TEMPLATE_TOOL_HANDLERS } from "@/api/mcp/template-tools";
import type { RequiresThirdPartyOutbound } from "@/api/mcp/third-party-outbound";
import type {
  AllHandlerOutputsTyped,
  AssertTrue,
  HandlerOutputsMatchByName,
  InternalToolResult,
  McpToolHandler,
  McpToolResponse,
  TypedHandlerDataByName,
} from "@/api/mcp/tool-types";
import {
  serializeToolResult,
  validationErrorResult,
} from "@/api/mcp/tool-utils";
import type { AuthorizedMcpRequestContext } from "@/api/mcp/write-tool-authority";
import { authorizeMcpToolContext } from "@/api/mcp/write-tool-authority";

import type {
  ChatProjectableToolName,
  ProjectionDataByName,
  RegistryReadToolName,
} from "./ref-field-map";
import { READ_TOOL_REF_FIELD_MAP } from "./ref-field-map";
import { dehydrateInputRefs } from "./ref-mediation";
import { toRegistryChatToolError } from "./registry-tool-error";

/**
 * The read-only registry handlers chat may drive, gathered from the per-domain
 * exports and keyed by `RegistryReadToolName` via `satisfies`. Exhaustive by
 * construction (a second class-guard beside the ref-field map): a read tool with
 * no handler wired here cannot compile.
 */
const REGISTRY_READ_TOOL_HANDLERS = {
  fetch: COMPAT_TOOL_HANDLERS.fetch,
  search: COMPAT_TOOL_HANDLERS.search,
  list_matters: STELLA_TOOL_HANDLERS.list_matters,
  list_contacts: MATTER_TOOL_HANDLERS.list_contacts,
  resolve_case_law_decision:
    LEGAL_RESOLVE_TOOL_HANDLERS.resolve_case_law_decision,
  resolve_law_citation: LEGAL_RESOLVE_TOOL_HANDLERS.resolve_law_citation,
  case_law_coverage: STELLA_TOOL_HANDLERS.case_law_coverage,
  read_case_law_citations: STELLA_TOOL_HANDLERS.read_case_law_citations,
  read_case_law_decision: STELLA_TOOL_HANDLERS.read_case_law_decision,
  read_contact: STELLA_TOOL_HANDLERS.read_contact,
  read_content_across_matters: STELLA_TOOL_HANDLERS.read_content_across_matters,
  search_case_law: STELLA_TOOL_HANDLERS.search_case_law,
  search_across_matters: STELLA_TOOL_HANDLERS.search_across_matters,
  list_templates: TEMPLATE_TOOL_HANDLERS.list_templates,
  // Non-projectable (`chatProjectable: false`): chat fills templates through
  // its own hand-written tool, which reports the same decisions in its result.
  preview_template_conditions:
    TEMPLATE_TOOL_HANDLERS.preview_template_conditions,
  list_documents: DOCUMENT_TOOL_HANDLERS.list_documents,
  read_document: DOCUMENT_TOOL_HANDLERS.read_document,
  list_properties: DOCUMENT_TOOL_HANDLERS.list_properties,
  list_tasks: MATTER_TOOL_HANDLERS.list_tasks,
  lookup_business_registry: MATTER_TOOL_HANDLERS.lookup_business_registry,
  // Non-projectable: chat uses its hand-written counterparty check tool.
  check_counterparty: MATTER_TOOL_HANDLERS.check_counterparty,
  list_clauses: KNOWLEDGE_TOOL_HANDLERS.list_clauses,
  list_playbooks: KNOWLEDGE_TOOL_HANDLERS.list_playbooks,
  list_reader_annotations:
    READER_ANNOTATION_TOOL_HANDLERS.list_reader_annotations,
  list_time_entries: BILLING_TOOL_HANDLERS.list_time_entries,
  resolve_rate: BILLING_TOOL_HANDLERS.resolve_rate,
  list_invoices: BILLING_TOOL_HANDLERS.list_invoices,
  get_usage: BILLING_TOOL_HANDLERS.get_usage,
  search_legislation: LEGISLATION_TOOL_HANDLERS.search_legislation,
  read_statute: LEGISLATION_TOOL_HANDLERS.read_statute,
  read_statute_provisions: LEGISLATION_TOOL_HANDLERS.read_statute_provisions,
  read_provision_history: LEGISLATION_TOOL_HANDLERS.read_provision_history,
  search_boe_legislation: RESEARCH_ADMIN_TOOL_HANDLERS.search_boe_legislation,
  list_audit_log: RESEARCH_ADMIN_TOOL_HANDLERS.list_audit_log,
  // Non-projectable: this only prepares sanitized issue content for MCP/CLI.
  prepare_feedback: FEEDBACK_TOOL_HANDLERS.prepare_feedback,
  // Non-projectable (`chatProjectable: false`): the capability meta-tools are
  // reached over MCP/CLI, never from chat, and the orchestrator refuses them
  // before dispatch. Wired only to keep this map exhaustive over every read
  // tool.
  list_capabilities: CAPABILITY_TOOL_HANDLERS.list_capabilities,
  describe_capability: CAPABILITY_TOOL_HANDLERS.describe_capability,
  [MCP_CAPABILITY_EXECUTORS.read]:
    CAPABILITY_TOOL_HANDLERS[MCP_CAPABILITY_EXECUTORS.read],
  // Non-projectable: MCP host reader navigation and widget data. Wired only
  // to keep this map exhaustive over every read tool.
  open_case_law_decision:
    DECISION_READER_TOOL_SET.handlers.open_case_law_decision,
  read_case_law_decision_blocks:
    DECISION_READER_TOOL_SET.handlers.read_case_law_decision_blocks,
  preview_cited_provision:
    DECISION_READER_TOOL_SET.handlers.preview_cited_provision,
  list_case_law_courts:
    CASE_LAW_COURT_CATALOG_TOOL_SET.handlers.list_case_law_courts,
} satisfies Record<RegistryReadToolName, McpToolHandler>;

type ProjectableRegistryReadToolName = ChatProjectableToolName<
  typeof READ_TOOL_REF_FIELD_MAP
>;

/**
 * The reads whose handler reaches a third-party service: those declared with
 * `withThirdPartyOutbound`. Derived from the handler types, so the chat read
 * script policy cannot offer one to scripts.
 */
export type ThirdPartyOutboundReadToolName = {
  [
    TName in RegistryReadToolName
  ]: (typeof REGISTRY_READ_TOOL_HANDLERS)[TName] extends RequiresThirdPartyOutbound
    ? TName
    : never;
}[RegistryReadToolName];

/** Compile-time guard: the derivation sees the reads that need a permit. */
export type ThirdPartyOutboundReadsDeclared = AssertTrue<
  "search_boe_legislation" extends ThirdPartyOutboundReadToolName
    ? "lookup_business_registry" extends ThirdPartyOutboundReadToolName
      ? true
      : false
    : false
>;

export type RegistryReadToolDataByName = TypedHandlerDataByName<
  typeof REGISTRY_READ_TOOL_HANDLERS,
  ProjectableRegistryReadToolName
>;

const isProjectableRegistryReadToolName = (
  toolName: RegistryReadToolName,
): toolName is ProjectableRegistryReadToolName =>
  READ_TOOL_REF_FIELD_MAP[toolName].chatProjectable;

type RegistryReadProjectionDataByName = ProjectionDataByName<
  typeof READ_TOOL_REF_FIELD_MAP,
  ProjectableRegistryReadToolName
>;

/** Compile-time guard: every chat-projected handler declares typed output. */
export type RegistryReadToolOutputContract = AssertTrue<
  AllHandlerOutputsTyped<
    typeof REGISTRY_READ_TOOL_HANDLERS,
    ProjectableRegistryReadToolName
  > extends true
    ? HandlerOutputsMatchByName<
        typeof REGISTRY_READ_TOOL_HANDLERS,
        RegistryReadProjectionDataByName,
        ProjectableRegistryReadToolName
      >
    : false
>;
export type RunRegistryReadToolProps = {
  toolName: RegistryReadToolName;
  args: Record<string, unknown>;
  context: McpRequestResources;
  refRegistry: ChatRefRegistry;
  /**
   * Eval seam: answers the tool in place of its registry handler. Everything
   * around the handler stays production (ref dehydration, boundary
   * normalization, the handler's own argument parse and its envelope, egress,
   * the strict projection), so an eval fixture meets the surface a model
   * meets, without a database.
   */
  handler?: McpToolHandler | undefined;
  /**
   * Narrows the normalized arguments before the handler runs (the turn's
   * corpus scope). It sees canonical values, so it compares a country as the
   * handler will read it; a refusal stops the read.
   */
  scopeArgs?:
    | ((
        args: Record<string, unknown>,
      ) => Promise<Result<Record<string, unknown>, ChatToolError>>)
    | undefined;
  /**
   * Keeps a read a chat app presents, for the turn to show (`show_app`).
   * The id it returns rides beside the projected payload as `appId`.
   */
  recordAppRead?: ((read: TurnAppRead) => string | undefined) | undefined;
};

/**
 * Every registry handler opens by parsing its arguments with the definition's
 * own valibot schema and answering a failure with `validationErrorResult`. An
 * injected handler gets that step here, so a refused call (an unknown key, a
 * bad value) meets the handler's envelope and an accepted one the parsed
 * arguments. A legacy definition without a valibot source validates by hand
 * inside its handler; its injected handler sees the normalized arguments.
 * The definition comes from the `as const` registry array, whose element
 * union keeps each valibot source's own type.
 */
const runInjectedHandler = async ({
  args,
  context,
  toolName,
  handler,
}: {
  args: Record<string, unknown>;
  context: AuthorizedMcpRequestContext;
  toolName: RegistryReadToolName;
  handler: McpToolHandler;
}): Promise<McpToolResponse> => {
  const definition =
    DEFAULT_MCP_TOOL_DEFINITIONS.find(({ name }) => name === toolName) ??
    panic(`Read tool ${toolName} is missing from the static registry`);
  if (!("inputSchemaSource" in definition)) {
    return await handler({ args, context });
  }
  const parsed = v.safeParse(definition.inputSchemaSource, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }
  if (!isRecord(parsed.output)) {
    return panic("An object input schema parsed to a non-object value");
  }
  return await handler({ args: parsed.output, context });
};

/** The key the boundary's input notes ride under beside a read's payload. */
const CHAT_INPUT_NOTES_KEY = "inputRead";

/**
 * The boundary's "read X as Y" notes, beside the projected payload, so the
 * model learns which value the server acted on (a clamped limit, a year read
 * as a date bound, a short ELI). A note quoting a raw UUID is left out: the
 * input side was already dehydrated from refs, and no tenant UUID may reach
 * the model.
 */
const withChatInputNotes = (
  payload: unknown,
  notes: readonly string[],
): unknown => {
  const safe = [...new Set(notes)].filter((note) => !containsRawUuid(note));
  return safe.length === 0 || !isRecord(payload)
    ? payload
    : { ...payload, [CHAT_INPUT_NOTES_KEY]: safe };
};

const APP_READ_CONTRACT_SINK = failureSink({
  event: "chat.app_read_contract_violated",
  expected: [],
});

/** The key the turn's id for a read an app can show rides under. */
const CHAT_APP_ID_KEY = "appId";

const withAppId = (payload: unknown, appId: string | undefined): unknown =>
  appId === undefined || !isRecord(payload)
    ? payload
    : { ...payload, [CHAT_APP_ID_KEY]: appId };

/**
 * Keep a read a chat app presents with the MCP result an MCP client would
 * have received, which is what the app reads. Any other read is not kept.
 */
const recordShownRead = ({
  toolName,
  args,
  result,
  record,
}: {
  toolName: RegistryReadToolName;
  args: Record<string, unknown>;
  result: InternalToolResult;
  record: (read: TurnAppRead) => string | undefined;
}): string | undefined => {
  if (chatMcpAppForTool(toolName) === undefined) {
    return undefined;
  }
  // The MCP contract is stricter than the chat projection in places; a read
  // the chat could show but an MCP client could not receive shows no app.
  const wire = Result.try(() =>
    serializeToolResult(
      result,
      getStaticMcpToolOutputContract(toolName),
      toolName,
    ),
  );
  if (Result.isError(wire)) {
    observeFailure(wire.error, { sink: APP_READ_CONTRACT_SINK });
    return undefined;
  }
  const { structuredContent } = wire.value;
  return isRecord(structuredContent) && !Array.isArray(structuredContent)
    ? record({
        toolName,
        call: { input: args, result: { structuredContent } },
      })
    : undefined;
};

/** What running one registry read answered, before any surface shaped it. */
export type RegistryReadOutcome =
  /** Refused before the handler ran: the tool is off or the caller may not. */
  | { type: "refused"; error: ChatToolError }
  /**
   * The read's own answer after egress, a validation refusal included, as
   * the MCP server would serialize it.
   */
  | {
      type: "answered";
      result: InternalToolResult;
      notes: readonly string[];
      /** The arguments the handler ran with, after normalization. */
      args: Record<string, unknown>;
    };

type ExecuteRegistryReadProps = {
  toolName: RegistryReadToolName;
  /** Raw arguments: real ids, never chat refs. */
  args: Record<string, unknown>;
  context: McpRequestResources;
  handler?: McpToolHandler | undefined;
  scopeArgs?: RunRegistryReadToolProps["scopeArgs"];
};

/**
 * Run one read-only MCP registry tool the way the MCP server does: deploy
 * feature gates, boundary normalization, the caller's authority, the handler,
 * egress in DEFAULT mode. Chat projects the answer for the model; an app's
 * host hands it back to the app as the server would.
 */
export const executeRegistryRead = async ({
  toolName,
  args,
  context,
  handler,
  scopeArgs,
}: ExecuteRegistryReadProps): Promise<RegistryReadOutcome> => {
  const staticDefinition =
    getStaticMcpToolDefinition(toolName) ??
    panic(`Read tool ${toolName} is missing from the static registry`);
  if (
    !isMcpDescriptorFeatureEnabled({
      context,
      kind: "tools",
      id: staticDefinition.name,
      featureId: staticDefinition.featureId,
    })
  ) {
    return {
      type: "refused",
      error: new ChatToolError({
        kind: "unavailable",
        message: "Tool is unavailable.",
      }),
    };
  }
  if (!isMcpToolFeatureEnabled(staticDefinition.feature)) {
    return {
      type: "refused",
      error: new ChatToolError({
        kind: "unavailable",
        message: "This feature is not enabled on this deployment.",
      }),
    };
  }

  const normalized = normalizeObjectInputAtBoundary({
    access: staticDefinition.access,
    schema: staticDefinition.inputSchema,
    value: args,
  });
  if (!normalized.ok) {
    return {
      type: "answered",
      result: agentInputValidationError({
        failure: normalized,
        subject: `${toolName} arguments`,
      }),
      notes: [],
      args,
    };
  }
  const scoped =
    scopeArgs === undefined
      ? Result.ok(normalized.value)
      : await scopeArgs(normalized.value);
  if (Result.isError(scoped)) {
    return { type: "refused", error: scoped.error };
  }
  const authorization = authorizeMcpToolContext({
    context,
    dataAccess: context,
    definition: staticDefinition,
    input: scoped.value,
    toolName,
  });
  if (!authorization.authorized) {
    return {
      type: "refused",
      error: new ChatToolError({
        kind: "unavailable",
        message: authorization.refusal.message,
      }),
    };
  }
  const authorizedContext = authorization.context;

  const invoke = async (invokeArgs: Record<string, unknown>) =>
    await runAsCorpusSearchCaller(
      mcpPublicReadCallerKey(authorizedContext),
      async () =>
        handler === undefined
          ? await REGISTRY_READ_TOOL_HANDLERS[toolName]({
              args: invokeArgs,
              context: authorizedContext,
            })
          : await runInjectedHandler({
              args: invokeArgs,
              context: authorizedContext,
              toolName,
              handler,
            }),
    );
  const response = await invoke(scoped.value);
  const finished = await finalizeToolEgress({
    context: authorizedContext,
    mode: "default",
    response,
  });
  return {
    type: "answered",
    result: finished,
    notes: normalized.notes,
    args: scoped.value,
  };
};

export const isRegistryReadToolName = (
  name: string,
): name is RegistryReadToolName =>
  Object.hasOwn(REGISTRY_READ_TOOL_HANDLERS, name);

/**
 * Run one read-only MCP registry tool as a chat tool.
 *
 * 1. Refuse a tool the ref-field map keeps off the chat surface.
 * 2. Dehydrate ref args to real UUIDs.
 * 3. Run the read as the MCP server does (`executeRegistryRead`): feature
 *    gating (OAuth scope gating does not apply, see
 *    `buildMcpContextFromChat`), normalization, authority, egress.
 * 4. Project a typed error into a `ChatToolError`; otherwise project the typed
 *    payload for chat in a single schema-driven pass
 *    (`projectForChat`: strict parse, strip, ref hydration, UUID invariant).
 * 5. Carry the boundary's input notes beside the projected payload.
 */
export const runRegistryReadTool = async ({
  toolName,
  args,
  context,
  refRegistry,
  handler,
  scopeArgs,
  recordAppRead,
}: RunRegistryReadToolProps): Promise<Result<unknown, ChatToolError>> => {
  if (!isProjectableRegistryReadToolName(toolName)) {
    return Result.err(
      new ChatToolError({
        kind: "unavailable",
        message: `Tool ${toolName} is not available in chat.`,
      }),
    );
  }
  const entry = READ_TOOL_REF_FIELD_MAP[toolName];

  const dehydrated = dehydrateInputRefs({ args, refRegistry, toolName });
  if (Result.isError(dehydrated)) {
    return Result.err(dehydrated.error);
  }

  const outcome = await executeRegistryRead({
    toolName,
    args: dehydrated.value.args,
    context,
    handler,
    scopeArgs,
  });
  if (outcome.type === "refused") {
    return Result.err(outcome.error);
  }
  const finished = outcome.result;
  if (finished.status === "error") {
    return Result.err(toRegistryChatToolError(finished.error));
  }

  // One schema-driven pass: strict parse (an unknown key — a field nobody
  // classified — fails closed before it can reach the model), then strip,
  // ref hydration, and the fail-closed "no tenant UUID reaches the model"
  // invariant in the same walk. Failures carry only paths to telemetry.
  const projected = projectForChat({
    dehydration: dehydrated.value,
    payload: finished.data,
    refRegistry,
    schema: entry.projection,
    source: "run-registry-tool",
    toolName,
  });
  if (Result.isError(projected)) {
    return projected;
  }
  const appId =
    recordAppRead === undefined
      ? undefined
      : recordShownRead({
          toolName,
          args: outcome.args,
          result: finished,
          record: recordAppRead,
        });
  return Result.ok(
    withAppId(withChatInputNotes(projected.value, outcome.notes), appId),
  );
};
