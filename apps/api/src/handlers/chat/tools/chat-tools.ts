import type { ScopedDb } from "@/api/db";
import { createOrgTools } from "@/api/handlers/chat/tools/org-tools";
import { createWorkspaceTools } from "@/api/handlers/chat/tools/workspace-tools";
import type { SafeId } from "@/api/lib/branded-types";

type WorkspaceTools = ReturnType<typeof createWorkspaceTools>;
type OrgTools = ReturnType<typeof createOrgTools>;

export type ChatTools = OrgTools & WorkspaceTools;

type GetChatToolsProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  accessibleWorkspaceIds: SafeId<"workspace">[];
  workspaceId: SafeId<"workspace"> | null;
};

export const getChatTools = ({
  scopedDb,
  organizationId,
  userId,
  accessibleWorkspaceIds,
  workspaceId,
}: GetChatToolsProps): ChatTools => {
  const orgTools = createOrgTools({
    accessibleWorkspaceIds,
    organizationId,
    scopedDb,
  });

  if (!workspaceId) {
    return orgTools;
  }

  const workspaceTools = createWorkspaceTools({
    allowedWorkspaceIds: accessibleWorkspaceIds,
    organizationId,
    userId,
    scopedDb,
  });

  return {
    ...orgTools,
    ...workspaceTools,
  };
};
