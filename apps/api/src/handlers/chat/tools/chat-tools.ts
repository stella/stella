import type { ToolSet } from "ai";

import type { SafeDb, ScopedDb } from "@/api/db";
import { getChatSkillMetadata } from "@/api/handlers/chat/skills";
import {
  APPLY_ACTIVE_DOCX_EDITS_TOOL_NAME,
  createActiveDocxEditTool,
} from "@/api/handlers/chat/tools/active-docx-edit-tool";
import { createAresTools } from "@/api/handlers/chat/tools/ares-tools";
import type { AuthorizedToolWorkspaceIds } from "@/api/handlers/chat/tools/authorized-workspace-ids";
import { createChatExecutionTools } from "@/api/handlers/chat/tools/execute/chat-execution-tools";
import type { ChatRefRegistry } from "@/api/handlers/chat/tools/execute/ref-registry";
import { createOrgTools } from "@/api/handlers/chat/tools/org-tools";
import { createSkillTools } from "@/api/handlers/chat/tools/skill-tools";
import {
  applyChatToolPolicies,
  CHAT_TOOL_POLICY_KIND,
} from "@/api/handlers/chat/tools/tool-policy";
import { createWorkspaceTools } from "@/api/handlers/chat/tools/workspace-tools";
import type { SafeId } from "@/api/lib/branded-types";

type WorkspaceTools = ReturnType<typeof createWorkspaceTools>;
type OrgTools = ReturnType<typeof createOrgTools>;
type ChatExecutionTools = ReturnType<typeof createChatExecutionTools>;
type SkillTools = ReturnType<typeof createSkillTools>;
type AresTools = ReturnType<typeof createAresTools>;
type ActiveDocxEditTools = ReturnType<typeof createActiveDocxEditTools>;

type BuiltInChatTools = OrgTools &
  ChatExecutionTools &
  SkillTools &
  AresTools &
  WorkspaceTools &
  ActiveDocxEditTools;

export type ChatTools = BuiltInChatTools;

type GetChatToolsProps = {
  safeDb: SafeDb;
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  // Use `resolveToolWorkspaceIds` to construct this — that helper is
  // the only path that intersects pinned IDs with the currently
  // accessible set, preventing stale stored pins from widening tool
  // authorization.
  toolWorkspaceIds: AuthorizedToolWorkspaceIds;
  refRegistry: ChatRefRegistry;
  workspaceId: SafeId<"workspace"> | null;
  /**
   * `true` when the request comes from a surface that has the
   * apply-active-docx-edits client executor mounted (the file
   * overlay). Other surfaces (standalone chat, global chat) MUST
   * NOT see this tool: the server has no `execute` for it, the
   * client never calls `addToolOutput`, and the call would hang.
   */
  hasActiveFileChat: boolean;
  externalTools?: ToolSet | undefined;
};

const createActiveDocxEditTools = () => ({
  [APPLY_ACTIVE_DOCX_EDITS_TOOL_NAME]: createActiveDocxEditTool(),
});

const BUILT_IN_CHAT_TOOL_POLICY_KINDS = {
  [APPLY_ACTIVE_DOCX_EDITS_TOOL_NAME]: CHAT_TOOL_POLICY_KIND.internal,
  ares_lookup_company: CHAT_TOOL_POLICY_KIND.publicOfficial,
  ares_search_companies: CHAT_TOOL_POLICY_KIND.publicOfficial,
  "ask-user": CHAT_TOOL_POLICY_KIND.internal,
  "create-document": CHAT_TOOL_POLICY_KIND.internal,
  "describe-stella-api": CHAT_TOOL_POLICY_KIND.internal,
  "load-skill": CHAT_TOOL_POLICY_KIND.internal,
  "read-skill-resource": CHAT_TOOL_POLICY_KIND.internal,
  "run-stella-query": CHAT_TOOL_POLICY_KIND.internal,
  "update-entity-fields": CHAT_TOOL_POLICY_KIND.mutation,
} as const satisfies Record<
  keyof BuiltInChatTools,
  (typeof CHAT_TOOL_POLICY_KIND)[keyof typeof CHAT_TOOL_POLICY_KIND]
>;

export const getChatTools = ({
  safeDb,
  scopedDb,
  organizationId,
  userId,
  toolWorkspaceIds,
  refRegistry,
  workspaceId,
  hasActiveFileChat,
  externalTools = {},
}: GetChatToolsProps): ToolSet => {
  const orgTools = createOrgTools({
    accessibleWorkspaceIds: toolWorkspaceIds,
    organizationId,
    scopedDb,
  });
  const executionTools = createChatExecutionTools({
    accessibleWorkspaceIds: toolWorkspaceIds,
    organizationId,
    refRegistry,
    safeDb,
    userId,
  });
  const skillTools = createSkillTools({
    skills: getChatSkillMetadata(),
  });
  const aresTools = createAresTools();
  const activeDocxEditTools = hasActiveFileChat
    ? createActiveDocxEditTools()
    : {};
  const externalChatTools = applyChatToolPolicies({
    defaultPolicyKind: CHAT_TOOL_POLICY_KIND.external,
    tools: externalTools,
  });

  if (!workspaceId) {
    return applyChatToolPolicies({
      policyKinds: BUILT_IN_CHAT_TOOL_POLICY_KINDS,
      tools: {
        ...orgTools,
        ...executionTools,
        ...skillTools,
        ...aresTools,
        ...activeDocxEditTools,
        ...externalChatTools,
      },
    });
  }

  const workspaceTools = createWorkspaceTools({
    allowedWorkspaceIds: toolWorkspaceIds,
    organizationId,
    refRegistry,
    userId,
    scopedDb,
  });

  return applyChatToolPolicies({
    policyKinds: BUILT_IN_CHAT_TOOL_POLICY_KINDS,
    tools: {
      ...orgTools,
      ...executionTools,
      ...skillTools,
      ...aresTools,
      ...workspaceTools,
      ...activeDocxEditTools,
      ...externalChatTools,
    },
  });
};
