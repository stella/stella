import { panic } from "better-result";

import type { PermissionInput } from "@stll/permissions";
import { isOrganizationManagementRole, roles } from "@stll/permissions";

import type { MemberRole } from "@/api/lib/member-roles";

/**
 * What the credential behind a request may spend on top of its member role.
 * A person's session carries the role alone. A machine credential (an API key
 * minted with an explicit permission subset) is attenuated: every decision
 * spends only what both the role and that subset grant. The discriminator is
 * required, so a context built without it cannot read as full role authority.
 */
export type CredentialAuthority =
  | { type: "session" }
  | { type: "attenuated"; permissions: PermissionInput };

export const SESSION_CREDENTIAL = {
  type: "session",
} as const satisfies CredentialAuthority;

const AUTHORITY = Symbol("member-authority");
type MemberAuthorityData = {
  role: MemberRole;
  credential: CredentialAuthority;
};
class MemberAuthority {
  readonly #data: MemberAuthorityData;
  constructor(data: MemberAuthorityData) {
    this.#data = data;
  }
  [AUTHORITY](): MemberAuthorityData {
    return this.#data;
  }
}
export type AuthorizedMemberRole = MemberAuthority;

export const authorizedMemberRole = (
  data: MemberAuthorityData,
): AuthorizedMemberRole => new MemberAuthority(data);

export const credentialPermissionsForContext = (
  authority: AuthorizedMemberRole,
): PermissionInput | undefined => {
  const { credential } = authority[AUTHORITY]();
  switch (credential.type) {
    case "session":
      return undefined;
    case "attenuated":
      return credential.permissions;
    default:
      credential satisfies never;
      return panic(`Unhandled credential: ${String(credential)}`);
  }
};

export const roleForDisplay = (authority: AuthorizedMemberRole): MemberRole =>
  authority[AUTHORITY]().role;

/**
 * The same credential applied to the member's role as it stands now: a check
 * made after the request started (an approved tool call) re-reads the role
 * and keeps whatever the credential attenuates.
 */
export const withCurrentMemberRole = (
  authority: AuthorizedMemberRole,
  role: MemberRole,
): AuthorizedMemberRole =>
  authorizedMemberRole({ role, credential: authority[AUTHORITY]().credential });

/** The authority of a person's own session. */
export const sessionMemberRole = (role: MemberRole): AuthorizedMemberRole =>
  authorizedMemberRole({ role, credential: SESSION_CREDENTIAL });

/** Revalidates a persisted membership after the request's credential check. */
export const hasCurrentMemberPermission = (
  role: MemberRole,
  permissions: PermissionInput,
): boolean => hasMemberPermission(sessionMemberRole(role), permissions);

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
export const grantsPermissions = (
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
    if (!Array.isArray(grantedActions)) {
      return false;
    }
    return requestedActions.every((action) => grantedActions.includes(action));
  });
};

/**
 * The single authorization read: `permissions` are granted only when the
 * member role grants them AND, for an attenuated credential, the credential's
 * own set grants them too. Every permission decision goes through this, so a
 * credential's attenuation cannot be lost by taking the role's word for it.
 */
export const hasMemberPermission = (
  authority: AuthorizedMemberRole,
  permissions: PermissionInput,
): boolean => {
  if (!roles[authority[AUTHORITY]().role].authorize(permissions).success) {
    return false;
  }
  const { credential } = authority[AUTHORITY]();
  switch (credential.type) {
    case "session":
      return true;
    case "attenuated":
      return grantsPermissions(credential.permissions, permissions);
    default: {
      credential satisfies never;
      return panic(`Unhandled credential: ${String(credential)}`);
    }
  }
};

/**
 * Organization management (owner or admin) acting through `permissions`: the
 * role must be a management role and the request must be able to spend the
 * permission that override uses.
 */
export const hasManagementPermission = (
  authority: AuthorizedMemberRole,
  permissions: PermissionInput,
): boolean =>
  isOrganizationManagementRole(authority[AUTHORITY]().role) &&
  hasMemberPermission(authority, permissions);

type MemberRoleContext = {
  memberRole: unknown;
};

const hasOwnMemberRole = (ctx: object): ctx is MemberRoleContext =>
  Object.hasOwn(ctx, "memberRole");

const isAuthorizedMemberRole = (
  value: unknown,
): value is AuthorizedMemberRole => value instanceof MemberAuthority;

export const readAuthorizedMemberRole = (
  ctx: object,
): AuthorizedMemberRole | null =>
  hasOwnMemberRole(ctx) && isAuthorizedMemberRole(ctx.memberRole)
    ? ctx.memberRole
    : null;
