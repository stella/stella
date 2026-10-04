import {
  getChatTools,
  type GetChatToolsProps,
} from "@/api/handlers/chat/tools/chat-tools";
import {
  chatScriptReadToolNames,
  CODE_MODE_EXECUTE_TOOL_NAME,
} from "@/api/handlers/chat/tools/execute/chat-code-mode";
import { DIRECT_ONLY_CHAT_READ_TOOLS } from "@/api/handlers/chat/tools/execute/chat-read-script-policy";
import {
  restrictChatToolsToScope,
  type ChatToolScope,
} from "@/api/handlers/chat/tools/tool-scope";
import type { ChatToolMap } from "@/api/lib/chat/chat-tool-types";
import { roleForDisplay } from "@/api/lib/permission-authorization";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";
import { isMcpDescriptorFeatureEnabled } from "@/api/mcp/feature-access";
import type { McpFeatureAccessContext } from "@/api/mcp/feature-access";
import { getStaticMcpToolDefinition } from "@/api/mcp/static-tool-definitions";
import { isMcpToolFeatureEnabled } from "@/api/mcp/tool-feature";
import { isMemberAuthorizedForMcpTool } from "@/api/mcp/write-tool-authority";

/**
 * A registry tool counts as offered only where its own registry gates pass:
 * the deployment feature it is tagged with and the member-role predicate the
 * MCP surface applies. Chat-only tools carry no such gates.
 */
const isRegistryToolUsable = ({
  toolName,
  memberRole,
  context,
}: {
  toolName: string;
  memberRole: AuthorizedMemberRole;
  context: McpFeatureAccessContext;
}): boolean => {
  const definition = getStaticMcpToolDefinition(toolName);
  if (definition === undefined) {
    return isMcpDescriptorFeatureEnabled({
      context,
      kind: "tools",
      id: toolName,
    });
  }
  return (
    isMcpDescriptorFeatureEnabled({
      context,
      kind: "tools",
      id: definition.name,
      featureId: definition.featureId,
    }) &&
    isMcpToolFeatureEnabled(definition.feature) &&
    isMemberAuthorizedForMcpTool(memberRole, definition) &&
    (definition.isVisibleToMemberRole?.(roleForDisplay(memberRole)) ?? true)
  );
};

/**
 * The tool names a chat turn offers the model: every registered tool, plus
 * the registry reads `execute_typescript` exposes as sandbox bindings when
 * that runner is registered. This is the chat side of
 * `resolveSkillToolAvailability`.
 */
const chatOfferedToolNames = ({
  context,
  memberRole,
  tools,
}: {
  context: McpFeatureAccessContext;
  memberRole: AuthorizedMemberRole;
  tools: ChatToolMap;
}): ReadonlySet<string> => {
  const names = Object.entries(tools).flatMap(([name, tool]) =>
    tool === undefined ? [] : [name],
  );
  if (names.includes(CODE_MODE_EXECUTE_TOOL_NAME)) {
    names.push(...chatScriptReadToolNames(context));
  }
  for (const [readName, directTool] of Object.entries(
    DIRECT_ONLY_CHAT_READ_TOOLS,
  )) {
    if (names.includes(directTool)) {
      names.push(readName);
    }
  }
  return new Set(
    names.filter((name) =>
      isRegistryToolUsable({ toolName: name, memberRole, context }),
    ),
  );
};

export type ChatSkillToolContext = Omit<
  GetChatToolsProps,
  "activeSkillContext" | "externalTools" | "purpose" | "skillMetadata"
> & {
  /** The request's named tool scope, which narrows the streaming set. */
  toolScope?: ChatToolScope | undefined;
};

/**
 * The tools a chat turn with this context offers, for deciding which skills
 * it can finish. Assembled by `getChatTools` itself, from the same inputs a
 * run receives, so registration and skill availability cannot disagree. The
 * tools are built for their names only and never run. Skill tools and
 * external connector tools are left out: a skill cannot require either.
 */
export const chatToolNamesForSkills = ({
  toolScope,
  ...props
}: ChatSkillToolContext): ReadonlySet<string> => {
  const tools = getChatTools({
    ...props,
    activeSkillContext: null,
    externalTools: {},
    skillMetadata: undefined,
  });
  return chatOfferedToolNames({
    context: props,
    memberRole: props.memberRole,
    tools:
      toolScope === undefined
        ? tools
        : restrictChatToolsToScope(tools, toolScope),
  });
};
