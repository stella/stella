import { Result } from "better-result";

import { MCP_CAPABILITY_EXECUTORS } from "@stll/api-contract/mcp-capability-executors";

import {
  documentVersionRealtimeUpdates,
  entityFileRealtimeUpdates,
  entityRealtimeUpdates,
  entityVersionRealtimeUpdates,
  fieldRealtimeUpdates,
  organizationWorkspaceRealtimeUpdates,
  playbookRunRealtimeUpdates,
  taskCreateRealtimeUpdates,
  taskRealtimeUpdates,
  timeEntryRealtimeUpdates,
  workspaceContactRealtimeUpdates,
  workspaceRealtimeUpdates,
} from "@/api/handlers/realtime-resource-sets";
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import {
  announceResourceSetUpdates,
  noResourceSetUpdates,
  type ResourceSetRealtime,
} from "@/api/lib/resource-set-realtime";
import type { McpWriteToolName } from "@/api/mcp/matter-requirement";
import type { McpToolHandler, McpToolResponse } from "@/api/mcp/tool-types";
import { isToolErrorResult } from "@/api/mcp/tool-utils";
import type { AuthorizedMcpRequestContext } from "@/api/mcp/write-tool-authority";

const NO_ROUTE_REALTIME = [
  noResourceSetUpdates("No route of this tool declares realtime"),
];

/**
 * What a successful call of each write tool announces: the `realtime`
 * declarations of the REST routes it stands in for. Tools call the routes'
 * operations directly, so the safe-handler wrapper that announces for a route
 * never runs for them. Total over the write tools so a new one has to choose;
 * `mcp-coverage-guard` holds each entry equal to its routes.
 */
export const WRITE_TOOL_REALTIME = {
  save_matter: [organizationWorkspaceRealtimeUpdates, workspaceRealtimeUpdates],
  delete_matter: [organizationWorkspaceRealtimeUpdates],
  save_contact: NO_ROUTE_REALTIME,
  delete_contact: NO_ROUTE_REALTIME,
  save_task: [taskCreateRealtimeUpdates, taskRealtimeUpdates],
  delete_task: NO_ROUTE_REALTIME,
  link_matter_contact: [workspaceContactRealtimeUpdates],
  save_document: [entityRealtimeUpdates, entityVersionRealtimeUpdates],
  upload_document_version: NO_ROUTE_REALTIME,
  open_document_version_upload: NO_ROUTE_REALTIME,
  delete_document: [entityFileRealtimeUpdates],
  compare_documents: [documentVersionRealtimeUpdates],
  prepare_file_comparison: NO_ROUTE_REALTIME,
  prepare_file_comparison_from_links: NO_ROUTE_REALTIME,
  open_file_comparison: NO_ROUTE_REALTIME,
  set_field_value: [fieldRealtimeUpdates],
  save_time_entry: [timeEntryRealtimeUpdates],
  delete_time_entry: [timeEntryRealtimeUpdates],
  save_clause: NO_ROUTE_REALTIME,
  save_playbook: NO_ROUTE_REALTIME,
  delete_clause: NO_ROUTE_REALTIME,
  run_playbook: [playbookRunRealtimeUpdates],
  create_reader_annotation: NO_ROUTE_REALTIME,
  update_reader_annotation: NO_ROUTE_REALTIME,
  delete_reader_annotation: NO_ROUTE_REALTIME,
  add_matter_member: [workspaceRealtimeUpdates],
  remove_matter_member: [workspaceRealtimeUpdates],
  create_organization: NO_ROUTE_REALTIME,
  update_organization_settings: NO_ROUTE_REALTIME,
  set_practice_jurisdictions: NO_ROUTE_REALTIME,
  fill_template: NO_ROUTE_REALTIME,
  save_filled_template: NO_ROUTE_REALTIME,
  create_template: NO_ROUTE_REALTIME,
  configure_template_fields: NO_ROUTE_REALTIME,
  // The executor runs the capability's safe handler, which announces itself.
  [MCP_CAPABILITY_EXECUTORS.write]: [
    noResourceSetUpdates("The capability's own handler announces"),
  ],
  submit_feedback: NO_ROUTE_REALTIME,
  mint_web_handoff: NO_ROUTE_REALTIME,
} as const satisfies Record<McpWriteToolName, readonly ResourceSetRealtime[]>;

const isWriteToolName = (toolName: string): toolName is McpWriteToolName =>
  Object.hasOwn(WRITE_TOOL_REALTIME, toolName);

const TOOL_REALTIME_ANNOUNCEMENT_FAILURE = failureSink({
  event: "mcp.tool-realtime.announce",
  expected: [],
});

type RunToolWithRealtimeOptions = {
  args: Record<string, unknown>;
  context: AuthorizedMcpRequestContext;
  handler: McpToolHandler;
  toolName: string;
  announce?: typeof announceResourceSetUpdates;
};

/**
 * Run one tool handler and announce its declared resource sets. The audit
 * events a write records name the matters it touched, which only the handler
 * resolves, so they decide the audience. A refused call announces nothing.
 *
 * The one place both tool runners (MCP and chat) go through.
 */
export const runToolWithRealtime = async ({
  args,
  context,
  handler,
  toolName,
  announce = announceResourceSetUpdates,
}: RunToolWithRealtimeOptions): Promise<McpToolResponse> => {
  if (!isWriteToolName(toolName)) {
    return await handler({ args, context });
  }

  const writtenWorkspaceIds = new Set<SafeId<"workspace">>();
  const recordAuditEvent: AuditRecorder = async (tx, event) => {
    const events: AuditEvent[] = Array.isArray(event) ? event : [event];
    for (const { workspaceId } of events) {
      if (workspaceId !== undefined && workspaceId !== null) {
        writtenWorkspaceIds.add(workspaceId);
      }
    }
    await context.recordAuditEvent(tx, event);
  };

  const response = await handler({
    args,
    context: { ...context, recordAuditEvent },
  });
  if (isToolErrorResult(response)) {
    return response;
  }

  const announcement = Result.try(() => {
    for (const realtime of WRITE_TOOL_REALTIME[toolName]) {
      const audience =
        realtime.scope === "workspace" ? [...writtenWorkspaceIds] : [undefined];
      for (const workspaceId of audience) {
        announce({
          realtime,
          result: response,
          organizationId: context.organizationId,
          workspaceId,
        });
      }
    }
  });
  if (Result.isError(announcement)) {
    observeFailure(announcement.error, {
      sink: TOOL_REALTIME_ANNOUNCEMENT_FAILURE,
    });
  }
  return response;
};
