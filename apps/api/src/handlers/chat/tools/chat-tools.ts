import type { SafeDb, ScopedDb } from "@/api/db";
import { getChatSkillMetadata } from "@/api/handlers/chat/skills";
import {
  APPLY_ACTIVE_DOCX_EDITS_TOOL_NAME,
  createActiveDocxEditTool,
} from "@/api/handlers/chat/tools/active-docx-edit-tool";
import type { AuthorizedToolWorkspaceIds } from "@/api/handlers/chat/tools/authorized-workspace-ids";
import { createChatExecutionTools } from "@/api/handlers/chat/tools/execute/chat-execution-tools";
import type { ChatRefRegistry } from "@/api/handlers/chat/tools/execute/ref-registry";
import { createOrgTools } from "@/api/handlers/chat/tools/org-tools";
import { createSkillTools } from "@/api/handlers/chat/tools/skill-tools";
import { createWorkspaceTools } from "@/api/handlers/chat/tools/workspace-tools";
import type { SafeId } from "@/api/lib/branded-types";

type WorkspaceTools = ReturnType<typeof createWorkspaceTools>;
type OrgTools = ReturnType<typeof createOrgTools>;
type ChatExecutionTools = ReturnType<typeof createChatExecutionTools>;
type SkillTools = ReturnType<typeof createSkillTools>;
type ActiveDocxEditTools = ReturnType<typeof createActiveDocxEditTools>;

export type ChatTools = OrgTools &
  ChatExecutionTools &
  SkillTools &
  WorkspaceTools &
  ActiveDocxEditTools;

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
};

const createActiveDocxEditTools = () => ({
  [APPLY_ACTIVE_DOCX_EDITS_TOOL_NAME]: createActiveDocxEditTool(),
});

export const getChatTools = ({
  safeDb,
  scopedDb,
  organizationId,
  userId,
  toolWorkspaceIds,
  refRegistry,
  workspaceId,
  hasActiveFileChat,
}: GetChatToolsProps): Partial<ChatTools> => {
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
  const activeDocxEditTools = hasActiveFileChat
    ? createActiveDocxEditTools()
    : {};

  if (!workspaceId) {
    return {
      ...orgTools,
      ...executionTools,
      ...skillTools,
      ...activeDocxEditTools,
    };
  }

  const workspaceTools = createWorkspaceTools({
    allowedWorkspaceIds: toolWorkspaceIds,
    organizationId,
    refRegistry,
    userId,
    scopedDb,
  });

  return {
    ...orgTools,
    ...executionTools,
    ...skillTools,
    ...workspaceTools,
    ...activeDocxEditTools,
  };
};
