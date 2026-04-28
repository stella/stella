import type { SafeDb, ScopedDb } from "@/api/db";
import { createChatExecutionTools } from "@/api/handlers/chat/tools/execute/chat-execution-tools";
import type { ChatRefRegistry } from "@/api/handlers/chat/tools/execute/ref-registry";
import { createOrgTools } from "@/api/handlers/chat/tools/org-tools";
import { createWorkspaceTools } from "@/api/handlers/chat/tools/workspace-tools";
import type { SafeId } from "@/api/lib/branded-types";

type WorkspaceTools = ReturnType<typeof createWorkspaceTools>;
type OrgTools = ReturnType<typeof createOrgTools>;
type ChatExecutionTools = ReturnType<typeof createChatExecutionTools>;

export type ChatTools = OrgTools & ChatExecutionTools & WorkspaceTools;

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

  if (!workspaceId) {
    return {
      ...orgTools,
      ...executionTools,
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
    ...workspaceTools,
  };
};
