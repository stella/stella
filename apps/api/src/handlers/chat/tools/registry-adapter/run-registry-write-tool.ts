import { panic, Result } from "better-result";

import { projectForChat } from "@/api/lib/chat/projection-schema";
import type { ChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { resourcesAreVisible } from "@/api/lib/entities/resource-access";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import type { McpRequestContext } from "@/api/mcp/context";
import { finalizeToolEgress } from "@/api/mcp/egress";
import {
  isMcpDescriptorFeatureEnabled,
  isMcpFeatureInputEnabled,
} from "@/api/mcp/feature-access";
import { isMcpToolFeatureEnabled } from "@/api/mcp/gateway/list-tools";
import {
  agentInputValidationError,
  normalizeObjectInputAtBoundary,
} from "@/api/mcp/input-normalization";
import { matterRequiredResult } from "@/api/mcp/matter-requirement";
import {
  getStaticMcpToolDefinition,
  invokeStaticMcpTool,
} from "@/api/mcp/static-tool-definitions";
import {
  ACCOUNT_ACCESS_UNAVAILABLE_MESSAGE,
  type AccountOperationCheck,
  hasMcpToolAuthority,
  hasMcpToolInputAuthority,
  isAccountAuthorizedForMcpTool,
} from "@/api/mcp/tool-authority";

import type {
  ChatProjectableToolName,
  RegistryWriteToolName,
} from "./ref-field-map";
import { WRITE_TOOL_REF_FIELD_MAP } from "./ref-field-map";
import { dehydrateRefs } from "./ref-mediation";
import { toRegistryChatToolError } from "./registry-tool-error";

type ProjectableRegistryWriteToolName = ChatProjectableToolName<
  typeof WRITE_TOOL_REF_FIELD_MAP
>;

const isProjectableRegistryWriteToolName = (
  toolName: RegistryWriteToolName,
): toolName is ProjectableRegistryWriteToolName =>
  WRITE_TOOL_REF_FIELD_MAP[toolName].chatProjectable;

export type RunRegistryWriteToolProps = {
  toolName: RegistryWriteToolName;
  args: Record<string, unknown>;
  context: McpRequestContext;
  refRegistry: ChatRefRegistry;
};

export type RunRegistryWriteToolDependencies = {
  isMcpToolFeatureEnabled: typeof isMcpToolFeatureEnabled;
  checkAccountOperation?: AccountOperationCheck;
};

const defaultRunRegistryWriteToolDependencies = {
  isMcpToolFeatureEnabled,
} satisfies RunRegistryWriteToolDependencies;

export const applyChatApprovalConfirmation = ({
  args,
  toolName,
}: {
  toolName: RegistryWriteToolName;
  args: Record<string, unknown>;
}): Record<string, unknown> => {
  if (toolName === "remove_matter_member") {
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
 * - The definition's declared write permissions are enforced here exactly as
 *   MCP dispatch enforces them; the handler keeps its input-specific role and
 *   workspace-status checks (`ensureActiveWorkspace`). This orchestrator also
 *   applies the feature-flag gate MCP dispatch applies.
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
const CHAT_RESOURCE_ADMISSION_FAILURE = failureSink({
  event: "chat.resource_admission_failed",
  expected: [],
});

export const runRegistryWriteTool = async (
  { toolName, args, context, refRegistry }: RunRegistryWriteToolProps,
  dependencies: RunRegistryWriteToolDependencies = defaultRunRegistryWriteToolDependencies,
): Promise<Result<unknown, ChatToolError>> => {
  if (!isProjectableRegistryWriteToolName(toolName)) {
    return Result.err(
      new ChatToolError({
        kind: "unavailable",
        message: `Tool ${toolName} is not available in chat.`,
      }),
    );
  }
  const staticDefinition =
    getStaticMcpToolDefinition(toolName) ??
    panic(`Write tool ${toolName} is missing from the static registry`);
  // The tool's declared account access, as its REST counterpart declares it.
  if (
    !isAccountAuthorizedForMcpTool(
      context.userEmail,
      staticDefinition,
      dependencies.checkAccountOperation,
    )
  ) {
    return Result.err(
      new ChatToolError({
        kind: "unavailable",
        message: ACCOUNT_ACCESS_UNAVAILABLE_MESSAGE,
      }),
    );
  }
  const entry = WRITE_TOOL_REF_FIELD_MAP[toolName];

  if (!hasMcpToolAuthority(context, staticDefinition)) {
    return Result.err(
      new ChatToolError({
        kind: "unavailable",
        message: `Your member role does not permit ${toolName}.`,
      }),
    );
  }

  if ("unavailableInputParams" in entry) {
    for (const param of entry.unavailableInputParams) {
      if (param in args) {
        return Result.err(
          new ChatToolError({
            kind: "invalid-input",
            message: `Input ${param} is not available in chat.`,
          }),
        );
      }
    }
  }

  if (
    !isMcpDescriptorFeatureEnabled({
      context,
      kind: "tools",
      id: staticDefinition.name,
      featureId: staticDefinition.featureId,
    })
  ) {
    return Result.err(
      new ChatToolError({
        kind: "unavailable",
        message: "Tool is unavailable.",
      }),
    );
  }
  if (!dependencies.isMcpToolFeatureEnabled(staticDefinition.feature)) {
    return Result.err(
      new ChatToolError({
        kind: "unavailable",
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

  const normalized = normalizeObjectInputAtBoundary({
    access: "write",
    exactProperties: ["confirm", "validate_only"],
    schema: staticDefinition.inputSchema,
    value: dehydrated.value.args,
  });
  if (!normalized.ok) {
    return Result.err(
      toRegistryChatToolError(
        agentInputValidationError({
          failure: normalized,
          subject: `${toolName} arguments`,
        }).error,
      ),
    );
  }

  if (
    !isMcpFeatureInputEnabled({
      context,
      definition: staticDefinition,
      args: normalized.value,
    })
  ) {
    return Result.err(
      new ChatToolError({ kind: "not-found", message: "Not found" }),
    );
  }

  if (!hasMcpToolInputAuthority(context, staticDefinition, normalized.value)) {
    return Result.err(
      new ChatToolError({
        kind: "unavailable",
        message: `Your member role does not permit ${toolName}.`,
      }),
    );
  }

  const visible = await Result.tryPromise(
    async () =>
      await resourcesAreVisible({
        inputs: [
          {
            schema:
              "inputSchemaSource" in staticDefinition
                ? staticDefinition.inputSchemaSource
                : staticDefinition.inputSchema,
            value: normalized.value,
          },
        ],
        scopedDb: context.scopedDb,
      }),
  );
  if (visible.isErr()) {
    observeFailure(visible.error, {
      sink: CHAT_RESOURCE_ADMISSION_FAILURE,
      ctx: { source: "chat", tool: toolName },
    });
    return Result.err(
      new ChatToolError({
        kind: "server-defect",
        message: "Tool execution failed",
        cause: visible.error,
      }),
    );
  }
  if (!visible.value) {
    return Result.err(
      new ChatToolError({ kind: "not-found", message: "Not found" }),
    );
  }

  const needsMatter = matterRequiredResult({
    args: normalized.value,
    context,
    // Chat carries no OAuth scopes, and save_matter is always projected.
    saveMatterCallable: WRITE_TOOL_REF_FIELD_MAP.save_matter.chatProjectable,
    toolName,
  });
  if (needsMatter !== null) {
    return Result.err(toRegistryChatToolError(needsMatter.error));
  }

  const invocation = await invokeStaticMcpTool({
    args: applyChatApprovalConfirmation({
      args: normalized.value,
      toolName,
    }),
    context,
    definition: staticDefinition,
  });
  if (invocation.status === "refused") {
    return Result.err(
      new ChatToolError({
        kind: "unavailable",
        message: `Your member role does not permit this ${toolName} operation.`,
      }),
    );
  }
  const response = invocation.response;
  const finished = await finalizeToolEgress({
    context,
    mode: "default",
    response,
  });

  if (finished.status === "error") {
    return Result.err(toRegistryChatToolError(finished.error));
  }

  // Same single schema-driven pass as the read path: strict parse (an
  // undeclared field fails closed by construction), then strip, ref
  // hydration, and the fail-closed UUID invariant in one walk. Failures
  // carry only paths to telemetry, never values.
  return projectForChat({
    dehydration: dehydrated.value,
    payload: finished.data,
    refRegistry,
    schema: entry.projection,
    source: "run-registry-write-tool",
    toolName,
  });
};
