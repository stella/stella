import * as v from "valibot";

import { getAuth, resolveCredentialMemberAuthorization } from "@/api/lib/auth";
import {
  isMachineApiKeyAudienceAllowed,
  MACHINE_API_KEY_CONFIG_ID,
  machineApiKeyMetadataSchema,
  machineApiKeyPermissionsSchema,
  parseMachineApiKeyPermissions,
} from "@/api/lib/machine-api-key-config";
import { isMemberRole } from "@/api/lib/member-roles";
import { hasMemberPermission } from "@/api/lib/permission-authorization";
import { brandActorSessionIdentity } from "@/api/lib/safe-id-boundaries";
import type { McpSession } from "@/api/mcp/auth";
import type { McpMode } from "@/api/mcp/constants";
import { McpAuthenticationError } from "@/api/mcp/errors";

/**
 * Every rejection reports the same thing. Whether a credential was unknown,
 * expired, disabled, pointed at a former member, or carried permissions its
 * owner's role no longer grants is exactly the information an attacker probing
 * with a stolen or guessed key wants back, and none of it helps a legitimate
 * caller more than "this credential is not usable" does.
 */
const rejectCredential = (): McpAuthenticationError =>
  new McpAuthenticationError({ message: "Invalid or expired API key" });

/**
 * Resolve a machine API key into the same authorization identity the JWT
 * bearer path produces, while retaining credential-specific audit provenance.
 * Both credential types still land on one authorization path.
 *
 * This adds a credential type; it does not relax anything. The returned session
 * is handed to `resolveMcpSessionContext` unchanged, which independently
 * re-runs the member lookup and derives the RLS database identity from
 * `userId` + `organizationId`. Two properties make that safe:
 *
 *  1. `referenceId` is a **user** id (the plugin runs with `references: "user"`),
 *     so the principal a key resolves to is a real user who must hold a `member`
 *     row in the owning org — the same requirement a JWT subject has. There is
 *     no synthetic machine principal and no path that skips the member check.
 *  2. The organization id comes from the key's server-written metadata, never
 *     from the caller. A key cannot ask to be resolved against a different org.
 *
 * On top of that this re-checks the key's stored permissions against the
 * owner's *current* role, so demoting or removing a member immediately shrinks
 * or kills every key they minted, without anyone having to remember to revoke.
 *
 * `mode` is the audience path the credential was presented on. The bearer path
 * gets this for free from the token's `aud` claim; a key carries no claim to
 * check, so a key minted for one audience is refused on another here. A key
 * with no audience in its metadata predates the binding and stays usable
 * anywhere, which is what it could already do.
 */
export const resolveMachineApiKeySession = async (
  credential: string,
  {
    mode = "default",
    verifyApiKey = getAuth().api.verifyApiKey,
    resolveAuthorization = resolveCredentialMemberAuthorization,
  }: {
    mode?: McpMode | undefined;
    verifyApiKey?: (
      ...args: Parameters<ReturnType<typeof getAuth>["api"]["verifyApiKey"]>
    ) => ReturnType<ReturnType<typeof getAuth>["api"]["verifyApiKey"]>;
    resolveAuthorization?: typeof resolveCredentialMemberAuthorization;
  } = {},
): Promise<McpSession> => {
  const verification = await verifyApiKey({
    body: {
      // Scoping to this configuration means a key minted under any other
      // configuration fails here rather than being accepted as a machine key.
      configId: MACHINE_API_KEY_CONFIG_ID,
      key: credential,
    },
  });

  if (!verification.valid || !verification.key) {
    throw rejectCredential();
  }

  const { key } = verification;

  // `enabled` is surfaced separately from validity by the plugin; a revoked key
  // is disabled rather than deleted so its audit trail survives.
  if (!key.enabled) {
    throw rejectCredential();
  }

  // Two independent reasons to refuse, sharing one branch because they share
  // one answer: metadata this code path did not write, and a key bound to a
  // different audience than the one it was presented on. Both are decided
  // before the owner is looked up, so a mismatched key cannot be used to probe
  // whether its owner is still a member.
  const metadata = v.safeParse(machineApiKeyMetadataSchema, key.metadata);
  if (
    !metadata.success ||
    !isMachineApiKeyAudienceAllowed({
      audience: metadata.output.audience,
      mode,
    })
  ) {
    throw rejectCredential();
  }

  const storedPermissions = v.safeParse(
    machineApiKeyPermissionsSchema,
    key.permissions,
  );
  if (!storedPermissions.success) {
    throw rejectCredential();
  }

  const parsedPermissions = parseMachineApiKeyPermissions(
    storedPermissions.output,
  );
  if (parsedPermissions.type !== "valid") {
    throw rejectCredential();
  }

  const { organizationId, scopes } = metadata.output;
  const userId = key.referenceId;

  // The live membership check. `resolveMcpSessionContext` runs this again for
  // the session it builds; doing it here as well is what lets the permission
  // re-check below happen before any session exists, and re-running an
  // authorization check is the safe direction to duplicate in.
  //
  // Branding happens here, at the same boundary `resolveMcpSessionContext` uses:
  // these two ids arrive as plain strings (one parsed out of a metadata column,
  // one read off the key row) and only become ownership ids once they cross it.
  const authorization = await resolveAuthorization(
    brandActorSessionIdentity({ organizationId, userId }),
  );

  if (!authorization || !isMemberRole(authorization.role)) {
    throw rejectCredential();
  }

  // The escalation guard, evaluated against the role the owner holds *now*
  // rather than the one they held at creation. A key can only ever be a subset
  // of its owner's current authority.
  if (
    !hasMemberPermission(
      { role: authorization.role },
      parsedPermissions.permissions,
    )
  ) {
    throw rejectCredential();
  }

  return {
    credential: {
      type: "machine_api_key",
      id: key.id,
      name: key.name ?? "Machine API key",
      // The set the check above proved the owner's role can grant. It travels
      // with the session so authorization can hold the key to it, rather than
      // to the whole role the owner happens to have.
      permissions: parsedPermissions.permissions,
    },
    organizationId,
    scopes: [...scopes],
    userId,
  };
};
