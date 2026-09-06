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
import type { ChatToolMap } from "@/api/lib/chat/chat-tool-types";
import type { ChatRefRegistry } from "@/api/lib/chat/ref-registry";
import type { ChatToolDefectMemo } from "@/api/lib/chat/tool-defect-memo";
import { knownDefectRefusalMessage } from "@/api/lib/chat/tool-defect-memo";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";
import { isRecord } from "@/api/lib/type-guards";
import {
  DEFAULT_MCP_TOOL_DEFINITIONS,
  getStaticMcpToolDefinition,
} from "@/api/mcp/static-tool-definitions";

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
export type ProjectedWriteToolName = {
  [K in RegistryWriteToolName]: (typeof WRITE_TOOL_REF_FIELD_MAP)[K]["chatProjectable"] extends true
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
  [K in ProjectedWriteToolName]: ServerTool<SchemaInput, SchemaInput, K>;
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
    if (definition.access !== "write") {
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
};

export const buildChatWriteTools = (
  props: BuildChatWriteToolsProps,
): ChatToolMap => {
  const { refRegistry, toolDefectMemo, ...contextDeps } = props;
  const context = buildMcpContextFromChat(contextDeps);

  const tools: ChatToolMap = {};
  for (const toolName of projectedWriteToolNames()) {
    const entry = WRITE_TOOL_REF_FIELD_MAP[toolName];
    const definition =
      getStaticMcpToolDefinition(toolName) ??
      panic(`Chat write tool ${toolName} is missing from the static registry`);
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
      description,
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
      const result = await runRegistryWriteTool({
        args: toolArgs,
        context,
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
