import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { panic, Result } from "better-result";

import type { ChatRefRegistry } from "@/api/handlers/chat/tools/execute/ref-registry";
import { captureError } from "@/api/lib/analytics";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";
import { BILLING_TOOL_HANDLERS } from "@/api/mcp/billing-tools";
import { COMPAT_TOOL_HANDLERS } from "@/api/mcp/compat-tools";
import type { McpRequestContext } from "@/api/mcp/context";
import { DOCUMENT_TOOL_HANDLERS } from "@/api/mcp/document-tools";
import { finalizeMcpEgress } from "@/api/mcp/egress";
import { isMcpToolFeatureEnabled } from "@/api/mcp/gateway/list-tools";
import { KNOWLEDGE_TOOL_HANDLERS } from "@/api/mcp/knowledge-tools";
import { MATTER_TOOL_HANDLERS } from "@/api/mcp/matter-tools";
import { RESEARCH_ADMIN_TOOL_HANDLERS } from "@/api/mcp/research-admin-tools";
import { getStaticMcpToolDefinition } from "@/api/mcp/static-tool-definitions";
import { STELLA_TOOL_HANDLERS } from "@/api/mcp/stella-tools";
import { TEMPLATE_TOOL_HANDLERS } from "@/api/mcp/template-tools";
import type { McpToolHandler } from "@/api/mcp/tool-types";

import type { RegistryReadToolName } from "./ref-field-map";
import { READ_TOOL_REF_FIELD_MAP } from "./ref-field-map";
import {
  dehydrateInputRefs,
  findUndeclaredUuidPath,
  hydrateOutputRefs,
} from "./ref-mediation";

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
  read_case_law_decision: STELLA_TOOL_HANDLERS.read_case_law_decision,
  read_contact: STELLA_TOOL_HANDLERS.read_contact,
  read_content_across_matters: STELLA_TOOL_HANDLERS.read_content_across_matters,
  search_case_law: STELLA_TOOL_HANDLERS.search_case_law,
  search_across_matters: STELLA_TOOL_HANDLERS.search_across_matters,
  list_templates: TEMPLATE_TOOL_HANDLERS.list_templates,
  list_documents: DOCUMENT_TOOL_HANDLERS.list_documents,
  read_document: DOCUMENT_TOOL_HANDLERS.read_document,
  list_properties: DOCUMENT_TOOL_HANDLERS.list_properties,
  list_tasks: MATTER_TOOL_HANDLERS.list_tasks,
  lookup_business_registry: MATTER_TOOL_HANDLERS.lookup_business_registry,
  list_clauses: KNOWLEDGE_TOOL_HANDLERS.list_clauses,
  list_playbooks: KNOWLEDGE_TOOL_HANDLERS.list_playbooks,
  list_time_entries: BILLING_TOOL_HANDLERS.list_time_entries,
  resolve_rate: BILLING_TOOL_HANDLERS.resolve_rate,
  list_invoices: BILLING_TOOL_HANDLERS.list_invoices,
  get_usage: BILLING_TOOL_HANDLERS.get_usage,
  search_legislation: RESEARCH_ADMIN_TOOL_HANDLERS.search_legislation,
  list_audit_log: RESEARCH_ADMIN_TOOL_HANDLERS.list_audit_log,
} satisfies Record<RegistryReadToolName, McpToolHandler>;

export const firstTextContent = (result: CallToolResult): string => {
  const item = result.content.at(0);
  return item?.type === "text" ? item.text : "";
};

/** Fallback for an `isError` result whose content carries no text block. */
export const DEFAULT_TOOL_ERROR_MESSAGE = "Tool execution failed.";

/** Surfaced to the model when a hydrated payload still carries a raw uuid. */
export const ANONYMIZATION_FAILURE_MESSAGE =
  "Tool output failed anonymization of internal identifiers.";

/**
 * A finished registry result is a single text content block holding the
 * handler's JSON payload (`textResult`). Parse it back into the plain object the
 * chat sandbox expects, mapping a malformed body to a `ChatToolError`. The
 * try/catch is a boundary parse of an already-serialized payload, not control
 * flow.
 */
export const parsePayload = (
  result: CallToolResult,
): Result<unknown, ChatToolError> => {
  try {
    // JSON.parse is typed `any`; pin it to `unknown` so the payload stays
    // opaque until ref hydration walks it (no `as` cast).
    const parsed: unknown = JSON.parse(firstTextContent(result));
    return Result.ok(parsed);
  } catch {
    return Result.err(
      new ChatToolError({
        message: "The tool returned a response that could not be read.",
      }),
    );
  }
};

export type RunRegistryReadToolProps = {
  toolName: RegistryReadToolName;
  args: Record<string, unknown>;
  context: McpRequestContext;
  refRegistry: ChatRefRegistry;
};

/**
 * Run one read-only MCP registry tool as a chat tool.
 *
 * 1. Refuse a tool the ref-field map keeps off the chat surface, or one whose
 *    deploy feature flag is off (feature gating still applies to chat; OAuth
 *    scope gating does not, see `buildMcpContextFromChat`).
 * 2. Dehydrate ref args to real UUIDs.
 * 3. Run the handler and finalize its egress in DEFAULT mode (chat is not the
 *    anonymized surface).
 * 4. Map an `isError` result into a `ChatToolError`; otherwise parse the JSON
 *    payload, hydrate its tenant UUIDs into chat refs, and return the object.
 */
export const runRegistryReadTool = async ({
  toolName,
  args,
  context,
  refRegistry,
}: RunRegistryReadToolProps): Promise<Result<unknown, ChatToolError>> => {
  if (!READ_TOOL_REF_FIELD_MAP[toolName].chatProjectable) {
    return Result.err(
      new ChatToolError({
        message: `Tool ${toolName} is not available in chat.`,
      }),
    );
  }

  const staticDefinition =
    getStaticMcpToolDefinition(toolName) ??
    panic(`Read tool ${toolName} is missing from the static registry`);
  if (!isMcpToolFeatureEnabled(staticDefinition.feature)) {
    return Result.err(
      new ChatToolError({
        message: "This feature is not enabled on this deployment.",
      }),
    );
  }

  const dehydrated = dehydrateInputRefs({ args, refRegistry, toolName });
  if (Result.isError(dehydrated)) {
    return Result.err(dehydrated.error);
  }

  const response = await REGISTRY_READ_TOOL_HANDLERS[toolName]({
    args: dehydrated.value.args,
    context,
  });
  const finished = await finalizeMcpEgress({
    context,
    mode: "default",
    response,
  });

  if (finished.isError === true) {
    const message = firstTextContent(finished) || DEFAULT_TOOL_ERROR_MESSAGE;
    return Result.err(new ChatToolError({ message }));
  }

  const payload = parsePayload(finished);
  if (Result.isError(payload)) {
    return Result.err(payload.error);
  }

  const hydrated = hydrateOutputRefs({
    dehydration: dehydrated.value,
    output: payload.value,
    refRegistry,
    toolName,
  });

  // Runtime backstop for the "no tenant UUID reaches the model" invariant: the
  // ref-field map is documentation the type system cannot fully enforce (a
  // wrong or missing path silently skips hydration), so re-check the finished
  // payload path-by-path rather than trusting the static mapping alone. A
  // UUID surviving anywhere the tool's `passthroughIdPaths` does not license
  // fails closed instead of leaking; the error message never repeats the
  // payload or the path, so it cannot itself leak the value it is refusing,
  // while the offending path (never the value) still reaches telemetry.
  const offendingPath = findUndeclaredUuidPath({ toolName, payload: hydrated });
  if (offendingPath !== undefined) {
    const error = new ChatToolError({ message: ANONYMIZATION_FAILURE_MESSAGE });
    captureError(error, {
      source: "run-registry-tool",
      toolName,
      path: offendingPath,
    });
    return Result.err(error);
  }

  return Result.ok(hydrated);
};
