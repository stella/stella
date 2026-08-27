import { roles } from "@stll/permissions";
import type { PermissionInput } from "@stll/permissions";

import type { MemberRole } from "@/api/lib/member-roles";

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
 * A permission set widened to an index signature. An ordinary assignment
 * rather than a cast: it lets an arbitrary resource name be looked up
 * (yielding `undefined` for one the set does not carry) without asserting
 * anything the compiler cannot already check.
 */
type PermissionActionsByResource = Record<
  string,
  readonly string[] | undefined
>;

/**
 * Does `granted` cover every resource/action pair in `requested`? A resource
 * the grant does not name is not granted, and an unlisted action on a named
 * resource is not granted either.
 */
const grants = (
  granted: PermissionInput,
  requested: PermissionInput,
): boolean => {
  const grantedByResource: PermissionActionsByResource = granted;
  const requestedByResource: PermissionActionsByResource = requested;

  return Object.keys(requestedByResource).every((resource) => {
    const requestedActions = requestedByResource[resource];
    if (requestedActions === undefined) {
      return true;
    }
    // `Object.hasOwn` before the index read: a resource named after an
    // inherited key (`constructor`, `__proto__`) would otherwise resolve to a
    // prototype value and make `includes` throw instead of denying.
    const grantedActions = Object.hasOwn(grantedByResource, resource)
      ? grantedByResource[resource]
      : undefined;
    if (grantedActions === undefined) {
      return false;
    }
    return requestedActions.every((action) => grantedActions.includes(action));
  });
};

/**
 * The single authorization read for MCP: a request may perform `permissions`
 * only when its member role grants them AND its credential's own permission set
 * (when it has one) grants them too. Prefer this over reading `memberRole`
 * directly, so a credential's attenuation cannot be lost by taking the role's
 * word for it.
 */
export const hasEffectiveAuthority = (
  authority: McpEffectiveAuthority,
  permissions: PermissionInput,
): boolean => {
  if (!roles[authority.memberRole].authorize(permissions).success) {
    return false;
  }
  const { credentialPermissions } = authority;
  return (
    credentialPermissions === undefined ||
    grants(credentialPermissions, permissions)
  );
};
