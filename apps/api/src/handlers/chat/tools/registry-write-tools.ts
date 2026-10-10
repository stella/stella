import {
  toolDefinition,
  type SchemaInput,
  type ServerTool,
} from "@tanstack/ai";
import { panic, Result } from "better-result";

import {
  buildMcpContextFromChat,
  type ChatRegistryContextDeps,
} from "@/api/handlers/chat/tools/registry-adapter/mcp-chat-context";
import type { RegistryWriteToolName } from "@/api/handlers/chat/tools/registry-adapter/ref-field-map";
import { WRITE_TOOL_REF_FIELD_MAP } from "@/api/handlers/chat/tools/registry-adapter/ref-field-map";
import { runRegistryWriteTool } from "@/api/handlers/chat/tools/registry-adapter/run-registry-write-tool";
import { toToolInputSchema } from "@/api/handlers/chat/tools/registry-adapter/tool-input-schema";
import { resolveCredentialMemberAuthorization } from "@/api/lib/auth";
import type { SafeId } from "@/api/lib/branded-types";
import type { ChatToolMap } from "@/api/lib/chat/chat-tool-types";
import type { ChatRefRegistry } from "@/api/lib/chat/ref-registry";
import type { ChatToolDefectMemo } from "@/api/lib/chat/tool-defect-memo";
import { knownDefectRefusalMessage } from "@/api/lib/chat/tool-defect-memo";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";
import { isMemberRole } from "@/api/lib/member-roles";
import { withCurrentMemberRole } from "@/api/lib/permission-authorization";
import type { WithToolSchemaInputs } from "@/api/lib/tanstack-ai-schema";
import { isRecord } from "@/api/lib/type-guards";
import {
  projectMcpFeatureInput,
  isMcpDescriptorFeatureEnabled,
} from "@/api/mcp/feature-access";
import {
  hiddenMcpDescriptorIds,
  scopeMcpDescriptorProse,
} from "@/api/mcp/feature-access-prose";
import {
  DEFAULT_MCP_TOOL_DEFINITIONS,
  getStaticMcpToolDefinition,
} from "@/api/mcp/static-tool-definitions";
import { isMcpToolVisibleTo } from "@/api/mcp/tool-visibility";
import {
  hasMcpToolAuthority,
  isAccountAuthorizedForMcpTool,
} from "@/api/mcp/write-tool-authority";

/**
 * Chat's write surface, projected from the `access: "write"` slice of the MCP
 * registry as first-class per-call tools (not sandbox bindings): each is a
 * plain `toolDefinition().server()` whose executor runs the #1011 registry
 * adapter's write orchestrator (`runRegistryWriteTool`). Approval is enforced
 * upstream by the `mutation` chat tool policy (`needsApproval`); the executor
 * only runs once the user approves, so no host call is ever suspended inside
 * the sandbox waiting on a human.
 */

/**
 * The projected write-tool names, derived from the ref-field map's per-tool
 * `chatProjectable` flags (the map is `as const`, so each flag is a literal).
 * `fill_template` is `false` (served by the hand-written template chat tool),
 * so it drops out of this union without a hardcoded exclusion.
 */
type ProjectedWriteToolName = {
  [
    K in RegistryWriteToolName
  ]: (typeof WRITE_TOOL_REF_FIELD_MAP)[K]["chatProjectable"] extends true
    ? K
    : never;
}[RegistryWriteToolName];

/**
 * The keyed write-tool surface chat registers, one entry per projected write
 * tool. Consumed as a type by `BuiltInChatTools` so every projected write name
 * flows into `ChatUITools` (and thus forces a frontend title key). The runtime
 * builder returns a loose `ChatToolMap`, exactly like the other chat tool
 * factories; this type describes what it produces.
 */
export type ChatRegistryWriteToolMap = {
  [K in ProjectedWriteToolName]: WithToolSchemaInputs<
    ServerTool<SchemaInput, SchemaInput, K>
  >;
};

/**
 * The projected write tools, in registry order. Derived from the `as const`
 * registry array so each `access: "write"` element's `name` narrows to the
 * `RegistryWriteToolName` union (no cast); the ref-field map then decides
 * projectability per tool.
 */
const projectedWriteToolNames = (): readonly RegistryWriteToolName[] => {
  const names: RegistryWriteToolName[] = [];
  for (const definition of DEFAULT_MCP_TOOL_DEFINITIONS) {
    if (
      definition.access !== "write" ||
      !isMcpToolVisibleTo(definition, "model")
    ) {
      continue;
    }
    if (WRITE_TOOL_REF_FIELD_MAP[definition.name].chatProjectable) {
      names.push(definition.name);
    }
  }
  return names;
};

type BuildChatWriteToolsProps = ChatRegistryContextDeps & {
  pinServerValidatedWorkspaceId: NonNullable<
    ChatRegistryContextDeps["pinServerValidatedWorkspaceId"]
  >;
  refRegistry: ChatRefRegistry;
  toolDefectMemo: ChatToolDefectMemo;
  /**
   * The caller's membership as it stands when a tool runs (`null` once they
   * left the organization). Defaults to the credential-boundary read.
   */
  resolveCurrentMembership?: (lookup: {
    organizationId: SafeId<"organization">;
    userId: SafeId<"user">;
  }) => Promise<{ role: string } | null>;
};

/**
 * Registration runs when the turn starts, but an approved write can run
 * minutes later. The member's role is read again at execution, so a
 * downgrade or a removal in between refuses the call; the credential's own
 * attenuation is kept.
 */
const currentExecutionDeps = async (
  contextDeps: ChatRegistryContextDeps,
  resolveCurrentMembership: NonNullable<
    BuildChatWriteToolsProps["resolveCurrentMembership"]
  >,
): Promise<Result<ChatRegistryContextDeps, ChatToolError>> => {
  const membership = await Result.tryPromise(
    async () =>
      await resolveCurrentMembership({
        organizationId: contextDeps.organizationId,
        userId: contextDeps.userId,
      }),
  );
  if (Result.isError(membership)) {
    return Result.err(
      new ChatToolError({
        kind: "transient",
        message: "Your current access could not be confirmed. Try again.",
        cause: membership.error,
      }),
    );
  }
  const role = membership.value?.role;
  if (role === undefined || !isMemberRole(role)) {
    return Result.err(
      new ChatToolError({
        kind: "unavailable",
        message: "You are no longer a member of this organization.",
      }),
    );
  }
  return Result.ok({
    ...contextDeps,
    memberRole: withCurrentMemberRole(contextDeps.memberRole, role),
  });
};

export const buildChatWriteTools = (
  props: BuildChatWriteToolsProps,
): ChatToolMap => {
  const {
    refRegistry,
    resolveCurrentMembership = resolveCredentialMemberAuthorization,
    toolDefectMemo,
    ...contextDeps
  } = props;
  const context = buildMcpContextFromChat(contextDeps);
  const hiddenIds = hiddenMcpDescriptorIds(
    context,
    DEFAULT_MCP_TOOL_DEFINITIONS,
  );

  const tools: ChatToolMap = {};
  for (const toolName of projectedWriteToolNames()) {
    const entry = WRITE_TOOL_REF_FIELD_MAP[toolName];
    const definition = projectMcpFeatureInput(
      context,
      getStaticMcpToolDefinition(toolName) ??
        panic(
          `Chat write tool ${toolName} is missing from the static registry`,
        ),
    );
    // The same declared gates MCP discovery applies: a member who cannot run
    // any of the tool's operations, or an account its declared account
    // access refuses, is not offered it.
    if (
      !hasMcpToolAuthority(context, definition) ||
      !isAccountAuthorizedForMcpTool(context.userEmail, definition) ||
      !isMcpDescriptorFeatureEnabled({
        context,
        kind: "tools",
        id: definition.name,
        featureId: definition.featureId,
      })
    ) {
      continue;
    }
    const inputSchema =
      "unavailableInputParams" in entry
        ? toToolInputSchema(
            definition.inputSchema,
            entry.unavailableInputParams,
          )
        : toToolInputSchema(definition.inputSchema);
    const description =
      "chatDescription" in entry
        ? entry.chatDescription
        : definition.description;

    tools[toolName] = toolDefinition({
      name: toolName,
      description: scopeMcpDescriptorProse(description, hiddenIds),
      inputSchema,
    }).server(async (args: unknown) => {
      const toolArgs = isRecord(args) ? args : {};
      // Same mechanical retry policy as the code-mode read runner: a call
      // that already failed with a server defect this turn is refused before
      // dispatch instead of re-executed.
      if (toolDefectMemo.isKnownDefect(toolName, toolArgs)) {
        throw new ChatToolError({
          kind: "server-defect",
          message: knownDefectRefusalMessage(toolName),
        });
      }
      const executionDeps = await currentExecutionDeps(
        contextDeps,
        resolveCurrentMembership,
      );
      const result = Result.isError(executionDeps)
        ? executionDeps
        : await runRegistryWriteTool({
            args: toolArgs,
            context: buildMcpContextFromChat(executionDeps.value),
            refRegistry,
            toolName,
          });
      if (Result.isError(result)) {
        if (result.error.kind === "server-defect") {
          toolDefectMemo.recordDefect(toolName, toolArgs);
        }
        throw result.error;
      }
      return result.value;
    });
  }
  return tools;
};
