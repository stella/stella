import type { PermissionInput } from "@stll/permissions";

import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";
import { hasMemberPermission } from "@/api/lib/permission-authorization";

export const WORKSPACE_ACTIVITY_PERMISSIONS = {
  workspace: ["read"],
} satisfies PermissionInput;

export const WORKSPACE_ACTIVITY_SCOPE = {
  entities: "entities",
  entitiesAndChat: "entities-and-chat",
} as const;

export const resolveWorkspaceActivityScope = (
  memberRole: AuthorizedMemberRole,
) =>
  hasMemberPermission(memberRole, { chat: ["create"] })
    ? WORKSPACE_ACTIVITY_SCOPE.entitiesAndChat
    : WORKSPACE_ACTIVITY_SCOPE.entities;
