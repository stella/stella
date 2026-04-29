import type { SafeDb, ScopedDb } from "@/api/db";
import { getChatSkillMetadata } from "@/api/handlers/chat/skills";
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

export type ChatTools = OrgTools &
  ChatExecutionTools &
  SkillTools &
  WorkspaceTools;

type GetChatToolsProps = {
  safeDb: SafeDb;
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  accessibleWorkspaceIds: SafeId<"workspace">[];
  refRegistry: ChatRefRegistry;
  workspaceId: SafeId<"workspace"> | null;
};

export const getChatTools = ({
  safeDb,
  scopedDb,
  organizationId,
  userId,
  accessibleWorkspaceIds,
  refRegistry,
  workspaceId,
}: GetChatToolsProps): ChatTools => {
  const orgTools = createOrgTools({
    accessibleWorkspaceIds,
    organizationId,
    scopedDb,
  });
  const executionTools = createChatExecutionTools({
    accessibleWorkspaceIds,
    organizationId,
    refRegistry,
    safeDb,
    userId,
  });
  const skillTools = createSkillTools({
    skills: getChatSkillMetadata(),
  });

  if (!workspaceId) {
    return {
      ...orgTools,
      ...executionTools,
      ...skillTools,
    };
  }

  const workspaceTools = createWorkspaceTools({
    allowedWorkspaceIds: accessibleWorkspaceIds,
    organizationId,
    userId,
    scopedDb,
  });

  return {
    ...orgTools,
    ...executionTools,
    ...skillTools,
    ...workspaceTools,
  };
};
