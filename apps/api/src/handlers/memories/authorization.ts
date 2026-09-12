import type { AccessibleWorkspace } from "@/api/lib/auth";
import type { SafeId } from "@/api/lib/branded-types";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";
import { hasMemberPermission } from "@/api/lib/permission-authorization";

type MemoryManagementTarget = {
  scope: "organization" | "user" | "workspace";
  userId: SafeId<"user"> | null;
  workspaceId: SafeId<"workspace"> | null;
};

type CanManageMemoryOptions = {
  accessibleWorkspaces: readonly AccessibleWorkspace[];
  currentUserId: SafeId<"user">;
  memberRole: AuthorizedMemberRole;
  memory: MemoryManagementTarget;
};

export const canManageMemory = ({
  accessibleWorkspaces,
  currentUserId,
  memberRole,
  memory,
}: CanManageMemoryOptions): boolean => {
  switch (memory.scope) {
    case "user":
      return memory.userId === currentUserId;
    case "organization":
      return hasMemberPermission(memberRole, { firmMemory: ["update"] });
    case "workspace":
      return (
        hasMemberPermission(memberRole, { workspace: ["update"] }) &&
        memory.workspaceId !== null &&
        accessibleWorkspaces.some(
          ({ id, status }) => id === memory.workspaceId && status === "active",
        )
      );
    default: {
      const exhaustive: never = memory.scope;
      return exhaustive;
    }
  }
};
