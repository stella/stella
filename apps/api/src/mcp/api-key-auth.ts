import * as v from "valibot";

import { DAY_IN_MS } from "@stll/time";

import { getAuth, resolveCredentialMemberAuthorization } from "@/api/lib/auth";
import {
  API_KEY_KIND,
  API_KEY_POLICY,
  isMachineApiKeyAudienceAllowed,
  MACHINE_API_KEY_CONFIG_ID,
  machineApiKeyMetadataSchema,
  machineApiKeyPermissionsSchema,
  parseMachineApiKeyPermissions,
} from "@/api/lib/machine-api-key-config";
import { personalApiKeyPermissionsAllowed } from "@/api/lib/machine-api-keys/personal-policy";
import { readPersonalApiKeyPolicy } from "@/api/lib/machine-api-keys/personal-policy-reader";
import { isMemberRole } from "@/api/lib/member-roles";
import {
  hasMemberPermission,
  sessionMemberRole,
} from "@/api/lib/permission-authorization";
import { brandActorSessionIdentity } from "@/api/lib/safe-id-boundaries";
import type { McpSession } from "@/api/mcp/auth";
import { getMcpResourceModeConfig, type McpMode } from "@/api/mcp/constants";
import { McpAuthenticationError } from "@/api/mcp/errors";

/**
 * Credential failures do not disclose server-side state. Audience mismatches
 * are the exception: they echo only the binding stored on the credential the
 * caller already presented, which gives a legitimate caller a corrective path
 * without revealing whether the owning member is still active.
 */
const rejectCredential = (): McpAuthenticationError =>
  new McpAuthenticationError({ message: "Invalid or expired API key" });

const rejectAudienceMismatch = (audience: McpMode): McpAuthenticationError =>
  new McpAuthenticationError({
    message: `This API key is bound to the ${audience} audience. Use ${getMcpResourceModeConfig(audience).httpPath}.`,
  });

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
type MachineApiKeyCredential = { session: McpSession; expiresAt: Date | null };

/**
 * Where a key is presented to read its own expiry rather than to reach a
 * resource. An audience binding limits what a key can reach; it never hides
 * the key's own lifetime from its holder, so every audience is accepted here.
 * Only `resolveOwnMachineApiKeyCredential` presents a key this way; no MCP
 * transport mode can.
 */
const KEY_SELF_INSPECTION = "self_inspection";

type MachineApiKeyDependencies = {
  verifyApiKey?: (
    ...args: Parameters<ReturnType<typeof getAuth>["api"]["verifyApiKey"]>
  ) => ReturnType<ReturnType<typeof getAuth>["api"]["verifyApiKey"]>;
  resolveAuthorization?: typeof resolveCredentialMemberAuthorization;
  resolvePersonalPolicy?: typeof readPersonalApiKeyPolicy;
};

const resolvePresentedMachineApiKey = async (
  credential: string,
  mode: McpMode | typeof KEY_SELF_INSPECTION,
  {
    verifyApiKey = getAuth().api.verifyApiKey,
    resolveAuthorization = resolveCredentialMemberAuthorization,
    resolvePersonalPolicy = readPersonalApiKeyPolicy,
  }: MachineApiKeyDependencies,
): Promise<MachineApiKeyCredential> => {
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

  // Both metadata validity and audience binding are decided before the owner
  // lookup. A mismatch names only the binding already carried by the presented
  // credential and cannot probe whether its owner is still a member.
  const metadata = v.safeParse(machineApiKeyMetadataSchema, key.metadata);
  if (!metadata.success) {
    throw rejectCredential();
  }
  if (
    mode !== KEY_SELF_INSPECTION &&
    !isMachineApiKeyAudienceAllowed({
      audience: metadata.output.audience,
      mode,
    })
  ) {
    throw rejectAudienceMismatch(metadata.output.audience ?? mode);
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
  const identity = brandActorSessionIdentity({ organizationId, userId });
  const personalPolicy =
    metadata.output.kind === API_KEY_KIND.personal &&
    (!personalApiKeyPermissionsAllowed(
      storedPermissions.output,
      metadata.output.scopes,
    ) ||
      key.expiresAt === null ||
      key.expiresAt.getTime() - key.createdAt.getTime() >
        API_KEY_POLICY.personal.maxDays * DAY_IN_MS ||
      (await resolvePersonalPolicy(identity.organizationId)) !== "enabled")
      ? "denied"
      : "allowed";

  // The live membership check. `resolveMcpSessionContext` runs this again for
  // the session it builds; doing it here as well is what lets the permission
  // re-check below happen before any session exists, and re-running an
  // authorization check is the safe direction to duplicate in.
  //
  // Branding happens here, at the same boundary `resolveMcpSessionContext` uses:
  // these two ids arrive as plain strings (one parsed out of a metadata column,
  // one read off the key row) and only become ownership ids once they cross it.
  const authorization = await resolveAuthorization(identity);

  if (
    personalPolicy === "denied" ||
    !authorization ||
    !isMemberRole(authorization.role)
  ) {
    throw rejectCredential();
  }

  // The escalation guard, evaluated against the role the owner holds *now*
  // rather than the one they held at creation. A key can only ever be a subset
  // of its owner's current authority, so the check reads the owner's role
  // as a session would.
  if (
    !hasMemberPermission(
      sessionMemberRole(authorization.role),
      parsedPermissions.permissions,
    )
  ) {
    throw rejectCredential();
  }

  return {
    expiresAt: key.expiresAt,
    session: {
      credential: {
        type:
          metadata.output.kind === API_KEY_KIND.personal
            ? "personal_api_key"
            : "machine_api_key",
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
    },
  };
};

export const resolveMachineApiKeyCredential = async (
  credential: string,
  {
    mode = "default",
    ...dependencies
  }: MachineApiKeyDependencies & { mode?: McpMode | undefined } = {},
): Promise<MachineApiKeyCredential> =>
  await resolvePresentedMachineApiKey(credential, mode, dependencies);

/** The key's own record, for its holder; any audience binding is accepted. */
export const resolveOwnMachineApiKeyCredential = async (
  credential: string,
  dependencies: MachineApiKeyDependencies = {},
): Promise<MachineApiKeyCredential> =>
  await resolvePresentedMachineApiKey(
    credential,
    KEY_SELF_INSPECTION,
    dependencies,
  );

/** MCP consumers need only the session; lifecycle observers also need expiry. */
export const resolveMachineApiKeySession = async (
  ...args: Parameters<typeof resolveMachineApiKeyCredential>
) => (await resolveMachineApiKeyCredential(...args)).session;
