import type { PermissionInput } from "@stll/permissions";

import type { MemberRole } from "@/api/lib/member-roles";
import {
  hasMemberPermission,
  SESSION_CREDENTIAL,
} from "@/api/lib/permission-authorization";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";

/**
 * The authority one MCP request actually carries: the member role its principal
 * holds, narrowed by the credential's own permission set when the credential
 * carries one.
 *
 * A machine API key is minted with an explicit permission set that is already
 * checked to be a subset of its owner's current role
 * (`mcp/api-key-auth.ts`). Reading the role alone would give every key the
 * owner's full authority and make that set decorative, so both halves are
 * required here. A JWT bearer session has no per-credential set and is bounded
 * by its role and its OAuth scopes.
 */
export type McpEffectiveAuthority = {
  memberRole: MemberRole;
  /** Absent means the credential is not attenuated beyond its role. */
  credentialPermissions?: PermissionInput | undefined;
};

/**
 * The MCP request's authority in the shape every handler and shared helper
 * reads. Built once per context; handlers never see the bare role.
 */
export const mcpMemberAuthority = ({
  memberRole,
  credentialPermissions,
}: McpEffectiveAuthority): AuthorizedMemberRole => ({
  role: memberRole,
  credential:
    credentialPermissions === undefined
      ? SESSION_CREDENTIAL
      : { type: "attenuated", permissions: credentialPermissions },
});

/**
 * The single authorization read for MCP: a request may perform `permissions`
 * only when its member role grants them AND its credential's own permission set
 * (when it has one) grants them too.
 */
export const hasEffectiveAuthority = (
  authority: McpEffectiveAuthority,
  permissions: PermissionInput,
): boolean => hasMemberPermission(mcpMemberAuthority(authority), permissions);
