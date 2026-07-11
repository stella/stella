import { panic, Result } from "better-result";

import type { ChatRefRegistry } from "@/api/handlers/chat/tools/execute/ref-registry";
import { captureError } from "@/api/lib/analytics/capture";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";
import { BILLING_TOOL_HANDLERS } from "@/api/mcp/billing-tools";
import { CAPABILITY_TOOL_HANDLERS } from "@/api/mcp/capability-tools";
import type { McpRequestContext } from "@/api/mcp/context";
import { DOCUMENT_TOOL_HANDLERS } from "@/api/mcp/document-tools";
import { finalizeMcpEgress } from "@/api/mcp/egress";
import { FEEDBACK_TOOL_HANDLERS } from "@/api/mcp/feedback-tools";
import { isMcpToolFeatureEnabled } from "@/api/mcp/gateway/list-tools";
import { KNOWLEDGE_TOOL_HANDLERS } from "@/api/mcp/knowledge-tools";
import { MATTER_TOOL_HANDLERS } from "@/api/mcp/matter-tools";
import { RESEARCH_ADMIN_TOOL_HANDLERS } from "@/api/mcp/research-admin-tools";
import { getStaticMcpToolDefinition } from "@/api/mcp/static-tool-definitions";
import { STELLA_TOOL_HANDLERS } from "@/api/mcp/stella-tools";
import { TEMPLATE_TOOL_HANDLERS } from "@/api/mcp/template-tools";
import type { McpToolHandler } from "@/api/mcp/tool-types";

import type { RegistryWriteToolName } from "./ref-field-map";
import { WRITE_TOOL_REF_FIELD_MAP } from "./ref-field-map";
import {
  dehydrateRefs,
  findUndeclaredUuidPathIn,
  hydrateRefs,
} from "./ref-mediation";
import {
  ANONYMIZATION_FAILURE_MESSAGE,
  DEFAULT_TOOL_ERROR_MESSAGE,
  firstTextContent,
  parsePayload,
} from "./run-registry-tool";

/**
 * The write registry handlers chat may drive, gathered from the per-domain
 * exports and keyed by `RegistryWriteToolName` via `satisfies`. Exhaustive by
 * construction (a second class-guard beside the ref-field map): a write tool
 * with no handler wired here cannot compile. `fill_template` is included to
 * keep the map exhaustive even though the orchestrator refuses to project it
 * (the hand-written chat tool serves it instead; see `WRITE_TOOL_REF_FIELD_MAP`).
 */
const REGISTRY_WRITE_TOOL_HANDLERS = {
  save_matter: MATTER_TOOL_HANDLERS.save_matter,
  delete_matter: MATTER_TOOL_HANDLERS.delete_matter,
  save_contact: MATTER_TOOL_HANDLERS.save_contact,
  delete_contact: MATTER_TOOL_HANDLERS.delete_contact,
  save_task: MATTER_TOOL_HANDLERS.save_task,
  link_matter_contact: MATTER_TOOL_HANDLERS.link_matter_contact,
  save_document: DOCUMENT_TOOL_HANDLERS.save_document,
  delete_document: DOCUMENT_TOOL_HANDLERS.delete_document,
  set_field_value: DOCUMENT_TOOL_HANDLERS.set_field_value,
  save_time_entry: BILLING_TOOL_HANDLERS.save_time_entry,
  delete_time_entry: BILLING_TOOL_HANDLERS.delete_time_entry,
  save_clause: KNOWLEDGE_TOOL_HANDLERS.save_clause,
  delete_clause: KNOWLEDGE_TOOL_HANDLERS.delete_clause,
  run_playbook: KNOWLEDGE_TOOL_HANDLERS.run_playbook,
  manage_organization: RESEARCH_ADMIN_TOOL_HANDLERS.manage_organization,
  set_practice_jurisdictions: STELLA_TOOL_HANDLERS.set_practice_jurisdictions,
  fill_template: TEMPLATE_TOOL_HANDLERS.fill_template,
  save_template: TEMPLATE_TOOL_HANDLERS.save_template,
  // Non-projectable (`chatProjectable: false`): the orchestrator refuses it
  // before reaching a handler, but the map stays exhaustive over every write
  // tool. `send_feedback` runs its own approval handshake and is served through
  // MCP/CLI, not the chat write projection.
  send_feedback: FEEDBACK_TOOL_HANDLERS.send_feedback,
  // Non-projectable (`chatProjectable: false`): invoke_capability runs an
  // arbitrary catalog capability over MCP/CLI, never from chat; the orchestrator
  // refuses it before dispatch. Wired only to keep this map exhaustive.
  invoke_capability: CAPABILITY_TOOL_HANDLERS.invoke_capability,
} satisfies Record<RegistryWriteToolName, McpToolHandler>;

export type RunRegistryWriteToolProps = {
  toolName: RegistryWriteToolName;
  args: Record<string, unknown>;
  context: McpRequestContext;
  refRegistry: ChatRefRegistry;
};

export const applyChatApprovalConfirmation = ({
  args,
  toolName,
}: {
  toolName: RegistryWriteToolName;
  args: Record<string, unknown>;
}): Record<string, unknown> => {
  if (
    toolName === "manage_organization" &&
    args["action"] === "remove_member"
  ) {
    return { ...args, confirm: true };
  }
  return args;
};

/**
 * Run one write MCP registry tool as a per-call chat tool. Mirrors
 * `runRegistryReadTool`; the differences are intrinsic to writes:
 *
 * - The MCP handler mutates tenant state and records its own audit event via
 *   `context.recordAuditEvent`. Chat threads its real audit recorder into
 *   `buildMcpContextFromChat`, so a projected write leaves the same audit trail
 *   an MCP or REST write would; there is no separate audit step here.
 * - Role and workspace-status gating are the handler's own (`roles[...]
 *   .authorize`, `ensureActiveWorkspace`), exactly as MCP dispatch relies on;
 *   this orchestrator adds only the feature-flag gate MCP dispatch also applies.
 * - Approval is enforced upstream by the chat tool policy (`mutation` ->
 *   `needsApproval`), not here. Because the MCP handler re-validates existence
 *   and access against current state at execution time, a stale approval (the
 *   approval-requested parts never expire) simply executes against current
 *   state or fails cleanly; no separate staleness check is warranted.
 *
 * Output hydration is minimal (writes mostly return ids/acks) but the
 * fail-closed UUID backstop still runs so no raw tenant id can reach the model
 * through a write result either.
 */
export const runRegistryWriteTool = async ({
  toolName,
  args,
  context,
  refRegistry,
}: RunRegistryWriteToolProps): Promise<Result<unknown, ChatToolError>> => {
  const entry = WRITE_TOOL_REF_FIELD_MAP[toolName];
  if (!entry.chatProjectable) {
    return Result.err(
      new ChatToolError({
        message: `Tool ${toolName} is not available in chat.`,
      }),
    );
  }

  const staticDefinition =
    getStaticMcpToolDefinition(toolName) ??
    panic(`Write tool ${toolName} is missing from the static registry`);
  if (!isMcpToolFeatureEnabled(staticDefinition.feature)) {
    return Result.err(
      new ChatToolError({
        message: "This feature is not enabled on this deployment.",
      }),
    );
  }

  const dehydrated = dehydrateRefs({
    args,
    inputRefs: entry.inputRefs,
    refRegistry,
  });
  if (Result.isError(dehydrated)) {
    return Result.err(dehydrated.error);
  }

  const response = await REGISTRY_WRITE_TOOL_HANDLERS[toolName]({
    args: applyChatApprovalConfirmation({
      args: dehydrated.value.args,
      toolName,
    }),
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

  const hydrated = hydrateRefs({
    dehydration: dehydrated.value,
    output: payload.value,
    outputRefs: entry.outputRefs,
    refRegistry,
  });

  // Same fail-closed backstop the read path runs: a raw uuid surviving anywhere
  // the tool's `passthroughIdPaths` does not license is refused rather than
  // leaked. The message never repeats the payload or path, so it cannot itself
  // leak the value; the offending path (never the value) reaches telemetry.
  const offendingPath = findUndeclaredUuidPathIn({
    passthroughIdPaths: entry.passthroughIdPaths,
    payload: hydrated,
  });
  if (offendingPath !== undefined) {
    const error = new ChatToolError({ message: ANONYMIZATION_FAILURE_MESSAGE });
    captureError(error, {
      source: "run-registry-write-tool",
      toolName,
      path: offendingPath,
    });
    return Result.err(error);
  }

  return Result.ok(hydrated);
};
